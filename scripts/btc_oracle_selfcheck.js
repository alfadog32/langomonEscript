#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';
process.env.BTC_ORACLE_THRESHOLD = '0.0001';
delete process.env.BTC_ORACLE_MIN_LAG_SCORE;
process.env.BTC_ORACLE_MARKET_SLUG = 'btc-updown-5m-1786125000';
process.env.BTC_ORACLE_MARKET_QUESTION = 'Bitcoin Up or Down - August 7 fixture';
process.env.BTC_ORACLE_MARKET_START_TS_SEC = '1786125000';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createSignalPayload,
  verifyOutputPaths,
  pathDiagnostics,
  CONFIG: bridgeConfig,
} = require('../btc_poly_oracle_v5_sniper_bridge_FIXED');
const runner = require('../btc_poly_oracle_auto_discovery_runner');
const { readConfig: readLiveConfig } = require('../live_adapter_polymarket');

function makeBook(overrides = {}) {
  return {
    valid: true,
    reason: 'ok',
    ageMs: 100,
    bestBid: 0.49,
    bestAsk: 0.51,
    midpoint: 0.50,
    spread: 0.02,
    bidDepth: 100,
    askDepth: 100,
    obi: 0.8,
    ...overrides,
  };
}

function makeSignal() {
  return createSignalPayload({
    impulse: {
      direction: 'UP',
      tokenId: 'up-token',
      initialPrice: 100000,
      triggerPrice: 100400,
      triggerMovePct: 0.004,
      initialBook: makeBook(),
    },
    latest: { price: 100420 },
    persistedAbsMove: 0.0042,
    finalBook: makeBook(),
  });
}

function captureDoctor() {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    runner.printDoctor();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

function run() {
  const outputPaths = verifyOutputPaths();
  for (const diag of Object.values(outputPaths)) {
    assert(diag.resolved.startsWith(path.resolve(__dirname, '..')), 'default output paths should resolve under project');
    assert.strictEqual(diag.directoryExists, true, 'default output path directory should exist');
  }

  const unsafe = pathDiagnostics('/tmp/oracle-selfcheck.ndjson');
  assert.strictEqual(unsafe.underProject, false, 'explicit absolute path outside project should be detectable');

  const signal = makeSignal();
  assert.strictEqual(signal.action, 'TELEGRAM_ALERT_ONLY', 'default action remains alert-only');
  assert.strictEqual(signal.safety.do_not_auto_trade, true);
  assert.strictEqual(signal.safety.telegram_approval_required, true);
  assert.strictEqual(signal.safety.do_not_disable_risk_engine, true);
  assert.strictEqual(signal.safety.do_not_cancel_profit_exits, true);
  assert.strictEqual(signal.safety.do_not_sweep_without_depth_check, true);
  assert.strictEqual(signal.token_id, 'up-token');
  assert.strictEqual(signal.confirmed, true, 'all three oracle confirmation legs should produce a confirmed signal');
  assert.deepStrictEqual(signal.confirmation_blockers, []);
  assert.strictEqual(signal.market_slug, 'btc-updown-5m-1786125000');
  assert.strictEqual(signal.market_start_ts_sec, 1786125000);
  assert.strictEqual(bridgeConfig.minLagScore, bridgeConfig.triggerThreshold, 'default lag floor must track the configured trigger threshold');

  const downSignal = createSignalPayload({
    impulse: {
      direction: 'DOWN',
      tokenId: 'down-token',
      initialPrice: 100000,
      triggerPrice: 99980,
      triggerMovePct: 0.0002,
      initialBook: makeBook({ midpoint: 0.50 }),
    },
    latest: { price: 99970 },
    persistedAbsMove: 0.0003,
    finalBook: makeBook({ midpoint: 0.50, obi: 0.8 }),
  });
  assert.strictEqual(downSignal.direction, 'DOWN');
  assert.strictEqual(downSignal.suggested_action, 'BUY_BTC_DOWN_TOKEN');
  assert.strictEqual(downSignal.token_id, 'down-token');
  assert.strictEqual(downSignal.confirmed, true, 'DOWN mapping must preserve all confirmation legs');

  const realFixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'btc_oracle_20260807T175015Z.json'),
    'utf8'
  ));
  const fixtureBook = (book) => makeBook({
    valid: book.valid,
    reason: book.reason,
    ageMs: book.age_ms,
    bestBid: book.best_bid,
    bestAsk: book.best_ask,
    midpoint: book.midpoint,
    spread: book.spread,
    bidDepth: book.bid_depth_usd,
    askDepth: book.ask_depth_usd,
    obi: book.obi,
  });
  const correctedRealSignal = createSignalPayload({
    impulse: {
      direction: realFixture.direction,
      tokenId: realFixture.token_id,
      initialPrice: realFixture.initial_btc_price,
      triggerPrice: realFixture.trigger_btc_price,
      triggerMovePct: realFixture.btc_trigger_move_pct,
      initialBook: fixtureBook(realFixture.book_at_trigger),
    },
    latest: { price: realFixture.current_btc_price },
    persistedAbsMove: realFixture.btc_persisted_move_pct,
    finalBook: fixtureBook(realFixture.book_after_persistence),
  });
  assert.strictEqual(realFixture.lag_score_pass, false, 'fixture must preserve the production failure before the fix');
  assert.strictEqual(correctedRealSignal.poly_lag_confirmed, true);
  assert.strictEqual(correctedRealSignal.lag_score_pass, true, 'coherent lag floor must recover the real qualifying signal');
  assert.strictEqual(correctedRealSignal.obi_confirmed, true);
  assert.strictEqual(correctedRealSignal.confirmed, true);

  const invalidBookSignal = createSignalPayload({
    impulse: {
      direction: 'DOWN',
      tokenId: 'down-token',
      initialPrice: 100000,
      triggerPrice: 99600,
      triggerMovePct: 0.004,
      initialBook: makeBook({ valid: false, reason: 'empty_side', midpoint: null }),
    },
    latest: { price: 99550 },
    persistedAbsMove: 0.0045,
    finalBook: makeBook({ valid: false, reason: 'empty_side', midpoint: null }),
  });
  assert.strictEqual(invalidBookSignal.action, 'TELEGRAM_ALERT_ONLY');
  assert.strictEqual(invalidBookSignal.confirmed, false, 'malformed books must remain unconfirmed');
  assert(invalidBookSignal.confirmation_blockers.some((reason) => reason.startsWith('book_')));
  assert.strictEqual(invalidBookSignal.suggested_max_paper_usd, bridgeConfig.suggestedMaxPaperUsd);
  assert(!('liveOrder' in invalidBookSignal), 'oracle signal should not become a live order');

  assert.strictEqual(bridgeConfig.writeTestEvent, false, 'write test is disabled by default');
  assert.strictEqual(runner.CONFIG.writeTestEvent, false, 'runner write test is disabled by default');
  assert(bridgeConfig.reconnectBaseMs >= 1000, 'oracle reconnect base should be bounded');
  assert(bridgeConfig.reconnectMaxMs >= bridgeConfig.reconnectBaseMs, 'oracle reconnect max should be at least base');
  assert(bridgeConfig.noSignalLogCooldownMs > 0, 'oracle no-signal logs should be cooldown limited');

  const doctorRaw = captureDoctor();
  const doctor = JSON.parse(doctorRaw);
  assert.strictEqual(doctor.mode, 'doctor');
  assert.strictEqual(doctor.networkConnectionsStarted, false);
  assert.strictEqual(doctor.bridgeStarted, false);
  assert.strictEqual(doctor.filesWritten, false);
  assert.strictEqual(doctor.tradingEnabled, false);
  assert(doctor.bridge.exists, 'doctor should find bridge file');

  const liveConfig = readLiveConfig(process.cwd());
  assert.strictEqual(liveConfig.enableLiveTrading, false);
  assert.strictEqual(liveConfig.liveAutoExecute, false);
  assert.strictEqual(liveConfig.liveKillSwitch, true);
  assert.strictEqual(liveConfig.liveDryRunOnly, true);
  assert.strictEqual(liveConfig.liveSubmitConfirm, false);

  console.log('btc oracle self-check passed');
}

run();
