'use strict';

/**
 * MoneyMaker Live Adapter for Polymarket CLOB
 *
 * Purpose:
 * - Isolated live-execution adapter for MoneyMaker order intents.
 * - Defaults to SAFE refusal / dry-run behavior.
 * - Reads normal .env for live safety flags.
 * - Reads .env.live.secrets ONLY when real live submission is explicitly enabled.
 *
 * This file does not modify moneymaker_v3.js by itself.
 * It can be required as a module or called as a CLI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// -----------------------------
// Utility helpers
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function shortId(value, head = 8, tail = 6) {
  const s = String(value || '');
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePrivateKey(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.startsWith('0x') ? s : `0x${s}`;
}

function roundToTick(price, tickSize) {
  const p = Number(price);
  const t = Number(tickSize || 0.01);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return p;
  const decimals = Math.max(0, (String(t).split('.')[1] || '').length);
  return Number((Math.round(p / t) * t).toFixed(decimals));
}

function priceConformsToTick(price, tickSize) {
  const p = Number(price);
  const t = Number(tickSize || 0.01);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return false;
  const q = p / t;
  return Math.abs(q - Math.round(q)) < 1e-8;
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function appendNdjson(filePath, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.appendFileSync(filePath, line);
}

function loadEnvFile(filePath, opts = {}) {
  const { override = false, required = false } = opts;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    if (required) throw new Error(`Missing env file: ${resolved}`);
    return { loaded: false, path: resolved };
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return { loaded: true, path: resolved };
}

function createIntentId(intent) {
  const seed = JSON.stringify({
    t: intent.timestamp || nowIso(),
    tokenId: intent.tokenId,
    side: intent.side,
    price: intent.price,
    sizeUsd: intent.sizeUsd,
    source: intent.source,
  });
  return `intent_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function firstString(...values) {
  const value = firstDefined(...values);
  return value === undefined ? '' : String(value).trim();
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function safeError(err) {
  return err && err.message ? err.message : String(err);
}

function redactWallet(value) {
  return value ? shortId(value, 6, 4) : null;
}

function missingEnv(names) {
  return names.filter((name) => !process.env[name]);
}

function secretFileExists(config) {
  return fs.existsSync(path.resolve(config.baseDir, config.liveSecretsPath));
}

function parseCliArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function readIntentFromArgs(baseDir, args, fallback = null) {
  const opts = parseCliArgs(args);
  const candidatePath = opts.intent || opts.candidate || opts.file || opts._[0];
  if (candidatePath) {
    const intent = safeReadJson(path.resolve(baseDir, candidatePath));
    if (!intent) throw new Error(`Could not read candidate JSON: ${path.resolve(baseDir, candidatePath)}`);
    return intent;
  }

  return {
    timestamp: nowIso(),
    source: 'READINESS_TEST',
    strategy: 'SpreadHunter',
    route: 'READINESS',
    tokenId: opts['token-id'] || opts.tokenId || fallback?.tokenId || '1234567890',
    marketId: opts['market-id'] || opts.marketId || fallback?.marketId || 'readiness-test-market',
    side: String(opts.side || fallback?.side || 'BUY').toUpperCase(),
    price: Number(opts.price || fallback?.price || 0.55),
    sizeUsd: Number(opts['size-usd'] || opts.sizeUsd || fallback?.sizeUsd || 1),
    reason: 'Synthetic readiness test intent; never submit by default',
    confidence: 0.8,
    sophieApproved: true,
    consensusScore: 0.8,
    bookFresh: true,
    bookAgeMs: 250,
    currentLiveExposureUsd: 0,
    currentDailyLivePnlUsd: 0,
    tickSize: opts['tick-size'] || fallback?.tickSize || '0.01',
    minOrderSize: opts['min-order-size'] !== undefined ? Number(opts['min-order-size']) : fallback?.minOrderSize ?? 0,
    negRisk: false,
    paperBurnIn: {
      ok: true,
      reports: 3,
      closedPnlUsd: 0,
      drawdownPct: 0,
      ghostFavorablePct: 1,
    },
  };
}

function printStructured(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// -----------------------------
// Config and flags
// -----------------------------
function readConfig(baseDir = process.cwd()) {
  loadEnvFile(path.join(baseDir, '.env'), { override: false, required: false });

  return {
    baseDir,
    clobHost: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
    chainId: Number(process.env.POLYMARKET_CHAIN_ID || process.env.CHAIN_ID || 137),
    liveSecretsPath: process.env.LIVE_SECRETS_PATH || './.env.live.secrets',
    liveIntentLogPath: process.env.LIVE_INTENT_LOG_PATH || './live_order_intents.ndjson',
    liveExecutionLogPath: process.env.LIVE_EXECUTION_LOG_PATH || './live_execution_events.ndjson',
    liveAdapterEventsPath: process.env.LIVE_ADAPTER_EVENTS_PATH || './live_adapter_events.ndjson',
    liveReconcileSnapshotPath: process.env.LIVE_RECONCILE_SNAPSHOT_PATH || './live_reconcile_snapshot.json',

    enableLiveTrading: toBool(process.env.ENABLE_LIVE_TRADING, false),
    liveAutoExecute: toBool(process.env.LIVE_AUTO_EXECUTE, false),
    liveKillSwitch: toBool(process.env.LIVE_KILL_SWITCH, true),
    liveDryRunOnly: toBool(process.env.LIVE_DRY_RUN_ONLY, true),
    liveSubmitConfirm: toBool(process.env.LIVE_SUBMIT_CONFIRM, false),
    liveAuthCheckAllow: toBool(process.env.LIVE_AUTH_CHECK_ALLOW, false),
    liveSigningTestAllow: toBool(process.env.LIVE_SIGNING_TEST_ALLOW, false),
    liveReconcileAllow: toBool(process.env.LIVE_RECONCILE_ALLOW, false),
    liveRequireSophieApproval: toBool(process.env.LIVE_REQUIRE_SOPHIE_APPROVAL, true),
    liveRequireFreshBook: toBool(process.env.LIVE_REQUIRE_FRESH_BOOK, true),
    liveRequireBurnIn: toBool(process.env.LIVE_REQUIRE_BURN_IN, true),
    liveCancelReplaceEnabled: toBool(process.env.LIVE_CANCEL_REPLACE_ENABLED, false),
    liveCancelStaleOrders: toBool(process.env.LIVE_CANCEL_STALE_ORDERS, true),
    liveCancelTestAllow: toBool(process.env.LIVE_CANCEL_TEST_ALLOW, false),
    liveWhaleCopyTrading: toBool(process.env.LIVE_WHALE_COPY_TRADING, false),
    liveAllowOracleSniper: toBool(process.env.LIVE_ALLOW_ORACLE_SNIPER, false),
    livePostOnlyDefault: toBool(process.env.LIVE_POST_ONLY_DEFAULT, true),

    maxLiveOrderUsd: toNum(process.env.MAX_LIVE_ORDER_USD, 1),
    maxLiveTotalExposureUsd: toNum(process.env.MAX_LIVE_TOTAL_EXPOSURE_USD, 10),
    liveDailyMaxLossUsd: toNum(process.env.LIVE_DAILY_MAX_LOSS_USD, 3),
    liveStaleOrderMs: toNum(process.env.LIVE_STALE_ORDER_MS, 45000),
    liveReplaceMinPriceDeltaTicks: toNum(process.env.LIVE_REPLACE_MIN_PRICE_DELTA_TICKS, 1),
    liveMaxBookAgeMs: toNum(process.env.LIVE_MAX_BOOK_AGE_MS, 1500),
    liveMaxSpread: toNum(process.env.LIVE_MAX_SPREAD, toNum(process.env.MAX_SPREAD, 0.12)),
    liveMinBurnInReports: toNum(process.env.LIVE_BURN_IN_MIN_REPORTS, 3),
    liveMinBurnInClosedPnlUsd: toNum(process.env.LIVE_BURN_IN_MIN_CLOSED_PNL_USD, 0),
    liveMaxBurnInDrawdownPct: toNum(process.env.LIVE_BURN_IN_MAX_DRAWDOWN_PCT, 3),
    liveMinGhostFavorablePct: toNum(process.env.LIVE_BURN_IN_MIN_GHOST_FAVORABLE_PCT, 0),
    liveBurnInOkOverride: toBool(process.env.LIVE_BURN_IN_OK, false),
    liveSophieMinScore: toNum(process.env.LIVE_SOPHIE_MIN_SCORE, toNum(process.env.CONSENSUS_THRESHOLD, 0.55)),
  };
}

// -----------------------------
// Intent normalization
// -----------------------------
function normalizeIntent(rawIntent) {
  if (!rawIntent || typeof rawIntent !== 'object') {
    throw new Error('Order intent must be an object');
  }

  const intent = {
    id: rawIntent.id || createIntentId(rawIntent),
    timestamp: firstString(rawIntent.timestamp, rawIntent.ts, nowIso()),
    source: rawIntent.source || rawIntent.strategy || 'UNKNOWN',
    route: rawIntent.route || rawIntent.routeMode || 'UNKNOWN',
    strategy: rawIntent.strategy || rawIntent.source || 'UNKNOWN',
    tokenId: firstString(rawIntent.tokenId, rawIntent.token_id, rawIntent.tokenID, rawIntent.assetId, rawIntent.asset_id, rawIntent.clobTokenId, rawIntent.clob_token_id),
    marketId: firstString(rawIntent.marketId, rawIntent.market_id, rawIntent.conditionId, rawIntent.condition_id, rawIntent.market) || null,
    side: String(rawIntent.side || '').toUpperCase(),
    price: Number(rawIntent.price),
    sizeUsd: firstNumber(rawIntent.sizeUsd, rawIntent.size_usd, rawIntent.usd, rawIntent.amountUsd, rawIntent.amount_usd, 0),
    sizeShares: firstDefined(rawIntent.sizeShares, rawIntent.size_shares) !== undefined ? Number(firstDefined(rawIntent.sizeShares, rawIntent.size_shares)) : null,
    orderType: rawIntent.orderType || 'GTC',
    postOnly: rawIntent.postOnly,
    reason: rawIntent.reason || '',
    confidence: rawIntent.confidence !== undefined ? Number(rawIntent.confidence) : null,
    sophieApproved: Boolean(rawIntent.sophieApproved || rawIntent.sophie_approved || rawIntent.sophie?.approved),
    consensusScore: firstNumber(rawIntent.consensusScore, rawIntent.consensus_score, rawIntent.sophie?.score),
    whaleCopy: Boolean(rawIntent.whaleCopy || rawIntent.whale_copy || rawIntent.source === 'WhaleCopy'),
    oracleSignal: Boolean(rawIntent.oracleSignal || rawIntent.oracle_signal || rawIntent.source === 'BTCOracle'),
    bookFresh: firstDefined(rawIntent.bookFresh, rawIntent.book_fresh) !== undefined ? Boolean(firstDefined(rawIntent.bookFresh, rawIntent.book_fresh)) : null,
    bookAgeMs: firstNumber(rawIntent.bookAgeMs, rawIntent.book_age_ms),
    bestBid: firstNumber(rawIntent.bestBid, rawIntent.best_bid, rawIntent.book?.bestBid, rawIntent.book?.best_bid),
    bestAsk: firstNumber(rawIntent.bestAsk, rawIntent.best_ask, rawIntent.book?.bestAsk, rawIntent.book?.best_ask),
    currentLiveExposureUsd: firstNumber(rawIntent.currentLiveExposureUsd, rawIntent.current_live_exposure_usd, 0),
    currentDailyLivePnlUsd: firstNumber(rawIntent.currentDailyLivePnlUsd, rawIntent.current_daily_live_pnl_usd, 0),
    paperBurnIn: rawIntent.paperBurnIn || rawIntent.paper_burn_in || rawIntent.burnIn || rawIntent.burn_in || null,
    tickSize: rawIntent.tickSize || rawIntent.tick_size || null,
    negRisk: firstDefined(rawIntent.negRisk, rawIntent.neg_risk) !== undefined ? Boolean(firstDefined(rawIntent.negRisk, rawIntent.neg_risk)) : null,
    minOrderSize: firstDefined(rawIntent.minOrderSize, rawIntent.min_order_size) !== undefined ? Number(firstDefined(rawIntent.minOrderSize, rawIntent.min_order_size)) : null,
    raw: rawIntent,
  };

  if (!intent.sizeShares && intent.sizeUsd > 0 && Number.isFinite(intent.price) && intent.price > 0) {
    intent.sizeShares = intent.sizeUsd / intent.price;
  }

  return intent;
}

// -----------------------------
// Safety gates
// -----------------------------
function evaluateBurnIn(config, intent) {
  if (!config.liveRequireBurnIn) return { ok: true, reasons: [], source: 'LIVE_REQUIRE_BURN_IN=false' };
  if (config.liveBurnInOkOverride && process.env.LIVE_REQUIRE_BURN_IN === 'false') {
    return { ok: true, reasons: [], source: 'LIVE_BURN_IN_OK' };
  }

  const burn = intent.paperBurnIn;
  if (!burn || typeof burn !== 'object') {
    return { ok: false, reasons: ['BURN_IN_REQUIRED'], source: 'intent.paperBurnIn' };
  }

  const reasons = [];
  const reports = Number(burn.reports || burn.reportCount || 0);
  const closedPnl = Number(burn.closedPnlUsd || burn.closedPnl || 0);
  const drawdown = Number(burn.drawdownPct || burn.drawdown || 0);
  const ghostRaw = firstDefined(burn.ghostFavorablePct, burn.ghostFavorable, burn.ghost_favorable_pct);
  const ghostFav = Number(ghostRaw);

  if (burn.ok !== true) reasons.push('BURN_IN_NOT_MARKED_OK');
  if (reports < config.liveMinBurnInReports) reasons.push('BURN_IN_REPORTS_TOO_LOW');
  if (closedPnl < config.liveMinBurnInClosedPnlUsd) reasons.push('BURN_IN_CLOSED_PNL_TOO_LOW');
  if (drawdown > config.liveMaxBurnInDrawdownPct) reasons.push('BURN_IN_DRAWDOWN_TOO_HIGH');
  if (!Number.isFinite(ghostFav)) reasons.push('BURN_IN_GHOST_FAVORABLE_UNAVAILABLE');
  if (Number.isFinite(ghostFav) && ghostFav < config.liveMinGhostFavorablePct) reasons.push('BURN_IN_GHOST_FAVORABLE_TOO_LOW');
  if (Number(burn.recentFatalErrors || 0) > 0) reasons.push('BURN_IN_RECENT_FATAL_ERRORS');

  return { ok: reasons.length === 0, reasons, source: 'intent.paperBurnIn' };
}

function evaluateStaticSafety(config, intent) {
  const reasons = [];

  if (!config.enableLiveTrading) reasons.push('LIVE_DISABLED');
  if (!config.liveAutoExecute) reasons.push('AUTO_EXECUTE_DISABLED');
  if (config.liveKillSwitch) reasons.push('KILL_SWITCH_ACTIVE');
  if (config.liveDryRunOnly) reasons.push('DRY_RUN_ONLY');
  if (!config.liveSubmitConfirm) reasons.push('LIVE_SUBMIT_CONFIRM_REQUIRED');

  if (!intent.tokenId) reasons.push('TOKEN_ID_MISSING');
  if (!['BUY', 'SELL'].includes(intent.side)) reasons.push('INVALID_SIDE');
  if (!Number.isFinite(intent.price) || intent.price <= 0 || intent.price >= 1) reasons.push('INVALID_PRICE');
  if (!Number.isFinite(intent.sizeUsd) || intent.sizeUsd <= 0) reasons.push('INVALID_SIZE_USD');
  if (intent.sizeUsd > config.maxLiveOrderUsd) reasons.push('MAX_LIVE_ORDER_USD_EXCEEDED');
  if (intent.currentLiveExposureUsd + intent.sizeUsd > config.maxLiveTotalExposureUsd) reasons.push('MAX_LIVE_TOTAL_EXPOSURE_EXCEEDED');
  if (intent.currentDailyLivePnlUsd <= -Math.abs(config.liveDailyMaxLossUsd)) reasons.push('DAILY_MAX_LOSS_EXCEEDED');

  if (config.liveRequireSophieApproval && intent.sophieApproved !== true) reasons.push('SOPHIE_NOT_APPROVED');
  if (Number.isFinite(intent.consensusScore) && intent.consensusScore < config.liveSophieMinScore) reasons.push('SOPHIE_SCORE_TOO_LOW');
  if (config.liveRequireFreshBook && intent.bookFresh !== true) reasons.push('BOOK_NOT_FRESH');
  if (config.liveRequireFreshBook && Number.isFinite(intent.bookAgeMs) && intent.bookAgeMs > config.liveMaxBookAgeMs) reasons.push('BOOK_TOO_OLD');
  if (intent.whaleCopy && !config.liveWhaleCopyTrading) reasons.push('WHALE_COPY_DISABLED');
  if (intent.oracleSignal && !config.liveAllowOracleSniper) reasons.push('ORACLE_SNIPER_DISABLED');

  const burn = evaluateBurnIn(config, intent);
  if (!burn.ok) reasons.push(...burn.reasons);

  return {
    ok: reasons.length === 0,
    reasons,
    burnIn: burn,
  };
}

function evaluateLossExposureGuards(config, intent) {
  const reasons = [];
  if (intent.currentDailyLivePnlUsd <= -Math.abs(config.liveDailyMaxLossUsd)) reasons.push('DAILY_MAX_LOSS_EXCEEDED');
  if (intent.currentLiveExposureUsd + intent.sizeUsd > config.maxLiveTotalExposureUsd) reasons.push('MAX_LIVE_TOTAL_EXPOSURE_EXCEEDED');
  if (intent.sizeUsd > config.maxLiveOrderUsd) reasons.push('MAX_LIVE_ORDER_USD_EXCEEDED');
  return { ok: reasons.length === 0, reasons };
}

function extractBookLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => ({
      price: Number(level.price ?? level.p ?? level[0]),
      size: Number(level.size ?? level.s ?? level[1]),
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size));
}

function normalizeOrderBook(book, intent = {}) {
  if (!book || typeof book !== 'object') return null;
  const bids = extractBookLevels(book.bids || book.buy || book.buys || book.BIDS);
  const asks = extractBookLevels(book.asks || book.sell || book.sells || book.ASKS);
  const bestBid = Number.isFinite(intent.bestBid) ? intent.bestBid : bids.length ? Math.max(...bids.map((b) => b.price)) : NaN;
  const bestAsk = Number.isFinite(intent.bestAsk) ? intent.bestAsk : asks.length ? Math.min(...asks.map((a) => a.price)) : NaN;
  const tickSize = book.tick_size || book.tickSize || book.minimum_tick_size || intent.tickSize || null;
  const minOrderSize = Number(book.min_order_size || book.minOrderSize || book.minimum_order_size || intent.minOrderSize || 0);
  const tsRaw = book.timestamp || book.ts || book.server_time || book.serverTime || book.updated_at || book.updatedAt || null;
  const parsedTs = tsRaw ? Number(tsRaw) || Date.parse(tsRaw) : NaN;
  const bookAgeMs = Number.isFinite(intent.bookAgeMs)
    ? intent.bookAgeMs
    : Number.isFinite(parsedTs)
      ? Math.max(0, Date.now() - (parsedTs > 10_000_000_000 ? parsedTs : parsedTs * 1000))
      : NaN;

  return {
    tickSize,
    negRisk: book.neg_risk ?? book.negRisk ?? intent.negRisk ?? null,
    minOrderSize,
    bestBid,
    bestAsk,
    spread: Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? Math.max(0, bestAsk - bestBid) : NaN,
    bookAgeMs,
    rawAvailable: true,
  };
}

async function fetchPublicOrderBook(config, tokenId) {
  if (!tokenId || typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const url = `${String(config.clobHost).replace(/\/$/, '')}/book?token_id=${encodeURIComponent(tokenId)}`;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function evaluateMetadataSafety(client, intent, config = readConfig()) {
  const reasons = [];
  const meta = {
    tickSize: intent.tickSize || null,
    negRisk: intent.negRisk,
    minOrderSize: intent.minOrderSize,
    bestBid: Number.isFinite(intent.bestBid) ? intent.bestBid : null,
    bestAsk: Number.isFinite(intent.bestAsk) ? intent.bestAsk : null,
    spread: null,
    bookAgeMs: Number.isFinite(intent.bookAgeMs) ? intent.bookAgeMs : null,
    source: 'intent',
  };
  let orderBook = null;

  if (client) {
    try {
      orderBook = await client.getOrderBook(intent.tokenId);
      meta.source = 'authenticated_clob';
    } catch (e) {
      reasons.push(`ORDERBOOK_METADATA_FAILED:${e.message}`);
    }
  } else if (intent.tokenId && intent.tokenId !== '1234567890') {
    orderBook = await fetchPublicOrderBook(config, intent.tokenId);
    if (orderBook) meta.source = 'public_clob';
  }

  const normalizedBook = normalizeOrderBook(orderBook, intent);
  if (normalizedBook) {
    meta.tickSize = meta.tickSize || normalizedBook.tickSize;
    meta.negRisk = meta.negRisk !== null && meta.negRisk !== undefined ? meta.negRisk : normalizedBook.negRisk;
    meta.minOrderSize = Number(meta.minOrderSize || normalizedBook.minOrderSize || 0);
    meta.bestBid = Number.isFinite(normalizedBook.bestBid) ? normalizedBook.bestBid : meta.bestBid;
    meta.bestAsk = Number.isFinite(normalizedBook.bestAsk) ? normalizedBook.bestAsk : meta.bestAsk;
    meta.spread = Number.isFinite(normalizedBook.spread) ? normalizedBook.spread : meta.spread;
    meta.bookAgeMs = Number.isFinite(normalizedBook.bookAgeMs) ? normalizedBook.bookAgeMs : meta.bookAgeMs;
  }

  if (client && !meta.tickSize) {
    try {
      meta.tickSize = await client.getTickSize(intent.tokenId);
    } catch (e) {
      reasons.push(`TICK_SIZE_LOOKUP_FAILED:${e.message}`);
    }
  }

  if (client && (meta.negRisk === null || meta.negRisk === undefined)) {
    try {
      meta.negRisk = await client.getNegRisk(intent.tokenId);
    } catch (e) {
      reasons.push(`NEG_RISK_LOOKUP_FAILED:${e.message}`);
    }
  }

  meta.tickSize = meta.tickSize || '0.01';
  meta.negRisk = Boolean(meta.negRisk);
  meta.minOrderSize = Number(meta.minOrderSize || 0);
  if (meta.spread === null && Number.isFinite(meta.bestBid) && Number.isFinite(meta.bestAsk)) {
    meta.spread = Math.max(0, meta.bestAsk - meta.bestBid);
  }

  if (!normalizedBook && (!Number.isFinite(meta.bestBid) || !Number.isFinite(meta.bestAsk))) {
    reasons.push('TOKEN_METADATA_UNAVAILABLE');
  }
  if (!Number.isFinite(intent.price) || intent.price < 0.01 || intent.price > 0.99) {
    reasons.push('PRICE_OUT_OF_RANGE');
  }
  if (!priceConformsToTick(intent.price, meta.tickSize)) {
    reasons.push('PRICE_NOT_TICK_ALIGNED');
  }

  if (meta.minOrderSize > 0 && intent.sizeShares < meta.minOrderSize) {
    reasons.push('SIZE_BELOW_MIN_ORDER');
  }
  if (!Number.isFinite(meta.bookAgeMs)) {
    reasons.push('BOOK_NOT_FRESH');
  } else if (meta.bookAgeMs > config.liveMaxBookAgeMs) {
    reasons.push('BOOK_TOO_OLD');
  }
  if (Number.isFinite(meta.spread) && meta.spread > config.liveMaxSpread) {
    reasons.push('SPREAD_TOO_WIDE');
  }

  return { ok: [...new Set(reasons)].length === 0, reasons: [...new Set(reasons)], meta };
}

// -----------------------------
// Polymarket live client wrapper
// -----------------------------
class PolymarketLiveClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.sdk = null;
    this.walletAddress = null;
    this.privateKeyAccessed = false;
    this.clientPurpose = null;
  }

  canSubmitLive() {
    return this.config.enableLiveTrading
      && this.config.liveAutoExecute
      && !this.config.liveKillSwitch
      && !this.config.liveDryRunOnly
      && this.config.liveSubmitConfirm;
  }

  shouldLoadSecrets() {
    return this.canSubmitLive();
  }

  secretAccessDecision(purpose) {
    const reasons = [];
    if (!secretFileExists(this.config)) reasons.push('LIVE_SECRETS_FILE_MISSING');

    if (purpose === 'submit') {
      if (!this.config.enableLiveTrading) reasons.push('ENABLE_LIVE_TRADING_FALSE');
      if (!this.config.liveAutoExecute) reasons.push('LIVE_AUTO_EXECUTE_FALSE');
      if (this.config.liveKillSwitch) reasons.push('LIVE_KILL_SWITCH_TRUE');
      if (this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_TRUE');
      if (!this.config.liveSubmitConfirm) reasons.push('LIVE_SUBMIT_CONFIRM_REQUIRED');
    } else if (purpose === 'cancel') {
      if (!this.config.enableLiveTrading) reasons.push('ENABLE_LIVE_TRADING_FALSE');
      if (!this.config.liveAutoExecute) reasons.push('LIVE_AUTO_EXECUTE_FALSE');
      if (this.config.liveKillSwitch) reasons.push('LIVE_KILL_SWITCH_TRUE');
      if (this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_TRUE');
      if (!this.config.liveCancelTestAllow) reasons.push('LIVE_CANCEL_TEST_ALLOW_FALSE');
    } else if (purpose === 'auth-check') {
      if (this.config.liveAutoExecute) reasons.push('LIVE_AUTO_EXECUTE_MUST_BE_FALSE_FOR_AUTH_CHECK');
      if (!this.config.liveKillSwitch) reasons.push('LIVE_KILL_SWITCH_MUST_BE_TRUE_FOR_AUTH_CHECK');
      if (!this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_MUST_BE_TRUE_FOR_AUTH_CHECK');
      if (!this.config.liveAuthCheckAllow) reasons.push('LIVE_AUTH_CHECK_ALLOW_FALSE');
    } else if (purpose === 'signing-test') {
      if (this.config.liveAutoExecute) reasons.push('LIVE_AUTO_EXECUTE_MUST_BE_FALSE_FOR_SIGNING_TEST');
      if (!this.config.liveKillSwitch) reasons.push('LIVE_KILL_SWITCH_MUST_BE_TRUE_FOR_SIGNING_TEST');
      if (!this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_MUST_BE_TRUE_FOR_SIGNING_TEST');
      if (!this.config.liveSigningTestAllow) reasons.push('LIVE_SIGNING_TEST_ALLOW_FALSE');
    } else if (purpose === 'reconcile') {
      if (this.config.liveAutoExecute) reasons.push('LIVE_AUTO_EXECUTE_MUST_BE_FALSE_FOR_RECONCILE');
      if (!this.config.liveKillSwitch) reasons.push('LIVE_KILL_SWITCH_MUST_BE_TRUE_FOR_RECONCILE');
      if (!this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_MUST_BE_TRUE_FOR_RECONCILE');
      if (!this.config.liveReconcileAllow) reasons.push('LIVE_RECONCILE_ALLOW_FALSE');
    }

    return { ok: reasons.length === 0, reasons };
  }

  async init(purpose = 'submit') {
    const allowed = this.secretAccessDecision(purpose);
    if (!allowed.ok) {
      throw new Error(`Refusing to load live secrets for ${purpose}: ${allowed.reasons.join(',')}`);
    }
    if (this.client) return this.client;

    const secretPath = path.resolve(this.config.baseDir, this.config.liveSecretsPath);
    loadEnvFile(secretPath, { override: false, required: true });

    const privateKey = normalizePrivateKey(process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY);
    if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY missing in live secrets');
    this.privateKeyAccessed = true;

    const funderAddress = process.env.POLYMARKET_PROXY_WALLET_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS || process.env.DEPOSIT_WALLET_ADDRESS;
    const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 3);

    const sdk = await import('@polymarket/clob-client-v2');
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(privateKey);
    const signer = createWalletClient({ account, transport: http() });
    this.walletAddress = funderAddress || account.address;

    const l1Client = new sdk.ClobClient({
      host: this.config.clobHost,
      chain: this.config.chainId,
      signer,
      signatureType,
      funderAddress,
      throwOnError: true,
    });

    const existingCreds = process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET && process.env.POLYMARKET_API_PASSPHRASE
      ? {
          key: process.env.POLYMARKET_API_KEY,
          secret: process.env.POLYMARKET_API_SECRET,
          passphrase: process.env.POLYMARKET_API_PASSPHRASE,
        }
      : null;

    const creds = existingCreds || await l1Client.createOrDeriveApiKey();

    this.client = new sdk.ClobClient({
      host: this.config.clobHost,
      chain: this.config.chainId,
      signer,
      creds,
      signatureType,
      funderAddress,
      throwOnError: true,
    });
    this.sdk = sdk;
    this.clientPurpose = purpose;
    return this.client;
  }

  async authCheck() {
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_AUTH_CHECK',
      secretsPresent: secretFileExists(this.config),
      privateKeyAccessed: false,
      clientInitialized: false,
      apiCredentialsReady: false,
      submitted: false,
      signed: false,
      errors: [],
      requiredEnvPresent: {
        POLYMARKET_PRIVATE_KEY: Boolean(process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY),
        POLYMARKET_API_KEY: Boolean(process.env.POLYMARKET_API_KEY),
        POLYMARKET_API_SECRET: Boolean(process.env.POLYMARKET_API_SECRET),
        POLYMARKET_API_PASSPHRASE: Boolean(process.env.POLYMARKET_API_PASSPHRASE),
        POLYMARKET_PROXY_WALLET_ADDRESS: Boolean(process.env.POLYMARKET_PROXY_WALLET_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS || process.env.DEPOSIT_WALLET_ADDRESS),
      },
    };

    try {
      await this.init('auth-check');
      event.privateKeyAccessed = this.privateKeyAccessed;
      event.clientInitialized = Boolean(this.client);
      event.apiCredentialsReady = Boolean(process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET && process.env.POLYMARKET_API_PASSPHRASE) || Boolean(this.client);
      event.walletAddress = redactWallet(this.walletAddress);
      event.requiredEnvPresent = {
        POLYMARKET_PRIVATE_KEY: Boolean(process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY),
        POLYMARKET_API_KEY: Boolean(process.env.POLYMARKET_API_KEY),
        POLYMARKET_API_SECRET: Boolean(process.env.POLYMARKET_API_SECRET),
        POLYMARKET_API_PASSPHRASE: Boolean(process.env.POLYMARKET_API_PASSPHRASE),
        POLYMARKET_PROXY_WALLET_ADDRESS: Boolean(process.env.POLYMARKET_PROXY_WALLET_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS || process.env.DEPOSIT_WALLET_ADDRESS),
      };
    } catch (e) {
      event.errors.push(safeError(e));
      event.missingEnv = missingEnv([
        'POLYMARKET_PRIVATE_KEY',
        'POLYMARKET_API_KEY',
        'POLYMARKET_API_SECRET',
        'POLYMARKET_API_PASSPHRASE',
      ]);
    }

    return event;
  }

  async signOrderOnly(intent, meta, purpose = 'signing-test') {
    const client = await this.init(purpose);
    const sdk = this.sdk;
    const side = intent.side === 'BUY' ? sdk.Side.BUY : sdk.Side.SELL;
    const userOrder = {
      tokenID: intent.tokenId,
      price: Number(intent.price),
      size: Number(intent.sizeShares),
      side,
    };
    return client.createOrder(userOrder, {
      tickSize: String(meta.tickSize),
      negRisk: Boolean(meta.negRisk),
    });
  }

  async signingTest(intent, meta) {
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_SIGNING_TEST',
      signed: false,
      submitted: false,
      privateKeyAccessed: false,
      dryRunOnly: true,
      errors: [],
      intent: redactIntent(intent),
    };

    try {
      await this.signOrderOnly(intent, meta, 'signing-test');
      event.signed = true;
      event.privateKeyAccessed = this.privateKeyAccessed;
      event.walletAddress = redactWallet(this.walletAddress);
    } catch (e) {
      event.errors.push(safeError(e));
    }

    return event;
  }

  async getOpenOrders(params = {}, purpose = 'submit') {
    const client = await this.init(purpose);
    return client.getOpenOrders(params.openOrderParams || undefined);
  }

  async reconcile(params = {}) {
    const client = await this.init('reconcile');
    const sdk = this.sdk;
    const assetType = sdk.AssetType || { COLLATERAL: 'COLLATERAL', CONDITIONAL: 'CONDITIONAL' };
    let openOrders = [];
    let collateral = null;
    let positions = [];
    let fills = [];
    const errors = [];

    try {
      openOrders = await client.getOpenOrders(params.openOrderParams || undefined);
    } catch (e) {
      errors.push(`OPEN_ORDERS_FAILED:${safeError(e)}`);
    }

    try {
      collateral = await client.getBalanceAllowance({ asset_type: assetType.COLLATERAL });
    } catch (e) {
      errors.push(`USDC_BALANCE_FAILED:${safeError(e)}`);
    }

    try {
      if (typeof client.getPositions === 'function') positions = await client.getPositions();
    } catch (e) {
      errors.push(`POSITIONS_FAILED:${safeError(e)}`);
    }

    try {
      if (typeof client.getTrades === 'function') fills = await client.getTrades();
    } catch (e) {
      errors.push(`TRADES_FAILED:${safeError(e)}`);
    }

    return {
      timestamp: nowIso(),
      walletAddress: redactWallet(this.walletAddress),
      usdcBalance: extractBalance(collateral),
      gasBalance: null,
      openOrdersCount: Array.isArray(openOrders) ? openOrders.length : 0,
      openOrdersUsd: sumOrdersUsd(openOrders),
      positionsCount: Array.isArray(positions) ? positions.length : 0,
      positionsUsd: sumPositionsUsd(positions),
      recentFillsCount: Array.isArray(fills) ? fills.length : 0,
      lastReconciledAt: nowIso(),
      errors,
    };
  }

  async cancelOrder(orderId, purpose = 'cancel') {
    if (!orderId) throw new Error('orderId required');
    const client = await this.init(purpose);
    return client.cancelOrder(orderId);
  }

  async cancelMarketOrders({ marketId, tokenId } = {}) {
    const client = await this.init('cancel');
    return client.cancelMarketOrders({ market: marketId, asset_id: tokenId });
  }

  async signAndSubmit(intent, meta) {
    const client = await this.init('submit');
    const sdk = this.sdk;
    const side = intent.side === 'BUY' ? sdk.Side.BUY : sdk.Side.SELL;
    const orderType = sdk.OrderType[intent.orderType] || sdk.OrderType.GTC;
    const postOnly = intent.postOnly !== undefined ? Boolean(intent.postOnly) : this.config.livePostOnlyDefault;

    const signedOrder = await this.signOrderOnly(intent, meta, 'submit');
    const response = await client.postOrder(signedOrder, orderType, postOnly);
    return { signedOrder, response };
  }

  async replaceOrder({ orderId, replacementIntent, meta }) {
    const cancelResponse = await this.cancelOrder(orderId, 'submit');
    const submitResponse = await this.signAndSubmit(replacementIntent, meta);
    return { cancelResponse, submitResponse };
  }
}

function extractBalance(collateral) {
  if (!collateral || typeof collateral !== 'object') return null;
  return firstNumber(collateral.balance, collateral.collateral, collateral.available, collateral.allowance);
}

function orderUsd(order) {
  if (!order || typeof order !== 'object') return 0;
  const price = firstNumber(order.price, order.order_price, order.limitPrice);
  const size = firstNumber(order.size, order.original_size, order.remaining_size, order.sizeShares);
  const sizeUsd = firstNumber(order.sizeUsd, order.size_usd, order.amount);
  if (Number.isFinite(sizeUsd)) return Math.max(0, sizeUsd);
  if (Number.isFinite(price) && Number.isFinite(size)) return Math.max(0, price * size);
  return 0;
}

function sumOrdersUsd(orders) {
  return Array.isArray(orders) ? Number(orders.reduce((sum, order) => sum + orderUsd(order), 0).toFixed(4)) : 0;
}

function sumPositionsUsd(positions) {
  if (!Array.isArray(positions)) return 0;
  return Number(positions.reduce((sum, pos) => sum + Math.max(0, firstNumber(pos.value, pos.valueUsd, pos.currentValue, 0)), 0).toFixed(4));
}

function orderId(order) {
  return firstString(order.id, order.orderId, order.order_id, order.hash);
}

function orderTokenId(order) {
  return firstString(order.tokenId, order.token_id, order.tokenID, order.asset_id, order.assetId);
}

function orderSide(order) {
  return firstString(order.side, order.orderSide).toUpperCase();
}

function orderStrategy(order) {
  return firstString(order.strategy, order.source, order.metadata?.strategy);
}

function orderPrice(order) {
  return firstNumber(order.price, order.order_price, order.limitPrice);
}

function orderCreatedMs(order) {
  const raw = firstDefined(order.createdAt, order.created_at, order.timestamp, order.created);
  if (raw === undefined) return NaN;
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function findMatchingOpenOrder(openOrders, intent) {
  if (!Array.isArray(openOrders)) return null;
  return openOrders.find((order) => {
    const tokenMatches = orderTokenId(order) === intent.tokenId;
    const sideMatches = orderSide(order) === intent.side;
    const existingStrategy = orderStrategy(order);
    const strategyMatches = !existingStrategy || existingStrategy === intent.strategy || existingStrategy === intent.source;
    return tokenMatches && sideMatches && strategyMatches;
  }) || null;
}

function buildCancelReplacePlan(config, intent, existingOrder, meta = {}) {
  const currentPrice = Number(intent.price);
  const existingPrice = existingOrder ? orderPrice(existingOrder) : NaN;
  const tick = Number(meta.tickSize || intent.tickSize || 0.01);
  const createdMs = existingOrder ? orderCreatedMs(existingOrder) : NaN;
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, Date.now() - createdMs) : NaN;
  const priceDeltaTicks = Number.isFinite(existingPrice) && Number.isFinite(currentPrice) && tick > 0
    ? Math.abs(currentPrice - existingPrice) / tick
    : NaN;

  let reason = 'NO_MATCHING_ORDER';
  let wouldCancel = false;
  let wouldPlaceReplacement = false;
  let skipDuplicate = false;

  if (existingOrder) {
    const stale = config.liveCancelStaleOrders && Number.isFinite(ageMs) && ageMs >= config.liveStaleOrderMs;
    const moved = Number.isFinite(priceDeltaTicks) && priceDeltaTicks >= config.liveReplaceMinPriceDeltaTicks;

    if (!stale && !moved) {
      reason = 'DUPLICATE_LIVE_ORDER';
      skipDuplicate = true;
    } else if (!config.liveCancelReplaceEnabled) {
      reason = 'CANCEL_REPLACE_DISABLED';
    } else if (stale) {
      reason = 'STALE_ORDER';
      wouldCancel = true;
      wouldPlaceReplacement = true;
    } else if (moved) {
      reason = 'PRICE_MOVED';
      wouldCancel = true;
      wouldPlaceReplacement = true;
    }
  }

  return {
    candidateOrder: {
      tokenId: intent.tokenId,
      side: intent.side,
      strategy: intent.strategy || intent.source,
      price: intent.price,
      sizeUsd: intent.sizeUsd,
    },
    matchingExistingOrder: existingOrder ? {
      orderId: orderId(existingOrder),
      tokenId: orderTokenId(existingOrder),
      side: orderSide(existingOrder),
      strategy: orderStrategy(existingOrder) || null,
      price: Number.isFinite(existingPrice) ? existingPrice : null,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
    } : null,
    reason,
    priceDeltaTicks: Number.isFinite(priceDeltaTicks) ? Number(priceDeltaTicks.toFixed(4)) : null,
    wouldCancel,
    wouldPlaceReplacement,
    skipDuplicate,
    submitted: false,
  };
}

function syntheticExistingOrder(intent, config) {
  return {
    id: 'dry-run-existing-order',
    tokenId: intent.tokenId,
    side: intent.side,
    strategy: intent.strategy || intent.source,
    price: roundToTick(Number(intent.price) - 0.02, intent.tickSize || 0.01),
    size: intent.sizeShares,
    createdAt: Date.now() - config.liveStaleOrderMs - 1000,
  };
}

function writeJsonAtomic(filePath, obj) {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, abs);
}

function burnInFromState(baseDir) {
  const statePath = path.resolve(baseDir, 'moneymaker_v3_state.json');
  const state = safeReadJson(statePath, null);
  if (!state || typeof state !== 'object') return null;
  const reports = firstNumber(state.reportsCount, state.reportCount, state.reports?.length, state.telemetry?.reportsCount, 0);
  const closedPnlUsd = firstNumber(state.closedPnlUsd, state.closedPnLUsd, state.pnl?.closedUsd, state.paper?.closedPnlUsd, 0);
  const drawdownPct = firstNumber(state.drawdownPct, state.maxDrawdownPct, state.risk?.drawdownPct, 0);
  const ghostFavorablePct = firstNumber(state.ghostFavorablePct, state.ghost?.favorablePct, state.ghostCalibration?.favorablePct);
  const recentFatalErrors = Array.isArray(state.errors)
    ? state.errors.filter((e) => /fatal|uncaught|syntax|crash/i.test(JSON.stringify(e))).length
    : 0;
  return { ok: true, reports, closedPnlUsd, drawdownPct, ghostFavorablePct, recentFatalErrors, source: statePath };
}

// -----------------------------
// Adapter public API
// -----------------------------
class LiveAdapter {
  constructor(options = {}) {
    this.baseDir = options.baseDir || process.cwd();
    this.config = readConfig(this.baseDir);
    this.live = new PolymarketLiveClient(this.config);
  }

  logEvent(event) {
    const file = path.resolve(this.baseDir, this.config.liveAdapterEventsPath);
    appendNdjson(file, event);
  }

  logExecution(event) {
    const file = path.resolve(this.baseDir, this.config.liveExecutionLogPath);
    appendNdjson(file, event);
  }

  saveReconcileSnapshot(event) {
    writeJsonAtomic(path.resolve(this.baseDir, this.config.liveReconcileSnapshotPath), event);
  }

  async evaluate(rawIntent, options = {}) {
    const intent = normalizeIntent(rawIntent);
    const staticSafety = evaluateStaticSafety(this.config, intent);
    let metadataSafety = { ok: true, reasons: [], meta: { tickSize: intent.tickSize || '0.01', negRisk: Boolean(intent.negRisk), minOrderSize: Number(intent.minOrderSize || 0) } };

    if (options.fetchMetadata === true && this.live.canSubmitLive()) {
      const client = await this.live.init('submit');
      metadataSafety = await evaluateMetadataSafety(client, intent, this.config);
    } else {
      metadataSafety = await evaluateMetadataSafety(null, intent, this.config);
    }

    const reasons = [...new Set([...staticSafety.reasons, ...metadataSafety.reasons])];
    const decision = reasons.length === 0 ? 'ALLOW_LIVE_SUBMISSION' : 'REFUSED';

    return {
      timestamp: nowIso(),
      type: 'LIVE_ADAPTER_EVALUATION',
      decision,
      reasons,
      intent: redactIntent(intent),
      metadata: metadataSafety.meta,
      safety: {
        submitted: false,
        signed: false,
        secretsRead: this.live.canSubmitLive(),
        privateKeyAccessed: false,
        staticSafety,
        metadataSafety,
      },
    };
  }

  async handleIntent(rawIntent, options = {}) {
    const submitMode = options.mode === 'submit';
    const evaluation = await this.evaluate(rawIntent, { ...options, fetchMetadata: submitMode || options.fetchMetadata === true });

    if (evaluation.decision !== 'ALLOW_LIVE_SUBMISSION') {
      this.logEvent(evaluation);
      console.warn(`[LIVE-ADAPTER REFUSED] source=${evaluation.intent.source} side=${evaluation.intent.side} token=${shortId(evaluation.intent.tokenId)} price=${evaluation.intent.price} size=$${evaluation.intent.sizeUsd} reasons=${evaluation.reasons.join(',')}`);
      return evaluation;
    }

    // Even if static checks pass, this final guard prevents accidental submissions unless the command is explicitly submit.
    if (options.mode !== 'submit') {
      evaluation.decision = 'DRY_RUN_ALLOWED_BUT_NOT_SUBMITTED';
      evaluation.reasons = ['MODE_NOT_SUBMIT'];
      this.logEvent(evaluation);
      console.log(`[LIVE-ADAPTER DRYRUN] would submit source=${evaluation.intent.source} side=${evaluation.intent.side} token=${shortId(evaluation.intent.tokenId)} price=${evaluation.intent.price} size=$${evaluation.intent.sizeUsd}`);
      return evaluation;
    }

    const intent = normalizeIntent(rawIntent);
    let openOrders = [];
    try {
      openOrders = await this.live.getOpenOrders({ openOrderParams: { asset_id: intent.tokenId } }, 'submit');
    } catch (e) {
      const event = {
        timestamp: nowIso(),
        type: 'LIVE_SUBMISSION_REFUSED',
        decision: 'REFUSED',
        reasons: ['OPEN_ORDERS_UNAVAILABLE'],
        errors: [safeError(e)],
        intent: redactIntent(intent),
        safety: { submitted: false, signed: false, privateKeyAccessed: this.live.privateKeyAccessed },
      };
      this.logEvent(event);
      return event;
    }

    const matchingOrder = findMatchingOpenOrder(openOrders, intent);
    const cancelReplacePlan = buildCancelReplacePlan(this.config, intent, matchingOrder, evaluation.metadata);
    if (cancelReplacePlan.skipDuplicate) {
      const event = {
        timestamp: nowIso(),
        type: 'LIVE_ORDER_DUPLICATE_SKIPPED',
        decision: 'SKIPPED_DUPLICATE',
        reasons: ['DUPLICATE_LIVE_ORDER'],
        intent: redactIntent(intent),
        cancelReplacePlan,
        safety: { submitted: false, signed: false, privateKeyAccessed: this.live.privateKeyAccessed },
      };
      this.logEvent(event);
      return event;
    }

    if (matchingOrder && !cancelReplacePlan.wouldCancel) {
      const event = {
        timestamp: nowIso(),
        type: 'LIVE_REPLACE_REFUSED',
        decision: 'REFUSED',
        reasons: [cancelReplacePlan.reason],
        intent: redactIntent(intent),
        cancelReplacePlan,
        safety: { submitted: false, signed: false, privateKeyAccessed: this.live.privateKeyAccessed },
      };
      this.logEvent(event);
      return event;
    }

    let cancelResponse = null;
    if (cancelReplacePlan.wouldCancel) {
      try {
        cancelResponse = await this.live.cancelOrder(cancelReplacePlan.matchingExistingOrder.orderId, 'submit');
      } catch (e) {
        const event = {
          timestamp: nowIso(),
          type: 'LIVE_REPLACE_REFUSED',
          decision: 'REFUSED',
          reasons: ['CANCEL_FAILED'],
          errors: [safeError(e)],
          intent: redactIntent(intent),
          cancelReplacePlan,
          safety: { submitted: false, signed: false, privateKeyAccessed: this.live.privateKeyAccessed },
        };
        this.logEvent(event);
        return event;
      }
    }

    const result = await this.live.signAndSubmit(intent, evaluation.metadata);
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_ORDER_SUBMITTED',
      decision: 'SUBMITTED',
      intent: redactIntent(intent),
      cancelReplacePlan,
      cancelResponse,
      response: result.response,
      safety: {
        submitted: true,
        signed: true,
        secretsRead: true,
        privateKeyAccessed: true,
      },
    };
    this.logExecution(event);
    console.log(`[LIVE-ORDER SUBMITTED] orderID=${result.response?.orderID || result.response?.orderId || 'unknown'} status=${result.response?.status || 'unknown'}`);
    return event;
  }

  async cancel(orderId) {
    const allowed = this.live.secretAccessDecision('cancel');
    if (!allowed.ok) {
      const event = {
        timestamp: nowIso(),
        type: 'LIVE_CANCEL_REFUSED',
        decision: 'REFUSED',
        reasons: allowed.reasons,
        orderId,
        submitted: false,
      };
      this.logEvent(event);
      return event;
    }
    const response = await this.live.cancelOrder(orderId, 'cancel');
    const event = { timestamp: nowIso(), type: 'LIVE_ORDER_CANCELLED', orderId, response, submitted: true };
    this.logExecution(event);
    return event;
  }

  async replace(orderId, rawIntent) {
    const evaluation = await this.evaluate(rawIntent, { fetchMetadata: true });
    if (evaluation.decision !== 'ALLOW_LIVE_SUBMISSION') {
      this.logEvent({ ...evaluation, type: 'LIVE_REPLACE_REFUSED', orderId });
      return { ...evaluation, type: 'LIVE_REPLACE_REFUSED', orderId };
    }
    const intent = normalizeIntent(rawIntent);
    const response = await this.live.replaceOrder({ orderId, replacementIntent: intent, meta: evaluation.metadata });
    const event = { timestamp: nowIso(), type: 'LIVE_ORDER_REPLACED', orderId, intent: redactIntent(intent), response };
    this.logExecution(event);
    return event;
  }

  async reconcile() {
    const allowed = this.live.secretAccessDecision('reconcile');
    if (!allowed.ok) {
      const event = {
        timestamp: nowIso(),
        type: 'LIVE_RECONCILE_REFUSED',
        decision: 'REFUSED',
        reasons: allowed.reasons,
        walletAddress: redactWallet(process.env.POLYMARKET_PROXY_WALLET_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS || process.env.DEPOSIT_WALLET_ADDRESS),
        usdcBalance: null,
        gasBalance: null,
        openOrdersCount: 0,
        openOrdersUsd: 0,
        positionsCount: 0,
        positionsUsd: 0,
        recentFillsCount: 0,
        lastReconciledAt: nowIso(),
        submitted: false,
        signed: false,
      };
      this.saveReconcileSnapshot(event);
      this.logExecution(event);
      return event;
    }

    let state;
    try {
      state = await this.live.reconcile();
    } catch (e) {
      state = {
        timestamp: nowIso(),
        walletAddress: null,
        usdcBalance: null,
        gasBalance: null,
        openOrdersCount: 0,
        openOrdersUsd: 0,
        positionsCount: 0,
        positionsUsd: 0,
        recentFillsCount: 0,
        lastReconciledAt: nowIso(),
        errors: [safeError(e)],
      };
    }
    const event = { ...state, type: state.errors?.length ? 'LIVE_RECONCILE_REFUSED' : 'LIVE_RECONCILE', decision: state.errors?.length ? 'REFUSED' : 'OK', submitted: false, signed: false };
    this.saveReconcileSnapshot(event);
    this.logExecution(event);
    return event;
  }

  async authCheck() {
    const event = await this.live.authCheck();
    this.logEvent(event);
    return event;
  }

  async signingTest(rawIntent) {
    const intent = normalizeIntent(rawIntent);
    const metadataSafety = await evaluateMetadataSafety(null, intent, this.config);
    const event = await this.live.signingTest(intent, metadataSafety.meta);
    event.metadata = metadataSafety.meta;
    event.metadataReasons = metadataSafety.reasons;
    this.logEvent(event);
    return event;
  }

  async metadataTest(rawIntent) {
    const intent = normalizeIntent(rawIntent);
    const metadataSafety = await evaluateMetadataSafety(null, intent, this.config);
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_METADATA_TEST',
      decision: metadataSafety.ok ? 'OK' : 'REFUSED',
      reasons: metadataSafety.reasons,
      intent: redactIntent(intent),
      metadata: metadataSafety.meta,
      submitted: false,
      signed: false,
    };
    this.logEvent(event);
    return event;
  }

  lossGuardTest() {
    const sample = normalizeIntent(readIntentFromArgs(this.baseDir, []));
    const cases = [
      { name: 'daily loss under limit', intent: { ...sample, currentDailyLivePnlUsd: -Math.abs(this.config.liveDailyMaxLossUsd) + 0.01 } },
      { name: 'daily loss over limit', intent: { ...sample, currentDailyLivePnlUsd: -Math.abs(this.config.liveDailyMaxLossUsd) - 0.01 } },
      { name: 'exposure under cap', intent: { ...sample, currentLiveExposureUsd: Math.max(0, this.config.maxLiveTotalExposureUsd - sample.sizeUsd - 0.01) } },
      { name: 'exposure over cap', intent: { ...sample, currentLiveExposureUsd: this.config.maxLiveTotalExposureUsd } },
      { name: 'order over cap', intent: { ...sample, sizeUsd: this.config.maxLiveOrderUsd + 0.01 } },
    ].map((testCase) => {
      const result = evaluateLossExposureGuards(this.config, testCase.intent);
      return { name: testCase.name, allowedPastGuard: result.ok, reasons: result.reasons };
    });

    const event = { timestamp: nowIso(), type: 'LIVE_LOSS_GUARD_TEST', cases, submitted: false, signed: false };
    this.logEvent(event);
    return event;
  }

  burnInCheck(rawIntent = null) {
    const stateBurnIn = burnInFromState(this.baseDir);
    const intent = normalizeIntent(rawIntent || { ...readIntentFromArgs(this.baseDir, []), paperBurnIn: stateBurnIn });
    const result = evaluateBurnIn(this.config, intent);
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_BURN_IN_CHECK',
      decision: result.ok ? 'OK' : 'REFUSED',
      reasons: result.reasons,
      burnIn: intent.paperBurnIn,
      source: result.source,
      submitted: false,
      signed: false,
    };
    this.logEvent(event);
    return event;
  }

  async cancelReplaceTest(rawIntent, { dryRun = true } = {}) {
    const intent = normalizeIntent(rawIntent);
    const metadataSafety = await evaluateMetadataSafety(null, intent, this.config);
    const existing = syntheticExistingOrder(intent, this.config);
    const plan = buildCancelReplacePlan(this.config, intent, existing, metadataSafety.meta);
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_CANCEL_REPLACE_TEST',
      decision: dryRun ? 'DRY_RUN_PLAN' : 'REFUSED',
      reasons: dryRun ? [] : ['REAL_CANCEL_REPLACE_TEST_REQUIRES_MANUAL_REVIEW'],
      dryRun,
      plan,
      submitted: false,
      signed: false,
    };
    this.logEvent(event);
    return event;
  }

  doctor() {
    const cfg = this.config;
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_ADAPTER_DOCTOR',
      baseDir: this.baseDir,
      commands: [
        'doctor',
        'auth-check',
        'signing-test',
        'metadata-test',
        'reconcile',
        'loss-guard-test',
        'cancel-replace-test --dry-run',
        'burn-in-check',
        'evaluate-sample',
      ],
      flags: {
        enableLiveTrading: cfg.enableLiveTrading,
        liveAutoExecute: cfg.liveAutoExecute,
        liveKillSwitch: cfg.liveKillSwitch,
        liveDryRunOnly: cfg.liveDryRunOnly,
        liveSubmitConfirm: cfg.liveSubmitConfirm,
        liveAuthCheckAllow: cfg.liveAuthCheckAllow,
        liveSigningTestAllow: cfg.liveSigningTestAllow,
        liveReconcileAllow: cfg.liveReconcileAllow,
        liveCancelReplaceEnabled: cfg.liveCancelReplaceEnabled,
        liveCancelStaleOrders: cfg.liveCancelStaleOrders,
        liveCancelTestAllow: cfg.liveCancelTestAllow,
        liveRequireBurnIn: cfg.liveRequireBurnIn,
        liveWhaleCopyTrading: cfg.liveWhaleCopyTrading,
        liveAllowOracleSniper: cfg.liveAllowOracleSniper,
        maxLiveOrderUsd: cfg.maxLiveOrderUsd,
        maxLiveTotalExposureUsd: cfg.maxLiveTotalExposureUsd,
        liveDailyMaxLossUsd: cfg.liveDailyMaxLossUsd,
        liveSecretsPath: cfg.liveSecretsPath,
      },
      canSubmitLive: this.live.canSubmitLive(),
      secretsFilePresent: secretFileExists(cfg),
      submitted: false,
      signed: false,
    };
    this.logEvent(event);
    return event;
  }
}

function redactIntent(intent) {
  return {
    id: intent.id,
    timestamp: intent.timestamp,
    source: intent.source,
    strategy: intent.strategy,
    route: intent.route,
    tokenId: shortId(intent.tokenId, 10, 6),
    marketId: intent.marketId,
    side: intent.side,
    price: intent.price,
    sizeUsd: intent.sizeUsd,
    sizeShares: intent.sizeShares,
    orderType: intent.orderType,
    postOnly: intent.postOnly,
    reason: intent.reason,
    confidence: intent.confidence,
    sophieApproved: intent.sophieApproved,
    consensusScore: Number.isFinite(intent.consensusScore) ? intent.consensusScore : null,
    whaleCopy: intent.whaleCopy,
    oracleSignal: intent.oracleSignal,
    bookFresh: intent.bookFresh,
    bookAgeMs: intent.bookAgeMs,
    bestBid: Number.isFinite(intent.bestBid) ? intent.bestBid : null,
    bestAsk: Number.isFinite(intent.bestAsk) ? intent.bestAsk : null,
    currentLiveExposureUsd: intent.currentLiveExposureUsd,
    currentDailyLivePnlUsd: intent.currentDailyLivePnlUsd,
    paperBurnIn: intent.paperBurnIn,
  };
}

// -----------------------------
// CLI
// -----------------------------
async function main() {
  const [, , command, ...args] = process.argv;
  const [arg1, arg2] = args;
  const baseDir = process.cwd();
  const adapter = new LiveAdapter({ baseDir });

  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(`Usage:
  node live_adapter_polymarket.js doctor
  node live_adapter_polymarket.js auth-check
  node live_adapter_polymarket.js signing-test [--intent intent.json]
  node live_adapter_polymarket.js metadata-test [--intent intent.json|--token-id TOKEN]
  node live_adapter_polymarket.js reconcile
  node live_adapter_polymarket.js loss-guard-test
  node live_adapter_polymarket.js cancel-replace-test --dry-run [--intent intent.json]
  node live_adapter_polymarket.js burn-in-check [--intent intent.json]
  node live_adapter_polymarket.js evaluate-sample
  node live_adapter_polymarket.js dry-run <intent.json>
  node live_adapter_polymarket.js submit <intent.json>
  node live_adapter_polymarket.js cancel <orderId>
  node live_adapter_polymarket.js replace <orderId> <intent.json>
`);
    return;
  }

  if (command === 'doctor') {
    printStructured(adapter.doctor());
    return;
  }

  if (command === 'auth-check') {
    printStructured(await adapter.authCheck());
    return;
  }

  if (command === 'signing-test') {
    const intent = readIntentFromArgs(baseDir, args);
    printStructured(await adapter.signingTest(intent));
    return;
  }

  if (command === 'metadata-test') {
    const intent = readIntentFromArgs(baseDir, args);
    printStructured(await adapter.metadataTest(intent));
    return;
  }

  if (command === 'loss-guard-test') {
    printStructured(adapter.lossGuardTest());
    return;
  }

  if (command === 'cancel-replace-test') {
    const dryRun = args.includes('--dry-run');
    const intent = readIntentFromArgs(baseDir, args);
    printStructured(await adapter.cancelReplaceTest(intent, { dryRun }));
    return;
  }

  if (command === 'burn-in-check') {
    const opts = parseCliArgs(args);
    const intent = opts.intent || opts.candidate || opts.file || opts._[0] ? readIntentFromArgs(baseDir, args) : null;
    printStructured(adapter.burnInCheck(intent));
    return;
  }

  if (command === 'evaluate-sample') {
    const result = await adapter.handleIntent(readIntentFromArgs(baseDir, []), { mode: 'dry-run', fetchMetadata: false });
    printStructured(result);
    return;
  }

  if (command === 'dry-run' || command === 'submit') {
    if (!arg1) throw new Error(`${command} requires <intent.json>`);
    const intentPath = path.resolve(baseDir, arg1);
    const intent = safeReadJson(intentPath);
    if (!intent) throw new Error(`Could not read intent JSON: ${intentPath}`);
    const result = await adapter.handleIntent(intent, { mode: command, fetchMetadata: command === 'submit' });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'cancel') {
    if (!arg1) throw new Error('cancel requires <orderId>');
    const result = await adapter.cancel(arg1);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'replace') {
    if (!arg1 || !arg2) throw new Error('replace requires <orderId> <intent.json>');
    const intentPath = path.resolve(baseDir, arg2);
    const intent = safeReadJson(intentPath);
    if (!intent) throw new Error(`Could not read intent JSON: ${intentPath}`);
    const result = await adapter.replace(arg1, intent);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'reconcile') {
    const result = await adapter.reconcile();
    printStructured(result);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[LIVE-ADAPTER ERROR] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  LiveAdapter,
  PolymarketLiveClient,
  readConfig,
  normalizeIntent,
  evaluateStaticSafety,
  evaluateMetadataSafety,
  evaluateBurnIn,
  evaluateLossExposureGuards,
};
