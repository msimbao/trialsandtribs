const Stats = require('../utils/stats');
const BinanceFetcher = require('../core/binanceFetcher');


class TradingBacktest {
  constructor(initialCap = 10000, lev = 1, makerFee = 0.0002, takerFee = 0.0004) {
    this.initialCapital = initialCap;
    this.leverage = lev;
    this.makerFee = makerFee;
    this.takerFee = takerFee;
    this.maintenanceMarginRate = 0.004;
    
    // Slippage model
    this.baseSlippage = 0.0003;
    this.volatilitySlippageMultiplier = 0.0002;
    this.stopSlippageATRMultiplier = 0.3;
    
    // DYNAMIC PROFIT PROTECTION SYSTEM
    // Two-tier trailing stops: wide pre-profit (2 ATR), tight post-profit (1→0.5 ATR)
    this.profitThresholdATR = 0.2; // Switch to profit protection after 0.5 ATR gain
    this.initialStopATR = 1.2; // Wide stop before profit (avoid noise)
    this.profitTrailingATR = 0.4; // Base trailing once profitable
    
    // Progressive tightening tiers based on profit level
    this.profitTiers = [
      { profitATR: 1.0, trailATR: 0.2 },   // Small profit: moderate protection
      { profitATR: 2.0, trailATR: 0.5 },  // Good profit: tighter protection
      { profitATR: 3.0, trailATR: 1.0 }    // Great profit: very tight protection
    ];
    
    // Regime-specific stop adjustments (subtle)
    this.regimeMultipliers = {
      bull: { initial: 1.0, profit: 1.2 },   // Slightly wider in trends
      bear: { initial: 1.0, profit: 1.2 },
      range: { initial: 1.0, profit: 0.8 }   // Tighter in range
    };
  }

  // Calculate entry slippage based on volatility
  calcSlippage(price, side, atr) {
    const vol = atr / price;
    const slip = this.baseSlippage + vol * this.volatilitySlippageMultiplier;
    return side === 'buy' ? price * (1 + slip) : price * (1 - slip);
  }

  // Calculate stop order slippage (stops execute worse than limit orders)
  calcStopSlip(stopPrice, side, atr) {
    const slip = atr * this.stopSlippageATRMultiplier;
    return side === 'long' ? Math.max(0, stopPrice - slip) : stopPrice + slip;
  }

  // Calculate liquidation price for leveraged position
  calcLiqPrice(entryPrice, lev, side) {
    return side === 'long'
      ? entryPrice * (1 - 1 / lev + this.maintenanceMarginRate)
      : entryPrice * (1 + 1 / lev - this.maintenanceMarginRate);
  }

  // Calculate perpetual futures funding costs (charged every 8 hours)
  calcFundingCost(posVal, hoursHeld, fundingRate = 0.0001) {
    return posVal * fundingRate * Math.floor(hoursHeld / 8);
  }

  // CORE: Dynamic trailing stop calculator
  // Adapts based on profit level and market regime
  calcDynamicTrail(curPrice, entryPrice, curAtr, pos, regime) {
    const profitAmt = pos === 1 ? curPrice - entryPrice : entryPrice - curPrice;
    const profitInATR = profitAmt / curAtr;
    
    const regType = regime.bull ? 'bull' : regime.bear ? 'bear' : 'range';
    const mults = this.regimeMultipliers[regType];
    
    // Pre-profit: use wide initial stop
    if (profitInATR < this.profitThresholdATR) {
      const stopDist = this.initialStopATR * curAtr * mults.initial;
      return pos === 1 ? curPrice - stopDist : curPrice + stopDist;
    }
    
    // Post-profit: progressive tightening based on profit tiers
    let trailATR = this.profitTrailingATR;
    for (const tier of this.profitTiers) {
      if (profitInATR >= tier.profitATR) trailATR = tier.trailATR;
    }
    trailATR *= mults.profit;
    
    const stopDist = trailATR * curAtr;
    return pos === 1 ? curPrice - stopDist : curPrice + stopDist;
  }

  // Technical indicators
  calcATR(data, period = 14) {
    const atr = new Array(data.length).fill(NaN);
    for (let i = 1; i < data.length; i++) {
      if (i >= period) {
        const trSlice = [];
        for (let j = i - period + 1; j <= i; j++) {
          const tr1 = data[j].high - data[j].low;
          const tr2 = j > 0 ? Math.abs(data[j].high - data[j - 1].close) : 0;
          const tr3 = j > 0 ? Math.abs(data[j].low - data[j - 1].close) : 0;
          trSlice.push(Math.max(tr1, tr2, tr3));
        }
        atr[i] = Stats.mean(trSlice);
      }
    }
    return atr;
  }

  calcRSI(data, period = 14) {
    const rsi = new Array(data.length).fill(NaN);
    for (let i = period; i < data.length; i++) {
      let gains = 0, losses = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const chg = data[j].close - data[j - 1].close;
        if (chg > 0) gains += chg; else losses += Math.abs(chg);
      }
      const avgG = gains / period, avgL = losses / period;
      rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return rsi;
  }

  calcEMA(data, period) {
    return Stats.ema(data.map(d => d.close), period);
  }

  // Detect market regime: bull/bear/range
  detectRegime(data, lookback = 50) {
    return data.map((d, i) => {
      if (i < lookback) return { bull: false, bear: false, range: true };
      const priceChg = (data[i].close - data[i - lookback].close) / data[i - lookback].close;
      const sma = Stats.mean(data.slice(Math.max(0, i - lookback), i + 1).map(d => d.close));
      const smaSlope = i >= lookback + 5
        ? (sma - Stats.mean(data.slice(i - lookback - 5, i - 4).map(d => d.close))) / sma
        : 0;
      const bull = priceChg > 0.10 && smaSlope > 0.001;
      const bear = priceChg < -0.10 && smaSlope < -0.001;
      return { bull, bear, range: !bull && !bear };
    });
  }

  // Generate trading signals based on strategy mode
  generateSignals(data, strategyMode = 'adaptive') {
    const atr = this.calcATR(data);
    const rsi = this.calcRSI(data);
    const ema20 = this.calcEMA(data, 20);
    const ema50 = this.calcEMA(data, 50);
    const ema200 = this.calcEMA(data, 200);
    const regimes = this.detectRegime(data);

    return data.map((d, i) => {
      if (i < 200) return { long: false, short: false };

      const recentHigh = Math.max(...data.slice(Math.max(0, i - 20), i).map(d => d.high));
      const recentLow = Math.min(...data.slice(Math.max(0, i - 20), i).map(d => d.low));
      let long = false, short = false;

      // Strategy logic
      if (strategyMode === 'mean_reversion') {
        long = rsi[i] < 30 && d.close > ema200[i];
        short = rsi[i] > 70 && d.close < ema200[i];
      } else if (strategyMode === 'momentum') {
        long = d.close > recentHigh && rsi[i] > 50 && d.close > ema200[i] && ema20[i] > ema50[i];
        short = d.close < recentLow && rsi[i] < 50 && d.close < ema200[i] && ema20[i] < ema50[i];
      } else if (strategyMode === 'pullback') {
        long = d.close > ema200[i] && d.close < ema20[i] && rsi[i] > 40 && rsi[i] < 60 && rsi[i] > rsi[i - 1];
        short = d.close < ema200[i] && d.close > ema20[i] && rsi[i] > 40 && rsi[i] < 60 && rsi[i] < rsi[i - 1];
      } else if (strategyMode === 'bear_market') {
        long = rsi[i] < 25 && d.close > data[i - 1].close && d.volume > data[i - 1].volume * 1.2;
        short = (rsi[i] > 60 && d.close < ema200[i] && ema20[i] < ema50[i]) ||
                (d.close < ema20[i] && data[i - 1].close > ema20[i - 1] && d.close < ema200[i]) ||
                (d.close < recentLow && d.close < ema200[i]);
      } else { // adaptive
        const bullLong = regimes[i].bull && d.close > ema200[i] && d.close < ema20[i] &&
                        rsi[i] > 40 && rsi[i] < 60 && rsi[i] > rsi[i - 1];
        const bearShort = regimes[i].bear && rsi[i] > 60 && d.close < ema200[i] && ema20[i] < ema50[i];
        const bearLong = regimes[i].bear && rsi[i] < 25 && d.close > data[i - 1].close;
        const rangeLong = regimes[i].range && rsi[i] < 30;
        const rangeShort = regimes[i].range && rsi[i] > 70;
        long = bullLong || bearLong || rangeLong;
        short = bearShort || rangeShort;
      }

      

      const atrMA = i >= 50 ? Stats.mean(atr.slice(i - 50, i)) : atr[i];
const isVolatileEnough = atr[i] > atrMA * 0.8; // Only trade when ATR > 80% of average

long = long && isVolatileEnough;
short = short && isVolatileEnough;

      return { long, short, atr: atr[i], rsi: rsi[i], ema20: ema20[i], ema50: ema50[i], ema200: ema200[i], regime: regimes[i] };
    });
  }

  // Get regime-specific position sizing parameters
  getRegimeParams(isBull, isBear) {
    if (isBull) return { positionSizePct: 0.5, minHoldBars: 3 };
    if (isBear) return { positionSizePct: 0.3, minHoldBars: 3 };
    return { positionSizePct: 0.4, minHoldBars: 3 };
  }

  // Main backtest engine
  backtest(data, strategyMode = 'adaptive', useRegimeParams = true) {
    const signals = this.generateSignals(data, strategyMode);
    let capital = this.initialCapital, position = 0, entryPrice = 0, entryBar = 0;
    let trailingStop = 0, positionQty = 0, liquidationPrice = 0, maxProfitATR = 0;
    const trades = [], equityCurve = [], regimeLog = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i], signal = signals[i], curPrice = row.close, curAtr = signal.atr;
      if (isNaN(curAtr)) { equityCurve.push(capital); continue; }

      const params = useRegimeParams
        ? this.getRegimeParams(signal.regime.bull, signal.regime.bear)
        : { positionSizePct: 0.5, minHoldBars: 3 };
      const regime = signal.regime.bull ? 'BULL' : signal.regime.bear ? 'BEAR' : 'RANGE';
      regimeLog.push(regime);

      // Check liquidation
      if (position !== 0 && ((position === 1 && curPrice <= liquidationPrice) ||
                             (position === -1 && curPrice >= liquidationPrice))) {
        const marginLost = entryPrice * positionQty;
        capital -= marginLost;
        trades.push({
          entryTime: data[entryBar].timestamp, exitTime: row.timestamp,
          direction: position === 1 ? 'long' : 'short', entryPrice, exitPrice: liquidationPrice,
          barsHeld: i - entryBar, pnl: -marginLost, return: -1, exitReason: 'liquidation',
          regime, maxProfitATR: maxProfitATR.toFixed(2)
        });
        console.warn(`⚠️ LIQUIDATION at bar ${i}! Price: ${curPrice.toFixed(2)}`);
        position = 0;
        continue;
      }

      // Manage open positions with dynamic trailing stops
      if (position !== 0) {
        const barsHeld = i - entryBar;
        const hoursHeld = barsHeld * 0.25;
        const profitAmt = position === 1 ? curPrice - entryPrice : entryPrice - curPrice;
        const profitInATR = profitAmt / curAtr;
        maxProfitATR = Math.max(maxProfitATR, profitInATR);

        // Update trailing stop (only moves in favorable direction)
        const newTrail = this.calcDynamicTrail(curPrice, entryPrice, curAtr, position, signal.regime);
        if (position === 1) trailingStop = Math.max(trailingStop, newTrail);
        else trailingStop = Math.min(trailingStop, newTrail);

        const stopHit = position === 1 ? curPrice <= trailingStop : curPrice >= trailingStop;
        if (stopHit) {
          const exitPrice = this.calcStopSlip(trailingStop, position === 1 ? 'long' : 'short', curAtr);
          const pnl = position === 1
            ? (exitPrice - entryPrice) * positionQty * this.leverage
            : (entryPrice - exitPrice) * positionQty * this.leverage;
          const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
          const fundingCost = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
          const netPnl = pnl - exitFee - fundingCost;
          capital += netPnl;

          const exitReason = profitInATR > this.profitThresholdATR ? 'profit_protection' : 'initial_stop';
          trades.push({
            entryTime: data[entryBar].timestamp, exitTime: row.timestamp,
            direction: position === 1 ? 'long' : 'short', entryPrice, exitPrice, barsHeld,
            pnl: netPnl, return: netPnl / (entryPrice * positionQty), exitReason, regime,
            fundingCost, slippage: Math.abs(trailingStop - exitPrice),
            maxProfitATR: maxProfitATR.toFixed(2)
          });
          position = 0;
          maxProfitATR = 0;
        }
      }

      // Enter new positions
      if (position === 0 && capital > 0) {
        if (signal.long || signal.short) {
          const tradeCapital = capital * params.positionSizePct;
          entryPrice = this.calcSlippage(curPrice, signal.long ? 'buy' : 'sell', curAtr);
          const entryFee = tradeCapital * this.leverage * this.takerFee;
          positionQty = (tradeCapital - entryFee) / entryPrice;
          entryBar = i;
          position = signal.long ? 1 : -1;
          maxProfitATR = 0;
          trailingStop = this.calcDynamicTrail(entryPrice, entryPrice, curAtr, position, signal.regime);
          liquidationPrice = this.calcLiqPrice(entryPrice, this.leverage, signal.long ? 'long' : 'short');
        }
      }
      equityCurve.push(capital);
    }

    // Close remaining position at end
    if (position !== 0) {
      const exitPrice = data[data.length - 1].close;
      const hoursHeld = (data.length - entryBar) * 0.25;
      const pnl = position === 1
        ? (exitPrice - entryPrice) * positionQty * this.leverage
        : (entryPrice - exitPrice) * positionQty * this.leverage;
      const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
      const fundingCost = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
      const netPnl = pnl - exitFee - fundingCost;
      capital += netPnl;
      trades.push({
        entryTime: data[entryBar].timestamp, exitTime: data[data.length - 1].timestamp,
        direction: position === 1 ? 'long' : 'short', entryPrice, exitPrice,
        barsHeld: data.length - entryBar, pnl: netPnl,
        return: netPnl / (entryPrice * positionQty), exitReason: 'end_of_data',
        regime: regimeLog[regimeLog.length - 1], fundingCost,
        maxProfitATR: maxProfitATR.toFixed(2)
      });
    }

    return { trades, equityCurve, signals, regimeLog };
  }

  // Forward testing (paper trading with live data)
  async forwardTest(symbol, interval, strategyMode = 'adaptive', useRegimeParams = true, updateInterval = 60) {
    console.log('\n' + '='.repeat(70));
    console.log('FORWARD TEST (PAPER TRADING) WITH DYNAMIC PROFIT PROTECTION 🛡️');
    console.log('='.repeat(70));
    console.log(`Symbol: ${symbol} | Interval: ${interval} | Strategy: ${strategyMode}`);
    console.log(`Leverage: ${this.leverage}x | Capital: $${this.initialCapital.toLocaleString()}`);
    console.log(`\nProfit Protection: ${this.initialStopATR} ATR → ${this.profitThresholdATR} ATR threshold → ${this.profitTrailingATR}-${this.profitTiers[this.profitTiers.length-1].trailATR} ATR trailing`);
    console.log('Press Ctrl+C to stop\n' + '='.repeat(70));

    const fetcher = new BinanceFetcher();
    let capital = this.initialCapital, position = 0, entryPrice = 0, entryTime = null;
    let trailingStop = 0, positionQty = 0, liquidationPrice = 0, maxProfitATR = 0;
    const trades = [], startTime = new Date();

    const shutdown = async () => {
      console.log('\n' + '='.repeat(70) + '\n⚠️  SHUTDOWN - CLOSING POSITIONS\n' + '='.repeat(70));
      if (position !== 0) {
        const data = await fetcher.getLatestCandles(symbol, interval, 10);
        const exitPrice = data.slice(0, -1)[data.length - 2].close;
        const exitTime = data.slice(0, -1)[data.length - 2].timestamp;
        const hoursHeld = (Date.now() - entryTime.getTime()) / 3600000;
        const pnl = position === 1 ? (exitPrice - entryPrice) * positionQty * this.leverage
                                   : (entryPrice - exitPrice) * positionQty * this.leverage;
        const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
        const fundingCost = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
        const netPnl = pnl - exitFee - fundingCost;
        capital += netPnl;
        trades.push({
          entryTime, exitTime, direction: position === 1 ? 'long' : 'short',
          entryPrice, exitPrice, pnl: netPnl, return: netPnl / (entryPrice * positionQty),
          exitReason: 'manual_shutdown', regime: 'UNKNOWN', fundingCost,
          maxProfitATR: maxProfitATR.toFixed(2)
        });
        console.log(`Position closed at ${exitPrice.toFixed(2)} | P&L: ${netPnl.toFixed(2)} | Max Profit: ${maxProfitATR.toFixed(2)} ATR`);
      }
      console.log(`\nFinal Capital: ${capital.toFixed(2)} | Return: ${((capital - this.initialCapital) / this.initialCapital * 100).toFixed(2)}%`);
      console.log(`Total Trades: ${trades.length}`);
      if (trades.length > 0) {
        const wins = trades.filter(t => t.pnl > 0).length;
        const protectedCapital = trades.filter(t => t.exitReason === 'profit_protection').length;
        console.log(`Win Rate: ${(wins / trades.length * 100).toFixed(1)}% | Profit protectedCapital: ${protectedCapital} (${(protectedCapital/trades.length*100).toFixed(1)}%)`);
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // Add periodic status logging
const LOG_INTERVAL_MINUTES = 5; // Change this to your desired interval
const statusLogger = setInterval(() => {
  if (position !== 0) {
    const currentPrice = data[data.length - 1].close;
    const currentAtr = signals[signals.length - 1].atr;
    const hoursHeld = (Date.now() - entryTime.getTime()) / 3600000;
    
    // Calculate current P&L
    const grossPnl = position === 1
      ? (currentPrice - entryPrice) * positionQty * this.leverage
      : (entryPrice - currentPrice) * positionQty * this.leverage;
    
    const exitFee = currentPrice * positionQty * this.leverage * this.takerFee;
    const fundingCost = this.calcFundingCost(currentPrice * positionQty * this.leverage, hoursHeld);
    const netPnl = grossPnl - exitFee - fundingCost;
    const projectedCapital = capital + netPnl;
    const profitInATR = (position === 1 ? currentPrice - entryPrice : entryPrice - currentPrice) / currentAtr;
    
    console.log('\n' + '─'.repeat(70));
    console.log(`⏰ PERIODIC STATUS UPDATE [${new Date().toLocaleString()}]`);
    console.log('─'.repeat(70));
    console.log(`Position: ${position === 1 ? 'LONG' : 'SHORT'} ${this.leverage}x at ${entryPrice.toFixed(2)}`);
    console.log(`Current Price: ${currentPrice.toFixed(2)} | Trailing Stop: ${trailingStop.toFixed(2)}`);
    console.log(`Profit: ${profitInATR.toFixed(2)} ATR (Max: ${maxProfitATR.toFixed(2)} ATR)`);
    console.log(`\nIF CLOSED NOW:`);
    console.log(`  Gross P&L: $${grossPnl.toFixed(2)}`);
    console.log(`  Exit Fee: -$${exitFee.toFixed(2)}`);
    console.log(`  Funding Cost: -$${fundingCost.toFixed(2)}`);
    console.log(`  Net P&L: $${netPnl.toFixed(2)} (${(netPnl/(entryPrice*positionQty)*100).toFixed(2)}%)`);
    console.log(`  Final Capital: $${projectedCapital.toFixed(2)}`);
    console.log(`  Total Return: ${((projectedCapital - this.initialCapital) / this.initialCapital * 100).toFixed(2)}%`);
    console.log('─'.repeat(70));
  } else {
    console.log(`\n⏰ [${new Date().toLocaleString()}] No position open | Capital: $${capital.toFixed(2)}`);
  }
}, LOG_INTERVAL_MINUTES * 60 * 1000);


    let lastClosedTime = null;

    while (true) {
      try {
        const rawData = await fetcher.getLatestCandles(symbol, interval, 501);
        if (!rawData || rawData.length < 201) {
          console.log('Fetch failed, retrying...');
          await new Promise(r => setTimeout(r, updateInterval * 1000));
          continue;
        }

        const data = rawData.slice(0, -1);
        const latest = data[data.length - 1];
        if (lastClosedTime && latest.closeTime <= lastClosedTime) {
          await new Promise(r => setTimeout(r, updateInterval * 1000));
          continue;
        }
        lastClosedTime = latest.closeTime;

        const signals = this.generateSignals(data, strategyMode);
        const signal = signals[signals.length - 1];
        const curPrice = latest.close, curTime = latest.timestamp, curAtr = signal.atr;
        if (isNaN(curAtr)) { await new Promise(r => setTimeout(r, updateInterval * 1000)); continue; }

        const regime = signal.regime.bull ? 'BULL' : signal.regime.bear ? 'BEAR' : 'RANGE';
        const params = useRegimeParams ? this.getRegimeParams(signal.regime.bull, signal.regime.bear)
                                       : { positionSizePct: 0.5, minHoldBars: 3 };

        console.log(`\n[${curTime}] ${curPrice.toFixed(2)} | ${regime} | Capital: ${capital.toFixed(2)}`);
        console.log(`RSI: ${signal.rsi.toFixed(1)} | ATR: ${curAtr.toFixed(2)}`);

        // Check liquidation
        if (position !== 0 && ((position === 1 && curPrice <= liquidationPrice) ||
                               (position === -1 && curPrice >= liquidationPrice))) {
          const marginLost = entryPrice * positionQty;
          capital -= marginLost;
          trades.push({
            entryTime, exitTime: curTime, direction: position === 1 ? 'long' : 'short',
            entryPrice, exitPrice: liquidationPrice, pnl: -marginLost, return: -1,
            exitReason: 'liquidation', regime, maxProfitATR: maxProfitATR.toFixed(2)
          });
          console.log(`🚨 LIQUIDATION at ${liquidationPrice.toFixed(2)}`);
          position = 0;
          continue;
        }

        // Manage open position
        if (position !== 0) {
          const hoursHeld = (curTime - entryTime) / 3600000;
          const profitAmt = position === 1 ? curPrice - entryPrice : entryPrice - curPrice;
          const profitInATR = profitAmt / curAtr;
          maxProfitATR = Math.max(maxProfitATR, profitInATR);

          const newTrail = this.calcDynamicTrail(curPrice, entryPrice, curAtr, position, signal.regime);
          if (position === 1) {
            if (newTrail > trailingStop) {
              trailingStop = newTrail;
              console.log(`📈 Trailing tightened: ${trailingStop.toFixed(2)} (Profit: ${profitInATR.toFixed(2)} ATR)`);
            }
          } else {
            if (newTrail < trailingStop) {
              trailingStop = newTrail;
              console.log(`📉 Trailing tightened: ${trailingStop.toFixed(2)} (Profit: ${profitInATR.toFixed(2)} ATR)`);
            }
          }

          const positionPnl = position === 1
            ? (curPrice - entryPrice) * positionQty * this.leverage
            : (entryPrice - curPrice) * positionQty * this.leverage;
          const pnlPct = (positionPnl / (entryPrice * positionQty)) * 100;
          const unrealizedFee = curPrice * positionQty * this.leverage * this.takerFee;
          const fundingCost = this.calcFundingCost(curPrice * positionQty * this.leverage, hoursHeld);
          const netPnl = positionPnl - unrealizedFee - fundingCost;
          const netPct = (netPnl / (entryPrice * positionQty)) * 100;
          const status = profitInATR >= this.profitThresholdATR ? '🛡️ protectedCapital' : '⏳ INITIAL';

          console.log(`Position: ${position === 1 ? 'LONG' : 'SHORT'} ${this.leverage}x | Entry: ${entryPrice.toFixed(2)} | ${status}`);
          console.log(`P&L: ${positionPnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | Net: ${netPnl.toFixed(2)} (${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}%)`);
          console.log(`Profit: ${profitInATR.toFixed(2)} ATR (Max: ${maxProfitATR.toFixed(2)}) | Stop: ${trailingStop.toFixed(2)} | Liq: ${liquidationPrice.toFixed(2)}`);

          const stopHit = position === 1 ? curPrice <= trailingStop : curPrice >= trailingStop;
          if (stopHit) {
            const exitPrice = this.calcStopSlip(trailingStop, position === 1 ? 'long' : 'short', curAtr);
            const pnl = position === 1
              ? (exitPrice - entryPrice) * positionQty * this.leverage
              : (entryPrice - exitPrice) * positionQty * this.leverage;
            const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
            const totalFunding = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
            const finalPnl = pnl - exitFee - totalFunding;
            capital += finalPnl;

            const exitReason = profitInATR > this.profitThresholdATR ? 'profit_protection' : 'initial_stop';
            trades.push({
              entryTime, exitTime: curTime, direction: position === 1 ? 'long' : 'short',
              entryPrice, exitPrice, pnl: finalPnl, return: finalPnl / (entryPrice * positionQty),
              exitReason, regime, fundingCost: totalFunding,
              slippage: Math.abs(trailingStop - exitPrice), maxProfitATR: maxProfitATR.toFixed(2)
            });

            const emoji = finalPnl > 0 ? '✅' : '❌';
            const reasonEmoji = exitReason === 'profit_protection' ? '🛡️' : '🔴';
            console.log(`${emoji} EXIT ${position === 1 ? 'LONG' : 'SHORT'}: ${exitPrice.toFixed(2)} ${reasonEmoji}`);
            console.log(`   P&L: ${finalPnl.toFixed(2)} (${((finalPnl/(entryPrice*positionQty)*100)).toFixed(2)}%)`);
            console.log(`   Max Profit: ${maxProfitATR.toFixed(2)} ATR | Reason: ${exitReason}`);
            position = 0;
            maxProfitATR = 0;
          }
        } else if (position === 0 && capital > 0) {
          // Enter new position
          if (signal.long || signal.short) {
            const tradeCapital = capital * params.positionSizePct;
            entryPrice = this.calcSlippage(curPrice, signal.long ? 'buy' : 'sell', curAtr);
            const entryFee = tradeCapital * this.leverage * this.takerFee;
            positionQty = (tradeCapital - entryFee) / entryPrice;
            entryTime = curTime;
            position = signal.long ? 1 : -1;
            maxProfitATR = 0;
            trailingStop = this.calcDynamicTrail(entryPrice, entryPrice, curAtr, position, signal.regime);
            liquidationPrice = this.calcLiqPrice(entryPrice, this.leverage, signal.long ? 'long' : 'short');

            console.log(`✅ ENTER ${signal.long ? 'LONG' : 'SHORT'} ${this.leverage}x: ${entryPrice.toFixed(2)} | Qty: ${positionQty.toFixed(4)}`);
            console.log(`   Initial Stop: ${trailingStop.toFixed(2)} (${this.initialStopATR} ATR) | Liq: ${liquidationPrice.toFixed(2)}`);
            const protectionPrice = signal.long
              ? entryPrice + this.profitThresholdATR * curAtr
              : entryPrice - this.profitThresholdATR * curAtr;
            console.log(`   Protection activates at: ${protectionPrice.toFixed(2)} (${this.profitThresholdATR} ATR)`);
          }
        }

        await new Promise(r => setTimeout(r, updateInterval * 1000));
      } catch (e) {
        console.error('Loop error:', e.message);
        await new Promise(r => setTimeout(r, updateInterval * 1000));
      }
    }
  }

  // Calculate performance metrics
  

  // Reality check for unrealistic results
}

module.exports = TradingBacktest;
