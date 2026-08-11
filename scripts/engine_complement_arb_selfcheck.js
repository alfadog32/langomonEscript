#!/usr/bin/env node
'use strict';

/**
 * Fixtures for pair-preserving discovery + executable ComplementArb economics.
 *
 * Fixture-only: no network, no PM2, no orders, no production state writes.
 * Proves the change TIGHTENS admission (depth, fees, min-order, coherence) and
 * only removes an artificial starvation in market selection.
 */

process.env.MM_SKIP_LOCAL_ENV_FILE = '1';

const assert = require('assert');
const { CONFIG, ComplementArbStrategy, VolatilityGuard, selectPairPreservingAssets, isCompleteBinaryComplementGroup } = require('../moneymaker_v3.js');

let passed = 0;
const queue = [];
// Checks may be async; they are queued and awaited sequentially so a failed
// assertion inside an async body cannot pass silently as an unhandled rejection.
function check(name, fn) { queue.push({ name, fn }); }

function ladder(top, levels, size, step, ascending) {
  return Array.from({ length: levels }, (_, i) => ({
    price: Number((ascending ? top + i * step : top - i * step).toFixed(4)),
    size,
  }));
}

function book(tokenId, { bid, ask, depthShares = 500, minOrderSize = 5, cachedAt = Date.now() } = {}) {
  const bids = ladder(bid, 10, depthShares, 0.01, false).filter((l) => l.price > 0);
  const asks = ladder(ask, 10, depthShares, 0.01, true).filter((l) => l.price < 1);
  return {
    assetId: tokenId, tokenId, market: 'M', timestamp: '',
    bids, asks, bestBid: bids[0].price, bestAsk: asks[0].price,
    midpoint: (bids[0].price + asks[0].price) / 2,
    spread: asks[0].price - bids[0].price,
    minOrderSize, minOrderSizeReported: true, negRisk: false,
    tickSize: 0.01, lastTradePrice: NaN, cachedAt,
  };
}

const BINARY_OUTCOMES = [{ tokenId: 'A', outcome: 'Yes' }, { tokenId: 'B', outcome: 'No' }];
function asset(tokenId, outcome, outcomes = BINARY_OUTCOMES, marketId = 'M') {
  return {
    assetKey: `${marketId}:${tokenId}`, tokenId, outcome, conditionId: 'COND',
    market: { marketId, question: 'q', liquidity: 50000, volume24h: 5000, outcomes, endDate: new Date(Date.now() + 86400000).toISOString() },
    score: 100, discoveredAt: Date.now(),
  };
}

function makeStrategy({ bookA, bookB, siblings, feeMeta }) {
  const cache = {
    getMarketAssets: () => siblings,
    getFreshBook: async (tokenId) => (String(tokenId) === 'A' ? bookA : bookB),
    getMarketFeeMetadata: () => (feeMeta === undefined
      ? { rate: 0.05, exponent: 1, takerOnly: true, conditionId: 'COND', source: 'official_clob_market_info', observedAtMs: Date.now() }
      : feeMeta),
  };
  const portfolio = { position: () => 0, positionUsd: () => 0, recordExecutionEvent: () => {} };
  const cfg = { ...CONFIG, complementArbEnabled: true, baseOrderUsd: 25, maxMarketExposureUsd: 350 };
  return new ComplementArbStrategy(cfg, cache, portfolio, new VolatilityGuard(cfg));
}

const A = asset('A', 'Yes');
const B = asset('B', 'No');
const SIBS = [A, B];

console.log('engine_complement_arb_selfcheck');

// --- pair-preserving discovery ---------------------------------------------
// Exercises the REAL production selector, not a mirror of it.
function select(scored, budget) {
  const r = selectPairPreservingAssets(scored, budget);
  return { selected: r.selected, complete: r.completeBinaryMarkets };
}
// Binary market shape: both outcomes carry the market's full 2-token outcome list.
function binaryMarket(marketId) {
  return [{ tokenId: `${marketId}:a`, outcome: 'Yes' }, { tokenId: `${marketId}:b`, outcome: 'No' }];
}
const scoredAsset = (marketId, tokenId, score) => ({
  market: { marketId, outcomes: binaryMarket(marketId) },
  tokenId: `${marketId}:${tokenId}`,
  score,
});

check('selection never admits a market half-complete', () => {
  // Old behaviour: flat sort + slice(0,3) would take M1a, M1b, M2a -> M2 orphaned.
  const scored = [
    scoredAsset('M1', 'a', 100), scoredAsset('M1', 'b', 99),
    scoredAsset('M2', 'a', 98), scoredAsset('M2', 'b', 10),
  ];
  const flat = scored.slice().sort((x, y) => y.score - x.score).slice(0, 3);
  const orphanFlat = flat.filter((x) => flat.filter((y) => y.market.marketId === x.market.marketId).length === 1);
  assert.strictEqual(orphanFlat.length, 1, 'old flat truncation orphans a sibling');

  const { selected } = select(scored, 3);
  for (const x of selected) {
    const siblings = selected.filter((y) => y.market.marketId === x.market.marketId).length;
    assert.strictEqual(siblings, 2, 'every selected market must be complete');
  }
  assert.strictEqual(selected.length, 2, 'budget is respected, partial market skipped');
});

check('selection respects the asset budget and does not inflate it', () => {
  const scored = [];
  for (let i = 0; i < 20; i += 1) { scored.push(scoredAsset(`M${i}`, 'a', 100 - i), scoredAsset(`M${i}`, 'b', 100 - i)); }
  const { selected, complete } = select(scored, 8);
  assert.strictEqual(selected.length, 8, 'budget honoured exactly');
  assert.strictEqual(complete, 4, '8 asset slots become 4 complete binary markets');
});

check('selection keeps the highest-scoring markets first', () => {
  const scored = [
    scoredAsset('LOW', 'a', 10), scoredAsset('LOW', 'b', 9),
    scoredAsset('HIGH', 'a', 100), scoredAsset('HIGH', 'b', 99),
  ];
  const { selected } = select(scored, 2);
  assert.deepStrictEqual([...new Set(selected.map((x) => x.market.marketId))], ['HIGH']);
});

check('a single-outcome market is still selectable', () => {
  const { selected } = select([scoredAsset('SOLO', 'a', 100)], 4);
  assert.strictEqual(selected.length, 1, 'non-binary/partial markets are not banned outright');
});

// --- ComplementArb executable economics -------------------------------------
async function generate(bookA, bookB, siblings = SIBS, feeMeta) {
  const s = makeStrategy({ bookA, bookB, siblings, feeMeta });
  return s.generate(A, bookA);
}

check('rejects a real overround (no arbitrage exists)', async () => {
  // ask 0.55 + 0.50 = 1.05 -> cost exceeds payout.
  const out = await generate(book('A', { bid: 0.50, ask: 0.55 }), book('B', { bid: 0.45, ask: 0.50 }));
  assert.deepStrictEqual(out, [], 'overround must never produce a signal');
});

check('rejects a top-of-book arb that dies after fees', async () => {
  // Top asks sum to 0.985 -> naive lockedEdge 0.015 > minEdge 0.012 (old code
  // would have emitted). Fees at rate 0.07 remove it.
  const out = await generate(book('A', { bid: 0.48, ask: 0.49 }), book('B', { bid: 0.48, ask: 0.495 }));
  assert.deepStrictEqual(out, [], 'fee-negative arb must fail closed');
});

check('rejects when displayed depth cannot fill the share count', async () => {
  const thinA = book('A', { bid: 0.20, ask: 0.21, depthShares: 0.5 });
  const out = await generate(thinA, book('B', { bid: 0.20, ask: 0.21 }));
  assert.deepStrictEqual(out, [], 'hidden liquidity must never be assumed');
});

check('rejects when the share count is below either leg minimum', async () => {
  const out = await generate(
    book('A', { bid: 0.48, ask: 0.49, minOrderSize: 100000 }),
    book('B', { bid: 0.48, ask: 0.49 })
  );
  assert.deepStrictEqual(out, [], 'min-order infeasible pair must fail closed');
});

check('rejects incoherent legs (stale or skewed observation times)', async () => {
  const now = Date.now();
  const stale = await generate(
    book('A', { bid: 0.20, ask: 0.21, cachedAt: now - 600_000 }),
    book('B', { bid: 0.20, ask: 0.21, cachedAt: now })
  );
  assert.deepStrictEqual(stale, [], 'a stale leg makes the locked edge fictional');
});

check('rejects a missing sibling and never guesses the other leg', async () => {
  const out = await generate(book('A', { bid: 0.2, ask: 0.21 }), book('B', { bid: 0.2, ask: 0.21 }), [A]);
  assert.deepStrictEqual(out, [], 'single-sibling market must fail closed');
});

check('fails closed when live fee metadata is absent', async () => {
  const deep = { bid: 0.09, ask: 0.10, depthShares: 100000 };
  const out = await generate(book('A', deep), book('B', deep), SIBS, null);
  assert.deepStrictEqual(out, [], 'absent fee metadata must never be treated as zero');
});

check('fails closed when fee metadata is not officially sourced', async () => {
  const deep = { bid: 0.09, ask: 0.10, depthShares: 100000 };
  const guessed = { rate: 0.07, exponent: 1, source: 'assumed_default', observedAtMs: Date.now() };
  const out = await generate(book('A', deep), book('B', deep), SIBS, guessed);
  assert.deepStrictEqual(out, [], 'a non-official fee source must not be accepted as authoritative');
});

check('uses the CURRENT market fee rate, not a hardcoded default', async () => {
  const deep = { bid: 0.09, ask: 0.10, depthShares: 100000 };
  const live = { rate: 0.05, exponent: 1, takerOnly: true, source: 'official_clob_market_info', observedAtMs: Date.now() };
  const out = await generate(book('A', deep), book('B', deep), SIBS, live);
  assert.strictEqual(out.length, 2);
  const econ = out[0].metadata.complementEconomics;
  assert.strictEqual(econ.feeRate, 0.05, 'fee rate must come from live metadata');
  assert.strictEqual(econ.feeSource, 'official_clob_market_info');
  // 0.05 differs from the 0.07 that had been hardcoded -> provenance is real.
  assert.notStrictEqual(econ.feeRate, 0.07);
});

check('fails closed on stale fee metadata', async () => {
  const deep = { bid: 0.09, ask: 0.10, depthShares: 100000 };
  const s = makeStrategy({ bookA: book('A', deep), bookB: book('B', deep), siblings: SIBS, feeMeta: undefined });
  // Real MarketCache returns null past maxAge; emulate that contract.
  s.cache.getMarketFeeMetadata = (id, maxAgeMs) => (maxAgeMs > 0 ? null : {});
  assert.deepStrictEqual(await s.generate(A, book('A', deep)), [], 'stale fee terms must fail closed');
});

check('fails closed when a leg minimum order size was not venue-reported', async () => {
  const deep = { bid: 0.09, ask: 0.10, depthShares: 100000 };
  const bA = book('A', deep); bA.minOrderSizeReported = false;
  const out = await generate(bA, book('B', deep));
  assert.deepStrictEqual(out, [], 'a defaulted minimum must never be treated as reported');
});

check('fails closed on negative-risk markets', async () => {
  const deep = { bid: 0.09, ask: 0.10, depthShares: 100000 };
  const bA = book('A', deep); bA.negRisk = true;
  const out = await generate(bA, book('B', deep));
  assert.deepStrictEqual(out, [], 'neg-risk settlement mechanics must fail closed');
});

// --- exact binary complement proof ------------------------------------------
check('group.length>=2 is NOT accepted as binary', () => {
  const three = [{ tokenId: 'A', outcome: 'X' }, { tokenId: 'B', outcome: 'Y' }, { tokenId: 'C', outcome: 'Z' }];
  const a = asset('A', 'X', three); const b = asset('B', 'Y', three);
  assert.strictEqual(isCompleteBinaryComplementGroup([a, b]), false, 'two legs of a 3-outcome market are not complements');
});

check('rejects duplicate, cross-market and oversized groups', () => {
  assert.strictEqual(isCompleteBinaryComplementGroup([asset('A', 'Yes'), asset('A', 'Yes')]), false, 'duplicate token');
  assert.strictEqual(isCompleteBinaryComplementGroup([asset('A', 'Yes'), asset('B', 'No', BINARY_OUTCOMES, 'OTHER')]), false, 'cross-market');
  assert.strictEqual(isCompleteBinaryComplementGroup([asset('A', 'Yes'), asset('B', 'No'), asset('A', 'Yes')]), false, 'three legs');
  assert.strictEqual(isCompleteBinaryComplementGroup([asset('A', 'Yes')]), false, 'single leg');
  const foreign = [{ tokenId: 'X', outcome: 'Yes' }, { tokenId: 'Y', outcome: 'No' }];
  assert.strictEqual(isCompleteBinaryComplementGroup([asset('A', 'Yes', foreign), asset('B', 'No', foreign)]), false, 'legs must be the market tokens');
  assert.strictEqual(isCompleteBinaryComplementGroup([asset('A', 'Yes'), asset('B', 'No')]), true, 'exact binary complement accepted');
});

check('ComplementArb refuses a non-binary market at strategy level', async () => {
  const three = [{ tokenId: 'A', outcome: 'X' }, { tokenId: 'B', outcome: 'Y' }, { tokenId: 'C', outcome: 'Z' }];
  const a3 = asset('A', 'X', three); const b3 = asset('B', 'Y', three);
  const deep = { bid: 0.09, ask: 0.10, depthShares: 100000 };
  const s = makeStrategy({ bookA: book('A', deep), bookB: book('B', deep), siblings: [a3, b3] });
  assert.deepStrictEqual(await s.generate(a3, book('A', deep)), [], 'non-binary market must fail closed');
});

check('selection counts only exact binary complements as complete', () => {
  const three = [{ tokenId: 'A', outcome: 'X' }, { tokenId: 'B', outcome: 'Y' }, { tokenId: 'C', outcome: 'Z' }];
  const nonBinary = [asset('A', 'X', three, 'M3'), asset('B', 'Y', three, 'M3')];
  const r = selectPairPreservingAssets(nonBinary, 8);
  assert.strictEqual(r.selected.length, 2, 'assets still usable by other strategies');
  assert.strictEqual(r.completeBinaryMarkets, 0, 'must not be counted as a complement pair');
});

check('admits only a genuine net-executable arbitrage, with equal shares', async () => {
  // Deep, cheap, wide-margin pair: asks 0.10 + 0.10 = 0.20 per share vs $1 payout.
  const bookA = book('A', { bid: 0.09, ask: 0.10, depthShares: 100000 });
  const bookB = book('B', { bid: 0.09, ask: 0.10, depthShares: 100000 });
  const out = await generate(bookA, bookB);
  assert.strictEqual(out.length, 2, 'a real arb emits both legs');
  const [legA, legB] = out;
  const econ = legA.metadata.complementEconomics;
  assert.ok(econ.netEdgePerShare >= CONFIG.complementArbMinEdge);
  assert.ok(econ.feesUsd > 0, 'fees must be charged, never zero');
  assert.ok(econ.executableAskSum >= econ.topAskSum - 1e-9, 'walked cost cannot beat top of book');
  assert.ok(econ.netEdgeUsd < econ.payoutUsd - econ.executableCostUsd, 'net edge must be after fees');
  // Equal-share sizing: both legs buy the same share count.
  assert.ok(Math.abs((legA.sizeUsd / legA.price) - (legB.sizeUsd / legB.price)) < 1e-6, 'legs must be equal-share');
  assert.strictEqual(legA.metadata.requiresBothLegs, true);
  assert.strictEqual(legA.metadata.pairId, legB.metadata.pairId, 'legs share a pair id');
  assert.ok(legA.price >= bookA.bestAsk, 'entry price is the depth-walked average, never better than top of book');
  // Equal-share combined payout: N shares of both binary outcomes pay exactly N.
  const sharesA = legA.sizeUsd / legA.price;
  assert.ok(Math.abs(econ.payoutUsd - econ.shares) < 1e-9, 'payout must equal the share count, i.e. $1 combined per share');
  assert.ok(Math.abs(sharesA - econ.shares) < 1e-6, 'leg share count must match the priced share count');
  assert.ok(Math.abs(econ.netEdgeUsd - (econ.payoutUsd - econ.executableCostUsd - econ.feesUsd)) < 1e-9, 'net edge identity');
});

check('emits once per market, not once per outcome', async () => {
  const s = makeStrategy({ bookA: book('A', { bid: 0.09, ask: 0.10, depthShares: 100000 }), bookB: book('B', { bid: 0.09, ask: 0.10, depthShares: 100000 }), siblings: SIBS });
  const fromB = await s.generate(B, book('B', { bid: 0.09, ask: 0.10 }));
  assert.deepStrictEqual(fromB, [], 'the second outcome must not duplicate the pair');
});

check('respects the disable flag', async () => {
  const s = makeStrategy({ bookA: book('A', { bid: 0.09, ask: 0.10 }), bookB: book('B', { bid: 0.09, ask: 0.10 }), siblings: SIBS });
  s.config = { ...s.config, complementArbEnabled: false };
  assert.deepStrictEqual(await s.generate(A, book('A', { bid: 0.09, ask: 0.10 })), []);
});

(async () => {
  for (const { name, fn } of queue) {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  }
  console.log(`\nPASS ${passed} checks`);
})().catch((e) => {
  console.error(`\nFAIL after ${passed} checks:`);
  console.error(e);
  process.exitCode = 1;
});
