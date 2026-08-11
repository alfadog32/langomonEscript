#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
const monitor = require('./moneymaker_local_monitor');

const ROOT = path.resolve(__dirname, '..');
const PRODUCTION_FILES = [
  'auto_live_candidates.ndjson',
  'trade_intents.ndjson',
  'live_intent_router_events.ndjson',
  'live_adapter_events.ndjson',
  'live_execution_events.ndjson',
].map((name) => path.join(ROOT, name));

function checksum(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeNdjson(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function startFixtureServer(statePath, now) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/dashboard/health') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/dashboard/api/status') {
      res.end(JSON.stringify({
        ok: true,
        generatedAt: new Date(now).toISOString(),
        stateFile: { resolvedPath: statePath },
        portfolio: { stateFile: statePath },
        settings: { runtime: {} },
      }));
      return;
    }
    if (req.url === '/time') {
      res.end(JSON.stringify(Math.floor(now / 1000)));
      return;
    }
    if (req.url === '/rpc') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: '0x89' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function makePm2Mock(tempDir) {
  const filePath = path.join(tempDir, 'pm2-fixture');
  fs.writeFileSync(filePath, `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\n' '│ id │ name                │ namespace │ version │ mode │ pid  │ uptime │ ↺ │ status │ cpu │ mem    │ user │ watching │'
  printf '%s\n' '│ 0  │ langomonEscript     │ default   │ 1.0.0   │ fork │ 1000 │ 2h     │ 3 │ online │ 1%  │ 80.0mb │ test │ disabled │'
  printf '%s\n' '│ 1  │ langomon-dashboard  │ default   │ 1.0.0   │ fork │ 1001 │ 2h     │ 1 │ online │ 0%  │ 30.0mb │ test │ disabled │'
  printf '%s\n' '│ 2  │ btcPolyOracle       │ default   │ 1.0.0   │ fork │ 1002 │ 2h     │ 2 │ online │ 1%  │ 40.0mb │ test │ disabled │'
  printf '%s\n' '│ 3  │ liveIntentRouter    │ default   │ 1.0.0   │ fork │ 1003 │ 2h     │ 0 │ online │ 0%  │ 25.0mb │ test │ disabled │'
  printf '%s\n' '│ 4  │ telegramApprovalBot │ default   │ 1.0.0   │ fork │ 1004 │ 2h     │ 0 │ online │ 0%  │ 25.0mb │ test │ disabled │'
  exit 0
fi
if [ "$1" = "describe" ]; then
  printf '%s\n' "│ status            │ online │"
  printf '%s\n' "│ pid               │ 1000 │"
  printf '%s\n' "│ uptime            │ 2h │"
  printf '%s\n' "│ restarts          │ 3 │"
  printf '%s\n' "│ unstable restarts │ 0 │"
  printf '%s\n' "│ out log path      │ ${tempDir}/$2-out.log │"
  printf '%s\n' "│ error log path    │ ${tempDir}/$2-error.log │"
  exit 0
fi
exit 1
`, { encoding: 'utf8', mode: 0o755 });
  return filePath;
}

function makeFixture(tempDir, now) {
  const statePath = path.join(tempDir, 'state.json');
  const tokenId = 'token-size';
  const order = {
    type: 'gabagool_order_placed', ts: now - 2_000, tokenId, marketId: 'market-5',
    marketSlug: 'btc-updown-5m-fixture', outcome: 'Up', side: 'buy', strategy: 'GabagoolBtcOracleStrategy',
    price: 0.62, sizeUsd: 2, expectedEdge: 0.1, confidence: 0.72,
  };
  const base = { ...order };
  const events = [
    { type: 'coverage_sentinel', ts: now - 16 * 60_000 },
    { ...base, type: 'gabagool_oracle_signal_read', ts: now - 3_000 },
    { ...base, type: 'gabagool_oracle_signal_fresh', ts: now - 2_900 },
    { ...base, type: 'gabagool_oracle_signal_confirmed', ts: now - 2_800 },
    { ...base, type: 'gabagool_candidate_built', ts: now - 2_700 },
    { ...base, type: 'gabagool_sophie_evaluated', ts: now - 2_600 },
    { ...base, type: 'gabagool_sophie_admitted', ts: now - 2_500 },
    { ...base, type: 'gabagool_risk_evaluated', ts: now - 2_400 },
    { ...base, type: 'gabagool_risk_admitted', ts: now - 2_300 },
    { ...base, type: 'gabagool_placement_attempted', ts: now - 2_100 },
    order,
    { ...base, type: 'gabagool_fill', ts: now - 1_900 },
  ];
  const fills = [{
    ts: now - 1_900, tokenId, marketId: 'market-5', marketSlug: base.marketSlug,
    outcome: 'Up', side: 'buy', strategy: base.strategy, price: 0.62, size: 2 / 0.62, value: 2,
    fillSource: 'crossed_bid_ask', trustedFill: true, trustedPnl: true, bookAgeMs: 100,
    bestBidAtPlacement: 0.61, bestAskAtPlacement: 0.62,
  }];
  writeJson(statePath, { executionEvents: events, fills, positions: {}, costBasis: {} });
  const log = `${new Date(now).toISOString()} [INFO] --- BTC ORACLE / GABAGOOL REPORT ---
Live Safety: ENABLE_LIVE_TRADING=false LIVE_AUTO_EXECUTE=false LIVE_KILL_SWITCH=true LIVE_DRY_RUN_ONLY=true LIVE_SUBMIT_CONFIRM=false
Confidence Floors: global=0.700 gabagoolPaper=0.470 gabagoolLive=0.700 activeMode=paper activeGabagoolMin=0.470
Signals 1h: read=20 fresh=20 expired=0 notConfirmed=0 confirmed=20 duplicateSkipped=0
Pipeline 1h: candidates=20 zeroSizeBlocked=0 sophieEval=20 sophieAdmit=20 sophieBlock=0 riskEval=20 riskAdmit=20 riskBlock=0 placementAttempt=20 placementBlock=0 orders=20 fills=20 exits=0
Exposure: position=$50.00 openOrders=$0.00 total=$50.00
Exposure Audit: riskExposureUsd=$0.00 portfolioExposureUsd=$50.00 capBlockingExposureUsd=$0.00 excludedDeadExposureUsd=$50.00
Exposure Buckets: activeTradable=$0.00 staleNoBid=$0.00 expiredBtc5m=$50.00 dust=$0.00 capBlocking=$0.00 excludedDead=$50.00
Fill Realism: trustedFills=20 untrustedFills=0 fillSourceCounts=crossed_bid_ask:20,resting_queue:0
${new Date(now - 1_950).toISOString()} [INFO] [AUTO-LIVE CANDIDATE SKIP] BUY token-...size reason=size_below_min_order [GabagoolBtcOracleStrategy]
`;
  for (const name of ['langomonEscript', 'langomon-dashboard', 'btcPolyOracle', 'liveIntentRouter', 'telegramApprovalBot']) {
    fs.writeFileSync(path.join(tempDir, `${name}-out.log`), name === 'langomonEscript' ? log : `${new Date(now).toISOString()} online\n`, 'utf8');
    fs.writeFileSync(path.join(tempDir, `${name}-error.log`), '', 'utf8');
  }
  const oraclePath = path.join(tempDir, 'external_signals.json');
  writeJson(oraclePath, { timestamp: new Date(now).toISOString(), expires_at: new Date(now + 15_000).toISOString(), direction: 'UP' });
  const supervisorPath = path.join(tempDir, 'supervisor.json');
  writeJson(supervisorPath, {
    lastRun: new Date(now - 10_000).toISOString(),
    flags: {
      ENABLE_LIVE_TRADING: { value: 'false' }, LIVE_AUTO_EXECUTE: { value: 'false' },
      LIVE_KILL_SWITCH: { value: 'true' }, LIVE_DRY_RUN_ONLY: { value: 'true' },
      LIVE_FINAL_BOSS_READY: { value: 'false' },
    },
    metrics: {
      liveTradingStage: 2, effectiveMaxLiveOrderUsd: 1, effectiveMaxLiveTotalExposureUsd: 1,
      effectiveLiveDailyMaxLossUsd: 1, effectiveMaxOrdersPerHour: 1, singleMarketId: null,
    },
  });
  writeNdjson(path.join(tempDir, 'live_intent_router_events.ndjson'), [{ timestamp: new Date(now - 1_000).toISOString(), type: 'LIVE_ROUTER_STARTED', mode: 'dry-run' }]);
  for (const filename of ['auto_live_candidates.ndjson', 'trade_intents.ndjson', 'live_adapter_events.ndjson', 'live_execution_events.ndjson', 'approval_decisions.ndjson', 'stage5_candidate_shadow.ndjson']) {
    writeNdjson(path.join(tempDir, filename), []);
  }
  return { statePath, oraclePath, supervisorPath };
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function run() {
  const safetyFields = {
    enableLiveTrading: { value: false }, liveAutoExecute: { value: false },
    liveKillSwitch: { value: true }, liveDryRunOnly: { value: true },
    liveSubmitConfirm: { value: false }, liveFinalBossReady: { value: false },
    liveStage: { value: 2 },
  };
  assert.strictEqual(monitor.classifySafety(safetyFields, false), 'SAFE_LOCKED_OFF');
  assert.strictEqual(monitor.classifySafety(safetyFields, true), 'SHADOW_OBSERVATION_ONLY');
  assert.strictEqual(monitor.classifySafety({
    ...safetyFields,
    enableLiveTrading: { value: true }, liveAutoExecute: { value: true },
    liveKillSwitch: { value: false }, liveDryRunOnly: { value: false },
    liveSubmitConfirm: { value: true }, liveFinalBossReady: { value: true },
    liveStage: { value: 5 },
  }, false), 'LIVE_ARMED');
  assert.strictEqual(monitor.classifySafety({ ...safetyFields, liveKillSwitch: { value: false } }, false), 'UNSAFE_CONFIGURATION');
  assert.strictEqual(monitor.sizingClassification(0.99, 2, 6, 5), 'STAGE5_CAP_BELOW_CLOB_MINIMUM');
  assert.strictEqual(monitor.classifyWriterBlocker('book_not_fresh', { bookComplete: false }), 'BOOK_INCOMPLETE');
  assert.strictEqual(monitor.classifyWriterBlocker('book_not_fresh', { bookComplete: true }), 'BOOK_STALE');

  const before = Object.fromEntries(PRODUCTION_FILES.map((filePath) => [filePath, checksum(filePath)]));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moneymaker-monitor-selfcheck-'));
  const now = Date.now();
  const fixture = makeFixture(tempDir, now);
  const fixtureStateBefore = checksum(fixture.statePath);
  const pm2Bin = makePm2Mock(tempDir);
  const outputDir = path.join(tempDir, 'runtime_monitor');
  const server = await startFixtureServer(fixture.statePath, now);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const report = await monitor.runOnce({
      now, outputDir, historyMaxBytes: 2_000, pm2Bin, logsDir: tempDir,
      dashboardUrl: `${baseUrl}/dashboard`, clobHealthUrl: `${baseUrl}/time`, rpcUrl: `${baseUrl}/rpc`,
      oraclePath: fixture.oraclePath, supervisorPath: fixture.supervisorPath, dataDir: tempDir,
      stateFile: fixture.statePath, networkTimeoutMs: 2_000,
    });
    assert.strictEqual(report.runtimeHealth.overall, 'HEALTHY');
    assert.strictEqual(report.safetyStatus.status, 'SAFE_LOCKED_OFF');
    assert.strictEqual(report.paperPipeline.hour1.ordersPlaced, 20);
    assert.strictEqual(report.paperPipeline.hour1.fills, 20);
    assert.strictEqual(report.paperPipeline.minutes15.coverageComplete, true);
    assert.strictEqual(report.exposure.actualTradablePaperExposureUsd, 0);
    assert.strictEqual(report.exposure.expiredBtcFiveMinutePaperExposureUsd, 50);
    assert.strictEqual(report.candidateStarvationDiagnostics.opportunityCount, 1);
    const opportunity = report.candidateStarvationDiagnostics.opportunities[0];
    assert.strictEqual(opportunity.hypotheticalStage5CandidateWriterBlocker, null);
    assert.strictEqual(opportunity.hypotheticalStage5Classification, 'ELIGIBLE');
    assert.strictEqual(opportunity.sizingClassification, 'PAPER_SIZE_BELOW_CLOB_MINIMUM_STAGE5_CAN_RESIZE');
    assert(Math.abs(opportunity.calculatedShares - 3.225806) < 0.000001);
    assert(Math.abs(opportunity.minimumViableUsd - 3.1) < 0.000001);
    assert.strictEqual(opportunity.exactCurrentCandidateWriterBlocker, 'size_below_min_order');
    assert.strictEqual(report.apiAndDataSourceHealth.clobPublicReachability.status, 'healthy');
    assert.strictEqual(report.apiAndDataSourceHealth.polygonRpcReachability.status, 'healthy');
    assert.strictEqual(report.apiAndDataSourceHealth.localDashboardHealth.status, 'healthy');
    assert.strictEqual(report.apiAndDataSourceHealth.oracleDataFreshness.status, 'healthy');
    assert(fs.existsSync(path.join(outputDir, 'latest.json')), 'latest.json must be written');
    assert(fs.existsSync(path.join(outputDir, 'history.ndjson')), 'history.ndjson must be written');
    assert.strictEqual(fs.readdirSync(outputDir).some((name) => name.endsWith('.tmp')), false, 'atomic temp must be cleaned');

    await monitor.runOnce({
      now: now + 1_000, outputDir, historyMaxBytes: 2_000, pm2Bin, logsDir: tempDir,
      dashboardUrl: `${baseUrl}/dashboard`, clobHealthUrl: `${baseUrl}/time`, rpcUrl: `${baseUrl}/rpc`,
      oraclePath: fixture.oraclePath, supervisorPath: fixture.supervisorPath, dataDir: tempDir,
      stateFile: fixture.statePath, networkTimeoutMs: 2_000,
    });
    assert(fs.existsSync(path.join(outputDir, 'history.ndjson.1')), 'bounded history must rotate');

    const watchOutput = path.join(tempDir, 'watch-output');
    const child = childProcess.spawn(process.execPath, [path.join(ROOT, 'scripts/moneymaker_local_monitor.js'), '--watch'], {
      cwd: ROOT,
      env: {
        ...process.env,
        MM_SKIP_LOCAL_ENV_FILE: 'true',
        MM_MONITOR_OUTPUT_DIR: watchOutput,
        MM_MONITOR_INTERVAL_MS: '100',
        MM_MONITOR_PM2_BIN: pm2Bin,
        MM_MONITOR_LOGS_DIR: tempDir,
        MM_MONITOR_DASHBOARD_URL: `${baseUrl}/dashboard`,
        MM_MONITOR_CLOB_HEALTH_URL: `${baseUrl}/time`,
        MM_MONITOR_RPC_URL: `${baseUrl}/rpc`,
        MM_MONITOR_ORACLE_PATH: fixture.oraclePath,
        MM_MONITOR_SUPERVISOR_PATH: fixture.supervisorPath,
        MM_MONITOR_DATA_DIR: tempDir,
        MM_MONITOR_STATE_FILE: fixture.statePath,
        MM_MONITOR_NETWORK_TIMEOUT_MS: '2000',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForFile(path.join(watchOutput, 'latest.json'));
    child.kill('SIGINT');
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('watch mode failed to stop after SIGINT')), 5_000);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.strictEqual(exit.code, 0, `watch mode should exit zero, got ${JSON.stringify(exit)}`);

    const after = Object.fromEntries(PRODUCTION_FILES.map((filePath) => [filePath, checksum(filePath)]));
    assert.deepStrictEqual(after, before, 'monitor must not modify production candidate/intent/router/adapter/execution files');
    assert.strictEqual(checksum(fixture.statePath), fixtureStateBefore, 'fixture state must remain unchanged');
    process.stdout.write('moneymaker local monitor selfcheck: ok\n');
  } finally {
    await closeServer(server);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
