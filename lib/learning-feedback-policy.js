/**
 * Ingest policy for POST /api/learning-feedback.
 *
 * The endpoint had no auth, no device id, no rate limit and no bounds. Each call
 * inserts a row and rewrites the `learning/global` document (total, wins, losses,
 * topLossReasons), which /api/learning-context feeds back into the AI prompt — so
 * an anonymous caller could rewrite the win-rate the model is conditioned on and
 * inject arbitrary "top loss reasons" into future prompts (issue #22).
 *
 * Same policy as history ingest (#18): identify the caller, validate and bound
 * the payload, then rate limit per device. In-memory per process — a speed bump,
 * not a distributed quota.
 */

const MAX_FIELD = {
  reason: 400,
  summary: 500,
  timeframe: 20,
  direction: 30,
  entryId: 80,
  analysisId: 80,
};

const VALID_OUTCOMES = ["win", "loss", "breakeven", "manual-note"];

const MAX_WRITES_PER_HOUR = 40;
const MAX_WRITES_PER_DAY = 200;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;

function clamp(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function normalizeDeviceId(raw) {
  const candidate = String(raw || "").trim();
  return DEVICE_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * @returns {{ ok: true, feedback: object } | { ok: false, status: number, message: string }}
 */
function validateFeedback(body) {
  const payload = body && typeof body === "object" ? body : {};

  const outcome = clamp(payload.outcome, 20).toLowerCase();
  if (!VALID_OUTCOMES.includes(outcome)) {
    return {
      ok: false,
      status: 400,
      message: `Outcome must be one of: ${VALID_OUTCOMES.join(", ")}.`,
    };
  }

  const reason = clamp(payload.reason, MAX_FIELD.reason);
  if (outcome === "loss" && !reason) {
    return { ok: false, status: 400, message: "Please provide what went wrong for loss entries." };
  }

  const feedback = {
    outcome,
    reason,
    summary: clamp(payload.summary, MAX_FIELD.summary),
    timeframe: clamp(payload.timeframe, MAX_FIELD.timeframe),
    direction: clamp(payload.direction, MAX_FIELD.direction),
    entryId: clamp(payload.entryId || payload.analysisId, MAX_FIELD.entryId),
  };

  // Only counted outcomes move the win/loss totals; a manual note must not.
  feedback.counted = outcome === "win" || outcome === "loss" || outcome === "breakeven";

  return { ok: true, feedback };
}

// ---- rate limiting (in-memory, per process) ----

const buckets = new Map();

function isRateLimited(key) {
  const now = Date.now();
  const entry = buckets.get(key) || { hour: [], day: [] };
  entry.hour = entry.hour.filter((ts) => now - ts < 60 * 60 * 1000);
  entry.day = entry.day.filter((ts) => now - ts < 24 * 60 * 60 * 1000);
  buckets.set(key, entry);
  return entry.hour.length >= MAX_WRITES_PER_HOUR || entry.day.length >= MAX_WRITES_PER_DAY;
}

function recordWrite(key) {
  const now = Date.now();
  const entry = buckets.get(key) || { hour: [], day: [] };
  entry.hour.push(now);
  entry.day.push(now);
  buckets.set(key, entry);
  if (buckets.size > 5000) {
    for (const [bucketKey, value] of buckets) {
      if (!value.hour.length && !value.day.length) buckets.delete(bucketKey);
      if (buckets.size <= 4000) break;
    }
  }
}

function resetForTests() {
  buckets.clear();
}

module.exports = {
  validateFeedback,
  normalizeDeviceId,
  isRateLimited,
  recordWrite,
  resetForTests,
  VALID_OUTCOMES,
  LIMITS: { MAX_WRITES_PER_HOUR, MAX_WRITES_PER_DAY, MAX_FIELD },
};
