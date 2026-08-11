#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { Signal } = require('../moneymaker_v3');
const {
  DEFAULT_POLICY,
  normalizeTraderEvent,
  aggregateTraderEvents,
  calculateWalletQuality,
  deriveIndependenceGroups,
  calculateConsensus,
  normalizeBook,
  calculateTakerFeeUsd,
  buildFollowerCandidate,
  classifyLeaderSell,
  evaluateExecutableMarkouts,
  toSophieSignalInput,
  makeTradeDedupeKey,
} = require('../lib/profitable_trader_consensus');
const { fetchPublicJson } = require('../lib/profitable_trader_readonly');
const { parseArgs } = require('./profitable_trader_shadow');

const NOW = 1_800_000_000_000;
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const TOKEN = '123456789';
const MARKET = `0x${'a'.repeat(64)}`;

function trade(wallet, overrides = {}) {
  return normalizeTraderEvent({
    proxyWallet: wallet,
    side: 'BUY',
    asset: TOKEN,
    conditionId: MARKET,
    size: 10,
    usdcSize: 5,
    price: 0.5,
    timestamp: Math.floor((NOW - 1_000) / 1000),
    transactionHash: `0x${wallet.slice(2, 10)}${String(overrides.sequence || 0).padStart(4, '0')}`,
    title: 'Will an event happen?',
    slug: 'will-an-event-happen',
    outcome: 'Yes',
    ...overrides,
  }, { wallet, detectionTimestampMs: overrides.detectionTimestampMs ?? NOW });
}

function closed(wallet, index, pnl) {
  return {
    proxyWallet: wallet,
    asset: `${TOKEN}${index}`,
    conditionId: `0x${index.toString(16).padStart(64, '0')}`,
    avgPrice: 0.45,
    totalBought: 100,
    realizedPnl: pnl,
    timestamp: Math.floor((NOW - (40 - index) * 86_400_000) / 1000),
    title: `Will event ${index % 12} happen?`,
    slug: `event-${index % 12}`,
    outcome: 'Yes',
  };
}

function repeatableQuality(wallet = A) {
  const pnls = Array.from({ length: 36 }, (_, index) => index % 4 === 0 ? -2 : 2.5);
  const events = Array.from({ length: 40 }, (_, index) => trade(wallet, {
    sequence: index,
    asset: `${TOKEN}${index % 12}`,
    conditionId: `0x${(index % 12).toString(16).padStart(64, '0')}`,
    timestamp: Math.floor((NOW - index * 60_000) / 1000),
    detectionTimestampMs: NOW - index * 60_000,
    usdcSize: 50 + (index % 5) * 10,
  }));
  return calculateWalletQuality({
    wallet,
    trades: events,
    closedPositions: pnls.map((pnl, index) => closed(wallet, index, pnl)),
    nowMs: NOW,
  });
}

function book(overrides = {}) {
  return normalizeBook({
    asset_id: TOKEN,
    market: MARKET,
    timestamp: String(NOW),
    bids: [{ price: '0.49', size: '100' }],
    asks: [{ price: '0.51', size: '100' }],
    min_order_size: '5',
    tick_size: '0.01',
    ...overrides,
  }, NOW);
}

async function main() {
  const parsed = parseArgs([
    '--priority-wallets', `${A},${B}`,
    '--observe-seconds', '21600',
    '--candidate-pool-size', '50',
    '--discovery-closed-limit', '100',
    '--closed-limit', '500',
    '--max-activity-age-minutes', '1440',
  ]);
  assert.deepStrictEqual(parsed.priorityWallets, [A, B]);
  assert.strictEqual(parsed.observeSeconds, 21_600);
  assert.strictEqual(parsed.candidatePoolSize, 50);
  assert.strictEqual(parsed.discoveryClosedLimit, 100);
  assert.strictEqual(parsed.maxActivityAgeMinutes, 1_440);
  const normalized = trade(A);
  assert(normalized, 'valid official activity must normalize');
  assert.strictEqual(normalized.latencyMs, 1_000);
  assert.strictEqual(normalized.makerTaker, 'UNKNOWN', 'REST activity must not invent maker/taker role');
  assert.strictEqual(normalized.side, 'BUY');
  assert.strictEqual(normalized.tokenId, TOKEN);
  assert.strictEqual(makeTradeDedupeKey(normalized), normalized.dedupeKey);
  const partial = trade(A, { size: 11, usdcSize: 5.5 });
  assert.notStrictEqual(partial.dedupeKey, normalized.dedupeKey, 'distinct partial fills must not be collapsed');
  const aggregated = aggregateTraderEvents([normalized, partial]);
  assert.strictEqual(aggregated.length, 1, 'same transaction/token partial fills must become one leader event');
  assert.strictEqual(aggregated[0].componentFillCount, 2);

  const qualityA = repeatableQuality(A);
  const qualityB = repeatableQuality(B);
  assert.strictEqual(qualityA.eligible, true, `repeatable wallet should qualify: ${qualityA.blockers.join(',')}`);
  assert(qualityA.profitFactor > 1);
  assert(qualityA.marketsTraded >= DEFAULT_POLICY.minMarkets);
  assert.strictEqual(qualityA.averageEntryPrice, 0.5);
  assert.strictEqual(qualityA.makerTrades, 0);
  assert.strictEqual(qualityA.takerTrades, 0);
  assert.strictEqual(qualityA.unknownLiquidityRoleTrades, 40);
  assert(Number.isFinite(qualityA.categoryStats.OTHER.qualityScore), 'category-specific quality must be inspectable');
  const qualityWithMarkouts = calculateWalletQuality({
    wallet: A,
    trades: Array.from({ length: 40 }, (_, index) => trade(A, { sequence: index + 800 })),
    closedPositions: Array.from({ length: 36 }, (_, index) => closed(A, index, index % 4 === 0 ? -2 : 2.5)),
    markouts: Array.from({ length: 6 }, (_, index) => ({
      netMarkoutPerShare5s: 0.001 + index / 10_000,
      netMarkoutPerShare15s: 0.002,
      netMarkoutPerShare30s: 0.003,
      netMarkoutPerShare60s: 0.004,
    })),
    nowMs: NOW,
  });
  assert.strictEqual(qualityWithMarkouts.markoutStats['5s'].sampleSize, 6);
  assert(qualityWithMarkouts.markoutStats['60s'].mean > 0);

  const jackpot = calculateWalletQuality({
    wallet: C,
    trades: Array.from({ length: 30 }, (_, index) => trade(C, { sequence: index, detectionTimestampMs: NOW - index * 1000 })),
    closedPositions: [100, ...Array.from({ length: 29 }, () => -0.1)].map((pnl, index) => closed(C, index, pnl)),
    nowMs: NOW,
  });
  assert.strictEqual(jackpot.eligible, false, 'one-off jackpot wallet must not qualify');
  assert(jackpot.blockers.includes('one_off_profit_concentration'));

  const bundledTrades = Array.from({ length: 40 }, (_, index) => trade(B, {
    sequence: index + 500,
    asset: `${TOKEN}${Math.floor(index / 10) % 2}`,
    conditionId: `0x${(index % 10).toString(16).padStart(64, '0')}`,
    timestamp: Math.floor((NOW - index * 30_000) / 1000),
    detectionTimestampMs: NOW - index * 30_000,
  }));
  const bundled = calculateWalletQuality({
    wallet: B,
    trades: bundledTrades,
    closedPositions: Array.from({ length: 36 }, (_, index) => closed(B, index, index % 4 === 0 ? -2 : 2.5)),
    nowMs: NOW,
  });
  assert.strictEqual(bundled.eligible, false, 'profitable multi-outcome portfolio construction must not authorize copying an isolated leg');
  assert(bundled.blockers.includes('portfolio_bundle_strategy_not_individually_copyable'));

  const correlatedA = Array.from({ length: 5 }, (_, index) => trade(A, { sequence: index, timestamp: (NOW - index * 5_000) / 1000, detectionTimestampMs: NOW - index * 5_000 }));
  const correlatedB = correlatedA.map((row) => ({ ...row, wallet: B, dedupeKey: `${row.dedupeKey}:b` }));
  const independentC = Array.from({ length: 5 }, (_, index) => trade(C, { sequence: index + 20, asset: `${TOKEN}9`, timestamp: (NOW - index * 7_000) / 1000, detectionTimestampMs: NOW - index * 7_000 }));
  const groups = deriveIndependenceGroups(new Map([[A, correlatedA], [B, correlatedB], [C, independentC]]));
  assert.strictEqual(groups[A], groups[B], 'mirrored wallets must share an independence group');
  assert.notStrictEqual(groups[A], groups[C]);

  const eventA = trade(A);
  const eventB = trade(B, { sequence: 99 });
  const consensus = calculateConsensus({
    events: [eventA, eventB],
    walletQualities: { [A]: qualityA, [B]: qualityB },
    independenceGroups: { [A]: 'same-controller', [B]: 'same-controller' },
    nowMs: NOW,
  });
  assert.strictEqual(consensus.independentLeaderCount, 1);
  assert.strictEqual(consensus.qualified, false, 'correlated wallets must not manufacture consensus');

  const independentConsensus = calculateConsensus({
    events: [eventA, eventB],
    walletQualities: { [A]: qualityA, [B]: qualityB },
    independenceGroups: { [A]: A, [B]: B },
    nowMs: NOW,
    policy: { minQualityScore: 0.50 },
  });
  assert.strictEqual(independentConsensus.independentLeaderCount, 2);
  assert.strictEqual(independentConsensus.qualified, true);
  assert(Number.isFinite(independentConsensus.leaders[0].categoryQuality));
  const unrelatedOlder = trade(C, {
    asset: 'unrelated-token',
    sequence: 101,
    detectionTimestampMs: NOW - 100,
  });
  const targetBoundConsensus = calculateConsensus({
    events: [unrelatedOlder, eventA, eventB],
    walletQualities: { [A]: qualityA, [B]: qualityB, [C]: repeatableQuality(C) },
    independenceGroups: { [A]: A, [B]: B, [C]: C },
    targetTokenId: TOKEN,
    targetSide: 'BUY',
    nowMs: NOW,
    policy: { minQualityScore: 0.50 },
  });
  assert.strictEqual(targetBoundConsensus.tokenId, TOKEN, 'consensus must bind to the candidate token, not an older rolling-window event');
  assert.strictEqual(targetBoundConsensus.independentLeaderCount, 2);
  const eliteSingleConsensus = calculateConsensus({
    events: [eventA],
    walletQualities: { [A]: { ...qualityA, eligible: true, qualityScore: 0.95, typicalTradeSizeUsd: 5 } },
    independenceGroups: { [A]: A },
    nowMs: NOW,
  });
  assert.strictEqual(eliteSingleConsensus.qualified, true, 'one genuinely elite fresh leader may qualify without pretending to be multi-wallet consensus');
  assert.strictEqual(eliteSingleConsensus.reason, 'qualified_elite_single_leader');

  const entryBook = book();
  const candidate = buildFollowerCandidate({
    event: eventA,
    walletQuality: qualityA,
    consensus: independentConsensus,
    book: entryBook,
    feeRate: 0.05,
    feeEvidence: 'fixture_official_clob_market_info',
    expectedMarkoutPrior: 0.04,
    btcOracleEvidence: { confirmed: true, lagScore: 0.02 },
    nowMs: NOW,
    policy: { minQualityScore: 0.50 },
  });
  assert.strictEqual(candidate.execution.averagePrice, 0.51, 'BUY must execute against ASK');
  assert.strictEqual(candidate.execution.paperRealistic, true);
  assert.strictEqual(candidate.execution.liveSubmittable, false, '$1 shadow size must remain distinct from exchange minimum');
  assert.strictEqual(candidate.qualified, true, candidate.blockReasons.join(','));
  assert.strictEqual(candidate.sophieInputs.btcOracleRole, 'additional_evidence_not_authority');
  const missingCategoryEvidence = buildFollowerCandidate({
    event: eventA,
    walletQuality: { ...qualityA, categoryStats: {} },
    consensus: independentConsensus,
    book: entryBook,
    expectedMarkoutPrior: 0.04,
    nowMs: NOW,
  });
  assert(missingCategoryEvidence.blockReasons.includes('insufficient_category_sample'));
  const nonCopyableLeader = buildFollowerCandidate({
    event: eventA,
    walletQuality: { ...qualityA, individualLegEntryCopyable: false },
    consensus: independentConsensus,
    book: entryBook,
    expectedMarkoutPrior: 0.04,
    nowMs: NOW,
  });
  assert(nonCopyableLeader.blockReasons.includes('individual_leg_copyability_not_proven'));
  const mismatchedConsensusCandidate = buildFollowerCandidate({
    event: eventA,
    walletQuality: qualityA,
    consensus: { ...independentConsensus, tokenId: 'wrong-token' },
    book: entryBook,
    expectedMarkoutPrior: 0.04,
    nowMs: NOW,
  });
  assert(mismatchedConsensusCandidate.blockReasons.includes('consensus_target_mismatch'));

  const stale = buildFollowerCandidate({
    event: { ...eventA, leaderTimestampMs: NOW - 60_000 },
    walletQuality: qualityA,
    consensus: independentConsensus,
    book: entryBook,
    expectedMarkoutPrior: 0.04,
    nowMs: NOW,
  });
  assert(stale.blockReasons.includes('leader_signal_stale'));
  const displaced = buildFollowerCandidate({
    event: { ...eventA, leaderPrice: 0.30 },
    walletQuality: qualityA,
    consensus: independentConsensus,
    book: entryBook,
    expectedMarkoutPrior: 0.30,
    nowMs: NOW,
  });
  assert(displaced.blockReasons.includes('absolute_price_displacement'));

  const noPrior = buildFollowerCandidate({
    event: eventA,
    walletQuality: qualityA,
    consensus: independentConsensus,
    book: entryBook,
    expectedMarkoutPrior: null,
    nowMs: NOW,
  });
  assert.strictEqual(noPrior.qualified, false, 'first collection must stay shadow-only without out-of-sample edge prior');
  assert(noPrior.blockReasons.includes('missing_out_of_sample_edge_prior'));

  const sellEvent = trade(A, { side: 'SELL', price: 0.55, size: 6, usdcSize: 3.3 });
  const sellWithoutPosition = buildFollowerCandidate({
    event: sellEvent,
    walletQuality: qualityA,
    consensus: independentConsensus,
    book: entryBook,
    expectedMarkoutPrior: 0.04,
    followerPositionShares: 0,
    nowMs: NOW,
  });
  assert(sellWithoutPosition.blockReasons.includes('sell_without_linked_follower_position'));
  const lifecycle = classifyLeaderSell({ sellEvent, knownLeaderSharesBefore: 10, knownLeaderAveragePrice: 0.50, followerPositionShares: 4 });
  assert.strictEqual(lifecycle.type, 'partial_profit_taking');
  assert.strictEqual(lifecycle.followerAction, 'reduce_only_sell_candidate');
  assert.strictEqual(lifecycle.followerSharesToSell, 4);

  const futureBooks = {
    5: book({ bids: [{ price: '0.52', size: '100' }] }),
    15: book({ bids: [{ price: '0.53', size: '100' }] }),
    30: book({ bids: [{ price: '0.50', size: '100' }] }),
    60: book({ bids: [{ price: '0.54', size: '100' }] }),
    120: book({ bids: [{ price: '0.55', size: '100' }] }),
    300: book({ bids: [{ price: '0.56', size: '100' }] }),
  };
  const markouts = evaluateExecutableMarkouts({ candidate, futureBooks, feeRate: 0 });
  assert.strictEqual(markouts.horizons['5s'].executableBid, 0.52, 'markout must use executable BID');
  assert(markouts.horizons['60s'].feeAdjustedPnlUsd > 0);
  assert(markouts.horizons['120s'].feeAdjustedPnlUsd > 0, 'two-minute executable BID markout must be retained');
  assert(markouts.horizons['300s'].feeAdjustedPnlUsd > 0, 'five-minute executable BID markout must be retained');
  assert(markouts.observedMfePerShare >= markouts.observedMaePerShare);
  assert(calculateTakerFeeUsd({ shares: 10, price: 0.5, feeRate: 0.05 }) > 0);
  assert(calculateTakerFeeUsd({ shares: 10, price: 0.5, feeRate: 0.05, feeExponent: 2 }) < calculateTakerFeeUsd({ shares: 10, price: 0.5, feeRate: 0.05, feeExponent: 1 }));

  const signalInput = toSophieSignalInput(candidate);
  const engineSignal = new Signal(signalInput);
  assert.strictEqual(engineSignal.strategy, 'ProfitableTraderConsensus');
  assert.strictEqual(engineSignal.metadata.profitableTraderConsensus.sophieInputs.mandatory, true);
  assert.strictEqual(engineSignal.metadata.profitableTraderConsensus.riskInputs.mandatory, true);

  let method = null;
  await fetchPublicJson('https://data-api.polymarket.com/activity?user=x', {
    fetchImpl: async (_url, options) => {
      method = options.method;
      return { ok: true, async json() { return []; } };
    },
  });
  assert.strictEqual(method, 'GET', 'data client must be read-only GET');
  let retryAttempts = 0;
  const retried = await fetchPublicJson('https://data-api.polymarket.com/activity?user=retry', {
    retryBaseMs: 1,
    fetchImpl: async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get() { return null; } },
          async text() { return 'rate limited'; },
        };
      }
      return { ok: true, async json() { return [{ recovered: true }]; } };
    },
  });
  assert.strictEqual(retryAttempts, 2, 'rate-limited public GET must retry within a bounded budget');
  assert.strictEqual(retried[0].recovered, true);
  await assert.rejects(
    () => fetchPublicJson('https://example.com/not-allowed', { fetchImpl: async () => ({ ok: true, async json() { return {}; } }) }),
    /read-only source refused/
  );

  process.stdout.write('profitable trader shadow selfcheck passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
