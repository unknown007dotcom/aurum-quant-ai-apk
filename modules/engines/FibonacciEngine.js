export class FibonacciEngine {
    /**
     * Detects the latest swing leg and calculates Fibonacci retracement.
     */
    static detect(swings, price) {
        if (!swings || !swings.highs.length || !swings.lows.length) {
            return null;
        }

        // Combine and sort swings by index to find the chronological order
        const allSwings = [];
        swings.highs.forEach(s => allSwings.push({ ...s, type: 'high' }));
        swings.lows.forEach(s => allSwings.push({ ...s, type: 'low' }));
        allSwings.sort((a, b) => a.index - b.index);

        if (allSwings.length < 2) return null;

        // Find the last swing point
        const lastSwing = allSwings[allSwings.length - 1];
        
        // Find the preceding swing point of the opposite type
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

        // If it's a bullish impulse, retracement is downwards from the high.
        // Level 0 = high, Level 1 = low.
        // If bearish impulse, retracement is upwards from the low.
        // Level 0 = low, Level 1 = high.

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

        // Check if price is in the entry zone
        let inEntryZone = false;
        if (isBullishImpulse) {
            inEntryZone = price <= levels[0.618] && price >= levels[0.705];
        } else {
            inEntryZone = price >= levels[0.618] && price <= levels[0.705];
        }

        const action = isBullishImpulse ? "Buy" : "Sell";
        
        let displayList = [
            `Direction: ${isBullishImpulse ? 'Bullish' : 'Bearish'} Retracement`,
            `Level 0 (TP): ${levels[0].toFixed(2)}`,
            `Level 0.618 (Entry): ${levels[0.618].toFixed(2)}`,
            `Level 0.705 (Entry): ${levels[0.705].toFixed(2)}`,
            `Level 1 (SL): ${levels[1].toFixed(2)}`,
            `Status: ${inEntryZone ? '🟢 IN ENTRY ZONE' : '⚪ Pending'}`
        ];

        return {
            isBullishImpulse,
            levels,
            inEntryZone,
            action,
            tp: levels[0],
            sl: levels[1],
            displayList
        };
    }
}
