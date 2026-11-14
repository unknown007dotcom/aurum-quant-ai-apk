// Worker CORS allow-list (issue #20).
//
// cloudflare-backend/src/index.js is a Worker module with a top-level `export
// default`, so it cannot be imported by a CommonJS test. Extract the pure helpers
// and evaluate them in a VM instead - that keeps the assertions on the real code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "cloudflare-backend", "src", "index.js"), "utf8");

function extract(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist in the worker`);
  const end = SOURCE.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}`);
  return SOURCE.slice(start, end);
}

const helperSource = [
  extract("const ALLOWED_ORIGINS = [", "const GRANULARITY_MAP"),
  extract("function corsHeaders(request) {", "function normalizeInstrument"),
].join("\n");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${helperSource}\nthis.isAllowedOrigin = isAllowedOrigin; this.corsHeaders = corsHeaders;`, sandbox);

const { isAllowedOrigin, corsHeaders } = sandbox;
const req = (origin) => ({ headers: { get: (name) => (name.toLowerCase() === "origin" ? origin : null) } });

test("own origins are allowed", () => {
  assert.equal(isAllowedOrigin("https://aurum-quant-ai.vercel.app"), true);
  assert.equal(isAllowedOrigin("http://localhost:3000"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:3000"), true);
});

test("preview deployments, LAN ports and packaged apps are allowed", () => {
  assert.equal(isAllowedOrigin("https://aurum-quant-ai-git-main-unknown.vercel.app"), true);
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("http://192.168.1.5:3000"), false, "raw LAN IPs are not needed");
  assert.equal(isAllowedOrigin("capacitor://localhost"), true);
  assert.equal(isAllowedOrigin("ionic://localhost"), true);
});

test("arbitrary origins are rejected", () => {
  for (const origin of [
    "https://evil.example",
    "https://aurum-quant-ai.vercel.app.evil.example",
    "https://evil-aurum-quant-ai.vercel.app",
    "http://localhost.evil.example",
    "null",
    "",
    undefined,
  ]) {
    assert.equal(isAllowedOrigin(origin), false, `${origin} must be rejected`);
  }
});

test("corsHeaders echoes only allowed origins", () => {
  const good = corsHeaders(req("https://aurum-quant-ai.vercel.app"));
  assert.equal(good["Access-Control-Allow-Origin"], "https://aurum-quant-ai.vercel.app");
  assert.equal(good.Vary, "Origin");

  const bad = corsHeaders(req("https://evil.example"));
  assert.equal("Access-Control-Allow-Origin" in bad, false, "unknown origin must get no ACAO header");
  assert.equal(bad.Vary, "Origin");
});

test("no-Origin requests and malformed requests do not throw", () => {
  const none = corsHeaders(req(undefined));
  assert.equal("Access-Control-Allow-Origin" in none, false);
  assert.doesNotThrow(() => corsHeaders({}));
  assert.doesNotThrow(() => corsHeaders(null));
});

test("the old reflect-anything pattern is gone", () => {
  assert.equal(
    /Access-Control-Allow-Origin":\s*origin/.test(SOURCE),
    false,
    "must not reflect the request Origin directly",
  );
  assert.equal(/headers\.get\("Origin"\) \|\| "\*"/.test(SOURCE), false, "must not default to *");
});
