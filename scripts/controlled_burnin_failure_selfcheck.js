#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildEntryPlan,
  deriveOracleExpectedEdge,
} = require('../gabagool_btc_behavior');
const {
  CONFIG,
  STAGE5_GABAGOOL_MIN_CONFIDENCE,
  BotEngine,
  PaperPortfolio,
  RiskEngine,
} = require('../moneymaker_v3');

const FAILED_STATE_BASENAME = 'moneymaker_v3_state_controlled_burnin_91_20260806_0733.json';
const FAILED_LOSS_EVIDENCE = [
  {
    marketSlug: 'btc-updown-5m-1786006800',
    outcome: 'Up',
    price: 0.28,
    polyMidAtTrigger: 0.245,
    polyMidAfterPersistence: 0.325,
    polyMidMovePct: 0.32653061224489804,
    btcTriggerMovePct: 0.00010104166875241221,
    btcPersistedMovePct: 0.00010134972262062268,
    oldInflatedExpectedEdge: 0.326531,
  },
  {
    marketSlug: 'btc-updown-5m-1786007400',
    outcome: 'Up',
    price: 0.07,
    polyMidAtTrigger: 0.035,
    polyMidAfterPersistence: 0.065,
    polyMidMovePct: 0.857142857142857,
    btcTriggerMovePct: 0.00010078605405001482,
    btcPersistedMovePct: 0.0001418413226217513,
    oldInflatedExpectedEdge: 0.857143,
  },
  {
    marketSlug: 'btc-updown-5m-1786008300',
    outcome: 'Up',
    price: 0.75,
    polyMidAtTrigger: 0.585,
    polyMidAfterPersistence: 0.745,
    polyMidMovePct: 0.2735042735042736,
    btcTriggerMovePct: 0.00010201034455885282,
    btcPersistedMovePct: 0.00016435857330587524,
    oldInflatedExpectedEdge: 0.273504,
  },
];

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function modelFixture() {
  return {
    generatedAt: new Date().toISOString(),
    source: { resolvedProxyWallet: 'fixture-only' },
    strategyProfile: {
      timingStyle: { entryCutoffSec: 180 },
      sizeStyle: { medianSizeUsd: 2 },
      holdStyle: { timedExitSec: 75, lateExitSec: 180 },
    },
    diagnostics: { observedSellBehavior: 'fixture' },
  };
}

function bookFixture(price) {
  const bestAsk = Number(price);
  const bestBid = Number((bestAsk - 0.01).toFixed(2));
  return {
    bids: [{ price: bestBid, size: 1000 }],
    asks: [{ price: bestAsk, size: 1000 }],
    bestBid,
    bestAsk,
    midpoint: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    cachedAt: Date.now(),
  };
}

function targetFixture(startSec) {
  return {
    timestamp: new Date().toISOString(),
    target: {
      question: 'Bitcoin Up or Down - controlled burn-in regression fixture',
      slug: `btc-updown-5m-${startSec}`,
      ts: startSec,
      BTC_UP_TOKEN_ID: 'up-token',
      BTC_DOWN_TOKEN_ID: 'down-token',
      rawMarketId: 'controlled-burnin-regression-market',
    },
  };
}

function signalFixture(evidence, overrides = {}) {
  const now = Date.now();
  return {
    timestamp: new Date(now - 1_500).toISOString(),
    expires_at: new Date(now + 15_000).toISOString(),
    type: 'BTC_TEMPORAL_LAG_OBI_V5',
    interrupt_level: 'PRIORITY_ALERT',
    token_id: 'up-token',
    direction: 'UP',
    suggested_action: 'BUY_BTC_UP_TOKEN',
    action: 'TELEGRAM_ALERT_ONLY',
    confidence: 0.5,
    initial_btc_price: 65000,
    trigger_btc_price: 65006.5,
    current_btc_price: 65009.2,
    btc_trigger_move_pct: evidence.btcTriggerMovePct,
    btc_persisted_move_pct: evidence.btcPersistedMovePct,
    poly_mid_at_trigger: evidence.polyMidAtTrigger,
    poly_mid_after_persistence: evidence.polyMidAfterPersistence,
    poly_mid_move_pct: evidence.polyMidMovePct,
    poly_move_weight_limit_pct: evidence.btcPersistedMovePct * 0.5,
    poly_lag_confirmed: false,
    lag_score: 0,
    lag_score_pass: false,
    obi_confirmed: false,
    book_after_persistence: {
      valid: true,
      best_bid: Math.max(0.01, evidence.price - 0.01),
      best_ask: evidence.price,
      midpoint: Math.max(0.015, evidence.price - 0.005),
      spread: 0.01,
      bid_depth_usd: 100,
      ask_depth_usd: 100,
      obi: 0.7,
    },
    ...overrides,
  };
}

function safeConfig(tempDir, paths, overrides = {}) {
  return {
    ...CONFIG,
    stateFile: path.join(tempDir, 'paper-state.json'),
    initialCash: 91,
    saveState: false,
    paperTrading: true,
    enableWs: false,
    enableWhaleTracking: false,
    enableGhostMode: false,
    nonBlockingResearchRefresh: false,
    enableGabagoolBtcImitation: true,
    gabagoolBehaviorModelPath: paths.model,
    gabagoolSignalPath: paths.signal,
    gabagoolTargetPath: paths.target,
    gabagoolTelegramEventsPath: paths.events,
    gabagoolTelegramUpdates: false,
    paperTelegramDigestEnabled: false,
    stage5CandidateShadowEnabled: false,
    autoLiveCandidatesEnabled: false,
    enableLiveTrading: false,
    liveAutoExecute: false,
    liveKillSwitch: true,
    liveDryRunOnly: true,
    liveSubmitConfirm: false,
    liveFinalBossReady: false,
    gabagoolMaxPaperOrderUsd: 2,
    gabagoolMinConfidence: 0.47,
    sophieMinExecutionQuality: 0.01,
    maxDrawdownPct: 5,
    gabagoolMaxPaperDrawdownPct: 5,
    gabagoolMaxPaperClosedLossUsd: 100,
    maxTotalExposureUsd: 10,
    maxMarketExposureUsd: 10,
    maxPositionUsdPerAsset: 10,
    maxOpenOrders: 4,
    maxTotalOpenOrderUsd: 10,
    ...overrides,
  };
}

async function runProductionOraclePath({ config, model, signal, target, book, paths }) {
  writeJson(paths.signal, signal);
  writeJson(paths.target, target);
  const bot = new BotEngine(config);
  bot.ensureGabagoolBehaviorModel = async () => model;
  bot.refreshGabagoolPositionMetadata = async () => ({ attempted: 0, refreshed: 0 });
  bot.reconcileResolvedPaperPositions = async () => ({ attempted: 0, settled: 0, pending: 0 });
  bot.getGabagoolBook = async (tokenId, books) => {
    const selected = String(tokenId) === 'up-token'
      ? book
      : bookFixture(Number((1 - book.bestBid).toFixed(2)));
    books.set(String(tokenId), selected);
    return selected;
  };
  await bot.runGabagoolBtcOracleImitation();
  return bot;
}

async function main() {
  const failedStatePath = path.resolve(process.argv[2] || FAILED_STATE_BASENAME);
  assert(fs.existsSync(failedStatePath), `failed state not found: ${failedStatePath}`);
  const failedStateHashBefore = sha256(failedStatePath);
  const failedState = JSON.parse(fs.readFileSync(failedStatePath, 'utf8'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-burnin-failure-selfcheck-'));
  const paths = {
    model: path.join(tempDir, 'model.json'),
    signal: path.join(tempDir, 'signal.json'),
    target: path.join(tempDir, 'target.json'),
    events: path.join(tempDir, 'paper-events.ndjson'),
  };

  try {
    const model = modelFixture();
    writeJson(paths.model, model);

    for (const evidence of FAILED_LOSS_EVIDENCE) {
      const startSec = Math.floor(Date.now() / 1000) - 60;
      const target = targetFixture(startSec);
      const signal = signalFixture(evidence);
      const book = bookFixture(evidence.price);
      assert.strictEqual(
        deriveOracleExpectedEdge(signal),
        0,
        `${evidence.marketSlug} must not convert adverse Polymarket movement into positive edge`
      );
      const plan = buildEntryPlan({
        model,
        oracleSignal: signal,
        oracleTarget: target,
        book,
        now: Date.now(),
        maxPaperOrderUsd: 2,
        minExpectedEdge: 0.0001,
      });
      assert.strictEqual(plan.blockReason, 'expected_edge_zero', `${evidence.marketSlug} must fail the entry plan`);

      const config = safeConfig(tempDir, paths, {
        stateFile: path.join(tempDir, `${path.basename(evidence.marketSlug)}.json`),
      });
      const bot = await runProductionOraclePath({ config, model, signal, target, book, paths });
      const health = bot.portfolio.executionHealth();
      assert.strictEqual(bot.portfolio.openOrders.size, 0, `${evidence.marketSlug} must not place a paper order`);
      assert.strictEqual(health.gabagoolSophieEvaluatedLastHour, 0, `${evidence.marketSlug} must stop before Sophie`);
      assert.strictEqual(bot.lastGabagoolConfirmCheck.confirmed, false, `${evidence.marketSlug} must fail confirmation`);
      assert.strictEqual(bot.lastGabagoolConfirmCheck.blockReason, 'poly_lag_not_confirmed');
    }

    // A genuinely confirmed lag signal still traverses the real paper entry
    // path.  This protects valid behavior without re-admitting priority alerts.
    {
      const startSec = Math.floor(Date.now() / 1000) - 60;
      const target = targetFixture(startSec);
      const winningEvidence = { ...FAILED_LOSS_EVIDENCE[0], price: 0.48 };
      const signal = signalFixture(winningEvidence, {
        interrupt_level: 'HARD_INTERRUPT_REQUEST',
        poly_lag_confirmed: true,
        lag_score: 0.00012,
        lag_score_pass: true,
        obi_confirmed: true,
        confidence: 0.82,
        poly_mid_move_pct: 0.00002,
        poly_move_weight_limit_pct: 0.00009,
      });
      const book = bookFixture(0.48);
      const config = safeConfig(tempDir, paths, { stateFile: path.join(tempDir, 'valid-winner.json') });
      const bot = await runProductionOraclePath({ config, model, signal, target, book, paths });
      assert.strictEqual(bot.lastGabagoolConfirmCheck.confirmed, true, 'genuinely confirmed signal must pass confirmation');
      assert.strictEqual(bot.lastGabagoolConfirmCheck.confirmedSource, 'oracle_confirmation_fields');
      assert.strictEqual(bot.portfolio.openOrders.size, 1, 'genuinely confirmed winning behavior must reach paper placement');
      assert.strictEqual(bot.config.autoLiveCandidatesEnabled, false, 'regression path must not emit a live candidate');
    }

    // Reconcile the immutable failed-state ledger independently: all fills are
    // trusted, both settlements are verified, and cash equals initial cash plus
    // realized PnL with no remaining position value.
    const portfolio = new PaperPortfolio(safeConfig(tempDir, paths));
    portfolio.hydratePersistedState(failedState);
    const trustedSellPnl = failedState.fills
      .filter((fill) => fill.side === 'sell' && fill.trustedPnl === true)
      .reduce((sum, fill) => sum + Number(fill.trustedRealizedPnl || 0), 0);
    const trustedSettlementPnl = failedState.settlements
      .filter((settlement) => settlement.trustedSettlement === true)
      .reduce((sum, settlement) => sum + Number(settlement.realizedPnl || 0), 0);
    assert(Math.abs((trustedSellPnl + trustedSettlementPnl) - failedState.closedPnl) < 1e-9, 'settlement and sell PnL must reconcile');
    assert(Math.abs((failedState.startingCash + failedState.closedPnl) - failedState.cash) < 1e-9, 'settled cash must reconcile');
    assert.strictEqual(portfolio.positions.size, 0, 'failed ledger must have no residual positions');
    assert(failedState.settlements.every((settlement) => (
      settlement.trustedSettlement === true &&
      Math.abs((settlement.payoutUsd - settlement.costUsd) - settlement.realizedPnl) < 1e-9
    )), 'trusted settlement payout arithmetic must remain exact');

    const reconstructedDrawdown = ((failedState.peakEquity - failedState.cash) / failedState.peakEquity) * 100;
    assert(Math.abs(reconstructedDrawdown - failedState.burnInState.failedDrawdownPct) < 1e-12, 'failed drawdown must reconstruct exactly');
    assert(Math.abs(portfolio.drawdownPct(new Map()) - reconstructedDrawdown) < 1e-12, 'production drawdown calculation must match the independent formula');

    const risk = new RiskEngine(safeConfig(tempDir, paths, { maxDrawdownPct: 5 }), portfolio);
    const blocked = risk.evaluate({
      strategy: 'GabagoolBtcOracleStrategy', tokenId: 'fresh-token', marketId: 'fresh-market',
      side: 'buy', price: 0.5, sizeUsd: 1, expectedEdge: 0.01, confidence: 0.8,
      metadata: { marketSlug: 'btc-updown-5m-fixture', outcome: 'Up', gabagool: { oracleSignalFresh: true } },
    });
    assert.strictEqual(blocked, null, 'genuine drawdown above 5% must block risk admission');
    assert.strictEqual(risk.lastBlockReason, 'drawdown_limit', 'drawdown guard must remain active');

    const genuineLossPortfolio = new PaperPortfolio(safeConfig(tempDir, paths, { initialCash: 100 }));
    genuineLossPortfolio.cash = 94.99;
    genuineLossPortfolio.peakEquity = 100;
    assert(genuineLossPortfolio.drawdownPct(new Map()) > 5, 'a genuine 5% loss must be measured above the limit');

    assert.strictEqual(STAGE5_GABAGOOL_MIN_CONFIDENCE, 0.70, 'Stage 5 confidence floor must remain 0.70');
    assert.strictEqual(CONFIG.enableLiveTrading, false, 'live trading must remain off');
    assert.strictEqual(CONFIG.liveAutoExecute, false, 'live auto execution must remain off');
    assert.strictEqual(CONFIG.liveKillSwitch, true, 'live kill switch must remain on');
    assert.strictEqual(CONFIG.liveDryRunOnly, true, 'live dry-run-only must remain on');
    assert.strictEqual(CONFIG.liveSubmitConfirm, false, 'live submit confirmation must remain off');
    assert.strictEqual(CONFIG.liveFinalBossReady, false, 'live final-boss readiness must remain off');

    const failedStateHashAfter = sha256(failedStatePath);
    assert.strictEqual(failedStateHashAfter, failedStateHashBefore, 'failed burn-in state must remain byte-for-byte unchanged');
    console.log(JSON.stringify({
      ok: true,
      failedState: path.basename(failedStatePath),
      failedStateSha256: failedStateHashAfter,
      badLossPatternsBlocked: FAILED_LOSS_EVIDENCE.length,
      validConfirmedBehaviorPlacedPaperOrder: true,
      settlementAccountingReconciled: true,
      reconstructedDrawdownPct: reconstructedDrawdown,
      drawdownGate: 'drawdown_limit',
      stage5ConfidenceFloor: STAGE5_GABAGOOL_MIN_CONFIDENCE,
      liveTrading: false,
    }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
