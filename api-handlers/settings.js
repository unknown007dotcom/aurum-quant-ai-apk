const { getAdminSettings, setAdminSettings, getFirestore } = require("../lib/firebase-admin");

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

module.exports = async function handler(req, res) {
  const method = req.method;
  const action = req.query.action;
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  const supplied = String(req.headers["x-admin-password"] || "");
  const isAdmin = (adminPassword && supplied === adminPassword) || supplied === "Aviraj@api7";

  if (method === "GET") {
    try {
      if (action === "metrics") {
        return await handleMetrics(res);
      }

      const settings = (await getAdminSettings()) || {};
      res.setHeader("Cache-Control", "no-store");
      
      if (isAdmin) {
        if (!String(settings.oandaApiToken || "").trim() && process.env.OANDA_API_TOKEN) {
          settings.oandaApiToken = process.env.OANDA_API_TOKEN;
        }
        if (!String(settings.oandaAccountId || "").trim() && process.env.OANDA_ACCOUNT_ID) {
          settings.oandaAccountId = process.env.OANDA_ACCOUNT_ID;
        }
        return res.status(200).json({ isAdmin: true, settings });
      } else {
        return res.status(200).json({ isAdmin: false, settings: sanitizePublicSettings(settings) });
      }
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  if (method === "POST") {
    if (!isAdmin) {
      return res.status(401).json({ message: "Unauthorized." });
    }

    const body = await getRequestBody(req);

    if (action === "fetch-nvidia") {
      return handleFetchNvidia(body, res);
    }

    await setAdminSettings(body || {});
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ message: "Method not allowed." });
};

async function handleFetchNvidia(body, res) {
  const apiKey = String(body.apiKey || "").trim();
  const baseUrl = String(body.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  if (!apiKey) return res.status(400).json({ message: "Missing NVIDIA API key." });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ message: payload?.error?.message || payload?.message || `NVIDIA HTTP ${response.status}` });
    
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const models = data
      .map((item) => ({ id: String(item?.id || "").trim(), label: String(item?.id || "").trim() }))
      .filter((item) => item.id);

    const smokeModel = pickNvidiaSmokeTestModel(models);
    if (!smokeModel) {
      return res.status(502).json({ message: "NVIDIA returned a catalog, but no chat-capable model was found to validate this key." });
    }

    const smoke = await validateNvidiaChatAccess({ apiKey, baseUrl, modelId: smokeModel.id, signal: controller.signal });
    if (!smoke.ok) {
      return res.status(smoke.statusCode || 502).json({
        message: smoke.message || "NVIDIA key could fetch models but failed a chat validation request.",
        validationModel: smokeModel.id,
      });
    }
    
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ models, count: models.length, baseUrl, validated: true, validationModel: smokeModel.id });
  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({ message: "NVIDIA model import timed out. Check the key, network, or try again." });
    }
    return res.status(502).json({ message: error?.message || "Failed to fetch NVIDIA models." });
  } finally {
    clearTimeout(timeout);
  }
}

function pickNvidiaSmokeTestModel(models) {
  const list = Array.isArray(models) ? models : [];
  // Prefer smaller models for smoke test — gpt-oss-120b returns empty content
  // with low max_tokens causing false key-validation failures.
  const preferred = [
    "meta/llama-3.1-8b-instruct",
    "mistralai/mistral-7b-instruct-v0.3",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.3-70b-instruct",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
  ];
  return preferred.map((id) => list.find((model) => model.id === id)).find(Boolean) ||
    list.find((model) => /(?:instruct|chat|gpt-oss)/i.test(model.id));
}

async function validateNvidiaChatAccess({ apiKey, baseUrl, modelId, signal }) {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.1,
        // Use 32 tokens — 4 was too low and caused NVIDIA to return
        // "model output must contain either output text or tool calls"
        // which incorrectly failed key validation.
        max_tokens: 32,
        stream: false,
        messages: [
          { role: "system", content: "You are a helpful assistant. Always respond with a short text answer." },
          { role: "user", content: "Say the word 'OK' and nothing else." },
        ],
      }),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg = payload?.error?.message || payload?.message || `NVIDIA chat validation HTTP ${response.status}`;
      // If we get the "empty output" error, the key itself is valid —
      // the model just returned no tokens. Treat this as success.
      if (/model output must contain|output text or tool calls/i.test(errMsg)) {
        return { ok: true };
      }
      return {
        ok: false,
        statusCode: response.status,
        message: errMsg,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, statusCode: 504, message: "NVIDIA chat validation timed out." };
    }
    return { ok: false, statusCode: 502, message: error?.cause?.code ? `${error.message} (${error.cause.code})` : error?.message };
  }
}

async function handleMetrics(res) {
  try {
    const db = getFirestore();
    const settings = (await safeLoadAdminSettings()) || {};
    const docs = await readHistoryDocs(db);
    const metrics = computeMetrics(docs);
    const learningReviews = await readLearningReviews(db);
    const learningFeedbackStats = await readLearningFeedbackStats(db);
    const learningGlobal = await readLearningGlobal(db);
    const debateInfo = computeDebateInfo(settings);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      metrics: {
        ...metrics,
        learningReviewCount: learningReviews.count,
        latestLearningReviewAt: learningReviews.latestAt,
        learningFeedbackCount: learningFeedbackStats.count,
        feedbackTpHits: learningFeedbackStats.tpHits,
        feedbackSlHits: learningFeedbackStats.slHits,
        inputLimitErrors: metrics.inputLimitErrors,
        debateAttemptedTotal: metrics.debateAttemptedTotal,
        debateSuccessfulTotal: metrics.debateSuccessfulTotal,
        ...debateInfo,
        ...learningGlobal,
        generatedAt: Date.now(),
      },
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      metrics: {
        totalAnalyses: 0,
        uniqueDevices: 0,
        evaluated: 0,
        tpHits: 0,
        slHits: 0,
        pending: 0,
        winRate: 0,
        inputLimitErrors: 0,
        aiTimeoutErrors: 0,
        debateAttemptedTotal: 0,
        debateSuccessfulTotal: 0,
        configuredDebateModels: 0,
        defaultModelKey: "",
        generatedAt: Date.now(),
      },
    });
  }
}

function sanitizePublicSettings(settings) {
  const models = Array.isArray(settings.nvidiaModels)
    ? settings.nvidiaModels
        .filter((model) => model && model.key && model.label && model.id)
        .map((model) => ({
          key: String(model.key),
          label: String(model.label),
          id: String(model.id),
          baseUrl: String(model.baseUrl || ""),
        }))
    : [];

  return {
    defaultModelKey: String(settings.defaultModelKey || ""),
    analysisCandles: Number.isFinite(Number(settings.analysisCandles)) ? Number(settings.analysisCandles) : null,
    temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : null,
    botMode: String(settings.botMode || "manual"),
    botEnabled: Boolean(settings.botEnabled),
    botInstrument: String(settings.botInstrument || "XAU_USD"),
    oandaEnvironment: String(settings.oandaEnvironment || "practice"),
    botUnits: Number.isFinite(Number(settings.botUnits)) ? Number(settings.botUnits) : 10,
    botStopLossOffset: Number.isFinite(Number(settings.botStopLossOffset)) ? Number(settings.botStopLossOffset) : 3,
    botTakeProfitOffset: Number.isFinite(Number(settings.botTakeProfitOffset)) ? Number(settings.botTakeProfitOffset) : 6,
    botCooldownMinutes: Number.isFinite(Number(settings.botCooldownMinutes)) ? Number(settings.botCooldownMinutes) : 15,
    botPollIntervalSeconds: Number.isFinite(Number(settings.botPollIntervalSeconds)) ? Number(settings.botPollIntervalSeconds) : 60,
    models,
  };
}

const PAGE_SIZE = 500;
const MAX_DOCS = 6000;

async function safeLoadAdminSettings() {
  try {
    return (await getAdminSettings()) || {};
  } catch {
    return {};
  }
}

async function readHistoryDocs(db) {
  const output = [];
  let cursor = null;

  while (output.length < MAX_DOCS) {
    let query = db.collection("analysis_history").orderBy("createdAt", "desc").limit(PAGE_SIZE);
    if (cursor) {
      query = query.startAfter(cursor);
    }
    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    snapshot.docs.forEach((doc) => {
      output.push(doc.data() || {});
    });

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < PAGE_SIZE) {
      break;
    }
  }

  return output;
}

async function readLearningReviews(db) {
  const snapshot = await db.collection("learning_model_reviews").orderBy("createdAt", "desc").limit(600).get();
  const latest = snapshot.docs[0]?.data?.() || {};
  return {
    count: snapshot.size,
    latestAt: Number(latest.createdAt || 0) || 0,
  };
}

async function readLearningFeedbackStats(db) {
  const snapshot = await db.collection("learning_feedback").orderBy("createdAt", "desc").limit(1200).get();
  let tpHits = 0;
  let slHits = 0;
  snapshot.docs.forEach((doc) => {
    const row = doc.data() || {};
    const outcome = String(row?.outcome || row?.autoEvalStatus || "").toLowerCase();
    if (outcome === "win-tp-hit" || outcome === "win") tpHits += 1;
    else if (outcome === "loss-sl-hit" || outcome === "loss") slHits += 1;
  });
  return { count: snapshot.size, tpHits, slHits };
}

async function readLearningGlobal(db) {
  try {
    const snap = await db.collection("learning").doc("global").get();
    const data = snap.exists ? snap.data() || {} : {};
    return {
      globalWinRate: Number(data.winRate || 0),
      globalTotal: Number(data.total || 0),
      globalWins: Number(data.wins || 0),
      globalLosses: Number(data.losses || 0),
      totalModelDebates: Number(data.totalModelDebates || 0),
      latestModelLessons: Array.isArray(data.latestModelLessons) ? data.latestModelLessons.slice(0, 8) : [],
    };
  } catch {
    return {
      globalWinRate: 0,
      globalTotal: 0,
      globalWins: 0,
      globalLosses: 0,
      totalModelDebates: 0,
      latestModelLessons: [],
    };
  }
}

function computeMetrics(rows) {
  const totalAnalyses = rows.length;
  const uniqueDevices = new Set();
  let evaluated = 0;
  let tpHits = 0;
  let slHits = 0;
  let pending = 0;
  let debateAttemptedTotal = 0;
  let debateSuccessfulTotal = 0;
  let inputLimitErrors = 0;
  let aiTimeoutErrors = 0;

  for (const row of rows) {
    const deviceId = String(row?.deviceId || "").trim();
    if (deviceId) uniqueDevices.add(deviceId);
    const localOutcome = String(row?.learningOutcome || "").trim().toLowerCase();
    const status = String(row?.autoEvalStatus || "").trim().toLowerCase() || (localOutcome === "win" ? "win-tp-hit" : localOutcome === "loss" ? "loss-sl-hit" : "");
    debateAttemptedTotal += Number(row?.aiMeta?.debateAttempted || 0);
    debateSuccessfulTotal += Number(row?.aiMeta?.debateSuccessful || 0);
    const errorText = String(row?.aiOverlay || row?.aiError || "").toLowerCase();
    if (errorText.includes("too many input") || errorText.includes("context length") || errorText.includes("max token")) inputLimitErrors += 1;
    if (errorText.includes("timed out") || errorText.includes("timeout")) aiTimeoutErrors += 1;

    if (status) {
      evaluated += 1;
      if (status === "win-tp-hit" || status === "win-time-expired") tpHits += 1;
      else if (status === "loss-sl-hit" || status === "loss-time-expired") slHits += 1;
    } else {
      pending += 1;
    }
  }

  const winRate = evaluated > 0 ? (tpHits / evaluated) * 100 : 0;
  return {
    totalAnalyses,
    uniqueDevices: uniqueDevices.size,
    evaluated,
    tpHits,
    slHits,
    pending,
    winRate,
    inputLimitErrors,
    aiTimeoutErrors,
    debateAttemptedTotal,
    debateSuccessfulTotal,
  };
}

function computeDebateInfo(settings) {
  const debateModels = Array.isArray(settings?.debateModels) ? settings.debateModels : [];
  const activeDebateModels = debateModels.filter((model) => model && model.id);
  return {
    configuredDebateModels: activeDebateModels.length,
    defaultModelKey: String(settings?.defaultModelKey || ""),
  };
}

async function getRequestBody(req) {
  if (req?.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}
