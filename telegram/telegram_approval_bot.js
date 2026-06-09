#!/usr/bin/env node
'use strict';

/**
 * telegram_approval_bot.js
 * Paper-only Telegram approval relay for MoneyMaker / BTC Oracle.
 *
 * SAFETY GUARANTEES:
 * - Does not import live_adapter_polymarket.js
 * - Does not read .env.live.secrets
 * - Does not submit/cancel/replace orders
 * - Does not enable live trading
 * - Only reads intent/signal files, sends Telegram messages, and writes decisions/logs
 *
 * Requires Node >= 18 for global fetch.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.0';

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function boolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function appendNdjson(filePath, obj) {
  ensureFile(filePath);
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); }
    catch (e) { out.push({ __parse_error: e.message, __raw: t }); }
  }
  return out;
}

function shortId(s, n = 6) {
  s = String(s || '');
  if (s.length <= n * 2 + 3) return s;
  return `${s.slice(0, n)}...${s.slice(-n)}`;
}

function hashIntent(obj) {
  const stable = [
    obj.intent_id || obj.id || '',
    obj.timestamp || '',
    obj.source || '',
    obj.strategy || '',
    obj.type || '',
    obj.token_id || obj.tokenId || '',
    obj.side || obj.suggested_side || obj.direction || obj.suggested_action || '',
    obj.price || obj.limit_price || '',
    obj.size_usd || obj.sizeUsd || obj.suggested_max_paper_usd || '',
    obj.action || ''
  ].join('|');
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function toIntent(raw, sourcePath) {
  let side = raw.side || raw.suggested_side || '';
  if (!side && raw.suggested_action) {
    if (String(raw.suggested_action).includes('BUY')) side = 'BUY';
    else if (String(raw.suggested_action).includes('SELL')) side = 'SELL';
  }
  if (!side && raw.direction) side = 'BUY';
  side = String(side || 'UNKNOWN').toUpperCase();

  const tokenId = raw.token_id || raw.tokenId || raw.asset_id || raw.assetId || raw.clobTokenId || '';
  const price = raw.price ?? raw.limit_price ?? raw.book_after_persistence?.best_ask ?? raw.book_at_trigger?.best_ask ?? null;
  const sizeUsd = raw.size_usd ?? raw.sizeUsd ?? raw.suggested_max_paper_usd ?? raw.max_size_usd ?? 1;
  const confidence = raw.confidence ?? raw.consensusScore ?? raw.score ?? null;

  const intent = {
    intent_id: raw.intent_id || raw.id || `intent_${hashIntent(raw)}`,
    timestamp: raw.timestamp || nowIso(),
    expires_at: raw.expires_at || raw.expiresAt || null,
    source: sourcePath.includes('external_signal') ? 'BTC_ORACLE' : (raw.source || raw.strategy || raw.type || 'MONEYMAKER'),
    strategy: raw.strategy || raw.type || raw.action || 'UNKNOWN',
    action: raw.action || raw.suggested_action || null,
    interrupt_level: raw.interrupt_level || null,
    token_id: String(tokenId || ''),
    market_id: raw.market_id || raw.marketId || raw.conditionId || null,
    side,
    price: price === null || price === undefined ? null : Number(price),
    size_usd: Number(sizeUsd || 0),
    confidence: confidence === null || confidence === undefined ? null : Number(confidence),
    reason: raw.reason || raw.message || raw.suggested_action || raw.type || 'Trade approval request',
    route: raw.route || raw.routeMode || null,
    raw_source_path: sourcePath,
    raw_hash: hashIntent(raw),
    raw
  };

  if (!intent.intent_id) intent.intent_id = `intent_${intent.raw_hash}`;
  return intent;
}

function isExpired(intent) {
  if (!intent.expires_at) return false;
  const t = Date.parse(intent.expires_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() > t;
}

function isActionableIntent(intent, config) {
  if (!intent || !intent.intent_id) return false;
  if (isExpired(intent)) return false;
  if (!intent.token_id && config.requireTokenId) return false;

  if (!config.alertAll) {
    const src = String(intent.raw_source_path || '');
    const lvl = String(intent.interrupt_level || '');
    const action = String(intent.action || '');
    const strategy = String(intent.strategy || '');

    const isBtcSignal = src.includes('external_signal') && (
      lvl.includes('PRIORITY') || lvl.includes('HARD') || action.includes('TELEGRAM') || strategy.includes('BTC_TEMPORAL')
    );
    const isTradeIntent = src.includes('trade_intents') || src.includes('sniper_route');
    if (!isBtcSignal && !isTradeIntent) return false;
  }
  return true;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatIntentMessage(intent) {
  const lines = [];
  lines.push('🚨 <b>Trade Approval Request</b>');
  lines.push('');
  lines.push(`<b>Source:</b> ${escapeHtml(intent.source)}`);
  lines.push(`<b>Strategy:</b> ${escapeHtml(intent.strategy)}`);
  if (intent.interrupt_level) lines.push(`<b>Level:</b> ${escapeHtml(intent.interrupt_level)}`);
  lines.push(`<b>Action:</b> ${escapeHtml(intent.action || intent.side)}`);
  lines.push(`<b>Side:</b> ${escapeHtml(intent.side)}`);
  lines.push(`<b>Token:</b> <code>${escapeHtml(shortId(intent.token_id, 8))}</code>`);
  if (intent.market_id) lines.push(`<b>Market:</b> <code>${escapeHtml(shortId(intent.market_id, 8))}</code>`);
  if (Number.isFinite(intent.price)) lines.push(`<b>Price:</b> $${intent.price.toFixed(3)}`);
  if (Number.isFinite(intent.size_usd)) lines.push(`<b>Max Size:</b> $${intent.size_usd.toFixed(2)}`);
  if (Number.isFinite(intent.confidence)) lines.push(`<b>Confidence:</b> ${intent.confidence.toFixed(3)}`);
  if (intent.route) lines.push(`<b>Route:</b> ${escapeHtml(intent.route)}`);
  if (intent.expires_at) lines.push(`<b>Expires:</b> ${escapeHtml(intent.expires_at)}`);
  lines.push('');
  lines.push(`<b>Reason:</b> ${escapeHtml(intent.reason)}`);
  lines.push('');
  lines.push(`<code>${escapeHtml(intent.intent_id)}</code>`);
  lines.push('');
  lines.push('Safety: paper approval only. This bot does not execute trades.');
  return lines.join('\n');
}

async function telegramApi(config, method, payload) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`${method} failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function sendApprovalMessage(config, state, intent) {
  const callbackId = crypto.createHash('sha256').update(intent.intent_id + '|' + intent.raw_hash).digest('hex').slice(0, 24);
  state.callbacks[callbackId] = { intent, created_at: nowIso() };

  const replyMarkup = { inline_keyboard: [[
    { text: '✅ Approve', callback_data: `APPROVE:${callbackId}` },
    { text: '❌ Deny', callback_data: `DENY:${callbackId}` }
  ]] };

  const data = await telegramApi(config, 'sendMessage', {
    chat_id: config.telegramChatId,
    text: formatIntentMessage(intent),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });

  state.sent[intent.intent_id] = {
    sent_at: nowIso(),
    callback_id: callbackId,
    telegram_message_id: data.result?.message_id || null,
    raw_hash: intent.raw_hash
  };

  appendNdjson(config.eventsPath, {
    timestamp: nowIso(),
    type: 'TELEGRAM_APPROVAL_SENT',
    intent_id: intent.intent_id,
    callback_id: callbackId,
    source: intent.source,
    token_id: intent.token_id,
    side: intent.side,
    price: intent.price,
    size_usd: intent.size_usd,
    telegram_message_id: data.result?.message_id || null
  });
  saveState(config, state);
}

function loadState(config) {
  if (!fs.existsSync(config.statePath)) return { version: VERSION, sent: {}, callbacks: {}, last_update_id: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
    return { version: parsed.version || VERSION, sent: parsed.sent || {}, callbacks: parsed.callbacks || {}, last_update_id: Number(parsed.last_update_id || 0) };
  } catch { return { version: VERSION, sent: {}, callbacks: {}, last_update_id: 0 }; }
}

function saveState(config, state) { fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2), 'utf8'); }

function decisionRecord(action, callbackId, cb, update) {
  const intent = cb.intent;
  return {
    timestamp: nowIso(),
    type: 'TELEGRAM_APPROVAL_DECISION',
    decision: action === 'APPROVE' ? 'APPROVED' : 'DENIED',
    intent_id: intent.intent_id,
    callback_id: callbackId,
    source: intent.source,
    strategy: intent.strategy,
    token_id: intent.token_id,
    market_id: intent.market_id,
    side: intent.side,
    price: intent.price,
    max_size_usd: intent.size_usd,
    confidence: intent.confidence,
    approved_by: 'telegram',
    telegram_user: {
      id: update.callback_query?.from?.id || null,
      username: update.callback_query?.from?.username || null,
      first_name: update.callback_query?.from?.first_name || null
    },
    safety: { paper_only: true, submitted: false, signed: false, secrets_read: false, live_trading_enabled: false }
  };
}

async function handleCallback(config, state, update) {
  const cq = update.callback_query;
  if (!cq || !cq.data) return;
  const [action, callbackId] = String(cq.data).split(':');
  if (!['APPROVE', 'DENY'].includes(action) || !callbackId) return;

  const cb = state.callbacks[callbackId];
  if (!cb) {
    await telegramApi(config, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Unknown or expired approval request.', show_alert: true }).catch(() => {});
    return;
  }

  const record = decisionRecord(action, callbackId, cb, update);
  appendNdjson(config.decisionsPath, record);
  appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'TELEGRAM_CALLBACK_HANDLED', decision: record.decision, intent_id: record.intent_id, callback_id: callbackId });

  const status = action === 'APPROVE' ? '✅ APPROVED' : '❌ DENIED';
  await telegramApi(config, 'answerCallbackQuery', { callback_query_id: cq.id, text: `${status}: ${record.intent_id}`, show_alert: false }).catch(() => {});

  if (cq.message?.chat?.id && cq.message?.message_id) {
    const original = cq.message.text || cq.message.caption || '';
    await telegramApi(config, 'editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: `${original}\n\n<b>Decision:</b> ${status}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }).catch(() => {});
  }

  delete state.callbacks[callbackId];
  saveState(config, state);
}

async function pollTelegramCallbacks(config, state) {
  const data = await telegramApi(config, 'getUpdates', { offset: Number(state.last_update_id || 0) + 1, timeout: 20, allowed_updates: ['callback_query', 'message'] });
  const updates = data.result || [];
  for (const update of updates) {
    if (update.update_id !== undefined) state.last_update_id = Math.max(Number(state.last_update_id || 0), Number(update.update_id));
    if (update.callback_query) await handleCallback(config, state, update);
    else if (update.message?.text === '/status') {
      await telegramApi(config, 'sendMessage', { chat_id: update.message.chat.id, text: `Approval relay online. Sent=${Object.keys(state.sent).length} Pending=${Object.keys(state.callbacks).length}` }).catch(() => {});
    }
  }
  saveState(config, state);
}

function scanIntentFiles(config, state) {
  const intents = [];
  for (const filePath of config.watchPaths) {
    const abs = path.resolve(config.baseDir, filePath);
    const records = readNdjson(abs);
    for (const raw of records) {
      if (raw.__parse_error) {
        appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'INTENT_PARSE_ERROR', file: filePath, error: raw.__parse_error });
        continue;
      }
      const intent = toIntent(raw, filePath);
      if (!isActionableIntent(intent, config)) continue;
      if (state.sent[intent.intent_id]) continue;
      intents.push(intent);
    }
  }
  return intents;
}

function readConfig(baseDir) {
  loadEnvFile(path.join(baseDir, '.env.telegram'));
  const watchPaths = (process.env.TELEGRAM_APPROVAL_WATCH_PATHS || [process.env.TRADE_INTENTS_PATH || './trade_intents.ndjson', './external_signal_events.ndjson', './sniper_route_requests.ndjson'].join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
  return {
    baseDir,
    enabled: boolish(process.env.TELEGRAM_APPROVAL_BOT_ENABLED, true),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    watchPaths,
    decisionsPath: path.resolve(baseDir, process.env.APPROVAL_DECISIONS_PATH || './approval_decisions.ndjson'),
    eventsPath: path.resolve(baseDir, process.env.TELEGRAM_APPROVAL_EVENTS_PATH || './telegram_approval_events.ndjson'),
    statePath: path.resolve(baseDir, process.env.TELEGRAM_APPROVAL_STATE_PATH || './telegram_approval_state.json'),
    pollMs: num(process.env.TELEGRAM_APPROVAL_FILE_POLL_MS, 3000),
    requireTokenId: boolish(process.env.TELEGRAM_APPROVAL_REQUIRE_TOKEN_ID, false),
    alertAll: boolish(process.env.TELEGRAM_APPROVAL_ALERT_ALL, false),
    maxBurst: Math.max(1, num(process.env.TELEGRAM_APPROVAL_MAX_BURST, 5))
  };
}

function validateConfig(config) {
  const errors = [];
  if (!config.enabled) errors.push('TELEGRAM_APPROVAL_BOT_ENABLED is false');
  if (!config.telegramBotToken) errors.push('TELEGRAM_BOT_TOKEN missing');
  if (!/^\d+:[A-Za-z0-9_-]{25,}$/.test(config.telegramBotToken)) errors.push('TELEGRAM_BOT_TOKEN format invalid');
  if (!config.telegramChatId) errors.push('TELEGRAM_CHAT_ID missing');
  return errors;
}

async function doctor(config) {
  console.log(`[telegram-approval] version=${VERSION}`);
  console.log(`[telegram-approval] baseDir=${config.baseDir}`);
  console.log(`[telegram-approval] enabled=${config.enabled}`);
  console.log(`[telegram-approval] watchPaths=${config.watchPaths.join(',')}`);
  console.log(`[telegram-approval] decisionsPath=${config.decisionsPath}`);
  console.log(`[telegram-approval] eventsPath=${config.eventsPath}`);
  console.log(`[telegram-approval] statePath=${config.statePath}`);
  console.log(`[telegram-approval] tokenSet=${Boolean(config.telegramBotToken)}`);
  console.log(`[telegram-approval] chatIdSet=${Boolean(config.telegramChatId)}`);
  const errors = validateConfig(config);
  if (errors.length) { console.error(`[telegram-approval] CONFIG_ERRORS=${errors.join('; ')}`); process.exitCode = 1; return; }
  const me = await telegramApi(config, 'getMe', {});
  console.log(`[telegram-approval] telegram_ok=true username=${me.result?.username || 'unknown'}`);
}

async function once(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('; '));
  const state = loadState(config);
  const intents = scanIntentFiles(config, state);
  console.log(`[telegram-approval] found ${intents.length} unsent intent(s)`);
  for (const intent of intents.slice(0, config.maxBurst)) {
    console.log(`[telegram-approval] sending ${intent.intent_id} ${intent.source} ${intent.side} ${shortId(intent.token_id)}`);
    await sendApprovalMessage(config, state, intent);
  }
  await pollTelegramCallbacks(config, state);
}

async function run(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('; '));
  ensureFile(config.decisionsPath);
  ensureFile(config.eventsPath);
  const state = loadState(config);
  appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'TELEGRAM_APPROVAL_RELAY_STARTED', version: VERSION, watchPaths: config.watchPaths, safety: { paper_only: true, submitted: false, reads_live_secrets: false } });
  console.log(`[telegram-approval] online version=${VERSION}`);
  console.log(`[telegram-approval] watching ${config.watchPaths.join(', ')}`);
  while (true) {
    try {
      const intents = scanIntentFiles(config, state);
      for (const intent of intents.slice(0, config.maxBurst)) {
        console.log(`[telegram-approval] sending ${intent.intent_id} ${intent.source} ${intent.side} ${shortId(intent.token_id)}`);
        await sendApprovalMessage(config, state, intent);
      }
      await pollTelegramCallbacks(config, state);
    } catch (e) {
      console.error(`[telegram-approval] ERROR ${e.stack || e.message}`);
      appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'TELEGRAM_APPROVAL_RELAY_ERROR', error: e.message });
      await sleep(3000);
    }
    await sleep(config.pollMs);
  }
}

async function main() {
  const command = process.argv[2] || 'run';
  const baseDir = process.cwd();
  const config = readConfig(baseDir);
  if (['help', '--help', '-h'].includes(command)) {
    console.log(`Usage:\n  node telegram_approval_bot.js doctor\n  node telegram_approval_bot.js once\n  node telegram_approval_bot.js run`);
    return;
  }
  if (command === 'doctor') return doctor(config);
  if (command === 'once') return once(config);
  if (command === 'run') return run(config);
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch(e => { console.error(`[telegram-approval] FATAL ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { readConfig, toIntent, isActionableIntent, formatIntentMessage };
