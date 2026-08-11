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
  PaperPortfolio,
  RiskEngine,
  Signal,
} = require('../moneymaker_v3');
const { normalizeCandidate, toLiveAdapterIntent } = require('../live_intent_router');
const {
  normalizeIntent,
  buildPolymarketUserOrder,
  evaluateStaticSafety,
  readConfig: readAdapterConfig,
} = require('../live_adapter_polymarket');

const ROOT = path.resolve(__dirname, '..');
const PROTECTED_FILES = [
  'auto_live_candidates.ndjson',
  'trade_intents.ndjson',
  'live_intent_router_events.ndjson',
  'live_adapter_events.ndjson',
  'live_execution_events.ndjson',
];

function state(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, size: null, sha256: null };
  const data = fs.readFileSync(filePath);
  return { exists: true, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

function protectedState() {
  return Object.fromEntries(PROTECTED_FILES.map((name) => [name, state(path.join(ROOT, name))]));
}

function configFor(tempDir, candidatePath) {
  return {
    ...CONFIG,
    stateFile: path.join(tempDir, 'unused-paper-state.json'),
    saveState: false,
    initialCash: 20,
    minOrderUsd: 0.5,
    minSignalEdge: 0,
    standardMinSignalEdge: 0,
    gabagoolMinExpectedEdge: 0,
    minConfidence: 0,
    gabagoolMinConfidence: 0,
    maxOpenOrders: 20,
    maxTotalOpenOrderUsd: 100,
    maxTotalExposureUsd: 100,
    maxMarketExposureUsd: 100,
    maxPositionUsdPerAsset: 100,
    maxDrawdownPct: 100,
    btcExposureBucketShare: 1,
    standardExposureBucketShare: 1,
    openOrderReplaceEnabled: false,
    paperActionBurnInEnabled: false,
    liveTradingStage: 5,
    liveStageProfile: undefined,
    liveCanaryMarketId: 'market-5',
    maxLiveOrderUsd: 5,
    maxLiveTotalExposureUsd: 5,
    liveDailyMaxLossUsd: 5,
    liveMaxOrdersPerHour: 1,
    autoLiveCandidatesEnabled: true,
    autoLiveCandidatesPath: candidatePath,
    liveAccountTruthSnapshotPath: path.join(tempDir, 'account-truth.json'),
    liveAccountTruthTtlMs: 30_000,
    autoLiveAllowedStrategies: ['GabagoolBtcOracleStrategy'],
    autoLiveBlockedStrategies: [],
    autoLiveMinConfidence: 0.7,
    autoLiveMaxBookAgeMs: 1_500,
    autoLiveMinGhostFavorablePct: 0,
    autoLiveCandidateCooldownMs: 0,
    enableConsensus: false,
  };
}

function runCase(tempDir, price, index) {
  const candidatePath = path.join(tempDir, `candidate-${index}.ndjson`);
  const config = configFor(tempDir, candidatePath);
  fs.writeFileSync(config.liveAccountTruthSnapshotPath, JSON.stringify({
    observedAt: new Date().toISOString(), account: { identityMatches: true },
    positions: { source: 'official_data_api_fixture_positions' }, openOrders: { source: 'official_clob_authenticated_fixture_open_orders' },
    totals: { liveExposureUsd: 0, dailyRealizedPnlUsd: 0, ordersLastHour: 0 },
    reconciliation: { identityBoundExternalReconciliation: true, fresh: true, exposureReconciled: true, dailyPnlReconciled: true, orderCountReconciled: true, blockers: [] },
  }));
  const portfolio = new PaperPortfolio(config);
  const risk = new RiskEngine(config, portfolio);
  const engine = Object.create(BotEngine.prototype);
  Object.assign(engine, {
    config,
    portfolio,
    risk,
    cache: { markPrices: () => new Map() },
    autoLiveCandidateLastWritten: new Map(),
    adjustedCandidateRiskApprovals: new WeakMap(),
    autoLiveSkipLogThrottle: new Map(),
    lastAutoLiveCandidateBlocker: null,
    cycle: 1,
    logAutoLiveCandidateSkip: () => {},
  });
  const signal = new Signal({
    strategy: 'GabagoolBtcOracleStrategy', tokenId: `token-${index}`, marketId: 'market-5',
    side: 'buy', price, sizeUsd: 2, expectedEdge: 0.1, confidence: 0.8,
    reason: 'quantization fixture', ttlMs: 60_000, maxHoldMs: 60_000,
    metadata: { marketSlug: 'fixture-market', outcome: 'Up' },
  });
  const asset = { tokenId: signal.tokenId, outcome: 'Up', market: { marketId: 'market-5', slug: 'fixture-market', question: 'fixture?' } };
  const book = {
    bestBid: Math.max(0.01, price - 0.01), bestAsk: price, midpoint: price - 0.005, spread: 0.01,
    bids: [[Math.max(0.01, price - 0.01), 20]], asks: [[price, 20]], cachedAt: Date.now() - 10,
    minOrderSize: 5,
  };

  const paperApproved = risk.evaluate(signal);
  assert(paperApproved, `paper risk rejected price ${price}: ${risk.lastBlockReason}`);
  assert.strictEqual(signal.sizeUsd, 2);
  const adjustedRisk = engine.prepareAdjustedLiveCandidateRisk(signal, asset, book);
  assert(adjustedRisk?.adjustedSizeRiskApproved, `adjusted risk rejected price ${price}: ${adjustedRisk?.adjustedSizeRiskBlocker}`);
  signal._riskApproved = true;
  assert.strictEqual(engine.maybeWriteLiveCandidate(signal, asset, book), true);

  const row = JSON.parse(fs.readFileSync(candidatePath, 'utf8').trim());
  const routedCandidate = normalizeCandidate(row, candidatePath);
  const routedIntent = toLiveAdapterIntent(routedCandidate);
  const adapterIntent = normalizeIntent(routedIntent);
  const userOrder = buildPolymarketUserOrder(adapterIntent, 'BUY');
  const finalNotionalUsd = userOrder.price * userOrder.size;
  const safetyConfig = readAdapterConfig(tempDir);
  safetyConfig.liveStageProfile = {
    stage: 5,
    name: 'min_viable_canary',
    submitAllowed: true,
    maxLiveOrderUsd: 5,
    maxLiveTotalExposureUsd: 5,
    liveDailyMaxLossUsd: 5,
    maxOrdersPerHour: 1,
    singleMarketOnly: true,
    singleMarketId: 'market-5',
  };
  const staticSafety = evaluateStaticSafety(safetyConfig, adapterIntent, { mode: 'submit' });

  assert.strictEqual(row.sizeUsd, row.riskApprovedSizeUsd, 'candidate size must equal adjusted-risk-approved size');
  assert.strictEqual(adapterIntent.sizeUsd, row.sizeUsd, 'router/adapter must preserve candidate USD size');
  assert.strictEqual(adapterIntent.sizeShares, row.sizeShares, 'router/adapter must preserve candidate shares');
  assert.strictEqual(userOrder.size, row.sizeShares, 'local CLOB order construction must preserve upward-safe shares');
  assert.strictEqual(adapterIntent.currentLiveExposureSource, 'official_data_api_fixture_positions + official_clob_authenticated_fixture_open_orders');
  assert.strictEqual(adapterIntent.currentLiveExposureAuthenticatedReconciliation, true);
  assert(!staticSafety.reasons.some((reason) => ['LIVE_ACCOUNT_IDENTITY_UNCERTAIN', 'LIVE_ACCOUNT_SNAPSHOT_STALE', 'LIVE_EXPOSURE_UNCERTAIN', 'LIVE_DAILY_PNL_UNCERTAIN', 'LIVE_ORDER_RATE_UNCERTAIN'].includes(reason)), 'complete fixture truth must pass adapter account gates');
  assert(userOrder.size + 1e-9 >= 5, `price ${price} rounded below five shares`);
  assert(finalNotionalUsd <= 5 + 1e-9, `price ${price} exceeded the Stage 5 $5 cap`);
  assert(Math.abs(finalNotionalUsd - row.sizeUsd) <= 1e-9, `price ${price} produced inconsistent USD/share amounts`);
  assert.strictEqual(signal.sizeUsd, 2, 'adapter path must not alter the original paper signal');
  return { price, sizeUsd: row.sizeUsd, sizeShares: row.sizeShares, finalNotionalUsd };
}

function main() {
  const before = protectedState();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-adapter-quantization-'));
  try {
    const results = [0.74, 0.333333, 0.666667, 0.99].map((price, index) => runCase(tempDir, price, index));
    const canonical = results[0];
    assert(canonical.sizeUsd >= 3.70 && canonical.sizeUsd <= 5);
    assert(canonical.sizeShares >= 5);
    assert.deepStrictEqual(protectedState(), before, 'quantization fixture modified a protected production event file');
    process.stdout.write(`stage5 adapter quantization/no-submit selfcheck: ok ${JSON.stringify(results)}\n`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
