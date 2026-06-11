#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONFIG,
  BotEngine,
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
    minOrderUsd: 3,
    initialCash: 100,
    maxOpenOrders: 10,
    maxTotalOpenOrderUsd: 100,
    maxTotalExposureUsd: 100,
    maxMarketExposureUsd: 100,
    maxPositionUsdPerAsset: 100,
    dustExitSuppressEnabled: true,
    dustExitLogCooldownMs: 300_000,
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

function makeAsset(tokenId = 'dust-token') {
  return {
    tokenId,
    outcome: 'YES',
    market: {
      marketId: 'dust-market',
      question: 'Dust self-check market',
      volume24h: 10_000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

function makeSellSignal(overrides = {}) {
  return new Signal({
    strategy: 'TakeProfitExit',
    tokenId: 'dust-token',
    marketId: 'dust-market',
    side: 'sell',
    price: 0.50,
    sizeUsd: 1,
    expectedEdge: 0,
    confidence: 1,
    reason: 'dust self-check',
    exitPlan: 'dust self-check',
    ttlMs: 45_000,
    maxHoldMs: 120_000,
    ...overrides,
  });
}

function seedPosition(bot, tokenId, qty, price = 0.50) {
  bot.portfolio.recordFill({
    tokenId,
    marketId: 'dust-market',
    side: 'buy',
    price,
    size: qty,
    strategy: 'Seed',
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
    const stateFile = path.join('/tmp', `engine-dust-selfcheck-${process.pid}-${Date.now()}.json`);
    const bot = new BotEngine(makeConfig({ saveState: true, stateFile }));
    const asset = makeAsset();
    seedPosition(bot, asset.tokenId, 0.458, 0.50);

    const logs = captureLogs(() => {
      bot.trySignal(makeSellSignal({ sizeUsd: 0.229 }), asset, makeBook());
      bot.trySignal(makeSellSignal({ sizeUsd: 0.229 }), asset, makeBook());
    });

    assert.strictEqual(bot.lastDustExitSuppressed.reason, 'DUST_EXIT_SUPPRESSED');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'dust exit must not place an order');
    assert(bot.portfolio.position(asset.tokenId) > 0, 'dust position must remain in portfolio state');
    bot.portfolio.saveState();
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(Number(saved.positions[asset.tokenId]) > 0, 'dust position must remain in saved state');
    assert.strictEqual(logs.filter((line) => line.includes('[DUST EXIT SUPPRESSED]')).length, 1, 'dust logs should be cooldown-limited');
  }

  {
    const bot = new BotEngine(makeConfig());
    const asset = makeAsset('dust-spread-token');
    seedPosition(bot, asset.tokenId, 0.50, 0.50);
    bot.trySignal(makeSellSignal({
      strategy: 'SpreadHunter',
      tokenId: asset.tokenId,
      sizeUsd: 0.25,
      expectedEdge: 0.02,
      confidence: 0.60,
    }), asset, makeBook());

    assert.strictEqual(bot.lastDustExitSuppressed.reason, 'DUST_EXIT_SUPPRESSED');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'dust SpreadHunter sell must not place an order');
    assert(bot.portfolio.position(asset.tokenId) > 0, 'dust SpreadHunter sell must not clear position');
  }

  {
    const bot = new BotEngine(makeConfig());
    const asset = makeAsset('normal-exit-token');
    seedPosition(bot, asset.tokenId, 10, 0.50);
    bot.trySignal(makeSellSignal({
      tokenId: asset.tokenId,
      sizeUsd: 5,
      price: 0.50,
    }), asset, makeBook());

    assert.strictEqual(bot.lastDustExitSuppressed, null, 'normal exit should not be marked as dust');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'normal >= MIN_ORDER_USD exit should route through risk and place paper order');
    assert(bot.portfolio.position(asset.tokenId) > 0, 'normal exit order should not pretend the position was sold before fill');
  }

  {
    const liveConfig = readLiveConfig(process.cwd());
    assert.strictEqual(liveConfig.enableLiveTrading, false, 'live safety not affected: ENABLE_LIVE_TRADING remains false by default');
    assert.strictEqual(liveConfig.liveAutoExecute, false, 'live safety not affected: LIVE_AUTO_EXECUTE remains false by default');
    assert.strictEqual(liveConfig.liveKillSwitch, true, 'live safety not affected: LIVE_KILL_SWITCH remains true by default');
    assert.strictEqual(liveConfig.liveDryRunOnly, true, 'live safety not affected: LIVE_DRY_RUN_ONLY remains true by default');
  }

  console.log('engine dust self-check passed');
}

run();
