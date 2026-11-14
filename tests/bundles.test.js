// Static checks on the shipped client/mobile bundles.
//
// The Android APK is built by copying mobile/www-extra/*.js verbatim into the
// WebView (see mobile/scripts/build-www.mjs). There is no bundler and no type
// check, so a mangled file only fails once a user installs the APK. These tests
// parse every shipped script so a syntax error fails CI instead.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function syntaxCheck(relPath) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, relPath)], { stdio: "pipe" });
    return null;
  } catch (error) {
    return String(error.stderr || error.message).split("\n").slice(0, 4).join(" ");
  }
}

const SHIPPED_SCRIPTS = [
  "app.js",
  "history.js",
  "server.js",
  "api/index.js",
  "modules/config.js",
  "mobile/www-extra/aurum-backend.js",
  "mobile/www-extra/mobile-runtime.js",
];

for (const script of SHIPPED_SCRIPTS) {
  test(`shipped script parses: ${script}`, () => {
    const file = path.join(ROOT, script);
    if (!fs.existsSync(file)) {
      // mobile-runtime.js is optional in the build.
      return;
    }
    let error = syntaxCheck(script);
    // ES modules (export/import) need an .mjs view for --check.
    if (error && /Unexpected token 'export'|Cannot use import statement|Failed to load the ES module|Unexpected token 'import'|import statement outside a module/i.test(error)) {
      const tmp = path.join(require("node:os").tmpdir(), `syntax-${path.basename(script)}.mjs`);
      fs.copyFileSync(file, tmp);
      try {
        execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
        error = null;
      } catch (moduleError) {
        error = String(moduleError.stderr || moduleError.message).split("\n").slice(0, 4).join(" ");
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    assert.equal(error, null, `${script} does not parse: ${error}`);
  });
}

test("no truncated '[...]' markers in shipped scripts", () => {
  // Two fallback payloads in the mobile backend were previously stored as
  // "binary-ish" truncated strings ending in "[...]", which made the whole file
  // a syntax error and left the APK without a working backend.
  const offenders = [];
  for (const script of SHIPPED_SCRIPTS) {
    const file = path.join(ROOT, script);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("[...]")) offenders.push(script);
  }
  assert.deepEqual(offenders, [], `truncated payload marker found in: ${offenders.join(", ")}`);
});
