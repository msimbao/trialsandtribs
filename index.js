const fs = require('fs').promises;
const Stats = require('./utils/stats');
const BinanceFetcher = require('./core/binanceFetcher');
const TradingBacktest = require('./core/engine');
const compareStrategies = require('./utils/compareStrats');
const config = require('./config.js');

// ============= MAIN EXECUTION =============

// Compare all strategies on historical data

async function main() {
  // ========== CONFIG ==========
  const FORWARD_TEST = config.FORWARD_TEST; // true = paper trading, false = backtest
  const SYMBOL = config.SYMBOL;
  const INTERVAL = config.INTERVAL;
  const INITIAL_CAPITAL = config.INITIAL_CAPITAL;
  const LEVERAGE = config.LEVERAGE;
  const STRATEGY_MODE = config.STRATEGY_MODE; // adaptive, momentum, mean_reversion, pullback, bear_market
  const USE_REGIME_PARAMS = config.USE_REGIME_PARAMS;
  const START_DATE = config.START_DATE;
  const END_DATE = config.END_DATE;
  const UPDATE_INTERVAL_SECONDS = config.UPDATE_INTERVAL_SECONDS;

  // ========== EXECUTION ==========
  if (FORWARD_TEST) {
    console.log('\n🚀 PAPER TRADING MODE - No real money at risk\n');
    const bt = new TradingBacktest(INITIAL_CAPITAL, LEVERAGE);
    await bt.forwardTest(SYMBOL, INTERVAL, STRATEGY_MODE, USE_REGIME_PARAMS, UPDATE_INTERVAL_SECONDS);
  } else {
    console.log('='.repeat(70));
    console.log('CRYPTO SCALPING BACKTEST WITH DYNAMIC PROFIT PROTECTION 🛡️');
    console.log('='.repeat(70));

    console.log('\nStep 1: Comparing strategies...');
    const comp = await compareStrategies(SYMBOL, INTERVAL, START_DATE, END_DATE, INITIAL_CAPITAL, LEVERAGE);

    console.log('\n\nStep 2: Detailed backtest on chosen strategy...');
    console.log(`Strategy: ${STRATEGY_MODE} | Leverage: ${LEVERAGE}x | Adaptive: ${USE_REGIME_PARAMS}`);

    const fetcher = new BinanceFetcher();
    const data = await fetcher.downloadHistoricalData(SYMBOL, INTERVAL, START_DATE, END_DATE);
    const bt = new TradingBacktest(INITIAL_CAPITAL, LEVERAGE);
    const { trades, equityCurve, signals, regimeLog } = bt.backtest(data, STRATEGY_MODE, USE_REGIME_PARAMS);
    const m = Stats.calcMetrics(trades, equityCurve, data, INITIAL_CAPITAL);
  
    // ===================================================
    // DETAILED REGIME RESULTS
    {
    console.log('\n' + '='.repeat(70));
    console.log('DETAILED RESULTS');
    console.log('='.repeat(70));
    console.log(`Initial: ${INITIAL_CAPITAL.toLocaleString()} | Final: ${m.finalCapital.toFixed(2)}`);
    console.log(`Return: ${(m.totalReturn * 100).toFixed(2)}% | Buy&Hold: ${(m.buyHoldReturn * 100).toFixed(2)}%`);
    console.log(`Outperformance: ${(m.outperformance * 100).toFixed(2)}%`);
    console.log(`\nTrades: ${m.totalTrades} | Wins: ${m.winningTrades} | Losses: ${m.losingTrades} | Liq: ${m.liquidations}`);
    console.log(`Win Rate: ${(m.winRate * 100).toFixed(2)}% | Profit Factor: ${m.profitFactor.toFixed(2)}`);
    console.log(`protectedCapital Exits: ${m.profitprotectedCapitalExits} (${m.profitProtectionRate}) | Avg Max Profit: ${m.avgMaxProfitATR} ATR`);
    console.log(`\nAvg Win: ${m.avgWin.toFixed(2)} | Avg Loss: ${m.avgLoss.toFixed(2)}`);
    console.log(`Max DD: ${(m.maxDrawdown * 100).toFixed(2)}% | Sharpe: ${m.sharpeRatio.toFixed(2)}`);
    console.log(`\nAvg Slippage: ${m.avgSlippage.toFixed(4)} | Total Funding: ${m.totalFundingCosts.toFixed(2)}`);

    console.log('\n' + '='.repeat(70));
    console.log('PERFORMANCE BY REGIME');
    console.log('='.repeat(70));
    console.table(m.regimeStats);
    }

    {
    const regimeCounts = {};
    for (const r of regimeLog) regimeCounts[r] = (regimeCounts[r] || 0) + 1;
    console.log('\nRegime Distribution:');
    for (const [r, cnt] of Object.entries(regimeCounts)) {
      console.log(`${r}: ${cnt} bars (${(cnt / regimeLog.length * 100).toFixed(1)}%)`);
    }

    Stats.realityCheck(m);
    console.log('\n' + '='.repeat(70));

    if (trades.length > 0) {
      console.log('\nRecent Trades (last 10):');
      const recent = trades.slice(-10).map(t => ({
        Entry: t.entryTime.slice(11, 19),
        Exit: t.exitTime.slice(11, 19),
        Dir: t.direction.toUpperCase(),
        EntryP: t.entryPrice.toFixed(2),
        ExitP: t.exitPrice.toFixed(2),
        'P&L': t.pnl.toFixed(2),
        'Ret%': (t.return * 100).toFixed(2),
        MaxATR: t.maxProfitATR,
        Regime: t.regime,
        Exit: t.exitReason
      }));
      console.table(recent);
      await fs.writeFile('backtest_trades.json', JSON.stringify(trades, null, 2));
      console.log('\n✅ Trades saved to backtest_trades.json');
    }
}

    // ===================================================
    // EQUITY CURVE
    {
    const eqData = equityCurve.map((eq, i) => ({ index: i, equity: eq, regime: regimeLog[i] || 'UNKNOWN' }));
    await fs.writeFile('backtest_equity_curve.json', JSON.stringify(eqData, null, 2));
    console.log('✅ Equity curve saved to backtest_equity_curve.json');
    await fs.writeFile('strategy_comparison.json', JSON.stringify(comp, null, 2));
    console.log('✅ Strategy comparison saved to strategy_comparison.json');

    console.log('\n' + '='.repeat(70));
    console.log('NEXT STEPS:');
    console.log('='.repeat(70));
    console.log('1. Review profit protection stats (aim for 30-60% protectedCapital exit rate)');
    console.log('2. Set FORWARD_TEST = true and paper trade for 2-4 weeks minimum');
    console.log('3. Compare paper results to backtest (expect 20-30% worse performance)');
    console.log('4. Only go live if paper trading validates strategy');
    console.log('5. Start with 1-5% of capital and 1-2x leverage');
    console.log('='.repeat(70));
    }
  }
}

main().catch(console.error);