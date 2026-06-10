const { getAdminSettings } = require("../lib/firebase-admin");
const { fetchMtfPayload, getOandaConfig, normalizeInstrument } = require("../lib/oanda");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ message: "Method not allowed." });

  const entryTf = req.query.entryTf || "15min";
  const outputsize = req.query.outputsize || "1000";
  const userApiKey = req.query.apikey || "";
  const symbol = req.query.symbol ? String(req.query.symbol) : "";

  try {
    const oandaConfig = await getOandaConfig();
    if (oandaConfig.configured) {
      const payload = await fetchMtfPayload({
        instrument: normalizeInstrument(symbol || oandaConfig.instrument),
        entryTf,
        outputsize,
      });
      return res.status(200).json(payload);
    }
  } catch (error) {
    // Fall through to legacy providers if OANDA is unavailable.
  }

  const keys = await resolveTwelveKeys(userApiKey);
  if (!keys.length) return res.status(400).json({ message: "No API Keys found in system." });
  const avKeys = await resolveAlphaVantageKeys();

  try {
    const fetchTfWithRotation = async (tf, rotationIndex) => {
      const symbols = ["XAU/USD", "XAUUSD"];
      let lastError = "All keys failed";

      for (let i = 0; i < keys.length; i++) {
        const keyIdx = (rotationIndex + i) % keys.length;
        const key = keys[keyIdx];

        for (const symbol of symbols) {
          const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${tf}&outputsize=${outputsize}&apikey=${key}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);

          try {
            const response = await fetch(url, { signal: controller.signal });
            const data = await response.json().catch(() => ({}));

            if (response.ok && data.status !== "error" && Array.isArray(data.values)) {
              let id = tf;
              if (tf === entryTf) id = "entry";
              else if (tf === "1h") id = "h1";
              return { id, values: data.values, symbolUsed: symbol };
            }

            const errorMsg = data?.message || `HTTP ${response.status}`;
            lastError = `Key ${keyIdx} Symbol ${symbol} failed: ${errorMsg}`;

            // If it's a quota error, try next key immediately
            if (response.status === 429 || errorMsg.toLowerCase().includes("limit") || errorMsg.toLowerCase().includes("quota")) {
              break; // Try next key
            }
          } catch (err) {
            lastError = err.message;
          } finally {
            clearTimeout(timeout);
          }
        }
      }
      throw new Error(lastError);
    };

    // Use a slight stagger for Promise.all to avoid burst IP throttling, 
    // and give each call a different starting key index.
    // Add Benchmark (SPX) fetch
    const fetchBenchmark = async () => {
      let lastError = "Benchmark fetch failed";
      for (const key of keys) {
        const url = `https://api.twelvedata.com/time_series?symbol=SPX&interval=${entryTf}&outputsize=${outputsize}&apikey=${key}`;
        try {
          const response = await fetch(url);
          const data = await response.json().catch(() => ({}));
          if (response.ok && data.status !== "error" && Array.isArray(data.values)) {
            return { id: "benchmark", values: data.values, symbolUsed: "SPX" };
          }
        } catch (err) { lastError = err.message; }
      }
      return { id: "benchmark", values: [], error: lastError };
    };

    const fetchAlphaVantage = async () => {
      if (!avKeys.length) return { id: "alpha_vantage", error: "No API keys" };
      let lastError = "Alpha Vantage failed";
      for (const key of avKeys) {
        const url = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=XAU&to_currency=USD&apikey=${key}`;
        try {
          const response = await fetch(url);
          const data = await response.json().catch(() => ({}));
          if (data["Realtime Currency Exchange Rate"]) {
            return { id: "alpha_vantage", data: data["Realtime Currency Exchange Rate"] };
          }
        } catch (err) { lastError = err.message; }
      }
      return { id: "alpha_vantage", error: lastError };
    };

    const [entryData, h1Data, dailyData, weeklyData, monthlyData, benchmarkData, avData] = await Promise.all([
      fetchTfWithRotation(entryTf, 0),
      new Promise(r => setTimeout(r, 200)).then(() => fetchTfWithRotation("1h", 1)),
      new Promise(r => setTimeout(r, 400)).then(() => fetchTfWithRotation("1day", 2)),
      new Promise(r => setTimeout(r, 600)).then(() => fetchTfWithRotation("1week", 3)),
      new Promise(r => setTimeout(r, 800)).then(() => fetchTfWithRotation("1month", 4)),
      new Promise(r => setTimeout(r, 1000)).then(() => fetchBenchmark()),
      new Promise(r => setTimeout(r, 1200)).then(() => fetchAlphaVantage())
    ]);

    res.status(200).json({ 
      data: [
        entryData, 
        h1Data, 
        { ...dailyData, id: "1day" }, 
        { ...weeklyData, id: "1week" }, 
        { ...monthlyData, id: "1month" },
        benchmarkData,
        avData
      ], 
      status: "ok" 
    });
  } catch (error) {
    res.status(502).json({ message: `Institutional Scan Error: ${error.message}` });
  }
};

async function resolveTwelveKeys(overrideKey) {
  const fromEnv = process.env.TWELVE_DATA_API_KEYS ? process.env.TWELVE_DATA_API_KEYS.split(",").map(k => k.trim()) : [];
  try {
    const settings = await getAdminSettings();
    const fromFirestore = Array.isArray(settings?.twelveDataKeys) ? settings.twelveDataKeys : [];
    const combined = [overrideKey, ...fromFirestore, ...fromEnv, process.env.TWELVE_DATA_API_KEY].filter(Boolean);
    return [...new Set(combined)];
  } catch {
    return [overrideKey, ...fromEnv, process.env.TWELVE_DATA_API_KEY].filter(Boolean);
  }
}

async function resolveAlphaVantageKeys() {
  const fromEnv = process.env.ALPHA_VANTAGE_KEYS ? process.env.ALPHA_VANTAGE_KEYS.split(",").map(k => k.trim()) : [];
  try {
    const settings = await getAdminSettings();
    const fromFirestore = Array.isArray(settings?.alphaVantageKeys) ? settings.alphaVantageKeys : [];
    const combined = [...fromFirestore, ...fromEnv, process.env.ALPHA_VANTAGE_KEY].filter(Boolean);
    return [...new Set(combined)];
  } catch {
    return [...fromEnv, process.env.ALPHA_VANTAGE_KEY].filter(Boolean);
  }
}
