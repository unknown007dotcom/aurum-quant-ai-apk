const entry = {
  aiOverlay: "",
  learningOutcome: "pending",
  executionOverview: [
    "Primary bias: Buy.",
    "Prefer entries on retracement into 2340.00-2342.00 if bullish confirmation prints.",
    "Risk engine: use approximately 1.50 XAU distance for SL, then stage TP1 2341.00, TP2 2342.50, TP3 2344.00.",
    "Invalidate longs if price closes back below the nearest bullish order block.",
    "Risk only after structure confirms inside the zone. Do not chase expanded candles."
  ]
};

const overlay = String(entry.aiOverlay || "");
const execStr = Array.isArray(entry.executionOverview) ? entry.executionOverview.join(" ") : String(entry.executionOverview || "");
const combinedText = overlay + " " + execStr;

const result = { direction: "", entryZone: "", invalidation: "", tps: [], outcome: entry.learningOutcome || "pending" };

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
  const backupEntry = /retracement into ([\d.,]+-[\d.,]+)/i.exec(execStr);
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

console.log(result);
