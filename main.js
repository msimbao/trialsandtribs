'use strict';

/**
 * main.js
 * Statistical Pairs Trading Bot
 *
 * Strategy:
 *   Monitor historically correlated coin pairs.
 *   When the price ratio diverges > ENTRY_ZSCORE standard deviations,
 *   short the expensive coin and long the cheap one.
 *   Exit when the ratio converges back toward the mean (EXIT_ZSCORE),
 *   or stop-loss / time-limit / overshoot triggers.
 *
 * Exchange : Binance (paper trading — no real orders)
 * Data     : Binance spot WebSocket + REST fallback
 */

const monitor  = require('./monitor');
const discord  = require('./discord');
const logger   = require('./logger');
const state    = require('./state');
const config   = require('./config');
const pairs    = require('./pairs');
const tracker  = require('./tracker');
const sourcer  = require('./sourcer');

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  logger.info('BOT', '🚀 Pairs Trading Bot starting...');

  await state.load();
  logger.info('BOT', `💾 State restored — balance: $${state.get('balance').toFixed(2)}`);

  // Startup Discord ping
  const positions  = state.get('positions');
  const history    = state.get('history');
  const allTimePnl = history.reduce((s, h) => s + h.netPnl, 0);

  await discord.send([
    '```',
    '🟢 PAIRS TRADING BOT ONLINE',
    `Balance     : $${state.get('balance').toFixed(2)}`,
    `All-time PnL: $${allTimePnl.toFixed(2)} (${history.length} trades)`,
    `Open slots  : ${positions.length}/${config.MAX_POSITIONS}`,
    `Pairs       : ${config.PAIRS_CONFIG.relationships.length} relationships monitored`,
    `Entry z     : ±${config.PAIRS_CONFIG.ENTRY_ZSCORE}  |  Exit z: ±${config.PAIRS_CONFIG.EXIT_ZSCORE}`,
    `Min diverg  : ${(config.PAIRS_CONFIG.MIN_DIVERGENCE * 100).toFixed(1)}%`,
    `Mode        : Paper Trading`,
    `Time        : ${new Date().toISOString()}`,
    '```',
  ].join('\n'));

  if (positions.length > 0) {
    await discord.send(buildPositionsBlock(positions));
  }

  // Seed pairs engine with current prices so warmup starts immediately
  logger.info('BOT', `Seeding prices for ${config.PAIRS.length} coins...`);
  await Promise.all(config.PAIRS.map(async (coin) => {
    try {
      const spot = await sourcer.getSpotPrice(coin);
      if (spot) pairs.onPrice(coin, spot.price);
    } catch (_) {}
  }));
  logger.info('BOT', 'Price seed complete — starting WebSocket monitor');

  // Start real-time monitor — feeds pairs engine and calls onTick
  monitor.start(onTick);

  // Periodic pairs status to Discord every 30 minutes
  setInterval(sendPairsStatus, config.PAIRS_CONFIG.STATUS_INTERVAL_MS);

  // Send initial status immediately (shows warmup progress)
  await sendPairsStatus();
}

// ─── Real-time tick handler ───────────────────────────────────────────────────
// Called by monitor.js on every price update for any coin
async function onTick(coin, price) {
  // pairs.onPrice() is already called by monitor.js before this fires —
  // we only need to act on signals here

  // ── Check exits on all open positions ──────────────────────────────────────
  const openPositions = state.get('positions');
  for (const pos of openPositions) {
    // Only check the position if the updated coin is one of its two legs
    if (pos.shortCoin !== coin && pos.longCoin !== coin) continue;

    const exit = pairs.checkExit(pos);
    if (exit) {
      await closePosition(pos, exit.reason, exit.zScore);
    }
  }

  // ── Scan for new entries if slots are available ─────────────────────────────
  const slotsOpen = config.MAX_POSITIONS - state.get('positions').length;
  if (slotsOpen <= 0) return;

  const opportunities = pairs.scanForOpportunities();
  for (const opp of opportunities) {
    if (state.get('positions').length >= config.MAX_POSITIONS) break;

    // Don't double-enter the same relationship
    const alreadyOpen = state.get('positions').some(p => p.key === opp.key);
    if (alreadyOpen) continue;

    if (state.get('balance') < config.TRADE_AMOUNT) {
      logger.warn('BOT', 'Insufficient balance for new position');
      break;
    }

    await openPosition(opp);
    break; // one new position per tick max to avoid race conditions
  }
}

// ─── Open a pairs position ────────────────────────────────────────────────────
async function openPosition(opp) {
  const {
    key, coinA, coinB, shortCoin, longCoin,
    zScore, divergence, currentRatio, mean, std,
  } = opp;

  const entryFee = config.TRADE_AMOUNT * 2 * config.TAKER_FEE; // open both legs

  const position = {
    id:              `pairs-${key}-${Date.now()}`,
    key,
    coinA,
    coinB,
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
  };

  const newBalance = state.get('balance') - entryFee;
  state.set('balance', newBalance);

  const positions = state.get('positions');
  positions.push(position);
  state.set('positions', positions);
  await state.save();

  logger.info('OPEN', `📐 Opened: short ${shortCoin} / long ${longCoin} | z=${zScore.toFixed(2)} | div=${(divergence * 100).toFixed(3)}%`);

  await discord.send([
    '```diff',
    `+ PAIRS OPENED: ${shortCoin}↓ / ${longCoin}↑`,
    `  Z-Score    : ${zScore.toFixed(3)}  (threshold ±${config.PAIRS_CONFIG.ENTRY_ZSCORE})`,
    `  Divergence : ${(divergence * 100).toFixed(3)}%`,
    `  Ratio      : ${currentRatio.toFixed(6)}  (mean: ${mean.toFixed(6)}, std: ${std.toFixed(6)})`,
    `  Short leg  : ${shortCoin} @ $${pairs.latestPrice[shortCoin].toFixed(4)}`,
    `  Long leg   : ${longCoin} @ $${pairs.latestPrice[longCoin].toFixed(4)}`,
    `  Amount     : $${config.TRADE_AMOUNT} ($${config.TRADE_AMOUNT / 2} each leg)`,
    `  Entry fee  : $${entryFee.toFixed(4)}`,
    `  Balance    : $${newBalance.toFixed(2)}`,
    `  Slots      : ${state.get('positions').length}/${config.MAX_POSITIONS}`,
    '```',
  ].join('\n'));
}

// ─── Close a pairs position ───────────────────────────────────────────────────
async function closePosition(position, reason, currentZScore) {
  const unrealized  = tracker.unrealizedPnl(position);
  const exitFee     = position.amount * 2 * config.TAKER_FEE; // close both legs
  const netPnl      = unrealized - exitFee;
  const newBalance  = state.get('balance') + position.amount + netPnl;
  const durationH   = ((Date.now() - position.openedAt) / 3600000).toFixed(1);

  state.set('balance', newBalance);

  const positions = state.get('positions').filter(p => p.id !== position.id);
  state.set('positions', positions);

  const history = state.get('history');
  history.push({
    ...position,
    closedAt:     Date.now(),
    exitReason:   reason,
    exitZScore:   currentZScore,
    netPnl,
  });
  state.set('history', history);
  await state.save();

  const allTimePnl = state.get('history').reduce((s, h) => s + h.netPnl, 0);
  logger.info('CLOSE', `📐 Closed ${position.key} | ${reason} | PnL: $${netPnl.toFixed(2)}`);

  const sign = netPnl >= 0 ? '+' : '-';
  await discord.send([
    `\`\`\`${netPnl >= 0 ? 'diff' : 'fix'}`,
    `${sign} PAIRS CLOSED: ${position.shortCoin}↓/${position.longCoin}↑  [${reason}]`,
    `  Duration     : ${durationH}h`,
    `  Entry z      : ${position.entryZScore.toFixed(3)}`,
    `  Exit z       : ${currentZScore.toFixed(3)}`,
    `  Unrealized   : $${unrealized.toFixed(4)}`,
    `  Exit fee     : $${exitFee.toFixed(4)}`,
    `  Net PnL      : $${netPnl.toFixed(2)}`,
    `  All-time PnL : $${allTimePnl.toFixed(2)}`,
    `  Balance      : $${newBalance.toFixed(2)}`,
    `  Slots        : ${positions.length}/${config.MAX_POSITIONS}`,
    '```',
  ].join('\n'));
}

// ─── 30-minute pairs status update ───────────────────────────────────────────
let pairsReadyAlertSent = false;

async function sendPairsStatus() {
  const snapshot   = pairs.getStatusSnapshot();
  const positions  = state.get('positions');
  const history    = state.get('history');
  const balance    = state.get('balance');
  const allTimePnl = history.reduce((s, h) => s + h.netPnl, 0);
  const minTicks   = config.PAIRS_CONFIG.MIN_HISTORY_TICKS;

  const warmingUp = snapshot.filter(r => r.ticks < minTicks);
  const ready     = snapshot.filter(r => r.ticks >= minTicks);
  const allReady  = warmingUp.length === 0;

  const lines = [
    '```',
    `📐 PAIRS STATUS  |  ${new Date().toUTCString()}`,
    `Balance: $${balance.toFixed(2)}  |  PnL: $${allTimePnl.toFixed(2)}  |  Open: ${positions.length}/${config.MAX_POSITIONS}`,
    allReady
      ? `Warmup : ✅ all ${snapshot.length} pairs ready`
      : `Warmup : ${ready.length}/${snapshot.length} ready — ${warmingUp.length} still collecting history`,
    '',
    `${'Pair'.padEnd(12)} ${'Ticks'.padEnd(10)} ${'Z-Score'.padEnd(10)} ${'Diverge'.padEnd(10)} Signal`,
    '─'.repeat(62),
  ];

  for (const row of snapshot) {
    const progress = row.ticks < minTicks
      ? `${row.ticks}/${minTicks}`
      : '✅';
    lines.push(
      `${row.pair.padEnd(12)} ${progress.toString().padEnd(10)} ${row.zScore.toString().padEnd(10)} ${row.diverge.padEnd(10)} ${row.signal}`
    );
  }

  if (positions.length > 0) {
    lines.push('');
    lines.push('OPEN POSITIONS:');
    for (const pos of positions) {
      const pnl    = tracker.unrealizedPnl(pos);
      const ageH   = ((Date.now() - pos.openedAt) / 3600000).toFixed(1);
      const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
      lines.push(`  ${pos.shortCoin}↓/${pos.longCoin}↑  entry-z: ${pos.entryZScore.toFixed(2)}  PnL: ${pnlStr}  age: ${ageH}h`);
    }
  }

  lines.push('```');
  await discord.send(lines.join('\n'));

  // One-time "all pairs ready" alert
  if (allReady && !pairsReadyAlertSent) {
    pairsReadyAlertSent = true;
    await discord.send([
      '```diff',
      '+ PAIRS ENGINE READY — all relationships have sufficient history',
      `  ${snapshot.length} pairs active  |  scanning on every price tick`,
      `  Entry: z ≥ ±${config.PAIRS_CONFIG.ENTRY_ZSCORE}  |  Min divergence: ${(config.PAIRS_CONFIG.MIN_DIVERGENCE * 100).toFixed(1)}%`,
      `  Exit: z ≤ ±${config.PAIRS_CONFIG.EXIT_ZSCORE}  |  Stop: z ≥ ±${config.PAIRS_CONFIG.STOP_ZSCORE}  |  Max hold: ${config.PAIRS_CONFIG.MAX_HOLD_HOURS}h`,
      '```',
    ].join('\n'));
  }
}

// ─── Build open positions block ───────────────────────────────────────────────
function buildPositionsBlock(positions) {
  if (!positions.length) return '```\n📂 No open positions\n```';

  const reserved = positions.reduce((s, p) => s + p.amount, 0);
  const lines = [
    '```',
    `📂 OPEN POSITIONS  ${positions.length}/${config.MAX_POSITIONS} slots  |  $${reserved.toFixed(0)} reserved`,
    `${'Pair'.padEnd(16)} ${'Entry-z'.padEnd(10)} ${'PnL'.padEnd(10)} Age`,
    '─'.repeat(44),
  ];

  for (const pos of positions) {
    const pnl  = tracker.unrealizedPnl(pos);
    const ageH = ((Date.now() - pos.openedAt) / 3600000).toFixed(1);
    lines.push(
      `${(pos.shortCoin + '↓/' + pos.longCoin + '↑').padEnd(16)} ${pos.entryZScore.toFixed(3).padEnd(10)} ${'$' + pnl.toFixed(2).padEnd(9)} ${ageH}h`
    );
  }

  lines.push('```');
  return lines.join('\n');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info('BOT', `${signal} — saving state and shutting down`);
  monitor.stop();
  await state.save();

  const positions  = state.get('positions');
  const allTimePnl = state.get('history').reduce((s, h) => s + h.netPnl, 0);

  await discord.send([
    '```fix',
    '🔴 BOT OFFLINE',
    `Balance     : $${state.get('balance').toFixed(2)}`,
    `All-time PnL: $${allTimePnl.toFixed(2)}`,
    `Open slots  : ${positions.length}/${config.MAX_POSITIONS}`,
    `Signal      : ${signal}`,
    '```',
  ].join('\n'));

  if (positions.length > 0) await discord.send(buildPositionsBlock(positions));
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