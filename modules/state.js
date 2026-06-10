/**
 * Application State Management
 */

import { APP_CONFIG, STORAGE_KEY } from './config.js';
import { isDirectMode } from './utils.js';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      timeframe: parsed.timeframe || APP_CONFIG.defaults.timeframe,
      candles: parsed.candles || APP_CONFIG.defaults.candles,
      temperature: parsed.temperature || APP_CONFIG.defaults.temperature,
      theme: parsed.theme || APP_CONFIG.defaults.theme,
      modelKey: parsed.modelKey || APP_CONFIG.defaults.modelKey,
      marketDataKey: parsed.marketDataKey || APP_CONFIG.defaultMarketDataKey,
      marketDataKeys: parsed.marketDataKeys || [APP_CONFIG.defaultMarketDataKey],
      optionsDataKeys: parsed.optionsDataKeys || ["hYScWrHFM0hBxFWMYZA3lahdpL05Ormb"],
      models: Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed.models : APP_CONFIG.defaultModels,
      debateModels: Array.isArray(parsed.debateModels) && parsed.debateModels.length > 0 ? parsed.debateModels : APP_CONFIG.defaultDebateModels,
      globalNvidiaApiKey: parsed.globalNvidiaApiKey || "",
      globalNvidiaApiKeys: parsed.globalNvidiaApiKeys || [],
      currentEquity: parsed.currentEquity || 50000,
      hwm: parsed.hwm || 50000,
    };
  } catch {
    return {
      timeframe: APP_CONFIG.defaults.timeframe,
      candles: APP_CONFIG.defaults.candles,
      temperature: APP_CONFIG.defaults.temperature,
      theme: APP_CONFIG.defaults.theme,
      modelKey: APP_CONFIG.defaults.modelKey,
      marketDataKey: APP_CONFIG.defaultMarketDataKey,
      marketDataKeys: [APP_CONFIG.defaultMarketDataKey],
      optionsDataKeys: ["hYScWrHFM0hBxFWMYZA3lahdpL05Ormb"],
      models: APP_CONFIG.defaultModels,
      debateModels: APP_CONFIG.defaultDebateModels,
      globalNvidiaApiKey: "",
      globalNvidiaApiKeys: [],
      currentEquity: 50000,
      hwm: 50000,
    };
  }
}

function loadAnalysisHistory() {
  try {
    const raw = localStorage.getItem("xauusd-analyzer-history-v1");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

const persistedSettings = loadSettings();

export const state = {
  selectedTimeframe: persistedSettings.timeframe,
  selectedModelKey: persistedSettings.modelKey,
  theme: persistedSettings.theme,
  marketDataKey: persistedSettings.marketDataKey,
  marketDataKeys: persistedSettings.marketDataKeys,
  optionsDataKeys: persistedSettings.optionsDataKeys,
  optionsDataKey: persistedSettings.optionsDataKeys[0] || "",
  candleCount: persistedSettings.candles,
  temperature: persistedSettings.temperature,
  models: persistedSettings.models,
  debateModels: persistedSettings.debateModels,
  globalNvidiaApiKey: persistedSettings.globalNvidiaApiKey,
  globalNvidiaApiKeys: persistedSettings.globalNvidiaApiKeys,
  editingModelKey: persistedSettings.modelKey,
  editingDebateModelKey: persistedSettings.debateModels?.[0]?.key || "",
  settingsRole: "locked",
  preferServerApi: !isDirectMode(),
  isRunning: false,
  customSelects: {},
  firebaseApp: null,
  firestore: null,
  analysisHistory: loadAnalysisHistory(),
  adminMetrics: {
    loading: false,
    loaded: false,
    error: "",
    data: null,
  },
  currentEquity: persistedSettings.currentEquity,
  hwm: persistedSettings.hwm,
  isSentinelBypassed: false,
  lastAiMeta: {
    debateUsed: false,
    debateAttempted: 0,
    debateSuccessful: 0,
    debateWorking: 0,
  },
  // RMI State
  currentRmi: 100.00,
  previousRmi: 100.00,
  rmiBias: "neutral",
};

export function persistSettings() {
  const data = {
    timeframe: state.selectedTimeframe,
    candles: state.candleCount,
    temperature: state.temperature,
    theme: state.theme,
    modelKey: state.selectedModelKey,
    marketDataKey: state.marketDataKey,
    marketDataKeys: state.marketDataKeys,
    optionsDataKeys: state.optionsDataKeys,
    models: state.models,
    debateModels: state.debateModels,
    globalNvidiaApiKey: state.globalNvidiaApiKey,
    globalNvidiaApiKeys: state.globalNvidiaApiKeys,
    currentEquity: state.currentEquity,
    hwm: state.hwm,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
