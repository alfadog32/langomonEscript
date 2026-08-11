#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_POLICY,
  normalizeTraderEvent,
  aggregateTraderEvents,
  calculateWalletQuality,
  deriveIndependenceGroups,
  calculateConsensus,
  normalizeBook,
  executablePrice,
  calculateTakerFeeUsd,
  buildFollowerCandidate,
  evaluateExecutableMarkouts,
} = require('../lib/profitable_trader_consensus');
const {
  fetchLeaderboard,
  fetchWalletActivity,
  fetchClosedPositions,
  fetchOrderBook,
  fetchClobMarketInfo,
} = require('../lib/profitable_trader_readonly');

const MARKOUT_HORIZONS_SECONDS = Object.freeze([5, 15, 30, 60, 120, 300]);
const PRIORITY_WALLET_NAMES = Object.freeze({
  '0xdb859a551fcf56e49416160911476bea7307152f': 'AV23IUa',
  '0x16bb9951a36fce71e2ef57890b786145e0ba8492': 'SDTrading',
  '0xf0318c32136c2db7fec88b84869aee6a1106c80c': 'BreakTheBank',
  '0x684baa57c338c2549aec0aa3f034f695d72a8409': 'monkeymashingkeyboard',
});

function parseArgs(argv) {
  const args = {
    leaderboardLimit: 20,
    walletLimit: 8,
    activityLimit: 300,
    closedLimit: 300,
    observeSeconds: 0,
    pollMs: 4_000,
    output: null,
    priorityWallets: [],
    candidatePoolSize: null,
    discoveryClosedLimit: null,
    maxActivityAgeMinutes: 10_080,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--leaderboard-limit') args.leaderboardLimit = Number(value), index += 1;
    else if (arg === '--wallet-limit') args.walletLimit = Number(value), index += 1;
    else if (arg === '--activity-limit') args.activityLimit = Number(value), index += 1;
    else if (arg === '--closed-limit') args.closedLimit = Number(value), index += 1;
    else if (arg === '--observe-seconds') args.observeSeconds = Number(value), index += 1;
    else if (arg === '--poll-ms') args.pollMs = Number(value), index += 1;
    else if (arg === '--output') args.output = value, index += 1;
    else if (arg === '--priority-wallets') args.priorityWallets = String(value || '').split(',').map((wallet) => wallet.trim().toLowerCase()).filter(Boolean), index += 1;
    else if (arg === '--candidate-pool-size') args.candidatePoolSize = Number(value), index += 1;
    else if (arg === '--discovery-closed-limit') args.discoveryClosedLimit = Number(value), index += 1;
    else if (arg === '--max-activity-age-minutes') args.maxActivityAgeMinutes = Number(value), index += 1;
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['leaderboardLimit', 'walletLimit', 'activityLimit', 'closedLimit', 'observeSeconds', 'pollMs']) {
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error(`invalid ${key}`);
  }
  args.leaderboardLimit = Math.max(1, Math.min(50, Math.floor(args.leaderboardLimit)));
  args.walletLimit = Math.max(1, Math.min(20, Math.floor(args.walletLimit)));
  args.activityLimit = Math.max(20, Math.min(500, Math.floor(args.activityLimit)));
  args.closedLimit = Math.max(20, Math.min(500, Math.floor(args.closedLimit)));
  args.observeSeconds = Math.max(0, Math.min(86_400, Math.floor(args.observeSeconds)));
  args.pollMs = Math.max(2_000, Math.min(60_000, Math.floor(args.pollMs)));
  args.candidatePoolSize = Number.isFinite(args.candidatePoolSize)
    ? Math.max(args.walletLimit, Math.min(100, Math.floor(args.candidatePoolSize)))
    : Math.max(args.walletLimit * 2, 12);
  args.discoveryClosedLimit = Number.isFinite(args.discoveryClosedLimit)
    ? Math.max(20, Math.min(args.closedLimit, Math.floor(args.discoveryClosedLimit)))
    : args.closedLimit;
  args.maxActivityAgeMinutes = Math.max(1, Math.min(10_080, Math.floor(args.maxActivityAgeMinutes)));
  for (const wallet of args.priorityWallets) {
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error(`invalid priority wallet: ${wallet}`);
  }
  args.priorityWallets = [...new Set(args.priorityWallets)];
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function percentile(values, probability) {
  const valid = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!valid.length) return null;
  return valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(valid.length * probability) - 1))];
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function finiteAge(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function summarizePnl(values) {
  const valid = values.filter(Number.isFinite);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of valid) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return {
    sampleSize: valid.length,
    mean: round(mean(valid)),
    median: round(median(valid)),
    winRate: valid.length ? round(valid.filter((value) => value > 0).length / valid.length) : null,
    total: round(valid.reduce((sum, value) => sum + value, 0)),
    maximumDrawdown: round(maxDrawdown),
  };
}

function help() {
  process.stdout.write([
    'Read-only profitable-trader discovery and forward shadow collector.',
    '',
    'node scripts/profitable_trader_shadow.js [options]',
    '  --observe-seconds N  forward observation duration; default 0 (discovery only)',
    '  --wallet-limit N     qualified wallets to observe; default 8',
    '  --poll-ms N          official activity polling interval; minimum 2000',
    '  --output PATH        optional JSON result path; stdout is always summary only',
    '  --priority-wallets W comma-separated public wallet addresses to re-verify first',
    '  --candidate-pool-size N broad leaderboard wallets to screen; maximum 100',
    '  --discovery-closed-limit N shallow closed-position sample before finalist re-verification',
    '  --max-activity-age-minutes N recency requirement after quality/copyability qualification',
    '',
    'This command uses public GET endpoints only and cannot place an order.',
  ].join('\n'));
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

async function discoverWallets(args) {
  const periods = ['DAY', 'WEEK', 'MONTH'];
  const periodRows = await Promise.all(periods.map((period) => fetchLeaderboard({ timePeriod: period, limit: args.leaderboardLimit })));
  const pool = new Map();
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    for (const row of periodRows[index]) {
      const wallet = String(row.proxyWallet || '').toLowerCase();
      if (!wallet) continue;
      if (!pool.has(wallet)) pool.set(wallet, { wallet, userName: row.userName || '', periods: {}, appearances: 0 });
      const candidate = pool.get(wallet);
      candidate.periods[period] = { rank: Number(row.rank), pnl: Number(row.pnl), vol: Number(row.vol) };
      candidate.appearances += 1;
    }
  }
  for (const wallet of args.priorityWallets) {
    if (!pool.has(wallet)) {
      pool.set(wallet, {
        wallet,
        userName: PRIORITY_WALLET_NAMES[wallet] || `priority-${wallet.slice(2, 10)}`,
        periods: {},
        appearances: 0,
      });
    }
  }
  const priorityOrder = new Map(args.priorityWallets.map((wallet, index) => [wallet, index]));
  const rankedPool = [...pool.values()]
    .sort((a, b) => {
      const aPriority = priorityOrder.has(a.wallet) ? priorityOrder.get(a.wallet) : Number.MAX_SAFE_INTEGER;
      const bPriority = priorityOrder.has(b.wallet) ? priorityOrder.get(b.wallet) : Number.MAX_SAFE_INTEGER;
      return aPriority - bPriority || b.appearances - a.appearances || (a.periods.MONTH?.rank || 999) - (b.periods.MONTH?.rank || 999);
    })
    .slice(0, args.candidatePoolSize);

  const datasets = await mapLimit(rankedPool, 1, async (candidate) => {
    const startedAt = Date.now();
    try {
      const [activity, closedPositions] = await Promise.all([
        fetchWalletActivity(candidate.wallet, { limit: args.activityLimit }),
        fetchClosedPositions(candidate.wallet, { limit: args.discoveryClosedLimit }),
      ]);
      const normalizedTrades = activity.map((row) => normalizeTraderEvent(row, {
        wallet: candidate.wallet,
        leaderName: candidate.userName,
        detectionTimestampMs: Number(row.timestamp) * 1000,
      })).filter(Boolean);
      const leaderboard = candidate.periods.MONTH
        ? { ...candidate.periods.MONTH, period: 'MONTH' }
        : candidate.periods.WEEK
          ? { ...candidate.periods.WEEK, period: 'WEEK' }
          : { ...candidate.periods.DAY, period: 'DAY' };
      const quality = calculateWalletQuality({
        wallet: candidate.wallet,
        trades: normalizedTrades,
        closedPositions,
        leaderboard,
      });
      return {
        ...candidate,
        activity,
        normalizedTrades,
        closedPositions,
        quality,
        fetchLatencyMs: Date.now() - startedAt,
        fetchError: null,
      };
    } catch (error) {
      return { ...candidate, activity: [], normalizedTrades: [], closedPositions: [], quality: null, fetchLatencyMs: Date.now() - startedAt, fetchError: error.message };
    }
  });
  const histories = new Map(datasets.filter((row) => row.quality).map((row) => [row.wallet, row.normalizedTrades]));
  const independenceGroups = deriveIndependenceGroups(histories);
  const maxActivityAgeMs = args.maxActivityAgeMinutes * 60_000;
  const broadEligible = datasets
    .filter((row) => row.quality?.eligible && row.quality.individualLegEntryCopyable === true)
    .sort((a, b) => {
      const activityOrder = finiteAge(a.quality.activityAgeMs) - finiteAge(b.quality.activityAgeMs);
      const aPriority = priorityOrder.has(a.wallet) ? priorityOrder.get(a.wallet) : Number.MAX_SAFE_INTEGER;
      const bPriority = priorityOrder.has(b.wallet) ? priorityOrder.get(b.wallet) : Number.MAX_SAFE_INTEGER;
      return activityOrder || b.quality.qualityScore - a.quality.qualityScore || aPriority - bPriority;
    });
  const observed = [];
  for (const candidate of broadEligible) {
    if (!(candidate.quality.activityAgeMs <= maxActivityAgeMs)) continue;
    if (args.discoveryClosedLimit < args.closedLimit) {
      try {
        const closedPositions = await fetchClosedPositions(candidate.wallet, { limit: args.closedLimit });
        candidate.closedPositions = closedPositions;
        candidate.quality = calculateWalletQuality({
          wallet: candidate.wallet,
          trades: candidate.normalizedTrades,
          closedPositions,
          leaderboard: candidate.quality.leaderboard,
        });
        candidate.fullReverificationClosedPositions = closedPositions.length;
      } catch (error) {
        candidate.reverificationError = error.message;
        continue;
      }
    }
    if (candidate.quality.eligible && candidate.quality.individualLegEntryCopyable === true && candidate.quality.activityAgeMs <= maxActivityAgeMs) {
      observed.push(candidate);
      if (observed.length >= args.walletLimit) break;
    }
  }
  return {
    source: 'official_polymarket_data_api',
    periods,
    leaderboardRows: periodRows.reduce((sum, rows) => sum + rows.length, 0),
    datasets,
    candidatePoolSize: rankedPool.length,
    discoveryClosedLimit: args.discoveryClosedLimit,
    fullReverificationClosedLimit: args.closedLimit,
    maxActivityAgeMinutes: args.maxActivityAgeMinutes,
    independenceGroups,
    observed,
    observationSelection: observed.length
      ? 'financially_qualified_individually_copyable_only'
      : 'no_eligible_individually_copyable_wallets',
  };
}

function feeParameters(info) {
  const rate = Number(info?.fd?.r);
  const exponent = Number(info?.fd?.e);
  return {
    rate: Number.isFinite(rate) ? rate : 0,
    exponent: Number.isFinite(exponent) ? exponent : 1,
    takerOnly: info?.fd?.to !== false,
    evidence: info?.fd ? 'official_clob_market_info' : 'official_clob_market_info_fee_missing_assumed_zero',
  };
}

async function observeForward(discovery, args) {
  const startMs = Date.now();
  const endMs = startMs + args.observeSeconds * 1000;
  const walletRows = discovery.observed;
  const walletQualities = Object.fromEntries(walletRows.map((row) => [row.wallet, row.quality]));
  const seen = new Set(walletRows.flatMap((row) => row.normalizedTrades.map((event) => event.dedupeKey)));
  const recentEvents = [];
  const signals = [];
  const errors = [];
  const marketInfoCache = new Map();
  let polls = 0;
  let lastProgressMs = 0;
  let lastCheckpointMs = 0;

  const writeCheckpoint = () => {
    if (!args.output) return;
    const checkpointPath = `${path.resolve(args.output)}.partial`;
    const temporaryPath = `${checkpointPath}.tmp`;
    const checkpoint = {
      mode: 'in_progress_public_get_shadow',
      startMs,
      endMs,
      checkpointMs: Date.now(),
      polls,
      discovery: {
        observationSelection: discovery.observationSelection,
        observed: discovery.observed.map((row) => ({ wallet: row.wallet, userName: row.userName, quality: row.quality })),
        independenceGroups: discovery.independenceGroups,
      },
      signals,
      errors,
    };
    fs.writeFileSync(temporaryPath, JSON.stringify(checkpoint, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, checkpointPath);
    lastCheckpointMs = checkpoint.checkpointMs;
  };

  const fetchMarketInfo = async (marketId) => {
    if (!marketId) return {};
    if (!marketInfoCache.has(marketId)) {
      marketInfoCache.set(marketId, fetchClobMarketInfo(marketId).catch((error) => ({ _error: error.message })));
    }
    return marketInfoCache.get(marketId);
  };

  const captureEvent = async (raw, walletRow, detectedAtMs) => {
    const event = raw?.schemaVersion === 1
      ? {
          ...raw,
          detectionTimestampMs: detectedAtMs,
          latencyMs: Math.max(0, detectedAtMs - raw.leaderTimestampMs),
          source: 'official_data_api_activity_forward_poll',
        }
      : normalizeTraderEvent(raw, {
          wallet: walletRow.wallet,
          leaderName: walletRow.userName,
          detectionTimestampMs: detectedAtMs,
          source: 'official_data_api_activity_forward_poll',
        });
    if (!event || seen.has(event.dedupeKey)) return;
    seen.add(event.dedupeKey);
    if (event.leaderTimestampMs < startMs - 5_000) return;
    try {
      const rawBook = await fetchOrderBook(event.tokenId);
      const capturedAtMs = Date.now();
      const book = normalizeBook(rawBook, capturedAtMs);
      const marketInfo = await fetchMarketInfo(event.marketId || book.marketId);
      const fee = feeParameters(marketInfo);
      recentEvents.push(event);
      while (recentEvents.length && capturedAtMs - recentEvents[0].detectionTimestampMs > DEFAULT_POLICY.consensusWindowMs) recentEvents.shift();
      const consensus = calculateConsensus({
        events: recentEvents,
        walletQualities,
        independenceGroups: discovery.independenceGroups,
        targetTokenId: event.tokenId,
        targetSide: event.side,
        nowMs: capturedAtMs,
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
        nowMs: capturedAtMs,
      });
      const categoryQuality = walletRow.quality.categoryStats?.[event.category] || null;
      const executableReferencePrice = event.side === 'BUY' ? book.bestAsk : book.bestBid;
      const minimumNotionalUsd = Number.isFinite(book.minOrderSizeShares) && Number.isFinite(executableReferencePrice)
        ? book.minOrderSizeShares * executableReferencePrice
        : null;
      signals.push({
        event,
        walletQuality: walletRow.quality,
        candidate,
        eligibilityAtDetection: {
          financiallyQualified: walletRow.quality.eligible === true,
          individualLegEntryCopyable: walletRow.quality.individualLegEntryCopyable === true,
          copyabilityClassification: walletRow.quality.observedTradeMode || 'unknown',
          categoryQualityScore: categoryQuality?.qualityScore ?? null,
          categoryPositions: categoryQuality?.positions ?? 0,
          consensusScore: consensus.score,
          independentLeaderCount: consensus.independentLeaderCount || 0,
          independenceGroup: discovery.independenceGroups[event.wallet] || event.wallet,
          shadowExecutable: event.side === 'BUY' && candidate.execution.sufficientDepth === true,
          paperRealistic: event.side === 'BUY' && candidate.execution.paperRealistic === true,
          liveMinimumFeasibleAtShadowSize: event.side === 'BUY' && candidate.execution.liveSubmittable === true,
          minimumOrderShares: book.minOrderSizeShares,
          minimumNotionalUsd: round(minimumNotionalUsd),
          makerTaker: event.makerTaker,
        },
        fee,
        placementBook: book,
        futureBooks: {},
        captureErrors: [],
      });
    } catch (error) {
      errors.push({ stage: 'capture_event', wallet: walletRow.wallet, tokenId: event.tokenId, error: error.message });
    }
  };

  process.stdout.write(`[SHADOW START] start=${new Date(startMs).toISOString()} end=${new Date(endMs).toISOString()} wallets=${walletRows.length} selection=${discovery.observationSelection}\n`);
  let nextPollMs = startMs;
  const finalHorizonSeconds = MARKOUT_HORIZONS_SECONDS[MARKOUT_HORIZONS_SECONDS.length - 1];
  while (Date.now() < endMs || signals.some((signal) => Object.keys(signal.futureBooks).length < MARKOUT_HORIZONS_SECONDS.length && Date.now() < signal.event.detectionTimestampMs + (finalHorizonSeconds + 5) * 1000)) {
    const now = Date.now();
    if (now < endMs && now >= nextPollMs) {
      nextPollMs = now + args.pollMs;
      polls += 1;
      await mapLimit(walletRows, 3, async (walletRow) => {
        try {
          const rows = await fetchWalletActivity(walletRow.wallet, { limit: 50, start: startMs - 5_000 });
          const detectedAtMs = Date.now();
          const ordered = rows.slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
          const normalized = ordered.map((raw) => normalizeTraderEvent(raw, {
            wallet: walletRow.wallet,
            leaderName: walletRow.userName,
            detectionTimestampMs: detectedAtMs,
            source: 'official_data_api_activity_forward_poll',
          })).filter(Boolean);
          for (const event of aggregateTraderEvents(normalized)) await captureEvent(event, walletRow, detectedAtMs);
        } catch (error) {
          errors.push({ stage: 'activity_poll', wallet: walletRow.wallet, error: error.message });
        }
      });
    }

    for (const signal of signals) {
      for (const seconds of MARKOUT_HORIZONS_SECONDS) {
        if (signal.futureBooks[seconds]) continue;
        const dueAt = signal.event.detectionTimestampMs + seconds * 1000;
        if (Date.now() < dueAt) continue;
        try {
          signal.futureBooks[seconds] = normalizeBook(await fetchOrderBook(signal.event.tokenId), Date.now());
        } catch (error) {
          signal.futureBooks[seconds] = { _error: error.message, bids: [], asks: [] };
          signal.captureErrors.push(`${seconds}s:${error.message}`);
        }
      }
    }
    if (now - lastProgressMs >= 300_000) {
      process.stdout.write(`[SHADOW PROGRESS] ts=${new Date(now).toISOString()} polls=${polls} signals=${signals.length} buys=${signals.filter((row) => row.event.side === 'BUY').length} errors=${errors.length}\n`);
      lastProgressMs = now;
    }
    if (now - lastCheckpointMs >= 300_000) writeCheckpoint();
    const pending = signals.some((signal) => Object.keys(signal.futureBooks).length < MARKOUT_HORIZONS_SECONDS.length && Date.now() < signal.event.detectionTimestampMs + (finalHorizonSeconds + 5) * 1000);
    if (Date.now() >= endMs && !pending) break;
    await sleep(Math.min(500, Math.max(50, nextPollMs - Date.now())));
  }

  for (const signal of signals) {
    signal.markouts = evaluateExecutableMarkouts({
      candidate: signal.candidate,
      futureBooks: signal.futureBooks,
      feeRate: signal.fee.rate,
      feeExponent: signal.fee.exponent,
    });
  }
  writeCheckpoint();
  return {
    startMs,
    endMs,
    finishedMs: Date.now(),
    durationSeconds: args.observeSeconds,
    walletCount: walletRows.length,
    polls,
    signals,
    errors,
  };
}

function cohortSummary(signals, filter) {
  const selected = signals.filter(filter).filter((row) => row.markouts?.available);
  const horizons = {};
  for (const seconds of MARKOUT_HORIZONS_SECONDS) {
    const horizonRows = selected.map((row) => row.markouts.horizons?.[`${seconds}s`]).filter((row) => row?.available);
    horizons[`${seconds}s`] = {
      sampleSize: horizonRows.length,
      grossMarkoutPerShare: summarizePnl(horizonRows.map((row) => row.grossMarkoutPerShare)),
      grossPnlUsd: summarizePnl(horizonRows.map((row) => row.grossPnlUsd)),
      feeAdjustedMarkoutPerShare: summarizePnl(horizonRows.map((row) => row.netMarkoutPerShare)),
      feeAdjustedPnlUsd: summarizePnl(horizonRows.map((row) => row.feeAdjustedPnlUsd)),
    };
  }
  return {
    signals: selected.length,
    uniqueWallets: new Set(selected.map((row) => row.event.wallet)).size,
    uniqueMarkets: new Set(selected.map((row) => row.event.marketId)).size,
    observedMaePerShare: summarizePnl(selected.map((row) => row.markouts.observedMaePerShare)),
    observedMfePerShare: summarizePnl(selected.map((row) => row.markouts.observedMfePerShare)),
    horizons,
  };
}

function copyScreeningEligible(row) {
  const invalidating = new Set([
    'leader_quality_not_qualified',
    'leader_signal_stale',
    'missing_executable_book_side',
    'insufficient_executable_depth',
    'absolute_price_displacement',
    'relative_price_displacement',
    'individual_leg_copyability_not_proven',
    'insufficient_category_sample',
    'category_quality_below_floor',
  ]);
  return row.event.side === 'BUY' &&
    row.eligibilityAtDetection?.financiallyQualified === true &&
    row.eligibilityAtDetection?.individualLegEntryCopyable === true &&
    !row.candidate.blockReasons.some((reason) => invalidating.has(reason));
}

function latencyBucket(latencyMs) {
  if (latencyMs <= 2_000) return '0-2s';
  if (latencyMs <= 5_000) return '2-5s';
  if (latencyMs <= 10_000) return '5-10s';
  if (latencyMs <= 15_000) return '10-15s';
  if (latencyMs <= 30_000) return '15-30s';
  return '>30s';
}

function displacementBucket(displacement) {
  if (displacement <= 0.01) return '<=1c';
  if (displacement <= 0.02) return '1-2c';
  if (displacement <= 0.04) return '2-4c';
  if (displacement <= 0.06) return '4-6c';
  return '>6c';
}

function groupedCohorts(signals, keyFor) {
  const groups = {};
  for (const row of signals.filter(copyScreeningEligible)) {
    const key = keyFor(row);
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, cohortSummary(rows, () => true)]));
}

function eventCounts(signals, keyFor) {
  const counts = {};
  for (const row of signals) {
    const key = keyFor(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function linkLeaderSellOutcomes(signals) {
  const ordered = signals.slice().sort((a, b) => a.event.detectionTimestampMs - b.event.detectionTimestampMs);
  const results = [];
  for (const buy of ordered.filter(copyScreeningEligible)) {
    const sell = ordered.find((row) => row.event.side === 'SELL' &&
      row.event.wallet === buy.event.wallet &&
      row.event.tokenId === buy.event.tokenId &&
      row.event.detectionTimestampMs > buy.event.detectionTimestampMs);
    if (!sell) continue;
    const leaderReductionFraction = Math.min(1, sell.event.leaderShares / Math.max(buy.event.leaderShares, 1e-9));
    const followerShares = buy.candidate.execution.targetShares * leaderReductionFraction;
    const exit = executablePrice(sell.placementBook.bids, followerShares, 'SELL');
    if (!exit.sufficient) {
      results.push({ buySignalId: buy.candidate.signalId, sellSignalId: sell.candidate.signalId, available: false, reason: 'insufficient_sell_detection_bid_depth' });
      continue;
    }
    const entryFee = buy.candidate.execution.feeUsd * leaderReductionFraction;
    const exitFee = calculateTakerFeeUsd({ shares: followerShares, price: exit.averagePrice, feeRate: sell.fee.rate, feeExponent: sell.fee.exponent, taker: true });
    const grossPnlUsd = followerShares * (exit.averagePrice - buy.candidate.execution.averagePrice);
    results.push({
      buySignalId: buy.candidate.signalId,
      sellSignalId: sell.candidate.signalId,
      wallet: buy.event.wallet,
      tokenId: buy.event.tokenId,
      category: buy.event.category,
      buyDetectedAtMs: buy.event.detectionTimestampMs,
      sellDetectedAtMs: sell.event.detectionTimestampMs,
      holdingMs: sell.event.detectionTimestampMs - buy.event.detectionTimestampMs,
      leaderReductionFraction: round(leaderReductionFraction),
      fullLeaderExitRelativeToObservedBuy: leaderReductionFraction >= 1,
      available: true,
      followerShares: round(followerShares),
      entryAsk: buy.candidate.execution.averagePrice,
      exitBid: round(exit.averagePrice),
      grossPnlUsd: round(grossPnlUsd),
      feeAdjustedPnlUsd: round(grossPnlUsd - entryFee - exitFee),
    });
  }
  return results;
}

function summarize(discovery, observation) {
  const datasets = discovery.datasets;
  const signals = observation?.signals || [];
  const eligibleQualities = datasets.filter((row) => row.quality?.eligible);
  const displacement = signals.map((row) => row.candidate.execution.leaderPriceDisplacement).filter(Number.isFinite);
  const latency = signals.map((row) => row.event.latencyMs).filter(Number.isFinite);
  const buyLatency = signals.filter((row) => row.event.side === 'BUY').map((row) => row.event.latencyMs).filter(Number.isFinite);
  const screeningEligible = signals.filter(copyScreeningEligible);
  const linkedLeaderSells = linkLeaderSellOutcomes(signals);
  const categoryKeys = ['SPORTS', 'CRYPTO', 'POLITICS', 'ECONOMICS', 'OTHER', 'FINANCE', 'TECH', 'WEATHER'];
  const categoryCohorts = Object.fromEntries(categoryKeys.map((category) => [
    category,
    cohortSummary(signals, (row) => copyScreeningEligible(row) && row.event.category === category),
  ]));
  const marketCounts = eventCounts(screeningEligible, (row) => row.event.marketId || row.event.marketSlug || row.event.tokenId);
  const dominantMarketShare = screeningEligible.length
    ? Math.max(...Object.values(marketCounts)) / screeningEligible.length
    : null;
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: observation ? 'forward_shadow' : 'discovery_only',
    safety: {
      publicGetOnly: true,
      orderPlacementCodePresent: false,
      followerOrdersPlaced: 0,
      paperOrdersPlaced: 0,
      liveOrdersPlaced: 0,
      spreadHunterChanged: false,
    },
    discovery: {
      leaderboardRows: discovery.leaderboardRows,
      walletsScreened: datasets.length,
      fetchErrors: datasets.filter((row) => row.fetchError).length,
      qualifiedWallets: eligibleQualities.length,
      observationSelection: discovery.observationSelection,
      observedWallets: discovery.observed.map((row) => ({
        wallet: row.wallet,
        userName: row.userName,
        qualityScore: row.quality.qualityScore,
        individualLegEntryCopyable: row.quality.individualLegEntryCopyable,
        observedTradeMode: row.quality.observedTradeMode,
      })),
      portfolioBundleWallets: datasets.filter((row) => row.quality?.observedTradeMode === 'portfolio_bundle_or_hedging').map((row) => ({
        wallet: row.wallet,
        userName: row.userName,
        qualityScore: row.quality.qualityScore,
        blockers: row.quality.blockers,
        multiTokenBuyMarketRate: row.quality.multiTokenBuyMarketRate,
      })),
      candidateWallets: datasets.map((row) => ({
        wallet: row.wallet,
        userName: row.userName,
        appearances: row.appearances,
        quality: row.quality,
        fetchError: row.fetchError,
      })),
    },
    shadow: {
      startedAt: observation?.startMs ? new Date(observation.startMs).toISOString() : null,
      endedAt: observation?.endMs ? new Date(observation.endMs).toISOString() : null,
      finishedAt: observation?.finishedMs ? new Date(observation.finishedMs).toISOString() : null,
      actualElapsedMs: observation?.finishedMs && observation?.startMs ? observation.finishedMs - observation.startMs : 0,
      observationSeconds: observation?.durationSeconds || 0,
      walletsObserved: observation?.walletCount || 0,
      polls: observation?.polls || 0,
      collectionErrors: observation?.errors?.length || 0,
      leaderSignals: signals.length,
      buySignals: signals.filter((row) => row.event.side === 'BUY').length,
      sellSignals: signals.filter((row) => row.event.side === 'SELL').length,
      uniqueBuyWallets: new Set(signals.filter((row) => row.event.side === 'BUY').map((row) => row.event.wallet)).size,
      uniqueBuyTokens: new Set(signals.filter((row) => row.event.side === 'BUY').map((row) => row.event.tokenId)).size,
      copyScreeningEligibleBuys: signals.filter(copyScreeningEligible).length,
      eventCountByWallet: eventCounts(signals, (row) => `${row.event.leaderName || 'unknown'}|${row.event.wallet}`),
      eventCountByCategory: eventCounts(signals, (row) => row.event.category),
      staleSignals: signals.filter((row) => row.candidate.blockReasons.includes('leader_signal_stale')).length,
      meanLatencyMs: round(mean(latency)),
      medianLatencyMs: round(median(latency)),
      latencyP90Ms: round(percentile(latency, 0.90)),
      buyMeanLatencyMs: round(mean(buyLatency)),
      buyMedianLatencyMs: round(median(buyLatency)),
      buyLatencyP90Ms: round(percentile(buyLatency, 0.90)),
      meanLeaderPriceDisplacement: round(mean(displacement)),
      medianLeaderPriceDisplacement: round(median(displacement)),
      leaderPriceDisplacementP90: round(percentile(displacement, 0.90)),
      paperRealistic: signals.filter((row) => row.candidate.execution.paperRealistic).length,
      liveSubmittable: signals.filter((row) => row.candidate.execution.liveSubmittable).length,
      shadowExecutable: signals.filter((row) => row.eligibilityAtDetection?.shadowExecutable).length,
      minimumSizeFeasibility: {
        signalsWithOfficialMinimum: signals.filter((row) => Number.isFinite(row.eligibilityAtDetection?.minimumOrderShares)).length,
        feasibleAtOneDollar: signals.filter((row) => row.eligibilityAtDetection?.liveMinimumFeasibleAtShadowSize).length,
        minimumNotionalAtMostFourUsd: signals.filter((row) => Number.isFinite(row.eligibilityAtDetection?.minimumNotionalUsd) && row.eligibilityAtDetection.minimumNotionalUsd <= 4).length,
        minimumNotionalUsd: summarizePnl(signals.map((row) => row.eligibilityAtDetection?.minimumNotionalUsd)),
      },
      makerTakerKnown: signals.filter((row) => row.event.makerTaker !== 'UNKNOWN').length,
      orderEligible: signals.filter((row) => row.candidate.qualified).length,
      orderEligibilityPolicy: 'requires positive out-of-sample executable markout prior; intentionally unavailable on first collection',
      cohorts: {
        financiallyQualifiedIndividuallyCopyable: cohortSummary(signals, copyScreeningEligible),
        portfolioBundleOrHedging: cohortSummary(signals, (row) => row.event.side === 'BUY' && row.eligibilityAtDetection?.copyabilityClassification === 'portfolio_bundle_or_hedging'),
        highQualityScreeningEligibleBuys: cohortSummary(signals, (row) => copyScreeningEligible(row) && row.walletQuality.qualityScore >= 0.70),
        eliteSingleWallet: cohortSummary(signals, (row) => copyScreeningEligible(row) && row.candidate.consensus.reason === 'qualified_elite_single_leader'),
        independentMultiWalletConsensus: cohortSummary(signals, (row) => copyScreeningEligible(row) && row.candidate.consensus.independentLeaderCount >= 2),
        singleWalletAll: cohortSummary(signals, (row) => copyScreeningEligible(row) && row.candidate.consensus.independentLeaderCount === 1),
      },
      perWalletEconomics: groupedCohorts(signals, (row) => `${row.event.leaderName || 'unknown'}|${row.event.wallet}`),
      categoryEconomics: categoryCohorts,
      latencyBucketEconomics: groupedCohorts(signals, (row) => latencyBucket(row.event.latencyMs)),
      displacementBucketEconomics: groupedCohorts(signals, (row) => displacementBucket(row.candidate.execution.leaderPriceDisplacement)),
      leaderSellOutcomes: {
        observedLinks: linkedLeaderSells.length,
        executableLinks: linkedLeaderSells.filter((row) => row.available).length,
        feeAdjustedPnlUsd: summarizePnl(linkedLeaderSells.filter((row) => row.available).map((row) => row.feeAdjustedPnlUsd)),
        rows: linkedLeaderSells,
      },
      dominantMarketShare: round(dominantMarketShare),
    },
  };
  const multi = summary.shadow.cohorts.independentMultiWalletConsensus.horizons['60s'].feeAdjustedMarkoutPerShare;
  const single = summary.shadow.cohorts.singleWalletAll.horizons['60s'].feeAdjustedMarkoutPerShare;
  summary.shadow.multiWalletPredictiveValue = multi.sampleSize >= 5 && single.sampleSize >= 5
    ? round(multi.mean - single.mean)
    : null;
  const activationCohort = summary.shadow.cohorts.financiallyQualifiedIndividuallyCopyable;
  const activationHorizons = [5, 15, 30, 60].map((seconds) => activationCohort.horizons[`${seconds}s`].feeAdjustedMarkoutPerShare);
  const activationChecks = {
    meaningfulSample: activationCohort.signals >= 30,
    independentWalletBreadth: activationCohort.uniqueWallets >= 3,
    marketBreadth: activationCohort.uniqueMarkets >= 10,
    positiveMeanEveryRequiredHorizon: activationHorizons.every((row) => row.mean > 0),
    positiveMedianEveryRequiredHorizon: activationHorizons.every((row) => row.median > 0),
    notDominatedByOneMarket: Number.isFinite(dominantMarketShare) && dominantMarketShare <= 0.25,
    acceptableMedianLatency: Number.isFinite(summary.shadow.buyMedianLatencyMs) && summary.shadow.buyMedianLatencyMs <= DEFAULT_POLICY.maxSignalAgeMs,
    liveMinimumEvidencePresent: summary.shadow.minimumSizeFeasibility.signalsWithOfficialMinimum > 0,
  };
  summary.shadow.activationChecks = activationChecks;
  summary.shadow.activationDecision = Object.values(activationChecks).every(Boolean)
    ? 'eligible_for_separate_controlled_paper_canary_review'
    : 'remain_shadow_only';
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  const discovery = await discoverWallets(args);
  const observation = args.observeSeconds > 0 ? await observeForward(discovery, args) : null;
  const summary = summarize(discovery, observation);
  const result = { summary, discovery: { ...discovery, datasets: discovery.datasets.map((row) => ({ ...row, activity: undefined, closedPositions: undefined })) }, observation };
  if (args.output) {
    const resolved = path.resolve(args.output);
    fs.writeFileSync(resolved, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`profitable-trader shadow failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, discoverWallets, observeForward, summarize, feeParameters, copyScreeningEligible };
