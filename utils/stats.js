// utils/stats.js
class Stats {
  static rolling(arr, w, fn) {
    const res = new Array(arr.length).fill(NaN);
    for (let i = w - 1; i < arr.length; i++) res[i] = fn(arr.slice(i - w + 1, i + 1));
    return res;
  }
  static mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
  static std(a) {
    const m = Stats.mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  }
  static max(a) { return Math.max(...a); }
  static min(a) { return Math.min(...a); }
  static ema(data, period) {
    const k = 2 / (period + 1), res = [data[0]];
    for (let i = 1; i < data.length; i++) res[i] = data[i] * k + res[i - 1] * (1 - k);
    return res;
  }
  static realityCheck(metrics) {
    const warns = [];
    if (metrics.winRate > 0.70) warns.push('⚠️  Win rate > 70% unusual for scalping');
    if (metrics.sharpeRatio > 3.0) warns.push('⚠️  Sharpe > 3 extremely rare in live trading');
    if (Math.abs(metrics.maxDrawdown) < 0.05) warns.push('⚠️  Max DD < 5% unrealistic for crypto');
    if (metrics.profitFactor > 3.0) warns.push('⚠️  Profit factor > 3 rarely sustained');
    if (metrics.liquidations > metrics.totalTrades * 0.1) warns.push('⚠️  Liquidation rate > 10% very dangerous');
    if (metrics.totalFundingCosts / Math.abs(metrics.totalPnl) > 0.2) warns.push('⚠️  Funding costs > 20% of P&L');

    if (warns.length > 0) {
      console.log('\n' + '='.repeat(70));
      console.log('🚨 REALITY CHECK WARNINGS:');
      console.log('='.repeat(70));
      warns.forEach(w => console.log(w));
      console.log('\nBacktest may be overfitted. STRONGLY RECOMMENDED: Paper trade 2-4 weeks before live.');
      console.log('='.repeat(70));
    } else {
      console.log('\n✅ Reality check passed - results appear reasonable');
    }

    console.log('\n' + '='.repeat(70));
    console.log('🛡️  PROFIT PROTECTION ANALYSIS');
    console.log('='.repeat(70));
    console.log(`protectedCapital Exits: ${metrics.profitprotectedCapitalExits} (${metrics.profitProtectionRate})`);
    console.log(`Avg Max Profit: ${metrics.avgMaxProfitATR} ATR`);
    console.log('Shows how well system locks in gains vs giving them back.');
    console.log('='.repeat(70));

    return warns.length === 0;
  }

  static calcMetrics(trades, equityCurve, data, initialCapital) {
    if (!trades || trades.length === 0) {
      return {
        totalTrades: 0, winRate: 0, totalReturn: 0, maxDrawdown: 0,
        sharpeRatio: 0, avgSlippage: 0, totalFundingCosts: 0,
        liquidations: 0, profitprotectedCapitalExits: 0
      };
    }

    const total = trades.length;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const winRate = wins.length / total;
    const liquidations = trades.filter(t => t.exitReason === 'liquidation').length;
    const protectedCapital = trades.filter(t => t.exitReason === 'profit_protection').length;

    const totalReturn = (equityCurve[equityCurve.length - 1] - initialCapital) / initialCapital;
    const avgWin = wins.length > 0 ? Stats.mean(wins.map(t => t.pnl)) : 0;
    const avgLoss = losses.length > 0 ? Stats.mean(losses.map(t => t.pnl)) : 0;
    const totalFunding = trades.reduce((s, t) => s + (t.fundingCost || 0), 0);
    const avgSlip = trades.filter(t => t.slippage).length > 0
      ? Stats.mean(trades.filter(t => t.slippage).map(t => Math.abs(t.slippage))) : 0;

    let maxDD = 0, peak = equityCurve[0];
    for (const eq of equityCurve) {
      if (eq > peak) peak = eq;
      const dd = (eq - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }

    const returns = equityCurve.slice(1).map((v, i) => (v - equityCurve[i]) / equityCurve[i]);
    const meanRet = Stats.mean(returns);
    const stdRet = Stats.std(returns);
    const sharpe = returns.length > 0 && stdRet !== 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;

    const buyHold = (data[data.length - 1].close - data[0].close) / data[0].close;

    const regimeStats = {};
    for (const t of trades) {
      if (!regimeStats[t.regime]) regimeStats[t.regime] = { sum: 0, count: 0, wins: 0 };
      regimeStats[t.regime].sum += t.pnl;
      regimeStats[t.regime].count++;
      if (t.pnl > 0) regimeStats[t.regime].wins++;
    }
    for (const r in regimeStats) {
      regimeStats[r].mean = regimeStats[r].sum / regimeStats[r].count;
      regimeStats[r].winRate = (regimeStats[r].wins / regimeStats[r].count * 100).toFixed(1) + '%';
    }

    const profitFactor = wins.length > 0 && losses.length > 0
      ? Math.abs(wins.reduce((a, b) => a + b.pnl, 0) / losses.reduce((a, b) => a + b.pnl, 0)) : 0;

    const avgMaxProfit = trades.filter(t => t.maxProfitATR).length > 0
      ? Stats.mean(trades.filter(t => t.maxProfitATR).map(t => parseFloat(t.maxProfitATR))) : 0;

    return {
      totalTrades: total, winningTrades: wins.length, losingTrades: losses.length,
      winRate, avgWin, avgLoss, profitFactor, totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
      totalReturn, maxDrawdown: maxDD, sharpeRatio: sharpe,
      finalCapital: equityCurve[equityCurve.length - 1], buyHoldReturn: buyHold,
      outperformance: totalReturn - buyHold, regimeStats, avgSlippage: avgSlip,
      totalFundingCosts: totalFunding, liquidations, profitprotectedCapitalExits: protectedCapital,
      profitProtectionRate: (protectedCapital / total * 100).toFixed(1) + '%',
      avgMaxProfitATR: avgMaxProfit.toFixed(2)
    };
  }
}

module.exports = Stats;
