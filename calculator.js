'use strict';

/**
 * calculator.js
 * Financial math for pairs trading
 */

// Total fee cost for opening + closing a pairs position (both legs, taker)
function roundTripFee(amount, takerFee) {
  // Two legs (short + long), each opened and closed = 4 fills
  return amount * 2 * takerFee * 2;
}

// Expected net PnL given price convergence back to mean
// divergence = (currentRatio - mean) / mean  (decimal)
// amount     = total capital (split equally across legs)
function expectedPnl(divergence, amount, takerFee) {
  const grossProfit = divergence * (amount / 2);
  return grossProfit - roundTripFee(amount, takerFee);
}

module.exports = { roundTripFee, expectedPnl };
