import { SweepEngine } from './SweepEngine.js';
import { FVGEngine } from './FVGEngine.js';
import { TrendEngine } from './TrendEngine.js';
import { FibonacciEngine } from './FibonacciEngine.js';
import { detectSwings } from '../analysis.js'; // We'll keep some generic utils in analysis.js for now or move them later
import { RMI } from '../../lib/rmi.js';
import { detectAmdPhase, toGmtHour } from '../utils.js';

export class MixerEngine {
    /**
     * Replaces monolithic analysis and synthesizes inputs from specialized engines.
     */
    static process(mtfData, intel, optionsIntel = null, selectedTimeframe = "1h", previousRmi = 0) {
        const entrySet = mtfData.data.find(d => d.id === "entry");
        const h1Set = mtfData.data.find(d => d.id === "h1");
        const d1Set = mtfData.data.find(d => d.id === "1day");
        const w1Set = mtfData.data.find(d => d.id === "1week");
        const m1Set = mtfData.data.find(d => d.id === "1month");
        
        if (!entrySet || !entrySet.values) {
            throw new Error("Critical Entry Data Stream is missing or empty.");
        }

        const parseTwelveValues = (set) => {
            if (!set || !set.values) return [];
            return set.values.map(v => ({
                datetime: v.datetime,
                open: parseFloat(v.open),
                high: parseFloat(v.high),
                low: parseFloat(v.low),
                close: parseFloat(v.close),
                volume: parseInt(v.volume || 0)
            })).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
        };

        const entryCandles = parseTwelveValues(entrySet);
        const htfCandles = {
            "1h": h1Set ? parseTwelveValues(h1Set) : entryCandles,
            "1day": d1Set ? parseTwelveValues(d1Set) : [],
            "1week": w1Set ? parseTwelveValues(w1Set) : [],
            "1month": m1Set ? parseTwelveValues(m1Set) : []
        };

        if (!entryCandles || entryCandles.length < 20) {
            throw new Error("Insufficient candle data for institutional analysis.");
        }

        const latest = entryCandles[entryCandles.length - 1];
        
        // Compute ATR
        const atr14 = this.averageTrueRange(entryCandles, 14);
        const currentAtr = atr14.at(-1);

        // Run Engines
        const swings = detectSwings(entryCandles, 3);
        const fvgs = FVGEngine.detect(entryCandles);
        const trendData = TrendEngine.detect(entryCandles, htfCandles);
        const liquidity = SweepEngine.detect(entryCandles, swings, htfCandles, currentAtr);
        const fibonacci = FibonacciEngine.detect(swings, latest.close);
        
        const structureMeta = this.detectStructureEvents(entryCandles, swings);
        const orderBlocks = this.detectOrderBlocks(entryCandles, fvgs, structureMeta.events, liquidity, currentAtr);
        const premiumDiscount = this.detectPremiumDiscount(entryCandles, latest.close);
        const sessions = this.detectSessions(entryCandles);

        // Build Context
        const context = {
            price: latest.close,
            trend: trendData.trend,
            sma21: trendData.sma21,
            sma50: trendData.sma50,
            atr14: currentAtr,
            swings,
            fvgs,
            orderBlocks,
            fibonacci,
            structure: structureMeta.events,
            structureMeta: structureMeta.meta,
            liquidity,
            premiumDiscount,
            sessions,
            htfAlignment: trendData.htfAlignment,
            reversalZones: this.detectReversalZones(orderBlocks, fvgs, latest.close),
            displacement: [], // Placeholder for future displacement engine
            volumeProfile: { poc: latest.close }, // Placeholder
            smt: { side: "none" }, // Placeholder
            timeframe: selectedTimeframe,
            timestamp: latest.datetime,
            scenarios: [],
            equationContext: { mathematicalScore: 5, garchRegime: "low", expectedMove: 2, atr14: currentAtr }
        };

        // RMI Calculation
        const currentRmi = RMI.calculate(entryCandles);
        const rmiBias = RMI.getBias(currentRmi, previousRmi);
        context.rmi = {
            value: currentRmi,
            bias: rmiBias,
            benchmark: "Self-Referenced Gold"
        };
        context.institutionalNews = intel.news || [];
        context.newsToday = (intel.news || []).map(n => `${n.event} (${n.impact})`).join(", ");
        
        // Detect Inducement (short-term swings)
        const shortSwings = detectSwings(entryCandles, 2);
        context.inducement = shortSwings.highs.slice(-1)[0] || null;

        // Mixer Decision Logic
        context.decision = this.buildTradeDecision(context);

        return { context, currentRmi };
    }

    // Ported helpers
    static averageTrueRange(candles, period) {
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
    }

    static detectStructureEvents(candles, swings) {
        const events = [];
        const lastHigh = swings.highs.at(-1);
        const lastLow = swings.lows.at(-1);
        const latest = candles.at(-1);

        if (lastHigh && latest.close > lastHigh.price) {
            events.push({ type: "BOS", side: "bullish", price: lastHigh.price, timestamp: latest.datetime });
        } else if (lastLow && latest.close < lastLow.price) {
            events.push({ type: "BOS", side: "bearish", price: lastLow.price, timestamp: latest.datetime });
        }

        return { events, meta: { trend: events.at(-1)?.side || "neutral" } };
    }

    static detectOrderBlocks(candles, fvgs, events, liquidity, atr) {
        const obs = [];
        for (let i = 1; i < candles.length - 2; i++) {
            const c = candles[i];
            const next = candles[i+1];
            if (c.close < c.open && next.close > c.high) {
                obs.push({ side: "bullish", kind: "decisional", low: c.low, high: c.high, mitigated: false });
            } else if (c.close > c.open && next.close < c.low) {
                obs.push({ side: "bearish", kind: "decisional", low: c.low, high: c.high, mitigated: false });
            }
        }
        return obs.slice(-5);
    }

    static detectPremiumDiscount(candles, price) {
        const high = Math.max(...candles.slice(-40).map(c => c.high));
        const low = Math.min(...candles.slice(-40).map(c => c.low));
        const eq = (high + low) / 2;
        return { zone: price > eq ? "premium" : "discount", equilibrium: eq };
    }

    static detectSessions(candles) {
        const latest = candles.at(-1);
        const hour = toGmtHour(latest.datetime);
        return {
            amdPhase: detectAmdPhase(latest.datetime),
            killzoneActive: (hour >= 7 && hour <= 10) || (hour >= 13 && hour <= 16)
        };
    }

    static detectReversalZones(orderBlocks, fvgs, price) {
        return orderBlocks.map(ob => ({
            side: ob.side,
            label: `${ob.kind} OB`,
            low: ob.low,
            high: ob.high,
            distance: Math.abs(price - ((ob.low + ob.high) / 2))
        })).sort((a,b) => a.distance - b.distance).slice(0, 4);
    }

    static buildTradeDecision(analysis) {
        // Mixer Logic: weigh trend against sweeps
        let direction = analysis.trend === "bullish" ? "Buy" : "Sell";
        let confidence = 50;

        // If there's a recent sweep, it acts as a strong reversal signal
        if (analysis.liquidity?.sweep) {
            if (analysis.liquidity.sweep.side === "bullish_reversal") {
                direction = "Buy";
                confidence += 25;
            } else if (analysis.liquidity.sweep.side === "bearish_reversal") {
                direction = "Sell";
                confidence += 25;
            }
        }

        // Fibonacci Confluence
        if (analysis.fibonacci && analysis.fibonacci.inEntryZone) {
            direction = analysis.fibonacci.action;
            confidence += 30; // Strong signal when in golden zone
        }

        // HTF Confluence
        if (analysis.htfAlignment?.bias === "bullish" && direction === "Buy") confidence += 15;
        if (analysis.htfAlignment?.bias === "bearish" && direction === "Sell") confidence += 15;

        // FVG Confluence
        if (direction === "Buy" && analysis.fvgs.some(f => f.side === "bullish")) confidence += 10;
        if (direction === "Sell" && analysis.fvgs.some(f => f.side === "bearish")) confidence += 10;

        confidence = Math.min(100, confidence);

        const biasSign = direction === "Buy" ? 1 : -1;
        const price = analysis.price;
        const stopDist = analysis.atr14 || 0.8;

        let tp1 = price + (stopDist * 1.5 * biasSign);
        let tp2 = price + (stopDist * 3 * biasSign);
        let tp3 = price + (stopDist * 5 * biasSign);
        let stopPrice = price - (stopDist * 1.2 * biasSign);

        const tradePlan = [
            `Primary bias: ${direction} with ${confidence}% confidence.`,
            `Wait for retest of nearest ${direction === "Buy" ? "bullish" : "bearish"} zone.`,
            analysis.liquidity?.sweep ? `Liquidity swept at ${analysis.liquidity.sweep.price}, targeting reversal.` : "Target liquidity pools (PDH/PDL)."
        ];

        if (analysis.fibonacci && analysis.fibonacci.inEntryZone) {
            tp1 = analysis.fibonacci.tp;
            tp2 = analysis.fibonacci.tp;
            tp3 = analysis.fibonacci.tp;
            stopPrice = analysis.fibonacci.sl;
            tradePlan.push(`Fibonacci Golden Zone active. Entry between 0.618 and 0.705. Target 0 at ${tp1.toFixed(2)}. SL 1 at ${stopPrice.toFixed(2)}.`);
        }

        return {
            action: direction,
            confidence: confidence,
            riskMode: confidence > 70 ? "Aggressive" : "Selective",
            score: 3 * biasSign,
            signals: { 
                totalTds: 6, 
                confluencePoints: 8, 
                gatesPassed: confidence > 60,
                totalScore: 3,
                activeCount: 4,
                htfAligned: analysis.htfAlignment?.bias === (direction === "Buy" ? "bullish" : "bearish"),
                midnightAligned: true,
                smaAligned: true,
                pdAligned: true
            },
            tradePlan: tradePlan,
            tp1: tp1,
            tp2: tp2,
            tp3: tp3,
            stopPrice: stopPrice
        };
    }
}
