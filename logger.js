'use strict';

/**
 * logger.js
 * Writes logs to console + rotating daily log files
 * Log dir: ./logs/
 */

const fs     = require('fs');
const path   = require('path');
const config = require('./config');

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = process.env.LOG_LEVEL ? LEVELS[process.env.LOG_LEVEL.toUpperCase()] : LEVELS.INFO;

// Ensure log dir
if (!fs.existsSync(config.LOG_DIR)) {
  fs.mkdirSync(config.LOG_DIR, { recursive: true });
}

let currentDate = '';
let logStream   = null;

function getStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDate) {
    if (logStream) logStream.end();
    currentDate = today;
    const file = path.join(config.LOG_DIR, `bot_${today}.log`);
    logStream   = fs.createWriteStream(file, { flags: 'a' });

    // Clean up logs older than 7 days
    pruneOldLogs(7);
  }
  return logStream;
}

function pruneOldLogs(keepDays) {
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    fs.readdirSync(config.LOG_DIR).forEach(f => {
      const fp = path.join(config.LOG_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    });
  } catch (_) {}
}

function write(level, module, message) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const ts      = new Date().toISOString();
  const padded  = level.padEnd(5);
  const line    = `[${ts}] [${padded}] [${module.padEnd(8)}] ${message}`;

  // Colorize console output
  const colors  = { DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
  const reset   = '\x1b[0m';
  console.log(`${colors[level] || ''}${line}${reset}`);

  // Write to file (no color codes)
  try {
    getStream().write(line + '\n');
  } catch (_) {}
}

module.exports = {
  debug: (m, msg) => write('DEBUG', m, msg),
  info:  (m, msg) => write('INFO',  m, msg),
  warn:  (m, msg) => write('WARN',  m, msg),
  error: (m, msg) => write('ERROR', m, msg),
};
