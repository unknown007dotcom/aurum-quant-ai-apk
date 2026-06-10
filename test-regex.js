const text = "Risk engine: use approximately 1.50 XAU distance for SL, then stage TP1 2341.00, TP2 2342.50, TP3 2344.00.";
const tpRegex = /(?:TP|Take[\s-]?Profit|Target)\s*(\d)?\s*[:\s]*\$?([\d,]+\.?\d*)/gi;
let m;
const tps = [];
while ((m = tpRegex.exec(text)) !== null) {
  tps.push(m[2]);
}
console.log(tps);
