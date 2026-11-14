/**
 * Fibonacci OTE (Optimal Trade Entry) calculation.
 *
 * Extracted verbatim from app.js (issue #26) so the core trading math is
 * testable. Earlier this was only reachable at runtime with a real chart.
 *
 * The function itself is pure: no DOM, no app state, no globals.
 *
 * Swing detection degrades in three steps so an OTE is always available while a
 * leg is forming: depth-4 pivots, then depth-2 pivots, then the absolute high/low
 * of the last 40 candles.
 *
 * Returned shape:
 *   { timeframeName, isBullishImpulse, levels, currentPrice, statusClass,
 *     statusText, range, tp, sl }
 * where `levels` holds the 0 / 0.618 / 0.705 / 1 retracement prices, tp is the
 * leg origin (levels[0]) and sl is the leg end (levels[1]).
 *
 * Loaded as a classic script (not a module) so `app.js` can call it
 * synchronously; a dynamic import would leave a window where the function is
 * undefined.
 */

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

if (typeof window !== "undefined") {
    window.calculateFibonacciOTE = calculateFibonacciOTE;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { calculateFibonacciOTE };
}
