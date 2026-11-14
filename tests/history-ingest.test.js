// Ingest policy for POST /api/history-log (issue #18).
const test = require("node:test");
const assert = require("node:assert/strict");

const ingest = require("../lib/history-ingest");

const validEntry = () => ({
  id: Date.now(),
  deviceId: "web-1234abcd-5678",
  price: 2341.5,
  bias: "Buy",
  tp1: 2347,
  tp2: 2352,
  sl: 2336,
  outcome: "pending",
});

test.beforeEach(() => ingest.resetForTests());

test("accepts a realistic entry", () => {
  const result = ingest.validateEntry(validEntry());
  assert.equal(result.ok, true);
  assert.equal(result.entry.bias, "Buy");
  assert.equal(result.entry.price, 2341.5);
});

test("rejects missing, non-object and unrecognisable payloads", () => {
  assert.equal(ingest.validateEntry(null).status, 400);
  assert.equal(ingest.validateEntry("nope").status, 400);
  assert.equal(ingest.validateEntry([1, 2, 3]).status, 400);
  assert.equal(ingest.validateEntry({}).status, 400);
  assert.equal(ingest.validateEntry({ deviceId: "web-1234abcd" }).status, 400);
});

test("rejects entries that stay too big after clamping", () => {
  // Each field is clamped to 2000 chars, so overflow them all: the surviving
  // 16 fields still exceed the 32 KiB storage budget.
  const huge = validEntry();
  for (let i = 0; i < 24; i += 1) huge[`field${i}`] = "z".repeat(2000);
  assert.equal(ingest.validateEntry(huge).status, 413);
});

test("clamps strings and arrays instead of trusting them", () => {
  const entry = validEntry();
  entry.aiOverlay = "y".repeat(50_000);
  entry.executionOverview = Array.from({ length: 500 }, () => "line");
  const result = ingest.validateEntry(entry);
  assert.equal(result.ok, true);
  assert.ok(result.entry.aiOverlay.length <= 2000);
  assert.ok(result.entry.executionOverview.length <= 200);
});

test("drops prototype-polluting keys", () => {
  const entry = validEntry();
  entry["__proto__"] = { polluted: true };
  entry["$where"] = "1==1";
  entry.constructor = { bad: true };
  const result = ingest.validateEntry(entry);
  assert.equal(result.ok, true);
  assert.equal("$where" in result.entry, false);
  assert.equal({}.polluted, undefined);
});

test("device ids are validated, not silently invented", () => {
  assert.equal(ingest.normalizeDeviceId("web-1234abcd-5678"), "web-1234abcd-5678");
  assert.equal(ingest.normalizeDeviceId("android-abc12345"), "android-abc12345");
  assert.equal(ingest.normalizeDeviceId("short"), null);
  assert.equal(ingest.normalizeDeviceId("has spaces in it"), null);
  assert.equal(ingest.normalizeDeviceId("x".repeat(200)), null);
  assert.equal(ingest.normalizeDeviceId(""), null);
  assert.equal(ingest.normalizeDeviceId(undefined), null);
  // The old behaviour hashed the User-Agent into a shared bucket.
  assert.equal(ingest.normalizeDeviceId("Mozilla/5.0 (Windows NT 10.0)"), null);
});

test("per-device write rate limit kicks in", () => {
  const device = "web-1234abcd-5678";
  for (let i = 0; i < ingest.LIMITS.MAX_WRITES_PER_HOUR; i += 1) {
    assert.equal(ingest.isRateLimited(device).limited, false, `write ${i} should be allowed`);
    ingest.recordWrite(device);
  }
  assert.equal(ingest.isRateLimited(device).limited, true);
  // A different device is unaffected.
  assert.equal(ingest.isRateLimited("web-9999ffff-0000").limited, false);
});

test("auto-learn fan-out is throttled", () => {
  assert.equal(ingest.shouldTriggerAutoLearn(), true);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(ingest.shouldTriggerAutoLearn(), false);
  }
});

test("handler enforces the policy", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "api-handlers", "history-log.js"), "utf8");
  assert.match(source, /validateEntry/, "payload must be validated");
  assert.match(source, /normalizeDeviceId/, "device id must be required");
  assert.match(source, /isRateLimited/, "writes must be rate limited");
  assert.match(source, /shouldTriggerAutoLearn/, "auto-learn must be throttled");
  assert.equal(
    /browser-\$\{hashFromString/.test(source),
    false,
    "anonymous User-Agent hashing must be gone",
  );
});

test("clients send a device id", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /function getDeviceId\(\)/, "web client needs a stable device id");
  assert.match(app, /"x-device-id": deviceId/, "web client must send the header");

  const mobile = fs.readFileSync(path.join(__dirname, "..", "mobile", "www-extra", "aurum-backend.js"), "utf8");
  assert.match(mobile, /function getDeviceId\(\)/, "android client needs a stable device id");
  assert.match(mobile, /deviceId: String\(entry\.deviceId \|\| \(await getDeviceId\(\)\)\)/);
});
