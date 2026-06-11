#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  CONFIG,
  BotEngine,
  PaperOrder,
  Signal,
} = require('../moneymaker_v3');
const { readConfig: readLiveConfig } = require('../live_adapter_polymarket');

function makeConfig(overrides = {}) {
  return {
    ...CONFIG,
    saveState: false,
    enableWs: false,
    enableGhostMode: false,
    enableWhaleTracking: false,
    enableConsensus: false,
    consensusLogRejected: true,
    initialCash: 1_000,
    minOrderUsd: 1,
    maxOpenOrders: 2,
    maxOpenOrdersPerTokenSideStrategy: 1,
    maxTotalOpenOrderUsd: 1_000,
    maxTotalExposureUsd: 1_000,
    maxMarketExposureUsd: 1_000,
    maxPositionUsdPerAsset: 1_000,
    minSignalEdge: 0.001,
    minConfidence: 0.1,
    sophieExecutionQualityEnabled: true,
    sophieMinExecutionQuality: 0.55,
    sophieSlotEvictionEnabled: true,
    sophieSlotEvictionMinImprovement: 0.08,
    sophieSlotEvictionMinOpenOrderAgeMs: 60_000,
    sophieNoFillCooldownMs: 600_000,
    sophieDuplicatePressureWindowMs: 900_000,
    sophieMaxDuplicateSkipsPerTokenWindow: 20,
    sophieMaxAttemptsPerTokenWindow: 12,
    ...overrides,
  };
}

function makeBook(overrides = {}) {
  return {
    bestBid: 0.49,
    bestAsk: 0.51,
    midpoint: 0.50,
    spread: 0.02,
    tickSize: 0.01,
    cachedAt: Date.now(),
    bids: [{ price: 0.49, size: 1000 }],
    asks: [{ price: 0.51, size: 1000 }],
    ...overrides,
  };
}

function makeAsset(tokenId = 'quality-token') {
  return {
    tokenId,
    outcome: 'YES',
    market: {
      marketId: 'quality-market',
      question: 'Execution quality self-check market',
      volume24h: 10_000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

function makeSignal(overrides = {}) {
  return new Signal({
    strategy: 'SpreadHunter',
    tokenId: 'quality-token',
    marketId: 'quality-market',
    side: 'buy',
    price: 0.49,
    sizeUsd: 3,
    expectedEdge: 0.03,
    confidence: 0.75,
    reason: 'execution quality self-check',
    exitPlan: 'execution quality self-check',
    ttlMs: 180_000,
    maxHoldMs: 300_000,
    metadata: {
      consensus: { score: 0.80, authorized: true },
    },
    ...overrides,
  });
}

function makeBot(overrides = {}) {
  const bot = new BotEngine(makeConfig(overrides));
  const books = new Map();
  bot.cache = {
    getBook: (tokenId) => books.get(String(tokenId)) || makeBook(),
    markPrices: () => new Map(),
    getMarketAssets: () => [],
    setBook: (tokenId, book) => books.set(String(tokenId), book),
  };
  bot.execution.cache = bot.cache;
  return bot;
}

function addOpenOrder(bot, signal, ageMs, book = makeBook()) {
  bot.cache.setBook(signal.tokenId, book);
  const order = new PaperOrder(signal);
  order.createdAt = Date.now() - ageMs;
  bot.portfolio.addOrder(order);
  return order;
}

function seedLowFillPressure(bot, signal) {
  for (let i = 0; i < 12; i += 1) {
    bot.portfolio.recordExecutionEvent('order_placed', signal, Date.now() - 60_000 - i);
  }
  for (let i = 0; i < 25; i += 1) {
    bot.portfolio.recordExecutionEvent('duplicate_skip', signal, Date.now() - 30_000 - i);
  }
}

function makeCalibratedSignal(overrides = {}) {
  return makeSignal({
    side: 'buy',
    price: 0.47,
    expectedEdge: 0.021,
    confidence: 0.43,
    metadata: {
      consensus: { score: 0.55, authorized: true },
    },
    ...overrides,
  });
}

function makeCalibratedBook(overrides = {}) {
  return makeBook({
    bestBid: 0.50,
    bestAsk: 0.53,
    midpoint: 0.515,
    spread: 0.03,
    ...overrides,
  });
}

function captureLogs(fn) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function run() {
  {
    const bot = makeBot();
    const asset = makeAsset('low-fill-token');
    const signal = makeSignal({ tokenId: asset.tokenId });
    seedLowFillPressure(bot, signal);
    bot.trySignal(signal, asset, makeBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'THROTTLE', 'low-fill repeated token should be throttled');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'throttle must not place a new order');
  }

  {
    const bot = makeBot();
    const asset = makeAsset('high-quality-token');
    const signal = makeSignal({ tokenId: asset.tokenId });
    bot.trySignal(signal, asset, makeBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'ADMIT', 'high-quality candidate should pass when slots are available');
    assert.strictEqual(bot.portfolio.openOrders.size, 1);
  }

  {
    const bot = makeBot({ maxOpenOrders: 10 });
    const asset = makeAsset('calibrated-pass-token');
    const signal = makeCalibratedSignal({ tokenId: asset.tokenId });
    bot.trySignal(signal, asset, makeCalibratedBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'CALIBRATED_ADMIT', 'near-threshold candidate should pass calibrated floors');
    assert.strictEqual(bot.portfolio.openOrders.size, 1);
  }

  {
    const bot = makeBot({ maxOpenOrders: 10 });
    const asset = makeAsset('calibrated-low-edge');
    bot.trySignal(makeCalibratedSignal({ tokenId: asset.tokenId, expectedEdge: 0.019 }), asset, makeCalibratedBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'BLOCK_LOW_QUALITY', 'calibrated candidate should fail if edge is too low');
    assert.strictEqual(bot.portfolio.openOrders.size, 0);
  }

  {
    const bot = makeBot({ maxOpenOrders: 10 });
    const asset = makeAsset('calibrated-low-confidence');
    bot.trySignal(makeCalibratedSignal({ tokenId: asset.tokenId, confidence: 0.41 }), asset, makeCalibratedBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'BLOCK_LOW_QUALITY', 'calibrated candidate should fail if confidence is too low');
    assert.strictEqual(bot.portfolio.openOrders.size, 0);
  }

  {
    const bot = makeBot({ maxOpenOrders: 10, sophieCalibratedMinFillProb: 0.80 });
    const asset = makeAsset('calibrated-low-fill-prob');
    bot.trySignal(makeCalibratedSignal({ tokenId: asset.tokenId }), asset, makeCalibratedBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'BLOCK_LOW_QUALITY', 'calibrated candidate should fail if fill probability is too low');
    assert.strictEqual(bot.portfolio.openOrders.size, 0);
  }

  {
    const bot = makeBot({ maxOpenOrders: 10 });
    const asset = makeAsset('calibrated-far-touch');
    bot.trySignal(makeCalibratedSignal({ tokenId: asset.tokenId, price: 0.46 }), asset, makeCalibratedBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'BLOCK_LOW_QUALITY', 'calibrated candidate should fail if distance from touch is too large');
    assert.strictEqual(bot.portfolio.openOrders.size, 0);
  }

  {
    const bot = makeBot({ maxOpenOrders: 10, sophieCalibratedMaxAdmissionsPerScan: 1 });
    const first = makeCalibratedSignal({ tokenId: 'calibrated-cap-1' });
    const second = makeCalibratedSignal({ tokenId: 'calibrated-cap-2' });
    bot.trySignal(first, makeAsset(first.tokenId), makeCalibratedBook());
    bot.trySignal(second, makeAsset(second.tokenId), makeCalibratedBook());
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'calibrated admissions should be capped per scan');
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'BLOCK_LOW_QUALITY');
  }

  {
    const bot = makeBot({ maxOpenOrders: 10 });
    const asset = makeAsset('low-quality-log-token');
    const bad = makeSignal({
      tokenId: asset.tokenId,
      expectedEdge: 0.002,
      confidence: 0.20,
      metadata: { consensus: { score: 0.20, authorized: true } },
    });
    const logs = captureLogs(() => {
      bot.trySignal(bad, asset, makeBook());
      bot.trySignal(bad, asset, makeBook());
    });
    assert.strictEqual(logs.filter((line) => line.includes('decision=BLOCK_LOW_QUALITY')).length, 1, 'low-quality block logs should be cooldown-limited');
    assert.strictEqual(bot.portfolio.openOrders.size, 0);
  }

  {
    const bot = makeBot({ maxOpenOrders: 10 });
    const asset = makeAsset('bad-target-token');
    const bad = makeSignal({
      tokenId: asset.tokenId,
      expectedEdge: 0.002,
      confidence: 0.20,
      metadata: { consensus: { score: 0.20, authorized: true } },
    });
    bot.trySignal(bad, asset, makeBook());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'active order target must not force bad orders');
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'BLOCK_LOW_QUALITY');
  }

  {
    const bot = makeBot();
    addOpenOrder(bot, makeSignal({ tokenId: 'strong-old-1', price: 0.49, expectedEdge: 0.04, confidence: 0.90 }), 90_000);
    addOpenOrder(bot, makeSignal({ tokenId: 'strong-old-2', price: 0.49, expectedEdge: 0.04, confidence: 0.90 }), 90_000);
    const weak = makeSignal({ tokenId: 'weak-candidate', expectedEdge: 0.01, confidence: 0.30, metadata: { consensus: { score: 0.40, authorized: true } } });
    bot.trySignal(weak, makeAsset(weak.tokenId), makeBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'BLOCK_LOW_QUALITY', 'weak saturated candidate should be blocked');
    assert.strictEqual(bot.portfolio.openOrders.size, 2);
  }

  {
    const bot = makeBot();
    addOpenOrder(bot, makeSignal({
      tokenId: 'weak-old-1',
      price: 0.44,
      expectedEdge: 0.003,
      confidence: 0.20,
      metadata: { consensus: { score: 0.30, authorized: true } },
    }), 90_000, makeBook({ bestBid: 0.49, bestAsk: 0.51, spread: 0.02 }));
    addOpenOrder(bot, makeSignal({
      tokenId: 'weak-old-2',
      price: 0.44,
      expectedEdge: 0.003,
      confidence: 0.20,
      metadata: { consensus: { score: 0.30, authorized: true } },
    }), 90_000, makeBook({ bestBid: 0.49, bestAsk: 0.51, spread: 0.02 }));
    const strong = makeSignal({ tokenId: 'strong-candidate', price: 0.49, expectedEdge: 0.04, confidence: 0.90, metadata: { consensus: { score: 0.95, authorized: true } } });
    bot.trySignal(strong, makeAsset(strong.tokenId), makeBook());
    assert.strictEqual(bot.lastSophieQualityDecision.qualityDecision, 'EVICT_ADMIT', 'large improvement should evict weak old paper order');
    assert.strictEqual(bot.portfolio.openOrders.size, 2);
    assert([...bot.portfolio.openOrders.values()].some((order) => order.tokenId === strong.tokenId));
  }

  {
    const bot = makeBot();
    const asset = makeAsset('protective-token');
    bot.portfolio.recordFill({ tokenId: asset.tokenId, marketId: asset.market.marketId, side: 'buy', price: 0.50, size: 10, strategy: 'Seed' });
    seedLowFillPressure(bot, makeSignal({ tokenId: asset.tokenId, strategy: 'TakeProfitExit', side: 'sell' }));
    bot.trySignal(makeSignal({
      strategy: 'TakeProfitExit',
      tokenId: asset.tokenId,
      side: 'sell',
      price: 0.60,
      sizeUsd: 6,
      expectedEdge: 0,
      confidence: 1,
      metadata: {},
    }), asset, makeBook({ bestBid: 0.59, bestAsk: 0.61, midpoint: 0.60 }));
    assert.notStrictEqual(bot.lastSophieQualityDecision?.qualityDecision, 'THROTTLE', 'protective exits must not be throttled');
    assert.strictEqual(bot.portfolio.openOrders.size, 1);
  }

  {
    const bot = makeBot();
    const asset = makeAsset('dust-quality-token');
    bot.portfolio.recordFill({ tokenId: asset.tokenId, marketId: asset.market.marketId, side: 'buy', price: 0.50, size: 0.5, strategy: 'Seed' });
    bot.trySignal(makeSignal({
      strategy: 'TakeProfitExit',
      tokenId: asset.tokenId,
      side: 'sell',
      price: 0.50,
      sizeUsd: 0.25,
      expectedEdge: 0,
      confidence: 1,
      metadata: {},
    }), asset, makeBook());
    assert.strictEqual(bot.lastDustExitSuppressed.reason, 'DUST_EXIT_SUPPRESSED', 'dust must remain suppression-only');
    assert(bot.portfolio.position(asset.tokenId) > 0, 'dust must not be force-sold');
  }

  {
    const liveConfig = readLiveConfig(process.cwd());
    assert.strictEqual(liveConfig.enableLiveTrading, false);
    assert.strictEqual(liveConfig.liveAutoExecute, false);
    assert.strictEqual(liveConfig.liveKillSwitch, true);
    assert.strictEqual(liveConfig.liveDryRunOnly, true);
    assert.strictEqual(liveConfig.liveSubmitConfirm, false);
  }

  console.log('engine execution quality self-check passed');
}

run();
