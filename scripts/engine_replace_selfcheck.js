#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  CONFIG,
  PaperExecutionEngine,
  PaperPortfolio,
  Signal,
} = require('../moneymaker_v3');

function makeConfig(overrides = {}) {
  return {
    ...CONFIG,
    saveState: false,
    enableGhostMode: false,
    minOrderUsd: 1,
    initialCash: 100,
    dedupeOpenOrders: true,
    openOrderReplaceEnabled: true,
    maxOpenOrdersPerTokenSideStrategy: 1,
    openOrderReplaceMinAgeMs: 45_000,
    openOrderReplacePriceEpsilon: 0.001,
    openOrderReplaceAllowSamePrice: false,
    openOrderReplaceForceRefreshMs: 120_000,
    openOrderReplaceAfterMs: 15_000,
    maxTotalOpenOrderUsd: 100,
    ...overrides,
  };
}

function makeBook() {
  return {
    bestBid: 0.45,
    bestAsk: 0.55,
    midpoint: 0.50,
    spread: 0.10,
    tickSize: 0.01,
    cachedAt: Date.now(),
    bids: [{ price: 0.45, size: 500 }],
    asks: [{ price: 0.55, size: 500 }],
  };
}

function makeSignal(overrides = {}) {
  return new Signal({
    strategy: 'SpreadHunter',
    tokenId: 'replace-token',
    marketId: 'replace-market',
    side: 'buy',
    price: 0.756,
    sizeUsd: 3,
    expectedEdge: 0.02,
    confidence: 0.60,
    reason: 'replace self-check',
    exitPlan: 'replace self-check',
    ttlMs: 180_000,
    maxHoldMs: 300_000,
    metadata: {},
    ...overrides,
  });
}

function makeEngine(config = makeConfig()) {
  const portfolio = new PaperPortfolio(config);
  const engine = new PaperExecutionEngine(config, portfolio, { getBook: () => makeBook() }, null);
  return { config, portfolio, engine };
}

function ageOnlyOrder(portfolio, ageMs) {
  const order = [...portfolio.openOrders.values()][0];
  order.createdAt = Date.now() - ageMs;
  return order;
}

function run() {
  {
    const { portfolio, engine } = makeEngine();
    assert.strictEqual(engine.place(makeSignal(), makeBook()), true);
    ageOnlyOrder(portfolio, 36_000);
    assert.strictEqual(engine.place(makeSignal(), makeBook()), false, 'same-price replacement at 36s should be skipped');
    assert.strictEqual(portfolio.openOrders.size, 1);
    assert.strictEqual(portfolio.openOrderExposureUsd(), 3, 'same-price skip must not double-count exposure');
    assert.strictEqual(portfolio.executionHealth().duplicateSkipsLastHour, 1);
  }

  {
    const { portfolio, engine } = makeEngine();
    assert.strictEqual(engine.place(makeSignal(), makeBook()), true);
    ageOnlyOrder(portfolio, 60_000);
    assert.strictEqual(engine.place(makeSignal(), makeBook()), false, 'same-price replacement before force refresh should be skipped');
    assert.strictEqual(portfolio.openOrders.size, 1);
    assert.strictEqual(portfolio.openOrderExposureUsd(), 3);
    assert.strictEqual(portfolio.executionHealth().duplicateSkipsLastHour, 1);
  }

  {
    const { portfolio, engine } = makeEngine();
    assert.strictEqual(engine.place(makeSignal(), makeBook()), true);
    ageOnlyOrder(portfolio, 121_000);
    assert.strictEqual(engine.place(makeSignal(), makeBook()), true, 'same-price replacement after force refresh should be allowed');
    assert.strictEqual(portfolio.openOrders.size, 1);
    assert.strictEqual(portfolio.openOrderExposureUsd(), 3, 'force refresh replacement must not increase exposure');
    assert.strictEqual(portfolio.executionHealth().replacementsLastHour, 1);
  }

  {
    const { portfolio, engine } = makeEngine();
    assert.strictEqual(engine.place(makeSignal({ price: 0.756 }), makeBook()), true);
    ageOnlyOrder(portfolio, 50_000);
    assert.strictEqual(engine.place(makeSignal({ price: 0.770 }), makeBook()), true, 'meaningful price change should be allowed after min age');
    assert.strictEqual(portfolio.openOrders.size, 1);
    assert.strictEqual([...portfolio.openOrders.values()][0].price, 0.770);
    assert.strictEqual(portfolio.openOrderExposureUsd(), 3);
  }

  {
    const { portfolio, engine } = makeEngine();
    assert.strictEqual(engine.place(makeSignal({ price: 0.756 }), makeBook()), true);
    ageOnlyOrder(portfolio, 10_000);
    assert.strictEqual(engine.place(makeSignal({ price: 0.770 }), makeBook()), false, 'age guard should keep duplicate protection active');
    assert.strictEqual(portfolio.openOrders.size, 1);
    assert.strictEqual(portfolio.openOrderExposureUsd(), 3);
  }

  console.log('engine replace self-check passed');
}

run();
