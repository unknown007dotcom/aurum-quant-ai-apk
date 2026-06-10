const { getFirestore } = require("../lib/firebase-admin");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  const body = await getRequestBody(req);
  const outcome = String(body.outcome || "").toLowerCase();
  const reason = String(body.reason || "").trim().slice(0, 400);
  const timeframe = String(body.timeframe || "").trim().slice(0, 20);
  const direction = String(body.direction || "").trim().slice(0, 30);
  const summary = String(body.summary || "").trim().slice(0, 500);
  const entryId = String(body.entryId || "").trim().slice(0, 80);

  if (!["win", "loss"].includes(outcome)) {
    res.status(400).json({ message: "Outcome must be win or loss." });
    return;
  }
  if (outcome === "loss" && !reason) {
    res.status(400).json({ message: "Please provide what went wrong for loss entries." });
    return;
  }

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
      createdAt: now,
    });

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
