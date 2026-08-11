#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotEngine, evaluateAutoLiveCandidateGates } = require('../moneymaker_v3');
const { normalizeIntent, evaluateMetadataSafety } = require('../live_adapter_polymarket');

function makeConfig(candidatePath, stage = 5) {
  return {
    liveTradingStage: stage,
    liveCanaryMarketId: 'market-5',
    maxLiveOrderUsd: stage === 5 ? 5 : 10,
    maxLiveTotalExposureUsd: stage === 5 ? 5 : 10,
    liveDailyMaxLossUsd: 5,
    liveMaxOrdersPerHour: 1,
    autoLiveCandidatesEnabled: true,
    autoLiveCandidatesPath: candidatePath,
    autoLiveAllowedStrategies: ['GabagoolBtcOracleStrategy'],
    autoLiveBlockedStrategies: [],
    autoLiveMinConfidence: 0.7,
    autoLiveMaxBookAgeMs: 1_500,
    autoLiveMinGhostFavorablePct: 0,
    autoLiveCandidateCooldownMs: 0,
    enableConsensus: false,
  };
}

function makeInput(config, overrides = {}) {
  const now = Date.now();
  return {
    signal: {
      strategy: 'GabagoolBtcOracleStrategy', tokenId: 'token-up', marketId: 'market-5',
      side: 'buy', price: 0.74, sizeUsd: 2, confidence: 0.8, expectedEdge: 0.1,
      _riskApproved: true, metadata: { marketSlug: 'fixture', outcome: 'Up' },
      ...(overrides.signal || {}),
    },
    asset: { market: { marketId: 'market-5', slug: 'fixture', question: 'fixture?' }, outcome: 'Up' },
    book: {
      bestBid: 0.73, bestAsk: 0.74, midpoint: 0.735, spread: 0.01,
      bids: [[0.73, 20]], asks: [[0.74, 20]], cachedAt: now - 50, minOrderSize: 5,
      ...(overrides.book || {}),
    },
    config,
  };
}

function writerContext(config, currentLiveExposureUsd = 0) {
  return {
    config,
    portfolio: {
      ghostStats: { total: 0, favorable: 0 },
      closedPnl: 0,
      drawdownPct: () => 0,
    },
    cache: { markPrices: () => ({}) },
    currentLiveExposureUsd,
    currentLiveExposureSource: 'fixture_engine_maintained_unreconciled',
    currentLiveExposureReconciled: false,
    autoLiveCandidateLastWritten: new Map(),
    adjustedCandidateRiskApprovals: new WeakMap(),
    lastAutoLiveCandidateBlocker: null,
    autoLiveSkipLogThrottle: new Map(),
    cycle: 1,
    logAutoLiveCandidateSkip: () => {},
    currentLiveExposureSnapshot: () => ({
      value: currentLiveExposureUsd,
      source: 'fixture_authenticated_account_truth',
      authenticatedReconciliation: true,
    }),
  };
}

function seedAdjustedRiskApproval(context, signal, decision) {
  context.adjustedCandidateRiskApprovals.set(signal, {
    paperRiskApprovedSizeUsd: decision.originalPaperSizeUsd,
    adjustedCandidateSizeUsd: decision.sizeUsd,
    adjustedSizeRiskApproved: true,
    adjustedSizeRiskBlocker: null,
    riskApprovedSizeUsd: decision.sizeUsd,
  });
}

function evaluate(input, currentLiveExposureUsd = 0) {
  return evaluateAutoLiveCandidateGates({
    ...input,
    portfolio: { ghostStats: { total: 0, favorable: 0 } },
    currentLiveExposureUsd,
    lastWrittenAt: 0,
    now: Date.now(),
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-writer-parity-'));
  try {
    const candidatePath = path.join(tempDir, 'candidates.ndjson');
    const stage5Input = makeInput(makeConfig(candidatePath));
    const shared = evaluate(stage5Input);
    const context = writerContext(stage5Input.config);
    seedAdjustedRiskApproval(context, stage5Input.signal, shared);
    const written = BotEngine.prototype.maybeWriteLiveCandidate.call(context, stage5Input.signal, stage5Input.asset, stage5Input.book);
    assert.strictEqual(written, shared.eligible);
    const row = JSON.parse(fs.readFileSync(candidatePath, 'utf8').trim());
    assert.strictEqual(row.sizeUsd, shared.sizeUsd);
    assert.strictEqual(row.sizeShares, shared.sizeShares);
    assert.strictEqual(row.originalPaperSizeUsd, 2);
    assert.deepStrictEqual(row.metadata.stage5Sizing, shared.sizing);
    assert(row.sizeShares >= 5);
    const adapterIntent = normalizeIntent(row);
    const adapterMetadata = await evaluateMetadataSafety({
      getOrderBook: async () => ({
        bids: [{ price: 0.73, size: 20 }],
        asks: [{ price: 0.74, size: 20 }],
        tick_size: '0.01',
        min_order_size: 5,
      }),
    }, adapterIntent, { liveMaxBookAgeMs: 1_500, liveMaxSpread: 0.2 });
    assert.strictEqual(adapterMetadata.reasons.includes('SIZE_BELOW_MIN_ORDER'), false, 'adapter must accept the writer adjusted share count');

    const blockedPath = path.join(tempDir, 'blocked.ndjson');
    const blockedInput = makeInput(makeConfig(blockedPath), {
      signal: { price: 0.95 },
      book: { bestBid: 0.94, bestAsk: 0.95, midpoint: 0.945, minOrderSize: 6 },
    });
    const sharedBlocked = evaluate(blockedInput);
    const blockedContext = writerContext(blockedInput.config);
    const blockedWritten = BotEngine.prototype.maybeWriteLiveCandidate.call(blockedContext, blockedInput.signal, blockedInput.asset, blockedInput.book);
    assert.strictEqual(blockedWritten, false);
    assert.strictEqual(blockedContext.lastAutoLiveCandidateBlocker, sharedBlocked.blocker);
    assert.strictEqual(sharedBlocked.blocker, 'minimum_viable_size_exceeds_order_cap');
    assert.strictEqual(fs.existsSync(blockedPath), false);

    const exposurePath = path.join(tempDir, 'exposure.ndjson');
    const exposureInput = makeInput(makeConfig(exposurePath));
    const sharedExposure = evaluate(exposureInput, 2);
    const exposureContext = writerContext(exposureInput.config, 2);
    const exposureWritten = BotEngine.prototype.maybeWriteLiveCandidate.call(exposureContext, exposureInput.signal, exposureInput.asset, exposureInput.book);
    assert.strictEqual(exposureWritten, false);
    assert.strictEqual(exposureContext.lastAutoLiveCandidateBlocker, sharedExposure.blocker);
    assert.strictEqual(sharedExposure.blocker, 'minimum_viable_size_exceeds_exposure_cap');

    const normalPath = path.join(tempDir, 'normal.ndjson');
    const normalInput = makeInput(makeConfig(normalPath, 4));
    const sharedNormal = evaluate(normalInput);
    const normalContext = writerContext(normalInput.config);
    const normalWritten = BotEngine.prototype.maybeWriteLiveCandidate.call(normalContext, normalInput.signal, normalInput.asset, normalInput.book);
    assert.strictEqual(normalWritten, false);
    assert.strictEqual(normalContext.lastAutoLiveCandidateBlocker, sharedNormal.blocker);
    assert.strictEqual(sharedNormal.blocker, 'size_below_min_order');

    process.stdout.write('stage5 writer/shared-evaluator parity selfcheck: ok\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
