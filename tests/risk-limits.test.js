// Hard live-trading risk limits (issue #31, CODE_REVIEW.md §10).
const test = require("node:test");
const assert = require("node:assert/strict");

const risk = require("../lib/risk-limits");

const ENV_KEYS = ["RISK_MAX_UNITS", "RISK_MAX_OPEN_POSITIONS", "RISK_MAX_DAILY_LOSS", "RISK_MAX_DAILY_ORDERS", "RISK_KILL_SWITCH"];

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

const liveOrder = (overrides = {}) => ({
  botMode: "live",
  units: 10,
  openPositions: 0,
  closedTrades: [],
  runtime: {},
  ...overrides,
});

test("default limits are sane and documented", () => {
  const limits = risk.getLimits();
  assert.equal(limits.maxUnits, risk.DEFAULT_LIMITS.maxUnits);
  assert.equal(limits.maxOpenPositions, 1);
  assert.equal(limits.maxDailyOrders, 20);
  assert.ok(limits.maxDailyLoss > 0);
});

test("a modest live order is allowed", () => {
  const result = risk.checkLiveOrder(liveOrder());
  assert.equal(result.allowed, true);
  assert.equal(result.code, "ok");
});

test("position size above the cap is refused, not clamped", () => {
  const result = risk.checkLiveOrder(liveOrder({ units: 1_000_000 }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, "units-max");
  assert.match(result.reason, /exceeds the hard limit/);
});

test("zero/negative/NaN size is refused", () => {
  for (const units of [0, -5, NaN, "abc"]) {
    const result = risk.checkLiveOrder(liveOrder({ units }));
    assert.equal(result.allowed, false, `units=${units} must be refused`);
    assert.equal(result.code, "units-invalid");
  }
});

test("max open positions blocks a second concurrent trade", () => {
  const result = risk.checkLiveOrder(liveOrder({ openPositions: 1 }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, "max-open-positions");
});

test("daily loss limit stops trading", () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const closedTrades = [
    { realizedPL: "-60.00", closeTime: new Date(now - 3600_000).toISOString() },
    { realizedPL: "-45.00", closeTime: new Date(now - 1800_000).toISOString() },
  ];
  const result = risk.checkLiveOrder(liveOrder({ closedTrades, now }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, "daily-loss");
  assert.match(result.reason, /halted for today/);
});

test("losses from a previous UTC day do not count", () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const closedTrades = [
    { realizedPL: "-500.00", closeTime: new Date(now - 36 * 3600_000).toISOString() },
  ];
  assert.equal(risk.realisedLossToday(closedTrades, now), 0);
  assert.equal(risk.checkLiveOrder(liveOrder({ closedTrades, now })).allowed, true);
});

test("profitable days offset earlier losses, as realised P&L net", () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const closedTrades = [
    { realizedPL: "-80.00", closeTime: new Date(now - 7200_000).toISOString() },
    { realizedPL: "60.00", closeTime: new Date(now - 3600_000).toISOString() },
  ];
  assert.equal(risk.realisedLossToday(closedTrades, now), -20);
  assert.equal(risk.checkLiveOrder(liveOrder({ closedTrades, now })).allowed, true);
});

test("daily order cap blocks the tide of orders", () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const runtime = { liveOrderLog: Array.from({ length: 20 }, (_, i) => now - i * 1000) };
  const result = risk.checkLiveOrder(liveOrder({ runtime, now }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, "daily-orders");
});

test("kill switch blocks every live order regardless of mode settings", () => {
  process.env.RISK_KILL_SWITCH = "true";
  const result = risk.checkLiveOrder(liveOrder({ units: 1 }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, "kill-switch");
  assert.equal(risk.isKillSwitchEngaged(), true);

  process.env.RISK_KILL_SWITCH = "false";
  assert.equal(risk.checkLiveOrder(liveOrder({ units: 1 })).allowed, true);
});

test("paper and manual modes are not blocked by live limits", () => {
  process.env.RISK_KILL_SWITCH = "true";
  // The kill switch still blocks anything claiming to be live, but paper ticks
  // never reach the order endpoint.
  for (const botMode of ["paper", "manual"]) {
    const result = risk.checkLiveOrder(liveOrder({ botMode }));
    assert.equal(result.code, "not-live");
  }
});

test("env overrides raise or lower the caps", () => {
  process.env.RISK_MAX_UNITS = "5000";
  assert.equal(risk.checkLiveOrder(liveOrder({ units: 4000 })).allowed, true);
  process.env.RISK_MAX_UNITS = "100";
  assert.equal(risk.checkLiveOrder(liveOrder({ units: 4000 })).allowed, false);
});

test("utcDayStart is midnight UTC, not local", () => {
  const start = risk.utcDayStart(Date.UTC(2026, 10, 14, 23, 59, 59));
  assert.equal(new Date(start).toISOString(), "2026-11-14T00:00:00.000Z");
});

test("trading-bot wires the limits before createMarketOrder", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "trading-bot.js"), "utf8");
  const guardIndex = source.indexOf("checkLiveOrder(");
  const orderIndex = source.indexOf("createMarketOrder({");
  assert.ok(guardIndex > -1, "trading-bot must call checkLiveOrder");
  assert.ok(guardIndex < orderIndex, "the risk check must run before the order is placed");
  assert.match(source, /Risk limit: \$\{risk\.reason\}/, "a denial must surface the reason");
  assert.match(source, /liveOrderLog/, "live orders must be logged for the daily cap");
});
