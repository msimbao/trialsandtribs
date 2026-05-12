'use strict';

/**
 * sourcer.js
 * Pulls market data from Binance via native https (no fetch, no axios)
 */

const https  = require('https');
const config = require('./config');
const logger = require('./logger');

// ─── Generic HTTPS GET ────────────────────────────────────────────────────────
function get(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message} | body: ${raw.slice(0,200)}`));
        }
      });
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ─── Perp price from Binance Futures ─────────────────────────────────────────
async function getPerpPrice(pair) {
  try {
    const symbol = `${pair}USDT`;
    const data   = await get(config.BINANCE_REST_FUTURES, `/fapi/v1/ticker/price?symbol=${symbol}`);
    if (!data || !data.price) return null;
    return { price: parseFloat(data.price), symbol };
  } catch (err) {
    logger.error('SOURCER', `getPerpPrice ${pair}: ${err.message}`);
    return null;
  }
}

// ─── Spot price from Binance Spot ────────────────────────────────────────────
async function getSpotPrice(pair) {
  try {
    const symbol = `${pair}USDT`;
    const data   = await get(config.BINANCE_REST_SPOT, `/api/v3/ticker/price?symbol=${symbol}`);
    if (!data || !data.price) return null;
    return { price: parseFloat(data.price), symbol };
  } catch (err) {
    logger.error('SOURCER', `getSpotPrice ${pair}: ${err.message}`);
    return null;
  }
}

// ─── Current funding rate ────────────────────────────────────────────────────
async function getCurrentFundingRate(pair) {
  try {
    const symbol = `${pair}USDT`;
    const data   = await get(config.BINANCE_REST_FUTURES, `/fapi/v1/premiumIndex?symbol=${symbol}`);
    if (!data || data.lastFundingRate === undefined) return null;
    return parseFloat(data.lastFundingRate);
  } catch (err) {
    logger.error('SOURCER', `getCurrentFundingRate ${pair}: ${err.message}`);
    return null;
  }
}

// ─── Rolling N-day average funding rate ──────────────────────────────────────
// Binance provides 8h funding intervals → 3 per day → days * 3 entries
async function getRollingFundingRate(pair, days = 7) {
  try {
    const symbol = `${pair}USDT`;
    const limit  = Math.min(days * 3, 1000);
    const data   = await get(
      config.BINANCE_REST_FUTURES,
      `/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit}`
    );

    if (!Array.isArray(data) || data.length === 0) return null;

    // Require at least 3 days of data — skip brand new coins
    const minRequired = 3 * 3; // 3 days × 3 payments/day
    if (data.length < minRequired) {
      logger.warn('SOURCER', `${pair} has only ${data.length} funding history entries — skipping (too new)`);
      return null;
    }

    const sum = data.reduce((acc, d) => acc + parseFloat(d.fundingRate), 0);
    return (sum / data.length) / 8;
  } catch (err) {
    logger.error('SOURCER', `getRollingFundingRate ${pair}: ${err.message}`);
    return null;
  }
}

// ─── Order book depth (top 5 bids/asks) ──────────────────────────────────────
async function getOrderBook(pair, type = 'futures') {
  try {
    const symbol   = `${pair}USDT`;
    const hostname = type === 'futures' ? config.BINANCE_REST_FUTURES : config.BINANCE_REST_SPOT;
    const path     = type === 'futures'
      ? `/fapi/v1/depth?symbol=${symbol}&limit=5`
      : `/api/v3/depth?symbol=${symbol}&limit=5`;

    const data = await get(hostname, path);
    if (!data || !data.bids) return null;

    return {
      bestBid: parseFloat(data.bids[0][0]),
      bestAsk: parseFloat(data.asks[0][0]),
      bidDepth: data.bids.reduce((s, b) => s + parseFloat(b[1]) * parseFloat(b[0]), 0),
      askDepth: data.asks.reduce((s, a) => s + parseFloat(a[1]) * parseFloat(a[0]), 0),
    };
  } catch (err) {
    logger.error('SOURCER', `getOrderBook ${pair}: ${err.message}`);
    return null;
  }
}

// ─── Fetch ALL perp pairs from Binance and filter by funding rate ─────────────
async function getAllFundingRates() {
  try {
    const data = await get(config.BINANCE_REST_FUTURES, '/fapi/v1/premiumIndex');
    if (!Array.isArray(data)) return [];

    return data
      .filter(d => d.symbol.endsWith('USDT') && d.lastFundingRate !== undefined)
      .map(d => ({
        pair:        d.symbol.replace('USDT', ''),
        fundingRate: parseFloat(d.lastFundingRate),
        annualized:  parseFloat(d.lastFundingRate) * 3 * 365 * 100,
      }))
      .filter(d => d.annualized > config.MIN_FUNDING_RATE_PCT)
      .sort((a, b) => b.annualized - a.annualized);
  } catch (err) {
    logger.error('SOURCER', `getAllFundingRates: ${err.message}`);
    return [];
  }
}

module.exports = { getPerpPrice, getSpotPrice, getCurrentFundingRate, getRollingFundingRate, getOrderBook, getAllFundingRates };
