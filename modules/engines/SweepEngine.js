export class SweepEngine {
    /**
     * Detects liquidity pools and liquidity events (sweeps/breakouts)
     */
    static detect(candles, swings, htfCandles, atr) {
        // 1. Extract HTF Parent Levels
        const pmh = htfCandles["1month"]?.at(-2)?.high || 0;
        const pml = htfCandles["1month"]?.at(-2)?.low || 0;
        const pwh = htfCandles["1week"]?.at(-2)?.high || 0;
        const pwl = htfCandles["1week"]?.at(-2)?.low || 0;
        const pdh = htfCandles["1day"]?.at(-2)?.high || 0;
        const pdl = htfCandles["1day"]?.at(-2)?.low || 0;

        // Calculate session high/low
        let asiaHigh = 0, asiaLow = Infinity;
        let londonHigh = 0, londonLow = Infinity;
        const recentSessionCandles = candles.slice(-200);

        if (recentSessionCandles.length > 0) {
            const latestDate = recentSessionCandles[recentSessionCandles.length - 1].datetime.split(' ')[0];
            recentSessionCandles.forEach(c => {
                if (!c.datetime.startsWith(latestDate)) return;
                const dateObj = new Date(c.datetime.replace(" ", "T") + "Z");
                const nyHour = Number(new Intl.DateTimeFormat("en-US", {
                    hour: "2-digit", hour12: false, timeZone: "America/New_York"
                }).format(dateObj));

                // Asia (Accumulation) 20:00 - 02:00 NY
                if (nyHour >= 20 || nyHour < 2) {
                    if (c.high > asiaHigh) asiaHigh = c.high;
                    if (c.low < asiaLow) asiaLow = c.low;
                }
                // London (Manipulation) 02:00 - 08:00 NY
                if (nyHour >= 2 && nyHour < 8) {
                    if (c.high > londonHigh) londonHigh = c.high;
                    if (c.low < londonLow) londonLow = c.low;
                }
            });
        }

        if (asiaLow === Infinity) asiaLow = 0;
        if (londonLow === Infinity) londonLow = 0;

        const pools = {
            pmh, pml, pwh, pwl, pdh, pdl,
            asiaHigh, asiaLow, londonHigh, londonLow,
            eqh: swings.highs.at(-1)?.price || 0,
            eql: swings.lows.at(-1)?.price || 0
        };

        const events = [];
        // Last 5 CLOSED candles
        const recentCandles = candles.slice(-6, -1);
        
        // Dynamic threshold based on ATR
        const MIN_DEPTH = Math.max(0.10, (atr || 0.5) * 0.10);

        // Inline FVG check helper
        function hasFvg(originalIndex, side) {
            if (originalIndex <= 0 || originalIndex >= candles.length - 1) return false;
            const prevCandle = candles[originalIndex - 1];
            const nextCandle = candles[originalIndex + 1];
            if (side === "bullish") {
                return nextCandle.low > prevCandle.high; // Bullish FVG gap-up
            } else {
                return nextCandle.high < prevCandle.low; // Bearish FVG gap-down
            }
        }

        function evaluateLevel(levelName, levelPrice, type) {
            if (!levelPrice) return;

            const sliceStart = candles.length - 6;

            for (let i = 0; i < recentCandles.length; i++) {
                const c = recentCandles[i];
                const originalIndex = sliceStart + i;
                const isLatest = i === recentCandles.length - 1;
                const bodySize = Math.abs(c.close - c.open);
                const totalRange = c.high - c.low;
                const bodyRatio = totalRange > 0 ? bodySize / totalRange : 0;

                if (type === "bullish") {
                    const wickDepth = c.high - levelPrice;
                    
                    // Single candle sweep
                    if (c.high > levelPrice && c.close < levelPrice && wickDepth > MIN_DEPTH) {
                        events.push({ level: levelName, type: "sweep", side: "bearish_reversal", price: levelPrice, timestamp: c.datetime, isLatest });
                    }
                    // Multi-candle sweep: previous candle closed above, current candle engulfs and closes below
                    else if (i > 0 && recentCandles[i-1].close > levelPrice && c.close < levelPrice && c.high > levelPrice) {
                        events.push({ level: levelName, type: "sweep", side: "bearish_reversal", price: levelPrice, timestamp: c.datetime, isLatest, subtype: "multi-candle" });
                    }
                    // BREAKOUT
                    else if (c.close > levelPrice) {
                        const closeDepth = c.close - levelPrice;
                        if (closeDepth > MIN_DEPTH && bodyRatio >= 0.70) {
                            if (hasFvg(originalIndex, "bullish")) {
                                events.push({ level: levelName, type: "breakout", side: "bullish_continuation", price: levelPrice, timestamp: c.datetime, isLatest });
                            } else {
                                events.push({ level: levelName, type: "pending", side: "weak_close", price: levelPrice, timestamp: c.datetime, isLatest });
                            }
                        } else if (closeDepth > 0) {
                            events.push({ level: levelName, type: "pending", side: "weak_close", price: levelPrice, timestamp: c.datetime, isLatest });
                        }
                    }
                } else {
                    const wickDepth = levelPrice - c.low;

                    // Single candle sweep
                    if (c.low < levelPrice && c.close > levelPrice && wickDepth > MIN_DEPTH) {
                        events.push({ level: levelName, type: "sweep", side: "bullish_reversal", price: levelPrice, timestamp: c.datetime, isLatest });
                    }
                    // Multi-candle sweep: previous candle closed below, current candle engulfs and closes above
                    else if (i > 0 && recentCandles[i-1].close < levelPrice && c.close > levelPrice && c.low < levelPrice) {
                        events.push({ level: levelName, type: "sweep", side: "bullish_reversal", price: levelPrice, timestamp: c.datetime, isLatest, subtype: "multi-candle" });
                    }
                    // BREAKOUT
                    else if (c.close < levelPrice) {
                        const closeDepth = levelPrice - c.close;
                        if (closeDepth > MIN_DEPTH && bodyRatio >= 0.70) {
                            if (hasFvg(originalIndex, "bearish")) {
                                events.push({ level: levelName, type: "breakout", side: "bearish_continuation", price: levelPrice, timestamp: c.datetime, isLatest });
                            } else {
                                events.push({ level: levelName, type: "pending", side: "weak_close", price: levelPrice, timestamp: c.datetime, isLatest });
                            }
                        } else if (closeDepth > 0) {
                            events.push({ level: levelName, type: "pending", side: "weak_close", price: levelPrice, timestamp: c.datetime, isLatest });
                        }
                    }
                }
            }
        }

        evaluateLevel("PMH", pmh, "bullish");
        evaluateLevel("PML", pml, "bearish");
        evaluateLevel("PWH", pwh, "bullish");
        evaluateLevel("PWL", pwl, "bearish");
        evaluateLevel("PDH", pdh, "bullish");
        evaluateLevel("PDL", pdl, "bearish");

        if (candles.length > 0) {
            const lastDateObj = new Date(candles[candles.length - 1].datetime.replace(" ", "T") + "Z");
            const currentNyHour = Number(new Intl.DateTimeFormat("en-US", {
                hour: "2-digit", hour12: false, timeZone: "America/New_York"
            }).format(lastDateObj));

            if (currentNyHour >= 2 && currentNyHour < 20) {
                evaluateLevel("Asia High", asiaHigh, "bullish");
                evaluateLevel("Asia Low", asiaLow, "bearish");
            }
            if (currentNyHour >= 8 || currentNyHour < 2) {
                evaluateLevel("London High", londonHigh, "bullish");
                evaluateLevel("London Low", londonLow, "bearish");
            }
        }

        const uniqueEvents = [];
        const seen = new Set();
        [...events].reverse().forEach(e => {
            const key = `${e.level}-${e.timestamp}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueEvents.push(e);
            }
        });

        const confirmedEvents = uniqueEvents.filter(e => e.type !== "pending");
        const mostSignificant = confirmedEvents.find(e => e.isLatest) || confirmedEvents[0] || null;

        return {
            pools,
            events: uniqueEvents,
            sweep: mostSignificant?.type === "sweep" ? mostSignificant : null,
            breakout: mostSignificant?.type === "breakout" ? mostSignificant : null,
            pdh,
            pdl
        };
    }
}
