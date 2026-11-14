/**
 * Trade-level parsing for history entries.
 *
 * The history detail panel derives direction / entry zone / invalidation / take
 * profit levels from whatever the AI wrote in `aiOverlay` plus the rule engine's
 * `executionOverview` lines. That text is free-form, so this module is a
 * deliberately defensive scraper — it must never invent a price.
 *
 * Shared by the browser (history.js imports it as an ES module) and by the Node
 * test suite (CommonJS require via the default export interop shim below).
 *
 * Known shapes it handles:
 *   "TP1 2341.00, TP2 2342.50, TP3 2344.00"
 *   "Take Profit 1: 2,341.00" / "Take-Profit: 2350.00"
 *   "TP1 = 2341.00"                        (equals sign, was parsed as "1")
 *   "Target 2350 at a 1.5% gain"           (was parsed as "350", level 2)
 *   "Targets: 2345 / 2350 / 2355"          (list after a label)
 *   "Targets: 2345, 2350 and 2355"
 */

// Prices in XAUUSD are 3-4 significant digits with up to 2 decimals.
const MIN_PRICE = 1;
const MAX_TP_LEVELS = 3;

const TP_KEYWORD = /(?:tp|take[\s-]?profit|target)s?/i;
// A TP number is only a *level* when it is not glued to the price digits:
// "TP1 2341.00" -> level 1, price 2341.00 but "Target 2350" -> no level (the
// old lazy pattern stole "23" as the level and left "50" as the price).
const LABEL = /(?:tp|take[\s-]?profit|target)s?(?:\s*(?:#|no\.?)?\s*(\d{1,2})(?![\d.,]))?\s*(?:[:=]|is\b|at\b|-|\u2192)?\s*/i;

function toPrice(raw) {
  const price = parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(price) || price < MIN_PRICE) return null;
  return price;
}

/**
 * Pull every "label [+ optional level] [+ separator] price" match out of text.
 * Returns [{ level, price }] in document order, levels resolved afterwards.
 */
function collectLabeledLevels(text) {
  const found = [];
  const re = new RegExp(
    LABEL.source + "\\$?([\\d][\\d,]*(?:\\.\\d+)?)",
    "gi",
  );
  let match;
  while ((match = re.exec(String(text))) !== null) {
    const level = match[1] ? parseInt(match[1], 10) : null;
    const price = toPrice(match[2]);
    if (price !== null) {
      found.push({ level, price, index: match.index });
    }
  }
  return found;
}

/**
 * Split separator-style lists that follow a TP/Target label, e.g.
 * "Targets: 2345 / 2350 / 2355" or "Target 2345, 2350 and 2355".
 */
function collectListedLevels(text) {
  const found = [];
  const labelRe = /(?:tp|take[\s-]?profit|target)s?\s*(?::|=)?\s*/gi;
  let label;
  while ((label = labelRe.exec(String(text))) !== null) {
    const tail = String(text).slice(label.index + label[0].length);
    // Only numbers joined by / , "and" or "&" belong to the list.
    const listMatch = /^\$?[\d][\d,]*(?:\.\d+)?(?:\s*(?:\/|,|&|\band\b|\+)\s*\$?[\d][\d,]*(?:\.\d+)?)+/.exec(tail);
    if (!listMatch) continue;
    for (const part of listMatch[0].split(/\s*(?:\/|,|&|\band\b|\+)\s*/)) {
      const price = toPrice(part.replace(/^\$/, ""));
      if (price !== null) found.push({ level: null, price, index: label.index });
    }
  }
  return found;
}

/**
 * Percentage figures ("1.5% gain", "0.8 % move") are context, not prices.
 */
function stripPercentages(text) {
  return String(text)
    .replace(/[\d.,]+\s*%/g, " ")
    .replace(/\bpercent(?:age)?\b/gi, " ");
}

function dedupeByPrice(levels, entryPrice) {
  const seen = new Set();
  const out = [];
  for (const level of levels) {
    if (entryPrice !== null && Math.abs(level.price - entryPrice) < 1e-9) continue;
    const key = level.price.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(level);
  }
  return out;
}

/**
 * Assign TP levels: an explicit label level wins (first occurrence only, so a
 * repeated "TP1" is demoted to the next free level); unlabeled levels are
 * numbered in document order, skipping levels already claimed.
 */
function assignLevels(levels) {
  const claimed = new Set();
  const pending = [];
  const resolved = levels.map((level) => {
    if (level.level !== null && !claimed.has(level.level)) {
      claimed.add(level.level);
      return { level: level.level, price: level.price };
    }
    pending.push({ level: null, price: level.price });
    return null;
  });

  let next = 1;
  for (let i = 0; i < resolved.length; i += 1) {
    if (resolved[i] !== null) continue;
    while (claimed.has(next)) next += 1;
    claimed.add(next);
    resolved[i] = { level: next, price: levels[i].price };
  }
  return resolved;
}

/**
 * @param {string} overlay      AI narrative text
 * @param {string[]|string} executionOverview  rule-engine lines
 * @param {{entryZone?: string|number}} [options]
 * @returns {{level: number, price: number}[]}
 */
export function parseTakeProfits(overlay, executionOverview, options = {}) {
  const execStr = Array.isArray(executionOverview)
    ? executionOverview.join(" ")
    : String(executionOverview || "");
  const combined = stripPercentages(`${overlay || ""} ${execStr}`);
  const entryPrice = toPrice(options.entryZone ?? "") ?? null;

  const labeled = collectLabeledLevels(combined);
  const listed = collectListedLevels(combined);

  // Prefer explicit labels; add list items that do not duplicate a labeled price.
  const labeledPrices = new Set(labeled.map((item) => item.price.toFixed(2)));
  const merged = [
    ...labeled,
    ...listed.filter((item) => !labeledPrices.has(item.price.toFixed(2))),
  ].sort((a, b) => a.index - b.index);

  const unique = dedupeByPrice(merged, entryPrice);
  if (unique.length === 0) return [];
  return assignLevels(unique).sort((a, b) => a.level - b.level).slice(0, MAX_TP_LEVELS);
}

export default parseTakeProfits;
