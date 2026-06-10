export class FVGEngine {
    /**
     * Detects and classifies Fair Value Gaps
     */
    static detect(candles) {
        const fvgs = [];
        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        for (let i = 1; i < candles.length - 1; i++) {
            const prev = candles[i - 1];
            const curr = candles[i];
            const next = candles[i + 1];

            const isGapUp = curr.open > prev.close;
            const isGapDown = curr.open < prev.close;

            // Bullish FVG or Gap Up
            if ((next.low > prev.high && isBull(curr)) || isGapUp) {
                let profile = isGapUp ? "Gap Up FVG" : "Standard";
                if (isBull(prev) && isBull(next)) profile = isGapUp ? "Gap Up (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
                else if (isBull(prev) && isBear(next)) profile = isGapUp ? "Gap Up (Trade Continuation)" : "Trade Continuation";
                else if (isBear(prev) && isBull(next)) profile = isGapUp ? "Gap Up (The Sweep)" : "The Sweep (Delayed Trap)";
                else if (isBear(prev) && isBear(next)) profile = isGapUp ? "Gap Up (Holy Grail)" : "The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐)";

                const price = isGapUp ? (curr.open + prev.close) / 2 : (next.low + prev.high) / 2;
                const high = isGapUp ? curr.open : next.low;
                const low = isGapUp ? prev.close : prev.high;

                if (!fvgs.some(f => f.side === "bullish" && Math.abs(f.price - price) < 0.05)) {
                    fvgs.push({
                        side: "bullish",
                        price,
                        high,
                        low,
                        timestamp: curr.datetime,
                        mitigated: false,
                        profile
                    });
                }
            }
            // Bearish FVG or Gap Down
            else if ((next.high < prev.low && isBear(curr)) || isGapDown) {
                let profile = isGapDown ? "Gap Down FVG" : "Standard";
                if (isBear(prev) && isBear(next)) profile = isGapDown ? "Gap Down (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
                else if (isBear(prev) && isBull(next)) profile = isGapDown ? "Gap Down (Trade Continuation)" : "Trade Continuation";
                else if (isBull(prev) && isBear(next)) profile = isGapDown ? "Gap Down (The Sweep)" : "The Sweep (Delayed Trap)";
                else if (isBull(prev) && isBull(next)) profile = isGapDown ? "Gap Down (Holy Grail)" : "The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐)";

                const price = isGapDown ? (curr.open + prev.close) / 2 : (next.high + prev.low) / 2;
                const high = isGapDown ? prev.close : prev.low;
                const low = isGapDown ? curr.open : next.high;

                if (!fvgs.some(f => f.side === "bearish" && Math.abs(f.price - price) < 0.05)) {
                    fvgs.push({
                        side: "bearish",
                        price,
                        high,
                        low,
                        timestamp: curr.datetime,
                        mitigated: false,
                        profile
                    });
                }
            }
        }
        return fvgs.slice(-10); // Return the 10 most recent FVGs
    }
}
