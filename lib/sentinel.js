/**
 * Sentinel Safety Module
 * Responsible for Apex Prop-Firm Compliance, Killzones, and Risk Gating.
 */

const SENTINEL_CONFIG = {
    MAX_TRAILING_DD_PCT: 5.0,      // Apex 5% Trailing Drawdown from HWM
    WARN_TRAILING_DD_PCT: 3.5,     // Warning threshold
    HALT_TRAILING_DD_PCT: 4.5,     // Hard halt before account blow
    MAX_FAILURE_STREAK: 3,         // Max consecutive losses before cooling off
    TRADING_HOURS: {
        BLOCK_NEW_TRADES: "16:30", // ET (New York)
        FORCE_CLOSE_ALL: "16:55",  // ET (New York)
        START_TRADING: "08:00",    // ET (New York)
    }
};

export const Sentinel = {
    /**
     * Main evaluation function
     */
    evaluateSafety(state, history) {
        const results = {
            isSafe: true,
            blocks: [],
            warnings: [],
            data: {}
        };

        // 1. Check Market Hours (Killzones)
        const timeCheck = this.checkMarketHours();
        if (!timeCheck.isSafe) {
            results.isSafe = false;
            results.blocks.push(timeCheck.reason);
        }
        results.data.marketTime = timeCheck.currentTime;

        // 2. Check Apex Compliance (Drawdown)
        const ddCheck = this.checkApexCompliance(state.currentEquity, state.hwm);
        if (ddCheck.level === 'HALT') {
            results.isSafe = false;
            results.blocks.push(ddCheck.reason);
        } else if (ddCheck.level === 'WARN') {
            results.warnings.push(ddCheck.reason);
        }
        results.data.drawdown = ddCheck.pct;

        // 3. Check Failure Streak
        const streakCheck = this.checkFailureStreak(history);
        if (!streakCheck.isSafe) {
            results.isSafe = false;
            results.blocks.push(streakCheck.reason);
        }
        results.data.failureStreak = streakCheck.count;

        return results;
    },

    /**
     * Verifies if current time is within safe trading windows
     */
    checkMarketHours() {
        // Get ET time
        const etTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
        const now = new Date(etTime);
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

        if (timeStr >= SENTINEL_CONFIG.TRADING_HOURS.BLOCK_NEW_TRADES) {
            return { isSafe: false, reason: `Late Session: Market close approaching (${timeStr} ET)`, currentTime: timeStr };
        }

        if (timeStr < SENTINEL_CONFIG.TRADING_HOURS.START_TRADING) {
            return { isSafe: false, reason: `Pre-Market: Waiting for liquidity (${timeStr} ET)`, currentTime: timeStr };
        }

        return { isSafe: true, currentTime: timeStr };
    },

    /**
     * Checks Trailing Drawdown from High-Water Mark (Apex Rules)
     */
    checkApexCompliance(equity, hwm) {
        if (!equity || !hwm) return { level: 'OK', pct: 0 };

        const ddAmount = hwm - equity;
        const ddPct = (ddAmount / hwm) * 100;

        if (ddPct >= SENTINEL_CONFIG.HALT_TRAILING_DD_PCT) {
            return { level: 'HALT', pct: ddPct, reason: `Critical DD: ${ddPct.toFixed(2)}% (Apex Limit near)` };
        }

        if (ddPct >= SENTINEL_CONFIG.WARN_TRAILING_DD_PCT) {
            return { level: 'WARN', pct: ddPct, reason: `Drawdown Warning: ${ddPct.toFixed(2)}%` };
        }

        return { level: 'OK', pct: ddPct };
    },

    /**
     * Detects if recent signals have been consistently failing
     */
    checkFailureStreak(history) {
        if (!history || !Array.isArray(history) || history.length === 0) {
            return { isSafe: true, count: 0 };
        }

        let streak = 0;
        for (const entry of history) {
            const outcome = String(entry.learningOutcome || entry.outcome || "").toLowerCase();
            
            // Only count resolved losses
            if (outcome === 'loss' || outcome === 'sl') {
                streak++;
            } else if (outcome === 'win' || outcome === 'tp') {
                break; // Streak broken by a win
            }
        }

        if (streak >= SENTINEL_CONFIG.MAX_FAILURE_STREAK) {
            return { isSafe: false, count: streak, reason: `Institutional Cooling: ${streak} consecutive losses detected.` };
        }

        return { isSafe: true, count: streak };
    }
};
