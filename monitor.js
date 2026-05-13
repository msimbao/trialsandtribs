'use strict';

/**
 * monitor.js
 * Streams real-time spot prices for every coin in the pairs engine.
 * Uses Binance spot combined stream (miniTicker) — one connection, all coins.
 * Falls back to REST polling every 30s if the WS drops.
 *
 * On every price tick:
 *   1. Updates pairs engine via pairs.onPrice()
 *   2. Calls onTickCallback(coin, price) so main.js can scan for signals
 */

const tls    = require('tls');
const config = require('./config');
const logger = require('./logger');
const pairs  = require('./pairs');

let wsSocket       = null;
let tickHandler    = null;
let reconnectTimer = null;
let pollTimer      = null;
let stopped        = false;

// ─── Start ────────────────────────────────────────────────────────────────────
function start(onTickCallback) {
  tickHandler = onTickCallback;
  stopped     = false;
  connectWS();
  pollTimer = setInterval(restPoll, config.REST_POLL_INTERVAL_MS);
}

function stop() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pollTimer)      clearInterval(pollTimer);
  if (wsSocket)       { try { wsSocket.destroy(); } catch (_) {} }
  logger.info('MONITOR', 'Stopped');
}

// ─── WebSocket — Binance spot combined miniTicker stream ──────────────────────
// miniTicker gives: symbol, close price (c), 24h volume, etc. at ~1s intervals
function connectWS() {
  if (stopped) return;

  const streams = config.PAIRS
    .map(p => `${p.toLowerCase()}usdt@miniTicker`)
    .join('/');

  const host = config.BINANCE_WS_SPOT;
  const path = `/stream?streams=${streams}`;

  logger.info('MONITOR', `Connecting to Binance spot WS (${config.PAIRS.length} coins)`);

  wsSocket = tls.connect(443, host, { servername: host }, () => {
    const key = Buffer.from(Math.random().toString()).toString('base64');
    const handshake = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '\r\n',
    ].join('\r\n');
    wsSocket.write(handshake);
  });

  let buffer   = Buffer.alloc(0);
  let upgraded = false;

  wsSocket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!upgraded) {
      const str = buffer.toString();
      const headerEnd = str.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      if (!str.includes('101')) {
        logger.error('MONITOR', `WS upgrade failed: ${str.slice(0, 200)}`);
        scheduleReconnect();
        return;
      }
      upgraded = true;
      buffer = buffer.slice(headerEnd + 4);
      logger.info('MONITOR', '✅ WebSocket connected — streaming spot prices');
    }

    while (buffer.length > 2) {
      const frame = parseWSFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.consumed);

      if (frame.opcode === 0x8) { scheduleReconnect(); return; }
      if (frame.opcode === 0x9) { wsSocket.write(buildWSFrame(0xA, frame.payload)); continue; }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        handleMessage(frame.payload.toString());
      }
    }
  });

  wsSocket.on('error', (err) => {
    logger.error('MONITOR', `WS error: ${err.message}`);
    scheduleReconnect();
  });

  wsSocket.on('close', () => {
    if (!stopped) {
      logger.warn('MONITOR', 'WS closed — reconnecting');
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wsSocket) { try { wsSocket.destroy(); } catch (_) {} }
    connectWS();
  }, config.WS_RECONNECT_MS);
}

// ─── Handle incoming miniTicker message ──────────────────────────────────────
function handleMessage(raw) {
  try {
    const msg  = JSON.parse(raw);
    const data = msg.data || msg;

    // miniTicker shape: { e: '24hrMiniTicker', s: 'BTCUSDT', c: '67000.00', ... }
    if (!data.s || !data.c) return;

    const symbol = data.s;
    if (!symbol.endsWith('USDT')) return;

    const coin  = symbol.replace('USDT', '');
    const price = parseFloat(data.c);
    if (!coin || isNaN(price) || price <= 0) return;

    // Feed into pairs engine
    pairs.onPrice(coin, price);

    // Notify main
    if (tickHandler) tickHandler(coin, price);

  } catch (_) {
    // silently drop malformed frames
  }
}

// ─── REST fallback — ensures prices stay fresh if WS lags ────────────────────
async function restPoll() {
  const sourcer = require('./sourcer');
  for (const coin of config.PAIRS) {
    try {
      const spot = await sourcer.getSpotPrice(coin);
      if (!spot) continue;
      pairs.onPrice(coin, spot.price);
      if (tickHandler) tickHandler(coin, spot.price);
    } catch (_) {}
  }
}

// ─── WebSocket frame parser ───────────────────────────────────────────────────
function parseWSFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len      = buf[1] & 0x7f;
  let offset   = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = buf.readUInt32BE(6); offset = 10;
  }

  if (masked) offset += 4;
  if (buf.length < offset + len) return null;

  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const mask = buf.slice(offset - 4, offset);
    payload    = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  }

  return { opcode, payload, consumed: offset + len };
}

function buildWSFrame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

module.exports = { start, stop };
