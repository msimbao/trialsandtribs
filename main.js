/**
 * Cash-and-Carry Arbitrage Bot
 * Spot long + Perp short to capture funding rates
 * Exchange: Binance | Mode: Paper Trading
 */

'use strict';

const sourcer    = require('./sourcer');
const calculator = require('./calculator');
const tracker    = require('./tracker');
const monitor    = require('./monitor');
const discord    = require('./discord');
const logger     = require('./logger');
const state      = require('./state');
const config     = require('./config');

let isRunning = false;

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  logger.info('BOT', '🚀 Cash-and-Carry Arbitrage Bot starting...');

  // Restore persisted state (positions, balance, PnL history)
  await state.load();
  logger.info('BOT', `💾 State restored. Virtual balance: $${state.get('balance').toFixed(2)}`);

  // Send startup ping to Discord
  await discord.send([
    '```',
    '🟢 ARBITRAGE BOT ONLINE',
    `Balance : $${state.get('balance').toFixed(2)}`,
    `Pairs   : ${config.PAIRS.join(', ')}`,
    `Mode    : Paper Trading`,
    `Time    : ${new Date().toISOString()}`,
    '```'
  ].join('\n'));

  // Start real-time WebSocket monitor (price + funding)
  monitor.start(onTick);

  // Also run hourly full scan as backup
  setInterval(fullScan, config.SCAN_INTERVAL_MS);
  await fullScan();
}

// ─── Real-time tick handler (called by WebSocket monitor) ────────────────────
async function onTick(data) {
  // data = { pair, perpPrice, spotPrice, fundingRate, spread }
  const openPositions = state.get('positions');

  for (const pos of openPositions) {
    if (pos.pair !== data.pair) continue;

    const spreadPct = data.spread * 100;
    const annualizedRate = data.fundingRate * 24 * 365 * 100;

    // ── Exit conditions ──────────────────────────────────────────────────────
    const spreadInverted   = data.spread < -config.SPREAD_INVERSION_THRESHOLD;
    const rateTooLow       = annualizedRate < config.EXIT_RATE_THRESHOLD_PCT;
    const hitMaxDrawdown   = tracker.drawdown(pos) > config.MAX_DRAWDOWN_PCT;
    const hitTakeProfit    = tracker.unrealizedPnl(pos, data.perpPrice, data.spotPrice) >= config.TAKE_PROFIT_USD;

    if (spreadInverted || rateTooLow || hitMaxDrawdown || hitTakeProfit) {
      const reason = spreadInverted ? 'SPREAD_INVERTED'
                   : rateTooLow     ? 'RATE_TOO_LOW'
                   : hitMaxDrawdown ? 'MAX_DRAWDOWN'
                   :                  'TAKE_PROFIT';

      await closePosition(pos, data, reason);
    }
  }
}

// ─── Full hourly scan ────────────────────────────────────────────────────────
async function fullScan() {
  if (isRunning) return;
  isRunning = true;

  try {
    logger.info('SCAN', `Starting full scan of ${config.PAIRS.length} pairs...`);
    const opportunities = [];

    for (const pair of config.PAIRS) {
      try {
        const result = await evaluatePair(pair);
        if (result) opportunities.push(result);
      } catch (err) {
        logger.error('SCAN', `Failed to evaluate ${pair}: ${err.message}`);
      }
    }

    // Sort by effective annual rate descending
    opportunities.sort((a, b) => b.effectiveRateY - a.effectiveRateY);

    if (opportunities.length > 0) {
      logger.info('SCAN', `Found ${opportunities.length} viable opportunities`);
      await sendOpportunitiesReport(opportunities);

      // Auto-enter best opportunity if not already in it
      const best = opportunities[0];
      const alreadyOpen = state.get('positions').some(p => p.pair === best.pair);

      if (!alreadyOpen && state.get('balance') >= config.TRADE_AMOUNT) {
        await openPosition(best);
      }
    } else {
      logger.info('SCAN', 'No viable opportunities found this cycle');
    }

    // Daily PnL summary at midnight UTC
    const hour = new Date().getUTCHours();
    if (hour === 0) await sendDailySummary();

  } catch (err) {
    logger.error('SCAN', `Full scan error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// ─── Evaluate a single pair ──────────────────────────────────────────────────
async function evaluatePair(pair) {
  const [perpData, spotData, fundingAvg] = await Promise.all([
    sourcer.getPerpPrice(pair),
    sourcer.getSpotPrice(pair),
    sourcer.getRollingFundingRate(pair, 30), // 30-day average
  ]);

  if (!perpData || !spotData || fundingAvg === null) {
    logger.warn('EVAL', `Incomplete data for ${pair}, skipping`);
    return null;
  }

  const spread        = calculator.spread(perpData.price, spotData.price);
  const profit        = calculator.profit(config.TRADE_AMOUNT, fundingAvg, config.TAKER_FEE, spread, config.LEVERAGE);
  const effectiveRateY = calculator.effectiveRate(profit, config.TRADE_AMOUNT);
  const annualizedFunding = fundingAvg * 24 * 365 * 100;

  // Filter: only take if annualized funding > threshold AND spread not too wide
  if (annualizedFunding < config.MIN_FUNDING_RATE_PCT) return null;
  if (Math.abs(spread) > config.MAX_SPREAD_PCT / 100) return null;

  logger.info('EVAL', `${pair} | Funding: ${annualizedFunding.toFixed(2)}%/y | Spread: ${(spread*100).toFixed(4)}% | Profit: $${profit.toFixed(2)}`);

  return {
    pair,
    perpPrice: perpData.price,
    spotPrice: spotData.price,
    spread,
    fundingRate: fundingAvg,
    fundingRateH: fundingAvg,
    annualizedFunding,
    profit,
    effectiveRateY,
    timestamp: Date.now(),
  };
}

// ─── Open a paper position ───────────────────────────────────────────────────
async function openPosition(opportunity) {
  const { pair, perpPrice, spotPrice, spread, fundingRate, annualizedFunding, profit } = opportunity;

  const position = {
    id: `${pair}-${Date.now()}`,
    pair,
    entryPerpPrice: perpPrice,
    entrySpotPrice: spotPrice,
    entrySpread: spread,
    entryFundingRate: fundingRate,
    amount: config.TRADE_AMOUNT,
    leverage: config.LEVERAGE,
    entryFee: config.TRADE_AMOUNT * 2 * config.TAKER_FEE,
    openedAt: Date.now(),
    fundingCollected: 0,
  };

  // Deduct fees from balance
  const newBalance = state.get('balance') - position.entryFee;
  state.set('balance', newBalance);

  const positions = state.get('positions');
  positions.push(position);
  state.set('positions', positions);
  await state.save();

  logger.info('OPEN', `📈 Opened position on ${pair} | Entry perp: $${perpPrice} | Funding: ${annualizedFunding.toFixed(1)}%/y`);

  await discord.send([
    '```diff',
    `+ POSITION OPENED: ${pair}`,
    `  Perp Entry  : $${perpPrice.toFixed(4)}`,
    `  Spot Entry  : $${spotPrice.toFixed(4)}`,
    `  Spread      : ${(spread * 100).toFixed(4)}%`,
    `  Funding/yr  : ${annualizedFunding.toFixed(2)}%`,
    `  Amount      : $${config.TRADE_AMOUNT}`,
    `  Leverage    : ${config.LEVERAGE}x`,
    `  Est. Profit : $${profit.toFixed(2)}/yr`,
    `  Balance     : $${newBalance.toFixed(2)}`,
    '```'
  ].join('\n'));
}

// ─── Close a paper position ──────────────────────────────────────────────────
async function closePosition(position, currentData, reason) {
  const unrealized = tracker.unrealizedPnl(position, currentData.perpPrice, currentData.spotPrice);
  const exitFee    = position.amount * 2 * config.TAKER_FEE;
  const netPnl     = unrealized + position.fundingCollected - exitFee;

  // Update balance
  const newBalance = state.get('balance') + position.amount + netPnl;
  state.set('balance', newBalance);

  // Remove from open positions
  const positions = state.get('positions').filter(p => p.id !== position.id);
  state.set('positions', positions);

  // Append to trade history
  const history = state.get('history');
  history.push({
    ...position,
    closedAt: Date.now(),
    exitPerpPrice: currentData.perpPrice,
    exitSpotPrice: currentData.spotPrice,
    exitReason: reason,
    netPnl,
    fundingCollected: position.fundingCollected,
  });
  state.set('history', history);
  await state.save();

  const durationHrs = ((Date.now() - position.openedAt) / 3600000).toFixed(1);
  const emoji = netPnl >= 0 ? '+' : '-';

  logger.info('CLOSE', `📉 Closed ${position.pair} | Reason: ${reason} | PnL: $${netPnl.toFixed(2)}`);

  await discord.send([
    `\`\`\`${netPnl >= 0 ? 'diff' : 'fix'}`,
    `${emoji} POSITION CLOSED: ${position.pair}`,
    `  Reason      : ${reason}`,
    `  Duration    : ${durationHrs}h`,
    `  Net PnL     : $${netPnl.toFixed(2)}`,
    `  Funding     : $${position.fundingCollected.toFixed(2)}`,
    `  Balance     : $${newBalance.toFixed(2)}`,
    '```'
  ].join('\n'));
}

// ─── Discord reports ─────────────────────────────────────────────────────────
async function sendOpportunitiesReport(opportunities) {
  const top = opportunities.slice(0, 5);
  const lines = [
    '```',
    '📊 HOURLY SCAN RESULTS',
    `${'Pair'.padEnd(8)} ${'Fund%/y'.padEnd(10)} ${'Spread%'.padEnd(10)} ${'Est$/yr'.padEnd(10)} ${'Eff%/y'}`,
    '─'.repeat(52),
  ];
  for (const o of top) {
    lines.push(
      `${o.pair.padEnd(8)} ${o.annualizedFunding.toFixed(2).padEnd(10)} ${(o.spread*100).toFixed(4).padEnd(10)} ${o.profit.toFixed(2).padEnd(10)} ${o.effectiveRateY.toFixed(2)}`
    );
  }
  lines.push('```');
  await discord.send(lines.join('\n'));
}

async function sendDailySummary() {
  const balance  = state.get('balance');
  const history  = state.get('history');
  const today    = history.filter(h => Date.now() - h.closedAt < 86400000);
  const totalPnl = today.reduce((s, h) => s + h.netPnl, 0);
  const openPos  = state.get('positions');

  await discord.send([
    '```',
    '📅 DAILY SUMMARY',
    `Balance       : $${balance.toFixed(2)}`,
    `Trades Today  : ${today.length}`,
    `Daily PnL     : $${totalPnl.toFixed(2)}`,
    `Open Positions: ${openPos.length}`,
    `Total Trades  : ${history.length}`,
    `Time          : ${new Date().toUTCString()}`,
    '```'
  ].join('\n'));
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info('BOT', `${signal} received — saving state and shutting down...`);
  monitor.stop();
  await state.save();
  await discord.send('```fix\n🔴 BOT OFFLINE — State saved\n```');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  logger.error('BOT', `Uncaught exception: ${err.message}\n${err.stack}`);
  await discord.send(`\`\`\`fix\n⚠️ UNCAUGHT ERROR: ${err.message}\n\`\`\``);
});

boot().catch(async (err) => {
  logger.error('BOT', `Boot failed: ${err.message}`);
  await discord.send(`\`\`\`fix\n💥 BOOT FAILED: ${err.message}\n\`\`\``);
  process.exit(1);
});
