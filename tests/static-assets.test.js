// Static asset resolution for server.js (issue #16).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveStaticFile } = require("../lib/static-assets");

const ROOT = path.join(__dirname, "..");
const status = (requestPath) => {
  const result = resolveStaticFile(ROOT, requestPath);
  return result.ok ? 200 : result.status;
};

test("app assets are still served", () => {
  for (const asset of [
    "/",
    "/index.html",
    "/history.html",
    "/app.js",
    "/history.js",
    "/styles.css",
    "/favicon.svg",
    "/logo.svg",
    "/candle_guide.png",
    "/modules/ui.js",
    "/modules/trade-levels.mjs",
  ]) {
    assert.equal(status(asset), 200, `${asset} should be served`);
  }
});

test("git internals are never served", () => {
  for (const file of ["/.git/config", "/.git/HEAD", "/.git/refs/heads/main", "/.github/workflows/tests.yml"]) {
    assert.equal(status(file), 404, `${file} must not be served`);
  }
});

test("the secrets store is never served", () => {
  assert.equal(status("/data/settings.json"), 404);
  assert.equal(status("/data/institutional_history.db.json"), 404);
  assert.equal(status("/data/settings.example.json"), 404);
});

test("dotfiles and server-side code are never served", () => {
  for (const file of [
    "/.env",
    "/.env.example",
    "/.gitignore",
    "/lib/admin-auth.js",
    "/lib/static-assets.js",
    "/api/index.js",
    "/api-handlers/settings.js",
    "/tests/bundles.test.js",
    "/CODE_REVIEW.md",
    "/package.json",
  ]) {
    assert.equal(status(file), 404, `${file} must not be served`);
  }
});

test("path traversal cannot escape the root", () => {
  for (const attack of [
    "/../etc/passwd",
    "/../../etc/passwd",
    "/modules/../../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/..%2f..%2fetc%2fpasswd",
    "/....//....//etc/passwd",
  ]) {
    assert.notEqual(status(attack), 200, `${attack} must not be served`);
  }
});

test("malformed encoding is rejected, not thrown", () => {
  assert.equal(status("/%E0%A4%A"), 400);
  assert.equal(status("/index%00.html"), 400);
});

test("unlisted extensions are not downloadable", () => {
  for (const file of ["/mobile/android/app/aurum-release.keystore", "/vercel.json", "/package-lock.json.md"]) {
    assert.equal(status(file), 404);
  }
});

test("sibling directories sharing the root prefix are unreachable", () => {
  // ROOT + "-backup" startsWith(ROOT) is true, which the old check allowed.
  assert.notEqual(status("/../aurum-quant-ai-apk-backup/index.html"), 200);
});
