# Cash-and-Carry Arbitrage Bot

Delta-neutral funding rate arbitrage: **short perp + long spot** to collect funding payments.

## Zero dependencies — pure Node.js built-ins only

```
node >= 16.0.0
No npm install needed
```

## Start

```bash
node src/main.js          # normal mode
LOG_LEVEL=DEBUG node src/main.js  # verbose
```

## Architecture

```
src/
  main.js       → orchestrator, entry/exit logic, Discord reports
  config.js     → all tunable parameters
  sourcer.js    → Binance REST API (https, no fetch)
  monitor.js    → Binance WebSocket streams (tls, real-time)
  calculator.js → profit, spread, effective rate math
  tracker.js    → position PnL, drawdown, funding accumulation
  state.js      → atomic JSON persistence (survives restarts)
  discord.js    → webhook sender (https, rate-limited, auto-retry)
  logger.js     → console + rotating daily log files

logs/           → daily rotating log files (7-day retention)
state/          → bot_state.json + bot_state.backup.json
```

## How it works

1. **WebSocket** streams real-time mark price + funding rate from Binance every second
2. **REST fallback** polls spot prices every 30s
3. Every **hour** a full scan evaluates all pairs:
   - 30-day rolling average funding rate
   - Current spread between perp and spot
   - Net profit after fees and spread cost
4. **Enter** if: annualized funding > 15% AND spread < 0.5%
5. **Exit** if any of:
   - Annualized rate drops below 5%
   - Spread inverts past -0.3%
   - Drawdown exceeds 3% of position
   - Take profit hit ($50)
6. **Discord** gets notified on: open, close, hourly scan results, daily summary, errors

## Key config (src/config.js)

| Parameter | Default | Description |
|---|---|---|
| `TRADE_AMOUNT` | $1000 | Capital per trade |
| `LEVERAGE` | 2x | Futures leverage |
| `MIN_FUNDING_RATE_PCT` | 15% | Min annualized rate to enter |
| `EXIT_RATE_THRESHOLD_PCT` | 5% | Exit when rate falls below |
| `MAX_DRAWDOWN_PCT` | 3% | Stop-loss drawdown |
| `TAKE_PROFIT_USD` | $50 | Take profit target |

## State persistence

State is saved to `state/bot_state.json` every 5 minutes and on shutdown.  
If the file is corrupt on boot, falls back to `bot_state.backup.json`.  
Restart the bot at any time — open positions and balance are fully restored.

## Upgrading to live trading

Replace paper logic in `main.js` `openPosition()` / `closePosition()` with:
```js
// Binance API calls (requires HMAC-SHA256 signed requests)
// Spot: POST /api/v3/order
// Futures: POST /fapi/v1/order
```
Add `BINANCE_API_KEY` and `BINANCE_SECRET` to environment variables.
