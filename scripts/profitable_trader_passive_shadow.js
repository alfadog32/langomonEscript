#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_POLICY,
  normalizeTraderEvent,
  aggregateTraderEvents,
  calculateConsensus,
  normalizeBook,
  buildFollowerCandidate,
} = require('../lib/profitable_trader_consensus');
const {
  fetchWalletActivity,
  fetchOrderBook,
  fetchClobMarketInfo,
  fetchMarketTrades,
} = require('../lib/profitable_trader_readonly');
const {
  MARKOUT_HORIZONS_SECONDS,
  createPassiveOrders,
  processPassiveOrder,
  observeOrderEconomics,
  linkLeaderSell,
  summarizePassiveStudy,
} = require('../lib/profitable_trader_passive');
const {
  feeParameters,
  copyScreeningEligible,
} = require('./profitable_trader_shadow');

const DEFAULT_BASELINE = '/tmp/profitable_trader_shadow_broad_90m.json';

function parseArgs(argv) {
  const args = {
    baseline: DEFAULT_BASELINE,
    output: '/tmp/profitable_trader_passive_shadow.json',
    minObserveSeconds: 1_800,
    maxObserveSeconds: 2_700,
    activityPollMs: 4_000,
    bookPollMs: 1_000,
    maxWallets: 12,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--baseline') args.baseline = value, index += 1;
    else if (arg === '--output') args.output = value, index += 1;
    else if (arg === '--min-observe-seconds') args.minObserveSeconds = Number(value), index += 1;
    else if (arg === '--max-observe-seconds') args.maxObserveSeconds = Number(value), index += 1;
    else if (arg === '--activity-poll-ms') args.activityPollMs = Number(value), index += 1;
    else if (arg === '--book-poll-ms') args.bookPollMs = Number(value), index += 1;
    else if (arg === '--max-wallets') args.maxWallets = Number(value), index += 1;
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['minObserveSeconds', 'maxObserveSeconds', 'activityPollMs', 'bookPollMs', 'maxWallets']) {
    if (!Number.isFinite(args[key])) throw new Error(`invalid ${key}`);
  }
  args.minObserveSeconds = Math.max(1_800, Math.min(2_700, Math.floor(args.minObserveSeconds)));
  args.maxObserveSeconds = Math.max(args.minObserveSeconds, Math.min(2_700, Math.floor(args.maxObserveSeconds)));
  args.activityPollMs = Math.max(2_000, Math.min(30_000, Math.floor(args.activityPollMs)));
  args.bookPollMs = Math.max(500, Math.min(5_000, Math.floor(args.bookPollMs)));
  args.maxWallets = Math.max(1, Math.min(20, Math.floor(args.maxWallets)));
  for (const key of ['baseline', 'output']) {
    const resolved = path.resolve(String(args[key] || ''));
    if (!(resolved === '/tmp' || resolved.startsWith('/tmp/'))) {
      throw new Error(`${key} must remain under /tmp for research-only isolation`);
    }
    args[key] = resolved;
  }
  return args;
}

function help() {
  process.stdout.write([
    'Public-GET-only passive profitable-trader forward shadow.',
    '',
    'node scripts/profitable_trader_passive_shadow.js [options]',
    '  --baseline PATH             prior taker artifact under /tmp',
    '  --output PATH               isolated result under /tmp',
    '  --min-observe-seconds N     enforced minimum 1800',
    '  --max-observe-seconds N     enforced maximum 2700',
    '  --activity-poll-ms N        leader feed polling, minimum 2000',
    '  --book-poll-ms N            passive-book polling, minimum 500',
    '  --max-wallets N             pre-registered baseline wallets, maximum 20',
    '',
    'The process cannot place paper or live orders and never imports production execution code.',
  ].join('\n'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function baselineTakerSummary(payload) {
  const shadow = payload?.summary?.shadow || {};
  const cohort = shadow.cohorts?.financiallyQualifiedIndividuallyCopyable || {};
  return {
    source: 'pre_registered_90_minute_forward_taker_baseline',
    startedAt: shadow.startedAt,
    endedAt: shadow.endedAt,
    walletsScreened: payload?.summary?.discovery?.walletsScreened,
    financiallyQualifiedWallets: payload?.summary?.discovery?.qualifiedWallets,
    selectedWallets: payload?.summary?.discovery?.observedWallets?.length,
    leaderEvents: shadow.leaderSignals,
    buyEvents: shadow.buySignals,
    qualifiedCopyableBuys: shadow.copyScreeningEligibleBuys,
    qualifiedBuyWallets: cohort.uniqueWallets,
    qualifiedBuyMarkets: cohort.uniqueMarkets,
    markouts: cohort.horizons,
    linkedLeaderSell: shadow.leaderSellOutcomes,
    independentConsensus60s: shadow.cohorts?.independentMultiWalletConsensus?.horizons?.['60s'],
    singleWallet60s: shadow.cohorts?.singleWalletAll?.horizons?.['60s'],
    minimumSizeFeasibility: shadow.minimumSizeFeasibility,
  };
}

function loadBaseline(filename, maxWallets) {
  const bytes = fs.readFileSync(filename);
  const payload = JSON.parse(bytes.toString('utf8'));
  const observed = (payload?.discovery?.observed || []).slice(0, maxWallets);
  if (!observed.length) throw new Error('baseline has no pre-registered observed wallet cohort');
  for (const row of observed) {
    if (!/^0x[0-9a-f]{40}$/.test(String(row.wallet || '')) || row.quality?.eligible !== true || row.quality?.individualLegEntryCopyable !== true) {
      throw new Error(`baseline cohort row is not financially qualified and individually copyable: ${row.wallet || 'unknown'}`);
    }
  }
  return {
    sha256: sha256(bytes),
    payload,
    walletRows: observed,
    independenceGroups: payload?.discovery?.independenceGroups || {},
    takerSummary: baselineTakerSummary(payload),
  };
}

function atomicWrite(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function compactOrder(order) {
  return {
    ...order,
    revalidationHistory: order.revalidationHistory.slice(-4),
  };
}

function pendingUntilMs(order) {
  const registrationDeadline = order.registeredAtMs + MARKOUT_HORIZONS_SECONDS.at(-1) * 1_000 + 5_000;
  const fillDeadline = order.fill
    ? order.fill.timestampMs + MARKOUT_HORIZONS_SECONDS.at(-1) * 1_000 + 5_000
    : 0;
  return Math.max(registrationDeadline, fillDeadline);
}

function uniqueFilledOpportunities(orders) {
  return new Set(orders.filter((order) => order.adverseMoveThresholdPct === 4 && order.fill).map((order) => order.opportunityId)).size;
}

async function observePassiveForward(baseline, args) {
  const startMs = Date.now();
  const minimumEndMs = startMs + args.minObserveSeconds * 1_000;
  const maximumEndMs = startMs + args.maxObserveSeconds * 1_000;
  const walletRows = baseline.walletRows;
  const walletQualities = Object.fromEntries(walletRows.map((row) => [row.wallet, row.quality]));
  const seen = new Set(walletRows.flatMap((row) => (row.normalizedTrades || []).map((event) => event.dedupeKey)));
  const recentEvents = [];
  const signals = [];
  const opportunities = [];
  const orders = [];
  const errors = [];
  const marketInfoCache = new Map();
  let activityPolls = 0;
  let bookPolls = 0;
  let registrationStoppedAtMs = null;
  let stopReason = null;
  let nextActivityPollMs = startMs;
  let nextBookPollMs = startMs;
  let lastProgressMs = 0;
  let lastCheckpointMs = 0;

  const fetchMarketInfo = async (marketId) => {
    if (!marketId) return {};
    if (!marketInfoCache.has(marketId)) {
      marketInfoCache.set(marketId, fetchClobMarketInfo(marketId).catch((error) => ({ _error: error.message })));
    }
    return marketInfoCache.get(marketId);
  };

  const checkpoint = () => {
    const checkpointPath = `${args.output}.partial`;
    atomicWrite(checkpointPath, {
      mode: 'in_progress_public_get_passive_shadow',
      baselineSha256: baseline.sha256,
      startMs,
      minimumEndMs,
      maximumEndMs,
      checkpointMs: Date.now(),
      registrationStoppedAtMs,
      stopReason,
      activityPolls,
      bookPolls,
      walletCount: walletRows.length,
      opportunityCount: opportunities.length,
      uniqueFilledOpportunitiesAtFourPct: uniqueFilledOpportunities(orders),
      opportunities,
      orders: orders.map(compactOrder),
      errors,
    });
    lastCheckpointMs = Date.now();
  };

  const captureEvent = async (rawEvent, walletRow, detectedAtMs) => {
    const event = {
      ...rawEvent,
      detectionTimestampMs: detectedAtMs,
      latencyMs: Math.max(0, detectedAtMs - rawEvent.leaderTimestampMs),
      source: 'official_data_api_activity_forward_poll',
    };
    if (seen.has(event.dedupeKey)) return;
    seen.add(event.dedupeKey);
    if (event.leaderTimestampMs < startMs - 5_000) return;
    try {
      const book = normalizeBook(await fetchOrderBook(event.tokenId), Date.now());
      const marketInfo = await fetchMarketInfo(event.marketId || book.marketId);
      const fee = feeParameters(marketInfo);
      recentEvents.push(event);
      while (recentEvents.length && book.observedAtMs - recentEvents[0].detectionTimestampMs > DEFAULT_POLICY.consensusWindowMs) recentEvents.shift();
      const consensus = calculateConsensus({
        events: recentEvents,
        walletQualities,
        independenceGroups: baseline.independenceGroups,
        targetTokenId: event.tokenId,
        targetSide: event.side,
        nowMs: book.observedAtMs,
      });
      const candidate = buildFollowerCandidate({
        event,
        walletQuality: walletRow.quality,
        consensus,
        book,
        feeRate: fee.rate,
        feeExponent: fee.exponent,
        feeEvidence: fee.evidence,
        expectedMarkoutPrior: null,
        nowMs: book.observedAtMs,
      });
      const signal = {
        event,
        walletQuality: walletRow.quality,
        candidate,
        eligibilityAtDetection: {
          financiallyQualified: walletRow.quality.eligible === true,
          individualLegEntryCopyable: walletRow.quality.individualLegEntryCopyable === true,
        },
        fee,
        placementBook: book,
      };
      signals.push(signal);

      if (event.side === 'SELL') {
        for (const order of orders) linkLeaderSell(order, book, event);
        return;
      }
      if (!copyScreeningEligible(signal)) return;
      const opportunityId = candidate.signalId;
      const registered = createPassiveOrders({
        opportunityId,
        event: { ...event, consensus },
        book,
        fee,
        registeredAtMs: book.observedAtMs,
      });
      if (!registered.orders.length) return;
      opportunities.push({
        opportunityId,
        event,
        walletQualityScore: walletRow.quality.qualityScore,
        consensus,
        placementBook: book,
        passiveRuleRejections: registered.rejections,
        registeredOrderCount: registered.orders.length,
      });
      orders.push(...registered.orders);
    } catch (error) {
      errors.push({ stage: 'capture_event', wallet: walletRow.wallet, tokenId: event.tokenId, error: error.message, atMs: Date.now() });
    }
  };

  const pollActivities = async () => {
    activityPolls += 1;
    await mapLimit(walletRows, 3, async (walletRow) => {
      try {
        const rows = await fetchWalletActivity(walletRow.wallet, { limit: 50, start: startMs - 5_000 });
        const detectedAtMs = Date.now();
        const normalized = rows.slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).map((raw) => normalizeTraderEvent(raw, {
          wallet: walletRow.wallet,
          leaderName: walletRow.userName,
          detectionTimestampMs: detectedAtMs,
          source: 'official_data_api_activity_forward_poll',
        })).filter(Boolean);
        for (const event of aggregateTraderEvents(normalized)) await captureEvent(event, walletRow, detectedAtMs);
      } catch (error) {
        errors.push({ stage: 'activity_poll', wallet: walletRow.wallet, error: error.message, atMs: Date.now() });
      }
    });
  };

  const pollBooks = async () => {
    const nowMs = Date.now();
    const relevantOrders = orders.filter((order) => order.status === 'open' || nowMs <= pendingUntilMs(order));
    const tokenIds = [...new Set(relevantOrders.map((order) => order.tokenId))];
    if (!tokenIds.length) return;
    bookPolls += 1;
    const books = new Map();
    await mapLimit(tokenIds, 8, async (tokenId) => {
      try {
        books.set(tokenId, normalizeBook(await fetchOrderBook(tokenId), Date.now()));
      } catch (error) {
        errors.push({ stage: 'book_poll', tokenId, error: error.message, atMs: Date.now() });
      }
    });
    const openMarketIds = [...new Set(relevantOrders.filter((order) => order.status === 'open').map((order) => order.marketId).filter(Boolean))];
    const tradesByMarket = new Map();
    await mapLimit(openMarketIds, 6, async (marketId) => {
      try {
        tradesByMarket.set(marketId, await fetchMarketTrades(marketId, { limit: 1_000, side: 'SELL', takerOnly: true }));
      } catch (error) {
        errors.push({ stage: 'market_trade_poll', marketId, error: error.message, atMs: Date.now() });
      }
    });
    for (const order of relevantOrders) {
      const book = books.get(order.tokenId);
      if (!book) continue;
      if (order.status === 'open') {
        processPassiveOrder(order, {
          book,
          trades: tradesByMarket.get(order.marketId) || [],
          nowMs: book.observedAtMs,
        });
      }
      observeOrderEconomics(order, book, book.observedAtMs);
    }
  };

  process.stdout.write(
    `[PASSIVE SHADOW START] start=${new Date(startMs).toISOString()} minEnd=${new Date(minimumEndMs).toISOString()} ` +
    `maxEnd=${new Date(maximumEndMs).toISOString()} wallets=${walletRows.length} baselineSha256=${baseline.sha256}\n`
  );

  while (true) {
    const nowMs = Date.now();
    if (!registrationStoppedAtMs && nowMs >= minimumEndMs && opportunities.length >= 100 && uniqueFilledOpportunities(orders) >= 25) {
      registrationStoppedAtMs = nowMs;
      stopReason = 'early_stop_threshold_met_after_30_minimum';
    }
    if (!registrationStoppedAtMs && nowMs >= maximumEndMs) {
      registrationStoppedAtMs = nowMs;
      stopReason = '45_minute_clock_limit';
    }
    if (!registrationStoppedAtMs && nowMs >= nextActivityPollMs) {
      await pollActivities();
      nextActivityPollMs = Date.now() + args.activityPollMs;
    }
    if (nowMs >= nextBookPollMs) {
      await pollBooks();
      nextBookPollMs = Date.now() + args.bookPollMs;
    }
    if (nowMs - lastProgressMs >= 300_000) {
      process.stdout.write(
        `[PASSIVE SHADOW PROGRESS] ts=${new Date(nowMs).toISOString()} activityPolls=${activityPolls} bookPolls=${bookPolls} ` +
        `signals=${signals.length} opportunities=${opportunities.length} uniqueFills4pct=${uniqueFilledOpportunities(orders)} errors=${errors.length}\n`
      );
      lastProgressMs = nowMs;
    }
    if (nowMs - lastCheckpointMs >= 300_000) checkpoint();

    const pending = orders.some((order) => Date.now() <= pendingUntilMs(order));
    if (registrationStoppedAtMs && !pending) break;
    const nextWake = Math.min(nextActivityPollMs, nextBookPollMs);
    await sleep(Math.min(500, Math.max(50, nextWake - Date.now())));
  }
  checkpoint();
  return {
    startMs,
    minimumEndMs,
    maximumEndMs,
    registrationStoppedAtMs,
    finishedAtMs: Date.now(),
    stopReason,
    walletCount: walletRows.length,
    activityPolls,
    bookPolls,
    signals,
    opportunities,
    orders,
    errors,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  const baseline = loadBaseline(args.baseline, args.maxWallets);
  const observation = await observePassiveForward(baseline, args);
  const summary = summarizePassiveStudy({
    opportunities: observation.opportunities,
    orders: observation.orders,
    priorTakerBaseline: baseline.takerSummary,
    observation: {
      startedAt: new Date(observation.startMs).toISOString(),
      minimumEndAt: new Date(observation.minimumEndMs).toISOString(),
      maximumEndAt: new Date(observation.maximumEndMs).toISOString(),
      registrationStoppedAt: new Date(observation.registrationStoppedAtMs).toISOString(),
      finishedAt: new Date(observation.finishedAtMs).toISOString(),
      registrationElapsedMs: observation.registrationStoppedAtMs - observation.startMs,
      totalElapsedMs: observation.finishedAtMs - observation.startMs,
      stopReason: observation.stopReason,
      walletCount: observation.walletCount,
      activityPolls: observation.activityPolls,
      bookPolls: observation.bookPolls,
      leaderSignals: observation.signals.length,
      buySignals: observation.signals.filter((row) => row.event.side === 'BUY').length,
      sellSignals: observation.signals.filter((row) => row.event.side === 'SELL').length,
      collectionErrors: observation.errors.length,
      baselinePath: args.baseline,
      baselineSha256: baseline.sha256,
    },
  });
  const result = {
    summary,
    cohort: baseline.walletRows.map((row) => ({
      wallet: row.wallet,
      userName: row.userName,
      quality: row.quality,
    })),
    opportunities: observation.opportunities,
    orders: observation.orders.map(compactOrder),
    errors: observation.errors,
  };
  atomicWrite(args.output, result);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`profitable-trader passive shadow failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  loadBaseline,
  baselineTakerSummary,
  observePassiveForward,
  uniqueFilledOpportunities,
};
