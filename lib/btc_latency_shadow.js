'use strict';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function levels(input, descending) {
  return [...(input || [])]
    .map((level) => ({ price: number(level.price), size: number(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

function normalizeBook(raw = {}, observedAtMs = Date.now()) {
  const bids = levels(raw.bids, true);
  const asks = levels(raw.asks, false);
  return {
    tokenId: String(raw.asset_id || raw.assetId || raw.tokenId || ''),
    marketId: String(raw.market || raw.marketId || ''),
    observedAtMs,
    sourceTimestampMs: number(raw.timestamp),
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    midpoint: bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : null,
    spread: bids[0] && asks[0] ? asks[0].price - bids[0].price : null,
    minOrderSizeShares: number(raw.min_order_size ?? raw.minOrderSize),
    tickSize: number(raw.tick_size ?? raw.tickSize),
    hash: String(raw.hash || ''),
  };
}

function applyMarketMessage(previous, message, observedAtMs = Date.now()) {
  if (message.event_type === 'book') {
    const normalized = normalizeBook(message, observedAtMs);
    return {
      ...normalized,
      minOrderSizeShares: normalized.minOrderSizeShares ?? previous?.minOrderSizeShares ?? null,
      tickSize: normalized.tickSize ?? previous?.tickSize ?? null,
    };
  }
  if (!previous) return null;
  const next = { ...previous, observedAtMs, sourceTimestampMs: number(message.timestamp) };
  const bidMap = new Map(previous.bids.map((x) => [x.price, x.size]));
  const askMap = new Map(previous.asks.map((x) => [x.price, x.size]));
  if (message.event_type === 'price_change') {
    for (const change of message.price_changes || []) {
      const price = number(change.price);
      const size = number(change.size);
      const map = String(change.side).toUpperCase() === 'BUY' ? bidMap : askMap;
      if (price === null || size === null) continue;
      if (size <= 0) map.delete(price); else map.set(price, size);
    }
  }
  next.bids = levels([...bidMap].map(([price, size]) => ({ price, size })), true);
  next.asks = levels([...askMap].map(([price, size]) => ({ price, size })), false);
  next.bestBid = next.bids[0]?.price ?? number(message.best_bid) ?? previous.bestBid;
  next.bestAsk = next.asks[0]?.price ?? number(message.best_ask) ?? previous.bestAsk;
  if (message.event_type === 'best_bid_ask') {
    next.bestBid = number(message.best_bid) ?? next.bestBid;
    next.bestAsk = number(message.best_ask) ?? next.bestAsk;
  }
  next.midpoint = next.bestBid && next.bestAsk ? (next.bestBid + next.bestAsk) / 2 : null;
  next.spread = next.bestBid && next.bestAsk ? next.bestAsk - next.bestBid : null;
  return next;
}

function walk(levelList, shares) {
  if (!(shares > 0)) return { sufficient: false, sharesFilled: 0, averagePrice: null, notionalUsd: 0 };
  let remaining = shares;
  let cost = 0;
  for (const level of levelList || []) {
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  const filled = shares - remaining;
  return { sufficient: remaining <= 1e-9, sharesFilled: filled, averagePrice: filled ? cost / filled : null, notionalUsd: cost };
}

function feeUsd(shares, price, feeRate, feeExponent) {
  if (![shares, price, feeRate, feeExponent].every(Number.isFinite)) return null;
  return Math.max(0, shares * feeRate * (price * (1 - price)) ** feeExponent);
}

function markout({ entryBook, exitBook, targetUsd = 1, feeRate, feeExponent }) {
  if (!entryBook?.bestAsk || !exitBook?.bestBid) return { scorable: false, reason: 'missing_executable_book' };
  if (!Number.isFinite(feeRate) || !Number.isFinite(feeExponent)) return { scorable: false, reason: 'fee_metadata_unknown' };
  const shares = targetUsd / entryBook.bestAsk;
  const entry = walk(entryBook.asks, shares);
  const exit = walk(exitBook.bids, shares);
  if (!entry.sufficient || !exit.sufficient) return { scorable: false, reason: 'insufficient_displayed_depth', shares };
  const entryFee = feeUsd(shares, entry.averagePrice, feeRate, feeExponent);
  const exitFee = feeUsd(shares, exit.averagePrice, feeRate, feeExponent);
  const rawMidpointPnlPerUsd = Number.isFinite(entryBook.midpoint) && Number.isFinite(exitBook.midpoint)
    ? (exitBook.midpoint - entryBook.midpoint) * shares / targetUsd : null;
  const grossExecutablePnl = exit.notionalUsd - entry.notionalUsd;
  return {
    scorable: true,
    shares,
    entryPrice: entry.averagePrice,
    exitPrice: exit.averagePrice,
    entryFee,
    exitFee,
    fees: entryFee + exitFee,
    rawMidpointPnlPerUsd,
    grossExecutablePnlPerUsd: grossExecutablePnl / targetUsd,
    netExecutablePnlPerUsd: (grossExecutablePnl - entryFee - exitFee) / targetUsd,
  };
}

function complement({ upBook, downBook, shares, upFee, downFee }) {
  if (!(shares > 0)) return { scorable: false, reason: 'invalid_shares' };
  if (!upFee || !downFee || ![upFee.rate, upFee.exponent, downFee.rate, downFee.exponent].every(Number.isFinite)) {
    return { scorable: false, reason: 'fee_metadata_unknown' };
  }
  const up = walk(upBook?.asks, shares);
  const down = walk(downBook?.asks, shares);
  if (!up.sufficient || !down.sufficient) return { scorable: false, reason: 'insufficient_displayed_depth' };
  const fees = feeUsd(shares, up.averagePrice, upFee.rate, upFee.exponent)
    + feeUsd(shares, down.averagePrice, downFee.rate, downFee.exponent);
  const rawEdgeUsd = shares - up.notionalUsd - down.notionalUsd;
  return { scorable: true, rawEdgeUsd, fees, netEdgeUsd: rawEdgeUsd - fees, netEdgePerShare: (rawEdgeUsd - fees) / shares };
}

function firstAtOrAfter(ring, timestampMs) {
  return (ring || []).find((item) => item.observedAtMs >= timestampMs) || null;
}

// Newest observation at or before `timestampMs`; null when nothing precedes it.
// Mirrors firstAtOrAfter for the "quote on screen at T0" entry convention.
// Rings are appended in ascending observedAtMs order, so a reverse scan is exact.
function lastAtOrBefore(ring, timestampMs) {
  const list = ring || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].observedAtMs <= timestampMs) return list[i];
  }
  return null;
}

// Aggregate displayed notional across at most `maxLevels` price levels.
function shallowDepthUsd(levelList, maxLevels = 10) {
  let total = 0;
  for (const level of (levelList || []).slice(0, maxLevels)) {
    if (Number.isFinite(level?.price) && Number.isFinite(level?.size)) total += level.price * level.size;
  }
  return total;
}

function orderBookImbalance(bidList, askList, maxLevels = 10) {
  const bid = shallowDepthUsd(bidList, maxLevels);
  const ask = shallowDepthUsd(askList, maxLevels);
  const denom = bid + ask;
  return denom > 0 ? (bid - ask) / denom : 0;
}

/**
 * Compact a live book into the minimum state a historical ring entry needs to
 * support executable markouts, depth/min-order feasibility and OBI.
 *
 * Retains a TRUNCATED ladder rather than the full one. Truncation is safe in
 * the conservative direction only: `walk()` reports `sufficient: false` when it
 * exhausts the retained levels, so a truncated ladder can under-report
 * feasibility but can never fabricate a fill that the full book would not have
 * supported. `laddersTruncated` records when truncation actually discarded
 * levels so a consumer can tell the two cases apart.
 */
function compactBookSnapshot(book, { maxLevels = 10 } = {}) {
  if (!book) return null;
  const bids = (book.bids || []).slice(0, maxLevels);
  const asks = (book.asks || []).slice(0, maxLevels);
  return {
    tokenId: book.tokenId,
    observedAtMs: book.observedAtMs,
    sourceTimestampMs: book.sourceTimestampMs ?? null,
    bestBid: book.bestBid ?? null,
    bestAsk: book.bestAsk ?? null,
    midpoint: book.midpoint ?? null,
    spread: book.spread ?? null,
    minOrderSizeShares: book.minOrderSizeShares ?? null,
    tickSize: book.tickSize ?? null,
    bids,
    asks,
    bidDepthUsd: shallowDepthUsd(bids, maxLevels),
    askDepthUsd: shallowDepthUsd(asks, maxLevels),
    obi: orderBookImbalance(bids, asks, maxLevels),
    retainedLevels: maxLevels,
    laddersTruncated: (book.bids || []).length > maxLevels || (book.asks || []).length > maxLevels,
  };
}

/**
 * Bound a ring by BOTH age and snapshot count. Mutates and returns the ring.
 * Oldest entries are dropped first, so no-lookahead ordering is preserved.
 */
function boundRing(ring, { maxAgeMs = 180_000, maxCount = 4_000, nowMs = Date.now() } = {}) {
  if (!Array.isArray(ring)) return ring;
  while (ring.length && ring[0].observedAtMs < nowMs - maxAgeMs) ring.shift();
  while (ring.length > maxCount) ring.shift();
  return ring;
}

function partitionPriceChanges(message = {}) {
  const result = new Map();
  for (const change of message.price_changes || []) {
    const token = String(change.asset_id || '');
    if (!token) continue;
    const changes = result.get(token) || [];
    changes.push(change); result.set(token, changes);
  }
  return result;
}

function stats(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return { n: 0, mean: null, median: null, min: null, max: null };
  return { n: clean.length, mean: clean.reduce((a, b) => a + b, 0) / clean.length, median: clean[Math.floor(clean.length / 2)], min: clean[0], max: clean.at(-1) };
}

module.exports = {
  normalizeBook, applyMarketMessage, partitionPriceChanges, walk, feeUsd, markout, complement,
  firstAtOrAfter, lastAtOrBefore, stats, shallowDepthUsd, orderBookImbalance,
  compactBookSnapshot, boundRing,
};
