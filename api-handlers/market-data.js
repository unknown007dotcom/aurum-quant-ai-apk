const DEFAULT_MARKET_DATA_KEY = "23c57edf48e541e48db2806575f58bf7";
const MAX_OUTPUTSIZE = 5000;
const SYMBOL_CANDIDATES = ["XAU/USD", "XAUUSD"];
const ALLOWED_SYMBOLS = new Set(["XAU/USD", "XAUUSD", "XAG/USD", "XAGUSD"]);
const { getAdminSettings } = require("../lib/firebase-admin");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  const interval = String(req.query.interval || "15min");
  const requestedOutputsize = Number.parseInt(String(req.query.outputsize || "180"), 10);
  const outputsize = String(Number.isFinite(requestedOutputsize) ? Math.max(30, Math.min(MAX_OUTPUTSIZE, requestedOutputsize)) : 180);
  const apiKey = String(req.query.apikey || "");
  const requestedSymbol = req.query.symbol ? String(req.query.symbol) : "";
  const symbols = requestedSymbol && ALLOWED_SYMBOLS.has(requestedSymbol) ? [requestedSymbol] : SYMBOL_CANDIDATES;
  let lastError = "Market data request failed.";

  const keys = await resolveTwelveKeys(apiKey);
  const startIdx = Math.floor(Math.random() * keys.length);

  for (const symbol of symbols) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(startIdx + i) % keys.length];
      const upstreamUrl = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&outputsize=${encodeURIComponent(outputsize)}&apikey=${encodeURIComponent(key)}&format=JSON`;
      try {
        const upstreamResponse = await fetch(upstreamUrl, { method: "GET" });
        const payload = await upstreamResponse.json().catch(() => ({}));

        if (!upstreamResponse.ok) {
          lastError = payload?.message || `Market data HTTP ${upstreamResponse.status} for ${symbol}`;
          if (isLikelyQuotaError(upstreamResponse.status, lastError)) {
            continue;
          }
          continue;
        }

        if (payload.status === "error") {
          lastError = payload?.message || `Market data error for ${symbol}`;
          if (isLikelyQuotaError(upstreamResponse.status, lastError)) {
            continue;
          }
          continue;
        }

        if (!Array.isArray(payload.values) || payload.values.length < 30) {
          lastError = `Not enough candles returned for ${symbol}`;
          continue;
        }

        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(payload);
        return;
      } catch (error) {
        lastError = error?.message || `Market data fetch failed for ${symbol}`;
      }
    }
  }

  res.status(502).json({ message: lastError });
};

async function resolveTwelveKeys(overrideKey) {
  const fromEnv = process.env.TWELVE_DATA_API_KEYS
    ? String(process.env.TWELVE_DATA_API_KEYS)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    : [];

  try {
    const settings = await getAdminSettings();
    const fromFirestore = Array.isArray(settings?.twelveDataKeys) ? settings.twelveDataKeys : [];
    const combined = [overrideKey, ...fromFirestore, ...fromEnv, process.env.TWELVE_DATA_API_KEY, DEFAULT_MARKET_DATA_KEY]
      .map((k) => String(k || "").trim())
      .filter(Boolean);
    return uniqueList(combined);
  } catch {
    const combined = [overrideKey, ...fromEnv, process.env.TWELVE_DATA_API_KEY, DEFAULT_MARKET_DATA_KEY]
      .map((k) => String(k || "").trim())
      .filter(Boolean);
    return uniqueList(combined);
  }
}

function uniqueList(items) {
  const out = [];
  for (const item of items) {
    if (!out.includes(item)) {
      out.push(item);
    }
  }
  return out.slice(0, 12);
}

function isLikelyQuotaError(status, message) {
  const text = String(message || "").toLowerCase();
  return (
    status === 429 ||
    text.includes("quota") ||
    text.includes("limit") ||
    text.includes("rate") ||
    text.includes("too many") ||
    text.includes("credits") ||
    text.includes("exceed")
  );
}
