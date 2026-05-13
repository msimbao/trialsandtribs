'use strict';

// ── All coins involved in pairs relationships ──────────────────────────────
// Single source of truth — monitor, main, and pairs all derive from this
const RELATIONSHIPS = [
  ['BTC',   'ETH'],    // ~0.95 — L1 majors
  ['SOL',   'AVAX'],   // ~0.91 — L1 competitors
  ['BNB',   'OKB'],    // ~0.88 — exchange tokens
  ['MATIC', 'ARB'],    // ~0.87 — L2 tokens
  ['LINK',  'BAND'],   // ~0.85 — oracle tokens
  ['DOGE',  'SHIB'],   // ~0.89 — meme coins
  ['DOT',   'KSM'],    // ~0.92 — Polkadot ecosystem
  ['UNI',   'SUSHI'],  // ~0.86 — DEX tokens
];

const ALL_PAIRS_COINS = [...new Set(RELATIONSHIPS.flatMap(r => r))];

module.exports = {
  // ── Coins to stream — derived from relationships, never out of sync ───────
  PAIRS: ALL_PAIRS_COINS,

  // ── Trade settings ────────────────────────────────────────────────────────
  TRADE_AMOUNT:    2000,   // USD per position (split $1000 each leg)
  INITIAL_BALANCE: 10000,  // Starting paper balance
  MAX_POSITIONS:   5,      // Max concurrent open pairs positions

  // ── Fees (Binance) ────────────────────────────────────────────────────────
  MAKER_FEE: 0.0002,
  TAKER_FEE: 0.0004,

  // ── Pairs trading ─────────────────────────────────────────────────────────
  PAIRS_CONFIG: {
    relationships: RELATIONSHIPS,

    ENTRY_ZSCORE:       1.5,     // enter at 1.5 std deviations
    EXIT_ZSCORE:        0.3,     // exit when converged back near mean
    STOP_ZSCORE:        3.5,     // stop loss — divergence keeps widening
    MAX_HOLD_HOURS:     72,      // force exit after 3 days
    MIN_DIVERGENCE:     0.008,   // 0.8% min divergence to cover fees
    LOOKBACK_TICKS:     2880,    // 24h of ratio history at ~30s intervals
    MIN_HISTORY_TICKS:  120,     // need ~1h before trading
    STATUS_INTERVAL_MS: 1800000, // Discord status every 30 min
  },

  // ── Monitoring ────────────────────────────────────────────────────────────
  WS_RECONNECT_MS:      5000,
  REST_POLL_INTERVAL_MS: 30000,  // fallback REST poll for spot prices

  // ── Binance endpoints ─────────────────────────────────────────────────────
  BINANCE_REST_SPOT:  'api.binance.com',
  BINANCE_WS_SPOT:    'stream.binance.com',  // spot WS — no funding noise

  // ── Discord ───────────────────────────────────────────────────────────────
  DISCORD_WEBHOOK: 'https://discordapp.com/api/webhooks/1503490609728589825/m0eKSz4QsEGQaxIDEe1zgX-hO6e5OKUqEkb_cjzzENpnNyNTpNozjBX-DQOSrp-2hZKd',

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_DIR:   './logs',
  STATE_DIR: './state',
};
