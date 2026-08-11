'use strict';

// Public-GET-only shadow audit. It never starts BotEngine, writes state, reads
// local environment files, or submits orders.
process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const {
  CONFIG,
  ResearchEngine,
  buildStrategyAwareDiscoveryAssets,
  selectStrategyAwareAssets,
  selectPairPreservingAssets,
  isCompleteBinaryComplementGroup,
  isBookComplete,
  topDepthUsd,
} = require('../moneymaker_v3.js');

const HOUR_MS = 60 * 60 * 1000;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isMarketTradable(market) {
  const enableOrderBook = [market.enableOrderBook, market.enable_order_book]
    .some((value) => value === true || value === 'true');
  return market.active !== false && market.closed !== true && market.archived !== true && enableOrderBook;
}

function extractTradableMarkets(events, config) {
  const markets = [];
  for (const event of events) {
    const eventTitle = event.title || event.question || event.slug || `event:${event.id || 'unknown'}`;
    for (const market of Array.isArray(event.markets) ? event.markets : []) {
      if (!isMarketTradable(market)) continue;
      const outcomes = parseArray(market.outcomes);
      const tokenIds = parseArray(market.clobTokenIds || market.clob_token_ids || market.tokenIds);
      const outcomePrices = parseArray(market.outcomePrices || market.outcome_prices);
      if (!Array.isArray(tokenIds) || tokenIds.length === 0) continue;
      const liquidity = firstFinite(
        market.liquidityNum, market.liquidity_num, market.liquidity, market.orderBookLiquidity
      );
      const volume24h = firstFinite(
        market.volume24hr, market.volume_24hr, market.volume24h, market.volume_24h,
        market.volumeNum, market.volume
      );
      if (liquidity < config.minLiquidity || volume24h < config.minVolume24h) continue;
      markets.push({
        marketId: String(market.id || market.conditionId || market.condition_id || ''),
        conditionId: String(market.conditionId || market.condition_id || ''),
        question: market.question || market.title || eventTitle,
        marketSlug: market.slug || '',
        eventTitle,
        eventSlug: event.slug || '',
        category: event.category || market.category || '',
        endDate: market.endDate || market.end_date_iso || market.endDateIso || event.endDate || event.end_date_iso || '',
        liquidity,
        volume24h,
        competitive: Boolean(market.competitive),
        restricted: Boolean(market.restricted || event.restricted),
        outcomes: tokenIds.map((tokenId, index) => ({
          tokenId: String(tokenId),
          outcome: String(outcomes?.[index] || `Outcome ${index + 1}`),
          indicativePrice: number(outcomePrices?.[index], NaN),
        })),
      });
    }
  }
  return markets;
}

function normalizeLevels(levels, side) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: number(level.price, NaN), size: number(level.size, NaN), side }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    .sort((a, b) => side === 'bid' ? b.price - a.price : a.price - b.price);
}

function normalizeBook(raw, tokenId) {
  const bids = normalizeLevels(raw?.bids, 'bid');
  const asks = normalizeLevels(raw?.asks, 'ask');
  const bestBid = bids[0]?.price ?? number(raw?.best_bid ?? raw?.bestBid, NaN);
  const bestAsk = asks[0]?.price ?? number(raw?.best_ask ?? raw?.bestAsk, NaN);
  return {
    assetId: String(raw?.asset_id || raw?.assetId || tokenId),
    market: String(raw?.market || ''),
    bids,
    asks,
    bestBid: Number.isFinite(bestBid) ? bestBid : null,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
    midpoint: Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : null,
    spread: Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? bestAsk - bestBid : null,
    minOrderSize: number(raw?.min_order_size ?? raw?.minOrderSize, 5),
    minOrderSizeReported: Number.isFinite(number(raw?.min_order_size ?? raw?.minOrderSize, NaN)),
    negRisk: raw?.neg_risk === true || raw?.negRisk === true,
    tickSize: number(raw?.tick_size ?? raw?.tickSize, 0.01),
    cachedAt: Date.now(),
  };
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'langomon-discovery-alignment-shadow/1.0' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchEvents(config) {
  const events = [];
  for (let page = 0; page < config.eventPages; page += 1) {
    const url = new URL('/events', config.gammaBaseUrl);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    // Keep the public shadow on the same proven Gamma contract as production.
    url.searchParams.set('order', 'volume24hr');
    url.searchParams.set('ascending', 'false');
    url.searchParams.set('limit', String(config.eventLimit));
    url.searchParams.set('offset', String(page * config.eventLimit));
    const pageEvents = await getJson(url);
    if (!Array.isArray(pageEvents)) throw new Error('Gamma /events did not return an array');
    events.push(...pageEvents);
  }
  return events;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, run));
  return results;
}

function hoursUntil(endDate, now) {
  const end = Date.parse(endDate);
  return Number.isFinite(end) ? (end - now) / HOUR_MS : NaN;
}

function endingSoonPenalty(endDate, now) {
  const hours = hoursUntil(endDate, now);
  if (!Number.isFinite(hours)) return 0;
  if (hours < 2) return 40;
  if (hours < 8) return 15;
  return 0;
}

function tailEligibility(entry, config, now) {
  const { book, market } = entry;
  if (!isBookComplete(book)) return { eligible: false, reason: 'incomplete_book' };
  const hours = hoursUntil(market.endDate, now);
  if (!Number.isFinite(hours)) return { eligible: false, reason: 'missing_end_date' };
  if (hours <= 0 || hours > config.tailEndHours) return { eligible: false, reason: 'outside_tail_window', hours };
  const confidence = Math.abs(book.midpoint - 0.5) * 1.6;
  if (confidence < config.tailEndMinConfidence) {
    return { eligible: false, reason: 'tail_confidence_below_min', hours, confidence };
  }
  if (book.spread > 0.08) return { eligible: false, reason: 'tail_spread_too_wide', hours, confidence };
  const edge = Math.abs(book.midpoint - 0.5) - book.spread - config.slippageBuffer;
  if (edge < config.minSignalEdge) {
    return { eligible: false, reason: 'tail_edge_below_min', hours, confidence, edge };
  }
  return {
    eligible: true,
    hours,
    confidence,
    edge,
    sideWithoutInventory: book.midpoint > 0.5 ? 'buy' : 'sell',
    penalty: endingSoonPenalty(market.endDate, now),
  };
}

function discoveryRejection(entry, config) {
  const { book } = entry;
  if (!isBookComplete(book)) return 'incomplete_book';
  if (book.bestBid < config.minBestBid) return 'best_bid_below_min';
  if (book.bestAsk > config.maxBestAsk) return 'best_ask_above_max';
  const maxSpread = config.hunterMode ? config.hunterMaxSpread : config.maxSpread;
  if (book.spread <= 0 || book.spread > maxSpread) return 'spread_outside_hunter_limit';
  const topOneSideUsd = Math.min(topDepthUsd(book.bids, 1), topDepthUsd(book.asks, 1));
  if (topOneSideUsd < config.hunterMinTopDepthUsd) return 'top_depth_below_hunter_min';
  const topDepthTotalUsd = topDepthUsd(book.bids, 1) + topDepthUsd(book.asks, 1);
  if (topDepthTotalUsd > config.hunterMaxTopDepthUsd) return 'top_depth_above_hunter_max';
  return null;
}

function assetKey(entry) {
  return `${entry.market.marketId}:${entry.outcome.tokenId}`;
}

function completeBinaryPairs(entries) {
  const byMarket = new Map();
  for (const entry of entries) {
    const id = entry.market.marketId;
    if (!byMarket.has(id)) byMarket.set(id, []);
    byMarket.get(id).push({
      market: entry.market,
      outcome: entry.outcome.outcome,
      tokenId: entry.outcome.tokenId,
      book: entry.book,
      score: entry.score || 0,
    });
  }
  return [...byMarket.values()].filter((group) => isCompleteBinaryComplementGroup(group));
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function main() {
  const config = {
    ...CONFIG,
    maxMarkets: number(process.env.SHADOW_MAX_MARKETS, 8),
    eventPages: number(process.env.SHADOW_EVENT_PAGES, CONFIG.eventPages),
    eventLimit: number(process.env.SHADOW_EVENT_LIMIT, CONFIG.eventLimit),
    hunterMode: true,
    hunterMaxSpread: number(process.env.SHADOW_HUNTER_MAX_SPREAD, 0.24),
    baseOrderUsd: number(process.env.SHADOW_BASE_ORDER_USD, 1),
    maxMarketExposureUsd: number(process.env.SHADOW_MAX_MARKET_EXPOSURE_USD, 3),
    minSignalEdge: number(process.env.SHADOW_MIN_SIGNAL_EDGE, 0.02),
    slippageBuffer: number(process.env.SHADOW_SLIPPAGE_BUFFER, 0.002),
    spreadHunterEnabled: false,
    complementArbEnabled: true,
    inventoryExitEnabled: true,
    tailEndEnabled: true,
    enableWhaleTracking: false,
    enableWhaleCopyStrategy: false,
    saveState: false,
  };
  const observedAt = Date.now();
  const events = await fetchEvents(config);
  const markets = extractTradableMarkets(events, config);
  const planned = markets.flatMap((market) => market.outcomes
    .slice(0, config.maxOutcomesPerMarket)
    .map((outcome) => ({ market, outcome })));
  let bookErrors = 0;
  const fetched = (await mapConcurrent(planned, 8, async (entry) => {
    try {
      const url = new URL('/book', config.clobBaseUrl);
      url.searchParams.set('token_id', entry.outcome.tokenId);
      return { ...entry, book: normalizeBook(await getJson(url), entry.outcome.tokenId) };
    } catch (error) {
      bookErrors += 1;
      return { ...entry, book: null, bookError: error.message };
    }
  })).filter((entry) => entry.book);

  const scorer = new ResearchEngine({}, { setBook() {} }, config);
  const scored = [];
  for (const entry of fetched) {
    const asset = scorer.scoreAsset(entry.market, entry.outcome, entry.book);
    if (asset) scored.push(asset);
  }
  scored.sort((a, b) => b.score - a.score);
  const baseline = selectPairPreservingAssets(scored, config.maxMarkets).selected;
  const baselineKeys = new Set(baseline.map((asset) => asset.assetKey));

  const noEndingPenalty = scored
    .map((asset) => ({ ...asset, score: asset.score + endingSoonPenalty(asset.market.endDate, observedAt) }))
    .sort((a, b) => b.score - a.score);
  const noPenaltySelected = selectPairPreservingAssets(noEndingPenalty, config.maxMarkets).selected;
  const noPenaltyKeys = new Set(noPenaltySelected.map((asset) => asset.assetKey));

  const observedAssets = fetched.map((entry) => ({
    assetKey: assetKey(entry),
    market: entry.market,
    outcome: entry.outcome.outcome,
    tokenId: entry.outcome.tokenId,
    book: entry.book,
    conditionId: entry.book.market || entry.market.conditionId,
    negRisk: entry.book.negRisk === true,
    score: 0,
  }));
  const strategyAwarePool = buildStrategyAwareDiscoveryAssets(observedAssets, config, null, observedAt);
  const strategyAwareSelection = selectStrategyAwareAssets(strategyAwarePool, config.maxMarkets);
  const strategyAware = { pool: strategyAwarePool, selected: strategyAwareSelection.selected };
  const strategyAwareKeys = new Set(strategyAware.selected.map((asset) => asset.assetKey));
  const complementCompatiblePool = strategyAwarePool.filter((asset) =>
    asset.discoveryStrategies?.includes('ComplementArb')
  );

  const tail = fetched.map((entry) => ({ entry, result: tailEligibility(entry, config, observedAt) }));
  const tailEligible = tail.filter(({ result }) => result.eligible);
  const tailEligibleKeys = new Set(tailEligible.map(({ entry }) => assetKey(entry)));
  const tailScored = tailEligible.filter(({ entry }) => !discoveryRejection(entry, config));
  const tailSelected = tailEligible.filter(({ entry }) => baselineKeys.has(assetKey(entry)));
  const tailLostEndingPenalty = tailEligible.filter(({ entry }) => {
    const key = assetKey(entry);
    return !baselineKeys.has(key) && noPenaltyKeys.has(key);
  });
  const tailLostHardFilter = tailEligible.filter(({ entry }) => discoveryRejection(entry, config));
  const tailLostRankingOther = tailEligible.filter(({ entry }) => {
    const key = assetKey(entry);
    return !discoveryRejection(entry, config) && !baselineKeys.has(key) && !noPenaltyKeys.has(key);
  });

  const fetchedComplete = fetched.filter((entry) => isBookComplete(entry.book));
  const scoredEntries = scored.map((asset) => ({
    market: asset.market,
    outcome: { tokenId: asset.tokenId, outcome: asset.outcome },
    book: asset.book,
    score: asset.score,
  }));
  const selectedEntries = baseline.map((asset) => ({
    market: asset.market,
    outcome: { tokenId: asset.tokenId, outcome: asset.outcome },
    book: asset.book,
    score: asset.score,
  }));
  const completePairsBefore = completeBinaryPairs(fetchedComplete);
  const completePairsScored = completeBinaryPairs(scoredEntries);
  const completePairsSelected = completeBinaryPairs(selectedEntries);

  const tailSelectedEligible = tailSelected.length;
  const tailCandidateBuy = tailSelected.filter(({ result }) => result.sideWithoutInventory === 'buy').length;
  const tailCandidateSellNeedsInventory = tailSelectedEligible - tailCandidateBuy;
  const selectedTailTimePopulation = tail.filter(({ entry, result }) =>
    Number.isFinite(result.hours) && result.hours > 0 && result.hours <= config.tailEndHours && baselineKeys.has(assetKey(entry))
  ).length;

  const report = {
    observedAt: new Date(observedAt).toISOString(),
    codeCommit: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    config: {
      maxMarkets: config.maxMarkets,
      hunterMode: config.hunterMode,
      enabledStandardStrategies: ['ComplementArb', 'InventoryExit', 'TailEndMispricing'],
      disabledStandardStrategies: ['SpreadHunter', 'WhaleCopy'],
      tailEndHours: config.tailEndHours,
      baseOrderUsd: config.baseOrderUsd,
      maxMarketExposureUsd: config.maxMarketExposureUsd,
      minSignalEdge: config.minSignalEdge,
      slippageBuffer: config.slippageBuffer,
      hunterMaxSpread: config.hunterMaxSpread,
    },
    discovery: {
      eventsFetched: events.length,
      tradableMarketsAfterGammaLiquidityVolumeFilters: markets.length,
      outcomeBooksPlanned: planned.length,
      outcomeBooksFetched: fetched.length,
      bookErrors,
      scoredAssets: scored.length,
      selectedAssets: baseline.length,
      selectedMarkets: new Set(baseline.map((asset) => asset.market.marketId)).size,
    },
    tailEnd: {
      timeWindowAssetsBeforeRanking: tail.filter(({ result }) =>
        Number.isFinite(result.hours) && result.hours > 0 && result.hours <= config.tailEndHours
      ).length,
      strategyEligibleAssetsBeforeRanking: tailEligible.length,
      strategyEligibleMarketsBeforeRanking: new Set(tailEligible.map(({ entry }) => entry.market.marketId)).size,
      strategyEligibleAssetsPassingLegacyDiscoveryFilters: tailScored.length,
      selectedTimeWindowAssets: selectedTailTimePopulation,
      selectedStrategyEligibleAssets: tailSelectedEligible,
      selectedStrategyEligibleMarkets: new Set(tailSelected.map(({ entry }) => entry.market.marketId)).size,
      selectedBuyCandidatesWithoutInventory: tailCandidateBuy,
      selectedSellSignalsRequiringInventory: tailCandidateSellNeedsInventory,
      lostToRankingTotal: tailEligible.length - tailSelectedEligible,
      lostToEndingSoonPenaltyOnly: tailLostEndingPenalty.length,
      lostToLegacyDiscoveryHardFilters: tailLostHardFilter.length,
      lostToOtherRankingReasons: tailLostRankingOther.length,
      eligiblePenaltyBands: countBy(tailEligible, ({ result }) => String(result.penalty)),
      legacyHardFilterReasons: countBy(tailLostHardFilter, ({ entry }) => discoveryRejection(entry, config)),
    },
    complementArbObservation: {
      exactBinaryPairsWithCompleteBooksBeforeScoring: completePairsBefore.length,
      exactBinaryPairsSurvivingLegacyPerAssetScoring: completePairsScored.length,
      exactBinaryPairsSelected: completePairsSelected.length,
      venueMinimumFeasiblePairsBeforeRanking: completeBinaryPairs(complementCompatiblePool.map((asset) => ({
        market: asset.market,
        outcome: { tokenId: asset.tokenId, outcome: asset.outcome },
        book: asset.book,
        score: asset.score,
      }))).length,
      pairsLostToLegacyPerAssetFilters: completePairsBefore.length - completePairsScored.length,
      pairsLostToRankingAfterScoring: completePairsScored.length - completePairsSelected.length,
    },
    counterfactualRemoveEndingSoonPenaltyOnly: {
      selectedAssets: noPenaltySelected.length,
      selectedTailEligibleAssets: tailEligible.filter(({ entry }) => noPenaltyKeys.has(assetKey(entry))).length,
      tailEligibleAssetsAdded: tailLostEndingPenalty.length,
      selectedAssetKeysChanged: baseline.filter((asset) => !noPenaltyKeys.has(asset.assetKey)).length +
        noPenaltySelected.filter((asset) => !baselineKeys.has(asset.assetKey)).length,
    },
    counterfactualStrategyAwareProfiles: {
      compatibleAssetPool: strategyAware.pool.length,
      selectedAssets: strategyAware.selected.length,
      selectedMarkets: new Set(strategyAware.selected.map((asset) => asset.market.marketId)).size,
      selectedTailEligibleAssets: tailEligible.filter(({ entry }) => strategyAwareKeys.has(assetKey(entry))).length,
      selectedTailEligibleMarkets: new Set(tailEligible
        .filter(({ entry }) => strategyAwareKeys.has(assetKey(entry)))
        .map(({ entry }) => entry.market.marketId)).size,
      selectedComplementPairs: completeBinaryPairs(strategyAware.selected
        .filter((asset) => asset.discoveryStrategies?.includes('ComplementArb'))
        .map((asset) => ({
        market: asset.market,
        outcome: { tokenId: asset.tokenId, outcome: asset.outcome },
        book: asset.book,
        score: asset.score,
      }))).length,
      tailBuyCandidatesWithoutInventory: strategyAware.selected.filter((asset) =>
        asset.discoveryStrategies?.includes('TailEndMispricing') && asset.book.midpoint > 0.5
      ).length,
      tailSellSignalsRequiringInventory: strategyAware.selected.filter((asset) =>
        asset.discoveryStrategies?.includes('TailEndMispricing') && asset.book.midpoint <= 0.5
      ).length,
      selectedByDiscoveryStrategy: countBy(strategyAware.selected, (asset) =>
        (asset.discoveryStrategies || []).join('+') || 'none'
      ),
    },
    strategyAwareSelected: strategyAware.selected.map((asset) => ({
      assetKey: asset.assetKey,
      market: asset.market,
      tokenId: asset.tokenId,
      outcome: asset.outcome,
      discoveryStrategies: asset.discoveryStrategies || [],
      score: Number(asset.score.toFixed(4)),
      book: asset.book,
    })),
    baselineSelected: baseline.map((asset) => ({
      marketId: asset.market.marketId,
      tokenId: asset.tokenId,
      outcome: asset.outcome,
      score: Number(asset.score.toFixed(4)),
      hoursUntilEnd: number(hoursUntil(asset.market.endDate, observedAt).toFixed(4), null),
      endingSoonPenalty: endingSoonPenalty(asset.market.endDate, observedAt),
      spread: asset.book.spread,
      midpoint: asset.book.midpoint,
      tailEligible: tailEligibleKeys.has(asset.assetKey),
    })),
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
