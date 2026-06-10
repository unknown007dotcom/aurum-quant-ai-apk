const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const { getAdminSettings, getFirestore } = require("../lib/firebase-admin");
const { getSummaryKnowledge, getDebateKnowledge } = require("../lib/smc-knowledge");
const DEBATE_MODES = {
  fast: { maxModels: 6, concurrency: 6, timeoutMs: 18000 },
  deep: { maxModels: 20, concurrency: 10, timeoutMs: 25000 },
  full: { maxModels: 35, concurrency: 12, timeoutMs: 25000 },
};

async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runner() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      try {
        results[currentIndex] = await workerFn(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = {
          ok: false,
          statusCode: 500,
          message: error?.message || "Worker function failed",
        };
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runner()
  );
  await Promise.all(workers);
  return results;
}

const modelCatalogCache = new Map();

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  const body = await getRequestBody(req);
  const selectedModelKey = String(body.selectedModelKey || "");
  const prompt = String(body.prompt || "");
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2;

  if (!prompt) {
    res.status(400).json({ message: "Missing AI prompt." });
    return;
  }

  const settings = await safeLoadSettings();
  const learningContext = await safeLoadLearningContext();
  const promptWithLearning = appendLearningContext(prompt, learningContext);
  const globalNvidiaKeys = normalizeNvidiaKeyPool(settings?.globalNvidiaApiKeys, settings?.globalNvidiaApiKey);

  const fallbackModel = normalizeOneModel({
    key: String(body.selectedModelKey || ""),
    label: String(body.label || ""),
    id: String(body.model || ""),
    apiKey: String(body.apiKey || ""),
    baseUrl: String(body.baseUrl || DEFAULT_BASE_URL),
  });

  let summaryModels = normalizeModels(settings?.nvidiaModels, body.models, globalNvidiaKeys, 0);
  let debateModels = normalizeModels(settings?.debateModels, body.debateModels, globalNvidiaKeys, summaryModels.length);
  ({ summaryModels, debateModels } = rebalanceModelPools(summaryModels, debateModels));

  const access = await resolveWorkingNvidiaAccess({
    summaryModels,
    debateModels,
    fallbackModel,
    globalKeys: globalNvidiaKeys,
  });

  if (access.ok) {
    summaryModels = applyWorkingNvidiaAccess(summaryModels, access, { fillFromCatalog: true });
    debateModels = applyWorkingNvidiaAccess(debateModels, access, { fillFromCatalog: false });
    if (fallbackModel?.id) {
      Object.assign(fallbackModel, applyWorkingNvidiaAccess([fallbackModel], access, { fillFromCatalog: false })[0] || fallbackModel);
    }
  }

  const selectedSummary =
    summaryModels.find((item) => item.key === selectedModelKey) ||
    debateModels.find((item) => item.key === selectedModelKey) ||
    summaryModels[0] ||
    debateModels[0] ||
    fallbackModel;

  if (!selectedSummary?.id || !selectedSummary?.apiKey || (!access.ok && access.errorMessage) || (access.catalogAvailable && !access.modelIds.has(selectedSummary.id))) {
    const reason = access.errorMessage ||
      (selectedSummary?.id && access.catalogAvailable && !access.modelIds.has(selectedSummary.id)
        ? `Configured model "${selectedSummary.id}" is not available for this NVIDIA key. Import NVIDIA models again from Settings.`
        : "No active API keys configured. Running under local rule-engine fallback.");
    const fallbackText = buildServerFallbackSummary(promptWithLearning, {
      reason,
      debateAttempted: 0,
      debateSuccessful: 0,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...createTextPayload(fallbackText, selectedSummary?.id || "local-fallback"),
      debateUsed: false,
      fallbackUsed: true,
      fallbackReason: "Summary provider not configured; server-generated summary used.",
      debateAttempted: 0,
      debateSuccessful: 0,
      debateWorking: 0,
      meta: {
        debateUsed: false,
        debateAttempted: 0,
        debateSuccessful: 0,
        debateWorking: 0
      }
    });
    return;
  }

  const debateMode = body.debateMode || settings?.debateMode || "full";
  const mode = DEBATE_MODES[debateMode] || DEBATE_MODES.deep;

  const debatePool = buildDebatePool(debateModels, selectedSummary, mode.maxModels);
  if (!debatePool.length) {
    const direct = await requestAiModel({
      modelConfig: selectedSummary,
      prompt: promptWithLearning,
      temperature,
      systemPrompt: buildSummarySystemPrompt(),
      maxTokens: 1500,
    });
    if (!direct.ok) {
      const fallbackText = buildServerFallbackSummary(promptWithLearning, {
        reason: direct.message || "Summary model unavailable.",
        debateAttempted: 0,
        debateSuccessful: 0,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        ...createTextPayload(fallbackText, selectedSummary.id),
        debateUsed: false,
        fallbackUsed: true,
        fallbackReason: "Summary provider unavailable; server-generated summary used.",
        debateAttempted: 0,
        debateSuccessful: 0,
        debateWorking: 0,
        meta: {
          debateUsed: false,
          debateAttempted: 0,
          debateSuccessful: 0,
          debateWorking: 0
        }
      });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    direct.payload = enforceDirectionalOutput(direct.payload, promptWithLearning);
    res.status(200).json({
      ...direct.payload,
      debateUsed: false,
      fallbackUsed: false,
      debateAttempted: 0,
      debateSuccessful: 0,
      debateWorking: 0,
    });
    return;
  }

  const debateResults = await runWithConcurrency(
    debatePool,
    mode.concurrency,
    async (entry, index) => {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, index * 150));
      }
      let result = await requestAiModel({
        modelConfig: entry.modelConfig,
        prompt: buildDebateUserPrompt(promptWithLearning, entry.bias),
        temperature,
        systemPrompt: buildDebateSystemPrompt(),
        maxTokens: 220,
      }, { timeoutMs: mode.timeoutMs });

      // Useful retry check
      const shouldRetry = !result.ok && (
        result.statusCode === 429 ||
        result.statusCode === 422 ||
        result.statusCode === 500 ||
        result.statusCode === 502 ||
        result.statusCode === 503 ||
        result.statusCode === 504 ||
        /timeout|rate limit|internal server error|bad gateway|service unavailable/i.test(result.message || "")
      );

      if (shouldRetry) {
        result = await requestAiModel({
          modelConfig: entry.modelConfig,
          prompt: buildDebateUserPrompt(promptWithLearning, entry.bias),
          temperature,
          systemPrompt: buildDebateSystemPrompt(),
          maxTokens: 220,
        }, { timeoutMs: mode.timeoutMs });
      }

      return result;
    }
  );

  const allDebateEntries = debateResults.map((result, index) => ({
    result,
    model: debatePool[index],
  }));

  const successfulDebates = allDebateEntries.filter(
    (item) => item.result.ok && extractAiText(item.result.payload)
  );

  const failedDebates = allDebateEntries
    .filter((item) => !(item.result.ok && extractAiText(item.result.payload)))
    .map((item) => ({
      modelLabel: item.model?.modelConfig?.label || "",
      modelId: item.model?.modelConfig?.id || "",
      bias: item.model?.bias || "",
      statusCode: item.result?.statusCode || null,
      message: item.result?.message || "No usable output",
      hasPayload: Boolean(item.result?.payload),
      payloadPreview: item.result?.payload
        ? JSON.stringify(item.result.payload).slice(0, 300)
        : "",
    }));

  const debateConsensus = { buy: 0, sell: 0, wait: 0 };
  successfulDebates.forEach(item => {
    const text = extractAiText(item.result.payload).toLowerCase();
    const bias = item.model?.bias || "";
    // Use the assigned debate role as the primary consensus signal,
    // fall back to final-line keyword scan only for "both" roles.
    if (bias === "bullish") { debateConsensus.buy++; }
    else if (bias === "bearish") { debateConsensus.sell++; }
    else if (bias === "redteam") { debateConsensus.wait++; }
    else {
      // "both" role: scan the last 200 chars for the final verdict
      const tail = text.slice(-200);
      if (/\bbuy\b|\bbullish\b|\blong\b/i.test(tail)) debateConsensus.buy++;
      else if (/\bsell\b|\bbearish\b|\bshort\b/i.test(tail)) debateConsensus.sell++;
      else debateConsensus.wait++;
    }
  });

  if (!successfulDebates.length) {
    const directSummary = await requestAiModel({
      modelConfig: selectedSummary,
      prompt: promptWithLearning,
      temperature,
      systemPrompt: buildSummarySystemPrompt(),
      maxTokens: 900,
    }, { timeoutMs: 35000 });
    if (directSummary.ok) {
      res.setHeader("Cache-Control", "no-store");
      directSummary.payload = enforceDirectionalOutput(directSummary.payload, promptWithLearning);
      res.status(200).json({
        ...directSummary.payload,
        debateUsed: false,
        fallbackUsed: true,
        fallbackReason: "Debate models timed out or failed; used direct summary.",
        debateAttempted: debatePool.length,
        debateSuccessful: 0,
        debateWorking: 0,
        debateConsensus,
        debateFailures: failedDebates,
      });
      return;
    }
    const failMessages = debateResults.map((entry) => entry.message).filter(Boolean).join(" | ");
    const fallbackText = buildServerFallbackSummary(promptWithLearning, {
      reason: failMessages || directSummary.message || "All models timed out.",
      debateAttempted: debatePool.length,
      debateSuccessful: 0,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...createTextPayload(fallbackText, selectedSummary.id),
      debateUsed: false,
      fallbackUsed: true,
      fallbackReason: "All debate and summary models timed out; server-generated summary used.",
      debateAttempted: debatePool.length,
      debateSuccessful: 0,
      debateWorking: 0,
      debateConsensus,
      debateFailures: failedDebates,
    });
    return;
  }

  const consolidatedPrompt = buildConsolidatedPrompt(promptWithLearning, successfulDebates);
  const summaryResponse = await requestAiModel({
    modelConfig: selectedSummary,
    prompt: consolidatedPrompt,
    temperature,
    systemPrompt: buildSummarySystemPrompt(),
    maxTokens: 2500,
  }, { timeoutMs: 35000 });

  if (!summaryResponse.ok) {
    const debateFallbackConfigs = successfulDebates.map((d) => d.model.modelConfig);
    const fallbackSummary = await requestFirstAvailableSummary({
      summaryModels,
      extraModels: debateFallbackConfigs,
      skipKey: selectedSummary.key,
      prompt: consolidatedPrompt,
      temperature,
    });
    if (!fallbackSummary.ok) {
      const fallbackText = buildServerFallbackSummary(consolidatedPrompt, {
        reason: `Primary: ${summaryResponse.message}. Fallback: ${fallbackSummary.message}.`,
        debateAttempted: debatePool.length,
        debateSuccessful: successfulDebates.length,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        ...createTextPayload(fallbackText, selectedSummary.id),
        debateUsed: true,
        fallbackUsed: true,
        fallbackReason: "Both summary models timed out; server-generated summary used.",
        debateAttempted: debatePool.length,
        debateSuccessful: successfulDebates.length,
        debateWorking: successfulDebates.length,
        debateConsensus,
        debateFailures: failedDebates,
        debateResponses: successfulDebates.map(d => ({
          modelLabel: d.model.modelConfig.label,
          modelId: d.model.modelConfig.id,
          bias: d.model.bias,
          output: extractAiText(d.result.payload)
        }))
      });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    fallbackSummary.payload = enforceDirectionalOutput(fallbackSummary.payload, consolidatedPrompt);
    res.status(200).json({
      ...fallbackSummary.payload,
      debateUsed: true,
      fallbackUsed: true,
      requestedModel: selectedSummary.label || selectedSummary.id,
      debateAttempted: debatePool.length,
      debateSuccessful: successfulDebates.length,
      debateWorking: successfulDebates.length,
      debateConsensus,
      debateFailures: failedDebates,
      debateResponses: successfulDebates.map(d => ({
        modelLabel: d.model.modelConfig.label,
        modelId: d.model.modelConfig.id,
        bias: d.model.bias,
        output: extractAiText(d.result.payload)
      }))
    });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  summaryResponse.payload = enforceDirectionalOutput(summaryResponse.payload, consolidatedPrompt);
  res.status(200).json({
    ...summaryResponse.payload,
    debateUsed: true,
    fallbackUsed: false,
    debateAttempted: debatePool.length,
    debateSuccessful: successfulDebates.length,
    debateWorking: successfulDebates.length,
    debateConsensus,
    debateFailures: failedDebates,
    debateResponses: successfulDebates.map(d => ({
      modelLabel: d.model.modelConfig.label,
      modelId: d.model.modelConfig.id,
      bias: d.model.bias,
      output: extractAiText(d.result.payload)
    }))
  });
};

function createTextPayload(text, modelId) {
  const content = String(text || "").trim();
  return {
    model: modelId || "server-fallback",
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}

function buildServerFallbackSummary(promptText, meta = {}) {
  const text = String(promptText || "");

  const field = (pattern) => {
    const match = pattern.exec(text);
    return match?.[1]?.trim() || "";
  };

  const decisionLine = field(/Rule Engine Direction:\s*([^\n]+)/i) || "Stay Flat";
  const priceLine = field(/Current Price:\s*([^\n]+)/i) || "n/a";
  const timeframeLine = field(/Timeframe:\s*([^\n]+)/i) || "n/a";
  const trendLine = field(/Trend:\s*([^\n]+)/i) || "n/a";
  const rmiLine = field(/RMI:\s*([^\n]+)/i) || "n/a";
  const fvgs = field(/Fair Value Gaps:\s*([^\n]+)/i) || "none";
  
  const direction =
    /sell|bear/i.test(decisionLine) ? "Sell" :
    /buy|bull/i.test(decisionLine) ? "Buy" :
    "Stay Flat";

  const isFlat = direction === "Stay Flat";
  const summaryText = isFlat
    ? "Local arbiter enforced Stay Flat using rule-engine confluence while the upstream AI model is unavailable."
    : `Local arbiter accepted the ${direction} bias using rule-engine confluence while the upstream AI model is unavailable.`;
    
  const fallbackReason = sanitizeProviderFailureReason(meta.reason);
  const riskNoteText = `${fallbackReason} Local scorecard is deterministic and should be treated as a safety fallback, not an AI consensus.`;

  return JSON.stringify({
    researcher: {
      summary: summaryText,
      direction: direction,
      riskNote: riskNoteText
    },
    trader: {
      entryZone: isFlat ? "N/A" : `Wait for confirmation near ${priceLine} structure.`,
      takeProfitLevels: isFlat ? "N/A" : "T1 at nearby liquidity, T2 at next displacement leg, runner after break-even.",
      stopLoss: isFlat ? "N/A" : "Invalidate beyond the opposite structural close.",
      positionSizing: isFlat ? "N/A" : "Use reduced risk until a configured AI model confirms the setup.",
      timeHorizon: isFlat ? "N/A" : "Intraday",
      invalidation: isFlat ? "N/A" : "Opposite structural close."
    },
    equations: {
      review: `Momentum: RMI momentum: ${rmiLine}. Volatility/structure: Trend alignment: ${trendLine}. Crowding proxy: FVG impulse: ${fvgs}.`
    }
  });
}

function sanitizeProviderFailureReason(reason) {
  const text = String(reason || "").trim();
  if (!text) {
    return "AI provider is not configured.";
  }
  if (/HTTP\s*(401|403)|forbidden|unauthorized|invalid api key|permission/i.test(text)) {
    return "NVIDIA rejected the configured API key. Re-save a valid NVIDIA key in Settings, then import NVIDIA models so the app can use a model available to that key.";
  }
  if (/HTTP\s*404|not found|model/i.test(text)) {
    return "The configured NVIDIA model is not available to this key. Import NVIDIA models again from Settings and select one of the imported models.";
  }
  return text.replace(/\bAI HTTP\s*\d+\b/gi, "AI provider error");
}

function buildDebatePool(debateModels, selectedSummary, maxModels = 20) {
  const normalizedDebates = Array.isArray(debateModels) ? debateModels : [];
  const uniqueDebates = dedupeModels(normalizedDebates.filter((model) => model.id && model.apiKey));
  const leftover = dedupeModels(
    uniqueDebates.filter(
      (model) =>
        model.id &&
        model.apiKey &&
        isChatCapableModel(model.id) &&
        model.isDebateParticipant &&
        model.key !== selectedSummary.key,
    ),
  );

  const capped = shuffleAndCap(leftover.filter((model) => model.id && model.apiKey), maxModels);
  return assignDebateBiasTeams(capped);
}

function isChatCapableModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  // Reject known non-chat model categories
  const nonChatPatterns = [
    /\bembed/,          // embedding models (nv-embed, embed-qa, embedcode, etc.)
    /\brerank/,         // reranking models
    /\bsafety/,         // safety classifiers (content-safety, safety-guard)
    /\bguard/,          // guard models (llama-guard, nemoguard)
    /\bclip\b/,         // CLIP models
    /\bdeplot\b/,       // chart-to-table models
    /\bparse\b/,        // document parsing models
    /\bretriever/,      // retrieval models
    /\breward\b/,       // reward models
    /\bcalibration/,    // calibration models
    /\bpii\b/,          // PII detection models
    /\bvideo-detector/,   // video analysis models
    /\bkosmos/,         // multimodal non-chat models
    /\bneva\b/,         // vision-only models
    /\bvila\b/,         // vision-language (non-chat)
    /\btranslate/,      // translation models
    /\bfuyu\b/,         // vision-only models
    /\bbge-/,           // BGE embedding models
    /\barctic-embed/,   // Snowflake embedding
    /\brecurrentgemma/,  // non-instruct base models
    /\bgemma-2b$/,      // base model without instruct
    /\bstarcoder/,      // code completion only
    /\bcodellama/,      // code completion only (no chat)
    /\bcodegemma/,      // code completion only
    /\bomni.*reasoning/, // multimodal reasoning (non-standard chat)
    /\bmultimodal/,     // multimodal (non-standard chat)
    /\bvision/,         // vision models need image input
  ];
  return !nonChatPatterns.some((pattern) => pattern.test(id));
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

function rebalanceModelPools(summaryModels, debateModels) {
  const summaries = dedupeModels(Array.isArray(summaryModels) ? summaryModels : []);
  const debates = dedupeModels(Array.isArray(debateModels) ? debateModels : []);

  if (summaries.length === 0 && debates.length > 0) {
    return { summaryModels: [debates[0]], debateModels: debates.slice(1) };
  }

  // Allow overlap: models in the primary library can also be in the debate list.
  // The debate pool builder dynamically excludes the active Lead Arbiter model.
  return {
    summaryModels: summaries,
    debateModels: debates,
  };
}

function assignDebateBiasTeams(models) {
  const total = models.length;
  if (total === 0) {
    return [];
  }
  
  // If we have at least 3 models, one MUST be the Red-Team Critic
  const hasRedTeam = total >= 2;
  const midpoint = Math.floor(total / (hasRedTeam ? 2.5 : 2));

  return models.map((model, index) => {
    let bias = "both";
    
    // Assign the last model to the Red-Team if eligible
    if (hasRedTeam && index === total - 1) {
      bias = "redteam";
    } else if (total % 2 === 0) {
      bias = index < midpoint ? "bullish" : "bearish";
    } else if (index < midpoint) {
      bias = "bullish";
    } else if (index < midpoint * 2) {
      bias = "bearish";
    } else {
      bias = "both";
    }
    return { modelConfig: model, bias };
  });
}

async function resolveWorkingNvidiaAccess({ summaryModels, debateModels, fallbackModel, globalKeys }) {
  const candidates = [];
  const pushCandidate = (apiKey, baseUrl) => {
    const cleanKey = String(apiKey || "").trim();
    if (!cleanKey) return;
    const cleanBase = sanitizeBaseUrl(baseUrl || DEFAULT_BASE_URL);
    const token = `${cleanBase}|${cleanKey}`;
    if (!candidates.some((item) => item.token === token)) {
      candidates.push({ apiKey: cleanKey, baseUrl: cleanBase, token });
    }
  };

  pushCandidate(fallbackModel?.apiKey, fallbackModel?.baseUrl);
  [...(summaryModels || []), ...(debateModels || [])].forEach((model) => pushCandidate(model?.apiKey, model?.baseUrl));
  (Array.isArray(globalKeys) ? globalKeys : []).forEach((key) => pushCandidate(key, DEFAULT_BASE_URL));

  if (!candidates.length) {
    return { ok: false, catalogAvailable: false, modelIds: new Set(), errorMessage: "No NVIDIA API key is configured." };
  }

  const errors = [];
  for (const candidate of candidates) {
    const catalog = await fetchNvidiaModelCatalog(candidate);
    if (catalog.ok) {
      let validationModel = pickNvidiaSmokeTestModel(catalog.models);
      if (!validationModel) {
        errors.push("NVIDIA returned a model catalog, but no chat-capable validation model was found.");
        continue;
      }
      let smoke = await validateNvidiaChatAccess({
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        modelId: validationModel.id,
      });
      // If the chosen validation model returned an empty-output error,
      // retry with a different preferred model before giving up on this key.
      if (!smoke.ok && smoke.emptyOutputModel) {
        const retryModel = pickNvidiaSmokeTestModel(catalog.models, smoke.emptyOutputModel);
        if (retryModel) {
          smoke = await validateNvidiaChatAccess({
            apiKey: candidate.apiKey,
            baseUrl: candidate.baseUrl,
            modelId: retryModel.id,
          });
          if (!smoke.ok && smoke.emptyOutputModel) {
            // Both tried models returned empty output — key is valid, accept it.
            smoke = { ok: true };
          }
        } else {
          // No alternative model to try — treat empty output as key-valid.
          smoke = { ok: true };
        }
      }
      if (!smoke.ok) {
        errors.push(smoke.message || `NVIDIA chat validation failed for ${validationModel.id}.`);
        continue;
      }
      return {
        ok: true,
        catalogAvailable: true,
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        modelIds: catalog.modelIds,
        models: catalog.models,
      };
    }
    errors.push(catalog.message);
  }

  return {
    ok: false,
    catalogAvailable: false,
    modelIds: new Set(),
    errorMessage: `NVIDIA key validation failed: ${errors.filter(Boolean).join(" | ") || "Unable to fetch model catalog."}`,
  };
}

async function fetchNvidiaModelCatalog(candidate) {
  const cacheKey = `${candidate.baseUrl}|${candidate.apiKey.slice(0, 12)}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) {
    return cached.value;
  }

  try {
    const response = await fetch(`${candidate.baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${candidate.apiKey}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const value = {
        ok: false,
        message: payload?.error?.message || payload?.message || `NVIDIA models HTTP ${response.status}`,
      };
      modelCatalogCache.set(cacheKey, { createdAt: Date.now(), value });
      return value;
    }
    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((item) => ({ id: String(item?.id || "").trim(), label: String(item?.id || "").trim() }))
          .filter((item) => item.id)
      : [];
    const value = { ok: true, models, modelIds: new Set(models.map((model) => model.id)) };
    modelCatalogCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  } catch (error) {
    return { ok: false, message: error?.message || "Unable to reach NVIDIA model catalog." };
  }
}

function pickNvidiaSmokeTestModel(models, excludeId = null) {
  const list = Array.isArray(models) ? models : [];
  // Prefer smaller/faster models for smoke test — gpt-oss-120b can return
  // empty content with very low max_tokens, causing false key-validation failures.
  const preferred = [
    "meta/llama-3.1-8b-instruct",
    "mistralai/mistral-7b-instruct-v0.3",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.3-70b-instruct",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
  ];
  return preferred
    .filter((id) => id !== excludeId)
    .map((id) => list.find((model) => model.id === id))
    .find(Boolean) ||
    list.find((model) => model.id !== excludeId && /(?:instruct|chat|gpt-oss)/i.test(model.id));
}

async function validateNvidiaChatAccess({ apiKey, baseUrl, modelId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${sanitizeBaseUrl(baseUrl || DEFAULT_BASE_URL)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.1,
        // Use 32 tokens — enough for any model to produce a short reply.
        // 4 tokens was too low and caused NVIDIA to return the
        // "model output must contain either output text or tool calls" error,
        // which incorrectly failed the key validation step.
        max_tokens: 32,
        stream: false,
        messages: [
          { role: "system", content: "You are a helpful assistant. Always respond with a short text answer." },
          { role: "user", content: "Say the word 'OK' and nothing else." },
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg = payload?.error?.message || payload?.message || `NVIDIA chat validation HTTP ${response.status}`;
      // Treat the "empty output" error as a key-is-valid signal.
      // It just means this particular model returned no tokens — the key itself works.
      if (/model output must contain|output text or tool calls/i.test(errMsg)) {
        return { ok: true, emptyOutputModel: modelId };
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
      return { ok: false, statusCode: 504, message: `NVIDIA chat validation timed out for ${modelId}.` };
    }
    return { ok: false, statusCode: 502, message: error?.cause?.code ? `${error.message} (${error.cause.code})` : error?.message };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveBestModelReplacement(modelId, availableModels) {
  const list = Array.isArray(availableModels) ? availableModels : [];
  if (list.length === 0) return modelId;

  const id = String(modelId || "").toLowerCase().trim();
  
  // 1. Exact match (case-insensitive)
  const exactMatch = list.find((m) => String(m.id || "").toLowerCase().trim() === id);
  if (exactMatch) return exactMatch.id;

  // 2. Extract key features of model ID to find similar family/size
  const isLlama = id.includes("llama");
  const isGemma = id.includes("gemma");
  const isMistral = id.includes("mistral");
  const is70B = id.includes("70b");
  const is8B = id.includes("8b");

  // First try: Same family AND same size
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

  // Second try: Same family
  match = list.find((m) => {
    const mId = String(m.id || "").toLowerCase();
    if (isLlama && mId.includes("llama")) return true;
    if (isGemma && mId.includes("gemma")) return true;
    if (isMistral && mId.includes("mistral")) return true;
    return false;
  });
  if (match) return match.id;

  // Third try: Pick preferred smoke test validation model if present
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

  // Fourth try: Fall back to first available model in list
  return list[0].id;
}

function applyWorkingNvidiaAccess(models, access, options = {}) {
  if (!Array.isArray(models) || !access?.ok) return Array.isArray(models) ? models : [];
  const usable = models
    .filter((model) => model?.id)
    .map((model) => {
      let finalId = model.id;
      if (access.catalogAvailable && !access.modelIds.has(model.id)) {
        finalId = resolveBestModelReplacement(model.id, access.models);
      }
      return {
        ...model,
        id: finalId,
        apiKey: access.apiKey,
        baseUrl: access.baseUrl || model.baseUrl || DEFAULT_BASE_URL,
      };
    });

  if (usable.length > 0 || !options.fillFromCatalog || !Array.isArray(access.models) || access.models.length === 0) {
    return usable;
  }

  return access.models.slice(0, 6).map((model, index) => normalizeOneModel({
    key: model.id,
    id: model.id,
    label: model.label || model.id,
    apiKey: access.apiKey,
    baseUrl: access.baseUrl || DEFAULT_BASE_URL,
    isDebateParticipant: index > 0,
  }));
}

async function requestFirstAvailableSummary({ summaryModels, extraModels, skipKey, prompt, temperature }) {
  const primaryCandidates = dedupeModels(summaryModels).filter((model) => model.key !== skipKey && model.id && model.apiKey);
  const extraCandidates = dedupeModels(Array.isArray(extraModels) ? extraModels : []).filter((model) => model.key !== skipKey && model.id && model.apiKey);
  const allCandidates = dedupeModels([...primaryCandidates, ...extraCandidates]).slice(0, 4);
  for (const model of allCandidates) {
    const result = await requestAiModel({
      modelConfig: model,
      prompt,
      temperature,
      systemPrompt: buildSummarySystemPrompt(),
      maxTokens: 950,
    }, { timeoutMs: 30000 });
    if (result.ok) {
      return result;
    }
  }
  return { ok: false, statusCode: 502, message: "No summary fallback model responded." };
}

async function requestAiModel({ modelConfig, prompt, temperature, systemPrompt, maxTokens }, options = {}) {
  const modelId = String(modelConfig?.id || "");
  const maxAttempts = 2;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : modelId.includes("gemma")
        ? 40000
        : 25000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const upstreamResponse = await fetch(`${sanitizeBaseUrl(modelConfig.baseUrl || DEFAULT_BASE_URL)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${modelConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
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

      const payload = await upstreamResponse.json().catch(() => ({}));
      
      // If we get rate limited (429) or transient server errors (5xx), wait and retry
      if (upstreamResponse.status === 429 || upstreamResponse.status >= 500) {
        if (attempt < maxAttempts) {
          clearTimeout(timeout);
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
      }

      if (!upstreamResponse.ok) {
        const errMsg = payload?.error?.message || payload?.message || `AI HTTP ${upstreamResponse.status}`;
        // If the NVIDIA API returns the "empty output" error, the model produced
        // no tokens. This is a model-level issue.
        if (/model output must contain|output text or tool calls/i.test(errMsg)) {
          return {
            ok: false,
            statusCode: 422,
            message: `Model "${modelId}" returned an empty response (no output tokens). Try a different model or increase max_tokens.`,
          };
        }
        return {
          ok: false,
          statusCode: upstreamResponse.status,
          message: errMsg,
        };
      }

      // Guard: NVIDIA sometimes returns HTTP 200 but with empty content.
      const responseText = payload?.choices?.[0]?.message?.content;
      if (upstreamResponse.ok && (responseText === null || responseText === "")) {
        return {
          ok: false,
          statusCode: 422,
          message: `Model "${modelId}" returned an HTTP 200 but with empty content. Try a different model.`,
        };
      }

      return { ok: true, payload };
    } catch (error) {
      if (attempt < maxAttempts) {
        clearTimeout(timeout);
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }
      if (error?.name === "AbortError") {
        return { ok: false, statusCode: 504, message: `Provider timeout for model ${modelId}.` };
      }
      return { ok: false, statusCode: 502, message: error?.message || `AI request failed for ${modelId}.` };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildDebateSystemPrompt() {
  return [
    "You are a low-latency XAUUSD analyst. Response must be under 150 words.",
    "Focus on CRT patterns, Liquidity sweeps, and Displacement.",
    "Identify best POI (OB/FVG) for bias. Grade setup quality.",
    getDebateKnowledge(),
  ].join("\n");
}

function buildSummarySystemPrompt() {
  return [
    "You are the Lead Institutional Arbiter for XAUUSD. Your role is to synthesize inputs into a final execution plan.",
    "--- CRITICAL JSON OUTPUT REQUIRED ---",
    "You MUST output exactly one valid JSON object. Do not wrap it in markdown blocks. Do not include any other text.",
    "The JSON MUST match this exact structure:",
    "{",
    "  \"researcher\": {",
    "    \"summary\": \"Explain the institutional narrative. You MUST explicitly reference HTF Alignment, FVGs, active Liquidity Pools, Session Levels, and Liquidity Sweeps in your overview. If Red-Team identifies a trap, prioritize it.\",",
    "    \"direction\": \"Buy\", \"Sell\", or \"Stay Flat\",",
    "    \"riskNote\": \"Summarize the RED-TEAM CRITIC's strongest argument.\"",
    "  },",
    "  \"trader\": {",
    "    \"entryZone\": \"Exact price range or 'N/A'\",",
    "    \"takeProfitLevels\": \"T1, T2, T3 or 'N/A'\",",
    "    \"stopLoss\": \"Specific price or 'N/A'\",",
    "    \"positionSizing\": \"Recommended position size (e.g. 'Risk 1% of portfolio') or 'N/A'\",",
    "    \"timeHorizon\": \"Expected hold time (e.g. '1-4 hours') or 'N/A'\",",
    "    \"invalidation\": \"Specific trigger or structural failure point\"",
    "  },",
    "  \"equations\": {",
    "    \"review\": \"Discuss Equation 1 (Momentum), Equation 2 (Volatility), Equation 3 (Max-Pain).\"",
    "  }",
    "}",
    "",
    "--- CRITICAL LOGICAL HIERARCHY ---",
    "1. SYNTHESIS FIRST: Your 'researcher.summary' is the absolute source of truth.",
    "2. NO CONTRADICTIONS: If your summary says 'Stay Flat' or 'Avoid', researcher.direction MUST be 'Stay Flat'. NEVER put a bullish/bearish direction if invalid.",
    "3. STAY FLAT SUPPRESSES LEVELS: If direction is 'Stay Flat', all trader fields EXCEPT 'invalidation' MUST be exactly 'N/A'. Do NOT provide price levels. This prevents the operator from trading an invalid setup.",
    "4. ACTIVE TRADE REQUIRES LEVELS: If direction is 'Buy' or 'Sell', trader.entryZone MUST contain a specific numeric price range and TP/SL/sizing MUST be populated.",
    "5. MANDATORY INVALIDATION: trader.invalidation MUST always contain a specific price or structural event (e.g. 'A 15m candle close above 4541.73').",
    "",
    getSummaryKnowledge(),
  ].join("\n");
}


function buildDebateUserPrompt(basePrompt, bias) {
  let biasGuide = "";
  
  if (bias === "redteam") {
    biasGuide = "Debate role: RED-TEAM CRITIC (Adversarial). Find reasons NOT to trade. Identify hidden traps: Gamma Traps (Price pinned at Max Pain), Options Walls, Inducement not swept, HTF supply/demand proximity, low-volume profile, or news risk. Be extremely skeptical. State the strongest counter-argument and the price level that would invalidate the current bias.";
  } else if (bias === "bullish") {
    biasGuide = "Debate role: BULLISH TEAM. Prioritize bullish continuation/reversal evidence using SMC frameworks (CHoCH→BOS, OB, FVG, liquidity sweep, displacement). Challenge bearish assumptions but report invalidation honestly.";
  } else if (bias === "bearish") {
    biasGuide = "Debate role: BEARISH TEAM. Prioritize bearish continuation/reversal evidence using SMC frameworks (CHoCH→BOS, OB, FVG, liquidity sweep, displacement). Challenge bullish assumptions but report invalidation honestly.";
  } else {
    biasGuide = "Debate role: BALANCED TEAM. Evaluate both sides using SMC/ICT confluence scoring. State which side has more confluences (OB, FVG, Premium/Discount zone, Kill Zone, displacement, HTF alignment).";
  }

  return [
    basePrompt,
    "",
    biasGuide,
    "Required mini-format:",
    "1) Bias Case (with CHoCH/BOS status and Premium/Discount zone)",
    "2) Structural Evidence (OB, FVG, liquidity levels, displacement)",
    "3) Entry/Trigger Zone (MUST provide exact price range from the data, ideally at OTE 70.5% of impulse)",
    "4) Target Levels (Specify T1, T2, T3 based on the nearest institutional liquidity pools/OB/FVG)",
    "5) Invalidation (structural close, not just wick)",
    "6) Confluence Score (how many of: HTF aligned, OB, FVG, zone, sweep, Kill Zone, displacement)",
  ].join("\n");
}

function buildConsolidatedPrompt(basePrompt, successfulDebates) {
  const sections = successfulDebates.map((entry, index) => {
    const content = extractAiText(entry.result.payload) || "";
    const roleLabel = entry.model.bias === "redteam" ? "RED-TEAM CRITIC (Adversarial Review)" : `Debate Analyst ${index + 1} [${String(entry.model.bias || "both").toUpperCase()}]`;
    return `${roleLabel} (${entry.model.modelConfig.label || entry.model.modelConfig.id}):\n${content.trim()}`;
  });

  return [
    "Primary Market Context and Rule Engine Baseline:",
    basePrompt,
    "",
    "Parallel Debate Outputs (including Adversarial Red-Team):",
    sections.join("\n\n"),
    "",
    "Task: As the Lead Arbiter, weigh the bullish, bearish, and RED-TEAM CRITIC evidence using the SMC/ICT/CRT framework. You MUST perform 'Adversarial Synthesis'—if the Red-Team identifies a critical structural trap (e.g., Gamma Trap at Max Pain), you MUST factor this heavily into your riskNote and final direction. Resolve conflicts by checking: 1) HTF structure alignment, 2) Premium/Discount zone, 3) Liquidity sweep, 4) Kill Zone timing, 5) Options Sentiment. Output one final direction. You MUST comply and output EXACTLY the JSON structure requested in the system prompt.",
  ].join("\n");
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

function setAiText(payload, text) {
  if (payload?.choices?.[0]?.message) {
    payload.choices[0].message.content = text;
    return payload;
  }
  if (payload?.output?.[0]?.content?.[0]) {
    payload.output[0].content[0].text = text;
    return payload;
  }
  payload.text = text;
  return payload;
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
  } catch (e) {
    return setAiText(payload, JSON.stringify(buildStructuredSummaryFromText(aiText, contextPrompt), null, 2));
  }

  return payload;
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
  const priceMatch = /Current Price:\s*([^\n]+)/i.exec(context);
  const priceLine = priceMatch?.[1]?.trim() || "current market price";

  return {
    researcher: {
      summary: raw || "AI response did not include a narrative summary.",
      direction,
      riskNote: "AI response was normalized into the required JSON trade-plan format."
    },
    trader: {
      entryZone: isFlat ? "N/A" : `Wait for confirmation near ${priceLine} structure.`,
      takeProfitLevels: isFlat ? "N/A" : "Use nearest liquidity as T1, next displacement leg as T2, then trail after break-even.",
      stopLoss: isFlat ? "N/A" : "Invalidate beyond the opposite structural close.",
      positionSizing: isFlat ? "N/A" : "Use reduced risk until clean execution confirmation.",
      timeHorizon: isFlat ? "N/A" : "Intraday",
      invalidation: isFlat ? "Re-evaluate after a confirmed CHoCH/BOS with displacement." : "Opposite structural close."
    },
    equations: {
      review: "AI response did not provide a dedicated equations block; use the generated market equations panel for momentum, volatility, and max-pain context."
    }
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
    globalKeys: cleanGlobalKeys,
  };
}

function pickNvidiaKeyByIndex(pool, index = 0) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return "";
  }
  const safeIndex = Math.abs(Number(index) || 0) % pool.length;
  return String(pool[safeIndex] || "").trim();
}

// pickRandomNvidiaKey removed — unused dead code. Use pickNvidiaKeyByIndex instead.

function normalizeNvidiaKeyPool(listValue, legacyValue) {
  const list = Array.isArray(listValue) ? listValue : [];
  const combined = [...list, legacyValue]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const unique = [];
  for (const key of combined) {
    if (!unique.includes(key)) {
      unique.push(key);
    }
  }
  return unique;
}

function dedupeModels(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    const key = String(model?.key || "").trim();
    const id = String(model?.id || "").trim();
    const token = key || id;
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(model);
  }
  return out;
}

function sanitizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function safeLoadSettings() {
  try {
    return (await getAdminSettings()) || null;
  } catch {
    return null;
  }
}

async function safeLoadLearningContext() {
  try {
    const db = getFirestore();
    const snap = await db.collection("learning").doc("global").get();
    const data = snap.exists ? snap.data() || {} : {};
    let total = Number(data.total || 0);
    let wins = Number(data.wins || 0);
    let topLossReasons = Array.isArray(data.topLossReasons) ? data.topLossReasons.slice(0, 8) : [];
    const topWinPatterns = Array.isArray(data.topWinPatterns) ? data.topWinPatterns.slice(0, 8) : [];

    if (!total || topLossReasons.length === 0) {
      const feedbackSnap = await db
        .collection("learning_feedback")
        .orderBy("createdAt", "desc")
        .limit(250)
        .get();
      const reasonCounts = new Map();
      total = feedbackSnap.size;
      wins = 0;
      feedbackSnap.docs.forEach((doc) => {
        const row = doc.data() || {};
        if (String(row.outcome || "") === "win") {
          wins += 1;
        }
        if (String(row.outcome || "") === "loss") {
          const reason = String(row.reason || "").trim();
          if (reason) {
            reasonCounts.set(reason, Number(reasonCounts.get(reason) || 0) + 1);
          }
        }
      });
      topLossReasons = [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    }

    const latestModelLessons = Array.isArray(data.latestModelLessons)
      ? data.latestModelLessons
          .map((item) => String(item?.lesson || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];

    // Enhanced: timeframe and direction stats
    const timeframeStats = data.timeframeStats || {};
    const directionStats = data.directionStats || {};
    const currentStreak = Number(data.currentStreak || 0);
    const currentStreakType = String(data.currentStreakType || "");
    const bestWinStreak = Number(data.bestWinStreak || 0);
    const worstLossStreak = Number(data.worstLossStreak || 0);

    return {
      total,
      winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0,
      topLossReasons,
      topWinPatterns,
      latestModelLessons,
      timeframeStats,
      directionStats,
      currentStreak,
      currentStreakType,
      bestWinStreak,
      worstLossStreak,
    };
  } catch {
    return { total: 0, winRate: 0, topLossReasons: [], topWinPatterns: [], latestModelLessons: [], timeframeStats: {}, directionStats: {}, currentStreak: 0, currentStreakType: "", bestWinStreak: 0, worstLossStreak: 0 };
  }
}

function appendLearningContext(prompt, context) {
  const reasons = Array.isArray(context?.topLossReasons) ? context.topLossReasons.slice(0, 3) : [];
  const wins = Array.isArray(context?.topWinPatterns) ? context.topWinPatterns.slice(0, 3) : [];
  const lessons = Array.isArray(context?.latestModelLessons) ? context.latestModelLessons.slice(0, 3) : [];
  const tfStats = context?.timeframeStats || {};
  const dirStats = context?.directionStats || {};

  const sections = [];

  // Main header
  sections.push("Global Learning Memory (from previous analyses across all users):");
  sections.push(`Historical samples: ${Number(context?.total || 0)}, win rate: ${Number(context?.winRate || 0)}%`);

  // Streak info
  if (context?.currentStreak > 0 && context?.currentStreakType) {
    sections.push(`Current streak: ${context.currentStreak} consecutive ${context.currentStreakType.toUpperCase()}s.`);
  }
  if (context?.worstLossStreak > 2) {
    sections.push(`Worst loss streak ever: ${context.worstLossStreak}. Be cautious about marginal setups.`);
  }

  // Timeframe performance
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

  // Direction performance
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

  if (wins.length > 0) {
    const winBlock = wins
      .map((item, index) => `${index + 1}. ${String(item?.reason || "").trim()} (count=${Number(item?.count || 0)})`)
      .filter((line) => line.includes(".") && line.length > 6)
      .join("\n");
    if (winBlock) {
      sections.push("Successful patterns to preserve:");
      sections.push(winBlock);
    }
  }

  // Loss reasons
  if (reasons.length > 0) {
    const reasonBlock = reasons
      .map((item, index) => `${index + 1}. ${String(item?.reason || "").trim()} (count=${Number(item?.count || 0)})`)
      .filter((line) => line.includes(".") && line.length > 6)
      .join("\n");
    if (reasonBlock) {
      sections.push("Avoid repeating these common failure patterns:");
      sections.push(reasonBlock);
    }
  }

  // Model lessons
  if (lessons.length > 0) {
    sections.push("Latest model-improvement notes:");
    sections.push(lessons.map((item, index) => `${index + 1}. ${item}`).join("\n"));
  }

  if (sections.length <= 2) {
    return prompt;
  }

  sections.push("Apply this memory as hard risk filters when generating the final decision.");
  return [prompt, "", ...sections].join("\n");
}

async function getRequestBody(req) {
  if (req?.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req?.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
