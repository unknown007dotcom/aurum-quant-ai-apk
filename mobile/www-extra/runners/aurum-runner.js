/*
 * Aurum Quant AI — Background Runner task
 * Runs in an ISOLATED JS context (NOT the WebView) via @capacitor/background-runner.
 * Scheduled by Android WorkManager (minimum ~15 min interval) and executes even
 * when the app is closed / screen off.
 *
 * It does the lightweight, critical job:
 *   1. read settings + pending signals from CapacitorKV (shared with the app)
 *   2. fetch the live price (OANDA -> Twelve Data)
 *   3. if price entered a pending signal's entry zone -> fire a local notification
 *   4. mark TP/SL outcomes so the in-app learning loop can diagnose later
 *
 * NOTE: This runner does NOT call the heavy LLM. The full 15-min AI analysis runs
 *       in the WebView (mobile-runtime.js) while the app is active. The runner's
 *       job is to make sure you still get the ENTRY-ZONE alert when the app is closed.
 *
 * KV keys (kept in sync by aurum-backend.js / the bridge):
 *   "runner_settings"  -> JSON { oandaApiToken, oandaEnvironment, oandaAccountId, twelveDataKeys[], botInstrument }
 *   "runner_signals"   -> JSON array of pending signals { id, direction, entryLow, entryHigh, tp1, tp2, sl, alerted }
 *   "runner_outcomes"  -> JSON array of { id, outcome, price, ts } (read back by the app)
 */

addEventListener("aurumScan", async (resolve, reject, args) => {
  try {
    await scan();
    resolve();
  } catch (e) {
    console.error("[AurumRunner] error", e);
    reject(e);
  }
});

// Some platforms also fire a generic event name; keep both for safety.
addEventListener("myCustomEvent", async (resolve) => {
  try { await scan(); } catch (e) {}
  resolve();
});

// Bridge events dispatched from the WebView to share data via CapacitorKV.
addEventListener("setKV", (resolve, reject, args) => {
  try {
    if (args && args.key) CapacitorKV.set(args.key, String(args.value || ""));
    resolve();
  } catch (e) { reject(e); }
});

addEventListener("getKV", (resolve, reject, args) => {
  try {
    const v = CapacitorKV.get(args && args.key);
    const raw = v && typeof v === "object" && "value" in v ? v.value : v;
    resolve({ value: raw || "" });
  } catch (e) { reject(e); }
});

function kvGet(key) {
  try {
    const v = CapacitorKV.get(key);
    // background-runner returns { value } or a string depending on version
    const raw = v && typeof v === "object" && "value" in v ? v.value : v;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
function kvSet(key, obj) {
  try { CapacitorKV.set(key, JSON.stringify(obj)); } catch (e) {}
}

function num() {
  for (let i = 0; i < arguments.length; i++) {
    const n = Number(arguments[i]);
    if (isFinite(n) && n !== 0) return n;
  }
  return NaN;
}
function fmt(n) { return isFinite(n) ? Number(n).toFixed(2) : "-"; }

function notify(title, body, id) {
  try {
    CapacitorNotifications.schedule([
      { id: id || Math.floor(Math.random() * 100000), title: title, body: body },
    ]);
  } catch (e) {
    console.log("[AurumRunner notify]", title, body);
  }
}

function normInstrument(v) {
  return String(v || "XAU_USD").trim().toUpperCase().replace("/", "_");
}

async function fetchPrice(s) {
  const instrument = normInstrument(s.botInstrument || "XAU_USD");
  const token = String(s.oandaApiToken || "").trim();
  const env = String(s.oandaEnvironment || "practice").toLowerCase() === "live" ? "live" : "practice";
  const base = env === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const accountId = String(s.oandaAccountId || "").trim();

  if (token && accountId) {
    try {
      const r = await fetch(base + "/v3/accounts/" + encodeURIComponent(accountId) + "/pricing?instruments=" + encodeURIComponent(instrument), {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      });
      const p = await r.json();
      const px = p && p.prices && p.prices[0];
      if (px) {
        const b = Number(px.closeoutBid), a = Number(px.closeoutAsk);
        const mid = isFinite(a) && isFinite(b) ? (a + b) / 2 : (b || a);
        if (isFinite(mid)) return mid;
      }
    } catch (e) {}
  }

  const keys = Array.isArray(s.twelveDataKeys) ? s.twelveDataKeys : [];
  const sym = instrument.replace("_", "/");
  for (let i = 0; i < keys.length; i++) {
    try {
      const rr = await fetch("https://api.twelvedata.com/price?symbol=" + encodeURIComponent(sym) + "&apikey=" + encodeURIComponent(keys[i]));
      const dd = await rr.json();
      if (dd && dd.price) return Number(dd.price);
    } catch (e) {}
  }
  return NaN;
}

async function scan() {
  const s = kvGet("runner_settings") || {};
  const signals = kvGet("runner_signals") || [];
  if (!signals.length) return;

  const price = await fetchPrice(s);
  if (!isFinite(price)) return;

  const outcomes = kvGet("runner_outcomes") || [];
  let changed = false;

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    if (!sig || sig.done) continue;
    const dir = String(sig.direction || "").toLowerCase();
    const isBuy = dir.indexOf("buy") >= 0 || dir.indexOf("long") >= 0;
    const isSell = dir.indexOf("sell") >= 0 || dir.indexOf("short") >= 0;
    if (!isBuy && !isSell) continue;

    const lo = num(sig.entryLow), hi = num(sig.entryHigh);

    // 1) Entry-zone alert (only once)
    if (!sig.alerted && isFinite(lo) && isFinite(hi) && price >= Math.min(lo, hi) && price <= Math.max(lo, hi)) {
      sig.alerted = true;
      changed = true;
      const title = (isBuy ? "🟢 BUY" : "🔴 SELL") + " — ENTRY NOW @ " + fmt(price);
      const body =
        "Entry " + fmt(lo) + "–" + fmt(hi) +
        " | TP1 " + fmt(sig.tp1) + " | TP2 " + fmt(sig.tp2) +
        " | SL " + fmt(sig.sl);
      notify(title, body, 7000 + (i % 1000));
    }

    // 2) Outcome tracking (TP / SL) for local learning
    if (!sig.done) {
      if (isBuy) {
        if (isFinite(sig.tp1) && price >= sig.tp1) { sig.done = "TP"; }
        else if (isFinite(sig.sl) && price <= sig.sl) { sig.done = "SL"; }
      } else {
        if (isFinite(sig.tp1) && price <= sig.tp1) { sig.done = "TP"; }
        else if (isFinite(sig.sl) && price >= sig.sl) { sig.done = "SL"; }
      }
      if (sig.done) {
        changed = true;
        outcomes.push({ id: sig.id, outcome: sig.done, price: price, ts: Date.now() });
        notify(
          (sig.done === "TP" ? "✅ TP HIT" : "🛑 SL HIT") + " (" + (isBuy ? "BUY" : "SELL") + ")",
          "Price " + fmt(price) + " — logged for AI self-review.",
          8000 + (i % 1000)
        );
      }
    }
  }

  if (changed) {
    kvSet("runner_signals", signals.filter((x) => !x.done));
    kvSet("runner_outcomes", outcomes.slice(-200));
  }
}
