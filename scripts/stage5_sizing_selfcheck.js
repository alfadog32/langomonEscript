#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const {
  computeMinimumViableLiveCandidateSize,
  evaluateAutoLiveCandidateGates,
} = require('../moneymaker_v3');

const NOW = 1_800_000;

function sizing(overrides = {}) {
  return computeMinimumViableLiveCandidateSize({
    proposedSizeUsd: 2,
    candidatePrice: 0.74,
    reportedMinimumShares: 5,
    stageProfileMaximumOrderUsd: 5,
    currentLiveExposure: 0,
    stageProfileMaximumTotalExposureUsd: 5,
    ...overrides,
  });
}

function config(stage = 5, overrides = {}) {
  return {
    liveTradingStage: stage,
    liveCanaryMarketId: 'market-5',
    maxLiveOrderUsd: stage === 5 ? 5 : 10,
    maxLiveTotalExposureUsd: stage === 5 ? 5 : 10,
    liveDailyMaxLossUsd: 5,
    liveMaxOrdersPerHour: 1,
    autoLiveCandidatesEnabled: true,
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

function input(overrides = {}) {
  const signal = {
    strategy: 'GabagoolBtcOracleStrategy',
    tokenId: 'token-up',
    marketId: 'market-5',
    side: 'buy',
    price: 0.74,
    sizeUsd: 2,
    confidence: 0.8,
    expectedEdge: 0.1,
    _riskApproved: true,
  };
  return {
    signal,
    asset: { market: { marketId: 'market-5', slug: 'fixture' }, outcome: 'Up' },
    book: { bestBid: 0.73, bestAsk: 0.74, midpoint: 0.735, spread: 0.01, bids: [[0.73, 20]], asks: [[0.74, 20]], cachedAt: NOW - 100, minOrderSize: 5 },
    config: config(),
    portfolio: { ghostStats: { total: 0, favorable: 0 } },
    currentLiveExposureUsd: 0,
    lastWrittenAt: 0,
    now: NOW,
    ...overrides,
  };
}

function main() {
  const resized = sizing();
  assert.strictEqual(resized.eligible, true);
  assert.strictEqual(resized.blocker, 'minimum_viable_size_supported');
  assert.strictEqual(resized.wasResized, true);
  assert(resized.minimumViableSizeUsd >= 3.70);
  assert(resized.adjustedShares >= 5);
  assert(Math.abs(resized.proposedShares - (2 / 0.74)) < 1e-12);

  const awkward = sizing({ proposedSizeUsd: 1, candidatePrice: 0.333333, reportedMinimumShares: 5 });
  assert(awkward.adjustedShares >= 5, 'upward USD rounding must never leave adjusted shares below five');

  const alreadyLarge = sizing({ candidatePrice: 0.30 });
  assert.strictEqual(alreadyLarge.adjustedLiveSizeUsd, 2);
  assert.strictEqual(alreadyLarge.wasResized, false);
  assert.strictEqual(alreadyLarge.blocker, 'original_size_already_supported');

  const reportedSix = sizing({ candidatePrice: 0.8, reportedMinimumShares: 6 });
  assert.strictEqual(reportedSix.effectiveMinimumShares, 6);
  assert(reportedSix.adjustedShares >= 6);

  const orderCap = sizing({ candidatePrice: 0.95, reportedMinimumShares: 6 });
  assert.strictEqual(orderCap.minimumViableSizeUsd, 5.7);
  assert.strictEqual(orderCap.blocker, 'minimum_viable_size_exceeds_order_cap');
  assert.strictEqual(orderCap.eligible, false);

  const exposureCap = sizing({ currentLiveExposure: 2 });
  assert.strictEqual(exposureCap.blocker, 'minimum_viable_size_exceeds_exposure_cap');

  assert.strictEqual(sizing({ candidatePrice: 0 }).blocker, 'invalid_price');
  assert.strictEqual(sizing({ proposedSizeUsd: 0 }).blocker, 'invalid_size_usd');
  assert.strictEqual(sizing({ reportedMinimumShares: 'bad' }).blocker, 'invalid_minimum_order_size');
  const missingMinimum = sizing({ reportedMinimumShares: null });
  assert.strictEqual(missingMinimum.effectiveMinimumShares, 5);
  assert.strictEqual(missingMinimum.minimumOrderSizePolicy, 'fallback_to_five');

  const stage5Input = input();
  const originalPaperSize = stage5Input.signal.sizeUsd;
  const stage5 = evaluateAutoLiveCandidateGates(stage5Input);
  assert.strictEqual(stage5.eligible, true);
  assert(stage5.sizeUsd >= 3.70);
  assert(stage5.sizeShares >= 5);
  assert.strictEqual(stage5.originalPaperSizeUsd, 2);
  assert.strictEqual(stage5Input.signal.sizeUsd, originalPaperSize, 'paper signal sizing must remain unchanged');

  const normal = evaluateAutoLiveCandidateGates(input({ config: config(4) }));
  assert.strictEqual(normal.eligible, false);
  assert.strictEqual(normal.blocker, 'size_below_min_order');

  const stage5OrderBlocked = evaluateAutoLiveCandidateGates(input({
    signal: { ...input().signal, price: 0.95 },
    book: { ...input().book, bestBid: 0.94, bestAsk: 0.95, midpoint: 0.945, minOrderSize: 6 },
  }));
  assert.strictEqual(stage5OrderBlocked.blocker, 'minimum_viable_size_exceeds_order_cap');

  const stage5ExposureBlocked = evaluateAutoLiveCandidateGates(input({ currentLiveExposureUsd: 2 }));
  assert.strictEqual(stage5ExposureBlocked.blocker, 'minimum_viable_size_exceeds_exposure_cap');

  process.stdout.write('stage5 sizing selfcheck: ok\n');
}

main();
