#!/usr/bin/env node
'use strict';

const assert = require('assert');
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
