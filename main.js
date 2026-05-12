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
  const openPos     = state.get('positions');
  const history     = state.get('history');
  const totalPnl    = history.reduce((s, h) => s + h.netPnl, 0);
  const startLines  = [
    '```',
    '🟢 ARBITRAGE BOT ONLINE',
    `Balance   : $${state.get('balance').toFixed(2)}`,
    `Total PnL : $${totalPnl.toFixed(2)} (${history.length} trades)`,
    `Slots     : ${openPos.length}/${config.MAX_POSITIONS} filled`,
    `Min Rate  : ${config.MIN_FUNDING_RATE_PCT}%/yr | Exit: ${config.EXIT_RATE_THRESHOLD_PCT}%/yr`,
    `Mode      : Paper Trading`,
    `Time      : ${new Date().toISOString()}`,
    '```',
  ];
  if (openPos.length > 0) {
    startLines.push(buildPositionsBlock(openPos, []));
  }
  await discord.send(startLines.join('\n'));

  // Start real-time WebSocket monitor (price + funding)
  monitor.start(onTick);

  // Collect funding payments every 8 hours (Binance funding interval)
  setInterval(async () => {
    const positions = state.get('positions');
    if (!positions.length) return;

    const lines = ['```', '💰 FUNDING COLLECTED'];
    let totalThisCycle = 0;

    for (const pos of positions) {
      const rate = await sourcer.getCurrentFundingRate(pos.pair);
      if (rate === null) { logger.warn('FUNDING', `No rate for ${pos.pair}, skipping`); continue; }
      const payment = tracker.addFundingPayment(pos, rate);
      totalThisCycle += payment;
      logger.info('FUNDING', `${pos.pair} collected $${payment.toFixed(4)} | Total: $${pos.fundingCollected.toFixed(4)}`);
      lines.push(`  ${pos.pair.padEnd(8)} +$${payment.toFixed(4)}  (total: $${pos.fundingCollected.toFixed(4)})`);
    }

    lines.push('─'.repeat(40));
    lines.push(`  This cycle : +$${totalThisCycle.toFixed(4)}`);
    lines.push(`  Balance    : $${state.get('balance').toFixed(2)}`);
    lines.push('```');
    await discord.send(lines.join('\n'));
    await state.save();
  }, 8 * 60 * 60 * 1000);

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
    const hitMaxDrawdown   = tracker.drawdown(pos, data.perpPrice, data.spotPrice) > config.MAX_DRAWDOWN_PCT;
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
    // Dynamically fetch all Binance perp pairs that pass the funding rate filter
    const candidates = await sourcer.getAllFundingRates();
    logger.info('SCAN', `Found ${candidates.length} pairs above ${config.MIN_FUNDING_RATE_PCT}%/yr threshold — evaluating top 20...`);

    const opportunities = [];

    for (const { pair } of candidates.slice(0, 20)) {
      try {
        const result = await evaluatePair(pair);
        if (result) opportunities.push(result);
      } catch (err) {
        logger.error('SCAN', `Failed to evaluate ${pair}: ${err.message}`);
      }
    }

    // Sort by effective annual rate descending
    opportunities.sort((a, b) => b.effectiveRateY - a.effectiveRateY);

    // Always send hourly status — never go silent
    await sendHourlyStatus(candidates.length, opportunities);

    if (opportunities.length > 0) {
      logger.info('SCAN', `Found ${opportunities.length} viable opportunities`);

      // Fill open slots with best opportunities not already held
      const openPairs   = new Set(state.get('positions').map(p => p.pair));
      const slotsOpen   = config.MAX_POSITIONS - state.get('positions').length;
      let   slotsUsed   = 0;

      for (const opportunity of opportunities) {
        if (slotsUsed >= slotsOpen) break;
        if (openPairs.has(opportunity.pair)) continue;
        if (state.get('balance') < config.TRADE_AMOUNT) {
          logger.warn('SCAN', 'Insufficient balance for new position');
          break;
        }
        await openPosition(opportunity);
        openPairs.add(opportunity.pair);
        slotsUsed++;
      }

      if (slotsUsed === 0 && slotsOpen > 0) {
        logger.info('SCAN', 'All viable pairs already held or balance too low');
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
    sourcer.getRollingFundingRate(pair, 7),
  ]);

  if (!perpData || !spotData || fundingAvg === null) {
    logger.warn('EVAL', `${pair} | SKIP: incomplete data (perp=${!!perpData} spot=${!!spotData} funding=${fundingAvg})`);
    return null;
  }

  const spread             = calculator.spread(perpData.price, spotData.price);
  const annualizedFunding  = fundingAvg * 24 * 365 * 100;

  // Tier-aware spread limit — Tier 3 coins have naturally wider spreads
  const tier               = getTier(pair);
  const maxSpread          = tier === 1 ? 0.003 : tier === 2 ? 0.005 : 0.012; // 0.3% / 0.5% / 1.2%

  if (annualizedFunding < config.MIN_FUNDING_RATE_PCT) {
    logger.warn('EVAL', `${pair} | SKIP: 7d avg funding ${annualizedFunding.toFixed(2)}% < ${config.MIN_FUNDING_RATE_PCT}% threshold`);
    return null;
  }
  if (Math.abs(spread) > maxSpread) {
    logger.warn('EVAL', `${pair} | SKIP: spread ${(spread*100).toFixed(4)}% > max ${(maxSpread*100).toFixed(2)}% for Tier ${tier}`);
    return null;
  }

  const profit         = calculator.profit(config.TRADE_AMOUNT, fundingAvg, config.TAKER_FEE, spread, config.LEVERAGE);
  const effectiveRateY = calculator.effectiveRate(profit, config.TRADE_AMOUNT);

  logger.info('EVAL', `${pair} | ✅ Funding: ${annualizedFunding.toFixed(2)}%/y | Spread: ${(spread*100).toFixed(4)}% | Profit: $${profit.toFixed(2)}`);

  return { pair, perpPrice: perpData.price, spotPrice: spotData.price, spread, fundingRate: fundingAvg,
           fundingRateH: fundingAvg, annualizedFunding, profit, effectiveRateY, tier, timestamp: Date.now() };
}

// ─── Tier helper (mirrors snapshot.js) ───────────────────────────────────────
function getTier(pair) {
  const T1 = new Set(['BTC', 'ETH']);
  const T2 = new Set(['BNB', 'SOL', 'XRP', 'MATIC', 'AVAX', 'LINK', 'LTC', 'DOT']);
  return T1.has(pair) ? 1 : T2.has(pair) ? 2 : 3;
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

  const slotsFilled = state.get('positions').length;
  logger.info('OPEN', `📈 Opened position on ${pair} | Entry perp: $${perpPrice} | Funding: ${annualizedFunding.toFixed(1)}%/y`);

  await discord.send([
    '```diff',
    `+ OPENED: ${pair}  [slot ${slotsFilled}/${config.MAX_POSITIONS}]`,
    `  Funding/yr  : ${annualizedFunding.toFixed(2)}%`,
    `  Spread      : ${(spread * 100).toFixed(4)}%`,
    `  Perp Entry  : $${perpPrice.toFixed(4)}`,
    `  Spot Entry  : $${spotPrice.toFixed(4)}`,
    `  Amount      : $${config.TRADE_AMOUNT} @ ${config.LEVERAGE}x`,
    `  Est.Profit  : $${profit.toFixed(2)}/yr`,
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

  const durationHrs  = ((Date.now() - position.openedAt) / 3600000).toFixed(1);
  const allTimePnl   = state.get('history').reduce((s, h) => s + h.netPnl, 0);
  const sign         = netPnl >= 0 ? '+' : '-';
  logger.info('CLOSE', `📉 Closed ${position.pair} | Reason: ${reason} | PnL: $${netPnl.toFixed(2)}`);

  await discord.send([
    `\`\`\`${netPnl >= 0 ? 'diff' : 'fix'}`,
    `${sign} CLOSED: ${position.pair}  [${reason}]`,
    `  Duration    : ${durationHrs}h`,
    `  Funding In  : $${position.fundingCollected.toFixed(4)}`,
    `  Unrealized  : $${unrealized.toFixed(4)}`,
    `  Net PnL     : $${netPnl.toFixed(2)}`,
    `  All-time PnL: $${allTimePnl.toFixed(2)}`,
    `  Balance     : $${newBalance.toFixed(2)}`,
    `  Slots       : ${state.get('positions').length}/${config.MAX_POSITIONS} filled`,
    '```'
  ].join('\n'));
}

// ─── Build open positions block (reused across messages) ─────────────────────
function buildPositionsBlock(positions, liveData) {
  if (!positions.length) return '```\n📂 No open positions\n```';

  const reserved = positions.reduce((s, p) => s + p.amount, 0);
  const lines    = [
    '```',
    `📂 OPEN POSITIONS  ${positions.length}/${config.MAX_POSITIONS} slots  |  $${reserved.toFixed(0)} reserved`,
    `${'Pair'.padEnd(7)} ${'Fund%/y'.padEnd(9)} ${'Collected'.padEnd(11)} ${'Unreal.'.padEnd(10)} ${'Age'}`,
    '─'.repeat(50),
  ];

  for (const pos of positions) {
    const live        = liveData.find ? liveData.find(d => d.pair === pos.pair) : null;
    const unrealized  = live ? tracker.unrealizedPnl(pos, live.perpPrice, live.spotPrice) : 0;
    const ageHrs      = ((Date.now() - pos.openedAt) / 3600000).toFixed(1);
    const annualized  = (pos.entryFundingRate * 24 * 365 * 100).toFixed(1);
    lines.push(
      `${pos.pair.padEnd(7)} ${(annualized + '%').padEnd(9)} ${'$' + pos.fundingCollected.toFixed(4).padEnd(10)} ${'$' + unrealized.toFixed(4).padEnd(9)} ${ageHrs}h`
    );
  }
  lines.push('```');
  return lines.join('\n');
}

// ─── Hourly status — always sent regardless of market conditions ──────────────
async function sendHourlyStatus(totalScanned, opportunities) {
  const balance    = state.get('balance');
  const positions  = state.get('positions');
  const history    = state.get('history');
  const allTimePnl = history.reduce((s, h) => s + h.netPnl, 0);
  const slotsOpen  = config.MAX_POSITIONS - positions.length;

  // Header
  const lines = [
    '```',
    `📊 HOURLY SCAN  |  ${new Date().toUTCString()}`,
    `Balance    : $${balance.toFixed(2)}  |  All-time PnL: $${allTimePnl.toFixed(2)}`,
    `Slots      : ${positions.length}/${config.MAX_POSITIONS} filled  |  Scanned: ${totalScanned} pairs`,
    '',
  ];

  // Opportunities found
  if (opportunities.length > 0) {
    lines.push(`✅ ${opportunities.length} pairs above ${config.MIN_FUNDING_RATE_PCT}%/yr — top 5:`);
    lines.push(`${'Pair'.padEnd(8)} ${'Fund%/y'.padEnd(10)} ${'Spread%'.padEnd(10)} ${'Est$/yr'}`);
    lines.push('─'.repeat(42));
    for (const o of opportunities.slice(0, 5)) {
      const held = positions.some(p => p.pair === o.pair) ? ' ✓' : '  ';
      lines.push(`${(o.pair + held).padEnd(8)} ${o.annualizedFunding.toFixed(2).padEnd(10)} ${(o.spread * 100).toFixed(4).padEnd(10)} $${o.profit.toFixed(2)}`);
    }
  } else {
    lines.push(`⏳ ${candidates.length} pairs above ${config.MIN_FUNDING_RATE_PCT}%/yr found but all filtered`);
    lines.push(`   Check logs for EVAL SKIP reasons (spread too wide is most common)`);
    lines.push(`   Market may be bearish/neutral — watching and waiting`);
  }

  lines.push('```');
  await discord.send(lines.join('\n'));

  // Always show open positions block if any are held
  if (positions.length > 0) {
    await discord.send(buildPositionsBlock(positions, []));
  }
}

async function sendDailySummary() {
  const balance    = state.get('balance');
  const history    = state.get('history');
  const positions  = state.get('positions');
  const today      = history.filter(h => Date.now() - h.closedAt < 86400000);
  const todayPnl   = today.reduce((s, h) => s + h.netPnl, 0);
  const allTimePnl = history.reduce((s, h) => s + h.netPnl, 0);
  const stats      = tracker.historySummary(history);

  await discord.send([
    '```',
    '📅 DAILY SUMMARY',
    `Balance     : $${balance.toFixed(2)}`,
    `Today PnL   : $${todayPnl.toFixed(2)} (${today.length} trades closed)`,
    `All-time PnL: $${allTimePnl.toFixed(2)}`,
    `Win Rate    : ${stats.winRate}%  |  Avg hold: ${stats.avgDuration}h`,
    `Open slots  : ${positions.length}/${config.MAX_POSITIONS}`,
    `Time        : ${new Date().toUTCString()}`,
    '```'
  ].join('\n'));

  // Also show open positions in daily summary
  if (positions.length > 0) {
    await discord.send(buildPositionsBlock(positions, []));
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info('BOT', `${signal} received — saving state and shutting down...`);
  monitor.stop();
  await state.save();

  const positions  = state.get('positions');
  const history    = state.get('history');
  const allTimePnl = history.reduce((s, h) => s + h.netPnl, 0);

  const lines = [
    '```fix',
    '🔴 BOT OFFLINE — State saved',
    `Balance     : $${state.get('balance').toFixed(2)}`,
    `All-time PnL: $${allTimePnl.toFixed(2)}`,
    `Open slots  : ${positions.length}/${config.MAX_POSITIONS}`,
    `Signal      : ${signal}`,
    '```',
  ];
  if (positions.length > 0) lines.push(buildPositionsBlock(positions, []));
  await discord.send(lines.join('\n'));
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
