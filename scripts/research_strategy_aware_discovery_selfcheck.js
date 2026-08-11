'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const {
  CONFIG,
  ResearchEngine,
  buildStrategyAwareDiscoveryAssets,
  selectStrategyAwareAssets,
  tailEndDiscoveryOpportunity,
  complementArbDiscoveryOpportunity,
} = require('../moneymaker_v3.js');

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-11T21:00:00.000Z');

function market(id, hours, tokenIds = [`${id}-yes`, `${id}-no`]) {
  return {
    marketId: id,
    conditionId: `condition-${id}`,
    question: `Fixture ${id}`,
    endDate: new Date(NOW + hours * HOUR_MS).toISOString(),
    liquidity: 10_000,
    volume24h: 5_000,
    outcomes: tokenIds.map((tokenId, index) => ({ tokenId, outcome: index === 0 ? 'Yes' : 'No' })),
  };
}

function book(tokenId, bid, ask, { depthShares = 1_000, minOrderSize = 5, reported = true } = {}) {
  return {
    assetId: tokenId,
    market: `condition-${tokenId.split('-')[0]}`,
    bids: [{ price: bid, size: depthShares, side: 'bid' }],
    asks: [{ price: ask, size: depthShares, side: 'ask' }],
    bestBid: bid,
    bestAsk: ask,
    midpoint: (bid + ask) / 2,
    spread: ask - bid,
    minOrderSize,
    minOrderSizeReported: reported,
    negRisk: false,
    tickSize: 0.001,
    cachedAt: NOW,
  };
}

function asset(marketValue, index, bid, ask, options) {
  const outcome = marketValue.outcomes[index];
  const value = book(outcome.tokenId, bid, ask, options);
  return {
    assetKey: `${marketValue.marketId}:${outcome.tokenId}`,
    market: marketValue,
    outcome: outcome.outcome,
    tokenId: outcome.tokenId,
    book: value,
    conditionId: marketValue.conditionId,
    negRisk: false,
    score: 0,
  };
}

function config(overrides = {}) {
  return {
    ...CONFIG,
    strategyAwareDiscoveryEnabled: true,
    hunterMode: true,
    hunterMaxSpread: 0.24,
    hunterMinTopDepthUsd: 5,
    hunterMaxTopDepthUsd: 4_000,
    minBestBid: 0.02,
    maxBestAsk: 0.98,
    spreadHunterEnabled: false,
    complementArbEnabled: false,
    inventoryExitEnabled: false,
    tailEndEnabled: true,
    enableWhaleTracking: false,
    enableWhaleCopyStrategy: false,
    tailEndHours: 36,
    tailEndMinConfidence: 0.58,
    minSignalEdge: 0.02,
    slippageBuffer: 0.002,
    baseOrderUsd: 1,
    maxMarketExposureUsd: 3,
    ...overrides,
  };
}

async function run() {
  const tailMarket = market('tail', 1);
  const tailAssets = [
    // These pass TailEnd economics but intentionally fail the legacy Hunter
    // price filters which caused the measured starvation.
    asset(tailMarket, 0, 0.005, 0.020),
    asset(tailMarket, 1, 0.980, 0.995),
  ];
  for (const value of tailAssets) {
    assert(tailEndDiscoveryOpportunity(value, config(), NOW), 'TailEnd profile must accept its own eligible book');
  }

  const legacyScorer = new ResearchEngine({}, {}, config());
  assert.strictEqual(
    legacyScorer.scoreAsset(tailMarket, tailMarket.outcomes[0], tailAssets[0].book),
    null,
    'legacy Hunter filter must reject the low-price TailEnd fixture'
  );
  assert.strictEqual(
    legacyScorer.scoreAsset(tailMarket, tailMarket.outcomes[1], tailAssets[1].book),
    null,
    'legacy Hunter filter must reject the high-price TailEnd fixture'
  );

  const longMarket = market('legacy', 168);
  const legacyAssets = [
    asset(longMarket, 0, 0.40, 0.60),
    asset(longMarket, 1, 0.40, 0.60),
  ];
  const tailOnlyPool = buildStrategyAwareDiscoveryAssets([...tailAssets, ...legacyAssets], config(), null, NOW);
  assert.strictEqual(tailOnlyPool.length, 2, 'disabled SpreadHunter assets must not dominate the compatible pool');
  assert(tailOnlyPool.every((value) => value.discoveryStrategies.includes('TailEndMispricing')));
  const tailOnlySelection = selectStrategyAwareAssets(tailOnlyPool, 2);
  assert.deepStrictEqual(
    new Set(tailOnlySelection.selected.map((value) => value.tokenId)),
    new Set(tailMarket.outcomes.map((value) => value.tokenId)),
    'TailEnd-compatible market must survive selection atomically'
  );

  const soonMarket = market('soon', 1);
  const laterMarket = market('later', 12);
  const soonBook = book('soon-yes', 0.10, 0.15);
  const laterBook = book('later-yes', 0.10, 0.15);
  const spreadConfig = config({ spreadHunterEnabled: true, tailEndEnabled: false });
  const soonScore = legacyScorer.scoreAsset.call({ config: spreadConfig }, soonMarket, soonMarket.outcomes[0], soonBook).score;
  const laterScore = legacyScorer.scoreAsset.call({ config: spreadConfig }, laterMarket, laterMarket.outcomes[0], laterBook).score;
  assert(Math.abs((laterScore - soonScore) - 40) < 1e-9, 'ending-soon penalty must remain intact for SpreadHunter');

  const arbMarket = market('arb', 72);
  const arbAssets = [
    asset(arbMarket, 0, 0.47, 0.49),
    asset(arbMarket, 1, 0.47, 0.49),
  ];
  assert.strictEqual(
    complementArbDiscoveryOpportunity(arbAssets, config({ complementArbEnabled: true })),
    null,
    'venue-minimum-infeasible pair must not consume discovery slots'
  );
  const feasibleArb = complementArbDiscoveryOpportunity(
    arbAssets,
    config({ complementArbEnabled: true, baseOrderUsd: 10, maxMarketExposureUsd: 100 })
  );
  assert(feasibleArb && feasibleArb.shares >= 5, 'venue-minimum-feasible exact binary pair must qualify');

  const mixedConfig = config({
    complementArbEnabled: true,
    baseOrderUsd: 10,
    maxMarketExposureUsd: 100,
  });
  const mixedPool = buildStrategyAwareDiscoveryAssets([...tailAssets, ...arbAssets], mixedConfig, null, NOW);
  const mixedSelection = selectStrategyAwareAssets(mixedPool, 4);
  assert.strictEqual(mixedSelection.selected.length, 4, 'strategy-aware selector must fill the asset budget');
  assert(mixedSelection.selected.some((value) => value.discoveryStrategies.includes('ComplementArb')));
  assert(mixedSelection.selected.some((value) => value.discoveryStrategies.includes('TailEndMispricing')));

  const inventoryMarket = market('inventory', 168);
  const inventoryAsset = asset(inventoryMarket, 0, 0.40, 0.45);
  const inventoryPool = buildStrategyAwareDiscoveryAssets(
    [inventoryAsset],
    config({ tailEndEnabled: false, inventoryExitEnabled: true }),
    { position: (tokenId) => tokenId === inventoryAsset.tokenId ? 10 : 0 },
    NOW
  );
  assert.strictEqual(inventoryPool.length, 1, 'held inventory must be discoverable for exit evaluation');
  assert(inventoryPool[0].discoveryStrategies.includes('InventoryExit'));

  // Exercise the production discoverCandidates branch, not only its helpers.
  const integrationConfig = config({ maxMarkets: 2, maxOutcomesPerMarket: 2 });
  const books = new Map([...tailAssets, ...legacyAssets].map((value) => [value.tokenId, value.book]));
  const integrationCache = {
    selected: [],
    setBook() {},
    setCandidates(values) { this.selected = values; },
    getMarketFeeMetadata() { return null; },
    setMarketFeeMetadata() {},
  };
  const integrationPoly = {
    async fetchActiveEvents() { return [{}]; },
    extractTradableMarkets() { return [tailMarket, longMarket]; },
    async getOrderBook(tokenId) { return books.get(tokenId); },
    async fetchMarketFeeMetadata() { return null; },
  };
  const integrationResearch = new ResearchEngine(integrationPoly, integrationCache, integrationConfig);
  const originalDateNow = Date.now;
  let integrationSelected;
  try {
    // The fixture market is defined relative to NOW. Freeze the production
    // branch to that same instant so this selfcheck cannot expire at wall time.
    Date.now = () => NOW;
    integrationSelected = await integrationResearch.discoverCandidates();
  } finally {
    Date.now = originalDateNow;
  }
  assert.strictEqual(integrationSelected.length, 2, 'production discovery branch must respect its asset budget');
  assert(integrationSelected.every((value) => value.discoveryStrategies.includes('TailEndMispricing')));
  assert.deepStrictEqual(integrationCache.selected, integrationSelected, 'production discovery must publish the selected profile assets');

  console.log('research strategy-aware discovery selfcheck passed');
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
