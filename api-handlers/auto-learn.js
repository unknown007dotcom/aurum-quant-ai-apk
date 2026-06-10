const { getFirestore, getAdminSettings } = require("../lib/firebase-admin");

const DEFAULT_BASE = "https://aurum-quant-ai.vercel.app";
const MAX_SCAN_ITEMS = 120;
const MAX_FAILURE_DEBATE_PER_RUN = 2;
const MAX_DEBATE_MODELS = 12;
const MODEL_TIMEOUT_MS = 12000;
const SUMMARY_TIMEOUT_MS = 16000;
const DEFAULT_AI_BASE = "https://integrate.api.nvidia.com/v1";
const TRADE_AUTO_CLOSE_MS = 30 * 60 * 1000;

module.exports = async function handler(req, res) {
  const cronAuth = process.env.CRON_SECRET || "";
  const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const isCronCall = req.headers["x-vercel-cron"] === "1";
  if (cronAuth && !isCronCall && provided !== cronAuth) {
    res.status(401).json({ message: "Unauthorized." });
    return;
  }

  try {
    const db = getFirestore();
    const settings = (await safeLoadAdminSettings()) || {};
    const baseUrl = process.env.AUTO_ANALYZE_BASE_URL || DEFAULT_BASE;
    const snapshot = await db
      .collection("analysis_history")
      .orderBy("createdAt", "desc")
      .limit(MAX_SCAN_ITEMS * 2)
      .get();

    let evaluated = 0;
    let slHits = 0;
    let tpHits = 0;
    let debatedLosses = 0;
    const lossQueue = [];

    for (const doc of snapshot.docs) {
      const entry = doc.data() || {};
      if (entry.autoEvaluated === true) {
        continue;
      }
      const timeframe = String(entry.timeframe || "15min");
      const direction = parseDirection(entry);
      const entryPrice = parseEntryPrice(entry);
      const invalidation = parseInvalidation(entry, direction, entryPrice);
      const targets = parseTargetLevels(entry, direction, invalidation, entryPrice);
      const tp1 = targets.tp1;
      const tp2 = targets.tp2;
      const at = parseTimestamp(entry.timestampIso);

      if (!direction || !Number.isFinite(invalidation) || !Number.isFinite(entryPrice) || !at) {
        await doc.ref.set({
          autoEvaluated: true,
          autoEvaluatedAt: Date.now(),
          autoEvalStatus: "skipped-missing-fields",
          autoEvalDirection: direction || null,
          autoEvalInvalidation: Number.isFinite(invalidation) ? invalidation : null,
          autoEvalEntry: Number.isFinite(entryPrice) ? entryPrice : null,
          autoEvalTp1: Number.isFinite(tp1) ? tp1 : null,
          autoEvalTp2: Number.isFinite(tp2) ? tp2 : null,
        }, { merge: true });
        evaluated += 1;
        continue;
      }

      const candles = await fetchCandles(baseUrl, timeframe);
      if (!candles.length) {
        continue;
      }

      const post = candles.filter((c) => parseTimestamp(c.datetime) > at).slice(0, barsForTimeframe(timeframe));
      if (post.length < 10) {
        continue;
      }

      const evaluation = evaluateSignal({
        direction,
        invalidation,
        entryPrice,
        tp1,
        tp2,
        postCandles: post,
        entryTimestamp: at,
      });

      const autoEvalStatus = evaluation.status;

      await doc.ref.set({
        autoEvaluated: true,
        autoEvaluatedAt: Date.now(),
        autoEvalStatus,
        autoEvalDirection: direction,
        autoEvalEntry: entryPrice,
        autoEvalInvalidation: invalidation,
        autoEvalTp1: Number.isFinite(tp1) ? tp1 : null,
        autoEvalTp2: Number.isFinite(tp2) ? tp2 : null,
        autoEvalHitBarIndex: Number.isFinite(evaluation.hitBarIndex) ? evaluation.hitBarIndex : null,
        autoEvalNote: evaluation.note,
        autoEvalMaxFavorable: evaluation.maxFavorable || 0,
        autoEvalMaxAdverse: evaluation.maxAdverse || 0,
        autoEvalPlannedRR: evaluation.plannedRR || 0,
        autoEvalActualRR: evaluation.actualRR || 0,
        autoEvalTimeframe: timeframe,
        autoEvalClosePrice: Number.isFinite(evaluation.closePrice) ? evaluation.closePrice : null,
      }, { merge: true });
      evaluated += 1;

      if (autoEvalStatus === "loss-sl-hit" || autoEvalStatus === "loss-time-expired") {
        slHits += 1;
        const reason = autoEvalStatus === "loss-time-expired"
          ? `Auto-closed after 30 minutes in loss on ${timeframe} ${direction.toUpperCase()} setup.`
          : `Auto-detected SL hit on ${timeframe} ${direction.toUpperCase()} setup after signal.`;
        await saveLearningOutcome(db, {
          outcome: "loss",
          timeframe,
          direction,
          entryId: String(entry.id || doc.id),
          reason,
          summary: String(entry.aiOverlay || "").slice(0, 500),
        });
        lossQueue.push({
          entryId: String(entry.id || doc.id),
          timeframe,
          direction,
          entryPrice,
          invalidation,
          tp1,
          tp2,
          reason,
          aiOverlay: String(entry.aiOverlay || "").slice(0, 1800),
          executionOverview: Array.isArray(entry.executionOverview) ? entry.executionOverview.slice(0, 8) : [],
          marketFingerprint: entry.marketFingerprint || null,
        });
      } else if (autoEvalStatus === "win-tp-hit" || autoEvalStatus === "win-time-expired") {
        tpHits += 1;
        await saveLearningOutcome(db, {
          outcome: "win",
          timeframe,
          direction,
          entryId: String(entry.id || doc.id),
          reason: autoEvalStatus === "win-time-expired"
            ? "Auto-closed after 30 minutes in profit after preserving directional bias."
            : "TP2 hit after clean structure held and invalidation stayed intact.",
          summary: String(entry.aiOverlay || "").slice(0, 500),
        });
      }
    }

    const queued = lossQueue.slice(0, MAX_FAILURE_DEBATE_PER_RUN);
    for (const failed of queued) {
      const debated = await runFailureDebateAndPersist(db, settings, failed);
      if (debated) {
        debatedLosses += 1;
      }
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, evaluated, slHits, tpHits, debatedLosses });
  } catch (error) {
    res.status(502).json({ message: error?.message || "Auto learn failed." });
  }
};

async function fetchCandles(baseUrl, timeframe) {
  const interval = timeframeToInterval(timeframe);
  const resp = await fetch(
    `${baseUrl}/api/market-data?interval=${encodeURIComponent(interval)}&outputsize=5000&symbol=XAU%2FUSD`,
  );
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || !Array.isArray(payload.values)) {
    return [];
  }
  return payload.values.slice().reverse();
}

function timeframeToInterval(value) {
  const raw = String(value || "").toLowerCase();
  const map = {
    "1m": "1min",
    "1min": "1min",
    "5m": "5min",
    "5min": "5min",
    "15m": "15min",
    "15min": "15min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1day",
    "1day": "1day",
    "1w": "1week",
    "1week": "1week",
  };
  return map[raw] || "15min";
}

function barsForTimeframe(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("1min") || raw === "1m") return 300;
  if (raw.includes("5min") || raw === "5m") return 220;
  if (raw.includes("15min") || raw === "15m") return 180;
  if (raw.includes("1h")) return 120;
  if (raw.includes("4h")) return 90;
  return 120;
}

function parseDirection(entry) {
  const text = `${String(entry?.aiOverlay || "")}\n${Array.isArray(entry?.executionOverview) ? entry.executionOverview.join("\n") : ""}`;
  const line = /Direction:\s*([^\n]+)/i.exec(text);
  if (line) {
    const token = String(line[1] || "").toLowerCase();
    if (token.includes("buy") || token.includes("bull")) return "buy";
    if (token.includes("sell") || token.includes("bear")) return "sell";
    if (token.includes("flat") || token.includes("wait")) return "";
  }
  const lower = text.toLowerCase();
  if (lower.includes("strong buy") || lower.includes("perfect buy") || lower.includes("primary bias: buy")) return "buy";
  if (lower.includes("strong sell") || lower.includes("perfect sell") || lower.includes("primary bias: sell")) return "sell";
  return "";
}

function parseInvalidation(entry, direction, entryPrice) {
  const text = `${String(entry?.aiOverlay || "")}\n${Array.isArray(entry?.executionOverview) ? entry.executionOverview.join("\n") : ""}`;
  const line = /Invalidation:\s*([^\n]+)/i.exec(text);
  if (line) {
    const numbers = String(line[1]).match(/\d+(\.\d+)?/g);
    if (numbers?.length) {
      return Number(numbers[0]);
    }
  }

  const stopDistance = parseStopDistance(entry);
  if (Number.isFinite(stopDistance) && Number.isFinite(entryPrice) && direction) {
    return direction === "buy" ? entryPrice - stopDistance : entryPrice + stopDistance;
  }
  return Number.NaN;
}

function parseEntryPrice(entry) {
  const fromField = Number(entry?.price);
  if (Number.isFinite(fromField)) {
    return fromField;
  }
  const text = `${String(entry?.aiOverlay || "")}\n${Array.isArray(entry?.executionOverview) ? entry.executionOverview.join("\n") : ""}`;
  const line = /Entry(?:\s*Zone)?\s*:\s*([^\n]+)/i.exec(text);
  if (line) {
    const numbers = String(line[1]).match(/\d+(\.\d+)?/g);
    if (numbers?.length) {
      return Number(numbers[0]);
    }
  }
  const fallbackNumbers = text.match(/Price:\s*(\d+(\.\d+)?)/i);
  if (fallbackNumbers?.[1]) {
    return Number(fallbackNumbers[1]);
  }
  return Number.NaN;
}

function parseTargetLevels(entry, direction, invalidation, entryPrice) {
  const text = `${String(entry?.aiOverlay || "")}\n${Array.isArray(entry?.executionOverview) ? entry.executionOverview.join("\n") : ""}`;
  const tpLine = /TP1[^0-9]*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  const tp2Line = /TP2[^0-9]*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  const parsedTp1 = tpLine?.[1] ? Number(tpLine[1]) : Number.NaN;
  const parsedTp2 = tp2Line?.[1] ? Number(tp2Line[1]) : Number.NaN;
  if (Number.isFinite(parsedTp1) || Number.isFinite(parsedTp2)) {
    return {
      tp1: Number.isFinite(parsedTp1) ? parsedTp1 : parsedTp2,
      tp2: Number.isFinite(parsedTp2) ? parsedTp2 : parsedTp1,
    };
  }

  if (!Number.isFinite(entryPrice) || !Number.isFinite(invalidation) || !direction) {
    return { tp1: Number.NaN, tp2: Number.NaN };
  }
  const stopDistance = Math.abs(entryPrice - invalidation);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0.01) {
    return { tp1: Number.NaN, tp2: Number.NaN };
  }
  return {
    tp1: direction === "buy" ? entryPrice + stopDistance : entryPrice - stopDistance,
    tp2: direction === "buy" ? entryPrice + stopDistance * 1.8 : entryPrice - stopDistance * 1.8,
  };
}

function parseStopDistance(entry) {
  const text = Array.isArray(entry?.executionOverview) ? entry.executionOverview.join("\n") : String(entry?.aiOverlay || "");
  const hit = /approximately\s+([0-9]+(?:\.[0-9]+)?)\s+XAU\s+distance\s+for\s+SL/i.exec(text);
  if (hit?.[1]) {
    const parsed = Number(hit[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Number.NaN;
}

function parseTimestamp(value) {
  if (!value) return 0;
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : 0;
}

function evaluateSignal({ direction, invalidation, entryPrice, tp1, tp2, postCandles, entryTimestamp }) {
  const slIndex = postCandles.findIndex((candle) => (
    direction === "buy"
      ? Number(candle.low) <= invalidation
      : Number(candle.high) >= invalidation
  ));
  const mainTarget = Number.isFinite(tp2) ? tp2 : tp1;
  const hasTp = Number.isFinite(mainTarget);
  const tpIndex = hasTp
    ? postCandles.findIndex((candle) => (
      direction === "buy"
        ? Number(candle.high) >= mainTarget
        : Number(candle.low) <= mainTarget
    ))
    : -1;

  // Calculate max favorable excursion (MFE) and max adverse excursion (MAE)
  let maxFavorable = 0;
  let maxAdverse = 0;
  for (const candle of postCandles) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    if (direction === "buy") {
      maxFavorable = Math.max(maxFavorable, high - entryPrice);
      maxAdverse = Math.max(maxAdverse, entryPrice - low);
    } else {
      maxFavorable = Math.max(maxFavorable, entryPrice - low);
      maxAdverse = Math.max(maxAdverse, high - entryPrice);
    }
  }

  const riskDistance = Math.abs(entryPrice - invalidation);
  const rewardDistance = hasTp ? Math.abs(mainTarget - entryPrice) : 0;
  const plannedRR = riskDistance > 0 && rewardDistance > 0 ? Number((rewardDistance / riskDistance).toFixed(2)) : 0;
  const actualRR = riskDistance > 0 && maxFavorable > 0 ? Number((maxFavorable / riskDistance).toFixed(2)) : 0;

  if (slIndex >= 0 && (tpIndex === -1 || slIndex <= tpIndex)) {
    return {
      status: "loss-sl-hit",
      hitBarIndex: slIndex,
      note: "Invalidation was touched before TP2.",
      maxFavorable: Number(maxFavorable.toFixed(2)),
      maxAdverse: Number(maxAdverse.toFixed(2)),
      plannedRR,
      actualRR,
      closePrice: invalidation,
    };
  }

  if (tpIndex >= 0) {
    return {
      status: "win-tp-hit",
      hitBarIndex: tpIndex,
      note: "TP2 was reached before invalidation.",
      maxFavorable: Number(maxFavorable.toFixed(2)),
      maxAdverse: Number(maxAdverse.toFixed(2)),
      plannedRR,
      actualRR,
      closePrice: mainTarget,
    };
  }

  const expiryTs = Number(entryTimestamp || 0) + TRADE_AUTO_CLOSE_MS;
  const expiryIndex = postCandles.findIndex((candle) => parseTimestamp(candle.datetime) >= expiryTs);
  if (expiryIndex >= 0) {
    const expiryCandle = postCandles[expiryIndex];
    const marketClose = Number(expiryCandle.close);
    const profit = direction === "buy" ? marketClose - entryPrice : entryPrice - marketClose;
    return {
      status: profit >= 0 ? "win-time-expired" : "loss-time-expired",
      hitBarIndex: expiryIndex,
      note: `Trade auto-closed after 30 minutes at market ${marketClose.toFixed(2)} ${profit >= 0 ? "in profit" : "in loss"}.`,
      maxFavorable: Number(maxFavorable.toFixed(2)),
      maxAdverse: Number(maxAdverse.toFixed(2)),
      plannedRR,
      actualRR,
      closePrice: marketClose,
    };
  }

  return {
    status: hasTp ? "closed-no-hit" : "closed-no-tp",
    hitBarIndex: -1,
    note: hasTp
      ? "Neither TP2 nor invalidation was reached inside evaluation window."
      : "TP2 not detected; only invalidation tracking was possible.",
    maxFavorable: Number(maxFavorable.toFixed(2)),
    maxAdverse: Number(maxAdverse.toFixed(2)),
    plannedRR,
    actualRR,
    closePrice: Number.NaN,
  };
}

async function saveLearningOutcome(db, { outcome, timeframe, direction, entryId, reason, summary }) {
  const now = Date.now();
  const existing = await db
    .collection("learning_feedback")
    .where("entryId", "==", entryId)
    .where("outcome", "==", outcome)
    .limit(1)
    .get();
  if (!existing.empty) {
    return;
  }

  await db.collection("learning_feedback").add({
    outcome,
    reason,
    timeframe,
    direction,
    summary,
    entryId,
    createdAt: now,
    source: "auto-learn",
  });

  const globalRef = db.collection("learning").doc("global");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(globalRef);
    const current = snap.exists ? snap.data() || {} : {};
    const total = Number(current.total || 0) + 1;
    const wins = Number(current.wins || 0) + (outcome === "win" ? 1 : 0);
    const losses = Number(current.losses || 0) + (outcome === "loss" ? 1 : 0);
    const reasons = Array.isArray(current.topLossReasons) ? current.topLossReasons : [];
    const winPatterns = Array.isArray(current.topWinPatterns) ? current.topWinPatterns : [];

    let nextReasons = reasons;
    let nextWinPatterns = winPatterns;
    if (outcome === "loss" && reason) {
      const index = reasons.findIndex((item) => item && item.reason === reason);
      if (index >= 0) {
        nextReasons = reasons.map((item, i) => (i === index ? { ...item, count: Number(item.count || 0) + 1 } : item));
      } else {
        nextReasons = [...reasons, { reason, count: 1 }];
      }
      nextReasons = nextReasons.sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, 12);
    } else if (outcome === "win" && reason) {
      const index = winPatterns.findIndex((item) => item && item.reason === reason);
      if (index >= 0) {
        nextWinPatterns = winPatterns.map((item, i) => (i === index ? { ...item, count: Number(item.count || 0) + 1 } : item));
      } else {
        nextWinPatterns = [...winPatterns, { reason, count: 1 }];
      }
      nextWinPatterns = nextWinPatterns.sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, 12);
    }

    // Track timeframe-specific win rates
    const tfStats = current.timeframeStats || {};
    const tfKey = timeframe || "unknown";
    const tfEntry = tfStats[tfKey] || { wins: 0, losses: 0 };
    tfEntry[outcome === "win" ? "wins" : "losses"] += 1;
    tfStats[tfKey] = tfEntry;

    // Track direction-specific win rates
    const dirStats = current.directionStats || {};
    const dirKey = direction || "unknown";
    const dirEntry = dirStats[dirKey] || { wins: 0, losses: 0 };
    dirEntry[outcome === "win" ? "wins" : "losses"] += 1;
    dirStats[dirKey] = dirEntry;

    // Streak tracking
    const lastOutcome = current.lastOutcome || "";
    let streak = Number(current.currentStreak || 0);
    let streakType = String(current.currentStreakType || "");
    if (outcome === lastOutcome) {
      streak += 1;
    } else {
      streak = 1;
      streakType = outcome;
    }
    const bestWinStreak = Math.max(Number(current.bestWinStreak || 0), outcome === "win" ? streak : 0);
    const worstLossStreak = Math.max(Number(current.worstLossStreak || 0), outcome === "loss" ? streak : 0);

    tx.set(globalRef, {
      total,
      wins,
      losses,
      winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0,
      topLossReasons: nextReasons,
      topWinPatterns: nextWinPatterns,
      timeframeStats: tfStats,
      directionStats: dirStats,
      lastOutcome: outcome,
      currentStreak: streak,
      currentStreakType: streakType,
      bestWinStreak,
      worstLossStreak,
      updatedAt: now,
    }, { merge: true });
  });
}

async function runFailureDebateAndPersist(db, settings, failed) {
  const existing = await db
    .collection("learning_model_reviews")
    .where("entryId", "==", failed.entryId)
    .limit(1)
    .get();
  if (!existing.empty) {
    return false;
  }

  const globalKeys = normalizeNvidiaKeyPool(settings?.globalNvidiaApiKeys, settings?.globalNvidiaApiKey);
  const summaryModels = normalizeModels(settings?.nvidiaModels, globalKeys, 0);
  const debateModels = normalizeModels(settings?.debateModels, globalKeys, summaryModels.length);
  const modelPool = dedupeModels([...summaryModels, ...debateModels]).slice(0, MAX_DEBATE_MODELS);
  if (!modelPool.length) {
    return false;
  }

  const debatePrompt = buildFailureDebatePrompt(failed);
  const responses = await Promise.all(
    modelPool.map((model) => requestAi({
      model,
      prompt: debatePrompt,
      system: "You are a strict trade post-mortem analyst. Provide concise failure cause and concrete prevention rule.",
      maxTokens: 260,
      timeoutMs: MODEL_TIMEOUT_MS,
    })),
  );

  const usable = responses
    .map((result, index) => ({ result, model: modelPool[index] }))
    .filter((item) => item.result.ok && item.result.text);

  if (!usable.length) {
    return false;
  }

  const summaryModel =
    summaryModels.find((model) => model.key === String(settings?.defaultModelKey || "")) ||
    summaryModels[0] ||
    usable[0].model;
  const summaryPrompt = buildFailureSummaryPrompt(failed, usable);
  const summaryResult = await requestAi({
    model: summaryModel,
    prompt: summaryPrompt,
    system: "Synthesize multi-model debate into one practical learning memory block. Keep it terse and actionable.",
    maxTokens: 320,
    timeoutMs: SUMMARY_TIMEOUT_MS,
  });

  const finalSummary = summaryResult.ok && summaryResult.text
    ? summaryResult.text
    : fallbackReviewSummary(usable);

  const now = Date.now();
  await db.collection("learning_model_reviews").add({
    entryId: failed.entryId,
    timeframe: failed.timeframe,
    direction: failed.direction,
    reason: failed.reason,
    debateCount: usable.length,
    modelCountTried: modelPool.length,
    reviewSummary: finalSummary.slice(0, 3000),
    createdAt: now,
    models: usable.map((item) => item.model.label || item.model.id).slice(0, 20),
  });

  const globalRef = db.collection("learning").doc("global");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(globalRef);
    const current = snap.exists ? snap.data() || {} : {};
    const latestLessons = Array.isArray(current.latestModelLessons) ? current.latestModelLessons : [];
    const compactLesson = finalSummary.split("\n").map((line) => line.trim()).filter(Boolean)[0] || failed.reason;
    const nextLessons = [
      { lesson: compactLesson.slice(0, 240), at: now, entryId: failed.entryId },
      ...latestLessons,
    ].slice(0, 12);

    tx.set(globalRef, {
      totalModelDebates: Number(current.totalModelDebates || 0) + 1,
      latestModelLessons: nextLessons,
      updatedAt: now,
    }, { merge: true });
  });

  return true;
}

function buildFailureDebatePrompt(failed) {
  const execution = Array.isArray(failed.executionOverview) ? failed.executionOverview.join(" | ") : "";
  return [
    "A trade signal failed (SL hit).",
    `Timeframe: ${failed.timeframe}`,
    `Direction: ${failed.direction}`,
    `Entry: ${failed.entryPrice}`,
    `Invalidation: ${failed.invalidation}`,
    `TP1: ${failed.tp1}`,
    `Reason: ${failed.reason}`,
    `Execution Overview: ${execution}`,
    `Market Fingerprint: Trend=${failed.marketFingerprint?.trend || "n/a"}, ATR=${failed.marketFingerprint?.atr || "n/a"}, Killzone=${failed.marketFingerprint?.killzone ? "YES" : "NO"}, SMT=${failed.marketFingerprint?.smtActive ? "ACTIVE" : "none"}`,
    `Overlay: ${failed.aiOverlay}`,
    "Reply in 4 lines exactly:",
    "1) Failure Cause:",
    "2) Missed Warning:",
    "3) Prevention Rule:",
    "4) Confidence Impact:",
  ].join("\n");
}

function buildFailureSummaryPrompt(failed, usable) {
  const modelLines = usable
    .map((item, index) => `Model ${index + 1} (${item.model.label || item.model.id}): ${item.result.text}`)
    .join("\n\n");

  return [
    "Consolidate these model post-mortems into one learning memory for future XAUUSD analysis.",
    `Signal failed on ${failed.timeframe} ${failed.direction.toUpperCase()} with SL hit.`,
    "",
    modelLines,
    "",
    "Output exactly these headings:",
    "Primary Failure Cause:",
    "Do-Not-Repeat Rule:",
    "Context Filter To Add:",
    "Adjustment To Signal Quality:",
  ].join("\n");
}

function fallbackReviewSummary(usable) {
  return usable
    .slice(0, 4)
    .map((item, index) => `Model ${index + 1}: ${item.result.text}`)
    .join("\n");
}

async function requestAi({ model, prompt, system, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${sanitizeBaseUrl(model.baseUrl || DEFAULT_AI_BASE)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        temperature: 0.15,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, text: "", message: payload?.error?.message || payload?.message || `AI HTTP ${response.status}` };
    }
    const text = extractAiText(payload);
    return { ok: Boolean(text), text, message: text ? "" : "Empty AI response." };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, text: "", message: "AI timeout." };
    }
    return { ok: false, text: "", message: error?.message || "AI request failed." };
  } finally {
    clearTimeout(timeout);
  }
}

function extractAiText(payload) {
  const fromChoices = payload?.choices?.[0]?.message?.content;
  if (typeof fromChoices === "string" && fromChoices.trim()) {
    return fromChoices.trim();
  }
  const fromOutput = payload?.output?.[0]?.content?.[0]?.text;
  if (typeof fromOutput === "string" && fromOutput.trim()) {
    return fromOutput.trim();
  }
  const textField = payload?.text;
  if (typeof textField === "string" && textField.trim()) {
    return textField.trim();
  }
  return "";
}

function normalizeModels(input, globalKeys, startIndex = 0) {
  return Array.isArray(input)
    ? input
      .map((item, index) => ({
        key: String(item?.key || item?.id || "").trim(),
        label: String(item?.label || item?.id || "").trim(),
        id: String(item?.id || "").trim(),
        apiKey:
          String(item?.apiKey || "").trim() ||
          pickRandomNvidiaKey(globalKeys),
        baseUrl: sanitizeBaseUrl(String(item?.baseUrl || DEFAULT_AI_BASE).trim()),
      }))
      .filter((item) => item.id && item.apiKey)
    : [];
}

function normalizeNvidiaKeyPool(listValue, legacyValue) {
  const list = Array.isArray(listValue) ? listValue : [];
  const combined = [...list, legacyValue].map((item) => String(item || "").trim()).filter(Boolean);
  const unique = [];
  for (const key of combined) {
    if (!key.toLowerCase().startsWith("nvapi-")) continue;
    if (!unique.includes(key)) unique.push(key);
  }
  return unique;
}

function pickRandomNvidiaKey(pool) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return "";
  }
  const idx = Math.floor(Math.random() * pool.length);
  return String(pool[idx] || "").trim();
}

function dedupeModels(models) {
  const seen = new Set();
  const output = [];
  for (const model of models) {
    const token = `${model.id}::${model.apiKey.slice(0, 24)}`;
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    output.push(model);
  }
  return output;
}

function sanitizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function safeLoadAdminSettings() {
  try {
    return await getAdminSettings();
  } catch {
    return null;
  }
}
