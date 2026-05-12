'use strict';

/**
 * calculator.js
 * All financial math lives here
 */

// Percent spread between perp and spot
function spread(perpPrice, spotPrice) {
  return (perpPrice - spotPrice) / spotPrice;
}

// Estimated profit over a period
// amount      = total capital deployed (USD)
// fundingRate = 1h rate (decimal)
// tradingFee  = taker/maker fee (decimal, per side)
// spreadVal   = decimal spread (perp - spot) / spot
// leverage    = futures leverage
function profit(amount, fundingRate, tradingFee, spreadVal, leverage) {
  // Capital split: spot gets most, futures uses leverage
  const workingAmount = amount * (leverage / (leverage + 1));
  const tradedAmount  = amount * 2;          // both legs combined

  const fundingIncome = workingAmount * fundingRate;
  const feeCost       = tradedAmount  * tradingFee * 2; // open + close
  const spreadCost    = tradedAmount  * spreadVal;       // entry slippage

  return fundingIncome - feeCost - spreadCost;
}

// Annualized effective return as % of capital
function effectiveRate(profitValue, amount) {
  return (profitValue / amount) * 100;
}

// Hours to annualize
function annualize(hourlyRate) {
  return hourlyRate * 24 * 365;
}

// Mark drawdown % from entry
function drawdownPct(entryPrice, currentPrice) {
  return ((entryPrice - currentPrice) / entryPrice) * 100;
}

module.exports = { spread, profit, effectiveRate, annualize, drawdownPct };
