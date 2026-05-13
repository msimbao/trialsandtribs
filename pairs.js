'use strict'; 

/**
 * pairs.js
 * Statistical pairs trading engine
 * Monitors correlated coin relationships
 * Enters when ratio deviates > entry z-score, exits on convergence
 */

const config = require('./config');
const logger = require('./logger');

// ── Price history per coin (rolling 24h of ticks) ────────────────────────────
const priceHistory = {}; // { 'BTC': [{price, ts}, ...], 'ETH': [...] }
const MAX_TICKS    = config.PAIRS_CONFIG.LOOKBACK_TICKS; // ~2880 = 24h at 30s intervals

// ── Ratio history per relationship ───────────────────────────────────────────
const ratioHistory = {}; // { 'BTC-ETH': [{ratio, ts}, ...] }

// ── Latest prices ─────────────────────────────────────────────────────────────
const latestPrice = {};

// ── All monitored coins (flat list) ──────────────────────────────────────────
const monitoredCoins = new Set(
  config.PAIRS_CONFIG.relationships.flatMap(r => r)
);

// ─── Ingest a price tick ──────────────────────────────────────────────────────
function onPrice(pair, price) {
  if (!monitoredCoins.has(pair)) return;

  latestPrice[pair] = price;

  // Store in history
  if (!priceHistory[pair]) priceHistory[pair] = [];
  priceHistory[pair].push({ price, ts: Date.now() });

  // Keep only recent ticks
  if (priceHistory[pair].length > MAX_TICKS) {
    priceHistory[pair].shift();
  }

  // Update ratio history for all relationships involving this pair
  for (const [coinA, coinB] of config.PAIRS_CONFIG.relationships) {
    if (pair !== coinA && pair !== coinB) continue;
    if (!latestPrice[coinA] || !latestPrice[coinB]) continue;

    const key   = `${coinA}-${coinB}`;
    const ratio = latestPrice[coinA] / latestPrice[coinB];

    if (!ratioHistory[key]) ratioHistory[key] = [];
    ratioHistory[key].push({ ratio, ts: Date.now() });
    if (ratioHistory[key].length > MAX_TICKS) ratioHistory[key].shift();
  }
}

// ─── Get z-score for a relationship ──────────────────────────────────────────
function getZScore(coinA, coinB) {
  const key     = `${coinA}-${coinB}`;
  const history = ratioHistory[key];

  if (!history || history.length < config.PAIRS_CONFIG.MIN_HISTORY_TICKS) return null;

  const ratios = history.map(h => h.ratio);
  const mean   = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const variance = ratios.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / ratios.length;
  const std    = Math.sqrt(variance);

  if (std === 0) return null;

  const current = latestPrice[coinA] / latestPrice[coinB];
  return { zScore: (current - mean) / std, mean, std, current, coinA, coinB, key };
}

// ─── Scan all relationships for entry signals ─────────────────────────────────
function scanForOpportunities() {
  const opportunities = [];

  for (const [coinA, coinB] of config.PAIRS_CONFIG.relationships) {
    const z = getZScore(coinA, coinB);
    if (!z) continue;

    const absZ       = Math.abs(z.zScore);
    const divergence = Math.abs(z.current - z.mean) / z.mean;

    // Entry: z-score above threshold AND divergence covers fees
    if (absZ >= config.PAIRS_CONFIG.ENTRY_ZSCORE &&
        divergence >= config.PAIRS_CONFIG.MIN_DIVERGENCE) {

      // Positive z = coinA expensive relative to coinB → short A, long B
      // Negative z = coinA cheap relative to coinB   → long A, short B
      const shortCoin = z.zScore > 0 ? coinA : coinB;
      const longCoin  = z.zScore > 0 ? coinB : coinA;

      opportunities.push({
        key:        z.key,
        coinA,
        coinB,
        shortCoin,
        longCoin,
        zScore:     z.zScore,
        absZ,
        divergence,
        mean:       z.mean,
        std:        z.std,
        currentRatio: z.current,
        priceA:     latestPrice[coinA],
        priceB:     latestPrice[coinB],
      });

      logger.info('PAIRS', `📐 Opportunity: ${shortCoin}↓ / ${longCoin}↑ | z=${z.zScore.toFixed(2)} | div=${(divergence*100).toFixed(3)}%`);
    }
  }

  // Sort by highest abs z-score
  return opportunities.sort((a, b) => b.absZ - a.absZ);
}

// ─── Check exit condition for an open pairs position ─────────────────────────
function checkExit(position) {
  const { coinA, coinB, entryZScore, entryRatio, openedAt } = position;
  const z = getZScore(coinA, coinB);
  if (!z) return null;

  const ageHours   = (Date.now() - openedAt) / 3600000;
  const absZ       = Math.abs(z.zScore);

  // Exit: z-score converged back toward mean
  if (absZ <= config.PAIRS_CONFIG.EXIT_ZSCORE) {
    return { reason: 'CONVERGED', zScore: z.zScore };
  }

  // Stop loss: divergence kept widening
  if (absZ >= config.PAIRS_CONFIG.STOP_ZSCORE) {
    return { reason: 'STOP_LOSS', zScore: z.zScore };
  }

  // Time limit: force exit
  if (ageHours >= config.PAIRS_CONFIG.MAX_HOLD_HOURS) {
    return { reason: 'TIME_LIMIT', zScore: z.zScore };
  }

  // Z-score flipped sign — convergence overshot
  if (Math.sign(z.zScore) !== Math.sign(entryZScore) && absZ > 0.5) {
    return { reason: 'OVERSHOT', zScore: z.zScore };
  }

  return null; // hold
}

// ─── Status snapshot for Discord ─────────────────────────────────────────────
function getStatusSnapshot() {
  const rows = [];

  for (const [coinA, coinB] of config.PAIRS_CONFIG.relationships) {
    const z = getZScore(coinA, coinB);
    const histLen = (ratioHistory[`${coinA}-${coinB}`] || []).length;
    const ready   = histLen >= config.PAIRS_CONFIG.MIN_HISTORY_TICKS;

    rows.push({
      pair:      `${coinA}/${coinB}`,
      zScore:    z ? z.zScore.toFixed(2)          : 'warming',
      diverge:   z ? ((Math.abs(z.current - z.mean)/z.mean)*100).toFixed(3)+'%' : '-',
      signal:    !ready         ? '⏳ warming up'
               : !z             ? '⏳ no data'
               : Math.abs(z.zScore) >= config.PAIRS_CONFIG.ENTRY_ZSCORE ? '🔥 ENTRY SIGNAL'
               : Math.abs(z.zScore) >= 1.0 ? '👀 watch'
               : '😴 quiet',
      ticks:     histLen,
    });
  }

  return rows;
}

// ─── Unrealized PnL for a pairs position ─────────────────────────────────────
function unrealizedPnl(position) {
  const { shortCoin, longCoin, entryShortPrice, entryLongPrice, amount } = position;
  const currentShort = latestPrice[shortCoin];
  const currentLong  = latestPrice[longCoin];
  if (!currentShort || !currentLong) return 0;

  const halfAmount   = amount / 2;
  const shortPnl     = (entryShortPrice - currentShort) / entryShortPrice * halfAmount;
  const longPnl      = (currentLong - entryLongPrice)   / entryLongPrice  * halfAmount;
  return shortPnl + longPnl;
}

module.exports = { onPrice, scanForOpportunities, checkExit, getStatusSnapshot, unrealizedPnl, latestPrice, monitoredCoins };
