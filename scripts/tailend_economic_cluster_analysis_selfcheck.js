#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { analyze, clopperPearson, clusterIdentity } = require('./tailend_economic_cluster_analysis');

const near = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

function observation({ marketId, marketSlug, question, price, correct = null, pnl = null, capital = 4.99 }) {
  return {
    timestamp: '2026-08-11T23:50:00.000Z', marketId, marketSlug, question, outcome: 'No',
    endDate: '2026-08-12T04:00:00Z', timeToExpiryMs: 4 * 3_600_000, spread: 0.01,
    currentSignal: { confidence: 0.79 },
    entryEconomics: {
      ok: true, executablePrice: price, shares: 5, requiredCapitalUsd: capital,
      breakEvenProbability: price + 0.05 * price * (1 - price),
    },
    resolutionScore: correct === null ? null : { correct, netPnlUsd: pnl },
  };
}

const btcA = observation({ marketId: '1', marketSlug: 'will-bitcoin-reach-65k-on-august-11', question: 'Will Bitcoin reach $65,000 on August 11?', price: 0.99, correct: true, pnl: 0.01 });
const btcB = observation({ marketId: '2', marketSlug: 'will-bitcoin-dip-to-62k-on-august-11', question: 'Will Bitcoin dip to $62,000 on August 11?', price: 0.969, correct: true, pnl: 0.15, capital: 4.85 });
assert.equal(clusterIdentity(btcA).key, clusterIdentity(btcB).key);

const eth = observation({ marketId: '3', marketSlug: 'will-ethereum-reach-2000-on-august-11', question: 'Will Ethereum reach $2,000 on August 11?', price: 0.995, correct: true, pnl: 0.02 });
assert.notEqual(clusterIdentity(btcA).key, clusterIdentity(eth).key);

const fight = observation({ marketId: '4', marketSlug: 'ufc-jkrops-jon23-2026-08-11', question: 'Joe vs Jon', price: 0.998, correct: true, pnl: 0.01 });
const rounds = observation({ marketId: '5', marketSlug: 'ufc-jkrops-jon23-2026-08-11-totals-1pt5', question: 'O/U 1.5 Rounds', price: 0.999, correct: true, pnl: 0.005 });
assert.equal(clusterIdentity(fight).key, clusterIdentity(rounds).key);

const weatherA = observation({ marketId: '6', marketSlug: 'highest-temperature-in-tokyo-on-august-12-2026-30c', question: 'Will the highest temperature in Tokyo be 30°C on August 12?', price: 0.98 });
const weatherB = observation({ marketId: '7', marketSlug: 'highest-temperature-in-tokyo-on-august-12-2026-31c', question: 'Will the highest temperature in Tokyo be 31°C on August 12?', price: 0.98 });
const weatherLow = observation({ marketId: '8', marketSlug: 'lowest-temperature-in-tokyo-on-august-12-2026-20c', question: 'Will the lowest temperature in Tokyo be 20°C on August 12?', price: 0.98 });
assert.equal(clusterIdentity(weatherA).key, clusterIdentity(weatherB).key);
assert.notEqual(clusterIdentity(weatherA).key, clusterIdentity(weatherLow).key);

const unrelatedA = observation({ marketId: '9', marketSlug: 'alpha', question: 'Unrelated A?', price: 0.96 });
const unrelatedB = observation({ marketId: '10', marketSlug: 'beta', question: 'Unrelated B?', price: 0.96 });
assert.notEqual(clusterIdentity(unrelatedA).key, clusterIdentity(unrelatedB).key);

near(clopperPearson(10, 10).lower, 0.6915028921812392);
near(clopperPearson(3, 3).lower, Math.pow(0.025, 1 / 3));
near(clopperPearson(0, 1).upper, 0.975);

const result = analyze({
  updatedAt: '2026-08-12T04:30:00.000Z', reason: 'fixture',
  observations: [btcA, btcB, eth, fight, rounds, weatherA, weatherB, unrelatedA, unrelatedB],
});
assert.equal(result.summary.rawResolvedSignals, 5);
assert.equal(result.summary.independentResolvedClusters, 3);
assert.equal(result.summary.positiveResolvedClusters, 3);
assert.equal(result.priceRegimes['0.99+'].resolvedOpportunities, 4);
assert.equal(result.priceRegimes['0.99+'].independentResolvedClusters, 3);
assert.equal(result.lowerPricePnl.below097Resolved, 1);
assert.equal(result.nearOneFragility.stress[0].resultingRawWinRate, 0.8);
assert.equal(result.methodology.categoryNeverUsedAlone, true);

console.log(JSON.stringify({
  ok: true,
  checks: [
    'crypto_asset_window_clustering', 'sports_event_clustering', 'weather_measure_clustering',
    'unrelated_singleton_fallback', 'exact_clopper_pearson', 'signal_vs_cluster_counts',
    'price_regime_cluster_counts', 'near_one_loss_stress',
  ],
}));
