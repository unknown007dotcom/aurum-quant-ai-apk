const safeToFixed = (val, dec = 2) => { const n = Number(val); return Number.isFinite(n) ? n.toFixed(dec) : "0.00"; };
const HISTORY_STORAGE_KEY = "xauusd-analyzer-history-v1";
const EDGE_API_BASE = (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))
    ? (window.location.port === "3000" ? "/api" : "http://127.0.0.1:8787")
    : "https://aurum-quant-edge.aurum-quant-ai.workers.dev";
const HISTORY_API_PATH = "/history-log";

const dom = {
  historyEntries: document.querySelector("#historyEntries"),
  historyDetailTitle: document.querySelector("#historyDetailTitle"),
  historyDetailTime: document.querySelector("#historyDetailTime"),
  historyDetailTimeframe: document.querySelector("#historyDetailTimeframe"),
  historyDetailPrice: document.querySelector("#historyDetailPrice"),
  historySummary: document.querySelector("#historySummary"),
  historyExecution: document.querySelector("#historyExecution"),
  historyTradeLevels: document.querySelector("#historyTradeLevels"),
  historyAiOverlay: document.querySelector("#historyAiOverlay"),
  historyAutoEval: document.querySelector("#historyAutoEval"),
  historyEmptyState: document.querySelector("#historyEmptyState"),
  historyDetail: document.querySelector("#historyDetail"),
  deleteHistoryButton: document.querySelector("#deleteHistoryButton"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  exportHistoryButton: document.querySelector("#exportHistoryButton"),
};

const state = {
  history: loadHistory(),
  selectedId: null,
};

initialize();

function initialize() {
  dom.deleteHistoryButton.addEventListener("click", deleteSelectedHistory);
  dom.clearHistoryButton.addEventListener("click", clearAllHistory);
  dom.exportHistoryButton.addEventListener("click", exportHistoryData);
  window.addEventListener("resize", handleViewportChange);
  renderHistoryEntries();

  if (state.history.length > 0) {
    selectHistoryEntry(state.history[0].id);
  }

  refreshHistoryFromBackend().catch(() => {});
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistHistory() {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.history));
}

function exportHistoryData() {
  if (!Array.isArray(state.history) || state.history.length === 0) {
    return;
  }

  const payload = state.history.map((entry) => {
    const levels = parseTradeLevels(entry);
    return {
      id: entry.id || "",
      syncId: entry.syncId || "",
      title: entry.title || "",
      timestampIso: entry.timestampIso || "",
      timeframe: entry.timeframe || "",
      price: entry.price || "",
      outcome: getEntryOutcome(entry),
      failureReason: getEntryOutcomeReason(entry),
      autoEvalStatus: entry.autoEvalStatus || "",
      summary: Array.isArray(entry.summary) ? entry.summary : [],
      executionOverview: Array.isArray(entry.executionOverview) ? entry.executionOverview : [],
      tradeLevels: {
        direction: levels.direction || "",
        entryZone: levels.entryZone || "",
        invalidation: levels.invalidation || "",
        tps: Array.isArray(levels.tps) ? levels.tps : [],
      },
      aiOverlay: String(entry.aiOverlay || ""),
      deviceId: entry.deviceId || "",
      deviceLabel: entry.deviceLabel || "",
    };
  });

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `aurum-quant-history-export-${formatExportStamp()}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatExportStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function getEntryOutcome(entry) {
  const localOutcome = String(entry?.learningOutcome || "").toLowerCase();
  if (localOutcome === "win" || localOutcome === "loss") {
    return localOutcome;
  }
  const autoEval = String(entry?.autoEvalStatus || "").toLowerCase();
  if (autoEval === "win-tp-hit") return "win";
  if (autoEval === "loss-sl-hit") return "loss";
  return "pending";
}

function getEntryOutcomeReason(entry) {
  return String(entry?.learningReason || entry?.autoEvalNote || "").trim();
}

function mergeHistoryEntries(localEntries, remoteEntries) {
  const merged = [];
  const seen = new Set();
  const localList = Array.isArray(localEntries) ? localEntries : [];
  const remoteList = Array.isArray(remoteEntries) ? remoteEntries : [];
  const remoteMap = new Map();

  remoteList.forEach((entry) => {
    const syncId = String(entry?.syncId || "").trim();
    const id = String(entry?.id || "").trim();
    if (syncId) remoteMap.set(syncId, entry);
    if (id) remoteMap.set(id, entry);
  });

  localList.forEach((entry) => {
    const syncId = String(entry?.syncId || "").trim();
    const id = String(entry?.id || "").trim();
    const remote = remoteMap.get(syncId) || remoteMap.get(id);
    const next = remote ? { ...entry, ...remote } : entry;
    const token = String(next?.syncId || next?.id || `${next?.timestampIso || ""}-${next?.title || ""}`);
    if (!seen.has(token)) {
      seen.add(token);
      merged.push(next);
    }
  });

  remoteList.forEach((entry) => {
    const token = String(entry?.syncId || entry?.id || `${entry?.timestampIso || ""}-${entry?.title || ""}`);
    if (!seen.has(token)) {
      seen.add(token);
      merged.push(entry);
    }
  });

  return merged
    .sort((left, right) => {
      const leftTs = Date.parse(String(left?.timestampIso || "")) || Number(left?.createdAt || left?.id || 0);
      const rightTs = Date.parse(String(right?.timestampIso || "")) || Number(right?.createdAt || right?.id || 0);
      return rightTs - leftTs;
    })
    .slice(0, 100);
}

async function refreshHistoryFromBackend() {
  try {
    const response = await fetch(`${EDGE_API_BASE}${HISTORY_API_PATH}?limit=100`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload?.entries)) {
      return;
    }
    state.history = mergeHistoryEntries(state.history, payload.entries);
    persistHistory();
    renderHistoryEntries();
    if (state.selectedId) {
      selectHistoryEntry(state.selectedId);
    } else if (state.history.length > 0) {
      selectHistoryEntry(state.history[0].id);
    }
  } catch {
    // Ignore sync failures and keep local history usable.
  }
}

function renderHistoryEntries() {
  if (!state.history.length) {
    dom.historyEntries.innerHTML = `
      <div class="history-entry-empty">
        <strong>No saved analysis yet.</strong>
        <p>Run a scan from the main page and it will appear here.</p>
      </div>
    `;
    dom.clearHistoryButton.disabled = true;
    renderNoSelection();
    return;
  }

  dom.clearHistoryButton.disabled = false;
  dom.historyEntries.innerHTML = state.history.map((entry) => {
    const levels = parseTradeLevels(entry);
    const dirBadge = levels.direction ? `<span class="badge ${levels.direction === 'Buy' ? 'badge-buy' : 'badge-sell'}">${levels.direction}</span>` : '';
    const outcome = getEntryOutcome(entry);
    const outcomeBadge = outcome === "pending"
      ? '<span class="badge badge-pending">PENDING</span>'
      : `<span class="badge ${outcome === 'win' ? 'badge-win' : 'badge-loss'}">${outcome.toUpperCase()}</span>`;
    return `
    <article class="history-entry-shell${entry.id === state.selectedId ? " active" : ""}">
      <button
        type="button"
        class="history-entry-card${entry.id === state.selectedId ? " active" : ""}"
        data-history-id="${escapeHtml(entry.id)}"
      >
        <span class="history-entry-time">${escapeHtml(entry.title || "Untitled Analysis")}</span>
        <span class="history-entry-meta">${escapeHtml(`${entry.timeframe || "--"} | Price ${entry.price || "--"}`)} ${dirBadge} ${outcomeBadge}</span>
      </button>
      ${renderInlineDetail(entry)}
    </article>
  `;
  }).join("");

  dom.historyEntries.querySelectorAll("[data-history-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectHistoryEntry(button.getAttribute("data-history-id"));
    });
  });

  dom.historyEntries.querySelectorAll("[data-delete-history-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteHistoryById(button.getAttribute("data-delete-history-id"));
    });
  });
}

function selectHistoryEntry(entryId) {
  const entry = state.history.find((item) => item.id === entryId);
  if (!entry) {
    renderNoSelection();
    return;
  }

  state.selectedId = entry.id;
  renderHistoryEntries();

  if (isMobileViewport()) {
    renderNoSelection();
    const selectedCard = dom.historyEntries.querySelector(`[data-history-id="${escapeSelector(entry.id)}"]`);
    selectedCard?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }

  dom.historyEmptyState.hidden = true;
  dom.historyDetail.hidden = false;
  dom.deleteHistoryButton.disabled = false;
  dom.historyDetailTitle.textContent = entry.title || "Saved Analysis";
  dom.historyDetailTime.textContent = entry.title || "--";
  dom.historyDetailTimeframe.textContent = entry.timeframe || "--";
  dom.historyDetailPrice.textContent = `Price ${entry.price || "--"}`;
  dom.historySummary.innerHTML = renderParagraphBlock(entry.summary);
  dom.historyExecution.innerHTML = renderParagraphBlock(entry.executionOverview);
  dom.historyTradeLevels.innerHTML = renderTradeLevelsHtml(entry);
  dom.historyAiOverlay.textContent = String(entry.aiOverlay || "No AI overlay stored.");

  const outcome = getEntryOutcome(entry);
  if (outcome !== "pending") {
    const outcomeClass = outcome === "win" ? "badge-win" : "badge-loss";
    dom.historyAutoEval.innerHTML = `<p><span class="badge ${outcomeClass}">${outcome.toUpperCase()}</span> ${escapeHtml(getEntryOutcomeReason(entry) || "Evaluated by AI.")}</p>`;
  } else {
    dom.historyAutoEval.innerHTML = '<p class="muted">AI will automatically evaluate this trade as the market moves.</p>';
  }
}

function renderParagraphBlock(lines) {
  const safeLines = Array.isArray(lines) ? lines : [];
  if (!safeLines.length) {
    return "<p>No data stored.</p>";
  }

  return safeLines.map((line) => `<p>${escapeHtml(String(line))}</p>`).join("");
}

function deleteSelectedHistory() {
  if (!state.selectedId) {
    return;
  }

  state.history = state.history.filter((entry) => entry.id !== state.selectedId);
  persistHistory();
  state.selectedId = state.history[0]?.id || null;
  renderHistoryEntries();

  if (state.selectedId) {
    selectHistoryEntry(state.selectedId);
    return;
  }

  renderNoSelection();
}

function deleteHistoryById(entryId) {
  state.selectedId = entryId;
  deleteSelectedHistory();
}

function clearAllHistory() {
  state.history = [];
  state.selectedId = null;
  persistHistory();
  renderHistoryEntries();
  renderNoSelection();
}

// Manual feedback removed in favor of auto-eval

function extractDirection(aiOverlay) {
  const text = String(aiOverlay || "");
  const match = /Direction:\s*([^\n]+)/i.exec(text);
  return match ? match[1].trim() : "";
}

function renderNoSelection() {
  dom.historyDetailTitle.textContent = "Choose a saved timestamp";
  dom.historyEmptyState.hidden = isMobileViewport();
  dom.historyDetail.hidden = true;
  dom.deleteHistoryButton.disabled = true;
}

function renderInlineDetail(entry) {
  if (!isMobileViewport() || entry.id !== state.selectedId) {
    return "";
  }

  return `
    <div class="history-inline-detail">
      <div class="history-detail-meta">
        <span class="badge muted">${escapeHtml(entry.title || "--")}</span>
        <span class="badge muted">${escapeHtml(entry.timeframe || "--")}</span>
        <span class="badge muted">${escapeHtml(`Price ${entry.price || "--"}`)}</span>
      </div>
      <article class="history-card">
        <p class="panel-kicker">Summary</p>
        <div class="history-copy">${renderParagraphBlock(entry.summary)}</div>
      </article>
      <article class="history-card">
        <p class="panel-kicker">Execution Overview</p>
        <div class="history-copy">${renderParagraphBlock(entry.executionOverview)}</div>
      </article>
      <article class="history-card">
        <p class="panel-kicker">Trade Levels</p>
        <div class="history-copy">${renderTradeLevelsHtml(entry)}</div>
      </article>
      <article class="history-card">
        <p class="panel-kicker">Auto Evaluation</p>
        <div class="history-copy">${getEntryOutcome(entry) !== "pending" ? `<p><span class="badge ${getEntryOutcome(entry) === "win" ? "badge-win" : "badge-loss"}">${escapeHtml(getEntryOutcome(entry).toUpperCase())}</span> ${escapeHtml(getEntryOutcomeReason(entry) || "Evaluated by AI.")}</p>` : '<p class="muted">Pending. The app will re-check this trade on future scans.</p>'}</div>
      </article>
      <article class="history-card">
        <p class="panel-kicker">AI Overlay</p>
        <pre class="ai-output history-ai-output">${escapeHtml(String(entry.aiOverlay || "No AI overlay stored."))}</pre>
      </article>
      <button type="button" class="ghost-button history-inline-delete" data-delete-history-id="${escapeHtml(entry.id)}">Delete</button>
    </div>
  `;
}

function handleViewportChange() {
  renderHistoryEntries();
  if (!state.selectedId) {
    renderNoSelection();
    return;
  }

  if (isMobileViewport()) {
    renderNoSelection();
    return;
  }

  selectHistoryEntry(state.selectedId);
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function escapeSelector(value) {
  return String(value).replace(/"/g, '\\"');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseTradeLevels(entry) {
  if (entry?.tradeLevels && typeof entry.tradeLevels === "object") {
    const stored = entry.tradeLevels;
    return {
      direction: String(stored.direction || ""),
      entryZone: String(stored.entryZone || ""),
      invalidation: String(stored.invalidation || ""),
      tps: Array.isArray(stored.tps) ? stored.tps.map((item) => ({ level: Number(item.level || 0), price: Number(item.price || 0) })).filter((item) => Number.isFinite(item.price)) : [],
      outcome: getEntryOutcome(entry),
    };
  }
  const overlay = String(entry.aiOverlay || "");
  const execStr = Array.isArray(entry.executionOverview) ? entry.executionOverview.join(" ") : String(entry.executionOverview || "");
  const combinedText = overlay + " " + execStr;
  
  const result = { direction: "", entryZone: "", invalidation: "", tps: [], outcome: getEntryOutcome(entry) };

  // Parse direction
  const dirMatch = /Direction[:\s]*([^\n]+)/i.exec(overlay);
  if (dirMatch) {
    const d = dirMatch[1].trim();
    result.direction = /buy|bull|long/i.test(d) ? "Buy" : /sell|bear|short/i.test(d) ? "Sell" : d;
  }
  if (!result.direction) {
    const backupDirMatch = /bias is (Buy|Sell)/i.exec(execStr) || /Primary bias: (Buy|Sell)/i.exec(execStr);
    if (backupDirMatch) result.direction = backupDirMatch[1];
  }

  // Parse Entry Zone
  const entryMatch = /Entry Zone[:\s]*([^\n]+)/i.exec(overlay);
  if (entryMatch) result.entryZone = entryMatch[1].trim();
  if (!result.entryZone) {
    const backupEntry = /retracement into ([\d.,]+(?:\s*-\s*[\d.,]+)?)/i.exec(execStr);
    if (backupEntry) result.entryZone = backupEntry[1];
  }

  // Parse Invalidation / SL
  const slMatch = /Invalidation[:\s]*([^\n]+)/i.exec(overlay);
  if (slMatch) result.invalidation = slMatch[1].trim();
  if (!result.invalidation) {
    const backupSl = /Invalidate (?:longs|shorts) if price closes back (?:below|above) (.*)/i.exec(execStr);
    if (backupSl) result.invalidation = backupSl[1].replace(".", "");
  }

  // Extract TP levels from combined text
  const tpRegex = /(?:TP|Take[\s-]?Profit|Target)\s*(\d)?\s*[:\s]*\$?([\d,]+\.?\d*)/gi;
  let m;
  while ((m = tpRegex.exec(combinedText)) !== null) {
    const level = m[1] ? parseInt(m[1]) : result.tps.length + 1;
    const price = parseFloat(m[2].replace(/,/g, ""));
    if (price > 0 && price !== parseFloat(result.entryZone)) result.tps.push({ level, price });
  }

  // Deduplicate and sort
  const seen = new Set();
  result.tps = result.tps.filter(t => {
    const key = safeToFixed(t.price, 2);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.level - b.level).slice(0, 3);

  return result;
}

function renderTradeLevelsHtml(entry) {
  const levels = parseTradeLevels(entry);
  const price = entry.price || "--";
  const autoEvalStatus = String(entry?.autoEvalStatus || "").toLowerCase();

  const dirClass = levels.direction === "Buy" ? "badge-buy" : levels.direction === "Sell" ? "badge-sell" : "";
  const outcomeClass = levels.outcome === "win" ? "badge-win" : levels.outcome === "loss" ? "badge-loss" : "badge-pending";

  let html = '<div class="trade-levels-grid">';

  // Direction & Price
  html += `<div class="trade-level-row"><span class="trade-level-label">Direction</span><span class="badge ${dirClass}">${escapeHtml(levels.direction || "N/A")}</span></div>`;
  html += `<div class="trade-level-row"><span class="trade-level-label">Market Price</span><span>${escapeHtml(String(price))}</span></div>`;

  // Entry Zone
  if (levels.entryZone) {
    html += `<div class="trade-level-row"><span class="trade-level-label">Entry Zone</span><span>${escapeHtml(levels.entryZone.slice(0, 80))}</span></div>`;
  }

  // TP Levels
  if (levels.tps.length > 0) {
    levels.tps.forEach((tp, i) => {
      html += `<div class="trade-level-row"><span class="trade-level-label">TP${tp.level || i + 1}</span><span class="trade-level-tp">$${safeToFixed(tp.price, 2)}</span></div>`;
    });
    const resolvedHits = autoEvalStatus === "win-tp-hit"
      ? Math.min(levels.tps.length >= 2 ? 2 : 1, levels.tps.length)
      : 0;
    const tpHitMarkup = autoEvalStatus === "win-time-expired" || autoEvalStatus === "loss-time-expired"
      ? `<span class="badge ${levels.outcome === "win" ? "badge-win" : "badge-loss"}">Timed Close</span>`
      : levels.outcome === "win"
        ? `<span class="badge badge-win">${resolvedHits} of ${levels.tps.length}</span>`
        : levels.outcome === "loss"
          ? `<span class="badge badge-loss">0 of ${levels.tps.length}</span>`
          : '<span class="badge badge-pending">Pending</span>';
    html += `<div class="trade-level-row"><span class="trade-level-label">TPs Hit</span><span>${tpHitMarkup}</span></div>`;
  } else {
    html += `<div class="trade-level-row"><span class="trade-level-label">TP Levels</span><span class="muted">Not detected</span></div>`;
  }

  // Invalidation / SL
  if (levels.invalidation) {
    html += `<div class="trade-level-row"><span class="trade-level-label">SL (Invalidation)</span><span class="trade-level-sl">${escapeHtml(levels.invalidation.slice(0, 80))}</span></div>`;
    html += `<div class="trade-level-row"><span class="trade-level-label">SL Hit</span><span>${levels.outcome === "loss" ? '<span class="badge badge-loss">YES</span>' : '<span class="badge badge-win">NO</span>'}</span></div>`;
  }

  // Outcome
  html += `<div class="trade-level-row"><span class="trade-level-label">Outcome</span><span class="badge ${outcomeClass}">${escapeHtml(levels.outcome.toUpperCase())}</span></div>`;
  if (autoEvalStatus === "win-time-expired" || autoEvalStatus === "loss-time-expired") {
    html += `<div class="trade-level-row"><span class="trade-level-label">Exit Mode</span><span class="badge muted">30m Auto Close</span></div>`;
  }

  html += '</div>';
  return html;
}
