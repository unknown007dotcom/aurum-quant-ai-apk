const safeToFixed = (val, dec = 2) => { const n = Number(val); return Number.isFinite(n) ? n.toFixed(dec) : "0.00"; };
/**
 * UI Rendering Service
 */

import { dom } from './dom.js';
import { state } from './state.js';
import { capitalize, formatPrice, timeframeLabel, escapeHtml } from './utils.js';

export const UI = {
    updateRmi(rmiData) {
        if (!dom.rmiValue || !dom.rmiTrend) return;
        
        dom.rmiValue.textContent = safeToFixed(rmiData.value, 2);
        dom.rmiTrend.textContent = capitalize(rmiData.bias);
        
        dom.rmiValue.className = rmiData.bias;
        dom.rmiTrend.className = rmiData.bias;
    },

    renderEmptyState() {
        this.fillList(dom.tradePlanList, ["Run the first scan to build a trade plan."]);
        this.fillList(dom.fvgList, ["No data yet."]);
        this.fillList(dom.obList, ["No data yet."]);
        this.fillList(dom.structureList, ["No data yet."]);
        this.fillList(dom.reversalList, ["No data yet."]);
        this.fillList(dom.liquidityList, ["No data yet."]);
        this.fillList(dom.scenarioList, ["No data yet."]);
        this.fillList(dom.sessionList, ["No data yet."]);
        this.fillList(dom.htfList, ["No data yet."]);
        
        dom.summaryCards.innerHTML = [
            this.summaryCard("Trend", "Pending"),
            this.summaryCard("Midnight Line", "Pending"),
            this.summaryCard("PD Zone", "--"),
            this.summaryCard("HTF Score", "--"),
        ].join("");
    },

    clearLists() {
        this.fillList(dom.tradePlanList, ["Building rule-engine plan..."]);
        this.fillList(dom.fvgList, ["Scanning fair value gaps..."]);
        this.fillList(dom.obList, ["Scanning order blocks..."]);
        this.fillList(dom.structureList, ["Reading structure..."]);
        this.fillList(dom.reversalList, ["Locating reversal zones..."]);
        this.fillList(dom.liquidityList, ["Mapping liquidity pools..."]);
        this.fillList(dom.scenarioList, ["Evaluating scenarios..."]);
        this.fillList(dom.sessionList, ["Checking session context..."]);
        this.fillList(dom.htfList, ["Pulling higher timeframe bias..."]);
    },

    fillList(element, items) {
        if (!element) return;
        element.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    },

    summaryCard(label, value) {
        return `<article class="summary-card"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong></article>`;
    },

    updateSentinelUI(safety) {
        if (!dom.sentinelBadge) return;
        dom.sentinelBadge.textContent = safety.isSafe ? "Active" : "BLOCKED";
        dom.sentinelBadge.className = `badge ${safety.isSafe ? 'active' : 'danger'}`;
        dom.sentinelMessage.textContent = safety.isSafe ? "Safety protocols clear." : safety.blockReason;
        dom.sentinelTime.textContent = `${safety.time} ET`;
        dom.sentinelDD.textContent = `DD: ${safety.dd}%`;
        dom.sentinelStreak.textContent = `Streak: ${safety.streak}`;
    },

    renderAnalysis(analysis) {
        // Implementation of full SMC dashboard update
        this.fillList(dom.fvgList, analysis.fvgs.map(g => `${g.side.toUpperCase()} ${g.profile} @ ${formatPrice(g.price)}`));
        this.fillList(dom.obList, analysis.orderBlocks.map(o => `${o.side.toUpperCase()} ${o.kind} @ ${formatPrice(o.low)}`));
        this.fillList(dom.tradePlanList, analysis.decision.tradePlan);
        
        dom.decisionLabel.textContent = analysis.decision.action;
        dom.confidenceLabel.textContent = `${analysis.decision.confidence}%`;
        dom.riskLabel.textContent = analysis.decision.riskMode;
        dom.priceLabel.textContent = formatPrice(analysis.price);
    },

    renderAiOutput(analysis) {
        if (!dom.aiOutput) return;
        dom.aiOutput.textContent = analysis.aiContent;
        dom.aiBadge.textContent = "Complete";
        dom.aiBadge.className = "badge active";
    },

    renderScorecard(analysis) {
        if (!dom.scorecardContent) return;
        const { signals } = analysis.decision;
        dom.scorecardContent.innerHTML = `
            <div class="score-card">
                <p>TDS Score</p>
                <strong>${signals.totalTds}/10</strong>
            </div>
            <div class="score-card">
                <p>Confluence</p>
                <strong>${signals.confluencePoints}/15</strong>
            </div>
        `;
    }
};
