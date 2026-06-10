function getSummaryKnowledge() {
  return `
SMC/ICT Core Rules & Liquidity Pools:
- Always reason from liquidity first. Track PDH/PDL, PWH/PWL, PMH/PML, Session Highs/Lows (Asia/London/NY), Equal Highs/Lows (EQH/EQL), and Round Numbers.
- Midnight Line Bias: Compare current price to Midnight Open.
- SMA 50 Bias: Use SMA 50 for trend confluence.
- Gap Rules: Whenever price opens gap up, use Bullish FVG. When price gaps down, use Bearish FVG.
- Sweep Detection (Fakeout): A sweep occurs if price pierces a liquidity level but closes inside, leaving a wick (wick > 50% of body). Treat this as a reversal trigger.
- Fake CHoCH: A CHoCH that fails to hold and reverses within 10 bars is a trap. Penalize setup score.

Order Block (OB) Master Chart:
Bearish (Sell) OB (Rule: Last bullish candle + next bearish candle + FVG below):
1. Fake OB (SMT Trap): Bullish candle floating in air, no SL taken, no FVG below. Action: IGNORE. Highest risk (90-95% fail).
2. Decisional OB: Near CHoCH level after reversal. Action: Medium risk. Wait for M15 confirmation, small targets.
3. Extreme OB (Ultimate Jackpot ⭐⭐⭐⭐⭐): Absolute TOP bullish candle, SL was taken, large FVG below. Action: Sniper Entry at 70.5% OTE. Safest (5-10% fail). Hold for 1:5+.
Bullish (Buy) OB (Rule: Last bearish candle + next bullish candle + FVG above):
1. Fake OB (SMT Trap): Bearish candle floating in air, no SL taken, no FVG above. Action: IGNORE.
2. Decisional OB: Near CHoCH level. Action: Wait for M15 confirmation. Take 1:2 target.
3. Extreme OB (Ultimate Jackpot ⭐⭐⭐⭐⭐): Absolute BOTTOM bearish candle, SL taken, large FVG above. Action: Sniper Entry at 70.5% OTE. Hold for 1:5+.

Fair Value Gap (FVG) Master Chart:
Bearish (Sell) FVG (Rule: Middle candle significantly bearish):
1. Exhaustion FVG (FOMO Trap): Bear-Bear-Bear. Action: IGNORE (Weakest, 60-70% fail).
2. Trade Continuation: Bear-Bear-Bull. Action: Sell Limit at 50% CE. Lock 80% on low break.
3. The Sweep (Delayed Trap): Bull-Bear-Bear. Action: Safe. Sell Limit at 70.5% OTE. Target 1:3.
4. The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐): Bull-Bear-Bull. Action: Most Powerful. Sell Limit at highest 70.5% OTE. Hold to lower H4 OB (1:5+).
Bullish (Buy) FVG (Rule: Middle candle significantly bullish):
1. Exhaustion FVG (FOMO Trap): Bull-Bull-Bull. Action: IGNORE (Weakest).
2. Trade Continuation: Bull-Bull-Bear. Action: Buy Limit at 50% CE. Lock 80% on high break.
3. The Sweep (Delayed Trap): Bear-Bull-Bull. Action: Safe. Buy Limit at 70.5% OTE. Target 1:3.
4. The Holy Grail (Ultimate Jackpot ⭐⭐⭐⭐⭐): Bear-Bull-Bear. Action: Most Powerful. Buy Limit at 70.5% OTE. Hold to upper large OB (1:5+).

Output discipline:
- Describe the institutional narrative (Elephant's Plan).
- Classify identified OBs and FVGs strictly using the 1-4 Master Chart types above.
- If setup is Fake OB or Exhaustion FVG, force Stay Flat or Ignore.
- For Extreme OBs or Holy Grail FVGs, provide precise 70.5% OTE Sniper Entry plans.

Institutional Liquidity Pool Classification (CRT Parent/Child):
- 🔴 EXTREME POINT: Previous Month/Quarter Highs & Lows. Parent: Monthly/Quarterly. Child confirmation: Weekly close.
- 🟠 MID-EXTREME POINT: PDH/PDL (Parent: Daily, Child: 4H close). PWH/PWL (Parent: Weekly, Child: Daily close).
- 🟡 DECISIONAL POINT: Asian Session H/L, London Session H/L. Parent: Session range. Child: 1H close.
- 🟢 INDUCEMENT: Equal Highs/Lows (Child: 15M), Swing Points (Child: 1H/4H), Round Numbers, Trendlines (reactive only).

CRT Event Classification:
- SWEEP (🩸): Child candle wicks beyond the liquidity level but CLOSES back inside. Reversal signal. Smart money stop hunt.
- BREAKOUT (💥): Child candle closes firmly beyond level with body ≥ 70% of range + FVG formed. Continuation signal.
- TAP (⚠️): Wick touch only, no close confirmation. Wait — no signal.
- Signal fires ONLY on confirmed child-candle close. No wick-based false alarms.
- Sweep TP targets opposite-side liquidity. Breakout TP targets next liquidity in breakout direction.
`.trim();
}

function getDebateKnowledge() {
  return `
Debate rules:
- Bullish team argues only the strongest long thesis based on Bullish Master Charts (Extreme OB / Holy Grail FVG) and Sweep Lows.
- Bearish team argues only the strongest short thesis based on Bearish Master Charts and Sweep Highs.
- Red-team challenges both by looking for Fake OBs, Exhaustion FVGs, Fake CHoCH traps, and SMT divergence.
- Use explicit terminology: "Holy Grail FVG", "Extreme OB", "Exhaustion FVG", "Decisional OB", "Fakeout Sweep".
- Be concise and evidence-driven.
- When price interacts with a liquidity pool, classify as SWEEP or BREAKOUT based on child-candle close.
- Sweep = reversal bias, Breakout = continuation bias. Factor this into directional arguments.
- Prioritize Extreme Point events over Inducement events in the debate.
`.trim();
}

module.exports = {
  getSummaryKnowledge,
  getDebateKnowledge,
};
