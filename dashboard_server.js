'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const crypto = require('crypto');
const { DEFAULT_SNAPSHOT_TTL_MS, validateCachedSnapshot } = require('./lib/polymarket_live_account_truth');
const { SCOPE: SINGLE_CANARY_SCOPE, evaluateSingleCanaryBaseline } = require('./lib/stage5_canary_session');
const { resolveStage5GabagoolConfidenceFloor } = require('./lib/stage5_policy');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const TOKEN_FILE = path.join(ROOT, '.dashboard_token');
const STATE_FILE_DEFAULT = path.join(ROOT, 'moneymaker_v3_state.json');
const LOG_FILE_BOUNDARY_PREFIX = '[DASHBOARD LOG FILE BOUNDARY] ';
const MAX_PORTFOLIO_REPORT_LINES = 300;
const MAX_PORTFOLIO_REPORT_DURATION_MS = 1_000;
const IMPORTANT_LOG_PATTERNS = [
  '[ORDER]',
  '[STANDARD ORDER]',
  '[STANDARD FILL]',
  '[STANDARD BLOCK]',
  '[STANDARD CANDIDATE]',
  '[STANDARD CHURN GUARD]',
  '[ORDER SKIP DUPLICATE]',
  '[SIGNAL BLOCK]',
  '[CONSENSUS BLOCK]',
  '[MIXED MODE REPORT]',
  '[MIXED MODE PACE]',
  '[BTC BUCKET FULL]',
  '[GHOST THROTTLE]',
  '[DUST EXIT]',
  '[DUST EXIT BLOCK]',
  '[ENGINE STARVATION WARNING]',
  '[TELEGRAM DIGEST]',
  '[FILL]',
  '[RESEARCH REFRESH]',
];
const SENSITIVE_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PRIVATE|MNEMONIC)/i;
const SETTING_KEYS = [
  'STATE_FILE',
  'INITIAL_CASH',
  'PAPER_DEAD_EXPOSURE_CASH_RELEASE_ENABLED',
  'PAPER_DEAD_EXPOSURE_CASH_RELEASE_BATCH_USD',
  'PAPER_DEAD_EXPOSURE_CASH_RELEASE_TRIGGER_USD',
  'BASE_ORDER_USD',
  'MIN_ORDER_USD',
  'MIN_CONFIDENCE',
  'SPREADHUNTER_MIN_CONFIDENCE_PAPER',
  'STANDARD_PAPER_MIN_CONFIDENCE',
  'STANDARD_CHURN_COOLDOWN_SEC',
  'STANDARD_CHURN_MIN_EDGE_IMPROVEMENT',
  'PAPER_CONFIDENCE_PROFILE',
  'PAPER_REALISTIC_FILLS',
  'PAPER_FILL_MIN_DELAY_MS',
  'PAPER_FILL_MAX_BOOK_AGE_MS',
  'PAPER_QUEUE_HAIRCUT_PCT',
  'MIN_SIGNAL_EDGE',
  'STANDARD_MIN_SIGNAL_EDGE',
  'MAX_TOTAL_EXPOSURE_USD',
  'BTC_EXPOSURE_BUCKET_SHARE',
  'STANDARD_EXPOSURE_BUCKET_SHARE',
  'MAX_TOTAL_OPEN_ORDER_USD',
  'MAX_POSITION_USD',
  'MAX_MARKET_EXPOSURE_USD',
  'MAX_DRAWDOWN_PCT',
  'REDUCE_ONLY_MIN_EXIT_USD',
  'SPREAD_HUNTER_GHOST_GATE_ENABLED',
  'SPREAD_HUNTER_MIN_GHOST_FAVORABLE_PCT',
  'SPREAD_HUNTER_GHOST_SIZE_MULTIPLIER',
  'ENABLE_GABAGOOL_BTC_IMITATION',
  'GABAGOOL_MAX_PAPER_ORDER_USD',
  'GABAGOOL_MAX_PAPER_DRAWDOWN_PCT',
  'GABAGOOL_MAX_PAPER_CLOSED_LOSS_USD',
  'GABAGOOL_PAUSE_ENTRIES_ON_LOSS',
  'GABAGOOL_MAX_ROUND_TRIPS_PER_TOKEN_PER_MARKET',
  'GABAGOOL_REENTER_COOLDOWN_MS',
  'GABAGOOL_MIN_DUST_EXIT_USD',
  'GABAGOOL_MAX_ENTRY_PRICE',
  'GABAGOOL_ALLOW_HIGH_PRICE_ENTRY_EDGE',
  'AUTO_LIVE_CANDIDATES_ENABLED',
  'ENABLE_LIVE_TRADING',
  'LIVE_AUTO_EXECUTE',
  'LIVE_KILL_SWITCH',
  'LIVE_DRY_RUN_ONLY',
  'LIVE_SUBMIT_CONFIRM',
  'LIVE_FINAL_BOSS_READY',
  'STAGE5_PAPER_CANDIDATE_DIAGNOSTICS_PATH',
  'LIVE_ACCOUNT_TRUTH_SNAPSHOT_PATH',
  'LIVE_ACCOUNT_TRUTH_TTL_MS',
  'PAPER_TELEGRAM_DIGEST_ENABLED',
  'PAPER_TELEGRAM_DIGEST_EVERY_MS',
  'TELEGRAM_APPROVAL_WATCH_PATHS',
  'DASHBOARD_ENABLED',
  'DASHBOARD_HOST',
  'DASHBOARD_PORT',
  'DASHBOARD_PUBLIC_URL',
];

const fileEnv = localEnvFileReadEnabled() ? parseEnvFile(ENV_FILE) : {};
const host = envStr('DASHBOARD_HOST', '127.0.0.1');
const port = envInt('DASHBOARD_PORT', 18888);
const dashboardEnabled = envStr('DASHBOARD_ENABLED', 'false').toLowerCase() === 'true';
const dashboardToken = resolveDashboardToken(host);
const tokenRequired = host === '0.0.0.0' || dashboardToken.length > 0;
const publicUrl = normalizePublicUrl(envStr('DASHBOARD_PUBLIC_URL', defaultPublicUrl(host, port)));

function createServer(options = {}) {
  return http.createServer((req, res) => {
    const startedAt = Date.now();
    if (options.accessLog !== false) {
      res.once('finish', () => logDashboardAccess(req, res, Date.now() - startedAt));
    }
    try {
      routeRequest(req, res, options);
    } catch (err) {
      logDashboardError(err, req);
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: 'dashboard_error',
          message: 'Dashboard status is temporarily unavailable.',
        });
      } else {
        res.destroy();
      }
    }
  });
}

function localEnvFileReadEnabled() {
  const raw = String(
    process.env.MM_SKIP_LOCAL_ENV_FILE ||
    process.env.SKIP_LOCAL_ENV_FILE ||
    ''
  ).trim().toLowerCase();
  return !['1', 'true', 'yes', 'on'].includes(raw);
}

function startServer() {
  if (!dashboardEnabled) {
    console.error('Dashboard refused to start: DASHBOARD_ENABLED must be true.');
    process.exit(1);
  }
  const server = createServer();
  server.listen(port, host, () => {
    const authStatus = tokenRequired ? 'required; token omitted from logs' : 'disabled';
    console.log(`Dashboard listening: ${publicUrl}/ (authentication ${authStatus})`);
  });
  return server;
}

function routeRequest(req, res, options = {}) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const getStatus = () => typeof options.statusProvider === 'function'
    ? options.statusProvider()
    : collectStatusSafely({ requestPath: url.pathname });

  if (!isAuthorized(url)) {
    sendText(res, 401, 'Unauthorized\n', 'text/plain; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, renderHtml(getStatus()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, getStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const status = getStatus();
    const truth = status.liveAccountTruth?.reconciliation || {};
    const liveAccountTruthComplete = truth.identityBoundExternalReconciliation === true && truth.fresh === true && truth.exposureReconciled === true && truth.dailyPnlReconciled === true && truth.orderCountReconciled === true;
    const liveAccountTruthRequired = status.liveSafetyProfile.status !== 'LIVE_LOCKED_OFF';
    sendJson(res, 200, {
      ok: status.ok === true && status.dataStatus === 'CONSISTENT' && status.liveSafetyProfile.status === 'LIVE_LOCKED_OFF' && (!liveAccountTruthRequired || liveAccountTruthComplete),
      serverOk: status.ok,
      generatedAt: status.generatedAt,
      dataTimestamp: status.dataTimestamp,
      dataStatus: status.dataStatus,
      liveSafetyStatus: status.liveSafetyProfile.status,
      liveAccountTruthComplete,
      liveAccountTruthRequired,
      liveAccountTruthBlockers: toTextList(truth.blockers, ['LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE']),
      warnings: [
        ...toTextList(status.portfolio?.consistencyWarnings),
        ...toTextList(status.availabilityWarnings),
      ],
      notices: toTextList(status.availabilityNotices),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logs') {
    const status = getStatus();
    sendText(res, 200, status.logs.importantLines.join('\n') + '\n', 'text/plain; charset=utf-8');
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
}

function isAuthorized(url) {
  if (!tokenRequired) return true;
  return url.searchParams.get('token') === dashboardToken;
}

function collectStatusSafely(options = {}) {
  try {
    return collectStatus(options.collectOptions || {});
  } catch (error) {
    logDashboardError(error, { method: 'GET', url: options.requestPath || '/status' });
    return unavailableStatus();
  }
}

function collectStatus(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const pm2 = options.pm2 || getPm2Status();
  const settings = options.settings || buildSettingsStatus(pm2);
  const logs = options.logs || getLogs(pm2);
  const state = options.state || readState(settings.runtime.STATE_FILE || settings.envFile.STATE_FILE || '');
  const report = parseLatestPortfolioReport(logs.allLines, nowMs);
  const stateFileAnalysis = analyzeStateFileUsage(state, settings, report);
  const engineProc = findProcess(pm2.processes || [], 'langomonEscript');
  const orderFillWindows = summarizeOrderFillWindows(logs.allLines, report, engineProc, nowMs, 60 * 60_000, logs);
  const liveSafetyProfile = buildRuntimeSafetyProfile(settings, engineProc, nowMs);
  const candidateDiagnostics = options.candidateDiagnostics || readCandidateDiagnostics(
    settings.runtime.STAGE5_PAPER_CANDIDATE_DIAGNOSTICS_PATH ||
    settings.envFile.STAGE5_PAPER_CANDIDATE_DIAGNOSTICS_PATH ||
    './runtime_monitor/stage5_paper_candidate_diagnostics.ndjson',
    nowMs
  );
  const liveAccountTruth = options.liveAccountTruth || readLiveAccountTruthSnapshot(
    settings.runtime.LIVE_ACCOUNT_TRUTH_SNAPSHOT_PATH || settings.envFile.LIVE_ACCOUNT_TRUTH_SNAPSHOT_PATH || './runtime_monitor/polymarket_live_account_truth.json',
    nowMs,
    Number(settings.runtime.LIVE_ACCOUNT_TRUTH_TTL_MS || settings.envFile.LIVE_ACCOUNT_TRUTH_TTL_MS || DEFAULT_SNAPSHOT_TTL_MS)
  );
  const portfolio = buildPortfolioSummary(state, report, stateFileAnalysis, {
    orderFillWindows,
    liveSafetyProfile,
    candidateDiagnostics,
    liveAccountTruth,
  });
  const publicPm2 = {
    ...pm2,
    processes: (pm2.processes || []).map(({ rawPm2Env, ...proc }) => proc),
  };
  const availabilityWarnings = [];
  const availabilityNotices = [];
  if (!pm2.available) availabilityWarnings.push('PM2_STATUS_UNAVAILABLE');
  if (!state.available) availabilityWarnings.push('STATE_FILE_UNAVAILABLE');
  if (logs.source === 'unavailable') availabilityWarnings.push('LOG_DATA_UNAVAILABLE');
  if (!liveAccountTruth.available) {
    const issue = liveAccountTruth.error ? 'LIVE_ACCOUNT_SNAPSHOT_MALFORMED' : 'LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE';
    if (liveSafetyProfile.status === 'LIVE_LOCKED_OFF') availabilityNotices.push(issue);
    else availabilityWarnings.push(issue);
  }

  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    dataTimestamp: report.sourceTimestamp || state.metadata.modifiedAt || null,
    dataStatus: portfolio.dataStatus,
    server: {
      time: new Date().toString(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
    },
    git: getGitInfo(),
    pm2: publicPm2,
    stateFile: {
      ...state.metadata,
      analysis: stateFileAnalysis,
      warning: state.metadata.warning || stateFileAnalysis.summary || null,
    },
    portfolio,
    sourceMetadata: portfolio.sourceMetadata,
    liveSafetyProfile,
    stage5Policy: {
      gabagoolMinConfidence: resolveStage5GabagoolConfidenceFloor(),
      source: 'lib/stage5_policy.js',
    },
    liveAccountTruth,
    availabilityWarnings,
    availabilityNotices,
    orderFillWindows,
    candidateDiagnostics,
    selectedPortfolioReportBoundary: report.boundary,
    latestPortfolioReport: report.lines,
    settings,
    logs: {
      source: logs.source,
      message: logs.message,
      sourceFiles: logs.sourceFiles || [],
      importantLines: logs.importantLines.slice(-50),
    },
  };
}

function unavailableStatus(nowMs = Date.now()) {
  const warning = 'DASHBOARD_STATUS_COLLECTION_UNAVAILABLE';
  return {
    ok: false,
    generatedAt: new Date(nowMs).toISOString(),
    dataTimestamp: null,
    dataStatus: 'UNAVAILABLE',
    server: {
      time: new Date(nowMs).toString(),
      hostname: safeSystemValue(() => os.hostname()),
      platform: safeSystemValue(() => os.platform()),
      arch: safeSystemValue(() => os.arch()),
    },
    git: { branch: 'unknown', commit: 'unknown' },
    pm2: { available: false, message: 'PM2 status unavailable.', processes: [] },
    stateFile: {
      rawValue: '', resolvedPath: '', exists: false, sizeBytes: 0, modifiedAt: null,
      warning: 'State data unavailable while dashboard status was collected.',
    },
    portfolio: {
      dataStatus: 'UNAVAILABLE',
      consistencyWarnings: [warning],
      stateWarnings: [warning],
      stateMessage: 'Status data is unavailable; the dashboard remains online.',
    },
    sourceMetadata: { parserStatus: 'unavailable' },
    liveSafetyProfile: {
      status: 'UNKNOWN_SAFETY_STATUS', values: {}, missing: [], mismatches: [],
    },
    stage5Policy: {
      gabagoolMinConfidence: resolveStage5GabagoolConfidenceFloor(),
      source: 'lib/stage5_policy.js',
    },
    liveAccountTruth: {
      available: false,
      reconciliation: { fresh: false, blockers: ['LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE'] },
      readiness: { blockers: ['SINGLE_CANARY_READINESS_UNAVAILABLE'] },
    },
    orderFillWindows: {},
    candidateDiagnostics: {},
    selectedPortfolioReportBoundary: null,
    latestPortfolioReport: [],
    settings: {
      pm2ProcessName: 'langomonEscript', pm2ProcessId: null, runtime: {}, envFile: {}, mismatches: [],
    },
    logs: {
      source: 'unavailable', message: 'Log data unavailable.', sourceFiles: [], importantLines: [],
    },
    availabilityWarnings: [warning],
    availabilityNotices: [],
  };
}

function safeSystemValue(readValue) {
  try {
    return String(readValue());
  } catch {
    return 'unknown';
  }
}

function logDashboardError(error, req = {}) {
  const method = String(req.method || 'UNKNOWN').replace(/[^A-Z]/gi, '').slice(0, 12) || 'UNKNOWN';
  const pathname = requestPathname(req.url);
  const detail = redactSensitiveText(error?.stack || error?.message || String(error));
  console.error(`[DASHBOARD REQUEST ERROR] method=${method} path=${pathname}\n${detail}`);
}

function logDashboardAccess(req, res, durationMs) {
  const method = String(req.method || 'UNKNOWN').replace(/[^A-Z]/gi, '').slice(0, 12) || 'UNKNOWN';
  const pathname = requestPathname(req.url);
  const contentLength = res.getHeader('Content-Length');
  const bytes = Number.isFinite(Number(contentLength)) ? Number(contentLength) : 'unknown';
  console.log(`[DASHBOARD ACCESS] method=${method} path=${pathname} status=${res.statusCode} bytes=${bytes} durationMs=${durationMs}`);
}

function requestPathname(rawUrl) {
  try {
    return new URL(String(rawUrl || '/unknown'), 'http://localhost').pathname;
  } catch {
    return '/unknown';
  }
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PRIVATE|MNEMONIC)[A-Z0-9_]*)(\s*[:=]\s*)[^\s]+/gi, '$1$2[REDACTED]');
}

function analyzeStateFileUsage(state, settings, report) {
  const warnings = [];
  const failureReasons = [];
  const rawValue = String(state?.metadata?.rawValue || '');
  const declaredProfileUsd = extractStateFileProfileUsd(rawValue);
  // Resolve runtimeInitialCash with a fallback chain:
  //   1. PM2 runtime env  2. .env file  3. loaded CONFIG
  // numberOrNull('') returns 0 (Number('') === 0), which is a false positive
  // when PM2 env simply doesn't contain the key. Treat 0 as "not set" only
  // when the raw string was empty/missing — a real $0 INITIAL_CASH is nonsensical.
  const rawRuntimeIC = settings?.runtime?.INITIAL_CASH;
  const rawEnvFileIC = settings?.envFile?.INITIAL_CASH;
  const pm2IC = (rawRuntimeIC !== undefined && rawRuntimeIC !== null && rawRuntimeIC !== '')
    ? numberOrNull(rawRuntimeIC)
    : null;
  const envFileIC = (rawEnvFileIC !== undefined && rawEnvFileIC !== null && rawEnvFileIC !== '')
    ? numberOrNull(rawEnvFileIC)
    : null;
  const runtimeInitialCash = pm2IC !== null ? pm2IC : envFileIC;
  const stateStartingCash = numberOrNull(state?.data?.startingCash);
  const stateCash = numberOrNull(state?.data?.cash);
  const burnInState = state?.data?.burnInState && typeof state.data.burnInState === 'object'
    ? state.data.burnInState
    : null;
  const inferredBankrollUsd = firstFinite(stateStartingCash, runtimeInitialCash, stateCash, report?.equity);
  if (declaredProfileUsd != null && inferredBankrollUsd != null && Math.abs(declaredProfileUsd - inferredBankrollUsd) > 5) {
    const message = `state_profile_mismatch: filename suggests ~$${declaredProfileUsd.toFixed(0)} but state/runtime suggests ~$${inferredBankrollUsd.toFixed(2)}`;
    warnings.push(message);
    failureReasons.push(message);
  }
  if (
    stateStartingCash != null &&
    runtimeInitialCash != null &&
    Math.abs(stateStartingCash - runtimeInitialCash) > 5
  ) {
    const message = `state_profile_mismatch: STATE_FILE startingCash=$${stateStartingCash.toFixed(2)} runtime INITIAL_CASH=$${runtimeInitialCash.toFixed(2)}`;
    warnings.push(message);
    failureReasons.push(message);
  }
  if (
    burnInState &&
    Number.isFinite(Number(burnInState.intendedProfileUsd)) &&
    runtimeInitialCash != null &&
    Math.abs(Number(burnInState.intendedProfileUsd) - runtimeInitialCash) > 5
  ) {
    const message = `state_profile_mismatch: burnInState intendedProfileUsd=$${Number(burnInState.intendedProfileUsd).toFixed(2)} runtime INITIAL_CASH=$${runtimeInitialCash.toFixed(2)}`;
    warnings.push(message);
    failureReasons.push(message);
  }
  if (warnings.length > 0 && Number((state?.data?.executionEvents || []).length || 0) > 0) {
    warnings.push('possible_old_state_reuse_after_reset');
  }
  if (String(burnInState?.lifecycleStatus || '') === 'burn_in_failed_by_drawdown') {
    failureReasons.push('burn_in_failed_by_drawdown');
  }
  return {
    declaredProfileUsd,
    runtimeInitialCash,
    stateStartingCash,
    inferredBankrollUsd,
    burnInLifecycleStatus: String(burnInState?.lifecycleStatus || ''),
    recommendedFreshStateFile: String(burnInState?.recommendedFreshStateFile || ''),
    warnings,
    failureReasons,
    status: failureReasons.includes('burn_in_failed_by_drawdown')
      ? 'burn_in_failed_by_drawdown'
      : failureReasons.length > 0
        ? 'state_profile_mismatch'
        : 'state_profile_clean',
    summary: [...failureReasons, ...warnings.filter((warning) => !failureReasons.includes(warning))].join(' | ') || null,
  };
}

function extractStateFileProfileUsd(value) {
  const base = path.basename(String(value || ''));
  const match = base.match(/(?:burnin|state)[^0-9]{0,12}(\d{2,3})(?=\.json|[^0-9]|$)/i);
  return match ? Number(match[1]) : null;
}

function buildPortfolioSummary(state, report, stateFileAnalysis = null, context = {}) {
  const stateSummary = summarizeState(state);
  const summary = {
    equity: firstFinite(report.equity, stateSummary.equity),
    cash: firstFinite(report.cash, stateSummary.cash),
    drawdownPct: firstFinite(report.drawdownPct, stateSummary.drawdownPct),
    closedPnl: firstFinite(report.closedPnl, stateSummary.closedPnl),
    trustedClosedPnl: numberOrNull(report.trustedClosedPnl),
    untrustedClosedPnl: numberOrNull(report.untrustedClosedPnl),
    trustedOpenPnl: numberOrNull(report.trustedOpenPnl),
    untrustedOpenPnl: numberOrNull(report.untrustedOpenPnl),
    btcGabagoolClosedPnl: numberOrNull(report.btcGabagoolClosedPnl),
    btcGabagoolTrustedClosedPnl: numberOrNull(report.btcGabagoolTrustedClosedPnl),
    spreadHunterClosedPnl: numberOrNull(report.spreadHunterClosedPnl),
    spreadHunterTrustedClosedPnl: numberOrNull(report.spreadHunterTrustedClosedPnl),
    positionExposureUsd: firstFinite(report.positionExposureUsd, stateSummary.positionExposureUsd),
    openOrderExposureUsd: firstFinite(report.openOrderExposureUsd, null),
    totalExposureUsd: firstFinite(report.totalExposureUsd, stateSummary.totalExposureUsd),
    openOrders: firstFinite(report.openOrders, null),
    ghostFavorablePct: firstFinite(report.ghostFavorablePct, stateSummary.ghostFavorablePct),
    avgFillDelayMs: numberOrNull(report.avgFillDelayMs),
    zeroSecondFillCountLastHour: numberOrNull(report.zeroSecondFillCountLastHour),
    invalidUntrustedFillCountLastHour: numberOrNull(report.invalidUntrustedFillCountLastHour),
    trustedFillCountLastHour: numberOrNull(report.trustedFillCountLastHour),
    untrustedFillCountLastHour: numberOrNull(report.untrustedFillCountLastHour),
    fillCountsBySource: report.fillCountsBySource || '',
    blockedLossExitCountLastHour: numberOrNull(report.blockedLossExitCountLastHour),
    repeatedBlockedLossExitCountLastHour: numberOrNull(report.repeatedBlockedLossExitCountLastHour),
    repeatedSameMarketSameTokenEntriesLastHour: numberOrNull(report.repeatedSameMarketSameTokenEntriesLastHour),
    spreadHunterGhostBlocksLastHour: numberOrNull(report.spreadHunterGhostBlocksLastHour),
    spreadHunterSophieBlocksLastHour: numberOrNull(report.spreadHunterSophieBlocksLastHour),
    spreadHunterConfidenceBlocksLastHour: numberOrNull(report.spreadHunterConfidenceBlocksLastHour),
    spreadHunterCooldownBlocksLastHour: numberOrNull(report.spreadHunterCooldownBlocksLastHour),
    spreadHunterExecutionRealismBlocksLastHour: numberOrNull(report.spreadHunterExecutionRealismBlocksLastHour),
    staleExposureUsd: numberOrNull(report.staleExposureUsd),
    tradableExposureUsd: numberOrNull(report.tradableExposureUsd),
    capBlockingExposureUsd: numberOrNull(report.capBlockingExposureUsd),
    activeTradableExposureUsd: numberOrNull(report.activeTradableExposureUsd),
    staleNoBidExposureUsd: numberOrNull(report.staleNoBidExposureUsd),
    confirmedNoOrderbook404ExposureUsd: numberOrNull(report.confirmedNoOrderbook404ExposureUsd),
    expiredBtc5mExposureUsd: numberOrNull(report.expiredBtc5mExposureUsd),
    resolutionPendingExposureUsd: numberOrNull(report.resolutionPendingExposureUsd),
    excludedDeadExposureUsd: numberOrNull(report.excludedDeadExposureUsd),
    excludedDeadExposureReasons: report.excludedDeadExposureReasons || '',
    deadExposureCashReserveOutstandingUsd: numberOrNull(report.deadExposureCashReserveOutstandingUsd),
    deadExposureCashReserveCreditsUsd: numberOrNull(report.deadExposureCashReserveCreditsUsd),
    deadExposureCashReserveRepaymentsUsd: numberOrNull(report.deadExposureCashReserveRepaymentsUsd),
    dustExposureUsd: numberOrNull(report.dustExposureUsd),
    staleExposureCount: numberOrNull(report.staleExposureCount),
    tradableExposureCount: numberOrNull(report.tradableExposureCount),
    dustExposureCount: numberOrNull(report.dustExposureCount),
    gabagoolExitBlocks: report.gabagoolExitBlocks || '',
    gabagoolLastPlacementDecision: report.gabagoolLastPlacementDecision || '',
    dominantOracleNotConfirmedReasonLastHour: report.dominantOracleNotConfirmedReasonLastHour || '',
    oracleNotConfirmedReasonsLastHour: report.oracleNotConfirmedReasonsLastHour || '',
    paperOrdersPlacedLastHour: numberOrNull(report.paperOrdersPlacedLastHour),
    paperOrdersFilledLastHour: numberOrNull(report.paperOrdersFilledLastHour),
    paperOrdersPlacedLast15m: numberOrNull(report.paperOrdersPlacedLast15m),
    paperOrdersFilledLast15m: numberOrNull(report.paperOrdersFilledLast15m),
    actionRateStatus: report.actionRateStatus || '',
    actionRateReason: report.actionRateReason || '',
    targetOrdersPer15m: numberOrNull(report.targetOrdersPer15m),
    targetFillsPer15m: numberOrNull(report.targetFillsPer15m),
    probationAdmissionsLastHour: numberOrNull(report.probationAdmissionsLastHour),
    probationAdmissionsBeforeRisk: numberOrNull(report.probationAdmissionsBeforeRisk),
    probationOrdersBlockedByDrawdown: numberOrNull(report.probationOrdersBlockedByDrawdown),
    finalBlockerAfterProbation: report.finalBlockerAfterProbation || '',
    drawdownGateActive: report.drawdownGateActive,
    sophieAdmittedButRiskBlockedLastHour: numberOrNull(report.sophieAdmittedButRiskBlockedLastHour),
    probationBlocksLastHour: numberOrNull(report.probationBlocksLastHour),
    lossGuardConfiguredClosedLossUsd: numberOrNull(report.lossGuardConfiguredClosedLossUsd),
    lossGuardCurrentClosedLossUsd: numberOrNull(report.lossGuardCurrentClosedLossUsd),
    lossGuardCooldownMs: numberOrNull(report.lossGuardCooldownMs),
    lossGuardCooldownRemainingMs: numberOrNull(report.lossGuardCooldownRemainingMs),
    lossGuardRecoveryEligible: report.lossGuardRecoveryEligible,
    lossGuardRecoveryActive: report.lossGuardRecoveryActive,
    lossGuardRecoveryBlockedReason: report.lossGuardRecoveryBlockedReason || '',
    lossGuardTriggerSource: report.lossGuardTriggerSource || '',
    burnInLifecycleStatusFromLogs: report.burnInLifecycleStatus || '',
    burnInLifecycleReason: report.burnInLifecycleReason || '',
    burnInFreshStateRequired: report.burnInFreshStateRequired,
    recommendedFreshStateFileFromLogs: report.recommendedFreshStateFile || '',
    gabagoolEntriesBeforeDrawdownBreach: numberOrNull(report.gabagoolEntriesBeforeDrawdownBreach),
    gabagoolAverageEntryPriceBeforeDrawdownBreach: numberOrNull(report.gabagoolAverageEntryPriceBeforeDrawdownBreach),
    gabagoolDrawdownLastExitClassification: report.gabagoolDrawdownLastExitClassification || '',
    gabagoolLossPerMarketToken: report.gabagoolLossPerMarketToken || '',
    gabagoolLossGuardTriggeredTooLate: report.gabagoolLossGuardTriggeredTooLate,
    gabagoolRepeatedEntriesAlreadyBlocked: report.gabagoolRepeatedEntriesAlreadyBlocked,
    topBlockReasonsLastHour: report.topBlockReasonsLastHour || '',
    whyTotalOrdersZeroLastHour: report.whyTotalOrdersZeroLastHour || '',
    strategyOrdersLastHour: report.strategyOrdersLastHour || '',
    liveSafety: context.liveSafetyProfile?.status || 'UNKNOWN_SAFETY_STATUS',
    reportLiveSafety: report.liveSafety || '',
    latestFillAudit: report.latestFillAudit || '',
    source: report.lines.length > 0 ? 'logs' : stateSummary.source,
    stateFile: state.path,
    stateAvailable: state.available,
    stateMessage: state.message,
    stateExists: state.metadata.exists,
    stateFileSizeBytes: state.metadata.sizeBytes,
    stateFileModifiedAt: state.metadata.modifiedAt,
    stateProfileStatus: stateFileAnalysis?.status || '',
    stateFailureReasons: stateFileAnalysis?.failureReasons || [],
    recommendedFreshStateFile: stateFileAnalysis?.recommendedFreshStateFile || '',
    burnInLifecycleStatus: stateFileAnalysis?.burnInLifecycleStatus || '',
    stateWarnings: stateFileAnalysis?.warnings || [],
    stateWarningSummary: stateFileAnalysis?.summary || '',
  };

  const tolerance = 0.02;
  const exclusiveExposureBucketKeys = [
    'activeTradableExposureUsd',
    'staleNoBidExposureUsd',
    'confirmedNoOrderbook404ExposureUsd',
    'expiredBtc5mExposureUsd',
    'resolutionPendingExposureUsd',
  ];
  const exposureBucketsComplete = exclusiveExposureBucketKeys.every((key) => summary[key] !== null);
  const classifiedExposureUsd = exposureBucketsComplete
    ? exclusiveExposureBucketKeys.reduce((total, key) => total + Number(summary[key]), 0)
    : null;
  const rawUnreconciledExposureUsd = summary.positionExposureUsd !== null && classifiedExposureUsd !== null
    ? summary.positionExposureUsd - classifiedExposureUsd
    : null;
  const unreconciledExposureUsd = rawUnreconciledExposureUsd !== null && Math.abs(rawUnreconciledExposureUsd) <= tolerance
    ? 0
    : rawUnreconciledExposureUsd;
  const strategyClosedPnl = numberOrNull(report.strategyClosedPnlTotal);
  const pnlReference = firstFinite(report.closedPnl, stateSummary.closedPnl);
  const trustedClosedPnl = numberOrNull(report.trustedClosedPnl);
  const untrustedClosedPnl = numberOrNull(report.untrustedClosedPnl);
  const trustClassifiedPnl = trustedClosedPnl !== null && untrustedClosedPnl !== null
    ? trustedClosedPnl + untrustedClosedPnl
    : null;
  const strategyPnlScope = report.strategyPnlScope === 'durable' ? 'durable' : 'retained';
  const rawUnreconciledPnl = strategyClosedPnl === null
    ? null
    : strategyPnlScope === 'durable' && pnlReference !== null
      ? strategyClosedPnl - pnlReference
      : trustClassifiedPnl !== null
        ? strategyClosedPnl - trustClassifiedPnl
        : null;
  const unreconciledPnl = rawUnreconciledPnl !== null && Math.abs(rawUnreconciledPnl) <= tolerance
    ? 0
    : rawUnreconciledPnl;
  const rawLegacyOrUnattributedHistoricalPnl = pnlReference !== null && strategyClosedPnl !== null
    ? pnlReference - strategyClosedPnl
    : null;
  const legacyOrUnattributedHistoricalPnl = rawLegacyOrUnattributedHistoricalPnl !== null && Math.abs(rawLegacyOrUnattributedHistoricalPnl) <= tolerance
    ? 0
    : rawLegacyOrUnattributedHistoricalPnl;
  const rawRetainedTrustCoverageGapPnl = pnlReference !== null && trustClassifiedPnl !== null
    ? pnlReference - trustClassifiedPnl
    : null;
  const retainedTrustCoverageGapPnl = rawRetainedTrustCoverageGapPnl !== null && Math.abs(rawRetainedTrustCoverageGapPnl) <= tolerance
    ? 0
    : rawRetainedTrustCoverageGapPnl;
  const consistencyWarnings = [];
  if (!exposureBucketsComplete && Number(summary.positionExposureUsd) > tolerance) {
    consistencyWarnings.push('EXPOSURE_BUCKETS_INCOMPLETE');
  } else if (unreconciledExposureUsd !== null && Math.abs(unreconciledExposureUsd) > tolerance) {
    consistencyWarnings.push('EXPOSURE_UNRECONCILED');
  }
  if (pnlReference !== null && strategyClosedPnl === null) {
    consistencyWarnings.push('PNL_BREAKDOWN_INCOMPLETE');
  } else if (unreconciledPnl !== null && Math.abs(unreconciledPnl) > tolerance) {
    consistencyWarnings.push('PNL_CLASSIFICATION_UNRECONCILED');
  }
  if (report.trustedClosedPnl === null || report.untrustedClosedPnl === null) {
    consistencyWarnings.push('TRUSTED_PNL_NOT_PRESENT_IN_SELECTED_REPORT');
  }
  if (context.orderFillWindows?.contradictions?.length) {
    consistencyWarnings.push(...context.orderFillWindows.contradictions);
  }
  if (report.parserStatus !== 'ok') consistencyWarnings.push(`PORTFOLIO_REPORT_${String(report.parserStatus || 'UNAVAILABLE').toUpperCase()}`);
  if (report.freshness === 'stale') consistencyWarnings.push('PORTFOLIO_REPORT_STALE');
  if (context.liveSafetyProfile?.status === 'UNKNOWN_SAFETY_STATUS') consistencyWarnings.push('UNKNOWN_SAFETY_STATUS');

  Object.assign(summary, {
    historicalStateFilePnl: stateSummary.closedPnl,
    selectedReportClosedPnl: numberOrNull(report.closedPnl),
    currentProcessWindowPnl: null,
    trustedPnl: numberOrNull(report.trustedClosedPnl),
    untrustedPnl: numberOrNull(report.untrustedClosedPnl),
    strategyPnl: strategyClosedPnl,
    retainedFillHistoryClosedPnl: strategyPnlScope === 'durable' ? trustClassifiedPnl : strategyClosedPnl,
    trustClassifiedPnl,
    legacyOrUnattributedHistoricalPnl,
    retainedTrustCoverageGapPnl,
    pnlAttributionScope: strategyPnlScope === 'durable'
      ? 'durable_strategy_pnl_with_retained_fill_trust'
      : 'retained_fill_history',
    unreconciledPnl,
    exposureBucketsComplete,
    classifiedExposureUsd,
    unreconciledExposureUsd,
    otherClassifiedExposureUsd: summary.confirmedNoOrderbook404ExposureUsd,
    overlappingStaleExposureUsd: summary.staleExposureUsd,
    overlappingExcludedDeadExposureUsd: summary.excludedDeadExposureUsd,
    overlappingDustExposureUsd: summary.dustExposureUsd,
    excludedDeadExposureIncludedInReconciliation: false,
    dustExposureIncludedInReconciliation: false,
    exclusiveExposureBucketKeys,
    consistencyWarnings: [...new Set(consistencyWarnings)],
    dataStatus: consistencyWarnings.length > 0 ? 'INCOMPLETE_OR_UNRECONCILED' : 'CONSISTENT',
    processUptimeOrdersLastHour: context.orderFillWindows?.processUptimeWindow?.orders ?? null,
    processUptimeFillsLastHour: context.orderFillWindows?.processUptimeWindow?.fills ?? null,
    wallClockLogOrdersLastHour: context.orderFillWindows?.wallClockLogWindow?.orders ?? null,
    wallClockLogFillsLastHour: context.orderFillWindows?.wallClockLogWindow?.fills ?? null,
    processUptimeLessThanRequestedWindow: context.orderFillWindows?.processUptimeLessThanRequestedWindow ?? null,
    recentSuccessfulPaperPlacements: context.candidateDiagnostics?.recentSuccessfulPaperPlacements ?? null,
    stage5SizingEvaluatedPlacements: context.candidateDiagnostics?.stage5SizingEvaluatedPlacements ?? null,
    stage5EligiblePlacements: context.candidateDiagnostics?.stage5EligiblePlacements ?? null,
    stage5IneligiblePlacements: context.candidateDiagnostics?.stage5IneligiblePlacements ?? null,
    stage5SizingResizedPlacements: context.candidateDiagnostics?.stage5SizingResizedPlacements ?? null,
    stage5SizingBlockedPlacements: context.candidateDiagnostics?.stage5SizingBlockedPlacements ?? null,
    dominantCandidateBlocker: context.candidateDiagnostics?.dominantCandidateBlocker ?? null,
    latestCandidateSizingExample: context.candidateDiagnostics?.latestCandidateSizingExample ?? null,
    sourceMetadata: {
      selectedPortfolioReport: {
        source: context.orderFillWindows?.sourceMetadata?.source || 'PM2/local log portfolio report',
        sourceTimestamp: report.sourceTimestamp,
        parserStatus: report.parserStatus,
        freshness: report.freshness,
        boundary: report.boundary,
        missingCriticalFields: report.missingCriticalFields,
      },
      stateFile: {
        source: state.path,
        sourceTimestamp: state.metadata.modifiedAt,
        parserStatus: state.available ? 'ok' : 'unavailable',
        freshness: state.available ? 'not_evaluated' : 'unavailable',
      },
      orderFillCounts: context.orderFillWindows?.sourceMetadata || null,
      liveSafety: context.liveSafetyProfile?.sourceMetadata || null,
      candidateDiagnostics: context.candidateDiagnostics?.sourceMetadata || null,
      fieldSources: {
        closedPnl: report.closedPnl !== null ? 'selected_portfolio_report' : stateSummary.closedPnl !== null ? 'historical_state_file' : 'unavailable',
        positionExposureUsd: report.positionExposureUsd !== null ? 'selected_portfolio_report' : stateSummary.positionExposureUsd !== null ? 'historical_state_file' : 'unavailable',
        exposureBuckets: exposureBucketsComplete ? 'selected_portfolio_report' : 'not_present_in_selected_report',
        excludedDeadExposure: 'selected_portfolio_report_overlapping_aggregate_not_used_in_reconciliation',
        trustedPnl: report.trustedClosedPnl !== null ? 'selected_portfolio_report' : 'not_present_in_selected_report',
        strategyPnl: strategyClosedPnl !== null
          ? (strategyPnlScope === 'durable' ? 'durable_strategy_pnl_from_selected_portfolio_report' : 'retained_fill_history_from_selected_portfolio_report')
          : 'not_present_in_selected_report',
        legacyOrUnattributedHistoricalPnl: legacyOrUnattributedHistoricalPnl !== null
          ? (strategyPnlScope === 'durable' ? 'historical_total_minus_durable_strategy_pnl' : 'historical_total_minus_retained_fill_history')
          : 'unavailable',
        retainedTrustCoverageGapPnl: retainedTrustCoverageGapPnl !== null ? 'historical_total_minus_retained_fill_trust' : 'unavailable',
      },
    },
  });
  return summary;
}

function summarizeState(state) {
  if (!state.available || !state.data) {
    return {
      source: 'unavailable',
      equity: null,
      cash: null,
      drawdownPct: null,
      closedPnl: null,
      positionExposureUsd: null,
      totalExposureUsd: null,
      ghostFavorablePct: null,
    };
  }

  const data = state.data;
  const positions = data.positions && typeof data.positions === 'object' ? data.positions : {};
  const costBasis = data.costBasis && typeof data.costBasis === 'object' ? data.costBasis : {};
  const positionMetadata = data.positionMetadata && typeof data.positionMetadata === 'object' ? data.positionMetadata : {};
  let positionExposureUsd = 0;
  let reliablePositionValueUsd = 0;

  for (const [tokenId, qtyRaw] of Object.entries(positions)) {
    const qty = Number(qtyRaw);
    const avg = Number(costBasis[tokenId]);
    if (Number.isFinite(qty) && qty > 0 && Number.isFinite(avg) && avg > 0) {
      const costValue = qty * avg;
      positionExposureUsd += costValue;
      const metadata = positionMetadata[tokenId] || {};
      const slugMatch = /^btc-updown-5m-(\d+)$/i.exec(String(metadata.marketSlug || ''));
      const expiredBtcWindow = metadata.tokenVerified === true && slugMatch &&
        Date.now() >= ((Number(slugMatch[1]) + 300) * 1000);
      const verifiedPayout = metadata.resolutionEvidenceVerified === true
        ? numberOrNull(metadata.payoutPerShare)
        : null;
      if (verifiedPayout === 0 || verifiedPayout === 1) {
        reliablePositionValueUsd += qty * verifiedPayout;
      } else if (!expiredBtcWindow) {
        reliablePositionValueUsd += costValue;
      }
    }
  }

  const cash = numberOrNull(data.cash);
  const equity = cash === null ? null : cash + reliablePositionValueUsd;
  const peakEquity = numberOrNull(data.peakEquity);
  const drawdownPct = equity !== null && peakEquity !== null && peakEquity > 0
    ? Math.max(0, ((peakEquity - equity) / peakEquity) * 100)
    : null;
  const ghostTotal = Number(data.ghostStats?.total || 0);
  const ghostFavorable = Number(data.ghostStats?.favorable || 0);

  return {
    source: 'state',
    equity,
    cash,
    drawdownPct,
    closedPnl: numberOrNull(data.closedPnl),
    positionExposureUsd,
    totalExposureUsd: positionExposureUsd,
    ghostFavorablePct: ghostTotal > 0 ? (ghostFavorable / ghostTotal) * 100 : null,
  };
}

function parseLogTimestamp(line) {
  const match = String(line || '').match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (!match) return null;
  const value = Date.parse(match[1]);
  return Number.isFinite(value) ? value : null;
}

function selectLatestPortfolioReportBoundary(lines) {
  const starts = [];
  for (let index = 0; index < (lines || []).length; index += 1) {
    if (String(lines[index]).includes('--- PORTFOLIO REPORT ---')) {
      starts.push({ index, timestampMs: parseLogTimestamp(lines[index]) });
    }
  }
  if (starts.length === 0) return null;
  let selected = starts[starts.length - 1];
  for (const candidate of starts) {
    if (candidate.timestampMs !== null && (selected.timestampMs === null || candidate.timestampMs > selected.timestampMs)) {
      selected = candidate;
    }
  }
  const next = starts.find((candidate) => candidate.index > selected.index);
  const nextFileBoundary = (lines || []).findIndex((line, index) => (
    index > selected.index && String(line).startsWith(LOG_FILE_BOUNDARY_PREFIX)
  ));
  const durationBoundary = selected.timestampMs === null ? -1 : (lines || []).findIndex((line, index) => {
    if (index <= selected.index) return false;
    const timestampMs = parseLogTimestamp(line);
    return timestampMs !== null && timestampMs > selected.timestampMs + MAX_PORTFOLIO_REPORT_DURATION_MS;
  });
  const naturalEndExclusive = Math.min(
    next ? next.index : lines.length,
    nextFileBoundary >= 0 ? nextFileBoundary : lines.length,
    durationBoundary >= 0 ? durationBoundary : lines.length
  );
  const hardEndExclusive = selected.index + MAX_PORTFOLIO_REPORT_LINES;
  const endExclusive = Math.min(naturalEndExclusive, hardEndExclusive);
  return {
    startLine: selected.index,
    endLineExclusive: endExclusive,
    lineCount: Math.max(0, endExclusive - selected.index),
    sourceTimestamp: selected.timestampMs === null ? null : new Date(selected.timestampMs).toISOString(),
    selectedBy: selected.timestampMs === null ? 'last_boundary_without_timestamp' : 'latest_boundary_timestamp',
    terminatedByNextBoundary: Boolean(next),
    terminatedByLogFileBoundary: nextFileBoundary >= 0 && nextFileBoundary === naturalEndExclusive,
    terminatedByDurationWindow: durationBoundary >= 0 && durationBoundary === naturalEndExclusive,
    truncatedByLineLimit: hardEndExclusive < naturalEndExclusive,
    maxLineCount: MAX_PORTFOLIO_REPORT_LINES,
    maxDurationMs: MAX_PORTFOLIO_REPORT_DURATION_MS,
  };
}

function parseLatestPortfolioReport(lines, nowMs = Date.now()) {
  const boundary = selectLatestPortfolioReportBoundary(lines);
  if (!boundary) return emptyReport();

  const reportLines = lines.slice(boundary.startLine, boundary.endLineExclusive);
  const report = emptyReport();
  report.lines = reportLines;
  report.boundary = boundary;
  report.sourceTimestamp = boundary.sourceTimestamp;

  for (const line of reportLines) {
    let match = line.match(/Equity:\s*\$([\d.-]+)\s*\|\s*Cash:\s*\$([\d.-]+)\s*\|\s*Drawdown:\s*([\d.-]+)%/);
    if (match) {
      report.equity = Number(match[1]);
      report.cash = Number(match[2]);
      report.drawdownPct = Number(match[3]);
      continue;
    }

    match = line.match(/Open Orders:\s*(\d+)\s*\|\s*Exposure:\s*\$([\d.-]+)\s*\|\s*Closed PnL:\s*\$([\d.-]+)/);
    if (match) {
      report.openOrders = Number(match[1]);
      report.totalExposureUsd = Number(match[2]);
      report.closedPnl = Number(match[3]);
      continue;
    }

    match = line.match(/Position Exposure:\s*\$([\d.-]+)\s*\|\s*Open Order Exposure:\s*\$([\d.-]+)/);
    if (match) {
      report.positionExposureUsd = Number(match[1]);
      report.openOrderExposureUsd = Number(match[2]);
      continue;
    }

    match = line.match(/Ghost calibration:\s*total=(\d+)\s*favorable=([\d.-]+)%/);
    if (match) {
      report.ghostFavorablePct = Number(match[2]);
      continue;
    }

    match = line.match(/PnL Trust:\s*trustedClosedPnl=\$([\d.-]+)\s*untrustedClosedPnl=\$([\d.-]+)\s*trustedOpenPnl=\$([\d.-]+)\s*untrustedOpenPnl=\$([\d.-]+)/);
    if (match) {
      report.trustedClosedPnl = Number(match[1]);
      report.untrustedClosedPnl = Number(match[2]);
      report.trustedOpenPnl = Number(match[3]);
      report.untrustedOpenPnl = Number(match[4]);
      continue;
    }

    match = line.match(/Strategy PnL:\s*btcGabagoolClosed=\$([\d.-]+)\s*btcGabagoolTrustedClosed=\$([\d.-]+)\s*spreadHunterClosed=\$([\d.-]+)\s*spreadHunterTrustedClosed=\$([\d.-]+)/);
    if (match) {
      report.btcGabagoolClosedPnl = Number(match[1]);
      report.btcGabagoolTrustedClosedPnl = Number(match[2]);
      report.spreadHunterClosedPnl = Number(match[3]);
      report.spreadHunterTrustedClosedPnl = Number(match[4]);
      continue;
    }

    match = line.match(/Fill Realism:\s*paperRealisticFills=(true|false)\s*avgFillDelayMs=([A-Z\d.-]+)\s*zeroSecondFillCountLastHour=(\d+)\s*invalidUntrustedFillCountLastHour=(\d+)\s*trustedFillCountLastHour=(\d+)\s*untrustedFillCountLastHour=(\d+)\s*fillCountsBySource=([^\s]+)/);
    if (match) {
      report.paperRealisticFills = match[1] === 'true';
      report.avgFillDelayMs = match[2] === 'NA' ? null : Number(match[2]);
      report.zeroSecondFillCountLastHour = Number(match[3]);
      report.invalidUntrustedFillCountLastHour = Number(match[4]);
      report.trustedFillCountLastHour = Number(match[5]);
      report.untrustedFillCountLastHour = Number(match[6]);
      report.fillCountsBySource = match[7];
      continue;
    }

    match = line.match(/Loss Exit Audit:\s*blockedLossExitCountLastHour=(\d+)\s*repeatedBlockedLossExitCountLastHour=(\d+)\s*repeatedSameMarketSameTokenEntriesLastHour=(\d+)/);
    if (match) {
      report.blockedLossExitCountLastHour = Number(match[1]);
      report.repeatedBlockedLossExitCountLastHour = Number(match[2]);
      report.repeatedSameMarketSameTokenEntriesLastHour = Number(match[3]);
      continue;
    }

    match = line.match(/Exposure Split:\s*tradableExposure=\$([\d.-]+)\s*staleExposure=\$([\d.-]+)\s*dustExposure=\$([\d.-]+)\s*tradableCount=(\d+)\s*staleCount=(\d+)\s*dustCount=(\d+)/);
    if (match) {
      report.tradableExposureUsd = Number(match[1]);
      report.staleExposureUsd = Number(match[2]);
      report.dustExposureUsd = Number(match[3]);
      report.tradableExposureCount = Number(match[4]);
      report.staleExposureCount = Number(match[5]);
      report.dustExposureCount = Number(match[6]);
      continue;
    }

    match = line.match(
      /Exposure Split:\s*portfolioExposure=\$([\d.-]+)\s*capBlockingExposure=\$([\d.-]+)\s*activeTradableExposure=\$([\d.-]+)\s*staleNoBidExposure=\$([\d.-]+)\s*confirmedNoOrderbook404Exposure=\$([\d.-]+)\s*expiredBtc5mExposure=\$([\d.-]+)\s*resolutionPendingExposure=\$([\d.-]+)\s*dustExposure=\$([\d.-]+)\s*excludedDeadExposure=\$([\d.-]+)\s*excludedDeadExposureReasons=(.*)$/
    );
    if (match) {
      report.totalExposureUsd = report.totalExposureUsd == null ? Number(match[1]) : report.totalExposureUsd;
      report.capBlockingExposureUsd = Number(match[2]);
      report.activeTradableExposureUsd = Number(match[3]);
      report.staleNoBidExposureUsd = Number(match[4]);
      report.confirmedNoOrderbook404ExposureUsd = Number(match[5]);
      report.expiredBtc5mExposureUsd = Number(match[6]);
      report.resolutionPendingExposureUsd = Number(match[7]);
      report.dustExposureUsd = Number(match[8]);
      report.excludedDeadExposureUsd = Number(match[9]);
      report.excludedDeadExposureReasons = match[10];
      report.tradableExposureUsd = Number(match[3]);
      report.staleExposureUsd =
        Number(match[4]) +
        Number(match[5]) +
        Number(match[6]) +
        Number(match[7]);
      continue;
    }

    match = line.match(/Gabagool Exit Blocks:\s*exposureCap=(.*?)\s+lastPlacementDecision=(.*)$/);
    if (match) {
      report.gabagoolExitBlocks = match[1];
      report.gabagoolLastPlacementDecision = match[2];
      continue;
    }

    match = line.match(/Gabagool Pre-Candidate Blocks:\s*dominant=([^\s]+)\s+notConfirmedReasons=(.*)$/);
    if (match) {
      report.dominantOracleNotConfirmedReasonLastHour = match[1];
      report.oracleNotConfirmedReasonsLastHour = match[2];
      continue;
    }

    match = line.match(/SpreadHunter Blocks:\s*ghost=(\d+)\s*sophie=(\d+)\s*confidence=(\d+)\s*cooldown=(\d+)\s*executionRealism=(\d+)/);
    if (match) {
      report.spreadHunterGhostBlocksLastHour = Number(match[1]);
      report.spreadHunterSophieBlocksLastHour = Number(match[2]);
      report.spreadHunterConfidenceBlocksLastHour = Number(match[3]);
      report.spreadHunterCooldownBlocksLastHour = Number(match[4]);
      report.spreadHunterExecutionRealismBlocksLastHour = Number(match[5]);
      continue;
    }

    match = line.match(/Paper Flow:\s*totalOrders=(\d+)\s*whyTotalOrdersZero=(.*?)\s+topBlockReasons=(.*?)\s+probationAdmissions=(\d+)\s+probationAdmissionsBeforeRisk=(\d+)\s+probationOrdersBlockedByDrawdown=(\d+)\s+finalBlockerAfterProbation=([^\s]+)\s+drawdownGateActive=(true|false)\s+sophieAdmittedButRiskBlocked=(\d+)\s+probationBlocks=(\d+)/);
    if (match) {
      report.paperOrdersPlacedLastHour = Number(match[1]);
      report.whyTotalOrdersZeroLastHour = match[2];
      report.topBlockReasonsLastHour = match[3];
      report.probationAdmissionsLastHour = Number(match[4]);
      report.probationAdmissionsBeforeRisk = Number(match[5]);
      report.probationOrdersBlockedByDrawdown = Number(match[6]);
      report.finalBlockerAfterProbation = match[7];
      report.drawdownGateActive = match[8] === 'true';
      report.sophieAdmittedButRiskBlockedLastHour = Number(match[9]);
      report.probationBlocksLastHour = Number(match[10]);
      continue;
    }

    match = line.match(/Action Rate 15m:\s*status=([^\s]+)\s*ordersPlacedLast15m=(\d+)\s*fillsLast15m=(\d+)\s*targetOrdersPer15m=(\d+)\s*targetFillsPer15m=(\d+)\s*reason=(.*?)\s+paperActionBurnInActive=(true|false)/);
    if (match) {
      report.actionRateStatus = match[1];
      report.paperOrdersPlacedLast15m = Number(match[2]);
      report.paperOrdersFilledLast15m = Number(match[3]);
      report.targetOrdersPer15m = Number(match[4]);
      report.targetFillsPer15m = Number(match[5]);
      report.actionRateReason = match[6];
      report.paperActionBurnInActive = match[7] === 'true';
      continue;
    }

    match = line.match(/Loss Guard:\s*configuredClosedLossUsd=\$([\d.-]+)\s*currentClosedLossUsd=\$([\d.-]+)\s*cooldownMs=([A-Z\d.-]+)\s*cooldownRemainingMs=([A-Z\d.-]+)\s*recoveryEligible=(true|false)\s*recoveryActive=(true|false)\s*recoveryBlockedReason=([^\s]+)\s*triggerSource=(.*)$/);
    if (match) {
      report.lossGuardConfiguredClosedLossUsd = Number(match[1]);
      report.lossGuardCurrentClosedLossUsd = Number(match[2]);
      report.lossGuardCooldownMs = match[3] === 'NA' ? null : Number(match[3]);
      report.lossGuardCooldownRemainingMs = match[4] === 'NA' ? null : Number(match[4]);
      report.lossGuardRecoveryEligible = match[5] === 'true';
      report.lossGuardRecoveryActive = match[6] === 'true';
      report.lossGuardRecoveryBlockedReason = match[7];
      report.lossGuardTriggerSource = match[8];
      continue;
    }

    match = line.match(/Burn-In Lifecycle:\s*status=([^\s]+)\s*reason=([^\s]+)\s*freshStateRequired=(true|false)\s*recommendedFreshStateFile=(.*)$/);
    if (match) {
      report.burnInLifecycleStatus = match[1];
      report.burnInLifecycleReason = match[2];
      report.burnInFreshStateRequired = match[3] === 'true';
      report.recommendedFreshStateFile = match[4];
      continue;
    }

    match = line.match(/Gabagool Drawdown Breakdown:\s*entriesBeforeDrawdownBreach=(\d+)\s*averageEntryPriceBeforeDrawdownBreach=([^\s]+)\s*lastExitClassification=([^\s]+)\s*lossPerMarketToken=(.*?)\s+lossGuardTriggeredTooLate=(true|false)\s+repeatedEntriesAlreadyBlocked=(true|false)$/);
    if (match) {
      report.gabagoolEntriesBeforeDrawdownBreach = Number(match[1]);
      report.gabagoolAverageEntryPriceBeforeDrawdownBreach = match[2] === 'n/a' ? null : Number(String(match[2]).replace(/^\$/, ''));
      report.gabagoolDrawdownLastExitClassification = match[3];
      report.gabagoolLossPerMarketToken = match[4];
      report.gabagoolLossGuardTriggeredTooLate = match[5] === 'true';
      report.gabagoolRepeatedEntriesAlreadyBlocked = match[6] === 'true';
      continue;
    }

    match = line.match(/Execution Health:.*?paperOrdersPlacedLastHour=(\d+).*?paperOrdersFilledLastHour=(\d+)/);
    if (match) {
      if (report.paperOrdersPlacedLastHour === null) {
        report.paperOrdersPlacedLastHour = Number(match[1]);
      }
      report.paperOrdersFilledLastHour = Number(match[2]);
      continue;
    }

    match = line.match(/Strategy Orders 1h:\s*(.*)$/);
    if (match) {
      report.strategyOrdersLastHour = match[1];
      continue;
    }

    match = line.match(/PnL By Strategy(?:\s+scope=(durable|retained))?:\s*(.*)$/);
    if (match) {
      report.strategyPnlScope = match[1] || 'retained';
      const values = [...match[2].matchAll(/:closed=\$?(-?[\d.]+)/g)].map((item) => Number(item[1]));
      if (values.length > 0 && values.every(Number.isFinite)) {
        report.strategyClosedPnlTotal = values.reduce((total, value) => total + value, 0);
      } else if (match[2].trim() === 'none') {
        // An explicit empty strategy map is a known zero, not an unknown.
        report.strategyClosedPnlTotal = 0;
      }
      continue;
    }

    match = line.match(/Live Safety:\s*(.*)$/);
    if (match) {
      report.liveSafety = match[1];
      continue;
    }

    match = line.match(/Paper Cash Reserve:\s*outstanding=\$([\d.-]+)\s*credits=\$([\d.-]+)\s*repayments=\$([\d.-]+)\s*releaseBatch=\$([\d.-]+)\s*triggerCash=\$([\d.-]+)/);
    if (match) {
      report.deadExposureCashReserveOutstandingUsd = Number(match[1]);
      report.deadExposureCashReserveCreditsUsd = Number(match[2]);
      report.deadExposureCashReserveRepaymentsUsd = Number(match[3]);
      report.deadExposureCashReserveReleaseBatchUsd = Number(match[4]);
      report.deadExposureCashReserveTriggerCashUsd = Number(match[5]);
      continue;
    }

    match = line.match(/Last Fill Audit:\s*(.*)$/);
    if (match) {
      report.latestFillAudit = match[1];
    }
  }

  const criticalFields = [
    'closedPnl',
    'positionExposureUsd',
    'paperOrdersPlacedLastHour',
    'paperOrdersFilledLastHour',
    'trustedClosedPnl',
    'untrustedClosedPnl',
    'activeTradableExposureUsd',
    'staleNoBidExposureUsd',
    'expiredBtc5mExposureUsd',
    'resolutionPendingExposureUsd',
    'dustExposureUsd',
    'excludedDeadExposureUsd',
  ];
  report.missingCriticalFields = criticalFields.filter((field) => report[field] === null);
  report.parserStatus = report.missingCriticalFields.length === 0
    ? 'ok'
    : boundary.terminatedByNextBoundary
      ? 'incomplete'
      : 'incomplete_or_truncated';
  if (!report.sourceTimestamp) {
    report.freshness = 'unknown';
  } else {
    report.freshness = nowMs - Date.parse(report.sourceTimestamp) > 5 * 60_000 ? 'stale' : 'fresh';
  }
  return report;
}

function emptyReport() {
  return {
    lines: [],
    equity: null,
    cash: null,
    drawdownPct: null,
    closedPnl: null,
    positionExposureUsd: null,
    openOrderExposureUsd: null,
    totalExposureUsd: null,
    openOrders: null,
    ghostFavorablePct: null,
    trustedClosedPnl: null,
    untrustedClosedPnl: null,
    trustedOpenPnl: null,
    untrustedOpenPnl: null,
    btcGabagoolClosedPnl: null,
    btcGabagoolTrustedClosedPnl: null,
    spreadHunterClosedPnl: null,
    spreadHunterTrustedClosedPnl: null,
    avgFillDelayMs: null,
    zeroSecondFillCountLastHour: null,
    invalidUntrustedFillCountLastHour: null,
    trustedFillCountLastHour: null,
    untrustedFillCountLastHour: null,
    fillCountsBySource: '',
    blockedLossExitCountLastHour: null,
    repeatedBlockedLossExitCountLastHour: null,
    repeatedSameMarketSameTokenEntriesLastHour: null,
    spreadHunterGhostBlocksLastHour: null,
    spreadHunterSophieBlocksLastHour: null,
    spreadHunterConfidenceBlocksLastHour: null,
    spreadHunterCooldownBlocksLastHour: null,
    spreadHunterExecutionRealismBlocksLastHour: null,
    staleExposureUsd: null,
    tradableExposureUsd: null,
    capBlockingExposureUsd: null,
    activeTradableExposureUsd: null,
    staleNoBidExposureUsd: null,
    confirmedNoOrderbook404ExposureUsd: null,
    expiredBtc5mExposureUsd: null,
    resolutionPendingExposureUsd: null,
    excludedDeadExposureUsd: null,
    excludedDeadExposureReasons: '',
    deadExposureCashReserveOutstandingUsd: null,
    deadExposureCashReserveCreditsUsd: null,
    deadExposureCashReserveRepaymentsUsd: null,
    dustExposureUsd: null,
    staleExposureCount: null,
    tradableExposureCount: null,
    dustExposureCount: null,
    gabagoolExitBlocks: '',
    gabagoolLastPlacementDecision: '',
    dominantOracleNotConfirmedReasonLastHour: '',
    oracleNotConfirmedReasonsLastHour: '',
    paperOrdersPlacedLastHour: null,
    paperOrdersFilledLastHour: null,
    paperOrdersPlacedLast15m: null,
    paperOrdersFilledLast15m: null,
    actionRateStatus: '',
    actionRateReason: '',
    targetOrdersPer15m: null,
    targetFillsPer15m: null,
    paperActionBurnInActive: null,
    probationAdmissionsLastHour: null,
    probationBlocksLastHour: null,
    probationAdmissionsBeforeRisk: null,
    probationOrdersBlockedByDrawdown: null,
    finalBlockerAfterProbation: '',
    drawdownGateActive: null,
    sophieAdmittedButRiskBlockedLastHour: null,
    lossGuardConfiguredClosedLossUsd: null,
    lossGuardCurrentClosedLossUsd: null,
    lossGuardCooldownMs: null,
    lossGuardCooldownRemainingMs: null,
    lossGuardRecoveryEligible: null,
    lossGuardRecoveryActive: null,
    lossGuardRecoveryBlockedReason: '',
    lossGuardTriggerSource: '',
    burnInLifecycleStatus: '',
    burnInLifecycleReason: '',
    burnInFreshStateRequired: null,
    recommendedFreshStateFile: '',
    gabagoolEntriesBeforeDrawdownBreach: null,
    gabagoolAverageEntryPriceBeforeDrawdownBreach: null,
    gabagoolDrawdownLastExitClassification: '',
    gabagoolLossPerMarketToken: '',
    gabagoolLossGuardTriggeredTooLate: null,
    gabagoolRepeatedEntriesAlreadyBlocked: null,
    topBlockReasonsLastHour: '',
    whyTotalOrdersZeroLastHour: '',
    strategyOrdersLastHour: '',
    strategyClosedPnlTotal: null,
    liveSafety: '',
    latestFillAudit: '',
    sourceTimestamp: null,
    parserStatus: 'unavailable',
    freshness: 'unavailable',
    missingCriticalFields: [],
    boundary: null,
  };
}

function getPm2Status() {
  const result = runCommand('pm2', ['jlist'], { timeout: 4000 });
  if (!result.ok) {
    return {
      available: false,
      message: `PM2 status unavailable: ${result.message}`,
      processes: [],
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const processes = Array.isArray(parsed) ? parsed.map((proc) => ({
      name: proc.name || '',
      pmId: proc.pm_id,
      status: proc.pm2_env?.status || 'unknown',
      restartCount: proc.pm2_env?.restart_time,
      unstableRestarts: proc.pm2_env?.unstable_restarts,
      uptime: proc.pm2_env?.pm_uptime ? new Date(proc.pm2_env.pm_uptime).toISOString() : null,
      memoryBytes: proc.monit?.memory,
      cpuPct: proc.monit?.cpu,
      outLogPath: proc.pm2_env?.pm_out_log_path || null,
      errLogPath: proc.pm2_env?.pm_err_log_path || null,
      rawPm2Env: proc.pm2_env || {},
    })) : [];

    return {
      available: true,
      message: processes.length > 0 ? 'PM2 process list loaded.' : 'PM2 is available but has no processes.',
      processes,
    };
  } catch (err) {
    return {
      available: false,
      message: `PM2 returned invalid JSON: ${err.message}`,
      processes: [],
    };
  }
}

function findProcess(processes, name) {
  return (processes || []).find((proc) => proc.name === name) || null;
}

function getLogs(pm2) {
  const pm2LogPaths = [];
  for (const proc of pm2.processes || []) {
    if (proc.outLogPath) pm2LogPaths.push(proc.outLogPath);
    if (proc.errLogPath) pm2LogPaths.push(proc.errLogPath);
  }

  const pm2Text = readManyFiles(pm2LogPaths, 256 * 1024);
  if (pm2Text.length > 0) {
    return buildLogResult('pm2', 'Read recent PM2 log files.', pm2Text, pm2LogPaths);
  }

  const fallbackPaths = findFallbackLogFiles();
  const fallbackText = readManyFiles(fallbackPaths, 256 * 1024);
  if (fallbackText.length > 0) {
    return buildLogResult('local-files', 'Read recent local log files.', fallbackText, fallbackPaths);
  }

  return buildLogResult('unavailable', 'No PM2 or local safe log files were available.', '');
}

function buildLogResult(source, message, text, sourceFiles = []) {
  const allLines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const importantLines = allLines.filter((line) => IMPORTANT_LOG_PATTERNS.some((pattern) => line.includes(pattern)));

  return {
    source,
    message,
    sourceFiles: [...new Set(sourceFiles)],
    allLines,
    importantLines: importantLines.slice(-50),
  };
}

function summarizeOrderFillWindows(lines, report, engineProc, nowMs = Date.now(), windowMs = 60 * 60_000, logSource = {}) {
  const cutoff = nowMs - windowMs;
  let orders = 0;
  let fills = 0;
  let earliestTimestampMs = null;
  let latestTimestampMs = null;
  let unparsableActivityLines = 0;
  for (const line of lines || []) {
    const isOrder = String(line).includes('[ORDER]');
    const isFill = String(line).includes('[FILL]');
    if (!isOrder && !isFill) continue;
    const timestampMs = parseLogTimestamp(line);
    if (timestampMs === null) {
      unparsableActivityLines += 1;
      continue;
    }
    earliestTimestampMs = earliestTimestampMs === null ? timestampMs : Math.min(earliestTimestampMs, timestampMs);
    latestTimestampMs = latestTimestampMs === null ? timestampMs : Math.max(latestTimestampMs, timestampMs);
    if (timestampMs < cutoff || timestampMs > nowMs + 1_000) continue;
    if (isOrder) orders += 1;
    if (isFill) fills += 1;
  }
  const uptimeMs = engineProc?.uptime ? nowMs - Date.parse(engineProc.uptime) : null;
  const processUptimeLessThanRequestedWindow = Number.isFinite(uptimeMs) ? uptimeMs < windowMs : null;
  const contradictions = [];
  if (report.paperOrdersPlacedLastHour === null && orders > 0) contradictions.push('ORDER_SUMMARY_MISSING_WITH_WALL_CLOCK_LOG_ACTIVITY');
  if (report.paperOrdersFilledLastHour === null && fills > 0) contradictions.push('FILL_SUMMARY_MISSING_WITH_WALL_CLOCK_LOG_ACTIVITY');
  if (report.paperOrdersPlacedLastHour === 0 && orders > 0) contradictions.push('ORDER_COUNTER_CONTRADICTS_WALL_CLOCK_LOGS');
  if (report.paperOrdersFilledLastHour === 0 && fills > 0) contradictions.push('FILL_COUNTER_CONTRADICTS_WALL_CLOCK_LOGS');
  return {
    requestedWindowMs: windowMs,
    requestedWindowStart: new Date(cutoff).toISOString(),
    requestedWindowEnd: new Date(nowMs).toISOString(),
    processUptimeLessThanRequestedWindow,
    processUptimeWindow: {
      source: 'selected portfolio report execution-health counters',
      startsAt: engineProc?.uptime || null,
      orders: numberOrNull(report.paperOrdersPlacedLastHour),
      fills: numberOrNull(report.paperOrdersFilledLastHour),
    },
    wallClockLogWindow: {
      source: 'timestamped [ORDER]/[FILL] PM2/local log entries',
      orders,
      fills,
      coverage: earliestTimestampMs !== null && earliestTimestampMs <= cutoff ? 'complete_for_requested_window' : 'partial_or_unknown',
      earliestActivityTimestamp: earliestTimestampMs === null ? null : new Date(earliestTimestampMs).toISOString(),
      latestActivityTimestamp: latestTimestampMs === null ? null : new Date(latestTimestampMs).toISOString(),
      unparsableActivityLines,
    },
    contradictions,
    sourceMetadata: {
      source: logSource.sourceFiles?.length ? logSource.sourceFiles : (logSource.source || 'PM2/local logs'),
      sourceTimestamp: latestTimestampMs === null ? null : new Date(latestTimestampMs).toISOString(),
      parserStatus: unparsableActivityLines > 0 ? 'partial' : 'ok',
      freshness: latestTimestampMs !== null && nowMs - latestTimestampMs <= windowMs ? 'fresh' : 'unknown_or_stale',
      selectedPortfolioReportBoundary: report.boundary,
    },
  };
}

function parseRuntimeBool(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function buildRuntimeSafetyProfile(settings, engineProc, nowMs = Date.now()) {
  const expected = {
    ENABLE_LIVE_TRADING: false,
    LIVE_AUTO_EXECUTE: false,
    LIVE_KILL_SWITCH: true,
    LIVE_DRY_RUN_ONLY: true,
    LIVE_SUBMIT_CONFIRM: false,
    LIVE_FINAL_BOSS_READY: false,
  };
  const values = {};
  const missing = [];
  const mismatches = [];
  for (const [key, safeValue] of Object.entries(expected)) {
    values[key] = parseRuntimeBool(settings?.runtime?.[key]);
    if (values[key] === null) missing.push(key);
    else if (values[key] !== safeValue) mismatches.push(key);
  }
  const status = missing.length > 0
    ? 'UNKNOWN_SAFETY_STATUS'
    : mismatches.length > 0
      ? 'UNSAFE_RUNTIME_PROFILE'
      : 'LIVE_LOCKED_OFF';
  return {
    status,
    values,
    missing,
    mismatches,
    sourceMetadata: {
      source: `PM2 structured runtime profile pm_id=${engineProc?.pmId ?? 'unknown'} name=${engineProc?.name || 'langomonEscript'}`,
      sourceTimestamp: engineProc?.uptime || null,
      observedAt: new Date(nowMs).toISOString(),
      parserStatus: missing.length > 0 ? 'incomplete' : 'ok',
      freshness: engineProc?.status === 'online' ? 'current_process' : 'process_not_online_or_unknown',
    },
  };
}

function summarizeCandidateDiagnostics(records, nowMs = Date.now(), source = 'fixture') {
  const parsed = (records || []).filter((record) => record && typeof record === 'object');
  const cutoff = nowMs - 60 * 60_000;
  const recent = parsed.filter((record) => {
    const timestamp = Date.parse(record.timestamp);
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= nowMs + 1_000;
  });
  const successfulPaperPlacements = recent.filter((record) => (
    record.source === 'gabagool_successful_paper_placement' && record.paperPlacementSucceeded !== false
  ));
  const blockerCounts = {};
  for (const record of successfulPaperPlacements) {
    if (record.finalEligibility === true) continue;
    const blocker = String(record.stage5EligibilityBlocker || record.candidateWriterBlocker || 'unknown');
    blockerCounts[blocker] = (blockerCounts[blocker] || 0) + 1;
  }
  const dominantCandidateBlocker = Object.entries(blockerCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  const latest = [...successfulPaperPlacements].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] || null;
  return {
    recentSuccessfulPaperPlacements: successfulPaperPlacements.length,
    stage5SizingEvaluatedPlacements: successfulPaperPlacements.filter((record) => (
      record.stage5SizingEvaluated === true || record.adjustedStage5SizeUsd !== undefined
    )).length,
    stage5EligiblePlacements: successfulPaperPlacements.filter((record) => record.finalEligibility === true).length,
    stage5IneligiblePlacements: successfulPaperPlacements.filter((record) => record.finalEligibility !== true).length,
    stage5SizingResizedPlacements: successfulPaperPlacements.filter((record) => (
      (record.stage5SizingEvaluated === true || record.adjustedStage5SizeUsd !== undefined) && record.wasResized === true
    )).length,
    stage5SizingBlockedPlacements: successfulPaperPlacements.filter((record) => (
      record.finalEligibility !== true && String(record.stage5EligibilityBlocker || record.candidateWriterBlocker || '').includes('size')
    )).length,
    dominantCandidateBlocker,
    latestCandidateSizingExample: latest,
    sourceMetadata: {
      source,
      sourceTimestamp: latest?.timestamp || null,
      parserStatus: 'ok',
      freshness: latest ? 'fresh' : 'no_recent_records',
    },
  };
}

function readCandidateDiagnostics(filePath, nowMs = Date.now()) {
  const resolved = path.resolve(ROOT, String(filePath || './runtime_monitor/stage5_paper_candidate_diagnostics.ndjson'));
  if (!fs.existsSync(resolved)) {
    return {
      recentSuccessfulPaperPlacements: null,
      stage5EligiblePlacements: null,
      stage5SizingEvaluatedPlacements: null,
      stage5IneligiblePlacements: null,
      stage5SizingResizedPlacements: null,
      stage5SizingBlockedPlacements: null,
      dominantCandidateBlocker: null,
      latestCandidateSizingExample: null,
      sourceMetadata: { source: resolved, sourceTimestamp: null, parserStatus: 'unavailable', freshness: 'unavailable' },
    };
  }
  const rows = readTail(resolved, 512 * 1024).split(/\r?\n/).filter(Boolean);
  const records = [];
  let invalidRows = 0;
  for (const row of rows) {
    try {
      records.push(JSON.parse(row));
    } catch {
      invalidRows += 1;
    }
  }
  const summary = summarizeCandidateDiagnostics(records, nowMs, resolved);
  if (invalidRows > 0) summary.sourceMetadata.parserStatus = 'partial';
  summary.sourceMetadata.invalidRows = invalidRows;
  return summary;
}

function readLiveAccountTruthSnapshot(filePath, nowMs = Date.now(), maxAgeMs = DEFAULT_SNAPSHOT_TTL_MS) {
  const resolved = path.resolve(ROOT, String(filePath || './runtime_monitor/polymarket_live_account_truth.json'));
  try {
    if (!fs.existsSync(resolved)) {
      return { available: false, path: resolved, observedAt: null, reconciliation: { fresh: false, blockers: ['LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE'] } };
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const validated = validateCachedSnapshot(parsed, { nowMs, maxAgeMs });
    const snapshot = validated.snapshot || parsed;
    const canaryPolicy = evaluateSingleCanaryBaseline({ snapshot, watcherHealth: snapshot.watcher, nowMs, maxAgeMs, requireWatcher: true });
    return {
      available: true,
      path: resolved,
      ...snapshot,
      readiness: {
        globalOrderHistoryReconciled: snapshot.reconciliation?.orderCountReconciled === true,
        singleCanarySessionEligible: canaryPolicy.eligible,
        scope: SINGLE_CANARY_SCOPE,
        blockers: canaryPolicy.blockers,
      },
    };
  } catch (error) {
    return {
      available: false,
      path: resolved,
      observedAt: null,
      error: error.message,
      reconciliation: { fresh: false, blockers: ['LIVE_ACCOUNT_SNAPSHOT_MALFORMED'] },
    };
  }
}

function findFallbackLogFiles() {
  const candidates = [
    path.join(ROOT, 'moneymaker.log'),
    path.join(ROOT, 'moneymaker_v3.log'),
    path.join(ROOT, 'pm2.log'),
    path.join(ROOT, 'logs', 'moneymaker.log'),
    path.join(ROOT, 'logs', 'moneymaker_v3.log'),
  ];

  for (const dir of [ROOT, path.join(ROOT, 'logs')]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.log')) {
          candidates.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Ignore inaccessible log directories.
    }
  }

  return [...new Set(candidates)].filter((candidate) => {
    const base = path.basename(candidate).toLowerCase();
    return !base.includes('secret') && !base.includes('key') && !base.includes('token');
  });
}

function readManyFiles(paths, maxBytes) {
  let text = '';
  for (const filePath of [...new Set(paths)]) {
    const chunk = readTail(filePath, maxBytes);
    if (chunk) text += `\n${LOG_FILE_BOUNDARY_PREFIX}${filePath}\n${chunk}`;
  }
  return text;
}

function readTail(filePath, maxBytes) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readState(runtimeStateFile = '') {
  const rawStateFile = String(runtimeStateFile || envStr('STATE_FILE', STATE_FILE_DEFAULT) || STATE_FILE_DEFAULT).trim();
  const statePath = path.resolve(ROOT, rawStateFile || STATE_FILE_DEFAULT);
  try {
    const metadata = stateFileMetadata(statePath, rawStateFile);
    if (!fs.existsSync(statePath)) {
      return { available: false, path: statePath, message: 'State file not found.', data: null, metadata };
    }
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return { available: true, path: statePath, message: 'State file loaded.', data, metadata };
  } catch (err) {
    return {
      available: false,
      path: statePath,
      message: `State file unavailable: ${err.message}`,
      data: null,
      metadata: stateFileMetadata(statePath, rawStateFile, err),
    };
  }
}

function getGitInfo() {
  return {
    branch: commandText('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    commit: commandText('git', ['rev-parse', '--short', 'HEAD']) || 'unknown',
  };
}

function stateFileMetadata(statePath, rawStateFile, error = null) {
  try {
    const exists = fs.existsSync(statePath);
    const stat = exists ? fs.statSync(statePath) : null;
    return {
      rawValue: rawStateFile || '',
      resolvedPath: statePath,
      exists,
      sizeBytes: stat?.size ?? 0,
      modifiedAt: stat?.mtime ? stat.mtime.toISOString() : null,
      warning: error ? error.message : null,
    };
  } catch (err) {
    return {
      rawValue: rawStateFile || '',
      resolvedPath: statePath,
      exists: false,
      sizeBytes: 0,
      modifiedAt: null,
      warning: err.message,
    };
  }
}

function buildSettingsStatus(pm2) {
  const runtimeProc = findProcess(pm2.processes || [], 'langomonEscript');
  const runtime = {};
  const envFileSettings = {};
  const mismatches = [];
  for (const key of SETTING_KEYS) {
    runtime[key] = sanitizeValue(key, pm2EnvValue(runtimeProc?.rawPm2Env || {}, key));
    envFileSettings[key] = sanitizeValue(key, fileEnv[key]);
    const runtimeValue = normalizeComparableSetting(runtime[key]);
    const envFileValue = normalizeComparableSetting(envFileSettings[key]);
    if (runtimeValue && envFileValue && runtimeValue !== envFileValue) {
      mismatches.push(`${key}: pm2=${runtimeValue} .env=${envFileValue}`);
    }
  }
  return {
    pm2ProcessName: runtimeProc?.name || 'langomonEscript',
    pm2ProcessId: runtimeProc?.pmId ?? null,
    runtime,
    envFile: envFileSettings,
    mismatches,
  };
}

function sanitizeValue(key, value) {
  if (value === undefined || value === null || value === '') return '';
  if (SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
  return String(value);
}

function normalizeComparableSetting(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function resolveDashboardToken(bindHost) {
  const configured = envRaw('DASHBOARD_TOKEN');
  if (configured && String(configured).trim()) return String(configured).trim();
  if (bindHost !== '0.0.0.0') return '';

  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (existing) return existing;
    }

    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(TOKEN_FILE, 0o600);
    } catch {
      // chmod can be unavailable on some Windows filesystems.
    }
    return token;
  } catch (err) {
    console.error(`Dashboard refused to start: could not create .dashboard_token: ${err.message}`);
    process.exit(1);
  }
}

function normalizePublicUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function defaultPublicUrl(bindHost, bindPort) {
  const urlHost = bindHost === '0.0.0.0' ? firstLanAddress() || os.hostname() : bindHost;
  return `http://${urlHost}:${bindPort}`;
}

function firstLanAddress() {
  let nets;
  try {
    nets = os.networkInterfaces();
  } catch {
    return '';
  }
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '';
}

function parseEnvFile(filePath) {
  const parsed = {};
  try {
    if (!fs.existsSync(filePath)) return parsed;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      parsed[match[1]] = stripEnvQuotes(match[2].trim());
    }
  } catch {
    return parsed;
  }
  return parsed;
}

function stripEnvQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function envRaw(key) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
  return fileEnv[key];
}

function pm2EnvValue(pm2Env, key) {
  if (!pm2Env || typeof pm2Env !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(pm2Env, key)) return pm2Env[key];
  if (pm2Env.env && Object.prototype.hasOwnProperty.call(pm2Env.env, key)) return pm2Env.env[key];
  return '';
}

function envStr(key, fallback) {
  const value = envRaw(key);
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function envInt(key, fallback) {
  const value = Number.parseInt(envStr(key, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

function commandText(command, args) {
  const result = runCommand(command, args, { timeout: 3000 });
  return result.ok ? result.stdout.trim() : '';
}

function runCommand(command, args, options = {}) {
  const commands = process.platform === 'win32' ? [command, `${command}.cmd`] : [command];
  for (const candidate of commands) {
    try {
      const stdout = childProcess.execFileSync(candidate, args, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: options.timeout || 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout, message: 'ok' };
    } catch (err) {
      if (candidate === commands[commands.length - 1]) {
        return { ok: false, stdout: '', message: err.message };
      }
    }
  }
  return { ok: false, stdout: '', message: 'command unavailable' };
}

function renderHtml(status) {
  status = normalizeStatusForRender(status);
  const p = status.portfolio;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoneyMaker Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; background: #f6f7f8; }
    h1, h2 { margin: 0 0 12px; }
    section { margin: 0 0 18px; padding: 16px; background: #fff; border: 1px solid #ddd; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { text-align: left; border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #eee; }
    pre { white-space: pre-wrap; word-break: break-word; background: #111; color: #eee; padding: 12px; overflow: auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .metric { border: 1px solid #ddd; padding: 10px; background: #fafafa; }
    .label { color: #555; font-size: 12px; text-transform: uppercase; }
    .value { font-size: 20px; margin-top: 4px; }
    .value.good { color: #0a0; }
    .value.warn { color: #b85c00; }
    .value.critical { color: #c00; }
    .alert { padding: 10px 14px; margin: 4px 0; border-left: 3px solid; border-radius: 2px; }
    .alert.critical { background: #fff0f0; border-color: #c00; color: #c00; }
    .alert.warn { background: #fff8f0; border-color: #b85c00; color: #b85c00; }
    .alert.note { background: #f0f8ff; border-color: #36c; color: #36c; }
    .bucket-label { font-size: 11px; color: #666; padding: 2px 6px; background: #f0f0f0; border-radius: 3px; margin: 2px 0; display: inline-block; }
  </style>
  <script>setTimeout(function () { window.location.reload(); }, 10000);</script>
</head>
<body>
  <h1>MoneyMaker Dashboard</h1>
  <section><strong>Data timestamp:</strong> ${escapeHtml(status.dataTimestamp || 'unknown')} &nbsp; <strong>Data status:</strong> ${escapeHtml(status.dataStatus || 'unknown')}</section>
  ${renderOperatorSummary(status)}
  ${renderActionNeeded(status)}
  ${renderLiveAccountTruth(status)}
  <section>
    <h2>Portfolio</h2>
    <div class="grid">
      ${metric('Equity', money(p.equity))}
      ${metric('Cash', money(p.cash))}
      ${metric('Drawdown', pct(p.drawdownPct))}
      ${metric('Total Historical Closed PnL', money(p.closedPnl))}
      ${metric('State-File Closed PnL', money(p.historicalStateFilePnl))}
      ${metric('Retained Fill-History Strategy PnL', money(p.retainedFillHistoryClosedPnl))}
      ${metric('Trusted Retained Closed PnL', money(p.trustedClosedPnl))}
      ${metric('Untrusted Retained Closed PnL', money(p.untrustedClosedPnl))}
      ${metric('Legacy/Unattributed Historical PnL', money(p.legacyOrUnattributedHistoricalPnl))}
      ${metric('Retained PnL Classification Difference', money(p.unreconciledPnl))}
      ${metric('Trusted Open PnL', money(p.trustedOpenPnl))}
      ${metric('Untrusted Open PnL', money(p.untrustedOpenPnl))}
      ${metric('BTC/Gabagool Closed', money(p.btcGabagoolClosedPnl))}
      ${metric('SpreadHunter Closed', money(p.spreadHunterClosedPnl))}
      ${metric('Total Position Exposure', money(p.positionExposureUsd))}
      ${metric('Open Order Exposure', money(p.openOrderExposureUsd))}
      ${metric('Active/Tradable Exposure', money(p.tradableExposureUsd))}
      ${metric('Stale/Non-Tradable Exposure (overlapping aggregate)', money(p.staleExposureUsd))}
      ${metric('Cap-Blocking Exposure', money(p.capBlockingExposureUsd))}
      ${metric('Resolved BTC 5m Awaiting Settlement', money(p.expiredBtc5mExposureUsd))}
      ${metric('Resolution-Pending Cost Exposure (non-cap-blocking)', money(p.resolutionPendingExposureUsd))}
      ${metric('Verified Resolved/Dead Exposure (overlapping aggregate)', money(p.excludedDeadExposureUsd))}
      ${metric('Other Exclusive Exposure (404)', money(p.otherClassifiedExposureUsd))}
      ${metric('Unreconciled Exposure', money(p.unreconciledExposureUsd))}
      ${metric('Paper Cash Reserve', money(p.deadExposureCashReserveOutstandingUsd))}
      ${metric('Dust Exposure (overlapping aggregate)', money(p.dustExposureUsd))}
      ${metric('Open Orders', intVal(p.openOrders))}
      ${metric('Ghost Favorable', pct(p.ghostFavorablePct))}
    </div>
    <p><strong>Exposure reconciliation:</strong> active/tradable, stale-no-bid, confirmed-404, resolved-awaiting-settlement, and resolution-pending are mutually exclusive buckets. Resolution-pending cost remains persisted and excluded from reliable equity, but does not block normal paper entry caps while definitive payout evidence is unavailable. Stale, excluded-dead, and dust totals are overlapping informational aggregates and are not added again.</p>
    <p><strong>PnL attribution:</strong> retained fill-history PnL is classified into trusted and untrusted components. Historical PnL outside the retained fill history is shown separately and is not treated as an accounting error.</p>
    ${renderExposureCapNote(status)}
    <p>${escapeHtml(p.stateMessage)}</p>
  </section>
  <section>
    <h2>Execution Realism</h2>
    <div class="grid">
      ${metric('Avg Fill Delay Ms', p.avgFillDelayMs == null && Number(p.paperOrdersFilledLastHour) === 0 ? 'no recent fills' : display(p.avgFillDelayMs))}
      ${metric('Zero-Second Fills', intVal(p.zeroSecondFillCountLastHour))}
      ${metric('Invalid/Untrusted Fills', intVal(p.invalidUntrustedFillCountLastHour))}
      ${metric('Trusted Fills', intVal(p.trustedFillCountLastHour))}
      ${metric('Untrusted Fills', intVal(p.untrustedFillCountLastHour))}
      ${metric('Blocked Loss Exits', intVal(p.blockedLossExitCountLastHour))}
      ${metric('Repeated Loss Blocks', intVal(p.repeatedBlockedLossExitCountLastHour))}
      ${metric('Repeat Same Token/Market', intVal(p.repeatedSameMarketSameTokenEntriesLastHour))}
      ${metric('Tradable Positions', reportedInt(p.tradableExposureCount))}
      ${metric('Stale Positions', reportedInt(p.staleExposureCount))}
      ${metric('Dust Positions', reportedInt(p.dustExposureCount))}
      ${metric('Fill Sources', p.fillCountsBySource || 'n/a')}
      ${metric('Strategy Orders 1h', p.strategyOrdersLastHour || 'n/a')}
    </div>
    <p>${escapeHtml(p.latestFillAudit || 'No audited fill found in the latest portfolio report.')}</p>
  </section>
  <section>
    <h2>Strategy Blocks</h2>
    <div class="grid">
      ${metric('SpreadHunter Ghost', intVal(p.spreadHunterGhostBlocksLastHour))}
      ${metric('SpreadHunter Sophie', intVal(p.spreadHunterSophieBlocksLastHour))}
      ${metric('SpreadHunter Confidence', intVal(p.spreadHunterConfidenceBlocksLastHour))}
      ${metric('SpreadHunter Cooldown', intVal(p.spreadHunterCooldownBlocksLastHour))}
      ${metric('SpreadHunter Realism', intVal(p.spreadHunterExecutionRealismBlocksLastHour))}
      ${metric('Dominant Oracle Pre-Candidate Block', p.dominantOracleNotConfirmedReasonLastHour || 'none')}
      ${metric('Oracle Not-Confirmed Reasons 1h', p.oracleNotConfirmedReasonsLastHour || 'none')}
      ${metric('Probation Admissions', intVal(p.probationAdmissionsLastHour))}
      ${metric('Probation Blocks', intVal(p.probationBlocksLastHour))}
      ${metric('Live Safety', p.liveSafety || 'n/a')}
    </div>
    ${renderBlockReasonBuckets(p.topBlockReasonsLastHour)}
  </section>
  <section>
    <h2>Paper Flow</h2>
    <div class="grid">
      ${metric('Orders Placed 1h', intVal(p.paperOrdersPlacedLastHour))}
      ${metric('Process-Uptime Orders', intVal(p.processUptimeOrdersLastHour))}
      ${metric('Wall-Clock Log Orders', intVal(p.wallClockLogOrdersLastHour))}
      ${metric('Process-Uptime Fills', intVal(p.processUptimeFillsLastHour))}
      ${metric('Wall-Clock Log Fills', intVal(p.wallClockLogFillsLastHour))}
      ${metric('Uptime < 1h Window', boolVal(p.processUptimeLessThanRequestedWindow))}
      ${metric('Orders Placed 15m', intVal(p.paperOrdersPlacedLast15m))}
      ${metric('Fills 15m', intVal(p.paperOrdersFilledLast15m))}
      ${metric('Action Rate', p.actionRateStatus || 'n/a')}
      ${metric('Action Rate Reason', p.actionRateReason || 'n/a')}
      ${metric('Probation Before Risk', intVal(p.probationAdmissionsBeforeRisk))}
      ${metric('Probation Drawdown Blocks', intVal(p.probationOrdersBlockedByDrawdown))}
      ${metric('Final Blocker After Probation', p.finalBlockerAfterProbation || 'n/a')}
      ${metric('Drawdown Gate Active', boolVal(p.drawdownGateActive))}
      ${metric('Sophie Admitted But Risk Blocked', intVal(p.sophieAdmittedButRiskBlockedLastHour))}
      ${metric('Why Total Orders Zero', p.whyTotalOrdersZeroLastHour || 'n/a')}
      ${metric('Gabagool Exit Blocks', p.gabagoolExitBlocks || 'n/a')}
      ${metric('Gabagool Last Decision', p.gabagoolLastPlacementDecision || 'n/a')}
    </div>
  </section>
  ${renderCandidateDiagnostics(status)}
  <section>
    <h2>Burn-In</h2>
    <div class="grid">
      ${metric('Lifecycle Status', p.burnInLifecycleStatusFromLogs || p.burnInLifecycleStatus || 'n/a')}
      ${metric('Lifecycle Reason', p.burnInLifecycleReason || 'n/a')}
      ${metric('Fresh State Required', boolVal(p.burnInFreshStateRequired))}
      ${metric('Suggested Fresh State', p.burnInFreshStateRequired === true ? (p.recommendedFreshStateFileFromLogs || p.recommendedFreshStateFile || 'not reported') : 'not required')}
      ${metric('State Profile Status', p.stateProfileStatus || 'n/a')}
    </div>
  </section>
  <section>
    <h2>Loss Guard</h2>
    <div class="grid">
      ${metric('Configured Closed Loss', money(p.lossGuardConfiguredClosedLossUsd))}
      ${metric('Current Closed Loss', money(p.lossGuardCurrentClosedLossUsd))}
      ${metric('Cooldown Remaining Ms', intVal(p.lossGuardCooldownRemainingMs))}
      ${metric('Recovery Eligible', boolVal(p.lossGuardRecoveryEligible))}
      ${metric('Recovery Active', boolVal(p.lossGuardRecoveryActive))}
      ${metric('Blocked Reason', p.lossGuardRecoveryBlockedReason || 'n/a')}
      ${metric('Trigger Source', p.lossGuardTriggerSource || 'n/a')}
    </div>
  </section>
  <section>
    <h2>Gabagool Drawdown</h2>
    <div class="grid">
      ${metric('Entries Before Breach', intVal(p.gabagoolEntriesBeforeDrawdownBreach))}
      ${metric('Avg Entry Before Breach', money(p.gabagoolAverageEntryPriceBeforeDrawdownBreach))}
      ${metric('Last Exit Classification', p.gabagoolDrawdownLastExitClassification || 'n/a')}
      ${metric('Loss Guard Too Late', boolVal(p.gabagoolLossGuardTriggeredTooLate))}
      ${metric('Repeated Entries Blocked', boolVal(p.gabagoolRepeatedEntriesAlreadyBlocked))}
      ${metric('Loss Per Market/Token', p.gabagoolLossPerMarketToken || 'n/a')}
    </div>
  </section>
  <section>
    <h2>State File</h2>
    <div class="grid">
      ${metric('Active STATE_FILE', status.stateFile.rawValue || 'n/a')}
      ${metric('Resolved Path', status.stateFile.resolvedPath || 'n/a')}
      ${metric('Exists', status.stateFile.exists ? 'true' : 'false')}
      ${metric('Size Bytes', intVal(status.stateFile.sizeBytes))}
      ${metric('Modified At', status.stateFile.modifiedAt || 'n/a')}
      ${metric('PM2 Process', 'pm_id=' + intVal(status.settings.pm2ProcessId) + ' name=' + escapeHtml(status.settings.pm2ProcessName))}
    </div>
    <p>${escapeHtml(status.stateFile.warning || p.stateMessage)}</p>
    ${renderList(p.stateWarnings)}
  </section>
  <section>
    <h2>PM2</h2>
    <p>${escapeHtml(status.pm2.message)}</p>
    ${renderPm2Table(status.pm2.processes)}
  </section>
  <details>
    <summary>PM2 Runtime Settings</summary>
    ${renderKeyValueTable(status.settings.runtime)}
  </details>
  <details>
    <summary>.env Settings</summary>
    ${renderKeyValueTable(status.settings.envFile)}
  </details>
  <section>
    <h2>Settings Mismatch</h2>
    ${renderList(status.settings.mismatches)}
  </section>
  <section>
    <h2>Latest Portfolio Report</h2>
    <pre>${escapeHtml(renderPortfolioReportText(status.latestPortfolioReport))}</pre>
  </section>
  <details>
    <summary>Data Source Metadata</summary>
    <pre>${escapeHtml(JSON.stringify(status.sourceMetadata, null, 2))}</pre>
  </details>
  <section>
    <h2>Important Logs</h2>
    <p>${escapeHtml(status.logs.message)}</p>
    <pre>${escapeHtml(status.logs.importantLines.join('\n') || 'No important log lines found.')}</pre>
  </section>
</body>
</html>`;
}

function renderOperatorSummary(status) {
  const p = status.portfolio;
  const liveSafe = status.liveSafetyProfile?.status === 'LIVE_LOCKED_OFF';
  const logText = status.logs.importantLines.join(' ');
  const hasRuntimeError = logText.includes('ReferenceError');

  // Derive bot status from PM2 process list
  const botProc = (status.pm2.processes || []).find((proc) => proc.name === 'langomonEscript');
  let botStatusLabel = 'UNKNOWN';
  let botStatusClass = 'warn';
  if (botProc) {
    const pm2Status = String(botProc.status || '').toLowerCase();
    if (pm2Status === 'online') {
      botStatusLabel = 'ONLINE';
      botStatusClass = 'good';
    } else if (pm2Status === 'stopped' || pm2Status === 'stopping') {
      botStatusLabel = pm2Status.toUpperCase();
      botStatusClass = 'warn';
    } else if (pm2Status === 'errored' || pm2Status === 'error') {
      botStatusLabel = 'ERRORED';
      botStatusClass = 'critical';
    } else {
      botStatusLabel = pm2Status.toUpperCase() || 'UNKNOWN';
      botStatusClass = 'warn';
    }
  }

  return `<section>
    <h2>Operator Summary</h2>
    <div class="grid">
      ${metric('Bot Status', botStatusLabel, botStatusClass)}
      ${metric('Live Safety', liveSafe ? 'SAFE (live off)' : (status.liveSafetyProfile?.status || 'UNKNOWN_SAFETY_STATUS'), liveSafe ? 'good' : 'critical')}
      ${metric('Runtime Error', hasRuntimeError ? 'DETECTED' : 'NONE', hasRuntimeError ? 'critical' : 'good')}
      ${metric('Orders Last Hour', intVal(p.paperOrdersPlacedLastHour))}
      ${metric('Fills Last Hour', intVal(p.paperOrdersFilledLastHour))}
      ${metric('Fills', intVal(p.trustedFillCountLastHour) + ' trusted / ' + intVal(p.untrustedFillCountLastHour) + ' untrusted')}
      ${metric('Strategy Orders 1h', p.strategyOrdersLastHour || 'n/a')}
      ${metric('Tradable Exposure', money(p.tradableExposureUsd))}
      ${metric('Expired/Excluded Exposure', money(p.excludedDeadExposureUsd))}
      ${metric('Cap-Blocking Stale Exposure', money(p.staleNoBidExposureUsd))}
      ${metric('Dust Exposure', money(p.dustExposureUsd))}
      ${metric('Open Orders', intVal(p.openOrders))}
      ${metric('Drawdown', pct(p.drawdownPct))}
    </div>
  </section>`;
}

function renderActionNeeded(status) {
  const p = status.portfolio;
  const items = [];
  let actionRequired = false;
  const logText = status.logs.importantLines.join(' ');
  const hasRuntimeError = logText.includes('ReferenceError');

  if (hasRuntimeError) {
    items.push('<div class="alert critical">CRITICAL: ReferenceError detected in current logs. Restart after applying patch.</div>');
    actionRequired = true;
  }
  for (const warning of p.consistencyWarnings || []) {
    items.push(`<div class="alert warn">DATA WARNING: ${escapeHtml(warning)}</div>`);
    actionRequired = true;
  }
  for (const warning of status.availabilityWarnings || []) {
    items.push(`<div class="alert warn">UNAVAILABLE DATA: ${escapeHtml(warning)}</div>`);
    actionRequired = true;
  }
  for (const notice of status.availabilityNotices || []) {
    items.push(`<div class="alert note">INFORMATIONAL: ${escapeHtml(notice)}. Live trading is locked off, so paper status is unaffected.</div>`);
  }
  const capBlockingStaleUsd = numberOrNull(p.staleNoBidExposureUsd);
  if (capBlockingStaleUsd !== null && capBlockingStaleUsd > 0) {
    items.push('<div class="alert warn">WARNING: Cap-blocking stale/non-tradable exposure ' + money(capBlockingStaleUsd) + ' requires market-data review.</div>');
    actionRequired = true;
  }
  const resolutionPendingUsd = numberOrNull(p.resolutionPendingExposureUsd);
  if (resolutionPendingUsd !== null && resolutionPendingUsd > 0) {
    items.push('<div class="alert note">INFORMATIONAL: Resolution-pending cost exposure ' + money(resolutionPendingUsd) + ' remains persisted, excluded from reliable equity, and non-cap-blocking until definitive payout evidence is verified.</div>');
  }
  const excludedDeadUsd = numberOrNull(p.excludedDeadExposureUsd);
  if (excludedDeadUsd !== null && excludedDeadUsd > 0) {
    items.push('<div class="alert note">INFORMATIONAL: ' + money(excludedDeadUsd) + ' verified resolved/dead exposure awaits settlement processing and is excluded from cap-blocking arithmetic.</div>');
  }
  const zeroSec = Number(p.zeroSecondFillCountLastHour);
  const trusted = Number(p.trustedFillCountLastHour);
  if (Number.isFinite(zeroSec) && zeroSec > 0 && Number.isFinite(trusted) && trusted > 0) {
    items.push('<div class="alert note">NOTE: ' + intVal(zeroSec) + ' trusted zero-second fill(s). Crossed bid/ask fills are exempt from PAPER_FILL_MIN_DELAY_MS (instant executable orders).</div>');
  }
  if (items.length > 0) {
    return '<section><h2>' + (actionRequired ? 'Action Needed' : 'Status Notices') + '</h2>' + items.join('') + '</section>';
  }
  return '';
}

function renderExposureCapNote(status) {
  const p = status.portfolio;
  const positionUsd = numberOrNull(p.positionExposureUsd);
  const tradableUsd = numberOrNull(p.tradableExposureUsd);
  const classifiedUsd = numberOrNull(p.classifiedExposureUsd);
  const excludedDeadUsd = numberOrNull(p.excludedDeadExposureUsd);
  if (positionUsd === null || positionUsd <= 0 || tradableUsd === null) return '';
  const nonTradableUsd = positionUsd - tradableUsd;
  const classifiedText = classifiedUsd === null ? '' : ' Mutually exclusive buckets total ' + money(classifiedUsd) + '.';
  const overlapText = excludedDeadUsd !== null && excludedDeadUsd > 0
    ? ' Excluded-dead ' + money(excludedDeadUsd) + ' is an overlapping aggregate and is not counted again.'
    : '';
  return '<div class="alert note">Total position exposure ' + money(positionUsd) + ' = active/tradable ' + money(tradableUsd) + ' + non-tradable primary buckets ' + money(nonTradableUsd) + '.' + classifiedText + overlapText + '</div>';
}

function renderLiveAccountTruth(status) {
  const truth = asObject(status.liveAccountTruth);
  const reconciliation = asObject(truth.reconciliation);
  const readiness = asObject(truth.readiness);
  const lockedOff = status.liveSafetyProfile?.status === 'LIVE_LOCKED_OFF';
  if (truth.available !== true && lockedOff) {
    const snapshotStatus = truth.error ? 'malformed or unavailable' : 'unavailable';
    return `<section>
      <h2>Live Account Truth</h2>
      <div class="alert note">Live-account truth is ${snapshotStatus}. It is not required for paper dashboard accounting while live trading is locked off.</div>
      <div class="grid">
        ${metric('Snapshot Status', snapshotStatus)}
        ${metric('Required In Current Mode', 'no — live trading locked off')}
        ${metric('Single-Canary Readiness', 'unavailable while live is locked off')}
      </div>
      <p><strong>Live-account blockers:</strong> ${escapeHtml(toTextList(reconciliation.blockers, ['LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE']).join(', '))}</p>
      <p><strong>Single-canary blockers:</strong> ${escapeHtml(toTextList(readiness.blockers, ['SINGLE_CANARY_READINESS_UNAVAILABLE']).join(', '))}</p>
    </section>`;
  }
  return `<section>
    <h2>Live Account Truth</h2>
    <div class="grid">
      ${metric('Snapshot Timestamp', truth.observedAt || 'unknown')}
      ${metric('Snapshot Age Ms', reconciliation.snapshotAgeMs ?? 'unknown')}
      ${metric('Snapshot Fresh', boolVal(reconciliation.fresh))}
      ${metric('Trust Status', reconciliation.trustStatus || 'unknown')}
      ${metric('Authenticated Components Complete', boolVal(reconciliation.authenticatedComponentsComplete))}
      ${metric('Public Address Components Complete', boolVal(reconciliation.publicAddressScopedComponentsComplete))}
      ${metric('Account Identity Match', boolVal(truth.account?.identityMatches))}
      ${metric('Wallet Type', truth.account?.resolvedWalletType || 'unknown')}
      ${metric('Positions Exposure', money(truth.positions?.exposureUsd))}
      ${metric('Positions Source Trust', truth.positions?.publicAddressScoped ? 'public address-scoped, identity-bound' : 'unknown')}
      ${metric('Open BUY Exposure', money(truth.openOrders?.remainingBuyExposureUsd))}
      ${metric('Open Orders Source Trust', truth.openOrders?.authenticated ? 'authenticated CLOB, identity-bound' : 'unknown')}
      ${metric('Reduce-Only SELL Notional', money(truth.openOrders?.reduceOnlySellNotionalUsd))}
      ${metric('Total Reconciled Live Exposure', money(truth.totals?.liveExposureUsd))}
      ${metric('Exposure Reconciled', boolVal(reconciliation.exposureReconciled))}
      ${metric('Daily Realized Live PnL', money(truth.totals?.dailyRealizedPnlUsd))}
      ${metric('Daily PnL Reconciled', boolVal(reconciliation.dailyPnlReconciled))}
      ${metric('Submitted Orders Last Hour', intVal(truth.totals?.ordersLastHour))}
      ${metric('Order Count Reconciled', boolVal(reconciliation.orderCountReconciled))}
      ${metric('Global Order History Reconciled', boolVal(readiness.globalOrderHistoryReconciled))}
      ${metric('Single Canary Eligible', boolVal(readiness.singleCanarySessionEligible))}
      ${metric('Eligibility Scope', readiness.scope || 'unavailable')}
      ${metric('Collateral Balance', money(truth.collateral?.balanceUsd))}
    </div>
    <p><strong>Blockers:</strong> ${escapeHtml(toTextList(reconciliation.blockers).join(', ') || 'none')}</p>
    <p><strong>Single-canary blockers:</strong> ${escapeHtml(toTextList(readiness.blockers).join(', ') || 'none')}</p>
  </section>`;
}

function renderCandidateDiagnostics(status) {
  const p = status.portfolio;
  const diagnostics = asObject(status.candidateDiagnostics);
  const sourceMetadata = asObject(diagnostics.sourceMetadata);
  const values = [
    p.recentSuccessfulPaperPlacements,
    p.stage5SizingEvaluatedPlacements,
    p.stage5EligiblePlacements,
    p.stage5IneligiblePlacements,
    p.stage5SizingResizedPlacements,
    p.stage5SizingBlockedPlacements,
    p.dominantCandidateBlocker,
    p.latestCandidateSizingExample,
  ];
  const unavailable = sourceMetadata.parserStatus === 'unavailable'
    || values.every((value) => value === undefined || value === null || value === '');
  if (unavailable) {
    return `<section>
      <h2>Stage 5 Paper Candidate Diagnostics</h2>
      <div class="alert note">Candidate diagnostics were not reported. This optional diagnostic source does not affect paper portfolio accounting.</div>
    </section>`;
  }
  return `<section>
    <h2>Stage 5 Paper Candidate Diagnostics</h2>
    <p>Paper placement and Stage 5 live-canary eligibility are separate results. A successful paper order may remain correctly ineligible for live canary.</p>
    <div class="grid">
      ${metric('Recent Successful Paper Placements', intVal(p.recentSuccessfulPaperPlacements))}
      ${metric('Authoritative Stage 5 Gabagool Confidence Floor', renderNumber(resolveStage5GabagoolConfidenceFloor(), 2))}
      ${metric('Stage 5 Live Sizing Evaluated', intVal(p.stage5SizingEvaluatedPlacements))}
      ${metric('Stage 5 Live Size Adjustments', intVal(p.stage5SizingResizedPlacements))}
      ${metric('Stage 5 Live-Canary Eligible', intVal(p.stage5EligiblePlacements))}
      ${metric('Stage 5 Live-Canary Ineligible', intVal(p.stage5IneligiblePlacements))}
      ${metric('Sizing-Specific Blockers', intVal(p.stage5SizingBlockedPlacements))}
      ${metric('Dominant Live-Canary Blocker', p.dominantCandidateBlocker || 'none reported')}
    </div>
    <pre>${escapeHtml(p.latestCandidateSizingExample ? JSON.stringify(p.latestCandidateSizingExample, null, 2) : 'No candidate sizing example reported.')}</pre>
  </section>`;
}

function renderPortfolioReportText(lines) {
  const visible = [];
  let expiredDetailLines = 0;
  let positionDetailLines = 0;
  for (const line of toTextList(lines)) {
    if (line.includes('[GABAGOOL PAPER EXPIRED EXPOSURE EXCLUDED]')) {
      expiredDetailLines += 1;
      continue;
    }
    if (/\[INFO\]\s+POS\s+/.test(line)) {
      positionDetailLines += 1;
      continue;
    }
    visible.push(line);
  }
  if (expiredDetailLines > 0 || positionDetailLines > 0) {
    visible.push(`[dashboard condensed ${expiredDetailLines} repetitive expired-exposure detail line(s) and ${positionDetailLines} per-position detail line(s); aggregate totals remain above]`);
  }
  return visible.join('\n') || 'No portfolio report found in available logs.';
}

const BLOCK_BUCKETS = {
  'no_position': 'strategy/no_position',
  'outside_tail_window': 'strategy/outside_tail_window',
  'disabled': 'strategy/disabled',
  'missing_complement_sibling': 'strategy/missing_complement_sibling',
  'edge_below_required': 'strategy/edge_below_required',
  'repeat_cooldown': 'sophie/repeat_cooldown',
  'low_quality': 'sophie/low_quality',
  'sophie_blocked': 'sophie/low_quality',
  'stale_token_cooldown': 'gabagool/stale_token_cooldown',
  '404_no_orderbook': 'gabagool/404_no_orderbook',
  'btc_bucket_exposure': 'risk/btc_bucket_exposure',
  'risk_blocked': 'risk/btc_bucket_exposure',
  'no_orderbook_404': 'gabagool/404_no_orderbook',
  'risk_position_cap': 'risk/btc_bucket_exposure',
  'risk_total_exposure_cap': 'risk/btc_bucket_exposure',
  'valid_but_risk_or_execution_blocked': 'risk/btc_bucket_exposure',
};

function groupBlockReasons(rawString) {
  if (!rawString || rawString === 'none') return [];
  const buckets = {};
  const parts = String(rawString).split(/\s*,\s*/);
  for (const part of parts) {
    const [reasonMatch, countMatch] = part.split(':');
    const reason = String(reasonMatch || '').trim();
    const count = parseInt(String(countMatch || '').trim(), 10);
    if (!reason || !Number.isFinite(count)) continue;
    const bucket = BLOCK_BUCKETS[reason] || 'other/' + reason;
    if (!buckets[bucket]) buckets[bucket] = { count: 0, reasons: [] };
    buckets[bucket].count += count;
    buckets[bucket].reasons.push(`${reason}:${count}`);
  }
  return Object.entries(buckets).sort((a, b) => b[1].count - a[1].count);
}

function renderBlockReasonBuckets(rawString) {
  const grouped = groupBlockReasons(rawString);
  if (grouped.length === 0) return '';
  return '<div>' + grouped.map(function ([bucket, info]) {
    return '<span class="bucket-label">' + escapeHtml(bucket) + ': ' + info.count + ' (' + escapeHtml(info.reasons.join(', ')) + ')</span>';
  }).join('<br>') + '</div>';
}

function renderPm2Table(processes) {
  if (!Array.isArray(processes) || processes.length === 0) return '<p>No rows.</p>';
  const columns = ['name', 'pmId', 'status', 'restartCount', 'unstableRestarts', 'uptime', 'memoryBytes', 'cpuPct'];
  const formatCell = (col, value) => {
    if (value === undefined || value === null) return 'n/a';
    if (col === 'memoryBytes') return mb(value);
    if (col === 'cpuPct') return cpuPct(value);
    if (col === 'restartCount' || col === 'unstableRestarts' || col === 'pmId') return intVal(value);
    return display(value);
  };
  return `<table><thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead><tbody>${
    processes.map((row) => `<tr>${columns.map((col) => `<td>${escapeHtml(formatCell(col, row[col]))}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

function metric(label, value, className = '') {
  const valClass = className ? 'value ' + className : 'value';
  return '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="' + valClass + '">' + escapeHtml(display(value)) + '</div></div>';
}

function renderTable(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columns)) return '<p>No rows.</p>';
  return `<table><thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((col) => `<td>${escapeHtml(display(row[col]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderKeyValueTable(obj) {
  const rows = Object.entries(asObject(obj)).map(([key, value]) => ({ key, value }));
  return renderTable(rows, ['key', 'value']);
}

function renderList(items) {
  const normalized = toTextList(items);
  if (normalized.length === 0) return '<p>No mismatches detected.</p>';
  return `<ul>${normalized.map((item) => `<li>${escapeHtml(display(item))}</li>`).join('')}</ul>`;
}

function normalizeStatusForRender(value) {
  const status = asObject(value);
  const portfolio = asObject(status.portfolio);
  const settings = asObject(status.settings);
  const logs = asObject(status.logs);
  const pm2 = asObject(status.pm2);
  return {
    ...status,
    portfolio: {
      ...portfolio,
      consistencyWarnings: toTextList(portfolio.consistencyWarnings),
      stateWarnings: toTextList(portfolio.stateWarnings),
    },
    stateFile: asObject(status.stateFile),
    settings: {
      ...settings,
      runtime: asObject(settings.runtime),
      envFile: asObject(settings.envFile),
      mismatches: toTextList(settings.mismatches),
    },
    pm2: { ...pm2, processes: Array.isArray(pm2.processes) ? pm2.processes : [] },
    liveSafetyProfile: asObject(status.liveSafetyProfile),
    liveAccountTruth: asObject(status.liveAccountTruth),
    candidateDiagnostics: asObject(status.candidateDiagnostics),
    sourceMetadata: asObject(status.sourceMetadata),
    latestPortfolioReport: toTextList(status.latestPortfolioReport),
    availabilityWarnings: toTextList(status.availabilityWarnings),
    availabilityNotices: toTextList(status.availabilityNotices),
    logs: {
      ...logs,
      sourceFiles: toTextList(logs.sourceFiles),
      importantLines: toTextList(logs.importantLines),
    },
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toTextList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === undefined || value === null || value === '') return [...fallback];
  return [String(value)];
}

function sendHtml(res, html) {
  sendText(res, 200, html, 'text/html; charset=utf-8');
}

function sendJson(res, statusCode, data) {
  sendText(res, statusCode, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');
}

function sendText(res, statusCode, body, contentType) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function renderNumber(value, digits) {
  if (value === undefined || value === null || value === '') return 'unknown';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : 'unknown';
}

function intVal(value) {
  if (value === undefined || value === null || value === '') return 'unknown';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : 'unknown';
}

function reportedInt(value) {
  return value === undefined || value === null || value === '' ? 'not reported' : intVal(value);
}

function boolVal(value) {
  if (value === undefined || value === null || value === '') return 'unknown';
  return value === true ? 'true' : value === false ? 'false' : 'unknown';
}

function money(value) {
  if (value === undefined || value === null || value === '') return 'unknown';
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : 'unknown';
}

function pct(value) {
  if (value === undefined || value === null || value === '') return 'unknown';
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : 'unknown';
}

function mb(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

function cpuPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : 'n/a';
}

function display(value) {
  if (value === undefined || value === null || value === '') return 'unknown';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return renderNumber(value, 2);
  }
  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sumKnown(...values) {
  const normalized = values.map(numberOrNull);
  if (normalized.some((value) => value === null)) return null;
  return normalized.reduce((sum, value) => sum + value, 0);
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i)) return i;
  }
  return -1;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  collectStatus,
  analyzeStateFileUsage,
  buildPortfolioSummary,
  parseLatestPortfolioReport,
  selectLatestPortfolioReportBoundary,
  summarizeOrderFillWindows,
  buildRuntimeSafetyProfile,
  summarizeCandidateDiagnostics,
  readLiveAccountTruthSnapshot,
  buildLogResult,
  renderHtml,
  collectStatusSafely,
  unavailableStatus,
  buildSettingsStatus,
  stateFileMetadata,
  readState,
  getPm2Status,
  createServer,
  startServer,
};
