'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_ENDPOINT = 'https://gamma-api.polymarket.com/public-profile';
const ACTIVITY_ENDPOINT = 'https://data-api.polymarket.com/activity';
const CLOSED_POSITIONS_ENDPOINT = 'https://data-api.polymarket.com/closed-positions';

const DEFAULT_USERNAME = 'gabagool22';
const DEFAULT_PROXY_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNum(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function quantile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(sorted) {
  return quantile(sorted, 0.5);
}

function normalizeWallet(value) {
  return String(value || '').trim().toLowerCase();
}

function deriveOracleExpectedEdge(oracleSignal = {}) {
  const abs = (value) => {
    const n = toNum(value);
    return Number.isFinite(n) ? Math.abs(n) : NaN;
  };
  const initialBtcPrice = toNum(oracleSignal.initial_btc_price);
  const triggerBtcPrice = toNum(oracleSignal.trigger_btc_price);
  const currentBtcPrice = toNum(oracleSignal.current_btc_price);
  const currentVsInitial = Number.isFinite(initialBtcPrice) && initialBtcPrice > 0 && Number.isFinite(currentBtcPrice)
    ? Math.abs((currentBtcPrice - initialBtcPrice) / initialBtcPrice)
    : NaN;
  const currentVsTrigger = Number.isFinite(triggerBtcPrice) && triggerBtcPrice > 0 && Number.isFinite(currentBtcPrice)
    ? Math.abs((currentBtcPrice - triggerBtcPrice) / triggerBtcPrice)
    : NaN;
  const candidates = [
    abs(oracleSignal.lag_score),
    abs(oracleSignal.btc_persisted_move_pct),
    abs(oracleSignal.btc_trigger_move_pct),
    abs(oracleSignal.poly_mid_move_pct),
    abs(oracleSignal.poly_move_weight_limit_pct),
    currentVsInitial,
    currentVsTrigger,
  ]
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, value));
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), 'utf8');
  return resolved;
}

function toTimestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isBtcMarket(row = {}) {
  const haystack = `${row.title || ''} ${row.slug || ''} ${row.eventSlug || ''}`.toLowerCase();
  return /\bbitcoin\b|\bbtc\b/.test(haystack);
}

function titleRangeMinutes(title) {
  const match = String(title || '').match(
    /(\d{1,2}):(\d{2})(AM|PM)-(\d{1,2}):(\d{2})(AM|PM)\s+ET/i
  );
  if (!match) return null;

  const toMinutes = (hourRaw, minuteRaw, meridiemRaw) => {
    let hour = Number(hourRaw) % 12;
    const minute = Number(minuteRaw);
    const meridiem = String(meridiemRaw).toUpperCase();
    if (meridiem === 'PM') hour += 12;
    return hour * 60 + minute;
  };

  const start = toMinutes(match[1], match[2], match[3]);
  const end = toMinutes(match[4], match[5], match[6]);
  let diff = end - start;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function isBtcFiveMinuteMarket(row = {}) {
  if (!isBtcMarket(row)) return false;
  if (/btc-updown-5m-\d+/i.test(String(row.slug || ''))) return true;
  return titleRangeMinutes(row.title) === 5;
}

function marketWindowStartSec(row = {}) {
  const slugMatch = String(row.slug || '').match(/btc-updown-5m-(\d+)/i);
  if (slugMatch) return Number(slugMatch[1]);
  return null;
}

function entryWindowBucket(secondsIntoWindow) {
  if (!Number.isFinite(secondsIntoWindow)) return 'unknown';
  if (secondsIntoWindow < 100) return 'early';
  if (secondsIntoWindow < 200) return 'mid';
  return 'late';
}

function normalizeTradeRow(row = {}) {
  const timestampMs = toTimestampMs(row.timestamp);
  const price = toNum(row.price);
  const size = toNum(row.size);
  const sizeUsd = Number.isFinite(toNum(row.usdcSize))
    ? toNum(row.usdcSize)
    : Number.isFinite(price) && Number.isFinite(size)
      ? price * size
      : NaN;
  return {
    proxyWallet: String(row.proxyWallet || ''),
    timestampMs,
    timestampSec: Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : null,
    side: String(row.side || '').toUpperCase(),
    type: String(row.type || 'TRADE').toUpperCase(),
    price,
    size,
    sizeUsd,
    asset: String(row.asset || ''),
    conditionId: String(row.conditionId || ''),
    title: String(row.title || ''),
    slug: String(row.slug || ''),
    eventSlug: String(row.eventSlug || ''),
    outcome: String(row.outcome || ''),
    outcomeIndex: Number.isFinite(Number(row.outcomeIndex)) ? Number(row.outcomeIndex) : null,
    transactionHash: String(row.transactionHash || ''),
    name: String(row.name || ''),
    pseudonym: String(row.pseudonym || ''),
  };
}

function normalizeClosedPosition(row = {}) {
  const timestampMs = toTimestampMs(row.timestamp);
  return {
    proxyWallet: String(row.proxyWallet || ''),
    timestampMs,
    timestampSec: Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : null,
    asset: String(row.asset || ''),
    conditionId: String(row.conditionId || ''),
    avgPrice: toNum(row.avgPrice),
    totalBought: toNum(row.totalBought),
    realizedPnl: toNum(row.realizedPnl),
    curPrice: toNum(row.curPrice),
    title: String(row.title || ''),
    slug: String(row.slug || ''),
    eventSlug: String(row.eventSlug || ''),
    outcome: String(row.outcome || ''),
    outcomeIndex: Number.isFinite(Number(row.outcomeIndex)) ? Number(row.outcomeIndex) : null,
    oppositeOutcome: String(row.oppositeOutcome || ''),
    oppositeAsset: String(row.oppositeAsset || ''),
    endDate: String(row.endDate || ''),
  };
}

async function fetchJson(url, { timeoutMs = 8_000, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation unavailable');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'gabagool-btc-behavior/1.0',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProfileByAddress(address, opts = {}) {
  const url = new URL(PROFILE_ENDPOINT);
  url.searchParams.set('address', address);
  return fetchJson(url.toString(), opts);
}

async function fetchActivityTrades(address, lookbackTrades = 500, opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(lookbackTrades) || 500));
  const rows = [];
  for (let offset = 0; offset < lookbackTrades; offset += limit) {
    const pageSize = Math.max(1, Math.min(limit, lookbackTrades - offset));
    const url = new URL(ACTIVITY_ENDPOINT);
    url.searchParams.set('user', address);
    url.searchParams.set('type', 'TRADE');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    const payload = await fetchJson(url.toString(), opts);
    const page = Array.isArray(payload) ? payload : [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchClosedPositions(address, limit = 50, opts = {}) {
  const rows = [];
  const maxPerPage = 50;
  for (let offset = 0; offset < limit; offset += maxPerPage) {
    const pageSize = Math.max(1, Math.min(maxPerPage, limit - offset));
    const url = new URL(CLOSED_POSITIONS_ENDPOINT);
    url.searchParams.set('user', address);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('sortBy', 'TIMESTAMP');
    url.searchParams.set('sortDirection', 'DESC');
    const payload = await fetchJson(url.toString(), opts);
    const page = Array.isArray(payload) ? payload : [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function buildBehaviorModel({
  profile = null,
  activity = [],
  closedPositions = [],
  username = DEFAULT_USERNAME,
  expectedProxyWallet = DEFAULT_PROXY_WALLET,
  lookbackTrades = 500,
}) {
  const normalizedProfile = profile || {};
  const normalizedTrades = (Array.isArray(activity) ? activity : [])
    .map(normalizeTradeRow)
    .filter((row) => row.type === 'TRADE' && Number.isFinite(row.timestampMs));
  const normalizedClosed = (Array.isArray(closedPositions) ? closedPositions : [])
    .map(normalizeClosedPosition)
    .filter((row) => Number.isFinite(row.timestampMs));

  const resolvedProxyWallet = String(normalizedProfile.proxyWallet || expectedProxyWallet || '');
  const resolvedName = String(normalizedProfile.name || normalizedProfile.username || '').trim();
  const resolvedPseudonym = String(normalizedProfile.pseudonym || '').trim();
  const usernameMatched = resolvedName.toLowerCase() === String(username || '').toLowerCase();
  const walletMatched = normalizeWallet(resolvedProxyWallet) === normalizeWallet(expectedProxyWallet);

  const btcTrades = normalizedTrades.filter(isBtcMarket);
  const btcFiveMinuteTrades = btcTrades.filter(isBtcFiveMinuteMarket);
  const btcClosedPositions = normalizedClosed.filter(isBtcMarket);
  const btcFiveMinuteClosedPositions = btcClosedPositions.filter(isBtcFiveMinuteMarket);
  const observedSellTrades = btcFiveMinuteTrades.filter((row) => row.side === 'SELL');

  const entryPrices = btcFiveMinuteTrades.map((row) => row.price).filter(Number.isFinite).sort((a, b) => a - b);
  const entrySizesUsd = btcFiveMinuteTrades.map((row) => row.sizeUsd).filter(Number.isFinite).sort((a, b) => a - b);
  const inferredExitPrices = btcFiveMinuteClosedPositions.map((row) => row.curPrice).filter(Number.isFinite).sort((a, b) => a - b);

  const tradesByBurst = new Map();
  const marketOutcomeSets = new Map();
  const windowCounts = { early: 0, mid: 0, late: 0, unknown: 0 };
  const entrySeconds = [];
  const outcomeCounts = { Up: 0, Down: 0 };

  for (const trade of btcFiveMinuteTrades.slice().sort((a, b) => a.timestampMs - b.timestampMs)) {
    const burstKey = `${trade.slug}:${trade.asset}`;
    if (!tradesByBurst.has(burstKey)) tradesByBurst.set(burstKey, []);
    tradesByBurst.get(burstKey).push(trade);

    const marketKey = trade.slug || trade.conditionId;
    if (!marketOutcomeSets.has(marketKey)) marketOutcomeSets.set(marketKey, new Set());
    if (trade.outcome) marketOutcomeSets.get(marketKey).add(trade.outcome);

    const startSec = marketWindowStartSec(trade);
    const secondsIntoWindow = Number.isFinite(startSec) && Number.isFinite(trade.timestampSec)
      ? trade.timestampSec - startSec
      : null;
    if (Number.isFinite(secondsIntoWindow)) {
      entrySeconds.push(secondsIntoWindow);
      windowCounts[entryWindowBucket(secondsIntoWindow)] += 1;
    } else {
      windowCounts.unknown += 1;
    }

    if (trade.outcome === 'Up') outcomeCounts.Up += 1;
    if (trade.outcome === 'Down') outcomeCounts.Down += 1;
  }

  const holdProxySeconds = [...tradesByBurst.values()]
    .filter((burst) => burst.length > 1)
    .map((burst) => {
      const ordered = burst.slice().sort((a, b) => a.timestampMs - b.timestampMs);
      return Math.max(0, Math.round((ordered[ordered.length - 1].timestampMs - ordered[0].timestampMs) / 1000));
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const entrySecondsSorted = entrySeconds.slice().sort((a, b) => a - b);
  const repeatedSameTokenCycleCount = [...tradesByBurst.values()]
    .reduce((sum, burst) => sum + Math.max(0, burst.length - 1), 0);

  const sameMarketBothSidesCount = [...marketOutcomeSets.values()].filter((set) => set.size > 1).length;
  const directionalBiasDelta = btcFiveMinuteTrades.length > 0
    ? Math.abs(outcomeCounts.Up - outcomeCounts.Down) / btcFiveMinuteTrades.length
    : 0;
  const directionalBias = directionalBiasDelta >= 0.15
    ? (outcomeCounts.Up > outcomeCounts.Down ? 'up' : 'down')
    : 'none';

  const realizedPnls = btcFiveMinuteClosedPositions
    .map((row) => row.realizedPnl)
    .filter(Number.isFinite);
  const winCount = realizedPnls.filter((value) => value > 0).length;
  const lossCount = realizedPnls.filter((value) => value < 0).length;
  const realizedWinRate = realizedPnls.length > 0 ? winCount / realizedPnls.length : null;

  const windowRanking = Object.entries(windowCounts)
    .filter(([key]) => key !== 'unknown')
    .sort((a, b) => b[1] - a[1]);
  const mostCommonEntryWindow = windowRanking[0]?.[0] || 'unknown';

  const holdProxyMedian = median(holdProxySeconds);
  const holdProxyAvg = average(holdProxySeconds);
  const entryCutoffSec = clamp((quantile(entrySecondsSorted, 0.75) || 120) + 20, 60, 210);
  const timedExitSec = clamp(holdProxyMedian || 75, 30, 180);
  const lateExitSec = clamp(Math.max(entryCutoffSec + 30, timedExitSec), 90, 260);
  const observedSellBehavior = observedSellTrades.length > 0 ? 'observed_sell_activity' : 'no_public_sell_activity';
  const mostCommonExitTrigger = observedSellTrades.length > 0
    ? 'small_profit_or_reversal_observed'
    : btcFiveMinuteClosedPositions.length > 0
      ? 'near_expiry_or_resolution_inferred'
      : 'unobserved_exit';

  const sourceWarnings = [];
  if (!usernameMatched) sourceWarnings.push(`profile_name_mismatch:${resolvedName || 'missing'}`);
  if (!walletMatched) sourceWarnings.push(`proxy_wallet_mismatch:${resolvedProxyWallet || 'missing'}`);

  const model = {
    strategyName: 'GabagoolBtcOracleStrategy',
    generatedAt: new Date().toISOString(),
    source: {
      username: username || DEFAULT_USERNAME,
      expectedProxyWallet,
      resolvedProxyWallet,
      resolvedName,
      resolvedPseudonym,
      usernameMatched,
      walletMatched,
      warnings: sourceWarnings,
      profileEndpoint: PROFILE_ENDPOINT,
      activityEndpoint: ACTIVITY_ENDPOINT,
      closedPositionsEndpoint: CLOSED_POSITIONS_ENDPOINT,
    },
    diagnostics: {
      lookbackTradesRequested: lookbackTrades,
      tradesFetched: normalizedTrades.length,
      closedPositionsFetched: normalizedClosed.length,
      btcTrades: btcTrades.length,
      btcFiveMinuteTrades: btcFiveMinuteTrades.length,
      avgEntryPrice: round(average(entryPrices)),
      medianEntryPrice: round(median(entryPrices)),
      avgExitPrice: observedSellTrades.length > 0
        ? round(average(observedSellTrades.map((row) => row.price).filter(Number.isFinite)))
        : null,
      inferredAvgExitPrice: round(average(inferredExitPrices)),
      avgHoldSeconds: round(holdProxyAvg, 3),
      medianHoldSeconds: round(holdProxyMedian, 3),
      avgSizeUsd: round(average(entrySizesUsd)),
      medianSizeUsd: round(median(entrySizesUsd)),
      winLossProxy: {
        wins: winCount,
        losses: lossCount,
        winRate: round(realizedWinRate),
        basis: btcFiveMinuteClosedPositions.length > 0
          ? 'closed_positions_realized_pnl_on_btc_5m'
          : 'unavailable',
      },
      repeatedSameTokenCycleCount,
      sameMarketBothSidesCount,
      mostCommonEntryWindow,
      mostCommonExitTrigger,
      observedSellBehavior,
      entryWindowCounts: windowCounts,
      outcomeCounts,
    },
    strategyProfile: {
      marketType: 'btc_updown_5m',
      preferCurrentTargetMarket: true,
      requireFreshOracleSignal: true,
      requireLagConfirmed: true,
      requireBookValidity: true,
      allowSameMarketRepeats: true,
      allowSideSwitch: true,
      directionalBias,
      priceStyle: {
        entry: 'aggressive_touch',
        buyPriceSource: 'bestAsk',
        sellPriceSource: 'bestBid',
        entryPriceP25: round(quantile(entryPrices, 0.25)),
        entryPriceMedian: round(median(entryPrices)),
        entryPriceP75: round(quantile(entryPrices, 0.75)),
      },
      sizeStyle: {
        avgSizeUsd: round(average(entrySizesUsd)),
        medianSizeUsd: round(median(entrySizesUsd)),
        p75SizeUsd: round(quantile(entrySizesUsd, 0.75)),
      },
      timingStyle: {
        avgEntrySecondsIntoWindow: round(average(entrySecondsSorted)),
        medianEntrySecondsIntoWindow: round(median(entrySecondsSorted)),
        p75EntrySecondsIntoWindow: round(quantile(entrySecondsSorted, 0.75)),
        entryCutoffSec: round(entryCutoffSec),
        mostCommonEntryWindow,
      },
      holdStyle: {
        avgHoldSecondsProxy: round(holdProxyAvg),
        medianHoldSecondsProxy: round(holdProxyMedian),
        timedExitSec: round(timedExitSec),
        lateExitSec: round(lateExitSec),
      },
      repeatStyle: {
        repeatedSameTokenCycleCount,
        sameMarketBothSidesCount,
        maxEntriesPerFreshSignal: 3,
        requireFreshOracleSignal: true,
        requireValidBook: true,
      },
      exitStyle: {
        mostCommonExitTrigger,
        onOracleReversal: true,
        onSignalStale: true,
        onLateWindow: true,
        onTimedHold: true,
      },
    },
  };

  return model;
}

async function refreshBehaviorModel({
  username = DEFAULT_USERNAME,
  expectedProxyWallet = DEFAULT_PROXY_WALLET,
  lookbackTrades = 500,
  closedPositionLimit = 50,
  outputPath = null,
  fetchImpl = global.fetch,
} = {}) {
  const profile = await fetchProfileByAddress(expectedProxyWallet, { fetchImpl });
  const activity = await fetchActivityTrades(expectedProxyWallet, lookbackTrades, { fetchImpl });
  const closedPositions = await fetchClosedPositions(expectedProxyWallet, closedPositionLimit, { fetchImpl });
  const model = buildBehaviorModel({
    profile,
    activity,
    closedPositions,
    username,
    expectedProxyWallet,
    lookbackTrades,
  });
  if (outputPath) writeJsonFile(outputPath, model);
  return model;
}

function loadOracleSignalFile(filePath) {
  const signal = readJsonFile(filePath, null);
  if (!signal || typeof signal !== 'object') return null;
  return signal;
}

function loadOracleTargetFile(filePath) {
  const payload = readJsonFile(filePath, null);
  if (!payload || typeof payload !== 'object' || !payload.target) return null;
  return payload;
}

function buildEntryPlan({
  model,
  oracleSignal,
  oracleTarget,
  book,
  now = Date.now(),
  maxPaperOrderUsd = 1,
  currentPositionUsd = 0,
  minEdge = 0.008,
  minExpectedEdge = 0.0001,
  minPrice = 0.02,
  maxPrice = 0.98,
  maxSpread = 0.12,
  depthFloorUsd = 5,
} = {}) {
  if (!model) return { blockReason: 'missing_behavior_model' };
  if (!oracleSignal) return { blockReason: 'missing_oracle_signal' };
  if (!oracleTarget?.target) return { blockReason: 'missing_oracle_target' };
  const tokenId = String(oracleSignal.token_id || '');
  if (!tokenId) return { blockReason: 'invalid_token_id' };

  const target = oracleTarget.target;
  const targetMarket = {
    title: String(target.question || ''),
    slug: String(target.slug || ''),
    eventSlug: String(target.slug || ''),
  };
  if (!isBtcMarket(targetMarket)) {
    return { blockReason: 'non_btc_market' };
  }
  if (!isBtcFiveMinuteMarket(targetMarket)) {
    return { blockReason: 'stale_market' };
  }
  const freshUntilMs = Date.parse(String(oracleSignal.expires_at || ''));
  if (!Number.isFinite(freshUntilMs) || freshUntilMs <= now) {
    return { blockReason: 'oracle_signal_expired' };
  }
  const confirmCheck = oracleSignal.gabagoolConfirmCheck || oracleSignal.confirmCheck || null;
  if (confirmCheck && confirmCheck.confirmed !== true) {
    return { blockReason: confirmCheck.blockReason || 'oracle_signal_not_confirmed' };
  }
  if (
    Object.prototype.hasOwnProperty.call(oracleSignal, 'confirmed') &&
    oracleSignal.confirmed !== true
  ) {
    return { blockReason: 'oracle_signal_not_confirmed' };
  }
  const upToken = String(target.BTC_UP_TOKEN_ID || '');
  const downToken = String(target.BTC_DOWN_TOKEN_ID || '');
  if (tokenId !== upToken && tokenId !== downToken) {
    return { blockReason: 'invalid_token_id' };
  }
  const direction = String(oracleSignal.direction || '').toUpperCase();
  if (!['UP', 'DOWN'].includes(direction)) {
    return { blockReason: 'invalid_outcome' };
  }
  const outcome = tokenId === upToken ? 'Up' : 'Down';
  const directionOutcome = direction === 'UP' ? 'Up' : 'Down';
  if (outcome !== directionOutcome) {
    return { blockReason: 'invalid_outcome' };
  }
  if (!book || !Number.isFinite(book.bestAsk) || !Number.isFinite(book.bestBid)) {
    return { blockReason: 'invalid_price' };
  }
  const price = Number(book.bestAsk);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { blockReason: 'invalid_price' };
  }
  if (
    (Number.isFinite(minPrice) && price < minPrice) ||
    (Number.isFinite(maxPrice) && price > maxPrice)
  ) {
    return { blockReason: 'invalid_price' };
  }
  const topBidUsd = (book.bids || []).slice(0, 1).reduce((sum, level) => sum + (Number(level.price) * Number(level.size)), 0);
  const topAskUsd = (book.asks || []).slice(0, 1).reduce((sum, level) => sum + (Number(level.price) * Number(level.size)), 0);
  if (!Number.isFinite(book.spread) || book.spread > maxSpread) {
    return { blockReason: 'spread_cap' };
  }
  if (Math.min(topBidUsd, topAskUsd) < depthFloorUsd) {
    return { blockReason: 'depth_floor' };
  }

  const startSec = Number(target.ts || 0);
  const secondsIntoWindow = startSec > 0 ? Math.max(0, Math.floor(now / 1000) - startSec) : null;
  if (Number.isFinite(secondsIntoWindow) && secondsIntoWindow >= 300) {
    return { blockReason: 'stale_market', secondsIntoWindow };
  }
  const entryCutoffSec = Number(model.strategyProfile?.timingStyle?.entryCutoffSec || 180);
  if (Number.isFinite(secondsIntoWindow) && secondsIntoWindow > entryCutoffSec) {
    return { blockReason: 'late_entry_window', secondsIntoWindow, entryCutoffSec };
  }

  const cappedSizeUsd = Math.max(0, Math.min(
    Number(model.strategyProfile?.sizeStyle?.medianSizeUsd || maxPaperOrderUsd),
    Number(maxPaperOrderUsd || 1)
  ));
  if (cappedSizeUsd <= 0) return { blockReason: 'invalid_size_cap' };

  const perTokenMaxExposureUsd = Math.max(cappedSizeUsd, cappedSizeUsd * 3);
  if (currentPositionUsd + cappedSizeUsd > perTokenMaxExposureUsd) {
    return { blockReason: 'per_token_repeat_cap', currentPositionUsd, perTokenMaxExposureUsd };
  }

  const oracleConfidence = clamp(Number(oracleSignal.confidence || 0.5), 0.35, 0.95);
  const derivedExpectedEdge = deriveOracleExpectedEdge(oracleSignal);
  if (!Number.isFinite(derivedExpectedEdge) || derivedExpectedEdge < minExpectedEdge) {
    return { blockReason: 'expected_edge_zero' };
  }
  const timeBoost = Number.isFinite(secondsIntoWindow) && secondsIntoWindow <= 60 ? 1.05 : 0.95;
  const confidence = clamp(oracleConfidence * timeBoost, 0.35, 0.95);
  const expectedEdge = Math.max(derivedExpectedEdge, minExpectedEdge);
  const ttlMs = Math.max(1_000, Math.min(freshUntilMs - now, 12_000));

  return {
    plan: {
      tokenId,
      marketId: String(target.rawMarketId || target.slug || ''),
      marketSlug: String(target.slug || ''),
      marketQuestion: String(target.question || ''),
      outcome,
      side: 'buy',
      price: round(price),
      sizeUsd: round(cappedSizeUsd, 2),
      expectedEdge: round(expectedEdge),
      confidence: round(confidence),
      ttlMs,
      maxHoldMs: Math.max(15_000, Number(model.strategyProfile?.holdStyle?.timedExitSec || 75) * 1000),
      reason: `gabagool-style btc oracle entry outcome=${outcome} secIntoWindow=${Number.isFinite(secondsIntoWindow) ? secondsIntoWindow : 'na'} oracleConfirmed=true`,
      exitPlan: 'Exit on oracle reversal, stale signal, timed hold, or late-window cleanup',
      metadata: {
        direction: String(oracleSignal.direction || '').toUpperCase(),
        marketSlug: String(target.slug || ''),
        marketQuestion: String(target.question || ''),
        outcome,
        secondsIntoWindow,
        signalExpiresAt: oracleSignal.expires_at,
        lagScore: round(derivedExpectedEdge),
        sourceWallet: model.source?.resolvedProxyWallet || DEFAULT_PROXY_WALLET,
        behaviorModelGeneratedAt: model.generatedAt,
        gabagoolObservedSellBehavior: model.diagnostics?.observedSellBehavior || 'unknown',
      },
    },
  };
}

function buildExitPlan({
  model,
  tokenId,
  positionQty,
  avgCost,
  lastFillTs,
  oracleSignal,
  oracleTarget,
  book,
  now = Date.now(),
  minEdge = 0.008,
} = {}) {
  if (!model || !oracleTarget?.target || !book) return { blockReason: 'missing_exit_inputs' };
  if (!Number.isFinite(positionQty) || positionQty <= 0) return { blockReason: 'no_position' };
  if (!Number.isFinite(avgCost) || avgCost <= 0) return { blockReason: 'invalid_avg_cost' };
  if (!Number.isFinite(book.bestBid) || book.bestBid <= 0) return { blockReason: 'invalid_exit_book' };

  const target = oracleTarget.target;
  const currentSignalToken = String(oracleSignal?.token_id || '');
  const holdingMs = Number.isFinite(lastFillTs) ? Math.max(0, now - lastFillTs) : null;
  const timedExitMs = Number(model.strategyProfile?.holdStyle?.timedExitSec || 75) * 1000;
  const lateExitSec = Number(model.strategyProfile?.holdStyle?.lateExitSec || 180);
  const secondsIntoWindow = Number.isFinite(Number(target.ts))
    ? Math.max(0, Math.floor(now / 1000) - Number(target.ts))
    : null;

  let trigger = null;
  if (!oracleSignal) trigger = 'signal_missing';
  else if (Date.parse(String(oracleSignal.expires_at || '')) <= now) trigger = 'signal_stale';
  else if (currentSignalToken && currentSignalToken !== String(tokenId)) trigger = 'oracle_reversal';
  else if (Number.isFinite(secondsIntoWindow) && secondsIntoWindow >= lateExitSec) trigger = 'late_window';
  else if (Number.isFinite(holdingMs) && holdingMs >= timedExitMs) trigger = 'timed_hold';
  else if (Number.isFinite(book.midpoint) && book.midpoint >= avgCost * 1.02) trigger = 'small_profit';

  if (!trigger) return { blockReason: 'exit_not_ready' };

  const currentValueUsd = positionQty * book.bestBid;
  const expectedEdge = Math.max(minEdge, Math.abs(book.bestBid - avgCost));
  const confidence = clamp(
    trigger === 'oracle_reversal' ? 0.78 :
      trigger === 'small_profit' ? 0.72 :
        trigger === 'late_window' ? 0.68 : 0.62,
    0.35,
    0.95
  );
  const outcome = String(target.BTC_UP_TOKEN_ID || '') === String(tokenId) ? 'Up' : 'Down';

  return {
    plan: {
      tokenId: String(tokenId),
      marketId: String(target.rawMarketId || target.slug || ''),
      marketSlug: String(target.slug || ''),
      marketQuestion: String(target.question || ''),
      outcome,
      side: 'sell',
      price: round(Number(book.bestBid)),
      sizeUsd: round(currentValueUsd, 2),
      expectedEdge: round(expectedEdge),
      confidence: round(confidence),
      ttlMs: 10_000,
      maxHoldMs: 20_000,
      reason: `gabagool-style btc oracle exit trigger=${trigger}`,
      exitPlan: `Exit trigger=${trigger}`,
      metadata: {
        direction: String(oracleSignal?.direction || '').toUpperCase(),
        marketSlug: String(target.slug || ''),
        marketQuestion: String(target.question || ''),
        outcome,
        trigger,
        secondsIntoWindow,
        holdingMs,
        sourceWallet: model.source?.resolvedProxyWallet || DEFAULT_PROXY_WALLET,
      },
    },
  };
}

module.exports = {
  PROFILE_ENDPOINT,
  ACTIVITY_ENDPOINT,
  CLOSED_POSITIONS_ENDPOINT,
  DEFAULT_USERNAME,
  DEFAULT_PROXY_WALLET,
  buildBehaviorModel,
  buildEntryPlan,
  buildExitPlan,
  fetchActivityTrades,
  fetchClosedPositions,
  fetchProfileByAddress,
  isBtcMarket,
  isBtcFiveMinuteMarket,
  deriveOracleExpectedEdge,
  loadOracleSignalFile,
  loadOracleTargetFile,
  readJsonFile,
  refreshBehaviorModel,
  writeJsonFile,
};
