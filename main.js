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
const pairs      = require('./pairs');

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

  // Pairs trading — 30-minute Discord status update
  setInterval(sendPairsStatus, config.PAIRS_CONFIG.STATUS_INTERVAL_MS);
  logger.info('BOT', `📐 Pairs trading active — monitoring ${config.PAIRS_CONFIG.relationships.length} relationships`);

  // Seed pairs engine with current prices so startup snapshot is meaningful
  logger.info('BOT', 'Seeding pairs engine with current prices...');
  const allPairsCoins = config.PAIRS_CONFIG.relationships.flatMap(r => r);
  await Promise.all(allPairsCoins.map(async (coin) => {
    try {
      const spot = await sourcer.getSpotPrice(coin);
      if (spot) pairs.onPrice(coin, spot.price);
    } catch (_) {}
  }));

  // Send pairs snapshot immediately — no waiting 30 minutes
  await sendPairsStatus();
}

// ─── Real-time tick handler (called by WebSocket monitor) ────────────────────
async function onTick(data) {
  // data = { pair, perpPrice, spotPrice, fundingRate, spread }

  // ── Feed price into pairs engine ────────────────────────────────────────────
  pairs.onPrice(data.pair, data.spotPrice);

  // ── Check exits on open pairs positions ────────────────────────────────────
  const openPositions = state.get('positions');
  for (const pos of openPositions) {
    if (pos.type !== 'pairs') continue;
    const exit = pairs.checkExit(pos);
    if (exit) await closePairsPosition(pos, exit.reason, exit.zScore);
  }

  // ── Check exits on funding positions ───────────────────────────────────────
  for (const pos of openPositions) {
    if (pos.type !== 'funding') continue;
    if (pos.pair !== data.pair) continue;

    const annualizedRate = data.fundingRate * 24 * 365 * 100;
    const spreadInverted = data.spread < -config.SPREAD_INVERSION_THRESHOLD;
    const rateTooLow     = annualizedRate < config.EXIT_RATE_THRESHOLD_PCT;
    const hitMaxDrawdown = tracker.drawdown(pos, data.perpPrice, data.spotPrice) > config.MAX_DRAWDOWN_PCT;
    const hitTakeProfit  = tracker.unrealizedPnl(pos, data.perpPrice, data.spotPrice) >= config.TAKE_PROFIT_USD;

    if (spreadInverted || rateTooLow || hitMaxDrawdown || hitTakeProfit) {
      const reason = spreadInverted ? 'SPREAD_INVERTED'
                   : rateTooLow     ? 'RATE_TOO_LOW'
                   : hitMaxDrawdown ? 'MAX_DRAWDOWN'
                   :                  'TAKE_PROFIT';
      await closePosition(pos, data, reason);
    }
  }

  // ── Scan for new pairs opportunities on every tick ──────────────────────────
  const slotsOpen = config.MAX_POSITIONS - state.get('positions').length;
  if (slotsOpen > 0) {
    const opportunities = pairs.scanForOpportunities();
    for (const opp of opportunities) {
      if (state.get('positions').length >= config.MAX_POSITIONS) break;
      // Don't double-enter same relationship
      const alreadyOpen = state.get('positions').some(p => p.type === 'pairs' && p.key === opp.key);
      if (!alreadyOpen && state.get('balance') >= config.TRADE_AMOUNT) {
        await openPairsPosition(opp);
        break; // one new position per tick max
      }
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
  const tier               = getTier(pair);

  // Tier-aware thresholds — all sourced from config
  const minRate   = tier === 1 ? config.MIN_RATE_T1 : tier === 2 ? config.MIN_RATE_T2 : config.MIN_RATE_T3;
  const maxSpread = tier === 1 ? 0.003 : tier === 2 ? 0.005 : 0.012;
  const minVol    = tier === 1 ? config.MIN_VOL_T1  : tier === 2 ? config.MIN_VOL_T2  : config.MIN_VOL_T3;

  if (annualizedFunding < minRate) {
    logger.warn('EVAL', `${pair} | SKIP: ${annualizedFunding.toFixed(2)}%/y < ${minRate}% min (T${tier})`);
    return null;
  }
  if (annualizedFunding > config.MAX_RATE) {
    logger.warn('EVAL', `${pair} | SKIP: ${annualizedFunding.toFixed(0)}%/y > ${config.MAX_RATE}% cap (manipulation risk)`);
    return null;
  }
  if (Math.abs(spread) > maxSpread) {
    logger.warn('EVAL', `${pair} | SKIP: spread ${(spread*100).toFixed(4)}% > ${(maxSpread*100).toFixed(2)}% max (T${tier})`);
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
    type: 'funding',
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

// ─── Open a pairs position ────────────────────────────────────────────────────
async function openPairsPosition(opp) {
  const { key, coinA, coinB, shortCoin, longCoin, zScore, divergence, currentRatio, mean, std } = opp;
  const halfAmount = config.TRADE_AMOUNT / 2;
  const entryFee   = config.TRADE_AMOUNT * 2 * config.TAKER_FEE;

  const position = {
    id:              `pairs-${key}-${Date.now()}`,
    type:            'pairs',
    key,
    coinA, coinB,
    shortCoin,
    longCoin,
    entryZScore:     zScore,
    entryRatio:      currentRatio,
    entryMean:       mean,
    entryStd:        std,
    entryShortPrice: pairs.latestPrice[shortCoin],
    entryLongPrice:  pairs.latestPrice[longCoin],
    amount:          config.TRADE_AMOUNT,
    entryFee,
    openedAt:        Date.now(),
    fundingCollected: 0, // pairs positions don't collect funding
  };

  const newBalance = state.get('balance') - entryFee;
  state.set('balance', newBalance);
  const positions = state.get('positions');
  positions.push(position);
  state.set('positions', positions);
  await state.save();

  logger.info('PAIRS', `📐 Opened pairs: short ${shortCoin} / long ${longCoin} | z=${zScore.toFixed(2)} | div=${(divergence*100).toFixed(3)}%`);

  await discord.send([
    '```diff',
    `+ PAIRS TRADE OPENED: ${shortCoin}↓ / ${longCoin}↑`,
    `  Z-Score    : ${zScore.toFixed(3)} (entry at ±${config.PAIRS_CONFIG.ENTRY_ZSCORE})`,
    `  Divergence : ${(divergence*100).toFixed(3)}%`,
    `  Ratio      : ${currentRatio.toFixed(6)} (mean: ${mean.toFixed(6)})`,
    `  Short $    : $${pairs.latestPrice[shortCoin].toFixed(4)}`,
    `  Long  $    : $${pairs.latestPrice[longCoin].toFixed(4)}`,
    `  Amount     : $${config.TRADE_AMOUNT} ($${halfAmount} each leg)`,
    `  Balance    : $${newBalance.toFixed(2)}`,
    `  Slots      : ${state.get('positions').length}/${config.MAX_POSITIONS}`,
    '```'
  ].join('\n'));
}

// ─── Close a pairs position ───────────────────────────────────────────────────
async function closePairsPosition(position, reason, currentZScore) {
  const unrealized  = pairs.unrealizedPnl(position);
  const exitFee     = position.amount * 2 * config.TAKER_FEE;
  const netPnl      = unrealized - exitFee;
  const newBalance  = state.get('balance') + position.amount + netPnl;
  const durationHrs = ((Date.now() - position.openedAt) / 3600000).toFixed(1);

  state.set('balance', newBalance);

  const positions = state.get('positions').filter(p => p.id !== position.id);
  state.set('positions', positions);

  const history = state.get('history');
  history.push({ ...position, closedAt: Date.now(), exitReason: reason, netPnl, exitZScore: currentZScore });
  state.set('history', history);
  await state.save();

  const allTimePnl = state.get('history').reduce((s, h) => s + h.netPnl, 0);
  logger.info('PAIRS', `📐 Closed pairs ${position.key} | ${reason} | PnL: $${netPnl.toFixed(2)}`);

  await discord.send([
    `\`\`\`${netPnl >= 0 ? 'diff' : 'fix'}`,
    `${netPnl >= 0 ? '+' : '-'} PAIRS CLOSED: ${position.shortCoin}↓/${position.longCoin}↑  [${reason}]`,
    `  Duration     : ${durationHrs}h`,
    `  Entry z      : ${position.entryZScore.toFixed(3)}`,
    `  Exit z       : ${currentZScore.toFixed(3)}`,
    `  Net PnL      : $${netPnl.toFixed(2)}`,
    `  All-time PnL : $${allTimePnl.toFixed(2)}`,
    `  Balance      : $${newBalance.toFixed(2)}`,
    `  Slots        : ${positions.length}/${config.MAX_POSITIONS}`,
    '```'
  ].join('\n'));
}

// ─── 30-minute pairs status update ───────────────────────────────────────────
let pairsReadyAlertSent = false;

async function sendPairsStatus() {
  const snapshot  = pairs.getStatusSnapshot();
  const positions = state.get('positions').filter(p => p.type === 'pairs');
  const balance   = state.get('balance');
  const minTicks  = config.PAIRS_CONFIG.MIN_HISTORY_TICKS;

  const warmingUp = snapshot.filter(r => r.ticks < minTicks);
  const ready     = snapshot.filter(r => r.ticks >= minTicks);
  const allReady  = warmingUp.length === 0;

  const lines = [
    '```',
    `📐 PAIRS STATUS  |  ${new Date().toUTCString()}`,
    `Balance: $${balance.toFixed(2)}  |  Open pairs: ${positions.length}`,
    allReady
      ? `Warmup: ✅ all ${snapshot.length} pairs ready`
      : `Warmup: ${ready.length}/${snapshot.length} ready — ${warmingUp.length} still collecting history`,
    '',
    `${'Pair'.padEnd(12)} ${'Ticks'.padEnd(8)} ${'Z-Score'.padEnd(10)} ${'Diverge'.padEnd(10)} ${'Signal'}`,
    '─'.repeat(60),
  ];

  for (const row of snapshot) {
    const progress = row.ticks < minTicks
      ? `${row.ticks}/${minTicks}`
      : '✅';
    lines.push(
      `${row.pair.padEnd(12)} ${progress.padEnd(8)} ${row.zScore.toString().padEnd(10)} ${row.diverge.padEnd(10)} ${row.signal}`
    );
  }

  if (positions.length > 0) {
    lines.push('');
    lines.push('OPEN PAIRS POSITIONS:');
    for (const pos of positions) {
      const pnl    = pairs.unrealizedPnl(pos);
      const ageHrs = ((Date.now() - pos.openedAt) / 3600000).toFixed(1);
      lines.push(`  ${pos.shortCoin}↓/${pos.longCoin}↑  z-entry:${pos.entryZScore.toFixed(2)}  PnL:$${pnl.toFixed(2)}  age:${ageHrs}h`);
    }
  }

  lines.push('```');
  await discord.send(lines.join('\n'));

  // Fire a one-time "all pairs ready" alert the first time warmup completes
  if (allReady && !pairsReadyAlertSent) {
    pairsReadyAlertSent = true;
    await discord.send([
      '```diff',
      '+ PAIRS ENGINE READY — all pairs have enough history',
      `  ${snapshot.length} relationships now active and scanning every second`,
      `  Entry threshold : z-score ≥ ${config.PAIRS_CONFIG.ENTRY_ZSCORE}`,
      `  Min divergence  : ${(config.PAIRS_CONFIG.MIN_DIVERGENCE * 100).toFixed(1)}%`,
      '  Bot will enter trades automatically when signals fire',
      '```'
    ].join('\n'));
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
