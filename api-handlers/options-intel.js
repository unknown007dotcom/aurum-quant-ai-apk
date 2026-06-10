const { getAdminSettings } = require("../lib/firebase-admin");
const { DEFAULT_OPTIONS_SYMBOL, fetchOptionsIntelligenceServer } = require("../lib/options-intel");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  try {
    const symbol = String(req.query.symbol || DEFAULT_OPTIONS_SYMBOL).trim() || DEFAULT_OPTIONS_SYMBOL;
    const apiKey = String(req.query.apikey || "").trim();
    const payload = await fetchOptionsIntelligenceServer({
      symbol,
      apiKey,
      getAdminSettings,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(payload);
  } catch (error) {
    res.status(502).json({ message: error?.message || "Failed to fetch options intelligence." });
  }
};
