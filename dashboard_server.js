'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const TOKEN_FILE = path.join(ROOT, '.dashboard_token');
const STATE_FILE_DEFAULT = path.join(ROOT, 'moneymaker_v3_state.json');
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
  'PAPER_TELEGRAM_DIGEST_ENABLED',
  'PAPER_TELEGRAM_DIGEST_EVERY_MS',
  'TELEGRAM_APPROVAL_WATCH_PATHS',
  'DASHBOARD_ENABLED',
  'DASHBOARD_HOST',
  'DASHBOARD_PORT',
  'DASHBOARD_PUBLIC_URL',
];

const fileEnv = parseEnvFile(ENV_FILE);
const host = envStr('DASHBOARD_HOST', '127.0.0.1');
const port = envInt('DASHBOARD_PORT', 18888);
const dashboardEnabled = envStr('DASHBOARD_ENABLED', 'false').toLowerCase() === 'true';
const dashboardToken = resolveDashboardToken(host);
const tokenRequired = host === '0.0.0.0' || dashboardToken.length > 0;
const publicUrl = normalizePublicUrl(envStr('DASHBOARD_PUBLIC_URL', defaultPublicUrl(host, port)));

function createServer() {
  return http.createServer((req, res) => {
    try {
      routeRequest(req, res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'dashboard_error', message: err.message });
    }
  });
}

function startServer() {
  if (!dashboardEnabled) {
    console.error('Dashboard refused to start: DASHBOARD_ENABLED must be true.');
    process.exit(1);
  }
  const server = createServer();
  server.listen(port, host, () => {
    const displayUrl = dashboardToken
      ? `${publicUrl}/?token=${encodeURIComponent(dashboardToken)}`
      : `${publicUrl}/`;
    console.log(`Dashboard URL: ${displayUrl}`);
  });
  return server;
}

function routeRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!isAuthorized(url)) {
    sendText(res, 401, 'Unauthorized\n', 'text/plain; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, renderHtml(collectStatus()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, collectStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logs') {
    const status = collectStatus();
    sendText(res, 200, status.logs.importantLines.join('\n') + '\n', 'text/plain; charset=utf-8');
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
}

function isAuthorized(url) {
  if (!tokenRequired) return true;
  return url.searchParams.get('token') === dashboardToken;
}

function collectStatus() {
  const pm2 = getPm2Status();
  const settings = buildSettingsStatus(pm2);
  const logs = getLogs(pm2);
  const state = readState(settings.runtime.STATE_FILE || settings.envFile.STATE_FILE || '');
  const report = parseLatestPortfolioReport(logs.allLines);
  const portfolio = buildPortfolioSummary(state, report);
  const publicPm2 = {
    ...pm2,
    processes: (pm2.processes || []).map(({ rawPm2Env, ...proc }) => proc),
  };

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    server: {
      time: new Date().toString(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
    },
    git: getGitInfo(),
    pm2: publicPm2,
    stateFile: state.metadata,
    portfolio,
    latestPortfolioReport: report.lines,
    settings,
    logs: {
      source: logs.source,
      message: logs.message,
      importantLines: logs.importantLines.slice(-50),
    },
  };
}

function buildPortfolioSummary(state, report) {
  const stateSummary = summarizeState(state);
  return {
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
    paperOrdersPlacedLastHour: numberOrNull(report.paperOrdersPlacedLastHour),
    paperOrdersFilledLastHour: numberOrNull(report.paperOrdersFilledLastHour),
    probationAdmissionsLastHour: numberOrNull(report.probationAdmissionsLastHour),
    probationBlocksLastHour: numberOrNull(report.probationBlocksLastHour),
    topBlockReasonsLastHour: report.topBlockReasonsLastHour || '',
    whyTotalOrdersZeroLastHour: report.whyTotalOrdersZeroLastHour || '',
    strategyOrdersLastHour: report.strategyOrdersLastHour || '',
    liveSafety: report.liveSafety || '',
    latestFillAudit: report.latestFillAudit || '',
    source: report.lines.length > 0 ? 'logs' : stateSummary.source,
    stateFile: state.path,
    stateAvailable: state.available,
    stateMessage: state.message,
    stateExists: state.metadata.exists,
    stateFileSizeBytes: state.metadata.sizeBytes,
    stateFileModifiedAt: state.metadata.modifiedAt,
  };
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
  let positionExposureUsd = 0;

  for (const [tokenId, qtyRaw] of Object.entries(positions)) {
    const qty = Number(qtyRaw);
    const avg = Number(costBasis[tokenId]);
    if (Number.isFinite(qty) && qty > 0 && Number.isFinite(avg) && avg > 0) {
      positionExposureUsd += qty * avg;
    }
  }

  const cash = numberOrNull(data.cash);
  const equity = cash === null ? null : cash + positionExposureUsd;
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

function parseLatestPortfolioReport(lines) {
  const start = findLastIndex(lines, (line) => line.includes('--- PORTFOLIO REPORT ---'));
  if (start < 0) return emptyReport();

  const reportLines = lines.slice(start, Math.min(lines.length, start + 80));
  const report = emptyReport();
  report.lines = reportLines;

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

    match = line.match(/SpreadHunter Blocks:\s*ghost=(\d+)\s*sophie=(\d+)\s*confidence=(\d+)\s*cooldown=(\d+)\s*executionRealism=(\d+)/);
    if (match) {
      report.spreadHunterGhostBlocksLastHour = Number(match[1]);
      report.spreadHunterSophieBlocksLastHour = Number(match[2]);
      report.spreadHunterConfidenceBlocksLastHour = Number(match[3]);
      report.spreadHunterCooldownBlocksLastHour = Number(match[4]);
      report.spreadHunterExecutionRealismBlocksLastHour = Number(match[5]);
      continue;
    }

    match = line.match(/Paper Flow:\s*totalOrders=(\d+)\s*whyTotalOrdersZero=(.*?)\s+topBlockReasons=(.*?)\s+probationAdmissions=(\d+)\s+probationBlocks=(\d+)/);
    if (match) {
      report.paperOrdersPlacedLastHour = Number(match[1]);
      report.whyTotalOrdersZeroLastHour = match[2];
      report.topBlockReasonsLastHour = match[3];
      report.probationAdmissionsLastHour = Number(match[4]);
      report.probationBlocksLastHour = Number(match[5]);
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
    paperOrdersPlacedLastHour: null,
    paperOrdersFilledLastHour: null,
    probationAdmissionsLastHour: null,
    probationBlocksLastHour: null,
    topBlockReasonsLastHour: '',
    whyTotalOrdersZeroLastHour: '',
    strategyOrdersLastHour: '',
    liveSafety: '',
    latestFillAudit: '',
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
    return buildLogResult('pm2', 'Read recent PM2 log files.', pm2Text);
  }

  const fallbackPaths = findFallbackLogFiles();
  const fallbackText = readManyFiles(fallbackPaths, 256 * 1024);
  if (fallbackText.length > 0) {
    return buildLogResult('local-files', 'Read recent local log files.', fallbackText);
  }

  return buildLogResult('unavailable', 'No PM2 or local safe log files were available.', '');
}

function buildLogResult(source, message, text) {
  const allLines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const importantLines = allLines.filter((line) => IMPORTANT_LOG_PATTERNS.some((pattern) => line.includes(pattern)));

  return {
    source,
    message,
    allLines,
    importantLines: importantLines.slice(-50),
  };
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
    if (chunk) text += `\n${chunk}`;
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
  ${renderOperatorSummary(status)}
  ${renderActionNeeded(status)}
  <section>
    <h2>Portfolio</h2>
    <div class="grid">
      ${metric('Equity', money(p.equity))}
      ${metric('Cash', money(p.cash))}
      ${metric('Drawdown', pct(p.drawdownPct))}
      ${metric('Closed PnL', money(p.closedPnl))}
      ${metric('Trusted Closed PnL', money(p.trustedClosedPnl))}
      ${metric('Untrusted Closed PnL', money(p.untrustedClosedPnl))}
      ${metric('Trusted Open PnL', money(p.trustedOpenPnl))}
      ${metric('Untrusted Open PnL', money(p.untrustedOpenPnl))}
      ${metric('BTC/Gabagool Closed', money(p.btcGabagoolClosedPnl))}
      ${metric('SpreadHunter Closed', money(p.spreadHunterClosedPnl))}
      ${metric('Position Exposure', money(p.positionExposureUsd))}
      ${metric('Open Order Exposure', money(p.openOrderExposureUsd))}
      ${metric('Tradable Exposure', money(p.tradableExposureUsd))}
      ${metric('Stale Exposure', money(p.staleExposureUsd))}
      ${metric('Cap-Blocking Exposure', money(p.capBlockingExposureUsd))}
      ${metric('Expired BTC 5m Exposure', money(p.expiredBtc5mExposureUsd))}
      ${metric('Excluded Dead Exposure', money(p.excludedDeadExposureUsd))}
      ${metric('Paper Cash Reserve', money(p.deadExposureCashReserveOutstandingUsd))}
      ${metric('Dust Exposure', money(p.dustExposureUsd))}
      ${metric('Open Orders', intVal(p.openOrders))}
      ${metric('Ghost Favorable', pct(p.ghostFavorablePct))}
    </div>
    ${renderExposureCapNote(status)}
    <p>${escapeHtml(p.stateMessage)}</p>
  </section>
  <section>
    <h2>Execution Realism</h2>
    <div class="grid">
      ${metric('Avg Fill Delay Ms', display(p.avgFillDelayMs))}
      ${metric('Zero-Second Fills', intVal(p.zeroSecondFillCountLastHour))}
      ${metric('Invalid/Untrusted Fills', intVal(p.invalidUntrustedFillCountLastHour))}
      ${metric('Trusted Fills', intVal(p.trustedFillCountLastHour))}
      ${metric('Untrusted Fills', intVal(p.untrustedFillCountLastHour))}
      ${metric('Blocked Loss Exits', intVal(p.blockedLossExitCountLastHour))}
      ${metric('Repeated Loss Blocks', intVal(p.repeatedBlockedLossExitCountLastHour))}
      ${metric('Repeat Same Token/Market', intVal(p.repeatedSameMarketSameTokenEntriesLastHour))}
      ${metric('Tradable Positions', intVal(p.tradableExposureCount))}
      ${metric('Stale Positions', intVal(p.staleExposureCount))}
      ${metric('Dust Positions', intVal(p.dustExposureCount))}
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
      ${metric('Why Total Orders Zero', p.whyTotalOrdersZeroLastHour || 'n/a')}
      ${metric('Gabagool Exit Blocks', p.gabagoolExitBlocks || 'n/a')}
      ${metric('Gabagool Last Decision', p.gabagoolLastPlacementDecision || 'n/a')}
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
    <pre>${escapeHtml(status.latestPortfolioReport.join('\n') || 'No portfolio report found in available logs.')}</pre>
  </section>
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
  const liveSafe = String(p.liveSafety || '').includes('ENABLE_LIVE_TRADING=false');
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
      ${metric('Live Safety', liveSafe ? 'SAFE (live off)' : 'CHECK LIVE FLAGS', liveSafe ? 'good' : 'critical')}
      ${metric('Runtime Error', hasRuntimeError ? 'DETECTED' : 'NONE', hasRuntimeError ? 'critical' : 'good')}
      ${metric('Orders Last Hour', intVal(p.paperOrdersPlacedLastHour))}
      ${metric('Fills Last Hour', intVal(p.paperOrdersFilledLastHour))}
      ${metric('Fills', intVal(p.trustedFillCountLastHour) + ' trusted / ' + intVal(p.untrustedFillCountLastHour) + ' untrusted')}
      ${metric('Strategy Orders 1h', p.strategyOrdersLastHour || 'n/a')}
      ${metric('Tradable Exposure', money(p.tradableExposureUsd))}
      ${metric('Stale Exposure', money(p.staleExposureUsd))}
      ${metric('Dust Exposure', money(p.dustExposureUsd))}
      ${metric('Open Orders', intVal(p.openOrders))}
      ${metric('Drawdown', pct(p.drawdownPct))}
    </div>
  </section>`;
}

function renderActionNeeded(status) {
  const p = status.portfolio;
  const items = [];
  const logText = status.logs.importantLines.join(' ');
  const hasRuntimeError = logText.includes('ReferenceError');

  if (hasRuntimeError) {
    items.push('<div class="alert critical">CRITICAL: ReferenceError detected in current logs. Restart after applying patch.</div>');
  }
  const staleUsd = Number(p.staleExposureUsd);
  if (Number.isFinite(staleUsd) && staleUsd > 0) {
    items.push('<div class="alert warn">WARNING: Stale exposure ' + money(p.staleExposureUsd) + ' — markets may be expired or in cooldown. Bot will self-clear.</div>');
  }
  const zeroSec = Number(p.zeroSecondFillCountLastHour);
  const trusted = Number(p.trustedFillCountLastHour);
  if (Number.isFinite(zeroSec) && zeroSec > 0 && Number.isFinite(trusted) && trusted > 0) {
    items.push('<div class="alert note">NOTE: ' + intVal(zeroSec) + ' trusted zero-second fill(s). Crossed bid/ask fills are exempt from PAPER_FILL_MIN_DELAY_MS (instant executable orders).</div>');
  }
  if (items.length > 0) {
    return '<section><h2>Action Needed</h2>' + items.join('') + '</section>';
  }
  return '';
}

function renderExposureCapNote(status) {
  const p = status.portfolio;
  const positionUsd = Number(p.positionExposureUsd);
  const tradableUsd = Number(p.tradableExposureUsd);
  const staleUsd = Number(p.staleExposureUsd);
  if (!Number.isFinite(positionUsd) || positionUsd <= 0) return '';
  if (!Number.isFinite(staleUsd) || staleUsd <= 0) return '';
  return '<p class="warn">Position Exposure=' + money(positionUsd) + ' includes ' + money(staleUsd) + ' stale. Tradable exposure=' + money(tradableUsd) + '.</p>';
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
  const parts = rawString.split(/\s*,\s*/);
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
  if (!processes || processes.length === 0) return '<p>No rows.</p>';
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
  if (!rows || rows.length === 0) return '<p>No rows.</p>';
  return `<table><thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((col) => `<td>${escapeHtml(display(row[col]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderKeyValueTable(obj) {
  const rows = Object.entries(obj).map(([key, value]) => ({ key, value }));
  return renderTable(rows, ['key', 'value']);
}

function renderList(items) {
  if (!items || items.length === 0) return '<p>No mismatches detected.</p>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(display(item))}</li>`).join('')}</ul>`;
}

function sendHtml(res, html) {
  sendText(res, 200, html, 'text/html; charset=utf-8');
}

function sendJson(res, statusCode, data) {
  sendText(res, statusCode, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function renderNumber(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function intVal(value) {
  if (value === undefined || value === null || value === '') return 'n/a';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : 'n/a';
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : 'n/a';
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : 'n/a';
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
  if (value === undefined || value === null || value === '') return 'n/a';
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
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(...values) {
  for (const value of values) {
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
  buildSettingsStatus,
  stateFileMetadata,
  readState,
  getPm2Status,
  createServer,
  startServer,
};
