# Crypto Trading Bot v2.0 - Modular Edition

A professional-grade cryptocurrency trading bot with backtesting, paper trading, and live trading capabilities. Features advanced risk management, multiple trading strategies, and dynamic profit protection.

## ⚠️ DISCLAIMER

**This software is for educational purposes only. Trading cryptocurrencies involves substantial risk of loss. The authors are not responsible for any financial losses incurred through the use of this software. Always start with paper trading and never risk more than you can afford to lose.**

## 🌟 Features

- **Multiple Trading Strategies**: Adaptive, Momentum, Mean Reversion, Pullback, Bear Market
- **Dynamic Profit Protection**: Two-tier trailing stops that lock in profits progressively
- **Regime Detection**: Automatically adapts to bull, bear, and ranging markets
- **Comprehensive Backtesting**: Test strategies on historical data with realistic slippage and fees
- **Paper Trading**: Practice on Binance testnet with no real money at risk
- **Live Trading**: Execute real trades on Binance Futures (use with extreme caution)
- **Risk Management**: Liquidation protection, position sizing, funding cost calculation
- **Detailed Analytics**: Sharpe ratio, max drawdown, win rate, regime-specific performance

## 📁 Project Structure

```
crypto-trading-bot/
├── src/
│   ├── config/
│   │   └── config.js                 # Central configuration
│   ├── core/
│   │   ├── backtestEngine.js        # Backtest simulation
│   │   ├── liveTrader.js            # Live trading engine
│   │   ├── metricsCalculator.js     # Performance metrics
│   │   └── riskManager.js           # Risk management
│   ├── indicators/
│   │   ├── indicators.js            # Technical indicators (ATR, RSI, EMA, etc.)
│   │   └── regimeDetector.js        # Market regime detection
│   ├── services/
│   │   ├── binanceFetcher.js        # Data fetching with caching
│   │   └── binanceTrader.js         # Order execution
│   ├── strategies/
│   │   └── strategies.js            # Trading strategy implementations
│   ├── utils/
│   │   └── stats.js                 # Statistical utilities
│   └── index.js                     # Main entry point
├── output/                           # Results and logs
├── binance_cache/                    # Cached historical data
├── .env.example                      # Environment variables template
├── package.json
└── README.md
```

## 🚀 Quick Start

### 1. Installation

```bash
# Clone the repository
git clone <repository-url>
cd crypto-trading-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### 2. Configuration

Edit `.env` file with your settings:

```bash
# For paper trading, get testnet API keys from:
# https://testnet.binancefuture.com

BINANCE_API_KEY=your_testnet_api_key
BINANCE_API_SECRET=your_testnet_secret
USE_TESTNET=true

# Trading parameters
SYMBOL=BTCUSDT
INTERVAL=15m
INITIAL_CAPITAL=10000
LEVERAGE=1
STRATEGY=adaptive
```

### 3. Run Backtest

Test your strategy on historical data:

```bash
npm run backtest
```

### 4. Compare Strategies

Find the best strategy for your market:

```bash
npm run compare
```

### 5. Paper Trade

Practice with testnet (no real money):

```bash
npm run paper
```

### 6. Live Trading (Advanced)

**⚠️ ONLY after thorough testing!**

```bash
npm run live
```

## 📊 Trading Strategies

### 1. Adaptive (Recommended)
Auto-switches tactics based on market regime:
- **Bull markets**: Buys pullbacks in uptrends
- **Bear markets**: Shorts rallies, catches oversold bounces
- **Ranging markets**: Mean reversion trading

### 2. Momentum
Trades breakouts and strong trends:
- Enters on new highs/lows with confirmation
- Best for trending markets
- Higher risk, higher reward

### 3. Mean Reversion
Buys oversold, sells overbought:
- Enters when RSI < 30 (long) or > 70 (short)
- Best for ranging markets
- Lower risk, consistent returns

### 4. Pullback
Buys dips in established trends:
- Waits for price to pull back to EMA in uptrend
- Momentum confirmation required
- Good risk/reward ratio

### 5. Bear Market
Aggressive short-selling strategy:
- Multiple short entry conditions
- Catches oversold bounces for longs
- Use only in confirmed bear markets

## 🛡️ Risk Management

### Dynamic Profit Protection

Two-tier trailing stop system:

1. **Pre-Profit Phase** (< 0.5 ATR profit):
   - Wide 2 ATR stop to avoid noise
   - Gives trade room to develop

2. **Post-Profit Phase** (> 0.5 ATR profit):
   - Progressive tightening:
     - 0.5+ ATR profit → 1.0 ATR trailing
     - 1.5+ ATR profit → 0.75 ATR trailing
     - 3.0+ ATR profit → 0.5 ATR trailing

### Position Sizing by Regime

- **Bull markets**: 50% of capital
- **Bear markets**: 30% of capital (more conservative)
- **Ranging markets**: 40% of capital

### Safety Limits

- Maximum drawdown: 30% (circuit breaker)
- Daily loss limit: 5%
- Maximum liquidations: 3 per session
- Liquidation distance check: Minimum 5%

## 📈 Performance Metrics

The bot calculates comprehensive metrics:

- **Return Metrics**: Total return, buy & hold comparison, outperformance
- **Trade Statistics**: Win rate, profit factor, avg win/loss
- **Risk Metrics**: Max drawdown, Sharpe ratio, volatility
- **Cost Analysis**: Slippage, funding costs, trading fees
- **Profit Protection**: Protected exits rate, avg max profit
- **Regime Performance**: Stats by bull/bear/range markets

## 🔧 Configuration Options

### Trading Parameters

```javascript
SYMBOL: 'BTCUSDT'           // Trading pair
INTERVAL: '15m'              // Candle timeframe
INITIAL_CAPITAL: 10000       // Starting capital (USDT)
LEVERAGE: 1                  // 1-125x (be careful!)
STRATEGY_MODE: 'adaptive'    // Strategy to use
```

### Risk Management

```javascript
PROFIT_THRESHOLD_ATR: 0.5    // When to activate profit protection
INITIAL_STOP_ATR: 2.0        // Wide stop before profit
PROFIT_TRAILING_ATR: 1.0     // Tight stop after profit

// Progressive tightening
PROFIT_TIERS: [
  { profitATR: 0.5, trailATR: 1.0 },
  { profitATR: 1.5, trailATR: 0.75 },
  { profitATR: 3.0, trailATR: 0.5 }
]
```

### Technical Indicators

```javascript
ATR_PERIOD: 14               // Volatility measurement
RSI_PERIOD: 14               // Momentum oscillator
EMA_FAST: 20                 // Short-term trend
EMA_MEDIUM: 50               // Medium-term trend
EMA_SLOW: 200                // Long-term trend
REGIME_LOOKBACK: 50          // Regime detection period
```

## 📖 Usage Examples

### Backtest Custom Date Range

```bash
START_DATE=2024-01-01 END_DATE=2024-12-31 npm run backtest
```

### Test Different Strategy

```bash
STRATEGY=momentum npm run backtest
```

### Paper Trade with Higher Leverage

```bash
LEVERAGE=3 npm run paper
```

### Backtest Different Symbol

```bash
SYMBOL=ETHUSDT npm run backtest
```

## 🔍 Understanding Results

### Reality Check Warnings

The bot includes reality checks for unrealistic backtest results:

- ⚠️ **Win rate > 70%**: Unusual for scalping, may be overfitted
- ⚠️ **Sharpe > 3**: Extremely rare in live trading
- ⚠️ **Max DD < 5%**: Unrealistic for crypto volatility
- ⚠️ **Profit factor > 3**: Rarely sustained long-term
- ⚠️ **Liquidations > 10%**: Very dangerous leverage usage
- ⚠️ **Funding > 20% of P&L**: Holding positions too long

### Interpreting Metrics

**Good Results:**
- Win rate: 45-60%
- Sharpe ratio: 1.0-2.5
- Max drawdown: 10-30%
- Profit factor: 1.5-2.5
- Protected exits: 30-60%

**Red Flags:**
- Too-perfect metrics (likely overfitted)
- High liquidation rate
- Excessive funding costs
- Negative Sharpe ratio
- Drawdown > 40%

## 🚨 Safety Guidelines

### Before Going Live

1. **Backtest thoroughly**
   - Test on at least 6-12 months of data
   - Try multiple market conditions
   - Run reality checks

2. **Paper trade extensively**
   - Minimum 2-4 weeks on testnet
   - Expect 20-30% worse performance than backtest
   - Validate win rate and drawdown

3. **Start small**
   - Use 1-5% of intended capital
   - Use 1-2x leverage maximum
   - Gradually scale up if profitable

4. **Monitor constantly**
   - Check positions daily
   - Review unexpected losses
   - Adjust parameters as needed

5. **Set hard limits**
   - Maximum daily loss
   - Maximum drawdown
   - Stop trading if limits hit

### Common Pitfalls

❌ **Don't:**
- Jump straight to live trading
- Use high leverage without experience
- Ignore reality check warnings
- Trade with money you can't afford to lose
- Set and forget without monitoring

✅ **Do:**
- Start with paper trading
- Use conservative position sizes
- Monitor performance metrics
- Keep detailed logs
- Stop trading when confused

## 🐛 Troubleshooting

### API Connection Issues

```bash
# Check your API keys are correct
# Ensure you're using testnet keys for paper trading
# Verify IP whitelist on Binance

# Test connection
node -e "const trader = require('./src/services/binanceTrader'); \
  new trader('key', 'secret', true).testConnection()"
```

### Cache Issues

```bash
# Clear cached data
rm -rf binance_cache/*

# Fetch fresh data
npm run backtest
```

### Missing Dependencies

```bash
# Reinstall all dependencies
rm -rf node_modules package-lock.json
npm install
```

### Module Errors

```bash
# Ensure Node.js version >= 14
node --version

# Update npm
npm install -g npm@latest
```

## 📚 API Reference

### BinanceFetcher

```javascript
const fetcher = new BinanceFetcher();

// Get latest candles
const candles = await fetcher.getLatestCandles('BTCUSDT', '15m', 100);

// Download historical data
const history = await fetcher.downloadHistoricalData(
  'BTCUSDT', '15m', '2024-01-01', '2024-12-31'
);
```

### BinanceTrader

```javascript
const trader = new BinanceTrader(apiKey, apiSecret, useTestnet);

// Initialize
await trader.testConnection();
await trader.setLeverage('BTCUSDT', 2);

// Place orders
await trader.marketOrder('BTCUSDT', 'BUY', 0.001);
await trader.stopLossOrder('BTCUSDT', 'SELL', 0.001, 45000);

// Manage positions
const position = await trader.getPosition('BTCUSDT');
await trader.closePosition('BTCUSDT');
```

### BacktestEngine

```javascript
const engine = new BacktestEngine();

// Run backtest
const { trades, equityCurve, signals } = engine.run(
  historicalData,
  'adaptive',
  true
);
```

### MetricsCalculator

```javascript
// Calculate metrics
const metrics = MetricsCalculator.calculate(trades, equityCurve, data);

// Print report
MetricsCalculator.printReport(metrics);

// Get warnings
const warnings = MetricsCalculator.realityCheck(metrics);
```

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests if applicable
4. Submit a pull request

## 📄 License

MIT License - See LICENSE file for details

## 🙏 Acknowledgments

- Binance API for market data and trading
- Technical analysis community for indicators
- Open source trading community

## 📞 Support

- **Issues**: Open a GitHub issue
- **Documentation**: Check this README and code comments
- **Testnet**: https://testnet.binancefuture.com

## 🔐 Security

- Never commit `.env` file to version control
- Keep API keys secret
- Use IP whitelist on Binance
- Enable 2FA on your Binance account
- Use API keys with minimal permissions
- Regularly rotate API keys

## 📊 Example Output

### Backtest Results
```
======================================================================
BACKTEST RESULTS
======================================================================

Initial Capital: $10,000
Final Capital: $12,450.32
Total Return: 24.50%
Buy & Hold: 15.20%
Outperformance: 9.30%

──────────────────────────────────────────────────────────────────────
TRADE STATISTICS
──────────────────────────────────────────────────────────────────────
Total Trades: 45
Wins: 28 | Losses: 17 | Liquidations: 0
Win Rate: 62.22%
Profit Factor: 2.15
Avg Win: $95.50 | Avg Loss: $-42.30
Avg Bars Held: 12.5

──────────────────────────────────────────────────────────────────────
RISK METRICS
──────────────────────────────────────────────────────────────────────
Max Drawdown: -15.30%
Sharpe Ratio: 1.85
Avg Slippage: $0.0023
Total Funding Costs: $125.50

──────────────────────────────────────────────────────────────────────
PROFIT PROTECTION ANALYSIS 🛡️
──────────────────────────────────────────────────────────────────────
Protected Exits: 18 (40.0%)
Avg Max Profit: 2.15 ATR
Measures how well the system locks in gains vs giving them back.

✅ Reality check passed - results appear reasonable
```

## 🎯 Roadmap

- [ ] Additional strategies (Grid, DCA, Arbitrage)
- [ ] Multiple timeframe analysis
- [ ] Machine learning signal enhancement
- [ ] Telegram/Discord notifications
- [ ] Web dashboard for monitoring
- [ ] Portfolio management across multiple pairs
- [ ] Advanced order types (Iceberg, TWAP)
- [ ] Backtesting optimization engine

---

**Remember: Past performance does not guarantee future results. Always practice proper risk management and never trade with money you cannot afford to lose.**