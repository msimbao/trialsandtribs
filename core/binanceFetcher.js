// services/binanceFetcher.js
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');


class BinanceFetcher {
  constructor(cacheDir = 'binance_cache') {
    this.baseUrl = 'https://api.binance.com/api/v3/klines';
    this.cacheDir = cacheDir;
    this.ensureCacheDir();
  }

  async ensureCacheDir() {
    try { await fs.mkdir(this.cacheDir, { recursive: true }); } 
    catch (e) { console.error('Cache dir error:', e); }
  }

  getCacheFile(symbol, interval, start, end) {
    return path.join(this.cacheDir, `${symbol}_${interval}_${start}_${end}.json`);
  }

  async fetchKlines(symbol, interval, startTime, endTime, limit = 1000) {
    try {
      const { data } = await axios.get(this.baseUrl, {
        params: { symbol, interval, startTime, endTime, limit }
      });
      return data;
    } catch (e) { console.error('Fetch error:', e.message); return null; }
  }

  // Get latest candles for forward testing
  async getLatestCandles(symbol, interval, limit = 500) {
    try {
      const { data } = await axios.get(this.baseUrl, { params: { symbol, interval, limit } });
      return data.map(c => ({
        timestamp: new Date(c[0]), open: +c[1], high: +c[2], low: +c[3],
        close: +c[4], volume: +c[5], closeTime: new Date(c[6]),
        quoteVolume: +c[7], trades: +c[8], takerBuyBase: +c[9],
        takerBuyQuote: +c[10], isClosed: c[6] < Date.now()
      }));
    } catch (e) { console.error('Latest candles error:', e.message); return null; }
  }

  // Download historical data with caching
  async downloadHistoricalData(symbol, interval, startDate, endDate) {
    const cacheFile = this.getCacheFile(symbol, interval, startDate, endDate);
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      console.log(`Loaded cached: ${cacheFile}`);
      return JSON.parse(cached);
    } catch (e) {
      console.log(`Downloading ${symbol} ${interval} from ${startDate} to ${endDate}`);
    }

    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    const intervalMs = {
      '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
      '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000,
      '12h': 43200000, '1d': 86400000
    };
    const chunkSize = intervalMs[interval] * 1000;
    const allData = [];
    let currentStart = startTs;

    while (currentStart < endTs) {
      const currentEnd = Math.min(currentStart + chunkSize, endTs);
      const data = await this.fetchKlines(symbol, interval, currentStart, currentEnd);
      if (!data) break;
      allData.push(...data);
      console.log(`Downloaded ${data.length} candles. Total: ${allData.length}`);
      if (data.length < 1000) break;
      currentStart = data[data.length - 1][0] + intervalMs[interval];
      await new Promise(r => setTimeout(r, 200));
    }

    const df = allData.map(c => ({
      timestamp: new Date(c[0]), open: +c[1], high: +c[2], low: +c[3],
      close: +c[4], volume: +c[5], closeTime: new Date(c[6]),
      quoteVolume: +c[7], trades: +c[8], takerBuyBase: +c[9],
      takerBuyQuote: +c[10], isClosed: true
    }));

    await fs.writeFile(cacheFile, JSON.stringify(df, null, 2));
    console.log(`Cached to ${cacheFile}`);
    return df;
  }
}

module.exports = BinanceFetcher;
