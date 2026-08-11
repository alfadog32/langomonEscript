'use strict';

const crypto = require('crypto');
const {
  executablePrice,
  calculateTakerFeeUsd,
} = require('./profitable_trader_consensus');

const PASSIVE_TTLS_SECONDS = Object.freeze([2, 5, 10, 15, 30]);
const ADVERSE_MOVE_THRESHOLDS_PCT = Object.freeze([4, 3, 2]);
const MARKOUT_HORIZONS_SECONDS = Object.freeze([5, 15, 30, 60, 120, 300]);
const PASSIVE_POLICY = Object.freeze({
  shadowSizeUsd: 1,
  queueHaircutPct: 0.50,
  partialFillDepthFraction: 0.35,
  minFillDelayMs: 1_000,
  maxBookAgeMs: 3_000,
  maxSpread: 0.10,
  maxLeaderAbsoluteDisplacement: 0.04,
  maxLeaderRelativeDisplacement: 0.10,
  maxLeaderAgeMs: 45_000,
  requiredMarketableSnapshots: 2,
});

function finite(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values) {
  const valid = (values || []).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function summarizePnl(values) {
  const valid = (values || []).filter(Number.isFinite);
  let cumulative = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const value of valid) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maximumDrawdown = Math.max(maximumDrawdown, peak - cumulative);
  }
  return {
    sampleSize: valid.length,
    mean: round(mean(valid)),
    median: round(median(valid)),
    winRate: valid.length ? round(valid.filter((value) => value > 0).length / valid.length) : null,
    total: round(valid.reduce((sum, value) => sum + value, 0)),
    maximumDrawdown: round(maximumDrawdown),
  };
}

function floorToTick(value, tick) {
  if (!(value > 0) || !(tick > 0)) return null;
  const steps = Math.floor((value + 1e-12) / tick);
  return round(steps * tick, 6);
}

function priceImprovementBucket(improvement) {
  if (!(improvement >= 0)) return 'unknown';
  if (improvement <= 0.01 + 1e-9) return '0-1c';
  if (improvement <= 0.02 + 1e-9) return '1-2c';
  if (improvement <= 0.03 + 1e-9) return '2-3c';
  if (improvement <= 0.04 + 1e-9) return '3-4c';
  return '>4c';
}

function latencyBucket(latencyMs) {
  if (latencyMs <= 2_000) return '0-2s';
  if (latencyMs <= 5_000) return '2-5s';
  if (latencyMs <= 10_000) return '5-10s';
  if (latencyMs <= 15_000) return '10-15s';
  return '>15s';
}

function passivePriceProposals(event, book) {
  const bid = finite(book?.bestBid);
  const ask = finite(book?.bestAsk);
  const tick = finite(book?.tickSize, 0.01);
  if (!(bid > 0) || !(ask > bid) || !(tick > 0)) return [];
  const midpoint = (bid + ask) / 2;
  const raw = [
    ['PASSIVE_BID', bid],
    ['PASSIVE_BID_PLUS_1T', bid + tick],
    ['PASSIVE_MID', midpoint],
    ['PASSIVE_LEADER', finite(event?.leaderPrice)],
    ['PASSIVE_ASK_MINUS_1C', ask - 0.01],
    ['PASSIVE_ASK_MINUS_2C', ask - 0.02],
    ['PASSIVE_ASK_MINUS_3C', ask - 0.03],
    ['PASSIVE_ASK_MINUS_4C', ask - 0.04],
    ['PASSIVE_ASK_MINUS_5C', ask - 0.05],
  ];
  return raw.map(([rule, value]) => ({ rule, proposedPrice: floorToTick(value, tick) }));
}

function queueAheadShares(book, price) {
  const tick = finite(book?.tickSize, 0.01);
  const epsilon = Math.max(1e-9, tick / 2);
  return (book?.bids || [])
    .filter((level) => finite(level.price) >= price - epsilon)
    .reduce((sum, level) => sum + Math.max(0, finite(level.size, 0)), 0);
}

function makerFeeUsd(order) {
  if (order.fee?.takerOnly !== false) return 0;
  return calculateTakerFeeUsd({
    shares: order.targetShares,
    price: order.price,
    feeRate: order.fee.rate,
    feeExponent: order.fee.exponent,
    taker: true,
  });
}

function createPassiveOrders({
  opportunityId = crypto.randomUUID(),
  event,
  book,
  fee = {},
  registeredAtMs = Date.now(),
  ttlsSeconds = PASSIVE_TTLS_SECONDS,
  adverseMoveThresholdsPct = ADVERSE_MOVE_THRESHOLDS_PCT,
  policy = {},
} = {}) {
  const activePolicy = { ...PASSIVE_POLICY, ...policy };
  const ask = finite(book?.bestAsk);
  const bid = finite(book?.bestBid);
  const tick = finite(book?.tickSize, 0.01);
  const rejections = [];
  const orders = [];
  for (const proposal of passivePriceProposals(event, book)) {
    const price = proposal.proposedPrice;
    let rejection = null;
    if (!(price > 0 && price < 1)) rejection = 'invalid_price';
    else if (!(price < ask - Math.max(1e-9, tick / 2))) rejection = 'marketable_at_registration';
    if (rejection) {
      rejections.push({ rule: proposal.rule, proposedPrice: price, reason: rejection });
      continue;
    }
    const targetShares = activePolicy.shadowSizeUsd / price;
    const base = {
      schemaVersion: 1,
      opportunityId,
      wallet: event.wallet,
      leaderName: event.leaderName,
      tokenId: event.tokenId,
      marketId: event.marketId || book.marketId,
      marketSlug: event.marketSlug,
      category: event.category,
      rule: proposal.rule,
      price,
      targetUsd: activePolicy.shadowSizeUsd,
      targetShares,
      registeredAtMs,
      leaderTimestampMs: event.leaderTimestampMs,
      detectionLatencyMs: event.latencyMs,
      leaderPrice: event.leaderPrice,
      placementBid: bid,
      placementAsk: ask,
      placementSpread: ask - bid,
      priceImprovementVsAsk: ask - price,
      priceImprovementBucket: priceImprovementBucket(ask - price),
      tickSize: tick,
      queueAheadShares: queueAheadShares(book, price),
      minimumOrderShares: Number.isFinite(finite(book?.minOrderSizeShares)) ? finite(book.minOrderSizeShares) : null,
      shadowExecutableAtRegistration: true,
      paperRealisticFill: false,
      liveMinimumFeasibleAtShadowSize: Number.isFinite(finite(book?.minOrderSizeShares))
        ? targetShares >= finite(book.minOrderSizeShares)
        : false,
      fee: {
        rate: finite(fee.rate, 0),
        exponent: finite(fee.exponent, 1),
        takerOnly: fee.takerOnly !== false,
        evidence: fee.evidence || 'unknown',
      },
      consensus: {
        reason: event.consensus?.reason || 'unknown',
        independentLeaderCount: finite(event.consensus?.independentLeaderCount, 0),
        score: finite(event.consensus?.score, 0),
      },
    };
    for (const ttlSeconds of ttlsSeconds) {
      for (const adverseMoveThresholdPct of adverseMoveThresholdsPct) {
        orders.push({
          ...base,
          orderId: crypto.randomUUID(),
          ttlSeconds,
          adverseMoveThresholdPct,
          expiresAtMs: registeredAtMs + ttlSeconds * 1_000,
          status: 'open',
          closeReason: null,
          closedAtMs: null,
          fill: null,
          entryFeeUsd: round(makerFeeUsd(base)),
          cumulativeOpposingSellShares: 0,
          opposingTradeCount: 0,
          marketableSnapshotCount: 0,
          lastMarketableEvidenceKey: null,
          lastBid: bid,
          maxObservedVolatilityPct: 0,
          registrationHorizons: {},
          fillHorizons: {},
          observedMaePerShare: null,
          observedMfePerShare: null,
          linkedLeaderSell: null,
          revalidationHistory: [],
        });
      }
    }
  }
  return { opportunityId, orders, rejections };
}

function bookAgeMs(book, nowMs) {
  const observedAtMs = finite(book?.observedAtMs);
  return Number.isFinite(observedAtMs) ? Math.max(0, nowMs - observedAtMs) : Infinity;
}

function revalidatePassiveOrder(order, book, nowMs = Date.now(), policy = {}) {
  const activePolicy = { ...PASSIVE_POLICY, ...policy };
  const bid = finite(book?.bestBid);
  const ask = finite(book?.bestAsk);
  const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : NaN;
  const ageMs = bookAgeMs(book, nowMs);
  const sourceTimestampMs = finite(book?.sourceTimestampMs);
  const sourceAgeMs = Number.isFinite(sourceTimestampMs) ? Math.max(0, nowMs - sourceTimestampMs) : null;
  const adverseMovePct = bid > 0 && order.placementBid > 0
    ? Math.max(0, ((order.placementBid - bid) / order.placementBid) * 100)
    : null;
  const leaderDisplacement = Number.isFinite(ask) ? ask - order.leaderPrice : null;
  const leaderRelativeDisplacement = Number.isFinite(leaderDisplacement)
    ? leaderDisplacement / Math.max(order.leaderPrice, 1e-9)
    : null;
  const leaderAgeMs = Math.max(0, nowMs - order.leaderTimestampMs);
  const currentExit = executablePrice(book?.bids || [], order.targetShares, 'SELL');
  const lastBid = finite(order.lastBid, bid);
  const volatilityPct = bid > 0 && lastBid > 0 ? Math.abs((bid - lastBid) / lastBid) * 100 : 0;
  order.lastBid = bid;
  order.maxObservedVolatilityPct = Math.max(order.maxObservedVolatilityPct || 0, volatilityPct);
  const evidence = {
    observedAtMs: nowMs,
    bid: round(bid),
    ask: round(ask),
    spread: round(spread),
    bookAgeMs: round(ageMs, 0),
    sourceAgeMs: round(sourceAgeMs, 0),
    leaderAgeMs: round(leaderAgeMs, 0),
    leaderDisplacement: round(leaderDisplacement),
    leaderRelativeDisplacement: round(leaderRelativeDisplacement),
    adverseMovePct: round(adverseMovePct),
    volatilityPct: round(volatilityPct),
    currentExitDepthSufficient: currentExit.sufficient === true,
    immediateGrossEconomicsPerShare: currentExit.sufficient ? round(currentExit.averagePrice - order.price) : null,
  };
  let reason = null;
  if (!(bid > 0) || !(ask > bid)) reason = 'invalid_or_incomplete_book';
  else if (ageMs > activePolicy.maxBookAgeMs) reason = 'stale_book';
  else if (!(spread > 0) || spread > activePolicy.maxSpread) reason = 'spread_revalidation_failed';
  else if (leaderAgeMs > activePolicy.maxLeaderAgeMs) reason = 'leader_signal_age_revalidation_failed';
  else if (leaderDisplacement > activePolicy.maxLeaderAbsoluteDisplacement) reason = 'leader_absolute_displacement_revalidation_failed';
  else if (leaderRelativeDisplacement > activePolicy.maxLeaderRelativeDisplacement) reason = 'leader_relative_displacement_revalidation_failed';
  else if (Number.isFinite(adverseMovePct) && adverseMovePct >= order.adverseMoveThresholdPct) reason = 'placement_bid_deterioration';
  else if (!currentExit.sufficient) reason = 'insufficient_current_exit_depth';
  order.revalidationHistory.push({ ...evidence, passed: !reason, reason });
  if (order.revalidationHistory.length > 64) order.revalidationHistory.shift();
  return { passed: !reason, reason, evidence };
}

function tradeTimestampMs(trade) {
  const value = finite(trade?.timestamp);
  return Number.isFinite(value) ? (value < 10_000_000_000 ? value * 1_000 : value) : NaN;
}

function tradeKey(trade) {
  return [
    String(trade?.transactionHash || ''),
    String(trade?.proxyWallet || ''),
    String(trade?.asset || ''),
    String(trade?.side || ''),
    finite(trade?.price),
    finite(trade?.size),
    tradeTimestampMs(trade),
  ].join(':');
}

function opposingTradeEvidence(order, trades, nowMs) {
  const unique = new Map();
  for (const trade of trades || []) unique.set(tradeKey(trade), trade);
  const rows = [...unique.values()].filter((trade) => {
    const timestampMs = tradeTimestampMs(trade);
    return String(trade?.asset || '') === String(order.tokenId) &&
      String(trade?.side || '').toUpperCase() === 'SELL' &&
      timestampMs > order.registeredAtMs &&
      timestampMs <= nowMs;
  });
  const epsilon = Math.max(1e-9, order.tickSize / 2);
  const touchedOrThrough = rows.some((trade) => finite(trade.price) <= order.price + epsilon);
  const cumulativeShares = rows.reduce((sum, trade) => sum + Math.max(0, finite(trade.size, 0)), 0);
  const haircutAdjustedShares = cumulativeShares * (1 - PASSIVE_POLICY.queueHaircutPct);
  const requiredShares = order.queueAheadShares + order.targetShares;
  return {
    rows,
    touchedOrThrough,
    cumulativeShares,
    haircutAdjustedShares,
    requiredShares,
    queueCleared: touchedOrThrough && haircutAdjustedShares >= requiredShares,
  };
}

function marketableDepthEvidence(order, book) {
  const epsilon = Math.max(1e-9, order.tickSize / 2);
  const eligibleAsks = (book?.asks || []).filter((level) => finite(level.price) <= order.price + epsilon);
  const opposingDepthUsd = eligibleAsks.reduce((sum, level) => sum + finite(level.price, 0) * finite(level.size, 0), 0);
  const fillableUsd = opposingDepthUsd * PASSIVE_POLICY.partialFillDepthFraction * (1 - PASSIVE_POLICY.queueHaircutPct);
  return {
    eligibleAsks: eligibleAsks.length,
    opposingDepthUsd,
    fillableUsd,
    sufficient: fillableUsd >= order.targetUsd,
  };
}

function fillOrder(order, source, nowMs, evidence) {
  order.status = 'filled';
  order.paperRealisticFill = true;
  order.closeReason = source;
  order.closedAtMs = nowMs;
  order.fill = {
    source,
    timestampMs: nowMs,
    price: order.price,
    shares: order.targetShares,
    sizeUsd: order.targetUsd,
    queueHaircutApplied: PASSIVE_POLICY.queueHaircutPct,
    partialFillDepthFraction: PASSIVE_POLICY.partialFillDepthFraction,
    evidence,
  };
  return { filled: true, source, evidence };
}

function processPassiveOrder(order, { book, trades = [], nowMs = Date.now(), policy = {} } = {}) {
  if (order.status !== 'open') return { filled: false, terminal: true, reason: order.closeReason };
  if (nowMs >= order.expiresAtMs) {
    order.status = 'expired';
    order.closeReason = 'ttl_expired';
    order.closedAtMs = nowMs;
    return { filled: false, terminal: true, reason: order.closeReason };
  }
  const revalidation = revalidatePassiveOrder(order, book, nowMs, policy);
  if (!revalidation.passed) {
    order.status = 'canceled';
    order.closeReason = revalidation.reason;
    order.closedAtMs = nowMs;
    return { filled: false, terminal: true, reason: order.closeReason, revalidation };
  }
  if (nowMs - order.registeredAtMs < PASSIVE_POLICY.minFillDelayMs) {
    return { filled: false, terminal: false, reason: 'minimum_fill_delay' };
  }

  const opposing = opposingTradeEvidence(order, trades, nowMs);
  order.cumulativeOpposingSellShares = opposing.cumulativeShares;
  order.opposingTradeCount = opposing.rows.length;
  if (opposing.queueCleared) {
    const source = order.queueAheadShares > 1e-9
      ? 'queue_depth_supported_maker_fill'
      : 'opposing_side_execution_touch';
    return fillOrder(order, source, nowMs, {
      opposingTradeCount: opposing.rows.length,
      cumulativeOpposingSellShares: round(opposing.cumulativeShares),
      haircutAdjustedShares: round(opposing.haircutAdjustedShares),
      queueAheadShares: round(order.queueAheadShares),
      requiredShares: round(opposing.requiredShares),
    });
  }

  const depth = marketableDepthEvidence(order, book);
  const isMarketableNow = finite(book?.bestAsk) <= order.price + Math.max(1e-9, order.tickSize / 2);
  if (isMarketableNow && depth.sufficient) {
    const evidenceKey = String(book?.hash || book?.sourceTimestampMs || '');
    if (evidenceKey && evidenceKey !== order.lastMarketableEvidenceKey) {
      order.marketableSnapshotCount += 1;
      order.lastMarketableEvidenceKey = evidenceKey;
    }
  } else {
    order.marketableSnapshotCount = 0;
    order.lastMarketableEvidenceKey = null;
  }
  if (order.marketableSnapshotCount >= PASSIVE_POLICY.requiredMarketableSnapshots) {
    return fillOrder(order, 'later_marketable_limit_confirmed', nowMs, {
      consecutiveDistinctMarketableSnapshots: order.marketableSnapshotCount,
      eligibleAskLevels: depth.eligibleAsks,
      opposingDepthUsd: round(depth.opposingDepthUsd),
      haircutAdjustedFillableUsd: round(depth.fillableUsd),
    });
  }
  return { filled: false, terminal: false, reason: isMarketableNow ? 'marketable_confirmation_pending' : 'not_fillable' };
}

function executableEconomics(order, book) {
  const exit = executablePrice(book?.bids || [], order.targetShares, 'SELL');
  if (!exit.sufficient) return { available: false, reason: 'insufficient_executable_bid_depth' };
  const entryFeeUsd = finite(order.entryFeeUsd, 0);
  const exitFeeUsd = calculateTakerFeeUsd({
    shares: order.targetShares,
    price: exit.averagePrice,
    feeRate: order.fee.rate,
    feeExponent: order.fee.exponent,
    taker: true,
  });
  const grossPnlUsd = order.targetShares * (exit.averagePrice - order.price);
  const feeAdjustedPnlUsd = grossPnlUsd - entryFeeUsd - exitFeeUsd;
  return {
    available: true,
    executableBid: round(exit.averagePrice),
    grossPnlUsd: round(grossPnlUsd),
    feeAdjustedPnlUsd: round(feeAdjustedPnlUsd),
    grossMarkoutPerShare: round(exit.averagePrice - order.price),
    feeAdjustedMarkoutPerShare: round(feeAdjustedPnlUsd / order.targetShares),
    entryFeeUsd: round(entryFeeUsd),
    exitFeeUsd: round(exitFeeUsd),
    totalFeesUsd: round(entryFeeUsd + exitFeeUsd),
  };
}

function observeOrderEconomics(order, book, nowMs = Date.now()) {
  for (const seconds of MARKOUT_HORIZONS_SECONDS) {
    const key = `${seconds}s`;
    if (!order.registrationHorizons[key] && nowMs >= order.registeredAtMs + seconds * 1_000) {
      order.registrationHorizons[key] = executableEconomics(order, book);
    }
    if (order.fill && !order.fillHorizons[key] && nowMs >= order.fill.timestampMs + seconds * 1_000) {
      order.fillHorizons[key] = executableEconomics(order, book);
    }
  }
  if (order.fill && nowMs >= order.fill.timestampMs) {
    const economics = executableEconomics(order, book);
    if (economics.available) {
      const markout = economics.feeAdjustedMarkoutPerShare;
      order.observedMaePerShare = Number.isFinite(order.observedMaePerShare)
        ? Math.min(order.observedMaePerShare, markout)
        : markout;
      order.observedMfePerShare = Number.isFinite(order.observedMfePerShare)
        ? Math.max(order.observedMfePerShare, markout)
        : markout;
    }
  }
}

function linkLeaderSell(order, book, sellEvent) {
  if (!order.fill || order.linkedLeaderSell || sellEvent?.wallet !== order.wallet || sellEvent?.tokenId !== order.tokenId) return null;
  if (sellEvent.detectionTimestampMs <= order.fill.timestampMs) return null;
  const economics = executableEconomics(order, book);
  order.linkedLeaderSell = {
    available: economics.available,
    sellDetectedAtMs: sellEvent.detectionTimestampMs,
    holdingMs: sellEvent.detectionTimestampMs - order.fill.timestampMs,
    leaderSellShares: sellEvent.leaderShares,
    ...economics,
  };
  return order.linkedLeaderSell;
}

function countsBy(rows, keyFor) {
  const counts = {};
  for (const row of rows) {
    const key = keyFor(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function dominantPositiveContribution(values) {
  const positives = values.filter((value) => Number.isFinite(value) && value > 0);
  const total = positives.reduce((sum, value) => sum + value, 0);
  return total > 0 ? Math.max(...positives) / total : null;
}

function orderCohortSummary(rows) {
  const ordered = rows.slice().sort((a, b) => (a.fill?.timestampMs || a.registeredAtMs) - (b.fill?.timestampMs || b.registeredAtMs));
  const fills = ordered.filter((order) => order.fill);
  const horizons = {};
  for (const seconds of MARKOUT_HORIZONS_SECONDS) {
    const key = `${seconds}s`;
    const economics = fills.map((order) => order.fillHorizons[key]).filter((row) => row?.available);
    horizons[key] = {
      sampleSize: economics.length,
      grossPnlUsd: summarizePnl(economics.map((row) => row.grossPnlUsd)),
      feeAdjustedPnlUsd: summarizePnl(economics.map((row) => row.feeAdjustedPnlUsd)),
      feeAdjustedMarkoutPerShare: summarizePnl(economics.map((row) => row.feeAdjustedMarkoutPerShare)),
      feesUsd: summarizePnl(economics.map((row) => row.totalFeesUsd)),
      dominantPositiveOutlierShare: round(dominantPositiveContribution(economics.map((row) => row.feeAdjustedPnlUsd))),
    };
  }
  const fiveSecond = fills.map((order) => order.fillHorizons['5s']).filter((row) => row?.available);
  const sixtySecond = fills.map((order) => order.fillHorizons['60s']).filter((row) => row?.available);
  const unfilled = ordered.filter((order) => !order.fill);
  const missedProfitable = unfilled.filter((order) => order.registrationHorizons['60s']?.feeAdjustedPnlUsd > 0);
  const filledRegistration60 = fills.map((order) => order.registrationHorizons['60s']?.feeAdjustedPnlUsd).filter(Number.isFinite);
  const unfilledRegistration60 = unfilled.map((order) => order.registrationHorizons['60s']?.feeAdjustedPnlUsd).filter(Number.isFinite);
  const linked = fills.map((order) => order.linkedLeaderSell).filter((row) => row?.available);
  return {
    signals: new Set(ordered.map((order) => order.opportunityId)).size,
    ordersShadowed: ordered.length,
    fills: fills.length,
    fillRate: ordered.length ? round(fills.length / ordered.length) : null,
    wallets: new Set(ordered.map((order) => order.wallet)).size,
    markets: new Set(ordered.map((order) => order.marketId)).size,
    entryImprovementVsAsk: summarizePnl(ordered.map((order) => order.priceImprovementVsAsk)),
    fillSources: countsBy(fills, (order) => order.fill.source),
    terminalReasons: countsBy(ordered.filter((order) => !order.fill), (order) => order.closeReason || order.status),
    paperRealisticFills: fills.length,
    liveMinimumFeasibleOrders: ordered.filter((order) => order.liveMinimumFeasibleAtShadowSize).length,
    toxicFillRate5s: fiveSecond.length ? round(fiveSecond.filter((row) => row.feeAdjustedPnlUsd < 0).length / fiveSecond.length) : null,
    adverseSelectionRate: fiveSecond.length ? round(fiveSecond.filter((row) => row.feeAdjustedMarkoutPerShare < 0).length / fiveSecond.length) : null,
    negative60sFillRate: sixtySecond.length ? round(sixtySecond.filter((row) => row.feeAdjustedPnlUsd < 0).length / sixtySecond.length) : null,
    observedMaePerShare: summarizePnl(fills.map((order) => order.observedMaePerShare)),
    observedMfePerShare: summarizePnl(fills.map((order) => order.observedMfePerShare)),
    missedProfitableOpportunities60s: missedProfitable.length,
    missedProfitableOpportunityRate60s: unfilled.length ? round(missedProfitable.length / unfilled.length) : null,
    filledOpportunityCounterfactual60s: summarizePnl(filledRegistration60),
    unfilledOpportunityCounterfactual60s: summarizePnl(unfilledRegistration60),
    adverseSelectionGap60s: Number.isFinite(mean(filledRegistration60)) && Number.isFinite(mean(unfilledRegistration60))
      ? round(mean(filledRegistration60) - mean(unfilledRegistration60))
      : null,
    linkedLeaderSell: {
      sampleSize: linked.length,
      feeAdjustedPnlUsd: summarizePnl(linked.map((row) => row.feeAdjustedPnlUsd)),
    },
    horizons,
  };
}

function groupedSummaries(rows, keyFor) {
  const groups = {};
  for (const row of rows) {
    const key = keyFor(row);
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, orderCohortSummary(group)]));
}

function summarizePassiveStudy({ opportunities = [], orders = [], priorTakerBaseline = null, observation = {} } = {}) {
  const productionGuardOrders = orders.filter((order) => order.adverseMoveThresholdPct === 4);
  const ruleTtlEconomics = groupedSummaries(productionGuardOrders, (order) => `${order.rule}|${order.ttlSeconds}s`);
  const walletRuleEconomics = groupedSummaries(productionGuardOrders, (order) => `${order.wallet}|${order.rule}|${order.ttlSeconds}s`);
  const eligibleRuleCells = Object.entries(ruleTtlEconomics).filter(([, cell]) => cell.fills >= 25);
  const rankedRuleCells = eligibleRuleCells.slice().sort((a, b) => {
    const left = finite(a[1].horizons['60s'].feeAdjustedPnlUsd.mean, -Infinity);
    const right = finite(b[1].horizons['60s'].feeAdjustedPnlUsd.mean, -Infinity);
    return right - left;
  });
  const proven = rankedRuleCells.filter(([, cell]) => {
    const sixty = cell.horizons['60s'].feeAdjustedPnlUsd;
    return sixty.mean > 0 && sixty.median > 0 && cell.wallets >= 3 && cell.markets >= 10 &&
      cell.adverseSelectionRate <= 0.50 && sixty.dominantPositiveOutlierShare <= 0.25;
  });
  const allBase = orderCohortSummary(productionGuardOrders);
  return {
    generatedAt: new Date().toISOString(),
    mode: 'public_get_passive_follower_forward_shadow',
    safety: {
      publicGetOnly: true,
      orderPlacementCodePresent: false,
      followerOrdersPlaced: 0,
      paperOrdersPlaced: 0,
      liveOrdersPlaced: 0,
      spreadHunterChanged: false,
      riskChanged: false,
      sophieChanged: false,
      stateChanged: false,
    },
    observation,
    priorTakerBaseline,
    passive: {
      opportunityCount: opportunities.length,
      uniqueFilledOpportunitiesAtFourPct: new Set(productionGuardOrders.filter((order) => order.fill).map((order) => order.opportunityId)).size,
      rulesTested: [...new Set(orders.map((order) => order.rule))],
      ttlsTestedSeconds: [...new Set(orders.map((order) => order.ttlSeconds))].sort((a, b) => a - b),
      adverseMoveThresholdsComparedPct: [...new Set(orders.map((order) => order.adverseMoveThresholdPct))].sort((a, b) => b - a),
      overallAtFourPct: allBase,
      ruleTtlEconomics,
      priceRuleEconomics: groupedSummaries(productionGuardOrders, (order) => order.rule),
      ttlEconomics: groupedSummaries(productionGuardOrders, (order) => `${order.ttlSeconds}s`),
      priceImprovementBucketEconomics: groupedSummaries(productionGuardOrders, (order) => order.priceImprovementBucket),
      adverseMoveThresholdComparison: groupedSummaries(orders, (order) => `${order.adverseMoveThresholdPct}%`),
      latencyEconomics: groupedSummaries(productionGuardOrders, (order) => latencyBucket(order.detectionLatencyMs)),
      consensusEconomics: groupedSummaries(productionGuardOrders, (order) => order.consensus.independentLeaderCount >= 2 ? 'independent_multi_wallet' : 'single_wallet'),
      perWalletEconomics: groupedSummaries(productionGuardOrders, (order) => order.wallet),
      perWalletRuleEconomics: walletRuleEconomics,
      walletRuleCellsWithAtLeastFiveFills: Object.fromEntries(Object.entries(walletRuleEconomics).filter(([, cell]) => cell.fills >= 5)),
      bestEligibleRuleCell: rankedRuleCells[0] ? { key: rankedRuleCells[0][0], result: rankedRuleCells[0][1] } : null,
      provenRuleCells: proven.map(([key, result]) => ({ key, result })),
      successStandardMet: proven.length > 0,
    },
  };
}

module.exports = {
  PASSIVE_TTLS_SECONDS,
  ADVERSE_MOVE_THRESHOLDS_PCT,
  MARKOUT_HORIZONS_SECONDS,
  PASSIVE_POLICY,
  floorToTick,
  priceImprovementBucket,
  passivePriceProposals,
  createPassiveOrders,
  revalidatePassiveOrder,
  opposingTradeEvidence,
  marketableDepthEvidence,
  processPassiveOrder,
  executableEconomics,
  observeOrderEconomics,
  linkLeaderSell,
  summarizePnl,
  orderCohortSummary,
  summarizePassiveStudy,
};
