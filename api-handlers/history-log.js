const { getFirestore } = require("../lib/firebase-admin");
const { isAdminPassword } = require("../lib/admin-auth");
const ingest = require("../lib/history-ingest");
const DEFAULT_BASE = "https://aurum-quant-ai.vercel.app";

module.exports = async function handler(req, res) {
  if (req.method === "POST") {
    const body = await getRequestBody(req);
    const source = String(body?.source || "manual").slice(0, 40);

    // Validate and bound the payload before anything touches storage.
    const validated = ingest.validateEntry(body?.entry);
    if (!validated.ok) {
      res.status(validated.status).json({ message: validated.message });
      return;
    }
    const entry = validated.entry;

    // A caller must identify itself; no silent User-Agent hashing, which made
    // every anonymous client share one bucket and hid abuse.
    const declaredDeviceId = ingest.normalizeDeviceId(
      entry.deviceId || req.headers["x-device-id"],
    );
    if (!declaredDeviceId) {
      res.status(400).json({
        message: "Missing or invalid device id (8-120 chars: letters, digits, . _ : -).",
      });
      return;
    }

    // Trusted operator bypasses the rate limit; everyone else is throttled.
    const isTrusted = isAdminPassword(String(req.headers["x-admin-password"] || ""));
    if (!isTrusted && ingest.isRateLimited(declaredDeviceId).limited) {
      res.setHeader("Retry-After", "600");
      res.status(429).json({ message: "Too many history writes for this device. Try again later." });
      return;
    }
    // Count the attempt before storage is touched: a caller must not be able to
    // dodge the limiter by forcing the local-fallback path.
    if (!isTrusted) ingest.recordWrite(declaredDeviceId);

    try {
      const Persistence = require("../lib/persistence");
      await Persistence.init();
      const db = getFirestore();

      const inferredDeviceId = declaredDeviceId;
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

      // Throttled so a burst of writes cannot fan out into repeated AI runs.
      if (ingest.shouldTriggerAutoLearn()) {
        triggerAutoLearn(req).catch(() => {});
      }
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true });
      return;
    } catch (error) {
      try {
        const Persistence = require("../lib/persistence");
        await Persistence.init();
        const inferredDeviceId = declaredDeviceId;
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
        if (ingest.shouldTriggerAutoLearn()) {
          triggerAutoLearn(req).catch(() => {});
        }
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
