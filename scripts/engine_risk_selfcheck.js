#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  CONFIG,
  EngineDiagnostics,
  RiskEngine,
  PaperPortfolio,
  Signal,
} = require('../moneymaker_v3');

function makeConfig(overrides = {}) {
  return {
    ...CONFIG,
    saveState: false,
    enableGhostMode: false,
    minSignalEdge: 0.01,
    minConfidence: 0.45,
    minOrderUsd: 1,
    initialCash: 1_000,
    maxOpenOrders: 20,
    maxTotalOpenOrderUsd: 1_000,
    maxTotalExposureUsd: 1_000,
    maxMarketExposureUsd: 1_000,
    maxPositionUsdPerAsset: 1_000,
    maxDrawdownPct: 50,
    openOrderReplaceEnabled: false,
    ...overrides,
  };
}

function makeSignal(overrides = {}) {
  return new Signal({
    strategy: 'SpreadHunter',
    tokenId: 'risk-token',
    marketId: 'risk-market',
    side: 'buy',
    price: 0.50,
    sizeUsd: 10,
    expectedEdge: 0.02,
    confidence: 0.70,
    reason: 'risk self-check',
    exitPlan: 'risk self-check exit',
    ttlMs: 45_000,
    maxHoldMs: 120_000,
    metadata: {
      consensus: {
        score: 0.9,
      },
    },
    ...overrides,
  });
}

function makeRisk(overrides = {}) {
  const config = makeConfig(overrides.config);
  const portfolio = new PaperPortfolio(config);
  const diagnostics = new EngineDiagnostics(config);
  const risk = new RiskEngine(config, portfolio, diagnostics);
  return { config, portfolio, diagnostics, risk };
}

function seedPosition(portfolio, { tokenId = 'risk-token', marketId = 'risk-market', qty = 100, avg = 0.40 } = {}) {
  portfolio.positions.set(tokenId, qty);
  portfolio.costBasis.set(tokenId, avg);
  portfolio.fills.push({
    ts: Date.now(),
    tokenId,
    marketId,
    side: 'buy',
    price: avg,
    size: qty,
    value: qty * avg,
    strategy: 'Seed',
  });
}

function expectBlock(name, overrides = {}, contextOverrides = {}) {
  const { risk } = makeRisk(contextOverrides);
  const result = risk.evaluate(makeSignal(overrides));
  assert.strictEqual(result, null, `${name} should block`);
  assert.strictEqual(risk.lastBlockReason, name);
  assert(risk.lastBlockDetails, `${name} should capture details`);
}

function run() {
  {
    const { risk } = makeRisk();
    const result = risk.evaluate(makeSignal());
    assert(result, 'valid SpreadHunter BUY should pass risk');
    assert.strictEqual(risk.lastBlockReason, null);
  }

  {
    const { portfolio, risk } = makeRisk();
    seedPosition(portfolio, { qty: 10, avg: 0.4 });
    portfolio.setMarkPrice('risk-token', 0.4);
    const details = risk.riskDetails(makeSignal({ sizeUsd: 1 }));
    assert.strictEqual(details.riskTotalExposureUsd, portfolio.totalExposureUsd(), 'risk exposure should match portfolio exposure for simple positions');
    assert.strictEqual(details.portfolioPositionExposureUsd, portfolio.positionExposureUsd(), 'position exposure breakdown should match portfolio positions');
    assert.strictEqual(details.portfolioOpenOrderExposureUsd, 0, 'simple positions should not have open-order exposure');
  }

  {
    const { portfolio, risk } = makeRisk();
    seedPosition(portfolio, { qty: 10, avg: 0.4 });
    portfolio.recordFill({
      tokenId: 'risk-token',
      marketId: 'risk-market',
      side: 'sell',
      price: 0.5,
      size: 10,
      strategy: 'Seed',
    });
    const details = risk.riskDetails(makeSignal({ sizeUsd: 1 }));
    assert.strictEqual(portfolio.position('risk-token'), 0, 'historical sell should fully close the seeded position');
    assert.strictEqual(details.riskTotalExposureUsd, 0, 'closed positions and historical fills must not be double-counted');
  }

  expectBlock('edge_below_min', { expectedEdge: 0.001 });
  expectBlock('confidence_below_min', { confidence: 0.10 });
  expectBlock('max_position_per_asset', { sizeUsd: 10 }, { config: { maxPositionUsdPerAsset: 5 } });
  expectBlock('max_total_exposure', { sizeUsd: 10 }, { config: { maxTotalExposureUsd: 5, maxMarketExposureUsd: 1_000, maxPositionUsdPerAsset: 1_000 } });
  expectBlock('cash_cap', { sizeUsd: 10 }, { config: { initialCash: 5, maxTotalExposureUsd: 1_000, maxMarketExposureUsd: 1_000, maxPositionUsdPerAsset: 1_000 } });

  {
    const { risk } = makeRisk({ config: { maxTotalExposureUsd: 5, maxMarketExposureUsd: 1_000, maxPositionUsdPerAsset: 1_000 } });
    const result = risk.evaluate(makeSignal({ sizeUsd: 10 }));
    assert.strictEqual(result, null, 'buy above the total exposure cap should block');
    assert.strictEqual(risk.lastBlockReason, 'max_total_exposure');
    assert.strictEqual(risk.lastBlockDetails.riskTotalExposureUsd, 0, 'fresh portfolio should start at zero exposure');
    assert.strictEqual(risk.lastBlockDetails.candidateSizeUsd, 10, 'risk block details should include candidate size');
    assert.strictEqual(risk.lastBlockDetails.wouldTotalExposureUsd, 10, 'risk block details should include post-trade exposure');
    assert.strictEqual(typeof risk.lastBlockDetails.portfolioPositionExposureUsd, 'number');
    assert.strictEqual(typeof risk.lastBlockDetails.portfolioOpenOrderExposureUsd, 'number');
    assert.strictEqual(typeof risk.lastBlockDetails.btcOraclePositionExposureUsd, 'number');
    assert.strictEqual(typeof risk.lastBlockDetails.btcOracleOpenOrderExposureUsd, 'number');
    assert.strictEqual(typeof risk.lastBlockDetails.nonBtcPositionExposureUsd, 'number');
    assert.strictEqual(typeof risk.lastBlockDetails.nonBtcOpenOrderExposureUsd, 'number');
  }

  {
    const { risk } = makeRisk();
    const result = risk.evaluate(makeSignal({ side: 'sell', sizeUsd: 10 }));
    assert.strictEqual(result, null, 'sell with no position should block');
    assert.strictEqual(risk.lastBlockReason, 'no_available_position');
    assert.strictEqual(risk.lastBlockDetails.availableSellQty, 0);
  }

  {
    const { portfolio, risk } = makeRisk();
    seedPosition(portfolio, { qty: 1, avg: 0.4 });
    const result = risk.evaluate(makeSignal({ side: 'sell', sizeUsd: 10, price: 0.50 }));
    assert.strictEqual(result, null, 'sell below MIN_ORDER_USD should block after position clamp');
    assert.strictEqual(risk.lastBlockReason, 'sell_size_below_min');
    assert(risk.lastBlockDetails.availableSellQty > 0);
  }

  {
    const { portfolio, risk } = makeRisk();
    seedPosition(portfolio, { qty: 100, avg: 0.4 });
    const result = risk.evaluate(makeSignal({
      strategy: 'TakeProfitExit',
      side: 'sell',
      sizeUsd: 10,
      price: 0.50,
      expectedEdge: 0,
      confidence: 0,
    }));
    assert(result, 'protective exit with valid position should pass risk');
    assert.strictEqual(risk.lastBlockReason, null);
  }

  {
    const { portfolio, risk } = makeRisk({
      config: {
        maxTotalExposureUsd: 5,
        maxMarketExposureUsd: 1_000,
        maxPositionUsdPerAsset: 1_000,
      },
    });
    seedPosition(portfolio, { qty: 20, avg: 0.4 });
    portfolio.setMarkPrice('risk-token', 0.4);
    const result = risk.evaluate(makeSignal({
      side: 'sell',
      sizeUsd: 4,
      price: 0.40,
    }));
    assert(result, 'sell reducing an existing position should pass even above the total exposure cap');
    assert.strictEqual(result.metadata.risk_exposure_reduce_allowed, true, 'sell reducing exposure should be tagged as explicitly allowed');
    assert.strictEqual(risk.lastBlockReason, null);
  }

  console.log('engine risk self-check passed');
}

run();
