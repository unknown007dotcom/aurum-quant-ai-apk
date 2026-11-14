const { getFirestore } = require("../lib/firebase-admin");
const { isAdminPassword } = require("../lib/admin-auth");
const policy = require("../lib/learning-feedback-policy");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  const body = await getRequestBody(req);

  const validated = policy.validateFeedback(body);
  if (!validated.ok) {
    res.status(validated.status).json({ message: validated.message });
    return;
  }
  const { outcome, reason, timeframe, direction, summary, entryId, counted } = validated.feedback;

  // Identify the caller: no anonymous writes to the document that conditions the
  // model's win-rate.
  const deviceId = policy.normalizeDeviceId(
    body.deviceId || req.headers["x-device-id"],
  );
  if (!deviceId) {
    res.status(400).json({
      message: "Missing or invalid device id (8-120 chars: letters, digits, . _ : -).",
    });
    return;
  }

  const isTrusted = isAdminPassword(String(req.headers["x-admin-password"] || ""));
  if (!isTrusted && policy.isRateLimited(deviceId)) {
    res.setHeader("Retry-After", "600");
    res.status(429).json({ message: "Too many feedback writes for this device. Try again later." });
    return;
  }
  if (!isTrusted) policy.recordWrite(deviceId);

  try {
    const db = getFirestore();
    const now = Date.now();
    await db.collection("learning_feedback").add({
      outcome,
      reason,
      timeframe,
      direction,
      summary,
      entryId,
      deviceId,
      createdAt: now,
    });

    if (!counted) {
      // A manual note is stored above but must not skew win/loss statistics.
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true, counted: false });
      return;
    }

    const globalRef = db.collection("learning").doc("global");
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(globalRef);
      const current = snap.exists ? snap.data() || {} : {};
      const total = Number(current.total || 0) + 1;
      const wins = Number(current.wins || 0) + (outcome === "win" ? 1 : 0);
      const losses = Number(current.losses || 0) + (outcome === "loss" ? 1 : 0);
      const reasons = Array.isArray(current.topLossReasons) ? current.topLossReasons : [];

      let nextReasons = reasons;
      if (outcome === "loss" && reason) {
        const index = reasons.findIndex((item) => item && item.reason === reason);
        if (index >= 0) {
          nextReasons = reasons.map((item, i) => (i === index ? { ...item, count: Number(item.count || 0) + 1 } : item));
        } else {
          nextReasons = [...reasons, { reason, count: 1 }];
        }
        nextReasons = nextReasons.sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, 12);
      }

      tx.set(globalRef, {
        total,
        wins,
        losses,
        winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0,
        topLossReasons: nextReasons,
        updatedAt: now,
      }, { merge: true });
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(502).json({ message: error?.message || "Failed to save learning feedback." });
  }
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
