'use strict';

const crypto = require('crypto');

const DEFAULT_POLICY = Object.freeze({
  minClosedPositions: 20,
  minMarkets: 8,
  minProfitFactor: 1.10,
  minQualityScore: 0.58,
  minCategoryQualityScore: 0.55,
  minCategoryPositions: 8,
  maxConcentration: 0.60,
  maxMultiTokenBuyMarketRate: 0.25,
  minMarketsForBundleClassification: 5,
  maxSignalAgeMs: 15_000,
  maxAbsoluteDisplacement: 0.04,
  maxRelativeDisplacement: 0.10,
  consensusWindowMs: 30_000,
  minIndependentLeaders: 2,
  eliteSingleMinQuality: 0.82,
  eliteSingleMinConsensusScore: 0.62,
  shadowSizeUsd: 1,
  minimumDepthMultiple: 1,
});

function finite(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ordered = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function mean(values) {
  const valid = (values || []).filter(Number.isFinite);
  return valid.length > 0 ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function normalizeWallet(value) {
  return String(value || '').trim().toLowerCase();
}

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function inferCategory(row = {}) {
  const text = `${row.title || ''} ${row.slug || ''} ${row.eventSlug || ''}`.toLowerCase();
  if (/bitcoin|btc|ethereum|eth\b|crypto|solana|xrp|doge/.test(text)) return 'CRYPTO';
  if (/nba|nfl|mlb|nhl|soccer|football|tennis|ufc|f1|grand prix|championship|league|cup\b/.test(text)) return 'SPORTS';
  if (/election|president|senate|congress|governor|democrat|republican|politic/.test(text)) return 'POLITICS';
  if (/temperature|rain|snow|weather|hurricane|storm/.test(text)) return 'WEATHER';
  if (/fed\b|inflation|gdp|unemployment|cpi|interest rate|econom/.test(text)) return 'ECONOMICS';
  if (/stock|nasdaq|s&p|dow\b|earnings|market cap|finance/.test(text)) return 'FINANCE';
  if (/ai\b|openai|apple|google|microsoft|nvidia|technology|tech\b/.test(text)) return 'TECH';
  return 'OTHER';
}

function makeTradeDedupeKey(event = {}) {
  const wallet = normalizeWallet(event.wallet || event.proxyWallet);
  const transactionHash = String(event.transactionHash || event.txHash || '').toLowerCase();
  const tokenId = String(event.tokenId || event.asset || event.assetId || '');
  const side = String(event.side || '').toUpperCase();
  const price = round(finite(event.leaderPrice ?? event.price), 6);
  const shares = round(finite(event.leaderShares ?? event.shares ?? event.size), 6);
  const timestamp = timestampMs(event.leaderTimestampMs ?? event.timestamp);
  return [wallet, transactionHash || 'no_tx', tokenId, side, price, shares, timestamp].join(':');
}

function normalizeTraderEvent(raw = {}, options = {}) {
  const wallet = normalizeWallet(options.wallet || raw.proxyWallet || raw.wallet);
  const side = String(raw.side || '').toUpperCase();
  const tokenId = String(raw.asset || raw.tokenId || raw.assetId || raw.asset_id || '');
  const leaderTimestampMs = timestampMs(raw.timestamp ?? raw.time ?? raw.createdAt);
  const detectionTimestampMs = timestampMs(options.detectionTimestampMs ?? Date.now());
  const price = finite(raw.price);
  const shares = finite(raw.size ?? raw.shares);
  const directUsd = finite(raw.usdcSize ?? raw.sizeUsd ?? raw.notionalUsd);
  const sizeUsd = Number.isFinite(directUsd) ? directUsd : price * shares;
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return null;
  if (!['BUY', 'SELL'].includes(side) || !tokenId) return null;
  if (![leaderTimestampMs, detectionTimestampMs, price, shares, sizeUsd].every(Number.isFinite)) return null;
  if (price <= 0 || price >= 1 || shares <= 0 || sizeUsd <= 0) return null;

  const event = {
    schemaVersion: 1,
    wallet,
    leaderName: String(raw.name || raw.pseudonym || options.leaderName || ''),
    side,
    tokenId,
    marketId: String(raw.conditionId || raw.marketId || raw.market || ''),
    marketSlug: String(raw.slug || ''),
    eventSlug: String(raw.eventSlug || ''),
    marketTitle: String(raw.title || raw.marketTitle || ''),
    outcome: String(raw.outcome || ''),
    outcomeIndex: Number.isInteger(Number(raw.outcomeIndex)) ? Number(raw.outcomeIndex) : null,
    leaderPrice: price,
    leaderShares: shares,
    leaderSizeUsd: sizeUsd,
    leaderTimestampMs,
    detectionTimestampMs,
    latencyMs: Math.max(0, detectionTimestampMs - leaderTimestampMs),
    transactionHash: String(raw.transactionHash || raw.txHash || ''),
    makerTaker: ['MAKER', 'TAKER'].includes(String(options.makerTaker || raw.traderSide || '').toUpperCase())
      ? String(options.makerTaker || raw.traderSide).toUpperCase()
      : 'UNKNOWN',
    source: String(options.source || 'official_data_api_activity'),
    category: options.category || inferCategory(raw),
  };
  event.dedupeKey = makeTradeDedupeKey(event);
  return event;
}

function aggregateTraderEvents(events = []) {
  const exact = new Map();
  for (const event of events.filter(Boolean)) {
    if (!exact.has(event.dedupeKey)) exact.set(event.dedupeKey, event);
  }
  const groups = new Map();
  for (const event of exact.values()) {
    const transactionGroup = event.transactionHash
      ? `${event.wallet}:${event.transactionHash.toLowerCase()}:${event.tokenId}:${event.side}`
      : event.dedupeKey;
    if (!groups.has(transactionGroup)) groups.set(transactionGroup, []);
    groups.get(transactionGroup).push(event);
  }
  return [...groups.values()].map((rows) => {
    if (rows.length === 1) return { ...rows[0], componentFillCount: 1, componentDedupeKeys: [rows[0].dedupeKey] };
    const shares = rows.reduce((sum, row) => sum + row.leaderShares, 0);
    const sizeUsd = rows.reduce((sum, row) => sum + row.leaderSizeUsd, 0);
    const representative = rows[0];
    const aggregated = {
      ...representative,
      leaderPrice: shares > 0 ? sizeUsd / shares : representative.leaderPrice,
      leaderShares: shares,
      leaderSizeUsd: sizeUsd,
      leaderTimestampMs: Math.min(...rows.map((row) => row.leaderTimestampMs)),
      detectionTimestampMs: Math.max(...rows.map((row) => row.detectionTimestampMs)),
      componentFillCount: rows.length,
      componentDedupeKeys: rows.map((row) => row.dedupeKey),
    };
    aggregated.latencyMs = Math.max(0, aggregated.detectionTimestampMs - aggregated.leaderTimestampMs);
    aggregated.dedupeKey = makeTradeDedupeKey(aggregated);
    return aggregated;
  });
}

function normalizeClosedPosition(raw = {}) {
  const wallet = normalizeWallet(raw.proxyWallet || raw.wallet);
  const realizedPnl = finite(raw.realizedPnl);
  const avgPrice = finite(raw.avgPrice);
  const totalBought = finite(raw.totalBought);
  const closedTimestampMs = timestampMs(raw.timestamp);
  if (!Number.isFinite(realizedPnl)) return null;
  return {
    wallet,
    tokenId: String(raw.asset || raw.tokenId || ''),
    marketId: String(raw.conditionId || raw.marketId || ''),
    marketSlug: String(raw.slug || ''),
    marketTitle: String(raw.title || ''),
    outcome: String(raw.outcome || ''),
    realizedPnl,
    avgPrice: Number.isFinite(avgPrice) ? avgPrice : null,
    totalBought: Number.isFinite(totalBought) ? totalBought : null,
    capitalDeployed: Number.isFinite(avgPrice) && Number.isFinite(totalBought) ? avgPrice * totalBought : null,
    closedTimestampMs: Number.isFinite(closedTimestampMs) ? closedTimestampMs : null,
    category: inferCategory(raw),
  };
}

function estimateHoldingDurations(trades = []) {
  const grouped = new Map();
  for (const trade of trades) {
    if (!trade?.tokenId || !Number.isFinite(trade.leaderTimestampMs)) continue;
    if (!grouped.has(trade.tokenId)) grouped.set(trade.tokenId, []);
    grouped.get(trade.tokenId).push(trade);
  }
  const durations = [];
  for (const rows of grouped.values()) {
    const ordered = rows.slice().sort((a, b) => a.leaderTimestampMs - b.leaderTimestampMs);
    let firstBuy = null;
    let inventory = 0;
    for (const row of ordered) {
      if (row.side === 'BUY') {
        if (inventory <= 1e-9) firstBuy = row.leaderTimestampMs;
        inventory += row.leaderShares;
      } else if (row.side === 'SELL' && inventory > 0) {
        inventory = Math.max(0, inventory - row.leaderShares);
        if (inventory <= 1e-9 && Number.isFinite(firstBuy)) {
          durations.push(row.leaderTimestampMs - firstBuy);
          firstBuy = null;
        }
      }
    }
  }
  return durations;
}

function maximumDrawdown(pnls = []) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    cumulative += pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

function calculateWalletQuality({
  wallet,
  trades = [],
  closedPositions = [],
  leaderboard = {},
  markouts = [],
  nowMs = Date.now(),
  policy = {},
} = {}) {
  const activePolicy = { ...DEFAULT_POLICY, ...policy };
  const normalizedTrades = trades.map((row) => row?.schemaVersion ? row : normalizeTraderEvent(row, { wallet, detectionTimestampMs: nowMs })).filter(Boolean);
  const normalizedClosed = closedPositions.map((row) => normalizeClosedPosition(row)).filter(Boolean);
  const orderedClosed = normalizedClosed.slice().sort((a, b) => finite(a.closedTimestampMs, 0) - finite(b.closedTimestampMs, 0));
  const pnls = orderedClosed.map((row) => row.realizedPnl);
  const winners = pnls.filter((value) => value > 0);
  const losers = pnls.filter((value) => value < 0);
  const grossProfit = winners.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losers.reduce((sum, value) => sum + value, 0));
  const realizedPnl = pnls.reduce((sum, value) => sum + value, 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const markets = new Set(normalizedClosed.map((row) => row.marketId || row.marketSlug || row.tokenId).filter(Boolean));
  const capitalDeployed = normalizedClosed.reduce((sum, row) => sum + finite(row.capitalDeployed, 0), 0);
  const maxDrawdown = maximumDrawdown(pnls);
  const positivePnlByMarket = new Map();
  const categoryStats = {};
  for (const row of normalizedClosed) {
    const key = row.marketId || row.marketSlug || row.tokenId;
    positivePnlByMarket.set(key, finite(positivePnlByMarket.get(key), 0) + Math.max(0, row.realizedPnl));
    const category = row.category || 'OTHER';
    if (!categoryStats[category]) {
      categoryStats[category] = {
        positions: 0,
        pnl: 0,
        wins: 0,
        losses: 0,
        grossProfit: 0,
        grossLoss: 0,
        capitalDeployed: 0,
        _pnls: [],
      };
    }
    categoryStats[category].positions += 1;
    categoryStats[category].pnl += row.realizedPnl;
    categoryStats[category].capitalDeployed += finite(row.capitalDeployed, 0);
    categoryStats[category]._pnls.push(row.realizedPnl);
    if (row.realizedPnl > 0) {
      categoryStats[category].wins += 1;
      categoryStats[category].grossProfit += row.realizedPnl;
    }
    if (row.realizedPnl < 0) {
      categoryStats[category].losses += 1;
      categoryStats[category].grossLoss += Math.abs(row.realizedPnl);
    }
  }
  for (const stats of Object.values(categoryStats)) {
    const categoryProfitFactor = stats.grossLoss > 0
      ? stats.grossProfit / stats.grossLoss
      : stats.grossProfit > 0 ? Infinity : 0;
    const categoryDrawdown = maximumDrawdown(stats._pnls);
    const categoryReturn = stats.capitalDeployed > 0 ? stats.pnl / stats.capitalDeployed : null;
    const categoryDrawdownRatio = stats.capitalDeployed > 0 ? categoryDrawdown / stats.capitalDeployed : null;
    const categoryReliability = stats.positions / (stats.positions + 20);
    const categoryWinQuality = (stats.wins + 2) / (stats.positions + 4);
    const categoryProfitQuality = Number.isFinite(categoryProfitFactor) ? clamp((categoryProfitFactor - 1) / 2) : 1;
    const categoryReturnQuality = Number.isFinite(categoryReturn) ? clamp((categoryReturn + 0.05) / 0.30) : 0;
    const categoryDrawdownQuality = Number.isFinite(categoryDrawdownRatio) ? clamp(1 - categoryDrawdownRatio / 0.25) : 0.25;
    const rawCategoryQuality = 0.40 * categoryWinQuality + 0.25 * categoryProfitQuality +
      0.20 * categoryReturnQuality + 0.15 * categoryDrawdownQuality;
    stats.winRate = round(stats.positions > 0 ? stats.wins / stats.positions : null);
    stats.profitFactor = Number.isFinite(categoryProfitFactor) ? round(categoryProfitFactor) : 'Infinity';
    stats.returnOnCapital = round(categoryReturn);
    stats.maxDrawdown = round(categoryDrawdown);
    stats.drawdownToCapital = round(categoryDrawdownRatio);
    stats.qualityScore = round(clamp(0.35 + categoryReliability * (rawCategoryQuality - 0.35)));
    stats.grossProfit = round(stats.grossProfit);
    stats.grossLoss = round(stats.grossLoss);
    stats.capitalDeployed = round(stats.capitalDeployed);
    stats.pnl = round(stats.pnl);
    delete stats._pnls;
  }
  const largestWinningMarketPnl = Math.max(0, ...positivePnlByMarket.values());
  const concentration = grossProfit > 0 ? largestWinningMarketPnl / grossProfit : 1;
  const winRate = pnls.length > 0 ? winners.length / pnls.length : null;
  const stabilizedWinRate = (winners.length + 2) / (pnls.length + 4);
  const sampleReliability = pnls.length / (pnls.length + 30);
  const marketBreadth = clamp(markets.size / Math.max(activePolicy.minMarkets * 2, 1));
  const boundedProfitFactor = Number.isFinite(profitFactor) ? clamp((profitFactor - 1) / 2) : 1;
  const returnOnCapital = capitalDeployed > 0 ? realizedPnl / capitalDeployed : null;
  const returnQuality = Number.isFinite(returnOnCapital) ? clamp((returnOnCapital + 0.05) / 0.30) : 0;
  const drawdownRatio = capitalDeployed > 0 ? maxDrawdown / capitalDeployed : null;
  const drawdownQuality = Number.isFinite(drawdownRatio) ? clamp(1 - drawdownRatio / 0.25) : 0.25;
  const repeatability = clamp(1 - concentration);
  const mostRecentTradeMs = normalizedTrades.reduce((latest, row) => Math.max(latest, row.leaderTimestampMs), 0);
  const currentActivity = mostRecentTradeMs > 0 ? clamp(1 - (nowMs - mostRecentTradeMs) / (7 * 86_400_000)) : 0;
  const sizeUsdValues = normalizedTrades.map((row) => row.leaderSizeUsd).filter(Number.isFinite);
  const holdingDurations = estimateHoldingDurations(normalizedTrades);
  const tradePrices = normalizedTrades.map((row) => row.leaderPrice).filter(Number.isFinite);
  const makerTrades = normalizedTrades.filter((row) => row.makerTaker === 'MAKER').length;
  const takerTrades = normalizedTrades.filter((row) => row.makerTaker === 'TAKER').length;
  const buyTokensByMarket = new Map();
  for (const trade of normalizedTrades) {
    if (trade.side !== 'BUY' || !trade.marketId) continue;
    if (!buyTokensByMarket.has(trade.marketId)) buyTokensByMarket.set(trade.marketId, new Set());
    buyTokensByMarket.get(trade.marketId).add(trade.tokenId);
  }
  const multiTokenBuyMarkets = [...buyTokensByMarket.values()].filter((tokens) => tokens.size > 1).length;
  const multiTokenBuyMarketRate = buyTokensByMarket.size > 0 ? multiTokenBuyMarkets / buyTokensByMarket.size : null;
  const portfolioBundleDominant = buyTokensByMarket.size >= activePolicy.minMarketsForBundleClassification &&
    multiTokenBuyMarketRate > activePolicy.maxMultiTokenBuyMarketRate;
  const availableMarkouts = markouts.filter((row) => Number.isFinite(row?.netMarkoutPerShare60s));
  const markoutStats = {};
  for (const seconds of [5, 15, 30, 60]) {
    const values = markouts
      .map((row) => finite(row?.[`netMarkoutPerShare${seconds}s`]))
      .filter(Number.isFinite);
    markoutStats[`${seconds}s`] = {
      sampleSize: values.length,
      mean: round(mean(values)),
      median: round(median(values)),
      winRate: round(values.length ? values.filter((value) => value > 0).length / values.length : null),
    };
  }
  const markoutQuality = availableMarkouts.length >= 5
    ? clamp(0.5 + mean(availableMarkouts.map((row) => row.netMarkoutPerShare60s)) / 0.04)
    : 0.5;

  const rawQuality = (
    0.22 * stabilizedWinRate +
    0.18 * boundedProfitFactor +
    0.13 * returnQuality +
    0.13 * drawdownQuality +
    0.12 * repeatability +
    0.08 * marketBreadth +
    0.07 * currentActivity +
    0.07 * markoutQuality
  );
  const qualityScore = clamp(0.35 + sampleReliability * (rawQuality - 0.35));
  const blockers = [];
  if (pnls.length < activePolicy.minClosedPositions) blockers.push('insufficient_closed_sample');
  if (markets.size < activePolicy.minMarkets) blockers.push('insufficient_market_breadth');
  if (!(realizedPnl > 0)) blockers.push('non_positive_realized_pnl');
  if (!(profitFactor >= activePolicy.minProfitFactor)) blockers.push('profit_factor_below_floor');
  if (concentration > activePolicy.maxConcentration) blockers.push('one_off_profit_concentration');
  if (portfolioBundleDominant) blockers.push('portfolio_bundle_strategy_not_individually_copyable');
  if (qualityScore < activePolicy.minQualityScore) blockers.push('quality_score_below_floor');
  if (currentActivity <= 0) blockers.push('no_recent_activity');

  return {
    wallet: normalizeWallet(wallet || normalizedTrades[0]?.wallet || normalizedClosed[0]?.wallet),
    leaderboard: {
      rank: leaderboard.rank ?? null,
      period: leaderboard.period ?? null,
      pnl: round(finite(leaderboard.pnl)),
      volume: round(finite(leaderboard.vol ?? leaderboard.volume)),
      discoveryOnly: true,
    },
    qualityScore: round(qualityScore),
    eligible: blockers.length === 0,
    blockers,
    trades: normalizedTrades.length,
    buyTrades: normalizedTrades.filter((row) => row.side === 'BUY').length,
    sellTrades: normalizedTrades.filter((row) => row.side === 'SELL').length,
    marketsTraded: markets.size,
    closedPositions: pnls.length,
    wins: winners.length,
    losses: losers.length,
    winRate: round(winRate),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    realizedPnl: round(realizedPnl),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor) : (profitFactor === Infinity ? 'Infinity' : null),
    capitalDeployed: round(capitalDeployed),
    returnOnCapital: round(returnOnCapital),
    maxDrawdown: round(maxDrawdown),
    drawdownToCapital: round(drawdownRatio),
    profitConcentration: round(concentration),
    sampleReliability: round(sampleReliability),
    mostRecentTradeMs: mostRecentTradeMs || null,
    activityAgeMs: mostRecentTradeMs ? Math.max(0, nowMs - mostRecentTradeMs) : null,
    typicalTradeSizeUsd: round(median(sizeUsdValues)),
    averageTradeSizeUsd: round(mean(sizeUsdValues)),
    averageEntryPrice: round(mean(tradePrices)),
    medianEntryPrice: round(median(tradePrices)),
    averageHoldingDurationMs: round(mean(holdingDurations), 0),
    medianHoldingDurationMs: round(median(holdingDurations), 0),
    makerTakerKnown: makerTrades + takerTrades,
    makerTrades,
    takerTrades,
    unknownLiquidityRoleTrades: normalizedTrades.length - makerTrades - takerTrades,
    buyMarketsObserved: buyTokensByMarket.size,
    multiTokenBuyMarkets,
    multiTokenBuyMarketRate: round(multiTokenBuyMarketRate),
    observedTradeMode: portfolioBundleDominant ? 'portfolio_bundle_or_hedging' : normalizedTrades.some((row) => row.side === 'BUY') ? 'individual_leg_copyable_not_proven' : 'sell_only_recent_sample',
    individualLegEntryCopyable: !portfolioBundleDominant && normalizedTrades.some((row) => row.side === 'BUY'),
    categoryStats,
    markoutSampleSize: availableMarkouts.length,
    markoutStats,
  };
}

function eventFingerprint(event, bucketMs = 5_000) {
  return [
    event.tokenId,
    event.side,
    Math.round(event.leaderTimestampMs / bucketMs),
    round(event.leaderPrice, 3),
  ].join(':');
}

function deriveIndependenceGroups(eventsByWallet = new Map(), { minimumShared = 3, similarityThreshold = 0.60 } = {}) {
  const entries = eventsByWallet instanceof Map ? [...eventsByWallet.entries()] : Object.entries(eventsByWallet || {});
  const parent = new Map(entries.map(([wallet]) => [wallet, wallet]));
  const find = (wallet) => {
    let root = wallet;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(wallet) !== wallet) {
      const next = parent.get(wallet);
      parent.set(wallet, root);
      wallet = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  const fingerprints = new Map(entries.map(([wallet, events]) => [wallet, new Set((events || []).map(eventFingerprint))]));
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const leftWallet = entries[i][0];
      const rightWallet = entries[j][0];
      const left = fingerprints.get(leftWallet);
      const right = fingerprints.get(rightWallet);
      let shared = 0;
      for (const value of left) if (right.has(value)) shared += 1;
      const denominator = Math.max(1, Math.min(left.size, right.size));
      if (shared >= minimumShared && shared / denominator >= similarityThreshold) union(leftWallet, rightWallet);
    }
  }
  return Object.fromEntries(entries.map(([wallet]) => [wallet, find(wallet)]));
}

function calculateConsensus({
  events = [],
  walletQualities = {},
  independenceGroups = {},
  targetTokenId = null,
  targetSide = null,
  nowMs = Date.now(),
  policy = {},
} = {}) {
  const activePolicy = { ...DEFAULT_POLICY, ...policy };
  const valid = events.filter((event) => event && nowMs - event.detectionTimestampMs <= activePolicy.consensusWindowMs);
  if (valid.length === 0) return { score: 0, qualified: false, reason: 'no_fresh_agreement', leaders: [] };
  const newest = valid.reduce((latest, event) => event.detectionTimestampMs > latest.detectionTimestampMs ? event : latest, valid[0]);
  const tokenId = String(targetTokenId || newest.tokenId);
  const side = String(targetSide || newest.side).toUpperCase();
  const aligned = valid.filter((event) => event.tokenId === tokenId && event.side === side);
  const byWallet = new Map();
  for (const event of aligned) {
    const existing = byWallet.get(event.wallet);
    if (!existing || event.detectionTimestampMs > existing.detectionTimestampMs) byWallet.set(event.wallet, event);
  }
  const groups = new Map();
  for (const event of byWallet.values()) {
    const quality = walletQualities[event.wallet] || {};
    if (!quality.eligible) continue;
    const group = independenceGroups[event.wallet] || event.wallet;
    const categoryQuality = finite(quality.categoryStats?.[event.category]?.qualityScore, quality.qualityScore);
    const combinedQuality = 0.70 * quality.qualityScore + 0.30 * categoryQuality;
    const contribution = combinedQuality * clamp(1 - event.latencyMs / Math.max(activePolicy.maxSignalAgeMs, 1));
    const existing = groups.get(group);
    if (!existing || contribution > existing.contribution) {
      groups.set(group, { event, contribution, categoryQuality, combinedQuality });
    }
  }
  const independent = [...groups.values()];
  const qualityMean = mean(independent.map((row) => row.contribution)) || 0;
  const breadth = clamp(independent.length / 3);
  const sizeSurprises = independent.map(({ event }) => {
    const typical = finite(walletQualities[event.wallet]?.typicalTradeSizeUsd, event.leaderSizeUsd);
    return clamp(event.leaderSizeUsd / Math.max(typical, 1) / 3);
  });
  const score = clamp(0.65 * qualityMean + 0.25 * breadth + 0.10 * (mean(sizeSurprises) || 0));
  const strongestQuality = independent.reduce((highest, row) => Math.max(highest, finite(walletQualities[row.event.wallet]?.qualityScore, 0)), 0);
  const multiLeaderQualified = independent.length >= activePolicy.minIndependentLeaders && score >= activePolicy.minQualityScore;
  const eliteSingleQualified = independent.length === 1 &&
    strongestQuality >= activePolicy.eliteSingleMinQuality &&
    score >= activePolicy.eliteSingleMinConsensusScore;
  const qualified = multiLeaderQualified || eliteSingleQualified;
  return {
    tokenId,
    side,
    score: round(score),
    qualified,
    reason: multiLeaderQualified
      ? 'qualified_independent_consensus'
      : eliteSingleQualified
        ? 'qualified_elite_single_leader'
        : 'insufficient_independent_consensus',
    uniqueWallets: byWallet.size,
    independentLeaderCount: independent.length,
    correlatedWalletsDiscounted: Math.max(0, byWallet.size - independent.length),
    independenceEvidence: Object.keys(independenceGroups).length > 0 ? 'historical_trade_fingerprint_groups' : 'wallet_identity_only',
    leaders: independent.map(({ event, contribution, categoryQuality, combinedQuality }) => ({
      wallet: event.wallet,
      category: event.category,
      categoryQuality: round(categoryQuality),
      combinedQuality: round(combinedQuality),
      qualityContribution: round(contribution),
      latencyMs: event.latencyMs,
    })),
  };
}

function normalizeBook(raw = {}, observedAtMs = Date.now()) {
  const normalizeLevels = (levels, descending) => (levels || [])
    .map((level) => ({ price: finite(level.price), size: finite(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
  const bids = normalizeLevels(raw.bids, true);
  const asks = normalizeLevels(raw.asks, false);
  return {
    tokenId: String(raw.asset_id || raw.assetId || raw.tokenId || ''),
    marketId: String(raw.market || raw.marketId || ''),
    observedAtMs,
    sourceTimestampMs: timestampMs(raw.timestamp),
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    spread: bids[0] && asks[0] ? asks[0].price - bids[0].price : null,
    minOrderSizeShares: finite(raw.min_order_size ?? raw.minOrderSize),
    tickSize: finite(raw.tick_size ?? raw.tickSize),
    hash: String(raw.hash || ''),
  };
}

function executablePrice(levels = [], shares, side) {
  if (!Number.isFinite(shares) || shares <= 0) return { sufficient: false, sharesRequested: shares, sharesFilled: 0, averagePrice: null, worstPrice: null };
  let remaining = shares;
  let cost = 0;
  let filled = 0;
  let worstPrice = null;
  for (const level of levels) {
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    filled += take;
    remaining -= take;
    worstPrice = level.price;
    if (remaining <= 1e-9) break;
  }
  return {
    side,
    sufficient: remaining <= 1e-9,
    sharesRequested: shares,
    sharesFilled: filled,
    averagePrice: filled > 0 ? cost / filled : null,
    worstPrice,
    notionalUsd: cost,
  };
}

function calculateTakerFeeUsd({ shares, price, feeRate = 0, feeExponent = 1, taker = true } = {}) {
  if (!taker || !Number.isFinite(shares) || !Number.isFinite(price) || !Number.isFinite(feeRate) || !Number.isFinite(feeExponent)) return 0;
  return Math.max(0, shares * feeRate * (price * (1 - price)) ** feeExponent);
}

function buildFollowerCandidate({
  event,
  walletQuality,
  consensus,
  book,
  feeRate = 0,
  feeExponent = 1,
  feeEvidence = 'unknown',
  expectedMarkoutPrior = null,
  followerPositionShares = 0,
  btcOracleEvidence = null,
  nowMs = Date.now(),
  policy = {},
} = {}) {
  const activePolicy = { ...DEFAULT_POLICY, ...policy };
  if (!event || !walletQuality || !book) return { qualified: false, blockReasons: ['missing_candidate_inputs'] };
  const ageMs = Math.max(0, nowMs - event.leaderTimestampMs);
  const isBuy = event.side === 'BUY';
  const executableSide = isBuy ? book.asks : book.bids;
  const topPrice = isBuy ? book.bestAsk : book.bestBid;
  const targetUsd = activePolicy.shadowSizeUsd;
  const targetShares = isBuy
    ? targetUsd / Math.max(finite(topPrice), 1e-9)
    : Math.min(finite(followerPositionShares, 0), targetUsd / Math.max(finite(topPrice), 1e-9));
  const execution = executablePrice(executableSide, targetShares, event.side);
  const displacement = Number.isFinite(topPrice)
    ? (isBuy ? topPrice - event.leaderPrice : event.leaderPrice - topPrice)
    : null;
  const relativeDisplacement = Number.isFinite(displacement) ? displacement / Math.max(event.leaderPrice, 1e-9) : null;
  const feeUsd = execution.sufficient
    ? calculateTakerFeeUsd({ shares: execution.sharesFilled, price: execution.averagePrice, feeRate, feeExponent, taker: true })
    : null;
  const feePerShare = Number.isFinite(feeUsd) && execution.sharesFilled > 0 ? feeUsd / execution.sharesFilled : null;
  const remainingExecutableEdge = Number.isFinite(expectedMarkoutPrior) && Number.isFinite(displacement) && Number.isFinite(feePerShare)
    ? expectedMarkoutPrior - Math.max(0, displacement) - feePerShare
    : null;
  const minimumShares = finite(book.minOrderSizeShares);
  const categoryQuality = walletQuality.categoryStats?.[event.category] || null;
  const liveSubmittable = execution.sufficient && Number.isFinite(minimumShares) && targetShares >= minimumShares;
  const blockReasons = [];
  if (!walletQuality.eligible) blockReasons.push('leader_quality_not_qualified');
  if (event.side === 'BUY' && walletQuality.individualLegEntryCopyable !== true) {
    blockReasons.push('individual_leg_copyability_not_proven');
  }
  if (!categoryQuality || categoryQuality.positions < activePolicy.minCategoryPositions) {
    blockReasons.push('insufficient_category_sample');
  } else if (!(categoryQuality.qualityScore >= activePolicy.minCategoryQualityScore)) {
    blockReasons.push('category_quality_below_floor');
  }
  if (ageMs > activePolicy.maxSignalAgeMs) blockReasons.push('leader_signal_stale');
  if (!Number.isFinite(topPrice)) blockReasons.push('missing_executable_book_side');
  if (!execution.sufficient) blockReasons.push('insufficient_executable_depth');
  if (Number.isFinite(displacement) && displacement > activePolicy.maxAbsoluteDisplacement) blockReasons.push('absolute_price_displacement');
  if (Number.isFinite(relativeDisplacement) && relativeDisplacement > activePolicy.maxRelativeDisplacement) blockReasons.push('relative_price_displacement');
  if (event.side === 'SELL' && !(followerPositionShares > 0)) blockReasons.push('sell_without_linked_follower_position');
  if (!Number.isFinite(expectedMarkoutPrior)) blockReasons.push('missing_out_of_sample_edge_prior');
  else if (!(remainingExecutableEdge > 0)) blockReasons.push('non_positive_remaining_executable_edge');
  if (consensus && consensus.qualified !== true) blockReasons.push('consensus_not_qualified');
  if (consensus && (String(consensus.tokenId) !== String(event.tokenId) || consensus.side !== event.side)) {
    blockReasons.push('consensus_target_mismatch');
  }

  return {
    schemaVersion: 1,
    strategy: 'ProfitableTraderConsensus',
    signalId: crypto.randomUUID(),
    createdAtMs: nowMs,
    qualified: blockReasons.length === 0,
    blockReasons,
    leader: {
      wallet: event.wallet,
      qualityScore: walletQuality.qualityScore,
      categoryQualityScore: categoryQuality?.qualityScore ?? null,
      categoryPositions: categoryQuality?.positions ?? 0,
      copyabilityClassification: walletQuality.observedTradeMode || 'unknown',
      individualLegEntryCopyable: walletQuality.individualLegEntryCopyable === true,
      side: event.side,
      price: event.leaderPrice,
      shares: event.leaderShares,
      sizeUsd: event.leaderSizeUsd,
      timestampMs: event.leaderTimestampMs,
      detectionTimestampMs: event.detectionTimestampMs,
      latencyMs: event.latencyMs,
      makerTaker: event.makerTaker,
    },
    tokenId: event.tokenId,
    marketId: event.marketId || book.marketId,
    marketSlug: event.marketSlug,
    marketTitle: event.marketTitle,
    outcome: event.outcome,
    category: event.category,
    side: event.side,
    currentBook: {
      observedAtMs: book.observedAtMs,
      sourceTimestampMs: book.sourceTimestampMs,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: round(book.spread),
      bidDepthShares: book.bids.reduce((sum, level) => sum + level.size, 0),
      askDepthShares: book.asks.reduce((sum, level) => sum + level.size, 0),
      minOrderSizeShares: minimumShares,
      tickSize: book.tickSize,
    },
    execution: {
      targetUsd,
      targetShares: round(targetShares),
      averagePrice: round(execution.averagePrice),
      worstPrice: round(execution.worstPrice),
      sufficientDepth: execution.sufficient,
      feeRate,
      feeExponent,
      feeUsd: round(feeUsd),
      feeEvidence,
      leaderPriceDisplacement: round(displacement),
      leaderPriceDisplacementPct: round(relativeDisplacement),
      expectedMarkoutPrior: round(expectedMarkoutPrior),
      remainingExecutableEdge: round(remainingExecutableEdge),
      paperRealistic: execution.sufficient,
      liveSubmittable,
      liveMinimumShortfallShares: Number.isFinite(minimumShares) ? round(Math.max(0, minimumShares - targetShares)) : null,
    },
    consensus: consensus || { score: walletQuality.qualityScore, independentLeaderCount: 1, qualified: false, reason: 'single_leader' },
    sophieInputs: {
      mandatory: true,
      leaderQuality: walletQuality.qualityScore,
      consensusScore: consensus?.score ?? walletQuality.qualityScore,
      latencyMs: event.latencyMs,
      displacement: round(displacement),
      spread: round(book.spread),
      remainingExecutableEdge: round(remainingExecutableEdge),
      currentLiquiditySufficient: execution.sufficient,
      btcOracleEvidence: btcOracleEvidence || null,
      btcOracleRole: btcOracleEvidence ? 'additional_evidence_not_authority' : 'not_supplied',
    },
    riskInputs: {
      mandatory: true,
      requestedSizeUsd: targetUsd,
      existingPositionShares: followerPositionShares,
      reductionOnly: event.side === 'SELL',
      liveSubmittable,
    },
  };
}

function classifyLeaderSell({ sellEvent, knownLeaderSharesBefore = null, knownLeaderAveragePrice = null, followerPositionShares = 0 } = {}) {
  if (!sellEvent || sellEvent.side !== 'SELL') return { type: 'not_a_sell', followerAction: 'none' };
  const leaderShares = finite(knownLeaderSharesBefore);
  const sellShares = finite(sellEvent.leaderShares, 0);
  let type = 'reduction_unknown_extent';
  if (Number.isFinite(leaderShares) && leaderShares > 0) {
    if (sellShares > leaderShares + 1e-9) type = 'directional_reversal_or_incomplete_history';
    else if (sellShares >= leaderShares - 1e-9) type = 'full_exit';
    else if (Number.isFinite(knownLeaderAveragePrice)) type = sellEvent.leaderPrice >= knownLeaderAveragePrice ? 'partial_profit_taking' : 'partial_thesis_invalidation';
    else type = 'partial_reduction';
  }
  const followerSharesToSell = Math.min(Math.max(0, followerPositionShares), Math.max(0, sellShares));
  return {
    type,
    followerAction: followerSharesToSell > 0 ? 'reduce_only_sell_candidate' : 'no_linked_follower_position',
    followerSharesToSell: round(followerSharesToSell),
  };
}

function evaluateExecutableMarkouts({ candidate, futureBooks = {}, feeRate = 0, feeExponent = 1 } = {}) {
  if (!candidate?.execution?.paperRealistic || candidate.side !== 'BUY') {
    return { available: false, reason: candidate?.side === 'SELL' ? 'entry_markout_requires_buy' : 'entry_not_executable' };
  }
  const shares = candidate.execution.targetShares;
  const entryPrice = candidate.execution.averagePrice;
  const entryFee = calculateTakerFeeUsd({ shares, price: entryPrice, feeRate, feeExponent, taker: true });
  const horizons = [...new Set([
    5,
    15,
    30,
    60,
    ...Object.keys(futureBooks).map((key) => Number(String(key).replace(/s$/, ''))).filter(Number.isFinite),
  ])].sort((a, b) => a - b);
  const results = {};
  for (const seconds of horizons) {
    const book = futureBooks[seconds] || futureBooks[`${seconds}s`];
    if (!book) {
      results[`${seconds}s`] = { available: false, reason: 'missing_future_executable_book' };
      continue;
    }
    const exit = executablePrice(book.bids, shares, 'SELL');
    if (!exit.sufficient) {
      results[`${seconds}s`] = { available: false, reason: 'insufficient_future_bid_depth' };
      continue;
    }
    const exitFee = calculateTakerFeeUsd({ shares, price: exit.averagePrice, feeRate, feeExponent, taker: true });
    const grossPnl = shares * (exit.averagePrice - entryPrice);
    const netPnl = grossPnl - entryFee - exitFee;
    results[`${seconds}s`] = {
      available: true,
      executableBid: round(exit.averagePrice),
      grossPnlUsd: round(grossPnl),
      feeAdjustedPnlUsd: round(netPnl),
      grossMarkoutPerShare: round(exit.averagePrice - entryPrice),
      netMarkoutPerShare: round(netPnl / shares),
      favorable: netPnl > 0,
    };
  }
  const availableResults = Object.values(results).filter((row) => row.available);
  return {
    available: true,
    entryPrice,
    shares,
    entryFeeUsd: round(entryFee),
    observedMaePerShare: round(Math.min(...availableResults.map((row) => row.netMarkoutPerShare))),
    observedMfePerShare: round(Math.max(...availableResults.map((row) => row.netMarkoutPerShare))),
    horizons: results,
  };
}

function toSophieSignalInput(candidate, { ttlMs = 10_000, maxHoldMs = 60_000 } = {}) {
  if (!candidate || candidate.qualified !== true) return null;
  return {
    strategy: 'ProfitableTraderConsensus',
    tokenId: candidate.tokenId,
    marketId: candidate.marketId,
    side: String(candidate.side).toLowerCase(),
    price: candidate.execution.averagePrice,
    sizeUsd: candidate.execution.targetUsd,
    expectedEdge: candidate.execution.remainingExecutableEdge,
    confidence: clamp((candidate.leader.qualityScore + candidate.consensus.score) / 2),
    reason: `qualified profitable-trader evidence leaders=${candidate.consensus.independentLeaderCount}`,
    exitPlan: 'Reduce on linked qualified leader SELL, thesis invalidation, or existing protective exits',
    ttlMs,
    maxHoldMs,
    metadata: {
      marketSlug: candidate.marketSlug,
      marketQuestion: candidate.marketTitle,
      outcome: candidate.outcome,
      profitableTraderConsensus: candidate,
      targetWalletExecution: {
        handle: candidate.leader.wallet,
        side: String(candidate.leader.side).toLowerCase(),
        sizeUsd: candidate.leader.sizeUsd,
        price: candidate.leader.price,
      },
    },
  };
}

module.exports = {
  DEFAULT_POLICY,
  normalizeTraderEvent,
  aggregateTraderEvents,
  normalizeClosedPosition,
  calculateWalletQuality,
  deriveIndependenceGroups,
  calculateConsensus,
  normalizeBook,
  executablePrice,
  calculateTakerFeeUsd,
  buildFollowerCandidate,
  classifyLeaderSell,
  evaluateExecutableMarkouts,
  toSophieSignalInput,
  inferCategory,
  makeTradeDedupeKey,
};
