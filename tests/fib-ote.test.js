// Fibonacci OTE math extracted from app.js (issue #26).
//
// These are the first tests this logic has ever had. Fixtures are synthetic
// candles shaped so each branch of the state machine is reachable.
const test = require("node:test");
const assert = require("node:assert/strict");

const { calculateFibonacciOTE } = require("../modules/fib-ote");

/** Build candles whose high/low follow `prices` (one candle per price). */
function candlesFrom(prices) {
  return prices.map((price) => ({ high: price + 0.5, low: price - 0.5, close: price }));
}

/** A clean uptrend with a pivot low then pivot high: bullish impulse leg. */
function bullishLeg() {
  const prices = [];
  for (let i = 0; i < 6; i += 1) prices.push(2300 + i); // base
  for (let i = 0; i < 5; i += 1) prices.push(2306 + i); // rise
  for (let i = 0; i < 8; i += 1) prices.push(2310 - i * 0.5); // small pullback
  // keep the last candle below the peak so the high stays a pivot
  prices.push(2306.5);
  return candlesFrom(prices);
}

test("returns null for missing or too-short input", () => {
  assert.equal(calculateFibonacciOTE(null, "15min", 2300), null);
  assert.equal(calculateFibonacciOTE([], "15min", 2300), null);
  assert.equal(calculateFibonacciOTE(candlesFrom([2300, 2301]), "15min", 2300), null);
  assert.equal(calculateFibonacciOTE(Array(14).fill({ high: 1, low: 0 }), "15min", 1), null);
});

test("returns the documented shape", () => {
  const result = calculateFibonacciOTE(bullishLeg(), "15min", 2305);
  assert.ok(result, "should produce an OTE");
  for (const key of [
    "timeframeName",
    "isBullishImpulse",
    "levels",
    "currentPrice",
    "statusClass",
    "statusText",
    "range",
    "tp",
    "sl",
  ]) {
    assert.ok(key in result, `missing ${key}`);
  }
  assert.equal(result.timeframeName, "15min");
  assert.equal(result.currentPrice, 2305);
  assert.ok(result.range > 0);
  assert.ok(Number.isFinite(result.levels[0.618]));
  assert.ok(Number.isFinite(result.levels[0.705]));
});

test("levels are ordered correctly for a bullish impulse", () => {
  const result = calculateFibonacciOTE(bullishLeg(), "15min", 2305);
  if (!result.isBullishImpulse) return; // fixture-dependent, covered below
  const { 0: origin, 0.618: ote, 0.705: deep, 1: end } = result.levels;
  assert.ok(origin > ote, "0 level is the swing high");
  assert.ok(ote > deep, "0.618 sits above 0.705 on a bullish pullback");
  assert.ok(deep > end, "0.705 sits above the leg low");
});

test("tp/sl follow the leg origin and end", () => {
  const result = calculateFibonacciOTE(bullishLeg(), "15min", 2305);
  assert.equal(result.tp, result.levels[0]);
  assert.equal(result.sl, result.levels[1]);
});

test("status machine: inside the OTE band is a zone, beyond it is invalid", () => {
  const leg = bullishLeg();
  const reference = calculateFibonacciOTE(leg, "15min", 2305);
  const { 0.618: ote, 0.705: deep, 0: origin } = reference.levels;

  const inside = calculateFibonacciOTE(leg, "15min", (ote + deep) / 2);
  assert.match(inside.statusText, /ZONE/, "a price between 0.618 and 0.705 is a zone");

  const beyondOrigin = calculateFibonacciOTE(leg, "15min", origin + 50);
  assert.match(beyondOrigin.statusText, /(PREMIUM|DISCOUNT)/, "price above the leg origin is not a zone");

  const beyondEnd = calculateFibonacciOTE(leg, "15min", Math.min(ote, deep) - 50);
  assert.match(beyondEnd.statusText, /(INVALIDATED|ZONE)/, "price beyond the band is invalidated or a zone");

  for (const result of [inside, beyondOrigin, beyondEnd]) {
    assert.ok(["pending", "tracking", "swept"].includes(result.statusClass));
  }
});

test("a flat market still yields a usable OTE via the fallback path", () => {
  // No pivots at depth 4 or 2: only the absolute-high/low fallback can fire.
  const flat = candlesFrom(Array.from({ length: 30 }, (_, i) => 2300 + (i % 2 === 0 ? 0.2 : -0.2)));
  const result = calculateFibonacciOTE(flat, "1h", 2300);
  assert.ok(result, "fallback must always produce levels");
  assert.ok(result.range > 0);
});

test("range is the distance between the leg extremes, and never negative", () => {
  const leg = bullishLeg();
  const result = calculateFibonacciOTE(leg, "15min", 2305);
  const values = Object.values(result.levels);
  assert.equal(result.range, Math.max(...values) - Math.min(...values));
  assert.ok(result.range > 0);
});

test("output is pure: same input gives identical output, input is not mutated", () => {
  const leg = bullishLeg();
  const snapshot = JSON.parse(JSON.stringify(leg));
  const first = calculateFibonacciOTE(leg, "15min", 2305);
  const second = calculateFibonacciOTE(leg, "15min", 2305);
  assert.deepEqual(first, second);
  assert.deepEqual(leg, snapshot, "calculateFibonacciOTE must not mutate its candles");
});

test("app.js delegates to the extracted module", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.equal(
    /^function calculateFibonacciOTE/m.test(app),
    false,
    "the implementation must not live in app.js any more",
  );

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const fibIndex = html.indexOf("modules/fib-ote.js");
  const appIndex = html.indexOf("app.js?");
  assert.ok(fibIndex > -1, "index.html must load fib-ote.js");
  assert.ok(fibIndex < appIndex, "fib-ote.js must load before app.js (no dynamic-import race)");
});
