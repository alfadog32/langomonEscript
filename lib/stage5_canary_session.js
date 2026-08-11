'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const SCOPE = 'single_order_canary_only';
const DEFAULT_MAX_AGE_MS = 30_000;
const GLOBAL_HISTORY_BLOCKERS = new Set([
  'LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE',
  'LIVE_ORDER_RATE_UNCERTAIN',
]);
const STATES = Object.freeze({
  CREATED: 'CREATED',
  BASELINE_VERIFIED: 'BASELINE_VERIFIED',
  ARM_ELIGIBLE: 'ARM_ELIGIBLE',
  SUBMISSION_ATTEMPT_MARKED: 'SUBMISSION_ATTEMPT_MARKED',
  SUBMISSION_ACCEPTED: 'SUBMISSION_ACCEPTED',
  SUBMISSION_OUTCOME_UNKNOWN: 'SUBMISSION_OUTCOME_UNKNOWN',
  RECONCILING: 'RECONCILING',
  FILLED: 'FILLED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  OPEN: 'OPEN',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
  LOCKOFF_RESTORED: 'LOCKOFF_RESTORED',
});
const TRANSITIONS = Object.freeze({
  CREATED: new Set(['BASELINE_VERIFIED', 'RECONCILIATION_FAILED']),
  BASELINE_VERIFIED: new Set(['ARM_ELIGIBLE', 'RECONCILIATION_FAILED']),
  ARM_ELIGIBLE: new Set(['SUBMISSION_ATTEMPT_MARKED', 'RECONCILIATION_FAILED']),
  SUBMISSION_ATTEMPT_MARKED: new Set(['SUBMISSION_ACCEPTED', 'SUBMISSION_OUTCOME_UNKNOWN', 'REJECTED', 'RECONCILIATION_FAILED']),
  SUBMISSION_ACCEPTED: new Set(['RECONCILING', 'RECONCILIATION_FAILED']),
  RECONCILING: new Set(['FILLED', 'PARTIALLY_FILLED', 'OPEN', 'REJECTED', 'CANCELLED', 'EXPIRED', 'RECONCILIATION_FAILED']),
  FILLED: new Set(['LOCKOFF_RESTORED']),
  PARTIALLY_FILLED: new Set(['LOCKOFF_RESTORED']),
  OPEN: new Set(['LOCKOFF_RESTORED']),
  REJECTED: new Set(['LOCKOFF_RESTORED']),
  CANCELLED: new Set(['LOCKOFF_RESTORED']),
  EXPIRED: new Set(['LOCKOFF_RESTORED']),
  SUBMISSION_OUTCOME_UNKNOWN: new Set(['RECONCILING', 'LOCKOFF_RESTORED']),
  RECONCILIATION_FAILED: new Set(['LOCKOFF_RESTORED']),
  LOCKOFF_RESTORED: new Set(),
});
const UNRESOLVED_STATES = new Set([
  STATES.CREATED, STATES.BASELINE_VERIFIED, STATES.ARM_ELIGIBLE,
  STATES.SUBMISSION_ATTEMPT_MARKED, STATES.SUBMISSION_ACCEPTED,
  STATES.SUBMISSION_OUTCOME_UNKNOWN, STATES.RECONCILING,
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return number < 10_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function orderId(record) {
  return String(record?.id || record?.orderID || record?.orderId || record?.order_id || '').trim();
}

function candidateIdentity(candidate = {}) {
  return {
    candidateId: String(candidate.candidateId || candidate.id || '').trim(),
    source: String(candidate.source || '').trim(),
    strategy: String(candidate.strategy || '').trim(),
    tokenId: String(candidate.tokenId || candidate.token_id || '').trim(),
    marketId: String(candidate.marketId || candidate.market_id || '').trim(),
    side: String(candidate.side || '').trim().toUpperCase(),
    price: finite(candidate.price),
    sizeShares: finite(candidate.sizeShares ?? candidate.size_shares),
    sizeUsd: finite(candidate.sizeUsd ?? candidate.size_usd),
    tickSize: String(candidate.tickSize || candidate.tick_size || '').trim(),
    minOrderSize: finite(candidate.minOrderSize ?? candidate.min_order_size),
    liveStage: finite(candidate.liveStage ?? candidate.live_stage),
    riskApproved: candidate.riskApproved === true,
    adjustedSizeRiskApproved: candidate.adjustedSizeRiskApproved === true,
    riskApprovedSizeUsd: finite(candidate.riskApprovedSizeUsd),
    sophieApproved: candidate.sophieApproved === true,
    oracleConfirmed: candidate.oracleConfirmed === true,
    persistenceConfirmed: candidate.persistenceConfirmed === true,
    bookFresh: candidate.bookFresh === true,
    testOnly: candidate.testOnly === true || /test|manual/i.test(`${candidate.source || ''}|${candidate.strategy || ''}|${candidate.reason || ''}`),
  };
}

function hashCanaryCandidate(candidate) {
  return hashObject(candidateIdentity(candidate));
}

function buildSingleCanaryBaselineEvidence(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    observedAt: snapshot.observedAt,
    account: snapshot.account,
    positions: { ...snapshot.positions, records: Array.isArray(snapshot.positions?.records) ? snapshot.positions.records : [] },
    openOrders: { ...snapshot.openOrders, records: Array.isArray(snapshot.openOrders?.records) ? snapshot.openOrders.records : [] },
    collateral: snapshot.collateral,
    pnl: snapshot.pnl,
    totals: snapshot.totals,
    reconciliation: snapshot.reconciliation,
    watcher: snapshot.watcher || null,
  };
}

function evaluateSingleCanaryBaseline({
  snapshot,
  watcherHealth = null,
  candidate = null,
  existingSession = null,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  acceptedBaselineExposureUsd = 0,
  requireWatcher = true,
} = {}) {
  const blockers = [];
  const reconciliation = snapshot?.reconciliation || {};
  const globalBlockers = Array.isArray(reconciliation.blockers) ? reconciliation.blockers : ['LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE'];
  const disallowedGlobalBlockers = globalBlockers.filter((blocker) => !GLOBAL_HISTORY_BLOCKERS.has(blocker));
  const observedMs = timestampMs(snapshot?.observedAt);
  const snapshotAgeMs = observedMs === null ? Infinity : Math.max(0, nowMs - observedMs);
  const exposure = finite(snapshot?.totals?.liveExposureUsd);
  const balance = finite(snapshot?.collateral?.balanceUsd);
  const positionCount = finite(snapshot?.positions?.count);
  const openOrderCount = finite(snapshot?.openOrders?.count);

  if (!snapshot || typeof snapshot !== 'object') blockers.push('LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE');
  if (snapshot?.account?.identityMatches !== true || reconciliation.identityBound !== true) blockers.push('LIVE_ACCOUNT_IDENTITY_UNCERTAIN');
  if (reconciliation.fresh !== true || !Number.isFinite(snapshotAgeMs) || snapshotAgeMs > maxAgeMs) blockers.push('LIVE_ACCOUNT_SNAPSHOT_STALE');
  blockers.push(...disallowedGlobalBlockers);
  if (reconciliation.exposureReconciled !== true || exposure === null) blockers.push('LIVE_EXPOSURE_UNCERTAIN');
  if (reconciliation.dailyPnlReconciled !== true || finite(snapshot?.totals?.dailyRealizedPnlUsd) === null) blockers.push('LIVE_DAILY_PNL_UNCERTAIN');
  if (snapshot?.pnl?.coverageComplete !== true || snapshot?.pnl?.feesComplete !== true || snapshot?.pnl?.redemptionsComplete !== true) blockers.push('LIVE_DAILY_PNL_INPUTS_INCOMPLETE');
  if (snapshot?.openOrders?.authenticated !== true || snapshot?.openOrders?.complete !== true || openOrderCount !== 0) blockers.push('CANARY_BASELINE_OPEN_ORDERS_NOT_ZERO');
  if (positionCount !== 0 || exposure === null || exposure > Number(acceptedBaselineExposureUsd) + 1e-9) blockers.push('CANARY_BASELINE_EXPOSURE_NOT_CLEAN');
  if (snapshot?.collateral?.authenticated !== true || snapshot?.collateral?.complete !== true || balance === null || balance < 0) blockers.push('LIVE_COLLATERAL_BALANCE_UNAVAILABLE');
  if (reconciliation.orderCountReconciled === true || reconciliation.globalOrderHistoryReconciled === true) {
    // Globally reconciled is acceptable, but the scope remains one canary.
  } else if (!globalBlockers.includes('LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE')) {
    blockers.push('LIVE_ORDER_HISTORY_SCOPE_NOT_EXPLICIT');
  }

  if (requireWatcher) {
    if (watcherHealth?.readinessScope !== SCOPE || !String(watcherHealth?.healthGeneration || '').trim()) blockers.push('LIVE_ACCOUNT_TRUTH_CANARY_SCOPE_UNPROVEN');
    if (watcherHealth?.running !== true || Number(watcherHealth?.watcherPid || 0) <= 0) blockers.push('LIVE_ACCOUNT_TRUTH_WATCHER_NOT_RUNNING');
    if (Number(watcherHealth?.consecutiveSuccessfulSnapshots || 0) < 2) blockers.push('LIVE_ACCOUNT_TRUTH_TWO_SNAPSHOTS_REQUIRED');
    if (Number(watcherHealth?.consecutiveFailures || 0) !== 0) blockers.push('LIVE_ACCOUNT_TRUTH_REFRESH_FAILURE');
    const watcherObserved = timestampMs(watcherHealth?.lastSuccessfulRefresh);
    if (watcherObserved === null || nowMs - watcherObserved >= 15_000) blockers.push('LIVE_ACCOUNT_SNAPSHOT_STALE');
  }

  if (existingSession && existingSession.state !== STATES.LOCKOFF_RESTORED) blockers.push('UNRESOLVED_PRIOR_CANARY_SESSION');
  if (existingSession?.state === STATES.LOCKOFF_RESTORED) blockers.push('CANARY_SESSION_RECORD_ALREADY_EXISTS');
  if (existingSession?.submissionAttempted === true) blockers.push('CANARY_SUBMISSION_ALREADY_ATTEMPTED');

  if (candidate) {
    const identity = candidateIdentity(candidate);
    const candidateAgeMs = Math.max(0, nowMs - (timestampMs(candidate.timestamp) ?? -Infinity));
    if (!identity.candidateId) blockers.push('CANARY_CANDIDATE_ID_MISSING');
    if (existingSession?.submissionAttempted === true && existingSession.candidateId === identity.candidateId) blockers.push('CANARY_CANDIDATE_SESSION_ALREADY_CONSUMED');
    if (identity.source !== 'MONEYMAKER' || identity.strategy !== 'GabagoolBtcOracleStrategy' || identity.testOnly) blockers.push('CANARY_CANDIDATE_NOT_REAL_GABAGOOL');
    if (identity.liveStage !== 5) blockers.push('CANARY_CANDIDATE_NOT_STAGE5');
    if (identity.side !== 'BUY') blockers.push('CANARY_CLEAN_BASELINE_REQUIRES_BUY');
    if (!identity.riskApproved || !identity.adjustedSizeRiskApproved || identity.riskApprovedSizeUsd === null || Math.abs(identity.riskApprovedSizeUsd - identity.sizeUsd) > 1e-9) blockers.push('CANARY_CANDIDATE_RISK_UNAPPROVED');
    if (!identity.sophieApproved) blockers.push('CANARY_CANDIDATE_SOPHIE_UNAPPROVED');
    if (!identity.oracleConfirmed || !identity.persistenceConfirmed) blockers.push('CANARY_CANDIDATE_ORACLE_UNCONFIRMED');
    if (!identity.bookFresh) blockers.push('CANARY_CANDIDATE_BOOK_STALE');
    if (!Number.isFinite(candidateAgeMs) || candidateAgeMs > 10_000) blockers.push('CANARY_CANDIDATE_STALE');
    if (!identity.tokenId || !identity.marketId || !['BUY', 'SELL'].includes(identity.side) || identity.price === null || identity.sizeShares === null || identity.sizeUsd === null) blockers.push('CANARY_CANDIDATE_INCOMPLETE');
  }

  const unique = [...new Set(blockers)];
  return {
    eligible: unique.length === 0,
    scope: SCOPE,
    globalOrderHistoryReconciled: reconciliation.orderCountReconciled === true && reconciliation.globalOrderHistoryReconciled !== false,
    historicalAllStatusCoverageAvailable: reconciliation.orderCountReconciled === true,
    authorizedSubmissionAttempts: 1,
    snapshotAgeMs,
    blockers: unique,
    globalBlockers: [...globalBlockers],
  };
}

function writeJsonAtomic0600(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
  fs.renameSync(temporary, resolved);
  fs.chmodSync(resolved, 0o600);
}

class CanarySessionStore {
  constructor({ sessionPath, now = Date.now } = {}) {
    if (!sessionPath) throw new Error('CANARY_SESSION_PATH_REQUIRED');
    this.sessionPath = path.resolve(sessionPath);
    this.lockPath = `${this.sessionPath}.lock`;
    this.now = now;
  }

  read() {
    if (!fs.existsSync(this.sessionPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !STATES[parsed?.state]) throw new Error('CANARY_SESSION_MALFORMED');
    return parsed;
  }

  withLock(fn) {
    fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
    let descriptor;
    try {
      descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('CANARY_SESSION_LOCKED');
      throw error;
    }
    try {
      return fn();
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(this.lockPath);
    }
  }

  write(session) {
    writeJsonAtomic0600(this.sessionPath, session);
    return session;
  }

  transitionLocked(session, nextState, patch = {}) {
    if (!TRANSITIONS[session.state]?.has(nextState)) throw new Error(`CANARY_INVALID_STATE_TRANSITION:${session.state}->${nextState}`);
    const timestamp = new Date(this.now()).toISOString();
    const next = {
      ...session,
      ...patch,
      state: nextState,
      updatedAt: timestamp,
      stateHistory: [...(session.stateHistory || []), { state: nextState, timestamp }],
    };
    if ([STATES.FILLED, STATES.PARTIALLY_FILLED, STATES.OPEN, STATES.REJECTED, STATES.CANCELLED, STATES.EXPIRED, STATES.RECONCILIATION_FAILED].includes(nextState)) next.finalState = nextState;
    return this.write(next);
  }

  createArmEligible({ candidate, baselineSnapshot, watcherHealth, acceptedBaselineExposureUsd = 0 } = {}) {
    return this.withLock(() => {
      const previous = this.read();
      const policy = evaluateSingleCanaryBaseline({ snapshot: baselineSnapshot, watcherHealth, candidate, existingSession: previous, nowMs: this.now(), acceptedBaselineExposureUsd });
      if (!policy.eligible) throw Object.assign(new Error(`CANARY_BASELINE_REFUSED:${policy.blockers.join(',')}`), { blockers: policy.blockers, policy });
      const identity = candidateIdentity(candidate);
      const candidateHash = String(candidate.candidateHash || candidate.rawHash || hashCanaryCandidate(candidate));
      const timestamp = new Date(this.now()).toISOString();
      let session = {
        schemaVersion: SCHEMA_VERSION,
        scope: SCOPE,
        sessionId: `stage5_${this.now()}_${crypto.randomBytes(6).toString('hex')}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        state: STATES.CREATED,
        stateHistory: [{ state: STATES.CREATED, timestamp }],
        candidateId: identity.candidateId,
        candidateHash,
        canonicalCandidateHash: hashCanaryCandidate(candidate),
        tokenId: identity.tokenId,
        marketId: identity.marketId,
        side: identity.side,
        quantizedPrice: identity.price,
        shares: identity.sizeShares,
        finalNotionalUsd: identity.sizeUsd,
        baselineAccountTruthObservedAt: baselineSnapshot.observedAt,
        baselineSnapshotHash: hashObject(baselineSnapshot),
        baselineIdentity: baselineSnapshot.account,
        baselineOpenOrderIds: (baselineSnapshot.openOrders?.records || []).map(orderId).filter(Boolean).sort(),
        baselinePositionCount: baselineSnapshot.positions?.count,
        baselineExposureUsd: baselineSnapshot.totals?.liveExposureUsd,
        baselineBalanceUsd: baselineSnapshot.collateral?.balanceUsd,
        baselineDailyRealizedPnlUsd: baselineSnapshot.totals?.dailyRealizedPnlUsd,
        watcherHealthGeneration: watcherHealth?.healthGeneration || baselineSnapshot.watcher?.healthGeneration || null,
        globalOrderHistoryReconciled: policy.globalOrderHistoryReconciled,
        historicalAllStatusCoverageAvailable: policy.historicalAllStatusCoverageAvailable,
        submissionAttempted: false,
        submissionAttemptedAt: null,
        expectedSignedOrderIdentityHash: null,
        returnedOrderId: null,
        adapterResponseClassification: 'never_attempted',
        reconciliationState: 'NOT_STARTED',
        finalState: null,
        lockoffRestorationState: 'NOT_STARTED',
        errors: [],
        blockers: [],
      };
      session = this.transitionLocked(session, STATES.BASELINE_VERIFIED, { baselinePolicy: policy });
      return this.transitionLocked(session, STATES.ARM_ELIGIBLE);
    });
  }

  assertCandidate(session, candidate) {
    const candidateId = String(candidate.candidateId || candidate.id || '');
    const suppliedHash = String(candidate.candidateHash || candidate.rawHash || hashCanaryCandidate(candidate));
    if (candidateId !== session.candidateId) throw new Error('CANARY_CANDIDATE_ID_MISMATCH');
    if (suppliedHash !== session.candidateHash || hashCanaryCandidate(candidate) !== session.canonicalCandidateHash) throw new Error('CANARY_CANDIDATE_HASH_MISMATCH');
  }

  markSubmissionAttempt({ candidate, signedOrder } = {}) {
    return this.withLock(() => {
      const session = this.read();
      if (!session) throw new Error('CANARY_SESSION_MISSING');
      this.assertCandidate(session, candidate);
      if (session.state !== STATES.ARM_ELIGIBLE || session.submissionAttempted === true) throw new Error('CANARY_SECOND_SUBMISSION_REFUSED');
      const safeSignedIdentity = signedOrder && typeof signedOrder === 'object'
        ? Object.fromEntries(Object.entries(signedOrder).filter(([key]) => !/signature|secret|key|passphrase/i.test(key)))
        : null;
      return this.transitionLocked(session, STATES.SUBMISSION_ATTEMPT_MARKED, {
        submissionAttempted: true,
        submissionAttemptedAt: new Date(this.now()).toISOString(),
        expectedSignedOrderIdentityHash: safeSignedIdentity ? hashObject(safeSignedIdentity) : null,
        adapterResponseClassification: 'submission_attempted',
      });
    });
  }

  recordSubmissionAccepted(orderIdentifier, responseClassification = 'accepted_with_order_id') {
    return this.withLock(() => this.transitionLocked(this.read(), STATES.SUBMISSION_ACCEPTED, {
      returnedOrderId: String(orderIdentifier),
      adapterResponseClassification: responseClassification,
    }));
  }

  recordSubmissionRejected(code = 'DEFINITIVE_REJECTION') {
    return this.withLock(() => this.transitionLocked(this.read(), STATES.REJECTED, {
      adapterResponseClassification: 'submission_attempted_definitive_rejection',
      blockers: [code],
    }));
  }

  recordSubmissionUnknown(code = 'SUBMISSION_OUTCOME_UNKNOWN') {
    return this.withLock(() => this.transitionLocked(this.read(), STATES.SUBMISSION_OUTCOME_UNKNOWN, {
      adapterResponseClassification: 'submission_outcome_unknown',
      blockers: [code],
    }));
  }

  startReconciliation() {
    return this.withLock(() => this.transitionLocked(this.read(), STATES.RECONCILING, { reconciliationState: 'IN_PROGRESS' }));
  }

  recordReconciliation(result) {
    return this.withLock(() => this.transitionLocked(this.read(), result.ok ? result.state : STATES.RECONCILIATION_FAILED, {
      reconciliationState: result.ok ? 'RECONCILED' : 'FAILED',
      reconciliation: result,
      blockers: result.blockers || [],
    }));
  }

  recordLockoff({ restored, code = null } = {}) {
    return this.withLock(() => {
      const session = this.read();
      if (!session) throw new Error('CANARY_SESSION_MISSING');
      if (restored && session.state === STATES.LOCKOFF_RESTORED) return session;
      if (!restored) {
        return this.write({ ...session, lockoffRestorationState: 'FAILED', blockers: [...new Set([...(session.blockers || []), code || 'LOCKOFF_RESTORATION_FAILED'])], updatedAt: new Date(this.now()).toISOString() });
      }
      let terminalSession = session;
      if (!TRANSITIONS[terminalSession.state]?.has(STATES.LOCKOFF_RESTORED)) {
        if (!TRANSITIONS[terminalSession.state]?.has(STATES.RECONCILIATION_FAILED)) throw new Error(`CANARY_LOCKOFF_TRANSITION_UNAVAILABLE:${terminalSession.state}`);
        terminalSession = this.transitionLocked(terminalSession, STATES.RECONCILIATION_FAILED, {
          reconciliationState: 'FAILED',
          blockers: [...new Set([...(terminalSession.blockers || []), 'CANARY_LOCKOFF_BEFORE_TERMINAL'])],
        });
      }
      return this.transitionLocked(terminalSession, STATES.LOCKOFF_RESTORED, { lockoffRestorationState: 'RESTORED' });
    });
  }
}

function classifySubmissionResponse(response) {
  const id = orderId(response);
  if (response?.success === false) return { classification: 'submission_attempted_definitive_rejection', orderId: null, definitive: true, accepted: false };
  if (id) return { classification: 'accepted_with_order_id', orderId: id, definitive: true, accepted: true };
  return { classification: 'submission_outcome_unknown', orderId: null, definitive: false, accepted: false };
}

async function submitCanaryExactlyOnce({ store, candidate, signedOrder, postOrder } = {}) {
  if (!store || typeof postOrder !== 'function') throw new Error('CANARY_SUBMISSION_DEPENDENCY_MISSING');
  store.markSubmissionAttempt({ candidate, signedOrder });
  let response;
  try {
    response = await postOrder();
  } catch (error) {
    const session = store.recordSubmissionUnknown(error?.code || 'SUBMISSION_TRANSPORT_AMBIGUOUS');
    return { classification: 'submission_outcome_unknown', response: null, orderId: null, errorCode: error?.code || 'SUBMISSION_TRANSPORT_AMBIGUOUS', session };
  }
  const classified = classifySubmissionResponse(response);
  if (classified.accepted) {
    return { ...classified, response, session: store.recordSubmissionAccepted(classified.orderId) };
  }
  if (classified.definitive) return { ...classified, response, session: store.recordSubmissionRejected('CLOB_SUBMISSION_REJECTED') };
  return { ...classified, response, session: store.recordSubmissionUnknown('ACCEPTED_RESPONSE_MISSING_ORDER_ID') };
}

function tradeFillSharesForOrder(trade, expectedOrderId) {
  let shares = 0;
  if (String(trade?.taker_order_id || '') === expectedOrderId) shares += Number(trade?.size || 0);
  for (const maker of Array.isArray(trade?.maker_orders) ? trade.maker_orders : []) {
    if (String(maker?.order_id || '') === expectedOrderId) shares += Number(maker?.matched_amount || 0);
  }
  return Number.isFinite(shares) ? shares : 0;
}

function reconcileExactCanaryOrder({ session, order, openOrders = [], trades = [], afterSnapshot, sourceStatus = null, nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const blockers = [];
  if (sourceStatus?.directOrder?.authenticated !== true || sourceStatus?.directOrder?.fetched !== true || sourceStatus?.directOrder?.complete !== true) blockers.push('CANARY_DIRECT_ORDER_SOURCE_INCOMPLETE');
  if (sourceStatus?.openOrders?.authenticated !== true || sourceStatus?.openOrders?.fetched !== true || sourceStatus?.openOrders?.complete !== true) blockers.push('CANARY_OPEN_ORDER_SOURCE_INCOMPLETE');
  if (sourceStatus?.trades?.authenticated !== true || sourceStatus?.trades?.fetched !== true || sourceStatus?.trades?.complete !== true ||
      sourceStatus?.trades?.coverageComplete !== true || sourceStatus?.trades?.paginationComplete !== true || sourceStatus?.trades?.terminalCursorReached !== true) {
    blockers.push('CANARY_TRADE_SOURCE_INCOMPLETE');
  }
  const expectedId = String(session?.returnedOrderId || '');
  const observedId = orderId(order);
  if (!expectedId || !order || observedId !== expectedId) blockers.push('CANARY_RETURNED_ORDER_ID_MISMATCH');
  const token = String(order?.asset_id || order?.assetId || order?.tokenId || '');
  const market = String(order?.market || order?.marketId || '');
  const side = String(order?.side || '').toUpperCase();
  const price = finite(order?.price);
  const originalShares = finite(order?.original_size ?? order?.originalSize ?? order?.size);
  const matchedShares = finite(order?.size_matched ?? order?.sizeMatched ?? 0);
  if (token !== String(session?.tokenId || '')) blockers.push('CANARY_ORDER_TOKEN_MISMATCH');
  if (market !== String(session?.marketId || '')) blockers.push('CANARY_ORDER_MARKET_MISMATCH');
  if (side !== String(session?.side || '')) blockers.push('CANARY_ORDER_SIDE_MISMATCH');
  if (price === null || Math.abs(price - Number(session?.quantizedPrice)) > 1e-9) blockers.push('CANARY_ORDER_PRICE_MISMATCH');
  if (originalShares === null || Math.abs(originalShares - Number(session?.shares)) > 1e-9) blockers.push('CANARY_ORDER_SIZE_MISMATCH');
  if (matchedShares === null || matchedShares < -1e-9 || (originalShares !== null && matchedShares > originalShares + 1e-9)) blockers.push('CANARY_ORDER_MATCHED_SIZE_INVALID');

  const baselineIds = new Set(session?.baselineOpenOrderIds || []);
  const currentIds = new Set(openOrders.map(orderId).filter(Boolean));
  const snapshotOpenIds = new Set((afterSnapshot?.openOrders?.records || []).map(orderId).filter(Boolean));
  if (currentIds.size !== snapshotOpenIds.size || [...currentIds].some((id) => !snapshotOpenIds.has(id))) blockers.push('CANARY_OPEN_ORDER_SOURCE_DISAGREEMENT');
  const unexpected = [...currentIds].filter((id) => id !== expectedId && !baselineIds.has(id));
  if (unexpected.length) blockers.push('CANARY_UNEXPECTED_ADDITIONAL_ORDER');

  const seenTrades = new Set();
  let tradeFillShares = 0;
  for (const trade of trades) {
    const tradeId = String(trade?.id || trade?.trade_id || hashObject(trade));
    if (seenTrades.has(tradeId)) continue;
    seenTrades.add(tradeId);
    tradeFillShares += tradeFillSharesForOrder(trade, expectedId);
  }
  if (tradeFillShares > 0 && matchedShares !== null && Math.abs(tradeFillShares - matchedShares) > 1e-9) blockers.push('CANARY_RECONCILIATION_SOURCE_DISAGREEMENT');

  const afterObservedMs = timestampMs(afterSnapshot?.observedAt);
  const afterExposure = finite(afterSnapshot?.totals?.liveExposureUsd);
  const afterBalance = finite(afterSnapshot?.collateral?.balanceUsd);
  if (afterSnapshot?.account?.identityMatches !== true || afterSnapshot?.reconciliation?.identityBound !== true ||
      afterSnapshot?.reconciliation?.exposureReconciled !== true || afterSnapshot?.reconciliation?.dailyPnlReconciled !== true ||
      afterSnapshot?.positions?.complete !== true || afterSnapshot?.positions?.identityBound !== true ||
      afterSnapshot?.openOrders?.complete !== true || afterSnapshot?.openOrders?.authenticated !== true ||
      afterObservedMs === null || nowMs - afterObservedMs > maxAgeMs) blockers.push('CANARY_AFTER_SNAPSHOT_UNCERTAIN');
  if (afterBalance === null || afterSnapshot?.collateral?.complete !== true || afterSnapshot?.collateral?.authenticated !== true) blockers.push('CANARY_AFTER_BALANCE_UNCERTAIN');
  const positionRecords = Array.isArray(afterSnapshot?.positions?.records) ? afterSnapshot.positions.records : [];
  const unexpectedPositions = positionRecords.filter((record) => String(record?.asset || record?.tokenId || record?.token_id || '') !== String(session?.tokenId || ''));
  if (unexpectedPositions.length > 0) blockers.push('CANARY_UNEXPECTED_POSITION_CHANGE');
  const expectedPosition = positionRecords.find((record) => String(record?.asset || record?.tokenId || record?.token_id || '') === String(session?.tokenId || ''));
  if (matchedShares > 0 && (!expectedPosition || finite(expectedPosition.size) === null || finite(expectedPosition.size) + 1e-9 < matchedShares)) blockers.push('CANARY_POSITION_DELTA_MISSING');
  if (!(matchedShares > 0) && positionRecords.length > 0) blockers.push('CANARY_UNEXPECTED_POSITION_CHANGE');
  const expectedFilledNotional = Number(matchedShares || 0) * Number(session?.quantizedPrice || 0);
  const status = String(order?.status || order?.state || '').toUpperCase();
  const orderRemainsOpen = ['LIVE', 'OPEN', 'UNMATCHED'].includes(status);
  const minimumExpectedExposureDelta = orderRemainsOpen ? Number(session?.finalNotionalUsd || 0) : expectedFilledNotional;
  const maximumPossibleExposureDelta = (orderRemainsOpen || matchedShares > 0) ? Number(session?.shares || 0) : 0;
  const exposureDelta = afterExposure === null ? null : afterExposure - Number(session?.baselineExposureUsd || 0);
  if (exposureDelta === null || exposureDelta < minimumExpectedExposureDelta - 0.02 || exposureDelta > maximumPossibleExposureDelta + 0.02) blockers.push('CANARY_EXPOSURE_DELTA_MISMATCH');
  const balanceDelta = Number(session?.baselineBalanceUsd) - Number(afterBalance);
  if (!Number.isFinite(balanceDelta) || Math.abs(balanceDelta - expectedFilledNotional) > 0.05) blockers.push('CANARY_BALANCE_DELTA_MISMATCH');

  let state = null;
  if (['FILLED', 'MATCHED'].includes(status) && originalShares !== null && matchedShares !== null && matchedShares >= originalShares - 1e-9) state = STATES.FILLED;
  else if (['LIVE', 'OPEN', 'UNMATCHED'].includes(status) && matchedShares > 0) state = STATES.PARTIALLY_FILLED;
  else if (['LIVE', 'OPEN', 'UNMATCHED'].includes(status)) state = STATES.OPEN;
  else if (['REJECTED', 'FAILED'].includes(status)) state = STATES.REJECTED;
  else if (['CANCELLED', 'CANCELED'].includes(status)) state = STATES.CANCELLED;
  else if (status === 'EXPIRED') state = STATES.EXPIRED;
  else blockers.push('CANARY_ORDER_STATUS_UNKNOWN');
  if (!currentIds.has(expectedId) && ['LIVE', 'OPEN', 'UNMATCHED'].includes(status)) blockers.push('CANARY_OPEN_ORDER_SOURCE_DISAGREEMENT');
  if (currentIds.has(expectedId) && [STATES.FILLED, STATES.REJECTED, STATES.CANCELLED, STATES.EXPIRED].includes(state)) blockers.push('CANARY_OPEN_ORDER_SOURCE_DISAGREEMENT');

  const unique = [...new Set(blockers)];
  return {
    ok: unique.length === 0,
    state: unique.length === 0 ? state : STATES.RECONCILIATION_FAILED,
    returnedOrderId: expectedId,
    observedOrderId: observedId || null,
    status: status || null,
    matchedShares,
    tradeFillShares,
    afterExposureUsd: afterExposure,
    afterBalanceUsd: afterBalance,
    blockers: unique,
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  GLOBAL_HISTORY_BLOCKERS,
  SCHEMA_VERSION,
  SCOPE,
  STATES,
  TRANSITIONS,
  UNRESOLVED_STATES,
  CanarySessionStore,
  buildSingleCanaryBaselineEvidence,
  candidateIdentity,
  classifySubmissionResponse,
  evaluateSingleCanaryBaseline,
  hashCanaryCandidate,
  hashObject,
  reconcileExactCanaryOrder,
  submitCanaryExactlyOnce,
  writeJsonAtomic0600,
};
