'use strict';

/**
 * discord.js
 * Sends messages to Discord via native https — no node-fetch, no axios
 * Handles rate limiting with automatic retry
 */

const https  = require('https');
const config = require('./config');
const logger = require('./logger');

const WEBHOOK_URL = new URL(config.DISCORD_WEBHOOK);
const RATE_LIMIT_DELAY = 1100; // ms between messages to avoid 429

let lastSent = 0;

// ─── Send a message ────────────────────────────────────────────────────────────
async function send(content, retries = 3) {
  // Rate limit guard: space out messages
  const now   = Date.now();
  const delta = now - lastSent;
  if (delta < RATE_LIMIT_DELAY) {
    await sleep(RATE_LIMIT_DELAY - delta);
  }

  const body = JSON.stringify({ content: String(content).slice(0, 2000) });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const statusCode = await post(body);

      if (statusCode === 204) {
        lastSent = Date.now();
        return true;
      }

      if (statusCode === 429) {
        logger.warn('DISCORD', `Rate limited (attempt ${attempt}/${retries}) — waiting 2s`);
        await sleep(2000 * attempt);
        continue;
      }

      logger.warn('DISCORD', `Unexpected status ${statusCode} (attempt ${attempt}/${retries})`);
      await sleep(1000);
    } catch (err) {
      logger.error('DISCORD', `Send error (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) await sleep(1500);
    }
  }

  logger.error('DISCORD', 'Failed to send message after all retries');
  return false;
}

// ─── HTTPS POST ────────────────────────────────────────────────────────────────
function post(body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: WEBHOOK_URL.hostname,
      path:     WEBHOOK_URL.pathname + WEBHOOK_URL.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'ArbitrageBot/1.0',
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      // Drain the body (required to reuse socket)
      res.resume();
      resolve(res.statusCode);
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Discord request timeout')); });
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Send an embed-style table as a code block ────────────────────────────────
async function sendTable(title, rows) {
  if (!rows.length) return;

  const headers = Object.keys(rows[0]);
  const widths  = headers.map(h =>
    Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length))
  );

  const fmt  = row => headers.map((h, i) => String(row[h] ?? '').padEnd(widths[i])).join('  ');
  const sep  = widths.map(w => '─'.repeat(w)).join('  ');
  const head = headers.map((h, i) => h.padEnd(widths[i])).join('  ');

  const lines = ['```', title, sep, head, sep, ...rows.map(fmt), '```'];
  await send(lines.join('\n'));
}

module.exports = { send, sendTable };
