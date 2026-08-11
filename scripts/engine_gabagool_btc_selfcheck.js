#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';
const stage5DiagnosticFixturePath = path.join(os.tmpdir(), `stage5-paper-diagnostic-selfcheck-${process.pid}.ndjson`);
process.env.STAGE5_PAPER_CANDIDATE_DIAGNOSTICS_PATH = stage5DiagnosticFixturePath;
process.on('exit', () => {
  try {
    fs.unlinkSync(stage5DiagnosticFixturePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
});

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
  resolvedMarketEvidenceForToken,
  settlementEvidenceHash,
} = require('../moneymaker_v3');
const { readConfig: readLiveConfig } = require('../live_adapter_polymarket');
const { analyzeStateFileUsage, buildSettingsStatus } = require('../dashboard_server');

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

function tempDir(name) {
  return fs.mkdtempSync(path.join('/tmp', `${name}-${process.pid}-`));
}

function markFixtureResolved(portfolio, tokenId, {
  payoutPerShare = 0,
  winningOutcome = 'Down',
} = {}) {
  const metadata = portfolio.positionMetadata.get(String(tokenId || '')) || {};
  portfolio.positionMetadata.set(String(tokenId || ''), {
    ...metadata,
    resolutionStatus: 'resolved',
    resolutionEvidenceVerified: true,
    settlementEvidenceBlocker: null,
    payoutPerShare,
    winningOutcome,
  });
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
  includeLegacyConfirmFields = true,
  polyLagConfirmed = true,
  lagScorePass = true,
  obiConfirmed = true,
  explicitConfirmedField = undefined,
  timestampMs = Date.now(),
  marketSlug = undefined,
  marketStartTsSec = undefined,
  lagScore = 0.00012,
  btcTriggerMovePct = 0.00016,
  btcPersistedMovePct = 0.00018,
  polyMidMovePct = 0.00002,
  polyMoveWeightLimitPct = 0.00005,
  initialBtcPrice = 66500,
  triggerBtcPrice = direction === 'UP' ? 66510 : 66490,
  currentBtcPrice = direction === 'UP' ? 66518 : 66482,
  bookAfterPersistence = {},
} = {}) {
  const now = timestampMs;
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
  if (marketSlug !== undefined) payload.market_slug = marketSlug;
  if (marketStartTsSec !== undefined) {
    payload.market_start_ts_sec = marketStartTsSec;
    payload.market_start_time = new Date(marketStartTsSec * 1000).toISOString();
    payload.market_end_time = new Date((marketStartTsSec + 300) * 1000).toISOString();
  }
  if (includeLegacyConfirmFields) {
    payload.poly_lag_confirmed = polyLagConfirmed;
    payload.lag_score_pass = lagScorePass;
    payload.obi_confirmed = obiConfirmed;
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
    btcOracleThreshold: 0.0001,
    btcOraclePersistenceMinPct: 0.0001,
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
  const realOracleFixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'btc_oracle_20260807T175015Z.json'),
    'utf8'
  ));

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
    assert.deepStrictEqual(health.oracleNotConfirmedReasonsLastHour, { btc_move_below_threshold: 1 });
    assert.strictEqual(health.dominantOracleNotConfirmedReasonLastHour, 'btc_move_below_threshold');
    assert(bot.formatBtcOracleReport(report).includes('btc_move_below_threshold:1'));
  }

  {
    writeOracleTarget(targetPath, baseStartSec);
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    writeOracleSignal(signalPath, {
      fresh: true,
      polyLagConfirmed: false,
      lagScorePass: true,
      obiConfirmed: true,
      explicitConfirmedField: false,
    });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 0, 'an actually unconfirmed signal must remain blocked');
    assert.strictEqual(health.oracleNotConfirmedReasonsLastHour.poly_lag_not_confirmed, 1);
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 0, 'confirmation must never be bypassed');
  }

  {
    writeOracleTarget(targetPath, baseStartSec);
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    const evidenceTimestamp = Date.now();
    writeOracleSignal(signalPath, {
      timestampMs: evidenceTimestamp,
      polyLagConfirmed: true,
      lagScorePass: false,
      obiConfirmed: true,
      explicitConfirmedField: false,
    });
    await bot.runGabagoolBtcOracleImitation();
    writeOracleSignal(signalPath, {
      timestampMs: evidenceTimestamp,
      polyLagConfirmed: true,
      lagScorePass: true,
      obiConfirmed: true,
      explicitConfirmedField: true,
    });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(health.oracleSignalsNotConfirmedLastHour, 1, 'initial incomplete evidence should be counted once');
    assert.strictEqual(health.oracleSignalsConfirmedLastHour, 1, 'superseding confirmation evidence must escape the negative-event cache');
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 1, 'superseding valid evidence should build the production candidate');
  }

  {
    const signalMarketSlug = `btc-updown-5m-${baseStartSec}`;
    writeOracleTarget(targetPath, baseStartSec + 300);
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    writeOracleSignal(signalPath, {
      marketSlug: signalMarketSlug,
      marketStartTsSec: baseStartSec,
      explicitConfirmedField: true,
    });
    await bot.runGabagoolBtcOracleImitation();
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(health.oracleNotConfirmedReasonsLastHour.market_mismatch, 1, 'rollover must identify the stale producing market exactly once');
    assert.strictEqual(health.duplicateOracleSignalsSkippedLastHour, 1, 'target rollover must not rebind and re-evaluate the signal on the new market');
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 0, 'old-window signals must never attach to the next five-minute market');
  }

  {
    writeOracleTarget(targetPath, baseStartSec);
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, { sophieMinExecutionQuality: 0.10 }));
    wireBooks(bot);
    writeOracleSignal(signalPath, {
      tokenId: 'down-token',
      direction: 'DOWN',
      fresh: true,
      explicitConfirmedField: true,
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      marketStartTsSec: baseStartSec,
    });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 1, 'confirmed BTC Down mapping should build a candidate');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'confirmed BTC Down should reach Sophie');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'admitted BTC Down should reach RiskEngine');
  }

  {
    writeOracleTarget(targetPath, baseStartSec);
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, { sophieMinExecutionQuality: 0.10 }));
    wireBooks(bot);
    writeJsonFile(signalPath, {
      ...realOracleFixture,
      timestamp: new Date().toISOString(),
      expires_at: new Date(Date.now() + 20_000).toISOString(),
      token_id: 'up-token',
      market_slug: `btc-updown-5m-${baseStartSec}`,
      market_start_ts_sec: baseStartSec,
      market_start_time: new Date(baseStartSec * 1000).toISOString(),
      market_end_time: new Date((baseStartSec + 300) * 1000).toISOString(),
      lag_score_pass: true,
      confirmed: true,
      confirmation_blockers: [],
      confirmation_config: { min_lag_score: 0.0001 },
    });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(realOracleFixture.lag_score_pass, false, 'real fixture must preserve the pre-fix failure');
    assert.strictEqual(health.oracleSignalsConfirmedLastHour, 1, 'corrected producer contract should confirm the real qualifying fixture');
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 1, 'real qualifying fixture should build a production-path candidate');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'real qualifying fixture should reach Sophie');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'admitted real fixture should reach RiskEngine');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, { sophieMinExecutionQuality: 0.99 }));
    wireBooks(bot);
    writeOracleSignal(signalPath, { fresh: true });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(report.signalStats.confirmedSource, 'oracle_confirmation_fields', 'fresh signal should require the oracle lag and OBI confirmation fields');
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 1, 'fresh oracle signal should build one candidate');
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
      saveState: true,
      stateFile: tempPath('legacy-expired-pipeline-state'),
      sophieMinExecutionQuality: 0.10,
      maxTotalExposureUsd: 2,
      btcExposureBucketShare: 1,
      maxMarketExposureUsd: 10,
      maxPositionUsdPerAsset: 10,
      gabagoolMaxPaperDrawdownPct: 100,
      gabagoolMaxPaperClosedLossUsd: 100,
    }));
    wireBooks(bot);
    const legacyTokenId = 'legacy-expired-pipeline-token';
    const legacyMarketId = 'legacy-expired-pipeline-market';
    const expiredStartSec = baseStartSec - 900;
    bot.portfolio.positions.set(legacyTokenId, 4);
    bot.portfolio.costBasis.set(legacyTokenId, 0.50);
    bot.portfolio.positionMarkets.set(legacyTokenId, legacyMarketId);
    bot.portfolio.setMarkPrice(legacyTokenId, 0.50);
    bot.portfolio.fills = [];
    bot.portfolio.positionMetadata.clear();
    bot.poly.fetchMarketById = async (requestedMarketId) => ({
      id: requestedMarketId,
      slug: `btc-updown-5m-${expiredStartSec}`,
      question: 'Bitcoin Up or Down - legacy pipeline fixture',
      clobTokenIds: JSON.stringify([legacyTokenId, 'legacy-expired-pipeline-other-token']),
      outcomes: JSON.stringify(['Up', 'Down']),
      outcomePrices: JSON.stringify(['0', '1']),
      closed: true,
      acceptingOrders: false,
      umaResolutionStatus: 'resolved',
      endDate: new Date((expiredStartSec + 300) * 1000).toISOString(),
    });
    writeOracleSignal(signalPath, { fresh: true });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 1, 'fixture should build a real Gabagool candidate');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'verified aged-out inventory should no longer stop the candidate before Sophie');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'verified aged-out inventory should allow the candidate to reach RiskEngine');
    assert.strictEqual(health.gabagoolPlacementAttemptedLastHour, 1, 'verified aged-out inventory should allow a real paper placement attempt');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'the nearest production path should place a genuine resting paper order');
    const afterPlacementExposure = bot.risk.exposureBreakdown();
    assert.strictEqual(afterPlacementExposure.expiredBtc5mExposureUsd, 0, 'resolved legacy inventory should settle before production-path admission');
    assert.strictEqual(bot.portfolio.settlements.length, 1, 'production path should preserve a durable market-settlement audit record');
    assert.strictEqual(afterPlacementExposure.capBlockingExposureUsd, 1, 'only the genuine new paper order should be cap blocking after admission');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile: tempPath('pending-resolution-pipeline-state'),
      sophieMinExecutionQuality: 0.10,
      maxTotalExposureUsd: 2,
      btcExposureBucketShare: 1,
      maxMarketExposureUsd: 10,
      maxPositionUsdPerAsset: 10,
      gabagoolMaxPaperDrawdownPct: 100,
      gabagoolMaxPaperClosedLossUsd: 100,
    }));
    wireBooks(bot);
    const pendingToken = 'pending-resolution-pipeline-token';
    const pendingOtherToken = 'pending-resolution-pipeline-other-token';
    const pendingMarketId = 'pending-resolution-pipeline-market';
    const pendingStartSec = baseStartSec - 900;
    const pendingSlug = `btc-updown-5m-${pendingStartSec}`;
    bot.portfolio.recordFill({
      tokenId: pendingToken,
      marketId: pendingMarketId,
      marketSlug: pendingSlug,
      outcome: 'Up',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
      ts: Date.now() - 11 * 60_000,
    });
    bot.portfolio.setMarkPrice(pendingToken, 0.50);
    bot.poly.fetchMarketById = async (requestedMarketId) => {
      assert.strictEqual(requestedMarketId, pendingMarketId, 'pending-resolution fixture must query the exact retained market');
      return {
        id: pendingMarketId,
        slug: pendingSlug,
        clobTokenIds: JSON.stringify([pendingToken, pendingOtherToken]),
        outcomes: JSON.stringify(['Up', 'Down']),
        outcomePrices: JSON.stringify(['0.5', '0.5']),
        closed: true,
        acceptingOrders: false,
        umaResolutionStatus: 'proposed',
        endDate: new Date((pendingStartSec + 300) * 1000).toISOString(),
      };
    };
    writeOracleSignal(signalPath, { fresh: true });
    await bot.runGabagoolBtcOracleImitation();
    const health = bot.portfolio.executionHealth();
    const exposure = bot.risk.exposureBreakdown();
    assert.strictEqual(health.gabagoolCandidatesBuiltLastHour, 1, 'pending inventory fixture should build one production-path candidate');
    assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 1, 'pending inventory must not stop the candidate before Sophie');
    assert.strictEqual(health.gabagoolRiskEvaluatedLastHour, 1, 'pending inventory must not stop the candidate before RiskEngine');
    assert.strictEqual(health.gabagoolPlacementAttemptedLastHour, 1, 'pending inventory must allow a genuine paper placement attempt');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'pending inventory fixture should place a genuine realistic paper order');
    assert.strictEqual(exposure.resolutionPendingExposureUsd, 2, 'pending inventory must remain visible after the new candidate proceeds');
    assert.strictEqual(exposure.capBlockingExposureUsd, 1, 'only the genuine new paper order may block the cap');
    assert.strictEqual(bot.portfolio.positions.has(pendingToken), true, 'pending inventory must remain persisted for future settlement');
    assert.strictEqual(bot.portfolio.settlements.length, 0, 'ambiguous evidence must not create a settlement');
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
      marketSlug: `btc-updown-5m-${baseStartSec - 600}`,
      outcome: 'Up',
    });
    portfolio.recordFill({
      tokenId: 'stale-btc-b',
      marketId: 'btc-stale-b',
      side: 'buy',
      price: 0.50,
      size: 12,
      strategy: 'GabagoolBtcOracleStrategy',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Down',
    });
    portfolio.setMarkPrice('stale-btc-a', 0.50);
    portfolio.setMarkPrice('stale-btc-b', 0.50);
    portfolio.paperTokenTradeability.set('stale-btc-a', { status: 'stale_token_cooldown' });
    portfolio.paperTokenTradeability.set('stale-btc-b', { status: 'no_orderbook_404' });
    markFixtureResolved(portfolio, 'stale-btc-a');
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
    assert(admitted, 'expired/404 BTC paper exposure should not block a fresh Gabagool buy via the BTC bucket');
    const admittedDetails = risk.riskDetails(admitted);
    assert.strictEqual(admittedDetails.strategyBucketExposureRawUsd, 12, 'bucket diagnostics should expose raw BTC bucket exposure');
    assert.strictEqual(admittedDetails.strategyBucketExposureExclusionUsd, 12, 'bucket diagnostics should exclude only dead BTC paper exposure');
    assert.strictEqual(admittedDetails.strategyBucketExposureUsd, 0, 'effective BTC bucket exposure should ignore dead BTC paper exposure for paper buys');
    assert.strictEqual(admittedDetails.expiredBtc5mExposureUsd, 6, 'expired BTC 5m exposure should be reported separately');
    assert.strictEqual(admittedDetails.confirmedNoOrderbook404ExposureUsd, 6, 'confirmed 404 exposure should be reported separately');
    assert.strictEqual(admittedDetails.capBlockingExposureUsd, 0, 'dead BTC exposure should not count toward cap-blocking exposure');
    assert.strictEqual(admittedDetails.rawTotalExposureUsd, 12, 'dead BTC exposure should remain visible in total portfolio exposure');

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
      marketSlug: `btc-updown-5m-${baseStartSec + 300}`,
      outcome: 'Up',
    });
    blockingPortfolio.setMarkPrice('tradable-btc-token', 0.50);
    blockingPortfolio.paperTokenTradeability.set('tradable-btc-token', { status: 'stale_token_cooldown' });
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
    assert.strictEqual(blocked, null, 'active live-window stale BTC exposure above the bucket cap should still be blocked');
    assert.strictEqual(blockingRisk.lastBlockReason, 'btc_bucket_exposure', 'active stale BTC exposure must still count against the BTC bucket');
    assert.strictEqual(blockingRisk.lastBlockDetails.strategyBucketExposureRawUsd, 8, 'raw active BTC exposure should be reported');
    assert.strictEqual(blockingRisk.lastBlockDetails.strategyBucketExposureExclusionUsd, 0, 'active stale BTC exposure must not be excluded');
    assert.strictEqual(blockingRisk.lastBlockDetails.strategyBucketExposureUsd, 8, 'effective bucket exposure should still include active stale BTC inventory');
    assert.strictEqual(blockingRisk.lastBlockDetails.staleNoBidExposureUsd, 8, 'active live-window stale BTC exposure should be reported separately');
    assert.strictEqual(blockingRisk.lastBlockDetails.capBlockingExposureUsd, 8, 'active live-window stale BTC exposure should remain cap blocking');

    const pendingPortfolio = new PaperPortfolio(config);
    const pendingRisk = new RiskEngine(config, pendingPortfolio);
    pendingPortfolio.paperTokenTradeability = new Map();
    pendingPortfolio.recordFill({
      tokenId: 'pending-btc-token',
      marketId: 'btc-pending-market',
      side: 'buy',
      price: 0.50,
      size: 16,
      strategy: 'GabagoolBtcOracleStrategy',
      marketSlug: 'btc-resolution-pending-market',
      outcome: 'Up',
      ts: Date.now() - (11 * 60_000),
    });
    pendingPortfolio.setMarkPrice('pending-btc-token', 0.50);
    pendingPortfolio.paperTokenTradeability.set('pending-btc-token', { status: 'stale_token_cooldown' });
    const pendingAdmitted = pendingRisk.evaluate({
      strategy: 'GabagoolBtcOracleStrategy',
      tokenId: 'fresh-btc-entry-3',
      marketId: 'btc-fresh-market-3',
      side: 'buy',
      price: 0.49,
      sizeUsd: 3,
      expectedEdge: 0.12,
      confidence: 0.60,
      metadata: {
        outcome: 'Up',
        marketSlug: `btc-updown-5m-${baseStartSec + 600}`,
        gabagool: {
          oracleSignalFresh: true,
          validBook: true,
          volatilityGuardPassed: true,
          lateEntryWindowPassed: true,
        },
      },
    });
    assert(pendingAdmitted, 'resolution-pending BTC inventory must not block an otherwise valid paper candidate');
    const pendingDetails = pendingRisk.riskDetails(pendingAdmitted);
    assert.strictEqual(pendingDetails.resolutionPendingExposureUsd, 8, 'resolution-pending BTC exposure should remain reported separately');
    assert.strictEqual(pendingDetails.strategyBucketExposureExclusionUsd, 8, 'resolution-pending BTC exposure should be excluded from the normal paper bucket cap');
    assert.strictEqual(pendingDetails.strategyBucketExposureUsd, 0, 'resolution-pending BTC exposure must not consume the normal paper bucket');
    assert.strictEqual(pendingDetails.capBlockingExposureUsd, 0, 'resolution-pending BTC exposure must not consume the global paper cap');
    assert.strictEqual(pendingPortfolio.positions.size, 1, 'cap exclusion must not silently delete pending inventory');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      maxTotalExposureUsd: 4.5,
      maxMarketExposureUsd: 10,
      maxPositionUsdPerAsset: 10,
    }));
    bot.portfolio.recordFill({
      tokenId: 'stale-no-bid-token',
      marketId: 'btc-no-bid-market',
      side: 'buy',
      price: 0.50,
      size: 10,
      strategy: 'GabagoolBtcOracleStrategy',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
    });
    bot.portfolio.setMarkPrice('stale-no-bid-token', 0.50);
    bot.cache.getFreshBook = async () => {
      const error = new Error('negative cache');
      error.mmBookFetchStatus = 'stale_token_cooldown';
      error.mmCooldownMsRemaining = 60_000;
      throw error;
    };
    const scan = await bot.buildGabagoolExposureCapExitScan({ now: Date.now() });
    assert.strictEqual(scan.active, true, 'live-window stale BTC inventory should still trigger the exposure-cap scan');
    assert.strictEqual(scan.positionsClosable, 0, 'reduce-only exits should not be attempted without a real bid');
    assert.strictEqual(scan.candidates.length, 0, 'no real bid should produce no reduce-only candidates');
    assert.strictEqual(scan.capTriggerReason, 'active_tradable_exposure_over_cap', 'scan should expose the active cap-trigger reason');
    assert(scan.blockedReasonSummary.includes('stale_token_cooldown_active_window:1'), 'scan should expose the active-window stale no-bid reason');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      maxTotalExposureUsd: 10,
      btcExposureBucketShare: 0.6,
    });
    const bot = new BotEngine(config);
    const tokenId = 'aged-out-fill-token';
    const marketId = 'aged-out-fill-market';
    const expiredStartSec = baseStartSec - 900;
    bot.portfolio.positions.set(tokenId, 4);
    bot.portfolio.costBasis.set(tokenId, 0.50);
    bot.portfolio.positionMarkets.set(tokenId, marketId);
    bot.portfolio.setMarkPrice(tokenId, 0.50);
    bot.portfolio.fills = [];
    bot.portfolio.positionMetadata.clear();

    const before = bot.risk.exposureBreakdown(null, { markPrices: bot.cache.markPrices() });
    assert.strictEqual(before.activeTradableExposureUsd, 2, 'unattributed inventory must remain cap blocking before objective verification');
    assert.strictEqual(before.expiredBtc5mExposureUsd, 0, 'unknown inventory must not be guessed to be expired');

    bot.poly.fetchMarketById = async (requestedMarketId) => ({
      id: requestedMarketId,
      slug: `btc-updown-5m-${expiredStartSec}`,
      question: 'Bitcoin Up or Down - fixture',
      clobTokenIds: JSON.stringify([tokenId, 'aged-out-fill-other-token']),
      outcomes: JSON.stringify(['Up', 'Down']),
      outcomePrices: JSON.stringify(['0', '1']),
      closed: true,
      acceptingOrders: false,
      umaResolutionStatus: 'resolved',
      endDate: new Date((expiredStartSec + 300) * 1000).toISOString(),
    });
    const refresh = await bot.refreshGabagoolPositionMetadata(Date.now());
    assert.deepStrictEqual(refresh, { attempted: 1, verified: 1, unresolved: 0 }, 'Gamma lookup should verify the aged-out BTC position');

    const after = bot.risk.exposureBreakdown(null, { markPrices: bot.cache.markPrices() });
    assert.strictEqual(after.activeTradableExposureUsd, 0, 'verified expired BTC inventory must stop blocking the cap');
    assert.strictEqual(after.expiredBtc5mExposureUsd, 2, 'verified expired BTC inventory should move to the expired bucket');
    assert.strictEqual(after.capBlockingExposureUsd, 0, 'verified expired BTC inventory should not count against paper entry exposure');
    assert.strictEqual(after.btcOraclePositionExposureUsd, 2, 'strategy exposure should survive retained-fill truncation');
    assert.strictEqual(after.nonBtcPositionExposureUsd, 0, 'verified BTC inventory must not be mislabeled as non-BTC');

    const restartedPortfolio = new PaperPortfolio(config);
    restartedPortfolio.hydratePersistedState(bot.portfolio.buildPersistedState());
    const restartedRisk = new RiskEngine(config, restartedPortfolio);
    const restarted = restartedRisk.exposureBreakdown(null, { markPrices: restartedPortfolio.markPricesSnapshot() });
    assert.strictEqual(restarted.expiredBtc5mExposureUsd, 2, 'verified position metadata must survive a normal state save/load');
    assert.strictEqual(restarted.capBlockingExposureUsd, 0, 'restart must not recreate the false exposure blocker');

    const unknownToken = 'unverified-aged-out-token';
    bot.portfolio.positions.set(unknownToken, 4);
    bot.portfolio.costBasis.set(unknownToken, 0.50);
    bot.portfolio.positionMarkets.set(unknownToken, 'unverified-market');
    bot.portfolio.setMarkPrice(unknownToken, 0.50);
    bot.poly.fetchMarketById = async (requestedMarketId) => ({
      id: requestedMarketId,
      slug: `btc-updown-5m-${expiredStartSec}`,
      clobTokenIds: JSON.stringify(['different-token']),
      outcomes: JSON.stringify(['Up']),
      closed: true,
      acceptingOrders: false,
    });
    const unresolved = await bot.refreshGabagoolPositionMetadata(Date.now() + 5 * 60_000);
    assert.strictEqual(unresolved.verified, 0, 'a market response that does not contain the token must not verify ownership');
    const failClosed = bot.risk.exposureBreakdown(null, { markPrices: bot.cache.markPrices() });
    assert.strictEqual(failClosed.activeTradableExposureUsd, 2, 'unverified inventory must remain cap blocking');
  }

  {
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile: tempPath('resolved-settlement-state'),
    });
    const bot = new BotEngine(config);
    const expiredStartSec = baseStartSec - 900;
    const marketId = 'resolved-settlement-market';
    const marketSlug = `btc-updown-5m-${expiredStartSec}`;
    const upToken = 'resolved-settlement-up-token';
    const downToken = 'resolved-settlement-down-token';
    bot.portfolio.recordFill({
      tokenId: upToken,
      marketId,
      marketSlug,
      outcome: 'Up',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.recordFill({
      tokenId: downToken,
      marketId,
      marketSlug,
      outcome: 'Down',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    assert.strictEqual(bot.portfolio.equity(), 96, 'unresolved expired inventory must be excluded from reliable equity');
    bot.poly.fetchMarketById = async () => ({
      id: marketId,
      slug: marketSlug,
      question: 'Bitcoin Up or Down - settlement fixture',
      clobTokenIds: JSON.stringify([upToken, downToken]),
      outcomes: JSON.stringify(['Up', 'Down']),
      outcomePrices: JSON.stringify(['1', '0']),
      closed: true,
      acceptingOrders: false,
      umaResolutionStatus: 'resolved',
      resolutionSource: 'fixture-resolution-source',
      endDate: new Date((expiredStartSec + 300) * 1000).toISOString(),
      closedTime: new Date((expiredStartSec + 300) * 1000).toISOString(),
    });
    const reconciled = await bot.reconcileResolvedPaperPositions(Date.now());
    assert.deepStrictEqual(reconciled, { attempted: 2, settled: 2, pending: 0 });
    assert.strictEqual(bot.portfolio.positions.size, 0, 'settled positions must leave the open position ledger');
    assert.strictEqual(bot.portfolio.settlements.length, 2, 'winner and loser settlement audit records must both persist');
    assert.strictEqual(bot.portfolio.cash, 100, 'winner must pay one dollar per share and loser must pay zero');
    assert.strictEqual(bot.portfolio.closedPnl, 0, 'combined winner and loser realized settlement PnL should reconcile');
    assert.strictEqual(bot.portfolio.equity(), 100, 'equity must equal settled cash after positions close');
    const duplicate = bot.portfolio.settleResolvedPosition({
      tokenId: upToken,
      evidence: bot.portfolio.settlements.find((entry) => entry.tokenId === upToken).evidence,
    });
    assert.strictEqual(duplicate.duplicate, true, 'the durable settlement key must prevent repeated payout');
    const restarted = new PaperPortfolio(config);
    restarted.hydratePersistedState(bot.portfolio.buildPersistedState());
    assert.strictEqual(restarted.settlements.length, 2, 'settlement audit history must survive state hydration');
    assert.strictEqual(restarted.settlementKeys.size, 2, 'idempotency keys must survive state hydration');
    assert(bot.portfolio.settlements.every((entry) => entry.evidenceHash === settlementEvidenceHash(entry.evidence)), 'settlement records must persist deterministic evidence hashes');
    const ledger = restarted.strategyLedger((strategy) => strategy === 'GabagoolBtcOracleStrategy');
    assert.strictEqual(ledger.settlementsCount, 2, 'trusted strategy PnL must include objective market settlements');
    assert.strictEqual(ledger.trustedClosedPnl, 0, 'trusted settlement PnL must reconcile through the strategy ledger');
    assert.strictEqual(ledger.currentPositionExposureUsd, 0, 'settled fill lots must not survive as phantom strategy exposure');
    assert.strictEqual(ledger.perTokenExposure.length, 0, 'settled tokens must leave strategy per-token exposure');

    const pendingConfig = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile: tempPath('pending-settlement-state'),
    });
    const pendingBot = new BotEngine(pendingConfig);
    pendingBot.portfolio.recordFill({
      tokenId: upToken,
      marketId,
      marketSlug,
      outcome: 'Up',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    pendingBot.poly.fetchMarketById = async () => ({
      id: marketId,
      slug: marketSlug,
      clobTokenIds: JSON.stringify([upToken, downToken]),
      outcomes: JSON.stringify(['Up', 'Down']),
      outcomePrices: JSON.stringify(['0.5', '0.5']),
      closed: true,
      acceptingOrders: false,
      umaResolutionStatus: 'proposed',
      endDate: new Date((expiredStartSec + 300) * 1000).toISOString(),
    });
    const pending = await pendingBot.reconcileResolvedPaperPositions(Date.now());
    assert.deepStrictEqual(pending, { attempted: 1, settled: 0, pending: 1 });
    assert.strictEqual(pendingBot.portfolio.positions.size, 1, 'ambiguous resolution must retain the position');
    assert.strictEqual(pendingBot.portfolio.settlements.length, 0, 'ambiguous resolution must not fabricate settlement');
    assert.strictEqual(pendingBot.portfolio.equity(), 98, 'pending resolution cost must stay outside reliable equity');
    const pendingExposure = pendingBot.risk.exposureBreakdown();
    assert.strictEqual(pendingExposure.resolutionPendingExposureUsd, 2, 'ambiguous resolution must use the pending bucket');
    assert.strictEqual(pendingExposure.excludedDeadExposureUsd, 0, 'ambiguous resolution must not count as confirmed dead');
    assert.strictEqual(pendingExposure.capBlockingExposureUsd, 0, 'ambiguous resolution must not block the normal global paper cap');
    assert.strictEqual(pendingBot.risk.exposureBucketState({ strategy: 'GabagoolBtcOracleStrategy', side: 'buy', sizeUsd: 1 }, pendingExposure).strategyBucketExposureUsd, 0, 'ambiguous resolution must not block the Gabagool paper bucket');
    pendingBot.portfolio.paperTokenTradeability.set(upToken, { status: 'no_orderbook_404' });
    const pendingNoBookExposure = pendingBot.risk.exposureBreakdown();
    assert.strictEqual(pendingNoBookExposure.resolutionPendingExposureUsd, 2, 'expired no-book inventory without resolution proof must remain pending');
    assert.strictEqual(pendingNoBookExposure.confirmedNoOrderbook404ExposureUsd, 0, 'an expired 404 must not override missing resolution evidence');
  }

  {
    const stateFile = tempPath('standard-settlement-real-characteristics-state');
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile,
      maxTotalExposureUsd: 8,
      standardExposureBucketShare: 0.5,
    });
    const bot = new BotEngine(config);
    const fixtures = [
      {
        tokenId: '70754151140016266921164956760483788029340576041455876128222747444483880527185',
        otherTokenId: '38410698283767127398742019309168536543792244747816607463407366447758077453222',
        marketId: '3276452',
        marketSlug: 'lol-t1-hle1-2026-08-08-total-games-2pt5',
        outcome: 'Over',
        outcomes: ['Over', 'Under'],
        outcomePrices: [1, 0],
        entryPrice: 0.65,
        mark: 0.57,
        closedTime: '2026-08-08T13:23:00.000Z',
      },
      {
        tokenId: '89535822439559695331746132462978157222180050647924770918964479731303792316026',
        otherTokenId: '95968977050074120413876909833798622722288635977338912048510921419928661095848',
        marketId: '3285896',
        marketSlug: 'lol-lgd-al-2026-08-08-total-games-2pt5',
        outcome: 'Over',
        outcomes: ['Over', 'Under'],
        outcomePrices: [0, 1],
        entryPrice: 0.17,
        mark: 0.07,
        closedTime: '2026-08-08T14:03:15.000Z',
      },
      {
        tokenId: '76073147559295528213098377778077503433003193159387639418630910211792453287184',
        otherTokenId: '65229114994463166123276141069161084375168779366225791850381813504475206256202',
        marketId: '3405001',
        marketSlug: 'cs2-eye-pha-2026-08-08-game2',
        outcome: 'EYEBALLERS',
        outcomes: ['EYEBALLERS', 'Phantom'],
        outcomePrices: [0, 1],
        entryPrice: 0.52,
        mark: 0.035,
        closedTime: '2026-08-08T13:31:55.000Z',
      },
      {
        tokenId: '82163733115918728572083283131773429629266071008421689272651250216974263714339',
        otherTokenId: '86389089648674011884114763286975909594313918763448185164084052958510839514759',
        marketId: '3405026',
        marketSlug: 'cs2-eye-pha-2026-08-08',
        outcome: 'EYEBALLERS',
        outcomes: ['EYEBALLERS', 'Phantom'],
        outcomePrices: [1, 0],
        entryPrice: 0.42,
        mark: 0.9855,
        closedTime: '2026-08-08T14:37:12.000Z',
      },
    ];
    const markets = new Map();
    for (const fixture of fixtures) {
      bot.portfolio.recordFill({
        tokenId: fixture.tokenId,
        marketId: fixture.marketId,
        marketSlug: '',
        outcome: fixture.outcome,
        side: 'buy',
        price: fixture.entryPrice,
        size: 1 / fixture.entryPrice,
        strategy: 'SpreadHunter',
      });
      bot.portfolio.setMarkPrice(fixture.tokenId, fixture.mark);
      markets.set(fixture.marketId, {
        id: fixture.marketId,
        slug: fixture.marketSlug,
        question: `standard settlement fixture ${fixture.marketId}`,
        clobTokenIds: JSON.stringify([fixture.tokenId, fixture.otherTokenId]),
        outcomes: JSON.stringify(fixture.outcomes),
        outcomePrices: JSON.stringify(fixture.outcomePrices.map(String)),
        closed: true,
        acceptingOrders: false,
        closedTime: fixture.closedTime,
      });
    }
    const beforeExposure = bot.risk.exposureBreakdown(null, { markPrices: bot.portfolio.markPricesSnapshot() });
    const beforeBucket = bot.risk.exposureBucketState({
      strategy: 'SpreadHunter', side: 'buy', price: 0.50, sizeUsd: 1,
    }, beforeExposure);
    assert(Math.abs(beforeExposure.activeTradableExposureUsd - 3.7024240465416938) < 1e-9, 'real standard fixture marks must reproduce the stale exposure');
    assert(beforeBucket.strategyBucketWouldExposureUsd > beforeBucket.strategyBucketCapUsd, 'stale standard fixture exposure must reproduce the bucket block');

    bot.poly.fetchMarketById = async (marketId) => markets.get(String(marketId));
    const expectedPayout = fixtures.reduce((sum, fixture) => (
      sum + ((1 / fixture.entryPrice) * fixture.outcomePrices[fixture.outcomes.indexOf(fixture.outcome)])
    ), 0);
    const expectedSettlementPnl = expectedPayout - fixtures.length;
    const reconciled = await bot.reconcileResolvedPaperPositions(Date.now());
    assert.deepStrictEqual(reconciled, { attempted: 4, settled: 4, pending: 0 });
    assert(Math.abs(expectedPayout - 3.9194139194139193) < 1e-12, 'real standard regression characteristics must derive the authoritative payout');
    assert(Math.abs(bot.portfolio.cash - (100 - fixtures.length + expectedPayout)) < 1e-9, 'standard winner payouts and loser zero payouts must credit cash exactly once');
    assert(Math.abs(bot.portfolio.closedPnl - expectedSettlementPnl) < 1e-9, 'standard settlement PnL must reconcile from cost and payout');
    assert.strictEqual(bot.portfolio.positions.size, 0, 'standard settlements must remove every resolved position');
    assert.strictEqual(bot.portfolio.settlements.length, 4, 'standard settlements must persist one audit record per position');
    assert(bot.portfolio.settlements.every((entry) => entry.strategy === 'SpreadHunter'), 'standard settlement PnL attribution must remain with SpreadHunter');
    assert(bot.portfolio.settlements.every((entry) => entry.evidence.marketType === 'standard_binary'), 'standard settlements must retain their evidence class');
    assert(bot.portfolio.settlements.every((entry) => entry.evidence.resolutionProof === 'standard_closed_binary_payout'), 'standard settlements must retain the exact proof type');
    assert(bot.portfolio.settlements.every((entry) => entry.evidenceHash === settlementEvidenceHash(entry.evidence)), 'standard settlement evidence hashes must be deterministic');
    const afterExposure = bot.risk.exposureBreakdown(null, { markPrices: bot.portfolio.markPricesSnapshot() });
    const afterBucket = bot.risk.exposureBucketState({
      strategy: 'SpreadHunter', side: 'buy', price: 0.50, sizeUsd: 1,
    }, afterExposure);
    assert.strictEqual(afterExposure.activeTradableExposureUsd, 0, 'settled standard inventory must leave active exposure');
    assert(afterBucket.strategyBucketWouldExposureUsd <= afterBucket.strategyBucketCapUsd, 'settled standard inventory must release the standard bucket');
    bot.portfolio.setMarkPrice(fixtures[0].tokenId, 0.99);
    assert.strictEqual(bot.portfolio.position(fixtures[0].tokenId), 0, 'a stale post-settlement mark must not recreate a position');
    assert.strictEqual(bot.portfolio.positionExposureUsd(bot.portfolio.markPricesSnapshot()), 0, 'a stale post-settlement mark must not recreate exposure');
    assert.deepStrictEqual(await bot.reconcileResolvedPaperPositions(Date.now() + 1), { attempted: 0, settled: 0, pending: 0 }, 'reconciliation must be idempotent once standard positions are gone');

    const restarted = new PaperPortfolio(config);
    restarted.hydratePersistedState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    assert.strictEqual(restarted.positions.size, 0, 'restart must not restore settled standard positions');
    assert.strictEqual(restarted.settlements.length, 4, 'restart must preserve all standard settlements');
    assert.strictEqual(restarted.settlementKeys.size, 4, 'restart must preserve standard idempotency keys');
    assert(Math.abs(restarted.cash - bot.portfolio.cash) < 1e-9, 'restart must preserve standard settlement cash');
    assert(Math.abs(restarted.closedPnl - bot.portfolio.closedPnl) < 1e-9, 'restart must preserve standard settlement PnL');
    const firstSettlement = restarted.settlements.find((entry) => entry.tokenId === fixtures[0].tokenId);
    const duplicate = restarted.settleResolvedPosition({ tokenId: fixtures[0].tokenId, evidence: firstSettlement.evidence });
    assert.strictEqual(duplicate.duplicate, true, 'restart idempotency must refuse duplicate standard payout');
    assert(Math.abs(restarted.cash - bot.portfolio.cash) < 1e-9, 'duplicate standard retry must not change cash');
  }

  {
    const standardToken = 'standard-adversarial-held-token';
    const standardOtherToken = 'standard-adversarial-other-token';
    const standardMarketId = 'standard-adversarial-market';
    const standardMarketSlug = 'standard-adversarial-slug';
    const baseMarket = {
      id: standardMarketId,
      slug: standardMarketSlug,
      clobTokenIds: JSON.stringify([standardToken, standardOtherToken]),
      outcomes: JSON.stringify(['Yes', 'No']),
      outcomePrices: JSON.stringify(['1', '0']),
      closed: true,
      acceptingOrders: false,
      closedTime: new Date(Date.now() - 60_000).toISOString(),
    };
    const runRefusal = async (label, market, expectedMetadataBlocker, reconcileAt = Date.now()) => {
      const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
        saveState: true,
        stateFile: tempPath(`standard-settlement-refusal-${label.replace(/[^a-z0-9]+/gi, '-')}`),
      }));
      bot.portfolio.recordFill({
        tokenId: standardToken,
        marketId: standardMarketId,
        marketSlug: standardMarketSlug,
        outcome: 'Yes',
        side: 'buy',
        price: 0.40,
        size: 2.5,
        strategy: 'SpreadHunter',
      });
      const before = bot.portfolio.captureSettlementState();
      bot.poly.fetchMarketById = async () => market;
      const result = await bot.reconcileResolvedPaperPositions(reconcileAt);
      assert.deepStrictEqual(result, { attempted: 1, settled: 0, pending: 1 }, `${label} must remain pending`);
      assert.strictEqual(bot.portfolio.cash, before.cash, `${label} must not change cash`);
      assert.strictEqual(bot.portfolio.closedPnl, before.closedPnl, `${label} must not change PnL`);
      assert.strictEqual(bot.portfolio.position(standardToken), before.positions.get(standardToken), `${label} must retain the position`);
      assert.strictEqual(bot.portfolio.settlements.length, 0, `${label} must not create a settlement`);
      assert.strictEqual(bot.portfolio.positionMetadata.get(standardToken).settlementEvidenceBlocker, expectedMetadataBlocker, `${label} must retain the exact blocker`);
    };
    await runRefusal('unresolved standard market', { ...baseMarket, closed: false }, 'market_not_closed');
    await runRefusal('closed standard market with explicit pending status', { ...baseMarket, umaResolutionStatus: 'proposed' }, 'market_resolution_pending');
    await runRefusal('mismatched standard token', { ...baseMarket, clobTokenIds: JSON.stringify(['different-token', standardOtherToken]) }, 'resolution_token_not_in_market');
    await runRefusal('mismatched standard outcome', { ...baseMarket, outcomes: JSON.stringify(['No', 'Yes']) }, 'resolution_outcome_mismatch');
    await runRefusal('ambiguous standard payout', { ...baseMarket, outcomePrices: JSON.stringify(['0.5', '0.5']) }, 'resolution_payout_vector_ambiguous');
    await runRefusal('missing standard accepting-orders evidence', (() => {
      const market = { ...baseMarket };
      delete market.acceptingOrders;
      return market;
    })(), 'market_accepting_orders_evidence_missing');
    await runRefusal('malformed standard payout evidence', { ...baseMarket, outcomePrices: '{not-json' }, 'resolution_binary_shape_invalid');
    await runRefusal('incomplete standard closed-time evidence', { ...baseMarket, closedTime: '' }, 'resolution_closed_time_missing');
    await runRefusal('stale standard evidence', baseMarket, 'settlement_evidence_stale', Date.now() - (5 * 60_000) - 1_000);

    const persistenceBot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile: tempPath('standard-settlement-persistence-failure'),
    }));
    persistenceBot.portfolio.recordFill({
      tokenId: standardToken,
      marketId: standardMarketId,
      marketSlug: standardMarketSlug,
      outcome: 'Yes',
      side: 'buy',
      price: 0.40,
      size: 2.5,
      strategy: 'SpreadHunter',
    });
    persistenceBot.poly.fetchMarketById = async () => baseMarket;
    const persistenceBefore = persistenceBot.portfolio.captureSettlementState();
    persistenceBot.portfolio.saveState = () => ({ ok: false, error: 'fixture_standard_atomic_save_failure' });
    const failed = await persistenceBot.reconcileResolvedPaperPositions(Date.now());
    assert.strictEqual(failed.blocker, 'settlement_state_save_failed', 'standard save failure must fail closed');
    assert.strictEqual(failed.rolledBackSettlements, 1, 'standard save failure must report its rolled-back settlement');
    assert.strictEqual(persistenceBot.portfolio.cash, persistenceBefore.cash, 'standard save failure must roll back cash');
    assert.strictEqual(persistenceBot.portfolio.closedPnl, persistenceBefore.closedPnl, 'standard save failure must roll back PnL');
    assert.strictEqual(persistenceBot.portfolio.position(standardToken), persistenceBefore.positions.get(standardToken), 'standard save failure must restore the position');
    assert.strictEqual(persistenceBot.portfolio.settlements.length, 0, 'standard save failure must remove the uncommitted audit record');
    assert.strictEqual(persistenceBot.portfolio.settlementKeys.size, 0, 'standard save failure must remove the uncommitted idempotency key');
  }

  {
    const expiredStartSec = baseStartSec - 1_200;
    const marketId = 'settlement-trust-boundary-market';
    const marketSlug = `btc-updown-5m-${expiredStartSec}`;
    const upToken = 'settlement-trust-boundary-up';
    const downToken = 'settlement-trust-boundary-down';
    const market = {
      id: marketId,
      slug: marketSlug,
      clobTokenIds: JSON.stringify([upToken, downToken]),
      outcomes: JSON.stringify(['Up', 'Down']),
      outcomePrices: JSON.stringify(['1', '0']),
      closed: true,
      acceptingOrders: false,
      umaResolutionStatus: 'resolved',
      resolutionSource: 'fixture-resolution-source',
      endDate: new Date((expiredStartSec + 300) * 1000).toISOString(),
    };
    const makePortfolio = () => {
      const portfolio = new PaperPortfolio(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
      portfolio.recordFill({
        tokenId: upToken,
        marketId,
        marketSlug,
        outcome: 'Up',
        side: 'buy',
        price: 0.50,
        size: 4,
        strategy: 'GabagoolBtcOracleStrategy',
      });
      return portfolio;
    };
    const evidence = resolvedMarketEvidenceForToken(market, {
      tokenId: upToken,
      expectedMarketId: marketId,
      expectedMarketSlug: marketSlug,
    });
    assert.strictEqual(evidence.verified, true, 'trust-boundary fixture must start with verified evidence');
    const negativeCases = [
      ['wrong market', { ...evidence, marketId: 'wrong-market' }, 'settlement_market_id_mismatch'],
      ['wrong slug', { ...evidence, marketSlug: `${marketSlug}-wrong` }, 'settlement_market_slug_mismatch'],
      ['wrong token', { ...evidence, tokenId: downToken, tokenIds: [downToken, 'other-token'] }, 'settlement_token_membership_mismatch'],
      ['reversed outcome', { ...evidence, outcome: 'Down' }, 'settlement_outcome_mismatch'],
      ['arbitrary payout', { ...evidence, payoutPerShare: 0 }, 'settlement_token_payout_mismatch'],
      ['malformed payout vector', { ...evidence, outcomePrices: [1, 1] }, 'settlement_payout_vector_invalid'],
      ['timestamp mismatch', { ...evidence, marketEndTime: new Date((expiredStartSec + 360) * 1000).toISOString() }, 'settlement_market_end_mismatch'],
      ['unverified evidence', { ...evidence, verified: false, resolutionEvidenceVerified: false }, 'settlement_evidence_unverified'],
    ];
    for (const [label, candidateEvidence, expectedBlocker] of negativeCases) {
      const portfolio = makePortfolio();
      const before = portfolio.captureSettlementState();
      const result = portfolio.settleResolvedPosition({ tokenId: upToken, evidence: candidateEvidence });
      assert.strictEqual(result.settled, false, `${label} must not settle`);
      assert.strictEqual(result.blocker, expectedBlocker, `${label} must fail at the settlement trust boundary`);
      assert.strictEqual(portfolio.cash, before.cash, `${label} must not change cash`);
      assert.strictEqual(portfolio.closedPnl, before.closedPnl, `${label} must not change closed PnL`);
      assert.strictEqual(portfolio.positions.get(upToken), before.positions.get(upToken), `${label} must retain the open position`);
      assert.strictEqual(portfolio.settlements.length, 0, `${label} must not append an audit record`);
      assert.strictEqual(portfolio.settlementKeys.size, 0, `${label} must not add an idempotency key`);
    }
  }

  {
    const expiredStartSec = baseStartSec - 1_500;
    const marketId = 'settlement-persistence-market';
    const marketSlug = `btc-updown-5m-${expiredStartSec}`;
    const upToken = 'settlement-persistence-up';
    const downToken = 'settlement-persistence-down';
    const stateFile = tempPath('settlement-persistence-state');
    const config = makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile,
    });
    const market = {
      id: marketId,
      slug: marketSlug,
      clobTokenIds: JSON.stringify([upToken, downToken]),
      outcomes: JSON.stringify(['Up', 'Down']),
      outcomePrices: JSON.stringify(['1', '0']),
      closed: true,
      acceptingOrders: false,
      umaResolutionStatus: 'resolved',
      resolutionSource: 'fixture-resolution-source',
      endDate: new Date((expiredStartSec + 300) * 1000).toISOString(),
    };
    const bot = new BotEngine(config);
    bot.portfolio.recordFill({
      tokenId: upToken,
      marketId,
      marketSlug,
      outcome: 'Up',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.poly.fetchMarketById = async () => market;
    const before = bot.portfolio.captureSettlementState();
    const originalSaveState = bot.portfolio.saveState.bind(bot.portfolio);
    bot.portfolio.saveState = () => ({ ok: false, skipped: false, error: 'fixture_atomic_save_failure' });
    const failed = await bot.reconcileResolvedPaperPositions(Date.now());
    assert.strictEqual(failed.blocker, 'settlement_state_save_failed', 'save failure must fail the settlement batch closed');
    assert.strictEqual(failed.rolledBackSettlements, 1, 'save failure must report the rolled-back settlement count');
    assert.strictEqual(bot.settlementPersistenceBlocked, true, 'save failure must block further settlement attempts');
    assert.strictEqual(bot.portfolio.cash, before.cash, 'save failure must roll back cash');
    assert.strictEqual(bot.portfolio.closedPnl, before.closedPnl, 'save failure must roll back closed PnL');
    assert.strictEqual(bot.portfolio.positions.get(upToken), before.positions.get(upToken), 'save failure must restore positions');
    assert.strictEqual(bot.portfolio.strategyPnl.get('GabagoolBtcOracleStrategy'), before.strategyPnl.get('GabagoolBtcOracleStrategy'), 'save failure must restore strategy PnL');
    assert.strictEqual(bot.portfolio.positionMetadata.get(upToken).marketSlug, before.positionMetadata.get(upToken).marketSlug, 'save failure must restore metadata');
    assert.strictEqual(bot.portfolio.settlements.length, 0, 'save failure must remove uncommitted settlement records');
    assert.strictEqual(bot.portfolio.settlementKeys.size, 0, 'save failure must remove uncommitted idempotency keys');

    bot.portfolio.saveState = originalSaveState;
    const retried = await bot.reconcileResolvedPaperPositions(Date.now() + 1);
    assert.deepStrictEqual(retried, { attempted: 1, settled: 1, pending: 0 }, 'retry may commit only after persistence recovers');
    assert.strictEqual(bot.settlementPersistenceBlocked, false, 'successful recovery save must unblock settlement');
    assert.strictEqual(bot.portfolio.cash, before.cash + 4, 'successful retry must apply the payout exactly once');
    assert.strictEqual(bot.portfolio.closedPnl, before.closedPnl + 2, 'successful retry must apply settlement PnL exactly once');
    assert.strictEqual(bot.portfolio.positions.size, 0, 'successful retry must remove the settled position');
    assert.strictEqual(bot.portfolio.settlements.length, 1, 'successful retry must persist exactly one settlement');

    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const restarted = new PaperPortfolio(config);
    restarted.hydratePersistedState(persisted);
    assert.strictEqual(restarted.cash, bot.portfolio.cash, 'restart must preserve committed settlement cash');
    assert.strictEqual(restarted.closedPnl, bot.portfolio.closedPnl, 'restart must preserve committed settlement PnL');
    assert.strictEqual(restarted.positions.size, 0, 'restart must not restore a settled position');
    assert.strictEqual(restarted.settlements.length, 1, 'restart must preserve exactly one settlement record');
    assert.strictEqual(restarted.settlementKeys.size, 1, 'restart must preserve exactly one settlement key');
    const duplicate = restarted.settleResolvedPosition({ tokenId: upToken, evidence: restarted.settlements[0].evidence });
    assert.strictEqual(duplicate.duplicate, true, 'restart idempotency key must prevent duplicate payout');
    assert.strictEqual(restarted.cash, bot.portfolio.cash, 'duplicate retry after restart must not change cash');

    const skippedBot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile: tempPath('settlement-skipped-save-state'),
    }));
    skippedBot.portfolio.recordFill({
      tokenId: upToken,
      marketId,
      marketSlug,
      outcome: 'Up',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    skippedBot.poly.fetchMarketById = async () => market;
    const skippedBefore = skippedBot.portfolio.captureSettlementState();
    skippedBot.portfolio.saveState = () => ({ ok: false, skipped: true, reason: 'fixture_deliberately_skipped_save' });
    const skipped = await skippedBot.reconcileResolvedPaperPositions(Date.now());
    assert.strictEqual(skipped.blocker, 'settlement_state_save_failed', 'a deliberately skipped save must not commit settlement');
    assert.strictEqual(skippedBot.portfolio.cash, skippedBefore.cash, 'skipped save must roll back cash');
    assert.strictEqual(skippedBot.portfolio.positions.get(upToken), skippedBefore.positions.get(upToken), 'skipped save must retain the position');
    assert.strictEqual(skippedBot.portfolio.settlements.length, 0, 'skipped save must not retain a settlement record');
    assert.strictEqual(skippedBot.settlementPersistenceBlocked, true, 'skipped save must block further settlement attempts');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      sophieMinExecutionQuality: 0.10,
      gabagoolMaxPaperDrawdownPct: 2.0,
      gabagoolMaxPaperClosedLossUsd: 0.75,
      gabagoolPauseEntriesOnLoss: true,
      gabagoolLossGuardCooldownMs: 60_000,
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
    const recoveredState = bot.gabagoolLossGuardState(bot.cache.markPrices(), Date.now() + 120_000);
    assert.strictEqual(recoveredState.paused, false, 'paper loss guard should recover after cooldown when BTC exposure is clean');
    assert.strictEqual(recoveredState.recoveryEligible, true, 'paper loss guard should expose recovery eligibility');
    assert.strictEqual(recoveredState.triggerEvent?.source, 'loss_exit_fill_fallback', 'paper loss guard should derive a fallback trigger from the last BTC loss fill');
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
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    wireBooks(bot, book);
    bot.trySignal(makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    }), asset, book);
    const duplicateSignal = makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    });
    const guard = bot.gabagoolEntryGuard(duplicateSignal, bot.cache.markPrices(), Date.now());
    bot.trySignal(duplicateSignal, asset, book);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(guard.reason, 'gabagool_reentry_guard', 'same-token open BUYs must be guarded');
    assert.strictEqual(guard.guardType, 'same_token_open_order', 'same-token open BUYs should expose an explicit guard type');
    assert.strictEqual(bot.portfolio.openOrders.size, 1, 'same-token BUY reentry must not stack a second open order');
    assert.strictEqual(bot.lastGabagoolPlacementDecision, 'IDLE:gabagool_reentry_guard', 'same-token open-order guard should surface in the last decision');
    assert.strictEqual(report.pipelineStats.gabagoolReentryBlocksLastHour, 1, 'same-token open-order blocks should count as reentry blocks');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const staleStartSec = baseStartSec - 600;
    const asset = makeGabagoolAsset(staleStartSec);
    const book = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    wireBooks(bot, book);
    bot.portfolio.recordFill({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      marketSlug: `btc-updown-5m-${staleStartSec}`,
      outcome: 'Up',
      side: 'buy',
      price: 0.50,
      size: 2,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.setMarkPrice('up-token', 0.50);
    if (!(bot.portfolio.paperTokenTradeability instanceof Map)) {
      bot.portfolio.paperTokenTradeability = new Map();
    }
    bot.portfolio.paperTokenTradeability.set('up-token', { status: 'stale_token_cooldown' });
    const staleSignal = makeGabagoolSignal(staleStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    });
    const guard = bot.gabagoolEntryGuard(staleSignal, bot.cache.markPrices(), Date.now());
    bot.trySignal(staleSignal, asset, book);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(guard.reason, 'gabagool_reentry_guard', 'expired same-token BTC exposure must block reentry');
    assert.strictEqual(guard.guardType, 'expired_btc_5m_exposure', 'expired same-token BTC exposure should expose the expired guard type');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'expired same-token BTC exposure must prevent a new BUY order');
    assert.strictEqual(report.pipelineStats.gabagoolReentryBlocksLastHour, 1, 'expired same-token BTC exposure should count as a reentry block');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    const asset = makeGabagoolAsset(baseStartSec);
    const book = makeBook({ bestBid: 0.48, bestAsk: 0.49, midpoint: 0.485, spread: 0.01 });
    wireBooks(bot, book);
    const now = Date.now();
    bot.recordGabagoolBlockedLossExit({
      tokenId: 'up-token',
      marketId: 'btc-market-selfcheck',
      marketSlug: `btc-updown-5m-${baseStartSec}`,
      outcome: 'Up',
      side: 'sell',
      price: 0.40,
      sizeUsd: 1,
      avgEntryPrice: 0.50,
      minProfitPrice: 0.51,
      source: 'selfcheck_recent_blocked_loss_exit',
    }, now);
    const retrySignal = makeGabagoolSignal(baseStartSec, {
      side: 'buy',
      price: 0.49,
      sizeUsd: 1,
      confidence: 0.60,
    });
    const guard = bot.gabagoolEntryGuard(retrySignal, bot.cache.markPrices(), now + 1_000);
    bot.trySignal(retrySignal, asset, book);
    const report = bot.buildBtcOracleReport(bot.cache.markPrices(), Date.now());
    assert.strictEqual(guard.reason, 'gabagool_reentry_guard', 'recent blocked loss exits must block same-token reentry');
    assert.strictEqual(guard.guardType, 'recent_blocked_loss_exit', 'blocked loss exit cooldown should surface in the guard type');
    assert.strictEqual(bot.portfolio.openOrders.size, 0, 'recent blocked loss exits must prevent a new BUY order');
    assert.strictEqual(report.pipelineStats.gabagoolReentryBlocksLastHour, 1, 'recent blocked loss exits should count as reentry blocks');
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
    assert.strictEqual(typeof report.exposure.audit.capBlockingExposureUsd, 'number', 'btc oracle report should expose cap-blocking exposure');
    assert.strictEqual(typeof report.exposure.audit.excludedDeadExposureUsd, 'number', 'btc oracle report should expose excluded dead exposure');
    assert.strictEqual(typeof report.exposure.buckets.activeTradableExposureUsd, 'number', 'btc oracle report should expose active tradable exposure');
    assert.strictEqual(typeof report.exposure.buckets.expiredBtc5mExposureUsd, 'number', 'btc oracle report should expose expired BTC 5m exposure');
    assert.strictEqual(typeof report.exposure.btcBuckets.confirmedNoOrderbook404ExposureUsd, 'number', 'btc oracle report should expose BTC 404 exposure');
    assert.strictEqual(typeof report.pnl.gabagoolPaperClosedPnl, 'number', 'btc oracle report should expose Gabagool closed pnl');
    assert.strictEqual(typeof report.pnl.gabagoolPaperUnrealizedPnl, 'number', 'btc oracle report should expose Gabagool unrealized pnl');
    assert.strictEqual(typeof report.pnl.gabagoolPaperNetPnl, 'number', 'btc oracle report should expose Gabagool net pnl');
    assert.strictEqual(typeof report.tradeQuality.gabagoolAvgRoundTripPnl, 'number', 'btc oracle report should expose average round-trip pnl');
    assert.strictEqual(typeof report.tradeQuality.gabagoolDustExitPnl, 'number', 'btc oracle report should expose dust exit pnl');
    assert.strictEqual(typeof report.dust.gabagoolDustPositionsCount, 'number', 'btc oracle report should expose dust position counts');
    assert.strictEqual(typeof report.dust.gabagoolDustValueUsd, 'number', 'btc oracle report should expose dust position value');
    assert(bot.formatBtcOracleReport(report).includes('Exposure Audit:'), 'formatted btc oracle report should include the exposure audit line');
    assert(bot.formatBtcOracleReport(report).includes('Exposure Buckets:'), 'formatted btc oracle report should include the exposure bucket line');
    assert(bot.formatBtcOracleReport(report).includes('BTC Exposure Buckets:'), 'formatted btc oracle report should include the BTC exposure bucket line');
    assert(bot.formatBtcOracleReport(report).includes('Gabagool PnL:'), 'formatted btc oracle report should include the Gabagool pnl line');
    assert(bot.formatBtcOracleReport(report).includes('Round Trips:'), 'formatted btc oracle report should include round-trip stats');
    assert.strictEqual(report.tradeQuality.winLossProxy, '1/0', 'btc oracle report should include a win/loss proxy after fake fills');
  }

  {
    const bot = new BotEngine(makeConfig({ modelPath, signalPath, targetPath, eventsPath }));
    wireBooks(bot);
    bot.portfolio.recordFill({
      tokenId: 'expired-up-token',
      marketId: 'btc-expired-market',
      marketSlug: `btc-updown-5m-${baseStartSec - 600}`,
      outcome: 'Up',
      side: 'buy',
      price: 0.50,
      size: 4,
      strategy: 'GabagoolBtcOracleStrategy',
    });
    bot.portfolio.setMarkPrice('expired-up-token', 0.49);
    if (!(bot.portfolio.paperTokenTradeability instanceof Map)) {
      bot.portfolio.paperTokenTradeability = new Map();
    }
    bot.portfolio.paperTokenTradeability.set('expired-up-token', { status: 'tradable' });
    markFixtureResolved(bot.portfolio, 'expired-up-token');
    const report = bot.buildBtcOracleReport(new Map([
      ['expired-up-token', 0.50],
    ]), Date.now());
    assert.strictEqual(report.exposure.buckets.expiredBtc5mExposureUsd, 2, 'expired BTC 5m exposure should stay visible in the exposure buckets');
    assert.strictEqual(report.exposure.audit.exposureMismatchUsd, 0, 'intentional expired BTC 5m exclusions should reconcile the exposure audit');
    assert.strictEqual(report.exposure.audit.exposureMismatchReason, 'intentional_expired_btc_5m_exclusion', 'verified resolved BTC exclusions should retain their precise reconciliation reason');
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
  }

  {
    const analysis = analyzeStateFileUsage({
      available: true,
      data: {
        startingCash: 59,
        cash: 57.67,
        executionEvents: [{ ts: Date.now() - 5_000 }],
      },
      metadata: {
        rawValue: 'moneymaker_v3_state_pre_live_burnin_30.json',
        exists: true,
        sizeBytes: 123,
        modifiedAt: new Date().toISOString(),
      },
    }, {
      runtime: { INITIAL_CASH: '59' },
      envFile: {},
    }, {
      equity: 57.67,
    });
    assert.strictEqual(analysis.status, 'state_profile_mismatch', 'state analysis should fail stale burn-in profile reuse');
    assert(analysis.warnings.some((value) => value.startsWith('state_profile_mismatch:')), 'state analysis should warn when the filename burn-in profile is stale');
    assert(analysis.warnings.includes('possible_old_state_reuse_after_reset'), 'state analysis should flag likely reuse after reset');
  }

  {
    const tempDir = fs.mkdtempSync(path.join('/tmp', 'paper-burnin-reset-'));
    const stateFile = path.join(tempDir, 'moneymaker_v3_state_post_patch_burnin_59.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      cash: 41,
      startingCash: 59,
      positions: { 'old-token': 3 },
      costBasis: { 'old-token': 2 },
      executionEvents: [{ ts: Date.now() - 5_000, type: 'fill' }],
      burnInState: {
        lifecycleStatus: 'dirty',
        lastResetAt: new Date(Date.now() - 60_000).toISOString(),
      },
    }, null, 2));
    const portfolio = new PaperPortfolio(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile,
      initialCash: 59,
      paperBurnInResetMode: true,
    }));
    const reset = portfolio.writeFreshBurnInStateFile('selfcheck_reset');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(reset.liveTradingEnabled, false, 'burn-in reset state should keep live trading off');
    assert.strictEqual(reset.liveKillSwitch, true, 'burn-in reset state should keep kill switch on');
    assert.strictEqual(reset.liveDryRunOnly, true, 'burn-in reset state should keep dry-run only on');
    assert.strictEqual(state.startingCash, 59, 'burn-in reset state should start with the configured paper bankroll');
    assert.strictEqual(state.closedPnl, 0, 'burn-in reset state should clear prior closed PnL');
    assert.strictEqual(state.executionEvents.length, 0, 'burn-in reset state should clear prior execution history');
    assert.strictEqual(state.burnInState.lifecycleStatus, 'clean_burnin_running', 'burn-in reset state should be marked clean');
    assert(fs.existsSync(reset.pendingResetStateFile), 'burn-in reset state should stage a pending reset handoff file');
    assert(reset.backupPath, 'burn-in reset should preserve a backup before writing the fresh state');
  }

  {
    const tempDir = fs.mkdtempSync(path.join('/tmp', 'paper-burnin-race-'));
    const stateFile = path.join(tempDir, 'moneymaker_v3_state_live_canary_59.json');
    const stalePortfolio = new PaperPortfolio(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile,
      initialCash: 59,
    }));
    stalePortfolio.positions.set('stale-token', 4);
    stalePortfolio.costBasis.set('stale-token', 2);
    stalePortfolio.positionMarkets.set('stale-token', 'market-1');
    stalePortfolio.latestMarks.set('stale-token', 2);
    stalePortfolio.executionEvents.push({ ts: Date.now(), type: 'fill' });
    stalePortfolio.saveState();

    const resetPortfolio = new PaperPortfolio(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile,
      initialCash: 59,
    }));
    const reset = resetPortfolio.writeFreshBurnInStateFile('selfcheck_reset_race');
    const beforeRestartState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(Object.keys(beforeRestartState.positions || {}).length, 0, 'fresh reset file should clear positions immediately');
    assert(fs.existsSync(reset.pendingResetStateFile), 'pending reset handoff file should exist before restart');

    fs.writeFileSync(stateFile, JSON.stringify({
      cash: 67,
      startingCash: 59,
      positions: { 'stale-token': 4 },
      costBasis: { 'stale-token': 2 },
      latestMarks: { 'stale-token': 2 },
      positionMarkets: { 'stale-token': 'market-1' },
      executionEvents: [{ ts: Date.now(), type: 'fill' }],
      burnInState: {
        lifecycleStatus: 'clean_burnin_running',
        lastResetAt: new Date(Date.now() - 30_000).toISOString(),
      },
    }, null, 2));
    const clobberedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(Object.keys(clobberedState.positions || {}).length, 1, 'an old process can still clobber the active file before restart');

    const restartedPortfolio = new PaperPortfolio(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      saveState: true,
      stateFile,
      initialCash: 59,
    }));
    restartedPortfolio.loadState();
    assert.strictEqual(restartedPortfolio.positions.size, 0, 'restart should re-apply the pending burn-in reset and clear stale positions');
    assert.strictEqual(restartedPortfolio.executionEvents.length, 0, 'restart should clear stale execution history');
    assert.strictEqual(restartedPortfolio.fills.length, 0, 'restart should clear stale fills');
    assert(!fs.existsSync(reset.pendingResetStateFile), 'pending reset handoff file should be consumed on restart');
  }

  {
    const portfolio = new PaperPortfolio(makeConfig({ modelPath, signalPath, targetPath, eventsPath }, {
      initialCash: 59,
      maxDrawdownPct: 5,
      paperActionBurnInEnabled: true,
      paperActionBurnInTargetOrdersPer15m: 3,
    }));
    portfolio.cash = 56.03;
    portfolio.peakEquity = 59;
    portfolio.closedPnl = -2.97;
    portfolio.recordExecutionEvent('paper_probation_admit', {
      strategy: 'SpreadHunter',
      tokenId: 'probation-token',
      side: 'buy',
      reason: 'paper_flow_probation',
    });
    portfolio.recordExecutionEvent('risk_block', {
      strategy: 'SpreadHunter',
      tokenId: 'probation-token',
      side: 'buy',
      reason: 'drawdown_limit',
      paperProbationActive: true,
      probationAdmission: 'probation_admission',
      sophieDecision: 'PAPER_PROBATION_ADMIT',
      finalBlockerAfterProbation: 'drawdown_limit',
      drawdownGateActive: true,
    });
    const health = portfolio.executionHealth(Date.now());
    assert.strictEqual(health.probationAdmissionsBeforeRisk, 1, 'paper flow should expose probation admissions before Risk');
    assert.strictEqual(health.probationOrdersBlockedByDrawdown, 1, 'paper flow should expose probation orders blocked by drawdown');
    assert.strictEqual(health.finalBlockerAfterProbation, 'drawdown_limit', 'paper flow should expose the final blocker after probation');
    assert.strictEqual(health.drawdownGateActive, true, 'paper flow should expose an active drawdown gate');
    assert(health.actionRateReason.includes('sophie_admitted_but_final_risk_gate_blocked'), 'action-rate reason should explain when Sophie admitted but final Risk blocked');
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
      initialCash: 50,
      minOrderUsd: 1,
      paperDeadExposureCashReleaseEnabled: true,
      paperDeadExposureCashReleaseBatchUsd: 50,
      paperDeadExposureCashReleaseTriggerUsd: 5,
    });
    const bot = new BotEngine(config);
    const expiredStartSec = Math.floor(Date.now() / 1000) - 900;
    const marketSlug = `btc-updown-5m-${expiredStartSec}`;
    const tokenId = 'expired-btc-cash-release-token';
    bot.portfolio.recordFill({
      tokenId,
      marketId: marketSlug,
      side: 'buy',
      price: 0.50,
      size: 100,
      strategy: 'GabagoolBtcOracleStrategy',
      marketSlug,
      outcome: 'Up',
    });
    bot.portfolio.setMarkPrice(tokenId, 0.50);
    markFixtureResolved(bot.portfolio, tokenId);
    bot.portfolio.cash = 1;
    const equityBefore = bot.portfolio.equity(bot.cache.markPrices());
    const reserveResult = bot.rebalancePaperDeadExposureCashReserve(bot.cache.markPrices(), Date.now());
    const equityAfter = bot.portfolio.equity(bot.cache.markPrices());
    assert.strictEqual(reserveResult.action, 'release', 'expired BTC inventory should release a paper cash batch');
    assert(Math.abs(bot.portfolio.availableCash() - 51) < 1e-9, 'paper cash reserve should add a fresh $50 batch when cash is exhausted');
    assert.strictEqual(bot.portfolio.deadExposureCashReserveOutstanding(), 50, 'paper cash reserve outstanding should track the released batch');
    assert(Math.abs(equityBefore - equityAfter) < 1e-9, 'paper cash reserve must not inflate equity');
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

  const isolatedLiveConfigRoot = tempDir('gabagool-live-config-selfcheck');
  const liveConfig = readLiveConfig(isolatedLiveConfigRoot);
  assert.strictEqual(liveConfig.enableLiveTrading, false, 'live adapter must stay disabled');
  assert.strictEqual(liveConfig.liveAutoExecute, false, 'live auto execute must stay disabled');
  assert.strictEqual(liveConfig.liveKillSwitch, true, 'live kill switch must stay enabled');
  assert.strictEqual(liveConfig.liveDryRunOnly, true, 'live dry run must stay enabled');
  assert.strictEqual(liveConfig.liveSubmitConfirm, false, 'live submit confirm must stay disabled');

  assert(fs.existsSync(stage5DiagnosticFixturePath), 'successful Gabagool paper placements must create the locked-off Stage 5 diagnostic fixture');
  const stage5Diagnostics = fs.readFileSync(stage5DiagnosticFixturePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  assert(stage5Diagnostics.length > 0, 'at least one successful paper placement diagnostic is required');
  assert(stage5Diagnostics.every((record) => record.source === 'gabagool_successful_paper_placement'));
  assert(stage5Diagnostics.every((record) => record.paperPlacementSucceeded === true));
  assert(stage5Diagnostics.every((record) => record.stage5SizingEvaluated === true));
  assert(stage5Diagnostics.every((record) => Object.prototype.hasOwnProperty.call(record, 'stage5CandidateGateEligible')));
  assert(stage5Diagnostics.every((record) => Object.prototype.hasOwnProperty.call(record, 'stage5AdjustedRiskEligible')));
  assert(stage5Diagnostics.every((record) => record.stage5EligibilityBlocker === record.candidateWriterBlocker));
  assert(stage5Diagnostics.every((record) => Object.prototype.hasOwnProperty.call(record, 'candidateWriterBlocker')));
  assert(stage5Diagnostics.every((record) => Object.prototype.hasOwnProperty.call(record, 'adjustedStage5SizeUsd')));

  console.log('engine gabagool btc self-check passed');
}

run();
