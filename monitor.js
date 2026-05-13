'use strict';

/**
 * monitor.js
 * WebSocket streams for real-time price + funding rate updates
 * Uses Binance combined stream for perp mark price (includes funding rate)
 * Falls back to REST polling if WS drops
 */

const net    = require('net');
const tls    = require('tls');
const config = require('./config');
const logger = require('./logger');
const calculator = require('./calculator');

let wsSocket    = null;
let tickHandler = null;
let reconnectTimer = null;
let stopped     = false;

// Latest snapshot per pair { perpPrice, spotPrice, fundingRate }
const snapshot = {};

// ─── Start monitoring ─────────────────────────────────────────────────────────
function start(onTickCallback) {
  tickHandler = onTickCallback;
  stopped     = false;
  connectWS();

  // Fallback REST poll every 30s for pairs not covered by WS
  setInterval(restFallbackPoll, 30000);
}

function stop() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (wsSocket) { try { wsSocket.destroy(); } catch (_) {} }
  logger.info('MONITOR', 'WebSocket monitor stopped');
}

// ─── WebSocket connection ─────────────────────────────────────────────────────
function connectWS() {
  if (stopped) return;

  // Subscribe to markPrice stream for all pairs (includes fundingRate, every 1s/3s)
  const streams = config.PAIRS.map(p => `${p.toLowerCase()}usdt@markPrice@1s`).join('/');
  const path    = `/stream?streams=${streams}`;

  logger.info('MONITOR', `Connecting to Binance WS: ${config.BINANCE_WS_FUTURES}${path}`);

  wsSocket = tls.connect(443, config.BINANCE_WS_FUTURES, { servername: config.BINANCE_WS_FUTURES }, () => {
    // Send HTTP Upgrade request
    const handshake = [
      `GET ${path} HTTP/1.1`,
      `Host: ${config.BINANCE_WS_FUTURES}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${Buffer.from(Math.random().toString()).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '\r\n'
    ].join('\r\n');

    wsSocket.write(handshake);
  });

  let buffer = Buffer.alloc(0);
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
      logger.info('MONITOR', '✅ WebSocket connected to Binance');
    }

    // Parse WebSocket frames
    while (buffer.length > 2) {
      const frame = parseWSFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.consumed);
      if (frame.opcode === 0x8) { // close
        logger.warn('MONITOR', 'Server sent close frame');
        scheduleReconnect();
        return;
      }
      if (frame.opcode === 0x9) { // ping → pong
        wsSocket.write(buildWSFrame(0xA, frame.payload));
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) { // text/binary
        handleStreamMessage(frame.payload.toString());
      }
    }
  });

  wsSocket.on('error', (err) => {
    logger.error('MONITOR', `WS error: ${err.message}`);
    scheduleReconnect();
  });

  wsSocket.on('close', () => {
    if (!stopped) {
      logger.warn('MONITOR', 'WS connection closed — scheduling reconnect');
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

// ─── Parse incoming stream message ────────────────────────────────────────────
function handleStreamMessage(raw) {
  try {
    const msg  = JSON.parse(raw);
    const data = msg.data || msg;

    // markPrice stream data shape: { e, E, s, p (mark price), r (funding rate), T }
    if (!data.s || data.p === undefined) return;

    const symbol = data.s;  // e.g. BTCUSDT
    const pair   = symbol.replace('USDT', '');
    const perpPrice  = parseFloat(data.p);
    const fundingRate = parseFloat(data.r || 0) / 8; // 8h → 1h

    if (!snapshot[pair]) snapshot[pair] = {};
    snapshot[pair].perpPrice   = perpPrice;
    snapshot[pair].fundingRate = fundingRate;
    snapshot[pair].lastWS      = Date.now();

    // Only emit tick if we also have a spot price
    if (snapshot[pair].spotPrice) {
      emitTick(pair);
    }
  } catch (err) {
    // silently ignore malformed frames
  }
}

// ─── REST fallback to fill in spot prices ─────────────────────────────────────
async function restFallbackPoll() {
  const sourcer = require('./sourcer');
  const pairs   = require('./pairs');

  // Build combined list: funding pairs + pairs trading coins
  const allCoins = new Set([
    ...config.PAIRS,
    ...config.PAIRS_CONFIG.relationships.flatMap(r => r),
  ]);

  for (const pair of allCoins) {
    try {
      const spot = await sourcer.getSpotPrice(pair);
      if (!spot) continue;

      // Update snapshot for funding rate positions
      if (!snapshot[pair]) snapshot[pair] = {};
      snapshot[pair].spotPrice = spot.price;
      if (snapshot[pair].perpPrice) emitTick(pair);

      // Feed spot price into pairs engine
      pairs.onPrice(pair, spot.price);
    } catch (_) {}
  }
}

// ─── Emit tick to main ────────────────────────────────────────────────────────
function emitTick(pair) {
  if (!tickHandler) return;
  const s = snapshot[pair];
  if (!s.perpPrice || !s.spotPrice) return;

  const spread = calculator.spread(s.perpPrice, s.spotPrice);
  tickHandler({ pair, perpPrice: s.perpPrice, spotPrice: s.spotPrice, fundingRate: s.fundingRate || 0, spread });
}

// ─── WebSocket frame parser ───────────────────────────────────────────────────
function parseWSFrame(buf) {
  if (buf.length < 2) return null;
  const fin    = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len      = buf[1] & 0x7f;
  let offset   = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    // Avoid BigInt — messages won't be >4GB, read only low 32 bits
    len = buf.readUInt32BE(6);
    offset = 10;
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

module.exports = { start, stop, snapshot };
