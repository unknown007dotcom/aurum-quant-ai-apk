/**
 * Institutional Market Analysis Engine (Refactored)
 * Acts as a wrapper for the new specialized engines (SweepEngine, FVGEngine, TrendEngine, MixerEngine).
 */

import { state } from './state.js';
import { RMI } from '../lib/rmi.js';
import { 
    directionOfCandle, capitalize, formatCompactNumber, 
    formatSignedNumber, formatPrice, toIstTimeStr,
    toGmtHour, toGmtMinutes, detectAmdPhase
} from './utils.js';
import { MixerEngine } from './engines/MixerEngine.js';

export function parseTwelveValues(set) {
  if (!set || !set.values) return [];
  return set.values.map(v => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseInt(v.volume || 0)
  })).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

export function analyzeInstitutionalStructure(mtfData, intel, optionsIntel = null) {
  const result = MixerEngine.process(mtfData, intel, optionsIntel, state.selectedTimeframe, state.previousRmi);
  
  // Update state based on Mixer result
  state.previousRmi = state.currentRmi;
  state.currentRmi = result.currentRmi;
  state.rmiBias = result.context.rmi.bias;

  return result.context;
}

export function detectSwings(candles, strength) {
  const highs = [];
  const lows = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
      if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, timestamp: candles[i].datetime });
    if (isLow) lows.push({ index: i, price: candles[i].low, timestamp: candles[i].datetime });
  }
  return { highs, lows };
}

export function buildTradeDecision(analysis) {
    return MixerEngine.buildTradeDecision(analysis);
}
