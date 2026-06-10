const { getFirestore } = require("../lib/firebase-admin");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  try {
    const db = getFirestore();
    const snap = await db.collection("learning").doc("global").get();
    const data = snap.exists ? snap.data() || {} : {};
    let total = Number(data.total || 0);
    let wins = Number(data.wins || 0);
    let topLossReasons = Array.isArray(data.topLossReasons)
      ? data.topLossReasons
          .map((item) => ({ reason: String(item?.reason || ""), count: Number(item?.count || 0) }))
          .filter((item) => item.reason && item.count > 0)
      : [];

    // Always derive a fresh view from feedback stream and use it as source of truth when larger/newer.
    const feedbackSnap = await db
      .collection("learning_feedback")
      .orderBy("createdAt", "desc")
      .limit(800)
      .get();
    const reasonCounts = new Map();
    let streamWins = 0;
    feedbackSnap.docs.forEach((doc) => {
      const row = doc.data() || {};
      const outcome = String(row.outcome || "");
      if (outcome === "win") streamWins += 1;
      if (outcome === "loss") {
        const reason = String(row.reason || "").trim();
        if (reason) {
          reasonCounts.set(reason, Number(reasonCounts.get(reason) || 0) + 1);
        }
      }
    });
    const streamTotal = feedbackSnap.size;
    const streamTop = [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    if (streamTotal >= total) {
      total = streamTotal;
      wins = streamWins;
      topLossReasons = streamTop;
    }

    topLossReasons = topLossReasons.slice(0, 8);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      context: {
        total,
        winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0,
        topLossReasons,
      },
    });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ context: { total: 0, winRate: 0, topLossReasons: [] } });
  }
};
