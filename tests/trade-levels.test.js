// Regression tests for the history trade-level parser (issue #5).
const test = require("node:test");
const assert = require("node:assert/strict");

// modules/trade-levels.mjs is an ES module consumed by history.js; load it the
// same way the browser does.
const loadParser = () => import("../modules/trade-levels.mjs");
const tps = (levels) => levels.map((item) => `${item.level}:${item.price}`);

test("TP labels with explicit levels", async () => {
  const { parseTakeProfits } = await loadParser();
  assert.deepEqual(tps(parseTakeProfits("TP1 2341.00, TP2 2342.50", [])), ["1:2341", "2:2342.5"]);
  assert.deepEqual(
    tps(parseTakeProfits("", ["TP1 2341.00, TP2 2342.50, TP3 2344.00"])),
    ["1:2341", "2:2342.5", "3:2344"],
  );
  assert.deepEqual(
    tps(parseTakeProfits("Take Profit 1: 2,341.00\nTake Profit 2: 2,335.00", [])),
    ["1:2341", "2:2335"],
  );
  assert.deepEqual(tps(parseTakeProfits("Take-Profit: 2350.00", [])), ["1:2350"]);
  assert.deepEqual(tps(parseTakeProfits("TP 1 2341.00, TP 2 2350.00", [])), ["1:2341", "2:2350"]);
});

test("equals sign no longer parses the level as the price (was 1, 2)", async () => {
  const { parseTakeProfits } = await loadParser();
  assert.deepEqual(tps(parseTakeProfits("TP1 = 2341.00, TP2 = 2347.00", [])), ["1:2341", "2:2347"]);
});

test("a bare price is not eaten as a level (was 350 at level 2)", async () => {
  const { parseTakeProfits } = await loadParser();
  assert.deepEqual(tps(parseTakeProfits("Target 2350 at a 1.5% gain", [])), ["1:2350"]);
  assert.deepEqual(tps(parseTakeProfits("Take profit at 2350 for a 1.5 percent move", [])), ["1:2350"]);
});

test("separator lists are expanded (was empty)", async () => {
  const { parseTakeProfits } = await loadParser();
  const expected = ["1:2345", "2:2350", "3:2355"];
  assert.deepEqual(tps(parseTakeProfits("Targets: 2345 / 2350 / 2355", [])), expected);
  assert.deepEqual(tps(parseTakeProfits("Targets: 2345, 2350 and 2355", [])), expected);
});

test("duplicate labels and repeated prices are normalised", async () => {
  const { parseTakeProfits } = await loadParser();
  // "TP:" then "TP2" -> levels 1 and 2, not 1 and 2-with-gap
  assert.deepEqual(tps(parseTakeProfits("TP: 2341.00 (TP2 2347.00)", [])), ["1:2341", "2:2347"]);
  // same price listed twice collapses
  assert.deepEqual(tps(parseTakeProfits("TP1 2341.00, TP2 2341.00", [])), ["1:2341"]);
  // a repeated TP1 is demoted instead of colliding
  assert.deepEqual(tps(parseTakeProfits("TP1 2341.00, TP1 2347.00", [])), ["1:2341", "2:2347"]);
});

test("entry zone price is never echoed as a take profit", async () => {
  const { parseTakeProfits } = await loadParser();
  const parsed = parseTakeProfits("TP1 2341.00, TP2 2347.00", [], { entryZone: "2340.00-2342.00" });
  assert.equal(parsed.some((item) => item.price === 2342), false);
});

test("caps at three levels and ignores non-price numbers", async () => {
  const { parseTakeProfits } = await loadParser();
  assert.equal(parseTakeProfits("TP1 2341, TP2 2347, TP3 2352, TP4 2360", []).length, 3);
  assert.deepEqual(parseTakeProfits("no levels here", []), []);
  assert.deepEqual(parseTakeProfits("", []), []);
  assert.deepEqual(parseTakeProfits(undefined, undefined), []);
});
