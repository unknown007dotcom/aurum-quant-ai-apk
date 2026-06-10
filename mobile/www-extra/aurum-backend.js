/*
 * Aurum Quant AI — ON-DEVICE BACKEND
 * ----------------------------------
 * Replaces the Vercel + Cloudflare backend. Installs a fetch() interceptor that
 * answers the SAME requests the UI already makes (to EDGE_API_BASE/...), but runs
 * everything locally on the phone:
 *   - /market-mtf   -> calls OANDA (or Twelve Data) directly for candles
 *   - /live-price   -> calls OANDA / Twelve Data directly
 *   - /ai-decision  -> calls NVIDIA chat completions directly (+ local learning memory)
 *   - /settings     -> reads/writes keys on-device (Capacitor Preferences/localStorage)
 *   - /history-log  -> stores analysis history ON THE DEVICE
 *   - /learning-context, /learning-feedback -> local self-learning
 *   - /bot          -> local offline status
 *
 * Keys are NOT shipped in the app. You paste them once in the in-app Settings.
 *
 * Must load BEFORE app.js so the interceptor is active before any request fires.
 */
(function () {
  "use strict";

  var DEFAULT_AI_BASE = "https://integrate.api.nvidia.com/v1";
  var DEFAULT_INSTRUMENT = "XAU_USD";
  var SETTINGS_PREF_KEY = "aurum_device_settings_v1";
  var HISTORY_PREF_KEY = "aurum_device_history_v1";
  var LESSONS_PREF_KEY = "aurum_device_lessons_v1";

  var GRAN = {
    "1min": "M1", "5min": "M5", "15min": "M15",
    "1h": "H1", "4h": "H4", "1day": "D", "1week": "W", "1month": "M",
  };
  var DEFAULT_TWELVE_KEY = "23c57edf48e541e48db2806575f58bf7";

  var Cap = window.Capacitor || null;
  var Preferences = Cap && Cap.Plugins ? Cap.Plugins.Preferences : null;
  var BackgroundRunner = Cap && Cap.Plugins ? Cap.Plugins.BackgroundRunner : null;

  // ---- Background Runner KV bridge ----
  // The background task (runners/aurum-runner.js) runs in an isolated context and
  // reads/writes CapacitorKV. We mirror the needed data there from the WebView.
  async function runnerSetKV(key, obj) {
    if (!BackgroundRunner) return;
    try {
      await BackgroundRunner.dispatchEvent({
        label: "ai.aurumquant.app.scan",
        event: "setKV",
        details: { key: key, value: JSON.stringify(obj) },
      });
    } catch (e) {}
  }
  async function syncRunnerSettings() {
    if (!BackgroundRunner) return;
    var s = await getSettings();
    await runnerSetKV("runner_settings", {
      oandaApiToken: s.oandaApiToken || "",
      oandaEnvironment: s.oandaEnvironment || "practice",
      oandaAccountId: s.oandaAccountId || "",
      twelveDataKeys: collectTwelveKeys(s),
      botInstrument: normInstrument(s.botInstrument || DEFAULT_INSTRUMENT),
    });
  }
  // Push current pending signals to the runner so it can alert when app is closed.
  async function syncRunnerSignals() {
    if (!BackgroundRunner) return;
    var h = await getHistory();
    var pending = h.filter(function (e) { return e && !e.outcome && e.direction && (isFinite(e.entry) || isFinite(e.tp1)); })
      .slice(-20)
      .map(function (e) {
        var spread = isFinite(e.entry) ? Math.max(0.5, Math.abs((e.tp1 || e.entry) - e.entry) * 0.05) : 1.0;
        return {
          id: String(e.id),
          direction: e.direction,
          entryLow: isFinite(e.entryLow) ? e.entryLow : (isFinite(e.entry) ? e.entry - spread : NaN),
          entryHigh: isFinite(e.entryHigh) ? e.entryHigh : (isFinite(e.entry) ? e.entry + spread : NaN),
          tp1: e.tp1, tp2: e.tp2, sl: e.sl, alerted: false,
        };
      });
    await runnerSetKV("runner_signals", pending);
  }
  // Pull outcomes the runner detected while the app was closed, fold into history.
  async function pullRunnerOutcomes() {
    if (!BackgroundRunner) return;
    try {
      var res = await BackgroundRunner.dispatchEvent({
        label: "ai.aurumquant.app.scan",
        event: "getKV",
        details: { key: "runner_outcomes" },
      });
      var raw = res && (res.value || res.result || res);
      var outcomes = raw ? JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) : [];
      if (Array.isArray(outcomes) && outcomes.length) {
        var h = await getHistory();
        outcomes.forEach(function (o) {
          for (var i = 0; i < h.length; i++) {
            if (String(h[i].id) === String(o.id) && !h[i].outcome) { h[i].outcome = o.outcome; }
          }
        });
        await setHistory(h);
        await runnerSetKV("runner_outcomes", []);
      }
    } catch (e) {}
  }

  // ---------------- storage ----------------
  async function prefGet(key) {
    try {
      if (Preferences) {
        var r = await Preferences.get({ key: key });
        return r && r.value ? JSON.parse(r.value) : null;
      }
    } catch (e) {}
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  async function prefSet(key, value) {
    var json = JSON.stringify(value);
    try { if (Preferences) { await Preferences.set({ key: key, value: json }); return; } } catch (e) {}
    try { localStorage.setItem(key, json); } catch (e) {}
  }

  async function getSettings() {
    return (await prefGet(SETTINGS_PREF_KEY)) || {};
  }
  async function saveSettings(patch) {
    var cur = await getSettings();
    var next = Object.assign({}, cur, patch || {});
    await prefSet(SETTINGS_PREF_KEY, next);
    return next;
  }

  // ---------------- helpers ----------------
  function normInstrument(v) {
    return String(v || DEFAULT_INSTRUMENT).trim().toUpperCase().replace("/", "_");
  }
  function clampInt(v, def, lo, hi) {
    var n = parseInt(String(v), 10);
    if (!isFinite(n)) n = def;
    return Math.max(lo, Math.min(hi, n));
  }
  function jsonResp(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  function collectNvidiaKeys(s) {
    var keys = [];
    var add = function (k) { var t = String(k || "").trim(); if (t && keys.indexOf(t) < 0) keys.push(t); };
    if (Array.isArray(s.globalNvidiaApiKeys)) s.globalNvidiaApiKeys.forEach(add);
    add(s.globalNvidiaApiKey);
    (s.nvidiaModels || []).forEach(function (m) { add(m && m.apiKey); });
    (s.debateModels || []).forEach(function (m) { add(m && m.apiKey); });
    return keys;
  }
  function collectTwelveKeys(s) {
    var keys = [];
    var add = function (k) { var t = String(k || "").trim(); if (t && keys.indexOf(t) < 0) keys.push(t); };
    if (Array.isArray(s.twelveDataKeys)) s.twelveDataKeys.forEach(add);
    add(s.twelveDataKey);
    add(DEFAULT_TWELVE_KEY);
    return keys;
  }

  // ---------------- OANDA ----------------
  function oandaBase(env) {
    return env === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  }
  async function oandaConfig(s) {
    var token = String(s.oandaApiToken || "").trim();
    var env = String(s.oandaEnvironment || "practice").toLowerCase() === "live" ? "live" : "practice";
    var accountId = String(s.oandaAccountId || "").trim();
    if (token && !accountId) {
      try {
        var r = await fetch(oandaBase(env) + "/v3/accounts", { headers: { Authorization: "Bearer " + token } });
        var p = await r.json();
        accountId = String((p.accounts && p.accounts[0] && p.accounts[0].id) || "").trim();
        if (accountId) await saveSettings({ oandaAccountId: accountId });
      } catch (e) {}
    }
    return { token: token, env: env, accountId: accountId, baseUrl: oandaBase(env), configured: !!token };
  }

  async function oandaCandles(cfg, instrument, timeframe, count) {
    var gran = GRAN[timeframe] || "M15";
    // /v3/instruments/{inst}/candles does not require an account id
    var url = cfg.baseUrl + "/v3/instruments/" + encodeURIComponent(instrument) +
      "/candles?price=M&granularity=" + gran + "&count=" + clampInt(count, 200, 30, 5000);
    var r = await fetch(url, { headers: { Authorization: "Bearer " + cfg.token, Accept: "application/json" } });
    if (!r.ok) throw new Error("OANDA candles HTTP " + r.status);
    var p = await r.json();
    return (Array.isArray(p.candles) ? p.candles : [])
      .filter(function (c) { return c && c.mid; })
      .map(function (c) {
        return {
          datetime: String(c.time || ""),
          open: Number(c.mid.o), high: Number(c.mid.h),
          low: Number(c.mid.l), close: Number(c.mid.c),
          volume: Number(c.volume || 0),
          complete: c.complete !== false,
        };
      });
  }

  async function twelveCandles(keys, instrument, timeframe, count) {
    var sym = instrument.replace("_", "/");
    var ivMap = { "1min": "1min", "5min": "5min", "15min": "15min", "1h": "1h", "4h": "4h", "1day": "1day", "1week": "1week", "1month": "1month" };
    var interval = ivMap[timeframe] || "15min";
    for (var i = 0; i < keys.length; i++) {
      try {
        var url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(sym) +
          "&interval=" + interval + "&outputsize=" + clampInt(count, 200, 30, 5000) + "&apikey=" + encodeURIComponent(keys[i]) + "&format=JSON";
        var r = await fetch(url);
        var p = await r.json();
        if (p && Array.isArray(p.values) && p.values.length) {
          return p.values.map(function (v) {
            return {
              datetime: v.datetime, open: Number(v.open), high: Number(v.high),
              low: Number(v.low), close: Number(v.close), volume: Number(v.volume || 0), complete: true,
            };
          });
        }
      } catch (e) {}
    }
    throw new Error("Twelve Data candles unavailable");
  }

  async function getCandles(s, cfg, instrument, timeframe, count) {
    if (cfg.configured) {
      try { return await oandaCandles(cfg, instrument, timeframe, count); } catch (e) {}
    }
    return await twelveCandles(collectTwelveKeys(s), instrument, timeframe, count);
  }

  // ---------------- endpoint: /market-mtf ----------------
  async function handleMarketMtf(url) {
    var s = await getSettings();
    var cfg = await oandaConfig(s);
    var instrument = normInstrument(url.searchParams.get("symbol") || DEFAULT_INSTRUMENT);
    var entryTf = String(url.searchParams.get("entryTf") || "15min");
    var outputsize = clampInt(url.searchParams.get("outputsize"), 1000, 30, 2500);

    var tfs = [
      ["5min", outputsize], ["15min", outputsize], ["1h", outputsize], ["4h", outputsize],
      ["1day", outputsize], ["1week", Math.min(outputsize, 1000)], ["1month", Math.min(outputsize, 500)],
    ];
    var results = await Promise.all(tfs.map(function (t) {
      return getCandles(s, cfg, instrument, t[0], t[1]).catch(function () { return []; });
    }));
    var byTf = {};
    tfs.forEach(function (t, i) { byTf[t[0]] = results[i]; });

    if (!byTf["15min"].length && !byTf["5min"].length) {
      return jsonResp({ message: "No market data. Add an OANDA token or Twelve Data key in Settings, and check your connection." }, 502);
    }

    return jsonResp({
      status: "ok", provider: cfg.configured ? "oanda" : "twelvedata", cache_status: "DEVICE",
      data: [
        { id: "5min", values: byTf["5min"], symbolUsed: instrument },
        { id: "15min", values: byTf["15min"], symbolUsed: instrument },
        { id: "entry", values: entryTf === "15min" ? byTf["15min"] : byTf["5min"], symbolUsed: instrument },
        { id: "h1", values: byTf["1h"], symbolUsed: instrument },
        { id: "4h", values: byTf["4h"], symbolUsed: instrument },
        { id: "1day", values: byTf["1day"], symbolUsed: instrument },
        { id: "1week", values: byTf["1week"], symbolUsed: instrument },
        { id: "1month", values: byTf["1month"], symbolUsed: instrument },
        { id: "benchmark", values: byTf["1day"], symbolUsed: instrument },
        { id: "alpha_vantage", data: null, symbolUsed: "" },
      ],
    });
  }

  // ---------------- endpoint: /live-price ----------------
  async function handleLivePrice(url) {
    var s = await getSettings();
    var cfg = await oandaConfig(s);
    var instrument = normInstrument(url.searchParams.get("symbol") || DEFAULT_INSTRUMENT);
    if (cfg.configured && cfg.accountId) {
      try {
        var r = await fetch(cfg.baseUrl + "/v3/accounts/" + encodeURIComponent(cfg.accountId) +
          "/pricing?instruments=" + encodeURIComponent(instrument),
          { headers: { Authorization: "Bearer " + cfg.token, Accept: "application/json" } });
        var p = await r.json();
        var px = p && p.prices && p.prices[0];
        if (px) {
          var bid = Number(px.closeoutBid || (px.bids && px.bids[0] && px.bids[0].price));
          var ask = Number(px.closeoutAsk || (px.asks && px.asks[0] && px.asks[0].price));
          var mid = isFinite(bid) && isFinite(ask) ? (bid + ask) / 2 : (bid || ask);
          if (isFinite(mid)) return jsonResp({ price: Number(mid.toFixed(3)), time: px.time || new Date().toISOString() });
        }
      } catch (e) {}
    }
    // Twelve Data fallback
    var keys = collectTwelveKeys(s);
    var sym = instrument.replace("_", "/");
    for (var i = 0; i < keys.length; i++) {
      try {
        var rr = await fetch("https://api.twelvedata.com/price?symbol=" + encodeURIComponent(sym) + "&apikey=" + encodeURIComponent(keys[i]));
        var dd = await rr.json();
        if (dd && dd.price) return jsonResp({ price: Number(dd.price), time: new Date().toISOString() });
      } catch (e) {}
    }
    return jsonResp({ message: "Failed to fetch live price." }, 502);
  }

  // ---------------- LOCAL LEARNING MEMORY ----------------
  async function getHistory() { return (await prefGet(HISTORY_PREF_KEY)) || []; }
  async function setHistory(list) { await prefSet(HISTORY_PREF_KEY, (list || []).slice(-1000)); }
  async function getLessons() { return (await prefGet(LESSONS_PREF_KEY)) || []; }
  async function setLessons(list) { await prefSet(LESSONS_PREF_KEY, (list || []).slice(-200)); }

  function buildLearningBlock(lessons, stats) {
    if (!lessons.length) return "";
    var lines = lessons.slice(-12).map(function (l, i) {
      return (i + 1) + ". [" + (l.outcome || "LOSS") + "] " + (l.lesson || "").slice(0, 240);
    });
    return "\n\n=== LOCAL LEARNING MEMORY (mistakes to avoid) ===\n" +
      "Track record on this device: " + (stats.tp || 0) + " TP / " + (stats.sl || 0) + " SL (win-rate " + (stats.winRate || 0) + "%).\n" +
      "Apply these lessons learned from PAST FAILED trades:\n" + lines.join("\n") +
      "\nDo NOT repeat these mistakes. If the current setup resembles a past failure, prefer 'Stay Flat'.\n";
  }

  async function learningStats() {
    var h = await getHistory();
    var tp = 0, sl = 0;
    h.forEach(function (e) { if (e.outcome === "TP") tp++; else if (e.outcome === "SL") sl++; });
    var total = tp + sl;
    return { tp: tp, sl: sl, winRate: total ? Math.round((tp / total) * 100) : 0, total: h.length };
  }

  // Evaluate pending signals against current price; mark TP/SL or time-expire.
  async function resolvePending(currentPrice) {
    var h = await getHistory();
    var changed = false;
    var now = Date.now();
    for (var i = 0; i < h.length; i++) {
      var e = h[i];
      if (!e || e.outcome) continue;
      if (!e.direction || (!isFinite(e.sl) && !isFinite(e.tp1))) continue;
      var dir = String(e.direction).toLowerCase();
      var isBuy = dir.indexOf("buy") >= 0 || dir.indexOf("long") >= 0;
      var isSell = dir.indexOf("sell") >= 0 || dir.indexOf("short") >= 0;
      if (isFinite(currentPrice) && (isBuy || isSell)) {
        if (isBuy) {
          if (isFinite(e.tp1) && currentPrice >= e.tp1) { e.outcome = "TP"; changed = true; }
          else if (isFinite(e.sl) && currentPrice <= e.sl) { e.outcome = "SL"; changed = true; }
        } else {
          if (isFinite(e.tp1) && currentPrice <= e.tp1) { e.outcome = "TP"; changed = true; }
          else if (isFinite(e.sl) && currentPrice >= e.sl) { e.outcome = "SL"; changed = true; }
        }
      }
      // time expiry safety (4h) -> mark as SL-ish "expired" so it can be reviewed
      if (!e.outcome && e.createdAt && now - e.createdAt > 4 * 60 * 60 * 1000) {
        e.outcome = "EXPIRED"; changed = true;
      }
    }
    if (changed) await setHistory(h);
    return changed;
  }

  // Ask NVIDIA to diagnose WHY a losing trade failed; store the lesson locally.
  async function diagnoseLosses() {
    var s = await getSettings();
    var keys = collectNvidiaKeys(s);
    if (!keys.length) return;
    var h = await getHistory();
    var losers = h.filter(function (e) { return (e.outcome === "SL" || e.outcome === "EXPIRED") && !e.diagnosed; });
    if (!losers.length) return;
    var model = (s.nvidiaModels && s.nvidiaModels[0]) || { id: "meta/llama-3.1-70b-instruct", baseUrl: DEFAULT_AI_BASE };
    var lessons = await getLessons();
    var MAX = 2; // diagnose a couple per run to limit calls
    for (var i = 0; i < losers.length && i < MAX; i++) {
      var e = losers[i];
      var ctx = e.contextSummary || ("Direction " + e.direction + ", entry " + e.entry + ", SL " + e.sl + ", TP1 " + e.tp1);
      var prompt =
        "You are a trading post-mortem analyst for XAU/USD. A signal FAILED.\n" +
        "Signal: " + e.direction + " | entry " + e.entry + " | SL " + e.sl + " | TP1 " + e.tp1 + " | outcome " + e.outcome + "\n" +
        "Market context at the time:\n" + ctx + "\n\n" +
        "In ONE concise sentence (max 40 words), state the single most likely reason this trade failed and the rule to avoid repeating it.";
      try {
        var out = await nvidiaChat(keys, model, "You are a precise trading risk reviewer. Reply with one short sentence.", prompt, 0.2, 120, 15000);
        if (out) {
          lessons.push({ ts: Date.now(), outcome: e.outcome, lesson: out, signalId: e.id });
          e.diagnosed = true;
        }
      } catch (err) {}
    }
    await setLessons(lessons);
    await setHistory(h);
  }

  // ---------------- NVIDIA AI ----------------
  async function nvidiaChat(keys, model, systemPrompt, userPrompt, temperature, maxTokens, timeoutMs) {
    var baseUrl = String((model && model.baseUrl) || DEFAULT_AI_BASE).replace(/\/+$/, "");
    var modelId = (model && model.id) || "meta/llama-3.1-70b-instruct";
    for (var i = 0; i < keys.length; i++) {
      var controller = new AbortController();
      var to = setTimeout(function () { controller.abort(); }, timeoutMs || 30000);
      try {
        var r = await fetch(baseUrl + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + keys[i] },
          body: JSON.stringify({
            model: modelId, temperature: temperature == null ? 0.2 : temperature,
            max_tokens: maxTokens || 1024, stream: false,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          }),
          signal: controller.signal,
        });
        clearTimeout(to);
        var p = await r.json().catch(function () { return {}; });
        var content = p && p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content;
        if (r.ok && content && String(content).trim()) return String(content).trim();
      } catch (e) { clearTimeout(to); }
    }
    return null;
  }

  function summarySystemPrompt() {
    return "You are the Lead Arbiter of an institutional XAU/USD trading desk using SMC/ICT. " +
      "Analyze the provided market structure and return ONLY a JSON object with this exact shape: " +
      '{"researcher":{"summary":"...","direction":"Buy|Sell|Stay Flat","riskNote":"..."},' +
      '"trader":{"entryZone":"...","takeProfitLevels":"...","stopLoss":"...","positionSizing":"...","timeHorizon":"...","invalidation":"..."},' +
      '"equations":{"review":"..."}}. ' +
      "Give a precise entry zone, TP1 and TP2, and SL as price levels. Be decisive but respect the learning memory. No text outside the JSON.";
  }

  async function handleAiDecision(request) {
    var body = await request.json().catch(function () { return {}; });
    var prompt = String(body.prompt || "").trim();
    if (!prompt) return jsonResp({ message: "Missing AI prompt." }, 400);

    var s = await getSettings();
    var keys = collectNvidiaKeys(s);
    var temperature = isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2;

    // attach local learning memory
    var lessons = await getLessons();
    var stats = await learningStats();
    var promptWithLearning = prompt + buildLearningBlock(lessons, stats);

    if (!keys.length) {
      return jsonResp(Object.assign(textPayload(
        '{"researcher":{"summary":"No NVIDIA API key set. Open Settings and paste your nvapi- key to enable AI analysis.","direction":"Stay Flat","riskNote":"AI offline."},"trader":{"entryZone":"N/A","takeProfitLevels":"N/A","stopLoss":"N/A"},"equations":{"review":"AI key missing."}}',
        "device-fallback"), { fallbackUsed: true, learningMemoryUsed: stats.total > 0, debateUsed: false }));
    }

    var leadModel = (body.models && body.models[0]) || (s.nvidiaModels && s.nvidiaModels[0]) ||
      { id: body.model || "meta/llama-3.1-70b-instruct", baseUrl: body.baseUrl || DEFAULT_AI_BASE };

    var content = await nvidiaChat(keys, leadModel, summarySystemPrompt(), promptWithLearning, temperature, 1400, 60000);

    // Optional lightweight debate: poll up to 2 debate models for direction consensus
    var consensus = { buy: 0, sell: 0, wait: 0 };
    var debateModels = (body.debateModels && body.debateModels.length ? body.debateModels : (s.debateModels || [])).slice(0, 2);
    var debateSuccessful = 0;
    if (debateModels.length) {
      var votes = await Promise.all(debateModels.map(function (m) {
        return nvidiaChat(keys, m, "You are a trading debate participant. Reply with ONE word: BUY, SELL, or WAIT.",
          promptWithLearning, 0.2, 8, 15000).catch(function () { return null; });
      }));
      votes.forEach(function (v) {
        if (!v) return; debateSuccessful++;
        var t = v.toLowerCase();
        if (t.indexOf("buy") >= 0) consensus.buy++;
        else if (t.indexOf("sell") >= 0) consensus.sell++;
        else consensus.wait++;
      });
    }

    if (!content) {
      return jsonResp(Object.assign(textPayload(
        '{"researcher":{"summary":"AI model unreachable from device. Check your key/network.","direction":"Stay Flat","riskNote":"AI offline."},"trader":{"entryZone":"N/A","takeProfitLevels":"N/A","stopLoss":"N/A"},"equations":{"review":"AI offline."}}',
        leadModel.id || "device-fallback"),
        { fallbackUsed: true, learningMemoryUsed: stats.total > 0, debateUsed: debateModels.length > 0, debateAttempted: debateModels.length, debateSuccessful: debateSuccessful, debateConsensus: consensus }));
    }

    return jsonResp(Object.assign(textPayload(content, leadModel.id || "device"), {
      fallbackUsed: false,
      learningMemoryUsed: stats.total > 0,
      debateUsed: debateModels.length > 0,
      debateAttempted: debateModels.length,
      debateSuccessful: debateSuccessful,
      debateConsensus: consensus,
    }));
  }

  function textPayload(text, modelId) {
    return { model: modelId, choices: [{ message: { role: "assistant", content: String(text || "").trim() } }] };
  }

  // ---------------- endpoint: /settings ----------------
  async function handleSettings(request, url) {
    var action = String(url.searchParams.get("action") || "");
    var s = await getSettings();
    if (request.method === "GET") {
      if (action === "metrics") {
        var st = await learningStats();
        return jsonResp({ metrics: { totalAnalyses: st.total, tpHits: st.tp, slHits: st.sl, winRate: st.winRate, evaluated: st.tp + st.sl, pending: 0, uniqueDevices: 1, learningReviewCount: (await getLessons()).length, generatedAt: Date.now() } });
      }
      // On device, the holder of the phone is always admin.
      return jsonResp({ isAdmin: true, settings: s });
    }
    if (request.method === "POST") {
      var body = await request.json().catch(function () { return {}; });
      if (action === "fetch-nvidia") {
        return await handleFetchNvidia(body);
      }
      var next = await saveSettings(body || {});
      syncRunnerSettings().catch(function () {});
      return jsonResp({ ok: true, settings: next });
    }
    return jsonResp({ message: "Method not allowed." }, 405);
  }

  async function handleFetchNvidia(body) {
    var apiKey = String(body.apiKey || "").trim();
    var baseUrl = String(body.baseUrl || DEFAULT_AI_BASE).replace(/\/+$/, "");
    if (!apiKey) return jsonResp({ message: "Missing NVIDIA API key." }, 400);
    try {
      var r = await fetch(baseUrl + "/models", { headers: { Accept: "application/json", Authorization: "Bearer " + apiKey } });
      var p = await r.json().catch(function () { return {}; });
      if (!r.ok) return jsonResp({ message: (p && p.error && p.error.message) || ("NVIDIA HTTP " + r.status) }, r.status);
      var data = Array.isArray(p.data) ? p.data : [];
      var models = data.map(function (it) { return { id: String((it && it.id) || "").trim(), label: String((it && it.id) || "").trim() }; }).filter(function (m) { return m.id; });
      return jsonResp({ models: models, count: models.length, baseUrl: baseUrl, validated: true });
    } catch (e) {
      return jsonResp({ message: e.message || "Failed to fetch NVIDIA models." }, 502);
    }
  }

  // ---------------- endpoint: /history-log ----------------
  async function handleHistoryLog(request, url) {
    if (request.method === "GET") {
      var limit = clampInt(url.searchParams.get("limit"), 100, 1, 200);
      var h = await getHistory();
      return jsonResp({ entries: h.slice(-limit).reverse() });
    }
    if (request.method === "POST") {
      var body = await request.json().catch(function () { return {}; });
      var entry = body && body.entry && typeof body.entry === "object" ? body.entry : null;
      if (!entry) return jsonResp({ message: "Missing history entry." }, 400);
      var sig = extractSignalFields(entry);
      var record = Object.assign({}, entry, {
        source: String(body.source || "manual"),
        id: String(entry.id || entry.syncId || Date.now()),
        createdAt: Number(entry.createdAt || Date.now()),
        direction: sig.direction, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
        contextSummary: sig.contextSummary,
      });
      var h = await getHistory();
      h.push(record);
      await setHistory(h);
      // fire-and-forget local learning maintenance + background-runner sync
      maintenance().catch(function () {});
      syncRunnerSignals().catch(function () {});
      return jsonResp({ ok: true, entry: record });
    }
    return jsonResp({ message: "Method not allowed." }, 405);
  }

  // pull entry/sl/tp from a saved analysis-history entry (best-effort across shapes)
  function extractSignalFields(entry) {
    var ai = entry.ai || entry.aiData || {};
    var dec = entry.decision || (entry.analysis && entry.analysis.decision) || {};
    var direction = entry.direction || (ai.researcher && ai.researcher.direction) || dec.action || "";
    var num = function () { for (var i = 0; i < arguments.length; i++) { var n = Number(arguments[i]); if (isFinite(n) && n !== 0) return n; } return NaN; };
    var entryPx = num(entry.entry, entry.price, dec.entryPrice, dec.price, entry.priceAtSignal);
    var sl = num(entry.sl, dec.stopPrice, dec.sl);
    var tp1 = num(entry.tp1, dec.tp1, dec.takeProfit);
    var tp2 = num(entry.tp2, dec.tp2);
    var ctx = entry.contextSummary || (entry.equationsText || (entry.analysis && entry.analysis.summary) || "");
    return { direction: direction, entry: entryPx, sl: sl, tp1: tp1, tp2: tp2, contextSummary: String(ctx).slice(0, 800) };
  }

  // ---------------- endpoints: learning ----------------
  async function handleLearningContext() {
    var lessons = await getLessons();
    var stats = await learningStats();
    return jsonResp({ total: lessons.length, winRate: stats.winRate, tp: stats.tp, sl: stats.sl, lessons: lessons.slice(-12) });
  }
  async function handleLearningFeedback(request) {
    var body = await request.json().catch(function () { return {}; });
    // Allow manual marking of an outcome on a history item, then re-run diagnosis.
    if (body && body.id && body.outcome) {
      var h = await getHistory();
      for (var i = 0; i < h.length; i++) { if (String(h[i].id) === String(body.id)) { h[i].outcome = body.outcome; h[i].diagnosed = false; } }
      await setHistory(h);
      diagnoseLosses().catch(function () {});
    }
    return jsonResp({ ok: true });
  }

  // ---------------- endpoint: /bot (local, offline) ----------------
  async function handleBot(request) {
    var s = await getSettings();
    if (request.method === "GET") {
      return jsonResp({
        configured: !!String(s.oandaApiToken || "").trim(),
        environment: s.oandaEnvironment || "practice",
        instrument: normInstrument(s.botInstrument || DEFAULT_INSTRUMENT),
        botEnabled: !!s.botEnabled, botMode: s.botMode || "manual",
        units: Number(s.botUnits || 10), openTradesCount: 0,
        runtime: { lastAction: "device", lastReason: "On-device backend (no auto-execution)." },
        connectionError: "", accountIdResolved: !!String(s.oandaAccountId || "").trim(),
        deviceBackend: true,
      });
    }
    if (request.method === "POST") {
      var body = await request.json().catch(function () { return {}; });
      var action = String(body.action || "").toLowerCase();
      if (action === "save-config") { await saveSettings(body.config || {}); }
      else if (action === "start") { await saveSettings({ botEnabled: true }); }
      else if (action === "stop") { await saveSettings({ botEnabled: false }); }
      return jsonResp({ ok: true, action: action, status: { deviceBackend: true } });
    }
    return jsonResp({ message: "Method not allowed." }, 405);
  }

  // ---------------- maintenance: evaluate + learn ----------------
  var lastMaintenance = 0;
  async function maintenance() {
    var now = Date.now();
    if (now - lastMaintenance < 30 * 1000) return; // throttle
    lastMaintenance = now;
    try {
      var s = await getSettings();
      var cfg = await oandaConfig(s);
      var instrument = normInstrument(s.botInstrument || DEFAULT_INSTRUMENT);
      var price = NaN;
      try {
        var keys = collectTwelveKeys(s);
        if (cfg.configured && cfg.accountId) {
          var r = await fetch(cfg.baseUrl + "/v3/accounts/" + encodeURIComponent(cfg.accountId) + "/pricing?instruments=" + encodeURIComponent(instrument), { headers: { Authorization: "Bearer " + cfg.token } });
          var p = await r.json(); var px = p && p.prices && p.prices[0];
          if (px) { var b = Number(px.closeoutBid), a = Number(px.closeoutAsk); price = (isFinite(b) && isFinite(a)) ? (a + b) / 2 : (b || a); }
        }
        if (!isFinite(price) && keys.length) {
          var rr = await fetch("https://api.twelvedata.com/price?symbol=" + encodeURIComponent(instrument.replace("_", "/")) + "&apikey=" + encodeURIComponent(keys[0]));
          var dd = await rr.json(); if (dd && dd.price) price = Number(dd.price);
        }
      } catch (e) {}
      await pullRunnerOutcomes();
      await resolvePending(price);
      await diagnoseLosses();
      await syncRunnerSettings();
      await syncRunnerSignals();
    } catch (e) {}
  }

  // ---------------- ROUTER (fetch interceptor) ----------------
  var ROUTES = ["/market-mtf", "/live-price", "/ai-decision", "/settings", "/history-log", "/learning-context", "/learning-feedback", "/bot"];

  function matchRoute(pathname) {
    for (var i = 0; i < ROUTES.length; i++) {
      if (pathname === ROUTES[i] || pathname.indexOf(ROUTES[i]) >= 0) return ROUTES[i];
    }
    return null;
  }

  function isBackendUrl(rawUrl) {
    var u = String(rawUrl || "");
    // Intercept anything that looks like our API (worker, vercel, or local /api)
    if (u.indexOf("workers.dev") >= 0) return true;
    if (u.indexOf("/api/") >= 0) return true;
    // bare paths starting with /market-mtf etc.
    for (var i = 0; i < ROUTES.length; i++) { if (u.indexOf(ROUTES[i]) >= 0) return true; }
    return false;
  }

  var originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    try {
      var rawUrl = typeof input === "string" ? input : (input && input.url) || "";
      if (isBackendUrl(rawUrl)) {
        var u;
        try { u = new URL(rawUrl, window.location.origin); } catch (e) { u = null; }
        var pathname = u ? u.pathname : rawUrl;
        var route = matchRoute(pathname);
        if (route) {
          var method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
          var request = new Request(rawUrl, init || (typeof input !== "string" ? input : undefined));
          request = new Request(request, { method: method });

          if (route === "/market-mtf") return await handleMarketMtf(u);
          if (route === "/live-price") return await handleLivePrice(u);
          if (route === "/ai-decision") return await handleAiDecision(request);
          if (route === "/settings") return await handleSettings(request, u);
          if (route === "/history-log") return await handleHistoryLog(request, u);
          if (route === "/learning-context") return await handleLearningContext();
          if (route === "/learning-feedback") return await handleLearningFeedback(request);
          if (route === "/bot") return await handleBot(request);
        }
      }
    } catch (err) {
      console.error("[AurumBackend] route error:", err);
      return jsonResp({ message: "On-device backend error: " + (err && err.message) }, 500);
    }
    return originalFetch(input, init);
  };

  // expose for the mobile runtime + manual triggers
  window.AurumBackend = {
    getSettings: getSettings,
    saveSettings: saveSettings,
    getHistory: getHistory,
    getLessons: getLessons,
    learningStats: learningStats,
    maintenance: maintenance,
    resolvePending: resolvePending,
    diagnoseLosses: diagnoseLosses,
    syncRunnerSettings: syncRunnerSettings,
    syncRunnerSignals: syncRunnerSignals,
    pullRunnerOutcomes: pullRunnerOutcomes,
  };

  // Initial background-runner sync at boot (best-effort).
  document.addEventListener("DOMContentLoaded", function () {
    syncRunnerSettings().catch(function () {});
    syncRunnerSignals().catch(function () {});
    pullRunnerOutcomes().catch(function () {});
  });

  console.log("[AurumBackend] on-device backend installed (OANDA/TwelveData/NVIDIA direct, local learning).");
})();
