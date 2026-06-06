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

    enableLiveTrading: toBool(process.env.ENABLE_LIVE_TRADING, false),
    liveAutoExecute: toBool(process.env.LIVE_AUTO_EXECUTE, false),
    liveKillSwitch: toBool(process.env.LIVE_KILL_SWITCH, true),
    liveDryRunOnly: toBool(process.env.LIVE_DRY_RUN_ONLY, true),
    liveRequireSophieApproval: toBool(process.env.LIVE_REQUIRE_SOPHIE_APPROVAL, true),
    liveRequireFreshBook: toBool(process.env.LIVE_REQUIRE_FRESH_BOOK, true),
    liveCancelStaleOrders: toBool(process.env.LIVE_CANCEL_STALE_ORDERS, true),
    liveWhaleCopyTrading: toBool(process.env.LIVE_WHALE_COPY_TRADING, false),
    liveAllowOracleSniper: toBool(process.env.LIVE_ALLOW_ORACLE_SNIPER, false),
    livePostOnlyDefault: toBool(process.env.LIVE_POST_ONLY_DEFAULT, true),

    maxLiveOrderUsd: toNum(process.env.MAX_LIVE_ORDER_USD, 1),
    maxLiveTotalExposureUsd: toNum(process.env.MAX_LIVE_TOTAL_EXPOSURE_USD, 10),
    liveDailyMaxLossUsd: toNum(process.env.LIVE_DAILY_MAX_LOSS_USD, 3),
    liveStaleOrderMs: toNum(process.env.LIVE_STALE_ORDER_MS, 45000),
    liveMaxBookAgeMs: toNum(process.env.LIVE_MAX_BOOK_AGE_MS, 1500),
    liveMinBurnInReports: toNum(process.env.LIVE_BURN_IN_MIN_REPORTS, 3),
    liveMinBurnInClosedPnlUsd: toNum(process.env.LIVE_BURN_IN_MIN_CLOSED_PNL_USD, 0),
    liveMaxBurnInDrawdownPct: toNum(process.env.LIVE_BURN_IN_MAX_DRAWDOWN_PCT, 2),
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
    timestamp: rawIntent.timestamp || nowIso(),
    source: rawIntent.source || rawIntent.strategy || 'UNKNOWN',
    route: rawIntent.route || rawIntent.routeMode || 'UNKNOWN',
    tokenId: String(rawIntent.tokenId || rawIntent.tokenID || rawIntent.asset_id || ''),
    marketId: rawIntent.marketId || rawIntent.conditionId || rawIntent.market || null,
    side: String(rawIntent.side || '').toUpperCase(),
    price: Number(rawIntent.price),
    sizeUsd: Number(rawIntent.sizeUsd || rawIntent.usd || rawIntent.amountUsd || 0),
    sizeShares: rawIntent.sizeShares !== undefined ? Number(rawIntent.sizeShares) : null,
    orderType: rawIntent.orderType || 'GTC',
    postOnly: rawIntent.postOnly,
    reason: rawIntent.reason || '',
    confidence: rawIntent.confidence !== undefined ? Number(rawIntent.confidence) : null,
    sophieApproved: Boolean(rawIntent.sophieApproved || rawIntent.sophie?.approved),
    consensusScore: rawIntent.consensusScore !== undefined ? Number(rawIntent.consensusScore) : Number(rawIntent.sophie?.score ?? NaN),
    whaleCopy: Boolean(rawIntent.whaleCopy || rawIntent.source === 'WhaleCopy'),
    oracleSignal: Boolean(rawIntent.oracleSignal || rawIntent.source === 'BTCOracle'),
    bookFresh: rawIntent.bookFresh !== undefined ? Boolean(rawIntent.bookFresh) : null,
    bookAgeMs: rawIntent.bookAgeMs !== undefined ? Number(rawIntent.bookAgeMs) : null,
    currentLiveExposureUsd: Number(rawIntent.currentLiveExposureUsd || 0),
    currentDailyLivePnlUsd: Number(rawIntent.currentDailyLivePnlUsd || 0),
    paperBurnIn: rawIntent.paperBurnIn || rawIntent.burnIn || null,
    tickSize: rawIntent.tickSize || null,
    negRisk: rawIntent.negRisk !== undefined ? Boolean(rawIntent.negRisk) : null,
    minOrderSize: rawIntent.minOrderSize !== undefined ? Number(rawIntent.minOrderSize) : null,
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
  if (config.liveBurnInOkOverride) return { ok: true, reasons: [], source: 'LIVE_BURN_IN_OK' };

  const burn = intent.paperBurnIn;
  if (!burn || typeof burn !== 'object') {
    return { ok: false, reasons: ['BURN_IN_MISSING'], source: 'intent.paperBurnIn' };
  }

  const reasons = [];
  const reports = Number(burn.reports || burn.reportCount || 0);
  const closedPnl = Number(burn.closedPnlUsd || burn.closedPnl || 0);
  const drawdown = Number(burn.drawdownPct || burn.drawdown || 0);
  const ghostFav = Number(burn.ghostFavorablePct || burn.ghostFavorable || 0);

  if (burn.ok !== true) reasons.push('BURN_IN_NOT_MARKED_OK');
  if (reports < config.liveMinBurnInReports) reasons.push('BURN_IN_REPORTS_TOO_LOW');
  if (closedPnl < config.liveMinBurnInClosedPnlUsd) reasons.push('BURN_IN_CLOSED_PNL_TOO_LOW');
  if (drawdown > config.liveMaxBurnInDrawdownPct) reasons.push('BURN_IN_DRAWDOWN_TOO_HIGH');
  if (ghostFav < config.liveMinGhostFavorablePct) reasons.push('BURN_IN_GHOST_FAVORABLE_TOO_LOW');

  return { ok: reasons.length === 0, reasons, source: 'intent.paperBurnIn' };
}

function evaluateStaticSafety(config, intent) {
  const reasons = [];

  if (!config.enableLiveTrading) reasons.push('LIVE_DISABLED');
  if (!config.liveAutoExecute) reasons.push('AUTO_EXECUTE_DISABLED');
  if (config.liveKillSwitch) reasons.push('KILL_SWITCH_ACTIVE');
  if (config.liveDryRunOnly) reasons.push('DRY_RUN_ONLY');

  if (!intent.tokenId) reasons.push('TOKEN_ID_MISSING');
  if (!['BUY', 'SELL'].includes(intent.side)) reasons.push('INVALID_SIDE');
  if (!Number.isFinite(intent.price) || intent.price <= 0 || intent.price >= 1) reasons.push('INVALID_PRICE');
  if (!Number.isFinite(intent.sizeUsd) || intent.sizeUsd <= 0) reasons.push('INVALID_SIZE_USD');
  if (intent.sizeUsd > config.maxLiveOrderUsd) reasons.push('MAX_ORDER_USD_EXCEEDED');
  if (intent.currentLiveExposureUsd + intent.sizeUsd > config.maxLiveTotalExposureUsd) reasons.push('MAX_TOTAL_EXPOSURE_EXCEEDED');
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

async function evaluateMetadataSafety(client, intent) {
  const reasons = [];
  const meta = {
    tickSize: intent.tickSize || null,
    negRisk: intent.negRisk,
    minOrderSize: intent.minOrderSize,
  };

  if (client) {
    try {
      const book = await client.getOrderBook(intent.tokenId);
      if (book) {
        meta.tickSize = meta.tickSize || book.tick_size || book.tickSize || book.minimum_tick_size || null;
        meta.negRisk = meta.negRisk !== null && meta.negRisk !== undefined ? meta.negRisk : Boolean(book.neg_risk ?? book.negRisk ?? false);
        meta.minOrderSize = Number(meta.minOrderSize || book.min_order_size || book.minOrderSize || book.minimum_order_size || 0);
      }
    } catch (e) {
      reasons.push(`ORDERBOOK_METADATA_FAILED:${e.message}`);
    }

    if (!meta.tickSize) {
      try {
        meta.tickSize = await client.getTickSize(intent.tokenId);
      } catch (e) {
        reasons.push(`TICK_SIZE_LOOKUP_FAILED:${e.message}`);
      }
    }

    if (meta.negRisk === null || meta.negRisk === undefined) {
      try {
        meta.negRisk = await client.getNegRisk(intent.tokenId);
      } catch (e) {
        reasons.push(`NEG_RISK_LOOKUP_FAILED:${e.message}`);
      }
    }
  }

  meta.tickSize = meta.tickSize || '0.01';
  meta.negRisk = Boolean(meta.negRisk);
  meta.minOrderSize = Number(meta.minOrderSize || 0);

  if (!priceConformsToTick(intent.price, meta.tickSize)) {
    reasons.push('PRICE_TICK_SIZE_INVALID');
  }

  if (meta.minOrderSize > 0 && intent.sizeShares < meta.minOrderSize) {
    reasons.push('MIN_ORDER_SIZE_NOT_MET');
  }

  return { ok: reasons.length === 0, reasons, meta };
}

// -----------------------------
// Polymarket live client wrapper
// -----------------------------
class PolymarketLiveClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.sdk = null;
  }

  shouldLoadSecrets() {
    return this.config.enableLiveTrading && this.config.liveAutoExecute && !this.config.liveKillSwitch && !this.config.liveDryRunOnly;
  }

  async init() {
    if (this.client) return this.client;
    if (!this.shouldLoadSecrets()) {
      throw new Error('Refusing to initialize live client while live flags are not fully enabled');
    }

    const secretPath = path.resolve(this.config.baseDir, this.config.liveSecretsPath);
    loadEnvFile(secretPath, { override: false, required: true });

    const privateKey = normalizePrivateKey(process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY);
    if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY missing in live secrets');

    const funderAddress = process.env.POLYMARKET_PROXY_WALLET_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS || process.env.DEPOSIT_WALLET_ADDRESS;
    const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 3);

    const sdk = await import('@polymarket/clob-client-v2');
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(privateKey);
    const signer = createWalletClient({ account, transport: http() });

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
    return this.client;
  }

  async reconcile(params = {}) {
    const client = await this.init();
    const sdk = this.sdk;
    const assetType = sdk.AssetType || { COLLATERAL: 'COLLATERAL', CONDITIONAL: 'CONDITIONAL' };
    const openOrders = await client.getOpenOrders(params.openOrderParams || undefined);
    const collateral = await client.getBalanceAllowance({ asset_type: assetType.COLLATERAL });
    return {
      timestamp: nowIso(),
      openOrders,
      collateral,
    };
  }

  async cancelOrder(orderId) {
    if (!orderId) throw new Error('orderId required');
    const client = await this.init();
    return client.cancelOrder(orderId);
  }

  async cancelMarketOrders({ marketId, tokenId } = {}) {
    const client = await this.init();
    return client.cancelMarketOrders({ market: marketId, asset_id: tokenId });
  }

  async signAndSubmit(intent, meta) {
    const client = await this.init();
    const sdk = this.sdk;
    const side = intent.side === 'BUY' ? sdk.Side.BUY : sdk.Side.SELL;
    const orderType = sdk.OrderType[intent.orderType] || sdk.OrderType.GTC;
    const postOnly = intent.postOnly !== undefined ? Boolean(intent.postOnly) : this.config.livePostOnlyDefault;

    const userOrder = {
      tokenID: intent.tokenId,
      price: Number(intent.price),
      size: Number(intent.sizeShares),
      side,
    };

    const signedOrder = await client.createOrder(userOrder, {
      tickSize: String(meta.tickSize),
      negRisk: Boolean(meta.negRisk),
    });

    const response = await client.postOrder(signedOrder, orderType, postOnly);
    return { signedOrder, response };
  }

  async replaceOrder({ orderId, replacementIntent, meta }) {
    const cancelResponse = await this.cancelOrder(orderId);
    const submitResponse = await this.signAndSubmit(replacementIntent, meta);
    return { cancelResponse, submitResponse };
  }
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
    const file = path.resolve(this.baseDir, this.config.liveIntentLogPath);
    appendNdjson(file, event);
  }

  logExecution(event) {
    const file = path.resolve(this.baseDir, this.config.liveExecutionLogPath);
    appendNdjson(file, event);
  }

  async evaluate(rawIntent, options = {}) {
    const intent = normalizeIntent(rawIntent);
    const staticSafety = evaluateStaticSafety(this.config, intent);
    let metadataSafety = { ok: true, reasons: [], meta: { tickSize: intent.tickSize || '0.01', negRisk: Boolean(intent.negRisk), minOrderSize: Number(intent.minOrderSize || 0) } };

    // Only ask CLOB for metadata when explicitly requested or live path is fully armed.
    const shouldFetchMetadata = options.fetchMetadata === true || this.live.shouldLoadSecrets();
    if (shouldFetchMetadata) {
      const client = this.live.shouldLoadSecrets() ? await this.live.init() : null;
      metadataSafety = await evaluateMetadataSafety(client, intent);
    } else {
      metadataSafety = await evaluateMetadataSafety(null, intent);
    }

    const reasons = [...staticSafety.reasons, ...metadataSafety.reasons];
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
        secretsRead: this.live.shouldLoadSecrets(),
        privateKeyAccessed: false,
        staticSafety,
        metadataSafety,
      },
    };
  }

  async handleIntent(rawIntent, options = {}) {
    const evaluation = await this.evaluate(rawIntent, options);

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
    const result = await this.live.signAndSubmit(intent, evaluation.metadata);
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_ORDER_SUBMITTED',
      decision: 'SUBMITTED',
      intent: redactIntent(intent),
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
    if (!this.live.shouldLoadSecrets()) {
      const event = {
        timestamp: nowIso(),
        type: 'LIVE_CANCEL_REFUSED',
        decision: 'REFUSED',
        reasons: ['LIVE_NOT_FULLY_ENABLED'],
        orderId,
      };
      this.logEvent(event);
      return event;
    }
    const response = await this.live.cancelOrder(orderId);
    const event = { timestamp: nowIso(), type: 'LIVE_ORDER_CANCELLED', orderId, response };
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
    if (!this.live.shouldLoadSecrets()) {
      return {
        timestamp: nowIso(),
        type: 'LIVE_RECONCILE_REFUSED',
        decision: 'REFUSED',
        reasons: ['LIVE_NOT_FULLY_ENABLED'],
        note: 'Reconciliation requires authenticated CLOB access; live flags are not fully enabled.',
      };
    }
    const state = await this.live.reconcile();
    const event = { timestamp: nowIso(), type: 'LIVE_RECONCILE', state };
    this.logExecution(event);
    return event;
  }
}

function redactIntent(intent) {
  return {
    id: intent.id,
    timestamp: intent.timestamp,
    source: intent.source,
    route: intent.route,
    tokenId: intent.tokenId,
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
    currentLiveExposureUsd: intent.currentLiveExposureUsd,
    currentDailyLivePnlUsd: intent.currentDailyLivePnlUsd,
    paperBurnIn: intent.paperBurnIn,
  };
}

// -----------------------------
// CLI
// -----------------------------
async function main() {
  const [, , command, arg1, arg2] = process.argv;
  const baseDir = process.cwd();
  const adapter = new LiveAdapter({ baseDir });

  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(`Usage:
  node live_adapter_polymarket.js doctor
  node live_adapter_polymarket.js dry-run <intent.json>
  node live_adapter_polymarket.js submit <intent.json>
  node live_adapter_polymarket.js cancel <orderId>
  node live_adapter_polymarket.js replace <orderId> <intent.json>
  node live_adapter_polymarket.js reconcile
`);
    return;
  }

  if (command === 'doctor') {
    const cfg = adapter.config;
    console.log(JSON.stringify({
      timestamp: nowIso(),
      type: 'LIVE_ADAPTER_DOCTOR',
      baseDir,
      flags: {
        enableLiveTrading: cfg.enableLiveTrading,
        liveAutoExecute: cfg.liveAutoExecute,
        liveKillSwitch: cfg.liveKillSwitch,
        liveDryRunOnly: cfg.liveDryRunOnly,
        liveWhaleCopyTrading: cfg.liveWhaleCopyTrading,
        liveAllowOracleSniper: cfg.liveAllowOracleSniper,
        maxLiveOrderUsd: cfg.maxLiveOrderUsd,
        maxLiveTotalExposureUsd: cfg.maxLiveTotalExposureUsd,
        liveDailyMaxLossUsd: cfg.liveDailyMaxLossUsd,
        liveSecretsPath: cfg.liveSecretsPath,
      },
      canInitializeLiveClient: adapter.live.shouldLoadSecrets(),
    }, null, 2));
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
    console.log(JSON.stringify(result, null, 2));
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
};
