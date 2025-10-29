# Setup Guide - Step by Step

This guide will walk you through setting up the trading bot from scratch to running your first backtest and paper trade.

## Prerequisites

- Node.js version 14 or higher
- npm (comes with Node.js)
- Basic command line knowledge
- Binance account (for testnet API keys)

## Step 1: Install Node.js

### Windows
1. Download from https://nodejs.org/
2. Run the installer
3. Verify installation:
   ```bash
   node --version
   npm --version
   ```

### Mac
```bash
# Using Homebrew
brew install node

# Verify
node --version
npm --version
```

### Linux
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version
npm --version
```

## Step 2: Download the Bot

```bash
# Clone or download the repository
git clone <repository-url> crypto-trading-bot
cd crypto-trading-bot

# Or if you downloaded a ZIP
unzip crypto-trading-bot.zip
cd crypto-trading-bot
```

## Step 3: Install Dependencies

```bash
npm install
```

This will install:
- axios (for API requests)
- dotenv (for environment variables)

## Step 4: Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit with your favorite text editor
nano .env
# or
code .env
# or
notepad .env
```

### For Backtesting Only
You can leave the API keys blank:

```bash
MODE=backtest
SYMBOL=BTCUSDT
INTERVAL=15m
INITIAL_CAPITAL=10000
LEVERAGE=1
STRATEGY=adaptive
START_DATE=2024-01-01
END_DATE=2024-12-31
```

### For Paper Trading
You'll need testnet API keys:

1. Go to https://testnet.binancefuture.com
2. Click "Generate HMAC_SHA256 Key"
3. Save your API Key and Secret Key
4. Add to `.env`:

```bash
BINANCE_API_KEY=your_testnet_api_key_here
BINANCE_API_SECRET=your_testnet_secret_here
USE_TESTNET=true
```

## Step 5: Test Your Installation

### Quick Test
```bash
# This should show the help message
node src/index.js
```

### Run Your First Backtest
```bash
npm run backtest
```

This will:
1. Download historical data from Binance
2. Cache it locally (for faster future runs)
3. Run the adaptive strategy
4. Show detailed results

**Expected output:**
```
======================================================================
BACKTEST MODE
======================================================================
Downloading BTCUSDT 15m from 2024-01-01 to 2024-12-31...
  Downloaded 1000 candles. Total: 1000
  ...
✓ Cached to binance_cache/BTCUSDT_15m_2024-01-01_2024-12-31.json

Running backtest: ADAPTIVE
...
✓ Backtest complete: 45 trades executed
```

## Step 6: Compare Strategies

```bash
npm run compare
```

This will test all strategies and show you which performs best.

## Step 7: Paper Trade (Optional)

### Setup Testnet
1. Visit https://testnet.binancefuture.com
2. Get free testnet USDT (button in top right)
3. Generate API keys
4. Add keys to `.env` file

### Start Paper Trading
```bash
npm run paper
```

**This will:**
- Connect to Binance testnet
- Show your testnet balance
- Start looking for trading signals
- Execute trades automatically (with testnet money)

Press Ctrl+C to stop and close positions.

## Common First-Time Issues

### Issue: "Cannot find module"
**Solution:**
```bash
# Delete and reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Issue: "Permission denied"
**Solution (Mac/Linux):**
```bash
sudo chmod +x src/index.js
```

### Issue: "API key invalid"
**Solution:**
- Double-check your API keys (no extra spaces)
- Make sure you're using TESTNET keys for paper trading
- Keys should be in quotes in `.env` file

### Issue: "No data downloaded"
**Solution:**
- Check your internet connection
- Binance may be rate limiting - wait a few minutes
- Try a shorter date range

### Issue: "Module not found: dotenv"
**Solution:**
```bash
npm install dotenv
```

## Configuration Tips

### Choosing a Symbol
Popular symbols with good liquidity:
- `BTCUSDT` - Bitcoin (most liquid)
- `ETHUSDT` - Ethereum
- `BNBUSDT` - Binance Coin
- `SOLUSDT` - Solana

### Choosing an Interval
- `5m`, `15m` - Scalping (many trades, requires attention)
- `1h`, `4h` - Swing trading (fewer trades, more relaxed)
- `1d` - Position trading (very few trades)

Start with `15m` or `1h` for learning.

### Choosing Initial Capital
For backtesting:
- Use realistic amounts ($1,000-$10,000)
- Match what you plan to trade with

For paper trading:
- Testnet gives you $100,000 USDT
- Set `INITIAL_CAPITAL` to what you actually plan to use

### Choosing Leverage
**Recommendation:**
- Backtesting: Try 1-3x first
- Paper trading: Use 1x until comfortable
- Live trading: NEVER exceed 3x as beginner

## Next Steps After Setup

### 1. Learn the Basics
```bash
# Run a simple backtest
npm run backtest

# Try different strategies
STRATEGY=momentum npm run backtest
STRATEGY=mean_reversion npm run backtest

# Compare all strategies
npm run compare
```

### 2. Experiment with Parameters
Edit `src/config/config.js` to adjust:
- Risk levels
- Position sizes
- Stop loss distances
- Indicator periods

### 3. Paper Trade
```bash
# Once comfortable with backtesting results
npm run paper

# Monitor for at least 2-4 weeks
# Track results in a spreadsheet
```

### 4. Analyze Results
Check the output files:
- `output/trades.json` - Trade history
- `output/equity_curve.json` - Capital over time
- `output/strategy_comparison.json` - Strategy rankings

### 5. Only Then Consider Live Trading
**Requirements before going live:**
- [ ] Profitable backtests (6-12 months)
- [ ] 2-4 weeks successful paper trading
- [ ] Understand all the code
- [ ] Set appropriate position sizes (1-5% of capital)
- [ ] Use 1-2x leverage maximum
- [ ] Have emergency stop procedures
- [ ] Can afford to lose the entire amount

## Project Structure Quick Reference

```
crypto-trading-bot/
├── src/
│   ├── config/config.js          ← Edit settings here
│   ├── core/                     ← Main engines
│   ├── indicators/               ← Technical analysis
│   ├── services/                 ← Binance API
│   ├── strategies/               ← Trading strategies
│   └── index.js                  ← Entry point
├── output/                       ← Results go here
├── binance_cache/                ← Cached data
├── .env                          ← Your configuration
└── package.json                  ← Dependencies
```

## Quick Commands Reference

```bash
# Backtest
npm run backtest

# Compare strategies
npm run compare

# Paper trade (testnet)
npm run paper

# Live trade (real money - DANGEROUS)
npm run live

# With custom parameters
SYMBOL=ETHUSDT LEVERAGE=2 npm run backtest
START_DATE=2024-06-01 END_DATE=2024-12-31 npm run backtest
STRATEGY=momentum npm run backtest
```

## Getting Help

### Check Logs
The bot prints detailed logs. Read them carefully:
- ✓ = Success
- ⚠️ = Warning
- ❌ = Error
- 🛡️ = Profit protection active

### Debug Mode
Add verbose logging:
```javascript
// In src/config/config.js
OUTPUT: {
  LOG_LEVEL: 'DEBUG'  // Change from 'INFO'
}
```

### Common Questions

**Q: How long should I backtest?**
A: Minimum 6 months, ideally 12+ months including different market conditions.

**Q: What win rate should I expect?**
A: 45-60% is realistic. Higher may be overfitted.

**Q: How much can I make?**
A: Realistic expectations: 10-30% annually with good risk management. Higher returns come with higher risk.

**Q: Can I run multiple symbols?**
A: Not yet in this version. Future feature.

**Q: Should I use high leverage?**
A: No. Start with 1-2x. High leverage increases liquidation risk.

## Safety Reminders

🔴 **NEVER:**
- Trade with borrowed money
- Use leverage you don't understand
- Skip paper trading
- Ignore warning signs
- Trade emotionally

🟢 **ALWAYS:**
- Start with backtesting
- Paper trade extensively
- Use stop losses
- Monitor positions
- Keep learning

---

**You're now ready to start! Begin with backtesting and take your time learning the system.**

For detailed usage, see [README.md](README.md)