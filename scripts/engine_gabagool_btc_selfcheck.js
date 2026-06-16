#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_PROXY_WALLET,
  DEFAULT_USERNAME,
  buildBehaviorModel,
  writeJsonFile,
} = require('../gabagool_btc_behavior');
const {
  CONFIG,
  BotEngine,
  PaperTelegramUpdateRelay,
} = require('../moneymaker_v3');
const { readConfig: readLiveConfig } = require('../live_adapter_polymarket');

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
    confidence: 0.82,
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
    minConfidence: 0.35,
    enableGabagoolBtcImitation: true,
    gabagoolLookbackTrades: 10,
    gabagoolMaxPaperOrderUsd: 1,
    gabagoolTelegramUpdates: true,
    gabagoolTelegramNotifyDetected: false,
    gabagoolTelegramNotifyPresophieBlocks: false,
    gabagoolTelegramNotifySophieBlocks: true,
    gabagoolTelegramNotifyRiskBlocks: true,
    gabagoolTelegramNotifyOrders: true,
    gabagoolTelegramNotifyFills: true,
    gabagoolTelegramBlockDedupeMs: 60_000,
    gabagoolMinPrice: 0.02,
    gabagoolMaxPrice: 0.98,
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
    assert(bot.formatBtcOracleReport(report).includes('--- BTC ORACLE / GABAGOOL REPORT ---'), 'formatted report should include the btc oracle header');
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
      maxTotalOpenOrderUsd: 0.5,
      maxTotalExposureUsd: 0.5,
      maxMarketExposureUsd: 0.5,
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
    assert.strictEqual(
      latestRelayEvent(bot, 'risk_blocked')?.notificationState,
      'PAPER ONLY BTC GABAGOOL RISK_BLOCKED',
      'Risk block should use the final Telegram state label'
    );
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: true });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(report.pipelineStats.gabagoolCandidatesBuiltLastHour, 1, 'signal with BTC move above threshold should reach candidate creation');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'happy path should reach Sophie');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'happy path should reach RiskEngine');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'candidate should create a paper order when Sophie and Risk pass');
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
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      gabagoolTelegramNotifyPresophieBlocks: true,
    }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: false });
    await bot.runGabagoolBtcOracleImitation();
    await bot.runGabagoolBtcOracleImitation();
    assert.strictEqual(countRelayEvents(bot, 'presophie_block_summary'), 1, 'duplicate expired signal should not spam Telegram relay events');
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
    assert.strictEqual(report.tradeQuality.winLossProxy, '1/0', 'btc oracle report should include a win/loss proxy after fake fills');
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

  const liveConfig = readLiveConfig(process.cwd());
  assert.strictEqual(liveConfig.enableLiveTrading, false, 'live adapter must stay disabled');
  assert.strictEqual(liveConfig.liveAutoExecute, false, 'live auto execute must stay disabled');
  assert.strictEqual(liveConfig.liveKillSwitch, true, 'live kill switch must stay enabled');
  assert.strictEqual(liveConfig.liveDryRunOnly, true, 'live dry run must stay enabled');
  assert.strictEqual(liveConfig.liveSubmitConfirm, false, 'live submit confirm must stay disabled');

  console.log('engine gabagool btc self-check passed');
}

run();
