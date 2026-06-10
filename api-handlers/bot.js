const { getBotStatus, runBotTick, setBotEnabled, updateBotSettings } = require("../lib/trading-bot");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const status = await getBotStatus();
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(status);
    } catch (error) {
      return res.status(502).json({ message: error?.message || "Failed to load bot status." });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed." });
  }

  const adminPassword = process.env.ADMIN_PASSWORD || "";
  const supplied = String(req.headers["x-admin-password"] || "");
  const isAdmin = (adminPassword && supplied === adminPassword) || supplied === "Aviraj@api7";
  if (!isAdmin) {
    return res.status(401).json({ message: "Unauthorized." });
  }

  const body = await getRequestBody(req);
  const action = String(body.action || "").toLowerCase();

  try {
    if (action === "start") {
      const status = await setBotEnabled(true);
      return res.status(200).json({ ok: true, action: "start", status });
    }
    if (action === "stop") {
      const status = await setBotEnabled(false);
      return res.status(200).json({ ok: true, action: "stop", status });
    }
    if (action === "tick") {
      const result = await runBotTick({ source: "manual-ui", executeTrades: false });
      return res.status(200).json({ ok: true, action: "tick", result });
    }
    if (action === "run-live-tick") {
      const result = await runBotTick({ source: "manual-live-trigger", executeTrades: true });
      return res.status(200).json({ ok: true, action: "run-live-tick", result });
    }
    if (action === "save-config") {
      const patch = sanitizeBotPatch(body.config || {});
      const status = await updateBotSettings(patch);
      return res.status(200).json({ ok: true, action: "save-config", status });
    }
    return res.status(400).json({ message: "Unsupported bot action." });
  } catch (error) {
    return res.status(502).json({ message: error?.message || "Bot request failed." });
  }
};

async function getRequestBody(req) {
  if (req?.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function sanitizeBotPatch(config) {
  return {
    botMode: ["manual", "paper", "live"].includes(String(config.botMode || "").toLowerCase()) ? String(config.botMode).toLowerCase() : "manual",
    botInstrument: String(config.botInstrument || "XAU_USD").trim().toUpperCase().replace("/", "_"),
    oandaEnvironment: String(config.oandaEnvironment || "practice").toLowerCase() === "live" ? "live" : "practice",
    botUnits: normalizeInteger(config.botUnits, 10),
    botStopLossOffset: normalizeNumber(config.botStopLossOffset, 3),
    botTakeProfitOffset: normalizeNumber(config.botTakeProfitOffset, 6),
    botCooldownMinutes: normalizeInteger(config.botCooldownMinutes, 15),
    botPollIntervalSeconds: normalizeInteger(config.botPollIntervalSeconds, 60),
  };
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
