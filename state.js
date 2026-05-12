'use strict';

/**
 * state.js
 * Persists bot state to disk — survives disconnects/restarts
 * State file: ./state/bot_state.json
 */

const fs     = require('fs');
const path   = require('path');
const config = require('./config');
const logger = require('./logger');

const STATE_FILE = path.join(config.STATE_DIR, 'bot_state.json');
const BACKUP_FILE = path.join(config.STATE_DIR, 'bot_state.backup.json');

// In-memory state
let _state = {
  balance:   config.INITIAL_BALANCE,
  positions: [],          // open paper positions
  history:   [],          // closed trade history
  startedAt: Date.now(),
  lastSave:  null,
};

// ─── Load from disk ────────────────────────────────────────────────────────────
async function load() {
  try {
    // Ensure state dir exists
    if (!fs.existsSync(config.STATE_DIR)) {
      fs.mkdirSync(config.STATE_DIR, { recursive: true });
    }

    if (!fs.existsSync(STATE_FILE)) {
      logger.info('STATE', 'No saved state found — starting fresh');
      await save();
      return;
    }

    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    _state = {
      ..._state,
      ...parsed,
    };

    logger.info('STATE', `Loaded state: balance=$${_state.balance.toFixed(2)}, open positions=${_state.positions.length}, trades=${_state.history.length}`);
  } catch (err) {
    // Try backup if main is corrupt
    if (fs.existsSync(BACKUP_FILE)) {
      logger.warn('STATE', `Main state corrupt, trying backup: ${err.message}`);
      try {
        const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
        _state = { ..._state, ...JSON.parse(raw) };
        logger.info('STATE', 'Loaded from backup');
      } catch (backupErr) {
        logger.error('STATE', `Backup also corrupt: ${backupErr.message}. Starting fresh.`);
      }
    } else {
      logger.error('STATE', `Failed to load state: ${err.message}. Starting fresh.`);
    }
  }
}

// ─── Save to disk (atomic write via tmp file) ──────────────────────────────────
async function save() {
  try {
    if (!fs.existsSync(config.STATE_DIR)) {
      fs.mkdirSync(config.STATE_DIR, { recursive: true });
    }

    _state.lastSave = Date.now();
    const json = JSON.stringify(_state, null, 2);
    const tmpFile = STATE_FILE + '.tmp';

    // Write to tmp first (atomic swap)
    fs.writeFileSync(tmpFile, json, 'utf8');

    // Rotate backup
    if (fs.existsSync(STATE_FILE)) {
      fs.copyFileSync(STATE_FILE, BACKUP_FILE);
    }

    // Promote tmp to main
    fs.renameSync(tmpFile, STATE_FILE);
    logger.debug('STATE', 'State saved to disk');
  } catch (err) {
    logger.error('STATE', `Failed to save state: ${err.message}`);
  }
}

// ─── Get/Set ───────────────────────────────────────────────────────────────────
function get(key) {
  return _state[key];
}

function set(key, value) {
  _state[key] = value;
}

// Auto-save every 5 minutes
setInterval(save, 5 * 60 * 1000);

module.exports = { load, save, get, set };
