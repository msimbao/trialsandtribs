'use strict';

/**
 * tracker.js
 * PnL tracking for pairs positions
 */

const pairs = require('./pairs');

// Unrealized PnL for an open pairs position using latest prices
function unrealizedPnl(position) {
  const { shortCoin, longCoin, entryShortPrice, entryLongPrice, amount } = position;
  const currentShort = pairs.latestPrice[shortCoin];
  const currentLong  = pairs.latestPrice[longCoin];
  if (!currentShort || !currentLong) return 0;

  const half     = amount / 2;
  const shortPnl = (entryShortPrice - currentShort) / entryShortPrice * half;
  const longPnl  = (currentLong     - entryLongPrice)  / entryLongPrice  * half;
  return shortPnl + longPnl;
}

// Summary stats across all closed trades
function historySummary(history) {
  if (!history.length) return { trades: 0, totalPnl: 0, winRate: 0, avgDurationH: 0 };

  const totalPnl      = history.reduce((s, h) => s + h.netPnl, 0);
  const wins          = history.filter(h => h.netPnl > 0).length;
  const avgDurationH  = history.reduce((s, h) => s + (h.closedAt - h.openedAt), 0) / history.length / 3600000;

  return {
    trades:       history.length,
    totalPnl:     parseFloat(totalPnl.toFixed(2)),
    winRate:      parseFloat(((wins / history.length) * 100).toFixed(1)),
    avgDurationH: parseFloat(avgDurationH.toFixed(1)),
  };
}

module.exports = { unrealizedPnl, historySummary };
