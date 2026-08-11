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
const { buildLiveAccountTruthSnapshot } = require('./lib/polymarket_live_account_truth');
const { createReadOnlyAccountTruthSource } = require('./lib/polymarket_live_account_truth_readonly_client');
const {
  SCOPE: SINGLE_CANARY_SCOPE,
  STATES: CANARY_STATES,
  CanarySessionStore,
  evaluateSingleCanaryBaseline,
  reconcileExactCanaryOrder,
  submitCanaryExactlyOnce,
} = require('./lib/stage5_canary_session');

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

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toOptionalBool(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function normalizeAddress(value) {
  const s = String(value || '').trim();
  return s ? s.toLowerCase() : '';
}

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
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
  if (!localEnvFileReadEnabled()) {
    return { loaded: false, path: path.resolve(filePath), skipped: true };
  }
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

function localEnvFileReadEnabled() {
  const raw = String(
    process.env.MM_SKIP_LOCAL_ENV_FILE ||
    process.env.SKIP_LOCAL_ENV_FILE ||
    ''
  ).trim().toLowerCase();
  return !['1', 'true', 'yes', 'on'].includes(raw);
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
    if (value === undefined || value === null || value === '') continue;
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

function resolvePolymarketSignatureType(rawValue = process.env.POLYMARKET_SIGNATURE_TYPE) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : 3;
}

function resolvePolymarketBuilderCode(env = process.env) {
  const rawValue = firstString(env.POLY_BUILDER_CODE);
  if (!rawValue) {
    return {
      builderCode: null,
      present: false,
      valid: true,
      errors: [],
    };
  }
  const valid = /^0x[0-9a-fA-F]+$/.test(rawValue);
  return {
    builderCode: valid ? rawValue : null,
    present: true,
    valid,
    errors: valid ? [] : ['POLY_BUILDER_CODE_INVALID_HEX'],
  };
}

function resolvePolymarketFunderAddress(env = process.env) {
  const signatureType = resolvePolymarketSignatureType(env.POLYMARKET_SIGNATURE_TYPE);
  const depositAddress = firstString(env.DEPOSIT_WALLET_ADDRESS) || null;
  const configuredFunderAddress = firstString(env.POLYMARKET_FUNDER_ADDRESS) || null;
  const proxyWalletAddress = firstString(env.POLYMARKET_PROXY_WALLET_ADDRESS) || null;
  const depositNorm = normalizeAddress(depositAddress);
  const funderNorm = normalizeAddress(configuredFunderAddress);
  const proxyNorm = normalizeAddress(proxyWalletAddress);
  const warnings = [];
  const errors = [];
  let funderAddress = null;
  let source = null;

  if (signatureType === 3) {
    if (!depositNorm && !funderNorm) {
      errors.push('TYPE_3_FUNDER_MISSING');
    } else if (depositNorm && funderNorm && depositNorm !== funderNorm) {
      errors.push('TYPE_3_FUNDER_DEPOSIT_MISMATCH');
    } else if (depositNorm) {
      funderAddress = depositAddress;
      source = 'DEPOSIT_WALLET_ADDRESS';
    } else if (funderNorm) {
      funderAddress = configuredFunderAddress;
      source = 'POLYMARKET_FUNDER_ADDRESS';
    }

    if (proxyNorm && normalizeAddress(funderAddress) && proxyNorm !== normalizeAddress(funderAddress)) {
      warnings.push('TYPE_3_PROXY_IGNORED');
    }
  } else {
    funderAddress = proxyWalletAddress || configuredFunderAddress || depositAddress || null;
    source = proxyWalletAddress
      ? 'POLYMARKET_PROXY_WALLET_ADDRESS'
      : configuredFunderAddress
        ? 'POLYMARKET_FUNDER_ADDRESS'
        : depositAddress
          ? 'DEPOSIT_WALLET_ADDRESS'
          : null;
    if (proxyNorm && funderNorm && proxyNorm !== funderNorm) warnings.push('NON_TYPE3_PROXY_DIFFERS_FROM_FUNDER');
    if (proxyNorm && depositNorm && proxyNorm !== depositNorm) warnings.push('NON_TYPE3_PROXY_DIFFERS_FROM_DEPOSIT');
  }

  return {
    signatureType,
    funderAddress,
    source,
    depositAddress,
    configuredFunderAddress,
    proxyWalletAddress,
    warnings,
    errors,
  };
}

function missingEnv(names) {
  return names.filter((name) => !process.env[name]);
}

function secretFileExists(config) {
  return fs.existsSync(path.resolve(config.baseDir, config.liveSecretsPath));
}

const LIVE_STAGE_PROFILES = Object.freeze({
  0: {
    stage: 0,
    name: 'paper_only',
    description: 'Stage 0: paper only',
    submitAllowed: false,
    maxLiveOrderUsd: 0,
    maxLiveTotalExposureUsd: 0,
    liveDailyMaxLossUsd: 0,
    maxOrdersPerHour: 0,
    singleMarketOnly: false,
  },
  1: {
    stage: 1,
    name: 'live_auth_dry_run_only',
    description: 'Stage 1: live auth dry-run only',
    submitAllowed: false,
    maxLiveOrderUsd: 0,
    maxLiveTotalExposureUsd: 0,
    liveDailyMaxLossUsd: 0,
    maxOrdersPerHour: 0,
    singleMarketOnly: false,
  },
  2: {
    stage: 2,
    name: 'canary_live',
    description: 'Stage 2: canary live, max $1, one market only, one order per hour',
    submitAllowed: true,
    maxLiveOrderUsd: 1,
    maxLiveTotalExposureUsd: 1,
    liveDailyMaxLossUsd: 1,
    maxOrdersPerHour: 1,
    singleMarketOnly: true,
  },
  3: {
    stage: 3,
    name: 'micro_live',
    description: 'Stage 3: micro-live, max $2, max daily loss $5',
    submitAllowed: true,
    maxLiveOrderUsd: 2,
    maxLiveTotalExposureUsd: 2,
    liveDailyMaxLossUsd: 5,
    maxOrdersPerHour: 6,
    singleMarketOnly: false,
  },
  4: {
    stage: 4,
    name: 'normal_live',
    description: 'Stage 4: normal live, explicit manual env change required',
    submitAllowed: true,
    maxLiveOrderUsd: null,
    maxLiveTotalExposureUsd: null,
    liveDailyMaxLossUsd: null,
    maxOrdersPerHour: null,
    singleMarketOnly: false,
  },
  5: {
    stage: 5,
    name: 'min_viable_canary',
    description: 'Stage 5: minimum viable manual canary, max $5, one market only, one order per hour',
    submitAllowed: true,
    maxLiveOrderUsd: 5,
    maxLiveTotalExposureUsd: 5,
    liveDailyMaxLossUsd: 5,
    maxOrdersPerHour: 1,
    singleMarketOnly: true,
  },
});

const REQUIRED_LIVE_SECRET_ENV = Object.freeze([
  'POLYMARKET_PRIVATE_KEY',
  'POLYMARKET_API_KEY',
  'POLYMARKET_API_SECRET',
  'POLYMARKET_API_PASSPHRASE',
]);

const REQUIRED_FUNDER_ENV = Object.freeze([
  'POLYMARKET_PROXY_WALLET_ADDRESS',
  'POLYMARKET_FUNDER_ADDRESS',
  'DEPOSIT_WALLET_ADDRESS',
]);

function resolveLiveStageProfile(configLike = {}) {
  const requestedStage = Math.max(0, Math.min(5, toInt(configLike.liveTradingStage, 0)));
  const base = LIVE_STAGE_PROFILES[requestedStage] || LIVE_STAGE_PROFILES[0];
  return {
    ...base,
    maxLiveOrderUsd: base.maxLiveOrderUsd == null ? Number(configLike.maxLiveOrderUsd || 0) : Math.min(Number(configLike.maxLiveOrderUsd || 0), base.maxLiveOrderUsd),
    maxLiveTotalExposureUsd: base.maxLiveTotalExposureUsd == null
      ? Number(configLike.maxLiveTotalExposureUsd || 0)
      : Math.min(Number(configLike.maxLiveTotalExposureUsd || 0), base.maxLiveTotalExposureUsd),
    liveDailyMaxLossUsd: base.liveDailyMaxLossUsd == null
      ? Math.abs(Number(configLike.liveDailyMaxLossUsd || 0))
      : Math.min(Math.abs(Number(configLike.liveDailyMaxLossUsd || 0)), base.liveDailyMaxLossUsd),
    maxOrdersPerHour: base.maxOrdersPerHour == null ? toInt(configLike.liveMaxOrdersPerHour, 25) : base.maxOrdersPerHour,
    singleMarketId: String(configLike.liveCanaryMarketId || '').trim() || null,
  };
}

function secretFileStatus(config) {
  const resolved = path.resolve(config.baseDir, config.liveSecretsPath);
  const exists = fs.existsSync(resolved);
  let readable = false;
  let writable = false;
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
    readable = true;
  } catch (_) {}
  try {
    fs.accessSync(resolved, fs.constants.W_OK);
    writable = true;
  } catch (_) {}
  return {
    path: resolved,
    exists,
    readable,
    writable,
  };
}

// -----------------------------
// Network / signing-proof helpers
// -----------------------------

const NETWORK_ERROR_TOKENS = Object.freeze([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'getaddrinfo',
  'fetch failed',
  'network request failed',
  'socket hang up',
]);

function classifySigningError(err) {
  if (!err) return { kind: 'UNKNOWN', message: '' };
  const message = err && err.message ? String(err.message) : String(err);
  const code = err && err.code ? String(err.code) : '';
  const causeMessage = err && err.cause && err.cause.message ? String(err.cause.message) : '';
  const causeCode = err && err.cause && err.cause.code ? String(err.cause.code) : '';
  const haystack = `${code} ${causeCode} ${message} ${causeMessage}`.toLowerCase();
  for (const token of NETWORK_ERROR_TOKENS) {
    if (haystack.includes(token.toLowerCase())) {
      return { kind: 'NETWORK_REQUIRED_FOR_SIGNING_PROOF', message };
    }
  }
  return { kind: 'SIGNING_ERROR', message };
}

async function probeHostReachable(rawUrl, { timeoutMs = 3000, method = 'GET', healthPath = '' } = {}) {
  const started = Date.now();
  let urlStr = String(rawUrl || '').trim();
  if (!urlStr) {
    return { reachable: false, latencyMs: 0, status: null, error: 'NO_URL_CONFIGURED' };
  }
  if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;
  let target;
  try {
    const u = new URL(urlStr);
    if (healthPath && (u.pathname === '/' || u.pathname === '')) {
      u.pathname = healthPath;
    }
    target = u.toString();
  } catch (e) {
    return { reachable: false, latencyMs: 0, status: null, error: `INVALID_URL:${safeError(e)}` };
  }
  if (typeof fetch !== 'function') {
    return { reachable: false, latencyMs: 0, status: null, error: 'FETCH_UNAVAILABLE' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method, signal: controller.signal });
    const latencyMs = Date.now() - started;
    return { reachable: res.status < 500, latencyMs, status: res.status, error: null };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const classified = classifySigningError(e);
    return {
      reachable: false,
      latencyMs,
      status: null,
      error: classified.kind === 'NETWORK_REQUIRED_FOR_SIGNING_PROOF'
        ? `NETWORK_UNREACHABLE:${classified.message}`
        : safeError(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeRpcReachable(rawUrl, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  let urlStr = String(rawUrl || '').trim();
  if (!urlStr) {
    return { reachable: false, latencyMs: 0, status: null, error: 'NO_RPC_URL_CONFIGURED' };
  }
  if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;
  if (typeof fetch !== 'function') {
    return { reachable: false, latencyMs: 0, status: null, error: 'FETCH_UNAVAILABLE' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(urlStr, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    let chainId = null;
    try {
      const body = await res.json();
      if (body && typeof body.result === 'string') chainId = body.result;
    } catch (_) {}
    return { reachable: res.status < 500, latencyMs, status: res.status, chainId, error: null };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const classified = classifySigningError(e);
    return {
      reachable: false,
      latencyMs,
      status: null,
      chainId: null,
      error: classified.kind === 'NETWORK_REQUIRED_FOR_SIGNING_PROOF'
        ? `NETWORK_UNREACHABLE:${classified.message}`
        : safeError(e),
    };
  } finally {
    clearTimeout(timer);
  }
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
    riskApproved: true,
    oracleConfirmed: true,
    persistenceConfirmed: true,
    expectedEdge: 0.05,
    bookFresh: true,
    bookAgeMs: 250,
    signalAgeMs: 250,
    decisionLatencyMs: 100,
    currentLiveExposureUsd: 0,
    currentLiveExposureSource: 'synthetic_readiness_fixture',
    currentLiveExposureAuthenticatedReconciliation: true,
    currentLiveExposureObservedAt: nowIso(),
    currentDailyLivePnlUsd: 0,
    currentDailyLivePnlReconciled: true,
    currentDailyLivePnlObservedAt: nowIso(),
    liveOrdersLastHour: 0,
    liveOrdersLastHourReconciled: true,
    liveOrdersLastHourObservedAt: nowIso(),
    accountIdentityMatches: true,
    liveAccountSnapshotFresh: true,
    liveAccountSnapshotObservedAt: nowIso(),
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
  const config = {
    baseDir,
    clobHost: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
    polygonRpcUrl: process.env.POLYMARKET_RPC_URL || process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    chainId: Number(process.env.POLYMARKET_CHAIN_ID || process.env.CHAIN_ID || 137),
    liveSecretsPath: process.env.LIVE_SECRETS_PATH || './.env.live.secrets',
    liveIntentLogPath: process.env.LIVE_INTENT_LOG_PATH || './live_order_intents.ndjson',
    liveExecutionLogPath: process.env.LIVE_EXECUTION_LOG_PATH || './live_execution_events.ndjson',
    liveAdapterEventsPath: process.env.LIVE_ADAPTER_EVENTS_PATH || './live_adapter_events.ndjson',
    liveReconcileSnapshotPath: process.env.LIVE_RECONCILE_SNAPSHOT_PATH || './live_reconcile_snapshot.json',
    stage5CanarySessionPath: process.env.STAGE5_CANARY_SESSION_PATH || './runtime_monitor/stage5_canary_session.json',

    enableLiveTrading: toBool(process.env.ENABLE_LIVE_TRADING, false),
    liveAutoExecute: toBool(process.env.LIVE_AUTO_EXECUTE, false),
    liveKillSwitch: toBool(process.env.LIVE_KILL_SWITCH, true),
    liveDryRunOnly: toBool(process.env.LIVE_DRY_RUN_ONLY, true),
    liveSubmitConfirm: toBool(process.env.LIVE_SUBMIT_CONFIRM, false),
    liveFinalBossReady: toBool(process.env.LIVE_FINAL_BOSS_READY, false),
    liveTradingStage: Math.max(0, Math.min(5, toInt(process.env.LIVE_TRADING_STAGE, 0))),
    liveAuthCheckAllow: toBool(process.env.LIVE_AUTH_CHECK_ALLOW, false),
    liveSigningTestAllow: toBool(process.env.LIVE_SIGNING_TEST_ALLOW, false),
    liveReconcileAllow: toBool(process.env.LIVE_RECONCILE_ALLOW, false),
    liveRequireSophieApproval: toBool(process.env.LIVE_REQUIRE_SOPHIE_APPROVAL, true),
    liveRequireRiskApproval: toBool(process.env.LIVE_REQUIRE_RISK_APPROVAL, true),
    liveRequireFreshBook: toBool(process.env.LIVE_REQUIRE_FRESH_BOOK, true),
    liveRequireBurnIn: toBool(process.env.LIVE_REQUIRE_BURN_IN, true),
    liveRequireOracleConfirmation: toBool(process.env.LIVE_REQUIRE_ORACLE_CONFIRMATION, true),
    liveRequirePersistenceConfirmation: toBool(process.env.LIVE_REQUIRE_PERSISTENCE_CONFIRMATION, true),
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
    liveMinExpectedEdge: toNum(process.env.LIVE_MIN_EXPECTED_EDGE, toNum(process.env.MIN_SIGNAL_EDGE, 0)),
    liveMaxSignalAgeMs: toNum(process.env.LIVE_MAX_SIGNAL_AGE_MS, 10_000),
    liveMaxDecisionLatencyMs: toNum(process.env.LIVE_MAX_DECISION_LATENCY_MS, 2_000),
    liveMaxOrderBuildLatencyMs: toNum(process.env.LIVE_MAX_ORDER_BUILD_LATENCY_MS, 2_000),
    liveMaxSubmitDryRunLatencyMs: toNum(process.env.LIVE_MAX_SUBMIT_DRY_RUN_LATENCY_MS, 2_500),
    liveMaxOrdersPerHour: toInt(process.env.LIVE_MAX_ORDERS_PER_HOUR, 25),
    liveAccountTruthTtlMs: toNum(process.env.LIVE_ACCOUNT_TRUTH_TTL_MS, 30_000),
    liveMinBurnInReports: toNum(process.env.LIVE_BURN_IN_MIN_REPORTS, 3),
    liveMinBurnInClosedPnlUsd: toNum(process.env.LIVE_BURN_IN_MIN_CLOSED_PNL_USD, 0),
    liveMaxBurnInDrawdownPct: toNum(process.env.LIVE_BURN_IN_MAX_DRAWDOWN_PCT, 3),
    liveMinGhostFavorablePct: toNum(process.env.LIVE_BURN_IN_MIN_GHOST_FAVORABLE_PCT, 0),
    liveBurnInOkOverride: toBool(process.env.LIVE_BURN_IN_OK, false),
    liveSophieMinScore: toNum(process.env.LIVE_SOPHIE_MIN_SCORE, toNum(process.env.CONSENSUS_THRESHOLD, 0.55)),
    liveExpectedSignerAddress: normalizeAddress(process.env.LIVE_EXPECTED_SIGNER_ADDRESS || ''),
    liveExpectedFunderAddress: normalizeAddress(process.env.LIVE_EXPECTED_FUNDER_ADDRESS || ''),
    liveCanaryMarketId: firstString(process.env.LIVE_CANARY_MARKET_ID),
  };
  config.liveStageProfile = resolveLiveStageProfile(config);
  return config;
}

// -----------------------------
// Intent normalization
// -----------------------------
function normalizeIntent(rawIntent) {
  if (!rawIntent || typeof rawIntent !== 'object') {
    throw new Error('Order intent must be an object');
  }

  const metadata = rawIntent.metadata || {};
  const riskMeta = metadata.risk || rawIntent.risk || {};
  const consensusMeta = metadata.consensus || rawIntent.consensus || rawIntent.sophie || {};
  const bookAfterPersistence = rawIntent.book_after_persistence || rawIntent.bookAfterPersistence || {};
  const timestampMs = parseTimestampMs(firstDefined(rawIntent.timestamp, rawIntent.ts));

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
    sophieApproved: Boolean(rawIntent.sophieApproved || rawIntent.sophie_approved || rawIntent.sophie?.approved || consensusMeta.authorized),
    consensusScore: firstNumber(rawIntent.consensusScore, rawIntent.consensus_score, rawIntent.sophie?.score, consensusMeta.score),
    riskApproved: toOptionalBool(firstDefined(
      rawIntent.riskApproved,
      rawIntent.risk_approved,
      rawIntent.riskAdmitted,
      rawIntent.risk_admitted,
      riskMeta.approved,
      riskMeta.admitted
    )),
    paperRiskApprovedSizeUsd: firstNumber(rawIntent.paperRiskApprovedSizeUsd, rawIntent.paper_risk_approved_size_usd, metadata.paperRiskApprovedSizeUsd),
    adjustedCandidateSizeUsd: firstNumber(rawIntent.adjustedCandidateSizeUsd, rawIntent.adjusted_candidate_size_usd, metadata.adjustedCandidateSizeUsd),
    riskApprovedSizeUsd: firstNumber(rawIntent.riskApprovedSizeUsd, rawIntent.risk_approved_size_usd, metadata.riskApprovedSizeUsd),
    adjustedSizeRiskApproved: toOptionalBool(firstDefined(rawIntent.adjustedSizeRiskApproved, rawIntent.adjusted_size_risk_approved, metadata.adjustedSizeRiskApproved)),
    adjustedSizeRiskBlocker: firstString(rawIntent.adjustedSizeRiskBlocker, rawIntent.adjusted_size_risk_blocker, metadata.adjustedSizeRiskBlocker) || null,
    liveStage: firstNumber(rawIntent.liveStage, rawIntent.live_stage, metadata.liveStageProfile?.stage),
    whaleCopy: Boolean(rawIntent.whaleCopy || rawIntent.whale_copy || rawIntent.source === 'WhaleCopy'),
    oracleSignal: Boolean(rawIntent.oracleSignal || rawIntent.oracle_signal || rawIntent.source === 'BTCOracle'),
    oracleConfirmed: toOptionalBool(firstDefined(
      rawIntent.oracleConfirmed,
      rawIntent.oracle_confirmed,
      rawIntent.confirmed,
      rawIntent.poly_lag_confirmed && rawIntent.lag_score_pass && rawIntent.obi_confirmed
    )),
    persistenceConfirmed: toOptionalBool(firstDefined(
      rawIntent.persistenceConfirmed,
      rawIntent.persistence_confirmed,
      metadata.persistenceConfirmed,
      bookAfterPersistence.valid
    )),
    bookFresh: firstDefined(rawIntent.bookFresh, rawIntent.book_fresh) !== undefined ? Boolean(firstDefined(rawIntent.bookFresh, rawIntent.book_fresh)) : null,
    bookAgeMs: firstNumber(rawIntent.bookAgeMs, rawIntent.book_age_ms),
    bestBid: firstNumber(rawIntent.bestBid, rawIntent.best_bid, rawIntent.book?.bestBid, rawIntent.book?.best_bid),
    bestAsk: firstNumber(rawIntent.bestAsk, rawIntent.best_ask, rawIntent.book?.bestAsk, rawIntent.book?.best_ask),
    expectedEdge: firstNumber(rawIntent.expectedEdge, rawIntent.expected_edge, metadata.expectedEdge, riskMeta.expectedEdge),
    lowQualityBlocked: toOptionalBool(firstDefined(rawIntent.lowQualityBlocked, rawIntent.low_quality_blocked, metadata.lowQualityBlocked)),
    reentryBlocked: toOptionalBool(firstDefined(rawIntent.reentryBlocked, rawIntent.reentry_blocked, metadata.reentryBlocked)),
    repeatCooldownBlocked: toOptionalBool(firstDefined(rawIntent.repeatCooldownBlocked, rawIntent.repeat_cooldown_blocked, metadata.repeatCooldownBlocked)),
    signalAgeMs: firstNumber(rawIntent.signalAgeMs, rawIntent.signal_age_ms, metadata.signalAgeMs),
    decisionLatencyMs: firstNumber(rawIntent.decisionLatencyMs, rawIntent.decision_latency_ms, metadata.decisionLatencyMs),
    currentLiveExposureUsd: firstNumber(rawIntent.currentLiveExposureUsd, rawIntent.current_live_exposure_usd),
    currentLiveExposureSource: firstString(rawIntent.currentLiveExposureSource, rawIntent.current_live_exposure_source, metadata.currentLiveExposure?.source) || 'unavailable_not_authenticated',
    currentLiveExposureAuthenticatedReconciliation: toOptionalBool(firstDefined(
      rawIntent.currentLiveExposureAuthenticatedReconciliation,
      rawIntent.current_live_exposure_authenticated_reconciliation,
      metadata.currentLiveExposure?.authenticatedReconciliation
    )) === true,
    currentLiveExposureObservedAt: firstString(rawIntent.currentLiveExposureObservedAt, rawIntent.current_live_exposure_observed_at, metadata.currentLiveExposure?.observedAt) || null,
    currentDailyLivePnlUsd: firstNumber(rawIntent.currentDailyLivePnlUsd, rawIntent.current_daily_live_pnl_usd),
    currentDailyLivePnlReconciled: toOptionalBool(firstDefined(rawIntent.currentDailyLivePnlReconciled, rawIntent.current_daily_live_pnl_reconciled, metadata.liveAccountTruth?.dailyLivePnlReconciled)) === true,
    currentDailyLivePnlObservedAt: firstString(rawIntent.currentDailyLivePnlObservedAt, rawIntent.current_daily_live_pnl_observed_at, metadata.liveAccountTruth?.observedAt) || null,
    currentLiveOrdersLastHour: firstNumber(rawIntent.liveOrdersLastHour, rawIntent.live_orders_last_hour, rawIntent.currentLiveOrdersLastHour, rawIntent.current_live_orders_last_hour),
    liveOrdersLastHourReconciled: toOptionalBool(firstDefined(rawIntent.liveOrdersLastHourReconciled, rawIntent.live_orders_last_hour_reconciled, metadata.liveAccountTruth?.liveOrdersLastHourReconciled)) === true,
    liveOrdersLastHourObservedAt: firstString(rawIntent.liveOrdersLastHourObservedAt, rawIntent.live_orders_last_hour_observed_at, metadata.liveAccountTruth?.observedAt) || null,
    accountIdentityMatches: toOptionalBool(firstDefined(rawIntent.accountIdentityMatches, rawIntent.account_identity_matches, metadata.liveAccountTruth?.accountIdentityMatches)) === true,
    liveAccountSnapshotFresh: toOptionalBool(firstDefined(rawIntent.liveAccountSnapshotFresh, rawIntent.live_account_snapshot_fresh, metadata.liveAccountTruth?.fresh)) === true,
    liveAccountSnapshotObservedAt: firstString(rawIntent.liveAccountSnapshotObservedAt, rawIntent.live_account_snapshot_observed_at, metadata.liveAccountTruth?.observedAt) || null,
    candidateHash: firstString(rawIntent.candidateHash, rawIntent.candidate_hash) || null,
    singleCanarySessionEligible: toOptionalBool(firstDefined(rawIntent.singleCanarySessionEligible, rawIntent.single_canary_session_eligible, metadata.liveAccountTruth?.singleCanarySessionEligible)) === true,
    singleCanaryBaseline: rawIntent.singleCanaryBaseline || rawIntent.single_canary_baseline || null,
    paperBurnIn: rawIntent.paperBurnIn || rawIntent.paper_burn_in || rawIntent.burnIn || rawIntent.burn_in || null,
    tickSize: rawIntent.tickSize || rawIntent.tick_size || null,
    negRisk: firstDefined(rawIntent.negRisk, rawIntent.neg_risk) !== undefined ? Boolean(firstDefined(rawIntent.negRisk, rawIntent.neg_risk)) : null,
    minOrderSize: firstDefined(rawIntent.minOrderSize, rawIntent.min_order_size) !== undefined ? Number(firstDefined(rawIntent.minOrderSize, rawIntent.min_order_size)) : null,
    raw: rawIntent,
  };

  if (!Number.isFinite(intent.signalAgeMs) && Number.isFinite(timestampMs)) {
    intent.signalAgeMs = Math.max(0, Date.now() - timestampMs);
  }

  if (!intent.sizeShares && intent.sizeUsd > 0 && Number.isFinite(intent.price) && intent.price > 0) {
    intent.sizeShares = intent.sizeUsd / intent.price;
  }

  return intent;
}

function buildPolymarketUserOrder(intent, side, builderCode = null) {
  const price = Number(intent?.price);
  const sizeUsd = Number(intent?.sizeUsd);
  const sizeShares = Number(intent?.sizeShares);
  const minimumShares = Number(intent?.minOrderSize);
  if (!intent?.tokenId) throw new Error('TOKEN_ID_MISSING');
  if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new Error('INVALID_PRICE');
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) throw new Error('INVALID_SIZE_USD');
  if (!Number.isFinite(sizeShares) || sizeShares <= 0) throw new Error('INVALID_SIZE_SHARES');
  const constructedNotionalUsd = price * sizeShares;
  const consistencyToleranceUsd = Math.max(1e-9, Math.abs(sizeUsd) * 1e-9);
  if (Math.abs(constructedNotionalUsd - sizeUsd) > consistencyToleranceUsd) {
    throw new Error('SIZE_USD_SHARES_MISMATCH');
  }
  if (Number.isFinite(minimumShares) && minimumShares > 0 && sizeShares + 1e-9 < minimumShares) {
    throw new Error('SIZE_BELOW_MIN_ORDER');
  }
  const userOrder = {
    tokenID: intent.tokenId,
    price,
    // Preserve the writer's upward-safe share quantity exactly. The adapter
    // never rounds shares down or re-derives them from a cent-rounded USD size.
    size: sizeShares,
    side,
  };
  if (builderCode) userOrder.builderCode = builderCode;
  return userOrder;
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

function evaluateLiveAccountTruth(config, intent, nowMs = Date.now()) {
  const reasons = [];
  const observedMs = parseTimestampMs(intent.liveAccountSnapshotObservedAt);
  const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : Infinity;
  const fieldFresh = (value) => {
    const parsed = parseTimestampMs(value);
    return Number.isFinite(parsed) && Math.max(0, nowMs - parsed) <= config.liveAccountTruthTtlMs &&
      Number.isFinite(observedMs) && Math.abs(parsed - observedMs) <= 1000;
  };
  if (intent.accountIdentityMatches !== true) reasons.push('LIVE_ACCOUNT_IDENTITY_UNCERTAIN');
  if (intent.liveAccountSnapshotFresh !== true || !Number.isFinite(ageMs) || ageMs > config.liveAccountTruthTtlMs) {
    reasons.push('LIVE_ACCOUNT_SNAPSHOT_STALE');
  }
  const authoritativeExposureSource = /official_data_api.*official_clob_authenticated/i.test(String(intent.currentLiveExposureSource || ''));
  if (!Number.isFinite(intent.currentLiveExposureUsd) || intent.currentLiveExposureAuthenticatedReconciliation !== true ||
      !authoritativeExposureSource || !fieldFresh(intent.currentLiveExposureObservedAt)) {
    reasons.push('LIVE_EXPOSURE_UNCERTAIN');
  }
  if (!Number.isFinite(intent.currentDailyLivePnlUsd) || intent.currentDailyLivePnlReconciled !== true || !fieldFresh(intent.currentDailyLivePnlObservedAt)) {
    reasons.push('LIVE_DAILY_PNL_UNCERTAIN');
  }
  const embeddedWatcher = intent.singleCanaryBaseline?.watcher || {};
  const canaryPolicy = Number(intent.liveStage) === 5 && intent.singleCanarySessionEligible === true
    ? evaluateSingleCanaryBaseline({ snapshot: intent.singleCanaryBaseline, watcherHealth: embeddedWatcher, candidate: intent, nowMs, requireWatcher: true })
    : null;
  const singleCanaryRateProof = canaryPolicy?.eligible === true;
  if (!singleCanaryRateProof && (!Number.isFinite(intent.currentLiveOrdersLastHour) || intent.liveOrdersLastHourReconciled !== true || !fieldFresh(intent.liveOrdersLastHourObservedAt))) {
    reasons.push('LIVE_ORDER_RATE_UNCERTAIN');
  }
  if (Number(intent.liveStage) === 5 && intent.singleCanarySessionEligible === true && !singleCanaryRateProof) reasons.push(...(canaryPolicy?.blockers || ['SINGLE_CANARY_BASELINE_UNAVAILABLE']));
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], observedAt: intent.liveAccountSnapshotObservedAt, ageMs, canaryPolicy, scope: singleCanaryRateProof ? SINGLE_CANARY_SCOPE : 'global' };
}

function evaluateStaticSafety(config, intent, options = {}) {
  const reasons = [];
  const submitMode = options.mode === 'submit';
  const stageProfile = config.liveStageProfile || resolveLiveStageProfile(config);
  const effectiveMaxLiveOrderUsd = stageProfile.maxLiveOrderUsd || config.maxLiveOrderUsd;
  const effectiveMaxLiveTotalExposureUsd = stageProfile.maxLiveTotalExposureUsd || config.maxLiveTotalExposureUsd;
  const effectiveDailyMaxLossUsd = stageProfile.liveDailyMaxLossUsd || Math.abs(config.liveDailyMaxLossUsd);

  if (submitMode) {
    if (!config.enableLiveTrading) reasons.push('LIVE_DISABLED');
    if (!config.liveAutoExecute) reasons.push('AUTO_EXECUTE_DISABLED');
    if (config.liveKillSwitch) reasons.push('KILL_SWITCH_ACTIVE');
    if (config.liveDryRunOnly) reasons.push('DRY_RUN_ONLY');
    if (!config.liveSubmitConfirm) reasons.push('LIVE_SUBMIT_CONFIRM_REQUIRED');
    if (!config.liveFinalBossReady) reasons.push('LIVE_FINAL_BOSS_NOT_READY');
    if (!stageProfile.submitAllowed) reasons.push(`LIVE_STAGE_${stageProfile.stage}_SUBMIT_BLOCKED`);
    if (stageProfile.singleMarketOnly && !stageProfile.singleMarketId) reasons.push('LIVE_CANARY_MARKET_ID_REQUIRED');
    if (stageProfile.singleMarketOnly && stageProfile.singleMarketId && intent.marketId && intent.marketId !== stageProfile.singleMarketId) {
      reasons.push('LIVE_CANARY_MARKET_MISMATCH');
    }
  }

  if (!intent.tokenId) reasons.push('TOKEN_ID_MISSING');
  if (!['BUY', 'SELL'].includes(intent.side)) reasons.push('INVALID_SIDE');
  if (!Number.isFinite(intent.price) || intent.price <= 0 || intent.price >= 1) reasons.push('INVALID_PRICE');
  if (!Number.isFinite(intent.sizeUsd) || intent.sizeUsd <= 0) reasons.push('INVALID_SIZE_USD');
  if (intent.sizeUsd > effectiveMaxLiveOrderUsd) reasons.push('MAX_LIVE_ORDER_USD_EXCEEDED');
  const liveAccountTruth = evaluateLiveAccountTruth(config, intent, options.nowMs || Date.now());
  reasons.push(...liveAccountTruth.reasons);
  if (Number.isFinite(intent.currentLiveExposureUsd) && intent.currentLiveExposureAuthenticatedReconciliation === true &&
      intent.currentLiveExposureUsd + intent.sizeUsd > effectiveMaxLiveTotalExposureUsd) {
    reasons.push('MAX_LIVE_TOTAL_EXPOSURE_EXCEEDED');
  }
  if (Number.isFinite(intent.currentDailyLivePnlUsd) && intent.currentDailyLivePnlReconciled === true &&
      intent.currentDailyLivePnlUsd <= -Math.abs(effectiveDailyMaxLossUsd)) reasons.push('DAILY_MAX_LOSS_EXCEEDED');
  if (stageProfile.maxOrdersPerHour > 0 && Number.isFinite(intent.currentLiveOrdersLastHour) && intent.liveOrdersLastHourReconciled === true &&
      intent.currentLiveOrdersLastHour >= stageProfile.maxOrdersPerHour) reasons.push('MAX_LIVE_ORDERS_PER_HOUR_EXCEEDED');

  if (config.liveRequireSophieApproval && intent.sophieApproved !== true) reasons.push('SOPHIE_NOT_APPROVED');
  if (Number.isFinite(intent.consensusScore) && intent.consensusScore < config.liveSophieMinScore) reasons.push('SOPHIE_SCORE_TOO_LOW');
  if (config.liveRequireRiskApproval && intent.riskApproved !== true) reasons.push('RISK_NOT_APPROVED');
  if (intent.liveStage === 5) {
    if (intent.adjustedSizeRiskApproved !== true) reasons.push('ADJUSTED_SIZE_RISK_NOT_APPROVED');
    if (!Number.isFinite(intent.riskApprovedSizeUsd) || Math.abs(intent.riskApprovedSizeUsd - intent.sizeUsd) > 1e-9) {
      reasons.push('RISK_APPROVED_SIZE_MISMATCH');
    }
  }
  if (config.liveRequireOracleConfirmation && intent.oracleSignal && intent.oracleConfirmed !== true) reasons.push('ORACLE_NOT_CONFIRMED');
  if (config.liveRequirePersistenceConfirmation && intent.oracleSignal && intent.persistenceConfirmed !== true) reasons.push('PERSISTENCE_NOT_CONFIRMED');
  if (Number.isFinite(config.liveMinExpectedEdge) && config.liveMinExpectedEdge > 0) {
    if (!Number.isFinite(intent.expectedEdge)) reasons.push('EXPECTED_EDGE_MISSING');
    else if (intent.expectedEdge < config.liveMinExpectedEdge) reasons.push('EXPECTED_EDGE_TOO_LOW');
  }
  if (intent.lowQualityBlocked === true) reasons.push('LOW_QUALITY_BLOCKED');
  if (intent.reentryBlocked === true) reasons.push('REENTRY_GUARD_ACTIVE');
  if (intent.repeatCooldownBlocked === true) reasons.push('REPEAT_COOLDOWN_ACTIVE');
  if (Number.isFinite(intent.signalAgeMs) && intent.signalAgeMs > config.liveMaxSignalAgeMs) reasons.push('SIGNAL_TOO_OLD');
  if (Number.isFinite(intent.decisionLatencyMs) && intent.decisionLatencyMs > config.liveMaxDecisionLatencyMs) reasons.push('DECISION_LATENCY_TOO_HIGH');
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
    liveAccountTruth,
    stageProfile,
    effectiveCaps: {
      maxLiveOrderUsd: effectiveMaxLiveOrderUsd,
      maxLiveTotalExposureUsd: effectiveMaxLiveTotalExposureUsd,
      liveDailyMaxLossUsd: effectiveDailyMaxLossUsd,
      maxOrdersPerHour: stageProfile.maxOrdersPerHour,
    },
  };
}

function evaluateLossExposureGuards(config, intent) {
  const stageProfile = config.liveStageProfile || resolveLiveStageProfile(config);
  const effectiveMaxLiveOrderUsd = stageProfile.maxLiveOrderUsd || config.maxLiveOrderUsd;
  const effectiveMaxLiveTotalExposureUsd = stageProfile.maxLiveTotalExposureUsd || config.maxLiveTotalExposureUsd;
  const effectiveDailyMaxLossUsd = stageProfile.liveDailyMaxLossUsd || Math.abs(config.liveDailyMaxLossUsd);
  const reasons = [];
  reasons.push(...evaluateLiveAccountTruth(config, intent).reasons);
  if (Number.isFinite(intent.currentDailyLivePnlUsd) && intent.currentDailyLivePnlReconciled === true &&
      intent.currentDailyLivePnlUsd <= -Math.abs(effectiveDailyMaxLossUsd)) reasons.push('DAILY_MAX_LOSS_EXCEEDED');
  if (Number.isFinite(intent.currentLiveExposureUsd) && intent.currentLiveExposureAuthenticatedReconciliation === true &&
      intent.currentLiveExposureUsd + intent.sizeUsd > effectiveMaxLiveTotalExposureUsd) {
    reasons.push('MAX_LIVE_TOTAL_EXPOSURE_EXCEEDED');
  }
  if (intent.sizeUsd > effectiveMaxLiveOrderUsd) reasons.push('MAX_LIVE_ORDER_USD_EXCEEDED');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
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
  if (!Number.isFinite(meta.bookAgeMs) || meta.bookAgeMs > config.liveMaxBookAgeMs) {
    reasons.push('BOOK_NOT_FRESH');
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
    this.signerAddress = null;
    this.privateKeyAccessed = false;
    this.clientPurpose = null;
    this.funderResolution = resolvePolymarketFunderAddress();
    this.builderCodeResolution = resolvePolymarketBuilderCode();
  }

  canSubmitLive() {
    const stageProfile = this.config.liveStageProfile || resolveLiveStageProfile(this.config);
    return this.config.enableLiveTrading
      && this.config.liveAutoExecute
      && !this.config.liveKillSwitch
      && !this.config.liveDryRunOnly
      && this.config.liveFinalBossReady
      && stageProfile.submitAllowed
      && this.config.liveSubmitConfirm;
  }

  shouldLoadSecrets() {
    return this.canSubmitLive();
  }

  secretAccessDecision(purpose) {
    const reasons = [];
    const secretStatus = secretFileStatus(this.config);
    if (!secretStatus.exists) reasons.push('LIVE_SECRETS_FILE_MISSING');
    if (secretStatus.exists && !secretStatus.readable) reasons.push('LIVE_SECRETS_FILE_UNREADABLE');

    if (purpose === 'submit') {
      if (!this.config.enableLiveTrading) reasons.push('ENABLE_LIVE_TRADING_FALSE');
      if (!this.config.liveAutoExecute) reasons.push('LIVE_AUTO_EXECUTE_FALSE');
      if (this.config.liveKillSwitch) reasons.push('LIVE_KILL_SWITCH_TRUE');
      if (this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_TRUE');
      if (!this.config.liveFinalBossReady) reasons.push('LIVE_FINAL_BOSS_READY_FALSE');
      if (!(this.config.liveStageProfile || resolveLiveStageProfile(this.config)).submitAllowed) reasons.push('LIVE_STAGE_SUBMIT_DISABLED');
      if (!this.config.liveSubmitConfirm) reasons.push('LIVE_SUBMIT_CONFIRM_REQUIRED');
    } else if (purpose === 'cancel') {
      if (!this.config.enableLiveTrading) reasons.push('ENABLE_LIVE_TRADING_FALSE');
      if (!this.config.liveAutoExecute) reasons.push('LIVE_AUTO_EXECUTE_FALSE');
      if (this.config.liveKillSwitch) reasons.push('LIVE_KILL_SWITCH_TRUE');
      if (this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_TRUE');
      if (!this.config.liveCancelTestAllow) reasons.push('LIVE_CANCEL_TEST_ALLOW_FALSE');
    } else if (purpose === 'auth-check') {
      // Stage 1 dry-run proof: allow auth-check without ENABLE_LIVE_TRADING
      // so the operator can prove signer/auth wiring while live flags stay OFF.
      // Still requires explicit LIVE_AUTH_CHECK_ALLOW=true and dry-run mode.
      // Kill switch is intentionally NOT checked here because auth-check never
      // submits orders — it only initializes the SDK client and verifies API
      // credentials. The kill switch continues to block submit/cancel/reconcile.
      if (!this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_MUST_BE_TRUE_FOR_AUTH_CHECK');
      if (!this.config.liveAuthCheckAllow) reasons.push('LIVE_AUTH_CHECK_ALLOW_FALSE');
    } else if (purpose === 'signing-test') {
      // Stage 1 dry-run proof: allow signing-test without ENABLE_LIVE_TRADING
      // so the operator can prove signature construction while live flags stay
      // OFF. Still requires LIVE_SIGNING_TEST_ALLOW=true and dry-run mode.
      // Kill switch is intentionally NOT checked here because signing-test only
      // constructs a signed order locally and never posts it to the CLOB. The
      // kill switch continues to block submit/cancel/reconcile.
      if (!this.config.liveDryRunOnly) reasons.push('LIVE_DRY_RUN_ONLY_MUST_BE_TRUE_FOR_SIGNING_TEST');
      if (!this.config.liveSigningTestAllow) reasons.push('LIVE_SIGNING_TEST_ALLOW_FALSE');
    } else if (purpose === 'reconcile') {
      if (!this.config.enableLiveTrading) reasons.push('ENABLE_LIVE_TRADING_FALSE');
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

    const funderResolution = resolvePolymarketFunderAddress(process.env);
    if (funderResolution.errors.length > 0) {
      throw new Error(`Polymarket funder resolution failed: ${funderResolution.errors.join(',')}`);
    }
    const builderCodeResolution = resolvePolymarketBuilderCode(process.env);
    const funderAddress = funderResolution.funderAddress;
    const signatureType = funderResolution.signatureType;

    const sdk = await import('@polymarket/clob-client-v2');
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(privateKey);
    const signer = createWalletClient({ account, transport: http(this.config.polygonRpcUrl) });
    this.signerAddress = account.address;
    this.walletAddress = funderAddress || account.address;
    this.funderResolution = funderResolution;
    this.builderCodeResolution = builderCodeResolution;

    const l1Client = new sdk.ClobClient({
      host: this.config.clobHost,
      chain: this.config.chainId,
      signer,
      signatureType,
      funderAddress,
      builderConfig: builderCodeResolution.builderCode ? { builderCode: builderCodeResolution.builderCode } : undefined,
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
      builderConfig: builderCodeResolution.builderCode ? { builderCode: builderCodeResolution.builderCode } : undefined,
      throwOnError: true,
    });
    this.sdk = sdk;
    this.clientPurpose = purpose;
    return this.client;
  }

  assertBuilderCodeReady() {
    const resolution = this.builderCodeResolution || resolvePolymarketBuilderCode(process.env);
    this.builderCodeResolution = resolution;
    if (resolution.present && !resolution.valid) {
      throw new Error(`Builder attribution unavailable: ${resolution.errors.join(',')}`);
    }
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
    };

    try {
      await this.init('auth-check');
      event.privateKeyAccessed = this.privateKeyAccessed;
      event.clientInitialized = Boolean(this.client);
      event.apiCredentialsReady = Boolean(process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET && process.env.POLYMARKET_API_PASSPHRASE) || Boolean(this.client);
      event.walletAddress = redactWallet(this.walletAddress);
      event.signerAddress = redactWallet(this.signerAddress);
      event.funderAddress = redactWallet(this.funderResolution?.funderAddress);
      event.funderEnvUsed = this.funderResolution?.source || null;
      event.funderWarnings = this.funderResolution?.warnings || [];
      event.signatureType = this.funderResolution?.signatureType || resolvePolymarketSignatureType();
      event.builderCodePresent = Boolean(this.builderCodeResolution?.present);
      event.builderCodeLooksValid = Boolean(this.builderCodeResolution?.valid);
    } catch (e) {
      event.errors.push(safeError(e));
      event.missingEnv = missingEnv(REQUIRED_LIVE_SECRET_ENV);
    }

    return event;
  }

  async signOrderOnly(intent, meta, purpose = 'signing-test') {
    const client = await this.init(purpose);
    this.assertBuilderCodeReady();
    const sdk = this.sdk;
    const side = intent.side === 'BUY' ? sdk.Side.BUY : sdk.Side.SELL;
    const userOrder = buildPolymarketUserOrder(intent, side, this.builderCodeResolution?.builderCode);
    const startedAt = Date.now();
    const signedOrder = await client.createOrder(userOrder, {
      tickSize: String(meta.tickSize),
      negRisk: Boolean(meta.negRisk),
    });
    return {
      signedOrder,
      orderConstructionLatencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  /**
   * Local-only signing proof: uses the SDK's orderBuilder.buildOrder directly
   * with pre-supplied tickSize and negRisk, bypassing the network-dependent
   * _resolveTickSize and resolveVersion calls. Used by signing-test and
   * auth-dry-run for deterministic Stage 1 proofs without market lookup.
   * Never submits.
   */
  async signOrderLocalOnly(intent, meta, purpose = 'signing-test') {
    const client = await this.init(purpose);
    this.assertBuilderCodeReady();
    const sdk = this.sdk;
    const side = intent.side === 'BUY' ? sdk.Side.BUY : sdk.Side.SELL;
    const userOrder = buildPolymarketUserOrder(intent, side, this.builderCodeResolution?.builderCode);
    const tickSize = String(meta.tickSize || '0.01');
    const negRisk = Boolean(meta.negRisk);
    // Force exchange version 2 for the modern Polymarket exchange. Local-only
    // path explicitly skips client.resolveVersion() which would require network.
    const version = 2;
    if (!client.orderBuilder || typeof client.orderBuilder.buildOrder !== 'function') {
      throw new Error('SDK orderBuilder.buildOrder unavailable; cannot run local signing proof');
    }
    const startedAt = Date.now();
    const signedOrder = await client.orderBuilder.buildOrder(
      userOrder,
      { tickSize, negRisk },
      version
    );
    return {
      signedOrder,
      orderConstructionLatencyMs: Math.max(0, Date.now() - startedAt),
      localOnly: true,
    };
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
      clobHost: this.config.clobHost,
      polygonRpcConfigured: Boolean(this.config.polygonRpcUrl),
      clobReachable: null,
      clobReachableLatencyMs: null,
      clobReachableError: null,
      rpcReachable: null,
      rpcReachableLatencyMs: null,
      rpcReachableError: null,
      rpcChainId: null,
      orderConstructionLatencyMs: null,
      signingProofPassed: false,
      signingProofError: null,
    };

    const clobProbe = await probeHostReachable(this.config.clobHost, { healthPath: '/' });
    event.clobReachable = clobProbe.reachable;
    event.clobReachableLatencyMs = clobProbe.latencyMs;
    event.clobReachableError = clobProbe.error;

    const rpcProbe = await probeRpcReachable(this.config.polygonRpcUrl);
    event.rpcReachable = rpcProbe.reachable;
    event.rpcReachableLatencyMs = rpcProbe.latencyMs;
    event.rpcReachableError = rpcProbe.error;
    event.rpcChainId = rpcProbe.chainId;

    try {
      const signed = await this.signOrderLocalOnly(intent, meta, 'signing-test');
      event.signed = true;
      event.privateKeyAccessed = this.privateKeyAccessed;
      event.walletAddress = redactWallet(this.walletAddress);
      event.signerAddress = redactWallet(this.signerAddress);
      event.funderAddress = redactWallet(this.funderResolution?.funderAddress);
      event.funderEnvUsed = this.funderResolution?.source || null;
      event.builderCodePresent = Boolean(this.builderCodeResolution?.present);
      event.builderCodeLooksValid = Boolean(this.builderCodeResolution?.valid);
      event.orderConstructionLatencyMs = signed.orderConstructionLatencyMs;
      event.localOnly = true;
      event.signingProofPassed = true;
    } catch (e) {
      const classified = classifySigningError(e);
      event.errors.push(safeError(e));
      event.signingProofPassed = false;
      event.signingProofError = classified.kind === 'NETWORK_REQUIRED_FOR_SIGNING_PROOF'
        ? 'NETWORK_REQUIRED_FOR_SIGNING_PROOF'
        : classified.kind;
    }

    return event;
  }

  async getOpenOrders(params = {}, purpose = 'submit') {
    const client = await this.init(purpose);
    return client.getOpenOrders(params.openOrderParams || undefined);
  }

  async reconcile(params = {}) {
    void params;
    throw new Error('LEGACY_RECONCILE_DISABLED_USE_LIVE_ACCOUNT_TRUTH_READONLY');
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

    const signed = await this.signOrderOnly(intent, meta, 'submit');
    const submitStartedAt = Date.now();
    const response = await client.postOrder(signed.signedOrder, orderType, postOnly);
    return {
      signedOrder: signed.signedOrder,
      response,
      orderConstructionLatencyMs: signed.orderConstructionLatencyMs,
      submitLatencyMs: Math.max(0, Date.now() - submitStartedAt),
    };
  }

  async postSignedOrder(signedOrder, intent) {
    const client = await this.init('submit');
    const sdk = this.sdk;
    const orderType = sdk.OrderType[intent.orderType] || sdk.OrderType.GTC;
    const postOnly = intent.postOnly !== undefined ? Boolean(intent.postOnly) : this.config.livePostOnlyDefault;
    const submitStartedAt = Date.now();
    const response = await client.postOrder(signedOrder, orderType, postOnly);
    return { response, submitLatencyMs: Math.max(0, Date.now() - submitStartedAt) };
  }

  async exactCanaryEvidence(session) {
    const client = await this.init('submit');
    const source = createReadOnlyAccountTruthSource({
      clobClient: client,
      fetchImpl: globalThis.fetch,
      dataApiBaseUrl: process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com',
      accountWallet: session.baselineIdentity?.resolvedAccountWallet,
    });
    const identity = {
      signerAddress: session.baselineIdentity?.signerAddress,
      expectedSignerAddress: session.baselineIdentity?.signerAddress,
      configuredAccountWallet: session.baselineIdentity?.configuredAccountWallet,
      resolvedAccountWallet: session.baselineIdentity?.resolvedAccountWallet,
      configuredSignatureType: session.baselineIdentity?.configuredSignatureType,
      resolvedSignatureType: session.baselineIdentity?.resolvedSignatureType,
      resolvedWalletType: session.baselineIdentity?.resolvedWalletType,
      authenticated: true,
    };
    // Read each mutable source once for this reconciliation generation.  The
    // readonly source caches open orders and trades, so the account snapshot
    // and exact-order evidence cannot silently combine different responses.
    const order = await client.getOrder(session.returnedOrderId);
    const openEnvelope = await source.fetchOpenOrders();
    const tradeEnvelope = await source.fetchTrades();
    const afterSnapshot = await buildLiveAccountTruthSnapshot({ source, identity, nowMs: Date.now(), maxAgeMs: this.config.liveAccountTruthTtlMs });
    return {
      order,
      openOrders: openEnvelope.records,
      trades: tradeEnvelope.records,
      afterSnapshot,
      sourceStatus: {
        directOrder: { authenticated: true, fetched: Boolean(order), complete: Boolean(order) },
        openOrders: {
          authenticated: openEnvelope.authenticated === true,
          fetched: openEnvelope.fetched === true,
          complete: openEnvelope.complete === true,
        },
        trades: {
          authenticated: tradeEnvelope.authenticated === true,
          fetched: tradeEnvelope.fetched === true,
          complete: tradeEnvelope.complete === true,
          coverageComplete: tradeEnvelope.coverageComplete === true,
          paginationComplete: tradeEnvelope.paginationComplete === true,
          terminalCursorReached: tradeEnvelope.terminalCursorReached === true,
        },
      },
    };
  }

  async replaceOrder({ orderId, replacementIntent, meta }) {
    const cancelResponse = await this.cancelOrder(orderId, 'submit');
    const submitResponse = await this.signAndSubmit(replacementIntent, meta);
    return { cancelResponse, submitResponse };
  }
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
    this.config = options.config || readConfig(this.baseDir);
    this.config.liveStageProfile = this.config.liveStageProfile || resolveLiveStageProfile(this.config);
    this.live = new PolymarketLiveClient(this.config);
    this.canarySessionStore = options.canarySessionStore || new CanarySessionStore({
      sessionPath: path.resolve(this.baseDir, this.config.stage5CanarySessionPath),
      now: options.now || Date.now,
    });
    this.canaryExactEvidenceProvider = options.canaryExactEvidenceProvider || ((session) => this.live.exactCanaryEvidence(session));
    this.canaryLockoffRestorer = options.canaryLockoffRestorer || null;
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
    const staticSafety = evaluateStaticSafety(this.config, intent, options);
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
        liveFinalBossReady: this.config.liveFinalBossReady,
        liveTradingStage: this.config.liveTradingStage,
        liveStageProfile: this.config.liveStageProfile,
      },
    };
  }

  async restoreCanaryLockoff(event) {
    if (typeof this.canaryLockoffRestorer !== 'function') return event;
    const existingSession = this.canarySessionStore.read();
    if (existingSession?.state === CANARY_STATES.LOCKOFF_RESTORED && existingSession?.lockoffRestorationState === 'RESTORED') {
      return { ...event, lockoffRestoration: 'ALREADY_RESTORED' };
    }
    try {
      const result = await this.canaryLockoffRestorer(event);
      if (result?.restored !== true) throw new Error('LOCKOFF_RESTORATION_FAILED');
      if (this.canarySessionStore.read()) this.canarySessionStore.recordLockoff({ restored: true });
      return { ...event, lockoffRestoration: 'RESTORED' };
    } catch (error) {
      if (this.canarySessionStore.read()) this.canarySessionStore.recordLockoff({ restored: false, code: 'LOCKOFF_RESTORATION_FAILED' });
      return { ...event, decision: 'RECONCILIATION_FAILED', reasons: [...new Set([...(event.reasons || []), 'LOCKOFF_RESTORATION_FAILED'])], lockoffRestoration: 'FAILED' };
    }
  }

  async handleSingleCanarySubmission(intent, evaluation) {
    const baseline = intent.singleCanaryBaseline;
    const watcher = baseline?.watcher || {};
    const watcherHealth = {
      running: watcher.running === true,
      watcherPid: watcher.watcherPid,
      consecutiveSuccessfulSnapshots: watcher.consecutiveSuccessfulSnapshots,
      consecutiveFailures: watcher.consecutiveFailures,
      lastSuccessfulRefresh: watcher.lastSuccessfulRefresh,
      healthGeneration: watcher.healthGeneration,
      readinessScope: watcher.readinessScope,
    };
    let currentOpenOrders;
    try {
      currentOpenOrders = await this.live.getOpenOrders({}, 'submit');
    } catch (error) {
      return this.restoreCanaryLockoff({ timestamp: nowIso(), type: 'LIVE_SUBMISSION_REFUSED', decision: 'REFUSED', reasons: ['OPEN_ORDERS_UNAVAILABLE'], adapterResponseClassification: 'refused_before_submission', safety: { submitted: false, signed: false } });
    }
    if (!Array.isArray(currentOpenOrders) || currentOpenOrders.length !== 0) {
      return this.restoreCanaryLockoff({ timestamp: nowIso(), type: 'LIVE_SUBMISSION_REFUSED', decision: 'REFUSED', reasons: ['CANARY_BASELINE_OPEN_ORDERS_NOT_ZERO'], adapterResponseClassification: 'refused_before_submission', safety: { submitted: false, signed: false } });
    }

    let session;
    try {
      session = this.canarySessionStore.createArmEligible({ candidate: intent, baselineSnapshot: baseline, watcherHealth });
    } catch (error) {
      return this.restoreCanaryLockoff({ timestamp: nowIso(), type: 'LIVE_SUBMISSION_REFUSED', decision: 'REFUSED', reasons: error.blockers || [String(error.message || 'CANARY_SESSION_REFUSED').split(':')[0]], adapterResponseClassification: 'refused_before_submission', safety: { submitted: false, signed: false } });
    }

    let signed;
    try {
      signed = await this.live.signOrderOnly(intent, evaluation.metadata, 'submit');
    } catch (error) {
      this.canarySessionStore.withLock(() => this.canarySessionStore.transitionLocked(this.canarySessionStore.read(), CANARY_STATES.RECONCILIATION_FAILED, { blockers: ['CANARY_ORDER_CONSTRUCTION_FAILED'] }));
      return this.restoreCanaryLockoff({ timestamp: nowIso(), type: 'LIVE_SUBMISSION_REFUSED', decision: 'REFUSED', reasons: ['CANARY_ORDER_CONSTRUCTION_FAILED'], adapterResponseClassification: 'refused_before_submission', safety: { submitted: false, signed: false } });
    }

    let submission;
    try {
      submission = await submitCanaryExactlyOnce({
        store: this.canarySessionStore,
        candidate: intent,
        signedOrder: signed.signedOrder,
        postOrder: async () => (await this.live.postSignedOrder(signed.signedOrder, intent)).response,
      });
    } catch (error) {
      try {
        this.canarySessionStore.withLock(() => this.canarySessionStore.transitionLocked(this.canarySessionStore.read(), CANARY_STATES.RECONCILIATION_FAILED, {
          blockers: [String(error.message || 'CANARY_SUBMISSION_GUARD_FAILED').split(':')[0]],
        }));
      } catch (_) {
        // Preserve the original durable state and fail closed if a concurrent
        // process owns the session lock.
      }
      let attemptPersisted = false;
      try { attemptPersisted = this.canarySessionStore.read()?.submissionAttempted === true; } catch (_) { attemptPersisted = false; }
      return this.restoreCanaryLockoff({
        timestamp: nowIso(), type: 'LIVE_SUBMISSION_REFUSED', decision: 'REFUSED',
        reasons: [String(error.message || 'CANARY_SUBMISSION_GUARD_FAILED').split(':')[0]],
        adapterResponseClassification: 'refused_before_submission',
        safety: { submitted: false, signed: true, submissionAttempted: attemptPersisted, automaticRetryCount: 0 },
      });
    }
    if (submission.classification === 'submission_outcome_unknown') {
      return this.restoreCanaryLockoff({
        timestamp: nowIso(), type: 'LIVE_SUBMISSION_OUTCOME_UNKNOWN', decision: 'SUBMISSION_OUTCOME_UNKNOWN',
        reasons: [submission.errorCode || 'SUBMISSION_OUTCOME_UNKNOWN'], adapterResponseClassification: submission.classification,
        sessionId: submission.session.sessionId, safety: { submitted: null, signed: true, submissionAttempted: true, automaticRetryCount: 0 },
      });
    }
    if (submission.classification === 'submission_attempted_definitive_rejection') {
      return this.restoreCanaryLockoff({
        timestamp: nowIso(), type: 'LIVE_SUBMISSION_REJECTED', decision: 'SUBMISSION_REJECTED', reasons: ['DEFINITIVE_REJECTION'],
        adapterResponseClassification: submission.classification, sessionId: submission.session.sessionId,
        response: { success: submission.response?.success, status: submission.response?.status || null },
        safety: { submitted: false, signed: true, submissionAttempted: true, automaticRetryCount: 0 },
      });
    }

    session = this.canarySessionStore.startReconciliation();
    let reconciliation;
    try {
      const evidence = await this.canaryExactEvidenceProvider(session);
      reconciliation = reconcileExactCanaryOrder({ session, ...evidence });
    } catch (error) {
      reconciliation = { ok: false, state: CANARY_STATES.RECONCILIATION_FAILED, blockers: ['CANARY_RECONCILIATION_SOURCE_UNAVAILABLE'], errorCode: error?.code || null };
    }
    const reconciledSession = this.canarySessionStore.recordReconciliation(reconciliation);
    const event = {
      timestamp: nowIso(),
      type: reconciliation.ok ? 'LIVE_ORDER_SUBMITTED' : 'LIVE_CANARY_RECONCILIATION_FAILED',
      decision: reconciliation.ok ? 'SUBMITTED' : 'RECONCILIATION_FAILED',
      reasons: reconciliation.blockers || [],
      adapterResponseClassification: submission.classification,
      returnedOrderId: submission.orderId,
      sessionId: reconciledSession.sessionId,
      reconciliationState: reconciledSession.finalState,
      response: { success: submission.response?.success, status: submission.response?.status || null, orderID: submission.orderId },
      safety: { submitted: true, signed: true, submissionAttempted: true, automaticRetryCount: 0, liveTradingStage: 5 },
    };
    this.logExecution(event);
    return this.restoreCanaryLockoff(event);
  }

  async handleIntent(rawIntent, options = {}) {
    const submitMode = options.mode === 'submit';
    const evaluation = await this.evaluate(rawIntent, { ...options, fetchMetadata: submitMode || options.fetchMetadata === true });

    if (evaluation.decision !== 'ALLOW_LIVE_SUBMISSION') {
      const normalizedRefusedIntent = normalizeIntent(rawIntent);
      const refusedResult = Number(normalizedRefusedIntent.liveStage) === 5 && normalizedRefusedIntent.singleCanarySessionEligible === true
        ? await this.restoreCanaryLockoff({ ...evaluation, adapterResponseClassification: 'refused_before_submission' })
        : evaluation;
      this.logEvent(refusedResult);
      console.warn(`[LIVE-ADAPTER REFUSED] source=${evaluation.intent.source} side=${evaluation.intent.side} token=${shortId(evaluation.intent.tokenId)} price=${evaluation.intent.price} size=$${evaluation.intent.sizeUsd} reasons=${evaluation.reasons.join(',')}`);
      return refusedResult;
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
    if (Number(intent.liveStage) === 5 && intent.singleCanarySessionEligible === true) {
      const canaryResult = await this.handleSingleCanarySubmission(intent, evaluation);
      this.logEvent(canaryResult);
      return canaryResult;
    }
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
        liveFinalBossReady: this.config.liveFinalBossReady,
        liveTradingStage: this.config.liveTradingStage,
        orderConstructionLatencyMs: result.orderConstructionLatencyMs,
        submitLatencyMs: result.submitLatencyMs,
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
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_RECONCILE_REFUSED',
      decision: 'REFUSED',
      reasons: ['LEGACY_RECONCILE_DISABLED_USE_LIVE_ACCOUNT_TRUTH_READONLY'],
      walletAddress: null,
      usdcBalance: null,
      gasBalance: null,
      openOrdersCount: null,
      openOrdersUsd: null,
      positionsCount: null,
      positionsUsd: null,
      lastReconciledAt: null,
      submitted: false,
      signed: false,
    };
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

  async authDryRun(rawIntent) {
    const cfg = this.config;
    const secrets = secretFileStatus(cfg);
    const stageProfile = cfg.liveStageProfile || resolveLiveStageProfile(cfg);

    const event = {
      timestamp: nowIso(),
      type: 'LIVE_AUTH_DRY_RUN',
      submitted: false,
      stage: cfg.liveTradingStage,
      stageProfile,
      finalBossReady: cfg.liveFinalBossReady,
      secretsFile: secrets,
      missingSecretEnvNames: missingEnv(REQUIRED_LIVE_SECRET_ENV),
      requiredSecretEnvNames: REQUIRED_LIVE_SECRET_ENV,
      acceptedFunderEnvNames: REQUIRED_FUNDER_ENV,
      signatureTypeEnvName: 'POLYMARKET_SIGNATURE_TYPE',
      signatureType: resolvePolymarketSignatureType(process.env.POLYMARKET_SIGNATURE_TYPE),
      funderEnvDetected: resolvePolymarketFunderAddress(process.env).source,
      funderAddress: redactWallet(resolvePolymarketFunderAddress(process.env).funderAddress),
      funderWarnings: resolvePolymarketFunderAddress(process.env).warnings,
      funderErrors: resolvePolymarketFunderAddress(process.env).errors,
      builderCodePresent: resolvePolymarketBuilderCode(process.env).present,
      builderCodeLooksValid: resolvePolymarketBuilderCode(process.env).valid,
      clobHost: cfg.clobHost,
      polygonRpcConfigured: Boolean(cfg.polygonRpcUrl),
      readyForMicroLive: false,
      reasons: [],
    };

    if (!secrets.exists) event.reasons.push('LIVE_SECRETS_FILE_MISSING');
    if (secrets.exists && !secrets.readable) event.reasons.push('LIVE_SECRETS_FILE_UNREADABLE');

    // Probe reachability up-front.
    const clobProbe = await probeHostReachable(cfg.clobHost, { healthPath: '/' });
    event.clobReachable = clobProbe.reachable;
    event.clobReachableLatencyMs = clobProbe.latencyMs;
    event.clobReachableError = clobProbe.error;
    if (!clobProbe.reachable) event.reasons.push('CLOB_UNREACHABLE');

    const rpcProbe = await probeRpcReachable(cfg.polygonRpcUrl);
    event.rpcReachable = rpcProbe.reachable;
    event.rpcReachableLatencyMs = rpcProbe.latencyMs;
    event.rpcReachableError = rpcProbe.error;
    event.rpcChainId = rpcProbe.chainId;
    if (!rpcProbe.reachable) event.reasons.push('POLYGON_RPC_UNREACHABLE');

    // Auth check (does not submit). Will fail safely if no secrets file or readable.
    let authEvent = null;
    if (cfg.liveAuthCheckAllow && secrets.exists && secrets.readable) {
      try {
        authEvent = await this.live.authCheck();
      } catch (e) {
        authEvent = { errors: [safeError(e)] };
      }
    } else if (!cfg.liveAuthCheckAllow) {
      event.reasons.push('LIVE_AUTH_CHECK_ALLOW_FALSE');
    }
    event.authCheck = authEvent;
    if (authEvent && Array.isArray(authEvent.errors) && authEvent.errors.length > 0) {
      event.reasons.push('AUTH_CHECK_FAILED');
    }

    // Signing proof (does not submit).
    let signingEvent = null;
    if (cfg.liveSigningTestAllow && secrets.exists && secrets.readable && rawIntent) {
      try {
        signingEvent = await this.signingTest(rawIntent);
      } catch (e) {
        signingEvent = {
          errors: [safeError(e)],
          signingProofPassed: false,
          signingProofError: classifySigningError(e).kind,
        };
      }
    } else if (!cfg.liveSigningTestAllow) {
      event.reasons.push('LIVE_SIGNING_TEST_ALLOW_FALSE');
    } else if (!rawIntent) {
      event.reasons.push('TEST_INTENT_REQUIRED');
    }
    event.signingProof = signingEvent;
    if (signingEvent) {
      event.orderConstructionLatencyMs = signingEvent.orderConstructionLatencyMs;
      event.signingProofPassed = Boolean(signingEvent.signingProofPassed);
      event.signingProofError = signingEvent.signingProofError || null;
      if (!event.signingProofPassed) {
        event.reasons.push(signingEvent.signingProofError || 'SIGNING_PROOF_FAILED');
      }
    }

    // Reconcile callable check (do not actually reconcile if not allowed).
    const reconcileDecision = this.live.secretAccessDecision('reconcile');
    event.reconcileCallable = reconcileDecision.ok;
    event.reconcileBlockReasons = reconcileDecision.reasons;

    // Final readiness gate.
    event.readyForMicroLive =
      event.reasons.length === 0 &&
      secrets.readable &&
      clobProbe.reachable &&
      rpcProbe.reachable &&
      event.signingProofPassed === true;

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
    const stageProfile = cfg.liveStageProfile || resolveLiveStageProfile(cfg);
    const secrets = secretFileStatus(cfg);
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
        liveFinalBossReady: cfg.liveFinalBossReady,
        liveTradingStage: cfg.liveTradingStage,
        liveAuthCheckAllow: cfg.liveAuthCheckAllow,
        liveSigningTestAllow: cfg.liveSigningTestAllow,
        liveReconcileAllow: cfg.liveReconcileAllow,
        liveCancelReplaceEnabled: cfg.liveCancelReplaceEnabled,
        liveCancelStaleOrders: cfg.liveCancelStaleOrders,
        liveCancelTestAllow: cfg.liveCancelTestAllow,
        liveRequireBurnIn: cfg.liveRequireBurnIn,
        liveRequireRiskApproval: cfg.liveRequireRiskApproval,
        liveRequireOracleConfirmation: cfg.liveRequireOracleConfirmation,
        liveRequirePersistenceConfirmation: cfg.liveRequirePersistenceConfirmation,
        liveWhaleCopyTrading: cfg.liveWhaleCopyTrading,
        liveAllowOracleSniper: cfg.liveAllowOracleSniper,
        maxLiveOrderUsd: cfg.maxLiveOrderUsd,
        maxLiveTotalExposureUsd: cfg.maxLiveTotalExposureUsd,
        liveDailyMaxLossUsd: cfg.liveDailyMaxLossUsd,
        polygonRpcUrlConfigured: Boolean(cfg.polygonRpcUrl),
        liveMinExpectedEdge: cfg.liveMinExpectedEdge,
        liveMaxSignalAgeMs: cfg.liveMaxSignalAgeMs,
        liveMaxDecisionLatencyMs: cfg.liveMaxDecisionLatencyMs,
        liveMaxOrderBuildLatencyMs: cfg.liveMaxOrderBuildLatencyMs,
        liveMaxSubmitDryRunLatencyMs: cfg.liveMaxSubmitDryRunLatencyMs,
        liveSecretsPath: cfg.liveSecretsPath,
      },
      liveStageProfile: stageProfile,
      canSubmitLive: this.live.canSubmitLive(),
      secretsFile: secrets,
      requiredSecretEnvNames: REQUIRED_LIVE_SECRET_ENV,
      acceptedFunderEnvNames: REQUIRED_FUNDER_ENV,
      signatureTypeEnvName: 'POLYMARKET_SIGNATURE_TYPE',
      funderEnvDetected: resolvePolymarketFunderAddress(process.env).source,
      funderAddress: redactWallet(resolvePolymarketFunderAddress(process.env).funderAddress),
      funderWarnings: resolvePolymarketFunderAddress(process.env).warnings,
      funderErrors: resolvePolymarketFunderAddress(process.env).errors,
      builderCodePresent: resolvePolymarketBuilderCode(process.env).present,
      builderCodeLooksValid: resolvePolymarketBuilderCode(process.env).valid,
      finalBossGate: {
        configuredReadyFlag: cfg.liveFinalBossReady,
        configuredStage: cfg.liveTradingStage,
        submitAllowedAtStage: stageProfile.submitAllowed,
        canSubmitLive: this.live.canSubmitLive(),
        funderAddress: redactWallet(resolvePolymarketFunderAddress(process.env).funderAddress),
        funderEnvUsed: resolvePolymarketFunderAddress(process.env).source,
        funderWarnings: resolvePolymarketFunderAddress(process.env).warnings,
        funderErrors: resolvePolymarketFunderAddress(process.env).errors,
        builderCodePresent: resolvePolymarketBuilderCode(process.env).present,
        builderCodeLooksValid: resolvePolymarketBuilderCode(process.env).valid,
      },
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
    currentLiveExposureSource: intent.currentLiveExposureSource,
    currentLiveExposureAuthenticatedReconciliation: intent.currentLiveExposureAuthenticatedReconciliation,
    currentLiveExposureObservedAt: intent.currentLiveExposureObservedAt,
    riskApprovedSizeUsd: Number.isFinite(intent.riskApprovedSizeUsd) ? intent.riskApprovedSizeUsd : null,
    adjustedSizeRiskApproved: intent.adjustedSizeRiskApproved,
    adjustedSizeRiskBlocker: intent.adjustedSizeRiskBlocker,
    currentDailyLivePnlUsd: intent.currentDailyLivePnlUsd,
    currentDailyLivePnlReconciled: intent.currentDailyLivePnlReconciled,
    currentDailyLivePnlObservedAt: intent.currentDailyLivePnlObservedAt,
    liveOrdersLastHour: intent.currentLiveOrdersLastHour,
    liveOrdersLastHourReconciled: intent.liveOrdersLastHourReconciled,
    liveOrdersLastHourObservedAt: intent.liveOrdersLastHourObservedAt,
    accountIdentityMatches: intent.accountIdentityMatches,
    liveAccountSnapshotFresh: intent.liveAccountSnapshotFresh,
    liveAccountSnapshotObservedAt: intent.liveAccountSnapshotObservedAt,
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
  node live_adapter_polymarket.js auth-dry-run [--intent intent.json]
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

  if (command === 'auth-dry-run') {
    const intent = readIntentFromArgs(baseDir, args);
    printStructured(await adapter.authDryRun(intent));
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
  buildPolymarketUserOrder,
  evaluateStaticSafety,
  evaluateMetadataSafety,
  evaluateBurnIn,
  evaluateLiveAccountTruth,
  evaluateLossExposureGuards,
  probeHostReachable,
  probeRpcReachable,
  classifySigningError,
  secretFileStatus,
  resolveLiveStageProfile,
  resolvePolymarketSignatureType,
  resolvePolymarketFunderAddress,
  resolvePolymarketBuilderCode,
  REQUIRED_LIVE_SECRET_ENV,
  REQUIRED_FUNDER_ENV,
};
