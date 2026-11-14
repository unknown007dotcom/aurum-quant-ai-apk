/**
 * Ingest policy for POST /api/history-log.
 *
 * CODE_REVIEW.md §4: the endpoint had no auth and no validation, so anyone could
 * inject fabricated entries, which then feed /api/auto-learn and the win-rate
 * stats. Fully closing that needs a real session, which this single-user tool
 * does not have — so the policy here is defence in depth instead:
 *
 *   1. a caller must identify itself with a real device id (no silent UA hash),
 *   2. the payload is validated and bounded (size, string lengths, array lengths,
 *      numeric fields) so a single write cannot bloat the store,
 *   3. writes are rate limited per device and per instance,
 *   4. the auto-learn trigger is throttled so writes cannot be used to fan out
 *      into expensive AI runs,
 *   5. a valid admin password bypasses the rate limit (trusted operator).
 *
 * Rate limiting is in-memory per process: it is a speed bump, not a distributed
 * quota. Tighten Firestore rules as well — this cannot protect direct DB access.
 */

const MAX_ENTRY_BYTES = 32 * 1024;
const MAX_STRING = 2000;
const MAX_ARRAY = 200;
const MAX_WRITES_PER_HOUR = 60;
const MAX_WRITES_PER_DAY = 400;
const AUTO_LEARN_MIN_INTERVAL_MS = 10 * 60 * 1000;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;

const NUMERIC_FIELDS = [
  "price",
  "entryPrice",
  "tp1",
  "tp2",
  "tp3",
  "sl",
  "stopPrice",
  "rmi",
  "debateAttempted",
  "debateSuccessful",
  "createdAt",
  "confidence",
  "tdsScore",
];

function clampString(value, limit = MAX_STRING) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeDeviceId(raw) {
  const candidate = String(raw || "").trim();
  return DEVICE_ID_PATTERN.test(candidate) ? candidate : null;
}

function boundedArray(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, MAX_ARRAY).map((item) => (typeof item === "string" ? clampString(item, 500) : item));
}

/**
 * @returns {{ ok: true, entry: object } | { ok: false, status: number, message: string }}
 */
function validateEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, status: 400, message: "Missing history entry." };
  }

  // Cheap shape check first (a huge single string would be clamped below), but a
  // pathological object graph is rejected without walking it.
  try {
    JSON.stringify(entry, (key, value) => {
      if (typeof value === "string" && value.length > MAX_ENTRY_BYTES * 4) {
        throw new Error("field too large");
      }
      return value;
    });
  } catch {
    return { ok: false, status: 413, message: `History entry too large (limit ${MAX_ENTRY_BYTES} bytes).` };
  }

  const clean = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof key !== "string" || key.length > 80) continue;
    if (/^\$|__proto__|constructor|prototype/.test(key)) continue;

    if (typeof value === "string") {
      clean[key] = clampString(value);
    } else if (typeof value === "number") {
      clean[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === "boolean" || value === null) {
      clean[key] = value;
    } else if (Array.isArray(value)) {
      clean[key] = boundedArray(value);
    } else if (value && typeof value === "object") {
      // One nested level is all the UI needs (tradeLevels, debateConsensus, ...).
      const nested = {};
      for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, 40)) {
        if (typeof nestedKey !== "string" || nestedKey.length > 80) continue;
        if (/^\$|__proto__|constructor|prototype/.test(nestedKey)) continue;
        if (typeof nestedValue === "string") nested[nestedKey] = clampString(nestedValue, 500);
        else if (typeof nestedValue === "number") nested[nestedKey] = Number.isFinite(nestedValue) ? nestedValue : null;
        else if (typeof nestedValue === "boolean" || nestedValue === null) nested[nestedKey] = nestedValue;
        else if (Array.isArray(nestedValue)) nested[nestedKey] = boundedArray(nestedValue);
      }
      clean[key] = nested;
    }
  }

  for (const field of NUMERIC_FIELDS) {
    if (field in clean && clean[field] !== null && !Number.isFinite(Number(clean[field]))) {
      delete clean[field];
    }
  }

  const recognised = ["price", "bias", "direction", "aiOverlay", "executionOverview", "outcome", "tp1", "tp2", "sl"];
  if (!recognised.some((field) => field in clean)) {
    return { ok: false, status: 400, message: "History entry has no recognisable fields." };
  }

  // After clamping, the sanitised entry must still fit the storage budget.
  if (JSON.stringify(clean).length > MAX_ENTRY_BYTES) {
    return { ok: false, status: 413, message: `History entry too large (limit ${MAX_ENTRY_BYTES} bytes).` };
  }

  return { ok: true, entry: clean };
}

// ---- rate limiting (in-memory, per process) ----

const buckets = new Map();

function nowMs() {
  return Date.now();
}

function prune(entry, now) {
  entry.hour = entry.hour.filter((ts) => now - ts < 60 * 60 * 1000);
  entry.day = entry.day.filter((ts) => now - ts < 24 * 60 * 60 * 1000);
}

function isRateLimited(key) {
  const now = nowMs();
  const entry = buckets.get(key) || { hour: [], day: [] };
  prune(entry, now);
  const limited = entry.hour.length >= MAX_WRITES_PER_HOUR || entry.day.length >= MAX_WRITES_PER_DAY;
  buckets.set(key, entry);
  return limited ? { limited: true, retryAfterSeconds: 600 } : { limited: false };
}

function recordWrite(key) {
  const now = nowMs();
  const entry = buckets.get(key) || { hour: [], day: [] };
  entry.hour.push(now);
  entry.day.push(now);
  buckets.set(key, entry);
  // Keep the map from growing without bound under a spray of fake device ids.
  if (buckets.size > 5000) {
    for (const [bucketKey, value] of buckets) {
      prune(value, now);
      if (!value.hour.length && !value.day.length) buckets.delete(bucketKey);
      if (buckets.size <= 4000) break;
    }
  }
}

let lastAutoLearnAt = 0;
function shouldTriggerAutoLearn() {
  const now = nowMs();
  if (now - lastAutoLearnAt < AUTO_LEARN_MIN_INTERVAL_MS) return false;
  lastAutoLearnAt = now;
  return true;
}

function resetForTests() {
  buckets.clear();
  lastAutoLearnAt = 0;
}

module.exports = {
  validateEntry,
  normalizeDeviceId,
  isRateLimited,
  recordWrite,
  shouldTriggerAutoLearn,
  resetForTests,
  LIMITS: {
    MAX_ENTRY_BYTES,
    MAX_WRITES_PER_HOUR,
    MAX_WRITES_PER_DAY,
    AUTO_LEARN_MIN_INTERVAL_MS,
  },
};
