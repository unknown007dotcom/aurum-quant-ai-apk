const { fetchPrice, getOandaConfig, normalizeInstrument } = require("../lib/oanda");
const { getAdminSettings } = require("../lib/firebase-admin");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed." });
  }

  const symbol = req.query.symbol ? String(req.query.symbol) : "XAU_USD";

  // Attempt 1: Fetch from OANDA
  try {
    const oandaConfig = await getOandaConfig();
    if (oandaConfig.configured) {
      const price = await fetchPrice({
        instrument: normalizeInstrument(symbol || oandaConfig.instrument),
      });
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ price: price?.mid || null, time: price?.time || null, source: "oanda" });
    }
  } catch (error) {
    console.error("OANDA live price fetch failed, falling back to Twelve Data:", error.message);
  }

  // Attempt 2: Fallback to Twelve Data
  try {
    const settings = await getAdminSettings();
    const twelveKeys = Array.isArray(settings?.twelveDataKeys) ? settings.twelveDataKeys : [];
    const fromEnv = process.env.TWELVE_DATA_API_KEYS ? process.env.TWELVE_DATA_API_KEYS.split(",").map(k => k.trim()) : [];
    const keys = [...twelveKeys, ...fromEnv, process.env.TWELVE_DATA_API_KEY, "23c57edf48e541e48db2806575f58bf7"].filter(Boolean);
    
    if (keys.length > 0) {
      const sym = symbol.replace("_", "/"); // Twelve Data expects XAU/USD
      const key = keys[Math.floor(Math.random() * keys.length)];
      const response = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.price) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ price: Number(data.price), source: "twelvedata" });
      }
    }
  } catch (error) {
    console.error("Twelve Data fallback fetch failed:", error.message);
  }

  return res.status(502).json({ message: "Failed to fetch live price from OANDA and Twelve Data." });
};
