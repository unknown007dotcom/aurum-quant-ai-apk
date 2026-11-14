// Ingest policy for POST /api/learning-feedback (issue #22).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const policy = require("../lib/learning-feedback-policy");

test.beforeEach(() => policy.resetForTests());

test("accepts the outcomes the UI actually sends", () => {
  for (const outcome of ["win", "loss", "breakeven", "manual-note"]) {
    const body = { outcome, reason: outcome === "loss" ? "structure failed" : "" };
    assert.equal(policy.validateFeedback(body).ok, true, `${outcome} should be accepted`);
  }
  // The old handler only allowed win/loss, so breakeven and manual notes 400'd.
  assert.equal(policy.validateFeedback({ outcome: "BE" }).ok, false);
});

test("rejects unknown outcomes and reasons loss without a reason", () => {
  assert.equal(policy.validateFeedback({ outcome: "profit" }).status, 400);
  assert.equal(policy.validateFeedback({}).status, 400);
  assert.equal(policy.validateFeedback(null).status, 400);
  assert.equal(policy.validateFeedback({ outcome: "loss" }).status, 400);
  assert.equal(policy.validateFeedback({ outcome: "loss", reason: "   " }).status, 400);
});

test("only win/loss/breakeven move the global counters", () => {
  assert.equal(policy.validateFeedback({ outcome: "win" }).feedback.counted, true);
  assert.equal(policy.validateFeedback({ outcome: "loss", reason: "x" }).feedback.counted, true);
  assert.equal(policy.validateFeedback({ outcome: "breakeven" }).feedback.counted, true);
  assert.equal(
    policy.validateFeedback({ outcome: "manual-note", reason: "lesson" }).feedback.counted,
    false,
    "a manual note must not skew the win rate",
  );
});

test("fields are clamped to the documented limits", () => {
  const result = policy.validateFeedback({
    outcome: "loss",
    reason: "r".repeat(5000),
    summary: "s".repeat(5000),
    timeframe: "t".repeat(200),
    direction: "d".repeat(200),
    entryId: "e".repeat(200),
  });
  assert.equal(result.ok, true);
  for (const field of ["reason", "summary", "timeframe", "direction", "entryId"]) {
    assert.ok(
      result.feedback[field].length <= policy.LIMITS.MAX_FIELD[field],
      `${field} must be clamped to ${policy.LIMITS.MAX_FIELD[field]}`,
    );
  }
});

test("device id is required and validated", () => {
  assert.equal(policy.normalizeDeviceId("web-1234abcd-5678"), "web-1234abcd-5678");
  assert.equal(policy.normalizeDeviceId("short"), null);
  assert.equal(policy.normalizeDeviceId("has spaces here"), null);
  assert.equal(policy.normalizeDeviceId(undefined), null);
});

test("per-device rate limit applies", () => {
  const device = "web-1234abcd-5678";
  for (let i = 0; i < policy.LIMITS.MAX_WRITES_PER_HOUR; i += 1) {
    assert.equal(policy.isRateLimited(device), false, `write ${i} should pass`);
    policy.recordWrite(device);
  }
  assert.equal(policy.isRateLimited(device), true);
  assert.equal(policy.isRateLimited("web-9999ffff-0000"), false);
});

test("handler enforces the policy", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "api-handlers", "learning-feedback.js"), "utf8");
  assert.match(source, /validateFeedback/);
  assert.match(source, /normalizeDeviceId/);
  assert.match(source, /isRateLimited/);
  assert.match(source, /recordWrite/);
  assert.match(source, /if \(!counted\)/, "manual notes must skip the global totals");
  assert.match(source, /deviceId,/, "the row must record which device wrote it");
});

test("web client sends the device id with feedback", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const blocks = app.split("/learning-feedback`").slice(1);
  assert.equal(blocks.length, 2, "expected two feedback POSTs");
  const [rated, note] = blocks;
  assert.match(rated.slice(0, 900), /"x-device-id": feedbackDeviceId/);
  assert.match(rated.slice(0, 900), /deviceId: feedbackDeviceId/);
  assert.match(note.slice(0, 900), /"x-device-id": noteDeviceId/);
  assert.match(note.slice(0, 900), /deviceId: noteDeviceId/);
});
