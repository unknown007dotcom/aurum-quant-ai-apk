export const STORAGE_KEY = "xauusd-analyzer-settings-v1";
export const HISTORY_STORAGE_KEY = "xauusd-analyzer-history-v1";
export const DEVICE_ID_KEY = "xauusd-device-id-v1";
export const MAX_TWELVE_CANDLES = 5000;
export const TRADE_AUTO_CLOSE_MS = 30 * 60 * 1000;

export const APP_CONFIG = {
  marketDataPath: "/api/market-data",
  marketMtfPath: "/api/market-mtf",
  aiChatPath: "/api/ai-decision",
  intelPath: "/api/intel",
  nvidiaModelsPath: "/api/settings?action=fetch-nvidia",
  historyLogPath: "/api/history-log",
  adminMetricsPath: "/api/settings?action=metrics",
  optionsIntelPath: "/api/options-intel",
  siteSettingsPath: "/api/site-settings",
  defaultMarketDataKey: "23c57edf48e541e48db2806575f58bf7",
  symbolCandidates: ["XAU/USD", "XAUUSD"],
  defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
  firebase: {
    apiKey: "AIzaSyD0Qmd81qBnCelAJR1sK-z5yudHmMFqWXk",
    authDomain: "aurum-quant-ai.firebaseapp.com",
    projectId: "aurum-quant-ai",
    storageBucket: "aurum-quant-ai.firebasestorage.app",
    messagingSenderId: "18778138823",
    appId: "1:18778138823:web:9fbc1551a41d493663f6e2",
    measurementId: "G-CH4Z0ZVLGX",
  },
  defaultDebateModels: [
    {
      key: "llama-405b-debate",
      id: "meta/llama-3.1-405b-instruct",
      label: "Llama 3.1 405B (Debater)",
      apiKey: "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",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      bias: "both",
      isDebateParticipant: true,
    },
    {
      key: "nemotron-70b-debate",
      id: "nvidia/llama-3.1-nemotron-70b-instruct",
      label: "Nemotron 70B (Arbiter)",
      apiKey: "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",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      bias: "both",
      isDebateParticipant: true,
    }
  ],
  defaultModels: [
    {
      key: "gpt-oss-default",
      id: "openai/gpt-oss-120b",
      label: "Main Summary Model",
      apiKey: "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",
      baseUrl: "https://integrate.api.nvidia.com/v1",
    },
  ],
  defaults: {
    timeframe: "15min",
    candles: 180,
    temperature: 0.2,
    theme: "dark",
    modelKey: "gpt-oss-default",
  },
};

export const SETTINGS_PASSWORD = "Aviraj@api7";
export const BASIC_SETTINGS_PASSWORD = "XAUUSD";
