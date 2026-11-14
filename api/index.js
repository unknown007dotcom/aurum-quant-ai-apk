const fs = require("node:fs");
const path = require("node:path");

// Handlers are resolved lazily, per request. Requiring all of them at module
// load meant one broken handler (missing dependency, SDK that throws on import,
// bad env var) took down every route on Vercel, where all /api/* traffic lands
// on this file. server.js already behaves this way.
const HANDLER_DIR = path.join(__dirname, "..", "api-handlers");

// Route names the client is allowed to call, so a request can never resolve to
// an arbitrary file on disk.
const ROUTES = [
  "ai-decision",
  "auto-analyze",
  "auto-learn",
  "bot",
  "history-log",
  "intel",
  "learning-context",
  "learning-feedback",
  "live-price",
  "market-data",
  "market-mtf",
  "options-intel",
  "settings",
];

function loadHandler(routeKey) {
  if (!ROUTES.includes(routeKey)) return null;
  const filePath = path.normalize(path.join(HANDLER_DIR, `${routeKey}.js`));
  if (!filePath.startsWith(HANDLER_DIR + path.sep) || !fs.existsSync(filePath)) {
    return null;
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const handler = require(filePath);
  return typeof handler === "function" ? handler : null;
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // Extract the api endpoint name (e.g. /api/settings -> settings)
    const match = pathname.match(/^\/api\/([^/?]+)/);
    if (!match) {
      return res.status(404).json({ message: `API Route not found: ${pathname}` });
    }

    const routeKey = match[1];
    const handlerFn = loadHandler(routeKey);

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

module.exports.ROUTES = ROUTES;
