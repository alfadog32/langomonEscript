'use strict';

// Read-only TailEnd funnel over a discovery shadow report. Public GETs only;
// no engine start, state save, paper placement, live candidate, or order call.
process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const fs = require('fs');
const {
  CONFIG,
  BotEngine,
  MultiConsensusEngine,
  Signal,
} = require('../moneymaker_v3.js');

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

async function fetchBook(baseUrl, tokenId) {
  const url = new URL('/book', baseUrl);
  url.searchParams.set('token_id', tokenId);
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'langomon-tailend-sophie-funnel-shadow/1.0' },
  });
  if (!response.ok) throw new Error(`book ${tokenId}: HTTP ${response.status} ${response.statusText}`);
  return normalizeBook(await response.json(), tokenId);
}

function cloneSignal(signal) {
  const cloned = new Signal({
    strategy: signal.strategy,
    tokenId: signal.tokenId,
    marketId: signal.marketId,
    side: signal.side,
    price: signal.price,
    sizeUsd: signal.sizeUsd,
    expectedEdge: signal.expectedEdge,
    confidence: signal.confidence,
    reason: signal.reason,
    exitPlan: signal.exitPlan,
    ttlMs: signal.ttlMs,
    maxHoldMs: signal.maxHoldMs,
    metadata: JSON.parse(JSON.stringify(signal.metadata || {})),
  });
  cloned.createdAt = signal.createdAt;
  return cloned;
}

function routeSummary(signal, admitted) {
  const consensus = signal?.metadata?.consensus || {};
  const route = consensus.route || {};
  return {
    admitted: Boolean(admitted),
    sizeUsd: signal?.sizeUsd ?? null,
    expectedEdge: signal?.expectedEdge ?? null,
    confidence: signal?.confidence ?? null,
    score: consensus.score ?? null,
    threshold: consensus.threshold ?? null,
    components: consensus.components || null,
    mode: route.mode || null,
    state: route.state || null,
    authorized: route.authorized === true,
    blockReason: route.blockReason || null,
    reason: route.reason || null,
    directionalMove: route.directionalMove ?? 0,
  };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = String(keyFn(item) || 'none');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: node scripts/tailend_sophie_funnel_shadow.js <discovery-report.json>');
  const discovery = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const selected = (Array.isArray(discovery.strategyAwareSelected) ? discovery.strategyAwareSelected : [])
    .filter((entry) => entry.discoveryStrategies?.includes('TailEndMispricing'));
  if (selected.length === 0) throw new Error('discovery report has no selected TailEnd observations');

  const config = {
    ...CONFIG,
    maxMarkets: 8,
    baseOrderUsd: 1,
    minOrderUsd: 1,
    minSignalEdge: 0.02,
    minConfidence: 0.70,
    sophieMinExecutionQuality: 0.60,
    spreadHunterEnabled: false,
    tailEndEnabled: true,
    complementArbEnabled: true,
    inventoryExitEnabled: true,
    enableWhaleTracking: false,
    enableWhaleCopyStrategy: false,
    enableLiveTrading: false,
    liveAutoExecute: false,
    liveKillSwitch: true,
    liveDryRunOnly: true,
    liveSubmitConfirm: false,
    liveFinalBossReady: false,
    saveState: false,
    stateFile: `/tmp/tailend-sophie-funnel-${process.pid}-${Date.now()}.json`,
  };

  const capturedLogs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => capturedLogs.push(args.join(' '));
  console.warn = (...args) => capturedLogs.push(args.join(' '));

  const observations = [];
  try {
    for (const selectedAsset of selected) {
      const book = await fetchBook(config.clobBaseUrl, selectedAsset.tokenId);
      const asset = {
        ...selectedAsset,
        market: selectedAsset.market,
        tokenId: String(selectedAsset.tokenId),
        outcome: selectedAsset.outcome,
        book,
      };
      const bot = new BotEngine(config);
      bot.cache.setCandidates([asset]);
      bot.cache.setBook(asset.tokenId, book);
      const tail = bot.strategies.find((strategy) => strategy.name === 'TailEndMispricing');
      const beforeEvents = bot.portfolio.executionEvents.length;
      const signals = await tail.generate(asset, book);
      const generatedEvents = bot.portfolio.executionEvents.slice(beforeEvents);
      const skip = generatedEvents.find((event) => event.type === 'strategy_skip') || null;

      const observation = {
        marketId: asset.market.marketId,
        marketSlug: asset.market.marketSlug,
        tokenId: asset.tokenId,
        outcome: asset.outcome,
        midpoint: book.midpoint,
        spread: book.spread,
        hoursUntilEnd: (Date.parse(asset.market.endDate) - Date.now()) / 3_600_000,
        rawSignalCount: signals.length,
        rawSkipReason: skip?.reason || null,
        rawSide: signals[0]?.side || null,
        rawSizeUsd: signals[0]?.sizeUsd ?? null,
        rawExpectedEdge: signals[0]?.expectedEdge ?? null,
        rawConfidence: signals[0]?.confidence ?? null,
        normal: null,
        alignedMomentumCounterfactual: null,
      };

      if (signals.length > 0) {
        const raw = signals[0];
        const normalSignal = cloneSignal(raw);
        const normalConsensus = new MultiConsensusEngine(config);
        const normalAdmitted = normalConsensus.evaluateSignal(
          normalSignal, asset, book, bot.cache, bot.portfolio, bot.volGuard, null
        );
        const normalRoute = routeSummary(normalSignal, normalAdmitted);
        let normalQuality = null;
        let normalSophieAdmitted = false;
        let normalRiskEvaluated = false;
        let normalRiskAdmitted = false;
        let normalRiskBlockReason = null;
        if (normalAdmitted) {
          normalQuality = bot.evaluateSophieExecutionQuality(normalAdmitted, book);
          normalSophieAdmitted = bot.applySophieExecutionGate(normalAdmitted, asset, book, normalQuality);
          if (normalSophieAdmitted) {
            normalRiskEvaluated = true;
            normalRiskAdmitted = Boolean(bot.risk.evaluate(normalAdmitted));
            normalRiskBlockReason = normalRiskAdmitted ? null : bot.risk.lastBlockReason;
          }
        }
        observation.normal = {
          route: normalRoute,
          sophieExecutionQualityEvaluated: Boolean(normalQuality),
          sophieExecutionQuality: normalQuality,
          sophieAdmitted: normalSophieAdmitted,
          sophieBlockReason: normalAdmitted ? (normalSophieAdmitted ? null : normalQuality?.qualityDecision) : normalRoute.blockReason,
          riskEvaluated: normalRiskEvaluated,
          riskAdmitted: normalRiskAdmitted,
          riskBlockReason: normalRiskBlockReason,
          theoreticalPlacement: normalRiskAdmitted,
        };

        const momentumBot = new BotEngine(config);
        momentumBot.cache.setCandidates([asset]);
        momentumBot.cache.setBook(asset.tokenId, book);
        const momentumSignal = cloneSignal(raw);
        const momentumConsensus = new MultiConsensusEngine(config);
        const move = Math.max(config.consensusTrendMovePct * 1.15, config.consensusTrendMovePct + 0.005);
        const priorMid = momentumSignal.side === 'buy'
          ? book.midpoint / (1 + move)
          : book.midpoint / (1 - move);
        momentumConsensus.midHistory.set(momentumSignal.tokenId, [
          { t: Date.now() - 3_000, mid: priorMid },
          { t: Date.now() - 2_000, mid: priorMid },
          { t: Date.now() - 1_000, mid: priorMid },
        ]);
        const momentumAdmitted = momentumConsensus.evaluateSignal(
          momentumSignal, asset, book, momentumBot.cache, momentumBot.portfolio, momentumBot.volGuard, null
        );
        const momentumRoute = routeSummary(momentumSignal, momentumAdmitted);
        let momentumQuality = null;
        let momentumSophieAdmitted = false;
        let momentumRiskEvaluated = false;
        let momentumRiskAdmitted = false;
        let momentumRiskBlockReason = null;
        if (momentumAdmitted) {
          momentumQuality = momentumBot.evaluateSophieExecutionQuality(momentumAdmitted, book);
          momentumSophieAdmitted = momentumBot.applySophieExecutionGate(
            momentumAdmitted, asset, book, momentumQuality
          );
          if (momentumSophieAdmitted) {
            momentumRiskEvaluated = true;
            momentumRiskAdmitted = Boolean(momentumBot.risk.evaluate(momentumAdmitted));
            momentumRiskBlockReason = momentumRiskAdmitted ? null : momentumBot.risk.lastBlockReason;
          }
        }
        observation.alignedMomentumCounterfactual = {
          seededMovePct: move,
          priorMid,
          route: momentumRoute,
          sophieExecutionQualityEvaluated: Boolean(momentumQuality),
          sophieExecutionQuality: momentumQuality,
          sophieAdmitted: momentumSophieAdmitted,
          sophieBlockReason: momentumAdmitted
            ? (momentumSophieAdmitted ? null : momentumQuality?.qualityDecision)
            : momentumRoute.blockReason,
          riskEvaluated: momentumRiskEvaluated,
          riskAdmitted: momentumRiskAdmitted,
          riskBlockReason: momentumRiskBlockReason,
          theoreticalPlacement: momentumRiskAdmitted,
        };
      }
      observations.push(observation);
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const rawSignals = observations.filter((entry) => entry.rawSignalCount > 0);
  const normalRouteAdmits = rawSignals.filter((entry) => entry.normal?.route?.admitted);
  const normalSophieAdmits = rawSignals.filter((entry) => entry.normal?.sophieAdmitted);
  const normalRiskEvaluated = rawSignals.filter((entry) => entry.normal?.riskEvaluated);
  const normalRiskAdmits = rawSignals.filter((entry) => entry.normal?.riskAdmitted);
  const momentumRouteAdmits = rawSignals.filter((entry) => entry.alignedMomentumCounterfactual?.route?.admitted);
  const momentumSophieAdmits = rawSignals.filter((entry) => entry.alignedMomentumCounterfactual?.sophieAdmitted);
  const momentumRiskEvaluated = rawSignals.filter((entry) => entry.alignedMomentumCounterfactual?.riskEvaluated);
  const momentumRiskAdmits = rawSignals.filter((entry) => entry.alignedMomentumCounterfactual?.riskAdmitted);

  const report = {
    observedAt: new Date().toISOString(),
    discoveryReportObservedAt: discovery.observedAt,
    discoveryCodeCommit: discovery.codeCommit,
    safety: {
      publicGetsOnly: true,
      stateSave: false,
      paperPlacementCalled: false,
      liveCandidateCalled: false,
      liveLocks: {
        enableLiveTrading: config.enableLiveTrading,
        liveAutoExecute: config.liveAutoExecute,
        liveKillSwitch: config.liveKillSwitch,
        liveDryRunOnly: config.liveDryRunOnly,
        liveSubmitConfirm: config.liveSubmitConfirm,
        liveFinalBossReady: config.liveFinalBossReady,
      },
    },
    config: {
      maxMarkets: config.maxMarkets,
      baseOrderUsd: config.baseOrderUsd,
      minOrderUsd: config.minOrderUsd,
      minSignalEdge: config.minSignalEdge,
      minConfidence: config.minConfidence,
      consensusThreshold: config.consensusThreshold,
      consensusStableMaxSpread: config.consensusStableMaxSpread,
      consensusTrendMovePct: config.consensusTrendMovePct,
      sophieMinExecutionQuality: config.sophieMinExecutionQuality,
    },
    normalFunnel: {
      selectedTailEndAssets: observations.length,
      selectedTailEndMarkets: new Set(observations.map((entry) => entry.marketId)).size,
      rawSignals: rawSignals.length,
      rawBuySignals: rawSignals.filter((entry) => entry.rawSide === 'buy').length,
      rawSellSignals: rawSignals.filter((entry) => entry.rawSide === 'sell').length,
      strategyBlocks: observations.length - rawSignals.length,
      strategyBlockReasons: countBy(observations.filter((entry) => entry.rawSignalCount === 0), (entry) => entry.rawSkipReason),
      sophieRouteEvaluated: rawSignals.length,
      sophieRouteAdmitted: normalRouteAdmits.length,
      sophieRouteBlockReasons: countBy(rawSignals.filter((entry) => !entry.normal?.route?.admitted), (entry) => entry.normal?.route?.blockReason),
      sophieRouteStates: countBy(rawSignals, (entry) => `${entry.normal?.route?.mode}:${entry.normal?.route?.state}`),
      sophieExecutionQualityEvaluated: rawSignals.filter((entry) => entry.normal?.sophieExecutionQualityEvaluated).length,
      sophieAdmitted: normalSophieAdmits.length,
      sophieBlockReasons: countBy(rawSignals.filter((entry) => !entry.normal?.sophieAdmitted), (entry) => entry.normal?.sophieBlockReason),
      riskEvaluated: normalRiskEvaluated.length,
      riskAdmitted: normalRiskAdmits.length,
      riskBlockReasons: countBy(normalRiskEvaluated.filter((entry) => !entry.normal?.riskAdmitted), (entry) => entry.normal?.riskBlockReason),
      theoreticalPlacements: normalRiskAdmits.length,
    },
    alignedMomentumCounterfactual: {
      rawSignalsTested: rawSignals.length,
      sophieRouteAdmitted: momentumRouteAdmits.length,
      sophieRouteStates: countBy(rawSignals, (entry) => `${entry.alignedMomentumCounterfactual?.route?.mode}:${entry.alignedMomentumCounterfactual?.route?.state}`),
      sophieRouteBlockReasons: countBy(rawSignals.filter((entry) => !entry.alignedMomentumCounterfactual?.route?.admitted), (entry) => entry.alignedMomentumCounterfactual?.route?.blockReason),
      sophieExecutionQualityEvaluated: rawSignals.filter((entry) => entry.alignedMomentumCounterfactual?.sophieExecutionQualityEvaluated).length,
      sophieAdmitted: momentumSophieAdmits.length,
      sophieBlockReasons: countBy(rawSignals.filter((entry) => !entry.alignedMomentumCounterfactual?.sophieAdmitted), (entry) => entry.alignedMomentumCounterfactual?.sophieBlockReason),
      riskEvaluated: momentumRiskEvaluated.length,
      riskAdmitted: momentumRiskAdmits.length,
      riskBlockReasons: countBy(momentumRiskEvaluated.filter((entry) => !entry.alignedMomentumCounterfactual?.riskAdmitted), (entry) => entry.alignedMomentumCounterfactual?.riskBlockReason),
      theoreticalPlacements: momentumRiskAdmits.length,
    },
    hypothesis: {
      absentMomentumPreventsSniperRoute: rawSignals.length > 0 && normalRouteAdmits.length === 0 && momentumRouteAdmits.length > 0,
      note: 'Counterfactual changes only the consensus mid-history evidence; strategy, Sophie, Risk, thresholds, and books are unchanged.',
    },
    observations,
    capturedLogLines: capturedLogs.length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
