'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CanarySessionStore,
  SCOPE,
  STATES,
  evaluateSingleCanaryBaseline,
  hashCanaryCandidate,
  reconcileExactCanaryOrder,
  submitCanaryExactlyOnce,
} = require('../lib/stage5_canary_session');
const { LiveAdapter, resolveLiveStageProfile } = require('../live_adapter_polymarket');
const { evaluateRouterSafety, normalizeCandidate, toLiveAdapterIntent } = require('../live_intent_router');
const { evaluateAccountTruthWatcherHealth } = require('./live_account_truth_runner_policy');

const ROOT = path.resolve(__dirname, '..');
const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = 'fixture-token-real-shaped-123456789';
const MARKET = 'fixture-btc-market-real-shaped';
const PROTECTED = [
  '.env', '.env.live.secrets', '.env.telegram', '.dashboard_token',
  'auto_live_candidates.ndjson', 'trade_intents.ndjson', 'live_intent_router_events.ndjson',
  'live_adapter_events.ndjson', 'live_execution_events.ndjson', 'moneymaker_v3_state.json',
];

function fileState(relative) {
  const target = path.join(ROOT, relative);
  if (!fs.existsSync(target)) return { exists: false };
  const stat = fs.statSync(target);
  if (!stat.isFile()) return { exists: true, type: 'non-file' };
  return { exists: true, size: stat.size, hash: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') };
}

function snapshot(nowMs = Date.now(), overrides = {}) {
  const base = {
    observedAt: new Date(nowMs).toISOString(),
    account: {
      signerAddress: WALLET, configuredAccountWallet: WALLET, resolvedAccountWallet: WALLET,
      configuredSignatureType: 0, resolvedSignatureType: 0, resolvedWalletType: 'EOA', identityMatches: true,
    },
    positions: { source: 'official_data_api_current_positions', fetched: true, complete: true, authenticated: false, publicAddressScoped: true, identityBound: true, fresh: true, count: 0, exposureUsd: 0, records: [], blockers: [] },
    openOrders: { source: 'official_clob_authenticated_open_orders', fetched: true, complete: true, authenticated: true, publicAddressScoped: false, identityBound: true, fresh: true, count: 0, remainingBuyExposureUsd: 0, reduceOnlySellNotionalUsd: 0, records: [], blockers: [] },
    collateral: { source: 'official_clob_authenticated_collateral_balance', fetched: true, complete: true, authenticated: true, identityBound: true, fresh: true, balanceUsd: 100, allowancesPresent: true },
    pnl: { source: 'authenticated trades + address activity', fetched: true, complete: true, authenticated: true, publicAddressScoped: true, identityBound: true, fresh: true, coverageComplete: true, feesComplete: true, redemptionsComplete: true, historyWindow: { start: 'account_inception', end: new Date(nowMs).toISOString() }, realizedPnlUsd: 0, blockers: [] },
    recentOrders: { source: 'corroborating_open_orders_trades_notifications', fetched: true, complete: false, authenticated: true, identityBound: true, coverageComplete: false, submittedCount: null, blockers: ['LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE'] },
    totals: { liveExposureUsd: 0, dailyRealizedPnlUsd: 0, ordersLastHour: null },
    reconciliation: {
      exposureReconciled: true, dailyPnlReconciled: true, orderCountReconciled: false,
      globalOrderHistoryReconciled: false, identityBound: true, fresh: true, snapshotAgeMs: 0, maxAgeMs: 30_000,
      trustStatus: 'incomplete_external_reconciliation',
      blockers: ['LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE', 'LIVE_ORDER_RATE_UNCERTAIN'],
    },
    watcher: {
      readinessScope: SCOPE, healthGeneration: 'fixture-health-generation-2', running: true, watcherPid: 4321,
      lastSuccessfulRefresh: new Date(nowMs).toISOString(), consecutiveSuccessfulSnapshots: 2, consecutiveFailures: 0,
    },
  };
  return deepMerge(base, overrides);
}

function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return overrides === undefined ? base : overrides;
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}

function candidate(nowMs = Date.now(), overrides = {}) {
  return {
    id: 'candidate-real-gabagool-1', candidateId: 'candidate-real-gabagool-1', timestamp: new Date(nowMs).toISOString(),
    source: 'MONEYMAKER', strategy: 'GabagoolBtcOracleStrategy', route: 'consensus:authorized',
    tokenId: TOKEN, marketId: MARKET, side: 'BUY', price: 0.74, sizeUsd: 3.7, sizeShares: 5,
    tickSize: '0.01', minOrderSize: 5, liveStage: 5, reason: 'real paper-approved Gabagool opportunity',
    confidence: 0.8, consensusScore: 0.8, sophieApproved: true, riskApproved: true,
    adjustedSizeRiskApproved: true, riskApprovedSizeUsd: 3.7, oracleSignal: false, oracleConfirmed: true,
    persistenceConfirmed: true, expectedEdge: 0.1, bookFresh: true, bookAgeMs: 50, signalAgeMs: 50,
    decisionLatencyMs: 10, currentLiveExposureUsd: 0,
    currentLiveExposureSource: 'official_data_api_current_positions + official_clob_authenticated_open_orders',
    currentLiveExposureAuthenticatedReconciliation: true, currentLiveExposureObservedAt: new Date(nowMs).toISOString(),
    currentDailyLivePnlUsd: 0, currentDailyLivePnlReconciled: true, currentDailyLivePnlObservedAt: new Date(nowMs).toISOString(),
    liveOrdersLastHour: null, liveOrdersLastHourReconciled: false, liveOrdersLastHourObservedAt: new Date(nowMs).toISOString(),
    accountIdentityMatches: true, liveAccountSnapshotFresh: true, liveAccountSnapshotObservedAt: new Date(nowMs).toISOString(),
    singleCanarySessionEligible: true, singleCanaryBaseline: snapshot(nowMs), negRisk: false,
    paperBurnIn: { ok: true, reports: 5, closedPnlUsd: 1, drawdownPct: 0, ghostFavorablePct: 1 },
    ...overrides,
  };
}

function watcherHealth(nowMs = Date.now(), overrides = {}) {
  return {
    running: true, watcherPid: 4321, readinessScope: SCOPE, lastSuccessfulRefresh: new Date(nowMs).toISOString(),
    consecutiveSuccessfulSnapshots: 2, consecutiveFailures: 0, exactBlockers: [], healthGeneration: 'fixture-health-generation-2',
    ...overrides,
  };
}

function adapterConfig(tempDir) {
  const config = {
    baseDir: tempDir, clobHost: 'https://fixture.invalid', enableLiveTrading: true, liveAutoExecute: true,
    liveKillSwitch: false, liveDryRunOnly: false, liveSubmitConfirm: true, liveFinalBossReady: true,
    liveTradingStage: 5, liveCanaryMarketId: MARKET, maxLiveOrderUsd: 5, maxLiveTotalExposureUsd: 5,
    liveDailyMaxLossUsd: 5, liveMaxOrdersPerHour: 1, liveAccountTruthTtlMs: 30_000,
    liveRequireSophieApproval: true, liveRequireRiskApproval: true, liveRequireFreshBook: true,
    liveRequireBurnIn: true, liveRequireOracleConfirmation: true, liveRequirePersistenceConfirmation: true,
    liveMinBurnInReports: 3, liveMinBurnInClosedPnlUsd: 0, liveMaxBurnInDrawdownPct: 3,
    liveMinGhostFavorablePct: 0, liveBurnInOkOverride: false, liveSophieMinScore: 0.55,
    liveMinExpectedEdge: 0, liveMaxSignalAgeMs: 10_000, liveMaxDecisionLatencyMs: 2_000,
    liveMaxBookAgeMs: 1_500, liveMaxSpread: 0.12, liveAllowOracleSniper: true,
    liveWhaleCopyTrading: false, livePostOnlyDefault: true, liveCancelReplaceEnabled: false,
    liveAdapterEventsPath: path.join(tempDir, 'adapter-events.ndjson'), liveExecutionLogPath: path.join(tempDir, 'execution-events.ndjson'),
    stage5CanarySessionPath: path.join(tempDir, 'session.json'),
  };
  config.liveStageProfile = resolveLiveStageProfile(config);
  return config;
}

function filledEvidence(orderId = 'order-fixture-1', overrides = {}) {
  return deepMerge({
    order: { id: orderId, status: 'FILLED', maker_address: WALLET, market: MARKET, asset_id: TOKEN, side: 'BUY', price: '0.74', original_size: '5', size_matched: '5' },
    openOrders: [],
    trades: [{ id: 'trade-1', taker_order_id: orderId, market: MARKET, asset_id: TOKEN, side: 'BUY', size: '5', price: '0.74', maker_orders: [] }],
    afterSnapshot: snapshot(Date.now(), {
      positions: { count: 1, exposureUsd: 3.7, records: [{ asset: TOKEN, size: 5, conservativeExposureUsd: 3.7 }] },
      collateral: { balanceUsd: 96.3 }, totals: { liveExposureUsd: 3.7 },
    }),
    sourceStatus: {
      directOrder: { authenticated: true, fetched: true, complete: true },
      openOrders: { authenticated: true, fetched: true, complete: true },
      trades: { authenticated: true, fetched: true, complete: true, coverageComplete: true, paginationComplete: true, terminalCursorReached: true },
    },
  }, overrides);
}

async function runAdapterScenario(tempDir, { intentOverrides = {}, response = { success: true, orderID: 'order-fixture-1', status: 'matched' }, postError = null, evidence = null, openOrders = [], restore = true, mutateAfterBaseline = null } = {}) {
  const config = adapterConfig(tempDir);
  const store = new CanarySessionStore({ sessionPath: config.stage5CanarySessionPath });
  let postCalls = 0;
  let restoreCalls = 0;
  const adapter = new LiveAdapter({
    baseDir: tempDir,
    config,
    canarySessionStore: store,
    canaryExactEvidenceProvider: async (session) => evidence || filledEvidence(session.returnedOrderId),
    canaryLockoffRestorer: async () => { restoreCalls += 1; return { restored: restore }; },
  });
  adapter.live = {
    privateKeyAccessed: false,
    canSubmitLive: () => true,
    init: async () => ({ async getOrderBook() { return { bids: [{ price: 0.73, size: 10 }], asks: [{ price: 0.74, size: 10 }], tick_size: '0.01', min_order_size: 5, neg_risk: false, timestamp: Date.now() }; } }),
    getOpenOrders: async () => openOrders,
    signOrderOnly: async (liveIntent) => {
      if (typeof mutateAfterBaseline === 'function') mutateAfterBaseline(liveIntent);
      return { signedOrder: { salt: 'fixture-salt', maker: WALLET, tokenId: TOKEN, price: '0.74', size: '5', signature: 'fixture-signature-never-real' }, orderConstructionLatencyMs: 1 };
    },
    postSignedOrder: async () => {
      postCalls += 1;
      const persisted = store.read();
      assert.equal(persisted.submissionAttempted, true, 'attempt marker must exist before postOrder');
      assert.equal(persisted.state, STATES.SUBMISSION_ATTEMPT_MARKED);
      if (postError) throw postError;
      return { response, submitLatencyMs: 1 };
    },
  };
  const raw = candidate(Date.now(), intentOverrides);
  const normalized = normalizeCandidate(raw, path.join(tempDir, 'auto_live_candidates.ndjson'));
  const routerConfig = { maxOrderUsd: 5, allowedSources: new Set(['MONEYMAKER']), blockedStrategies: new Set(), allowedStrategies: new Set(['GabagoolBtcOracleStrategy']), blockTestSignals: true, requireSophieApproval: true, allowOracleSignals: true, requireFreshBook: true, maxBookAgeMs: 1500, minConfidence: 0.70 };
  const routerDecision = evaluateRouterSafety(normalized, routerConfig);
  assert.equal(routerDecision.ok, true, `production router refusal: ${routerDecision.reasons.join(',')}`);
  const adapterIntent = toLiveAdapterIntent(normalized);
  const result = await adapter.handleIntent(adapterIntent, { mode: 'submit', fetchMetadata: true });
  return { result, store, postCalls, restoreCalls, adapterIntent, adapter };
}

async function main() {
  const before = Object.fromEntries(PROTECTED.map((file) => [file, fileState(file)]));
  const forbiddenReads = [];
  const originalRead = fs.readFileSync;
  fs.readFileSync = function guardedRead(file, ...args) {
    const resolved = path.resolve(String(file));
    if (['.env', '.env.live.secrets', '.env.telegram'].includes(path.basename(resolved)) && resolved.startsWith(ROOT)) forbiddenReads.push(resolved);
    return originalRead.call(this, file, ...args);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-canary-session-'));
  try {
    const nowMs = Date.now();
    const clean = snapshot(nowMs);
    const healthyWatcher = watcherHealth(nowMs);
    const realCandidate = candidate(nowMs);
    const shared = evaluateSingleCanaryBaseline({ snapshot: clean, watcherHealth: healthyWatcher, candidate: realCandidate, nowMs });
    assert.equal(shared.eligible, true);
    assert.equal(shared.scope, SCOPE);
    assert.equal(shared.globalOrderHistoryReconciled, false);
    const runner = evaluateAccountTruthWatcherHealth(healthyWatcher, { phase: 'prearm', nowMs, snapshot: clean });
    assert.equal(runner.ok, shared.eligible);
    assert.equal(runner.scope, shared.scope);
    assert.equal(runner.globalOrderHistoryReconciled, false);

    const eligibleDir = path.join(root, 'eligible');
    const eligible = await runAdapterScenario(eligibleDir);
    assert.equal(eligible.result.decision, 'SUBMITTED');
    assert.equal(eligible.result.returnedOrderId, 'order-fixture-1');
    assert.equal(eligible.result.reconciliationState, STATES.FILLED);
    assert.equal(eligible.postCalls, 1);
    assert.equal(eligible.restoreCalls, 1);
    const finalSession = eligible.store.read();
    assert.equal(finalSession.state, STATES.LOCKOFF_RESTORED);
    assert.equal(finalSession.finalState, STATES.FILLED);
    assert.equal(finalSession.submissionAttempted, true);
    assert.match(finalSession.expectedSignedOrderIdentityHash, /^[a-f0-9]{64}$/);
    assert(!fs.readFileSync(path.join(eligibleDir, 'session.json'), 'utf8').includes('fixture-signature-never-real'));
    assert.equal(fs.statSync(path.join(eligibleDir, 'session.json')).mode & 0o777, 0o600);
    const duplicateInvocation = await eligible.adapter.handleIntent(eligible.adapterIntent, { mode: 'submit', fetchMetadata: true });
    assert.equal(duplicateInvocation.decision, 'REFUSED');
    assert(duplicateInvocation.reasons.includes('CANARY_SESSION_RECORD_ALREADY_EXISTS'));
    assert.equal(eligible.postCalls, 1, 'duplicate runner invocation must not submit again');
    assert.equal(eligible.restoreCalls, 1, 'lockoff restoration runs at most once');

    const policyFailures = [
      [snapshot(nowMs, { openOrders: { count: 1, records: [{ id: 'existing' }] } }), 'CANARY_BASELINE_OPEN_ORDERS_NOT_ZERO'],
      [snapshot(nowMs, { positions: { count: 1 }, totals: { liveExposureUsd: 1 } }), 'CANARY_BASELINE_EXPOSURE_NOT_CLEAN'],
      [snapshot(nowMs, { reconciliation: { dailyPnlReconciled: false, blockers: ['LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE', 'LIVE_ORDER_RATE_UNCERTAIN', 'LIVE_DAILY_PNL_UNCERTAIN'] } }), 'LIVE_DAILY_PNL_UNCERTAIN'],
      [snapshot(nowMs, { pnl: { coverageComplete: false } }), 'LIVE_DAILY_PNL_INPUTS_INCOMPLETE'],
      [snapshot(nowMs, { pnl: { redemptionsComplete: false } }), 'LIVE_DAILY_PNL_INPUTS_INCOMPLETE'],
      [snapshot(nowMs, { account: { identityMatches: false } }), 'LIVE_ACCOUNT_IDENTITY_UNCERTAIN'],
      [snapshot(nowMs - 31_000, { reconciliation: { fresh: false } }), 'LIVE_ACCOUNT_SNAPSHOT_STALE'],
    ];
    for (const [badSnapshot, blocker] of policyFailures) {
      const policy = evaluateSingleCanaryBaseline({ snapshot: badSnapshot, watcherHealth: healthyWatcher, candidate: realCandidate, nowMs });
      const runnerPolicy = evaluateAccountTruthWatcherHealth(healthyWatcher, { phase: 'prearm', nowMs, snapshot: badSnapshot, candidate: realCandidate });
      assert.equal(policy.eligible, false);
      assert(policy.blockers.includes(blocker), blocker);
      assert.equal(runnerPolicy.ok, policy.eligible, `runner/shared parity for ${blocker}`);
      assert.deepEqual(runnerPolicy.blockers, policy.blockers, `runner/shared blockers for ${blocker}`);
      const productionRefusal = await runAdapterScenario(path.join(root, `policy-refusal-${blocker.toLowerCase()}`), {
        intentOverrides: { singleCanaryBaseline: badSnapshot },
      });
      assert.equal(productionRefusal.result.decision, 'REFUSED', `production adapter refusal for ${blocker}`);
      assert(productionRefusal.result.reasons.includes(blocker), `production adapter blocker for ${blocker}`);
      assert.equal(productionRefusal.postCalls, 0);
      assert.equal(productionRefusal.restoreCalls, 1);
    }
    assert(evaluateSingleCanaryBaseline({ snapshot: clean, watcherHealth: watcherHealth(nowMs, { running: false }), candidate: realCandidate, nowMs }).blockers.includes('LIVE_ACCOUNT_TRUTH_WATCHER_NOT_RUNNING'));
    assert(evaluateSingleCanaryBaseline({ snapshot: clean, watcherHealth: watcherHealth(nowMs, { consecutiveFailures: 2 }), candidate: realCandidate, nowMs }).blockers.includes('LIVE_ACCOUNT_TRUTH_REFRESH_FAILURE'));
    assert(evaluateSingleCanaryBaseline({ snapshot: clean, watcherHealth: healthyWatcher, candidate: candidate(nowMs - 11_000), nowMs }).blockers.includes('CANARY_CANDIDATE_STALE'));
    for (const [name, baselineOverride, expectedBlocker] of [
      ['watcher-dead', { watcher: { running: false } }, 'LIVE_ACCOUNT_TRUTH_WATCHER_NOT_RUNNING'],
      ['watcher-failures', { watcher: { consecutiveFailures: 2 } }, 'LIVE_ACCOUNT_TRUTH_REFRESH_FAILURE'],
    ]) {
      const productionRefusal = await runAdapterScenario(path.join(root, name), { intentOverrides: { singleCanaryBaseline: snapshot(nowMs, baselineOverride) } });
      assert.equal(productionRefusal.result.decision, 'REFUSED');
      assert(productionRefusal.result.reasons.includes(expectedBlocker));
      assert.equal(productionRefusal.postCalls, 0);
    }
    const staleCandidateRefusal = await runAdapterScenario(path.join(root, 'stale-candidate'), { intentOverrides: { timestamp: new Date(nowMs - 11_000).toISOString() } });
    assert.equal(staleCandidateRefusal.result.decision, 'REFUSED');
    assert(staleCandidateRefusal.result.reasons.includes('CANARY_CANDIDATE_STALE'));
    assert.equal(staleCandidateRefusal.postCalls, 0);

    const activeStore = new CanarySessionStore({ sessionPath: path.join(root, 'active.json'), now: () => nowMs });
    activeStore.createArmEligible({ candidate: realCandidate, baselineSnapshot: clean, watcherHealth: healthyWatcher });
    const activePolicy = evaluateSingleCanaryBaseline({ snapshot: clean, watcherHealth: healthyWatcher, candidate: realCandidate, existingSession: activeStore.read(), nowMs });
    const activeRunnerPolicy = evaluateAccountTruthWatcherHealth(healthyWatcher, { phase: 'prearm', nowMs, snapshot: clean, candidate: realCandidate, existingSession: activeStore.read() });
    assert(activePolicy.blockers.includes('UNRESOLVED_PRIOR_CANARY_SESSION'));
    assert.deepEqual(activeRunnerPolicy.blockers, activePolicy.blockers, 'runner/shared unresolved-session parity');
    assert.throws(() => activeStore.markSubmissionAttempt({ candidate: { ...realCandidate, price: 0.75 }, signedOrder: {} }), /CANDIDATE_HASH_MISMATCH/);
    const interruptedBeforeSubmission = activeStore.recordLockoff({ restored: true });
    assert.equal(interruptedBeforeSubmission.state, STATES.LOCKOFF_RESTORED);
    assert.equal(interruptedBeforeSubmission.finalState, STATES.RECONCILIATION_FAILED);
    assert(interruptedBeforeSubmission.blockers.includes('CANARY_LOCKOFF_BEFORE_TERMINAL'));
    const mutatedAfterBaseline = await runAdapterScenario(path.join(root, 'mutated-after-baseline'), {
      mutateAfterBaseline: (liveIntent) => { liveIntent.price = 0.75; },
    });
    assert.equal(mutatedAfterBaseline.result.decision, 'REFUSED');
    assert(mutatedAfterBaseline.result.reasons.includes('CANARY_CANDIDATE_HASH_MISMATCH'));
    assert.equal(mutatedAfterBaseline.postCalls, 0);
    assert.equal(mutatedAfterBaseline.store.read().submissionAttempted, false);

    const timeout = await runAdapterScenario(path.join(root, 'timeout'), { postError: Object.assign(new Error('timeout after send'), { code: 'ETIMEDOUT' }) });
    assert.equal(timeout.result.decision, 'SUBMISSION_OUTCOME_UNKNOWN');
    assert.equal(timeout.postCalls, 1);
    assert.equal(timeout.result.safety.automaticRetryCount, 0);
    assert.equal(timeout.store.read().submissionAttempted, true);
    assert.equal(timeout.store.read().finalState, null);
    const retryBefore = timeout.postCalls;
    await assert.rejects(submitCanaryExactlyOnce({ store: timeout.store, candidate: timeout.adapterIntent, signedOrder: {}, postOrder: async () => { throw new Error('must not run'); } }), /SECOND_SUBMISSION_REFUSED|INVALID_STATE/);
    assert.equal(timeout.postCalls, retryBefore);
    const reset = await runAdapterScenario(path.join(root, 'reset'), { postError: Object.assign(new Error('reset after send'), { code: 'ECONNRESET' }) });
    assert.equal(reset.result.decision, 'SUBMISSION_OUTCOME_UNKNOWN');
    assert.equal(reset.postCalls, 1);
    const noId = await runAdapterScenario(path.join(root, 'missing-id'), { response: { success: true, status: 'accepted' } });
    assert.equal(noId.result.decision, 'SUBMISSION_OUTCOME_UNKNOWN');
    assert.equal(noId.postCalls, 1);

    const mismatchedId = await runAdapterScenario(path.join(root, 'id-mismatch'), { evidence: filledEvidence('wrong-id') });
    assert.equal(mismatchedId.result.decision, 'RECONCILIATION_FAILED');
    assert(mismatchedId.result.reasons.includes('CANARY_RETURNED_ORDER_ID_MISMATCH'));
    const unexpectedOrder = await runAdapterScenario(path.join(root, 'unexpected-order'), { evidence: filledEvidence('order-fixture-1', { openOrders: [{ id: 'other-order' }] }) });
    assert(unexpectedOrder.result.reasons.includes('CANARY_UNEXPECTED_ADDITIONAL_ORDER'));
    const disagreement = await runAdapterScenario(path.join(root, 'disagreement'), { evidence: filledEvidence('order-fixture-1', { trades: [{ id: 'trade-x', taker_order_id: 'order-fixture-1', size: '2', maker_orders: [] }] }) });
    assert(disagreement.result.reasons.includes('CANARY_RECONCILIATION_SOURCE_DISAGREEMENT'));
    const incompleteExactSource = await runAdapterScenario(path.join(root, 'incomplete-exact-source'), {
      evidence: filledEvidence('order-fixture-1', { sourceStatus: { trades: { coverageComplete: false } } }),
    });
    assert(incompleteExactSource.result.reasons.includes('CANARY_TRADE_SOURCE_INCOMPLETE'));
    const unexpectedPosition = await runAdapterScenario(path.join(root, 'unexpected-position'), {
      evidence: filledEvidence('order-fixture-1', { afterSnapshot: { positions: { records: [{ asset: 'unexpected-token', size: 5, conservativeExposureUsd: 3.7 }] } } }),
    });
    assert(unexpectedPosition.result.reasons.includes('CANARY_UNEXPECTED_POSITION_CHANGE'));
    const staleReconciliation = await runAdapterScenario(path.join(root, 'stale-reconciliation'), {
      evidence: filledEvidence('order-fixture-1', { afterSnapshot: { observedAt: new Date(Date.now() - 31_000).toISOString() } }),
    });
    assert(staleReconciliation.result.reasons.includes('CANARY_AFTER_SNAPSHOT_UNCERTAIN'));

    const identitySession = { ...finalSession, state: STATES.RECONCILING, returnedOrderId: 'order-fixture-1' };
    const variants = [
      ['token', { order: { asset_id: 'wrong-token' } }, 'CANARY_ORDER_TOKEN_MISMATCH'],
      ['side', { order: { side: 'SELL' } }, 'CANARY_ORDER_SIDE_MISMATCH'],
      ['price', { order: { price: '0.75' } }, 'CANARY_ORDER_PRICE_MISMATCH'],
      ['size', { order: { original_size: '6' } }, 'CANARY_ORDER_SIZE_MISMATCH'],
    ];
    for (const [, override, blocker] of variants) {
      const evidence = filledEvidence('order-fixture-1', override);
      const result = reconcileExactCanaryOrder({ session: identitySession, ...evidence });
      assert.equal(result.ok, false);
      assert(result.blockers.includes(blocker));
      const productionMismatch = await runAdapterScenario(path.join(root, `production-${blocker.toLowerCase()}`), { evidence });
      assert.equal(productionMismatch.result.decision, 'RECONCILIATION_FAILED');
      assert(productionMismatch.result.reasons.includes(blocker));
    }
    const statuses = [
      ['LIVE', '2', STATES.PARTIALLY_FILLED, [{ id: 'order-fixture-1' }]],
      ['REJECTED', '0', STATES.REJECTED, []],
      ['CANCELLED', '0', STATES.CANCELLED, []],
      ['EXPIRED', '0', STATES.EXPIRED, []],
    ];
    for (const [status, matched, expectedState, openOrders] of statuses) {
      const fill = Number(matched);
      const evidence = filledEvidence('order-fixture-1', {
        order: { status, size_matched: matched }, openOrders,
        trades: fill ? [{ id: `trade-${status}`, taker_order_id: 'order-fixture-1', size: matched, maker_orders: [] }] : [],
        afterSnapshot: snapshot(Date.now(), {
          positions: { count: fill ? 1 : 0, exposureUsd: fill * 0.74, records: fill ? [{ asset: TOKEN, size: fill, conservativeExposureUsd: fill * 0.74 }] : [] },
          openOrders: {
            count: openOrders.length,
            remainingBuyExposureUsd: status === 'LIVE' ? (5 - fill) * 0.74 : 0,
            records: openOrders,
          },
          collateral: { balanceUsd: 100 - fill * 0.74 },
          totals: { liveExposureUsd: status === 'LIVE' ? 3.7 : fill * 0.74 },
        }),
      });
      const result = reconcileExactCanaryOrder({ session: identitySession, ...evidence });
      assert.equal(result.ok, true, `${status}:${result.blockers}`);
      assert.equal(result.state, expectedState);
      const productionStatus = await runAdapterScenario(path.join(root, `production-status-${status.toLowerCase()}`), { evidence });
      assert.equal(productionStatus.result.reconciliationState, expectedState);
      assert.equal(productionStatus.postCalls, 1);
    }
    const absentUnknown = reconcileExactCanaryOrder({ session: identitySession, ...filledEvidence('order-fixture-1', { order: { status: 'UNKNOWN' }, openOrders: [] }) });
    assert(absentUnknown.blockers.includes('CANARY_ORDER_STATUS_UNKNOWN'), 'absence from open orders is not a terminal status');
    const productionAbsentUnknown = await runAdapterScenario(path.join(root, 'production-absent-unknown'), { evidence: filledEvidence('order-fixture-1', { order: { status: 'UNKNOWN' }, openOrders: [] }) });
    assert.equal(productionAbsentUnknown.result.decision, 'RECONCILIATION_FAILED');
    assert(productionAbsentUnknown.result.reasons.includes('CANARY_ORDER_STATUS_UNKNOWN'));

    const definitive = await runAdapterScenario(path.join(root, 'definitive'), { response: { success: false, errorMsg: 'rejected', status: 'rejected' } });
    assert.equal(definitive.result.decision, 'SUBMISSION_REJECTED');
    assert.equal(definitive.postCalls, 1);
    const restorationFailure = await runAdapterScenario(path.join(root, 'restore-fail'), { restore: false });
    assert.equal(restorationFailure.result.decision, 'RECONCILIATION_FAILED');
    assert(restorationFailure.result.reasons.includes('LOCKOFF_RESTORATION_FAILED'));
    assert.equal(restorationFailure.store.read().lockoffRestorationState, 'FAILED');

    for (const [signal, expected] of [['INT', 130], ['TERM', 143]]) {
      const signalDir = fs.mkdtempSync(path.join(os.tmpdir(), `stage5-signal-${signal.toLowerCase()}-`));
      const child = childProcess.spawnSync('bash', ['scripts/stage5_live_canary_once.sh', '--selfcheck-signal-handler', signal], {
        cwd: ROOT, env: { PATH: process.env.PATH, STAGE5_SIGNAL_FIXTURE_DIR: signalDir }, encoding: 'utf8', timeout: 5_000,
      });
      assert.equal(child.status, expected, `${signal} exit status: ${child.stderr}`);
      assert.deepEqual(fs.readFileSync(path.join(signalDir, 'restoration-calls'), 'utf8').trim().split(/\s+/), [String(expected)]);
      fs.rmSync(signalDir, { recursive: true, force: true });
    }

    assert.equal(forbiddenReads.length, 0, `forbidden env reads: ${forbiddenReads.join(',')}`);
    const after = Object.fromEntries(PROTECTED.map((file) => [file, fileState(file)]));
    assert.deepEqual(after, before, 'protected production files must remain unchanged');
    console.log('stage5 canary-session selfcheck: PASS (production router+adapter, atomic attempt-before-post, exact-order reconciliation, ambiguity no-retry, parity, signals, lockoff, protected files)');
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
