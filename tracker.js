'use strict';

/**
 * tracker.js
 * Tracks open position PnL, drawdown, funding accumulation
 */

const config = require('./config');

// Unrealized PnL from price movement only (delta-neutral)
// Short perp + long spot = profit from funding, lossy if spread widens
function unrealizedPnl(position, currentPerpPrice, currentSpotPrice) {
  const { entryPerpPrice, entrySpotPrice, amount, leverage } = position;

  // Short perp leg PnL (profit when price drops from entry)
  const perpPnl = (entryPerpPrice - currentPerpPrice) / entryPerpPrice * (amount * leverage / (leverage + 1));

  // Long spot leg PnL
  const spotPnl = (currentSpotPrice - entrySpotPrice) / entrySpotPrice * amount;

  return perpPnl + spotPnl;
}

// Drawdown % of position amount based on real mark-to-market price movement
function drawdown(position, currentPerpPrice, currentSpotPrice) {
  const unrealized = unrealizedPnl(position, currentPerpPrice, currentSpotPrice);
  return unrealized < 0 ? (Math.abs(unrealized) / position.amount) * 100 : 0;
}

// Add a funding payment to an open position
// Call this every 8 hours (Binance funding interval)
function addFundingPayment(position, currentFundingRate) {
  const payment = position.amount
                * (position.leverage / (position.leverage + 1))
                * currentFundingRate;
  position.fundingCollected += payment;
  return payment;
}

// Summary stats across all closed trades
function historySummary(history) {
  if (!history.length) return { trades: 0, totalPnl: 0, winRate: 0, avgDuration: 0 };

  const totalPnl   = history.reduce((s, h) => s + h.netPnl, 0);
  const wins       = history.filter(h => h.netPnl > 0).length;
  const avgDuration = history.reduce((s, h) => s + (h.closedAt - h.openedAt), 0) / history.length / 3600000;

  return {
    trades:      history.length,
    totalPnl:    parseFloat(totalPnl.toFixed(2)),
    winRate:     parseFloat(((wins / history.length) * 100).toFixed(1)),
    avgDuration: parseFloat(avgDuration.toFixed(1)),
  };
}

module.exports = { unrealizedPnl, drawdown, addFundingPayment, historySummary };
