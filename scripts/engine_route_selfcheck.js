#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  CONFIG,
  EngineDiagnostics,
  MultiConsensusEngine,
  RiskEngine,
  PaperExecutionEngine,
  PaperPortfolio,
  Signal,
} = require('../moneymaker_v3');

function makeConfig(overrides = {}) {
  return {
    ...CONFIG,
    saveState: false,
    enableGhostMode: false,
    enableWhaleTracking: false,
    consensusThreshold: 0.5,
    minSignalEdge: 0.004,
    minConfidence: 0.2,
    hunterMaxSpread: 0.16,
    consensusStableMaxSpread: 0.12,
    routeAuthMaxBookAgeMs: 3_000,
    hunterMinTopDepthUsd: 1,
    maxOpenOrders: 20,
    maxOpenOrdersPerTokenSideStrategy: 1,
    maxTotalOpenOrderUsd: 1_000,
    maxTotalExposureUsd: 1_000,
    maxMarketExposureUsd: 1_000,
    maxPositionUsdPerAsset: 1_000,
    minOrderUsd: 1,
    dedupeOpenOrders: true,
    openOrderReplaceEnabled: false,
    quoteDuringVolatility: false,
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

function makeAsset(tokenId = 'token-selfcheck') {
  return {
    tokenId,
    outcome: 'YES',
    market: {
      marketId: 'market-selfcheck',
      question: 'Self-check market',
      volume24h: 10_000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

function makeSignal(overrides = {}) {
  return new Signal({
    strategy: 'SpreadHunter',
    tokenId: 'token-selfcheck',
    marketId: 'market-selfcheck',
    side: 'buy',
    price: 0.44,
    sizeUsd: 10,
    expectedEdge: 0.02,
    confidence: 0.75,
    reason: 'self-check',
    exitPlan: 'self-check exit',
    ttlMs: 45_000,
    maxHoldMs: 120_000,
    metadata: { liquidityPenalty: 1 },
    ...overrides,
  });
}

function makeContext(overrides = {}) {
  const config = makeConfig(overrides.config);
  const diagnostics = new EngineDiagnostics(config);
  const consensus = new MultiConsensusEngine(config, diagnostics);
  const portfolio = new PaperPortfolio(config);
  const volGuard = overrides.volGuard || { isTripped: () => false };
  const cache = { getMarketAssets: () => [], getBook: () => null };
  return { config, diagnostics, consensus, portfolio, volGuard, cache };
}

function evaluate({ consensus, portfolio, volGuard, cache }, signal, asset, book) {
  return consensus.evaluateSignal(signal, asset, book, cache, portfolio, volGuard, null);
}

function run() {
  {
    const ctx = makeContext();
    const signal = makeSignal();
    const evaluated = evaluate(ctx, signal, makeAsset(), makeBook());
    assert(evaluated, 'SpreadHunter maker-stable safe scenario should pass consensus');
    assert.strictEqual(evaluated.metadata.consensus.route.mode, 'MAKER');
    assert.strictEqual(evaluated.metadata.consensus.route.state, 'STABLE');
    assert.strictEqual(evaluated.metadata.consensus.route.authorized, true);
    assert.strictEqual(evaluated.metadata.consensus.route.reason, 'SpreadHunter authorized for maker-stable spread capture');
  }

  {
    const ctx = makeContext();
    const tokenId = 'token-trending';
    ctx.consensus.midHistory.set(tokenId, [
      { t: Date.now() - 5_000, mid: 0.45 },
      { t: Date.now() - 4_000, mid: 0.46 },
      { t: Date.now() - 3_000, mid: 0.48 },
      { t: Date.now() - 2_000, mid: 0.50 },
      { t: Date.now() - 1_000, mid: 0.55 },
    ]);
    const signal = makeSignal({ tokenId, side: 'sell' });
    const evaluated = evaluate(ctx, signal, makeAsset(tokenId), makeBook({ midpoint: 0.56, bestBid: 0.54, bestAsk: 0.58, spread: 0.04 }));
    assert.strictEqual(evaluated, null, 'Misaligned SpreadHunter sniper-trending scenario should block');
  }

  {
    const ctx = makeContext();
    const execution = new PaperExecutionEngine(ctx.config, ctx.portfolio, { getBook: () => makeBook() }, ctx.diagnostics);
    const signal = makeSignal();
    assert.strictEqual(execution.place(signal, makeBook()), true, 'First duplicate scenario order should place');
    assert.strictEqual(execution.place(signal, makeBook()), false, 'Second duplicate scenario order should skip');
    assert.strictEqual(ctx.portfolio.openOrders.size, 1, 'Duplicate skip must not add a second open order');
  }

  {
    const ctx = makeContext();
    const signal = makeSignal();
    const staleBook = makeBook({ cachedAt: Date.now() - 10_000 });
    const evaluated = evaluate(ctx, signal, makeAsset(), staleBook);
    assert.strictEqual(evaluated, null, 'Stale book should block');
  }

  {
    const ctx = makeContext({ volGuard: { isTripped: () => true } });
    const signal = makeSignal();
    const evaluated = evaluate(ctx, signal, makeAsset(), makeBook());
    assert.strictEqual(evaluated, null, 'Volatility guard should block');
  }

  {
    const ctx = makeContext({ config: { maxTotalExposureUsd: 5 } });
    const risk = new RiskEngine(ctx.config, ctx.portfolio, ctx.diagnostics);
    const signal = makeSignal({ sizeUsd: 10 });
    assert.strictEqual(risk.evaluate(signal), null, 'Exposure cap should block oversized buy');
    assert.strictEqual(risk.lastBlockReason, 'exposure_cap');
  }

  {
    const ctx = makeContext();
    const signal = makeSignal({ strategy: 'InventoryExit', side: 'sell', sizeUsd: 5, expectedEdge: 0, confidence: 0.1 });
    const evaluated = evaluate(ctx, signal, makeAsset(), makeBook());
    assert(evaluated, 'InventoryExit should bypass consensus as a risk-reducing route');
    assert.strictEqual(evaluated.metadata.consensus.route.mode, 'RISK_EXIT');
  }

  {
    const ctx = makeContext();
    const signal = makeSignal();
    const waitBook = makeBook({ bestBid: 0.30, bestAsk: 0.55, midpoint: 0.425, spread: 0.25 });
    const evaluated = evaluate(ctx, signal, makeAsset(), waitBook);
    assert.strictEqual(evaluated, null, 'WAIT route should not place or authorize orders');
  }

  console.log('engine route self-check passed');
}

run();
