const path = require("node:path");

const routes = {
  "ai-decision": require("../api-handlers/ai-decision"),
  "auto-analyze": require("../api-handlers/auto-analyze"),
  "auto-learn": require("../api-handlers/auto-learn"),
  "bot": require("../api-handlers/bot"),
  "history-log": require("../api-handlers/history-log"),
  "intel": require("../api-handlers/intel"),
  "learning-context": require("../api-handlers/learning-context"),
  "learning-feedback": require("../api-handlers/learning-feedback"),
  "live-price": require("../api-handlers/live-price"),
  "market-data": require("../api-handlers/market-data"),
  "market-mtf": require("../api-handlers/market-mtf"),
  "options-intel": require("../api-handlers/options-intel"),
  "settings": require("../api-handlers/settings")
};

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    
    // Extract the api endpoint name (e.g. /api/settings -> settings)
    const match = pathname.match(/^\/api\/([^/]+)/);
    if (!match) {
      return res.status(404).json({ message: `API Route not found: ${pathname}` });
    }
    
    const routeKey = match[1];
    const handlerFn = routes[routeKey];
    
    if (!handlerFn) {
      return res.status(404).json({ message: `API Endpoint not found: ${routeKey}` });
    }
    
    // Ensure req.query is populated
    if (!req.query) {
      req.query = Object.fromEntries(url.searchParams.entries());
    }
    
    // Forward execution to the actual handler
    await handlerFn(req, res);
  } catch (error) {
    console.error("Router error:", error);
    res.status(500).json({ message: error.message || "Internal server error in router." });
  }
};
