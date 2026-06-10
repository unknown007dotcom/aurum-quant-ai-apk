const { getAdminSettings } = require("./firebase-admin");

const DEFAULT_INSTRUMENT = "XAU_USD";
const BASE_URLS = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

const GRANULARITY_MAP = {
  "1min": "M1",
  "5min": "M5",
  "15min": "M15",
  "1h": "H1",
  "4h": "H4",
  "1day": "D",
  "1week": "W",
  "1month": "M",
};

async function getOandaConfig() {
  const settings = await safeSettings();
  const environment = normalizeEnvironment(process.env.OANDA_ENVIRONMENT || settings.oandaEnvironment);
  const token = String(process.env.OANDA_API_TOKEN || settings.oandaApiToken || "").trim();
  const configured = Boolean(token);
  const instrument = normalizeInstrument(process.env.OANDA_INSTRUMENT || settings.botInstrument || DEFAULT_INSTRUMENT);
  const accountId = String(process.env.OANDA_ACCOUNT_ID || settings.oandaAccountId || "").trim() || (configured ? await discoverAccountId(token, environment) : "");

  return {
    configured,
    token,
    environment,
    baseUrl: BASE_URLS[environment],
    accountId,
    instrument,
  };
}

async function fetchPrice(options = {}) {
  const config = await getResolvedConfig(options);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/pricing`, {
    query: { instruments: instrument },
  });
  const price = Array.isArray(payload?.prices) ? payload.prices[0] : null;
  return {
    instrument,
    raw: price,
    time: String(price?.time || payload?.time || ""),
    bid: toNumber(price?.closeoutBid || price?.bids?.[0]?.price),
    ask: toNumber(price?.closeoutAsk || price?.asks?.[0]?.price),
    mid: midpoint(price),
    status: String(price?.status || ""),
  };
}

async function fetchCandles(options = {}) {
  const config = await getResolvedConfig(options);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const granularity = mapGranularity(options.timeframe || "15min");
  const count = Math.max(30, Math.min(5000, Number.parseInt(String(options.count || "200"), 10) || 200));
  const payload = await oandaRequest(
    config,
    `/v3/accounts/${encodeURIComponent(config.accountId)}/instruments/${encodeURIComponent(instrument)}/candles`,
    {
      query: {
        price: "M",
        granularity,
        count,
      },
    },
  );

  const candles = Array.isArray(payload?.candles) ? payload.candles : [];
  return normalizeOandaCandles(candles);
}

async function fetchMtfPayload(options = {}) {
  const config = await getResolvedConfig(options);
  const entryTf = String(options.entryTf || "15min");
  
  // BUG FIX: Increase default saved candles to 1,000 (clamped up to 2,500)
  const outputsize = Math.max(30, Math.min(2500, Number.parseInt(String(options.outputsize || "1000"), 10) || 1000));
  const instrument = normalizeInstrument(options.instrument || config.instrument);

  const [m5Data, m15Data, h1Data, h4Data, dailyData, weeklyData, monthlyData] = await Promise.all([
    fetchCandles({ ...config, instrument, timeframe: "5min", count: outputsize }),
    fetchCandles({ ...config, instrument, timeframe: "15min", count: outputsize }),
    fetchCandles({ ...config, instrument, timeframe: "1h", count: outputsize }),
    fetchCandles({ ...config, instrument, timeframe: "4h", count: outputsize }),
    fetchCandles({ ...config, instrument, timeframe: "1day", count: outputsize }),
    // Weekly and Monthly are naturally shorter timeframes, so we clamp them safely:
    fetchCandles({ ...config, instrument, timeframe: "1week", count: Math.min(outputsize, 1000) }),
    fetchCandles({ ...config, instrument, timeframe: "1month", count: Math.min(outputsize, 500) }),
  ]);

  return {
    status: "ok",
    provider: "oanda",
    data: [
      { id: "5min", values: m5Data, symbolUsed: instrument },
      { id: "15min", values: m15Data, symbolUsed: instrument },
      { id: "entry", values: entryTf === "15min" ? m15Data : m5Data, symbolUsed: instrument },
      { id: "h1", values: h1Data, symbolUsed: instrument },
      { id: "4h", values: h4Data, symbolUsed: instrument },
      { id: "1day", values: dailyData, symbolUsed: instrument },
      { id: "1week", values: weeklyData, symbolUsed: instrument },
      { id: "1month", values: monthlyData, symbolUsed: instrument },
      { id: "benchmark", values: dailyData, symbolUsed: instrument },
      { id: "alpha_vantage", data: null, symbolUsed: "" },
    ],
  };
}

async function listOpenTrades(options = {}) {
  const config = await getResolvedConfig(options);
  const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/openTrades`);
  const trades = Array.isArray(payload?.trades) ? payload.trades : [];
  const instrument = options.instrument ? normalizeInstrument(options.instrument) : "";
  return instrument ? trades.filter((trade) => String(trade?.instrument || "") === instrument) : trades;
}

async function createMarketOrder(options = {}) {
  const config = await getResolvedConfig(options);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const units = Number.parseInt(String(options.units || 0), 10);
  if (!Number.isFinite(units) || units === 0) {
    throw new Error("Order units must be a non-zero integer.");
  }

  const order = {
    units: String(units),
    instrument,
    timeInForce: "FOK",
    type: "MARKET",
    positionFill: "DEFAULT",
  };

  if (Number.isFinite(Number(options.stopLoss))) {
    order.stopLossOnFill = { price: formatPrice(Number(options.stopLoss)) };
  }
  if (Number.isFinite(Number(options.takeProfit))) {
    order.takeProfitOnFill = { price: formatPrice(Number(options.takeProfit)) };
  }
  if (options.clientId || options.clientTag || options.clientComment) {
    order.clientExtensions = {
      id: String(options.clientId || `aurum-${Date.now()}`).slice(0, 128),
      tag: String(options.clientTag || "aurum-bot").slice(0, 128),
      comment: String(options.clientComment || "Aurum Quant AI bot").slice(0, 256),
    };
  }

  return oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/orders`, {
    method: "POST",
    body: { order },
  });
}

function normalizeOandaCandles(candles) {
  return candles
    .filter((candle) => candle?.complete !== false && candle?.mid)
    .map((candle) => ({
      datetime: String(candle.time || ""),
      open: toNumber(candle.mid?.o),
      high: toNumber(candle.mid?.h),
      low: toNumber(candle.mid?.l),
      close: toNumber(candle.mid?.c),
      volume: Number.isFinite(Number(candle.volume)) ? Number(candle.volume) : null,
    }))
    .filter((row) => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
}

function midpoint(price) {
  const bid = toNumber(price?.closeoutBid || price?.bids?.[0]?.price);
  const ask = toNumber(price?.closeoutAsk || price?.asks?.[0]?.price);
  if (Number.isFinite(bid) && Number.isFinite(ask)) {
    return Number(((bid + ask) / 2).toFixed(3));
  }
  return toNumber(price?.closeoutBid || price?.closeoutAsk || price?.bids?.[0]?.price || price?.asks?.[0]?.price);
}

function formatPrice(value) {
  const precision = Math.abs(value) >= 100 ? 3 : 5;
  return Number(value).toFixed(precision);
}

async function discoverAccountId(token, environment) {
  const baseUrl = BASE_URLS[normalizeEnvironment(environment)];
  const response = await fetch(`${baseUrl}/v3/accounts`, {
    method: "GET",
    headers: buildHeaders(token),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.errorMessage || payload?.message || `OANDA accounts lookup failed (${response.status}).`);
  }
  const accountId = String(payload?.accounts?.[0]?.id || "").trim();
  if (!accountId) {
    throw new Error("No OANDA account ID could be discovered for this token.");
  }
  return accountId;
}

async function oandaRequest(config, path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const url = new URL(`${config.baseUrl}${path}`);
  const query = options.query && typeof options.query === "object" ? options.query : {};
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    method,
    headers: {
      ...buildHeaders(config.token),
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(options.body || {}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.errorMessage || payload?.message || `OANDA HTTP ${response.status}`);
  }
  return payload;
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function getResolvedConfig(options = {}) {
  const base = options.token && options.accountId && options.baseUrl
    ? options
    : await getOandaConfig();
  if (!base?.configured || !base?.token) {
    throw new Error("OANDA is not configured. Set OANDA_API_TOKEN in the server environment.");
  }
  if (!base?.accountId) {
    throw new Error("OANDA account ID is unavailable.");
  }
  return {
    configured: true,
    token: base.token,
    baseUrl: String(base.baseUrl || BASE_URLS[normalizeEnvironment(base.environment)]),
    accountId: String(base.accountId),
    instrument: normalizeInstrument(base.instrument || DEFAULT_INSTRUMENT),
  };
}

async function safeSettings() {
  try {
    return (await getAdminSettings()) || {};
  } catch {
    return {};
  }
}

function mapGranularity(timeframe) {
  const key = String(timeframe || "15min");
  return GRANULARITY_MAP[key] || "M15";
}

function normalizeEnvironment(value) {
  return String(value || "practice").toLowerCase() === "live" ? "live" : "practice";
}

function normalizeInstrument(value) {
  const raw = String(value || DEFAULT_INSTRUMENT).trim().toUpperCase();
  return raw.replace("/", "_");
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

module.exports = {
  DEFAULT_INSTRUMENT,
  fetchCandles,
  fetchMtfPayload,
  fetchPrice,
  getOandaConfig,
  listOpenTrades,
  createMarketOrder,
  normalizeInstrument,
};
