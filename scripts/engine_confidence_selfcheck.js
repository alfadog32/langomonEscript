#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const {
  CONFIG,
  BotEngine,
  EngineDiagnostics,
  MultiConsensusEngine,
  RiskEngine,
  PaperExecutionEngine,
  PaperPortfolio,
  Signal,
} = require('../moneymaker_v3');
const { readConfig: readLiveConfig } = require('../live_adapter_polymarket');

function makeConfig(overrides = {}) {
  return {
    ...CONFIG,
    saveState: false,
    enableGhostMode: false,
    enableWhaleTracking: false,
    paperConfidenceProfile: 'conservative',
    spreadHunterMinConfidencePaper: 0.35,
    minConfidence: 0.45,
    minSignalEdge: 0.01,
    minOrderUsd: 1,
    initialCash: 1_000,
    maxOpenOrders: 20,
    maxOpenOrdersPerTokenSideStrategy: 1,
    maxTotalOpenOrderUsd: 1_000,
    maxTotalExposureUsd: 1_000,
    maxMarketExposureUsd: 1_000,
    maxPositionUsdPerAsset: 1_000,
    maxDrawdownPct: 50,
    dedupeOpenOrders: true,
    openOrderReplaceEnabled: false,
    quoteDuringVolatility: false,
    consensusThreshold: 0.5,
    consensusStableMaxSpread: 0.12,
    routeAuthMaxBookAgeMs: 3_000,
    hunterMinTopDepthUsd: 1,
    ...overrides,
  };
}

function makeBook(overrides = {}) {
  return {
    bestBid: 0.45,
    bestAsk: 0.55,
    midpoint: 0.50,
    spread: 0.10,
    tickSize: 0.01,
    cachedAt: Date.now(),
    bids: [{ price: 0.45, size: 500 }],
    asks: [{ price: 0.55, size: 500 }],
    ...overrides,
  };
}

function makeAsset(tokenId = 'confidence-token') {
  return {
    tokenId,
    outcome: 'YES',
    market: {
      marketId: 'confidence-market',
      question: 'Confidence self-check market',
      volume24h: 10_000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

function makeSignal(overrides = {}) {
  return new Signal({
    strategy: 'SpreadHunter',
    tokenId: 'confidence-token',
    marketId: 'confidence-market',
    side: 'buy',
    price: 0.44,
    sizeUsd: 10,
    expectedEdge: 0.02,
    confidence: 0.38,
    reason: 'confidence self-check',
    exitPlan: 'confidence self-check exit',
    ttlMs: 45_000,
    maxHoldMs: 120_000,
    metadata: { liquidityPenalty: 1 },
    ...overrides,
  });
}

function makeContext(configOverrides = {}, volGuard = null) {
  const config = makeConfig(configOverrides);
  const diagnostics = new EngineDiagnostics(config);
  const consensus = new MultiConsensusEngine(config, diagnostics);
  const portfolio = new PaperPortfolio(config);
  const guard = volGuard || { isTripped: () => false };
  const cache = { getMarketAssets: () => [], getBook: () => null };
  const risk = new RiskEngine(config, portfolio, diagnostics);
  return { config, diagnostics, consensus, portfolio, volGuard: guard, cache, risk };
}

function makeRuntimeBot(configOverrides = {}) {
  const config = makeConfig({
    stateFile: path.join('/tmp', `engine-confidence-selfcheck-${process.pid}.json`),
    ...configOverrides,
  });
  const bot = new BotEngine(config);
  bot.cache = {
    getMarketAssets: () => [],
    getBook: () => makeBook(),
    markPrices: () => new Map(),
  };
  bot.execution.cache = bot.cache;
  return bot;
}

function evaluateConsensus(ctx, signal, book = makeBook()) {
  return ctx.consensus.evaluateSignal(signal, makeAsset(signal.tokenId), book, ctx.cache, ctx.portfolio, ctx.volGuard, null);
}

function evaluateRiskAfterConsensus(ctx, signal, book = makeBook()) {
  const evaluated = evaluateConsensus(ctx, signal, book);
  if (!evaluated) return { evaluated, risked: null };
  return { evaluated, risked: ctx.risk.evaluate(evaluated) };
}

function run() {
  {
    const ctx = makeContext({ paperConfidenceProfile: 'conservative' });
    const { evaluated, risked } = evaluateRiskAfterConsensus(ctx, makeSignal({ confidence: 0.38 }));
    assert(evaluated, 'conservative scenario should pass consensus before risk');
    assert.strictEqual(risked, null, 'conservative blocks confidence below 0.45');
    assert.strictEqual(ctx.risk.lastBlockReason, 'confidence_below_min');
    assert.strictEqual(ctx.risk.lastBlockDetails.minConfidence, 0.45);
    assert.strictEqual(ctx.risk.lastBlockDetails.confidenceProfile, 'conservative');
    assert.strictEqual(ctx.risk.lastBlockDetails.thresholdSource, 'MIN_CONFIDENCE');
  }

  {
    const ctx = makeContext({ paperConfidenceProfile: 'capital_velocity' });
    const { evaluated, risked } = evaluateRiskAfterConsensus(ctx, makeSignal({ confidence: 0.38, expectedEdge: 0.02 }));
    assert(evaluated, 'capital_velocity scenario should pass consensus before risk');
    const threshold = ctx.risk.confidenceThreshold(evaluated);
    assert.strictEqual(threshold.minConfidence, 0.35);
    assert.strictEqual(threshold.confidenceProfile, 'capital_velocity');
    assert.strictEqual(threshold.thresholdSource, 'SPREADHUNTER_MIN_CONFIDENCE_PAPER');
    assert(risked, 'capital_velocity allows safe positive-edge SpreadHunter at confidence 0.38 with threshold 0.35');
    assert.strictEqual(ctx.risk.lastBlockReason, null);
  }

  {
    const bot = makeRuntimeBot({ paperConfidenceProfile: 'capital_velocity' });
    bot.trySignal(makeSignal({ confidence: 0.38, expectedEdge: 0.02 }), makeAsset(), makeBook());
    assert.strictEqual(bot.risk.lastBlockReason, null, 'runtime trySignal path should not block eligible capital_velocity SpreadHunter');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'runtime trySignal path should place the paper order');
  }

  {
    const bot = makeRuntimeBot({ paperConfidenceProfile: 'conservative' });
    bot.trySignal(makeSignal({ confidence: 0.38, expectedEdge: 0.02 }), makeAsset(), makeBook());
    assert.strictEqual(bot.risk.lastBlockReason, 'confidence_below_min', 'runtime trySignal path should keep conservative MIN_CONFIDENCE');
    assert.strictEqual(bot.risk.lastBlockDetails.minConfidence, 0.45);
    assert.strictEqual(bot.risk.lastBlockDetails.thresholdSource, 'MIN_CONFIDENCE');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'blocked runtime trySignal path must not place a paper order');
  }

  {
    const ctx = makeContext({ paperConfidenceProfile: 'balanced' });
    const risked = ctx.risk.evaluate(makeSignal({
      confidence: 0.38,
      expectedEdge: 0.001,
      metadata: {
        consensus: {
          score: 0.9,
          route: { authorized: true, mode: 'MAKER', state: 'STABLE' },
        },
      },
    }));
    assert.strictEqual(risked, null, 'low edge still blocks');
    assert.strictEqual(ctx.risk.lastBlockReason, 'edge_below_min');
  }

  {
    const ctx = makeContext({ paperConfidenceProfile: 'capital_velocity' });
    const { evaluated } = evaluateRiskAfterConsensus(ctx, makeSignal(), makeBook({ cachedAt: Date.now() - 10_000 }));
    assert.strictEqual(evaluated, null, 'stale book still blocks before risk');
  }

  {
    const ctx = makeContext({ paperConfidenceProfile: 'capital_velocity' }, { isTripped: () => true });
    const { evaluated } = evaluateRiskAfterConsensus(ctx, makeSignal());
    assert.strictEqual(evaluated, null, 'volatility guard still blocks before risk');
  }

  {
    const ctx = makeContext({
      paperConfidenceProfile: 'capital_velocity',
      maxTotalExposureUsd: 3,
      maxMarketExposureUsd: 1_000,
      maxPositionUsdPerAsset: 1_000,
    });
    const { evaluated, risked } = evaluateRiskAfterConsensus(ctx, makeSignal({ confidence: 0.38, sizeUsd: 10 }));
    assert(evaluated, 'exposure-cap scenario should pass consensus before risk');
    assert.strictEqual(risked, null, 'exposure cap still blocks after confidence override');
    assert.strictEqual(ctx.risk.lastBlockReason, 'max_total_exposure');
  }

  {
    const ctx = makeContext({ paperConfidenceProfile: 'capital_velocity' });
    const execution = new PaperExecutionEngine(ctx.config, ctx.portfolio, { getBook: () => makeBook() }, ctx.diagnostics);
    const { risked } = evaluateRiskAfterConsensus(ctx, makeSignal({ confidence: 0.38 }));
    assert(risked, 'duplicate scenario should produce a placeable signal first');
    assert.strictEqual(execution.place(risked, makeBook()), true, 'first duplicate scenario order should place');
    assert.strictEqual(execution.place(risked, makeBook()), false, 'duplicate still skips');
    assert.strictEqual(ctx.portfolio.openOrders.size, 1, 'duplicate skip must not add a second open order');
  }

  {
    const liveConfig = readLiveConfig(process.cwd());
    assert.strictEqual(liveConfig.enableLiveTrading, false, 'live safety not affected: ENABLE_LIVE_TRADING remains false by default');
    assert.strictEqual(liveConfig.liveAutoExecute, false, 'live safety not affected: LIVE_AUTO_EXECUTE remains false by default');
    assert.strictEqual(liveConfig.liveKillSwitch, true, 'live safety not affected: LIVE_KILL_SWITCH remains true by default');
    assert.strictEqual(liveConfig.liveDryRunOnly, true, 'live safety not affected: LIVE_DRY_RUN_ONLY remains true by default');
    assert.strictEqual(makeConfig({ paperConfidenceProfile: 'capital_velocity' }).autoLiveMinConfidence, CONFIG.autoLiveMinConfidence);
  }

  console.log('engine confidence self-check passed');
}

run();
