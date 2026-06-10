const { getFirestore } = require("../lib/firebase-admin");
const DEFAULT_BASE = "https://aurum-quant-ai.vercel.app";

module.exports = async function handler(req, res) {
  if (req.method === "POST") {
    const body = await getRequestBody(req);
    const entry = body?.entry && typeof body.entry === "object" ? body.entry : null;
    const source = String(body?.source || "manual");
    if (!entry) {
      res.status(400).json({ message: "Missing history entry." });
      return;
    }
    try {
      const Persistence = require("../lib/persistence");
      await Persistence.init();
      const db = getFirestore();

      const inferredDeviceId = String(
        entry.deviceId ||
        req.headers["x-device-id"] ||
        `browser-${hashFromString(String(req.headers["user-agent"] || ""))}`,
      ).slice(0, 120);
      const payload = {
        ...entry,
        source,
        deviceId: inferredDeviceId,
        syncId: String(entry.syncId || `${inferredDeviceId}__${String(entry.id || Date.now())}`).slice(0, 180),
        deviceLabel: String(entry.deviceLabel || req.headers["user-agent"] || "").slice(0, 260),
        createdAt: Number.isFinite(Number(entry.createdAt))
          ? Number(entry.createdAt)
          : Number.isFinite(Date.parse(String(entry.timestampIso || "")))
            ? Date.parse(String(entry.timestampIso))
            : Date.now(),
      };
      
      // Dual persistence: Cloud (Firestore) + Institutional (Persistence/Comdb2)
      await Promise.all([
          db.collection("analysis_history").doc(payload.syncId).set(payload, { merge: true }),
          Persistence.logSignal(payload)
      ]);

      triggerAutoLearn(req).catch(() => {});
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true });
      return;
    } catch (error) {
      try {
        const Persistence = require("../lib/persistence");
        await Persistence.init();
        const inferredDeviceId = String(
          entry.deviceId ||
          req.headers["x-device-id"] ||
          `browser-${hashFromString(String(req.headers["user-agent"] || ""))}`,
        ).slice(0, 120);
        const payload = {
          ...entry,
          source,
          deviceId: inferredDeviceId,
          syncId: String(entry.syncId || `${inferredDeviceId}__${String(entry.id || Date.now())}`).slice(0, 180),
          deviceLabel: String(entry.deviceLabel || req.headers["user-agent"] || "").slice(0, 260),
          createdAt: Number.isFinite(Number(entry.createdAt))
            ? Number(entry.createdAt)
            : Number.isFinite(Date.parse(String(entry.timestampIso || "")))
              ? Date.parse(String(entry.timestampIso))
              : Date.now(),
          storageMode: "local-fallback",
        };
        await Persistence.logSignal(payload);
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({ ok: true, storageMode: "local-fallback" });
        return;
      } catch (fallbackError) {
        res.status(502).json({ message: fallbackError?.message || error?.message || "Failed to store history." });
        return;
      }
    }
  }

  if (req.method === "GET") {
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || "30"), 10) || 30));
    try {
      const db = getFirestore();
      const snapshot = await db.collection("analysis_history").orderBy("createdAt", "desc").limit(limit).get();
      const entries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ entries });
      return;
    } catch (error) {
      try {
        const Persistence = require("../lib/persistence");
        await Persistence.init();
        const entries = (await Persistence.readAll())
          .slice()
          .sort((left, right) => {
            const leftTs = Number(left?.createdAt || Date.parse(String(left?.timestampIso || "")) || Number(left?.id || 0));
            const rightTs = Number(right?.createdAt || Date.parse(String(right?.timestampIso || "")) || Number(right?.id || 0));
            return rightTs - leftTs;
          })
          .slice(0, limit)
          .map((entry) => ({ id: entry.syncId || entry.id, ...entry }));
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({ entries, storageMode: "local-fallback" });
        return;
      } catch (fallbackError) {
        res.status(502).json({ message: fallbackError?.message || error?.message || "Failed to read history." });
        return;
      }
    }
  }

  res.status(405).json({ message: "Method not allowed." });
};

async function getRequestBody(req) {
  if (req?.body && typeof req.body === "object") {
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function hashFromString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0).toString(16);
}

async function triggerAutoLearn(req) {
  const cronSecret = process.env.CRON_SECRET || "";
  const baseUrl = resolveBaseUrl(req);
  await fetch(`${baseUrl}/api/auto-learn`, {
    method: "POST",
    headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
  });
}

function resolveBaseUrl(req) {
  const configured = String(process.env.AUTO_ANALYZE_BASE_URL || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const host = String(req?.headers?.host || "").trim();
  if (!host) {
    return DEFAULT_BASE;
  }
  const protocol = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  return `${protocol}://${host}`.replace(/\/+$/, "");
}
