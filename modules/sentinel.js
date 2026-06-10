/**
 * Sentinel Safety Engine
 */

export const Sentinel = {
    evaluateSafety(state, history) {
        const dd = this.calculateDrawdown(state);
        const streak = this.calculateLosingStreak(history);
        
        let isSafe = true;
        let blockReason = "";

        if (dd > 5) {
            isSafe = false;
            blockReason = "Daily Drawdown > 5%";
        } else if (streak >= 3) {
            isSafe = false;
            blockReason = "Losing Streak Limit (3)";
        }

        return {
            isSafe,
            blockReason,
            dd: dd.toFixed(2),
            streak,
            time: new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' })
        };
    },

    calculateDrawdown(state) {
        const equity = state.currentEquity || 50000;
        const hwm = state.hwm || 50000;
        if (hwm === 0) return 0;
        return ((hwm - equity) / hwm) * 100;
    },

    calculateLosingStreak(history) {
        if (!history || !Array.isArray(history) || history.length === 0) return 0;
        let streak = 0;
        for (let i = 0; i < history.length; i++) {
            const outcome = String(history[i].outcome || history[i].learningOutcome || "").toLowerCase();
            if (outcome === "loss" || outcome === "sl") {
                streak++;
            } else if (outcome === "win" || outcome === "tp") {
                break;
            }
        }
        return streak;
    }
};
