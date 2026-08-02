#!/usr/bin/env node
'use strict';

// Isolated Stage 5 path proof. It never reads repository .env files, never
// loads live secrets, and runs the real router against temporary NDJSON files.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function candidate() {
  return {
    id: 'stage5-router-refusal-proof',
    timestamp: new Date().toISOString(),
    source: 'MONEYMAKER',
    strategy: 'GabagoolBtcOracleStrategy',
    tokenId: 'stage5proofasset1234567890',
    marketId: 'stage5-canary-market',
    side: 'BUY',
    price: 0.80,
    sizeUsd: 5,
    sizeShares: 6.25,
    minOrderSize: 5,
    confidence: 0.80,
    sophieApproved: true,
    riskApproved: true,
    expectedEdge: 0.05,
    bookFresh: true,
    bookAgeMs: 50,
    tickSize: '0.01',
    negRisk: false,
    reason: 'stage five operator readiness candidate',
    paperBurnIn: { ok: true, reports: 5, closedPnlUsd: 1, drawdownPct: 0, ghostFavorablePct: 25 },
  };
}

function readEvents(eventsPath) {
  return fs.readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function runScenario(name, liveCanaryMarketId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stage5-router-${name}-`));
  const input = path.join(dir, 'candidate.ndjson');
  const events = path.join(dir, 'router-events.ndjson');
  fs.writeFileSync(input, `${JSON.stringify(candidate())}\n`);

  const env = {
    ...process.env,
    MM_SKIP_LOCAL_ENV_FILE: 'true',
    SKIP_LOCAL_ENV_FILE: 'true',
    ENABLE_LIVE_TRADING: 'false',
    LIVE_AUTO_EXECUTE: 'false',
    LIVE_KILL_SWITCH: 'true',
    LIVE_DRY_RUN_ONLY: 'true',
    LIVE_SUBMIT_CONFIRM: 'false',
    LIVE_FINAL_BOSS_READY: 'false',
    LIVE_TRADING_STAGE: '5',
    LIVE_CANARY_MARKET_ID: liveCanaryMarketId,
    MAX_LIVE_ORDER_USD: '5',
    MAX_LIVE_TOTAL_EXPOSURE_USD: '5',
    LIVE_DAILY_MAX_LOSS_USD: '5',
    LIVE_MAX_ORDERS_PER_HOUR: '1',
    LIVE_ROUTER_MODE: 'submit',
    LIVE_ROUTER_ADAPTER_PATH: path.join(ROOT, 'live_adapter_polymarket.js'),
    LIVE_ROUTER_TELEGRAM_NOTIFY: 'false',
    LIVE_ROUTER_WATCH_PATHS: input,
    LIVE_ROUTER_EVENTS_PATH: events,
    LIVE_ROUTER_STATE_PATH: path.join(dir, 'router-state.json'),
    LIVE_ADAPTER_EVENTS_PATH: path.join(dir, 'adapter-events.ndjson'),
    LIVE_INTENT_LOG_PATH: path.join(dir, 'adapter-intents.ndjson'),
    LIVE_EXECUTION_LOG_PATH: path.join(dir, 'adapter-executions.ndjson'),
    LIVE_SECRETS_PATH: path.join(dir, 'never-read-live-secrets'),
  };
  const result = spawnSync(process.execPath, [path.join(ROOT, 'live_intent_router.js'), 'once'], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, `${name}: router failed: ${result.stderr || result.stdout}`);

  const eventsList = readEvents(events);
  const event = eventsList.find((entry) => entry.type === 'LIVE_ROUTER_ADAPTER_RESULT');
  assert(event, `${name}: router did not reach adapter`);
  assert.strictEqual(event.router_mode, 'submit', `${name}: submit-mode refusal path was not used`);
  assert.notStrictEqual(event.adapter_decision, 'SUBMITTED', `${name}: unsafe adapter submission`);
  assert(event.adapter_reasons.includes('AUTO_EXECUTE_DISABLED'), `${name}: AUTO_EXECUTE_DISABLED missing`);
  assert(!eventsList.some((entry) => entry.adapter_decision === 'SUBMITTED'), `${name}: submission event recorded`);
  return event;
}

function main() {
  const proof = candidate();
  assert.strictEqual(proof.sizeUsd, 5, '$5 candidate required');
  assert(proof.sizeShares >= proof.minOrderSize, '5-share minimum must be satisfied');

  const missing = runScenario('missing-canary-id', '');
  assert(missing.adapter_reasons.includes('LIVE_CANARY_MARKET_ID_REQUIRED'), 'Stage 5 must require LIVE_CANARY_MARKET_ID');

  const matching = runScenario('matching-canary-id', proof.marketId);
  assert(!matching.adapter_reasons.includes('LIVE_CANARY_MARKET_ID_REQUIRED'), 'matching Stage 5 market id should pass required gate');
  assert(!matching.adapter_reasons.includes('LIVE_CANARY_MARKET_MISMATCH'), 'matching Stage 5 market id should pass single-market gate');
  assert(!matching.adapter_reasons.includes('MAX_LIVE_ORDER_USD_EXCEEDED'), '$5 must pass Stage 5 order cap');
  assert(!matching.adapter_reasons.includes('MAX_LIVE_TOTAL_EXPOSURE_USD_EXCEEDED'), '$5 must pass Stage 5 exposure cap');

  console.log('live_stage5_router_refusal_selfcheck: ok (candidate -> router -> adapter refusal; no submit)');
}

main();
