#!/usr/bin/env node
'use strict';

// Read-only TailEnd outcome study. Public GETs plus a read-only state snapshot;
// never starts BotEngine, saves state, places paper/live orders, or loads .env.
process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const fs = require('fs');
const path = require('path');
const {
  CONFIG,
  BotEngine,
  PolymarketPublicClient,
  RiskEngine,
  Signal,
  isBookComplete,
} = require('../moneymaker_v3');
const {
  capitalClassification,
  evaluateVenueMinimumEntry,
  opportunityKey,
  reliableResolutionEvidence,
  scoreForwardBidMark,
  scoreResolution,
} = require('../lib/tailend_economic_validity');

const arg = (name, fallback = null) => {
  const hit = process.argv.find((value) => value === `--${name}` || value.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};
const numArg = (name, fallback) => Number(arg(name, fallback));
const OUTPUT = path.resolve(String(arg('output', `/tmp/tailend_economic_validity_${Date.now()}.json`)));
const STATE_FILE = path.resolve(String(arg('state-file', '/home/lango/langomonEscript/moneymaker_v3_state_controlled_burnin_91_20260806_2139.json')));
const TARGET_UNIQUE = Math.max(1, numArg('target-unique', 100));
const MIN_RESOLVED = Math.max(1, numArg('min-resolved', 30));
const DURATION_MS = Math.max(60_000, numArg('duration-ms', 14 * 24 * 60 * 60_000));
const DISCOVERY_MS = Math.max(60_000, numArg('discovery-ms', 15 * 60_000));
const POLL_MS = Math.max(30_000, numArg('poll-ms', 60_000));
const CHECKPOINT_MS = Math.max(15_000, numArg('checkpoint-ms', 60_000));
const RESOLUTION_RECHECK_MS = Math.max(60_000, numArg('resolution-recheck-ms', 5 * 60_000));
const CONCURRENCY = Math.max(1, Math.min(16, numArg('concurrency', 8)));
const ONCE = arg('once', false) === true || String(arg('once', 'false')).toLowerCase() === 'true';
const QUIET = String(arg('quiet', 'true')).toLowerCase() !== 'false';
const HORIZONS = [
  ['5m', 5 * 60_000], ['15m', 15 * 60_000], ['30m', 30 * 60_000],
  ['1h', 60 * 60_000], ['3h', 3 * 60 * 60_000], ['6h', 6 * 60 * 60_000],
];
const startedAtMs = Date.now();

const runtimeConfig = {
  ...CONFIG,
  saveState: false,
  stateFile: STATE_FILE,
  initialCash: numArg('initial-cash', 91),
  baseOrderUsd: numArg('base-order-usd', 1),
  minOrderUsd: numArg('min-order-usd', 1),
  maxPositionUsdPerAsset: numArg('max-position-usd', 2),
  maxMarketExposureUsd: numArg('max-market-exposure-usd', 3),
  maxTotalExposureUsd: numArg('max-total-exposure-usd', 10),
  maxTotalOpenOrderUsd: numArg('max-open-order-usd', 3),
  maxOpenOrders: numArg('max-open-orders', 4),
  btcExposureBucketShare: numArg('btc-bucket-share', 0.60),
  standardExposureBucketShare: numArg('standard-bucket-share', 0.40),
  minSignalEdge: numArg('min-signal-edge', 0.02),
  standardMinSignalEdge: numArg('standard-min-signal-edge', 0.004),
  minConfidence: numArg('min-confidence', 0.70),
  standardPaperMinConfidence: numArg('standard-paper-min-confidence', 0.58),
  maxDrawdownPct: numArg('max-drawdown-pct', 5),
  sophieMinExecutionQuality: numArg('sophie-min-quality', 0.60),
  tailEndHours: numArg('tail-hours', 36),
  tailEndMinConfidence: numArg('tail-min-confidence', 0.58),
  slippageBuffer: numArg('slippage-buffer', 0.002),
  eventPages: numArg('event-pages', 2),
  eventLimit: numArg('event-limit', 100),
  maxOutcomesPerMarket: 2,
  tailEndEnabled: true,
  spreadHunterEnabled: false,
  enableWhaleTracking: false,
  enableWhaleCopyStrategy: false,
  enableConsensus: false,
  enableLiveTrading: false,
  liveAutoExecute: false,
  liveKillSwitch: true,
  liveDryRunOnly: true,
  liveSubmitConfirm: false,
  liveFinalBossReady: false,
  paperActionBurnInEnabled: false,
};

let state = {
  study: 'TAILEND_ECONOMIC_VALIDITY_SHADOW_V1',
  startedAt: new Date(startedAtMs).toISOString(),
  updatedAt: new Date(startedAtMs).toISOString(),
  reason: 'startup',
  cycles: 0,
  targetUnique: TARGET_UNIQUE,
  minResolved: MIN_RESOLVED,
  errors: [],
  observations: [],
};

function recordError(message) {
  state.errors.push(String(message));
  if (state.errors.length > 500) state.errors.splice(0, state.errors.length - 500);
}

if (fs.existsSync(OUTPUT)) {
  try {
    const prior = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    if (prior?.study === state.study && Array.isArray(prior.observations)) {
      state = { ...state, ...prior, reason: 'resumed' };
      // Preserve the checkpointed cohort and measurements while reflecting the
      // current invocation's stopping objective in durable metadata.
      state.targetUnique = TARGET_UNIQUE;
      state.minResolved = MIN_RESOLVED;
    }
  } catch (error) {
    recordError(`resume: ${error.message}`);
  }
}

function cloneSignal(signal, sizeUsd = signal.sizeUsd) {
  return new Signal({
    strategy: signal.strategy, tokenId: signal.tokenId, marketId: signal.marketId,
    side: signal.side, price: signal.price, sizeUsd,
    expectedEdge: signal.expectedEdge, confidence: signal.confidence,
    reason: signal.reason, exitPlan: signal.exitPlan, ttlMs: signal.ttlMs,
    maxHoldMs: signal.maxHoldMs, metadata: JSON.parse(JSON.stringify(signal.metadata || {})),
  });
}

async function mapConcurrent(items, worker) {
  const result = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, items.length)) }, runner));
  return result;
}

function readPortfolioSnapshot(bot) {
  const payload = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  bot.portfolio.hydratePersistedState(payload);
  return {
    cash: bot.portfolio.cash,
    equity: bot.portfolio.equity(),
    drawdownPct: bot.portfolio.getDrawdownPct(),
    stateMtimeMs: fs.statSync(STATE_FILE).mtimeMs,
  };
}

async function gammaMarket(marketId) {
  const response = await fetch(`${runtimeConfig.gammaBaseUrl}/markets/${encodeURIComponent(marketId)}`, {
    headers: { accept: 'application/json', 'user-agent': 'langomon-tailend-economics/1.0' },
  });
  if (!response.ok) throw new Error(`Gamma market ${marketId}: HTTP ${response.status}`);
  return response.json();
}

function riskResult(risk, signal) {
  const details = risk.riskDetails(signal);
  const passed = Boolean(risk.evaluate(signal));
  return { passed, reason: passed ? null : risk.lastBlockReason, details: passed ? details : risk.lastBlockDetails };
}

async function discover(poly) {
  const events = await poly.fetchActiveEvents();
  const markets = poly.extractTradableMarkets(events);
  const planned = markets.flatMap((market) => market.outcomes.slice(0, runtimeConfig.maxOutcomesPerMarket)
    .map((outcome) => ({ market, outcome })));
  const fetched = await mapConcurrent(planned, async ({ market, outcome }) => {
    try {
      const book = await poly.getOrderBook(outcome.tokenId);
      return { market, outcome, book };
    } catch (error) {
      recordError(`book ${outcome.tokenId}: ${error.message}`);
      return null;
    }
  });
  const bot = new BotEngine(runtimeConfig);
  const snapshot = readPortfolioSnapshot(bot);
  const tail = bot.strategies.find((strategy) => strategy.name === 'TailEndMispricing');
  const known = new Set(state.observations.map(opportunityKey));
  let eligibleBuys = 0;
  let duplicates = 0;
  let added = 0;
  for (const item of fetched.filter(Boolean)) {
    const { market, outcome, book } = item;
    if (!isBookComplete(book)) continue;
    const asset = { market, tokenId: outcome.tokenId, outcome: outcome.outcome, book };
    bot.cache.setCandidates([asset]);
    bot.cache.setBook(asset.tokenId, book);
    const signals = await tail.generate(asset, book);
    const raw = signals.find((signal) => signal.side === 'buy');
    if (!raw) continue;
    eligibleBuys += 1;
    const key = opportunityKey({ marketId: market.marketId, tokenId: asset.tokenId, outcome: asset.outcome });
    if (known.has(key)) { duplicates += 1; continue; }
    const conditionId = String(book.market || market.conditionId || '');
    const feeMeta = await poly.fetchMarketFeeMetadata(conditionId);
    const entryEconomics = evaluateVenueMinimumEntry(book, feeMeta);
    const quality = bot.evaluateSophieExecutionQuality(cloneSignal(raw), book);
    const sophieSignal = cloneSignal(raw);
    const sophiePassed = bot.applySophieExecutionGate(sophieSignal, asset, book, quality);
    const rawRisk = sophiePassed
      ? riskResult(new RiskEngine(runtimeConfig, bot.portfolio, null), cloneSignal(sophieSignal))
      : { passed: false, reason: `sophie:${quality.qualityDecision}`, details: null };
    let venueRisk = { passed: false, reason: entryEconomics.reason || 'venue_economics_unavailable', details: null };
    if (entryEconomics.ok && sophiePassed) {
      venueRisk = riskResult(
        new RiskEngine(runtimeConfig, bot.portfolio, null),
        cloneSignal(sophieSignal, entryEconomics.requiredNotionalUsd)
      );
    }
    const now = Date.now();
    const expiryMs = Date.parse(market.endDate || '');
    const observation = {
      timestamp: new Date(now).toISOString(),
      key, marketId: String(market.marketId), conditionId,
      marketSlug: market.marketSlug || '', question: market.question || '', category: market.category || '',
      tokenId: String(asset.tokenId), outcome: String(asset.outcome), endDate: market.endDate || null,
      timeToExpiryMs: Number.isFinite(expiryMs) ? expiryMs - now : null,
      bestBid: book.bestBid, bestAsk: book.bestAsk, midpoint: book.midpoint, spread: book.spread,
      venueMinimumShares: book.minOrderSizeReported === true ? book.minOrderSize : null,
      currentSignal: {
        side: raw.side, price: raw.price, sizeUsd: raw.sizeUsd,
        expectedEdge: raw.expectedEdge, confidence: raw.confidence, reason: raw.reason,
      },
      feeMetadata: feeMeta ? {
        rate: feeMeta.rate, exponent: feeMeta.exponent, takerOnly: feeMeta.takerOnly,
        source: feeMeta.source, observedAtMs: feeMeta.observedAtMs,
      } : null,
      entryEconomics,
      sophie: {
        evaluated: true, passed: sophiePassed, reason: sophiePassed ? null : quality.qualityDecision,
        executionQuality: quality.sophieExecutionQuality,
        predictedFillProbability: quality.predictedFillProbability,
        distanceFromTouch: quality.distanceFromTouch,
      },
      currentRisk: rawRisk,
      currentNoPlacementReason: sophiePassed ? (rawRisk.reason || 'none') : `sophie:${quality.qualityDecision}`,
      venueMinimumRisk: venueRisk,
      stateSnapshot: snapshot,
      forwardMarks: {}, forwardMarkErrors: {}, resolutionChecks: 0, lastResolutionCheckAtMs: null,
      resolutionEvidence: null, resolutionScore: null,
    };
    state.observations.push(observation);
    known.add(key);
    added += 1;
  }
  state.cycles += 1;
  state.lastDiscovery = {
    at: new Date().toISOString(), events: events.length, markets: markets.length, booksPlanned: planned.length,
    booksFetched: fetched.filter(Boolean).length, eligibleBuys, duplicates, added,
    uniqueTotal: state.observations.length,
  };
}

async function updateForwardMarksAndResolutions(poly) {
  const now = Date.now();
  for (const observation of state.observations) {
    for (const [label, offsetMs] of HORIZONS) {
      if (observation.forwardMarks?.[label] || now < Date.parse(observation.timestamp) + offsetMs) continue;
      try {
        const book = await poly.getOrderBook(observation.tokenId);
        const feeMeta = await poly.fetchMarketFeeMetadata(String(book.market || observation.conditionId || ''));
        observation.forwardMarks[label] = scoreForwardBidMark(
          observation, book, feeMeta, Date.parse(observation.timestamp) + offsetMs, Date.now()
        );
      } catch (error) {
        observation.forwardMarkErrors[label] = {
          reason: `book_fetch_failed:${error.message}`,
          targetAtMs: Date.parse(observation.timestamp) + offsetMs, observedAtMs: Date.now(),
        };
      }
    }
    if (observation.resolutionScore) continue;
    const endMs = Date.parse(observation.endDate || '');
    if (!Number.isFinite(endMs) || now < endMs) continue;
    if (now - Number(observation.lastResolutionCheckAtMs || 0) < RESOLUTION_RECHECK_MS) continue;
    observation.lastResolutionCheckAtMs = now;
    observation.resolutionChecks = Number(observation.resolutionChecks || 0) + 1;
    try {
      const market = await gammaMarket(observation.marketId);
      const evidence = reliableResolutionEvidence(market, observation.outcome);
      observation.resolutionEvidence = evidence;
      if (evidence.resolved) observation.resolutionScore = scoreResolution(observation, evidence, Date.now());
    } catch (error) {
      observation.resolutionEvidence = { resolved: false, reason: `gamma_fetch_failed:${error.message}` };
    }
  }
}

function bucketSummary(name, keyFn) {
  const groups = {};
  for (const observation of state.observations) {
    const key = String(keyFn(observation));
    if (!groups[key]) groups[key] = [];
    groups[key].push(observation);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, observations]) => {
    const resolved = observations.filter((item) => item.resolutionScore);
    const wins = resolved.filter((item) => item.resolutionScore.correct).length;
    const capital = resolved.reduce((sum, item) => sum + Number(item.entryEconomics?.requiredCapitalUsd || 0), 0);
    const pnl = resolved.reduce((sum, item) => sum + Number(item.resolutionScore.netPnlUsd || 0), 0);
    const breakEvens = observations.map((item) => Number(item.entryEconomics?.breakEvenProbability)).filter(Number.isFinite);
    return [key, {
      bucket: name, observations: observations.length, resolved: resolved.length,
      empiricalWinRate: resolved.length ? wins / resolved.length : null,
      meanBreakEvenProbability: breakEvens.length ? breakEvens.reduce((a, b) => a + b, 0) / breakEvens.length : null,
      netPnlUsd: pnl, roi: capital > 0 ? pnl / capital : null,
    }];
  }));
}

function distribution(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null };
  const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    count: sorted.length,
    min: sorted[0], p25: quantile(0.25), median: quantile(0.5), p75: quantile(0.75), max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function summary() {
  const resolved = state.observations.filter((item) => item.resolutionScore);
  const wins = resolved.filter((item) => item.resolutionScore.correct).length;
  const pnl = resolved.reduce((sum, item) => sum + Number(item.resolutionScore.netPnlUsd || 0), 0);
  const capital = resolved.reduce((sum, item) => sum + Number(item.entryEconomics?.requiredCapitalUsd || 0), 0);
  const classCounts = {};
  for (const observation of state.observations) {
    const key = capitalClassification(observation);
    classCounts[key] = (classCounts[key] || 0) + 1;
  }
  const confidenceValues = resolved.map((item) => Number(item.currentSignal.confidence)).filter(Number.isFinite);
  return {
    uniqueSignals: state.observations.length,
    economicallyScorableEntries: state.observations.filter((item) => item.entryEconomics?.ok).length,
    officialFeeMetadataUnavailable: state.observations.filter((item) => item.entryEconomics?.reason === 'official_fee_metadata_unavailable').length,
    resolvedSignals: resolved.length,
    empiricalWinRate: resolved.length ? wins / resolved.length : null,
    feeAdjustedHypotheticalPnlUsd: pnl,
    roi: capital > 0 ? pnl / capital : null,
    venueMinimumProfitableCount: resolved.filter((item) => Number(item.resolutionScore.netPnlUsd) > 0).length,
    profitableButCapBlockedCount: resolved.filter((item) => Number(item.resolutionScore.netPnlUsd) > 0 && item.venueMinimumRisk?.passed !== true).length,
    meanConfidenceResolved: confidenceValues.length ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length : null,
    confidenceCalibrationGap: resolved.length && confidenceValues.length
      ? (wins / resolved.length) - (confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length)
      : null,
    entryPriceDistribution: distribution(state.observations.map((item) => item.entryEconomics?.executablePrice)),
    breakEvenProbabilityDistribution: distribution(state.observations.map((item) => item.entryEconomics?.breakEvenProbability)),
    capitalClassification: classCounts,
    buckets: {
      entryPrice: bucketSummary('entryPrice', (item) => {
        const p = Number(item.entryEconomics?.executablePrice);
        return p < 0.97 ? '<0.97' : p < 0.98 ? '0.97-0.98' : p < 0.99 ? '0.98-0.99' : '0.99+';
      }),
      confidence: bucketSummary('confidence', (item) => {
        const c = Number(item.currentSignal.confidence);
        return c < 0.70 ? '<0.70' : c < 0.80 ? '0.70-0.80' : '0.80+';
      }),
      hoursToExpiry: bucketSummary('hoursToExpiry', (item) => {
        const h = Number(item.timeToExpiryMs) / 3_600_000;
        return h <= 1 ? '<=1h' : h <= 6 ? '1-6h' : h <= 12 ? '6-12h' : h <= 24 ? '12-24h' : '24-36h';
      }),
      spread: bucketSummary('spread', (item) => {
        const s = Number(item.spread);
        return s <= 0.002 ? '<=0.002' : s <= 0.005 ? '0.002-0.005' : s <= 0.01 ? '0.005-0.01' : '>0.01';
      }),
      category: bucketSummary('category', (item) => item.category || 'unknown'),
    },
  };
}

function report(reason) {
  state.updatedAt = new Date().toISOString();
  state.reason = reason;
  state.durationMs = Date.now() - startedAtMs;
  state.stopCriterion = `unique >= ${TARGET_UNIQUE} and resolved >= ${MIN_RESOLVED}, or duration safety bound`;
  state.safety = {
    publicGetsOnly: true, runtimeStateReadOnly: true, ordersPlaced: false,
    stateMutated: false, runtimeConfigChanged: false, pm2Restarted: false,
    localEnvFilesLoaded: false,
  };
  state.runtimeConfig = {
    stateFile: STATE_FILE, baseOrderUsd: runtimeConfig.baseOrderUsd, minOrderUsd: runtimeConfig.minOrderUsd,
    maxPositionUsdPerAsset: runtimeConfig.maxPositionUsdPerAsset,
    maxMarketExposureUsd: runtimeConfig.maxMarketExposureUsd,
    maxTotalExposureUsd: runtimeConfig.maxTotalExposureUsd,
    maxTotalOpenOrderUsd: runtimeConfig.maxTotalOpenOrderUsd,
    standardExposureBucketShare: runtimeConfig.standardExposureBucketShare,
    consensusEnabled: runtimeConfig.enableConsensus,
  };
  state.summary = summary();
  return state;
}

function write(reason) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true, mode: 0o700 });
  const temporary = `${OUTPUT}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(report(reason), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, OUTPUT);
}

(async () => {
  const poly = new PolymarketPublicClient(runtimeConfig);
  let stopping = false;
  let lastDiscoveryAt = 0;
  const finish = (reason, code = 0) => {
    if (stopping) return;
    stopping = true;
    try { write(reason); } catch (error) { console.error(error.stack || error.message); code = 1; }
    process.stdout.write(`${JSON.stringify({ output: OUTPUT, reason, pid: process.pid, summary: summary() })}\n`);
    process.exit(code);
  };
  process.on('SIGINT', () => finish('sigint'));
  process.on('SIGTERM', () => finish('sigterm'));
  process.on('uncaughtException', (error) => { recordError(`uncaught: ${error.stack || error.message}`); finish('uncaught', 1); });
  const checkpoint = setInterval(() => { try { write('checkpoint'); } catch (error) { recordError(`checkpoint: ${error.message}`); } }, CHECKPOINT_MS);
  checkpoint.unref();
  write('startup');
  process.stdout.write(`${JSON.stringify({ status: 'started', pid: process.pid, output: OUTPUT, targetUnique: TARGET_UNIQUE, minResolved: MIN_RESOLVED })}\n`);
  if (QUIET) {
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
  }

  while (!stopping && Date.now() - startedAtMs < DURATION_MS) {
    const loopStart = Date.now();
    if (state.observations.length < TARGET_UNIQUE && Date.now() - lastDiscoveryAt >= DISCOVERY_MS) {
      try { await discover(poly); } catch (error) { recordError(`discovery: ${error.stack || error.message}`); }
      lastDiscoveryAt = Date.now();
    }
    try { await updateForwardMarksAndResolutions(poly); } catch (error) { recordError(`forward: ${error.stack || error.message}`); }
    write('cycle');
    if (ONCE) return finish('once');
    const resolved = state.observations.filter((item) => item.resolutionScore).length;
    if (state.observations.length >= TARGET_UNIQUE && resolved >= MIN_RESOLVED) return finish('target_and_resolution_reached');
    const wait = Math.max(0, POLL_MS - (Date.now() - loopStart));
    if (Date.now() - startedAtMs + wait >= DURATION_MS) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  finish('duration_safety_bound');
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
