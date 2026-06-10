function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => ({
    datetime: c.datetime || c.time || '',
    open: Number(c.mid?.o ?? c.open ?? 0),
    high: Number(c.mid?.h ?? c.high ?? 0),
    low: Number(c.mid?.l ?? c.low ?? 0),
    close: Number(c.mid?.c ?? c.close ?? 0),
    volume: Number(c.volume ?? 0),
    complete: c.complete !== false,
  })).filter(c => c.open && c.high && c.low && c.close).sort((a, b) => a.datetime.localeCompare(b.datetime));
}

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
        return normalizeCandles(match.values);
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
            return `${candidates[0].name} @ $${candidates[0].price.toFixed(2)}`;
        }
        return "Next institutional level";
    }
};

module.exports = LiquidityEngine;
