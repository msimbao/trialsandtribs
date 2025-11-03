  //Config
  module.exports = {
   FORWARD_TEST : true, // true = paper trading, false = backtest
   SYMBOL : 'NEARUSDT',
   INTERVAL : '1h',
   INITIAL_CAPITAL : 800,
   LEVERAGE : 1,
   STRATEGY_MODE : 'adaptive', // adaptive, momentum, mean_reversion, pullback, bear_market
   USE_REGIME_PARAMS : true,
   START_DATE : '2025-01-01',
   END_DATE : '2025-10-20',
   UPDATE_INTERVAL_SECONDS : 60,
  }