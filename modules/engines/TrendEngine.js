export class TrendEngine {
    /**
     * Calculates exponential moving average
     */
    static exponentialMovingAverage(values, period) {
        const k = 2 / (period + 1);
        let ema = [values[0]];
        for (let i = 1; i < values.length; i++) {
            ema.push(values[i] * k + ema[i - 1] * (1 - k));
        }
        return ema;
    }

    /**
     * Determines the overall trend and HTF alignment
     */
    static detect(candles, htfCandles) {
        if (!candles || candles.length < 50) {
            return { trend: "neutral", sma21: null, sma50: null, htfAlignment: { bias: "neutral", score: 0 } };
        }

        const latestClose = candles[candles.length - 1].close;
        const closes = candles.map((candle) => candle.close);
        const ema21 = this.exponentialMovingAverage(closes, 21);
        const ema50 = this.exponentialMovingAverage(closes, 50);

        const ema21Val = ema21.at(-1);
        const ema50Val = ema50.at(-1);

        let computedTrend = "neutral";
        if (ema21Val >= ema50Val) {
            computedTrend = latestClose >= ema50Val ? "bullish" : "bearish";
        } else {
            computedTrend = latestClose <= ema50Val ? "bearish" : "bullish";
        }

        // Evaluate HTF (Higher Timeframe) alignment
        let htfBias = "neutral";
        let htfScore = 0;
        
        const h1Candles = htfCandles["1h"] || [];
        const d1Candles = htfCandles["1day"] || [];

        if (d1Candles.length >= 2) {
            const d1Prev = d1Candles[d1Candles.length - 2];
            const d1Curr = d1Candles[d1Candles.length - 1];
            if (d1Curr.close > d1Prev.high) { htfBias = "bullish"; htfScore++; }
            else if (d1Curr.close < d1Prev.low) { htfBias = "bearish"; htfScore++; }
        }

        if (h1Candles.length >= 2) {
            const h1Prev = h1Candles[h1Candles.length - 2];
            const h1Curr = h1Candles[h1Candles.length - 1];
            if (h1Curr.close > h1Prev.high && htfBias !== "bearish") { htfBias = "bullish"; htfScore++; }
            else if (h1Curr.close < h1Prev.low && htfBias !== "bullish") { htfBias = "bearish"; htfScore++; }
        }

        return {
            trend: computedTrend,
            sma21: ema21Val,
            sma50: ema50Val,
            htfAlignment: {
                bias: htfBias,
                score: htfScore
            }
        };
    }
}
