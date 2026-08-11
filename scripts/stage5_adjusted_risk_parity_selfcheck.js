#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CONFIG,
  BotEngine,
  PaperExecutionEngine,
  PaperPortfolio,
  RiskEngine,
  Signal,
} = require('../moneymaker_v3');

const ROOT = path.resolve(__dirname, '..');
const PROTECTED_FILES = [
  'auto_live_candidates.ndjson',
  'trade_intents.ndjson',
  'live_intent_router_events.ndjson',
  'live_adapter_events.ndjson',
  'live_execution_events.ndjson',
];

function fileState(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, size: null, sha256: null };
  const data = fs.readFileSync(filePath);
  return { exists: true, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

function protectedState() {
  return Object.fromEntries(PROTECTED_FILES.map((name) => [name, fileState(path.join(ROOT, name))]));
}

function makeConfig(tempDir, overrides = {}) {
  return {
    ...CONFIG,
    stateFile: path.join(tempDir, 'paper-state.json'),
    saveState: false,
    initialCash: 20,
    minOrderUsd: 0.5,
    minFillUsd: 0.01,
    minSignalEdge: 0,
    standardMinSignalEdge: 0,
    gabagoolMinExpectedEdge: 0,
    minConfidence: 0,
    gabagoolMinConfidence: 0,
    gabagoolMinConfidenceLive: 0,
    stage5CanaryGabagoolMinConfidence: 0.7,
    maxOpenOrders: 20,
    maxOpenOrdersPerTokenSideStrategy: 1,
    maxTotalOpenOrderUsd: 100,
    maxTotalExposureUsd: 100,
    maxMarketExposureUsd: 100,
    maxPositionUsdPerAsset: 100,
    maxDrawdownPct: 100,
    btcExposureBucketShare: 1,
    standardExposureBucketShare: 1,
    openOrderReplaceEnabled: false,
    dedupeOpenOrders: true,
    enableGabagoolBtcImitation: true,
    gabagoolMaxPaperOrderUsd: 2,
    paperActionBurnInEnabled: false,
    liveTradingStage: 5,
    liveStageProfile: undefined,
    liveCanaryMarketId: 'market-5',
    maxLiveOrderUsd: 5,
    maxLiveTotalExposureUsd: 5,
    liveDailyMaxLossUsd: 5,
    liveMaxOrdersPerHour: 1,
    autoLiveCandidatesEnabled: true,
    autoLiveCandidatesPath: path.join(tempDir, 'candidates.ndjson'),
    liveAccountTruthSnapshotPath: path.join(tempDir, 'account-truth.json'),
    liveAccountTruthTtlMs: 30_000,
    autoLiveAllowedStrategies: ['GabagoolBtcOracleStrategy'],
    autoLiveBlockedStrategies: [],
    autoLiveMinConfidence: 0.7,
    autoLiveMaxBookAgeMs: 1_500,
    autoLiveMinGhostFavorablePct: 0,
    autoLiveCandidateCooldownMs: 0,
    enableConsensus: false,
    ...overrides,
  };
}

function makeSignal(price = 0.74, sizeUsd = 2) {
  return new Signal({
    strategy: 'GabagoolBtcOracleStrategy',
    tokenId: 'token-up',
    marketId: 'market-5',
    side: 'buy',
    price,
    sizeUsd,
    expectedEdge: 0.1,
    confidence: 0.8,
    reason: 'fixture',
    ttlMs: 60_000,
    maxHoldMs: 60_000,
    metadata: { marketSlug: 'fixture-market', outcome: 'Up' },
  });
}

function makeBook(price = 0.74) {
  return {
    bestBid: Math.max(0.01, price - 0.01),
    bestAsk: price,
    midpoint: price - 0.005,
    spread: 0.01,
    bids: [[Math.max(0.01, price - 0.01), 20]],
    asks: [[price, 20]],
    cachedAt: Date.now() - 20,
    minOrderSize: 5,
  };
}

function makeHarness(tempDir, overrides = {}) {
  const config = makeConfig(tempDir, overrides);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(config.liveAccountTruthSnapshotPath, JSON.stringify({
    observedAt: new Date().toISOString(),
    account: { identityMatches: true },
    positions: { source: 'official_data_api_fixture_positions' },
    openOrders: { source: 'official_clob_authenticated_fixture_open_orders' },
    totals: { liveExposureUsd: 0, dailyRealizedPnlUsd: 0, ordersLastHour: 0 },
    reconciliation: { identityBoundExternalReconciliation: true, fresh: true, exposureReconciled: true, dailyPnlReconciled: true, orderCountReconciled: true, blockers: [] },
  }));
  const portfolio = new PaperPortfolio(config);
  const cache = { markPrices: () => new Map(), getBook: () => null };
  const risk = new RiskEngine(config, portfolio);
  const execution = new PaperExecutionEngine(config, portfolio, cache);
  const engine = Object.create(BotEngine.prototype);
  Object.assign(engine, {
    config,
    portfolio,
    cache,
    risk,
    execution,
    autoLiveCandidateLastWritten: new Map(),
    adjustedCandidateRiskApprovals: new WeakMap(),
    autoLiveSkipLogThrottle: new Map(),
    cycle: 1,
    lastAutoLiveCandidateBlocker: null,
    logAutoLiveCandidateSkip: () => {},
  });
  return engine;
}

function approvePaper(engine, signal) {
  const approved = engine.risk.evaluate(signal);
  assert(approved, `paper risk unexpectedly rejected: ${engine.risk.lastBlockReason}`);
  assert.strictEqual(approved.sizeUsd, 2, 'paper risk must approve the original $2 size');
  return approved;
}

function candidateRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function main() {
  const before = protectedState();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-adjusted-risk-'));
  try {
    const asset = { tokenId: 'token-up', outcome: 'Up', market: { marketId: 'market-5', slug: 'fixture-market', question: 'fixture?' } };
    const book = makeBook();

    const approvedEngine = makeHarness(path.join(tempDir, 'approved'));
    const signal = approvePaper(approvedEngine, makeSignal());
    const approval = approvedEngine.prepareAdjustedLiveCandidateRisk(signal, asset, book);
    assert(approval && approval.adjustedSizeRiskApproved === true);
    assert.strictEqual(approval.paperRiskApprovedSizeUsd, 2);
    assert(approval.adjustedCandidateSizeUsd >= 3.70);
    assert.strictEqual(approval.riskApprovedSizeUsd, approval.adjustedCandidateSizeUsd);
    assert.strictEqual(signal.sizeUsd, 2, 'isolated adjusted-risk evaluation must not mutate the paper signal');
    assert.strictEqual(approvedEngine.execution.place(signal, book), true, 'actual paper placement path must accept the original order');
    assert.strictEqual([...approvedEngine.portfolio.openOrders.values()][0].sizeUsd, 2, 'paper order must remain $2');
    signal._riskApproved = true;
    assert.strictEqual(approvedEngine.maybeWriteLiveCandidate(signal, asset, book), true, 'actual candidate writer must accept separately approved adjusted size');
    const [candidate] = candidateRows(approvedEngine.config.autoLiveCandidatesPath);
    assert(candidate, 'candidate writer did not append its temporary NDJSON record');
    assert.strictEqual(candidate.sizeUsd, approval.riskApprovedSizeUsd);
    assert.strictEqual(candidate.riskApprovedSizeUsd, candidate.sizeUsd);
    assert.strictEqual(candidate.paperRiskApprovedSizeUsd, 2);
    assert.strictEqual(candidate.adjustedSizeRiskApproved, true);
    assert.strictEqual(candidate.adjustedSizeRiskBlocker, null);

    const exposureEngine = makeHarness(path.join(tempDir, 'exposure-block'), { maxTotalExposureUsd: 3 });
    const exposureSignal = approvePaper(exposureEngine, makeSignal());
    const exposureApproval = exposureEngine.prepareAdjustedLiveCandidateRisk(exposureSignal, asset, book);
    assert.strictEqual(exposureApproval.adjustedSizeRiskApproved, false);
    assert.strictEqual(exposureApproval.adjustedSizeRiskBlocker, 'max_total_exposure');
    exposureSignal._riskApproved = true;
    assert.strictEqual(exposureEngine.maybeWriteLiveCandidate(exposureSignal, asset, book), false);
    assert.strictEqual(fs.existsSync(exposureEngine.config.autoLiveCandidatesPath), false);

    const cashEngine = makeHarness(path.join(tempDir, 'cash-block'), { initialCash: 3 });
    const cashSignal = approvePaper(cashEngine, makeSignal());
    const cashApproval = cashEngine.prepareAdjustedLiveCandidateRisk(cashSignal, asset, book);
    assert.strictEqual(cashApproval.adjustedSizeRiskApproved, false);
    assert.strictEqual(cashApproval.adjustedSizeRiskBlocker, 'cash_cap');

    const booleanOnlyEngine = makeHarness(path.join(tempDir, 'boolean-only'));
    const booleanOnlySignal = approvePaper(booleanOnlyEngine, makeSignal());
    booleanOnlySignal._riskApproved = true;
    assert.strictEqual(booleanOnlyEngine.maybeWriteLiveCandidate(booleanOnlySignal, asset, book), false);
    assert.strictEqual(booleanOnlyEngine.lastAutoLiveCandidateBlocker, 'adjusted_size_risk_unavailable');

    const stage4Engine = makeHarness(path.join(tempDir, 'stage4'), {
      liveTradingStage: 4,
      liveCanaryMarketId: '',
      maxLiveOrderUsd: 10,
      maxLiveTotalExposureUsd: 10,
    });
    const stage4Signal = approvePaper(stage4Engine, makeSignal(0.30));
    stage4Signal._riskApproved = true;
    assert.strictEqual(stage4Engine.maybeWriteLiveCandidate(stage4Signal, asset, makeBook(0.30)), true, 'non-Stage-5 writer behavior must not require adjusted-size approval');
    assert.strictEqual(candidateRows(stage4Engine.config.autoLiveCandidatesPath)[0].sizeUsd, 2);

    assert.deepStrictEqual(protectedState(), before, 'fixture changed a protected production event file');
    process.stdout.write('stage5 adjusted-size risk parity selfcheck: ok\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
