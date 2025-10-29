const TradingBacktest = require('../core/engine');
const BinanceFetcher = require('../core/binanceFetcher');
const Stats = require('../utils/stats');

async function compareStrategies(symbol, interval, start, end, capital, lev) {
  console.log('\n' + '='.repeat(70));
  console.log('STRATEGY COMPARISON WITH DYNAMIC PROFIT PROTECTION 🛡️');
  console.log('='.repeat(70));

  const fetcher = new BinanceFetcher();
  const data = await fetcher.downloadHistoricalData(symbol, interval, start, end);
  const bt = new TradingBacktest(capital, lev);
  const strategies = ['mean_reversion', 'momentum', 'pullback', 'bear_market', 'adaptive'];
  const results = [];

  for (const strat of strategies) {
    console.log(`\nBacktesting ${strat}...`);
    const { trades, equityCurve, signals } = bt.backtest(data, strat, true);
    const m = Stats.calcMetrics(trades, equityCurve, data);
    results.push({
      Strategy: strat,
      'Return %': (m.totalReturn * 100).toFixed(2),
      Trades: m.totalTrades,
      'Win Rate %': (m.winRate * 100).toFixed(1),
      protectedCapital: m.profitProtectionRate,
      Sharpe: m.sharpeRatio.toFixed(2),
      'Max DD %': (m.maxDrawdown * 100).toFixed(2),
      Liquidations: m.liquidations
    });
  }

  results.sort((a, b) => parseFloat(b['Return %']) - parseFloat(a['Return %']));
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS (Sorted by Return)');
  console.log('='.repeat(70));
  console.table(results);

  console.log('\n' + '='.repeat(70));
  console.log('STRATEGY RECOMMENDATIONS');
  console.log('='.repeat(70));
  console.log('✓ ADAPTIVE: Auto-switches based on regime (best for set-and-forget)');
  console.log('✓ MEAN_REVERSION: Buys oversold/sells overbought (best for ranging markets)');
  console.log('✓ MOMENTUM: Trades breakouts (best for strong bull trends)');
  console.log('✓ PULLBACK: Buys dips in uptrends (best for bull with corrections)');
  console.log('✓ BEAR_MARKET: Aggressive shorts (best for confirmed bear markets)');
  console.log('='.repeat(70));

  return results;
}

module.exports = compareStrategies;
