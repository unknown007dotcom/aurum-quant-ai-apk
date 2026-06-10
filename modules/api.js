/**
 * API Service for Market Data and AI Decisions
 */

import { APP_CONFIG } from './config.js';
import { state } from './state.js';
import { fetchWithTimeout, isDirectMode } from './utils.js';

export async function fetchInstitutionalMtfData(interval, outputsize) {
  if (isDirectMode() || !state.preferServerApi) {
    return fetchInstitutionalMtfDataDirect(interval, outputsize);
  }

  const keys = Array.isArray(state.marketDataKeys) && state.marketDataKeys.length > 0
    ? state.marketDataKeys
    : [state.marketDataKey].filter(Boolean);

  if (keys.length === 0) throw new Error("No Market Data API keys configured.");

  // Proactive Rotation
  state.marketKeyIndex = ((state.marketKeyIndex || 0) + 1) % keys.length;
  const key = keys[state.marketKeyIndex];

  try {
    const url = `${APP_CONFIG.marketMtfPath}?symbol=XAU/USD&entryTf=${interval}&outputsize=${outputsize}&apikey=${key}`;
    const response = await fetchWithTimeout(url, {}, 25000);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `MTF Data Stream Failed (${response.status})`);
    }
    return await response.json();
  } catch (error) {
    console.warn("[MTF] Server API failed, falling back to direct mode:", error.message);
    if (error.message.includes("429") || error.message.includes("credits")) {
       throw error; 
    }
    state.preferServerApi = false;
    return fetchInstitutionalMtfDataDirect(interval, outputsize);
  }
}

async function fetchInstitutionalMtfDataDirect(interval, outputsize) {
  const [entryCandles, h1Candles, d1Candles, w1Candles, m1Candles] = await Promise.all([
    fetchMarketDataDirect(interval, outputsize),
    fetchMarketDataDirect("1h", outputsize),
    fetchMarketDataDirect("1day", outputsize),
    fetchMarketDataDirect("1week", outputsize),
    fetchMarketDataDirect("1month", outputsize)
  ]);

  return {
    status: "ok",
    data: [
      { id: "entry", values: entryCandles },
      { id: "h1", values: h1Candles },
      { id: "1day", values: d1Candles },
      { id: "1week", values: w1Candles },
      { id: "1month", values: m1Candles }
    ]
  };
}

export async function fetchMarketDataDirect(interval, outputsize, symbol = "XAU/USD") {
  const key = state.marketDataKey;
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${key}`;
  const response = await fetchWithTimeout(url, {}, 15000);
  const data = await response.json();
  if (!response.ok || data.status === "error") {
    throw new Error(data.message || `Market data fetch failed for ${symbol}`);
  }
  return data.values.map(v => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseInt(v.volume || 0)
  })).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

export async function fetchInstitutionalIntel() {
  const response = await fetch(APP_CONFIG.intelPath);
  return response.ok ? await response.json() : { rules: {}, news: [] };
}

export async function fetchOptionsIntelligence() {
  const key = state.optionsDataKey;
  if (!key) return null;
  const url = `${APP_CONFIG.optionsIntelPath}?apikey=${key}`;
  const response = await fetch(url);
  return response.ok ? await response.json() : null;
}

export async function requestAiDecision(analysis) {
  const model = getSelectedModel();
  const payload = {
    analysis,
    model: {
      id: model.id,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      temperature: state.temperature,
    },
    debateModels: state.debateModels.map(m => ({
      id: m.id,
      apiKey: m.apiKey,
      baseUrl: m.baseUrl,
      isDebateParticipant: m.isDebateParticipant,
      bias: m.bias
    }))
  };

  const response = await fetch(APP_CONFIG.aiChatPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || "AI Decision Hub failed.");
  }

  return await response.json();
}

function getSelectedModel() {
  return state.models.find(m => m.key === state.selectedModelKey) || state.models[0];
}
