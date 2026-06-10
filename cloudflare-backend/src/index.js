const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_INSTRUMENT = "XAU_USD";
const HISTORY_LIMIT = 150;
const MIN_DEPTH = 0.10;

// --- Debate Council & Learning Memory Constants ---
const DEBATE_MAX_WAIT_MS = 25000;
const SUMMARY_MAX_WAIT_MS = 35000;
const MAX_DEBATE_MODELS = 35;
const DEFAULT_DEBATE_MAX_TOKENS = 750;
const DEFAULT_SUMMARY_MAX_TOKENS = 2200;
const ALLOWED_ORIGINS = [
  "https://aurum-quant-ai.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const GRANULARITY_MAP = {
  "1min": "M1",
  "5min": "M5",
  "15min": "M15",
  "1h": "H1",
  "4h": "H4",
  "1day": "D",
  "1week": "W",
  "1month": "M",
};

const CACHE_TTL_SECONDS = 7200; // 2 hours — auto-deleted by Cloudflare after expiry

/**
 * Compresses raw candle JSON array into an ultra-minimized flat array of numbers.
 * Mapping: [0]=Unix Timestamp, [1]=Open, [2]=High, [3]=Low, [4]=Close, [5]=Volume
 * Achieves ~66% storage reduction versus verbose JSON keys.
 */
function compressCandles(rawCandles) {
  if (!Array.isArray(rawCandles)) return [];
  return rawCandles.map(c => [
    Math.floor(new Date(c.datetime).getTime() / 1000), // Index [0]: Unix Timestamp (seconds)
    c.open,                                            // Index [1]: Open
    c.high,                                            // Index [2]: High
    c.low,                                             // Index [3]: Low
    c.close,                                           // Index [4]: Close
    c.volume || 0                                      // Index [5]: Volume
  ]);
}

/**
 * Inflates the flat number arrays back into the standard JSON objects the frontend/AI expects.
 */
function inflateCandles(flatCandles) {
  if (!Array.isArray(flatCandles)) return [];
  return flatCandles.map(item => ({
    datetime: new Date(item[0] * 1000).toISOString(),
    open: item[1],
    high: item[2],
    low: item[3],
    close: item[4],
    volume: item[5],
    complete: true
  }));
}

/**
 * Fetches candle data using Cloudflare KV as a high-speed edge cache with auto-expiry.
 * Cache-Aside Pattern: KV read → (HIT? inflate & return) : (MISS? OANDA fetch → compress → KV write with TTL → return)
 */
async function fetchCandlesWithCache(env, options = {}) {
  const instrument = normalizeInstrument(options.instrument || DEFAULT_INSTRUMENT);
  const timeframe = String(options.timeframe || "15min");
  const count = clampInt(options.count, 1000, 30, 2500);
  
  // Use a master cache key without the requested count, so we build a single growing dataset per timeframe
  const cacheKey = `candles:${instrument}:${timeframe}:master`;

  // 1. Attempt to read existing history from the Cloudflare KV Edge Cache
  let cachedCandles = [];
  let cacheHit = false;
  try {
    if (env.CANDLE_CACHE) {
      const cachedData = await env.CANDLE_CACHE.get(cacheKey);
      if (cachedData) {
        const flatArray = JSON.parse(cachedData);
        cachedCandles = inflateCandles(flatArray);
        if (cachedCandles.length > 0) {
          cacheHit = true;
        }
      }
    }
  } catch (err) {
    console.error("KV read error:", err);
  }

  // Define timeframe freshness threshold in milliseconds
  const timeframeMs = {
    "1min": 1 * 60 * 1000,
    "5min": 5 * 60 * 1000,
    "15min": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1day": 24 * 60 * 60 * 1000,
    "1week": 7 * 24 * 60 * 60 * 1000,
    "1month": 30 * 24 * 60 * 60 * 1000
  };
  const duration = timeframeMs[timeframe] || (15 * 60 * 1000);

  // Check if cache is fresh enough.
  // Cache is fresh if the latest candle's timestamp is within the timeframe duration.
  let isFresh = false;
  if (cacheHit && cachedCandles.length > 0) {
    const lastCandle = cachedCandles.at(-1);
    const lastTime = new Date(lastCandle.datetime).getTime();
    if (Date.now() - lastTime < duration) {
      isFresh = true;
    }
  }

  // If the cache is fresh, return the uncut dataset directly! (Extremely fast Cache Hit!)
  if (isFresh) {
    return {
      source: "KV_CACHE",
      candles: cachedCandles
    };
  }

  // 2. Cache is stale or missing -> Fetch fresh rolling window from OANDA
  // To grow the history, we always request the fresh rolling window (the count requested, up to 2500)
  let freshCandles = [];
  let fetchFailed = false;
  try {
    freshCandles = await fetchCandles(env, { instrument, timeframe, count });
  } catch (err) {
    console.error(`OANDA fetch failed for ${timeframe}:`, err.message || err);
    fetchFailed = true;
  }

  if (!fetchFailed && Array.isArray(freshCandles) && freshCandles.length > 0) {
    // 3. Merge new candles into the permanent cached history (avoiding duplicate datetimes)
    const mergedMap = new Map();
    
    // Add existing history first, normalizing to Unix timestamp (seconds) as key
    cachedCandles.forEach(c => {
      if (c.datetime) {
        const ts = Math.floor(new Date(c.datetime).getTime() / 1000);
        if (Number.isFinite(ts)) {
          mergedMap.set(ts, { ...c, datetime: new Date(ts * 1000).toISOString() });
        }
      }
    });
    
    // Add/overwrite with fresh candles (so any incomplete candles get updated!)
    freshCandles.forEach(c => {
      if (c.datetime) {
        const ts = Math.floor(new Date(c.datetime).getTime() / 1000);
        if (Number.isFinite(ts)) {
          mergedMap.set(ts, { ...c, datetime: new Date(ts * 1000).toISOString() });
        }
      }
    });

    // Convert back to array, sort chronologically ascending using Date objects
    let mergedList = Array.from(mergedMap.values()).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    // Cap the permanent history database to a very generous 5,000 candles to keep performance optimal
    if (mergedList.length > 5000) {
      mergedList = mergedList.slice(-5000);
    }

    // 4. Save the expanded history back to KV PERMANENTLY (No expiration TTL! Never deleted!)
    if (env.CANDLE_CACHE) {
      try {
        const compressed = compressCandles(mergedList);
        await env.CANDLE_CACHE.put(cacheKey, JSON.stringify(compressed));
      } catch (err) {
        console.error("KV write error:", err);
      }
    }

    return {
      source: "OANDA_LIVE_MERGED",
      candles: mergedList
    };
  }

  // Fallback to whatever is cached if OANDA fetch failed or returned empty
  if (cachedCandles.length > 0) {
    return {
      source: "KV_CACHE_FALLBACK",
      candles: cachedCandles
    };
  }

  if (fetchFailed) {
    throw new Error(`OANDA fetch failed and no cached candles available for ${timeframe}.`);
  }

  return { source: "OANDA_LIVE", candles: freshCandles };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return jsonResponse({ ok: true, service: "aurum-quant-edge" }, request);
      }
      if (url.pathname === "/market-mtf" && request.method === "GET") {
        return handleMarketMtfResponse(url, env, request);
      }
      if (url.pathname === "/live-price" && request.method === "GET") {
        return handleLivePriceResponse(url, env, request);
      }
      if (url.pathname === "/bot") {
        return jsonResponse(await handleBot(request, env, ctx), request);
      }
      if (url.pathname === "/history-log") {
        return jsonResponse(await handleHistoryLog(request, env), request);
      }
      if (url.pathname === "/ai-decision" && request.method === "POST") {
        return jsonResponse(await handleAiDecision(request, env), request);
      }
      if (url.pathname === "/learning-context" && request.method === "GET") {
        return jsonResponse(await loadLearningContext(env), request);
      }
      if (url.pathname === "/learning-feedback" && request.method === "POST") {
        return jsonResponse(await handleLearningFeedback(request, env), request);
      }
      if (url.pathname === "/auto-learn" && request.method === "POST") {
        return jsonResponse(await handleAutoLearn(request, env), request);
      }
      if (url.pathname === "/settings") {
        return jsonResponse(await handleSettings(request, env), request);
      }
      if (url.pathname === "/oanda/account" && request.method === "GET") {
        return jsonResponse(await loadAccountSummary(env), request);
      }
      if (url.pathname === "/oanda/history" && request.method === "GET") {
        return jsonResponse(await loadClosedTrades(env), request);
      }
      return jsonResponse({ message: "Not found." }, request, 404);
    } catch (error) {
      return jsonResponse({ message: error?.message || "Worker request failed." }, request, 502);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBotTick(env, { source: "cron", executeTrades: true }).catch(console.error));
  }
};

async function handleMarketMtfResponse(url, env, request) {
  const symbol = normalizeInstrument(url.searchParams.get("symbol") || DEFAULT_INSTRUMENT);
  const entryTf = String(url.searchParams.get("entryTf") || "15min");
  const outputsize = clampInt(url.searchParams.get("outputsize"), 1000, 30, 2500);
  const payload = await fetchMtfPayload(env, { instrument: symbol, entryTf, outputsize });
  const cacheStatus = payload.cache_status || "MISS";
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Cache": cacheStatus,
      ...corsHeaders(request),
    },
  });
}

async function handleLivePriceResponse(url, env, request) {
  const symbol = normalizeInstrument(url.searchParams.get("symbol") || DEFAULT_INSTRUMENT);
  try {
    const price = await fetchPrice(env, { instrument: symbol });
    return jsonResponse({ price: price?.mid || null, time: price?.time || null }, request);
  } catch (error) {
    return jsonResponse({ message: error?.message || "Failed to fetch live price from OANDA." }, request, 502);
  }
}

async function handleBot(request, env, ctx) {
  if (request.method === "GET") {
    return getBotStatus(env);
  }

  if (request.method !== "POST") {
    throw new Error("Method not allowed.");
  }

  assertAdmin(request, env);
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || "").toLowerCase();
  if (action === "start") {
    const status = await updateBotSettings(env, { botEnabled: true });
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(runBotTick(env, { source: "manual-start-trigger", executeTrades: true }).catch(console.error));
    }
    return { ok: true, action: "start", status };
  }
  if (action === "stop") {
    const status = await updateBotSettings(env, { botEnabled: false });
    return { ok: true, action: "stop", status };
  }
  if (action === "tick") {
    const result = await runBotTick(env, { source: "manual-ui", executeTrades: false });
    return { ok: true, action: "tick", result };
  }
  if (action === "run-live-tick") {
    const result = await runBotTick(env, { source: "manual-trigger", executeTrades: true });
    return { ok: true, action: "run-live-tick", result };
  }
  if (action === "save-config") {
    const patch = sanitizeBotPatch(body.config || {});
    const status = await updateBotSettings(env, patch);
    return { ok: true, action: "save-config", status };
  }
  throw new Error("Unsupported bot action.");
}

async function handleHistoryLog(request, env) {
  await autoResolvePendingHistory(env).catch(console.error);

  if (request.method === "GET") {
    const limit = clampInt(new URL(request.url).searchParams.get("limit"), 100, 1, 200);
    const entries = await loadHistoryEntries(env);
    return { entries: entries.slice(0, limit) };
  }
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const entry = body?.entry && typeof body.entry === "object" ? body.entry : null;
    if (!entry) throw new Error("Missing history entry.");
    const source = String(body?.source || "manual");
    const saved = await appendHistoryEntry(env, {
      ...entry,
      source,
      syncId: String(entry.syncId || entry.id || `${Date.now()}`),
      timestampIso: String(entry.timestampIso || entry.timestamp || new Date().toISOString()),
      createdAt: Number(entry.createdAt || Date.now()),
    });
    await autoResolvePendingHistory(env).catch(console.error);
    return { ok: true, entry: saved };
  }
  throw new Error("Method not allowed.");
}

async function handleSettings(request, env) {
  const url = new URL(request.url);
  const action = String(url.searchParams.get("action") || "");
  const settings = await loadSettings(env);
  const supplied = String(request.headers.get("x-admin-password") || "");
  const adminPassword = String(env.ADMIN_PASSWORD || "Aviraj@api7").trim();
  const isAdmin = supplied === adminPassword;

  if (request.method === "GET") {
    if (action === "metrics") {
      return { metrics: computeMetrics(await loadHistoryEntries(env)) };
    }
    if (isAdmin) {
      if (!String(settings.oandaApiToken || "").trim() && env.OANDA_API_TOKEN) {
        settings.oandaApiToken = env.OANDA_API_TOKEN;
      }
      if (!String(settings.oandaAccountId || "").trim() && env.OANDA_ACCOUNT_ID) {
        settings.oandaAccountId = env.OANDA_ACCOUNT_ID;
      }
    }
    return { settings: isAdmin ? settings : sanitizePublicSettings(settings), isAdmin };
  }

  if (request.method !== "POST") {
    throw new Error("Method not allowed.");
  }

  assertAdmin(request, env);
  const body = await request.json().catch(() => ({}));
  if (action === "fetch-nvidia") {
    return handleFetchNvidia(body);
  }
  const next = { ...settings, ...body };
  await saveSettings(env, next);
  return { ok: true };
}

function resolveBestModelReplacement(modelId, availableModels) {
  const list = Array.isArray(availableModels) ? availableModels : [];
  if (list.length === 0) return modelId;

  const id = String(modelId || "").toLowerCase().trim();
  const exactMatch = list.find((m) => String(m.id || "").toLowerCase().trim() === id);
  if (exactMatch) return exactMatch.id;

  const isLlama = id.includes("llama");
  const isGemma = id.includes("gemma");
  const isMistral = id.includes("mistral");
  const is70B = id.includes("70b");
  const is8B = id.includes("8b");

  let match = list.find((m) => {
    const mId = String(m.id || "").toLowerCase();
    if (isLlama && !mId.includes("llama")) return false;
    if (isGemma && !mId.includes("gemma")) return false;
    if (isMistral && !mId.includes("mistral")) return false;
    if (is70B && !mId.includes("70b")) return false;
    if (is8B && !mId.includes("8b")) return false;
    return true;
  });
  if (match) return match.id;

  match = list.find((m) => {
    const mId = String(m.id || "").toLowerCase();
    if (isLlama && mId.includes("llama")) return true;
    if (isGemma && mId.includes("gemma")) return true;
    if (isMistral && mId.includes("mistral")) return true;
    return false;
  });
  if (match) return match.id;

  const preferred = [
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.3-70b-instruct",
    "openai/gpt-oss-20b",
    "mistralai/mistral-7b-instruct-v0.3",
  ];
  const smoke = preferred.map((prefId) => list.find((m) => m.id === prefId)).find(Boolean) ||
    list.find((m) => /(?:instruct|chat|gpt-oss)/i.test(m.id));
  if (smoke) return smoke.id;

  return list[0].id;
}

async function handleAiDecision(request, env) {
  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    return { message: "Missing AI prompt." };
  }

  const settings = await loadSettings(env);
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2;

  // --- Load learning memory and append to prompt ---
  const learningContext = await loadLearningContext(env);
  const learningMemoryUsed = Number(learningContext.total || 0) > 0;
  const promptWithLearning = appendLearningContext(prompt, learningContext);

  // --- Collect all available API keys (deduplicated, ordered by priority) ---
  const candidateKeys = [];
  const addKey = (k) => { const s = String(k || "").trim(); if (s && !candidateKeys.includes(s)) candidateKeys.push(s); };

  const bodyModels = Array.isArray(body.models) ? body.models : [];
  const bodyDebateModels = Array.isArray(body.debateModels) ? body.debateModels : [];
  const selectedKey = String(body.selectedModelKey || "");
  const selectedModel = bodyModels.find((m) => m.key === selectedKey) || bodyModels[0];
  if (selectedModel?.apiKey) addKey(selectedModel.apiKey);
  bodyModels.forEach((m) => addKey(m?.apiKey));
  bodyDebateModels.forEach((m) => addKey(m?.apiKey));
  addKey(body.apiKey);
  addKey(settings.globalNvidiaApiKey);
  if (Array.isArray(settings.globalNvidiaApiKeys)) {
    settings.globalNvidiaApiKeys.forEach((k) => addKey(k));
  }
  addKey(env.NVIDIA_API_KEY);

  // --- Normalize model pools ---
  const globalNvidiaKeys = normalizeNvidiaKeyPool(settings.globalNvidiaApiKeys, settings.globalNvidiaApiKey);
  let summaryModels = normalizeModels(settings.nvidiaModels, bodyModels, globalNvidiaKeys, 0);
  let debateModelPool = normalizeModels(settings.debateModels, bodyDebateModels, globalNvidiaKeys, summaryModels.length);
  ({ summaryModels, debateModels: debateModelPool } = rebalanceModelPools(summaryModels, debateModelPool));

  const fallbackModelConfig = normalizeOneModel({
    key: selectedKey,
    label: String(body.label || ""),
    id: String(body.model || ""),
    apiKey: String(body.apiKey || ""),
    baseUrl: String(body.baseUrl || DEFAULT_BASE_URL),
  }, globalNvidiaKeys, 0);

  if (!candidateKeys.length) {
    return {
      ...createTextPayload(buildServerFallbackSummary(promptWithLearning, { reason: "No configured AI model or API key. Save your NVIDIA API key in Admin Settings." }), "server-fallback"),
      debateUsed: false, debateAttempted: 0, debateSuccessful: 0, debateWorking: 0,
      learningMemoryUsed, fallbackUsed: true,
      fallbackReason: "No API keys configured.",
    };
  }

  // --- Resolve working NVIDIA access ---
  const baseUrl = String(fallbackModelConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const access = await resolveWorkingNvidiaAccess(candidateKeys, baseUrl);
  if (!access.ok) {
    return {
      ...createTextPayload(buildServerFallbackSummary(promptWithLearning, { reason: access.message }), fallbackModelConfig.id || "server-fallback"),
      debateUsed: false, debateAttempted: 0, debateSuccessful: 0, debateWorking: 0,
      learningMemoryUsed, fallbackUsed: true,
      fallbackReason: sanitizeProviderFailureReason(access.message),
      keysAttempted: candidateKeys.length,
    };
  }

  // Apply working access (key + baseUrl) to all model pools
  summaryModels = applyWorkingAccess(summaryModels, access);
  debateModelPool = applyWorkingAccess(debateModelPool, access);
  if (fallbackModelConfig.id) {
    fallbackModelConfig.apiKey = access.apiKey;
    fallbackModelConfig.baseUrl = access.baseUrl;
  }

  // --- Select Lead Arbiter (summary) model ---
  const selectedSummary =
    summaryModels.find((m) => m.key === selectedKey) ||
    debateModelPool.find((m) => m.key === selectedKey) ||
    summaryModels[0] ||
    debateModelPool[0] ||
    fallbackModelConfig;

  const resolvedModelId = access.modelIds.has(selectedSummary.id)
    ? selectedSummary.id
    : resolveBestModelReplacement(selectedSummary.id, access.models);

  if (!resolvedModelId) {
    return {
      ...createTextPayload(buildServerFallbackSummary(promptWithLearning, { reason: "No NVIDIA chat models are available to this key. Import NVIDIA models again from Settings." }), "server-fallback"),
      debateUsed: false, debateAttempted: 0, debateSuccessful: 0, debateWorking: 0,
      learningMemoryUsed, fallbackUsed: true,
      fallbackReason: "No available NVIDIA models.",
      keysAttempted: candidateKeys.length,
    };
  }

  selectedSummary.id = resolvedModelId;

  // --- Build Debate Pool ---
  const debatePool = buildDebatePool(debateModelPool, selectedSummary, access);

  // --- No debate models: direct Lead Arbiter call ---
  if (!debatePool.length) {
    const direct = await requestAiModel({
      modelConfig: selectedSummary,
      prompt: promptWithLearning,
      temperature,
      systemPrompt: buildSummarySystemPrompt(),
      maxTokens: DEFAULT_SUMMARY_MAX_TOKENS,
    }, { timeoutMs: SUMMARY_MAX_WAIT_MS });

    if (!direct.ok) {
      const reason = direct.message || "Summary model unavailable.";
      return {
        ...createTextPayload(buildServerFallbackSummary(promptWithLearning, { reason }), selectedSummary.id),
        debateUsed: false, debateAttempted: 0, debateSuccessful: 0, debateWorking: 0,
        learningMemoryUsed, fallbackUsed: true,
        fallbackReason: sanitizeProviderFailureReason(reason),
        keysAttempted: candidateKeys.length,
      };
    }

    direct.payload = enforceDirectionalOutput(direct.payload, promptWithLearning);
    return {
      ...normalizeAiPayload(direct.payload, promptWithLearning),
      debateUsed: false, debateAttempted: 0, debateSuccessful: 0, debateWorking: 0,
      debateConsensus: { buy: 0, sell: 0, wait: 0 },
      learningMemoryUsed, fallbackUsed: false,
      requestedModel: selectedSummary.label || selectedSummary.id,
      finalModel: selectedSummary.id,
    };
  }

  // --- Run Debate Models in Parallel (staggered) ---
  const debateResults = await Promise.all(
    debatePool.map(async (entry, index) => {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, index * 500));
      }
      return requestAiModel({
        modelConfig: entry.modelConfig,
        prompt: buildDebateUserPrompt(promptWithLearning, entry.bias),
        temperature,
        systemPrompt: buildDebateSystemPrompt(),
        maxTokens: DEFAULT_DEBATE_MAX_TOKENS,
      }, { timeoutMs: DEBATE_MAX_WAIT_MS });
    })
  );

  const successfulDebates = debateResults
    .map((result, index) => ({ result, model: debatePool[index] }))
    .filter((item) => item.result.ok && extractAiText(item.result.payload));

  const debateConsensus = calculateDebateConsensus(successfulDebates);

  // --- All debates failed: fallback to direct Arbiter ---
  if (!successfulDebates.length) {
    const directSummary = await requestAiModel({
      modelConfig: selectedSummary,
      prompt: promptWithLearning,
      temperature,
      systemPrompt: buildSummarySystemPrompt(),
      maxTokens: DEFAULT_SUMMARY_MAX_TOKENS,
    }, { timeoutMs: SUMMARY_MAX_WAIT_MS });

    if (directSummary.ok) {
      directSummary.payload = enforceDirectionalOutput(directSummary.payload, promptWithLearning);
      return {
        ...normalizeAiPayload(directSummary.payload, promptWithLearning),
        debateUsed: false, debateAttempted: debatePool.length, debateSuccessful: 0, debateWorking: 0,
        debateConsensus, learningMemoryUsed,
        fallbackUsed: true, fallbackReason: "Debate models timed out or failed; used direct summary.",
        requestedModel: selectedSummary.label || selectedSummary.id,
        finalModel: selectedSummary.id,
      };
    }

    const failReason = debateResults.map((r) => r.message).filter(Boolean).join(" | ") || directSummary.message || "All models timed out.";
    return {
      ...createTextPayload(buildServerFallbackSummary(promptWithLearning, { reason: failReason }), selectedSummary.id),
      debateUsed: false, debateAttempted: debatePool.length, debateSuccessful: 0, debateWorking: 0,
      debateConsensus, learningMemoryUsed,
      fallbackUsed: true, fallbackReason: "All debate and summary models failed; server-generated summary used.",
      requestedModel: selectedSummary.label || selectedSummary.id,
      finalModel: selectedSummary.id,
    };
  }

  // --- Build Consolidated Prompt & Call Lead Arbiter ---
  const consolidatedPrompt = buildConsolidatedPrompt(promptWithLearning, successfulDebates);
  const summaryResponse = await requestAiModel({
    modelConfig: selectedSummary,
    prompt: consolidatedPrompt,
    temperature,
    systemPrompt: buildSummarySystemPrompt(),
    maxTokens: DEFAULT_SUMMARY_MAX_TOKENS,
  }, { timeoutMs: SUMMARY_MAX_WAIT_MS });

  if (!summaryResponse.ok) {
    const reason = summaryResponse.message || "Lead Arbiter model unavailable.";
    return {
      ...createTextPayload(buildServerFallbackSummary(consolidatedPrompt, { reason }), selectedSummary.id),
      debateUsed: true, debateAttempted: debatePool.length, debateSuccessful: successfulDebates.length, debateWorking: successfulDebates.length,
      debateConsensus, learningMemoryUsed,
      fallbackUsed: true, fallbackReason: sanitizeProviderFailureReason(reason),
      requestedModel: selectedSummary.label || selectedSummary.id,
      finalModel: selectedSummary.id,
      debateResponses: successfulDebates.map(d => ({
        modelLabel: d.model.modelConfig.label,
        modelId: d.model.modelConfig.id,
        bias: d.model.bias,
        output: extractAiText(d.result.payload)
      }))
    };
  }

  // --- Success: Return Full Debate Result ---
  summaryResponse.payload = enforceDirectionalOutput(summaryResponse.payload, consolidatedPrompt);
  return {
    ...normalizeAiPayload(summaryResponse.payload, consolidatedPrompt),
    debateUsed: true,
    debateAttempted: debatePool.length,
    debateSuccessful: successfulDebates.length,
    debateWorking: successfulDebates.length,
    debateConsensus,
    learningMemoryUsed,
    fallbackUsed: false,
    requestedModel: selectedSummary.label || selectedSummary.id,
    finalModel: selectedSummary.id,
    debateResponses: successfulDebates.map(d => ({
      modelLabel: d.model.modelConfig.label,
      modelId: d.model.modelConfig.id,
      bias: d.model.bias,
      output: extractAiText(d.result.payload)
    }))
  };
}

async function resolveWorkingNvidiaAccess(candidateKeys, baseUrl) {
  const cleanBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const errors = [];
  for (const apiKey of candidateKeys.slice(0, 5)) {
    try {
      const response = await fetch(`${cleanBase}/models`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        const models = Array.isArray(payload?.data)
          ? payload.data
              .map((item) => ({ id: String(item?.id || "").trim(), label: String(item?.id || "").trim() }))
              .filter((item) => item.id)
          : [];
        const validationModel = pickNvidiaSmokeTestModel(models);
        if (!validationModel) {
          errors.push("NVIDIA returned a model catalog, but no chat-capable validation model was found.");
          continue;
        }
        const smoke = await validateNvidiaChatAccess({
          apiKey,
          baseUrl: cleanBase,
          modelId: validationModel.id,
        });
        if (!smoke.ok) {
          errors.push(smoke.message || `NVIDIA chat validation failed for ${validationModel.id}.`);
          continue;
        }
        return {
          ok: true,
          apiKey,
          baseUrl: cleanBase,
          models,
          modelIds: new Set(models.map((item) => item.id)),
        };
      }
      errors.push(payload?.error?.message || payload?.message || `NVIDIA models HTTP ${response.status}`);
    } catch (error) {
      errors.push(error?.message || "Unable to reach NVIDIA model catalog.");
    }
  }
  return { ok: false, message: errors.filter(Boolean).join(" | ") || "All NVIDIA keys failed model-catalog validation." };
}

function pickNvidiaSmokeTestModel(models) {
  const list = Array.isArray(models) ? models : [];
  const preferred = [
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.3-70b-instruct",
    "openai/gpt-oss-20b",
    "mistralai/mistral-7b-instruct-v0.3",
  ];
  return preferred.map((id) => list.find((model) => model.id === id)).find(Boolean) ||
    list.find((model) => /(?:instruct|chat|gpt-oss)/i.test(model.id));
}

async function validateNvidiaChatAccess({ apiKey, baseUrl, modelId, signal }) {
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), 12000) : null;
  try {
    const response = await fetch(`${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        max_tokens: 4,
        stream: false,
        messages: [
          { role: "user", content: "Reply OK." },
        ],
      }),
      signal: signal || controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        message: payload?.error?.message || payload?.message || `NVIDIA chat validation HTTP ${response.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, statusCode: 504, message: `NVIDIA chat validation timed out for ${modelId}.` };
    }
    return { ok: false, statusCode: 502, message: error?.cause?.code ? `${error.message} (${error.cause.code})` : error?.message };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeAiPayload(payload, prompt) {
  const text = extractAiText(payload);
  if (!text) return payload;
  try {
    JSON.parse(stripJsonFence(text));
    return payload;
  } catch {
    return setAiText(payload, JSON.stringify(buildStructuredSummaryFromText(text, prompt), null, 2));
  }
}

async function getBotStatus(env) {
  const settings = await loadSettings(env);
  const runtime = await loadRuntime(env);
  const [price, openTrades, accountSummary, closedTrades, history] = await Promise.all([
    fetchPrice(env, { instrument: settings.botInstrument || DEFAULT_INSTRUMENT }).catch(() => null),
    listOpenTrades(env, { instrument: settings.botInstrument || DEFAULT_INSTRUMENT }).catch(() => []),
    loadAccountSummary(env).catch(() => null),
    loadClosedTrades(env).catch(() => ({ trades: [] })),
    loadHistoryEntries(env),
  ]);

  return {
    configured: Boolean(env.OANDA_API_TOKEN),
    environment: normalizeEnvironment(settings.oandaEnvironment || env.OANDA_ENVIRONMENT || "practice"),
    instrument: normalizeInstrument(settings.botInstrument || env.OANDA_INSTRUMENT || DEFAULT_INSTRUMENT),
    botEnabled: Boolean(settings.botEnabled),
    botMode: normalizeBotMode(settings.botMode),
    units: clampInt(settings.botUnits, 10, 1, 1000000),
    stopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    takeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    cooldownMinutes: clampInt(settings.botCooldownMinutes, 15, 1, 1440),
    pollIntervalSeconds: clampInt(settings.botPollIntervalSeconds, 60, 15, 3600),
    latestPrice: price?.mid || runtime?.lastPrice || null,
    latestPriceTime: price?.time || runtime?.lastPriceTime || "",
    openTradesCount: Array.isArray(openTrades) ? openTrades.length : 0,
    openTrades,
    accountSummary: accountSummary?.account || null,
    recentClosedTrades: Array.isArray(closedTrades?.trades) ? closedTrades.trades.slice(0, 12) : [],
    recentHistory: history.slice(0, 20),
    runtime,
  };
}

async function runBotTick(env, options = {}) {
  const settings = await loadSettings(env);
  const runtime = await loadRuntime(env);
  const executeTrades = Boolean(options.executeTrades);
  const instrument = normalizeInstrument(settings.botInstrument || env.OANDA_INSTRUMENT || DEFAULT_INSTRUMENT);
  const botConfig = {
    instrument,
    botEnabled: Boolean(settings.botEnabled),
    botMode: normalizeBotMode(settings.botMode),
    units: clampInt(settings.botUnits, 10, 1, 1000000),
    stopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    takeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    cooldownMinutes: clampInt(settings.botCooldownMinutes, 15, 1, 1440),
  };

  const [mtfData, latestPrice, openTrades] = await Promise.all([
    fetchMtfPayload(env, { instrument, entryTf: "15min", outputsize: 1000 }),
    fetchPrice(env, { instrument }),
    listOpenTrades(env, { instrument }).catch(() => []),
  ]);

  const analysis = analyzeMtfData(mtfData, latestPrice);
  applyBotRiskProfile(analysis, botConfig);
  const windowCheck = checkTradingWindow();

  let action = "analysis-generated";
  let reason = "Analysis complete.";

  if (!botConfig.botEnabled) {
    action = "skipped";
    reason = "Bot is stopped.";
  } else if (!windowCheck.allowed) {
    action = "blocked";
    reason = windowCheck.reason;
  }

  // Generate Alert if any liquidity sweeps were detected OR a perfect signal is present
  const isPerfectSignal = (analysis.decision.score >= 3 && analysis.trend === "bullish") || (analysis.decision.score <= -2 && analysis.trend === "bearish");
  if (action !== "skipped" && action !== "blocked") {
    if (Array.isArray(analysis.sweeps) && analysis.sweeps.length > 0) {
      reason = `CRT Event: ${analysis.sweeps.map(s => `${s.name} (${s.condition})`).join(", ")}`;
      action = "alert-sweep";
    } else if (isPerfectSignal) {
      reason = `PERFECT SIGNAL: ${analysis.decision.action} Confluence fully aligned!`;
      action = "alert-sweep";
    }
  }

  const nextRuntime = {
    lastTickAt: Date.now(),
    lastSource: String(options.source || "manual"),
    lastPrice: latestPrice?.mid || analysis.price,
    lastPriceTime: latestPrice?.time || "",
    lastDecision: analysis.decision.action,
    lastConfidence: analysis.decision.confidence,
    lastReason: reason,
    lastAction: action,
    lastAnalysis: {
      trend: analysis.trend,
      summary: analysis.decision.tradePlan,
      tp1: analysis.decision.tp1,
      tp2: analysis.decision.tp2,
      stopPrice: analysis.decision.stopPrice,
    },
    openTradesCount: Array.isArray(openTrades) ? openTrades.length : 0,
    lastExecutedAt: action === "alert-sweep" ? Date.now() : runtime?.lastExecutedAt || null,
    lastOrderId: "",
  };

  await saveRuntime(env, nextRuntime);
  await appendHistoryEntry(env, {
    id: `bot-${Date.now()}`,
    title: `Bot Tick ${new Date().toLocaleTimeString("en-US", { hour12: false })}`,
    timestampIso: new Date().toISOString(),
    timeframe: "15min",
    price: String(analysis.price),
    summary: analysis.decision.tradePlan,
    executionOverview: [
      `Direction: ${analysis.decision.action}`,
      `Confidence: ${analysis.decision.confidence}%`,
      `Stop: ${analysis.decision.stopPrice}`,
      `Target: ${analysis.decision.tp2}`,
    ],
    aiOverlay: reason,
    botAction: action,
    syncId: `bot-${Date.now()}`,
    createdAt: Date.now(),
    bias: analysis.decision.action,
    tp1: Number(analysis.decision.tp1 || 0),
    tp2: Number(analysis.decision.tp2 || 0),
    sl: Number(analysis.decision.stopPrice || 0),
    outcome: "pending",
  });

  await autoResolvePendingHistory(env).catch(console.error);

  return {
    ok: true,
    analysis,
    latestPrice,
    action,
    reason,
    orderResponse,
    status: await getBotStatus(env),
  };
}

async function loadAccountSummary(env) {
  const config = await getOandaConfig(env);
  return oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/summary`);
}

async function loadClosedTrades(env) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument((await loadSettings(env)).botInstrument || config.instrument);
  return oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/trades`, {
    query: {
      state: "CLOSED",
      instrument,
      count: 20,
    },
  });
}

async function fetchMtfPayload(env, options = {}) {
  const instrument = normalizeInstrument(options.instrument || DEFAULT_INSTRUMENT);
  const entryTf = String(options.entryTf || "15min");
  
  // BUG FIX: Increase default saved candles to 1,000 (clamped up to 2,500)
  const outputsize = clampInt(options.outputsize, 1000, 30, 2500);

  // Fetch all timeframes in parallel using the KV edge cache (now storing 1,000 candles!)
  const [m5Payload, m15Payload, h1Payload, h4Payload, dailyPayload, weeklyPayload, monthlyPayload] = await Promise.all([
    fetchCandlesWithCache(env, { instrument, timeframe: "5min", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "15min", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "1h", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "4h", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "1day", count: outputsize }),
    // Weekly and Monthly are naturally shorter timeframes, so we clamp them safely:
    fetchCandlesWithCache(env, { instrument, timeframe: "1week", count: Math.min(outputsize, 1000) }),
    fetchCandlesWithCache(env, { instrument, timeframe: "1month", count: Math.min(outputsize, 500) }),
  ]);

  // Determine aggregate cache status for the X-Cache header
  const allPayloads = [m5Payload, m15Payload, h1Payload, h4Payload, dailyPayload, weeklyPayload, monthlyPayload];
  const allFromCache = allPayloads.every(p => p.source === "KV_CACHE");
  const noneFromCache = allPayloads.every(p => p.source === "OANDA_LIVE");
  const cacheStatus = allFromCache ? "HIT" : noneFromCache ? "MISS" : "PARTIAL_MISS";

  return {
    status: "ok",
    provider: "oanda",
    cache_status: cacheStatus,
    data: [
      { id: "5min", values: m5Payload.candles, symbolUsed: instrument },
      { id: "15min", values: m15Payload.candles, symbolUsed: instrument },
      { id: "entry", values: entryTf === "15min" ? m15Payload.candles : m5Payload.candles, symbolUsed: instrument },
      { id: "h1", values: h1Payload.candles, symbolUsed: instrument },
      { id: "4h", values: h4Payload.candles, symbolUsed: instrument },
      { id: "1day", values: dailyPayload.candles, symbolUsed: instrument },
      { id: "1week", values: weeklyPayload.candles, symbolUsed: instrument },
      { id: "1month", values: monthlyPayload.candles, symbolUsed: instrument },
      { id: "benchmark", values: dailyPayload.candles, symbolUsed: instrument },
      { id: "alpha_vantage", data: null, symbolUsed: "" },
    ],
  };
}

async function fetchPrice(env, options = {}) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  
  // Try OANDA
  try {
    const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/pricing`, {
      query: { instruments: instrument },
    });
    const price = Array.isArray(payload?.prices) ? payload.prices[0] : null;
    if (price) {
      const midVal = midpoint(price);
      if (Number.isFinite(midVal)) {
        const result = {
          instrument,
          time: String(price?.time || new Date().toISOString()),
          bid: normalizeNumber(price?.closeoutBid || price?.bids?.[0]?.price, midVal),
          ask: normalizeNumber(price?.closeoutAsk || price?.asks?.[0]?.price, midVal),
          mid: midVal,
          status: String(price?.status || "tradeable"),
          source: "oanda"
        };
        // Cache it asynchronously in KV
        if (env.CANDLE_CACHE) {
          await env.CANDLE_CACHE.put("last_price_" + instrument, JSON.stringify(result)).catch(() => {});
        }
        return result;
      }
    }
  } catch (error) {
    console.warn("OANDA live price fetch failed, trying Twelve Data fallback:", error.message);
  }

  // Try Twelve Data
  const settings = await loadSettings(env);
  const twelveKeys = Array.isArray(settings?.twelveDataKeys) ? settings.twelveDataKeys : [];
  const keys = [...twelveKeys, "23c57edf48e541e48db2806575f58bf7"].filter(Boolean);
  if (keys.length > 0) {
    const sym = instrument.replace("_", "/");
    const key = keys[Math.floor(Math.random() * keys.length)];
    try {
      const response = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.price) {
        const p = Number(data.price);
        const result = {
          instrument,
          time: new Date().toISOString(),
          bid: p,
          ask: p,
          mid: p,
          status: "tradeable",
          source: "twelvedata"
        };
        // Cache it in KV
        if (env.CANDLE_CACHE) {
          await env.CANDLE_CACHE.put("last_price_" + instrument, JSON.stringify(result)).catch(() => {});
        }
        return result;
      }
    } catch (twelveErr) {
      console.error("Twelve Data fallback failed:", twelveErr.message);
    }
  }

  // Final Try: Retrieve last successfully cached price from Cloudflare KV
  if (env.CANDLE_CACHE) {
    try {
      const cached = await env.CANDLE_CACHE.get("last_price_" + instrument);
      if (cached) {
        const result = JSON.parse(cached);
        result.source = (result.source || "unknown") + "-cached";
        console.log(`Returning cached live price for ${instrument} from KV:`, result.mid);
        return result;
      }
    } catch (cacheErr) {
      console.error("Failed to load cached price:", cacheErr.message);
    }
  }

  throw new Error("Failed to fetch live price from OANDA, Twelve Data, and cache.");
}

async function fetchCandles(env, options = {}) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const granularity = GRANULARITY_MAP[String(options.timeframe || "15min")] || "M15";
  const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/instruments/${encodeURIComponent(instrument)}/candles`, {
    query: {
      price: "M",
      granularity,
      count: clampInt(options.count, 200, 30, 5000),
    },
  });
  return (Array.isArray(payload?.candles) ? payload.candles : [])
    .filter((row) => row?.mid)
    .map((row) => ({
      datetime: String(row.time || ""),
      open: normalizeNumber(row.mid?.o, 0),
      high: normalizeNumber(row.mid?.h, 0),
      low: normalizeNumber(row.mid?.l, 0),
      close: normalizeNumber(row.mid?.c, 0),
      volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
      complete: row.complete === true || row.complete === "true" || row.complete === undefined,
    }));
}

async function listOpenTrades(env, options = {}) {
  const config = await getOandaConfig(env);
  const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/openTrades`);
  const trades = Array.isArray(payload?.trades) ? payload.trades : [];
  const instrument = normalizeInstrument(options.instrument || "");
  return instrument ? trades.filter((row) => String(row.instrument || "") === instrument) : trades;
}

async function createMarketOrder(env, options = {}) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const units = clampInt(options.units, 0, -1000000000, 1000000000);
  return oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/orders`, {
    method: "POST",
    body: {
      order: {
        units: String(units),
        instrument,
        timeInForce: "FOK",
        type: "MARKET",
        positionFill: "DEFAULT",
        stopLossOnFill: { price: formatPrice(options.stopLoss) },
        takeProfitOnFill: { price: formatPrice(options.takeProfit) },
      },
    },
  });
}

async function getOandaConfig(env) {
  const settings = await loadSettings(env);
  const environment = normalizeEnvironment(settings.oandaEnvironment || env.OANDA_ENVIRONMENT || "practice");
  const token = String(settings.oandaApiToken || env.OANDA_API_TOKEN || "").trim();
  let accountId = String(settings.oandaAccountId || env.OANDA_ACCOUNT_ID || "").trim();
  if (!accountId && token) {
    try {
      accountId = await discoverAccountId(token, environment);
    } catch (e) {
      console.warn("Could not auto-discover OANDA account ID:", e.message);
    }
  }
  return {
    token,
    accountId,
    instrument: normalizeInstrument(settings.botInstrument || env.OANDA_INSTRUMENT || DEFAULT_INSTRUMENT),
    baseUrl: environment === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com",
    environment,
  };
}

async function discoverAccountId(token, environment) {
  if (!token) throw new Error("OANDA_API_TOKEN is not configured.");
  const baseUrl = environment === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const response = await fetch(`${baseUrl}/v3/accounts`, {
    method: "GET",
    headers: oandaHeaders(token),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.errorMessage || `OANDA accounts lookup failed (${response.status}).`);
  }
  return String(payload?.accounts?.[0]?.id || "").trim();
}

async function oandaRequest(config, path, options = {}) {
  if (!config.token) throw new Error("OANDA token is not configured.");
  if (!config.accountId) throw new Error("OANDA account ID is unavailable.");
  const url = new URL(`${config.baseUrl}${path}`);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    method: String(options.method || "GET").toUpperCase(),
    headers: {
      ...oandaHeaders(config.token),
      ...(options.method ? { "Content-Type": "application/json" } : {}),
    },
    body: options.method ? JSON.stringify(options.body || {}) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.errorMessage || payload?.message || `OANDA HTTP ${response.status}`);
  }
  return payload;
}

function oandaHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function loadSettings(env) {
  return (await kvGetJson(env, "settings", {})) || {};
}

async function saveSettings(env, settings) {
  await env.AURUM_KV.put("settings", JSON.stringify(settings));
}

async function updateBotSettings(env, patch) {
  const current = await loadSettings(env);
  const next = { ...current, ...patch };
  await saveSettings(env, next);
  return getBotStatus(env);
}

async function loadRuntime(env) {
  return (await kvGetJson(env, "runtime", {})) || {};
}

async function saveRuntime(env, runtime) {
  await env.AURUM_KV.put("runtime", JSON.stringify(runtime));
}

async function loadHistoryEntries(env) {
  const data = await kvGetJson(env, "history", []);
  return Array.isArray(data) ? data : [];
}

async function appendHistoryEntry(env, entry) {
  const current = await loadHistoryEntries(env);
  const next = [
    {
      ...entry,
      id: String(entry.id || entry.syncId || Date.now()),
    },
    ...current,
  ]
    .slice(0, HISTORY_LIMIT)
    .sort((left, right) => {
      const leftTs = Date.parse(String(left.timestampIso || "")) || Number(left.createdAt || 0);
      const rightTs = Date.parse(String(right.timestampIso || "")) || Number(right.createdAt || 0);
      return rightTs - leftTs;
    });
  await env.AURUM_KV.put("history", JSON.stringify(next));
  return next[0];
}

async function kvGetJson(env, key, fallback) {
  const raw = await env.AURUM_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function analyzeMtfData(mtfData, latestPrice) {
  const entry = normalizeCandles(mtfData?.data?.find((item) => item.id === "entry")?.values || []);
  const benchmark = normalizeCandles(mtfData?.data?.find((item) => item.id === "benchmark")?.values || []);
  if (entry.length < 30) throw new Error("Not enough entry candles to drive the bot.");
  const closes = entry.map((row) => row.close);
  const ema21 = exponentialMovingAverage(closes, 21).at(-1);
  const ema50 = exponentialMovingAverage(closes, 50).at(-1);
  const latestClose = entry.at(-1).close;
  let trend = "neutral";
  if (ema21 >= ema50) {
    trend = latestClose >= ema50 ? "bullish" : "bearish";
  } else {
    trend = latestClose <= ema50 ? "bearish" : "bullish";
  }
  const fvgs = detectFairValueGaps(entry);
  const obs = detectOrderBlocks(entry, fvgs);
  const structureEvents = detectStructureEvents(entry);
  const price = Number.isFinite(Number(latestPrice?.mid)) ? Number(latestPrice.mid) : entry.at(-1).close;
  const rmiValue = calculateRmi(entry);
  const rmiBias = rmiValue >= 100 ? "bullish" : "bearish";
  const htfAlignment = (Array.isArray(mtfData?.data) ? mtfData.data : [])
    .filter((row) => ["h1", "1day", "1week", "1month"].includes(row.id))
    .map((row) => {
      const values = normalizeCandles(row.values || []);
      if (values.length < 2) return `${row.id.toUpperCase()} unavailable`;
      const oldest = values[0].close;
      const latest = values.at(-1).close;
      return `${row.id.toUpperCase()} ${latest >= oldest ? "bullish" : "bearish"}`;
    });
  const sweeps = detectLiquiditySweeps(mtfData);
  const score = [
    trend === "bullish" ? 1 : -1,
    rmiBias === "bullish" ? 1 : -1,
    htfAlignment.filter((row) => row.includes(trend)).length > 1 ? 1 : 0,
    fvgs.length > 0 ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
  return {
    price,
    trend,
    fvgs,
    obs,
    structureEvents,
    htfAlignment,
    sweeps,
    rmi: { value: rmiValue, bias: rmiBias },
    decision: {
      action: trend === "bullish" ? "Buy" : "Sell",
      confidence: Math.max(55, Math.min(92, 68 + score * 6)),
      score,
      tp1: roundPrice(price + (trend === "bullish" ? 4 : -4)),
      tp2: roundPrice(price + (trend === "bullish" ? 8 : -8)),
      stopPrice: roundPrice(price + (trend === "bullish" ? -3 : 3)),
      tradePlan: [
        `Bot bias: ${trend.toUpperCase()}`,
        `RMI alignment: ${rmiBias.toUpperCase()}`,
        `HTF alignment count: ${htfAlignment.length}`,
        `FVG count: ${fvgs.length}`,
        fvgs.length > 0 ? `FVG MAP:\n${fvgs.map(f => `- ${f.side.toUpperCase()} @ ${f.price} [${f.type}]`).join("\n")}` : "",
        obs.length > 0 ? `OB MAP:\n${obs.map(o => `- ${o.side.toUpperCase()} @ ${o.price} [${o.type} (${o.strength})]`).join("\n")}` : "",
        sweeps.length > 0 ? `CRT EVENTS:\n${sweeps.map(s => `- ${s.name}: ${s.condition} -> ${s.action}`).join("\n")}` : "No recent CRT events (Sweeps/Breakouts)."
      ].filter(Boolean),
    },
  };
}

function applyBotRiskProfile(analysis, botConfig) {
  const side = analysis.decision.action === "Buy" ? 1 : -1;
  const stopDistance = Math.abs(normalizeNumber(botConfig.stopLossOffset, 3));
  const targetDistance = Math.abs(normalizeNumber(botConfig.takeProfitOffset, 6));
  analysis.decision.stopPrice = roundPrice(analysis.price + (side === 1 ? -stopDistance : stopDistance));
  analysis.decision.tp1 = roundPrice(analysis.price + (side === 1 ? targetDistance * 0.67 : targetDistance * -0.67));
  analysis.decision.tp2 = roundPrice(analysis.price + (side === 1 ? targetDistance : targetDistance * -1));
  analysis.decision.tradePlan = [
    ...analysis.decision.tradePlan,
    `Risk profile: SL ${stopDistance.toFixed(1)} / TP ${targetDistance.toFixed(1)}`,
    `Units: ${botConfig.units}`,
  ];
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => ({
      open: normalizeNumber(candle?.open, Number.NaN),
      high: normalizeNumber(candle?.high, Number.NaN),
      low: normalizeNumber(candle?.low, Number.NaN),
      close: normalizeNumber(candle?.close, Number.NaN),
      complete: candle?.complete !== false,
      _ts: new Date(candle?.datetime || 0).getTime(),
    }))
    .filter((row) => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close))
    .sort((left, right) => left._ts - right._ts);
}

function exponentialMovingAverage(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function calculateRmi(candles) {
  if (!candles || candles.length < 30) {
    return 100.00;
  }
  const closes = candles.map((c) => c.close);
  const period = 30;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i += 1) {
    ema = closes[i] * k + ema * (1 - k);
  }
  const rmi = (closes.at(-1) / ema) * 100;
  return Number(rmi.toFixed(2));
}

function detectFairValueGaps(candles) {
  const out = [];
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;
  
  for (let i = 1; i < candles.length - 1; i += 1) {
    const prev = candles[i - 1]; // 1st
    const mid = candles[i];      // 2nd
    const next = candles[i + 1]; // 3rd

    const isGapUp = mid.open > prev.close;
    const isGapDown = mid.open < prev.close;

    // Bullish FVG or Gap Up
    if ((next.low > prev.high && isBull(mid)) || isGapUp) {
      let type = isGapUp ? "Gap Up FVG" : "Standard";
      if (isBull(prev) && isBull(next)) type = isGapUp ? "Gap Up (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
      else if (isBull(prev) && isBear(next)) type = isGapUp ? "Gap Up (Trade Continuation)" : "Trade Continuation";
      else if (isBear(prev) && isBull(next)) type = isGapUp ? "Gap Up (The Sweep)" : "The Sweep (Delayed Trap)";
      else if (isBear(prev) && isBear(next)) type = isGapUp ? "Gap Up (Holy Grail)" : "The Holy Grail (Ultimate Jackpot â­â­â­â­â­)";
      
      const gapPrice = isGapUp ? roundPrice((mid.open + prev.close) / 2) : roundPrice((next.low + prev.high) / 2);
      
      if (!out.some(f => f.side === "bullish" && Math.abs(f.price - gapPrice) < 0.05)) {
        out.push({ side: "bullish", type, price: gapPrice });
      }
    }
    // Bearish FVG or Gap Down
    else if ((next.high < prev.low && isBear(mid)) || isGapDown) {
      let type = isGapDown ? "Gap Down FVG" : "Standard";
      if (isBear(prev) && isBear(next)) type = isGapDown ? "Gap Down (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
      else if (isBear(prev) && isBull(next)) type = isGapDown ? "Gap Down (Trade Continuation)" : "Trade Continuation";
      else if (isBull(prev) && isBear(next)) type = isGapDown ? "Gap Down (The Sweep)" : "The Sweep (Delayed Trap)";
      else if (isBull(prev) && isBull(next)) type = isGapDown ? "Gap Down (Holy Grail)" : "The Holy Grail (Ultimate Jackpot â­â­â­â­â­)";
      
      const gapPrice = isGapDown ? roundPrice((mid.open + prev.close) / 2) : roundPrice((next.high + prev.low) / 2);
      
      if (!out.some(f => f.side === "bearish" && Math.abs(f.price - gapPrice) < 0.05)) {
        out.push({ side: "bearish", type, price: gapPrice });
      }
    }
  }
  return out.slice(-8);
}

function detectOrderBlocks(candles, fvgs) {
  const out = [];
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;

  for (let i = 5; i < candles.length - 1; i += 1) {
    const prev = candles[i - 1];
    const curr = candles[i];
    
    // Bullish OB candidate (Last bearish before bullish)
    if (isBear(prev) && isBull(curr)) {
      const hasFvgAbove = fvgs.some(f => f.side === "bullish" && f.price > prev.high);
      const lookback = candles.slice(Math.max(0, i - 10), i);
      const isExtreme = lookback.every(c => c.low >= prev.low);
      
      let type = "Fake OB (SMT Trap)";
      let strength = "Weakest (90-95% fail)";
      if (hasFvgAbove) {
        if (isExtreme) {
          type = "Extreme OB (Ultimate Jackpot â­â­â­â­â­)";
          strength = "Most Powerful (5-10% fail)";
        } else {
          type = "Decisional OB (Trap / Inducement)";
          strength = "Medium (50-60% fail)";
        }
      }
      out.push({ side: "bullish", type, strength, price: prev.low });
    }
    // Bearish OB candidate (Last bullish before bearish)
    else if (isBull(prev) && isBear(curr)) {
      const hasFvgBelow = fvgs.some(f => f.side === "bearish" && f.price < prev.low);
      const lookback = candles.slice(Math.max(0, i - 10), i);
      const isExtreme = lookback.every(c => c.high <= prev.high);
      
      let type = "Fake OB (SMT Trap)";
      let strength = "Weakest (90-95% fail)";
      if (hasFvgBelow) {
        if (isExtreme) {
          type = "Extreme OB (Ultimate Jackpot â­â­â­â­â­)";
          strength = "Most Powerful (5-10% fail)";
        } else {
          type = "Decisional OB (Trap / Inducement)";
          strength = "Medium (50-60% fail)";
        }
      }
      out.push({ side: "bearish", type, strength, price: prev.high });
    }
  }
  return out.slice(-8);
}

function detectStructureEvents(candles) {
  const out = [];
  for (let i = 2; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    const pivot = candles[i - 2];
    if (current.high > previous.high && previous.high <= pivot.high) out.push(`BOS up through ${roundPrice(previous.high)}`);
    if (current.low < previous.low && previous.low >= pivot.low) out.push(`Liquidity sweep below ${roundPrice(previous.low)}`);
  }
  return out.slice(-6);
}

function midpoint(price) {
  const bid = normalizeNumber(price?.closeoutBid || price?.bids?.[0]?.price, Number.NaN);
  const ask = normalizeNumber(price?.closeoutAsk || price?.asks?.[0]?.price, Number.NaN);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return Number(((bid + ask) / 2).toFixed(3));
  return normalizeNumber(price?.closeoutBid || price?.closeoutAsk || 0, 0);
}

function formatPrice(value) {
  return Number(value || 0).toFixed(Math.abs(Number(value || 0)) >= 100 ? 3 : 5);
}

function roundPrice(value) {
  return Number(Number(value).toFixed(3));
}

function checkTradingWindow() {
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const current = `${String(etNow.getHours()).padStart(2, "0")}:${String(etNow.getMinutes()).padStart(2, "0")}`;
  if (current < "08:00") return { allowed: false, reason: `Pre-session lockout (${current} ET).` };
  if (current >= "16:30") return { allowed: false, reason: `Late-session lockout (${current} ET).` };
  return { allowed: true, reason: `Trading window open (${current} ET).` };
}

function checkCooldown(lastExecutedAt, cooldownMinutes) {
  if (!Number.isFinite(Number(lastExecutedAt))) return { allowed: true, reason: "No prior execution." };
  const remainingMs = Number(lastExecutedAt) + cooldownMinutes * 60 * 1000 - Date.now();
  if (remainingMs > 0) return { allowed: false, reason: `Cooldown active for ${Math.ceil(remainingMs / 60000)} more minute(s).` };
  return { allowed: true, reason: "Cooldown cleared." };
}

function sanitizePublicSettings(settings) {
  return {
    botMode: normalizeBotMode(settings.botMode),
    botEnabled: Boolean(settings.botEnabled),
    botInstrument: normalizeInstrument(settings.botInstrument || DEFAULT_INSTRUMENT),
    oandaEnvironment: normalizeEnvironment(settings.oandaEnvironment || "practice"),
    botUnits: clampInt(settings.botUnits, 10, 1, 1000000),
    botStopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    botTakeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    botCooldownMinutes: clampInt(settings.botCooldownMinutes, 15, 1, 1440),
    botPollIntervalSeconds: clampInt(settings.botPollIntervalSeconds, 60, 15, 3600),
    defaultModelKey: String(settings.defaultModelKey || ""),
    nvidiaModels: Array.isArray(settings.nvidiaModels) ? settings.nvidiaModels.map((item) => ({
      key: String(item.key || ""),
      id: String(item.id || ""),
      label: String(item.label || item.id || ""),
      baseUrl: String(item.baseUrl || DEFAULT_BASE_URL),
    })) : [],
  };
}

function computeMetrics(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let wins = 0;
  let losses = 0;
  list.forEach((row) => {
    const outcome = String(row?.learningOutcome || row?.botAction || "").toLowerCase();
    if (outcome.includes("win")) wins += 1;
    if (outcome.includes("loss")) losses += 1;
  });
  const total = list.length;
  return {
    totalAnalyses: total,
    uniqueDevices: new Set(list.map((row) => String(row?.deviceId || row?.source || ""))).size,
    globalTotal: total,
    globalWins: wins,
    globalLosses: losses,
    globalWinRate: total > 0 ? (wins / total) * 100 : 0,
    debateAttemptedTotal: 0,
    debateSuccessfulTotal: 0,
    inputLimitErrors: 0,
    aiTimeoutErrors: 0,
  };
}

async function handleFetchNvidia(body) {
  const apiKey = String(body.apiKey || "").trim();
  const baseUrl = String(body.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!apiKey) throw new Error("Missing NVIDIA API key.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `NVIDIA HTTP ${response.status}`);
    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((item) => ({ id: String(item?.id || ""), label: String(item?.id || "") }))
          .filter((item) => item.id && item.id.length > 0)
      : [];
    const smokeModel = pickNvidiaSmokeTestModel(models);
    if (!smokeModel) {
      throw new Error("NVIDIA returned a catalog, but no chat-capable model was found to validate this key.");
    }
    const smoke = await validateNvidiaChatAccess({ apiKey, baseUrl, modelId: smokeModel.id, signal: controller.signal });
    if (!smoke.ok) {
      throw new Error(smoke.message || "NVIDIA key could fetch models but failed a chat validation request.");
    }
    return { models, count: models.length, baseUrl, validated: true, validationModel: smokeModel.id };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("NVIDIA model import timed out. Check the key, network, or try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
//  DEBATE COUNCIL — Model normalization, debate pool, prompts
// ============================================================

function normalizeOneModel(model, globalKeys = [], index = 0) {
  const cleanGlobalKeys = Array.isArray(globalKeys)
    ? globalKeys.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const inheritedKey = pickNvidiaKeyByIndex(cleanGlobalKeys, index);
  const directKey = String(model?.apiKey || "").trim();
  return {
    key: String(model?.key || model?.id || "").trim(),
    label: String(model?.label || model?.id || "").trim(),
    id: String(model?.id || "").trim(),
    apiKey: directKey || inheritedKey,
    baseUrl: sanitizeBaseUrl(model?.baseUrl || DEFAULT_BASE_URL),
    isDebateParticipant: Boolean(model?.isDebateParticipant),
  };
}

function normalizeModels(primary, fallback, globalKeys = [], startIndex = 0) {
  const primaryList = Array.isArray(primary) ? primary : [];
  const fallbackList = Array.isArray(fallback) ? fallback : [];
  const source = [...primaryList, ...fallbackList];
  return dedupeModels(
    source
      .map((item, index) => normalizeOneModel(item, globalKeys, startIndex + index))
      .filter((item) => item.id && item.apiKey),
  );
}

function normalizeNvidiaKeyPool(listValue, legacyValue) {
  const list = Array.isArray(listValue) ? listValue : [];
  const combined = [...list, legacyValue]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const unique = [];
  for (const key of combined) {
    if (!unique.includes(key)) unique.push(key);
  }
  return unique;
}

function pickNvidiaKeyByIndex(pool, index = 0) {
  if (!Array.isArray(pool) || pool.length === 0) return "";
  const safeIndex = Math.abs(Number(index) || 0) % pool.length;
  return String(pool[safeIndex] || "").trim();
}

function dedupeModels(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    const key = String(model?.key || "").trim();
    const id = String(model?.id || "").trim();
    const token = key || id;
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(model);
  }
  return out;
}

function rebalanceModelPools(summaryModels, debateModels) {
  const summaries = dedupeModels(Array.isArray(summaryModels) ? summaryModels : []);
  const debates = dedupeModels(Array.isArray(debateModels) ? debateModels : []);
  if (summaries.length === 0 && debates.length > 0) {
    return { summaryModels: [debates[0]], debateModels: debates.slice(1) };
  }
  // Allow overlap: models in the primary library can also be in the debate list.
  // The debate pool builder dynamically excludes the active Lead Arbiter model.
  return { summaryModels: summaries, debateModels: debates };
}

function sanitizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function isChatCapableModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  const nonChatPatterns = [
    /\bembed/, /\brerank/, /\bsafety/, /\bguard/, /\bclip\b/, /\bdeplot\b/,
    /\bparse\b/, /\bretriever/, /\breward\b/, /\bcalibration/, /\bpii\b/,
    /\bvideo-detector/, /\bkosmos/, /\bneva\b/, /\bvila\b/, /\btranslate/,
    /\bfuyu\b/, /\bbge-/, /\barctic-embed/, /\brecurrentgemma/, /\bgemma-2b$/,
    /\bstarcoder/, /\bcodellama/, /\bcodegemma/, /\bomni.*reasoning/,
    /\bmultimodal/, /\bvision/,
  ];
  return !nonChatPatterns.some((pattern) => pattern.test(id));
}

function applyWorkingAccess(models, access) {
  if (!Array.isArray(models) || !access?.ok) return Array.isArray(models) ? models : [];
  return models.map((model) => {
    let finalId = model.id;
    if (access.modelIds && !access.modelIds.has(model.id)) {
      finalId = resolveBestModelReplacement(model.id, access.models) || model.id;
    }
    return { ...model, id: finalId, apiKey: access.apiKey, baseUrl: access.baseUrl || model.baseUrl };
  });
}

function buildDebatePool(debateModels, selectedSummary, access) {
  const normalizedDebates = Array.isArray(debateModels) ? debateModels : [];
  const filtered = dedupeModels(
    normalizedDebates
      .filter((model) => model.id && model.apiKey)
      .filter((model) => isChatCapableModel(model.id))
      .filter((model) => model.isDebateParticipant && model.key !== selectedSummary.key),
  );
  const capped = shuffleAndCap(filtered, MAX_DEBATE_MODELS);
  return assignDebateBiasTeams(capped);
}

function shuffleAndCap(models, max) {
  if (models.length <= max) return models;
  const shuffled = [...models];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, max);
}

function assignDebateBiasTeams(models) {
  const total = models.length;
  if (total === 0) return [];
  const roles = ["bullish", "bearish", "balanced", "redteam", "bullish", "redteam"];
  return models.map((model, index) => ({
    modelConfig: model,
    bias: roles[index] || "balanced",
  }));
}

function buildDebateSystemPrompt() {
  return [
    "You are a low-latency XAUUSD institutional debate analyst.",
    "Response must be under 180 words.",
    "Analyze only Gold / XAUUSD. Do not reference DXY, indices, silver, oil, crypto, equities, or proxy assets.",
    "Use SMC/ICT/CRT logic: HTF alignment, liquidity sweeps, displacement, FVG, OB, premium/discount, session timing, invalidation.",
    "You are NOT the final decision maker. Argue only your assigned role clearly.",
    "Always include exact price levels from the supplied data when possible.",
  ].join("\n");
}

function buildDebateUserPrompt(basePrompt, bias) {
  let role = "";
  if (bias === "bullish") {
    role = [
      "Debate role: BULLISH TEAM.",
      "Find the strongest valid BUY case.",
      "Prioritize sweep of lows, discount pricing, bullish displacement, bullish FVG/OB retest, and HTF bullish alignment.",
      "Be honest about invalidation.",
    ].join("\n");
  } else if (bias === "bearish") {
    role = [
      "Debate role: BEARISH TEAM.",
      "Find the strongest valid SELL case.",
      "Prioritize sweep of highs, premium pricing, bearish displacement, bearish FVG/OB retest, and HTF bearish alignment.",
      "Be honest about invalidation.",
    ].join("\n");
  } else if (bias === "redteam") {
    role = [
      "Debate role: RED-TEAM CRITIC.",
      "Your job is to find reasons NOT to trade.",
      "Look for traps: no real sweep, weak displacement, HTF conflict, inducement not cleared, price in chop, poor R:R, bad session timing, liquidity too close, stale FVG, invalid OB.",
      "If setup is unsafe, say Stay Flat and explain why.",
    ].join("\n");
  } else {
    role = [
      "Debate role: BALANCED TEAM.",
      "Compare buy and sell cases objectively.",
      "Score confluence using HTF alignment, OB/FVG, premium/discount, sweep, displacement, kill-zone/session timing, and R:R.",
    ].join("\n");
  }
  return [
    basePrompt, "", role, "",
    "Required format:",
    "1) Bias case",
    "2) Structural evidence",
    "3) Entry/trigger zone",
    "4) Targets",
    "5) Invalidation",
    "6) Verdict: Buy, Sell, or Stay Flat",
  ].join("\n");
}

async function requestAiModel({ modelConfig, prompt, temperature, systemPrompt, maxTokens }, options = {}) {
  const timeoutMs = options.timeoutMs || SUMMARY_MAX_WAIT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${sanitizeBaseUrl(modelConfig.baseUrl || DEFAULT_BASE_URL)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${modelConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: modelConfig.id,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        message: payload?.error?.message || payload?.message || `AI HTTP ${response.status}`,
        payload,
      };
    }
    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      statusCode: error?.name === "AbortError" ? 504 : 502,
      message: error?.name === "AbortError"
        ? `Provider timeout for model ${modelConfig.id}.`
        : error?.message || `AI request failed for ${modelConfig.id}.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function calculateDebateConsensus(successfulDebates) {
  const consensus = { buy: 0, sell: 0, wait: 0 };
  successfulDebates.forEach((item) => {
    const text = String(extractAiText(item.result.payload) || "").toLowerCase();
    const bias = item.model?.bias || "";
    if (bias === "redteam") { consensus.wait++; return; }
    const tail = text.slice(-300);
    if (/\bbuy\b|\bbullish\b|\blong\b/i.test(tail)) consensus.buy++;
    else if (/\bsell\b|\bbearish\b|\bshort\b/i.test(tail)) consensus.sell++;
    else consensus.wait++;
  });
  return consensus;
}

function buildConsolidatedPrompt(basePrompt, successfulDebates) {
  const sections = successfulDebates.map((entry, index) => {
    const text = extractAiText(entry.result.payload) || "";
    const role = entry.model.bias === "redteam"
      ? "RED-TEAM CRITIC"
      : `${String(entry.model.bias || "balanced").toUpperCase()} DEBATE ANALYST`;
    return `${role} (${entry.model.modelConfig.label || entry.model.modelConfig.id}):\n${text.trim()}`;
  });
  return [
    "Primary Market Context:",
    basePrompt,
    "",
    "Parallel Debate Outputs:",
    sections.join("\n\n"),
    "",
    "Lead Arbiter Task:",
    "You are the final decision maker.",
    "Resolve conflicts using this priority order:",
    "1) HTF structure alignment",
    "2) Premium/discount location",
    "3) Confirmed liquidity sweep or breakout",
    "4) Displacement quality",
    "5) FVG/OB quality",
    "6) Session timing",
    "7) Risk-to-reward and invalidation clarity",
    "",
    "If the red-team identifies a serious structural trap, you must either choose Stay Flat or explicitly explain why the trap is invalid.",
    "Output exactly the JSON schema from the system prompt. No markdown. No extra text.",
  ].join("\n");
}

function enforceDirectionalOutput(payload, contextPrompt) {
  const aiText = extractAiText(payload);
  if (!aiText) return payload;
  try {
    let cleanText = aiText.trim();
    if (cleanText.startsWith("```json")) cleanText = cleanText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    else if (cleanText.startsWith("```")) cleanText = cleanText.replace(/^```\s*/, "").replace(/\s*```$/, "");
    const data = JSON.parse(cleanText);
    const summary = (data.researcher?.summary || "").toLowerCase();
    const direction = (data.researcher?.direction || "").toLowerCase();
    const summaryIsNeutral = /stay flat|avoid|no trade|wait|not suitable|neutral/i.test(summary);
    const directionIsBiased = /buy|sell|bull|bear|long|short/i.test(direction);
    if (summaryIsNeutral && directionIsBiased) {
      if (!data.researcher) data.researcher = {};
      if (!data.trader) data.trader = {};
      data.researcher.direction = "Stay Flat";
      data.researcher.riskNote = "Institutional Verdict — High risk detected. Narrative overrules technical lean. " + (data.researcher.riskNote || "");
      data.trader.entryZone = "N/A";
      data.trader.takeProfitLevels = "N/A";
      data.trader.stopLoss = "N/A";
      data.trader.positionSizing = "N/A";
      data.trader.timeHorizon = "N/A";
      data.trader.invalidation = "Point where the discussed bias would have failed structurally.";
      return setAiText(payload, JSON.stringify(data, null, 2));
    }
  } catch {
    return setAiText(payload, JSON.stringify(buildStructuredSummaryFromText(aiText, contextPrompt), null, 2));
  }
  return payload;
}

// ============================================================
//  LEARNING MEMORY — KV-backed learning context
// ============================================================

function emptyLearningContext() {
  return {
    total: 0, wins: 0, losses: 0, breakevens: 0,
    winRate: 0, topLossReasons: [], topWinPatterns: [],
    timeframeStats: {}, directionStats: {},
    latestModelLessons: [],
    currentStreak: 0, currentStreakType: "",
    bestWinStreak: 0, worstLossStreak: 0,
    updatedAt: 0,
  };
}

async function loadLearningContext(env) {
  try {
    const store = env.LEARNING_STORE || env.AURUM_KV;
    if (!store) return emptyLearningContext();
    const raw = await store.get("learning:global");
    if (!raw) return emptyLearningContext();
    return { ...emptyLearningContext(), ...JSON.parse(raw) };
  } catch {
    return emptyLearningContext();
  }
}

function appendLearningContext(prompt, context) {
  if (!context || Number(context.total || 0) <= 0) return prompt;
  const sections = [];
  sections.push("Global Learning Memory:");
  sections.push(`Historical samples: ${context.total}, win rate: ${context.winRate || 0}%`);

  if (context.currentStreak > 0 && context.currentStreakType) {
    sections.push(`Current streak: ${context.currentStreak} consecutive ${context.currentStreakType.toUpperCase()}s.`);
  }
  if (context.worstLossStreak > 2) {
    sections.push(`Worst loss streak ever: ${context.worstLossStreak}. Be cautious about marginal setups.`);
  }

  const tfStats = context.timeframeStats || {};
  const tfLines = Object.entries(tfStats)
    .filter(([, stats]) => (stats.wins || 0) + (stats.losses || 0) >= 2)
    .map(([tf, stats]) => {
      const total = (stats.wins || 0) + (stats.losses || 0);
      const wr = total > 0 ? ((stats.wins / total) * 100).toFixed(0) : 0;
      return `${tf}: ${wr}% win rate (${stats.wins}W/${stats.losses}L)`;
    });
  if (tfLines.length > 0) {
    sections.push("Performance by timeframe:");
    sections.push(tfLines.join(", "));
  }

  const dirStats = context.directionStats || {};
  const dirLines = Object.entries(dirStats)
    .filter(([key]) => key === "buy" || key === "sell")
    .filter(([, stats]) => (stats.wins || 0) + (stats.losses || 0) >= 2)
    .map(([dir, stats]) => {
      const total = (stats.wins || 0) + (stats.losses || 0);
      const wr = total > 0 ? ((stats.wins / total) * 100).toFixed(0) : 0;
      return `${dir.toUpperCase()}: ${wr}% win rate (${stats.wins}W/${stats.losses}L)`;
    });
  if (dirLines.length > 0) {
    sections.push("Performance by direction:");
    sections.push(dirLines.join(", "));
  }

  if (Array.isArray(context.topWinPatterns) && context.topWinPatterns.length) {
    sections.push("", "Successful patterns to preserve:");
    context.topWinPatterns.slice(0, 5).forEach((item, index) => {
      sections.push(`${index + 1}. ${item.reason} (count=${item.count})`);
    });
  }

  if (Array.isArray(context.topLossReasons) && context.topLossReasons.length) {
    sections.push("", "Avoid repeating these common failure patterns:");
    context.topLossReasons.slice(0, 5).forEach((item, index) => {
      sections.push(`${index + 1}. ${item.reason} (count=${item.count})`);
    });
  }

  if (Array.isArray(context.latestModelLessons) && context.latestModelLessons.length) {
    sections.push("", "Latest model-improvement lessons:");
    context.latestModelLessons.slice(0, 5).forEach((lesson, index) => {
      const text = typeof lesson === "string" ? lesson : lesson?.lesson || "";
      if (text) sections.push(`${index + 1}. ${text}`);
    });
  }

  if (sections.length <= 2) return prompt;

  sections.push("", "Learning memory is a risk filter, not a replacement for current market structure.");
  sections.push("Apply this memory as hard risk filters before giving the final decision.");
  return [prompt, "", sections.join("\n")].join("\n");
}

// ============================================================
//  LEARNING FEEDBACK — Endpoint handlers
// ============================================================

async function updateMemoryWithFeedback(env, data) {
  const outcome = String(data.outcome || "").toLowerCase();
  const direction = String(data.direction || "").trim().slice(0, 30);
  const timeframe = String(data.timeframe || "").trim().slice(0, 20);
  const reason = String(data.reason || "").trim().slice(0, 400);
  const analysisId = String(data.analysisId || "").trim().slice(0, 80);
  const arbiterDirection = String(data.arbiterDirection || "").trim().slice(0, 30);
  const riskNote = String(data.riskNote || "").trim().slice(0, 500);
  const price = Number(data.price) || 0;
  const createdAt = Number(data.createdAt) || Date.now();

  if (!["win", "loss", "breakeven", "manual-note"].includes(outcome)) {
    return { ok: false, message: "Outcome must be win, loss, breakeven, or manual-note." };
  }

  const store = env.LEARNING_STORE || env.AURUM_KV;
  if (!store) return { ok: false, message: "Learning store not configured." };

  // 1. Save individual feedback
  const feedbackKey = `learning:feedback:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  await store.put(feedbackKey, JSON.stringify({
    outcome, direction, timeframe, reason, analysisId,
    arbiterDirection, riskNote, price, createdAt,
  }));

  // 2. Load and update global memory
  const global = await loadLearningContext(env);
  global.total = Number(global.total || 0) + 1;
  if (outcome === "win") global.wins = Number(global.wins || 0) + 1;
  else if (outcome === "loss") global.losses = Number(global.losses || 0) + 1;
  else if (outcome === "breakeven") global.breakevens = Number(global.breakevens || 0) + 1;
  global.winRate = global.total > 0 ? Number(((global.wins / global.total) * 100).toFixed(2)) : 0;

  // Update timeframe stats
  if (timeframe) {
    if (!global.timeframeStats) global.timeframeStats = {};
    const tfEntry = global.timeframeStats[timeframe] || { wins: 0, losses: 0 };
    if (outcome === "win") tfEntry.wins += 1;
    else if (outcome === "loss") tfEntry.losses += 1;
    global.timeframeStats[timeframe] = tfEntry;
  }

  // Update direction stats
  const dirKey = String(direction || "").toLowerCase();
  if (dirKey === "buy" || dirKey === "sell") {
    if (!global.directionStats) global.directionStats = {};
    const dirEntry = global.directionStats[dirKey] || { wins: 0, losses: 0 };
    if (outcome === "win") dirEntry.wins += 1;
    else if (outcome === "loss") dirEntry.losses += 1;
    global.directionStats[dirKey] = dirEntry;
  }

  // Update reason counters
  if (outcome === "loss" && reason) {
    global.topLossReasons = incrementReasonCounter(global.topLossReasons, reason);
  } else if (outcome === "win" && reason) {
    global.topWinPatterns = incrementReasonCounter(global.topWinPatterns, reason);
  }

  // Streak tracking
  const lastOutcome = global.lastOutcome || "";
  if (outcome === lastOutcome || outcome === "manual-note") {
    global.currentStreak = Number(global.currentStreak || 0) + (outcome === "manual-note" ? 0 : 1);
  } else if (outcome !== "manual-note") {
    global.currentStreak = 1;
    global.currentStreakType = outcome;
  }
  global.lastOutcome = outcome === "manual-note" ? lastOutcome : outcome;
  global.bestWinStreak = Math.max(Number(global.bestWinStreak || 0), outcome === "win" ? global.currentStreak : 0);
  global.worstLossStreak = Math.max(Number(global.worstLossStreak || 0), outcome === "loss" ? global.currentStreak : 0);
  global.updatedAt = Date.now();

  // 3. Save updated global
  await store.put("learning:global", JSON.stringify(global));

  return { ok: true, learningContext: global };
}

async function autoResolvePendingHistory(env) {
  try {
    const store = env.AURUM_KV;
    if (!store) return;

    // Load history
    const history = await loadHistoryEntries(env);
    if (!Array.isArray(history) || history.length === 0) return;

    // Filter pending entries to see if we have work to do
    const pendingEntries = history.filter(entry => {
      const bias = String(entry.bias || entry.direction || "").trim().toLowerCase();
      const isPending = !entry.outcome || entry.outcome === "pending";
      const hasDirection = bias === "buy" || bias === "sell";
      return isPending && hasDirection;
    });

    if (pendingEntries.length === 0) return;

    // We need recent candles to evaluate
    const config = await getOandaConfig(env).catch(() => null);
    if (!config) return;
    const instrument = normalizeInstrument(config.instrument);

    // Fetch 15-minute candles to evaluate chronologically
    const tf15 = await fetchCandlesWithCache(env, { instrument, timeframe: "15min", count: 1000 }).catch(() => null);
    if (!tf15 || !Array.isArray(tf15.candles) || tf15.candles.length === 0) return;

    // Sort candles chronologically ascending (oldest to newest)
    const candles15 = [...tf15.candles].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));

    let updated = false;

    for (let entry of history) {
      const biasRaw = String(entry.bias || entry.direction || "").trim();
      const bias = biasRaw.toLowerCase();
      const isPending = !entry.outcome || entry.outcome === "pending";
      const hasDirection = bias === "buy" || bias === "sell";

      if (isPending && hasDirection) {
        const entryPrice = Number(entry.price) || 0;
        const sl = Number(entry.sl || entry.stopPrice || 0);
        const tp = Number(entry.tp2 || entry.tp1 || entry.tp || 0);

        if (entryPrice <= 0 || sl <= 0 || tp <= 0) {
          continue; // missing targets, skip
        }

        const entryTime = Date.parse(entry.timestampIso || entry.timestamp || "");
        if (isNaN(entryTime)) continue;

        // Filter candles that started after (or within) the signal time
        const subsequent = candles15.filter(c => Date.parse(c.datetime) >= entryTime);
        if (subsequent.length === 0) continue;

        let outcome = "pending";
        for (const candle of subsequent) {
          const high = Number(candle.high) || 0;
          const low = Number(candle.low) || 0;
          if (high <= 0 || low <= 0) continue;

          if (bias === "buy") {
            const hitSL = low <= sl;
            const hitTP = high >= tp;

            if (hitSL && hitTP) {
              outcome = "loss";
              break;
            } else if (hitSL) {
              outcome = "loss";
              break;
            } else if (hitTP) {
              outcome = "win";
              break;
            }
          } else if (bias === "sell") {
            const hitSL = high >= sl;
            const hitTP = low <= tp;

            if (hitSL && hitTP) {
              outcome = "loss";
              break;
            } else if (hitSL) {
              outcome = "loss";
              break;
            } else if (hitTP) {
              outcome = "win";
              break;
            }
          }
        }

        if (outcome !== "pending") {
          entry.outcome = outcome;
          entry.learningOutcome = outcome;
          updated = true;

          // Trigger learning update
          const reason = outcome === "win"
            ? `${biasRaw} setup confirmed. TP of ${tp} reached.`
            : `${biasRaw} setup failed. SL of ${sl} reached.`;

          await updateMemoryWithFeedback(env, {
            outcome,
            direction: biasRaw,
            timeframe: entry.timeframe || "15min",
            reason,
            analysisId: String(entry.id),
            price: entryPrice,
          }).catch(console.error);
        }
      }
    }

    if (updated) {
      await store.put("history", JSON.stringify(history));
    }
  } catch (err) {
    console.error("autoResolvePendingHistory error:", err);
  }
}

async function handleLearningFeedback(request, env) {
  const body = await request.json().catch(() => ({}));
  return updateMemoryWithFeedback(env, body);
}

function incrementReasonCounter(list, reason) {
  const clean = String(reason || "").trim();
  if (!clean) return Array.isArray(list) ? list : [];
  const next = Array.isArray(list) ? [...list] : [];
  const existing = next.find((item) => item.reason === clean);
  if (existing) existing.count = Number(existing.count || 0) + 1;
  else next.push({ reason: clean, count: 1 });
  return next.sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, 20);
}

// ============================================================
//  AUTO-LEARN — Learn from closed OANDA trades
// ============================================================

async function handleAutoLearn(request, env) {
  const store = env.LEARNING_STORE || env.AURUM_KV;
  if (!store) return { ok: false, message: "Learning store not configured." };

  let closedTrades = [];
  try {
    const result = await loadClosedTrades(env);
    closedTrades = Array.isArray(result?.trades) ? result.trades : [];
  } catch {
    return { ok: false, message: "Failed to fetch closed OANDA trades." };
  }

  // Load processed trade IDs
  let processedIds = [];
  try {
    const raw = await store.get("learning:processed-trades");
    if (raw) processedIds = JSON.parse(raw);
  } catch { processedIds = []; }
  const processedSet = new Set(processedIds);

  let processed = 0;
  for (const trade of closedTrades) {
    const tradeId = String(trade?.id || "");
    if (!tradeId || processedSet.has(tradeId)) continue;

    const realizedPL = Number(trade?.realizedPL || 0);
    let outcome = "breakeven";
    if (realizedPL > 0) outcome = "win";
    else if (realizedPL < 0) outcome = "loss";

    const direction = Number(trade?.initialUnits || 0) >= 0 ? "Buy" : "Sell";
    const reason = outcome === "win"
      ? `OANDA trade ${tradeId} closed in profit (PL: ${realizedPL}).`
      : outcome === "loss"
        ? `OANDA trade ${tradeId} closed in loss (PL: ${realizedPL}).`
        : `OANDA trade ${tradeId} closed at breakeven.`;

    // Save feedback
    const feedbackKey = `learning:feedback:${Date.now()}:oanda-${tradeId}`;
    await store.put(feedbackKey, JSON.stringify({
      outcome, direction, timeframe: "", reason,
      analysisId: `oanda-${tradeId}`, price: Number(trade?.price || 0),
      createdAt: Date.now(), source: "auto-learn-oanda",
    }));

    // Update global
    const global = await loadLearningContext(env);
    global.total = Number(global.total || 0) + 1;
    if (outcome === "win") global.wins = Number(global.wins || 0) + 1;
    else if (outcome === "loss") global.losses = Number(global.losses || 0) + 1;
    else global.breakevens = Number(global.breakevens || 0) + 1;
    global.winRate = global.total > 0 ? Number(((global.wins / global.total) * 100).toFixed(2)) : 0;

    if (outcome === "loss" && reason) {
      global.topLossReasons = incrementReasonCounter(global.topLossReasons, reason);
    } else if (outcome === "win" && reason) {
      global.topWinPatterns = incrementReasonCounter(global.topWinPatterns, reason);
    }
    global.updatedAt = Date.now();
    await store.put("learning:global", JSON.stringify(global));

    processedSet.add(tradeId);
    processed++;
  }

  // Save updated processed trade IDs
  await store.put("learning:processed-trades", JSON.stringify([...processedSet].slice(-500)));

  return { ok: true, processed, totalTrades: closedTrades.length };
}

// ============================================================
//  SYSTEM PROMPTS
// ============================================================

function buildSummarySystemPrompt() {
  return [
    "You are the Lead Institutional Arbiter for XAUUSD.",
    "STRICT SECURITY & ISOLATION RULE: You MUST analyze Gold (XAUUSD) completely in isolation. NEVER reference, correlate, or compare Gold with any other asset, Forex currency, index, or commodity (such as DXY, EURUSD, S&P 500, Silver, Crude Oil, or any benchmarks/proxies). All SMC structure and momentum calculations must be derived purely from XAU/USD's own price history. Do not discuss or compare other symbols under any circumstances.",
    "Output exactly one valid JSON object with this shape:",
    "{",
    '  "researcher": { "summary": "...", "direction": "Buy | Sell | Stay Flat", "riskNote": "..." },',
    '  "trader": { "entryZone": "...", "takeProfitLevels": "...", "stopLoss": "...", "positionSizing": "...", "timeHorizon": "...", "invalidation": "..." },',
    '  "equations": { "review": "..." },',
    '  "scorecard": { "tdsScore": 0, "confluence": "Low | Medium | High", "grade": "Skip | Watch | Active", "confidence": 0, "drivers": ["..."] }',
    "}",
    "If the setup is weak or invalid, use Stay Flat and N/A values.",
  ].join("\n");
}

function buildServerFallbackSummary(promptText, meta = {}) {
  const directionMatch = /Rule Engine Direction:\s*([^\n]+)/i.exec(promptText) || /Rule Engine Decision:\s*([^\n]+)/i.exec(promptText);
  const ruleDirection = directionMatch?.[1] || "";
  const direction = /sell|bear/i.test(ruleDirection) ? "Sell" : /buy|bull/i.test(ruleDirection) ? "Buy" : "Stay Flat";
  const trendMatch = /Trend:\s*([^\n]+)/i.exec(promptText);
  const rmiMatch = /RMI:\s*([0-9.-]+)\s*\(([^)]+)\)/i.exec(promptText);
  const fvgMatch = /Fair Value Gaps:\s*([^\n]+)/i.exec(promptText);
  const priceMatch = /Current Price:\s*([0-9.]+)/i.exec(promptText);
  const scorecard = buildDeterministicScorecard({
    direction,
    trend: trendMatch?.[1] || "",
    rmi: Number(rmiMatch?.[1]),
    rmiBias: rmiMatch?.[2] || "",
    fairValueGaps: fvgMatch?.[1] || "",
  });
  const modelReason = sanitizeProviderFailureReason(meta.reason || "AI provider unavailable.");
  const summary = scorecard.grade === "Active"
    ? `Local arbiter accepted the ${direction} bias using rule-engine confluence while the upstream AI model is unavailable.`
    : `Local arbiter kept the setup on watch because confluence is not strong enough while the upstream AI model is unavailable.`;

  return JSON.stringify({
    researcher: {
      summary,
      direction: scorecard.grade === "Active" ? direction : "Stay Flat",
      riskNote: `${modelReason} Local scorecard is deterministic and should be treated as a safety fallback, not an AI consensus.`,
    },
    trader: {
      entryZone: scorecard.grade === "Active" ? `Wait for confirmation near ${priceMatch?.[1] || "current price"} structure.` : "N/A",
      takeProfitLevels: scorecard.grade === "Active" ? "T1 at nearby liquidity, T2 at next displacement leg, runner after break-even." : "N/A",
      stopLoss: scorecard.grade === "Active" ? "Invalidate beyond the opposite structural close." : "N/A",
      positionSizing: scorecard.grade === "Active" ? "Use reduced risk until a configured AI model confirms the setup." : "N/A",
      timeHorizon: scorecard.grade === "Active" ? "Intraday" : "N/A",
      invalidation: "Opposite structural close.",
    },
    equations: {
      review: [
        `Momentum: ${scorecard.drivers.find((item) => item.startsWith("RMI")) || "RMI not available"}.`,
        `Volatility/structure: ${scorecard.drivers.find((item) => item.startsWith("Trend")) || "trend not available"}.`,
        `Crowding proxy: ${scorecard.drivers.find((item) => item.startsWith("FVG")) || "no FVG impulse detected"}.`,
      ].join(" "),
    },
    scorecard,
  });
}

function sanitizeProviderFailureReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return "AI provider is not configured.";
  if (/HTTP\s*(401|403)|forbidden|unauthorized|invalid api key|permission/i.test(text)) {
    return "NVIDIA rejected the configured API key. Re-save a valid NVIDIA key in Settings, then import NVIDIA models so the app can use a model available to that key.";
  }
  if (/HTTP\s*404|not found|model/i.test(text)) {
    return "The configured NVIDIA model is not available to this key. Import NVIDIA models again from Settings and select one of the imported models.";
  }
  return text.replace(/\bAI HTTP\s*\d+\b/gi, "AI provider error");
}

function extractAiText(payload) {
  const fromChoices = payload?.choices?.[0]?.message?.content;
  if (typeof fromChoices === "string" && fromChoices.trim()) return fromChoices.trim();
  const fromOutput = payload?.output?.[0]?.content?.[0]?.text;
  if (typeof fromOutput === "string" && fromOutput.trim()) return fromOutput.trim();
  const textField = payload?.text;
  if (typeof textField === "string" && textField.trim()) return textField.trim();
  return "";
}

function setAiText(payload, text) {
  if (payload?.choices?.[0]?.message) {
    payload.choices[0].message.content = text;
    return payload;
  }
  if (payload?.output?.[0]?.content?.[0]) {
    payload.output[0].content[0].text = text;
    return payload;
  }
  return {
    ...payload,
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

function stripJsonFence(text) {
  let cleanText = String(text || "").trim();
  if (cleanText.startsWith("```json")) return cleanText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  if (cleanText.startsWith("```")) return cleanText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  return cleanText;
}

function buildStructuredSummaryFromText(aiText, contextPrompt) {
  const raw = String(aiText || "").trim();
  const context = String(contextPrompt || "");
  const ruleDirection = /Rule Engine Direction:\s*([^\n]+)/i.exec(context)?.[1] || "";
  const direction =
    /\b(sell|bearish|short)\b/i.test(raw) ? "Sell" :
    /\b(buy|bullish|long)\b/i.test(raw) ? "Buy" :
    /\b(sell|bearish|short)\b/i.test(ruleDirection) ? "Sell" :
    /\b(buy|bullish|long)\b/i.test(ruleDirection) ? "Buy" :
    "Stay Flat";
  const isFlat = direction === "Stay Flat";
  const priceLine = /Current Price:\s*([^\n]+)/i.exec(context)?.[1]?.trim() || "current market price";

  return {
    researcher: {
      summary: raw || "AI response did not include a narrative summary.",
      direction,
      riskNote: "AI response was normalized into the required JSON trade-plan format.",
    },
    trader: {
      entryZone: isFlat ? "N/A" : `Wait for confirmation near ${priceLine} structure.`,
      takeProfitLevels: isFlat ? "N/A" : "Use nearest liquidity as T1, next displacement leg as T2, then trail after break-even.",
      stopLoss: isFlat ? "N/A" : "Invalidate beyond the opposite structural close.",
      positionSizing: isFlat ? "N/A" : "Use reduced risk until clean execution confirmation.",
      timeHorizon: isFlat ? "N/A" : "Intraday",
      invalidation: isFlat ? "Re-evaluate after a confirmed CHoCH/BOS with displacement." : "Opposite structural close.",
    },
    equations: {
      review: "AI response did not provide a dedicated equations block; use the generated market equations panel for momentum, volatility, and max-pain context.",
    },
  };
}

function buildDeterministicScorecard({ direction, trend, rmi, rmiBias, fairValueGaps }) {
  let score = 0;
  const drivers = [];
  const lowerDirection = String(direction || "").toLowerCase();
  const lowerTrend = String(trend || "").toLowerCase();
  const lowerRmiBias = String(rmiBias || "").toLowerCase();
  const fvgText = String(fairValueGaps || "").toLowerCase();

  if (lowerDirection === "buy" || lowerDirection === "sell") {
    score += 25;
    drivers.push(`Rule engine direction: ${direction}`);
  }
  if ((lowerDirection === "buy" && lowerTrend.includes("bull")) || (lowerDirection === "sell" && lowerTrend.includes("bear"))) {
    score += 25;
    drivers.push(`Trend alignment: ${trend}`);
  } else if (lowerTrend) {
    score += 10;
    drivers.push(`Trend present: ${trend}`);
  }
  if (Number.isFinite(rmi)) {
    const rmiDistance = Math.abs(rmi - 50);
    const rmiPoints = rmiDistance >= 12 ? 20 : rmiDistance >= 7 ? 12 : 6;
    score += rmiPoints;
    drivers.push(`RMI momentum: ${rmi.toFixed(2)} (${rmiBias || "neutral"})`);
  }
  if ((lowerDirection === "buy" && lowerRmiBias.includes("bull")) || (lowerDirection === "sell" && lowerRmiBias.includes("bear"))) {
    score += 15;
  }
  if (fvgText && !fvgText.includes("none")) {
    score += 15;
    drivers.push(`FVG impulse: ${fairValueGaps}`);
  }

  const tdsScore = Math.max(0, Math.min(100, Math.round(score)));
  const confluence = tdsScore >= 75 ? "High" : tdsScore >= 55 ? "Medium" : "Low";
  const grade = tdsScore >= 75 ? "Active" : tdsScore >= 55 ? "Watch" : "Skip";
  return {
    tdsScore,
    confluence,
    grade,
    confidence: tdsScore,
    drivers: drivers.slice(0, 5),
  };
}

function createTextPayload(text, modelId) {
  return {
    model: modelId,
    choices: [
      {
        message: {
          role: "assistant",
          content: String(text || "").trim(),
        },
      },
    ],
  };
}

function assertAdmin(request, env) {
  const supplied = String(request.headers.get("x-admin-password") || "");
  const adminPassword = String(env.ADMIN_PASSWORD || "Aviraj@api7").trim();
  if (supplied !== adminPassword) {
    throw new Error("Unauthorized.");
  }
}

function jsonResponse(payload, request, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  };
}

function normalizeInstrument(value) {
  return String(value || DEFAULT_INSTRUMENT).trim().toUpperCase().replace("/", "_");
}

function normalizeEnvironment(value) {
  return String(value || "practice").toLowerCase() === "live" ? "live" : "practice";
}

function normalizeBotMode(value) {
  const mode = String(value || "manual").toLowerCase();
  return ["manual", "paper", "live"].includes(mode) ? mode : "manual";
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function sanitizeBotPatch(config) {
  return {
    botMode: normalizeBotMode(config.botMode),
    botInstrument: normalizeInstrument(config.botInstrument || DEFAULT_INSTRUMENT),
    oandaEnvironment: normalizeEnvironment(config.oandaEnvironment || "practice"),
    botUnits: clampInt(config.botUnits, 10, 1, 1000000),
    botStopLossOffset: normalizeNumber(config.botStopLossOffset, 3),
    botTakeProfitOffset: normalizeNumber(config.botTakeProfitOffset, 6),
    botCooldownMinutes: clampInt(config.botCooldownMinutes, 15, 1, 1440),
    botPollIntervalSeconds: clampInt(config.botPollIntervalSeconds, 60, 15, 3600),
  };
}

function checkBreakoutFVG(candles, breakoutIdx, isUpside) {
  if (breakoutIdx < 1 || breakoutIdx >= candles.length - 1) return false;
  const prev = candles[breakoutIdx - 1];
  const next = candles[breakoutIdx + 1];
  if (isUpside) {
    // Bullish FVG: next candle's low > previous candle's high
    return next.low > prev.high;
  } else {
    // Bearish FVG: next candle's high < previous candle's low
    return next.high < prev.low;
  }
}

function detectLiquiditySweeps(mtfData) {
  const MIN_DEPTH = 0.10; // Minimum $0.10 depth beyond level to qualify
  const getCandles = (id) => normalizeCandles(mtfData?.data?.find(d => d.id === id)?.values || []);
  const monthly = getCandles("1month");
  const weekly = getCandles("1week");
  const daily = getCandles("1day");
  const h4 = getCandles("4h");
  const h1 = getCandles("h1");
  const m15 = getCandles("15min");
  const m5 = getCandles("5min");
  
  const sweeps = [];
  const diagnosticLogs = [];
  const evaluateEvent = (levelName, levelPrice, childCandles, isHigh, formedAt) => {
    const closedCandles = childCandles.filter(c => c.complete !== false);
    if (closedCandles.length < 2) return;
    // Use the latest closed candles (including the most recent one)
    const candidates = closedCandles.slice(-6);

    for (const current of candidates) {
      // --- TEMPORAL PARADOX FILTER ---
      const currentVal = new Date(current.datetime || current._ts).getTime();
      if (formedAt && currentVal < formedAt) continue;

      const bodySize = Math.abs(current.close - current.open);
      const totalRange = current.high - current.low;
      const bodyRatio = totalRange > 0 ? bodySize / totalRange : 0;

      if (isHigh) {
        const wickDepth = current.high - levelPrice;
        // SWEEP: wicked above, closed below
        if (current.high > levelPrice && current.close < levelPrice && wickDepth > MIN_DEPTH) {
          sweeps.push({ name: levelName, price: levelPrice, condition: "Sweep Out (Fakeout)", action: "Sell Reversal", status: "SWEPT", bodyPct: (bodyRatio * 100).toFixed(1) + "%" });
          return; // found event, stop
        }
        // Close above level
        if (current.close > levelPrice) {
          const closeDepth = current.close - levelPrice;
          if (closeDepth > MIN_DEPTH && bodyRatio >= 0.70) {
            // Check FVG
            const candleIdx = closedCandles.indexOf(current);
            const hasFVG = checkBreakoutFVG(closedCandles, candleIdx, true);
            if (hasFVG) {
              sweeps.push({ name: levelName, price: levelPrice, condition: "Breakout (True BOS)", action: "Buy Continuation", status: "BROKEN", bodyPct: (bodyRatio * 100).toFixed(1) + "%", fvg: true });
              return;
            }
            // Weak close - PENDING, don't push to results
          }
          // Else: close beyond but not strong enough - skip
        }
      } else {
        const wickDepth = levelPrice - current.low;
        // SWEEP: wicked below, closed above
        if (current.low < levelPrice && current.close > levelPrice && wickDepth > MIN_DEPTH) {
          sweeps.push({ name: levelName, price: levelPrice, condition: "Sweep Out (Fakeout)", action: "Buy Reversal", status: "SWEPT", bodyPct: (bodyRatio * 100).toFixed(1) + "%" });
          return;
        }
        // Close below level
        if (current.close < levelPrice) {
          const closeDepth = levelPrice - current.close;
          if (closeDepth > MIN_DEPTH && bodyRatio >= 0.70) {
            const candleIdx = closedCandles.indexOf(current);
            const hasFVG = checkBreakoutFVG(closedCandles, candleIdx, false);
            if (hasFVG) {
              sweeps.push({ name: levelName, price: levelPrice, condition: "Breakout (True BOS)", action: "Sell Continuation", status: "BROKEN", bodyPct: (bodyRatio * 100).toFixed(1) + "%", fvg: true });
              return;
            }
          }
        }
      }
    }
  };

  // 0.5 Quarterly (Parent) -> Monthly (Child)
  if (monthly.length >= 4) {
    const prevQ = monthly.slice(-4, -1);
    const pqh = Math.max(...prevQ.map(c => c.high));
    const pql = Math.min(...prevQ.map(c => c.low));
    const formedAt = new Date(monthly[monthly.length - 1].datetime || monthly[monthly.length - 1]._ts).getTime();
    evaluateEvent("PQH (Prev Quarter High)", pqh, monthly, true, formedAt);
    evaluateEvent("PQL (Prev Quarter Low)", pql, monthly, false, formedAt);
  }

  // 1. Monthly (Parent) -> Weekly (Child)
  if (monthly.length >= 2) {
    const prev = monthly[monthly.length - 2];
    const formedAt = new Date(monthly[monthly.length - 1].datetime || monthly[monthly.length - 1]._ts).getTime();
    evaluateEvent("PMH (Prev Month High)", prev.high, weekly, true, formedAt);
    evaluateEvent("PML (Prev Month Low)", prev.low, weekly, false, formedAt);
  }

  // 2. Weekly (Parent) -> Daily (Child)
  if (weekly.length >= 2) {
    const prev = weekly[weekly.length - 2];
    const formedAt = new Date(weekly[weekly.length - 1].datetime || weekly[weekly.length - 1]._ts).getTime();
    evaluateEvent("PWH (Prev Week High)", prev.high, daily, true, formedAt);
    evaluateEvent("PWL (Prev Week Low)", prev.low, daily, false, formedAt);
  }

  // 3. Daily (Parent) -> 4H (Child)
  if (daily.length >= 2) {
    const prev = daily[daily.length - 2];
    const formedAt = new Date(daily[daily.length - 1].datetime || daily[daily.length - 1]._ts).getTime();
    evaluateEvent("PDH (Prev Day High)", prev.high, h4, true, formedAt);
    evaluateEvent("PDL (Prev Day Low)", prev.low, h4, false, formedAt);
  }

  // 3.5 4H (Parent) -> 15M (Child)
  if (h4.length >= 2) {
    const prev = h4[h4.length - 2];
    const formedAt = new Date(h4[h4.length - 1].datetime || h4[h4.length - 1]._ts).getTime();
    evaluateEvent("P4H (Prev 4H High)", prev.high, m15, true, formedAt);
    evaluateEvent("P4L (Prev 4H Low)", prev.low, m15, false, formedAt);
  }

  // 4. Session High/Low (Asian/London) -> 5M (Child)
  if (h1.length > 0) {
    const lastTime = new Date(h1[h1.length - 1]._ts);
    const todayStr = lastTime.toISOString().split("T")[0];
    const currentHourUTC = lastTime.getUTCHours();
    
    let asianHigh = -Infinity, asianLow = Infinity;
    let londonHigh = -Infinity, londonLow = Infinity;
    let hasAsian = false, hasLondon = false;
    
    h1.forEach(c => {
      const d = new Date(c._ts);
      if (d.toISOString().split("T")[0] === todayStr) {
        const hour = d.getUTCHours();
        // Asian session: 00:00 to 07:00 UTC
        if (hour >= 0 && hour < 7) {
          asianHigh = Math.max(asianHigh, c.high);
          asianLow = Math.min(asianLow, c.low);
          hasAsian = true;
        }
        // London session: 07:00 to 12:00 UTC
        else if (hour >= 7 && hour < 12) {
          londonHigh = Math.max(londonHigh, c.high);
          londonLow = Math.min(londonLow, c.low);
          hasLondon = true;
        }
      }
    });
    
    // Only evaluate session if it's strictly over based on the current hour of the latest H1 candle
    if (hasAsian && currentHourUTC >= 7) {
      const formedAt = new Date(todayStr + "T07:00:00Z").getTime();
      evaluateEvent("Asian High", asianHigh, m5, true, formedAt);
      evaluateEvent("Asian Low", asianLow, m5, false, formedAt);
    }
    if (hasLondon && currentHourUTC >= 12) {
      const formedAt = new Date(todayStr + "T12:00:00Z").getTime();
      evaluateEvent("London High", londonHigh, m5, true, formedAt);
      evaluateEvent("London Low", londonLow, m5, false, formedAt);
    }
  }

  return sweeps;
}

function buildDetectionLog(levelName, levelPrice, candle, decision, reason, calculations) {
  const istTime = new Date(candle._ts || Date.now()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return {
    timestamp: istTime,
    level: levelName,
    levelPrice: roundPrice(levelPrice),
    candle: { open: roundPrice(candle.open), high: roundPrice(candle.high), low: roundPrice(candle.low), close: roundPrice(candle.close) },
    decision,
    reason,
    ...calculations
  };
}
