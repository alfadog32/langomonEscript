'use strict';

const { walk, feeUsd } = require('./btc_latency_shadow');

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(',').map((item) => item.trim());
  }
}

function breakEvenResolutionProbability(price, feeRate, feeExponent, feeApplies = true) {
  const p = finite(price);
  if (!(p > 0 && p < 1)) return null;
  if (!feeApplies) return p;
  const rate = finite(feeRate);
  const exponent = finite(feeExponent);
  if (rate === null || exponent === null) return null;
  return p + rate * ((p * (1 - p)) ** exponent);
}

function consumedDepth(levels, shares) {
  let remaining = shares;
  let levelsUsed = 0;
  let worstPrice = null;
  for (const level of levels || []) {
    if (!(remaining > 1e-9)) break;
    const take = Math.min(remaining, Number(level.size) || 0);
    if (!(take > 0)) continue;
    remaining -= take;
    levelsUsed += 1;
    worstPrice = Number(level.price);
  }
  return { levelsUsed, worstPriceReached: worstPrice };
}

function evaluateVenueMinimumEntry(book, feeMeta) {
  const shares = finite(book?.minOrderSize);
  if (book?.minOrderSizeReported !== true || !(shares > 0)) {
    return { ok: false, reason: 'venue_minimum_unreported' };
  }
  const execution = walk(book.asks, shares);
  if (!execution.sufficient) {
    return { ok: false, reason: 'insufficient_executable_ask_depth', shares, execution };
  }
  if (!feeMeta || feeMeta.source !== 'official_clob_market_info') {
    return { ok: false, reason: 'official_fee_metadata_unavailable', shares, execution };
  }
  const fee = feeUsd(shares, execution.averagePrice, Number(feeMeta.rate), Number(feeMeta.exponent));
  if (!Number.isFinite(fee)) {
    return { ok: false, reason: 'official_fee_metadata_invalid', shares, execution };
  }
  const requiredNotionalUsd = execution.notionalUsd;
  const requiredCapitalUsd = requiredNotionalUsd + fee;
  const depth = consumedDepth(book.asks, shares);
  return {
    ok: true,
    reason: null,
    shares,
    executablePrice: execution.averagePrice,
    requiredNotionalUsd,
    entryFeeUsd: fee,
    requiredCapitalUsd,
    levelsUsed: depth.levelsUsed,
    worstPriceReached: depth.worstPriceReached,
    breakEvenProbability: breakEvenResolutionProbability(
      execution.averagePrice,
      Number(feeMeta.rate),
      Number(feeMeta.exponent),
      true
    ),
  };
}

function reliableResolutionEvidence(market, expectedOutcome) {
  if (!market || market.closed !== true) return { resolved: false, reason: 'market_not_closed' };
  const acceptingOrdersKnown = Object.prototype.hasOwnProperty.call(market, 'acceptingOrders')
    || Object.prototype.hasOwnProperty.call(market, 'accepting_orders');
  if (!acceptingOrdersKnown) return { resolved: false, reason: 'accepting_orders_evidence_missing' };
  if (market.acceptingOrders === true || market.accepting_orders === true) {
    return { resolved: false, reason: 'market_still_accepting_orders' };
  }
  const resolutionStatus = String(market.umaResolutionStatus || market.resolutionStatus || '').toLowerCase();
  if (resolutionStatus && resolutionStatus !== 'resolved') {
    return { resolved: false, reason: 'market_resolution_pending' };
  }
  const outcomes = parseArray(market.outcomes).map(String);
  const prices = parseArray(market.outcomePrices || market.outcome_prices).map(finite);
  if (outcomes.length < 2 || prices.length !== outcomes.length || prices.some((price) => price === null)) {
    return { resolved: false, reason: 'terminal_prices_unavailable' };
  }
  const winners = prices.map((price, index) => ({ price, index })).filter((item) => item.price === 1);
  const losers = prices.filter((price) => price === 0);
  if (winners.length !== 1 || losers.length !== prices.length - 1) {
    return { resolved: false, reason: 'terminal_prices_not_decisive' };
  }
  const winnerOutcome = outcomes[winners[0].index];
  const expectedIndex = outcomes.findIndex((outcome) => outcome === String(expectedOutcome));
  if (expectedIndex < 0) return { resolved: false, reason: 'observed_outcome_missing' };
  const resolvedAtMs = Date.parse(
    market.closedTime || market.closed_time || market.resolvedAt || market.resolved_at || market.updatedAt || ''
  );
  if (!Number.isFinite(resolvedAtMs)) return { resolved: false, reason: 'resolution_closed_time_missing' };
  return {
    resolved: true,
    reason: null,
    winnerOutcome,
    observedOutcome: String(expectedOutcome),
    correct: winnerOutcome === String(expectedOutcome),
    terminalPrices: Object.fromEntries(outcomes.map((outcome, index) => [outcome, prices[index]])),
    resolvedAtMs,
    source: 'gamma_closed_not_accepting_orders_exact_terminal_prices',
  };
}

function scoreResolution(observation, evidence, scoredAtMs = Date.now()) {
  if (!observation?.entryEconomics?.ok || !evidence?.resolved) return null;
  const entry = observation.entryEconomics;
  const payoutUsd = evidence.correct ? entry.shares : 0;
  const netPnlUsd = payoutUsd - entry.requiredCapitalUsd;
  return {
    scoredAt: new Date(scoredAtMs).toISOString(),
    correct: evidence.correct,
    winnerOutcome: evidence.winnerOutcome,
    payoutUsd,
    entryNotionalUsd: entry.requiredNotionalUsd,
    feesUsd: entry.entryFeeUsd,
    netPnlUsd,
    roi: entry.requiredCapitalUsd > 0 ? netPnlUsd / entry.requiredCapitalUsd : null,
    maximumAdverseLossUsd: -entry.requiredCapitalUsd,
    signalToResolutionMs: Number.isFinite(evidence.resolvedAtMs)
      ? Math.max(0, evidence.resolvedAtMs - Date.parse(observation.timestamp))
      : Math.max(0, scoredAtMs - Date.parse(observation.timestamp)),
    evidence,
  };
}

function scoreForwardBidMark(observation, book, feeMeta, targetAtMs, observedAtMs = Date.now()) {
  if (!observation?.entryEconomics?.ok) return { ok: false, reason: 'entry_economics_unavailable' };
  const shares = observation.entryEconomics.shares;
  const exit = walk(book?.bids || [], shares);
  if (!exit.sufficient) return { ok: false, reason: 'insufficient_executable_bid_depth', targetAtMs, observedAtMs };
  if (!feeMeta || feeMeta.source !== 'official_clob_market_info') {
    return { ok: false, reason: 'official_fee_metadata_unavailable', targetAtMs, observedAtMs };
  }
  const exitFeeUsd = feeUsd(shares, exit.averagePrice, Number(feeMeta.rate), Number(feeMeta.exponent));
  if (!Number.isFinite(exitFeeUsd)) return { ok: false, reason: 'official_fee_metadata_invalid', targetAtMs, observedAtMs };
  const proceedsUsd = exit.notionalUsd - exitFeeUsd;
  const netPnlUsd = proceedsUsd - observation.entryEconomics.requiredCapitalUsd;
  return {
    ok: true,
    reason: null,
    targetAtMs,
    observedAtMs,
    noLookaheadDelayMs: Math.max(0, observedAtMs - targetAtMs),
    shares,
    executableBidPrice: exit.averagePrice,
    grossProceedsUsd: exit.notionalUsd,
    exitFeeUsd,
    netProceedsUsd: proceedsUsd,
    netPnlUsd,
    roi: observation.entryEconomics.requiredCapitalUsd > 0
      ? netPnlUsd / observation.entryEconomics.requiredCapitalUsd
      : null,
  };
}

function opportunityKey(value) {
  return [value?.marketId, value?.tokenId, value?.outcome].map((item) => String(item || '')).join(':');
}

function capitalClassification(observation) {
  if (!observation?.entryEconomics?.ok || !observation?.resolutionScore) return 'D_UNRESOLVED_OR_INSUFFICIENT';
  const positive = Number(observation.resolutionScore.netPnlUsd) > 0;
  const fits = observation.venueMinimumRisk?.passed === true;
  if (fits) return 'C_VENUE_MINIMUM_FITS_CAPS';
  return positive
    ? 'A_POSITIVE_RESOLVED_PNL_BUT_CAP_BLOCKED'
    : 'B_CAP_BLOCKED_AND_NOT_ECONOMICALLY_JUSTIFIED';
}

module.exports = {
  breakEvenResolutionProbability,
  capitalClassification,
  evaluateVenueMinimumEntry,
  opportunityKey,
  reliableResolutionEvidence,
  scoreForwardBidMark,
  scoreResolution,
};
