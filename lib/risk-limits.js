/**
 * Hard server-side risk limits for live trading.
 *
 * runBotTick() already gated live orders behind TRADING_BOT_ALLOW_LIVE plus a
 * trading-window/cooldown check (CODE_REVIEW.md §10 praised that), but nothing
 * bounded *how much* a single tick could risk: botUnits came straight from
 * settings with no cap, there was no daily-loss stop, and no kill-switch.
 *
 * This module is deliberately independent of UI input and of any single caller:
 * it takes the settings, the account state and the order the bot is about to
 * place, and returns allow/deny with a reason. Callers must treat any denial as
 * fatal for that tick — never clamp and continue, because a clamped order is a
 * silently different trade from the one that was analysed.
 *
 * Environment overrides (all optional, all sane defaults):
 *   RISK_MAX_UNITS            default 1000   max absolute units per order
 *   RISK_MAX_OPEN_POSITIONS   default 1      concurrent open trades per instrument
 *   RISK_MAX_DAILY_LOSS       default 100    account currency, realised, per UTC day
 *   RISK_MAX_DAILY_ORDERS     default 20     live orders per UTC day
 *   RISK_KILL_SWITCH          "true" blocks every live order regardless of mode
 */

const DEFAULT_LIMITS = {
  maxUnits: 1000,
  maxOpenPositions: 1,
  maxDailyLoss: 100,
  maxDailyOrders: 20,
};

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLimits() {
  return {
    maxUnits: intFromEnv("RISK_MAX_UNITS", DEFAULT_LIMITS.maxUnits),
    maxOpenPositions: intFromEnv("RISK_MAX_OPEN_POSITIONS", DEFAULT_LIMITS.maxOpenPositions),
    maxDailyLoss: numberFromEnv("RISK_MAX_DAILY_LOSS", DEFAULT_LIMITS.maxDailyLoss),
    maxDailyOrders: intFromEnv("RISK_MAX_DAILY_ORDERS", DEFAULT_LIMITS.maxDailyOrders),
  };
}

function isKillSwitchEngaged() {
  return String(process.env.RISK_KILL_SWITCH || "").trim().toLowerCase() === "true";
}

/** UTC midnight for the timestamp — the accounting day used by the limits. */
function utcDayStart(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Realised P&L for the current UTC day, from closed trades.
 * Trades are expected to carry `realizedPL` (OANDA's field name) and either
 * `closeTime` or `closedAt`.
 */
function realisedLossToday(closedTrades = [], now = Date.now()) {
  const dayStart = utcDayStart(now);
  let total = 0;
  for (const trade of Array.isArray(closedTrades) ? closedTrades : []) {
    const closedAt = Date.parse(String(trade?.closeTime || trade?.closedAt || ""));
    if (!Number.isFinite(closedAt) || closedAt < dayStart) continue;
    const pl = Number(trade?.realizedPL ?? trade?.realizedPl ?? trade?.pl ?? 0);
    if (Number.isFinite(pl)) total += pl;
  }
  return total;
}

function liveOrdersToday(runtime, now = Date.now()) {
  const entries = Array.isArray(runtime?.liveOrderLog) ? runtime.liveOrderLog : [];
  const dayStart = utcDayStart(now);
  return entries.filter((ts) => Number.isFinite(Number(ts)) && Number(ts) >= dayStart).length;
}

/**
 * @param {object} input
 * @param {string} input.botMode            "manual" | "paper" | "live"
 * @param {number} input.units              requested units (sign ignored)
 * @param {number} input.openPositions      currently open trades
 * @param {object[]} [input.closedTrades]   closed trades with realizedPL
 * @param {object} [input.runtime]          bot runtime doc (liveOrderLog)
 * @param {number} [input.now]
 * @returns {{ allowed: boolean, reason: string, code: string, limits: object }}
 */
function checkLiveOrder(input = {}) {
  const limits = getLimits();
  const now = Number(input.now) || Date.now();
  const deny = (code, reason) => ({ allowed: false, code, reason, limits });

  if (String(input.botMode || "").toLowerCase() !== "live") {
    // Not our concern: paper/manual ticks never reach the order endpoint.
    return { allowed: true, code: "not-live", reason: "Not a live order.", limits };
  }

  if (isKillSwitchEngaged()) {
    return deny("kill-switch", "Kill switch engaged (RISK_KILL_SWITCH=true). Live orders are blocked.");
  }

  // Check the raw value: Math.abs() would turn -5 into a valid 5.
  const rawUnits = Number(input.units);
  if (!Number.isFinite(rawUnits) || rawUnits <= 0) {
    return deny("units-invalid", "Order size is not a positive number.");
  }
  const units = rawUnits;
  if (units > limits.maxUnits) {
    return deny(
      "units-max",
      `Order size ${units} exceeds the hard limit of ${limits.maxUnits} units. Refusing to place it.`,
    );
  }

  const openPositions = Number(input.openPositions) || 0;
  if (openPositions >= limits.maxOpenPositions) {
    return deny(
      "max-open-positions",
      `${openPositions} open position(s) already; the limit is ${limits.maxOpenPositions}.`,
    );
  }

  const pnl = realisedLossToday(input.closedTrades, now);
  if (pnl <= -limits.maxDailyLoss) {
    return deny(
      "daily-loss",
      `Daily loss limit reached (${pnl.toFixed(2)} vs -${limits.maxDailyLoss}). Trading halted for today.`,
    );
  }

  const ordersToday = liveOrdersToday(input.runtime, now);
  if (ordersToday >= limits.maxDailyOrders) {
    return deny(
      "daily-orders",
      `${ordersToday} live orders already placed today; the limit is ${limits.maxDailyOrders}.`,
    );
  }

  return { allowed: true, code: "ok", reason: "Within risk limits.", limits };
}

module.exports = {
  checkLiveOrder,
  getLimits,
  isKillSwitchEngaged,
  realisedLossToday,
  liveOrdersToday,
  utcDayStart,
  DEFAULT_LIMITS,
};
