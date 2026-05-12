'use strict';

module.exports = {
  // ── Pairs to monitor ──────────────────────────────────────────────────────
  PAIRS: ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'XRP', 'LTC', 'LINK'],

  // ── Trade settings ────────────────────────────────────────────────────────
  TRADE_AMOUNT:    2000,   // USD per position (INITIAL_BALANCE / MAX_POSITIONS)
  LEVERAGE:        2,      // Futures leverage
  INITIAL_BALANCE: 10000,  // Starting paper balance
  MAX_POSITIONS:   5,      // Max concurrent open positions

  // ── Fees (Binance) ────────────────────────────────────────────────────────
  MAKER_FEE:  0.0002,      // 0.02%
  TAKER_FEE:  0.0004,      // 0.04%

  // ── Entry filters ─────────────────────────────────────────────────────────
  MIN_FUNDING_RATE_PCT: 5,     // TEMP: lowered to confirm bot is working — raise to 15 for real trading
  MAX_SPREAD_PCT:       0.5,   // Max abs spread between perp and spot (%)

  // ── Exit conditions ───────────────────────────────────────────────────────
  EXIT_RATE_THRESHOLD_PCT:     5,     // Exit if annualized rate drops below (%)
  SPREAD_INVERSION_THRESHOLD:  0.003, // Exit if spread inverts past -0.3%
  MAX_DRAWDOWN_PCT:            3,     // Exit if position loses >3% of amount
  TAKE_PROFIT_USD:             50,    // Take profit at $50 unrealized PnL

  // ── Monitoring ────────────────────────────────────────────────────────────
  SCAN_INTERVAL_MS: 3600000,          // Full scan every 1 hour
  WS_RECONNECT_MS:  5000,             // WebSocket reconnect delay

  // ── Binance endpoints ─────────────────────────────────────────────────────
  BINANCE_REST_FUTURES: 'fapi.binance.com',
  BINANCE_REST_SPOT:    'api.binance.com',
  BINANCE_WS_FUTURES:   'fstream.binance.com',

  // ── Discord ───────────────────────────────────────────────────────────────
  DISCORD_WEBHOOK: 'https://discordapp.com/api/webhooks/1503490609728589825/m0eKSz4QsEGQaxIDEe1zgX-hO6e5OKUqEkb_cjzzENpnNyNTpNozjBX-DQOSrp-2hZKd',

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_DIR:   './logs',
  STATE_DIR: './state',
};
