/**
 * Utility functions for Aurum Quant AI
 */

import { APP_CONFIG, MAX_TWELVE_CANDLES } from './config.js';

export function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatPrice(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

export function formatCompactNumber(value, decimals = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(decimals) : "--";
}

export function formatSignedNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return numeric > 0 ? `+${numeric}` : `${numeric}`;
}

export function sanitizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

export function normalizePassword(pass) {
  return String(pass || "").trim();
}

export async function fetchWithTimeout(resource, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function timeframeLabel(value) {
  const map = {
    "1min": "1M",
    "15min": "15M",
    "1h": "1H",
    "4h": "4H",
    "1day": "1D",
  };
  return map[value] || value;
}

export function tradingViewInterval(value) {
  const map = {
    "1min": "1",
    "15min": "15",
    "1h": "60",
    "4h": "240",
    "1day": "D",
  };
  return map[value] || "15";
}

export function toIstTimeStr(date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(date);
}

export function directionOfCandle(candle) {
  if (candle.close > candle.open) return "bullish";
  if (candle.close < candle.open) return "bearish";
  return "neutral";
}

export function isDirectMode() {
  return window.location.protocol === "file:";
}

export function setStatus(message) {
  const statusText = document.querySelector("#statusText");
  if (statusText) statusText.textContent = message;
}

export function toGmtMinutes(datetime) {
  const date = new Date(datetime.replace(" ", "T") + "Z");
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export function toGmtHour(datetime) {
  return Math.floor(toGmtMinutes(datetime) / 60);
}

export function detectAmdPhase(datetime) {
  if (!datetime) return "Unknown";
  const date = new Date(datetime.replace(" ", "T") + "Z");
  const nyHour = Number(new Intl.DateTimeFormat("en-US", {
      hour: "2-digit", hour12: false, timeZone: "America/New_York"
  }).format(date));

  if (nyHour >= 20 || nyHour < 2) return "Accumulation";
  if (nyHour >= 2 && nyHour < 8) return "Manipulation";
  if (nyHour >= 8 && nyHour < 12) return "Distribution";
  return "Rebalancing";
}

export function formatError(error) {
  return [
    "AI or market scan failed.",
    "",
    `Message: ${error.message}`,
    "",
    isDirectMode()
      ? "Direct mode tip: cross-origin requests might be blocked."
      : "Check API keys and model configuration in Settings.",
  ].join("\n");
}

export function toIstTimeStr(date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(date);
}
