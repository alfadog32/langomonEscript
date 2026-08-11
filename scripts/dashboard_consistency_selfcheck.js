#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const http = require('http');
const {
  collectStatus,
  buildLogResult,
  parseLatestPortfolioReport,
  renderHtml,
  createServer,
  collectStatusSafely,
  summarizeCandidateDiagnostics,
} = require('../dashboard_server');

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function stateFixture({ closedPnl = 87.74, exposure = 114 } = {}) {
  return {
    available: true,
    path: '/tmp/dashboard-fixture-state.json',
    message: 'fixture state loaded',
    data: {
      cash: 10,
      peakEquity: 124,
      closedPnl,
      positions: exposure > 0 ? { token: exposure } : {},
      costBasis: exposure > 0 ? { token: 1 } : {},
      ghostStats: { total: 0, favorable: 0 },
      fills: [],
      settlements: [],
      strategyPnl: {},
      executionEvents: [],
    },
    metadata: {
      rawValue: '/tmp/dashboard-fixture-state.json',
      resolvedPath: '/tmp/dashboard-fixture-state.json',
      exists: true,
      sizeBytes: 100,
      modifiedAt: iso(-30_000),
      warning: null,
    },
  };
}

function safeRuntimeSettings(overrides = {}) {
  return {
    pm2ProcessName: 'langomonEscript',
    pm2ProcessId: 7,
    runtime: {
      STATE_FILE: '/tmp/dashboard-fixture-state.json',
      ENABLE_LIVE_TRADING: 'false',
      LIVE_AUTO_EXECUTE: 'false',
      LIVE_KILL_SWITCH: 'true',
      LIVE_DRY_RUN_ONLY: 'true',
      LIVE_SUBMIT_CONFIRM: 'false',
      LIVE_FINAL_BOSS_READY: 'false',
      ...overrides,
    },
    envFile: {},
    mismatches: [],
  };
}

function pm2Fixture(uptimeOffsetMs = -2 * 60 * 60_000) {
  return {
    available: true,
    message: 'mock PM2 JSON',
    processes: [{
      name: 'langomonEscript',
      pmId: 7,
      status: 'online',
      uptime: iso(uptimeOffsetMs),
      rawPm2Env: {},
    }],
  };
}

function diagnosticFixture() {
  return {
    recentSuccessfulPaperPlacements: 1,
    stage5SizingEvaluatedPlacements: 1,
    stage5EligiblePlacements: 1,
    stage5IneligiblePlacements: 0,
    stage5SizingResizedPlacements: 1,
    stage5SizingBlockedPlacements: 0,
    dominantCandidateBlocker: null,
    latestCandidateSizingExample: { adjustedStage5SizeUsd: 3.7 },
    sourceMetadata: { source: '/tmp/fixture-diagnostics.ndjson', parserStatus: 'ok', freshness: 'fresh' },
  };
}

function statusFrom(lines, overrides = {}) {
  return collectStatus({
    nowMs: NOW,
    pm2: overrides.pm2 || pm2Fixture(),
    settings: overrides.settings || safeRuntimeSettings(),
    logs: buildLogResult('fixture', 'fixture logs', lines.join('\n')),
    state: overrides.state || stateFixture(),
    candidateDiagnostics: diagnosticFixture(),
  });
}

function completeReport(timestamp = iso(-30_000)) {
  return [
    `${timestamp} [INFO] --- PORTFOLIO REPORT ---`,
    `${timestamp} [INFO] Equity: $108.00 | Cash: $98.00 | Drawdown: 0.00%`,
    `${timestamp} [INFO] Open Orders: 0 | Exposure: $10.00 | Closed PnL: $2.00`,
    `${timestamp} [INFO] Position Exposure: $10.00 | Open Order Exposure: $0.00 | Available Cash: $98.00`,
    `${timestamp} [INFO] Execution Health: paperOrdersPlacedLastHour=1 paperOrdersFilledLastHour=1`,
    `${timestamp} [INFO] PnL Trust: trustedClosedPnl=$1.50 untrustedClosedPnl=$0.50 trustedOpenPnl=$0.00 untrustedOpenPnl=$0.00`,
    `${timestamp} [INFO] Exposure Split: portfolioExposure=$10.00 capBlockingExposure=$8.00 activeTradableExposure=$6.00 staleNoBidExposure=$1.00 confirmedNoOrderbook404Exposure=$1.00 expiredBtc5mExposure=$1.00 resolutionPendingExposure=$1.00 dustExposure=$1.00 excludedDeadExposure=$2.00 excludedDeadExposureReasons=confirmed_no_orderbook_404:1.00,expired_btc_5m_window:1.00`,
    `${timestamp} [INFO] Strategy Orders 1h: GabagoolBtcOracleStrategy:1`,
    `${timestamp} [INFO] PnL By Strategy: GabagoolBtcOracleStrategy:closed=$1.50 open=$0.00 net=$1.50 | SpreadHunter:closed=$0.50 open=$0.00 net=$0.50`,
  ];
}

function request(server, requestPath) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: address.port, path: requestPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        contentType: res.headers['content-type'],
        contentLength: res.headers['content-length'],
        body,
      }));
    });
    req.on('error', reject);
  });
}

async function main() {
  const contradictionLines = [
    `${iso(-120_000)} [INFO] --- PORTFOLIO REPORT ---`,
    `${iso(-120_000)} [INFO] Equity: $124.00 | Cash: $10.00 | Drawdown: 0.00%`,
    `${iso(-120_000)} [INFO] Open Orders: 0 | Exposure: $114.00 | Closed PnL: $87.74`,
    `${iso(-120_000)} [INFO] Position Exposure: $114.00 | Open Order Exposure: $0.00 | Available Cash: $10.00`,
    `${iso(-120_000)} [INFO] Execution Health: paperOrdersPlacedLastHour=0 paperOrdersFilledLastHour=0`,
    `${iso(-90_000)} [INFO] [ORDER] BUY token @ 0.740 size=$2.00 [GabagoolBtcOracleStrategy]`,
    `${iso(-60_000)} [INFO] [FILL] SELL token @ 0.850 usd=$2.30 [GabagoolBtcOracleStrategy]`,
  ];
  const contradiction = statusFrom(contradictionLines);
  assert(contradiction.portfolio.consistencyWarnings.includes('ORDER_COUNTER_CONTRADICTS_WALL_CLOCK_LOGS'));
  assert(contradiction.portfolio.consistencyWarnings.includes('FILL_COUNTER_CONTRADICTS_WALL_CLOCK_LOGS'));
  assert.strictEqual(contradiction.portfolio.wallClockLogOrdersLastHour, 1);
  assert.strictEqual(contradiction.portfolio.wallClockLogFillsLastHour, 1);
  assert.strictEqual(contradiction.portfolio.exposureBucketsComplete, false);
  assert.strictEqual(contradiction.portfolio.unreconciledExposureUsd, null);
  assert(contradiction.portfolio.consistencyWarnings.includes('EXPOSURE_BUCKETS_INCOMPLETE'));
  assert.strictEqual(contradiction.portfolio.historicalStateFilePnl, 87.74);
  assert.strictEqual(contradiction.portfolio.trustedPnl, null);
  assert(contradiction.portfolio.consistencyWarnings.includes('PNL_BREAKDOWN_INCOMPLETE'));

  const missingCounters = statusFrom([
    `${iso(-120_000)} [INFO] --- PORTFOLIO REPORT ---`,
    `${iso(-90_000)} [INFO] [ORDER] BUY token @ 0.740 size=$2.00 [GabagoolBtcOracleStrategy]`,
    `${iso(-60_000)} [INFO] [FILL] BUY token @ 0.740 usd=$2.00 [GabagoolBtcOracleStrategy]`,
  ]);
  assert.strictEqual(missingCounters.portfolio.paperOrdersPlacedLastHour, null);
  assert(missingCounters.portfolio.consistencyWarnings.includes('ORDER_SUMMARY_MISSING_WITH_WALL_CLOCK_LOG_ACTIVITY'));

  const restarted = statusFrom(completeReport(), { pm2: pm2Fixture(-10 * 60_000) });
  assert.strictEqual(restarted.portfolio.processUptimeLessThanRequestedWindow, true);
  assert(!restarted.portfolio.consistencyWarnings.includes('PROCESS_UPTIME_SHORTER_THAN_ONE_HOUR_WINDOW'));
  assert.strictEqual(restarted.dataStatus, 'CONSISTENT', 'short process uptime is informational when the available counters reconcile');

  const missingSafetySettings = safeRuntimeSettings();
  delete missingSafetySettings.runtime.LIVE_FINAL_BOSS_READY;
  const unknownSafety = statusFrom(completeReport(), { settings: missingSafetySettings });
  assert.strictEqual(unknownSafety.liveSafetyProfile.status, 'UNKNOWN_SAFETY_STATUS');

  const stale = statusFrom(completeReport(iso(-10 * 60_000)));
  assert.strictEqual(stale.portfolio.sourceMetadata.selectedPortfolioReport.freshness, 'stale');
  assert(stale.portfolio.consistencyWarnings.includes('PORTFOLIO_REPORT_STALE'));

  const fresh = statusFrom(completeReport(), { state: stateFixture({ closedPnl: 2, exposure: 10 }) });
  assert.strictEqual(fresh.portfolio.exposureBucketsComplete, true);
  assert(Math.abs(fresh.portfolio.unreconciledExposureUsd) < 0.000001);
  assert(Math.abs(fresh.portfolio.unreconciledPnl) < 0.000001);
  assert.strictEqual(fresh.liveSafetyProfile.status, 'LIVE_LOCKED_OFF');
  assert.strictEqual(fresh.portfolio.dataStatus, 'CONSISTENT');
  assert(fresh.dataTimestamp);
  assert(fresh.selectedPortfolioReportBoundary.lineCount > 0);
  assert.strictEqual(fresh.portfolio.classifiedExposureUsd, 10);
  assert.strictEqual(fresh.portfolio.otherClassifiedExposureUsd, 1);
  assert.strictEqual(fresh.portfolio.excludedDeadExposureIncludedInReconciliation, false);
  assert.strictEqual(fresh.portfolio.dustExposureIncludedInReconciliation, false);
  assert.strictEqual(fresh.portfolio.unreconciledPnl, 0);

  const cleanNoFill = statusFrom([
    `${iso(-30_000)} [INFO] --- PORTFOLIO REPORT ---`,
    `${iso(-30_000)} [INFO] Equity: $91.00 | Cash: $91.00 | Drawdown: 0.00%`,
    `${iso(-30_000)} [INFO] Open Orders: 0 | Exposure: $0.00 | Closed PnL: $0.00`,
    `${iso(-30_000)} [INFO] Position Exposure: $0.00 | Open Order Exposure: $0.00 | Available Cash: $91.00`,
    `${iso(-30_000)} [INFO] Execution Health: paperOrdersPlacedLastHour=0 paperOrdersFilledLastHour=0`,
    `${iso(-30_000)} [INFO] PnL Trust: trustedClosedPnl=$0.00 untrustedClosedPnl=$0.00 trustedOpenPnl=$0.00 untrustedOpenPnl=$0.00`,
    `${iso(-30_000)} [INFO] Exposure Split: portfolioExposure=$0.00 capBlockingExposure=$0.00 activeTradableExposure=$0.00 staleNoBidExposure=$0.00 confirmedNoOrderbook404Exposure=$0.00 expiredBtc5mExposure=$0.00 resolutionPendingExposure=$0.00 dustExposure=$0.00 excludedDeadExposure=$0.00 excludedDeadExposureReasons=none`,
    `${iso(-30_000)} [INFO] PnL By Strategy: none`,
    `${iso(-30_000)} [INFO] Gabagool Pre-Candidate Blocks: dominant=lag_score_not_confirmed notConfirmedReasons=lag_score_not_confirmed:61`,
  ], { state: stateFixture({ closedPnl: 0, exposure: 0 }) });
  assert.strictEqual(cleanNoFill.portfolio.retainedFillHistoryClosedPnl, 0, 'explicit empty retained fill history is authoritative zero');
  assert.strictEqual(cleanNoFill.portfolio.legacyOrUnattributedHistoricalPnl, 0, 'zero total less zero retained PnL proves zero legacy PnL');
  assert.strictEqual(cleanNoFill.portfolio.dataStatus, 'CONSISTENT');
  assert(!cleanNoFill.portfolio.consistencyWarnings.includes('PNL_BREAKDOWN_INCOMPLETE'));
  assert.strictEqual(cleanNoFill.portfolio.dominantOracleNotConfirmedReasonLastHour, 'lag_score_not_confirmed');
  assert.strictEqual(cleanNoFill.portfolio.oracleNotConfirmedReasonsLastHour, 'lag_score_not_confirmed:61');

  const productionAccounting = statusFrom([
    `${iso(-30_000)} [INFO] --- PORTFOLIO REPORT ---`,
    `${iso(-30_000)} [INFO] Equity: $196.67 | Cash: $60.67 | Drawdown: 0.00%`,
    `${iso(-30_000)} [INFO] Open Orders: 0 | Exposure: $136.00 | Closed PnL: $105.67`,
    `${iso(-30_000)} [INFO] Position Exposure: $136.00 | Open Order Exposure: $0.00 | Available Cash: $60.67`,
    `${iso(-30_000)} [INFO] Execution Health: paperOrdersPlacedLastHour=0 paperOrdersFilledLastHour=0`,
    `${iso(-30_000)} [INFO] PnL Trust: trustedClosedPnl=$61.85 untrustedClosedPnl=$0.00 trustedOpenPnl=$0.00 untrustedOpenPnl=$0.00`,
    `${iso(-30_000)} [INFO] Exposure Split: portfolioExposure=$136.00 capBlockingExposure=$64.00 activeTradableExposure=$64.00 staleNoBidExposure=$0.00 confirmedNoOrderbook404Exposure=$0.00 expiredBtc5mExposure=$72.00 resolutionPendingExposure=$0.00 dustExposure=$0.00 excludedDeadExposure=$72.00 excludedDeadExposureReasons=expired_btc_5m_window:72.00`,
    `${iso(-30_000)} [INFO] PnL By Strategy: GabagoolBtcOracleStrategy:closed=$61.85 open=$0.00 net=$61.85`,
  ], { state: stateFixture({ closedPnl: 105.67, exposure: 136 }) });
  assert.strictEqual(productionAccounting.portfolio.classifiedExposureUsd, 136);
  assert.strictEqual(productionAccounting.portfolio.unreconciledExposureUsd, 0);
  assert.strictEqual(productionAccounting.portfolio.legacyOrUnattributedHistoricalPnl, 43.82);
  assert.strictEqual(productionAccounting.portfolio.unreconciledPnl, 0);
  assert.strictEqual(productionAccounting.portfolio.dataStatus, 'CONSISTENT');
  assert(!productionAccounting.portfolio.consistencyWarnings.includes('EXPOSURE_UNRECONCILED'));
  assert(!productionAccounting.portfolio.consistencyWarnings.includes('PNL_CLASSIFICATION_UNRECONCILED'));
  assert(productionAccounting.availabilityNotices.includes('LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE'));
  assert(!productionAccounting.availabilityWarnings.includes('LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE'));
  const productionHtml = renderHtml(productionAccounting);
  assert(productionHtml.includes('<h2>Status Notices</h2>'));
  assert(productionHtml.includes('verified resolved/dead exposure'));
  assert(!productionHtml.includes('Bot will self-clear'));
  assert(productionHtml.includes('Required In Current Mode'));
  assert(!productionHtml.includes('Snapshot Timestamp'));
  assert(productionHtml.includes('Suggested Fresh State'));
  assert(productionHtml.includes('not required'));

  const retainedTrustBoundary = statusFrom([
    `${iso(-30_000)} [INFO] --- PORTFOLIO REPORT ---`,
    `${iso(-30_000)} [INFO] Equity: $88.54 | Cash: $88.54 | Drawdown: 2.96%`,
    `${iso(-30_000)} [INFO] Open Orders: 0 | Exposure: $0.00 | Closed PnL: $-2.46`,
    `${iso(-30_000)} [INFO] Position Exposure: $0.00 | Open Order Exposure: $0.00 | Available Cash: $88.54`,
    `${iso(-30_000)} [INFO] Execution Health: paperOrdersPlacedLastHour=22 paperOrdersFilledLastHour=4`,
    `${iso(-30_000)} [INFO] PnL Trust: trustedClosedPnl=$-0.70 untrustedClosedPnl=$0.00 trustedOpenPnl=$0.00 untrustedOpenPnl=$0.00`,
    `${iso(-30_000)} [INFO] Exposure Split: portfolioExposure=$0.00 capBlockingExposure=$0.00 activeTradableExposure=$0.00 staleNoBidExposure=$0.00 confirmedNoOrderbook404Exposure=$0.00 expiredBtc5mExposure=$0.00 resolutionPendingExposure=$0.00 dustExposure=$0.00 excludedDeadExposure=$0.00 excludedDeadExposureReasons=none`,
    `${iso(-30_000)} [INFO] PnL By Strategy scope=durable: SpreadHunter:closed=$-0.08 open=$0.00 net=$-0.08 | InventoryExit:closed=$0.01 open=$0.00 net=$0.01 | StopLossExit:closed=$-2.79 open=$0.00 net=$-2.79 | TakeProfitExit:closed=$0.40 open=$0.00 net=$0.40`,
  ], { state: stateFixture({ closedPnl: -2.46, exposure: 0 }) });
  assert.strictEqual(retainedTrustBoundary.portfolio.unreconciledPnl, 0, 'durable strategy totals must reconcile against total closed PnL');
  assert.strictEqual(retainedTrustBoundary.portfolio.retainedFillHistoryClosedPnl, -0.7, 'retained trust history must remain separately visible');
  assert.strictEqual(retainedTrustBoundary.portfolio.retainedTrustCoverageGapPnl, -1.76, 'bounded trust history gap must remain explicit');
  assert(!retainedTrustBoundary.portfolio.consistencyWarnings.includes('PNL_CLASSIFICATION_UNRECONCILED'), 'normal retained-history boundaries must not create a false classification defect');

  const stage5Meaning = summarizeCandidateDiagnostics([
    {
      timestamp: iso(-20_000),
      source: 'gabagool_successful_paper_placement',
      paperPlacementSucceeded: true,
      stage5SizingEvaluated: true,
      wasResized: true,
      finalEligibility: false,
      stage5EligibilityBlocker: 'confidence_below_min',
      candidateWriterBlocker: 'confidence_below_min',
      adjustedStage5SizeUsd: 3.7,
    },
    {
      timestamp: iso(-10_000),
      source: 'stage5_shadow_opportunity',
      finalEligibility: true,
    },
  ], NOW, '/tmp/stage5-meaning.ndjson');
  assert.strictEqual(stage5Meaning.recentSuccessfulPaperPlacements, 1, 'shadow records must not inflate successful paper placements');
  assert.strictEqual(stage5Meaning.stage5SizingEvaluatedPlacements, 1);
  assert.strictEqual(stage5Meaning.stage5SizingResizedPlacements, 1);
  assert.strictEqual(stage5Meaning.stage5EligiblePlacements, 0, 'successful paper placement may remain live-canary ineligible');
  assert.strictEqual(stage5Meaning.stage5IneligiblePlacements, 1);
  assert.strictEqual(stage5Meaning.dominantCandidateBlocker, 'confidence_below_min');
  const stage5MeaningStatus = statusFrom(completeReport(), {
    state: stateFixture({ closedPnl: 2, exposure: 10 }),
  });
  Object.assign(stage5MeaningStatus.portfolio, stage5Meaning);
  const stage5MeaningHtml = renderHtml(stage5MeaningStatus);
  assert(stage5MeaningHtml.includes('Paper placement and Stage 5 live-canary eligibility are separate results'));
  assert(stage5MeaningHtml.includes('Stage 5 Live Sizing Evaluated'));
  assert(stage5MeaningHtml.includes('Stage 5 Live-Canary Ineligible'));
  assert(stage5MeaningHtml.includes('confidence_below_min'));

  const parsedMissing = parseLatestPortfolioReport(contradictionLines, NOW);
  assert.strictEqual(parsedMissing.trustedClosedPnl, null);
  assert.notStrictEqual(parsedMissing.trustedClosedPnl, 0);
  assert(renderHtml(contradiction).includes('unknown'));

  const boundedByFile = parseLatestPortfolioReport([
    ...completeReport(),
    '[DASHBOARD LOG FILE BOUNDARY] /tmp/unrelated-process.log',
    ...Array.from({ length: 1_000 }, (_, index) => `${iso(-20_000)} unrelated process line ${index}`),
  ], NOW);
  assert.strictEqual(boundedByFile.lines.length, completeReport().length);
  assert.strictEqual(boundedByFile.boundary.terminatedByLogFileBoundary, true);
  assert.strictEqual(boundedByFile.boundary.truncatedByLineLimit, false);

  const boundedByDuration = parseLatestPortfolioReport([
    ...completeReport(),
    ...Array.from({ length: 1_000 }, (_, index) => `${iso(-20_000)} engine noise line ${index}`),
  ], NOW);
  assert.strictEqual(boundedByDuration.lines.length, completeReport().length);
  assert.strictEqual(boundedByDuration.boundary.terminatedByDurationWindow, true);
  assert.strictEqual(boundedByDuration.boundary.truncatedByLineLimit, false);

  const boundedByLimit = parseLatestPortfolioReport([
    ...completeReport(),
    ...Array.from({ length: 1_000 }, (_, index) => `engine noise without timestamp ${index}`),
  ], NOW);
  assert.strictEqual(boundedByLimit.lines.length, 300);
  assert.strictEqual(boundedByLimit.boundary.truncatedByLineLimit, true);

  const condensedReportStatus = statusFrom([
    ...completeReport(),
    `${iso(-30_000)} [INFO] [GABAGOOL PAPER EXPIRED EXPOSURE EXCLUDED] token=redacted valueUsd=$2.00`,
    `${iso(-30_000)} [INFO] POS redacted qty=1 value=$2.00`,
  ], { state: stateFixture({ closedPnl: 2, exposure: 10 }) });
  const condensedReportHtml = renderHtml(condensedReportStatus);
  assert(!condensedReportHtml.includes('token=redacted'));
  assert(!condensedReportHtml.includes('POS redacted'));
  assert(condensedReportHtml.includes('dashboard condensed 1 repetitive expired-exposure detail line(s) and 1 per-position detail line(s)'));

  const noCandidateDiagnostics = statusFrom(completeReport());
  noCandidateDiagnostics.candidateDiagnostics = { sourceMetadata: { parserStatus: 'unavailable' } };
  noCandidateDiagnostics.portfolio.recentSuccessfulPaperPlacements = null;
  noCandidateDiagnostics.portfolio.stage5EligiblePlacements = null;
  noCandidateDiagnostics.portfolio.stage5SizingResizedPlacements = null;
  noCandidateDiagnostics.portfolio.stage5SizingBlockedPlacements = null;
  noCandidateDiagnostics.portfolio.dominantCandidateBlocker = null;
  noCandidateDiagnostics.portfolio.latestCandidateSizingExample = null;
  const noCandidateHtml = renderHtml(noCandidateDiagnostics);
  assert(noCandidateHtml.includes('Candidate diagnostics were not reported'));
  assert(!noCandidateHtml.includes('Dominant Candidate Blocker'));

  const legacyBlockerShape = statusFrom(completeReport());
  legacyBlockerShape.liveAccountTruth = {
    available: true,
    reconciliation: { blockers: 'LEGACY_BLOCKER_STRING' },
    readiness: { blockers: { code: 'LEGACY_BLOCKER_OBJECT' } },
  };
  const defensiveHtml = renderHtml(legacyBlockerShape);
  assert(defensiveHtml.startsWith('<!doctype html>'));
  assert(defensiveHtml.includes('LEGACY_BLOCKER_STRING'));
  assert(defensiveHtml.includes('INFORMATIONAL'));

  const capturedErrors = [];
  const originalConsoleError = console.error;
  console.error = (message) => capturedErrors.push(String(message));
  let unavailable;
  try {
    unavailable = collectStatusSafely({
      requestPath: '/fixture-status',
      collectOptions: { pm2: { available: true, processes: 'malformed-process-list' } },
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.strictEqual(unavailable.ok, false);
  assert.strictEqual(unavailable.dataStatus, 'UNAVAILABLE');
  assert(renderHtml(unavailable).includes('DASHBOARD_STATUS_COLLECTION_UNAVAILABLE'));
  assert(capturedErrors.some((line) => line.includes('[DASHBOARD REQUEST ERROR]')));

  const server = createServer({ statusProvider: () => legacyBlockerShape, accessLog: false });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const health = await request(server, '/health');
    const api = await request(server, '/api/status');
    const html = await request(server, '/');
    assert.strictEqual(health.statusCode, 200);
    assert.strictEqual(api.statusCode, 200);
    assert.strictEqual(html.statusCode, 200);
    assert(String(health.contentType).startsWith('application/json'));
    assert(String(api.contentType).startsWith('application/json'));
    assert(String(html.contentType).startsWith('text/html'));
    assert(html.body.startsWith('<!doctype html>'));
    assert(!html.body.includes('server error'));
    assert.strictEqual(Number(html.contentLength), Buffer.byteLength(html.body));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  process.stdout.write('dashboard consistency selfcheck: ok\n');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
