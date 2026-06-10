/**
 * Relative Market Index (RMI) Utility
 * Ported from Institutional Bloomberg patterns.
 */

export const RMI = {
    /**
     * Calculate RMI: (current_price / 30_ema) * 100
     * Measures short-term overbought/oversold relative momentum dynamically.
     * @param {Array} securityCandles - Current asset candles
     * @param {Array} benchmarkCandles - Fallback/Unused benchmark candles
     * @returns {number} Current RMI value (Base 100)
     */
    calculate(securityCandles, benchmarkCandles) {
        if (!securityCandles || securityCandles.length < 30) {
            return 100.00;
        }
        const closes = securityCandles.map(c => c.close);
        const period = 30;
        const k = 2 / (period + 1);
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) {
            ema = closes[i] * k + ema * (1 - k);
        }
        const rmi = (closes.at(-1) / ema) * 100;
        return parseFloat(rmi.toFixed(2));
    },

    /**
     * Determine RMI Trend Bias relative to overbought/oversold baseline (100)
     * @param {number} currentRmi 
     * @param {number} previousRmi 
     * @returns {string} bullish | bearish | neutral
     */
    getBias(currentRmi, previousRmi) {
        if (currentRmi > 100.05) return "bullish";
        if (currentRmi < 99.95) return "bearish";
        return "neutral";
    }
};
