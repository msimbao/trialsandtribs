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
  MIN_FUNDING_RATE_PCT: 5,      // Global pre-filter — tier thresholds applied in evaluatePair

  // Tier-aware rate minimums (annualized %)
  MIN_RATE_T1: 10,   // BTC, ETH
  MIN_RATE_T2: 15,   // BNB, SOL, XRP etc
  MIN_RATE_T3: 20,   // everything else — sized for $2000 trades

  // Tier-aware volume minimums (24h USD)
  MIN_VOL_T1:  0,        // BTC/ETH always liquid
  MIN_VOL_T2:  50e6,     // $50M/day
  MIN_VOL_T3:  5e6,      // $5M/day — plenty for $2000 position

  // Manipulation cap
  MAX_RATE:    150,       // ignore anything above 150% annualized

  // ── Exit conditions ───────────────────────────────────────────────────────
  EXIT_RATE_THRESHOLD_PCT:     5,     // Exit if annualized rate drops below (%)
  SPREAD_INVERSION_THRESHOLD:  0.003, // Exit if spread inverts past -0.3%
  MAX_DRAWDOWN_PCT:            3,     // Exit if position loses >3% of amount
  TAKE_PROFIT_USD:             50,    // Take profit at $50 unrealized PnL

  // ── Monitoring ────────────────────────────────────────────────────────────
  SCAN_INTERVAL_MS: 3600000,          // Full scan every 1 hour
  WS_RECONNECT_MS:  5000,             // WebSocket reconnect delay

  // ── Pairs trading ─────────────────────────────────────────────────────────
  PAIRS_CONFIG: {
    relationships: [
      ['BTC',   'ETH'],    // ~0.95 — L1 majors
      ['SOL',   'AVAX'],   // ~0.91 — L1 competitors
      ['BNB',   'OKB'],    // ~0.88 — exchange tokens
      ['MATIC', 'ARB'],    // ~0.87 — L2 tokens
      ['LINK',  'BAND'],   // ~0.85 — oracle tokens
      ['DOGE',  'SHIB'],   // ~0.89 — meme coins
      ['DOT',   'KSM'],    // ~0.92 — Polkadot ecosystem
      ['UNI',   'SUSHI'],  // ~0.86 — DEX tokens
    ],
    ENTRY_ZSCORE:       1.5,   // enter at 1.5 std deviations
    EXIT_ZSCORE:        0.3,   // exit when converged back near mean
    STOP_ZSCORE:        3.5,   // stop loss — divergence extreme
    MAX_HOLD_HOURS:     72,    // force exit after 3 days
    MIN_DIVERGENCE:     0.008, // 0.8% min divergence to cover fees
    LOOKBACK_TICKS:     2880,  // 24h of history at 30s intervals
    MIN_HISTORY_TICKS:  120,   // need 1h of history before trading
    STATUS_INTERVAL_MS: 1800000, // Discord pairs status every 30 minutes
  },

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
