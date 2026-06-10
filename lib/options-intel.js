const DEFAULT_OPTIONS_SYMBOL = "GLD";
const DEFAULT_OPTIONS_BASES = [
  "https://api.massive.com",
  "https://api.polygon.io",
];
const DEFAULT_PAGE_LIMIT = 250;
const MAX_PAGE_COUNT = 8;

async function resolveOptionsKeys(overrideKey, getAdminSettings) {
  const fromEnv = [
    process.env.MASSIVE_API_KEYS,
    process.env.POLYGON_API_KEYS,
    process.env.OPTIONS_DATA_API_KEYS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((key) => key.trim())
    .filter(Boolean);

  const singularEnv = [
    process.env.MASSIVE_API_KEY,
    process.env.POLYGON_API_KEY,
    process.env.OPTIONS_DATA_API_KEY,
  ]
    .map((key) => String(key || "").trim())
    .filter(Boolean);

  let fromSettings = [];
  if (typeof getAdminSettings === "function") {
    try {
      const settings = await getAdminSettings();
      fromSettings = Array.isArray(settings?.optionsDataKeys) ? settings.optionsDataKeys : [];
    } catch {
      fromSettings = [];
    }
  }

  return uniqueList([overrideKey, ...fromSettings, ...fromEnv, ...singularEnv].map((key) => String(key || "").trim()).filter(Boolean)).slice(0, 12);
}

async function fetchOptionsIntelligenceServer({
  symbol = DEFAULT_OPTIONS_SYMBOL,
  apiKey,
  getAdminSettings,
  fetchImpl = fetch,
}) {
  const keys = await resolveOptionsKeys(apiKey, getAdminSettings);
  if (!keys.length) {
    return {
      available: false,
      maxPainAvailable: false,
      optionsAvailable: false,
      source: "No options key configured",
      notes: ["No Massive/Polygon options API key is configured."],
    };
  }

  let lastError = null;
  const rotatedKeys = rotateList(keys);

  for (const key of rotatedKeys) {
    for (const baseUrl of DEFAULT_OPTIONS_BASES) {
      try {
        const chain = await fetchFullOptionChain({
          baseUrl,
          symbol,
          apiKey: key,
          fetchImpl,
        });

        if (!chain.results.length) {
          lastError = `${baseUrl} returned no option contracts for ${symbol}.`;
          continue;
        }

        return buildOptionsSummary(chain.results, baseUrl, symbol);
      } catch (error) {
        lastError = error?.message || `${baseUrl} request failed.`;
      }
    }
  }

  return {
    available: false,
    maxPainAvailable: false,
    optionsAvailable: false,
    source: "Massive/Polygon unavailable",
    notes: [lastError || "Options data request failed."],
  };
}

async function fetchFullOptionChain({ baseUrl, symbol, apiKey, fetchImpl }) {
  const collected = [];
  let nextUrl = `${baseUrl}/v3/snapshot/options/${encodeURIComponent(symbol)}?limit=${DEFAULT_PAGE_LIMIT}&apiKey=${encodeURIComponent(apiKey)}`;
  let pageCount = 0;

  while (nextUrl && pageCount < MAX_PAGE_COUNT) {
    pageCount += 1;
    const response = await fetchImpl(nextUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detail = payload?.error || payload?.message || `HTTP ${response.status}`;
      throw new Error(`${baseUrl} options snapshot failed: ${detail}`);
    }

    const pageResults = Array.isArray(payload?.results) ? payload.results : [];
    collected.push(...pageResults);

    const rawNextUrl = typeof payload?.next_url === "string" ? payload.next_url.trim() : "";
    if (!rawNextUrl) {
      nextUrl = "";
      continue;
    }

    nextUrl = rawNextUrl.includes("apiKey=")
      ? rawNextUrl
      : `${rawNextUrl}${rawNextUrl.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}`;
  }

  return { results: collected };
}

function buildOptionsSummary(results, baseUrl, symbol) {
  const normalized = results.filter((item) => item && typeof item === "object");
  const maxPain = calculateMaxPain(normalized);
  const pcRatio = calculatePutCallRatio(normalized);
  const greeks = calculateAggregateGreeks(normalized);
  const avgIv = calculateAverageIv(normalized);
  const sourceLabel = `${baseUrl.includes("massive.com") ? "Massive" : "Polygon"} (${symbol} proxy)`;
  const notes = [`Loaded ${normalized.length} contracts from the option-chain snapshot.`];

  if (!Number.isFinite(greeks.delta)) {
    notes.push("Live delta was unavailable in the returned chain; staying neutral for delta-driven bias.");
  }

  return {
    available: true,
    maxPainAvailable: Number.isFinite(maxPain),
    optionsAvailable: true,
    maxPain,
    pcRatio,
    iv: avgIv,
    gvz: Number.isFinite(avgIv) ? avgIv * 100 : Number.NaN,
    delta: Number.isFinite(greeks.delta) ? greeks.delta : 0,
    gamma: greeks.gamma,
    theta: greeks.theta,
    vega: greeks.vega,
    source: sourceLabel,
    notes,
    contractCount: normalized.length,
  };
}

function calculateMaxPain(results) {
  if (!Array.isArray(results) || !results.length) return Number.NaN;
  const strikes = [...new Set(results.map(getStrike).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!strikes.length) return Number.NaN;
  const strikeMap = new Map();

  results.forEach((item) => {
    const strike = getStrike(item);
    if (!Number.isFinite(strike)) return;
    const bucket = strikeMap.get(strike) || { callOi: 0, putOi: 0 };
    const oi = getOpenInterest(item);
    if (getContractType(item) === "put") bucket.putOi += oi;
    else bucket.callOi += oi;
    strikeMap.set(strike, bucket);
  });

  let minPain = Number.POSITIVE_INFINITY;
  let maxPainStrike = strikes[Math.floor(strikes.length / 2)];

  strikes.forEach((testStrike) => {
    let totalPain = 0;
    strikes.forEach((strike) => {
      const bucket = strikeMap.get(strike) || { callOi: 0, putOi: 0 };
      if (testStrike > strike) totalPain += (testStrike - strike) * bucket.callOi;
      else if (testStrike < strike) totalPain += (strike - testStrike) * bucket.putOi;
    });
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testStrike;
    }
  });

  return maxPainStrike;
}

function calculatePutCallRatio(results) {
  if (!Array.isArray(results) || !results.length) return Number.NaN;
  let callOi = 0;
  let putOi = 0;
  results.forEach((item) => {
    const oi = getOpenInterest(item);
    if (getContractType(item) === "put") putOi += oi;
    else callOi += oi;
  });
  return callOi > 0 ? putOi / callOi : Number.NaN;
}

function calculateAverageIv(results) {
  let totalWeight = 0;
  let totalIv = 0;
  results.forEach((item) => {
    const iv = Number(item?.implied_volatility);
    if (!Number.isFinite(iv) || iv <= 0) return;
    const weight = Math.max(getOpenInterest(item), 1);
    totalIv += iv * weight;
    totalWeight += weight;
  });
  return totalWeight > 0 ? totalIv / totalWeight : Number.NaN;
}

function calculateAggregateGreeks(results) {
  const total = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  let totalWeight = 0;
  results.forEach((item) => {
    const greeks = item?.greeks || {};
    const weight = Math.max(getOpenInterest(item), 1);
    const delta = Number(greeks?.delta);
    const gamma = Number(greeks?.gamma);
    const theta = Number(greeks?.theta);
    const vega = Number(greeks?.vega);
    if (!Number.isFinite(delta) && !Number.isFinite(gamma) && !Number.isFinite(theta) && !Number.isFinite(vega)) return;
    if (Number.isFinite(delta)) total.delta += delta * weight;
    if (Number.isFinite(gamma)) total.gamma += gamma * weight;
    if (Number.isFinite(theta)) total.theta += theta * weight;
    if (Number.isFinite(vega)) total.vega += vega * weight;
    totalWeight += weight;
  });
  if (!totalWeight) {
    return { delta: Number.NaN, gamma: Number.NaN, theta: Number.NaN, vega: Number.NaN };
  }
  return {
    delta: total.delta / totalWeight,
    gamma: total.gamma / totalWeight,
    theta: total.theta / totalWeight,
    vega: total.vega / totalWeight,
  };
}

function getStrike(item) {
  return Number(item?.details?.strike_price);
}

function getContractType(item) {
  const type = String(item?.details?.contract_type || item?.contract_type || "").toLowerCase();
  return type === "put" ? "put" : "call";
}

function getOpenInterest(item) {
  const value = Number(item?.open_interest);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function uniqueList(items) {
  return [...new Set(items)];
}

function rotateList(items) {
  if (!Array.isArray(items) || items.length <= 1) return items;
  const startIdx = Math.floor(Math.random() * items.length);
  return items.slice(startIdx).concat(items.slice(0, startIdx));
}

module.exports = {
  DEFAULT_OPTIONS_SYMBOL,
  fetchOptionsIntelligenceServer,
};
