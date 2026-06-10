const fs = require('fs'); 
const content = fs.readFileSync('app.js', 'utf8'); 
const start = content.indexOf('const LiquidityEngine = {'); 
const end = content.indexOf('// --- Liquidity Notification System ---'); 
let engineStr = content.substring(start, end).trim(); 
const normalizeCandlesStr = `function normalizeCandles(raw) {
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
}`; 
engineStr = engineStr.replace('AnalysisEngine.normalizeCandles(match.values)', 'normalizeCandles(match.values)'); 
fs.writeFileSync('lib/liquidity-engine.js', normalizeCandlesStr + '\n\n' + engineStr + '\n\nmodule.exports = LiquidityEngine;\n');
