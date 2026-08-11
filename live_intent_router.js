'use strict';

/**
 * live_intent_router.js
 * Conservative bridge from Sophie/MoneyMaker auto-live candidates to live_adapter_polymarket.js.
 *
 * SAFETY MODEL:
 * - Does not sign orders itself.
 * - Does not read .env.live.secrets itself.
 * - Calls live_adapter_polymarket.js, which remains the final live safety gate.
 * - Defaults to dry-run mode unless LIVE_ROUTER_MODE=submit and live adapter flags are armed.
 * - Refuses blank-token, rejected, test/manual, blocked-strategy, oversized, stale, or duplicate candidates.
 * - Logs duplicate candidates but does not Telegram-spam duplicate notices by default.
 *
 * Input file default:
 *   ./auto_live_candidates.ndjson
 *
 * Commands:
 *   node live_intent_router.js doctor
 *   node live_intent_router.js once
 *   node live_intent_router.js run
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.2.0';

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function loadEnvFile(filePath, { override = false } = {}) {
  if (envBool('MM_SKIP_LOCAL_ENV_FILE', false) || envBool('SKIP_LOCAL_ENV_FILE', false)) return false;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return false;

  const raw = fs.readFileSync(resolved, 'utf8');
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return String(raw).split(',').map((x) => x.trim()).filter(Boolean);
}

function ensureFile(filePath) {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, '', 'utf8');
}

function appendNdjson(filePath, obj) {
  ensureFile(filePath);
  fs.appendFileSync(path.resolve(filePath), `${JSON.stringify(obj)}\n`, 'utf8');
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function safeWriteJson(filePath, obj) {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, abs);
}

function readNdjson(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return [];

  const out = [];
  const raw = fs.readFileSync(abs, 'utf8');
  let lineNo = 0;

  for (const line of raw.split(/\r?\n/)) {
    lineNo += 1;
    const t = line.trim();
    if (!t) continue;

    try {
      out.push({ raw: JSON.parse(t), lineNo, filePath: abs });
    } catch (e) {
      out.push({ parseError: e.message, lineNo, rawLine: t, filePath: abs });
    }
  }

  return out;
}

function sha16(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function shortId(value, head = 8, tail = 6) {
  const s = String(value || '');
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function firstString(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function inferSource(raw, filePath) {
  const explicit = firstString(raw.source, raw.external_source, raw.origin);
  if (explicit) {
    if (explicit === 'binance_btcusdt_trade_ws' || explicit.includes('binance')) return 'BTC_ORACLE';
    return explicit;
  }

  const fp = String(filePath || '').toLowerCase();
  if (fp.includes('external_signal')) return 'BTC_ORACLE';
  if (fp.includes('auto_live_candidates')) return 'MONEYMAKER';
  if (fp.includes('trade_intents')) return 'MONEYMAKER';
  return 'UNKNOWN';
}

function inferStrategy(raw) {
  return firstString(raw.strategy, raw.type, raw.signal_type, raw.action, 'UNKNOWN');
}

function inferSide(raw) {
  const direct = firstString(raw.side, raw.suggested_side);
  if (direct) return direct.toUpperCase();

  const action = String(raw.suggested_action || raw.action || '').toUpperCase();
  if (action.includes('SELL')) return 'SELL';
  if (action.includes('BUY')) return 'BUY';

  const direction = String(raw.direction || '').toUpperCase();
  if (direction === 'UP' || direction === 'DOWN') return 'BUY';

  return 'UNKNOWN';
}

function inferTokenId(raw) {
  return firstString(
    raw.tokenId,
    raw.token_id,
    raw.assetId,
    raw.asset_id,
    raw.clobTokenId,
    raw.clob_token_id,
    raw.token,
    raw.market?.tokenId,
    raw.metadata?.tokenId
  );
}

function inferMarketId(raw) {
  return firstString(raw.marketId, raw.market_id, raw.conditionId, raw.condition_id, raw.market?.marketId, raw.metadata?.marketId);
}

function inferPrice(raw, side) {
  const direct = firstFinite(raw.price, raw.limit_price, raw.order_price, raw.execution_price);
  if (Number.isFinite(direct)) return direct;

  const after = raw.book_after_persistence || raw.bookAfterPersistence || null;
  const before = raw.book_at_trigger || raw.bookAtTrigger || null;
  if (side === 'BUY') {
    return firstFinite(after?.best_ask, after?.bestAsk, before?.best_ask, before?.bestAsk);
  }
  if (side === 'SELL') {
    return firstFinite(after?.best_bid, after?.bestBid, before?.best_bid, before?.bestBid);
  }
  return NaN;
}

function inferSizeUsd(raw) {
  return firstFinite(raw.sizeUsd, raw.size_usd, raw.max_size_usd, raw.suggested_max_paper_usd, raw.suggestedMaxPaperUsd, raw.usd, raw.amountUsd);
}

function inferConfidence(raw) {
  return firstFinite(raw.confidence, raw.consensusScore, raw.consensus_score, raw.sophie?.score, raw.metadata?.consensus?.score);
}

function normalizeCandidate(raw, filePath) {
  const source = inferSource(raw, filePath);
  const strategy = inferStrategy(raw);
  const side = inferSide(raw);
  const tokenId = inferTokenId(raw);
  const marketId = inferMarketId(raw);
  const price = inferPrice(raw, side);
  const sizeUsd = inferSizeUsd(raw);
  const confidence = inferConfidence(raw);
  const rawHash = sha16(JSON.stringify(raw));
  const candidateId = firstString(raw.intent_id, raw.id, raw.candidate_id, raw.signal_id, `candidate_${rawHash}`);
  const consensus = raw.metadata?.consensus || raw.consensus || raw.sophie || null;

  const riskApproved = Boolean(
    raw.riskApproved ??
    raw.risk_approved ??
    raw.risk?.approved ??
    raw.metadata?.riskApproved ??
    raw.metadata?.risk_approved ??
    false
  );

  const expectedEdge = firstFinite(
    raw.expectedEdge,
    raw.expected_edge,
    raw.metadata?.expectedEdge,
    raw.risk?.expectedEdge,
    raw.metadata?.risk?.expectedEdge
  );

  const sophieApproved = Boolean(
    raw.sophieApproved ||
    raw.sophie_approved ||
    raw.sophie?.approved ||
    consensus?.authorized ||
    raw.metadata?.consensus?.authorized
  );

  const sizeShares = firstFinite(raw.sizeShares, raw.size_shares);
  const minOrderSizeRaw = raw.minOrderSize ?? raw.min_order_size ?? null;
  const currentLiveExposureUsd = firstFinite(raw.currentLiveExposureUsd, raw.current_live_exposure_usd);
  const paperRiskApprovedSizeUsd = firstFinite(raw.paperRiskApprovedSizeUsd, raw.paper_risk_approved_size_usd, raw.metadata?.paperRiskApprovedSizeUsd);
  const adjustedCandidateSizeUsd = firstFinite(raw.adjustedCandidateSizeUsd, raw.adjusted_candidate_size_usd, raw.metadata?.adjustedCandidateSizeUsd);
  const riskApprovedSizeUsd = firstFinite(raw.riskApprovedSizeUsd, raw.risk_approved_size_usd, raw.metadata?.riskApprovedSizeUsd);
  const adjustedSizeRiskApproved = raw.adjustedSizeRiskApproved ?? raw.adjusted_size_risk_approved ?? raw.metadata?.adjustedSizeRiskApproved ?? null;

  return {
    candidateId,
    rawHash,
    source,
    strategy,
    route: firstString(raw.route, raw.routeMode, raw.metadata?.consensus?.route?.mode),
    tokenId,
    marketId,
    side,
    price,
    sizeUsd,
    confidence,
    reason: firstString(raw.reason, raw.message, raw.suggested_action, raw.action, strategy),
    timestamp: firstString(raw.timestamp, raw.ts, nowIso()),
    expiresAt: firstString(raw.expires_at, raw.expiresAt),
    interruptLevel: firstString(raw.interrupt_level, raw.interruptLevel),
    action: firstString(raw.action, raw.suggested_action),
    riskApproved,
    expectedEdge,
    sophieApproved,
    consensusScore: Number.isFinite(confidence) ? confidence : firstFinite(consensus?.score, raw.metadata?.consensus?.score),
    bookFresh: raw.bookFresh !== undefined ? Boolean(raw.bookFresh) : raw.book_fresh !== undefined ? Boolean(raw.book_fresh) : inferBookFresh(raw),
    bookAgeMs: firstFinite(raw.bookAgeMs, raw.book_age_ms, raw.book_after_persistence?.age_ms, raw.bookAfterPersistence?.ageMs),
    whaleCopy: Boolean(raw.whaleCopy || raw.whale_copy || strategy === 'WhaleCopy'),
    oracleSignal: raw.oracleSignal === true || raw.oracle_signal === true || source === 'BTC_ORACLE' || strategy === 'BTC_TEMPORAL_LAG_OBI_V5',
    oracleConfirmed: (raw.oracleConfirmed ?? raw.oracle_confirmed) === true,
    persistenceConfirmed: (raw.persistenceConfirmed ?? raw.persistence_confirmed) === true,
    tickSize: raw.tickSize || raw.tick_size || raw.book_after_persistence?.tick_size || raw.bookAfterPersistence?.tickSize || null,
    negRisk: raw.negRisk ?? raw.neg_risk ?? null,
    sizeShares: Number.isFinite(sizeShares) ? sizeShares : null,
    minOrderSize: minOrderSizeRaw !== null && minOrderSizeRaw !== undefined ? Number(minOrderSizeRaw) : null,
    paperRiskApprovedSizeUsd: Number.isFinite(paperRiskApprovedSizeUsd) ? paperRiskApprovedSizeUsd : null,
    adjustedCandidateSizeUsd: Number.isFinite(adjustedCandidateSizeUsd) ? adjustedCandidateSizeUsd : null,
    riskApprovedSizeUsd: Number.isFinite(riskApprovedSizeUsd) ? riskApprovedSizeUsd : null,
    adjustedSizeRiskApproved: adjustedSizeRiskApproved === true,
    adjustedSizeRiskBlocker: firstString(raw.adjustedSizeRiskBlocker, raw.adjusted_size_risk_blocker, raw.metadata?.adjustedSizeRiskBlocker),
    liveStage: Number(firstFinite(
      raw.liveStage,
      raw.live_stage,
      raw.metadata?.liveStageProfile?.stage,
    )),
    currentLiveExposureUsd: Number.isFinite(currentLiveExposureUsd) ? currentLiveExposureUsd : null,
    currentLiveExposureSource: firstString(raw.currentLiveExposureSource, raw.current_live_exposure_source, raw.metadata?.currentLiveExposure?.source) || 'unavailable_not_authenticated',
    currentLiveExposureAuthenticatedReconciliation: (raw.currentLiveExposureAuthenticatedReconciliation ?? raw.current_live_exposure_authenticated_reconciliation ?? raw.metadata?.currentLiveExposure?.authenticatedReconciliation) === true,
    currentLiveExposureObservedAt: firstString(raw.currentLiveExposureObservedAt, raw.current_live_exposure_observed_at, raw.metadata?.currentLiveExposure?.observedAt),
    currentDailyLivePnlUsd: firstFinite(raw.currentDailyLivePnlUsd, raw.current_daily_live_pnl_usd),
    currentDailyLivePnlReconciled: (raw.currentDailyLivePnlReconciled ?? raw.current_daily_live_pnl_reconciled ?? raw.metadata?.liveAccountTruth?.dailyLivePnlReconciled) === true,
    currentDailyLivePnlObservedAt: firstString(raw.currentDailyLivePnlObservedAt, raw.current_daily_live_pnl_observed_at, raw.metadata?.liveAccountTruth?.observedAt),
    liveOrdersLastHour: firstFinite(raw.liveOrdersLastHour, raw.live_orders_last_hour, raw.currentLiveOrdersLastHour, raw.current_live_orders_last_hour),
    liveOrdersLastHourReconciled: (raw.liveOrdersLastHourReconciled ?? raw.live_orders_last_hour_reconciled ?? raw.metadata?.liveAccountTruth?.liveOrdersLastHourReconciled) === true,
    liveOrdersLastHourObservedAt: firstString(raw.liveOrdersLastHourObservedAt, raw.live_orders_last_hour_observed_at, raw.metadata?.liveAccountTruth?.observedAt),
    accountIdentityMatches: (raw.accountIdentityMatches ?? raw.account_identity_matches ?? raw.metadata?.liveAccountTruth?.accountIdentityMatches) === true,
    liveAccountSnapshotFresh: (raw.liveAccountSnapshotFresh ?? raw.live_account_snapshot_fresh ?? raw.metadata?.liveAccountTruth?.fresh) === true,
    liveAccountSnapshotObservedAt: firstString(raw.liveAccountSnapshotObservedAt, raw.live_account_snapshot_observed_at, raw.metadata?.liveAccountTruth?.observedAt),
    singleCanarySessionEligible: (raw.singleCanarySessionEligible ?? raw.single_canary_session_eligible ?? raw.metadata?.liveAccountTruth?.singleCanarySessionEligible) === true,
    singleCanaryBaseline: raw.singleCanaryBaseline || raw.single_canary_baseline || null,
    marketSlug: firstString(raw.marketSlug, raw.market_slug, raw.metadata?.marketSlug),
    marketQuestion: firstString(raw.marketQuestion, raw.market_question, raw.metadata?.marketQuestion),
    outcome: firstString(raw.outcome, raw.metadata?.outcome),
    paperBurnIn: raw.paperBurnIn || raw.burnIn || raw.paper_burn_in || null,
    raw,
    rawSourcePath: filePath,
  };
}

function inferBookFresh(raw) {
  const after = raw.book_after_persistence || raw.bookAfterPersistence || null;
  if (after?.valid === true && Number(after.age_ms ?? after.ageMs ?? Infinity) <= envNum('LIVE_MAX_BOOK_AGE_MS', 1500)) return true;
  if (raw.book_at_trigger?.valid === true && Number(raw.book_at_trigger.age_ms ?? Infinity) <= envNum('LIVE_MAX_BOOK_AGE_MS', 1500)) return true;
  return false;
}

function toLiveAdapterIntent(candidate) {
  return {
    id: candidate.candidateId,
    timestamp: candidate.timestamp,
    source: candidate.source,
    strategy: candidate.strategy,
    route: candidate.route,
    tokenId: candidate.tokenId,
    marketId: candidate.marketId,
    side: candidate.side,
    price: candidate.price,
    sizeUsd: candidate.sizeUsd,
    size_usd: candidate.sizeUsd,
    reason: candidate.reason,
    confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : null,
    sophieApproved: candidate.sophieApproved,
    sophie_approved: candidate.sophieApproved,
    riskApproved: candidate.riskApproved,
    risk_approved: candidate.riskApproved,
    expectedEdge: Number.isFinite(candidate.expectedEdge) ? candidate.expectedEdge : null,
    expected_edge: Number.isFinite(candidate.expectedEdge) ? candidate.expectedEdge : null,
    consensusScore: Number.isFinite(candidate.consensusScore) ? candidate.consensusScore : null,
    whaleCopy: candidate.whaleCopy,
    oracleSignal: candidate.oracleSignal,
    oracleConfirmed: candidate.oracleConfirmed,
    persistenceConfirmed: candidate.persistenceConfirmed,
    bookFresh: candidate.bookFresh,
    bookAgeMs: Number.isFinite(candidate.bookAgeMs) ? candidate.bookAgeMs : null,
    sizeShares: Number.isFinite(candidate.sizeShares) ? candidate.sizeShares : null,
    size_shares: Number.isFinite(candidate.sizeShares) ? candidate.sizeShares : null,
    minOrderSize: candidate.minOrderSize,
    min_order_size: candidate.minOrderSize,
    paperRiskApprovedSizeUsd: candidate.paperRiskApprovedSizeUsd,
    adjustedCandidateSizeUsd: candidate.adjustedCandidateSizeUsd,
    riskApprovedSizeUsd: candidate.riskApprovedSizeUsd,
    adjustedSizeRiskApproved: candidate.adjustedSizeRiskApproved,
    adjustedSizeRiskBlocker: candidate.adjustedSizeRiskBlocker,
    liveStage: Number.isFinite(candidate.liveStage) ? candidate.liveStage : null,
    live_stage: Number.isFinite(candidate.liveStage) ? candidate.liveStage : null,
    currentLiveExposureUsd: candidate.currentLiveExposureUsd,
    current_live_exposure_usd: candidate.currentLiveExposureUsd,
    currentLiveExposureSource: candidate.currentLiveExposureSource,
    current_live_exposure_source: candidate.currentLiveExposureSource,
    currentLiveExposureAuthenticatedReconciliation: candidate.currentLiveExposureAuthenticatedReconciliation,
    current_live_exposure_authenticated_reconciliation: candidate.currentLiveExposureAuthenticatedReconciliation,
    currentLiveExposureObservedAt: candidate.currentLiveExposureObservedAt || null,
    currentDailyLivePnlUsd: candidate.currentDailyLivePnlUsd,
    currentDailyLivePnlReconciled: candidate.currentDailyLivePnlReconciled,
    currentDailyLivePnlObservedAt: candidate.currentDailyLivePnlObservedAt || null,
    liveOrdersLastHour: candidate.liveOrdersLastHour,
    liveOrdersLastHourReconciled: candidate.liveOrdersLastHourReconciled,
    liveOrdersLastHourObservedAt: candidate.liveOrdersLastHourObservedAt || null,
    accountIdentityMatches: candidate.accountIdentityMatches,
    liveAccountSnapshotFresh: candidate.liveAccountSnapshotFresh,
    liveAccountSnapshotObservedAt: candidate.liveAccountSnapshotObservedAt || null,
    candidateHash: candidate.rawHash,
    singleCanarySessionEligible: candidate.singleCanarySessionEligible,
    singleCanaryBaseline: candidate.singleCanaryBaseline,
    tickSize: candidate.tickSize,
    negRisk: candidate.negRisk,
    marketSlug: candidate.marketSlug || null,
    market_slug: candidate.marketSlug || null,
    marketQuestion: candidate.marketQuestion || null,
    market_question: candidate.marketQuestion || null,
    outcome: candidate.outcome || null,
    paperBurnIn: candidate.paperBurnIn,
    raw: candidate.raw,
  };
}

function isExpired(candidate) {
  if (!candidate.expiresAt) return false;
  const t = Date.parse(candidate.expiresAt);
  return Number.isFinite(t) && Date.now() > t;
}

function evaluateRouterSafety(candidate, config) {
  const reasons = [];
  const source = String(candidate.source || '');
  const strategy = String(candidate.strategy || '');
  const action = String(candidate.action || '').toUpperCase();
  const level = String(candidate.interruptLevel || '').toUpperCase();
  const type = String(candidate.raw?.type || strategy || '');

  if (!candidate || !candidate.candidateId) reasons.push('CANDIDATE_INVALID');
  if (isExpired(candidate)) reasons.push('CANDIDATE_EXPIRED');
  if (!candidate.tokenId) reasons.push('TOKEN_ID_MISSING');
  if (!['BUY', 'SELL'].includes(candidate.side)) reasons.push('INVALID_SIDE');
  if (!Number.isFinite(candidate.price) || candidate.price <= 0 || candidate.price >= 1) reasons.push('INVALID_PRICE');
  if (!Number.isFinite(candidate.sizeUsd) || candidate.sizeUsd <= 0) reasons.push('INVALID_SIZE_USD');
  if (Number.isFinite(candidate.sizeUsd) && candidate.sizeUsd > config.maxOrderUsd) reasons.push('ROUTER_MAX_ORDER_USD_EXCEEDED');
  if (candidate.liveStage === 5) {
    if (candidate.adjustedSizeRiskApproved !== true) reasons.push('ADJUSTED_SIZE_RISK_NOT_APPROVED');
    if (!Number.isFinite(candidate.riskApprovedSizeUsd) || Math.abs(candidate.riskApprovedSizeUsd - candidate.sizeUsd) > 1e-9) {
      reasons.push('RISK_APPROVED_SIZE_MISMATCH');
    }
  }

  if (!config.allowedSources.has(source)) reasons.push(`SOURCE_NOT_ALLOWED:${source || 'blank'}`);
  if (config.blockedStrategies.has(strategy) || type.includes('REJECTED')) reasons.push(`STRATEGY_BLOCKED:${strategy || type || 'blank'}`);
  if (!config.allowedStrategies.has(strategy)) {
    reasons.push(`STRATEGY_NOT_ALLOWED:${strategy || 'blank'}`);
    console.log(`[live-router] STRATEGY_NOT_ALLOWED strategy=${strategy} allowList=[${[...config.allowedStrategies].join(',')}]`);
  }
  if (config.blockTestSignals && /test|manual/i.test(`${source}|${strategy}|${candidate.tokenId}|${candidate.reason}`)) reasons.push('TEST_OR_MANUAL_SIGNAL_BLOCKED');

  if (config.requireSophieApproval && source === 'MONEYMAKER' && !candidate.sophieApproved) reasons.push('SOPHIE_APPROVAL_MISSING');

  if (candidate.oracleSignal || source === 'BTC_ORACLE' || strategy === 'BTC_TEMPORAL_LAG_OBI_V5') {
    if (!config.allowOracleSignals) reasons.push('ORACLE_SIGNALS_DISABLED');
    if (strategy !== 'BTC_TEMPORAL_LAG_OBI_V5') reasons.push('ORACLE_STRATEGY_INVALID');
    if (level !== 'HARD_INTERRUPT_REQUEST') reasons.push('ORACLE_NOT_HARD_INTERRUPT');
    if (action !== 'TELEGRAM_HARD_INTERRUPT_REQUEST') reasons.push('ORACLE_ACTION_NOT_HARD_INTERRUPT');
    if (candidate.raw?.poly_lag_confirmed !== true) reasons.push('ORACLE_POLY_LAG_NOT_CONFIRMED');
    if (candidate.raw?.lag_score_pass !== true) reasons.push('ORACLE_LAG_SCORE_NOT_PASS');
    if (candidate.raw?.obi_confirmed !== true) reasons.push('ORACLE_OBI_NOT_CONFIRMED');
    if (candidate.raw?.book_after_persistence?.valid !== true && candidate.raw?.bookAfterPersistence?.valid !== true) reasons.push('ORACLE_BOOK_AFTER_PERSISTENCE_INVALID');
  }

  if (config.requireFreshBook && candidate.bookFresh !== true) reasons.push('BOOK_NOT_FRESH');
  if (config.requireFreshBook && Number.isFinite(candidate.bookAgeMs) && candidate.bookAgeMs > config.maxBookAgeMs) reasons.push('BOOK_TOO_OLD');

  if (Number.isFinite(candidate.confidence) && candidate.confidence < config.minConfidence) reasons.push('CONFIDENCE_TOO_LOW');

  return { ok: reasons.length === 0, reasons };
}

function loadState(config) {
  const fallback = { version: VERSION, processed: {}, duplicateNotified: {}, startedAt: nowIso() };
  const parsed = safeReadJson(config.statePath, fallback);
  return {
    version: parsed.version || VERSION,
    processed: parsed.processed || {},
    duplicateNotified: parsed.duplicateNotified || {},
    startedAt: parsed.startedAt || nowIso(),
  };
}

function saveState(config, state) {
  const entries = Object.entries(state.processed || {});
  if (entries.length > config.maxStateEntries) {
    entries.sort((a, b) => String(b[1]?.timestamp || '').localeCompare(String(a[1]?.timestamp || '')));
    state.processed = Object.fromEntries(entries.slice(0, config.maxStateEntries));
  }

  const duplicateEntries = Object.entries(state.duplicateNotified || {});
  if (duplicateEntries.length > config.maxStateEntries) {
    duplicateEntries.sort((a, b) => String(b[1]?.timestamp || '').localeCompare(String(a[1]?.timestamp || '')));
    state.duplicateNotified = Object.fromEntries(duplicateEntries.slice(0, config.maxStateEntries));
  }

  safeWriteJson(config.statePath, state);
}

function readConfig(baseDir = process.cwd()) {
  loadEnvFile(path.join(baseDir, '.env'));
  loadEnvFile(path.join(baseDir, '.env.telegram'));
  loadEnvFile(path.join(baseDir, 'telegram', '.env.telegram'));

  const watchPaths = envList('LIVE_ROUTER_WATCH_PATHS', [process.env.AUTO_LIVE_CANDIDATES_PATH || './auto_live_candidates.ndjson'])
    .map((p) => path.resolve(baseDir, p));

  const allowedSources = new Set(envList('LIVE_ALLOWED_SOURCES', ['MONEYMAKER', 'BTC_ORACLE']));
  const allowedStrategies = new Set(envList('LIVE_ROUTER_ALLOWED_STRATEGIES', envList('LIVE_ALLOWED_STRATEGIES', [
    'SpreadHunter',
    'GabagoolBtcOracleStrategy',
    'InventoryExit',
    'StopLossExit',
    'TakeProfitExit',
    'BTC_TEMPORAL_LAG_OBI_V5',
  ])));
  const blockedStrategies = new Set(envList('LIVE_BLOCKED_STRATEGIES', [
    'BTC_TEMPORAL_LAG_OBI_REJECTED',
    'WhaleCopy',
    'ComplementArb',
    'TailEndMispricing',
    'TEST_APPROVAL',
  ]));

  return {
    baseDir,
    version: VERSION,
    enabled: envBool('LIVE_ROUTER_ENABLED', true),
    mode: String(process.env.LIVE_ROUTER_MODE || 'dry-run').trim().toLowerCase(),
    adapterPath: path.resolve(baseDir, process.env.LIVE_ROUTER_ADAPTER_PATH || './live_adapter_polymarket.js'),
    watchPaths,
    statePath: path.resolve(baseDir, process.env.LIVE_ROUTER_STATE_PATH || './live_intent_router_state.json'),
    eventsPath: path.resolve(baseDir, process.env.LIVE_ROUTER_EVENTS_PATH || './live_intent_router_events.ndjson'),
    pollMs: envInt('LIVE_ROUTER_POLL_MS', 2500),
    maxBurst: Math.max(1, envInt('LIVE_ROUTER_MAX_BURST', 3)),
    maxStateEntries: Math.max(100, envInt('LIVE_ROUTER_MAX_STATE_ENTRIES', 5000)),
    maxOrderUsd: envNum('LIVE_ROUTER_MAX_ORDER_USD', envNum('MAX_LIVE_ORDER_USD', 1)),
    minConfidence: envNum('LIVE_ROUTER_MIN_CONFIDENCE', 0),
    requireSophieApproval: envBool('LIVE_ROUTER_REQUIRE_SOPHIE_APPROVAL', true),
    requireFreshBook: envBool('LIVE_ROUTER_REQUIRE_FRESH_BOOK', true),
    maxBookAgeMs: envNum('LIVE_MAX_BOOK_AGE_MS', 1500),
    allowOracleSignals: envBool('LIVE_ROUTER_ALLOW_ORACLE_SIGNALS', false),
    blockTestSignals: envBool('LIVE_ROUTER_BLOCK_TEST_SIGNALS', true),
    allowedSources,
    allowedStrategies,
    blockedStrategies,
    telegramNotify: envBool('LIVE_ROUTER_TELEGRAM_NOTIFY', true),
    notifyDuplicates: envBool('LIVE_ROUTER_NOTIFY_DUPLICATES', false),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  };
}

function validateConfig(config) {
  const errors = [];
  if (!config.enabled) errors.push('LIVE_ROUTER_ENABLED=false');
  if (!['dry-run', 'submit'].includes(config.mode)) errors.push('LIVE_ROUTER_MODE must be dry-run or submit');
  if (!fs.existsSync(config.adapterPath)) errors.push(`live adapter not found: ${config.adapterPath}`);
  if (!Number.isFinite(config.maxOrderUsd) || config.maxOrderUsd <= 0) errors.push('LIVE_ROUTER_MAX_ORDER_USD invalid');
  return errors;
}

function loadAdapter(config) {
  // Require lazily so doctor can report adapter path clearly.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(config.adapterPath);
}

async function notifyTelegram(config, text) {
  if (!config.telegramNotify || !config.telegramBotToken || !config.telegramChatId) return;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram notify failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

function decisionClass(decision, reasons = []) {
  const d = String(decision || '').toUpperCase();
  const r = (Array.isArray(reasons) ? reasons : []).map((x) => String(x || '').toUpperCase());

  if (d === 'SUBMITTED' || d === 'LIVE_ORDER_SUBMITTED') {
    return { title: 'AUTO-LIVE SUBMITTED', icon: '🟢', severity: 'submitted' };
  }

  if (d === 'DRY_RUN_ALLOWED_BUT_NOT_SUBMITTED' || d === 'ALLOW_LIVE_SUBMISSION') {
    return { title: 'AUTO-LIVE DRY RUN', icon: '🟢', severity: 'dry_run' };
  }

  if (d === 'DUPLICATE_BLOCKED' || r.some((x) => x.includes('DUPLICATE'))) {
    return { title: 'DUPLICATE BLOCKED', icon: '🟦', severity: 'blocked' };
  }

  if (r.some((x) => x.includes('DAILY_MAX_LOSS'))) {
    return { title: 'DAILY LOSS HIT', icon: '🔴', severity: 'danger' };
  }

  if (r.some((x) => x.includes('KILL_SWITCH'))) {
    return { title: 'KILL SWITCH ACTIVE', icon: '🛑', severity: 'danger' };
  }

  if (r.some((x) => x.includes('BOOK_TOO_OLD') || x.includes('BOOK_NOT_FRESH'))) {
    return { title: 'BOOK TOO OLD', icon: '🟠', severity: 'blocked' };
  }

  if (r.some((x) => x.includes('SOPHIE_SCORE') || x.includes('SOPHIE_APPROVAL') || x.includes('CONFIDENCE_TOO_LOW'))) {
    return { title: 'SOPHIE SCORE TOO LOW', icon: '🟠', severity: 'blocked' };
  }

  if (d === 'REFUSED' || d === 'ROUTER_SKIPPED' || d.includes('REFUSED')) {
    return { title: 'AUTO-LIVE REFUSED', icon: '🟡', severity: 'refused' };
  }

  return { title: 'LIVE ROUTER NOTICE', icon: '🔵', severity: 'info' };
}

function resultMessage(candidate, decision, reasons) {
  const cls = decisionClass(decision, reasons);

  return [
    `${cls.icon} <b>${escapeHtml(cls.title)}</b>`,
    `<b>Decision:</b> ${escapeHtml(decision)}`,
    `<b>Source:</b> ${escapeHtml(candidate.source)}`,
    `<b>Strategy:</b> ${escapeHtml(candidate.strategy)}`,
    `<b>Side:</b> ${escapeHtml(candidate.side)}`,
    `<b>Token:</b> <code>${escapeHtml(shortId(candidate.tokenId, 8, 6))}</code>`,
    Number.isFinite(candidate.price) ? `<b>Price:</b> $${candidate.price.toFixed(3)}` : null,
    Number.isFinite(candidate.sizeUsd) ? `<b>Size:</b> $${candidate.sizeUsd.toFixed(2)}` : null,
    Number.isFinite(candidate.confidence) ? `<b>Sophie/Confidence:</b> ${candidate.confidence.toFixed(3)}` : null,
    candidate.route ? `<b>Route:</b> ${escapeHtml(candidate.route)}` : null,
    reasons && reasons.length ? `<b>Reasons:</b> ${escapeHtml(reasons.slice(0, 8).join(', '))}` : null,
    `<code>${escapeHtml(candidate.candidateId)}</code>`,
  ].filter(Boolean).join('\n');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function processCandidate(config, state, adapter, item) {
  if (item.parseError) {
    appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'ROUTER_PARSE_ERROR', file: item.filePath, lineNo: item.lineNo, error: item.parseError });
    return { processed: false, skipped: true };
  }

  const candidate = normalizeCandidate(item.raw, item.filePath);
  const uniqueKey = `${candidate.candidateId}:${candidate.rawHash}`;
  if (state.processed[uniqueKey]) {
    state.duplicateNotified = state.duplicateNotified || {};
    if (!state.duplicateNotified[uniqueKey]) {
      const reasons = ['DUPLICATE_CANDIDATE_ALREADY_PROCESSED'];
      const event = {
        timestamp: nowIso(),
        type: 'LIVE_ROUTER_DUPLICATE_BLOCKED',
        decision: 'DUPLICATE_BLOCKED',
        candidate_id: candidate.candidateId,
        raw_hash: candidate.rawHash,
        source: candidate.source,
        strategy: candidate.strategy,
        token_id: candidate.tokenId,
        side: candidate.side,
        price: candidate.price,
        size_usd: candidate.sizeUsd,
        reasons,
      };
      appendNdjson(config.eventsPath, event);
      state.duplicateNotified[uniqueKey] = { timestamp: nowIso(), decision: event.decision, reasons };
      saveState(config, state);
      if (config.notifyDuplicates) {
        await notifyTelegram(config, resultMessage(candidate, event.decision, reasons)).catch((e) => {
          appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'LIVE_ROUTER_TELEGRAM_NOTIFY_FAILED', error: e.message, candidate_id: candidate.candidateId });
        });
      }
    }
    return { processed: false, skipped: true, duplicate: true };
  }

  const routerSafety = evaluateRouterSafety(candidate, config);
  if (!routerSafety.ok) {
    console.log(
      `[live-router] AUTO_LIVE_CANDIDATE_SKIP strategy=${candidate.strategy} side=${candidate.side} ` +
      `token=${shortId(candidate.tokenId)} price=${candidate.price} sizeUsd=${candidate.sizeUsd} ` +
      `riskApproved=${candidate.riskApproved} expectedEdge=${candidate.expectedEdge} ` +
      `sophieApproved=${candidate.sophieApproved} reasons=[${routerSafety.reasons.join(',')}]`
    );
    const event = {
      timestamp: nowIso(),
      type: 'LIVE_ROUTER_REFUSED',
      decision: 'ROUTER_SKIPPED',
      candidate_id: candidate.candidateId,
      raw_hash: candidate.rawHash,
      source: candidate.source,
      strategy: candidate.strategy,
      token_id: candidate.tokenId,
      side: candidate.side,
      price: candidate.price,
      size_usd: candidate.sizeUsd,
      risk_approved: candidate.riskApproved,
      expected_edge: candidate.expectedEdge,
      sophie_approved: candidate.sophieApproved,
      size_shares: candidate.sizeShares,
      min_order_size: candidate.minOrderSize,
      reasons: routerSafety.reasons,
    };
    appendNdjson(config.eventsPath, event);
    state.processed[uniqueKey] = { timestamp: nowIso(), decision: event.decision, reasons: routerSafety.reasons };
    saveState(config, state);
    await notifyTelegram(config, resultMessage(candidate, event.decision, routerSafety.reasons)).catch((e) => {
      appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'LIVE_ROUTER_TELEGRAM_NOTIFY_FAILED', error: e.message, candidate_id: candidate.candidateId });
    });
    return { processed: true, refused: true, event };
  }

  const rawIntent = toLiveAdapterIntent(candidate);
  console.log(
    `[live-router] AUTO_LIVE_CANDIDATE_ROUTED strategy=${candidate.strategy} side=${candidate.side} ` +
    `token=${shortId(candidate.tokenId)} price=${candidate.price} sizeUsd=${candidate.sizeUsd} ` +
    `riskApproved=${candidate.riskApproved} expectedEdge=${candidate.expectedEdge} ` +
    `sophieApproved=${candidate.sophieApproved} sizeShares=${candidate.sizeShares} minOrderSize=${candidate.minOrderSize} ` +
    `mode=${config.mode}`
  );
  const result = await adapter.handleIntent(rawIntent, {
    mode: config.mode === 'submit' ? 'submit' : 'dry-run',
    fetchMetadata: config.mode === 'submit',
  });

  const event = {
    timestamp: nowIso(),
    type: 'LIVE_ROUTER_ADAPTER_RESULT',
    router_mode: config.mode,
    candidate_id: candidate.candidateId,
    raw_hash: candidate.rawHash,
    source: candidate.source,
    strategy: candidate.strategy,
    token_id: candidate.tokenId,
    side: candidate.side,
    price: candidate.price,
    size_usd: candidate.sizeUsd,
    risk_approved: candidate.riskApproved,
    expected_edge: candidate.expectedEdge,
    sophie_approved: candidate.sophieApproved,
    size_shares: candidate.sizeShares,
    min_order_size: candidate.minOrderSize,
    adapter_decision: result?.decision || result?.type || 'UNKNOWN',
    adapter_reasons: result?.reasons || [],
    adapter_type: result?.type || null,
  };

  appendNdjson(config.eventsPath, event);
  state.processed[uniqueKey] = { timestamp: nowIso(), decision: event.adapter_decision, reasons: event.adapter_reasons };
  saveState(config, state);

  await notifyTelegram(config, resultMessage(candidate, event.adapter_decision, event.adapter_reasons)).catch((e) => {
    appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'LIVE_ROUTER_TELEGRAM_NOTIFY_FAILED', error: e.message, candidate_id: candidate.candidateId });
  });

  return { processed: true, event, result };
}

function collectItems(config) {
  const items = [];
  for (const p of config.watchPaths) {
    ensureFile(p);
    items.push(...readNdjson(p));
  }
  return items;
}

async function processBatch(config, state, adapter) {
  const items = collectItems(config);
  let count = 0;

  for (const item of items) {
    if (count >= config.maxBurst) break;
    const result = await processCandidate(config, state, adapter, item);
    if (result.processed) count += 1;
  }

  return count;
}

async function doctor(config) {
  console.log(`[live-router] version=${VERSION}`);
  console.log(`[live-router] baseDir=${config.baseDir}`);
  console.log(`[live-router] mode=${config.mode}`);
  console.log(`[live-router] adapterPath=${config.adapterPath}`);
  console.log(`[live-router] watchPaths=${config.watchPaths.join(',')}`);
  console.log(`[live-router] eventsPath=${config.eventsPath}`);
  console.log(`[live-router] statePath=${config.statePath}`);
  console.log(`[live-router] maxOrderUsd=${config.maxOrderUsd}`);
  console.log(`[live-router] allowedSources=${[...config.allowedSources].join(',')}`);
  console.log(`[live-router] allowedStrategies=${[...config.allowedStrategies].join(',')}`);
  console.log(`[live-router] blockedStrategies=${[...config.blockedStrategies].join(',')}`);
  console.log(`[live-router] allowOracleSignals=${config.allowOracleSignals}`);
  console.log(`[live-router] telegramNotify=${config.telegramNotify && Boolean(config.telegramBotToken) && Boolean(config.telegramChatId)}`);
  console.log(`[live-router] notifyDuplicates=${config.notifyDuplicates}`);

  const errors = validateConfig(config);
  if (errors.length) {
    console.error(`[live-router] CONFIG_ERRORS=${errors.join('; ')}`);
    process.exitCode = 1;
    return;
  }

  try {
    const mod = loadAdapter(config);
    const adapter = new mod.LiveAdapter({ baseDir: config.baseDir });
    console.log(`[live-router] adapterLoaded=true`);
    console.log(`[live-router] adapterSecretsWouldLoad=${adapter.live.shouldLoadSecrets()}`);
    console.log(`[live-router] liveFlags enableLiveTrading=${adapter.config.enableLiveTrading} liveAutoExecute=${adapter.config.liveAutoExecute} liveKillSwitch=${adapter.config.liveKillSwitch} liveDryRunOnly=${adapter.config.liveDryRunOnly}`);
  } catch (e) {
    console.error(`[live-router] adapterLoaded=false error=${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

async function once(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('; '));
  ensureFile(config.eventsPath);
  const state = loadState(config);
  const { LiveAdapter } = loadAdapter(config);
  const adapter = new LiveAdapter({ baseDir: config.baseDir });
  const count = await processBatch(config, state, adapter);
  console.log(`[live-router] processed=${count}`);
}

async function run(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('; '));
  ensureFile(config.eventsPath);
  const state = loadState(config);
  const { LiveAdapter } = loadAdapter(config);
  const adapter = new LiveAdapter({ baseDir: config.baseDir });

  appendNdjson(config.eventsPath, {
    timestamp: nowIso(),
    type: 'LIVE_ROUTER_STARTED',
    version: VERSION,
    mode: config.mode,
    watchPaths: config.watchPaths,
    safety: { signs_orders_itself: false, reads_live_secrets_itself: false, adapter_final_gate: true },
  });

  console.log(`[live-router] online version=${VERSION} mode=${config.mode}`);
  console.log(`[live-router] watching ${config.watchPaths.join(', ')}`);

  while (true) {
    try {
      const count = await processBatch(config, state, adapter);
      if (count > 0) console.log(`[live-router] processed=${count}`);
    } catch (e) {
      console.error(`[live-router] ERROR ${e.stack || e.message}`);
      appendNdjson(config.eventsPath, { timestamp: nowIso(), type: 'LIVE_ROUTER_ERROR', error: e.message });
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
    console.log('Usage:\n  node live_intent_router.js doctor\n  node live_intent_router.js once\n  node live_intent_router.js run');
    return;
  }

  if (command === 'doctor') return doctor(config);
  if (command === 'once') return once(config);
  if (command === 'run') return run(config);
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[live-router] FATAL ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  readConfig,
  normalizeCandidate,
  evaluateRouterSafety,
  toLiveAdapterIntent,
  decisionClass,
};
