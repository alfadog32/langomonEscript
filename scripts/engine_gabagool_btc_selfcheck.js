#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_PROXY_WALLET,
  DEFAULT_USERNAME,
  buildBehaviorModel,
  buildExitPlan,
  writeJsonFile,
} = require('../gabagool_btc_behavior');
const {
  CONFIG,
  BotEngine,
  PaperTelegramUpdateRelay,
  PaperPortfolio,
  RiskEngine,
  SpreadHunterStrategy,
  VolatilityGuard,
} = require('../moneymaker_v3');
const { readConfig: readLiveConfig } = require('../live_adapter_polymarket');
const { buildSettingsStatus } = require('../dashboard_server');

function makeBook(overrides = {}) {
  return {
    bestBid: 0.48,
    bestAsk: 0.50,
    midpoint: 0.49,
    spread: 0.02,
    tickSize: 0.01,
    cachedAt: Date.now(),
    bids: [{ price: 0.48, size: 100 }],
    asks: [{ price: 0.50, size: 100 }],
    ...overrides,
  };
}

function tempPath(name) {
  return path.join('/tmp', `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function makeProfile() {
  return {
    proxyWallet: DEFAULT_PROXY_WALLET,
    name: DEFAULT_USERNAME,
    pseudonym: 'Grown-Cantaloupe',
  };
}

function makeGabagoolAsset(baseStartSec, overrides = {}) {
  return {
    tokenId: 'up-token',
    outcome: 'Up',
    market: {
      marketId: 'btc-market-selfcheck',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      question: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
    },
    ...overrides,
  };
}

function makeGabagoolSignal(baseStartSec, overrides = {}) {
  const metadata = overrides.metadata || {};
  const gabagool = metadata.gabagool || {};
  return {
    id: `gabagool-selfcheck-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    strategy: 'GabagoolBtcOracleStrategy',
    tokenId: 'up-token',
    marketId: 'btc-market-selfcheck',
    side: 'buy',
    price: 0.49,
    sizeUsd: 1,
    expectedEdge: 0.12,
    confidence: 0.60,
    ttlMs: 15_000,
    maxHoldMs: 60_000,
    ...overrides,
    metadata: {
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      marketQuestion: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
      outcome: 'Up',
      ...metadata,
      gabagool: {
        oracleSignalFresh: true,
        validBook: true,
        volatilityGuardPassed: true,
        lateEntryWindowPassed: true,
        exitIntent: false,
        ...gabagool,
      },
    },
  };
}

function makeActivity(baseStartSec) {
  return [
    {
      proxyWallet: DEFAULT_PROXY_WALLET,
      timestamp: baseStartSec + 20,
      conditionId: 'cond-1',
      type: 'TRADE',
      size: 10,
      usdcSize: 3.2,
      transactionHash: '0xaaa1',
      price: 0.32,
      asset: 'up-token',
      side: 'BUY',
      outcomeIndex: 0,
      title: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
      slug: `btc-updown-5m-${baseStartSec}`,
      eventSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
      name: DEFAULT_USERNAME,
    },
    {
      proxyWallet: DEFAULT_PROXY_WALLET,
      timestamp: baseStartSec + 48,
      conditionId: 'cond-1',
      type: 'TRADE',
      size: 10,
      usdcSize: 3.1,
      transactionHash: '0xaaa2',
      price: 0.31,
      asset: 'up-token',
      side: 'BUY',
      outcomeIndex: 0,
      title: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
      slug: `btc-updown-5m-${baseStartSec}`,
      eventSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
      name: DEFAULT_USERNAME,
    },
    {
      proxyWallet: DEFAULT_PROXY_WALLET,
      timestamp: baseStartSec + 74,
      conditionId: 'cond-1',
      type: 'TRADE',
      size: 10,
      usdcSize: 6.5,
      transactionHash: '0xbbb1',
      price: 0.65,
      asset: 'down-token',
      side: 'BUY',
      outcomeIndex: 1,
      title: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
      slug: `btc-updown-5m-${baseStartSec}`,
      eventSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Down',
      name: DEFAULT_USERNAME,
    },
  ];
}

function makeClosedPositions(baseStartSec) {
  return [
    {
      proxyWallet: DEFAULT_PROXY_WALLET,
      asset: 'up-token',
      conditionId: 'cond-1',
      avgPrice: 0.31,
      totalBought: 31,
      realizedPnl: 6.9,
      curPrice: 1,
      timestamp: (baseStartSec + 320),
      title: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
      slug: `btc-updown-5m-${baseStartSec}`,
      eventSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
      outcomeIndex: 0,
      oppositeOutcome: 'Down',
      oppositeAsset: 'down-token',
      endDate: new Date((baseStartSec + 300) * 1000).toISOString(),
    },
  ];
}

function writeOracleTarget(filePath, baseStartSec) {
  writeJsonFile(filePath, {
    timestamp: new Date().toISOString(),
    target: {
      question: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
      slug: `btc-updown-5m-${baseStartSec}`,
      ts: baseStartSec,
      BTC_UP_TOKEN_ID: 'up-token',
      BTC_DOWN_TOKEN_ID: 'down-token',
      rawMarketId: 'btc-market-selfcheck',
    },
  });
}

function writeOracleSignal(filePath, {
  tokenId = 'up-token',
  direction = 'UP',
  fresh = true,
  confidence = 0.82,
  includeLegacyConfirmFields = false,
  explicitConfirmedField = undefined,
  lagScore = 0,
  btcTriggerMovePct = 0.00016,
  btcPersistedMovePct = 0.00018,
  polyMidMovePct = 0.03,
  polyMoveWeightLimitPct = 0.00005,
  initialBtcPrice = 66500,
  triggerBtcPrice = direction === 'UP' ? 66510 : 66490,
  currentBtcPrice = direction === 'UP' ? 66518 : 66482,
  bookAfterPersistence = {},
} = {}) {
  const now = Date.now();
  const payload = {
    timestamp: new Date(now).toISOString(),
    expires_at: new Date(now + (fresh ? 20_000 : -5_000)).toISOString(),
    token_id: tokenId,
    direction,
    confidence,
    lag_score: lagScore,
    suggested_action: direction === 'UP' ? 'BUY_BTC_UP_TOKEN' : 'BUY_BTC_DOWN_TOKEN',
    action: 'TELEGRAM_ALERT_ONLY',
    initial_btc_price: initialBtcPrice,
    trigger_btc_price: triggerBtcPrice,
    current_btc_price: currentBtcPrice,
    btc_trigger_move_pct: btcTriggerMovePct,
    btc_persisted_move_pct: btcPersistedMovePct,
    poly_mid_move_pct: polyMidMovePct,
    poly_move_weight_limit_pct: polyMoveWeightLimitPct,
    book_after_persistence: {
      valid: true,
      reason: 'ok',
      best_bid: direction === 'UP' ? 0.48 : 0.63,
      best_ask: direction === 'UP' ? 0.50 : 0.65,
      midpoint: direction === 'UP' ? 0.49 : 0.64,
      spread: 0.02,
      ask_depth_usd: 48,
      bid_depth_usd: 48,
      obi: 0.71,
      ...bookAfterPersistence,
    },
  };
  if (includeLegacyConfirmFields) {
    payload.poly_lag_confirmed = true;
    payload.lag_score_pass = true;
    payload.obi_confirmed = true;
  }
  if (explicitConfirmedField !== undefined) {
    payload.confirmed = explicitConfirmedField;
  }
  writeJsonFile(filePath, payload);
}

function makeConfig(paths, overrides = {}) {
  return {
    ...CONFIG,
    saveState: false,
    enableWs: false,
    enableGhostMode: false,
    enableWhaleTracking: false,
    enableConsensus: true,
    consensusLogRejected: false,
    initialCash: 100,
    baseOrderUsd: 1,
    minOrderUsd: 1,
    minFillUsd: 1,
    maxOpenOrders: 5,
    maxOpenOrdersPerTokenSideStrategy: 1,
    maxTotalOpenOrderUsd: 20,
    maxTotalExposureUsd: 20,
    maxMarketExposureUsd: 20,
    maxPositionUsdPerAsset: 5,
    minSignalEdge: 0.008,
    minConfidence: 0.70,
    standardPaperMinConfidence: 0.58,
    enableGabagoolBtcImitation: true,
    gabagoolLookbackTrades: 10,
    gabagoolMaxPaperOrderUsd: 1,
    gabagoolMaxPaperDrawdownPct: 2.0,
    gabagoolMaxPaperClosedLossUsd: 0.75,
    gabagoolPauseEntriesOnLoss: true,
    gabagoolMaxRoundTripsPerTokenPerMarket: 2,
    gabagoolReenterCooldownMs: 30_000,
    gabagoolAllowMarketReentry: false,
    gabagoolMinConfidence: 0.50,
    gabagoolMinConfidenceLive: 0.70,
    gabagoolAllowDustExits: true,
    gabagoolMinDustExitUsd: 0.01,
    gabagoolMinProfitBuffer: 0.01,
    gabagoolTelegramUpdates: true,
    gabagoolTelegramNotifyDetected: false,
    gabagoolTelegramNotifyPresophieBlocks: false,
    gabagoolTelegramNotifySophieBlocks: true,
    gabagoolTelegramNotifyRiskBlocks: true,
    gabagoolTelegramNotifyOrders: true,
    gabagoolTelegramNotifyFills: true,
    gabagoolTelegramBlockDedupeMs: 60_000,
    gabagoolTelegramRiskBlockDedupeMs: 120_000,
    gabagoolMinPrice: 0.02,
    gabagoolMaxEntryPrice: 0.85,
    gabagoolMaxPrice: 0.98,
    gabagoolAllowHighPriceEntryEdge: 0.20,
    gabagoolMinExpectedEdge: 0.0001,
    gabagoolBehaviorModelPath: paths.modelPath,
    gabagoolSignalPath: paths.signalPath,
    gabagoolTargetPath: paths.targetPath,
    gabagoolTelegramEventsPath: paths.eventsPath,
    telegramBotToken: '',
    telegramChatId: '',
    hunterMinTopDepthUsd: 5,
    hunterMaxSpread: 0.12,
    sophieExecutionQualityEnabled: true,
    sophieMinExecutionQuality: 0.35,
    ...overrides,
  };
}

function wireBooks(bot, upBook = makeBook(), downBook = makeBook({ bestBid: 0.63, bestAsk: 0.65, midpoint: 0.64 })) {
  const books = new Map([
    ['up-token', upBook],
    ['down-token', downBook],
  ]);
  bot.cache = {
    getBook: (tokenId) => books.get(String(tokenId)),
    setBook: (tokenId, book) => books.set(String(tokenId), book),
    getFreshBook: async (tokenId) => {
      const book = books.get(String(tokenId));
      if (!book) throw new Error(`missing book for ${tokenId}`);
      return book;
    },
    markPrices: () => new Map([...books.entries()].map(([tokenId, book]) => [tokenId, book.midpoint])),
    getMarketAssets: () => [],
  };
  bot.execution.cache = bot.cache;
  bot.paperUpdates = new PaperTelegramUpdateRelay(bot.config, bot.portfolio);
  bot.execution.paperUpdates = bot.paperUpdates;
}

function countRelayEvents(bot, eventType) {
  return bot.paperUpdates.events.filter((event) => event.eventType === eventType).length;
}

function latestRelayEvent(bot, eventType) {
  return bot.paperUpdates.events.filter((event) => event.eventType === eventType).slice(-1)[0] || null;
}

async function run() {
  const baseStartSec = Math.floor(Date.now() / 1000) - 40;
  const modelPath = tempPath('gabagool-model');
  const signalPath = tempPath('gabagool-signal');
  const targetPath = tempPath('gabagool-target');
  const eventsPath = tempPath('gabagool-events');

  const model = buildBehaviorModel({
    profile: makeProfile(),
    activity: makeActivity(baseStartSec),
    closedPositions: makeClosedPositions(baseStartSec),
    username: DEFAULT_USERNAME,
    expectedProxyWallet: DEFAULT_PROXY_WALLET,
    lookbackTrades: 10,
  });
  assert.strictEqual(model.source.walletMatched, true, 'fake profile wallet should resolve');
  assert.strictEqual(model.source.usernameMatched, true, 'fake profile username should resolve');
  assert(model.diagnostics.btcFiveMinuteTrades > 0, 'fake activity should produce btc 5m trades');
  writeJsonFile(modelPath, model);
  writeOracleTarget(targetPath, baseStartSec);
  const oracleTarget = {
    target: {
      question: 'Bitcoin Up or Down - June 15, 3:10AM-3:15AM ET',
      slug: `btc-updown-5m-${baseStartSec}`,
      ts: baseStartSec,
      BTC_UP_TOKEN_ID: 'up-token',
      BTC_DOWN_TOKEN_ID: 'down-token',
      rawMarketId: 'btc-market-selfcheck',
    },
  };

  {
    const dustExitPlan = buildExitPlan({
      model,
      tokenId: 'up-token',
      positionQty: 0.04,
      avgCost: 0.40,
      lastFillTs: Date.now() - 5_000,
      oracleSignal: {
        expires_at: new Date(Date.now() + 20_000).toISOString(),
        token_id: 'down-token',
      },
      oracleTarget,
      book: makeBook({ bestBid: 0.90, bestAsk: 0.91, midpoint: 0.905, spread: 0.01 }),
      now: Date.now(),
      minEdge: 0.008,
      allowDustExit: true,
      minDustExitUsd: 0.05,
    });
    assert.strictEqual(dustExitPlan.blockReason, 'dust_exit_below_min', 'microscopic Gabagool exit plans should be suppressed before signal creation');

    const zeroExitPlan = buildExitPlan({
      model,
      tokenId: 'up-token',
      positionQty: 0.001,
      avgCost: 0.40,
      lastFillTs: Date.now() - 5_000,
      oracleSignal: {
        expires_at: new Date(Date.now() + 20_000).toISOString(),
        token_id: 'down-token',
      },
      oracleTarget,
      book: makeBook({ bestBid: 0.97, bestAsk: 0.98, midpoint: 0.975, spread: 0.01 }),
      now: Date.now(),
      minEdge: 0.008,
      allowDustExit: true,
      minDustExitUsd: 0.05,
    });
    assert.strictEqual(zeroExitPlan.blockReason, 'zero_size_candidate', 'sub-cent Gabagool exit plans should be blocked before signal creation');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert(report, 'btc oracle report should build with no trades');
    assert.strictEqual(report.pnl.btcOraclePaperClosedPnl, 0, 'zero-state report should default closed pnl to zero');
    assert.strictEqual(report.pnl.btcOraclePaperOpenPnl, 0, 'zero-state report should default open pnl to zero');
    assert.strictEqual(report.exposure.totalBtcOracleExposureUsd, 0, 'zero-state report should default exposure to zero');
    assert.strictEqual(report.pipelineStats.gabagoolOrdersPlacedLastHour, 0, 'zero-state report should default order count to zero');
    assert.strictEqual(report.signalStats.oracleSignalsReadLastHour, 0, 'zero-state report should default signal count to zero');
    assert.strictEqual(report.strategyStatus.liveFlags.enableLiveTrading, false, 'report should surface live trading as disabled');
    assert.strictEqual(report.strategyStatus.liveFlags.liveAutoExecute, false, 'report should surface live auto execute as disabled');
    assert.strictEqual(report.strategyStatus.liveFlags.liveKillSwitch, true, 'report should surface live kill switch as enabled');
    assert.strictEqual(report.strategyStatus.gabagoolEntriesPaused, false, 'zero-state report should not pause Gabagool entries');
    assert.strictEqual(report.pnl.gabagoolPaperNetPnl, 0, 'zero-state report should expose zero Gabagool net pnl');
    assert.strictEqual(report.tradeQuality.gabagoolRoundTripsLastHour, 0, 'zero-state report should expose zero round trips');
    assert(bot.formatBtcOracleReport(report).includes('--- BTC ORACLE / GABAGOOL REPORT ---'), 'formatted report should include the btc oracle header');
  }

  {
    const paperConfig = makeConfig({ modelPath, signalPath, targetPath, eventsPath });
    const liveConfig = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, { enableLiveTrading: true });
    const baseSignal = {
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      expectedEdge: 0.12,
      confidence: 0.525,
      metadata: {
        marketSlug: `btc-updown-5m-${baseStartSec}`,
        outcome: 'Up',
        gabagool: {
          oracleSignalFresh: true,
          validBook: true,
          volatilityGuardPassed: true,
          lateEntryWindowPassed: true,
        },
      },
    };

    const paperRisk = new RiskEngine(paperConfig, new PaperPortfolio(paperConfig));
    const liveRisk = new RiskEngine(liveConfig, new PaperPortfolio(liveConfig));

    const paperSignalByStrategy = {
      ...baseSignal,
      strategy: 'GabagoolBtcOracleStrategy',
      metadata: JSON.parse(JSON.stringify(baseSignal.metadata)),
    };
    const paperSignalByStrategyName = {
      ...baseSignal,
      strategyName: 'GabagoolBtcOracleStrategy',
      metadata: JSON.parse(JSON.stringify(baseSignal.metadata)),
    };
    const paperSignalByMetadataStrategy = {
      ...baseSignal,
      metadata: {
        ...JSON.parse(JSON.stringify(baseSignal.metadata)),
        strategy: 'GabagoolBtcOracleStrategy',
      },
    };

    assert(paperRisk.evaluate(paperSignalByStrategy), 'paper Gabagool floor should admit confidence above GABAGOOL_MIN_CONFIDENCE');
    assert.strictEqual(paperRisk.lastBlockReason, null, 'paper Gabagool floor should not block the signal');
    assert.strictEqual(paperRisk.riskDetails(paperSignalByStrategy).thresholdSource, 'GABAGOOL_MIN_CONFIDENCE', 'paper Gabagool floor should use the paper threshold source');
    assert.strictEqual(paperRisk.riskDetails(paperSignalByStrategy).minConfidence, 0.5, 'paper Gabagool floor should use minConfidence=0.5');
    assert.strictEqual(paperRisk.riskDetails(paperSignalByStrategy).paperConfidenceOverrideEligible, true, 'paper Gabagool floor should mark override eligibility');
    assert(paperRisk.evaluate(paperSignalByStrategyName), 'Gabagool strategyName should be recognized by the confidence floor');
    assert.strictEqual(paperRisk.riskDetails(paperSignalByStrategyName).thresholdSource, 'GABAGOOL_MIN_CONFIDENCE', 'strategyName Gabagool signal should use the paper threshold source');
    assert(paperRisk.evaluate(paperSignalByMetadataStrategy), 'Gabagool metadata.strategy should be recognized by the confidence floor');
    assert.strictEqual(paperRisk.riskDetails(paperSignalByMetadataStrategy).thresholdSource, 'GABAGOOL_MIN_CONFIDENCE', 'metadata.strategy Gabagool signal should use the paper threshold source');

    assert.strictEqual(liveRisk.evaluate({
      ...baseSignal,
      strategy: 'GabagoolBtcOracleStrategy',
      metadata: JSON.parse(JSON.stringify(baseSignal.metadata)),
    }), null, 'live Gabagool floor should block the same signal');
    assert.strictEqual(liveRisk.lastBlockReason, 'confidence_below_min', 'live Gabagool floor should still block below-live-floor confidence');
    assert.strictEqual(liveRisk.lastBlockDetails.thresholdSource, 'GABAGOOL_MIN_CONFIDENCE_LIVE', 'live Gabagool floor should use the live threshold source');
    assert.strictEqual(liveRisk.lastBlockDetails.minConfidence, 0.7, 'live Gabagool floor should use the stricter live minimum');
    assert.strictEqual(liveRisk.lastBlockDetails.paperConfidenceOverrideEligible, false, 'live Gabagool floor should not mark paper override eligibility');

    const nonGabagoolRisk = new RiskEngine(paperConfig, new PaperPortfolio(paperConfig));
    assert.strictEqual(nonGabagoolRisk.evaluate({
      ...baseSignal,
      strategy: 'SpreadHunter',
      metadata: JSON.parse(JSON.stringify(baseSignal.metadata)),
    }), null, 'standard paper strategy should still be blocked when below the mixed-mode standard confidence floor');
    assert.strictEqual(nonGabagoolRisk.lastBlockReason, 'confidence_below_min', 'standard paper strategy should still be blocked by the standard confidence floor');
    assert.strictEqual(nonGabagoolRisk.lastBlockDetails.thresholdSource, 'STANDARD_PAPER_MIN_CONFIDENCE', 'standard paper strategy should use the mixed-mode standard threshold source');
    assert.strictEqual(nonGabagoolRisk.lastBlockDetails.paperConfidenceOverrideEligible, true, 'standard paper strategy should mark mixed-mode paper override eligibility');
    assert(nonGabagoolRisk.evaluate({
      ...baseSignal,
      strategy: 'SpreadHunter',
      confidence: 0.592132,
      metadata: JSON.parse(JSON.stringify(baseSignal.metadata)),
    }), 'standard paper strategy should admit near-0.58 confidence in mixed mode');
    assert.strictEqual(nonGabagoolRisk.lastBlockReason, null, 'standard paper strategy near the mixed-mode floor should no longer be blocked');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: false });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'expired oracle signal must not place an order');
    assert.strictEqual(bot.paperUpdates.events.length, 0, 'expired oracle signal should not emit Telegram updates by default');
    assert.strictEqual(health.oracleSignalsExpiredLastHour, 1, 'expired oracle signal should be counted in diagnostics');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 0, 'expired oracle signal must be blocked before Sophie');
    assert.strictEqual(report.signalStats.oracleSignalsExpiredLastHour, 1, 'expired oracle signal count should be included in the btc oracle report');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    writeOracleSignal(signalPath, {
      fresh: true,
      lagScore: 0.00012,
      btcTriggerMovePct: 0.00004,
      btcPersistedMovePct: 0.00003,
      initialBtcPrice: 66500,
      triggerBtcPrice: 66502,
      currentBtcPrice: 66502.5,
    });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'not-confirmed oracle signal must not place an order');
    assert.strictEqual(bot.paperUpdates.events.length, 0, 'not-confirmed oracle signal should not emit Telegram updates by default');
    assert.strictEqual(health.oracleSignalsNotConfirmedLastHour, 1, 'not-confirmed oracle signal should be counted in diagnostics');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 0, 'not-confirmed oracle signal must be blocked before Sophie');
    assert.strictEqual(report.signalStats.oracleSignalsNotConfirmedLastHour, 1, 'not-confirmed oracle signal count should be included in the btc oracle report');
    assert.strictEqual(report.signalStats.lastNotConfirmedReason, 'btc_move_below_threshold', 'not-confirmed signal should include a specific reason');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, { sophieMinExecutionQuality: 0.99 }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: true });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(report.signalStats.confirmedSource, 'derived_from_persistence', 'fresh signal without explicit confirmed field should derive confirmation from persistence');
    assert.strictEqual(countRelayEvents(bot, 'candidate_ready'), 1, 'fresh oracle signal should build one candidate');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'Sophie-rejected candidate must not place an order');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'fresh confirmed oracle signal should reach Sophie');
    assert.strictEqual(countRelayEvents(bot, 'sophie_blocked'), 1, 'Sophie rejection should emit one Telegram relay event');
    assert.strictEqual(report.pipelineStats.gabagoolSophieBlockedLastHour, 1, 'btc oracle report should include Sophie block counts');
    assert.strictEqual(
      latestRelayEvent(bot, 'sophie_blocked')?.notificationState,
      'PAPER ONLY BTC GABAGOOL SOPHIE_BLOCKED',
      'Sophie block should use the final Telegram state label'
    );
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      sophieMinExecutionQuality: 0.10,
      maxPositionUsdPerAsset: 0.5,
    }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: true });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'Risk-rejected candidate must not place an order');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'risk-rejected candidate should still reach Sophie');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'risk-rejected candidate should reach RiskEngine');
    assert.strictEqual(countRelayEvents(bot, 'risk_blocked'), 1, 'Risk rejection should emit one Telegram relay event');
    assert.strictEqual(report.pipelineStats.gabagoolRiskBlockedLastHour, 1, 'btc oracle report should include Risk block counts');
    assert.strictEqual(report.pipelineStats.gabagoolLastRiskBlockReason, 'max_position_per_asset', 'btc oracle report should include the last Risk block reason');
    assert.strictEqual(report.pipelineStats.gabagoolLastPlacementDecision, 'RISK_BLOCKED:risk_position_cap', 'risk blocks should surface the no-placement reason');
    assert.strictEqual(
      latestRelayEvent(bot, 'risk_blocked')?.notificationState,
      'PAPER ONLY BTC GABAGOOL RISK_BLOCKED',
      'Risk block should use the final Telegram state label'
    );
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      sophieMinExecutionQuality: 0.10,
      maxTotalExposureUsd: 1.20,
      maxMarketExposureUsd: 10,
      maxPositionUsdPerAsset: 10,
    }));
    const book = makeBook({ bestBid: 0.48, bestAsk: 0.50, midpoint: 0.49 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.49,
      size: 3,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.setMarkPrice('up-token', 0.49);
    bot.trySignal(
      makeGabagoolSignal(baseStartSec, {
        price: 0.49,
        sizeUsd: 1,
        confidence: 0.60,
      }),
      makeGabagoolAsset(baseStartSec),
      book
    );
    const event = latestRelayEvent(bot, 'risk_blocked');
    assert(event, 'max total exposure block should emit a Gabagool risk relay event');
    assert(Number.isFinite(event.riskTotalExposureUsd), 'risk relay payload should include riskTotalExposureUsd');
    assert(Number.isFinite(event.portfolioPositionExposureUsd), 'risk relay payload should include portfolioPositionExposureUsd');
    assert(Number.isFinite(event.portfolioOpenOrderExposureUsd), 'risk relay payload should include portfolioOpenOrderExposureUsd');
    assert(Number.isFinite(event.btcOraclePositionExposureUsd), 'risk relay payload should include btcOraclePositionExposureUsd');
    assert(Number.isFinite(event.btcOracleOpenOrderExposureUsd), 'risk relay payload should include btcOracleOpenOrderExposureUsd');
    assert(Number.isFinite(event.nonBtcPositionExposureUsd), 'risk relay payload should include nonBtcPositionExposureUsd');
    assert(Number.isFinite(event.nonBtcOpenOrderExposureUsd), 'risk relay payload should include nonBtcOpenOrderExposureUsd');
    assert(Number.isFinite(event.maxTotalExposureUsd), 'risk relay payload should include maxTotalExposureUsd');
    assert(Number.isFinite(event.exposureAvailableUsd), 'risk relay payload should include exposureAvailableUsd');
    assert(Number.isFinite(event.candidateSizeUsd), 'risk relay payload should include candidateSizeUsd');
    assert(Number.isFinite(event.wouldTotalExposureUsd), 'risk relay payload should include wouldTotalExposureUsd');
    const message = bot.paperUpdates.formatMessage(event);
    assert(message.includes('riskTotalExposureUsd='), 'risk relay message should include the exposure breakdown');
    assert(message.includes('wouldTotalExposureUsd='), 'risk relay message should include post-trade total exposure');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      maxTotalExposureUsd: 20,
      btcExposureBucketShare: 0.5,
      maxMarketExposureUsd: 20,
      maxPositionUsdPerAsset: 20,
    });
    const portfolio = new PaperPortfolio(config);
    const risk = new RiskEngine(config, portfolio);
    portfolio.paperTokenTradeability = new Map();
    portfolio.recordFill({
      tokenId: 'stale-btc-a',
      marketId: 'btc-stale-a',
      side: 'buy',
      price: 0.50,
      size: 12,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    portfolio.recordFill({
      tokenId: 'stale-btc-b',
      marketId: 'btc-stale-b',
      side: 'buy',
      price: 0.50,
      size: 12,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    portfolio.setMarkPrice('stale-btc-a', 0.50);
    portfolio.setMarkPrice('stale-btc-b', 0.50);
    portfolio.paperTokenTradeability.set('stale-btc-a', { status: 'stale_token_cooldown' });
    portfolio.paperTokenTradeability.set('stale-btc-b', { status: 'no_orderbook_404' });
    const admitted = risk.evaluate({
      strategy: 'GabagoolBtcOracleStrategy',
      tokenId: 'fresh-btc-entry',
      marketId: 'btc-fresh-market',
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      expectedEdge: 0.12,
      confidence: 0.60,
      metadata: {
        outcome: 'Up',
        marketSlug: `btc-updown-5m-${baseStartSec}`,
        gabagool: {
          oracleSignalFresh: true,
          validBook: true,
          volatilityGuardPassed: true,
          lateEntryWindowPassed: true,
        },
      },
    });
    assert(admitted, 'stale BTC paper exposure should not block a fresh Gabagool buy via the BTC bucket');
    const admittedDetails = risk.riskDetails(admitted);
    assert.strictEqual(admittedDetails.strategyBucketExposureRawUsd, 12, 'bucket diagnostics should expose raw BTC bucket exposure');
    assert.strictEqual(admittedDetails.strategyBucketExposureExclusionUsd, 12, 'bucket diagnostics should exclude stale BTC paper exposure');
    assert.strictEqual(admittedDetails.strategyBucketExposureUsd, 0, 'effective BTC bucket exposure should ignore stale BTC paper exposure for paper buys');

    const blockingPortfolio = new PaperPortfolio(config);
    const blockingRisk = new RiskEngine(config, blockingPortfolio);
    blockingPortfolio.paperTokenTradeability = new Map();
    blockingPortfolio.recordFill({
      tokenId: 'tradable-btc-token',
      marketId: 'btc-tradable-market',
      side: 'buy',
      price: 0.50,
      size: 16,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    blockingPortfolio.setMarkPrice('tradable-btc-token', 0.50);
    blockingPortfolio.paperTokenTradeability.set('tradable-btc-token', { status: 'tradable' });
    const blocked = blockingRisk.evaluate({
      strategy: 'GabagoolBtcOracleStrategy',
      tokenId: 'fresh-btc-entry-2',
      marketId: 'btc-fresh-market-2',
      side: 'buy',
      price: 0.49,
      sizeUsd: 3,
      expectedEdge: 0.12,
      confidence: 0.60,
      metadata: {
        outcome: 'Up',
        marketSlug: `btc-updown-5m-${baseStartSec + 300}`,
        gabagool: {
          oracleSignalFresh: true,
          validBook: true,
          volatilityGuardPassed: true,
          lateEntryWindowPassed: true,
        },
      },
    });
    assert.strictEqual(blocked, null, 'tradable BTC exposure above the bucket cap should still be blocked');
    assert.strictEqual(blockingRisk.lastBlockReason, 'btc_bucket_exposure', 'tradable BTC exposure must still count against the BTC bucket');
    assert.strictEqual(blockingRisk.lastBlockDetails.strategyBucketExposureRawUsd, 8, 'raw tradable BTC exposure should be reported');
    assert.strictEqual(blockingRisk.lastBlockDetails.strategyBucketExposureExclusionUsd, 0, 'tradable BTC exposure must not be excluded');
    assert.strictEqual(blockingRisk.lastBlockDetails.strategyBucketExposureUsd, 8, 'effective bucket exposure should still include tradable BTC inventory');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      sophieMinExecutionQuality: 0.10,
      gabagoolMaxPaperDrawdownPct: 2.0,
      gabagoolMaxPaperClosedLossUsd: 0.75,
      gabagoolPauseEntriesOnLoss: true,
    }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.19, bestAsk: 0.21, midpoint: 0.20, spread: 0.02 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'sell',
      price: 0.20,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 }));
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'loss guard should pause fresh Gabagool BUY entries');
    assert.strictEqual(report.strategyStatus.gabagoolEntriesPaused, true, 'btc report should show Gabagool entries paused');
    assert.strictEqual(report.strategyStatus.gabagoolEntryPauseReason, 'gabagool_loss_guard', 'btc report should expose the loss guard reason');
    assert.strictEqual(report.pipelineStats.gabagoolLastPlacementDecision, 'IDLE:gabagool_loss_guard', 'loss guard should surface the placement decision');
    assert.strictEqual(report.pnl.gabagoolPaperClosedPnl < 0, true, 'loss guard scenario should show negative Gabagool closed pnl');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      sophieMinExecutionQuality: 0.10,
      gabagoolMaxPaperDrawdownPct: 2.0,
      gabagoolMaxPaperClosedLossUsd: 0.75,
      gabagoolPauseEntriesOnLoss: true,
    }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.49, bestAsk: 0.50, midpoint: 0.495, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'other-token',
      marketId: 'other-market',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.recordFill({
      tokenId: 'other-token',
      marketId: 'other-market',
      side: 'sell',
      price: 0.20,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.40,
      size: 3,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.49,
      sizeUsd: 0.95,
      metadata: {
        outcome: 'Up',
        gabagool: { exitIntent: true },
      },
    }), asset, book);
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'loss guard must still allow SELL exits that reduce Gabagool inventory');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      sophieMinExecutionQuality: 0.10,
      gabagoolMaxRoundTripsPerTokenPerMarket: 2,
      gabagoolReenterCooldownMs: 30_000,
    }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    wireBooks(bot, book);
    for (let i = 0; i < 2; i += 1) {
      bot.portfolio.recordFill({
        tokenId: 'up-token',
        marketId: 'btc-market-selfcheck',
        side: 'buy',
        price: 0.50,
        size: 2,
        strategy: 'GabagoolBtcOracleStrategy',
      });
      bot.portfolio.recordFill({
        tokenId: 'up-token',
        marketId: 'btc-market-selfcheck',
        side: 'sell',
        price: 0.45,
        size: 2,
        strategy: 'GabagoolBtcOracleStrategy',
      });
    }
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, book);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'churn guard should block re-entry after repeated bad round trips');
    assert.strictEqual(report.pipelineStats.gabagoolChurnBlocksLastHour, 1, 'btc report should count churn guard blocks');
    assert.strictEqual(report.pipelineStats.gabagoolLastPlacementDecision, 'IDLE:gabagool_churn_guard', 'btc report should surface the churn guard decision');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      sophieMinExecutionQuality: 0.10,
      gabagoolMaxEntryPrice: 0.85,
      gabagoolAllowHighPriceEntryEdge: 0.20,
    }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.89, bestAsk: 0.90, midpoint: 0.895, spread: 0.01 });
    wireBooks(bot, book);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      price: 0.90,
      expectedEdge: 0.12,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, book);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'high-price weak-edge Gabagool BUY should be blocked');
    assert.strictEqual(report.pipelineStats.gabagoolHighPriceEntryBlocksLastHour, 1, 'btc report should count high-price entry guard blocks');
    assert.strictEqual(report.pipelineStats.gabagoolLastPlacementDecision, 'IDLE:gabagool_high_price_entry_guard', 'btc report should surface the high-price guard decision');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: true, confidence: 0.60 });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(report.pipelineStats.gabagoolCandidatesBuiltLastHour, 1, 'signal with BTC move above threshold should reach candidate creation');
    assert.strictEqual(report.strategyStatus.gabagoolActiveMinConfidence, 0.5, 'paper mode should use the Gabagool paper minimum confidence');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'happy path should reach Sophie');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'happy path should reach RiskEngine');
    assert.strictEqual(health.gabagoolRiskAdmittedLastHour, 1, 'paper Gabagool candidate above the paper floor should pass RiskEngine');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'candidate should create a paper order when Sophie and Risk pass');
    assert.strictEqual(report.pipelineStats.gabagoolPlacementAttemptedLastHour, 1, 'happy path should attempt one final placement');
    assert.strictEqual(report.pipelineStats.gabagoolPlacementBlockedLastHour, 0, 'happy path should not count any placement blocks');
    assert.strictEqual(report.pipelineStats.gabagoolLastPlacementDecision, 'ORDER_PLACED', 'happy path should report an order placement decision');
    assert.strictEqual(health.gabagoolOrdersPlacedLastHour, 1, 'happy path should place one paper order');
    assert.strictEqual(countRelayEvents(bot, 'order_placed'), 1, 'paper order placement should emit one Telegram relay event');
    assert.strictEqual(
      latestRelayEvent(bot, 'order_placed')?.notificationState,
      'PAPER ONLY BTC GABAGOOL ORDER_PLACED',
      'order placement should use the final Telegram state label'
    );
    assert(bot.paperUpdates.events.length > 0, 'telegram relay should emit local events without network credentials');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: true, confidence: 0.60 });
    await bot.runGabagoolBtcOracleImitation();
    writeOracleSignal(signalPath, { fresh: true, confidence: 0.60 });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'duplicate placement block should keep the original paper order only');
    assert.strictEqual(health.gabagoolPlacementAttemptedLastHour, 2, 'duplicate placement path should count both final placement attempts');
    assert.strictEqual(health.gabagoolPlacementBlockedLastHour, 1, 'duplicate placement path should count one placement block');
    assert.strictEqual(report.pipelineStats.gabagoolPlacementBlockReasonLast, 'duplicate_order', 'report should include the latest placement block reason');
    assert.strictEqual(report.pipelineStats.gabagoolLastPlacementDecision, 'PLACEMENT_BLOCKED:duplicate_order', 'report should include the latest placement decision');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      gabagoolTelegramNotifyPresophieBlocks: true,
    }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: false });
    await bot.runGabagoolBtcOracleImitation();
    await bot.runGabagoolBtcOracleImitation();
    assert.strictEqual(countRelayEvents(bot, 'presophie_block_summary'), 1, 'duplicate expired signal should not spam Telegram relay events');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      gabagoolTelegramNotifyRiskBlocks: true,
      gabagoolTelegramRiskBlockDedupeMs: 120_000,
    });
    const relay = new PaperTelegramUpdateRelay(config, new PaperPortfolio(config));
    const payload = {
      strategy: 'GabagoolBtcOracleStrategy',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      tokenId: 'up-token',
      outcome: 'Up',
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      riskDecision: 'BLOCK:max_total_exposure',
      blockReason: 'max_total_exposure',
      riskTotalExposureUsd: 2.5,
      portfolioPositionExposureUsd: 2.0,
      portfolioOpenOrderExposureUsd: 0.5,
      btcOraclePositionExposureUsd: 2.0,
      btcOracleOpenOrderExposureUsd: 0.5,
      nonBtcPositionExposureUsd: 0,
      nonBtcOpenOrderExposureUsd: 0,
      maxTotalExposureUsd: 2.0,
      exposureAvailableUsd: -0.5,
      candidateSizeUsd: 1,
      wouldTotalExposureUsd: 3.5,
    };
    const first = relay.record('risk_blocked', payload);
    assert(first, 'first max-exposure relay event should be recorded');
    const second = relay.record('risk_blocked', payload);
    assert.strictEqual(second, null, 'duplicate max-exposure relay event should be suppressed inside the dedupe window');
    const dedupeKey = relay.blockDedupeKey(first);
    relay.blockDedupe.get(dedupeKey).expiresAt = Date.now() - 1;
    const third = relay.record('risk_blocked', payload);
    assert(third, 'post-window max-exposure relay event should be recorded');
    assert.strictEqual(third.blockRepeatCount, 1, 'post-window relay event should summarize one suppressed duplicate');
    assert(relay.formatMessage(third).includes('repeatCount=1'), 'relay summary should include the repeated-block count');
  }

  for (const badAsk of [0, 0.01, 0.99]) {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(
      bot,
      makeBook({ bestBid: Math.max(0, badAsk - 0.02), bestAsk: badAsk, midpoint: badAsk > 0 ? badAsk - 0.01 : 0, spread: 0.02 })
    );
    writeOracleSignal(signalPath, { fresh: true });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(bot.portfolio.openOrders.size, 0, `price ${badAsk} must be blocked before Sophie`);
    assert.strictEqual(bot.paperUpdates.events.length, 0, `price ${badAsk} should not emit Telegram updates by default`);
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 0, `price ${badAsk} must not reach Sophie`);
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(
      bot,
      makeBook({ bestBid: 0.89, bestAsk: 0.90, midpoint: 0.895, spread: 0.01 })
    );
    writeOracleSignal(signalPath, { fresh: true, confidence: 0.60 });
    await assert.doesNotReject(
      async () => bot.runGabagoolBtcOracleImitation(),
      'Gabagool selfcheck should never crash on rawSignal fallback paths'
    );
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook();
    wireBooks(bot, book);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      sizeUsd: 0,
      metadata: {
        outcome: 'Up',
        gabagool: { exitIntent: true },
      },
    }), asset, book);
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'zero-size SELL candidate must not place an order');
    assert.strictEqual(health.gabagoolZeroSizeBlockedLastHour, 1, 'zero-size SELL candidate should increment the zero-size counter');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 0, 'zero-size SELL candidate must be blocked before Sophie');
    assert.strictEqual(report.pipelineStats.gabagoolZeroSizeBlockedLastHour, 1, 'btc report should include zero-size blocked counts');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook();
    wireBooks(bot, book);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      sizeUsd: 0,
    }), asset, book);
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'zero-size BUY candidate must not place an order');
    assert.strictEqual(health.gabagoolZeroSizeBlockedLastHour, 1, 'zero-size BUY candidate should increment the zero-size counter');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 0, 'zero-size BUY candidate must be blocked before Sophie');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.50, bestAsk: 0.51, midpoint: 0.505, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.40,
      size: 3,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.50,
      sizeUsd: 0.95,
      metadata: {
        outcome: 'Up',
        gabagool: { exitIntent: true },
      },
    }), asset, book);
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'Gabagool dust SELL above the dust floor should still place an order');
    bot.execution.processOpenOrders();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'dust SELL should fill and clear the open order');
    assert.strictEqual(health.gabagoolDustExitsLastHour, 1, 'dust SELL fill should increment dust exit counts');
    assert.strictEqual(health.gabagoolDustExitAllowedLastHour, 1, 'dust SELL below MIN_ORDER_USD should be explicitly allowed for inventory reduction');
      assert.strictEqual(health.gabagoolDustPositionRemainingLastHour, 0, 'batched dust exit should not leave remaining dust inventory');
      assert.strictEqual(bot.portfolio.position('up-token'), 0, 'batched dust SELL should clear the token position');
    assert.strictEqual(report.exitStats.gabagoolLastExitClassification, 'dust_exit', 'dust SELL fill should be classified as a dust exit');
    assert.strictEqual(report.exitStats.gabagoolDustExitAllowedLastHour, 1, 'btc report should count allowed dust exits');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.50, bestAsk: 0.51, midpoint: 0.505, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.40,
      size: 0.001,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    writeOracleSignal(signalPath, { fresh: false, confidence: 0.60, tokenId: 'down-token' });
    await bot.runGabagoolBtcOracleImitation();
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'sub-cent dust should remain unsold when it cannot clear the floor');
    assert.strictEqual(health.gabagoolZeroSizeBlockedLastHour, 1, 'sub-cent dust should prevent repeated upstream zero-size candidate generation');
    assert.strictEqual(report.pipelineStats.gabagoolZeroSizeSourceLast, 'position_value_rounds_to_zero', 'btc report should expose the last upstream zero-size source');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook();
    wireBooks(bot, book);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      sizeUsd: 0.95,
      price: 0.49,
    }), asset, book);
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'new BUY below MIN_ORDER_USD must still be blocked');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'undersized BUY should still reach RiskEngine after Sophie');
    assert.strictEqual(health.gabagoolRiskBlockedLastHour, 1, 'undersized BUY should be counted as a Risk block');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.50, bestAsk: 0.51, midpoint: 0.505, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.40,
      size: 3,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.50,
      sizeUsd: 1.0,
      metadata: {
        outcome: 'Up',
        gabagool: { exitIntent: true },
      },
    }), asset, book);
    bot.execution.processOpenOrders();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(report.exitStats.gabagoolProfitExitsLastHour, 1, 'SELL above average entry should be classified as a profit exit');
    assert.strictEqual(report.exitStats.gabagoolLastExitClassification, 'profit_exit', 'profit exit should be reported');
    assert(report.exitStats.gabagoolLastExitPnl > 0, 'profit exit should report positive realized pnl');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.30, bestAsk: 0.31, midpoint: 0.305, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
      side: 'buy',
      price: 0.82,
      size: 2,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.74,
      sizeUsd: 1.48,
      metadata: {
        outcome: 'Up',
        gabagool: { exitIntent: true },
      },
    }), asset, book);
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'normal SELL below average entry must be blocked before order placement');
    assert.strictEqual(health.gabagoolLossExitBlocksLastHour, 1, 'blocked below-cost SELL should increment blocked loss-exit counts');
    assert.strictEqual(report.exitStats.gabagoolLossExitBlocksLastHour, 1, 'btc report should expose blocked loss-exit counts');
    assert.strictEqual(bot.lastGabagoolPlacementDecision, 'IDLE:blocked_loss_exit', 'capital protection should surface blocked_loss_exit as the last decision');
    assert.strictEqual(latestRelayEvent(bot, 'risk_blocked')?.blockReason, 'blocked_loss_exit', 'blocked below-cost SELL should relay a blocked_loss_exit warning');
    assert.strictEqual(typeof report.exitStats.gabagoolInventoryReducesLastHour, 'number', 'btc report should expose inventory reduce counters');
    assert.strictEqual(typeof report.exitStats.gabagoolInvalidZeroSizeLastHour, 'number', 'btc report should expose invalid zero-size counters');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.65, bestAsk: 0.66, midpoint: 0.655, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
      side: 'buy',
      price: 0.76,
      size: 2,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.65,
      sizeUsd: 1.30,
      metadata: {
        outcome: 'Up',
        reduceOnly: true,
        gabagool: {
          exitIntent: true,
          exitMode: 'loss_guard_reduce_only',
          exitTrigger: 'loss_guard_reduce_only',
        },
      },
    }), asset, book);
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'forced reduce-only SELL below average entry should still place');
    bot.execution.processOpenOrders();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(report.exitStats.gabagoolLossExitsLastHour, 1, 'forced emergency SELL below average entry should classify as loss_exit');
    assert.strictEqual(report.exitStats.gabagoolLastExitClassification, 'loss_exit', 'forced emergency SELL should never classify as profit_exit or dust_exit');
    assert.strictEqual(report.pipelineStats.gabagoolMarketLockoutReasonLast, 'loss_exit_market_lockout', 'forced loss exit should lock out the market immediately');
    assert(report.exitStats.gabagoolLastExitPnl < 0, 'forced loss exit should report negative realized pnl');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook();
    wireBooks(bot, book);
    bot.lastGabagoolOracleTarget = oracleTarget.target;
    bot.portfolio.recordFill({
      tokenId: 'legacy-dust-token',
      marketId: 'legacy-market',
      side: 'buy',
      price: 0.50,
      size: 0.02,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, book);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'stale tiny dust with unknown direction must not block a fresh current-market BUY');
    assert.strictEqual(report.pipelineStats.gabagoolSameMarketDirectionBlocksLastHour, 0, 'ignored stale dust must not increment same-market direction blocks');
    assert.strictEqual(report.pipelineStats.gabagoolStaleDustIgnoredLastHour, 1, 'ignored stale dust should be counted');
    assert.strictEqual(report.pipelineStats.gabagoolSameMarketUnknownDirectionIgnoredLastHour, 1, 'unknown-direction dust should be counted separately');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const upAsset = makeGabagoolAsset(baseStartSec);
    const downAsset = makeGabagoolAsset(baseStartSec, { tokenId: 'down-token', outcome: 'Down' });
    const upBook = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    const downBook = makeBook({ bestBid: 0.63, bestAsk: 0.65, midpoint: 0.64, spread: 0.02 });
    wireBooks(bot, upBook, downBook);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), upAsset, upBook);
    bot.execution.processOpenOrders();
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      tokenId: 'down-token',
      side: 'buy',
      price: 0.64,
      sizeUsd: 1,
      confidence: 0.60,
      metadata: {
        outcome: 'Down',
        gabagool: {
          oracleSignalFresh: true,
          validBook: true,
          volatilityGuardPassed: true,
          lateEntryWindowPassed: true,
          exitIntent: false,
        },
      },
    }), downAsset, downBook);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'opposite-direction entry in the same market must be blocked');
    assert.strictEqual(report.pipelineStats.gabagoolSameMarketDirectionBlocksLastHour, 1, 'same-market opposite-direction blocks should be counted');
    assert.strictEqual(bot.lastGabagoolPlacementDecision, 'IDLE:gabagool_same_market_direction_guard', 'same-market direction guard should surface in the last decision');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const upAsset = makeGabagoolAsset(baseStartSec);
    const upBook = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    wireBooks(bot, upBook);
    bot.portfolio.recordFill({
      tokenId: 'down-token',
      marketId: 'btc-market-selfcheck',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Down',
      side: 'buy',
      price: 0.64,
      size: 2,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), upAsset, upBook);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'a real current-market DOWN position must block a new UP entry');
    assert.strictEqual(report.pipelineStats.gabagoolSameMarketDirectionBlocksLastHour, 1, 'DOWN-to-UP same-market blocks should be counted');
    assert.strictEqual(bot.lastGabagoolPlacementDecision, 'IDLE:gabagool_same_market_direction_guard', 'DOWN-to-UP guard should surface in the last decision');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const entryBook = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    wireBooks(bot, entryBook);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, entryBook);
    bot.execution.processOpenOrders();
    const exitBook = makeBook({ bestBid: 0.60, bestAsk: 0.61, midpoint: 0.605, spread: 0.01 });
    wireBooks(bot, exitBook);
    const fullExitUsd = Number((bot.portfolio.availablePositionQty('up-token') * Number(exitBook.bestBid)).toFixed(2));
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.60,
      sizeUsd: fullExitUsd,
      metadata: {
        outcome: 'Up',
        gabagool: { exitIntent: true },
      },
    }), asset, exitBook);
    bot.execution.processOpenOrders();
    wireBooks(bot, entryBook);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, entryBook);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'same-direction reentry after a completed round trip must stay blocked unless explicitly enabled');
    assert.strictEqual(bot.lastGabagoolBlockedReason, 'gabagool_reentry_guard', 'completed round trips should lock same-token reentry');
    assert.strictEqual(report.pipelineStats.gabagoolReentryBlocksLastHour, 1, 'completed round-trip reentry blocks should be counted');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const upAsset = makeGabagoolAsset(baseStartSec);
    const downAsset = makeGabagoolAsset(baseStartSec, { tokenId: 'down-token', outcome: 'Down' });
    const upBook = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    const downBook = makeBook({ bestBid: 0.63, bestAsk: 0.65, midpoint: 0.64, spread: 0.02 });
    wireBooks(bot, upBook, downBook);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), upAsset, upBook);
    bot.execution.processOpenOrders();
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.30,
      sizeUsd: 0.60,
      metadata: {
        outcome: 'Up',
        reduceOnly: true,
        gabagool: {
          exitIntent: true,
          exitMode: 'loss_guard_reduce_only',
          exitTrigger: 'loss_guard_reduce_only',
        },
      },
    }), upAsset, makeBook({ bestBid: 0.30, bestAsk: 0.31, midpoint: 0.305, spread: 0.01 }));
    bot.execution.processOpenOrders();
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      tokenId: 'down-token',
      side: 'buy',
      price: 0.64,
      sizeUsd: 1,
      confidence: 0.60,
      metadata: {
        outcome: 'Down',
        gabagool: {
          oracleSignalFresh: true,
          validBook: true,
          volatilityGuardPassed: true,
          lateEntryWindowPassed: true,
          exitIntent: false,
        },
      },
    }), downAsset, downBook);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'market lockout after a loss exit must block every new BUY in that market');
    assert.strictEqual(bot.lastGabagoolBlockedReason, 'gabagool_market_lockout', 'loss-exit market lockout should block fresh entries');
    assert.strictEqual(report.pipelineStats.gabagoolMarketLockoutReasonLast, 'loss_exit_market_lockout', 'btc report should surface the most recent market lockout reason');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.55, bestAsk: 0.56, midpoint: 0.555, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
      side: 'buy',
      price: 0.60,
      size: 2,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'sell',
      price: 0.55,
      sizeUsd: 1.10,
      metadata: {
        outcome: 'Up',
        reduceOnly: true,
        gabagool: {
          exitIntent: true,
          exitMode: 'loss_guard_reduce_only',
          exitTrigger: 'loss_guard_reduce_only',
        },
      },
    }), asset, book);
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'reduce-only SELL should be the only admitted lifecycle action');
    assert.strictEqual([...bot.portfolio.openOrders.values()][0].side, 'sell', 'the placed lifecycle action should be the reduce-only SELL');
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.56,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, book);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'immediate BUY after SELL in the same loop must be blocked');
    assert.strictEqual(report.pipelineStats.gabagoolReentryBlocksLastHour, 1, 'same-loop BUY after SELL should count as a Gabagool re-entry block');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'buy',
      price: 0.50,
      size: 2,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      side: 'sell',
      price: 0.70,
      size: 1,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert(report.pnl.btcOraclePaperClosedPnl > 0, 'btc oracle report should include realized pnl after fake fills');
    assert(report.pnl.btcOraclePaperOpenPnl < 0, 'btc oracle report should include open pnl after fake fills');
    assert(report.exposure.totalBtcOracleExposureUsd > 0, 'btc oracle report should include open exposure after fake fills');
    assert.strictEqual(typeof report.exposure.audit.riskExposureUsd, 'number', 'btc oracle report should expose the risk audit total');
    assert.strictEqual(typeof report.exposure.audit.portfolioExposureUsd, 'number', 'btc oracle report should expose the portfolio audit total');
    assert.strictEqual(typeof report.exposure.audit.btcOracleExposureUsd, 'number', 'btc oracle report should expose the strategy audit total');
    assert.strictEqual(typeof report.exposure.audit.exposureMismatchUsd, 'number', 'btc oracle report should expose the audit mismatch');
    assert.strictEqual(typeof report.exposure.audit.exposureAvailableUsd, 'number', 'btc oracle report should expose the remaining exposure headroom');
    assert.strictEqual(typeof report.pnl.gabagoolPaperClosedPnl, 'number', 'btc oracle report should expose Gabagool closed pnl');
    assert.strictEqual(typeof report.pnl.gabagoolPaperUnrealizedPnl, 'number', 'btc oracle report should expose Gabagool unrealized pnl');
    assert.strictEqual(typeof report.pnl.gabagoolPaperNetPnl, 'number', 'btc oracle report should expose Gabagool net pnl');
    assert.strictEqual(typeof report.tradeQuality.gabagoolAvgRoundTripPnl, 'number', 'btc oracle report should expose average round-trip pnl');
    assert.strictEqual(typeof report.tradeQuality.gabagoolDustExitPnl, 'number', 'btc oracle report should expose dust exit pnl');
    assert.strictEqual(typeof report.dust.gabagoolDustPositionsCount, 'number', 'btc oracle report should expose dust position counts');
    assert.strictEqual(typeof report.dust.gabagoolDustValueUsd, 'number', 'btc oracle report should expose dust position value');
    assert(bot.formatBtcOracleReport(report).includes('Exposure Audit:'), 'formatted btc oracle report should include the exposure audit line');
    assert(bot.formatBtcOracleReport(report).includes('Gabagool PnL:'), 'formatted btc oracle report should include the Gabagool pnl line');
    assert(bot.formatBtcOracleReport(report).includes('Round Trips:'), 'formatted btc oracle report should include round-trip stats');
    assert.strictEqual(report.tradeQuality.winLossProxy, '1/0', 'btc oracle report should include a win/loss proxy after fake fills');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      maxTotalExposureUsd: 4.5,
      maxMarketExposureUsd: 10,
      maxPositionUsdPerAsset: 10,
    }));
    wireBooks(bot);
    bot.portfolio.recordFill({
      tokenId: 'other-token',
      marketId: 'other-market',
      side: 'buy',
      price: 0.50,
      size: 10,
      strategy: 'SpreadHunter',
    });
    bot.portfolio.setMarkPrice('other-token', 0.50);
    writeOracleSignal(signalPath, { fresh: true, confidence: 0.60 });
    await bot.runGabagoolBtcOracleImitation();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'cap-saturated entry path should wait for exits instead of placing a new BUY');
    assert.strictEqual(report.pipelineStats.gabagoolLastPlacementDecision, 'IDLE:exposure_cap_waiting_for_exit', 'btc oracle report should surface the exposure-cap waiting state');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      enableBtcOracleReport: true,
      btcOracleReportTelegram: false,
      btcOracleReportEveryMs: 60_000,
      btcOracleReportTelegramEveryMs: 300_000,
    }));
    wireBooks(bot);
    const telegramMessages = [];
    bot.paperUpdates.sendToTelegram = (message) => telegramMessages.push(message);
    bot.maybeEmitBtcOracleReport({ markPrices: bot.cache.markPrices(), now: 600_000 });
    assert.strictEqual(telegramMessages.length, 0, 'btc oracle report should not send Telegram summaries when disabled');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      enableBtcOracleReport: true,
      btcOracleReportTelegram: true,
      btcOracleReportEveryMs: 60_000,
      btcOracleReportTelegramEveryMs: 300_000,
    }));
    wireBooks(bot);
    const telegramMessages = [];
    bot.paperUpdates.sendToTelegram = (message) => telegramMessages.push(message);
    const fixedNow = 600_000;
    bot.maybeEmitBtcOracleReport({ markPrices: bot.cache.markPrices(), now: fixedNow });
    bot.maybeEmitBtcOracleReport({ markPrices: bot.cache.markPrices(), now: fixedNow });
    assert.strictEqual(telegramMessages.length, 1, 'btc oracle report should send one Telegram summary when enabled');
    assert(telegramMessages[0].includes('PAPER ONLY BTC ORACLE REPORT'), 'btc oracle Telegram summary should use the compact report header');
  }

  {
    const settingsStatus = buildSettingsStatus({
      processes: [{
        name: 'langomonEscript',
        pmId: 14,
        rawPm2Env: {
          STATE_FILE: 'moneymaker_v3_state_runtime.json',
          INITIAL_CASH: '20',
          MAX_TOTAL_EXPOSURE_USD: '10',
        },
      }],
    });
    assert.strictEqual(settingsStatus.pm2ProcessId, 14, 'dashboard status should preserve the active PM2 process id');
    assert.strictEqual(settingsStatus.runtime.STATE_FILE, 'moneymaker_v3_state_runtime.json', 'dashboard status should expose the PM2 runtime state file');
    assert(settingsStatus.mismatches.some((line) => line.startsWith('STATE_FILE:')), 'dashboard status should detect STATE_FILE mismatches between PM2 and .env');
    assert(settingsStatus.mismatches.some((line) => line.startsWith('INITIAL_CASH:')), 'dashboard status should detect runtime cash mismatches between PM2 and .env');
    assert(settingsStatus.mismatches.some((line) => line.startsWith('MAX_TOTAL_EXPOSURE_USD:')), 'dashboard status should detect runtime exposure mismatches between PM2 and .env');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      enableConsensus: false,
      minSignalEdge: 0.02,
      standardMinSignalEdge: 0.004,
      minConfidence: 0.70,
      maxTotalExposureUsd: 20,
      maxMarketExposureUsd: 10,
      maxPositionUsdPerAsset: 5,
    }));
    wireBooks(bot);
    const standardTokenId = 'standard-spreadhunter-token';
    const standardBook = makeBook({
      bestBid: 0.45,
      bestAsk: 0.53,
      midpoint: 0.49,
      spread: 0.08,
      bids: [{ price: 0.45, size: 200 }],
      asks: [{ price: 0.53, size: 200 }],
    });
    bot.cache.setBook(standardTokenId, standardBook);
    const asset = {
      tokenId: standardTokenId,
      outcome: 'Yes',
      market: {
        marketId: 'standard-market-selfcheck',
        marketSlug: 'standard-market-selfcheck',
        question: 'Will the standard paper lane place an order?',
        volume24h: 250000,
        endDate: new Date(Date.now() + (24 * 60 * 60_000)).toISOString(),
      },
    };
    const signal = {
      id: `standard-selfcheck-${Date.now()}`,
      strategy: 'SpreadHunter',
      tokenId: standardTokenId,
      marketId: asset.market.marketId,
      side: 'buy',
      price: standardBook.bestBid,
      sizeUsd: 1,
      expectedEdge: 0.01,
      confidence: 0.76,
      ttlMs: 15_000,
      maxHoldMs: 60_000,
      metadata: {
        marketQuestion: asset.market.question,
        outcome: asset.outcome,
      },
    };
    bot.trySignal(signal, asset, standardBook);
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'standard SpreadHunter candidate should place independently in mixed mode');
    assert.strictEqual(health.paperOrdersPlacedLastHour, 1, 'standard mixed-mode order should count as a paper order');
    assert.strictEqual(health.gabagoolOrdersPlacedLastHour, 0, 'standard mixed-mode order should not be counted as a Gabagool order');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      enableConsensus: false,
      minOrderUsd: 1,
      minFillUsd: 1,
    }));
    wireBooks(bot);
    const tokenId = 'standard-dust-cleanup-token';
    const cleanupBook = makeBook({
      bestBid: 0.40,
      bestAsk: 0.42,
      midpoint: 0.41,
      spread: 0.02,
      bids: [{ price: 0.40, size: 200 }],
      asks: [{ price: 0.42, size: 200 }],
    });
    bot.cache.setBook(tokenId, cleanupBook);
    const asset = {
      tokenId,
      outcome: 'Yes',
      market: {
        marketId: 'standard-dust-cleanup-market',
        marketSlug: 'standard-dust-cleanup-market',
        question: 'Can reduce-only standard dust clean up below $1?',
        volume24h: 50000,
        endDate: new Date(Date.now() + (12 * 60 * 60_000)).toISOString(),
      },
    };
    bot.portfolio.recordFill({
      tokenId,
      marketId: asset.market.marketId,
      side: 'buy',
      price: 0.40,
      size: 0.2,
      strategy: 'SpreadHunter',
    });
    bot.trySignal({
      id: `standard-dust-cleanup-${Date.now()}`,
      strategy: 'InventoryExit',
      tokenId,
      marketId: asset.market.marketId,
      side: 'sell',
      price: cleanupBook.bestBid,
      sizeUsd: 0.08,
      expectedEdge: 0,
      confidence: 0.20,
      ttlMs: 15_000,
      maxHoldMs: 60_000,
      metadata: {
        marketQuestion: asset.market.question,
        outcome: asset.outcome,
        reduceOnly: true,
      },
    }, asset, cleanupBook);
    assert.strictEqual(bot.execution.lastPlacementDecision?.reason, 'order_placed', 'reduce-only standard dust cleanup should place below MIN_ORDER_USD');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'reduce-only standard dust cleanup should create one SELL order');
    assert.strictEqual([...bot.portfolio.openOrders.values()][0].side, 'sell', 'reduce-only standard dust cleanup must remain a SELL order');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      enableConsensus: false,
      minOrderUsd: 1,
      minFillUsd: 1,
    });
    const portfolio = new PaperPortfolio(config);
    const risk = new RiskEngine(config, portfolio);
    const tokenId = 'standard-reserved-dust-token';
    const marketId = 'standard-reserved-dust-market';
    portfolio.recordFill({
      tokenId,
      marketId,
      side: 'buy',
      price: 0.88,
      size: 0.037463,
      strategy: 'SpreadHunter',
    });
    portfolio.addOrder({
      id: 'reserved-standard-sell',
      tokenId,
      marketId,
      side: 'sell',
      strategy: 'SpreadHunter',
      price: 0.91,
      createdAt: Date.now() - 5_000,
      signal: {
        strategy: 'SpreadHunter',
        tokenId,
        marketId,
        side: 'sell',
        price: 0.91,
        sizeUsd: 1,
        metadata: { outcome: 'No' },
      },
      remainingUsd() {
        return 0.034091;
      },
    });
    const admitted = risk.evaluate({
      strategy: 'SpreadHunter',
      tokenId,
      marketId,
      side: 'sell',
      price: 0.91,
      sizeUsd: 1,
      expectedEdge: 0.011,
      confidence: 0.592132,
      metadata: { outcome: 'No' },
    });
    assert(admitted, 'reserved-inventory replacement sell should bypass the $1 floor');
    assert.strictEqual(risk.lastBlockReason, null, 'reserved-inventory replacement sell should not trip sell_size_below_min');
    assert(admitted.sizeUsd > 0 && admitted.sizeUsd < 1, 'reserved-inventory replacement sell should clamp down to the tiny remaining quantity');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      enableConsensus: false,
      minOrderUsd: 1,
      minFillUsd: 1,
    });
    const portfolio = new PaperPortfolio(config);
    const risk = new RiskEngine(config, portfolio);
    const tokenId = 'standard-batch-cleanup-token';
    const marketId = 'standard-batch-cleanup-market';
    const sellPrice = 0.86;
    const qty = 1.205982558139535;
    portfolio.recordFill({
      tokenId,
      marketId,
      side: 'buy',
      price: 0.83,
      size: qty,
      strategy: 'SpreadHunter',
    });
    const admitted = risk.evaluate({
      strategy: 'SpreadHunter',
      tokenId,
      marketId,
      side: 'sell',
      price: sellPrice,
      sizeUsd: 1,
      expectedEdge: 0.02,
      confidence: 0.70,
      metadata: { outcome: 'No' },
    });
    assert(admitted, 'reduce-only sell that would leave dust should still admit');
    assert(Math.abs(admitted.sizeUsd - (qty * sellPrice)) < 1e-9, 'reduce-only sell should batch out the entire remaining position');
    assert.strictEqual(admitted.metadata.dust_exit_batch, true, 'batched cleanup should mark dust_exit_batch');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      enableConsensus: false,
      standardChurnCooldownMs: 60_000,
      standardChurnMinEdgeImprovement: 0.003,
    });
    const bot = new BotEngine(config);
    wireBooks(bot);
    const tokenId = 'standard-churn-token';
    const marketId = 'standard-churn-market';
    const book = makeBook({
      bestBid: 0.83,
      bestAsk: 0.86,
      midpoint: 0.845,
      spread: 0.03,
      bids: [{ price: 0.83, size: 250 }],
      asks: [{ price: 0.86, size: 250 }],
    });
    bot.cache.setBook(tokenId, book);
    const asset = {
      tokenId,
      outcome: 'Yes',
      market: {
        marketId,
        marketSlug: marketId,
        question: 'Will standard churn reentry be throttled?',
        volume24h: 250000,
        endDate: new Date(Date.now() + (24 * 60 * 60_000)).toISOString(),
      },
    };
    bot.updateStandardChurnCooldownOnFill({
      order: {
        strategy: 'SpreadHunter',
        side: 'sell',
        tokenId,
        marketId,
        signal: { expectedEdge: 0.011 },
      },
      fillDetails: { positionQtyAfter: 0 },
      fillPrice: 0.86,
      now: Date.now(),
      book,
    });
    bot.trySignal({
      id: `standard-churn-block-${Date.now()}`,
      strategy: 'SpreadHunter',
      tokenId,
      marketId,
      side: 'buy',
      price: 0.83,
      sizeUsd: 1,
      expectedEdge: 0.011,
      confidence: 0.61,
      ttlMs: 15_000,
      maxHoldMs: 60_000,
      metadata: { outcome: 'Yes', marketSlug: marketId },
    }, asset, book);
    assert.strictEqual(bot.execution.lastPlacementDecision?.reason, 'standard_churn_guard', 'recent standard round-trip should block immediate same-edge reentry');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'blocked standard churn reentry should not place an order');

    bot.trySignal({
      id: `standard-churn-allow-${Date.now()}`,
      strategy: 'SpreadHunter',
      tokenId,
      marketId,
      side: 'buy',
      price: 0.83,
      sizeUsd: 1,
      expectedEdge: 0.0145,
      confidence: 0.61,
      ttlMs: 15_000,
      maxHoldMs: 60_000,
      metadata: { outcome: 'Yes', marketSlug: marketId },
    }, asset, book);
    assert.strictEqual(bot.execution.lastPlacementDecision?.reason, 'order_placed', 'improved-edge reentry should pass the standard churn guard');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      spreadHunterGhostGateEnabled: true,
      spreadHunterMinGhostFavorablePct: 15,
      spreadHunterGhostMinSamples: 10,
      spreadHunterGhostSizeMultiplier: 0.25,
      baseOrderUsd: 2,
      minOrderUsd: 1,
    });
    const portfolio = new PaperPortfolio(config);
    portfolio.ghostStats = { total: 100, favorable: 8, unfavorable: 92 };
    portfolio.recordFill({
      tokenId: 'ghost-throttle-token',
      marketId: 'ghost-throttle-market',
      side: 'buy',
      price: 0.40,
      size: 3,
      strategy: 'SpreadHunter',
    });
    const strategy = new SpreadHunterStrategy(config, null, portfolio, new VolatilityGuard(config));
    const asset = {
      tokenId: 'ghost-throttle-token',
      outcome: 'Yes',
      market: {
        marketId: 'ghost-throttle-market',
        marketSlug: 'ghost-throttle-market',
        question: 'Will poor ghost calibration suppress new entries but keep exits?',
        volume24h: 250000,
        endDate: new Date(Date.now() + (24 * 60 * 60_000)).toISOString(),
      },
    };
    const signals = await strategy.generate(asset, makeBook({
      bestBid: 0.40,
      bestAsk: 0.48,
      midpoint: 0.44,
      spread: 0.08,
      bids: [{ price: 0.40, size: 300 }],
      asks: [{ price: 0.48, size: 300 }],
    }));
    assert(signals.every((signal) => signal.side !== 'buy'), 'ghost throttle should suppress undersized new entries');
    assert(signals.some((signal) => signal.side === 'sell'), 'ghost throttle should still allow exits');
  }

  const liveConfig = readLiveConfig(process.cwd());
  assert.strictEqual(liveConfig.enableLiveTrading, false, 'live adapter must stay disabled');
  assert.strictEqual(liveConfig.liveAutoExecute, false, 'live auto execute must stay disabled');
  assert.strictEqual(liveConfig.liveKillSwitch, true, 'live kill switch must stay enabled');
  assert.strictEqual(liveConfig.liveDryRunOnly, true, 'live dry run must stay enabled');
  assert.strictEqual(liveConfig.liveSubmitConfirm, false, 'live submit confirm must stay disabled');

  console.log('engine gabagool btc self-check passed');
}

run();
