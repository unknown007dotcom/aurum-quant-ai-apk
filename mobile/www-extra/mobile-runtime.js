/*
 * Aurum Quant AI - Mobile Runtime Shim
 * Loaded before app.js inside the Capacitor APK.
 *
 * Responsibilities:
 *  1. Point the bundled UI at the remote backend (Cloudflare Worker), overridable.
 *  2. Request local-notification permission.
 *  3. Run a 15-minute analysis loop while the app is in the foreground.
 *  4. Only notify when price is INSIDE the entry zone (not at analysis time).
 *  5. Persist analysis history locally on the device (Capacitor Preferences).
 *
 * NOTE: True 24/7 background monitoring requires a native foreground service
 *       (see android/ FOREGROUND_SERVICE notes). This shim handles the
 *       foreground/active loop; the service can call window.AurumMobile.runCycle().
 */
(function () {
  "use strict";

  // ---- 1. Backend base URL (override here or via Preferences key "apiBase") ----
  window.__AURUM_API_BASE__ =
    window.__AURUM_API_BASE__ ||
    "https://aurum-quant-edge.aurum-quant-ai.workers.dev";

  var ANALYSIS_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  var TICK_POLL_MS = 5 * 1000; // 5s price polling for entry-zone watch
  var HISTORY_KEY = "aurum_local_history_v1";
  var LAST_SIGNAL_KEY = "aurum_last_signal_v1";

  var Cap = window.Capacitor || null;
  var LocalNotifications =
    Cap && Cap.Plugins ? Cap.Plugins.LocalNotifications : null;
  var Preferences = Cap && Cap.Plugins ? Cap.Plugins.Preferences : null;

  function isNative() {
    return !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  }

  // ---- Local storage helpers (Preferences on device, localStorage on web) ----
  async function storeGet(key) {
    try {
      if (Preferences) {
        var r = await Preferences.get({ key: key });
        return r && r.value ? JSON.parse(r.value) : null;
      }
    } catch (e) {}
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  }
  async function storeSet(key, value) {
    var json = JSON.stringify(value);
    try {
      if (Preferences) {
        await Preferences.set({ key: key, value: json });
        return;
      }
    } catch (e) {}
    try {
      localStorage.setItem(key, json);
    } catch (e) {}
  }

  // ---- Notifications ----
  var notifId = 1000;
  async function ensureNotifPermission() {
    if (!LocalNotifications) return false;
    try {
      var perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") {
        perm = await LocalNotifications.requestPermissions();
      }
      return perm.display === "granted";
    } catch (e) {
      return false;
    }
  }

  async function notify(title, body) {
    if (LocalNotifications) {
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: ++notifId,
              title: title,
              body: body,
              schedule: { at: new Date(Date.now() + 500) },
            },
          ],
        });
        return;
      } catch (e) {}
    }
    // Web fallback
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body: body });
      } else {
        console.log("[notify]", title, body);
      }
    } catch (e) {
      console.log("[notify]", title, body);
    }
  }

  // ---- Local history (device) ----
  async function appendHistory(entry) {
    var list = (await storeGet(HISTORY_KEY)) || [];
    list.push(entry);
    if (list.length > 1000) list = list.slice(-1000);
    await storeSet(HISTORY_KEY, list);
    return list;
  }
  async function getHistory() {
    return (await storeGet(HISTORY_KEY)) || [];
  }

  // ---- Backend calls ----
  function apiUrl(path) {
    return window.__AURUM_API_BASE__.replace(/\/+$/, "") + path;
  }

  async function fetchLivePrice() {
    // The app already proxies price via the backend; try a few known shapes.
    var endpoints = ["/live-price?symbol=XAU_USD", "/market-mtf?symbol=XAU%2FUSD&entryTf=15min&outputsize=2"];
    for (var i = 0; i < endpoints.length; i++) {
      try {
        var res = await fetch(apiUrl(endpoints[i]), { cache: "no-store" });
        if (!res.ok) continue;
        var data = await res.json();
        if (data && typeof data.price === "number") return data.price;
        // try to read last close from mtf payload
        if (data && data.data) {
          var entry = data.data.find(function (d) { return d.id === "entry" || d.id === "15min"; });
          var vals = entry && entry.values ? entry.values : null;
          if (vals && vals.length) {
            var last = vals[0];
            var c = Number(last.close != null ? last.close : (last.mid && last.mid.c));
            if (isFinite(c)) return c;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  // Pull a fresh AI decision from the backend. Returns a normalized signal or null.
  async function runAiAnalysis() {
    try {
      // Prefer the app's own analysis pipeline if it exposed one.
      if (typeof window.AurumRunAnalysis === "function") {
        var r = await window.AurumRunAnalysis();
        return normalizeSignal(r);
      }
    } catch (e) {}
    // Fallback: ask backend ai-decision endpoint directly.
    try {
      var res = await fetch(apiUrl("/ai-decision"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "XAU_USD", timeframe: "15min", source: "mobile-loop" }),
      });
      if (!res.ok) return null;
      var data = await res.json();
      return normalizeSignal(data);
    } catch (e) {
      return null;
    }
  }

  // Normalize whatever the backend returns into { action, entryLow, entryHigh, tp1, tp2, sl }
  function normalizeSignal(d) {
    if (!d) return null;
    var src = d.decision || d.signal || d.plan || d;
    var action = String(src.action || src.decision || src.bias || "").toLowerCase();
    if (action.indexOf("buy") >= 0 || action.indexOf("long") >= 0) action = "BUY";
    else if (action.indexOf("sell") >= 0 || action.indexOf("short") >= 0) action = "SELL";
    else return null; // no actionable signal

    var entryLow = num(src.entryLow, src.entryZoneLow, src.entry && src.entry.low, src.entryZone && src.entryZone[0]);
    var entryHigh = num(src.entryHigh, src.entryZoneHigh, src.entry && src.entry.high, src.entryZone && src.entryZone[1]);
    var entry = num(src.entry, src.entryPrice, src.price);
    if (!isFinite(entryLow) && isFinite(entry)) entryLow = entry - 1.0;
    if (!isFinite(entryHigh) && isFinite(entry)) entryHigh = entry + 1.0;

    return {
      action: action,
      entryLow: Math.min(entryLow, entryHigh),
      entryHigh: Math.max(entryLow, entryHigh),
      tp1: num(src.tp1, src.takeProfit1, src.tp, src.takeProfit),
      tp2: num(src.tp2, src.takeProfit2),
      sl: num(src.sl, src.stopLoss, src.stop, src.stopPrice),
      confidence: num(src.confidence, src.conf),
      raw: d,
      at: Date.now(),
    };
  }
  function num() {
    for (var i = 0; i < arguments.length; i++) {
      var n = Number(arguments[i]);
      if (isFinite(n) && n !== 0) return n;
    }
    return NaN;
  }

  function inEntryZone(price, sig) {
    if (!sig || !isFinite(price)) return false;
    return price >= sig.entryLow && price <= sig.entryHigh;
  }

  function fmt(n) {
    return isFinite(n) ? Number(n).toFixed(2) : "-";
  }

  function signalKey(sig) {
    return sig.action + ":" + fmt(sig.entryLow) + "-" + fmt(sig.entryHigh) + ":" + fmt(sig.sl);
  }

  // ---- The monitoring engine ----
  var currentSignal = null;
  var lastAnalysisAt = 0;
  var tickTimer = null;
  var analysisTimer = null;
  var alreadyAlertedKey = null;

  async function runCycle(force) {
    var now = Date.now();
    if (!force && now - lastAnalysisAt < ANALYSIS_INTERVAL_MS - 1000) return;
    lastAnalysisAt = now;
    // On-device self-learning: evaluate past signals (TP/SL) + diagnose losses.
    try {
      if (window.AurumBackend && window.AurumBackend.maintenance) {
        await window.AurumBackend.maintenance();
      }
    } catch (e) {}
    var sig = await runAiAnalysis();
    if (sig) {
      currentSignal = sig;
      await appendHistory({
        type: "analysis",
        ts: now,
        action: sig.action,
        entryLow: sig.entryLow,
        entryHigh: sig.entryHigh,
        tp1: sig.tp1,
        tp2: sig.tp2,
        sl: sig.sl,
        confidence: sig.confidence,
      });
      console.log("[AurumMobile] new signal", sig.action, sig.entryLow, sig.entryHigh);
    }
  }

  async function watchTick() {
    if (!currentSignal) return;
    var price = await fetchLivePrice();
    if (!isFinite(price)) return;
    if (inEntryZone(price, currentSignal)) {
      var key = signalKey(currentSignal);
      if (key !== alreadyAlertedKey) {
        alreadyAlertedKey = key;
        await storeSet(LAST_SIGNAL_KEY, { key: key, ts: Date.now() });
        var s = currentSignal;
        var title = "🎯 " + s.action + " — ENTRY NOW @ " + fmt(price);
        var body =
          "Entry zone " + fmt(s.entryLow) + "–" + fmt(s.entryHigh) +
          "\nTP1 " + fmt(s.tp1) + " | TP2 " + fmt(s.tp2) +
          "\nSL " + fmt(s.sl) +
          (isFinite(s.confidence) ? "\nConfidence " + Math.round(s.confidence) + "%" : "");
        await notify(title, body);
        await appendHistory({ type: "entry_alert", ts: Date.now(), price: price, action: s.action, entryLow: s.entryLow, entryHigh: s.entryHigh, tp1: s.tp1, tp2: s.tp2, sl: s.sl });
      }
    }
  }

  function start() {
    if (analysisTimer || tickTimer) return;
    runCycle(true);
    analysisTimer = setInterval(function () { runCycle(false); }, 60 * 1000); // check each minute, runs at 15m boundary
    tickTimer = setInterval(watchTick, TICK_POLL_MS);
    console.log("[AurumMobile] monitoring started");
  }
  function stop() {
    if (analysisTimer) clearInterval(analysisTimer);
    if (tickTimer) clearInterval(tickTimer);
    analysisTimer = tickTimer = null;
  }

  // Public API (also callable from a native foreground service via the bridge)
  window.AurumMobile = {
    start: start,
    stop: stop,
    runCycle: runCycle,
    watchTick: watchTick,
    getHistory: getHistory,
    getCurrentSignal: function () { return currentSignal; },
    setApiBase: function (url) { window.__AURUM_API_BASE__ = url; },
  };

  // Boot
  document.addEventListener("DOMContentLoaded", async function () {
    // Allow override of backend from saved preference
    var saved = await storeGet("apiBase");
    if (saved && typeof saved === "string") window.__AURUM_API_BASE__ = saved;
    await ensureNotifPermission();
    start();
  });
})();
