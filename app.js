/**
 * Aurum Quant AI - Institutional Trading OS
 * Full Consolidated Production Build (v1.1)
 * Stateful SMC/ICT + RMI + Arbiter Council
 */

// --- Helper functions ---
const safeToFixed = (val, dec = 2) => {
    const n = Number(val);
    return Number.isFinite(n) ? n.toFixed(dec) : "0.00";
};

// --- Dynamic Imports ---
let FibonacciEngine = null;
import("./modules/engines/FibonacciEngine.js").then(mod => {
    FibonacciEngine = mod.FibonacciEngine;
}).catch(err => {
    console.error("Failed to load FibonacciEngine module", err);
});

// --- Constants & Config ---
const STORAGE_KEY = "xauusd-analyzer-settings-v1";
const HISTORY_STORAGE_KEY = "xauusd-analyzer-history-v1";
const DEVICE_ID_KEY = "xauusd-device-id-v1";
const EDGE_API_BASE = (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.protocol.includes("capacitor") || window.location.protocol.includes("http")))
    ? (window.location.port === "3000" ? "/api" : (window.location.protocol === "file:" ? "" : "/api"))
    : "/api";
const APP_CONFIG = {
  marketMtfPath: "/market-mtf",
  aiChatPath: "/ai-decision",
  intelPath: "/intel",
  historyLogPath: "/history-log",
  botStatusPath: "/bot",
  botControlPath: "/bot",
  settingsPath: "/settings",
  optionsIntelPath: "/options-intel",
  defaultMarketDataKey: "",
  defaultBaseUrl: "https://integrate.api.nvidia.com/v1"
};
const SETTINGS_PASSWORD = "Aviraj@api7";
const BASIC_SETTINGS_PASSWORD = "XAUUSD";

// --- State Management ---
let state = {
  trueGoldPrice: null,
  selectedTimeframe: "15min",
  selectedTimezone: "Asia/Kolkata",
  candleCount: 1000,
  temperature: 0.2,
  theme: "dark",
  isRunning: false,
  settingsRole: "locked",
  analysisHistory: [],
  botStatus: null,
  currentRmi: 100,
  previousRmi: 100,
  rmiBias: "neutral",
  marketDataKey: APP_CONFIG.defaultMarketDataKey,
  botMode: "manual",
  oandaEnvironment: "practice",
  botInstrument: "XAU_USD",
  botUnits: 10,
  botStopLossOffset: 3,
  botTakeProfitOffset: 6,
  botCooldownMinutes: 15,
  botPollIntervalSeconds: 60,
  optionsDataKey: "",
  selectedModelKey: "gpt-oss-default",
  models: [    {
      key: 'meta-llama-3-1-70b-instruct',
      id: 'meta/llama-3.1-70b-instruct',
      label: 'Llama 3.1 70B (Default)',
      apiKey: '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',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    }],
  debateModels: [
    {
      key: "llama-405b-debate",
      id: "meta/llama-3.1-405b-instruct",
      label: "Llama 3.1 405B (Debater)",
      apiKey: "",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      bias: "both",
      isDebateParticipant: true,
    },
    {
      key: "nemotron-70b-debate",
      id: "nvidia/llama-3.1-nemotron-70b-instruct",
      label: "Nemotron 70B (Arbiter)",
      apiKey: "",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      bias: "both",
      isDebateParticipant: true,
    }
  ]
};

function apiUrl(path) {
  const cleanPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
  if (cleanPath.startsWith("/settings") || cleanPath.startsWith("/ai-decision") || cleanPath.startsWith("/auto-learn")) {
    return `/api${cleanPath}`;
  }
  const cleanBase = String(EDGE_API_BASE || "").replace(/\/+$/, "");
  return `${cleanBase}${cleanPath}`;
}

const TIMEFRAME_TO_TRADINGVIEW = {
  "1min": "1",
  "15min": "15",
  "1h": "60",
  "4h": "240",
  "1day": "D",
};

// --- DOM Mapping ---
const dom = {
  get: (id) => document.querySelector(id),
  setStatus: (m) => { const el = document.querySelector("#statusText"); if (el) el.textContent = m; },
  fillList: (id, items) => {
    const el = document.querySelector(id);
    if (!el) return;
    el.innerHTML = items.map(i => `<li>${String(i).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m]))}</li>`).join("");
  }
};

// --- Analysis Logic ---
const AnalysisEngine = {
    toNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    },

    normalizeCandles(candles) {
        if (!Array.isArray(candles)) return [];
        // Twelve Data returns newest-first. Sort ascending (oldest→newest)
        // so .at(-1) always gives the LATEST candle.
        return candles
            .map((candle) => ({
                ...candle,
                open: Number(candle?.open),
                high: Number(candle?.high),
                low: Number(candle?.low),
                close: Number(candle?.close),
                _ts: new Date(candle?.datetime || 0).getTime(),
            }))
            .filter((candle) => 
                Number.isFinite(candle.open) && candle.open > 0 &&
                Number.isFinite(candle.high) && candle.high > 0 &&
                Number.isFinite(candle.low) && candle.low > 0 &&
                Number.isFinite(candle.close) && candle.close > 0
            )
            .sort((a, b) => a._ts - b._ts); // oldest first
    },

    exponentialMovingAverage(values, period) {
        const k = 2 / (period + 1);
        let ema = [values[0]];
        for (let i = 1; i < values.length; i++) ema.push(values[i] * k + ema[i - 1] * (1 - k));
        return ema;
    },

    averageTrueRange(candles, period) {
        if (!candles || candles.length === 0) return [];
        let tr = [candles[0].high - candles[0].low];
        for (let i = 1; i < candles.length; i++) {
            tr.push(Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            ));
        }
        let atr = [tr[0]];
        for (let i = 1; i < tr.length; i++) {
            atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
        }
        return atr;
    },

    standardDeviation(values, period) {
        const std = [];
        for (let i = 0; i < values.length; i++) {
            if (i < period - 1) {
                std.push(0);
            } else {
                const slice = values.slice(i - period + 1, i + 1);
                const mean = slice.reduce((a, b) => a + b, 0) / period;
                const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
                std.push(Math.sqrt(variance));
            }
        }
        return std;
    },

    calculateRMI(candles, benchmark) {
        if (!candles || candles.length < 30) return 100.00;
        const closes = candles.map(c => c.close);
        const period = 30;
        const k = 2 / (period + 1);
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
        const rmi = (closes.at(-1) / ema) * 100;
        return parseFloat(rmi.toFixed(2));
    },

    detectFairValueGaps(candles) {
        const fvgs = [];
        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        for (let i = 1; i < candles.length - 1; i++) {
            const p = candles[i - 1];
            const curr = candles[i];
            const n = candles[i + 1];

            const isGapUp = curr.open > p.close;
            const isGapDown = curr.open < p.close;

            // Bullish FVG or Gap Up
            if ((n.low > p.high && isBull(curr)) || isGapUp) {
                let type = isGapUp ? "Gap Up FVG" : "Standard";
                if (isBull(p) && isBull(n)) type = isGapUp ? "Gap Up (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
                else if (isBull(p) && isBear(n)) type = isGapUp ? "Gap Up (Trade Continuation)" : "Trade Continuation";
                else if (isBear(p) && isBull(n)) type = isGapUp ? "Gap Up (The Sweep)" : "The Sweep (Delayed Trap)";
                else if (isBear(p) && isBear(n)) type = isGapUp ? "Gap Up (Holy Grail)" : "The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐)";

                const price = isGapUp ? (curr.open + p.close) / 2 : (n.low + p.high) / 2;
                if (!fvgs.some(f => f.side === "bullish" && Math.abs(f.price - price) < 0.05)) {
                    fvgs.push({ side: "bullish", price, type });
                }
            }
            // Bearish FVG or Gap Down
            else if ((n.high < p.low && isBear(curr)) || isGapDown) {
                let type = isGapDown ? "Gap Down FVG" : "Standard";
                if (isBear(p) && isBear(n)) type = isGapDown ? "Gap Down (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
                else if (isBear(p) && isBull(n)) type = isGapDown ? "Gap Down (Trade Continuation)" : "Trade Continuation";
                else if (isBull(p) && isBear(n)) type = isGapDown ? "Gap Down (The Sweep)" : "The Sweep (Delayed Trap)";
                else if (isBull(p) && isBull(n)) type = isGapDown ? "Gap Down (Holy Grail)" : "The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐)";

                const price = isGapDown ? (curr.open + p.close) / 2 : (n.high + p.low) / 2;
                if (!fvgs.some(f => f.side === "bearish" && Math.abs(f.price - price) < 0.05)) {
                    fvgs.push({ side: "bearish", price, type });
                }
            }
        }
        return fvgs.slice(-8);
    },

    detectStructureEvents(candles) {
        const events = [];
        for (let i = 2; i < candles.length; i++) {
            const current = candles[i];
            const previous = candles[i - 1];
            const pivot = candles[i - 2];
            if (current.high > previous.high && previous.high <= pivot.high) {
                events.push(`BOS up through ${previous.high.toFixed(2)}`);
            }
            if (current.low < previous.low && previous.low >= pivot.low) {
                events.push(`Liquidity sweep below ${previous.low.toFixed(2)}`);
            }
        }
        return events.slice(-6);
    },

    detectOrderBlocks(candles, trend) {
        const relevant = candles.slice(-12, -1);
        const matches = relevant
            .filter((candle) => trend === "bullish" ? candle.close < candle.open : candle.close > candle.open)
            .slice(-3)
            .map((candle) => {
                const side = trend === "bullish" ? "Bullish demand" : "Bearish supply";
                return `${side} ${candle.low.toFixed(2)} - ${candle.high.toFixed(2)}`;
            });
        return matches.length ? matches : ["No clean order block found in current scan window."];
    },

    buildHeatmap(price, trend, rmiBias, htfAlignment = []) {
        const htfBullishCount = htfAlignment.filter(h => h.includes("BULLISH")).length;
        const htfBearishCount = htfAlignment.filter(h => h.includes("BEARISH")).length;
        const htfBias = htfBullishCount > htfBearishCount ? "bullish" : htfBullishCount < htfBearishCount ? "bearish" : "neutral";

        return [
            { label: "Gold SMC Trend", bias: trend, note: `Trend: ${trend.toUpperCase()}` },
            { label: "Gold RMI Momentum", bias: rmiBias === "neutral" ? trend : rmiBias, note: `Bias: ${rmiBias.toUpperCase()}` },
            { label: "Gold HTF Alignment", bias: htfBias === "neutral" ? trend : htfBias, note: `Aligned: ${Math.max(htfBullishCount, htfBearishCount)}/3` },
            { label: "Gold SMC Confluence", bias: trend, note: "Confluence Active" },
        ];
    },

    detectSwings(candles, strength) {
        const highs = [];
        const lows = [];
        for (let i = strength; i < candles.length - strength; i++) {
            let isHigh = true;
            let isLow = true;
            for (let j = 1; j <= strength; j++) {
                if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
                if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
            }
            if (isHigh) highs.push({ index: i, price: candles[i].high });
            if (isLow) lows.push({ index: i, price: candles[i].low });
        }
        return { highs, lows };
    },

    detectFibonacci(candles, currentPrice) {
        const swings = this.detectSwings(candles, 3);
        if (!swings || !swings.highs.length || !swings.lows.length) return null;

        const allSwings = [];
        swings.highs.forEach(s => allSwings.push({ ...s, type: 'high' }));
        swings.lows.forEach(s => allSwings.push({ ...s, type: 'low' }));
        allSwings.sort((a, b) => a.index - b.index);

        if (allSwings.length < 2) return null;

        const lastSwing = allSwings[allSwings.length - 1];
        let prevSwing = null;
        for (let i = allSwings.length - 2; i >= 0; i--) {
            if (allSwings[i].type !== lastSwing.type) {
                prevSwing = allSwings[i];
                break;
            }
        }

        if (!prevSwing) return null;

        const isBullishImpulse = lastSwing.type === 'high' && prevSwing.type === 'low';
        
        let highPrice = isBullishImpulse ? lastSwing.price : prevSwing.price;
        let lowPrice = !isBullishImpulse ? lastSwing.price : prevSwing.price;
        let range = highPrice - lowPrice;

        if (range <= 0) return null;

        let levels = {};
        if (isBullishImpulse) {
            levels = { 0: highPrice, 0.618: highPrice - (range * 0.618), 0.705: highPrice - (range * 0.705), 1: lowPrice };
        } else {
            levels = { 0: lowPrice, 0.618: lowPrice + (range * 0.618), 0.705: lowPrice + (range * 0.705), 1: highPrice };
        }

        let inEntryZone = isBullishImpulse 
            ? (currentPrice <= levels[0.618] && currentPrice >= levels[0.705])
            : (currentPrice >= levels[0.618] && currentPrice <= levels[0.705]);

        return {
            isBullishImpulse,
            levels,
            inEntryZone,
            action: isBullishImpulse ? "Buy" : "Sell",
            tp: levels[0],
            sl: levels[1],
            displayList: [
                `Direction: ${isBullishImpulse ? 'Bullish' : 'Bearish'} Retracement`,
                `Level 0 (TP): ${levels[0].toFixed(2)}`,
                `Level 0.618 (Entry): ${levels[0.618].toFixed(2)}`,
                `Level 0.705 (Entry): ${levels[0.705].toFixed(2)}`,
                `Level 1 (SL): ${levels[1].toFixed(2)}`,
                `Status: ${inEntryZone ? '🟢 IN ENTRY ZONE' : '⚪ Pending'}`
            ]
        };
    },

    run(mtfData) {
        const entry = this.normalizeCandles(mtfData.data.find(d => d.id === "entry")?.values || []);
        if (!entry.length) {
            throw new Error("No entry timeframe candles returned.");
        }
        
        state.previousRmi = state.currentRmi;
        state.currentRmi = this.calculateRMI(entry);
        state.rmiBias = state.currentRmi > 100.05 ? "bullish" : state.currentRmi < 99.95 ? "bearish" : "neutral";

        const closes = entry.map(c => c.close);
        const ema21 = this.exponentialMovingAverage(closes, 21).at(-1);
        const ema50 = this.exponentialMovingAverage(closes, 50).at(-1);
        const currentPrice = entry.at(-1).close;
        const prevPrice = entry.at(-2)?.close ?? currentPrice;
        const prevPrevPrice = entry.at(-3)?.close ?? prevPrice;

        let trend = "neutral";
        if (ema21 >= ema50) {
            trend = currentPrice >= ema50 ? "bullish" : "bearish";
        } else {
            trend = currentPrice <= ema50 ? "bearish" : "bullish";
        }
        const fvgs = this.detectFairValueGaps(entry);
        const structureEvents = this.detectStructureEvents(entry);
        const orderBlocks = this.detectOrderBlocks(entry, trend);
        const fibonacci = this.detectFibonacci(entry, currentPrice);
        const reversalZones = fvgs.length
            ? fvgs.slice(0, 3).map(f => `${f.side === "bullish" ? "Discount" : "Premium"} reversal zone near ${f.price.toFixed(2)}`)
            : ["No immediate reversal gap. Follow primary trend."];
        const liquidity = [
            `Session high ${Math.max(...entry.slice(-12).map(c => c.high)).toFixed(2)}`,
            `Session low ${Math.min(...entry.slice(-12).map(c => c.low)).toFixed(2)}`,
            `Current auction ${trend === "bullish" ? "repricing above value" : "rejecting premium"}`
        ];
        const scenarios = [
            trend === "bullish"
                ? `Base case: buy pullback into ${Math.max(currentPrice - 3, 0).toFixed(2)} - ${Math.max(currentPrice - 1, 0).toFixed(2)}`
                : `Base case: sell retrace into ${(currentPrice + 1).toFixed(2)} - ${(currentPrice + 3).toFixed(2)}`,
            `Fail-safe: invalidate beyond ${(trend === "bullish" ? currentPrice - 4 : currentPrice + 4).toFixed(2)}`
        ];
        const sessions = [
            "London/NY overlap remains the highest priority execution window.",
            `Current engine preference: ${trend === "bullish" ? "buy discount in killzone" : "sell premium in killzone"}`,
        ];
        const htfAlignment = mtfData.data
            .filter(d => ["h1", "1day", "1week"].includes(d.id))
            .map(d => {
                const values = this.normalizeCandles(d.values || []);
                if (values.length < 2) return `${d.id.toUpperCase()} unavailable`;
                const oldest = values[0].close;
                const latest = values.at(-1).close;
                const bias = latest >= oldest ? "bullish" : "bearish";
                return `${d.id.toUpperCase()} ${bias.toUpperCase()}`;
            });
        const lifecycle = {
            title: `${trend === "bullish" ? "Long" : "Short"} setup armed`,
            subtitle: `${state.selectedTimeframe} execution plan for XAU/USD`,
            progressPct: trend === "bullish" ? 58 : 46,
            status: "pending",
            detail: `Entry ${inferEntryRange(currentPrice, trend === "bullish" ? currentPrice - 4 : currentPrice + 4)} | TP1 ${(currentPrice + (trend === "bullish" ? 3 : -3)).toFixed(2)}`,
        };

        // --- Three Equations Doctrine Calculations ---
        const atr14 = this.averageTrueRange(entry, 14);
        const currentAtr = atr14.at(-1) || 1.0;
        const prevAtr = atr14.at(-2) || currentAtr;
        const avgAtr20 = atr14.length >= 20 
            ? (atr14.slice(-20).reduce((a, b) => a + b, 0) / 20) 
            : currentAtr;
        
        // Bollinger Bands Width (20, 2)
        const sma20 = closes.length >= 20 
            ? (closes.slice(-20).reduce((a, b) => a + b, 0) / 20) 
            : currentPrice;
        const last20Closes = closes.slice(-20);
        const mean = last20Closes.reduce((a, b) => a + b, 0) / last20Closes.length;
        const variance = last20Closes.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / last20Closes.length;
        const stdDev = Math.sqrt(variance);
        const bbWidth = stdDev * 4;

        // Delta
        const deltaChange = currentPrice - prevPrice;
        const deltaVal = deltaChange / currentAtr;
        let deltaInterp = "Neutral (NO TRADE)";
        if (deltaVal > 0.7) deltaInterp = "Strong bullish momentum (BUY)";
        else if (deltaVal >= 0.3) deltaInterp = "Bullish (BUY pullbacks)";
        else if (deltaVal <= -0.7) deltaInterp = "Strong bearish momentum (STRONG SELL)";
        else if (deltaVal <= -0.3) deltaInterp = "Bearish (SELL rallies)";

        // Gamma
        const prevDeltaChange = prevPrice - prevPrevPrice;
        const prevDeltaVal = prevDeltaChange / prevAtr;
        const gammaVal = deltaVal - prevDeltaVal;
        let gammaInterp = "Stable market (Range trade)";
        if (gammaVal > 0.1) gammaInterp = "Momentum accelerating UP (BUY breakout)";
        else if (gammaVal < -0.1) gammaInterp = "Momentum accelerating DOWN (SELL breakdown)";

        // Theta
        let consolPeriods = 0;
        const rangeThreshold = currentAtr * 0.75;
        for (let i = entry.length - 1; i >= 0; i--) {
            if (Math.abs(entry[i].close - currentPrice) <= rangeThreshold) {
                consolPeriods++;
            } else {
                break;
            }
        }
        const thetaVal = consolPeriods / currentAtr;
        let thetaInterp = "Medium (Market slowing)";
        if (thetaVal < 0.2) thetaInterp = "Very low (Trend fresh)";
        else if (thetaVal > 0.6) thetaInterp = "High (Big breakout soon)";

        // Vega & Volatility Ratio
        const vegaVal = currentAtr / avgAtr20;
        let vegaInterp = "Normal (Standard trade)";
        if (vegaVal < 0.8) vegaInterp = "Low volatility (Prepare breakout)";
        else if (vegaVal > 1.2) vegaInterp = "Volatility expansion (Trade trend only)";

        const volRatioVal = vegaVal;
        let volRatioInterp = "Normal (Trend/pullback)";
        if (volRatioVal < 0.7) volRatioInterp = "Dead market (Wait)";
        else if (volRatioVal > 1.8) volRatioInterp = "Extreme (Reduce size)";
        else if (volRatioVal > 1.2) volRatioInterp = "High volatility (Breakout)";

        // Compression
        const compressionVal = bbWidth / currentAtr;
        let compressionInterp = "Normal";
        if (compressionVal < 0.8) compressionInterp = "Massive breakout coming";
        else if (compressionVal > 1.5) compressionInterp = "Market already expanded";

        // Expected Move (GARCH)
        const yesterdayMove = prevPrice - prevPrevPrice;
        const garchForecast = 0.06 * Math.pow(yesterdayMove, 2) + 0.94 * prevAtr;

        // Target Probability Score
        const targetPrice = currentPrice + (trend === "bullish" ? 3.0 : -3.0);
        const tpDist = Math.abs(targetPrice - currentPrice);
        const probScore = tpDist / currentAtr;
        let probInterp = "Moderate (1-2 ATR)";
        if (probScore < 1.0) probInterp = "Very high (< 1 ATR)";
        else if (probScore > 3.0) probInterp = "Low probability (> 3 ATR)";
        else if (probScore > 2.0) probInterp = "Difficult (2-3 ATR)";

        // IV
        const ivVal = (currentAtr / currentPrice) * 15.87;
        let ivInterp = "Normal (10-15%)";
        if (ivVal < 0.10) ivInterp = "Calm (< 10%)";
        else if (ivVal > 0.25) ivInterp = "Panic/fear (> 25%)";
        else if (ivVal > 0.15) ivInterp = "High (15-25%)";

        // Max Pain
        const maxPainVal = sma20;
        let maxPainInterp = "Near (Neutral)";
        if (currentPrice > maxPainVal + (0.5 * currentAtr)) maxPainInterp = "Far above (SELL bias)";
        else if (currentPrice < maxPainVal - (0.5 * currentAtr)) maxPainInterp = "Far below (BUY bias)";

        // Recommendations
        let recommendation = `HOLD / FLAT - No clear mathematical momentum trigger.`;
        if (deltaVal > 0.7 && gammaVal > 0 && volRatioVal > 1.2 && compressionVal < 0.8) {
            recommendation = `STRONG BUY - Bullish breakout accelerating. Aligned with GARCH warning score.`;
        } else if (deltaVal < -0.7 && gammaVal < 0 && volRatioVal > 1.2 && compressionVal < 0.8) {
            recommendation = `STRONG SELL - Bearish breakdown accelerating. Aligned with GARCH warning score.`;
        } else if (trend === "bullish" && deltaVal > 0.3 && maxPainInterp.includes("below")) {
            recommendation = `BUY pullbacks - Aligned with institutional fair value (${maxPainVal.toFixed(2)}).`;
        } else if (trend === "bearish" && deltaVal < -0.3 && maxPainInterp.includes("above")) {
            recommendation = `SELL rallies - Aligned with institutional fair value (${maxPainVal.toFixed(2)}).`;
        } else if (compressionVal < 0.8) {
            recommendation = `WAIT FOR BREAKOUT - High energy compression in progress (Bollinger Compression: ${compressionVal.toFixed(2)}).`;
        } else if (trend === "bullish") {
            recommendation = `BUY - Primary bullish trend holds.`;
        } else if (trend === "bearish") {
            recommendation = `SELL - Primary bearish trend holds.`;
        }

        // Build concise 5-6 line institutional summary
        const dirWord = deltaVal > 0.3 ? "bullish" : deltaVal < -0.3 ? "bearish" : "neutral";
        const momWord = Math.abs(gammaVal) > 0.1 ? (gammaVal > 0 ? "accelerating upward" : "accelerating downward") : "stable";
        const volWord = vegaVal > 1.2 ? "elevated" : vegaVal < 0.8 ? "compressed" : "normal";
        const brkWord = compressionVal < 0.8
            ? "Bollinger compression is high — a breakout is imminent."
            : compressionVal > 1.5
            ? "Volatility has already expanded; the breakout phase may be underway."
            : "Bollinger bands show normal dispersion.";
        const pricePos = currentPrice > maxPainVal + 0.5 * currentAtr ? "above"
            : currentPrice < maxPainVal - 0.5 * currentAtr ? "below" : "near";

        const equationsText = [
            `XAU/USD @ $${currentPrice.toFixed(2)} | ATR(14): ${currentAtr.toFixed(2)} | SMA-20: $${maxPainVal.toFixed(2)} | IV: ${(ivVal * 100).toFixed(1)}%`,
            `Momentum is ${dirWord} (Delta: ${deltaVal.toFixed(2)}) and ${momWord} (Gamma: ${gammaVal >= 0 ? "+" : ""}${gammaVal.toFixed(2)}). Volatility is ${volWord} (Vega: ${vegaVal.toFixed(2)}).`,
            `${brkWord} Price is ${pricePos} the institutional fair-value anchor (${maxPainInterp}).`,
            `GARCH forecast: ≈$${garchForecast.toFixed(2)} expected move. Target probability to TP ($${targetPrice.toFixed(2)}): ${probInterp}.`,
            `Theta: ${thetaVal.toFixed(2)} (${thetaInterp}) | Compression: ${compressionVal.toFixed(2)} (${compressionInterp}).`,
            `▶ Signal: ${recommendation}`
        ].join("\n");

        let liquidityPools = { extreme: [], midExtreme: [], decisional: [], inducement: [] };
        let liquidityEvents = [];
        let sessionLevels = {};
        try {
            liquidityPools = LiquidityEngine.computeLiquidityPools(mtfData);
            liquidityEvents = LiquidityEngine.scanAllLiquidityEvents(liquidityPools, mtfData);
            sessionLevels = LiquidityEngine._sessionState || {};
        } catch (e) { console.warn("Failed to compute liquidity for confidence scaling", e); }

        let confidence = 40;
        if (trend === 'bullish' || trend === 'bearish') confidence += 10;
        if (state.rmiBias === trend) confidence += 10;
        if (htfAlignment.filter(row => row.includes(trend)).length > 1) confidence += 15;
        if (fvgs.length > 0) confidence += 10;
        if (structureEvents.length > 0) confidence += 5;

        const sweepEvents = (liquidityEvents || []).filter(e => e.type === 'SWEEP');
        const alignedSweep = sweepEvents.some(e => {
            if (trend === 'bullish' && e.pool?.side === 'low' && e.biasDirection === 'reversal') return true;
            if (trend === 'bearish' && e.pool?.side === 'high' && e.biasDirection === 'reversal') return true;
            return false;
        });
        if (alignedSweep) confidence += 15;
        confidence = Math.min(95, Math.max(30, confidence));

        const atrMult = currentAtr;
        let calcTp1 = currentPrice + (trend === 'bullish' ? 1.5 * atrMult : -1.5 * atrMult);
        let calcTp2 = currentPrice + (trend === 'bullish' ? 3.0 * atrMult : -3.0 * atrMult);
        let calcStop = currentPrice + (trend === 'bullish' ? -1.0 * atrMult : 1.0 * atrMult);

        if (liquidityEvents && liquidityEvents.length > 0) {
            const sweepEvent = liquidityEvents.find(e => e.type === 'SWEEP' && e.nextTP && e.nextTP !== '—');
            if (sweepEvent) {
                const tpMatch = sweepEvent.nextTP.match(/\$?([\d.]+)/);
                if (tpMatch) calcTp1 = parseFloat(tpMatch[1]);
            }
        }

        let action = trend === "bullish" ? "Buy" : "Sell";
        let tradePlan = [
            `Institutional Regime: ${trend.toUpperCase()}`,
            `RMI Momentum: ${state.rmiBias.toUpperCase()}`,
            `Fair Value Gaps detected: ${fvgs.length}`,
            `Targeting next institutional liquidity pool.`
        ];

        if (fibonacci && fibonacci.inEntryZone) {
            action = fibonacci.action;
            confidence += 30; // Strong signal when in golden zone
            calcTp1 = fibonacci.tp;
            calcTp2 = fibonacci.tp;
            calcStop = fibonacci.sl;
            tradePlan.push(`Fibonacci Golden Zone active. Target 0 at ${calcTp1.toFixed(2)}. SL 1 at ${calcStop.toFixed(2)}.`);
        }
        
        confidence = Math.min(95, Math.max(30, confidence));

        return {
            price: currentPrice,
            trend,
            rmi: { value: state.currentRmi, bias: state.rmiBias },
            fvgs,
            orderBlocks,
            structureEvents,
            reversalZones,
            liquidity,
            scenarios,
            sessions,
            htfAlignment,
            lifecycle,
            heatmap: this.buildHeatmap(currentPrice, trend, state.rmiBias, htfAlignment),
            equationsText,
            fibonacci,
            decision: {
                action: action,
                confidence,
                score: action === "Buy" ? 3 : -3,
                tp1: calcTp1,
                tp2: calcTp2,
                stopPrice: calcStop,
                tradePlan: tradePlan
            }
        };
    }
};

// --- Institutional Liquidity Engine ---
const LiquidityEngine = {
    // IST session boundaries (hours in UTC)
    ASIAN_START_UTC: 0,   // 05:30 IST = 00:00 UTC
    ASIAN_END_UTC: 7,     // 12:30 IST = 07:00 UTC
    LONDON_START_UTC: 7,  // 12:30 IST = 07:00 UTC
    LONDON_END_UTC: 12,   // 17:30 IST = 12:00 UTC
    NY_START_UTC: 12,
    NY_END_UTC: 17.5,

    // Minimum wick/close depth to qualify as a real event (filters micro-noise / spread)
    MIN_DEPTH: 0.10, // $0.10 for Gold (XAUUSD)

    // Track notified events to prevent duplicates
    _notifiedEvents: new Set(),
    _sessionState: { asianHigh: null, asianLow: null, londonHigh: null, londonLow: null, nyHigh: null, nyLow: null, asianLocked: false, londonLocked: false, nyLocked: false, lastResetDay: -1 },

    // Level status tracking: ACTIVE / TAPPED / PENDING / SWEPT / BROKEN
    _levelStatuses: {},

    // Diagnostic logs (last 100 entries)
    _diagnosticLogs: [],

    // Safely parse datetime strings as UTC, avoiding browser/local timezone traps
    parseUtcDate(dateStr) {
        if (!dateStr) return new Date();
        if (typeof dateStr !== "string") return new Date(dateStr);
        if (dateStr.includes("Z") || dateStr.includes("+") || (dateStr.includes("-") && dateStr.includes("T"))) {
            return new Date(dateStr);
        }
        const normalized = dateStr.trim().replace(/\s+/, "T");
        if (!normalized.includes("T")) {
            return new Date(normalized + "T00:00:00Z");
        }
        return new Date(normalized.includes("Z") ? normalized : normalized + "Z");
    },

    /**
     * Compute all liquidity pools from multi-timeframe OANDA data.
     * Returns structured pools grouped by tier.
     */
    computeLiquidityPools(mtfData) {
        const monthly = this._getCandles(mtfData, "1month");
        const weekly = this._getCandles(mtfData, "1week");
        const daily = this._getCandles(mtfData, "1day");
        const h4 = this._getCandles(mtfData, "4h");
        const h1 = this._getCandles(mtfData, "h1");
        const m15 = this._getCandles(mtfData, "15min") || this._getCandles(mtfData, "entry");
        const currentPrice = (daily.length ? daily.at(-1).close : h1.length ? h1.at(-1).close : 0);

        const pools = {
            extreme: [],
            midExtreme: [],
            decisional: [],
            inducement: []
        };

        // 🔴 EXTREME POINT — Previous Month / Quarter Highs & Lows
        if (monthly.length >= 2) {
            const prevMonth = monthly.at(-2);
            const currentMonthTime = new Date(monthly.at(-1).datetime).getTime();
            pools.extreme.push(
                { name: "Previous Month High", shortName: "PMH", price: prevMonth.high, side: "high", parent: "Monthly", childTf: "1week", tier: "extreme", formedAt: currentMonthTime },
                { name: "Previous Month Low", shortName: "PML", price: prevMonth.low, side: "low", parent: "Monthly", childTf: "1week", tier: "extreme", formedAt: currentMonthTime }
            );
        }
        // Quarterly from monthly data (group by calendar quarter)
        if (monthly.length >= 4) {
            const quarterly = this._computeQuarterly(monthly);
            const currentMonthTime = new Date(monthly.at(-1).datetime).getTime();
            if (quarterly) {
                pools.extreme.push(
                    { name: "Previous Quarter High", shortName: "PQH", price: quarterly.high, side: "high", parent: "Quarterly", childTf: "1week", tier: "extreme", formedAt: currentMonthTime },
                    { name: "Previous Quarter Low", shortName: "PQL", price: quarterly.low, side: "low", parent: "Quarterly", childTf: "1week", tier: "extreme", formedAt: currentMonthTime }
                );
            }
        }

        // 🟠 MID-EXTREME POINT — PDH/PDL, PWH/PWL
        if (daily.length >= 2) {
            const prevDay = daily.at(-2);
            const currentDayTime = new Date(daily.at(-1).datetime).getTime();
            pools.midExtreme.push(
                { name: "Previous Day High", shortName: "PDH", price: prevDay.high, side: "high", parent: "Daily", childTf: "4h", tier: "midExtreme", formedAt: currentDayTime },
                { name: "Previous Day Low", shortName: "PDL", price: prevDay.low, side: "low", parent: "Daily", childTf: "4h", tier: "midExtreme", formedAt: currentDayTime }
            );
        }
        if (weekly.length >= 2) {
            const prevWeek = weekly.at(-2);
            const currentWeekTime = new Date(weekly.at(-1).datetime).getTime();
            pools.midExtreme.push(
                { name: "Previous Week High", shortName: "PWH", price: prevWeek.high, side: "high", parent: "Weekly", childTf: "1day", tier: "midExtreme", formedAt: currentWeekTime },
                { name: "Previous Week Low", shortName: "PWL", price: prevWeek.low, side: "low", parent: "Weekly", childTf: "1day", tier: "midExtreme", formedAt: currentWeekTime }
            );
        }

        // 🟡 DECISIONAL POINT — Asian / London Session H/L
        const sessionLevels = this.detectSessionHighsLows(h1);
        const todayStart = this._sessionState.todayStartUTC || 0;
        if (sessionLevels.asianHigh !== null) {
            const formedAt = todayStart + 7 * 60 * 60 * 1000;
            pools.decisional.push(
                { name: "Asian Session High", shortName: "ASH", price: sessionLevels.asianHigh, side: "high", parent: "Session", childTf: "1h", tier: "decisional", sessionStatus: sessionLevels.asianLocked ? "locked" : "tracking", formedAt },
                { name: "Asian Session Low", shortName: "ASL", price: sessionLevels.asianLow, side: "low", parent: "Session", childTf: "1h", tier: "decisional", sessionStatus: sessionLevels.asianLocked ? "locked" : "tracking", formedAt }
            );
        }
        if (sessionLevels.londonHigh !== null) {
            const formedAt = todayStart + 12 * 60 * 60 * 1000;
            pools.decisional.push(
                { name: "London Session High", shortName: "LSH", price: sessionLevels.londonHigh, side: "high", parent: "Session", childTf: "1h", tier: "decisional", sessionStatus: sessionLevels.londonLocked ? "locked" : "tracking", formedAt },
                { name: "London Session Low", shortName: "LSL", price: sessionLevels.londonLow, side: "low", parent: "Session", childTf: "1h", tier: "decisional", sessionStatus: sessionLevels.londonLocked ? "locked" : "tracking", formedAt }
            );
        }
        if (sessionLevels.nyHigh !== null) {
            const formedAt = todayStart + 17.5 * 60 * 60 * 1000;
            pools.decisional.push(
                { name: "New York Session High", shortName: "NYH", price: sessionLevels.nyHigh, side: "high", parent: "Session", childTf: "1h", tier: "decisional", sessionStatus: sessionLevels.nyLocked ? "locked" : "tracking", formedAt },
                { name: "New York Session Low", shortName: "NYL", price: sessionLevels.nyLow, side: "low", parent: "Session", childTf: "1h", tier: "decisional", sessionStatus: sessionLevels.nyLocked ? "locked" : "tracking", formedAt }
            );
        }

        // 🟢 INDUCEMENT — Equal Highs/Lows, Swing Points, Round Numbers
        const eqLevels = this._detectEqualLevels(m15.length ? m15 : h1, currentPrice);
        eqLevels.forEach(eq => pools.inducement.push(eq));

        const swingLevels = this._detectSwingPoints(h1, h4, currentPrice);
        swingLevels.forEach(sw => pools.inducement.push(sw));

        const roundLevels = this._detectRoundNumbers(currentPrice);
        roundLevels.forEach(rn => pools.inducement.push(rn));

        return pools;
    },

    /**
     * Scan all liquidity pools against child-candle data and classify events.
     * Implements level status management, complete-candle gating, and diagnostic logging.
     */
    scanAllLiquidityEvents(pools, mtfData) {
        const events = [];
        const allPools = [...(pools.extreme || []), ...(pools.midExtreme || []), ...(pools.decisional || []), ...(pools.inducement || [])];

        // BUG FIX: Always reset _levelStatuses on every fresh scan so that repeated
        // manual runs (e.g. multiple "Bot Preview" clicks) always re-evaluate levels
        // from the current candle feed instead of getting locked on stale states from
        // a previous run.  The daily-reset guard is moved INSIDE the daily-reset block
        // only for cross-day identity (so the session-day watermark is still maintained).
        const now = new Date();
        const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const currentDayOfYear = Math.floor((istNow - new Date(istNow.getFullYear(), 0, 0)) / 86400000);
        // Always reset on every call — this prevents stale SWEPT/BROKEN/PENDING states
        // from persisting across multiple preview clicks or instrument/timeframe changes.
        this._levelStatuses = { _lastResetDay: currentDayOfYear };

        for (const pool of allPools) {
            if (pool.shortName === "RND" || pool.shortName === "TLE") continue; // Reactive only

            // Skip session pools that are still tracking (not locked/closed)
            if (pool.sessionStatus === "tracking") continue;

            // Skip dead levels (already SWEPT or BROKEN)
            const levelKey = `${pool.shortName}_${pool.price.toFixed(2)}`;
            const currentStatus = this._levelStatuses[levelKey];
            if (currentStatus === "SWEPT" || currentStatus === "BROKEN") {
                // Still push a "dead" marker so UI shows the status
                events.push({
                    type: currentStatus === "SWEPT" ? "SWEEP" : "BREAKOUT",
                    displayName: `${pool.name} ${currentStatus === "SWEPT" ? "Sweep" : "Breakout"}`,
                    emoji: currentStatus === "SWEPT" ? "🩸" : "💥",
                    price: pool.price,
                    childClose: 0,
                    childDetail: this._levelStatuses[levelKey + "_detail"] || "Previously confirmed",
                    bias: currentStatus === "SWEPT"
                        ? (pool.side === "high" ? "REVERSAL EXPECTED ↓" : "REVERSAL EXPECTED ↑")
                        : (pool.side === "high" ? "CONTINUATION UP ↑" : "CONTINUATION DOWN ↓"),
                    biasDirection: currentStatus === "SWEPT" ? "reversal" : "continuation",
                    pool,
                    tierLabel: this._tierLabel(pool.tier),
                    time: this._levelStatuses[levelKey + "_time"] || "—",
                    nextTP: this._levelStatuses[levelKey + "_nextTP"] || "—",
                    _dead: true
                });
                continue;
            }

            const childCandles = this._getChildCandles(mtfData, pool.childTf);
            if (!childCandles || !childCandles.length) continue;

            // Scan all available child candles to find any sweeps/breakouts since formation
            let maxLookback = childCandles.length;

            // Determine the index of the latest completed candle from the end
            let latestCompletedIdx = 1;
            for (let k = 1; k <= childCandles.length; k++) {
                if (childCandles.at(-k).complete !== false) {
                    latestCompletedIdx = k;
                    break;
                }
            }

            let foundConfirmed = false;
            let sawPendingOnLatest = false;

            for (let i = 1; i <= maxLookback; i++) {
                const child = childCandles.at(-i);
                const prior = (childCandles.length >= i + 1) ? childCandles.at(-(i + 1)) : null;

                // --- TEMPORAL PARADOX FILTER ---
                // Only evaluate child candles that occurred at or after the level's formation timestamp!
                const childTime = new Date(child.datetime).getTime();
                if (pool.formedAt && childTime < pool.formedAt) {
                    continue; 
                }

                const event = this.classifyEvent(child, pool, prior, childCandles);

                // Diagnostic logging
                if (event && i <= 3) {
                    this._addDiagnosticLog(pool, child, event);
                }

                // Only promote confirmed events (SWEEP / BREAKOUT)
                if (event && (event.type === "SWEEP" || event.type === "BREAKOUT")) {
                    event.pool = pool;
                    event.tierLabel = this._tierLabel(pool.tier);
                    
                    // Format time of the specific child candle that triggered the event
                    const eventDate = this.parseUtcDate(child.datetime);
                    event.time = (eventDate instanceof Date && !isNaN(eventDate))
                        ? eventDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })
                        : "N/A";
                    
                    event.nextTP = this._findNextTP(allPools, pool, event.type, child.close);

                    if (i > latestCompletedIdx) {
                        event._dead = true;
                        event.type = event.type === "SWEEP" ? "SWEPT" : "BROKEN";
                        event.strength = "Historical";
                    } else {
                        event._dead = false;
                    }

                    events.push(event);

                    // Update level status
                    this._levelStatuses[levelKey] = event.type === "SWEEP" || event.type === "SWEPT" ? "SWEPT" : "BROKEN";
                    this._levelStatuses[levelKey + "_time"] = event.time;
                    this._levelStatuses[levelKey + "_detail"] = event.childDetail;
                    this._levelStatuses[levelKey + "_nextTP"] = event.nextTP;
                    foundConfirmed = true;
                    break;
                }
                
                // Pending is weak evidence. Keep scanning; do not let it hide a true older confirmation.
                if (event && event.type === "PENDING" && i === latestCompletedIdx) {
                    sawPendingOnLatest = true;
                }
                // TAP on live candle: skip silently
                if (event && event.type === "TAP") {
                    continue;
                }
            }

            // PENDING is allowed only for the most recent completed candle and never overwrites confirmed states.
            if (!foundConfirmed && sawPendingOnLatest && currentStatus !== "SWEPT" && currentStatus !== "BROKEN") {
                this._levelStatuses[levelKey] = "PENDING";
            }
        }

        return events;
    },

    /**
     * Add a diagnostic log entry (capped at 100)
     */
    _addDiagnosticLog(pool, candle, event) {
        const bodySize = Math.abs(candle.close - candle.open);
        const totalRange = candle.high - candle.low;
        const bodyPct = totalRange > 0 ? ((bodySize / totalRange) * 100).toFixed(1) : "0.0";
        const istTime = new Date(candle.datetime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

        const entry = {
            timestamp: istTime,
            level: `${pool.name} @ $${pool.price.toFixed(2)}`,
            levelStatus: this._levelStatuses[`${pool.shortName}_${pool.price.toFixed(2)}`] || "ACTIVE",
            candle: {
                open: candle.open?.toFixed(2),
                high: candle.high?.toFixed(2),
                low: candle.low?.toFixed(2),
                close: candle.close?.toFixed(2),
                complete: candle.complete !== false
            },
            calculations: {
                bodyPct: bodyPct + "%",
                wickAbove: pool.side === "high" ? (candle.high - pool.price).toFixed(2) : "N/A",
                wickBelow: pool.side === "low" ? (pool.price - candle.low).toFixed(2) : "N/A",
                closeVsLevel: pool.side === "high"
                    ? (candle.close > pool.price ? `ABOVE by $${(candle.close - pool.price).toFixed(2)}` : `BELOW by $${(pool.price - candle.close).toFixed(2)}`)
                    : (candle.close < pool.price ? `BELOW by $${(pool.price - candle.close).toFixed(2)}` : `ABOVE by $${(candle.close - pool.price).toFixed(2)}`)
            },
            decision: event.type,
            reason: event.childDetail || event.type
        };

        this._diagnosticLogs.unshift(entry);
        if (this._diagnosticLogs.length > 100) this._diagnosticLogs.length = 100;

        // Also log to console for debugging
        console.log(`[LIQ EVENT] ${entry.decision} | ${entry.level} | Body: ${entry.calculations.bodyPct} | Close: ${entry.calculations.closeVsLevel}`);
    },

    /**
     * CRT Event Classification — SWEEP / BREAKOUT / PENDING / TAP
     *
     * Rules:
     *   SWEEP:    wick pierces level, close returns BACK INSIDE, wick depth > MIN_DEPTH
     *   BREAKOUT: close beyond level by > MIN_DEPTH, body ≥ 70%, FVG confirmed
     *   PENDING:  close beyond level but weak body or no FVG
     *   TAP:      live/incomplete candle touching level (no action)
     */
    classifyEvent(childCandle, pool, priorCandle, childCandles) {
        if (!childCandle || !pool || !pool.price) return null;
        const level = pool.price;
        const { open, high, low, close } = childCandle;
        const bodySize = Math.abs(close - open);
        const totalRange = high - low;
        const bodyRatio = totalRange > 0 ? bodySize / totalRange : 0;
        const isComplete = childCandle.complete !== false;

        // RULE D: If candle is NOT complete, only return TAP (no real event)
        if (!isComplete) {
            if (pool.side === "high" && high > level) return { type: "TAP" };
            if (pool.side === "low" && low < level) return { type: "TAP" };
            return null;
        }

        // Dynamic ATR calculation for MIN_DEPTH
        let atr = this.MIN_DEPTH;
        if (childCandles && childCandles.length > 14) {
            let trs = [childCandles[0].high - childCandles[0].low];
            for (let i = 1; i < childCandles.length; i++) {
                trs.push(Math.max(
                    childCandles[i].high - childCandles[i].low,
                    Math.abs(childCandles[i].high - childCandles[i - 1].close),
                    Math.abs(childCandles[i].low - childCandles[i - 1].close)
                ));
            }
            atr = trs[0];
            for (let i = 1; i < trs.length; i++) {
                atr = (atr * 13 + trs[i]) / 14;
            }
        }

        const minSweepDepth = Math.max(0.15, atr * 0.08);
        const minBreakDepth = Math.max(0.25, atr * 0.10);
        const hasTimeframePreference = pool.childTf === "1h" || pool.childTf === "4h";

        if (pool.side === "high") {
            const wickAbove = high - level;
            const closeAbove = close - level;

            // RULE A — SWEEP: wicked above level, closed back inside
            if (high > level && close <= level && wickAbove >= (minSweepDepth * 0.5)) {
                let strength = wickAbove >= atr * 0.25 ? "Very Strong" : "Strong";
                if (hasTimeframePreference) strength += " (Preferred TF)";
                return {
                    type: "SWEEP",
                    displayName: `${pool.name} Sweep`,
                    emoji: "🩸",
                    price: level,
                    childClose: close,
                    childDetail: `Wick $${wickAbove.toFixed(2)} above, Closed $${(level - close).toFixed(2)} below | Body ${(bodyRatio * 100).toFixed(0)}%`,
                    bias: "REVERSAL EXPECTED ↓",
                    biasDirection: "reversal",
                    strength
                };
            }
            // MULTI-CANDLE SWEEP: previous candle closed above, current candle engulfs and closes below
            else if (priorCandle && priorCandle.close > level && close <= level && high > level) {
                return {
                    type: "SWEEP",
                    displayName: `${pool.name} Multi-Candle Sweep`,
                    emoji: "🩸",
                    price: level,
                    childClose: close,
                    childDetail: `Engulfed back below $${level.toFixed(2)} | Body ${(bodyRatio * 100).toFixed(0)}%`,
                    bias: "REVERSAL EXPECTED ↓",
                    biasDirection: "reversal",
                    strength: "Strong"
                };
            }

            // Close is ABOVE the level
            if (close > level) {
                // BUG FIX: Wick Rejection Filter
                // If the upper wick is more than 35% of the total range, it is an institutional stop hunt, not a breakout!
                const upperWick = high - Math.max(open, close);
                const isRejected = totalRange > 0 && (upperWick / totalRange) > 0.35;

                if (isRejected) {
                    return {
                        type: "PENDING",
                        displayName: `${pool.name} Touch Pending`,
                        emoji: "⚠️",
                        price: level,
                        childClose: close,
                        childDetail: `Closed $${closeAbove.toFixed(2)} above, but upper wick rejection is too large (${((upperWick / totalRange) * 100).toFixed(0)}%)`,
                        bias: "PENDING — Wait for confirmation",
                        biasDirection: "pending",
                        strength: "Weak"
                    };
                }

                // RULE B — BREAKOUT: strong close with momentum
                if (closeAbove >= (minBreakDepth * 0.5) && bodyRatio >= 0.40) {
                    const hasFVG = this._checkFVGFormed(childCandles, childCandle);
                    const fvgLabel = hasFVG.formed
                        ? (hasFVG.pending ? ' | Pending FVG ⏳' : ' | FVG confirmed ✅')
                        : '';
                    return {
                        type: "BREAKOUT",
                        displayName: `${pool.name} Breakout`,
                        emoji: "💥",
                        price: level,
                        childClose: close,
                        childDetail: `Closed $${closeAbove.toFixed(2)} above | Body ${(bodyRatio * 100).toFixed(0)}%${fvgLabel}`,
                        fvgZone: hasFVG.zone,
                        bias: "CONTINUATION UP ↑",
                        biasDirection: "continuation",
                        strength: hasTimeframePreference ? "Strong (Preferred TF)" : "Strong"
                    };
                }

                // RULE C — PENDING: close beyond but weak momentum
                if (closeAbove > 0) {
                    return {
                        type: "PENDING",
                        displayName: `${pool.name} Touch Pending`,
                        emoji: "⚠️",
                        price: level,
                        childClose: close,
                        childDetail: `Closed $${closeAbove.toFixed(2)} above, but sweep/breakout momentum is weak`,
                        bias: "PENDING — Wait for confirmation",
                        biasDirection: "pending",
                        strength: "Weak"
                    };
                }
            }

            // Wick touched but below minimum sweep depth
            if (high >= level) {
                return {
                    type: "TAP",
                    displayName: `${pool.name} Tap`,
                    emoji: "⚠️",
                    price: level,
                    childClose: close,
                    childDetail: "Touched level; waiting for confirmation",
                    bias: "WAIT FOR CONFIRMATION",
                    biasDirection: "neutral",
                    strength: "Weak"
                };
            }

        } else {
            // LOW-side pool: price approaches from above
            const wickBelow = level - low;
            const closeBelow = level - close;

            // RULE A — SWEEP: wicked below level, closed back inside
            if (low < level && close >= level && wickBelow >= (minSweepDepth * 0.5)) {
                let strength = wickBelow >= atr * 0.25 ? "Very Strong" : "Strong";
                if (hasTimeframePreference) strength += " (Preferred TF)";
                return {
                    type: "SWEEP",
                    displayName: `${pool.name} Sweep`,
                    emoji: "🩸",
                    price: level,
                    childClose: close,
                    childDetail: `Wick $${wickBelow.toFixed(2)} below, Closed $${(close - level).toFixed(2)} above | Body ${(bodyRatio * 100).toFixed(0)}%`,
                    bias: "REVERSAL EXPECTED ↑",
                    biasDirection: "reversal",
                    strength
                };
            }
            // MULTI-CANDLE SWEEP: previous candle closed below, current candle engulfs and closes above
            else if (priorCandle && priorCandle.close < level && close >= level && high > level) {
                return {
                    type: "SWEEP",
                    displayName: `${pool.name} Multi-Candle Sweep`,
                    emoji: "🩸",
                    price: level,
                    childClose: close,
                    childDetail: `Engulfed back below $${level.toFixed(2)} | Body ${(bodyRatio * 100).toFixed(0)}%`,
                    bias: "REVERSAL EXPECTED ↑",
                    biasDirection: "reversal",
                    strength: "Strong"
                };
            }

            // Close is BELOW the level
            if (close < level) {
                // BUG FIX: Wick Rejection Filter
                // If the lower wick is more than 35% of the total range, it is an institutional stop hunt, not a breakout!
                const lowerWick = Math.min(open, close) - low;
                const isRejected = totalRange > 0 && (lowerWick / totalRange) > 0.35;

                if (isRejected) {
                    return {
                        type: "PENDING",
                        displayName: `${pool.name} Touch Pending`,
                        emoji: "⚠️",
                        price: level,
                        childClose: close,
                        childDetail: `Closed $${closeBelow.toFixed(2)} below, but lower wick rejection is too large (${((lowerWick / totalRange) * 100).toFixed(0)}%)`,
                        bias: "PENDING — Wait for confirmation",
                        biasDirection: "pending",
                        strength: "Weak"
                    };
                }

                // RULE B — BREAKOUT: strong close with momentum
                if (closeBelow >= (minBreakDepth * 0.5) && bodyRatio >= 0.40) {
                    const hasFVG = this._checkFVGFormed(childCandles, childCandle);
                    const fvgLabel = hasFVG.formed
                        ? (hasFVG.pending ? ' | Pending FVG ⏳' : ' | FVG confirmed ✅')
                        : '';
                    return {
                        type: "BREAKOUT",
                        displayName: `${pool.name} Breakout`,
                        emoji: "💥",
                        price: level,
                        childClose: close,
                        childDetail: `Closed $${closeBelow.toFixed(2)} below | Body ${(bodyRatio * 100).toFixed(0)}%${fvgLabel}`,
                        fvgZone: hasFVG.zone,
                        bias: "CONTINUATION DOWN ↓",
                        biasDirection: "continuation",
                        strength: hasTimeframePreference ? "Strong (Preferred TF)" : "Strong"
                    };
                }

                // RULE C — PENDING: close beyond but weak momentum
                if (closeBelow > 0) {
                    return {
                        type: "PENDING",
                        displayName: `${pool.name} Touch Pending`,
                        emoji: "⚠️",
                        price: level,
                        childClose: close,
                        childDetail: `Closed $${closeBelow.toFixed(2)} below, but sweep/breakout momentum is weak`,
                        bias: "PENDING — Wait for confirmation",
                        biasDirection: "pending",
                        strength: "Weak"
                    };
                }
            }

            // Wick touched but below minimum sweep depth
            if (low <= level) {
                return {
                    type: "TAP",
                    displayName: `${pool.name} Tap`,
                    emoji: "⚠️",
                    price: level,
                    childClose: close,
                    childDetail: "Touched level; waiting for confirmation",
                    bias: "WAIT FOR CONFIRMATION",
                    biasDirection: "neutral",
                    strength: "Weak"
                };
            }
        }

        return null;
    },

    /**
     * Detect Asian & London session highs/lows from H1 candles.
     */
    detectSessionHighsLows(h1Candles) {
        if (!h1Candles || !h1Candles.length) return this._sessionState;

        // Use the last available candle's time — UTC based, timezone safe
        const lastCandle = h1Candles.at(-1);
        const lastDate = this.parseUtcDate(lastCandle.datetime);
        const utcHour = lastDate.getUTCHours();
        const utcMinute = lastDate.getUTCMinutes();

        // Trading day resets at 00:00 UTC (05:30 IST)
        const currentDayOfYear = Math.floor(lastDate.getTime() / 86400000);

        if (this._sessionState.lastResetDay !== currentDayOfYear) {
            this._sessionState = { asianHigh: null, asianLow: null, londonHigh: null, londonLow: null, nyHigh: null, nyLow: null, asianLocked: false, londonLocked: false, nyLocked: false, lastResetDay: currentDayOfYear };
        }

        // Filter H1 candles for today (since 00:00 UTC)
        const todayStartUTC = new Date(lastDate);
        todayStartUTC.setUTCHours(0, 0, 0, 0);

        this._sessionState.todayStartUTC = todayStartUTC.getTime();

        const todayCandles = h1Candles.filter(c => this.parseUtcDate(c.datetime) >= todayStartUTC);

        // Asian: 00:00-07:00 UTC (05:30-12:30 IST)
        const asianCandles = todayCandles.filter(c => {
            const h = this.parseUtcDate(c.datetime).getUTCHours();
            return h >= 0 && h < 7;
        });
        if (asianCandles.length > 0) {
            this._sessionState.asianHigh = Math.max(...asianCandles.map(c => c.high));
            this._sessionState.asianLow = Math.min(...asianCandles.map(c => c.low));
        }
        // Lock Asian after 07:00 UTC
        if (utcHour >= 7) {
            this._sessionState.asianLocked = true;
        }

        // London: 07:00-12:00 UTC (12:30-17:30 IST)
        const londonCandles = todayCandles.filter(c => {
            const h = this.parseUtcDate(c.datetime).getUTCHours();
            return h >= 7 && h < 12;
        });
        if (londonCandles.length > 0) {
            this._sessionState.londonHigh = Math.max(...londonCandles.map(c => c.high));
            this._sessionState.londonLow = Math.min(...londonCandles.map(c => c.low));
        }
        // Lock London after 12:00 UTC
        if (utcHour >= 12) {
            this._sessionState.londonLocked = true;
        }

        // NY: 12:00-17:30 UTC (17:30-23:00 IST)
        const nyCandles = todayCandles.filter(c => {
            const d = this.parseUtcDate(c.datetime);
            const timeVal = d.getUTCHours() + d.getUTCMinutes() / 60;
            return timeVal >= 12 && timeVal < 17.5;
        });
        if (nyCandles.length > 0) {
            this._sessionState.nyHigh = Math.max(...nyCandles.map(c => c.high));
            this._sessionState.nyLow = Math.min(...nyCandles.map(c => c.low));
        }
        // Lock NY after 17:30 UTC
        const lastTimeVal = utcHour + utcMinute / 60;
        if (lastTimeVal >= 17.5) {
            this._sessionState.nyLocked = true;
        }

        return this._sessionState;
    },

    // --- Helper: Get candles by timeframe ID from MTF data ---
    _getCandles(mtfData, tfId) {
        if (!mtfData?.data || !Array.isArray(mtfData.data)) return [];
        const match = mtfData.data.find(d => d.id === tfId);
        if (!match || !Array.isArray(match.values)) return [];
        return AnalysisEngine.normalizeCandles(match.values);
    },

    _getChildCandles(mtfData, childTf) {
        const tfMap = { "1week": "1week", "1day": "1day", "4h": "4h", "1h": "h1", "15min": "15min" };
        return this._getCandles(mtfData, tfMap[childTf] || childTf);
    },

    // --- Helper: Compute quarterly high/low from monthly candles ---
    _computeQuarterly(monthlyCandles) {
        if (monthlyCandles.length < 4) return null;
        // Group by calendar quarter, find previous completed quarter
        const quarters = {};
        monthlyCandles.forEach(c => {
            const d = new Date(c.datetime);
            const q = `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
            if (!quarters[q]) quarters[q] = [];
            quarters[q].push(c);
        });
        const qKeys = Object.keys(quarters).sort();
        if (qKeys.length < 2) return null;
        const prevQ = quarters[qKeys[qKeys.length - 2]];
        return {
            high: Math.max(...prevQ.map(c => c.high)),
            low: Math.min(...prevQ.map(c => c.low))
        };
    },

    // --- Helper: Detect Equal Highs/Lows ---
    _detectEqualLevels(candles, currentPrice) {
        const levels = [];
        if (!candles || candles.length < 10) return levels;
        const tolerance = 0.5; // $0.50 for Gold
        const swings = this._findSwings(candles);
        const highs = swings.highs;
        const lows = swings.lows;

        // Find clusters of equal highs
        for (let i = 0; i < highs.length; i++) {
            for (let j = i + 1; j < highs.length; j++) {
                if (Math.abs(highs[i].price - highs[j].price) <= tolerance) {
                    const avgPrice = (highs[i].price + highs[j].price) / 2;
                    const formedAt = Math.max(highs[i].time, highs[j].time);
                    if (!levels.some(l => Math.abs(l.price - avgPrice) < 1.0)) {
                        levels.push({
                            name: "Equal Highs", shortName: "EQH", price: avgPrice,
                            side: "high", parent: "Any", childTf: "15min", tier: "inducement", formedAt
                        });
                    }
                }
            }
        }
        // Find clusters of equal lows
        for (let i = 0; i < lows.length; i++) {
            for (let j = i + 1; j < lows.length; j++) {
                if (Math.abs(lows[i].price - lows[j].price) <= tolerance) {
                    const avgPrice = (lows[i].price + lows[j].price) / 2;
                    const formedAt = Math.max(lows[i].time, lows[j].time);
                    if (!levels.some(l => Math.abs(l.price - avgPrice) < 1.0)) {
                        levels.push({
                            name: "Equal Lows", shortName: "EQL", price: avgPrice,
                            side: "low", parent: "Any", childTf: "15min", tier: "inducement", formedAt
                        });
                    }
                }
            }
        }
        return levels.slice(0, 4); // Cap at 4
    },

    // --- Helper: Detect Swing Points ---
    _detectSwingPoints(h1Candles, h4Candles, currentPrice) {
        const levels = [];
        const candles = h4Candles.length >= 10 ? h4Candles : h1Candles;
        if (candles.length < 5) return levels;
        const swings = this._findSwings(candles);

        if (swings.highs.length > 0) {
            const recentHigh = swings.highs[swings.highs.length - 1];
            levels.push({
                name: "Swing High", shortName: "SWH", price: recentHigh.price,
                side: "high", parent: "Any", childTf: h4Candles.length >= 10 ? "4h" : "1h", tier: "inducement",
                formedAt: recentHigh.time
            });
        }
        if (swings.lows.length > 0) {
            const recentLow = swings.lows[swings.lows.length - 1];
            levels.push({
                name: "Swing Low", shortName: "SWL", price: recentLow.price,
                side: "low", parent: "Any", childTf: h4Candles.length >= 10 ? "4h" : "1h", tier: "inducement",
                formedAt: recentLow.time
            });
        }
        return levels;
    },

    // --- Helper: Find swing highs and lows ---
    _findSwings(candles) {
        const highs = [];
        const lows = [];
        for (let i = 2; i < candles.length - 2; i++) {
            if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i - 2].high &&
                candles[i].high > candles[i + 1].high && candles[i].high > candles[i + 2].high) {
                highs.push({ price: candles[i].high, time: new Date(candles[i].datetime).getTime() });
            }
            if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i - 2].low &&
                candles[i].low < candles[i + 1].low && candles[i].low < candles[i + 2].low) {
                lows.push({ price: candles[i].low, time: new Date(candles[i].datetime).getTime() });
            }
        }
        return { highs, lows };
    },

    // --- Helper: Detect Round Numbers near current price ---
    _detectRoundNumbers(currentPrice) {
        const levels = [];
        const interval = 50; // $50 intervals for Gold
        const base = Math.floor(currentPrice / interval) * interval;
        for (let i = -2; i <= 2; i++) {
            const rn = base + (i * interval);
            if (rn > 0 && Math.abs(rn - currentPrice) <= 150) {
                levels.push({
                    name: `Round Number ($${rn.toLocaleString()})`, shortName: "RND", price: rn,
                    side: rn > currentPrice ? "high" : "low", parent: "Any", childTf: "reactive", tier: "inducement"
                });
            }
        }
        return levels;
    },

    // --- Helper: Strict 3-candle FVG validation ---
    // FVG requires: candle[n-1], candle[n] (breakout), candle[n+1]
    // Bullish FVG: candle[n+1].low > candle[n-1].high
    // Bearish FVG: candle[n+1].high < candle[n-1].low
    _checkFVGFormed(candles, breakoutCandle) {
        if (!candles || candles.length < 3) return { formed: false };
        const idx = candles.indexOf(breakoutCandle);

        // Standard (confirmed) 3-candle check: [n-1], [n], [n+1]
        // This is only valid when the breakout candle is NOT the latest candle,
        // because candle[n+1] must have fully closed for the gap to be real.
        if (idx >= 1 && idx < candles.length - 1) {
            const prev = candles[idx - 1];
            const next = candles[idx + 1];
            // Bullish FVG: next candle's low is entirely above prior candle's high
            if (next.low > prev.high) {
                return { formed: true, zone: `$${prev.high.toFixed(2)} → $${next.low.toFixed(2)}` };
            }
            // Bearish FVG: next candle's high is entirely below prior candle's low
            if (next.high < prev.low) {
                return { formed: true, zone: `$${next.high.toFixed(2)} → $${prev.low.toFixed(2)}` };
            }
        }

        // BUG FIX — "Latest Candle" Pending-FVG Heuristic:
        // When the breakout is on the LATEST candle (idx === candles.length - 1),
        // candle[n+1] has NOT formed yet — so a true 3-candle FVG cannot be confirmed.
        // Instead of falsely reporting a confirmed FVG (old broken behaviour), we now
        // check whether the breakout candle's body itself is displaced away from the
        // candle two bars earlier (a necessary — but not sufficient — condition for an
        // FVG).  If true, we return { formed: true, pending: true } so the UI can label
        // this as a "Pending FVG" rather than a fully confirmed one.
        if (idx >= 2 && idx === candles.length - 1) {
            const priorPrior = candles[idx - 2];
            // Bullish body displacement: breakout candle's LOW is above candle[n-2].HIGH
            if (breakoutCandle.low > priorPrior.high) {
                return {
                    formed: true,
                    pending: true,
                    zone: `$${priorPrior.high.toFixed(2)} → $${breakoutCandle.low.toFixed(2)} (Pending — await next close)`
                };
            }
            // Bearish body displacement: breakout candle's HIGH is below candle[n-2].LOW
            if (breakoutCandle.high < priorPrior.low) {
                return {
                    formed: true,
                    pending: true,
                    zone: `$${breakoutCandle.high.toFixed(2)} → $${priorPrior.low.toFixed(2)} (Pending — await next close)`
                };
            }
        }

        // No FVG found — cannot confirm breakout
        return { formed: false };
    },

    // --- Helper: Tier label ---
    _tierLabel(tier) {
        const map = { extreme: "🔴 Extreme Point", midExtreme: "🟠 Mid-Extreme Point", decisional: "🟡 Decisional Point", inducement: "🟢 Inducement" };
        return map[tier] || tier;
    },

    // --- Helper: Find next TP target ---
    _findNextTP(allPools, currentPool, eventType, currentClose) {
        // Sweep → target opposite-side liquidity
        // Breakout → target next liquidity in breakout direction
        const isSweep = eventType === "SWEEP";
        const direction = currentPool.side === "high"
            ? (isSweep ? "low" : "high")
            : (isSweep ? "high" : "low");

        const candidates = allPools
            .filter(p => p !== currentPool && p.side === direction && p.price > 0)
            .map(p => ({ ...p, dist: Math.abs(p.price - currentClose) }))
            .sort((a, b) => a.dist - b.dist);

        if (candidates.length > 0) {
            return `${candidates[0].name} @ $${safeToFixed(candidates[0].price, 2)}`;
        }
        return "Next institutional level";
    }
};

// --- Liquidity Notification System ---
let _lastNotifiedEventKeys = new Set();

function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
        // Show inline banner instead of immediate popup
        const banner = document.getElementById("notificationBanner");
        if (banner) banner.style.display = "flex";
    }
}

function enableNotifications() {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then(perm => {
        const banner = document.getElementById("notificationBanner");
        if (banner) banner.style.display = "none";
    });
}

function fireLiquidityNotification(event) {
    if (!event || !event.pool) return;
    if (Notification.permission !== "granted") return;

    // Deduplication key: pool shortName + event type + price (rounded)
    const eventKey = `${event.pool.shortName}-${event.type}-${Math.round(event.price)}`;
    if (_lastNotifiedEventKeys.has(eventKey)) return;
    _lastNotifiedEventKeys.add(eventKey);
    // Keep set from growing forever
    if (_lastNotifiedEventKeys.size > 50) {
        const first = _lastNotifiedEventKeys.values().next().value;
        _lastNotifiedEventKeys.delete(first);
    }

    const isSweep = event.type === "SWEEP";
    const title = isSweep
        ? "🩸 GOLD LIQUIDITY SWEPT (Reversal Signal)"
        : "💥 GOLD LIQUIDITY BROKEN (Continuation Signal)";

    let body = `Type    : ${event.displayName}\n`;
    body += `Price   : $${event.price.toFixed(2)}\n`;
    body += `Tier    : ${event.tierLabel}\n`;
    body += `Parent  : ${event.pool.parent}\n`;
    body += `Child TF: ${String(event.pool?.childTf || "N/A").toUpperCase()} (${event.childDetail || "N/A"}) ✅\n`;
    if (event.fvgZone) body += `FVG Zone: ${event.fvgZone}\n`;
    body += `Time    : ${event.time} IST\n`;
    body += `Bias    : ${event.bias}\n`;
    body += `Next TP : ${event.nextTP}`;

    try {
        new Notification(title, {
            body,
            icon: "favicon.svg",
            image: "candle_guide.png",
            tag: eventKey,
            requireInteraction: true
        });
    } catch (e) {
        console.warn("Notification failed:", e);
    }
}

function fireAllLiquidityNotifications(events) {
    if (!Array.isArray(events)) return;
    events.forEach(ev => fireLiquidityNotification(ev));
}

// --- Execution & UI ---
async function runAnalysis() {
    if (state.isRunning) return;
    state.isRunning = true;
    toggleScanUI(true);
    dom.setStatus("Running bot preview on the latest market structure...");

    try {
        const symbol = encodeURIComponent(state.botInstrument || "XAU_USD");

        // --- Step 1: Fetch market data ---
        // PRIMARY: Hit the Cloudflare Worker (which uses KV-cached candle data from OANDA)
        // FALLBACK: Hit the local Node.js server (which fetches directly from OANDA, no KV cache)
        let res, mtfData;
        const queryParams = `symbol=${symbol}&entryTf=${state.selectedTimeframe}&outputsize=${state.candleCount || 1000}`;
        const cloudflareUrl = `${EDGE_API_BASE}${APP_CONFIG.marketMtfPath}?${queryParams}`;
        const localFallbackUrl = `/api${APP_CONFIG.marketMtfPath}?${queryParams}`;
        let fetchSuccess = false;
        let primaryErrMessage = "";
        let dataSource = "";

        // --- Attempt 1: Cloudflare Worker (has KV edge cache with growing candle history) ---
        try {
            res = await fetch(cloudflareUrl);
            if (res.ok) {
                mtfData = await res.json().catch(() => ({}));
                if (mtfData && Array.isArray(mtfData.data)) {
                    fetchSuccess = true;
                    dataSource = `Cloudflare KV (${res.headers.get("X-Cache") || "LIVE"})`;
                } else {
                    primaryErrMessage = "Cloudflare: Malformed data payload (missing data array)";
                }
            } else {
                const errPayload = await res.json().catch(() => ({}));
                primaryErrMessage = `Cloudflare HTTP ${res.status}: ${errPayload?.message || errPayload?.errorMessage || "Unknown error"}`;
            }
        } catch (fetchErr) {
            primaryErrMessage = `Cloudflare: ${fetchErr.message}`;
        }

        // --- Attempt 2: Local server fallback (direct OANDA fetch, no KV cache) ---
        if (!fetchSuccess) {
            console.warn(`Cloudflare Worker failed (${primaryErrMessage}). Falling back to local server...`);
            try {
                res = await fetch(localFallbackUrl);
                if (res.ok) {
                    mtfData = await res.json().catch(() => ({}));
                    if (mtfData && Array.isArray(mtfData.data)) {
                        fetchSuccess = true;
                        dataSource = "Local Server (OANDA Direct)";
                    } else {
                        primaryErrMessage += ` | Local: Malformed data payload`;
                    }
                } else {
                    const errPayload = await res.json().catch(() => ({}));
                    primaryErrMessage += ` | Local HTTP ${res.status}: ${errPayload?.message || errPayload?.errorMessage || "Unknown error"}`;
                }
            } catch (fallbackErr) {
                primaryErrMessage += ` | Local: ${fallbackErr.message}`;
            }
        }

        if (fetchSuccess) {
            console.log(`✅ Market data loaded from: ${dataSource}`);
        }

        if (!fetchSuccess) {
            showAnalysisError(
                "Market Data Unreachable",
                `Failed to fetch market data from both Cloudflare and Vercel/local backends.\n\nErrors encountered:\n${primaryErrMessage}\n\nPlease check your configuration and network connection.`
            );
            return;
        }

        const analysis = AnalysisEngine.run(mtfData);

        // --- Liquidity Engine Integration ---
        try {
            const liquidityPools = LiquidityEngine.computeLiquidityPools(mtfData);
            const liquidityEvents = LiquidityEngine.scanAllLiquidityEvents(liquidityPools, mtfData);
            const sessionLevels = LiquidityEngine._sessionState;
            analysis.liquidityPools = liquidityPools;
            analysis.liquidityEvents = liquidityEvents;
            analysis.sessionLevels = sessionLevels;
            // Fire browser push notifications for confirmed events
            fireAllLiquidityNotifications(liquidityEvents);
        } catch (liqErr) {
            console.warn("LiquidityEngine error:", liqErr);
            analysis.liquidityPools = { extreme: [], midExtreme: [], decisional: [], inducement: [] };
            analysis.liquidityEvents = [];
            analysis.sessionLevels = {};
        }

        state.lastAnalysisData = analysis;
        renderMarketUI(analysis);
        state.lastMtfData = mtfData;   // <--- INJECT THIS LINE!
        renderFibonacciOteUI(mtfData);

        // --- Step 2: Consult AI arbiter ---
        dom.setStatus("Consulting Arbiter Council for Consensus...");
        const prompt = buildAiPrompt(analysis, mtfData);
        const selectedModel = state.models.find(model => model.key === state.selectedModelKey) || state.models[0] || {};

        let aiRes, aiData;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000);
        try {
            aiRes = await fetch(`${EDGE_API_BASE}${APP_CONFIG.aiChatPath}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    selectedModelKey: state.selectedModelKey,
                    model: selectedModel?.id,
                    label: selectedModel?.label,
                    apiKey: selectedModel?.apiKey,
                    baseUrl: selectedModel?.baseUrl,
                    models: state.models,
                    debateModels: state.debateModels,
                    temperature: state.temperature,
                    prompt
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            aiData = await aiRes.json().catch(() => ({}));
        } catch (aiErr) {
            clearTimeout(timeoutId);
            // AI network failed — render deterministic fallback so panel is never blank
            dom.setStatus(`Market analysis complete. AI offline: ${aiErr.message}`);
            const fallbackPayload = buildLocalAiFallback(analysis, `AI model unreachable: ${aiErr.message}`);
            renderAiUI(fallbackPayload, analysis);
            syncHistory(analysis, fallbackPayload);
            refreshBotStatus().catch(() => {});
            return;
        }

        // Worker may return a fallback payload with choices[] even on non-200
        const hasFallback = Array.isArray(aiData?.choices) && aiData.choices.length > 0;
        if (!aiRes.ok && !hasFallback) {
            dom.setStatus(`AI unavailable (${aiRes.status}): ${aiData?.message || "Check API keys in Settings."}`);
            const fallbackPayload = buildLocalAiFallback(analysis, `Server error ${aiRes.status}: ${aiData?.message || 'Check API keys.'}`);
            renderAiUI(fallbackPayload, analysis);
            syncHistory(analysis, fallbackPayload);
            refreshBotStatus().catch(() => {});
            return;
        }

        renderAiUI(aiData, analysis);
        syncHistory(analysis, aiData);
        refreshBotStatus().catch(() => {});

        dom.setStatus(`Preview complete | RMI: ${state.currentRmi} | Bias: ${state.rmiBias}`);
    } catch (e) {
        showAnalysisError("Unexpected Error", e.message || String(e));
        console.error("runAnalysis error:", e);
    } finally {
        state.isRunning = false;
        toggleScanUI(false);
    }
}

function showAnalysisError(title, detail) {
    dom.setStatus(`⚠ ${title}`);
    const out = dom.get("#aiOutput");
    if (out) out.textContent = `⚠ ${title}\n\n${detail}`;
    const eq = dom.get("#equationsOutput");
    if (eq) eq.textContent = `Blocked by: ${title}. See Model Interpretation panel.`;
    const badge = dom.get("#aiBadge");
    if (badge) { badge.textContent = "ERROR"; badge.className = "badge muted"; }
}

function buildLocalAiFallback(analysis, reason) {
    const trend = analysis?.trend || "neutral";
    const price = Number(analysis?.price || 0);
    const rmi = analysis?.rmi?.value ?? 0;
    const bias = analysis?.rmi?.bias || "neutral";
    const direction = trend === "bullish" ? "Buy" : trend === "bearish" ? "Sell" : "Stay Flat";
    const isFlat = direction === "Stay Flat";
    const tp1 = analysis?.decision?.tp1 ? safeToFixed(analysis.decision.tp1) : "N/A";
    const stop = analysis?.decision?.stopPrice ? safeToFixed(analysis.decision.stopPrice) : "N/A";
    const summaryText = isFlat
        ? `Rule engine signals a neutral posture on XAU/USD. RMI (${safeToFixed(rmi)}) is ${bias}. No directional edge detected — staying flat until structure confirms. ${reason}`
        : `Rule engine signals a ${direction.toLowerCase()} setup on XAU/USD at $${safeToFixed(price)}. RMI (${safeToFixed(rmi)}) is ${bias}. Structure favors ${trend} continuation. AI Arbiter offline — deterministic analysis shown. ${reason}`;

    const payload = {
        researcher: {
            summary: summaryText,
            direction: direction,
            riskNote: `AI model is currently unavailable. This output is generated by the local deterministic rule engine. Treat as a safety reference, not an AI consensus. Reason: ${reason}`
        },
        trader: {
            entryZone: isFlat ? "N/A" : `Near $${price.toFixed(2)} — wait for structure confirmation`,
            takeProfitLevels: isFlat ? "N/A" : `T1: $${tp1}`,
            stopLoss: isFlat ? "N/A" : `$${stop}`,
            positionSizing: isFlat ? "N/A" : "Reduce size until AI confirms setup",
            timeHorizon: isFlat ? "N/A" : "Intraday",
            invalidation: isFlat ? "N/A" : `Structural close beyond $${stop}`
        },
        equations: {
            review: null
        }
    };

    // Return as a choices-format payload matching what the AI would return
    return {
        choices: [{
            message: {
                content: JSON.stringify(payload)
            }
        }],
        fallbackUsed: true
    };
}

function renderMarketUI(a) {
    const d = a.decision;
    if (dom.get("#decisionLabel")) dom.get("#decisionLabel").textContent = d.action;
    if (dom.get("#confidenceLabel")) dom.get("#confidenceLabel").textContent = `${d.confidence}%`;
    if (dom.get("#riskLabel")) dom.get("#riskLabel").textContent = d.action === "Buy" || d.action === "Sell" ? "Active" : "Flat";
    if (dom.get("#priceLabel")) dom.get("#priceLabel").textContent = a.price.toFixed(2);
    if (dom.get("#rmiValue")) dom.get("#rmiValue").textContent = a.rmi.value.toFixed(2);
    if (dom.get("#rmiTrend")) {
        dom.get("#rmiTrend").textContent = a.rmi.bias.toUpperCase();
        dom.get("#rmiTrend").className = a.rmi.bias;
    }
    
    dom.fillList("#tradePlanList", d.tradePlan);
    dom.fillList("#fvgList", a.fvgs.map(f => `${f.side.toUpperCase()} @ ${f.price.toFixed(2)} [${f.type || "Standard"}]`));
    dom.fillList("#obList", a.orderBlocks || ["Awaiting chart analysis."]);
    dom.fillList("#structureList", a.structureEvents || ["Awaiting chart analysis."]);
    dom.fillList("#reversalList", a.reversalZones || ["Awaiting chart analysis."]);
    dom.fillList("#liquidityList", a.liquidity || ["Awaiting chart analysis."]);
    dom.fillList("#fibList", a.fibonacci?.displayList || ["Awaiting chart analysis."]);
    dom.fillList("#scenarioList", a.scenarios || ["Awaiting chart analysis."]);
    dom.fillList("#htfList", a.htfAlignment || ["Awaiting chart analysis."]);
    
    // Summary Cards
    const sc = dom.get("#summaryCards");
    if (sc) {
        sc.innerHTML = `
            <article class="summary-card"><p>Trend</p><strong>${a.trend.toUpperCase()}</strong></article>
            <article class="summary-card"><p>RMI Bias</p><strong>${a.rmi.bias.toUpperCase()}</strong></article>
            <article class="summary-card"><p>Price</p><strong>${a.price.toFixed(2)}</strong></article>
            <article id="summaryDebateCard" class="summary-card" style="cursor: pointer;"><p>Debate Council ↗</p><strong id="summaryDebateCount">—</strong></article>
        `;
        const debateCard = dom.get("#summaryDebateCard");
        if (debateCard) {
            debateCard.onclick = () => showDebateCouncilModal();
        }
    }

    // Three Equations Doctrine Bind
    const eq = dom.get("#equationsOutput");
    if (eq && a.equationsText) {
        eq.textContent = a.equationsText;
    }
    const eqBadge = dom.get("#equationsBadge");
    if (eqBadge) {
        eqBadge.textContent = "READY";
        eqBadge.className = "badge";
    }

    // --- Institutional Liquidity Pools Rendering ---
    renderLiquidityPoolsUI(a.liquidityPools, a.liquidityEvents);
    renderLiquidityEventBox(a.liquidityEvents);
    renderSessionLevels(a.sessionLevels);
    renderInstitutionalLifecycleInfo(a.liquidityEvents);

    renderLifecycleUI(a.lifecycle);
    renderHeatmapUI(a.heatmap);
    startRealTimeFeeds(a);
}

function renderLiquidityPoolsUI(pools, events) {
    const container = dom.get("#liquidityPoolsGrid");
    if (!container || !pools) return;

    // BUG FIX: Key the eventMap by the composite "shortName_price" string instead of
    // just shortName.  Using only shortName meant that all pools of the same type
    // (e.g. every Equal High is "EQH") would overwrite each other in the map, causing
    // every active EQH to display as "Swept" once any single one was swept.
    const eventMap = {};
    if (Array.isArray(events)) {
        events.forEach(ev => {
            if (ev.pool) {
                const key = `${ev.pool.shortName}_${ev.pool.price.toFixed(2)}`;
                eventMap[key] = ev;
            }
        });
    }

    const renderTier = (tierName, tierKey, pools, cssClass) => {
        if (!pools || pools.length === 0) return "";
        const poolItems = pools.map(p => {
            const levelKey = `${p.shortName}_${p.price.toFixed(2)}`;
            const ev = eventMap[levelKey]; // BUG FIX: use composite key, not just shortName
            const currentStatus = LiquidityEngine._levelStatuses[levelKey];
            
            let statusClass = "active";
            let statusText = "Active";
            if (ev && (ev.type === "SWEEP" || ev.type === "SWEPT")) { statusClass = "swept"; statusText = "Swept 🩸"; }
            else if (ev && (ev.type === "BREAKOUT" || ev.type === "BROKEN")) { statusClass = "broken"; statusText = "Broken 💥"; }
            else if (currentStatus === "SWEPT") { statusClass = "swept"; statusText = "Swept 🩸"; }
            else if (currentStatus === "BROKEN") { statusClass = "broken"; statusText = "Broken 💥"; }
            else if (currentStatus === "PENDING") { statusClass = "pending"; statusText = "Pending ⚠️"; }
            else if (p.sessionStatus === "tracking") { statusClass = "tracking"; statusText = "Tracking"; }
            else if (p.sessionStatus === "locked") { statusClass = "active"; statusText = "Locked"; }
            return `<div class="pool-item">
                <span class="pool-name">${escapeHtml(p.name)}</span>
                <span class="pool-price">$${p.price.toFixed(2)}</span>
                <span class="pool-status ${statusClass}">${statusText}</span>
            </div>`;
        }).join("");

        return `<div class="liquidity-tier-card ${cssClass}">
            <div class="tier-header"><span class="tier-icon">${tierName.split(" ")[0]}</span><span class="tier-name">${tierName}</span></div>
            <div class="tier-body">${poolItems}</div>
        </div>`;
    };

    container.innerHTML =
        renderTier("🔴 Extreme Point", "extreme", pools.extreme, "tier-extreme") +
        renderTier("🟠 Mid-Extreme Point", "midExtreme", pools.midExtreme, "tier-mid-extreme") +
        renderTier("🟡 Decisional Point", "decisional", pools.decisional, "tier-decisional") +
        renderTier("🟢 Inducement", "inducement", pools.inducement, "tier-inducement");
}

function renderLiquidityEventBox(events) {
    const container = dom.get("#liquidityEventBox");
    if (!container) return;

    if (!Array.isArray(events) || events.length === 0) {
        container.innerHTML = `<div class="liquidity-event-box"><div class="event-header"><span class="event-emoji">⏳</span><span class="event-title">No Confirmed Events</span></div><p style="color:var(--muted);font-size:0.85rem;margin:0.5rem 0 0;">Monitoring all liquidity pools for sweep or breakout confirmation on child-candle close.</p></div>`;
        return;
    }

    // Apply filtering if a filter is selected
    const filterSelect = dom.get("#eventFilterSelect");
    let filterVal = filterSelect ? filterSelect.value : "all";
    
    // Only display active (non-dead/non-historical) events in the confirmed events alert box
    let filteredEvents = events.filter(e => !e._dead);
    if (filterVal === "sweep") filteredEvents = filteredEvents.filter(e => e.type === "SWEEP" || e.type === "SWEPT");
    else if (filterVal === "breakout") filteredEvents = filteredEvents.filter(e => e.type === "BREAKOUT" || e.type === "BROKEN");
    else if (filterVal === "extreme") filteredEvents = filteredEvents.filter(e => e.pool?.tier === "extreme");
    else if (filterVal === "midExtreme") filteredEvents = filteredEvents.filter(e => e.pool?.tier === "midExtreme");
    else if (filterVal === "decisional") filteredEvents = filteredEvents.filter(e => e.pool?.tier === "decisional");
    else if (filterVal === "inducement") filteredEvents = filteredEvents.filter(e => e.pool?.tier === "inducement");

    if (filteredEvents.length === 0) {
        container.innerHTML = `<div class="liquidity-event-box"><div class="event-header"><span class="event-emoji">⏳</span><span class="event-title">No Matching Events</span></div><p style="color:var(--muted);font-size:0.85rem;margin:0.5rem 0 0;">No events match the selected filter criteria.</p></div>`;
        return;
    }

    const tierPriority = { extreme: 0, midExtreme: 1, decisional: 2, inducement: 3 };
    const sorted = [...filteredEvents].sort((a, b) => (tierPriority[a.pool?.tier] || 9) - (tierPriority[b.pool?.tier] || 9));
    
    let html = "";
    sorted.slice(0, 3).forEach(ev => {
        const isSweep = ev.type === "SWEEP" || ev.type === "SWEPT";
        const boxClass = isSweep ? "sweep" : "breakout";
        html += `<div class="liquidity-event-box ${boxClass}" style="margin-bottom: 1rem;">
            <div class="event-header">
                <span class="event-emoji">${ev.emoji}</span>
                <span class="event-title">${isSweep ? "LIQUIDITY SWEEP CONFIRMED" : "LIQUIDITY BREAKOUT CONFIRMED"}</span>
            </div>
            <div class="event-grid">
                <span class="event-key">Event Type</span><span class="event-value">${ev.type} (${isSweep ? "Reversal Signal" : "Continuation Signal"})</span>
                <span class="event-key">Liquidity</span><span class="event-value">${escapeHtml(ev.displayName)}</span>
                <span class="event-key">Price Level</span><span class="event-value">$${ev.price.toFixed(2)}</span>
                <span class="event-key">Parent Candle</span><span class="event-value">${ev.pool.parent}</span>
                <span class="event-key">Child Candle</span><span class="event-value">${String(ev.pool?.childTf || "N/A").toUpperCase()} (${ev.childDetail || "N/A"}) ✅</span>
                ${ev.fvgZone ? `<span class="event-key">FVG Zone</span><span class="event-value">${ev.fvgZone}</span>` : ""}
                <span class="event-key">Time (IST)</span><span class="event-value">${ev.time}</span>
                <span class="event-key">Tier</span><span class="event-value">${ev.tierLabel}</span>
                <span class="event-key">Bias</span><span class="event-value event-bias ${ev.biasDirection}">${ev.bias}</span>
                <span class="event-key">Next TP Target</span><span class="event-value">${escapeHtml(ev.nextTP)}</span>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function renderSessionLevels(sessionLevels) {
    const container = dom.get("#sessionLevelsDisplay");
    if (!container || !sessionLevels) return;

    let html = "";
    if (sessionLevels.asianHigh != null) {
        const asianClass = sessionLevels.asianLocked ? "locked" : "tracking";
        html += `<div class="session-level asian ${asianClass}">
            <span class="session-label">🌏 Asian High</span>
            <span class="session-price">$${safeToFixed(sessionLevels.asianHigh)}</span>
            <span class="session-status">${sessionLevels.asianLocked ? "LOCKED" : "TRACKING"}</span>
        </div>`;
        html += `<div class="session-level asian ${asianClass}">
            <span class="session-label">🌏 Asian Low</span>
            <span class="session-price">$${safeToFixed(sessionLevels.asianLow)}</span>
            <span class="session-status">${sessionLevels.asianLocked ? "LOCKED" : "TRACKING"}</span>
        </div>`;
    }
    if (sessionLevels.londonHigh != null) {
        const londonClass = sessionLevels.londonLocked ? "locked" : "tracking";
        html += `<div class="session-level london ${londonClass}">
            <span class="session-label">🇬🇧 London High</span>
            <span class="session-price">$${safeToFixed(sessionLevels.londonHigh)}</span>
            <span class="session-status">${sessionLevels.londonLocked ? "LOCKED" : "TRACKING"}</span>
        </div>`;
        html += `<div class="session-level london ${londonClass}">
            <span class="session-label">🇬🇧 London Low</span>
            <span class="session-price">$${safeToFixed(sessionLevels.londonLow)}</span>
            <span class="session-status">${sessionLevels.londonLocked ? "LOCKED" : "TRACKING"}</span>
        </div>`;
    }
    if (sessionLevels.nyHigh != null) {
        const nyClass = sessionLevels.nyLocked ? "locked" : "tracking";
        html += `<div class="session-level ny ${nyClass}">
            <span class="session-label">🗽 New York High</span>
            <span class="session-price">$${safeToFixed(sessionLevels.nyHigh)}</span>
            <span class="session-status">${sessionLevels.nyLocked ? "LOCKED" : "TRACKING"}</span>
        </div>`;
        html += `<div class="session-level ny ${nyClass}">
            <span class="session-label">🗽 New York Low</span>
            <span class="session-price">$${safeToFixed(sessionLevels.nyLow)}</span>
            <span class="session-status">${sessionLevels.nyLocked ? "LOCKED" : "TRACKING"}</span>
        </div>`;
    }
    if (!html) {
        html = `<p style="color:var(--muted);font-size:0.85rem;">Session levels will populate during Asian (05:30-12:30 IST), London (12:30-17:30 IST) and NY (17:30-23:00 IST) hours.</p>`;
    }
    container.innerHTML = html;
}

function renderInstitutionalLifecycleInfo(events) {
    const container = dom.get("#institutionalLifecycleInfo");
    if (!container) return;

    const activeTiers = new Set();
    if (Array.isArray(events)) {
        events.forEach(ev => { if (ev.pool?.tier) activeTiers.add(ev.pool.tier); });
    }

    const tiers = [
        { key: "extreme", dot: "dot-extreme", label: "🔴 Extreme Point", desc: "Price reacting to Previous Month/Quarter H/L. Confirmed on Weekly child close." },
        { key: "midExtreme", dot: "dot-mid-extreme", label: "🟠 Mid-Extreme", desc: "PDH/PDL (4H child) or PWH/PWL (Daily child). Key daily/weekly bias reference." },
        { key: "decisional", dot: "dot-decisional", label: "🟡 Decisional", desc: "Asian or London Session H/L. Intraday decision zone. 1H child close." },
        { key: "inducement", dot: "dot-inducement", label: "🟢 Inducement", desc: "EQH/EQL, Swing Points, Round Numbers. Retail stop-loss pools." }
    ];

    container.innerHTML = tiers.map(t => {
        const active = activeTiers.has(t.key) ? " active" : "";
        return `<div class="lifecycle-info-row${active}">
            <span class="lifecycle-info-dot ${t.dot}"></span>
            <div><strong>${t.label}</strong><br><span style="color:var(--muted);font-size:0.8rem;">${t.desc}</span></div>
        </div>`;
    }).join("");
}

// --- AI Section Parser ---
function parseAiJson(rawText) {
    const extractFirstJsonObject = (text) => {
        const start = text.indexOf("{");
        if (start === -1) return "";

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < text.length; i++) {
            const char = text[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === "\\") {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) continue;

            if (char === "{") depth += 1;
            if (char === "}") {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(start, i + 1);
                }
            }
        }

        return "";
    };

    try {
        let cleanText = rawText.trim();
        if (cleanText.startsWith("```json")) {
            cleanText = cleanText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
        } else if (cleanText.startsWith("```")) {
            cleanText = cleanText.replace(/^```\s*/, "").replace(/\s*```$/, "");
        }
        try {
            return JSON.parse(cleanText);
        } catch {
            const recoveredJson = extractFirstJsonObject(cleanText);
            if (recoveredJson) {
                return JSON.parse(recoveredJson);
            }
            throw new Error("No JSON object found in AI response.");
        }
    } catch (e) {
        console.warn("AI JSON Parse Error, attempting recovery.", e);
        return null;
    }
}


function renderAiUI(ai, analysis) {
    const rawText = extractAiText(ai) || "";
    let data = parseAiJson(rawText);

    if (!data) {
        data = {
            researcher: { summary: "Failed to parse AI response. " + rawText.slice(0, 100), direction: "Stay Flat", riskNote: "" },
            trader: { entryZone: "N/A", takeProfitLevels: "N/A", stopLoss: "N/A", positionSizing: "N/A", timeHorizon: "N/A", invalidation: "N/A" },
            equations: { review: "Pending JSON response." }
        };
    }

    // ── Determine final AI direction
    const aiDirection = (data.researcher?.direction || "").trim();
    const normalizedDirection = /buy|bull|long/i.test(aiDirection)  ? "Buy"
                              : /sell|bear|short/i.test(aiDirection) ? "Sell"
                              : "Stay Flat";
    const isFlat = normalizedDirection === "Stay Flat";

    // ── 1. Decision strip override (AI beats rule engine)
    if (dom.get("#decisionLabel")) dom.get("#decisionLabel").textContent = normalizedDirection;
    if (dom.get("#riskLabel"))     dom.get("#riskLabel").textContent = isFlat ? "Flat" : "Active";
    if (dom.get("#aiBadge"))       dom.get("#aiBadge").textContent = "COMPLETE";

    // ── 2. Model Interpretation panel — branches on Stay Flat vs Active
    const out = dom.get("#aiOutput");
    if (out) {
        if (isFlat) {
            const reason   = data.researcher?.summary || "Arbiter flagged this setup as invalid.";
            const watchFor = data.trader?.invalidation || "Monitor structure for a valid trigger.";
            const riskNote = data.researcher?.riskNote || "";
            out.textContent = [
                "⚠ STAY FLAT — DO NOT TRADE",
                "",
                "Reason:",
                reason,
                "",
                "What to watch for (trigger to re-evaluate):",
                watchFor,
                riskNote ? `\nRisk Note:\n${riskNote}` : ""
            ].join("\n").trim();
        } else {
            const parts = [];
            if (data.researcher?.summary)        parts.push(`Summary\n${data.researcher.summary}`);
            if (normalizedDirection)             parts.push(`\nDirection\n${normalizedDirection}`);
            if (data.trader?.entryZone)          parts.push(`\nEntry Zone\n${data.trader.entryZone}`);
            if (data.trader?.takeProfitLevels)   parts.push(`\nTake Profit Levels\n${data.trader.takeProfitLevels}`);
            if (data.trader?.stopLoss)           parts.push(`\nStop Loss\n${data.trader.stopLoss}`);
            if (data.trader?.positionSizing)     parts.push(`\nPosition Sizing\n${data.trader.positionSizing}`);
            if (data.trader?.timeHorizon)        parts.push(`\nTime Horizon\n${data.trader.timeHorizon}`);
            if (data.trader?.invalidation)       parts.push(`\nInvalidation\n${data.trader.invalidation}`);
            if (data.researcher?.riskNote)       parts.push(`\nRisk Note\n${data.researcher.riskNote}`);
            out.textContent = parts.join("\n") || "Arbiter response pending.";
        }
    }

    // ── 3. Trade plan list
    if (isFlat) {
        dom.fillList("#tradePlanList", [
            "⛔ NO TRADE — Arbiter: Stay Flat",
            `Watch for: ${(data.trader?.invalidation || "a valid institutional trigger").slice(0, 150)}`,
            "Win-rate or structural reason flagged. See Model Interpretation."
        ]);
    }

    // ── 4. Three Equations panel
    const eq = dom.get("#equationsOutput");
    if (eq) {
        let text = analysis.equationsText || "";
        if (data.equations && data.equations.review && data.equations.review !== "Pending JSON response.") {
            text += `\n\n` + [
                `================================================================================`,
                `                      ARBITER COUNCIL COMMENTARY & REVIEW`,
                `================================================================================`,
                data.equations.review
            ].join("\n");
        }
        eq.textContent = text;
    }
    if (dom.get("#equationsBadge")) {
        dom.get("#equationsBadge").textContent = "READY";
        dom.get("#equationsBadge").className = "badge";
    }

    // Update summary card debate count
    const debateSuccessful = Number(ai.debateSuccessful || 0);
    const debateAttempted = Number(ai.debateAttempted || 0);
    const summaryDebateEl = dom.get("#summaryDebateCount");
    if (summaryDebateEl) {
        summaryDebateEl.textContent = `${debateSuccessful} / ${debateAttempted}`;
    }

    state.lastAiResult = { data, ai, analysis, direction: normalizedDirection };

    // ── 7. Scorecard panel
    const score = dom.get("#scorecardContent");
    if (score) {
        const card = normalizeScorecard(data.scorecard, analysis, isFlat);
        score.innerHTML = `
            <div class="score-card"><p>TDS Score</p><strong>${escapeHtml(card.tdsScore)}%</strong></div>
            <div class="score-card"><p>Confluence</p><strong>${escapeHtml(card.confluence)}</strong></div>
            <div class="score-card"><p>Confidence</p><strong>${escapeHtml(card.confidence)}%</strong></div>
            <div class="score-card"><p>Grade</p><strong style="color:${card.grade === 'Active' ? '#22c55e' : card.grade === 'Watch' ? '#f59e0b' : '#ef4444'}">${escapeHtml(card.grade)}</strong></div>
        `;
    }
    if (dom.get("#scorecardBadge")) dom.get("#scorecardBadge").textContent = "VERIFIED";
}

function normalizeScorecard(scorecard, analysis, isFlat) {
    const fallback = buildLocalScorecard(analysis, isFlat);
    if (!scorecard || typeof scorecard !== "object") return fallback;
    const tdsScore = clampScore(scorecard.tdsScore ?? scorecard.score ?? fallback.tdsScore);
    const confidence = clampScore(scorecard.confidence ?? tdsScore);
    return {
        tdsScore,
        confidence,
        confluence: String(scorecard.confluence || fallback.confluence),
        grade: normalizeGrade(scorecard.grade || fallback.grade),
    };
}

function buildLocalScorecard(analysis, isFlat) {
    const direction = String(analysis?.decision?.action || "").toLowerCase();
    const trend = String(analysis?.trend || "").toLowerCase();
    const rmi = Number(analysis?.rmi?.value);
    const rmiBias = String(analysis?.rmi?.bias || "").toLowerCase();
    let score = 0;

    if (direction === "buy" || direction === "sell") score += 25;
    if ((direction === "buy" && trend.includes("bull")) || (direction === "sell" && trend.includes("bear"))) score += 25;
    if (Number.isFinite(rmi)) score += Math.abs(rmi - 50) >= 12 ? 20 : 10;
    if ((direction === "buy" && rmiBias.includes("bull")) || (direction === "sell" && rmiBias.includes("bear"))) score += 15;
    if (Array.isArray(analysis?.fvgs) && analysis.fvgs.length) score += 15;
    if (isFlat) score = Math.min(score, 54);

    const tdsScore = clampScore(score);
    const confluence = tdsScore >= 75 ? "High" : tdsScore >= 55 ? "Medium" : "Low";
    const grade = tdsScore >= 75 ? "Active" : tdsScore >= 55 ? "Watch" : "Skip";
    return { tdsScore, confluence, confidence: tdsScore, grade };
}

function clampScore(value) {
    const parsed = Number(value);
    return Math.max(0, Math.min(100, Math.round(Number.isFinite(parsed) ? parsed : 0)));
}

function normalizeGrade(value) {
    const grade = String(value || "").trim().toLowerCase();
    if (grade === "active") return "Active";
    if (grade === "watch") return "Watch";
    return "Skip";
}


let sentimentInterval = null;
let pricePollingInterval = null;
let lastGoldPrice = 2350.00;
let dailyOpenGold = 2345.00;

function updateRealTimeTracker(price, trend, structureEvents, fvgs, obs, decision) {
  // Capture the latest dataset for interactive clicks
  state.latestTrackerData = {
    price,
    trend,
    structureEvents,
    fvgs,
    obs,
    decision,
    liquidity: state.lastAnalysisData?.liquidity || []
  };

  const steps = ["Discovery", "Sweep", "Choch", "Trigger", "Target"];
  steps.forEach(s => {
    const el = document.getElementById(`step${s}`);
    if (el) el.className = "lifecycle-step";
  });

  let activeStep = "Discovery";
  
  const hasSweep = Array.isArray(structureEvents) && structureEvents.some(e => typeof e === 'string' && e.toLowerCase().includes("sweep"));
  if (hasSweep) {
    activeStep = "Sweep";
    const dStep = document.getElementById("stepDiscovery");
    if (dStep) dStep.className = "lifecycle-step completed";
  }
  
  const hasChoch = Array.isArray(structureEvents) && structureEvents.some(e => typeof e === 'string' && (e.toLowerCase().includes("bos") || e.toLowerCase().includes("choch")));
  if (hasChoch) {
    activeStep = "Choch";
    const dStep = document.getElementById("stepDiscovery");
    const sStep = document.getElementById("stepSweep");
    if (dStep) dStep.className = "lifecycle-step completed";
    if (sStep) sStep.className = "lifecycle-step completed";
  }

  // Check if we are near any demand/supply OB price range
  let nearOb = false;
  if (Array.isArray(obs)) {
    obs.forEach(o => {
      if (typeof o === 'string') {
        const matches = o.match(/(\d+\.\d+)/g);
        if (matches && matches.length >= 2) {
          const low = parseFloat(matches[0]);
          const high = parseFloat(matches[1]);
          if (price >= low - 1.0 && price <= high + 1.0) {
            nearOb = true;
          }
        }
      }
    });
  }

  // Check if we are near any FVG zone
  let nearFvg = false;
  if (Array.isArray(fvgs)) {
    fvgs.forEach(f => {
      if (f && f.price) {
        if (Math.abs(price - f.price) <= 1.5) {
          nearFvg = true;
        }
      }
    });
  }

  if (nearOb || nearFvg) {
    activeStep = "Trigger";
    const dStep = document.getElementById("stepDiscovery");
    const sStep = document.getElementById("stepSweep");
    const cStep = document.getElementById("stepChoch");
    if (dStep) dStep.className = "lifecycle-step completed";
    if (sStep) sStep.className = "lifecycle-step completed";
    if (cStep) cStep.className = "lifecycle-step completed";
  }

  let reachedTarget = false;
  if (decision && decision.tp1) {
    const tp = parseFloat(decision.tp1);
    if (trend === "bullish" ? price >= tp : price <= tp) {
      reachedTarget = true;
    }
  }

  if (reachedTarget) {
    activeStep = "Target";
    const dStep = document.getElementById("stepDiscovery");
    const sStep = document.getElementById("stepSweep");
    const cStep = document.getElementById("stepChoch");
    const tStep = document.getElementById("stepTrigger");
    if (dStep) dStep.className = "lifecycle-step completed";
    if (sStep) sStep.className = "lifecycle-step completed";
    if (cStep) cStep.className = "lifecycle-step completed";
    if (tStep) tStep.className = "lifecycle-step completed";
  }

  const activeEl = document.getElementById(`step${activeStep}`);
  if (activeEl) activeEl.className = "lifecycle-step active";
  
  const discText = document.getElementById("discoveryStatus");
  const sweepText = document.getElementById("sweepStatus");
  const chochText = document.getElementById("chochStatus");
  const trigText = document.getElementById("triggerStatus");
  const targetText = document.getElementById("targetStatus");
  
  if (discText) discText.textContent = "OB & FVG zones identified.";

  // Use LiquidityEngine events if available for more specific labels
  const liqEvents = state.lastAnalysisData?.liquidityEvents || [];
  const sweepEvents = liqEvents.filter(e => e.type === "SWEEP");
  const breakoutEvents = liqEvents.filter(e => e.type === "BREAKOUT");

  if (sweepText) {
    if (sweepEvents.length > 0) {
      sweepText.textContent = `🩸 ${sweepEvents[0].displayName}`;
    } else if (hasSweep) {
      sweepText.textContent = "Liquidity sweep triggered!";
    } else if (breakoutEvents.length > 0) {
      sweepText.textContent = `💥 ${breakoutEvents[0].displayName}`;
    } else {
      sweepText.textContent = "Monitoring sweep levels...";
    }
  }
  if (chochText) {
    chochText.textContent = hasChoch 
      ? "M5/M15 CHoCH Break confirmed!" 
      : "Awaiting structure shift...";
  }
  if (trigText) {
    trigText.textContent = (nearOb || nearFvg)
      ? `Price in sniper zone: ${price.toFixed(2)}` 
      : "Awaiting 70.5% OTE retest...";
  }
  if (targetText) {
    targetText.textContent = reachedTarget 
      ? `TP Target hit at ${price.toFixed(2)}!` 
      : `Target: ${decision?.tp1 ? parseFloat(decision.tp1).toFixed(2) : "n/a"}`;
  }
}

async function fetchLivePrice() {
  try {
    const symbol = encodeURIComponent(state.botInstrument || "XAU_USD");
    const url = apiUrl(`/live-price?symbol=${symbol}`);
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.price) {
      state.trueGoldPrice = Number(payload.price);
    }
  } catch (error) {
    console.warn("Failed to fetch live price:", error);
  }
}

function startRealTimeFeeds(analysis) {
  if (sentimentInterval) clearInterval(sentimentInterval);
  if (pricePollingInterval) clearInterval(pricePollingInterval);
  
  if (analysis && analysis.price) {
    state.trueGoldPrice = analysis.price;
  } else if (state.botStatus && state.botStatus.latestPrice) {
    state.trueGoldPrice = Number(state.botStatus.latestPrice);
  } else {
    // Try to load price from the last entry in local analysis history!
    try {
      const savedHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (savedHistory) {
        const parsed = JSON.parse(savedHistory);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].price) {
          state.trueGoldPrice = Number(parsed[0].price);
        }
      }
    } catch (e) {}
  }

  // Initial immediate fetch and schedule 2s polling
  fetchLivePrice();
  pricePollingInterval = setInterval(fetchLivePrice, 2000);

  const tick = () => {
    if (!state.trueGoldPrice) {
      const topPriceEl = document.getElementById("priceLabel");
      if (topPriceEl && topPriceEl.textContent !== "--") {
        topPriceEl.textContent = "--";
      }
      return;
    }
    // Micro-fluctuation centered around the true fetched price to show lifelike ticks without artificial drift
    const microOffset = (Math.random() - 0.5) * 0.04;
    const liveDisplayPrice = Number((state.trueGoldPrice + microOffset).toFixed(2));

    const topPriceEl = document.getElementById("priceLabel");
    if (topPriceEl) topPriceEl.textContent = liveDisplayPrice.toFixed(2);
    
    if (analysis) {
      updateRealTimeTracker(liveDisplayPrice, analysis.trend, analysis.structureEvents, analysis.fvgs, analysis.orderBlocks, analysis.decision);
    }
  };

  tick();
  sentimentInterval = setInterval(tick, 200);
}

function renderLifecycleUI(lifecycle) {
    const lifecycleContent = dom.get("#lifecycleContent");
    if (!lifecycleContent) return;
    if (!lifecycle) {
        lifecycleContent.innerHTML = `<p class="empty-hint">No active signals tracked. Run a bot preview to initiate lifecycle monitoring.</p>`;
        return;
    }
    
    lifecycleContent.innerHTML = `
        <div class="lifecycle-card">
            <div class="lifecycle-info">
                <h4>${lifecycle.title || "Signal Scanned"}</h4>
                <p>${lifecycle.subtitle || "XAU/USD Lifecycle Monitor"}</p>
            </div>
            <div class="lifecycle-progress">
                <div class="progress-track">
                    <div class="progress-fill" style="width: ${lifecycle.progressPct || 0}%"></div>
                </div>
                <div class="progress-labels">
                    <span>Armed</span>
                    <span>Target: ${lifecycle.progressPct || 0}%</span>
                </div>
            </div>
            <div class="lifecycle-status">
                <span class="status-badge status-${lifecycle.status || 'pending'}">${lifecycle.status || 'pending'}</span>
            </div>
        </div>
    `;
}

function renderHeatmapUI(items) {
    const heatmapContent = dom.get("#heatmapContent");
    if (!heatmapContent) return;
    if (!items || !items.length) {
        heatmapContent.innerHTML = `<p class="empty-hint">Initializing heatmap intelligence...</p>`;
        return;
    }
    
    heatmapContent.innerHTML = items.map(item => {
        const isBull = item.bias === "bullish";
        const trendClass = isBull ? "positive" : "negative";
        const themeClass = isBull ? "bullish" : "bearish";
        
        return `
            <div class="heatmap-card ${themeClass}">
                <div class="card-header heatmap-header">
                    <span class="symbol heatmap-symbol">${item.label}</span>
                    <span class="correlation heatmap-score">${item.note}</span>
                </div>
                <div class="card-body">
                    <span class="price-val heatmap-price">${item.bias.toUpperCase()}</span>
                    <span class="pct-val ${trendClass} heatmap-trend">${isBull ? "BULL" : "BEAR"}</span>
                </div>
            </div>
        `;
    }).join("");
}

function buildAiPrompt(analysis, mtfData) {
    const entryTf = state.selectedTimeframe;
    const latestEntry = Array.isArray(mtfData?.data?.find(d => d.id === "entry")?.values)
        ? mtfData.data.find(d => d.id === "entry").values.at(-1)
        : null;
    const benchmark = Array.isArray(mtfData?.data?.find(d => d.id === "benchmark")?.values)
        ? mtfData.data.find(d => d.id === "benchmark").values.at(-1)
        : null;
    const alphaVantage = mtfData?.data?.find(d => d.id === "alpha_vantage")?.data || null;
    const tradeBias = analysis?.decision?.action || "Stay Flat";
    const price = Number(analysis?.price);
    const tp1 = Number(analysis?.decision?.tp1);
    const tp2 = Number(analysis?.decision?.tp2);
    const stop = Number(analysis?.decision?.stopPrice);
    const entryRange = inferEntryRange(price, stop);

    return [
        "Analyze this XAUUSD market data. Output ONLY a valid JSON object matching the system prompt schema.",
        "",
        `Symbol: XAU/USD`,
        `Timeframe: ${entryTf}`,
        `Current Price: ${Number.isFinite(price) ? price.toFixed(2) : "n/a"}`,
        `Rule Engine Direction: ${tradeBias}`,
        `Rule Engine Entry Range: ${entryRange}`,
        `Rule Engine Stop: ${Number.isFinite(stop) ? stop.toFixed(2) : "n/a"}`,
        `Rule Engine TP1: ${Number.isFinite(tp1) ? tp1.toFixed(2) : "n/a"}`,
        `Rule Engine TP2: ${Number.isFinite(tp2) ? tp2.toFixed(2) : "n/a"}`,
        `Trend: ${analysis?.trend || "n/a"}`,
        `RMI: ${analysis?.rmi?.value ?? "n/a"} (${analysis?.rmi?.bias || "n/a"})`,
        `HTF Alignment: ${Array.isArray(analysis?.htfAlignment) ? analysis.htfAlignment.join(" | ") : "n/a"}`,
        `Structure Events: ${Array.isArray(analysis?.structureEvents) ? analysis.structureEvents.join(", ") : "none"}`,
        `Fair Value Gaps: ${Array.isArray(analysis?.fvgs) ? analysis.fvgs.map(f => `${f.side}@${f.price.toFixed(2)}`).join(", ") : "none"}`,
        `Order Blocks: ${Array.isArray(analysis?.orderBlocks) ? analysis.orderBlocks.map(ob => {
            if (typeof ob === "string") return ob;
            if (ob && typeof ob === "object") {
                const side = ob.side || (ob.low && ob.high ? (ob.low < ob.high ? "bullish" : "bearish") : "unknown");
                const price = typeof ob.price === "number" ? ob.price : (typeof ob.low === "number" ? ob.low : 0);
                return `${side}@${price.toFixed(2)}`;
            }
            return "unknown";
        }).join(", ") : "none"}`,
        `Liquidity Pools: ${analysis?.liquidityPools ? JSON.stringify(analysis.liquidityPools) : "none"}`,
        `Liquidity Events: ${Array.isArray(analysis?.liquidityEvents) ? analysis.liquidityEvents.map(e => `${e.type} on ${e.pool?.shortName} @ ${e.price}`).join(", ") : "none"}`,
        `Session Levels: ${analysis?.sessionLevels ? JSON.stringify(analysis.sessionLevels) : "none"}`,
        `Benchmark Close: ${benchmark?.close || "n/a"}`,
        `Alpha Vantage Reference: ${alphaVantage ? `Bid: ${alphaVantage["8. Bid Price"]}, Ask: ${alphaVantage["9. Ask Price"]}` : "n/a"}`,
        `Latest Entry Candle: ${latestEntry ? JSON.stringify(latestEntry) : "n/a"}`,
    ].join("\n");
}

function inferEntryRange(price, stop) {
    if (!Number.isFinite(price)) return "n/a";
    const distance = Number.isFinite(stop) ? Math.max(Math.abs(price - stop) * 0.4, 0.2) : 0.4;
    return `${(price - distance).toFixed(2)} - ${(price + distance).toFixed(2)}`;
}

function extractAiText(payload) {
    if (!payload) return "";
    if (typeof payload.content === "string" && payload.content.trim()) return payload.content.trim();
    if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();
    if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
    const choice = payload?.choices?.[0]?.message?.content;
    if (typeof choice === "string" && choice.trim()) return choice.trim();
    if (Array.isArray(choice)) {
        return choice
            .map(part => {
                if (typeof part === "string") return part;
                if (typeof part?.text === "string") return part.text;
                if (typeof part?.content === "string") return part.content;
                return "";
            })
            .join("")
            .trim();
    }
    const outputText = payload?.output?.[0]?.content;
    if (Array.isArray(outputText)) {
        const text = outputText
            .map(part => {
                if (typeof part?.text === "string") return part.text;
                if (typeof part?.content === "string") return part.content;
                return "";
            })
            .join("")
            .trim();
        if (text) return text;
    }
    const candidateText = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(candidateText)) {
        const text = candidateText
            .map(part => typeof part?.text === "string" ? part.text : "")
            .join("")
            .trim();
        if (text) return text;
    }
    return "";
}

function toggleScanUI(running) {
    const btn = dom.get("#analyzeButton");
    if (btn) btn.disabled = running;
    const refresh = dom.get("#refreshButton");
    if (refresh) refresh.disabled = running;
    const badge = dom.get("#connectionBadge");
    if (badge) {
        badge.textContent = running ? "PREVIEWING" : "IDLE";
        badge.className = `badge ${running ? 'active' : 'muted'}`;
    }
}

function applyLocalFileModeGuard() {
    return false; // Disabled for mobile and local builds
}

async function syncHistory(analysis, aiData) {
    try {
        const rawText = extractAiText(aiData) || "";
        const parsed = parseAiJson(rawText) || {};
        
        // Extract numbers from AI or fallback to analysis.decision
        let tp1 = Number(analysis.decision?.tp1 || 0);
        let tp2 = Number(analysis.decision?.tp2 || 0);
        let stopPrice = Number(analysis.decision?.stopPrice || 0);
        
        if (parsed.trader) {
            const extractNum = (str) => {
                if (!str) return 0;
                const match = String(str).match(/([0-9]+\.[0-9]+|[0-9]+)/);
                return match ? parseFloat(match[1]) : 0;
            };
            if (parsed.trader.stopLoss) {
                const val = extractNum(parsed.trader.stopLoss);
                if (val > 0) stopPrice = val;
            }
            if (parsed.trader.takeProfitLevels) {
                const matches = String(parsed.trader.takeProfitLevels).match(/([0-9]+\.[0-9]+|[0-9]+)/g);
                if (matches && matches.length > 0) {
                    tp1 = parseFloat(matches[0]);
                    if (matches.length > 1) tp2 = parseFloat(matches[1]);
                    else tp2 = tp1;
                }
            }
        }

        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            price: analysis.price,
            rmi: analysis.rmi.value,
            bias: analysis.decision.action,
            debateUsed: Boolean(aiData?.debateUsed),
            debateAttempted: Number(aiData?.debateAttempted || 0),
            debateSuccessful: Number(aiData?.debateSuccessful || 0),
            debateConsensus: aiData?.debateConsensus || null,
            learningMemoryUsed: Boolean(aiData?.learningMemoryUsed),
            fallbackUsed: Boolean(aiData?.fallbackUsed),
            requestedModel: String(aiData?.requestedModel || aiData?.model || ""),
            tp1: tp1,
            tp2: tp2,
            sl: stopPrice,
            outcome: "pending",
        };
        state.analysisHistory.unshift(entry);
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.analysisHistory.slice(0, 50)));
        
        await fetch(`${EDGE_API_BASE}${APP_CONFIG.historyLogPath}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entry, source: "manual-bot-preview" })
        });
    } catch (e) {}
}

async function submitLearningFeedback(outcome) {
    const last = state.lastAiResult;
    if (!last) {
        dom.setStatus("No analysis to rate. Run a scan first.");
        return;
    }
    const direction = last.direction || "Stay Flat";
    const reason = outcome === "win"
        ? `${direction} setup confirmed by market. Structure held.`
        : outcome === "loss"
            ? `${direction} setup invalidated. Structural failure.`
            : `${direction} setup ended at breakeven.`;

    try {
        const res = await fetch(`${EDGE_API_BASE}/learning-feedback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                outcome,
                direction,
                timeframe: state.selectedTimeframe || "15min",
                reason,
                analysisId: String(Date.now()),
                arbiterDirection: direction,
                price: last.analysis?.price || 0,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
            showFeedbackToast(`✓ Recorded ${outcome.toUpperCase()} — Memory updated (${data.learningContext?.total || 0} total, ${data.learningContext?.winRate || 0}% win rate)`);
            // Disable buttons after submission
            ["#fbWinBtn", "#fbLossBtn", "#fbBeBtn"].forEach((sel) => {
                const btn = dom.get(sel);
                if (btn) { btn.disabled = true; btn.style.opacity = "0.4"; }
            });
        } else {
            showFeedbackToast(`⚠ Feedback failed: ${data.message || "Unknown error."}`);
        }
    } catch (err) {
        showFeedbackToast(`⚠ Network error: ${err.message}`);
    }
}

async function promptLearningNote() {
    const last = state.lastAiResult;
    if (!last) {
        dom.setStatus("No analysis to rate. Run a scan first.");
        return;
    }
    const note = prompt("Enter a manual note/lesson to save in learning memory:");
    if (note === null || note.trim() === "") return;
    
    const direction = last.direction || "Stay Flat";
    try {
        const res = await fetch(`${EDGE_API_BASE}/learning-feedback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                outcome: "manual-note",
                direction,
                timeframe: state.selectedTimeframe || "15min",
                reason: note.trim(),
                analysisId: String(Date.now()),
                arbiterDirection: direction,
                price: last.analysis?.price || 0,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
            showFeedbackToast(`✓ Saved manual note to memory.`);
        } else {
            showFeedbackToast(`⚠ Note failed: ${data.message || "Unknown error."}`);
        }
    } catch (err) {
        showFeedbackToast(`⚠ Network error: ${err.message}`);
    }
}

function showFeedbackToast(msg) {
    let toast = document.getElementById("feedbackToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "feedbackToast";
        toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1e293b;color:#e2e8f0;padding:12px 24px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.4);transition:opacity .3s;pointer-events:none;";
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = "1";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = "0"; }, 4000);
}

function updateTimeframeUI(nextValue) {
    state.selectedTimeframe = nextValue || "15min";
    const label = dom.get("#chartIntervalLabel");
    if (label) label.textContent = state.selectedTimeframe.replace("min", "M").replace("h", "H").replace("day", "D").toUpperCase();
}

function primeHomeScreen() {
    dom.fillList("#tradePlanList", ["Run a bot preview to generate the execution plan."]);
    dom.fillList("#fvgList", ["Awaiting chart analysis."]);
    dom.fillList("#obList", ["Awaiting chart analysis."]);
    dom.fillList("#structureList", ["Awaiting chart analysis."]);
    dom.fillList("#reversalList", ["Awaiting chart analysis."]);
    dom.fillList("#liquidityList", ["Awaiting chart analysis."]);
    dom.fillList("#fibList", ["Awaiting chart analysis."]);
    dom.fillList("#scenarioList", ["Awaiting chart analysis."]);
    dom.fillList("#htfList", ["Awaiting chart analysis."]);
    dom.fillList("#openTradesList", ["Loading OANDA trade exposure..."]);
    dom.fillList("#closedTradesList", ["Loading recent OANDA closed trades..."]);
    startRealTimeFeeds();
}

function renderBotStatus(status) {
    state.botStatus = status || null;
    if (status?.latestPrice) {
        state.trueGoldPrice = Number(status.latestPrice);
    }
    if (dom.get("#botModeLabel")) dom.get("#botModeLabel").textContent = String(status?.botMode || "manual").toUpperCase();
    if (dom.get("#botStateLabel")) dom.get("#botStateLabel").textContent = status?.botEnabled ? "Running" : "Stopped";
    if (dom.get("#botActionLabel")) dom.get("#botActionLabel").textContent = status?.runtime?.lastAction || "Waiting";
    if (dom.get("#botOpenTradesLabel")) dom.get("#botOpenTradesLabel").textContent = String(status?.openTradesCount || 0);
    renderAccountSummary(status?.accountSummary);
    renderOpenTrades(status?.openTrades);
    renderClosedTrades(status?.recentClosedTrades);
}

function renderAccountSummary(account) {
    const grid = dom.get("#accountSummaryGrid");
    if (!grid) return;
    if (!account) {
        grid.innerHTML = `
            <article class="summary-card"><p>Balance</p><strong>--</strong></article>
            <article class="summary-card"><p>NAV</p><strong>--</strong></article>
            <article class="summary-card"><p>Margin Free</p><strong>--</strong></article>
            <article class="summary-card"><p>Unrealized P/L</p><strong>--</strong></article>
        `;
        return;
    }
    grid.innerHTML = `
        <article class="summary-card"><p>Balance</p><strong>${escapeHtml(account.balance || "--")}</strong></article>
        <article class="summary-card"><p>NAV</p><strong>${escapeHtml(account.NAV || "--")}</strong></article>
        <article class="summary-card"><p>Margin Free</p><strong>${escapeHtml(account.marginAvailable || "--")}</strong></article>
        <article class="summary-card"><p>Unrealized P/L</p><strong>${escapeHtml(account.unrealizedPL || "--")}</strong></article>
    `;
}

function renderOpenTrades(trades) {
    const list = dom.get("#openTradesList");
    if (!list) return;
    const rows = Array.isArray(trades) ? trades : [];
    if (!rows.length) {
        dom.fillList("#openTradesList", ["No open OANDA trades."]);
        return;
    }
    list.innerHTML = rows.slice(0, 8).map((trade) => {
        const side = Number(trade?.currentUnits || 0) >= 0 ? "LONG" : "SHORT";
        return `<li>${escapeHtml(`${trade.instrument || "--"} | ${side} | Units ${trade.currentUnits || "--"} | Entry ${trade.price || "--"} | UPL ${trade.unrealizedPL || "--"}`)}</li>`;
    }).join("");
}

function renderClosedTrades(trades) {
    const list = dom.get("#closedTradesList");
    if (!list) return;
    const rows = Array.isArray(trades) ? trades : [];
    if (!rows.length) {
        dom.fillList("#closedTradesList", ["No recent closed OANDA trades found."]);
        return;
    }
    list.innerHTML = rows.slice(0, 10).map((trade) => {
        const closedAt = trade?.closeTime ? new Date(trade.closeTime).toLocaleString() : "Open time unavailable";
        return `<li>${escapeHtml(`${trade.instrument || "--"} | Units ${trade.initialUnits || trade.currentUnits || "--"} | Open ${trade.price || "--"} | Realized P/L ${trade.realizedPL || "--"} | ${closedAt}`)}</li>`;
    }).join("");
}

let lastAlertTick = 0;
async function refreshBotStatus() {
    const response = await fetch(`${EDGE_API_BASE}${APP_CONFIG.botStatusPath}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.message || `Bot status failed (${response.status})`);
    }
    renderBotStatus(payload);
    
    // Check for alerts
    const runtime = payload?.runtime || {};
    if (runtime.lastAction === "alert-sweep" && runtime.lastTickAt > lastAlertTick) {
        lastAlertTick = runtime.lastTickAt;
        if (Notification.permission === "granted") {
            new Notification("Aurum Quant AI Alert", {
                body: runtime.lastReason,
                icon: "favicon.ico",
                image: "candle_guide.png"
            });
        }
    }
    
    return payload;
}

async function sendBotCommand(action, extra = {}) {
    const response = await fetch(`${EDGE_API_BASE}${APP_CONFIG.botControlPath}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-admin-password": SETTINGS_PASSWORD,
        },
        body: JSON.stringify({ action, ...extra }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.message || `Bot command failed (${response.status})`);
    }
    if (payload.status) renderBotStatus(payload.status);
    if (payload.result?.status) renderBotStatus(payload.result.status);
    return payload;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function applyChartFallback(message) {
    const chart = dom.get("#tradingviewChart");
    if (!chart) return;
    chart.innerHTML = `<div class="empty-hint">${escapeHtml(message)}</div>`;
}

async function initTradingViewChart() {
    const chart = dom.get("#tradingviewChart");
    if (!chart) return;
    chart.innerHTML = "";

    const interval = TIMEFRAME_TO_TRADINGVIEW[state.selectedTimeframe] || "15";
    if (!window.TradingView) {
        await new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-tv-widget="1"]');
            if (existing) {
                existing.addEventListener("load", resolve, { once: true });
                existing.addEventListener("error", reject, { once: true });
                return;
            }
            const script = document.createElement("script");
            script.src = "https://s3.tradingview.com/tv.js";
            script.async = true;
            script.dataset.tvWidget = "1";
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        }).catch(() => {
            applyChartFallback("TradingView failed to load. Refresh to retry the chart.");
        });
    }

    if (!window.TradingView) return;
    chart.innerHTML = "";
    new window.TradingView.widget({
        autosize: true,
        symbol: "OANDA:XAUUSD",
        interval,
        timezone: state.selectedTimezone || "Asia/Kolkata",
        theme: "dark",
        style: "1",
        locale: "en",
        allow_symbol_change: false,
        hide_top_toolbar: false,
        hide_legend: false,
        container_id: "tradingviewChart"
    });
}

async function runLiquidityScanSilent() {
    if (state.isRunning) return; // Skip if main analysis is busy
    try {
        const symbol = encodeURIComponent(state.botInstrument || "XAU_USD");
        let res, mtfData;
        const queryParams = `symbol=${symbol}&entryTf=${state.selectedTimeframe}&outputsize=${state.candleCount || 1000}`;
        const cloudflareUrl = `${EDGE_API_BASE}${APP_CONFIG.marketMtfPath}?${queryParams}`;
        const localFallbackUrl = `/api${APP_CONFIG.marketMtfPath}?${queryParams}`;
        let fetchSuccess = false;

        // Attempt 1: Cloudflare Worker (KV-cached candle data)
        try {
            res = await fetch(cloudflareUrl);
            if (res.ok) {
                mtfData = await res.json().catch(() => ({}));
                if (mtfData && Array.isArray(mtfData.data)) {
                    fetchSuccess = true;
                }
            }
        } catch (e) {
            // Cloudflare failed, try local fallback
        }

        // Attempt 2: Local server fallback (direct OANDA, no KV cache)
        if (!fetchSuccess) {
            try {
                res = await fetch(localFallbackUrl);
                if (res.ok) {
                    mtfData = await res.json().catch(() => ({}));
                    if (mtfData && Array.isArray(mtfData.data)) {
                        fetchSuccess = true;
                    }
                }
            } catch (e) {
                // Both failed
            }
        }

        if (!fetchSuccess || !mtfData) return;
        
        const liquidityPools = LiquidityEngine.computeLiquidityPools(mtfData);
        const liquidityEvents = LiquidityEngine.scanAllLiquidityEvents(liquidityPools, mtfData);
        
        if (!state.lastAnalysisData) state.lastAnalysisData = {};
        state.lastAnalysisData.liquidityPools = liquidityPools;
        state.lastAnalysisData.liquidityEvents = liquidityEvents;
        state.lastAnalysisData.sessionLevels = LiquidityEngine._sessionState;
        
        renderLiquidityPoolsUI(liquidityPools, liquidityEvents);
        state.lastMtfData = mtfData;   // <--- INJECT THIS LINE!
        renderFibonacciOteUI(mtfData);
        renderLiquidityEventBox(liquidityEvents);
        fireAllLiquidityNotifications(liquidityEvents);
    } catch (e) {
        console.warn("Silent liquidity scan failed:", e);
    }
}
// --- Lifecycle ---
window.addEventListener('DOMContentLoaded', () => {
    console.log("Aurum OS Consolidated Booted.");
    setupTrackerModal();
    setupDebateCouncilModal();
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission();
    }
    
    // Auto-run analysis on first load
    setTimeout(() => {
        runAnalysis().catch(console.error);
    }, 500);

    // Live background polling for Liquidity Engine (runs every 30 seconds)
    window.setInterval(() => {
        runLiquidityScanSilent().catch(() => {});
    }, 30000);
    
    const analyzeBtn = dom.get("#analyzeButton");
    if (analyzeBtn) analyzeBtn.onclick = runAnalysis;
    const refreshBtn = dom.get("#refreshButton");
    if (refreshBtn) refreshBtn.onclick = runAnalysis;
    const startBotBtn = dom.get("#startBotButton");
    if (startBotBtn) startBotBtn.onclick = async () => {
        dom.setStatus("Starting automated bot...");
        try {
            await sendBotCommand("start");
            await refreshBotStatus();
            dom.setStatus("Bot started. Cron ticks can now execute according to the saved mode.");
        } catch (error) {
            dom.setStatus(`Failed to start bot: ${error.message}`);
        }
    };
    const stopBotBtn = dom.get("#stopBotButton");
    if (stopBotBtn) stopBotBtn.onclick = async () => {
        dom.setStatus("Stopping automated bot...");
        try {
            await sendBotCommand("stop");
            await refreshBotStatus();
            dom.setStatus("Bot stopped.");
        } catch (error) {
            dom.setStatus(`Failed to stop bot: ${error.message}`);
        }
    };

    // --- Timeframe / Timezone Sync ---
    const timeframeOptions = [
        { value: "1min", label: "1 Minute" },
        { value: "15min", label: "15 Minutes" },
        { value: "1h", label: "1 Hour" },
        { value: "4h", label: "4 Hours" },
        { value: "1day", label: "1 Day" }
    ];

    const timezoneOptions = [
        { value: "Asia/Kolkata", label: "India (IST +5:30)" },
        { value: "UTC", label: "UTC" },
        { value: "America/New_York", label: "New York (EST/EDT)" },
        { value: "America/Chicago", label: "Chicago (CST/CDT)" },
        { value: "Europe/London", label: "London (GMT/BST)" },
        { value: "Europe/Zurich", label: "Zurich (CET/CEST)" },
        { value: "Asia/Dubai", label: "Dubai (GST +4)" },
        { value: "Asia/Singapore", label: "Singapore (SGT +8)" },
        { value: "Asia/Tokyo", label: "Tokyo (JST +9)" },
        { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" }
    ];

    initCustomSelect("timeframeSelect", timeframeOptions, state.selectedTimeframe, async (val) => {
        state.selectedTimeframe = val;
        updateTimeframeUI(val);
        dom.setStatus(`Timeframe changed to ${val}. Syncing chart...`);
        try {
            const chart = window.tvWidget;
            if (chart && chart.chart) {
                const tvInterval = val === "1day" ? "D" : 
                                 val === "4h" ? "240" : 
                                 val === "1h" ? "60" : 
                                 val === "15min" ? "15" : "1";
                chart.chart().setResolution(tvInterval);
            }
        } catch (e) {}
    });

    initCustomSelect("timezoneSelect", timezoneOptions, "Asia/Kolkata", (val) => {
        try {
            const chart = window.tvWidget;
            if (chart && chart.chart) {
                chart.activeChart().setTimezone(val);
                dom.setStatus(`Timezone updated to ${val}`);
            }
        } catch (e) {}
    });

    const settingsBtn = dom.get("#settingsToggle");
    if (settingsBtn) {
        settingsBtn.onclick = () => {
            const modal = dom.get("#passwordModal");
            if (modal) modal.classList.add("open");
        };
    }
    const closePasswordBtn = dom.get("#closePasswordModal");
    if (closePasswordBtn) {
        closePasswordBtn.onclick = () => {
            const modal = dom.get("#passwordModal");
            if (modal) modal.classList.remove("open");
        };
    }

    const unlockBtn = dom.get("#submitPasswordButton");
    if (unlockBtn) {
        unlockBtn.onclick = () => {
            const passInput = dom.get("#passwordInput");
            const pass = passInput ? passInput.value : "";
            const errorEl = dom.get("#passwordError");
            if (errorEl) errorEl.textContent = ""; // Clear existing errors
            
            if (pass === SETTINGS_PASSWORD || pass === BASIC_SETTINGS_PASSWORD) {
                if (pass === BASIC_SETTINGS_PASSWORD) {
                    state.settingsRole = "basic";
                    document.querySelectorAll(".admin-only").forEach(el => el.style.display = "none");
                    document.querySelectorAll(".auth-only").forEach(el => el.style.display = "");
                } else {
                    state.settingsRole = "admin";
                    document.querySelectorAll(".admin-only").forEach(el => el.style.display = "");
                    document.querySelectorAll(".auth-only").forEach(el => el.style.display = "");
                }
                dom.get("#passwordModal").classList.remove("open");
                dom.get("#settingsPanel").classList.add("open");
                loadAdminStats();
            } else {
                if (errorEl) {
                    errorEl.textContent = "Invalid password. Please try again.";
                    errorEl.style.color = "#ff6b6b";
                }
            }
        };
    }

    const closeBtn = dom.get("#closeSettings");
    if (closeBtn) closeBtn.onclick = () => dom.get("#settingsPanel").classList.remove("open");

    // --- Wire Admin Settings API ---
    async function loadAdminSettings() {
        try {
            const response = await fetch(`${EDGE_API_BASE}${APP_CONFIG.settingsPath}`, { headers: { 'x-admin-password': SETTINGS_PASSWORD } });
            const data = await response.json();
            if (!data.isAdmin) {
                dom.setStatus("Backend admin auth mismatch. Settings are loading in read-only mode.");
            }
            const settings = data.settings || {};
            if (dom.get("#marketDataKeysInput")) dom.get("#marketDataKeysInput").value = (settings.twelveDataKeys || []).join("\n");
            if (dom.get("#optionsDataKeysInput")) dom.get("#optionsDataKeysInput").value = (settings.polygonKeys || []).join("\n");
            if (dom.get("#alphaVantageKeysInput")) dom.get("#alphaVantageKeysInput").value = (settings.alphaVantageKeys || []).join("\n");
            if (dom.get("#globalNvidiaApiKeysInput")) dom.get("#globalNvidiaApiKeysInput").value = Array.isArray(settings.globalNvidiaApiKeys) && settings.globalNvidiaApiKeys.length ? settings.globalNvidiaApiKeys.join("\n") : (settings.globalNvidiaApiKey || "");
            if (dom.get("#oandaApiTokenInput")) dom.get("#oandaApiTokenInput").value = settings.oandaApiToken || "";
            if (dom.get("#oandaAccountIdInput")) dom.get("#oandaAccountIdInput").value = settings.oandaAccountId || "";
            const permittedModels = new Set([
                "meta/llama-3.1-8b-instruct",
                "meta/llama-3.3-70b-instruct",
                "abacusai/dracarys-llama-3.1-70b-instruct",
                "meta/llama-4-maverick-17b-128e-instruct",
                "mistralai/mistral-nemotron",
                "nvidia/llama-3.3-nemotron-super-49b-v1",
                "google/gemma-3n-e2b-it",
                "google/gemma-3n-e4b-it",
                "meta/llama-3.2-3b-instruct",
                "mistralai/ministral-14b-instruct-2512",
                "mistralai/mistral-large-3-675b-instruct-2512",
                "mistralai/mistral-medium-3.5-128b",
                "mistralai/mistral-small-4-119b-2603",
                "mistralai/mixtral-8x7b-instruct-v0.1",
                "nvidia/llama-3.1-nemotron-nano-8b-v1",
                "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
                "nvidia/nemotron-3-super-120b-a12b",
                "nvidia/nemotron-mini-4b-instruct",
                "nvidia/nemotron-nano-12b-v2-vl",
                "qwen/qwen3-coder-480b-a35b-instruct",
                "qwen/qwen3.5-397b-a17b",
                "stockmark/stockmark-2-100b-instruct",
                "upstage/solar-10.7b-instruct",
                "bytedance/seed-oss-36b-instruct",
                "deepseek-ai/deepseek-v4-flash",
                "deepseek-ai/deepseek-v4-pro",
                "google/gemma-4-31b-it",
                "meta/llama-3.1-70b-instruct",
                "meta/llama-3.2-1b-instruct",
                "microsoft/phi-4-mini-instruct",
                "nvidia/llama-3.3-nemotron-super-49b-v1.5",
                "nvidia/nemotron-3-ultra-550b-a55b",
                "qwen/qwen3-next-80b-a3b-instruct",
                "openai/gpt-oss-120b",
                "openai/gpt-oss-20b",
                "nvidia/nvidia-nemotron-nano-9b-v2",
                "nvidia/nemotron-3-nano-30b-a3b"
            ]);

            if (Array.isArray(settings.nvidiaModels) && settings.nvidiaModels.length) {
                state.models = settings.nvidiaModels
                    .filter((model) => permittedModels.has(String(model.id || "").trim()))
                    .map((model) => {
                        let modelId = model.id;
                        let label = model.label;
                        if (modelId === "openai/gpt-oss-120b") {
                            modelId = "meta/llama-3.1-70b-instruct";
                            label = "Main Summary Model (Llama 3.1 70B)";
                        }
                        return {
                            key: model.key,
                            id: modelId,
                            label: label,
                            apiKey: model.apiKey || "",
                            baseUrl: model.baseUrl || APP_CONFIG.defaultBaseUrl
                        };
                    });
                if (settings.defaultModelKey) {
                    state.selectedModelKey = settings.defaultModelKey;
                }
            }
            if (Array.isArray(settings.debateModels) && settings.debateModels.length) {
                state.debateModels = settings.debateModels
                    .filter((model) => permittedModels.has(String(model.id || "").trim()))
                    .map((model) => {
                        return {
                            key: model.key,
                            id: model.id,
                            label: model.label,
                            apiKey: model.apiKey || "",
                            baseUrl: model.baseUrl || APP_CONFIG.defaultBaseUrl,
                            bias: model.bias || "both",
                            isDebateParticipant: model.isDebateParticipant !== undefined ? model.isDebateParticipant : true
                        };
                    });
            }
            if ((Array.isArray(settings.nvidiaModels) && settings.nvidiaModels.length) || (Array.isArray(settings.debateModels) && settings.debateModels.length)) {
                saveLocalSettings();
                renderModelDropdowns();
            }
            state.botMode = settings.botMode || state.botMode;
            state.oandaEnvironment = settings.oandaEnvironment || state.oandaEnvironment;
            state.botInstrument = settings.botInstrument || state.botInstrument;
            state.botUnits = Number.isFinite(Number(settings.botUnits)) ? Number(settings.botUnits) : state.botUnits;
            state.botStopLossOffset = Number.isFinite(Number(settings.botStopLossOffset)) ? Number(settings.botStopLossOffset) : state.botStopLossOffset;
            state.botTakeProfitOffset = Number.isFinite(Number(settings.botTakeProfitOffset)) ? Number(settings.botTakeProfitOffset) : state.botTakeProfitOffset;
            state.botCooldownMinutes = Number.isFinite(Number(settings.botCooldownMinutes)) ? Number(settings.botCooldownMinutes) : state.botCooldownMinutes;
            state.botPollIntervalSeconds = Number.isFinite(Number(settings.botPollIntervalSeconds)) ? Number(settings.botPollIntervalSeconds) : state.botPollIntervalSeconds;
            if (dom.get("#botInstrumentInput")) dom.get("#botInstrumentInput").value = state.botInstrument;
            if (dom.get("#botUnitsInput")) dom.get("#botUnitsInput").value = state.botUnits;
            if (dom.get("#botStopLossOffsetInput")) dom.get("#botStopLossOffsetInput").value = state.botStopLossOffset;
            if (dom.get("#botTakeProfitOffsetInput")) dom.get("#botTakeProfitOffsetInput").value = state.botTakeProfitOffset;
            if (dom.get("#botCooldownMinutesInput")) dom.get("#botCooldownMinutesInput").value = state.botCooldownMinutes;
            if (dom.get("#botPollIntervalSecondsInput")) dom.get("#botPollIntervalSecondsInput").value = state.botPollIntervalSeconds;
            setCustomSelectValue("botModeSelect", state.botMode);
            setCustomSelectValue("oandaEnvironmentSelect", state.oandaEnvironment);
        } catch (e) {
            console.error("Failed to load settings", e);
        }
    }

    function readGlobalNvidiaKeyInput() {
        const raw = dom.get("#globalNvidiaApiKeysInput")?.value || "";
        return raw
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean)[0] || "";
    }

    function readGlobalNvidiaKeysInput() {
        const raw = dom.get("#globalNvidiaApiKeysInput")?.value || "";
        return raw
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean);
    }

    function applyGlobalNvidiaKeysToBlankModels(globalKeys) {
        if (!Array.isArray(globalKeys) || globalKeys.length === 0) return;
        const applyKeys = (models) => {
            if (!Array.isArray(models)) return;
            models.forEach((model, index) => {
                if (model && !String(model.apiKey || "").trim()) {
                    model.apiKey = globalKeys[index % globalKeys.length];
                }
            });
        };
        applyKeys(state.models);
        applyKeys(state.debateModels);
    }
    
    async function saveAdminSettings(key, value) {
        try {
            const body = typeof key === "object" ? key : { [key]: value };
            const response = await fetch(`${EDGE_API_BASE}${APP_CONFIG.settingsPath}`, {
                method: 'POST',
                headers: { 'x-admin-password': SETTINGS_PASSWORD, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                dom.setStatus(payload.message || "Failed to save settings.");
                return false;
            }
            dom.setStatus("Settings saved successfully.");
            return true;
        } catch (e) {
            dom.setStatus("Failed to save settings.");
            return false;
        }
    }
    window.saveAdminSettings = saveAdminSettings;

    async function syncAiBackendSettings() {
        const globalNvidiaApiKeys = readGlobalNvidiaKeysInput();
        const globalNvidiaApiKey = globalNvidiaApiKeys[0] || "";
        applyGlobalNvidiaKeysToBlankModels(globalNvidiaApiKeys);
        saveLocalSettings();
        return saveAdminSettings({
            globalNvidiaApiKey,
            globalNvidiaApiKeys,
            nvidiaModels: state.models,
            debateModels: state.debateModels,
            defaultModelKey: state.selectedModelKey
        });
        window.syncAiBackendSettings = syncAiBackendSettings;
    }

    const saveMarketKeysBtn = dom.get("#saveMarketKeysButton");
    if (saveMarketKeysBtn) saveMarketKeysBtn.onclick = () => {
        const keys = dom.get("#marketDataKeysInput").value.split("\n").map(k => k.trim()).filter(Boolean);
        saveAdminSettings("twelveDataKeys", keys);
    };

    const saveOptionsKeysBtn = dom.get("#saveOptionsKeysButton");
    if (saveOptionsKeysBtn) saveOptionsKeysBtn.onclick = () => {
        const keys = dom.get("#optionsDataKeysInput").value.split("\n").map(k => k.trim()).filter(Boolean);
        saveAdminSettings("polygonKeys", keys);
    };

    const saveAlphaKeysBtn = dom.get("#saveAlphaVantageKeysButton");
    if (saveAlphaKeysBtn) saveAlphaKeysBtn.onclick = () => {
        const keys = dom.get("#alphaVantageKeysInput").value.split("\n").map(k => k.trim()).filter(Boolean);
        saveAdminSettings("alphaVantageKeys", keys);
    };

    const saveGlobalNvidiaKeyBtn = dom.get("#saveGlobalNvidiaKeyButton");
    if (saveGlobalNvidiaKeyBtn) saveGlobalNvidiaKeyBtn.onclick = async () => {
        const key = readGlobalNvidiaKeyInput();
        if (!key) {
            dom.setStatus("Enter a valid NVIDIA API key first.");
            return;
        }
        await syncAiBackendSettings();
    };

    const saveOandaKeysBtn = dom.get("#saveOandaKeysButton");
    if (saveOandaKeysBtn) saveOandaKeysBtn.onclick = async () => {
        const token = (dom.get("#oandaApiTokenInput")?.value || "").trim();
        const accountId = (dom.get("#oandaAccountIdInput")?.value || "").trim();
        await saveAdminSettings({ oandaApiToken: token, oandaAccountId: accountId });
    };

    const saveBotConfigBtn = dom.get("#saveBotConfigButton");
    if (saveBotConfigBtn) saveBotConfigBtn.onclick = async () => {
        try {
            state.botInstrument = (dom.get("#botInstrumentInput")?.value || state.botInstrument || "XAU_USD").trim().toUpperCase().replace("/", "_");
            state.botUnits = parseInt(dom.get("#botUnitsInput")?.value || state.botUnits, 10);
            state.botStopLossOffset = parseFloat(dom.get("#botStopLossOffsetInput")?.value || state.botStopLossOffset);
            state.botTakeProfitOffset = parseFloat(dom.get("#botTakeProfitOffsetInput")?.value || state.botTakeProfitOffset);
            state.botCooldownMinutes = parseInt(dom.get("#botCooldownMinutesInput")?.value || state.botCooldownMinutes, 10);
            state.botPollIntervalSeconds = parseInt(dom.get("#botPollIntervalSecondsInput")?.value || state.botPollIntervalSeconds, 10);
            await sendBotCommand("save-config", {
                config: {
                    botMode: state.botMode,
                    oandaEnvironment: state.oandaEnvironment,
                    botInstrument: state.botInstrument,
                    botUnits: state.botUnits,
                    botStopLossOffset: state.botStopLossOffset,
                    botTakeProfitOffset: state.botTakeProfitOffset,
                    botCooldownMinutes: state.botCooldownMinutes,
                    botPollIntervalSeconds: state.botPollIntervalSeconds,
                }
            });
            await refreshBotStatus();
            dom.setStatus("Bot configuration saved.");
        } catch (error) {
            dom.setStatus(`Failed to save bot config: ${error.message}`);
        }
    };

    loadAdminSettings();
    initSettingsUI();
    loadAdminStats();
    refreshBotStatus().catch((error) => {
        if (dom.get("#botMetaText")) dom.get("#botMetaText").textContent = `Bot status unavailable: ${error.message}`;
    });
    window.setInterval(() => {
        refreshBotStatus().catch(() => {});
    }, 15000);

    updateTimeframeUI(state.selectedTimeframe);
    primeHomeScreen();
    requestNotificationPermission();
    // Notification banner buttons
    const notifEnableBtn = document.getElementById("notifEnableBtn");
    if (notifEnableBtn) notifEnableBtn.addEventListener("click", enableNotifications);
    const notifDismissBtn = document.getElementById("notifDismissBtn");
    if (notifDismissBtn) notifDismissBtn.addEventListener("click", () => {
        const banner = document.getElementById("notificationBanner");
        if (banner) banner.style.display = "none";
    });

    // Event filter listener
    const filterSelect = document.getElementById("eventFilterSelect");
    if (filterSelect) {
        filterSelect.addEventListener("change", () => {
            if (state.lastAnalysisData && state.lastAnalysisData.liquidityEvents) {
                renderLiquidityEventBox(state.lastAnalysisData.liquidityEvents);
            }
        });
    }

    initTradingViewChart().catch(() => applyChartFallback("TradingView chart is temporarily unavailable."));
    if (!applyLocalFileModeGuard()) {
        dom.setStatus("Institutional OS: Bot console ready.");
    }

    async function loadAdminStats() {
        const hint = dom.get("#adminStatsHint");
        const grid = dom.get("#adminStatsGrid");
        if (!hint || !grid) return;
        
        try {
            const response = await fetch(`${EDGE_API_BASE}${APP_CONFIG.settingsPath}?action=metrics`, { 
                headers: { 'x-admin-password': SETTINGS_PASSWORD } 
            });
            const data = await response.json();
            const m = data.metrics || {};
            
            hint.style.display = "none";
            grid.innerHTML = `
                <div class="admin-stat-card">
                    <p>Total Analyses</p>
                    <strong>${m.totalAnalyses || 0}</strong>
                </div>
                <div class="admin-stat-card ${m.globalWinRate > 50 ? 'stat-positive' : 'stat-negative'}">
                    <p>Global Win Rate</p>
                    <strong>${(m.globalWinRate || 0).toFixed(1)}%</strong>
                </div>
                <div class="admin-stat-card">
                    <p>Sample Size</p>
                    <strong>${m.globalTotal || 0} trades</strong>
                </div>
                <div class="admin-stat-card">
                    <p>Unique Devices</p>
                    <strong>${m.uniqueDevices || 0}</strong>
                </div>
                <div class="admin-stat-card">
                    <p>Debate Success</p>
                    <strong>${m.debateSuccessfulTotal || 0} / ${m.debateAttemptedTotal || 0}</strong>
                </div>
                <div class="admin-stat-card ${m.inputLimitErrors > 0 ? 'stat-negative' : ''}">
                    <p>AI Errors</p>
                    <strong>${(m.inputLimitErrors || 0) + (m.aiTimeoutErrors || 0)}</strong>
                </div>
            `;
        } catch (e) {
            hint.textContent = "Failed to load analytics.";
            console.error("Failed to load metrics", e);
        }
    }
});

// --- Local State Management ---
function loadLocalSettings() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);

            if (parsed.models && Array.isArray(parsed.models)) {
                state.models = parsed.models.map((model) => {
                    if (model.key === "gpt-oss-default") {
                        model.id = "openai/gpt-oss-120b";
                        model.label = "Main Summary Model (GPT-OSS-120B)";
                    }
                    return model;
                });
            }
            if (parsed.debateModels && Array.isArray(parsed.debateModels)) state.debateModels = parsed.debateModels;
            if (parsed.selectedModelKey) state.selectedModelKey = parsed.selectedModelKey;
            if (parsed.temperature !== undefined) state.temperature = parsed.temperature;
            if (parsed.candleCount) state.candleCount = parsed.candleCount;
            if (parsed.botMode) state.botMode = parsed.botMode;
            if (parsed.oandaEnvironment) state.oandaEnvironment = parsed.oandaEnvironment;
            if (parsed.botInstrument) state.botInstrument = parsed.botInstrument;
            if (parsed.botUnits) state.botUnits = parsed.botUnits;
            if (parsed.botStopLossOffset) state.botStopLossOffset = parsed.botStopLossOffset;
            if (parsed.botTakeProfitOffset) state.botTakeProfitOffset = parsed.botTakeProfitOffset;
            if (parsed.botCooldownMinutes) state.botCooldownMinutes = parsed.botCooldownMinutes;
            if (parsed.botPollIntervalSeconds) state.botPollIntervalSeconds = parsed.botPollIntervalSeconds;
        }
    } catch (e) {
        console.error("Failed to load local settings", e);
    }
}

function saveLocalSettings() {
    try {
        const payload = {
            models: state.models,
            debateModels: state.debateModels,
            selectedModelKey: state.selectedModelKey,
            temperature: state.temperature,
            candleCount: state.candleCount,
            botMode: state.botMode,
            oandaEnvironment: state.oandaEnvironment,
            botInstrument: state.botInstrument,
            botUnits: state.botUnits,
            botStopLossOffset: state.botStopLossOffset,
            botTakeProfitOffset: state.botTakeProfitOffset,
            botCooldownMinutes: state.botCooldownMinutes,
            botPollIntervalSeconds: state.botPollIntervalSeconds
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        console.error("Failed to save local settings", e);
    }
}

function renderModelDropdowns() {
    const mainOptions = state.models.map(m => ({ value: m.key, label: `${m.label} (${m.id})` }));
    initCustomSelect("modelSelect", mainOptions, state.selectedModelKey, (val) => {
        state.selectedModelKey = val;
        saveLocalSettings();
    });

    const editorOptions = [
        { value: "", label: "-- Select Model to Edit --" },
        ...state.models.map(m => ({ value: m.key, label: m.label }))
    ];
    initCustomSelect("modelEditorSelect", editorOptions, "", (val) => {
        populateModelEditor(val, false);
    });

    const debateEditorOptions = [
        { value: "", label: "-- Select Debate Model to Edit --" },
        ...state.debateModels.map(m => ({ value: m.key, label: m.label }))
    ];
    initCustomSelect("debateModelEditorSelect", debateEditorOptions, "", (val) => {
        populateModelEditor(val, true);
    });
}

function populateModelEditor(key, isDebate) {
    const list = isDebate ? state.debateModels : state.models;
    const prefix = isDebate ? "debateModel" : "model";
    const model = list.find(m => m.key === key);
    
    if (model) {
        if (dom.get(`#${prefix}LabelInput`)) dom.get(`#${prefix}LabelInput`).value = model.label || "";
        if (dom.get(`#${prefix}IdInput`)) dom.get(`#${prefix}IdInput`).value = model.id || "";
        if (dom.get(`#${prefix}ApiKeyInput`)) dom.get(`#${prefix}ApiKeyInput`).value = model.apiKey || "";
        if (dom.get(`#${prefix}BaseUrlInput`)) dom.get(`#${prefix}BaseUrlInput`).value = model.baseUrl || "https://integrate.api.nvidia.com/v1";
    } else {
        if (dom.get(`#${prefix}LabelInput`)) dom.get(`#${prefix}LabelInput`).value = "";
        if (dom.get(`#${prefix}IdInput`)) dom.get(`#${prefix}IdInput`).value = "";
        if (dom.get(`#${prefix}ApiKeyInput`)) dom.get(`#${prefix}ApiKeyInput`).value = "";
        if (dom.get(`#${prefix}BaseUrlInput`)) dom.get(`#${prefix}BaseUrlInput`).value = "https://integrate.api.nvidia.com/v1";
    }
}

function setupModelManager(isDebate) {
    const prefix = isDebate ? "debateModel" : "model";
    const listName = isDebate ? "debateModels" : "models";
    
    const saveBtn = dom.get(`#save${isDebate ? "Debate" : ""}ModelButton`);
    const delBtn = dom.get(`#delete${isDebate ? "Debate" : ""}ModelButton`);
    const addBtn = dom.get(`#add${isDebate ? "Debate" : ""}ModelButton`);
    
    if (addBtn) addBtn.onclick = () => {
        setCustomSelectValue(`${prefix}EditorSelect`, "");
        populateModelEditor("", isDebate);
    };

    if (saveBtn) saveBtn.onclick = async () => {
        const editorSelect = dom.get(`#${prefix}EditorSelect`);
        const oldKey = editorSelect ? editorSelect.value : "";
        const label = dom.get(`#${prefix}LabelInput`).value.trim();
        const id = dom.get(`#${prefix}IdInput`).value.trim();
        const apiKey = dom.get(`#${prefix}ApiKeyInput`).value.trim();
        const baseUrl = dom.get(`#${prefix}BaseUrlInput`).value.trim() || "https://integrate.api.nvidia.com/v1";
        
        if (!label || !id) {
            dom.setStatus("Label and ID are required.");
            return;
        }
        
        const newKey = id.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
        
        const newObj = { key: newKey, id, label, apiKey, baseUrl };
        
        if (oldKey) {
            const idx = state[listName].findIndex(m => m.key === oldKey);
            if (idx > -1) state[listName][idx] = newObj;
            else state[listName].push(newObj);
        } else {
            state[listName].push(newObj);
        }
        
        if (!isDebate && oldKey === state.selectedModelKey) {
            state.selectedModelKey = newKey;
        }
        
        saveLocalSettings();
        renderModelDropdowns();
        if (!isDebate) {
            await syncAiBackendSettings();
        } else {
            await saveAdminSettings("debateModels", state.debateModels);
        }
        dom.setStatus(`Saved ${isDebate ? "debate " : ""}model: ${label}`);
        if (editorSelect) editorSelect.value = newKey;
    };

    if (delBtn) delBtn.onclick = async () => {
        const editorSelect = dom.get(`#${prefix}EditorSelect`);
        const oldKey = editorSelect ? editorSelect.value : "";
        if (!oldKey) return;
        
        state[listName] = state[listName].filter(m => m.key !== oldKey);
        if (!isDebate && state.selectedModelKey === oldKey && state.models.length > 0) {
            state.selectedModelKey = state.models[0].key;
        }
        
        saveLocalSettings();
        renderModelDropdowns();
        populateModelEditor("", isDebate);
        if (!isDebate) {
            await syncAiBackendSettings();
        } else {
            await saveAdminSettings("debateModels", state.debateModels);
        }
        dom.setStatus(`Deleted model.`);
    };
}

async function syncAiBackendSettings() {
    if (typeof window !== "undefined" && window.syncAiBackendSettings) {
        return await window.syncAiBackendSettings();
    }
    console.warn("syncAiBackendSettings is not yet initialized.");
}

async function saveAdminSettings(key, value) {
    if (typeof window !== "undefined" && window.saveAdminSettings) {
        return await window.saveAdminSettings(key, value);
    }
    console.warn("saveAdminSettings is not yet initialized.");
}

function initSettingsUI() {
    loadLocalSettings();
    renderModelDropdowns();
    setupModelManager(false);
    setupModelManager(true);

    const botModeOptions = [
        { value: "manual", label: "Manual Only" },
        { value: "paper", label: "Paper Trading" },
        { value: "live", label: "Live Trading" }
    ];
    initCustomSelect("botModeSelect", botModeOptions, state.botMode || "manual", (val) => {
        state.botMode = val;
        saveLocalSettings();
    });

    const oandaEnvironmentOptions = [
        { value: "practice", label: "Practice" },
        { value: "live", label: "Live" }
    ];
    initCustomSelect("oandaEnvironmentSelect", oandaEnvironmentOptions, state.oandaEnvironment || "practice", (val) => {
        state.oandaEnvironment = val;
        saveLocalSettings();
    });
    
    const tempInput = dom.get("#temperatureInput");
    if (tempInput) {
        tempInput.value = state.temperature !== undefined ? state.temperature : 0.2;
        tempInput.onchange = (e) => {
            state.temperature = parseFloat(e.target.value);
            saveLocalSettings();
        };
    }
    
    const candleInput = dom.get("#candleCountInput");
    if (candleInput) {
        candleInput.value = state.candleCount || 180;
        candleInput.onchange = (e) => {
            state.candleCount = parseInt(e.target.value, 10);
            saveLocalSettings();
        };
    }

    if (dom.get("#botInstrumentInput")) dom.get("#botInstrumentInput").value = state.botInstrument || "XAU_USD";
    if (dom.get("#botUnitsInput")) dom.get("#botUnitsInput").value = state.botUnits || 10;
    if (dom.get("#botStopLossOffsetInput")) dom.get("#botStopLossOffsetInput").value = state.botStopLossOffset || 3;
    if (dom.get("#botTakeProfitOffsetInput")) dom.get("#botTakeProfitOffsetInput").value = state.botTakeProfitOffset || 6;
    if (dom.get("#botCooldownMinutesInput")) dom.get("#botCooldownMinutesInput").value = state.botCooldownMinutes || 15;
    if (dom.get("#botPollIntervalSecondsInput")) dom.get("#botPollIntervalSecondsInput").value = state.botPollIntervalSeconds || 60;

    const setSettingsStatus = (message) => {
        const settingsStatus = dom.get("#settingsStatus");
        if (settingsStatus) settingsStatus.textContent = message;
        dom.setStatus(message);
    };

    const mergeImportedModels = (existing, imported) => {
        const out = [];
        const seen = new Set();
        [...imported, ...(Array.isArray(existing) ? existing : [])].forEach((model) => {
            const token = String(model?.key || model?.id || "").trim();
            if (!token || seen.has(token)) return;
            seen.add(token);
            out.push(model);
        });
        return out;
    };
    
        const importNvidiaBtn = dom.get('#importNvidiaModelsButton');
    if (importNvidiaBtn) importNvidiaBtn.onclick = async () => {
        const apiKey = dom.get('#nvidiaImportApiKeyInput')?.value?.trim();
        const baseUrl = dom.get('#modelBaseUrlInput')?.value?.trim() || APP_CONFIG.defaultBaseUrl;
        if (!apiKey) { setSettingsStatus('Please enter an API key.'); return; }
        importNvidiaBtn.disabled = true;
        setSettingsStatus('Fetching models via on-device backend...');
        try {
            // Calling the relative path ensures aurum-backend.js intercepts it
            // and uses its internal logic to talk to NVIDIA.
            const res = await fetch(`${EDGE_API_BASE}${APP_CONFIG.settingsPath}?action=fetch-nvidia`, {
                method: 'POST',
                headers: { 
                    'x-admin-password': SETTINGS_PASSWORD,
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ apiKey, baseUrl })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.message || `On-device Error ${res.status}`);
            const imported = (data.models || []).map(m => ({
                key: String(m.id || '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase(),
                id: String(m.id || ''), 
                label: String(m.label || m.id), 
                apiKey, 
                baseUrl
            })).filter(m => m.id);
            state.models = mergeImportedModels(state.models, imported);
            state.debateModels = mergeImportedModels(state.debateModels, imported.map(m => ({ ...m, bias: 'both', isDebateParticipant: true })));
            saveLocalSettings(); renderModelDropdowns();
            setSettingsStatus(`Success: Imported ${imported.length} models.`);
        } catch (e) {
            setSettingsStatus('Import Error: ' + e.message);
        } finally {
            importNvidiaBtn.disabled = false;
        }
    };

    const themeOptions = [
        { value: "dark", label: "Dark Pro" },
        { value: "midnight", label: "Midnight Blue" },
        { value: "light", label: "Light Pro" }
    ];
    initCustomSelect("themeSelect", themeOptions, state.theme || "dark", (val) => {
        state.theme = val;
        document.documentElement.setAttribute("data-theme", val);
        saveLocalSettings();
    });
}

// --- Custom Select Logic ---
function initCustomSelect(containerId, options, initialValue, onSelect) {
    const container = dom.get(`#${containerId}`);
    if (!container) return;

    const initialLabel = options.find(o => o.value === initialValue)?.label || "Select...";

    // Build internal structure
    container.innerHTML = `
        <button type="button" class="custom-select-button">${initialLabel}</button>
        <div class="custom-select-list">
            <input type="text" class="custom-select-search" placeholder="Search...">
            <div class="custom-select-options">
                ${options.map(o => `<button type="button" class="custom-select-option ${o.value === initialValue ? 'active' : ''}" data-value="${o.value}">${o.label}</button>`).join("")}
            </div>
        </div>
    `;

    const button = container.querySelector(".custom-select-button");
    const search = container.querySelector(".custom-select-search");
    const optionList = container.querySelector(".custom-select-options");
    
    // Show search only if there are many options
    if (options.length > 8) {
        search.style.display = "block";
    }

    button.onclick = (e) => {
        e.stopPropagation();
        const isOpen = container.classList.contains("open");
        document.querySelectorAll(".custom-select.open").forEach(s => s.classList.remove("open"));
        if (!isOpen) {
            container.classList.add("open");
            if (search && search.style.display !== "none") {
                search.value = "";
                filterOptions("");
                search.focus();
            }
        }
    };

    const filterOptions = (term) => {
        const t = term.toLowerCase();
        const btns = optionList.querySelectorAll(".custom-select-option");
        btns.forEach(btn => {
            const text = btn.textContent.toLowerCase();
            btn.style.display = text.includes(t) ? "block" : "none";
        });
    };

    if (search) {
        search.onclick = (e) => e.stopPropagation();
        search.oninput = (e) => filterOptions(e.target.value);
    }

    // Use event delegation for options
    optionList.onclick = (e) => {
        const btn = e.target.closest(".custom-select-option");
        if (!btn) return;
        
        e.stopPropagation();
        const val = btn.getAttribute("data-value");
        const label = btn.textContent;
        
        button.textContent = label;
        optionList.querySelectorAll(".custom-select-option").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        container.classList.remove("open");
        
        if (onSelect) onSelect(val);
    };
}

// Close custom selects when clicking outside
document.addEventListener("click", () => {
    document.querySelectorAll(".custom-select.open").forEach(s => s.classList.remove("open"));
});

function setCustomSelectValue(containerId, value) {
    const container = dom.get(`#${containerId}`);
    if (!container) return;
    const btn = container.querySelector(`.custom-select-option[data-value="${value}"]`);
    if (btn) {
        const display = container.querySelector(".custom-select-button");
        const options = container.querySelectorAll(".custom-select-option");
        display.textContent = btn.textContent;
        options.forEach(o => o.classList.remove("active"));
        btn.classList.add("active");
    } else {
        const display = container.querySelector(".custom-select-button");
        const options = container.querySelectorAll(".custom-select-option");
        if (display) display.textContent = "Select...";
        options.forEach(o => o.classList.remove("active"));
    }
}


function setupTrackerModal() {
  const steps = [
    { id: "stepDiscovery", key: "Discovery" },
    { id: "stepSweep", key: "Sweep" },
    { id: "stepChoch", key: "Choch" },
    { id: "stepTrigger", key: "Trigger" },
    { id: "stepTarget", key: "Target" }
  ];
  steps.forEach(step => {
    const el = document.getElementById(step.id);
    if (el) {
      el.addEventListener("click", () => showTrackerModal(step.key));
    }
  });

  const closeBtn = document.getElementById("closeTrackerModal");
  if (closeBtn) {
    closeBtn.onclick = () => {
      const modal = document.getElementById("trackerModal");
      if (modal) {
        modal.style.display = "none";
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
      }
    };
  }
}

function showTrackerModal(stepName) {
  const data = state.latestTrackerData || {};
  const modal = document.getElementById("trackerModal");
  const title = document.getElementById("trackerModalTitle");
  const summary = document.getElementById("trackerModalSummary");
  const valuesList = document.getElementById("trackerModalValues");
  if (!modal) return;

  let stepTitle = "";
  let stepKicker = "Tracker Stage Detail";
  let stepSummary = "";
  let itemsHtml = "";

  if (stepName === "Discovery") {
    stepTitle = "1. Discovery Stage";
    stepKicker = "Scanning Supply & Demand";
    stepSummary = "Identifying institutional interest zones. Discovery looks for Order Blocks (OB) and Fair Value Gaps (FVG) which represent major imbalances where smart money has entered, forming strong magnets for price retracement.";
    
    const obs = Array.isArray(data.obs) ? data.obs : [];
    const fvgs = Array.isArray(data.fvgs) ? data.fvgs : [];
    
    if (!obs.length && !fvgs.length) {
      itemsHtml = `<li class="tracker-modal-value-item"><span class="lbl">Status</span><span class="val">No OB or FVG zones detected.</span></li>`;
    } else {
      obs.forEach((ob, idx) => {
        itemsHtml += `<li class="tracker-modal-value-item"><span class="lbl">Order Block #${idx+1}</span><span class="val active">${escapeHtml(ob)}</span></li>`;
      });
      fvgs.forEach((f, idx) => {
        const sideStr = String(f.side || "").toUpperCase();
        itemsHtml += `<li class="tracker-modal-value-item"><span class="lbl">FVG #${idx+1} (${sideStr})</span><span class="val secondary">@ ${Number(f.price || 0).toFixed(2)}</span></li>`;
      });
    }
  }
  else if (stepName === "Sweep") {
    stepTitle = "2. Liquidity Hunt";
    stepKicker = "Institutional Stop Hunts";
    stepSummary = "Smart money hunts liquidity pools (retail buy stops and sell stops) situated past major highs/lows. Price sweeps these levels to trigger retail stops, capturing liquidity before starting a reversal.";
    
    const liquidity = Array.isArray(data.liquidity) ? data.liquidity : [];
    const events = Array.isArray(data.structureEvents) ? data.structureEvents : [];
    const sweeps = events.filter(e => typeof e === 'string' && e.toLowerCase().includes("sweep"));
    
    if (sweeps.length > 0) {
      sweeps.forEach((sw, idx) => {
        itemsHtml += `<li class="tracker-modal-value-item"><span class="lbl">Active Sweep #${idx+1}</span><span class="val active">${escapeHtml(sw)}</span></li>`;
      });
    }
    
    if (liquidity.length > 0) {
      liquidity.slice(0, 6).forEach((liq, idx) => {
        itemsHtml += `<li class="tracker-modal-value-item"><span class="lbl">Monitored Pool #${idx+1}</span><span class="val">${escapeHtml(liq)}</span></li>`;
      });
    }
    
    if (!itemsHtml) {
      itemsHtml = `<li class="tracker-modal-value-item"><span class="lbl">Status</span><span class="val">Monitoring liquidity pools...</span></li>`;
    }
  }
  else if (stepName === "Choch") {
    stepTitle = "3. Character Shift";
    stepKicker = "Market Structure Reversal";
    stepSummary = "Looking for a Change of Character (CHoCH) or Break of Structure (BOS) on lower timeframes (M5/M15). This represents a shift in institutional market structure, confirming that the swept level has initiated a strong reversal direction.";
    
    const events = Array.isArray(data.structureEvents) ? data.structureEvents : [];
    const shifts = events.filter(e => typeof e === 'string' && (e.toLowerCase().includes("bos") || e.toLowerCase().includes("choch")));
    
    if (shifts.length > 0) {
      shifts.forEach((sh, idx) => {
        itemsHtml += `<li class="tracker-modal-value-item"><span class="lbl">Structure Event #${idx+1}</span><span class="val active">${escapeHtml(sh)}</span></li>`;
      });
    } else {
      itemsHtml = `
        <li class="tracker-modal-value-item"><span class="lbl">Status</span><span class="val">Awaiting structure shift...</span></li>
        <li class="tracker-modal-value-item"><span class="lbl">Current Price</span><span class="val">@ ${Number(data.price || 0).toFixed(2)}</span></li>
      `;
    }
  }
  else if (stepName === "Trigger") {
    stepTitle = "4. Sniper Entry";
    stepKicker = "Optimal Trade Entry (OTE)";
    stepSummary = "Precision execution within the sniper entry zone. This overlaps structural retracements (62% - 79% Fib leg) with newly formed demand or supply Order Blocks and FVG mitigations, offering maximum reward-to-risk ratio.";
    
    const dec = data.decision || {};
    const sl = Number(dec.stopPrice || 0);
    const tp1 = Number(dec.tp1 || 0);
    const current = Number(data.price || 0);
    
    itemsHtml = `
      <li class="tracker-modal-value-item"><span class="lbl">Bias Direction</span><span class="val active">${escapeHtml(String(dec.action || "Awaiting").toUpperCase())}</span></li>
      <li class="tracker-modal-value-item"><span class="lbl">Current Gold Price</span><span class="val">@ ${current.toFixed(2)}</span></li>
      <li class="tracker-modal-value-item"><span class="lbl">Protection Stop Loss</span><span class="val secondary">@ ${sl > 0 ? sl.toFixed(2) : "n/a"}</span></li>
      <li class="tracker-modal-value-item"><span class="lbl">Confidence Rating</span><span class="val">${dec.confidence || 0}%</span></li>
    `;
  }
  else if (stepName === "Target") {
    stepTitle = "5. Distribution (Take Profit)";
    stepKicker = "Scaling Institutional Position";
    stepSummary = "Reaching major structural targets. This is where smart money distributes their accumulated positions back into retail flow, generating take-profit exits at high liquidity points.";
    
    const dec = data.decision || {};
    const tp1 = Number(dec.tp1 || 0);
    const tp2 = Number(dec.tp2 || 0);
    const sl = Number(dec.stopPrice || 0);
    
    itemsHtml = `
      <li class="tracker-modal-value-item"><span class="lbl">Take Profit Target 1 (TP1)</span><span class="val active">@ ${tp1 > 0 ? tp1.toFixed(2) : "n/a"}</span></li>
      <li class="tracker-modal-value-item"><span class="lbl">Take Profit Target 2 (TP2)</span><span class="val secondary">@ ${tp2 > 0 ? tp2.toFixed(2) : "n/a"}</span></li>
      <li class="tracker-modal-value-item"><span class="lbl">Risk Protection (SL)</span><span class="val">@ ${sl > 0 ? sl.toFixed(2) : "n/a"}</span></li>
    `;
  }

  // Bind values
  const kickerEl = document.getElementById("trackerModalKicker");
  if (kickerEl) kickerEl.textContent = stepKicker;
  if (title) title.textContent = stepTitle;
  if (summary) summary.textContent = stepSummary;
  if (valuesList) valuesList.innerHTML = itemsHtml;

  // Toggle open
  modal.style.display = "grid";
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function setupDebateCouncilModal() {
  const closeBtn = document.getElementById("closeDebateCouncilModal");
  if (closeBtn) {
    closeBtn.onclick = () => {
      const modal = document.getElementById("debateCouncilModal");
      if (modal) {
        modal.style.display = "none";
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
      }
    };
  }
  const viewDetailsBtn = document.getElementById("viewDebateDetailsButton");
  if (viewDetailsBtn) {
    viewDetailsBtn.onclick = () => showDebateCouncilModal();
  }
}

function showDebateCouncilModal() {
  const modal = document.getElementById("debateCouncilModal");
  const modelList = document.getElementById("debateModelList");
  const activeModelName = document.getElementById("debateActiveModelName");
  const outputContainer = document.getElementById("debateModelOutputContainer");
  if (!modal) return;

  // Reset display
  if (modelList) modelList.innerHTML = "";
  if (activeModelName) activeModelName.textContent = "Select a model to view output";
  if (outputContainer) outputContainer.textContent = "Choose a model from the left sidebar to display its response commentary here.";

  const aiResult = state.lastAiResult || {};
  const debateResponses = aiResult.ai?.debateResponses || [];

  if (!debateResponses.length) {
    if (outputContainer) {
      if (aiResult.ai?.debateUsed === false) {
        outputContainer.textContent = "No debate was conducted. Either only a single summary model was selected, or all debate models timed out/failed. Run a bot preview first with debate models enabled in Settings.";
      } else {
        outputContainer.textContent = "No active debate data found. Please run a bot preview first to execute the Arbiter Debate Council.";
      }
    }
  } else {
    // Populate list of models
    debateResponses.forEach((resp, idx) => {
      const li = document.createElement("li");
      const biasLabel = String(resp.bias || "balanced").toUpperCase();
      li.innerHTML = `
        <button class="debate-model-item" data-index="${idx}">
          <span class="debate-model-name">${escapeHtml(resp.modelLabel || resp.modelId)}</span>
          <span class="debate-model-badge ${escapeHtml(resp.bias || 'balanced')}">${escapeHtml(biasLabel)}</span>
        </button>
      `;
      modelList.appendChild(li);
    });

    // Add click listeners to items
    const items = modelList.querySelectorAll(".debate-model-item");
    items.forEach(btn => {
      btn.onclick = () => {
        // Toggle active class
        items.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const index = parseInt(btn.getAttribute("data-index"), 10);
        const resp = debateResponses[index];
        if (resp) {
          activeModelName.textContent = `${resp.modelLabel || resp.modelId} (${String(resp.bias || 'balanced').toUpperCase()})`;
          outputContainer.textContent = resp.output || "Empty response from model.";
        }
      };
    });

    // Automatically click first model in the list
    if (items.length > 0) {
      items[0].click();
    }
  }

  // Toggle open
  modal.style.display = "grid";
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

// --- ICT Optimal Trade Entry (OTE) Fibonacci & Swing Deep-Dive Module ---

function calculateFibonacciOTE(candles, timeframeName, currentPrice) {
    if (!candles || candles.length < 15) {
        return null;
    }

    // Find all local swings of depth 4
    const highs = [];
    const lows = [];
    const len = candles.length;
    const k = 4;
    
    for (let i = k; i < len - k; i++) {
        let isHigh = true;
        let isLow = true;
        for (let j = 1; j <= k; j++) {
            if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
                isHigh = false;
            }
            if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
                isLow = false;
            }
        }
        if (isHigh) highs.push({ price: candles[i].high, index: i });
        if (isLow) lows.push({ price: candles[i].low, index: i });
    }

    // Fallback search with smaller depth
    if (highs.length === 0 || lows.length === 0) {
        const k2 = 2;
        for (let i = k2; i < len - k2; i++) {
            let isHigh = true;
            let isLow = true;
            for (let j = 1; j <= k2; j++) {
                if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
                    isHigh = false;
                }
                if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
                    isLow = false;
                }
            }
            if (isHigh) highs.push({ price: candles[i].high, index: i });
            if (isLow) lows.push({ price: candles[i].low, index: i });
        }
    }

    // Secondary fallback using absolute limits of the last 40 candles
    if (highs.length === 0 || lows.length === 0) {
        const sliceSize = Math.min(40, len);
        const recentCandles = candles.slice(-sliceSize);
        const absHigh = Math.max(...recentCandles.map(c => c.high));
        const absLow = Math.min(...recentCandles.map(c => c.low));
        highs.push({ price: absHigh, index: len - Math.floor(sliceSize / 2) });
        lows.push({ price: absLow, index: len - sliceSize });
    }

    const allSwings = [];
    highs.forEach(h => allSwings.push({ ...h, type: 'high' }));
    lows.forEach(l => allSwings.push({ ...l, type: 'low' }));
    allSwings.sort((a, b) => a.index - b.index);

    if (allSwings.length < 2) return null;

    const lastSwing = allSwings[allSwings.length - 1];
    let prevSwing = null;
    for (let i = allSwings.length - 2; i >= 0; i--) {
        if (allSwings[i].type !== lastSwing.type) {
            prevSwing = allSwings[i];
            break;
        }
    }

    if (!prevSwing) return null;

    const isBullishImpulse = lastSwing.type === 'high' && prevSwing.type === 'low';
    const highPrice = isBullishImpulse ? lastSwing.price : prevSwing.price;
    const lowPrice = !isBullishImpulse ? lastSwing.price : prevSwing.price;
    const range = highPrice - lowPrice;

    if (range <= 0) return null;

    let levels = {};
    if (isBullishImpulse) {
        levels = {
            0: highPrice,
            0.618: highPrice - (range * 0.618),
            0.705: highPrice - (range * 0.705),
            1: lowPrice
        };
    } else {
        levels = {
            0: lowPrice,
            0.618: lowPrice + (range * 0.618),
            0.705: lowPrice + (range * 0.705),
            1: highPrice
        };
    }

    let statusClass = "pending";
    let statusText = "PRE-OTE ⚪";
    
    if (isBullishImpulse) {
        if (currentPrice <= levels[0.618] && currentPrice >= levels[0.705]) {
            statusClass = "tracking";
            statusText = "BUY ZONE 🟢";
        } else if (currentPrice > levels[0.618]) {
            statusClass = "pending";
            statusText = "PREMIUM ⚪";
        } else if (currentPrice < levels[0.705]) {
            statusClass = "swept";
            statusText = "INVALIDATED 🔴";
        }
    } else {
        if (currentPrice >= levels[0.618] && currentPrice <= levels[0.705]) {
            statusClass = "swept";
            statusText = "SELL ZONE 🔴";
        } else if (currentPrice < levels[0.618]) {
            statusClass = "pending";
            statusText = "DISCOUNT ⚪";
        } else if (currentPrice > levels[0.705]) {
            statusClass = "swept";
            statusText = "INVALIDATED 🔴";
        }
    }

    return {
        timeframeName,
        isBullishImpulse,
        levels,
        currentPrice,
        statusClass,
        statusText,
        range,
        tp: levels[0],
        sl: levels[1]
    };
}

function renderFibonacciOteUI(mtfData) {
    let fibPanel = document.getElementById("fibonacciOtePanel");
    if (!fibPanel) {
        const chartPanel = document.querySelector(".chart-panel");
        if (chartPanel) {
            fibPanel = document.createElement("section");
            fibPanel.className = "panel";
            fibPanel.id = "fibonacciOtePanel";
            fibPanel.style.gridColumn = "1 / -1";
            fibPanel.innerHTML = `
                <div class="panel-head">
                  <div>
                    <p class="panel-kicker">ICT Optimal Trade Entry (OTE)</p>
                    <h2>Multi-Timeframe Fibonacci OTE</h2>
                  </div>
                  <span id="fibonacciOteBadge" class="badge">ACTIVE</span>
                </div>
                <div class="liquidity-pools-grid" id="fibonacciOteGrid" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:1rem; margin-top:1rem;">
                    <p style="color:var(--muted);font-size:0.85rem;">Awaiting analysis to calculate Fibonacci OTE calls...</p>
                </div>
            `;
            chartPanel.parentNode.insertBefore(fibPanel, chartPanel);
        }
    }

    const grid = document.getElementById("fibonacciOteGrid");
    if (!grid || !mtfData || !mtfData.data) return;

    const timeframes = [
        { id: "5min", name: "5 Minute (5M)" },
        { id: "15min", name: "15 Minute (15M)" },
        { id: "h1", name: "1 Hour (1H)" },
        { id: "4h", name: "4 Hour (4H)" },
        { id: "1day", name: "Daily (1D)" },
        { id: "1week", name: "Weekly (1W)" },
        { id: "1month", name: "Monthly (1M)" }
    ];

    let html = "";
    
    timeframes.forEach(tf => {
        const candles = LiquidityEngine._getCandles(mtfData, tf.id);
        if (!candles || candles.length === 0) return;
        
        const currentPrice = candles.at(-1).close;
        const fib = calculateFibonacciOTE(candles, tf.name, currentPrice);
        
        if (!fib) return;

        const impulseLabel = fib.isBullishImpulse ? "🟢 Bullish Impulse" : "🔴 Bearish Impulse";
        
        // Interactive clickable container cards with hover transitions
        html += `
            <div class="liquidity-tier-card" 
                 onclick="openSwingDeepDiveModal('${tf.id}', '${tf.name}')" 
                 style="background: var(--surface); border: 1px solid rgba(255,255,255,0.05); padding: 1.2rem; border-radius: 8px; cursor: pointer; transition: transform 0.2s, border-color 0.2s;"
                 onmouseover="this.style.borderColor='rgba(255,255,255,0.15)'; this.style.transform='translateY(-2px)';"
                 onmouseout="this.style.borderColor='rgba(255,255,255,0.05)'; this.style.transform='translateY(0)';"
                 title="Click to deep-dive into the Fair Value Gaps and Order Blocks of this swing leg">
                <div class="tier-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.8rem; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 0.5rem;">
                    <span style="font-weight:600; font-size:0.95rem; color:var(--text);">${tf.name}</span>
                    <span class="pool-status ${fib.statusClass}" style="padding: 2px 8px; border-radius: 4px; font-weight:700; font-size:0.75rem;">${fib.statusText}</span>
                </div>
                <div style="font-size:0.8rem; color:var(--muted); margin-bottom:0.8rem;">
                    Type: <strong style="color:var(--text);">${impulseLabel}</strong>
                </div>
                <div style="display:flex; flex-direction:column; gap:0.4rem; font-size:0.82rem;">
                    <div style="display:flex; justify-content:space-between;">
                        <span>Level 1.0 (Stop Loss)</span>
                        <strong style="color:var(--text); font-family:monospace;">$${safeToFixed(fib.sl)}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span>Level 0.705 (OTE Bottom)</span>
                        <strong style="color:var(--text); font-family:monospace;">$${safeToFixed(fib.levels[0.705])}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span>Level 0.618 (OTE Top)</span>
                        <strong style="color:var(--text); font-family:monospace;">$${safeToFixed(fib.levels[0.618])}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span>Level 0.000 (Take Profit)</span>
                        <strong style="color:var(--text); font-family:monospace;">$${safeToFixed(fib.tp)}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top:0.4rem; border-top:1px dashed rgba(255,255,255,0.1); padding-top:0.4rem;">
                        <span>Current Price</span>
                        <strong style="color:var(--text); font-family:monospace;">$${safeToFixed(fib.currentPrice)}</strong>
                    </div>
                </div>
            </div>
        `;
    });

    grid.innerHTML = html || `<p style="color:var(--muted);font-size:0.85rem;">No Fibonacci retracement data could be calculated.</p>`;
}

/**
 * Deep-dive scanner: Calculates all Fair Value Gaps (FVG) and Order Blocks (OB) 
 * located chronologically within the detected swing leg.
 */
function scanSwingLegDetails(candles, startIdx, endIdx, isBullish) {
    const fvgs = [];
    const obs = [];
    const len = candles.length;

    // 1. Scan for Fair Value Gaps inside the swing leg range [startIdx, endIdx]
    for (let i = startIdx + 1; i < endIdx; i++) {
        if (i < 1 || i >= len - 1) continue;
        const prev = candles[i - 1];
        const next = candles[i + 1];

        if (isBullish) {
            // Bullish FVG: next low > previous high
            if (next.low > prev.high) {
                const isTapped = candles.slice(i + 1).some(c => c.low < prev.high);
                fvgs.push({
                    type: "Bullish FVG",
                    top: next.low,
                    bottom: prev.high,
                    priceLabel: `$${prev.high.toFixed(2)} → $${next.low.toFixed(2)}`,
                    status: isTapped ? "Tapped (Mitigated) ⚪" : "Open (Unmitigated) 🟢",
                    statusClass: isTapped ? "pending" : "tracking"
                });
            }
        } else {
            // Bearish FVG: next high < previous low
            if (next.high < prev.low) {
                const isTapped = candles.slice(i + 1).some(c => c.high > prev.low);
                fvgs.push({
                    type: "Bearish FVG",
                    top: prev.low,
                    bottom: next.high,
                    priceLabel: `$${next.high.toFixed(2)} → $${prev.low.toFixed(2)}`,
                    status: isTapped ? "Tapped (Mitigated) ⚪" : "Open (Unmitigated) 🔴",
                    statusClass: isTapped ? "pending" : "swept"
                });
            }
        }
    }

    // 2. Scan for Order Block near the origin of the swing (startIdx)
    let obCandle = null;
    const searchStart = Math.max(0, startIdx - 2);
    const searchEnd = Math.min(len - 1, startIdx + 2);

    for (let i = searchStart; i <= searchEnd; i++) {
        const c = candles[i];
        if (isBullish) {
            if (c.close < c.open) { // bearish candle prior to expansion
                if (!obCandle || c.low < obCandle.low) obCandle = c;
            }
        } else {
            if (c.close > c.open) { // bullish candle prior to expansion
                if (!obCandle || c.high > obCandle.high) obCandle = c;
            }
        }
    }

    // Fallback to the swing start candle if no opposite candle found
    if (!obCandle && candles[startIdx]) {
        obCandle = candles[startIdx];
    }

    if (obCandle) {
        const isTapped = isBullish 
            ? candles.slice(startIdx + 1).some(c => c.low < obCandle.low)
            : candles.slice(startIdx + 1).some(c => c.high > obCandle.high);

        obs.push({
            type: isBullish ? "Bullish OB" : "Bearish OB",
            top: obCandle.high,
            bottom: obCandle.low,
            priceLabel: `$${obCandle.low.toFixed(2)} → $${obCandle.high.toFixed(2)}`,
            status: isTapped ? "Tapped (Mitigated) ⚪" : "Open (Unmitigated) 🌟",
            statusClass: isTapped ? "pending" : (isBullish ? "tracking" : "swept")
        });
    }

    return { fvgs, obs };
}

/**
 * Interactive Modal Pop-Up: Displays the deep-dive analysis of FVGs and OBs
 * inside the selected timeframe's swing leg.
 */
function openSwingDeepDiveModal(timeframeId, timeframeName) {
    if (!state.lastMtfData) {
        alert("Please run a bot preview first to load timeframe candles!");
        return;
    }

    const candles = LiquidityEngine._getCandles(state.lastMtfData, timeframeId);
    if (!candles || candles.length === 0) {
        alert(`No candle history available for ${timeframeName}.`);
        return;
    }

    const currentPrice = candles.at(-1).close;
    const fib = calculateFibonacciOTE(candles, timeframeName, currentPrice);

    if (!fib) {
        alert(`Could not calculate Fibonacci swing leg for ${timeframeName}.`);
        return;
    }

    // Re-detect the swing indexes chronologically to find our start and end index
    const highs = [];
    const lows = [];
    const len = candles.length;
    const k = 4;
    for (let i = k; i < len - k; i++) {
        let isHigh = true; let isLow = true;
        for (let j = 1; j <= k; j++) {
            if (candles[i].high <= candles[i-j].high || candles[i].high <= candles[i+j].high) isHigh = false;
            if (candles[i].low >= candles[i-j].low || candles[i].low >= candles[i+j].low) isLow = false;
        }
        if (isHigh) highs.push({ index: i });
        if (isLow) lows.push({ index: i });
    }
    if (highs.length === 0 || lows.length === 0) {
        const k2 = 2;
        for (let i = k2; i < len - k2; i++) {
            let isHigh = true; let isLow = true;
            for (let j = 1; j <= k2; j++) {
                if (candles[i].high <= candles[i-j].high || candles[i].high <= candles[i+j].high) isHigh = false;
                if (candles[i].low >= candles[i-j].low || candles[i].low >= candles[i+j].low) isLow = false;
            }
            if (isHigh) highs.push({ index: i });
            if (isLow) lows.push({ index: i });
        }
    }
    if (highs.length === 0 || lows.length === 0) {
        const sliceSize = Math.min(40, len);
        highs.push({ index: len - Math.floor(sliceSize / 2) });
        lows.push({ index: len - sliceSize });
    }

    const allSwings = [];
    highs.forEach(h => allSwings.push({ ...h, type: 'high' }));
    lows.forEach(l => allSwings.push({ ...l, type: 'low' }));
    allSwings.sort((a, b) => a.index - b.index);

    const lastSwing = allSwings[allSwings.length - 1];
    let prevSwing = null;
    for (let i = allSwings.length - 2; i >= 0; i--) {
        if (allSwings[i].type !== lastSwing.type) { prevSwing = allSwings[i]; break; }
    }

    const startIdx = prevSwing ? prevSwing.index : 0;
    const endIdx = lastSwing ? lastSwing.index : len - 1;

    // Scan the swing leg for FVGs and OBs
    const zones = scanSwingLegDetails(candles, startIdx, endIdx, fib.isBullishImpulse);

    // Create Modal HTML Overlay dynamically
    let modal = document.getElementById("swingDeepDiveModal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "swingDeepDiveModal";
        modal.style.position = "fixed";
        modal.style.top = "0";
        modal.style.left = "0";
        modal.style.width = "100vw";
        modal.style.height = "100vh";
        modal.style.backgroundColor = "rgba(10, 15, 24, 0.85)";
        modal.style.backdropFilter = "blur(8px)";
        modal.style.zIndex = "10000";
        modal.style.display = "flex";
        modal.style.justifyContent = "center";
        modal.style.alignItems = "center";
        modal.style.opacity = "0";
        modal.style.transition = "opacity 0.25s ease-out";
        document.body.appendChild(modal);
    }

    // Build the lists inside the modal
    let fvgRows = zones.fvgs.map(f => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding: 0.6rem 0.8rem; border-radius:4px; border-left:3px solid ${fib.isBullishImpulse ? '#4e9f3d' : '#d9534f'};">
            <div>
                <span style="font-weight:600; font-size:0.85rem; color:var(--text);">${f.type}</span>
                <div style="font-family:monospace; font-size:0.8rem; color:var(--muted); margin-top:0.2rem;">${f.priceLabel}</div>
            </div>
            <span class="pool-status ${f.statusClass}" style="padding: 2px 6px; border-radius: 4px; font-weight:700; font-size:0.7rem;">${f.status}</span>
        </div>
    `).join("");

    if (zones.fvgs.length === 0) {
        fvgRows = `<p style="color:var(--muted); font-size:0.85rem; text-align:center; padding: 1rem 0;">No Fair Value Gaps (FVG) detected in this swing leg.</p>`;
    }

    let obRows = zones.obs.map(o => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding: 0.6rem 0.8rem; border-radius:4px; border-left:3px solid ${fib.isBullishImpulse ? '#4e9f3d' : '#d9534f'};">
            <div>
                <span style="font-weight:600; font-size:0.85rem; color:var(--text);">${o.type}</span>
                <div style="font-family:monospace; font-size:0.8rem; color:var(--muted); margin-top:0.2rem;">${o.priceLabel}</div>
            </div>
            <span class="pool-status ${o.statusClass}" style="padding: 2px 6px; border-radius: 4px; font-weight:700; font-size:0.7rem;">${o.status}</span>
        </div>
    `).join("");

    if (zones.obs.length === 0) {
        obRows = `<p style="color:var(--muted); font-size:0.85rem; text-align:center; padding: 1rem 0;">No Order Blocks (OB) detected near the origin.</p>`;
    }

    modal.innerHTML = `
        <div class="modal-content" style="background:#111827; border: 1px solid rgba(255,255,255,0.1); width:90%; max-width:600px; max-height:85vh; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 20px 25px -5px rgba(0,0,0,0.5); overflow:hidden;">
            <!-- Modal Header -->
            <div style="padding: 1.2rem 1.5rem; border-bottom: 1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center; background:#1f2937;">
                <div>
                    <span style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; font-weight:700; letter-spacing:0.05em;">SMC Internal Structure</span>
                    <h3 style="margin: 0.2rem 0 0; color:var(--text); font-size:1.2rem; font-weight:700;">🔍 ${timeframeName} Swing Leg Deep-Dive</h3>
                </div>
                <button onclick="closeSwingDeepDiveModal()" style="background:none; border:none; color:var(--muted); font-size:1.5rem; cursor:pointer; line-height:1; transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--muted)'">&times;</button>
            </div>
            
            <!-- Scrollable Content -->
            <div style="padding: 1.5rem; overflow-y:auto; display:flex; flex-direction:column; gap:1.5rem;">
                <!-- Swing Context Summary -->
                <div style="background:rgba(255,255,255,0.03); padding:1rem; border-radius:8px; display:grid; grid-template-columns: 1fr 1fr; gap:0.8rem; font-size:0.85rem;">
                    <div><span style="color:var(--muted);">Structure bias:</span> <strong style="color:var(--text);">${fib.isBullishImpulse ? 'Bullish Buy Pullback' : 'Bearish Sell Retrace'}</strong></div>
                    <div><span style="color:var(--muted);">OTE Live Call:</span> <strong class="${fib.statusClass}" style="padding:1px 6px; border-radius:4px;">${fib.statusText}</strong></div>
                    <div><span style="color:var(--muted);">Swing Start (SL):</span> <strong style="color:var(--text); font-family:monospace;">$${fib.sl.toFixed(2)}</strong></div>
                    <div><span style="color:var(--muted);">Swing Target (TP):</span> <strong style="color:var(--text); font-family:monospace;">$${fib.tp.toFixed(2)}</strong></div>
                </div>

                <!-- Section: Order Blocks (Origin) -->
                <div>
                    <h4 style="margin:0 0 0.6rem 0; color:var(--text); font-size:0.9rem; font-weight:700; display:flex; align-items:center; gap:0.4rem;">
                        <span>🧱</span> Swing Origin Order Blocks (OB)
                    </h4>
                    <div style="display:flex; flex-direction:column; gap:0.5rem;">
                        ${obRows}
                    </div>
                </div>

                <!-- Section: Fair Value Gaps (FVG) -->
                <div>
                    <h4 style="margin:0 0 0.6rem 0; color:var(--text); font-size:0.9rem; font-weight:700; display:flex; align-items:center; gap:0.4rem;">
                        <span>⚡</span> Swing Leg Fair Value Gaps (FVG)
                    </h4>
                    <div style="display:flex; flex-direction:column; gap:0.5rem; max-height: 250px; overflow-y: auto; padding-right:4px;">
                        ${fvgRows}
                    </div>
                </div>
            </div>

            <!-- Footer -->
            <div style="padding: 1rem 1.5rem; border-top: 1px solid rgba(255,255,255,0.08); display:flex; justify-content:flex-end; background:#111827;">
                <button onclick="closeSwingDeepDiveModal()" style="background:#1f2937; color:var(--text); border:1px solid rgba(255,255,255,0.1); padding:0.4rem 1.2rem; border-radius:6px; font-weight:600; cursor:pointer; font-size:0.85rem; transition:background 0.2s;" onmouseover="this.style.background='#374151'" onmouseout="this.style.background='#1f2937'">Close Analysis</button>
            </div>
        </div>
    `;

    // Trigger Fade-In
    modal.style.display = "flex";
    setTimeout(() => {
        modal.style.opacity = "1";
    }, 10);
}

function closeSwingDeepDiveModal() {
    const modal = document.getElementById("swingDeepDiveModal");
    if (modal) {
        modal.style.opacity = "0";
        setTimeout(() => {
            modal.style.display = "none";
        }, 250);
    }
}
