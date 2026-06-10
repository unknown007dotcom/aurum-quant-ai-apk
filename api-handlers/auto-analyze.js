const { getAdminSettings, getFirestore } = require("../lib/firebase-admin");

const DEFAULT_BASE = "https://aurum-quant-ai.vercel.app";

module.exports = async function handler(req, res) {
  const cronAuth = process.env.CRON_SECRET || "";
  const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const isCronCall = req.headers["x-vercel-cron"] === "1";
  if (cronAuth && !isCronCall && provided !== cronAuth) {
    res.status(401).json({ message: "Unauthorized." });
    return;
  }

  try {
    const settings = (await getAdminSettings()) || {};
    const models = Array.isArray(settings.nvidiaModels) ? settings.nvidiaModels : [];
    const debateModels = Array.isArray(settings.debateModels) ? settings.debateModels : [];
    const model = models.find((m) => m.key === settings.defaultModelKey) || models[0];
    const globalKeys = normalizeNvidiaKeyPool(settings.globalNvidiaApiKeys, settings.globalNvidiaApiKey);
    const resolvedApiKey = String(model?.apiKey || "").trim() || pickRandomNvidiaKey(globalKeys);
    if (!model?.id || !resolvedApiKey) {
      res.status(400).json({ message: "No configured summary model for auto analysis." });
      return;
    }

    const timeframe = "15min";
    const baseUrl = process.env.AUTO_ANALYZE_BASE_URL || DEFAULT_BASE;
    const marketResp = await fetch(`${baseUrl}/api/market-data?interval=${encodeURIComponent(timeframe)}&outputsize=5000&symbol=XAU%2FUSD`);
    const marketData = await marketResp.json().catch(() => ({}));
    if (!marketResp.ok || !Array.isArray(marketData.values) || marketData.values.length < 50) {
      throw new Error(marketData?.message || `Market data failed (${marketResp.status}).`);
    }

    const candles = marketData.values.slice(0, 240).reverse().map((row) => ({
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      datetime: row.datetime,
    }));
    const closes = candles.map((c) => c.close);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const last = candles[candles.length - 1];
    const trend = last.close > sma20 && sma20 > sma50 ? "bullish" : last.close < sma20 && sma20 < sma50 ? "bearish" : "neutral";
    const high60 = Math.max(...candles.slice(-60).map((c) => c.high));
    const low60 = Math.min(...candles.slice(-60).map((c) => c.low));

    const prompt = [
      "Symbol: XAU/USD",
      `Timeframe: ${timeframe}`,
      `Price: ${last.close}`,
      `Trend: ${trend}`,
      `SMA20: ${sma20}`,
      `SMA50: ${sma50}`,
      `Range60: ${low60}-${high60}`,
      "Return only concise trade summary with headings: Summary, Direction, Entry Zone, Invalidation, Risk Note.",
    ].join("\n");

    const aiResp = await fetch(`${baseUrl}/api/ai-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        selectedModelKey: model.key,
        model: model.id,
        label: model.label || model.id,
        apiKey: resolvedApiKey,
        baseUrl: model.baseUrl || "https://integrate.api.nvidia.com/v1",
        models: models.map((m) => ({ ...m, apiKey: String(m?.apiKey || "").trim() || pickRandomNvidiaKey(globalKeys) })),
        debateModels: debateModels.map((m) => ({ ...m, apiKey: String(m?.apiKey || "").trim() || pickRandomNvidiaKey(globalKeys) })),
        temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.2,
        prompt,
      }),
    });
    const aiData = await aiResp.json().catch(() => ({}));
    if (!aiResp.ok) {
      throw new Error(aiData?.message || `AI decision failed (${aiResp.status}).`);
    }

    const aiText = extractAiText(aiData);
    const entry = {
      id: `auto-${Date.now()}`,
      title: formatTimestamp(new Date()),
      timestampIso: new Date().toISOString(),
      deviceId: "system:auto-analyze",
      deviceLabel: "Automated scheduler",
      timeframe,
      price: String(last.close),
      summary: [
        `Market Regime: ${trend}`,
        `Signal Confidence: auto`,
        `Risk Profile: auto`,
        "Session State: auto",
      ],
      executionOverview: [
        "Primary bias from automated run.",
        `SMA20=${sma20} SMA50=${sma50}`,
        `Range60=${low60}-${high60}`,
      ],
      aiOverlay: aiText,
      source: "auto",
      createdAt: Date.now(),
    };

    const db = getFirestore();
    await db.collection("analysis_history").add(entry);

    // Trigger autonomous post-mortem learning pass after saving a new automated signal.
    const cronSecret = process.env.CRON_SECRET || "";
    fetch(`${baseUrl}/api/auto-learn`, {
      method: "POST",
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
    }).catch(() => {});

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, saved: true, model: aiData?.model || model.id });
  } catch (error) {
    res.status(502).json({ message: error?.message || "Auto analysis failed." });
  }
};

function normalizeNvidiaKeyPool(listValue, legacyValue) {
  const list = Array.isArray(listValue) ? listValue : [];
  const combined = [...list, legacyValue].map((item) => String(item || "").trim()).filter(Boolean);
  const unique = [];
  for (const key of combined) {
    if (!key.toLowerCase().startsWith("nvapi-")) continue;
    if (!unique.includes(key)) unique.push(key);
  }
  return unique;
}

function pickRandomNvidiaKey(pool) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return "";
  }
  const idx = Math.floor(Math.random() * pool.length);
  return String(pool[idx] || "").trim();
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return Number.NaN;
  const window = values.slice(-period);
  return Number((window.reduce((a, b) => a + Number(b || 0), 0) / period).toFixed(5));
}

function extractAiText(payload) {
  return String(payload?.choices?.[0]?.message?.content || payload?.output?.[0]?.content?.[0]?.text || payload?.text || "").trim();
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}
