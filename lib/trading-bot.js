const { getAdminSettings, getFirestore } = require("./firebase-admin");
const { createMarketOrder, fetchMtfPayload, fetchPrice, getOandaConfig, listOpenTrades, normalizeInstrument } = require("./oanda");
const Liquidity = require("./liquidity-engine");

const BOT_RUNTIME_COLLECTION = "bot";
const BOT_RUNTIME_DOC = "runtime";

async function getBotStatus() {
  const settings = await safeSettings();
  const oanda = await safeOandaConfig();
  const runtime = await safeRuntime();

  let latestPrice = null;
  let openTrades = [];
  let connectionError = "";

  if (oanda.configured) {
    try {
      latestPrice = await fetchPrice({ instrument: settings.botInstrument || oanda.instrument });
      openTrades = await listOpenTrades({ instrument: settings.botInstrument || oanda.instrument });
    } catch (error) {
      connectionError = error?.message || "OANDA request failed.";
    }
  }

  return {
    configured: oanda.configured,
    environment: oanda.environment || "practice",
    instrument: normalizeInstrument(settings.botInstrument || oanda.instrument || "XAU_USD"),
    botEnabled: Boolean(settings.botEnabled),
    botMode: normalizeBotMode(settings.botMode),
    units: normalizeInteger(settings.botUnits, 10),
    stopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    takeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    cooldownMinutes: normalizeInteger(settings.botCooldownMinutes, 15),
    pollIntervalSeconds: normalizeInteger(settings.botPollIntervalSeconds, 60),
    latestPrice: latestPrice?.mid || runtime?.lastPrice || null,
    latestPriceTime: latestPrice?.time || runtime?.lastPriceTime || "",
    openTradesCount: Array.isArray(openTrades) ? openTrades.length : 0,
    runtime,
    connectionError,
    accountIdResolved: Boolean(oanda.accountId),
  };
}

async function updateBotSettings(patch) {
  const db = getFirestore();
  await db.collection("admin").doc("settings").set(patch, { merge: true });
  return getBotStatus();
}

async function setBotEnabled(enabled) {
  return updateBotSettings({ botEnabled: Boolean(enabled) });
}

async function runBotTick(options = {}) {
  const source = String(options.source || "manual");
  const executeTrades = Boolean(options.executeTrades);
  const settings = await safeSettings();
  const oanda = await getOandaConfig();

  if (!oanda.configured) {
    const status = await saveRuntime({
      lastTickAt: Date.now(),
      lastSource: source,
      lastAction: "blocked",
      lastReason: "OANDA is not configured.",
    });
    return { ok: false, message: "OANDA is not configured.", status };
  }

  const botConfig = {
    instrument: normalizeInstrument(settings.botInstrument || oanda.instrument || "XAU_USD"),
    botMode: normalizeBotMode(settings.botMode),
    botEnabled: Boolean(settings.botEnabled),
    units: normalizeInteger(settings.botUnits, 10),
    stopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    takeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    cooldownMinutes: normalizeInteger(settings.botCooldownMinutes, 15),
    pollIntervalSeconds: normalizeInteger(settings.botPollIntervalSeconds, 60),
  };

  const [mtfData, latestPrice, runtime, openTrades] = await Promise.all([
    fetchMtfPayload({ instrument: botConfig.instrument, entryTf: "15min", outputsize: 200 }),
    fetchPrice({ instrument: botConfig.instrument }),
    safeRuntime(),
    listOpenTrades({ instrument: botConfig.instrument }).catch(() => []),
  ]);

  const analysis = analyzeMtfData(mtfData, latestPrice);
  applyBotRiskProfile(analysis, botConfig);
  const windowCheck = checkTradingWindow();
  const cooldownCheck = checkCooldown(runtime?.lastExecutedAt, botConfig.cooldownMinutes);
  const openTradeExists = Array.isArray(openTrades) && openTrades.length > 0;

  let action = "preview";
  let reason = "Manual preview generated.";
  let orderResponse = null;

  if (executeTrades) {
    if (!botConfig.botEnabled) {
      action = "skipped";
      reason = "Bot is stopped.";
    } else if (botConfig.botMode === "manual") {
      action = "skipped";
      reason = "Bot mode is manual.";
    } else if (!windowCheck.allowed) {
      action = "blocked";
      reason = windowCheck.reason;
    } else if (!cooldownCheck.allowed) {
      action = "skipped";
      reason = cooldownCheck.reason;
    } else if (openTradeExists) {
      action = "skipped";
      reason = `Existing open trade detected for ${botConfig.instrument}.`;
    } else if (botConfig.botMode === "live" && !isLiveTradingAllowed()) {
      action = "blocked";
      reason = "Live trading is disabled. Set TRADING_BOT_ALLOW_LIVE=true to permit order placement.";
    } else if (botConfig.botMode === "paper") {
      action = "paper-trade";
      reason = "Paper trade recorded.";
    } else if (botConfig.botMode === "live") {
      const units = analysis.decision.action === "Buy" ? botConfig.units : botConfig.units * -1;
      orderResponse = await createMarketOrder({
        instrument: botConfig.instrument,
        units,
        stopLoss: analysis.decision.stopPrice,
        takeProfit: analysis.decision.tp2,
        clientId: `aurum-${Date.now()}`,
        clientTag: "aurum-bot",
        clientComment: "Aurum Quant AI automated execution",
      });
      action = "live-order";
      reason = "Live order submitted to OANDA.";
    }
  }

  const runtimePayload = {
    lastTickAt: Date.now(),
    lastSource: source,
    lastPrice: latestPrice?.mid || analysis.price || null,
    lastPriceTime: latestPrice?.time || "",
    lastDecision: analysis.decision.action,
    lastConfidence: analysis.decision.confidence,
    lastReason: reason,
    lastAction: action,
    lastAnalysis: {
      trend: analysis.trend,
      summary: analysis.decision.tradePlan,
      tp1: analysis.decision.tp1,
      tp2: analysis.decision.tp2,
      stopPrice: analysis.decision.stopPrice,
      rmi: analysis.rmi,
      htfAlignment: analysis.htfAlignment,
      fvgs: analysis.fvgs,
      structureEvents: analysis.structureEvents,
      orderBlocks: analysis.orderBlocks,
      premiumDiscount: analysis.premiumDiscount,
      scenarios: analysis.scenarios,
      reversalZones: analysis.reversalZones,
      liquidityPools: analysis.liquidityPools,
      liquidityEvents: analysis.liquidityEvents,
      sessionLevels: analysis.sessionLevels,
    },
    openTradesCount: Array.isArray(openTrades) ? openTrades.length : 0,
  };

  if (action === "paper-trade" || action === "live-order") {
    runtimePayload.lastExecutedAt = Date.now();
  }
  if (orderResponse) {
    runtimePayload.lastOrderId = String(orderResponse?.orderFillTransaction?.id || orderResponse?.orderCreateTransaction?.id || "");
  }

  const status = await saveRuntime(runtimePayload);
  await persistBotHistory({
    source,
    mode: botConfig.botMode,
    action,
    reason,
    analysis,
    latestPrice,
    orderResponse,
  });

  return {
    ok: true,
    analysis,
    latestPrice,
    action,
    reason,
    orderResponse,
    status,
    windowCheck,
    cooldownCheck,
  };
}

function analyzeMtfData(mtfData, latestPrice) {
  const entry = normalizeCandles(mtfData?.data?.find((item) => item.id === "entry")?.values || []);
  const benchmark = normalizeCandles(mtfData?.data?.find((item) => item.id === "benchmark")?.values || []);
  if (entry.length < 30) {
    throw new Error("Not enough entry candles to drive the bot.");
  }

  const closes = entry.map((row) => row.close);
  const ema21 = exponentialMovingAverage(closes, 21).at(-1);
  const ema50 = exponentialMovingAverage(closes, 50).at(-1);
  const trend = ema21 >= ema50 ? "bullish" : "bearish";
  const fvgs = detectFairValueGaps(entry);
  const structureEvents = detectStructureEvents(entry);
  const price = Number.isFinite(Number(latestPrice?.mid)) ? Number(latestPrice.mid) : entry.at(-1).close;
  const rmiValue = calculateRmi(entry);
  const rmiBias = rmiValue >= 100 ? "bullish" : "bearish";
  const htfAlignment = buildHtfAlignment(mtfData);

  let liquidityPools = { extreme: [], midExtreme: [], decisional: [], inducement: [] };
  let liquidityEvents = [];
  let sessionLevels = {};
  try {
    liquidityPools = Liquidity.computeLiquidityPools(mtfData);
    liquidityEvents = Liquidity.scanAllLiquidityEvents(liquidityPools, mtfData);
    sessionLevels = Liquidity._sessionState || {};
  } catch (e) { /* non-fatal */ }

  let confidence = 40;
  if (trend === 'bullish' || trend === 'bearish') confidence += 10;
  if (rmiBias === trend) confidence += 10;
  if (htfAlignment.filter(row => row.includes(trend)).length > 1) confidence += 15;
  if (fvgs.length > 0) confidence += 10;
  if (structureEvents.length > 0) confidence += 5;

  const sweepEvents = (liquidityEvents || []).filter(e => e.type === 'SWEEP' && !e._dead);
  const alignedSweep = sweepEvents.some(e => {
    if (trend === 'bullish' && e.pool?.side === 'low' && e.biasDirection === 'reversal') return true;
    if (trend === 'bearish' && e.pool?.side === 'high' && e.biasDirection === 'reversal') return true;
    return false;
  });
  if (alignedSweep) confidence += 15;
  confidence = Math.min(95, Math.max(30, confidence));

  const atrVal = calculateATR(entry, 14);
  const atrMult = atrVal.length ? atrVal.at(-1) : 5;
  let calcTp1 = roundPrice(price + (trend === 'bullish' ? 1.5 * atrMult : -1.5 * atrMult));
  let calcTp2 = roundPrice(price + (trend === 'bullish' ? 3.0 * atrMult : -3.0 * atrMult));
  let calcStop = roundPrice(price + (trend === 'bullish' ? -1.0 * atrMult : 1.0 * atrMult));

  if (liquidityEvents && liquidityEvents.length > 0) {
    const sweepEvent = liquidityEvents.find(e => e.type === 'SWEEP' && !e._dead && e.nextTP && e.nextTP !== '—');
    if (sweepEvent) {
      const tpMatch = sweepEvent.nextTP.match(/\$?([\d.]+)/);
      if (tpMatch) calcTp1 = parseFloat(tpMatch[1]);
    }
  }

  return {
    price,
    trend,
    fvgs,
    structureEvents,
    htfAlignment,
    liquidityPools,
    liquidityEvents,
    sessionLevels,
    rmi: {
      value: rmiValue,
      bias: rmiBias,
    },
    decision: {
      action: trend === "bullish" ? "Buy" : "Sell",
      confidence,
      score: 0,
      tp1: calcTp1,
      tp2: calcTp2,
      stopPrice: calcStop,
      tradePlan: [
        `Bot bias: ${trend.toUpperCase()}`,
        `RMI alignment: ${rmiBias.toUpperCase()}`,
        `HTF alignment count: ${htfAlignment.length}`,
        `FVG count: ${fvgs.length}`,
      ],
    },
  };
}

function applyBotRiskProfile(analysis, botConfig) {
  if (!analysis?.decision) return;
  const side = analysis.decision.action === "Buy" ? 1 : -1;
  const stopDistance = Math.abs(normalizeNumber(botConfig?.botStopLossOffset, 3));
  const targetDistance = Math.abs(normalizeNumber(botConfig?.botTakeProfitOffset, 6));
  analysis.decision.stopPrice = roundPrice(analysis.price + (side === 1 ? -stopDistance : stopDistance));
  analysis.decision.tp1 = roundPrice(analysis.price + (side === 1 ? targetDistance * 0.67 : targetDistance * -0.67));
  analysis.decision.tp2 = roundPrice(analysis.price + (side === 1 ? targetDistance : targetDistance * -1));
  analysis.decision.tradePlan = [
    ...analysis.decision.tradePlan,
    `Risk profile: SL ${stopDistance.toFixed(1)} / TP ${targetDistance.toFixed(1)}`,
    `Units: ${normalizeInteger(botConfig?.units, 10)}`,
  ];
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => ({
      open: normalizeNumber(candle?.open, Number.NaN),
      high: normalizeNumber(candle?.high, Number.NaN),
      low: normalizeNumber(candle?.low, Number.NaN),
      close: normalizeNumber(candle?.close, Number.NaN),
      _ts: new Date(candle?.datetime || 0).getTime(),
    }))
    .filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close))
    .sort((left, right) => left._ts - right._ts);
}

function exponentialMovingAverage(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    out.push(values[index] * k + out[index - 1] * (1 - k));
  }
  return out;
}

function calculateRmi(candles) {
  if (!candles || candles.length < 30) return 100.00;
  const closes = candles.map(c => c.close);
  const period = 30;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  const rmi = (closes.at(-1) / ema) * 100;
  return Number(rmi.toFixed(2));
}

function detectFairValueGaps(candles) {
  const fvgs = [];
  for (let index = 1; index < candles.length - 1; index += 1) {
    const prev = candles[index - 1];
    const next = candles[index + 1];
    if (next.low > prev.high) fvgs.push({ side: "bullish", price: roundPrice((next.low + prev.high) / 2) });
    else if (next.high < prev.low) fvgs.push({ side: "bearish", price: roundPrice((next.high + prev.low) / 2) });
  }
  return fvgs.slice(-8);
}

function detectStructureEvents(candles) {
  const events = [];
  for (let index = 2; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const pivot = candles[index - 2];
    if (current.high > previous.high && previous.high <= pivot.high) {
      events.push(`BOS up through ${roundPrice(previous.high)}`);
    }
    if (current.low < previous.low && previous.low >= pivot.low) {
      events.push(`Liquidity sweep below ${roundPrice(previous.low)}`);
    }
  }
  return events.slice(-6);
}

function buildHtfAlignment(mtfData) {
  return (Array.isArray(mtfData?.data) ? mtfData.data : [])
    .filter((row) => ["h1", "1day", "1week", "1month"].includes(row.id))
    .map((row) => {
      const values = normalizeCandles(row.values || []);
      if (values.length < 2) return `${row.id.toUpperCase()} unavailable`;
      const oldest = values[0].close;
      const latest = values.at(-1).close;
      const bias = latest >= oldest ? "bullish" : "bearish";
      return `${row.id.toUpperCase()} ${bias}`;
    });
}

function checkTradingWindow() {
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hh = String(etNow.getHours()).padStart(2, "0");
  const mm = String(etNow.getMinutes()).padStart(2, "0");
  const current = `${hh}:${mm}`;
  if (current < "08:00") {
    return { allowed: false, reason: `Pre-session lockout (${current} ET).` };
  }
  if (current >= "16:30") {
    return { allowed: false, reason: `Late-session lockout (${current} ET).` };
  }
  return { allowed: true, reason: `Trading window open (${current} ET).` };
}

function checkCooldown(lastExecutedAt, cooldownMinutes) {
  if (!Number.isFinite(Number(lastExecutedAt))) {
    return { allowed: true, reason: "No prior execution." };
  }
  const remainingMs = Number(lastExecutedAt) + cooldownMinutes * 60 * 1000 - Date.now();
  if (remainingMs > 0) {
    return { allowed: false, reason: `Cooldown active for ${Math.ceil(remainingMs / 60000)} more minute(s).` };
  }
  return { allowed: true, reason: "Cooldown cleared." };
}

function isLiveTradingAllowed() {
  return String(process.env.TRADING_BOT_ALLOW_LIVE || "").trim().toLowerCase() === "true";
}

async function safeSettings() {
  try {
    return (await getAdminSettings()) || {};
  } catch {
    return {};
  }
}

async function safeOandaConfig() {
  try {
    return await getOandaConfig();
  } catch {
    return {
      configured: false,
      environment: "practice",
      accountId: "",
      instrument: "XAU_USD",
    };
  }
}

async function safeRuntime() {
  try {
    const db = getFirestore();
    const snapshot = await db.collection(BOT_RUNTIME_COLLECTION).doc(BOT_RUNTIME_DOC).get();
    return snapshot.exists ? snapshot.data() || {} : {};
  } catch {
    return {};
  }
}

async function saveRuntime(patch) {
  const db = getFirestore();
  await db.collection(BOT_RUNTIME_COLLECTION).doc(BOT_RUNTIME_DOC).set(patch, { merge: true });
  return safeRuntime();
}

async function persistBotHistory(context) {
  try {
    const db = getFirestore();
    const now = Date.now();
    await db.collection("analysis_history").add({
      id: `bot-${now}`,
      source: context.source,
      botMode: context.mode,
      botAction: context.action,
      botReason: context.reason,
      createdAt: now,
      timestampIso: new Date(now).toISOString(),
      timeframe: "15min",
      price: String(context.latestPrice?.mid || context.analysis?.price || ""),
      summary: context.analysis?.decision?.tradePlan || [],
      executionOverview: [
        `Direction: ${context.analysis?.decision?.action || "N/A"}`,
        `Confidence: ${context.analysis?.decision?.confidence || 0}%`,
        `Stop: ${context.analysis?.decision?.stopPrice || "N/A"}`,
        `TP2: ${context.analysis?.decision?.tp2 || "N/A"}`,
      ],
      aiOverlay: context.reason,
      orderMeta: context.orderResponse ? {
        orderId: String(context.orderResponse?.orderFillTransaction?.id || context.orderResponse?.orderCreateTransaction?.id || ""),
      } : null,
    });
  } catch {
    // Best effort only for bot history persistence.
  }
}

function normalizeBotMode(value) {
  const mode = String(value || "manual").toLowerCase();
  if (mode === "live" || mode === "paper") return mode;
  return "manual";
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundPrice(value) {
  return Number(Number(value).toFixed(3));
}

function calculateATR(candles, period) {
  if (candles.length < 2) return [0];
  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    ));
  }
  let atr = [trs[0]];
  for (let i = 1; i < trs.length; i++) atr.push((atr[i-1] * (period-1) + trs[i]) / period);
  return atr;
}

module.exports = {
  getBotStatus,
  runBotTick,
  setBotEnabled,
  updateBotSettings,
};
