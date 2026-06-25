#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { CONFIG } = require('../moneymaker_v3');
const {
  readConfig: readLiveConfig,
  probeHostReachable,
  probeRpcReachable,
  secretFileStatus,
  REQUIRED_LIVE_SECRET_ENV,
  REQUIRED_FUNDER_ENV,
} = require('../live_adapter_polymarket');
const { readConfig: readTelegramConfig } = require('../telegram/telegram_approval_bot');

const ROOT = process.cwd();
const REQUIRED_PM2 = {
  langomonEscript: ['langomonEscript'],
  liveIntentRouter: ['liveIntentRouter'],
  telegramApprovalBot: ['telegramApprovalBot'],
  moneyMakerDashboard: ['moneyMakerDashboard', 'langomon-dashboard'],
};

function loadEnvFile(filePath) {
  if (!localEnvFileReadEnabled()) return;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return;

  const raw = fs.readFileSync(resolved, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function localEnvFileReadEnabled() {
  const raw = String(
    process.env.MM_SKIP_LOCAL_ENV_FILE ||
    process.env.SKIP_LOCAL_ENV_FILE ||
    ''
  ).trim().toLowerCase();
  return !['1', 'true', 'yes', 'on'].includes(raw);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function dashboardHealthCommand() {
  const publicUrl = normalizeBaseUrl(process.env.DASHBOARD_PUBLIC_URL);
  if (publicUrl) return `curl -s ${publicUrl}/health`;

  const host = String(process.env.DASHBOARD_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = Number.parseInt(process.env.DASHBOARD_PORT || '18888', 10);
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `curl -s http://${displayHost}:${Number.isFinite(port) ? port : 18888}/health`;
}

function runCommand(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout || 5000,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ? String(error.stdout) : '',
      stderr: error.stderr ? String(error.stderr) : error.message,
    };
  }
}

function readPm2List() {
  const result = runCommand('pm2', ['jlist']);
  if (!result.ok) {
    const stderr = result.stderr || '';
    const concise = stderr.includes('EROFS')
      ? 'pm2 unavailable in restricted filesystem sandbox'
      : stderr.split(/\r?\n/).find(Boolean) || 'pm2 jlist failed';
    return { ok: false, processes: [], error: concise };
  }
  try {
    return { ok: true, processes: JSON.parse(result.stdout), error: null };
  } catch (error) {
    return { ok: false, processes: [], error: `pm2 jlist parse failed: ${error.message}` };
  }
}

function tailLines(filePath, maxLines = 500) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch (_) {
    return [];
  }
}

function tailPm2Logs(processName, maxLines = 500) {
  const result = runCommand('pm2', ['logs', processName, '--lines', String(maxLines), '--nostream'], { timeout: 8000 });
  if (!result.ok) return [];
  const keepPatterns = [
    /--- PORTFOLIO REPORT ---/,
    /--- BTC ORACLE \/ GABAGOOL REPORT ---/,
    /Execution Health:/,
    /Paper Flow:/,
    /Pipeline 1h:/,
    /Fill Realism:/,
    /Exposure Audit:/,
    /Exposure Buckets:/,
    /Last Decisions:/,
    /Gabagool Health:/,
    /Gabagool Exit Blocks:/,
    /\[ORDER\]/,
    /\[FILL\]/,
    /\[RESEARCH REFRESH/,
  ];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(line) || keepPatterns.some((pattern) => pattern.test(line)));
}

function mergeTailLines(...sets) {
  const seen = new Set();
  const out = [];
  for (const set of sets) {
    for (const line of set || []) {
      if (!line || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

function lineTimestampMs(line) {
  const match = String(line || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  if (!match) return NaN;
  return Date.parse(match[0]);
}

function linesSince(lines, sinceMs) {
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return lines;
  return lines.filter((line) => {
    const ts = lineTimestampMs(line);
    return Number.isFinite(ts) && ts >= sinceMs;
  });
}

function parseLastNumber(lines, pattern) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(pattern);
    if (match) return Number(match[1]);
  }
  return NaN;
}

function parseLastExecutionHealth(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('Execution Health:')) continue;
    const get = (key) => {
      const match = line.match(new RegExp(`${key}=([0-9.]+)%?`));
      return match ? Number(match[1]) : NaN;
    };
    return {
      candidateEvaluationsLastHour: get('candidateEvaluationsLastHour'),
      paperOrdersPlacedLastHour: get('paperOrdersPlacedLastHour'),
      paperOrdersFilledLastHour: get('paperOrdersFilledLastHour'),
      paperOrdersExpiredNoFillLastHour: get('paperOrdersExpiredNoFillLastHour'),
      paperOrdersAdmittedLastHour: get('paperOrdersAdmittedLastHour'),
      paperOrdersRejectedBySophieLastHour: get('paperOrdersRejectedBySophieLastHour'),
      ordersPlacedLastHour: get('ordersPlacedLastHour'),
      fillsLastHour: get('fillsLastHour'),
      duplicateSkipsLastHour: get('duplicateSkipsLastHour'),
      replacementsLastHour: get('replacementsLastHour'),
      oldestOpenOrderAgeSec: get('oldestOpenOrderAgeSec'),
      avgOpenOrderAgeSec: get('avgOpenOrderAgeSec'),
      noFillStreakMax: get('noFillStreakMax'),
      avgTimeToFillSec: get('avgTimeToFillSec'),
      maxOpenOrderBlocksLastHour: get('maxOpenOrderBlocksLastHour'),
      fillRateLastHour: get('fillRateLastHour'),
      fillRateByPlacedOrdersLastHour: get('fillRateByPlacedOrdersLastHour'),
      activePaperOrders: get('activePaperOrders'),
      avgActiveOrderAgeSec: get('avgActiveOrderAgeSec'),
    };
  }
  return {};
}

function parseKeyValueLine(line) {
  const out = {};
  const regex = /([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g;
  let match;
  while ((match = regex.exec(String(line || '')))) {
    const key = match[1];
    const raw = match[2];
    const cleaned = raw.replace(/^\$/, '').replace(/%$/, '');
    if (cleaned === 'true') out[key] = true;
    else if (cleaned === 'false') out[key] = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) out[key] = Number(cleaned);
    else out[key] = raw;
  }
  return out;
}

function parseLastKeyValueLine(lines, prefix) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes(prefix)) continue;
    return {
      line,
      ts: lineTimestampMs(line),
      values: parseKeyValueLine(line),
    };
  }
  return null;
}

function countRecent(lines, pattern, now = Date.now(), windowMs = 60 * 60_000) {
  let count = 0;
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    const ts = lineTimestampMs(line);
    if (Number.isFinite(ts) && now - ts <= windowMs) count += 1;
  }
  return count;
}

function boolStatus(value, expected) {
  return { value, expected, ok: value === expected };
}

function recentMatchingLines(lines, pattern, now = Date.now(), windowMs = 10 * 60_000) {
  return lines.filter((line) => {
    if (!pattern.test(line)) return false;
    const ts = lineTimestampMs(line);
    return Number.isFinite(ts) && now - ts <= windowMs;
  });
}

function lastTimedLine(lines, pattern) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!pattern.test(line)) continue;
    const ts = lineTimestampMs(line);
    if (Number.isFinite(ts)) return { line, ts };
  }
  return null;
}

function latestTs(...events) {
  const times = events.map((event) => event?.ts).filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

async function main() {
  loadEnvFile(path.join(ROOT, '.env'));

  const reasons = [];
  const pm2 = readPm2List();
  const byName = new Map(pm2.processes.map((proc) => [proc.name, proc]));
  const pm2Checks = {};

  if (!pm2.ok) {
    reasons.push(`pm2 status unavailable: ${pm2.error}`);
  }

  for (const [name, aliases] of Object.entries(REQUIRED_PM2)) {
    const proc = aliases.map((alias) => byName.get(alias)).find(Boolean);
    const online = proc?.pm2_env?.status === 'online';
    pm2Checks[name] = online ? 'online' : 'missing_or_not_online';
    if (!online) reasons.push(`${name} is not online`);
  }

  const engineProc = byName.get('langomonEscript');
  const engineLogPath = engineProc?.pm2_env?.pm_out_log_path || path.join(process.env.HOME || '', '.pm2/logs/langomonEscript-out.log');
  const engineErrorLogPath = engineProc?.pm2_env?.pm_err_log_path || path.join(process.env.HOME || '', '.pm2/logs/langomonEscript-error.log');
  const engineFileLines = tailLines(engineLogPath, 1000);
  const enginePm2Lines = tailPm2Logs('langomonEscript', 1000);
  const pm2HasFreshReport = enginePm2Lines.some((line) => /--- PORTFOLIO REPORT ---|--- BTC ORACLE \/ GABAGOOL REPORT ---/.test(line));
  const engineLines = (pm2HasFreshReport ? enginePm2Lines : mergeTailLines(engineFileLines, enginePm2Lines)).slice(-1500);
  const engineErrorLines = tailLines(engineErrorLogPath, 300);
  const pmUptime = Number(engineProc?.pm2_env?.pm_uptime || 0);
  const uptimeSec = pmUptime > 0 ? Math.max(0, Math.round((Date.now() - pmUptime) / 1000)) : null;
  const linesSinceUptime = linesSince(engineLines, pmUptime);
  const currentEngineLines = pm2HasFreshReport ? engineLines : (linesSinceUptime.length > 0 ? linesSinceUptime : engineLines.slice(-600));
  const currentEngineErrorLines = linesSince(engineErrorLines, pmUptime);
  const portfolioReportFreshMs = Number.parseInt(process.env.LIVE_READINESS_PORTFOLIO_FRESH_MS || '900000', 10);
  const lastPortfolioReport = lastTimedLine(currentEngineLines, /--- PORTFOLIO REPORT ---|--- BTC ORACLE \/ GABAGOOL REPORT ---/);
  const recentPortfolioReportFound = Boolean(
    lastPortfolioReport && Date.now() - lastPortfolioReport.ts <= (Number.isFinite(portfolioReportFreshMs) ? portfolioReportFreshMs : 900_000)
  );
  const openOrders = parseLastNumber(currentEngineLines, /Open Orders:\s+(\d+)/);
  const drawdownPct = parseLastNumber(currentEngineLines, /Drawdown:\s+([0-9.]+)%/);
  const openOrderExposureUsd = parseLastNumber(currentEngineLines, /Open Order Exposure:\s+\$([0-9.]+)/);
  const totalExposureUsd = parseLastNumber(currentEngineLines, /Open Orders:\s+\d+\s+\|\s+Exposure:\s+\$([0-9.]+)/);
  const executionHealth = parseLastExecutionHealth(currentEngineLines);
  const pipelineReport = parseLastKeyValueLine(currentEngineLines, 'Pipeline 1h:');
  const paperFlowReport = parseLastKeyValueLine(currentEngineLines, 'Paper Flow:');
  const actionRateReport = parseLastKeyValueLine(currentEngineLines, 'Action Rate 15m:');
  const fillRealismReport = parseLastKeyValueLine(currentEngineLines, 'Fill Realism:');
  const exposureAuditReport = parseLastKeyValueLine(currentEngineLines, 'Exposure Audit:');
  const exposureBucketsReport = parseLastKeyValueLine(currentEngineLines, 'Exposure Buckets:');
  const lastDecisionsReport = parseLastKeyValueLine(currentEngineLines, 'Last Decisions:');
  const gabagoolHealthReport = parseLastKeyValueLine(currentEngineLines, 'Gabagool Health:');
  const gabagoolExitBlocksReport = parseLastKeyValueLine(currentEngineLines, 'Gabagool Exit Blocks:');
  const fillsLastHour = Number.isFinite(executionHealth.fillsLastHour)
    ? executionHealth.fillsLastHour
    : Number.isFinite(pipelineReport?.values?.fills)
      ? pipelineReport.values.fills
      : Number.isFinite(fillRealismReport?.values?.trustedFills) || Number.isFinite(fillRealismReport?.values?.untrustedFills)
        ? (Number(fillRealismReport?.values?.trustedFills || 0) + Number(fillRealismReport?.values?.untrustedFills || 0))
        : countRecent(currentEngineLines, /\[FILL\]/);
  const candidateEvaluationsLastHour = Number.isFinite(executionHealth.candidateEvaluationsLastHour)
    ? executionHealth.candidateEvaluationsLastHour
    : Number.isFinite(pipelineReport?.values?.candidates)
      ? pipelineReport.values.candidates
      : Number.isFinite(gabagoolHealthReport?.values?.gabagoolCandidatesBuiltLastHour)
        ? gabagoolHealthReport.values.gabagoolCandidatesBuiltLastHour
        : countRecent(currentEngineLines, /\[SOPHIE ORDER QUALITY\]|\[SOPHIE CALIBRATED ADMIT\]|\[SOPHIE BOOTSTRAP ADMIT\]/);
  const paperOrdersAdmittedLastHour = Number.isFinite(executionHealth.paperOrdersAdmittedLastHour)
    ? executionHealth.paperOrdersAdmittedLastHour
    : Number.isFinite(pipelineReport?.values?.sophieAdmit)
      ? pipelineReport.values.sophieAdmit
    : countRecent(currentEngineLines, /\[SOPHIE ORDER QUALITY\].*decision=ADMIT|\[SOPHIE CALIBRATED ADMIT\]|\[SOPHIE BOOTSTRAP ADMIT\]/);
  const paperOrdersFilledLastHour = Number.isFinite(executionHealth.paperOrdersFilledLastHour)
    ? executionHealth.paperOrdersFilledLastHour
    : fillsLastHour;
  const paperOrdersExpiredNoFillLastHour = Number.isFinite(executionHealth.paperOrdersExpiredNoFillLastHour)
    ? executionHealth.paperOrdersExpiredNoFillLastHour
    : countRecent(currentEngineLines, /\[ORDER REPLACE\]/);
  const paperOrdersRejectedBySophieLastHour = Number.isFinite(executionHealth.paperOrdersRejectedBySophieLastHour)
    ? executionHealth.paperOrdersRejectedBySophieLastHour
    : Number.isFinite(pipelineReport?.values?.sophieBlock)
      ? pipelineReport.values.sophieBlock
    : countRecent(currentEngineLines, /\[SOPHIE ORDER QUALITY\].*BLOCK_LOW_QUALITY|\[SOPHIE EXECUTION THROTTLE\]/);
  const paperOrdersPlacedLastHour = Number.isFinite(executionHealth.paperOrdersPlacedLastHour)
    ? executionHealth.paperOrdersPlacedLastHour
    : Number.isFinite(paperFlowReport?.values?.totalOrders)
      ? paperFlowReport.values.totalOrders
      : Number.isFinite(pipelineReport?.values?.orders)
        ? pipelineReport.values.orders
        : (Number.isFinite(executionHealth.ordersPlacedLastHour) ? executionHealth.ordersPlacedLastHour : countRecent(currentEngineLines, /\[ORDER\]/));
  const ordersPlacedLastHour = paperOrdersPlacedLastHour;
  const duplicateSkipsLastHour = Number.isFinite(executionHealth.duplicateSkipsLastHour) ? executionHealth.duplicateSkipsLastHour : countRecent(currentEngineLines, /\[ORDER SKIP DUPLICATE\]/);
  const maxOpenOrderBlocksLastHour = Number.isFinite(executionHealth.maxOpenOrderBlocksLastHour)
    ? executionHealth.maxOpenOrderBlocksLastHour
    : countRecent(currentEngineLines, /\[SOPHIE SLOT BLOCK\]|block=max_open_orders/);
  const fillRateLastHour = Number.isFinite(executionHealth.fillRateLastHour) ? executionHealth.fillRateLastHour : (ordersPlacedLastHour > 0 ? (fillsLastHour / ordersPlacedLastHour) * 100 : 0);
  const noFillStreakMax = Number.isFinite(executionHealth.noFillStreakMax) ? executionHealth.noFillStreakMax : 0;
  const avgTimeToFillSec = Number.isFinite(executionHealth.avgTimeToFillSec) ? executionHealth.avgTimeToFillSec : null;
  const fillRateByPlacedOrdersLastHour = Number.isFinite(executionHealth.fillRateByPlacedOrdersLastHour)
    ? executionHealth.fillRateByPlacedOrdersLastHour
    : fillRateLastHour;
  const activePaperOrders = Number.isFinite(executionHealth.activePaperOrders)
    ? executionHealth.activePaperOrders
    : (Number.isFinite(openOrders) ? openOrders : 0);
  const oldestOpenOrderAgeSec = Number.isFinite(executionHealth.oldestOpenOrderAgeSec) ? executionHealth.oldestOpenOrderAgeSec : 0;
  const avgOpenOrderAgeSec = Number.isFinite(executionHealth.avgOpenOrderAgeSec) ? executionHealth.avgOpenOrderAgeSec : 0;
  const avgActiveOrderAgeSec = Number.isFinite(executionHealth.avgActiveOrderAgeSec) ? executionHealth.avgActiveOrderAgeSec : avgOpenOrderAgeSec;
  const ordersPlacedLast15m = Number.isFinite(actionRateReport?.values?.ordersPlacedLast15m)
    ? actionRateReport.values.ordersPlacedLast15m
    : Number.isFinite(executionHealth.paperOrdersPlacedLast15m)
      ? executionHealth.paperOrdersPlacedLast15m
      : 0;
  const fillsLast15m = Number.isFinite(actionRateReport?.values?.fillsLast15m)
    ? actionRateReport.values.fillsLast15m
    : Number.isFinite(executionHealth.paperOrdersFilledLast15m)
      ? executionHealth.paperOrdersFilledLast15m
      : 0;
  const targetOrdersPer15m = Number.isFinite(actionRateReport?.values?.targetOrdersPer15m)
    ? actionRateReport.values.targetOrdersPer15m
    : 0;
  const targetFillsPer15m = Number.isFinite(actionRateReport?.values?.targetFillsPer15m)
    ? actionRateReport.values.targetFillsPer15m
    : 0;
  const actionRateStatus = String(actionRateReport?.values?.status || 'action_rate_not_applicable');
  const actionRateReason = String(actionRateReport?.values?.reason || 'none');
  const trustedFillsLastHour = Number.isFinite(fillRealismReport?.values?.trustedFills)
    ? fillRealismReport.values.trustedFills
    : Number.isFinite(fillRealismReport?.values?.trustedFillCountLastHour)
      ? fillRealismReport.values.trustedFillCountLastHour
      : null;
  const untrustedFillsLastHour = Number.isFinite(fillRealismReport?.values?.untrustedFills)
    ? fillRealismReport.values.untrustedFills
    : Number.isFinite(fillRealismReport?.values?.untrustedFillCountLastHour)
      ? fillRealismReport.values.untrustedFillCountLastHour
      : null;
  const currentPlacementDecision = String(
    lastDecisionsReport?.values?.placementDecision
    || gabagoolExitBlocksReport?.values?.lastPlacementDecision
    || gabagoolHealthReport?.values?.gabagoolLastPlacementDecision
    || 'none'
  );
  const currentPlacementReason = String(
    lastDecisionsReport?.values?.placementBlock
    || gabagoolHealthReport?.values?.gabagoolPlacementBlockReasonLast
    || 'none'
  );
  const reportedPortfolioExposureUsd = Number.isFinite(exposureAuditReport?.values?.portfolioExposureUsd)
    ? exposureAuditReport.values.portfolioExposureUsd
    : totalExposureUsd;
  const reportedCapBlockingExposureUsd = Number.isFinite(exposureAuditReport?.values?.capBlockingExposureUsd)
    ? exposureAuditReport.values.capBlockingExposureUsd
    : totalExposureUsd;
  const excludedDeadExposureUsd = Number.isFinite(exposureAuditReport?.values?.excludedDeadExposureUsd)
    ? exposureAuditReport.values.excludedDeadExposureUsd
    : null;
  const fillProbabilityOverestimated = countRecent(currentEngineLines, /\[SOPHIE FILL PROB CALIBRATED\].*far_from_touch|\[SOPHIE NO-FILL LEARN\]/) > 0;
  const recentStarvationWarning = countRecent(currentEngineLines, /\[ENGINE STARVATION WARNING\]/) > 0;
  const makerOptimizerAdmitsLastHour = countRecent(currentEngineLines, /\[SOPHIE MAKER OPTIMIZER ADMIT\]/);
  const makerOptimizerBlocksLastHour = countRecent(currentEngineLines, /\[SOPHIE MAKER OPTIMIZER BLOCK\]/);
  const unstableRestarts = Number(engineProc?.pm2_env?.unstable_restarts || 0);
  const crashPattern = /Fatal start error|Loop error|uncaughtException|Unhandled|FATAL|SyntaxError|ReferenceError|TypeError|process exited|exited with code/i;
  const recentErrorLines = recentMatchingLines(currentEngineErrorLines, crashPattern);
  const recentExitLines = recentMatchingLines(currentEngineLines, /\b(process exited|exited with code|uncaughtException|Unhandled|Fatal start error)\b/i, Date.now(), 5 * 60_000);
  const recentUnstableRestart = unstableRestarts > 0 && Number.isFinite(uptimeSec) && uptimeSec < 120;
  const crashLoopOk = !engineProc || (engineProc.pm2_env?.status === 'online' && !recentUnstableRestart && recentErrorLines.length === 0 && recentExitLines.length === 0);
  const staleCrashEvidenceIgnored = engineErrorLines.some((line) => crashPattern.test(line)) && recentErrorLines.length === 0;
  const crashLoopEvidence = {
    status: engineProc?.pm2_env?.status || null,
    uptimeSec,
    unstableRestarts,
    recentErrorLines: recentErrorLines.length,
    recentExitLines: recentExitLines.length,
    staleCrashEvidenceIgnored,
  };
  const lastResearchStart = lastTimedLine(currentEngineLines, /\[RESEARCH REFRESH START\]/);
  const lastResearchComplete = lastTimedLine(currentEngineLines, /\[RESEARCH REFRESH COMPLETE\]/);
  const lastResearchFailed = lastTimedLine(currentEngineLines, /\[RESEARCH REFRESH FAILED\]/);
  const lastResearchTimeout = lastTimedLine(currentEngineLines, /\[RESEARCH REFRESH TIMEOUT\]/);
  const lastResearchUnstuck = lastTimedLine(currentEngineLines, /\[RESEARCH REFRESH UNSTUCK\]/);
  const lastResearchTerminalTs = latestTs(lastResearchComplete, lastResearchFailed, lastResearchUnstuck);
  const researchInProgress = Boolean(lastResearchStart && lastResearchStart.ts > lastResearchTerminalTs);
  const researchAgeMs = researchInProgress ? Date.now() - lastResearchStart.ts : 0;
  const researchStuckMs = Math.max(1, Number(CONFIG.researchStuckResetMs || 90_000));
  const researchStuck = researchInProgress && researchAgeMs > researchStuckMs;
  const researchRefresh = {
    lastStartAt: lastResearchStart ? new Date(lastResearchStart.ts).toISOString() : null,
    lastCompleteAt: lastResearchComplete ? new Date(lastResearchComplete.ts).toISOString() : null,
    lastFailedAt: lastResearchFailed ? new Date(lastResearchFailed.ts).toISOString() : null,
    lastTimeoutAt: lastResearchTimeout ? new Date(lastResearchTimeout.ts).toISOString() : null,
    lastUnstuckAt: lastResearchUnstuck ? new Date(lastResearchUnstuck.ts).toISOString() : null,
    inProgress: researchInProgress,
    ageMs: Math.max(0, Math.round(researchAgeMs)),
    stuckMs: researchStuckMs,
    stuck: researchStuck,
  };

  if (!recentPortfolioReportFound) reasons.push('recent portfolio report not found');
  if (researchStuck) reasons.push(`research refresh stuck for ${Math.round(researchAgeMs)}ms`);
  if (lastResearchComplete && candidateEvaluationsLastHour <= 0) reasons.push('candidate evaluations are zero after research completed');
  if (candidateEvaluationsLastHour <= 0) reasons.push(`candidateEvaluationsLastHour ${candidateEvaluationsLastHour} below required > 0`);
  if (paperOrdersPlacedLastHour <= 0) reasons.push('no paper orders occurred during burn-in');
  if (fillsLastHour <= 0) reasons.push('no fills occurred during burn-in');
  if (actionRateStatus === 'action_rate_below_target') {
    reasons.push(
      `action_rate_below_target orders15m=${ordersPlacedLast15m}/${targetOrdersPer15m} ` +
      `fills15m=${fillsLast15m}/${targetFillsPer15m} reason=${actionRateReason}`
    );
  }
  if (!Number.isFinite(openOrders) || openOrders <= 0) reasons.push(`no active paper orders; candidateEvaluationsLastHour=${candidateEvaluationsLastHour} paperOrdersAdmittedLastHour=${paperOrdersAdmittedLastHour} paperOrdersPlacedLastHour=${paperOrdersPlacedLastHour} makerOptimizerAdmitsLastHour=${makerOptimizerAdmitsLastHour} makerOptimizerBlocksLastHour=${makerOptimizerBlocksLastHour}`);
  if (!crashLoopOk) reasons.push('langomonEscript appears to be crash-looping');
  if (Number.isFinite(drawdownPct) && drawdownPct > CONFIG.maxDrawdownPct) reasons.push(`drawdown ${drawdownPct}% exceeds max ${CONFIG.maxDrawdownPct}%`);
  if (Number.isFinite(reportedCapBlockingExposureUsd) && reportedCapBlockingExposureUsd > CONFIG.maxTotalExposureUsd) {
    reasons.push(`capBlockingExposureUsd $${reportedCapBlockingExposureUsd} exceeds cap $${CONFIG.maxTotalExposureUsd}`);
  }
  if (Number.isFinite(openOrderExposureUsd) && openOrderExposureUsd > CONFIG.maxTotalOpenOrderUsd) reasons.push(`open order exposure $${openOrderExposureUsd} exceeds cap $${CONFIG.maxTotalOpenOrderUsd}`);
  if (fillsLastHour < 3) reasons.push(`fillsLastHour ${fillsLastHour} below required 3`);
  if (fillRateLastHour < 1.0) reasons.push(`fillRateLastHour ${fillRateLastHour}% below required 1.0%`);
  if (ordersPlacedLastHour > 150) reasons.push(`ordersPlacedLastHour ${ordersPlacedLastHour} exceeds max 150`);
  if (duplicateSkipsLastHour > 500) reasons.push(`duplicateSkipsLastHour ${duplicateSkipsLastHour} exceeds max 500`);
  if (maxOpenOrderBlocksLastHour > 50) reasons.push(`maxOpenOrderBlocksLastHour ${maxOpenOrderBlocksLastHour} exceeds max 50`);
  if (noFillStreakMax > 3) reasons.push(`noFillStreakMax ${noFillStreakMax} exceeds max 3`);
  if (paperOrdersExpiredNoFillLastHour > Math.max(10, paperOrdersPlacedLastHour)) {
    reasons.push(`paperOrdersExpiredNoFillLastHour ${paperOrdersExpiredNoFillLastHour} is excessive`);
  }
  if (fillProbabilityOverestimated) reasons.push('predicted fill probability overestimated; no-fill learning active');
  if (recentStarvationWarning) reasons.push('recent engine starvation warning detected');

  const liveConfig = readLiveConfig(ROOT);
  const safetyFlags = {
    ENABLE_LIVE_TRADING: boolStatus(liveConfig.enableLiveTrading, false),
    LIVE_AUTO_EXECUTE: boolStatus(liveConfig.liveAutoExecute, false),
    LIVE_KILL_SWITCH: boolStatus(liveConfig.liveKillSwitch, true),
    LIVE_DRY_RUN_ONLY: boolStatus(liveConfig.liveDryRunOnly, true),
    LIVE_SUBMIT_CONFIRM: boolStatus(liveConfig.liveSubmitConfirm, false),
  };

  for (const [name, check] of Object.entries(safetyFlags)) {
    if (!check.ok) reasons.push(`${name} expected ${check.expected} got ${check.value}`);
  }

  const telegramConfig = readTelegramConfig(ROOT);
  const telegramDoctorExists = fs.readFileSync(path.join(ROOT, 'telegram/telegram_approval_bot.js'), 'utf8').includes("command === 'doctor'");
  if (!telegramDoctorExists) reasons.push('telegram doctor command not found');

  const engineSyntax = runCommand(process.execPath, ['--check', 'moneymaker_v3.js']);
  if (!engineSyntax.ok) reasons.push('moneymaker_v3.js syntax check failed');

  const dashboardSyntax = runCommand(process.execPath, ['--check', 'dashboard_server.js']);
  if (!dashboardSyntax.ok) reasons.push('dashboard_server.js syntax check failed');

  // -----------------------------
  // Live final-boss network + auth + signing diagnostics
  // -----------------------------
  const secrets = secretFileStatus(liveConfig);
  const missingSecretEnvNames = REQUIRED_LIVE_SECRET_ENV.filter((name) => !process.env[name]);
  const funderEnvDetected = REQUIRED_FUNDER_ENV.find((name) => process.env[name]) || null;
  const signatureTypeRaw = process.env.POLYMARKET_SIGNATURE_TYPE;
  const signatureType = signatureTypeRaw ? Number(signatureTypeRaw) : null;
  const polygonRpcUrl = process.env.POLYMARKET_RPC_URL || process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

  const clobProbe = await probeHostReachable(liveConfig.clobHost, { healthPath: '/', timeoutMs: 3000 });
  const rpcProbe = await probeRpcReachable(polygonRpcUrl, { timeoutMs: 3000 });

  const routerOracleSignalsAllowed = String(process.env.LIVE_ROUTER_ALLOW_ORACLE_SIGNALS || '').toLowerCase() === 'true';

  if (!secrets.exists) reasons.push('live secrets file missing');
  if (secrets.exists && !secrets.readable) {
    reasons.push(`live secrets file unreadable by current user (${secrets.path}); fix with chown/chmod`);
  }
  if (missingSecretEnvNames.length > 0) {
    reasons.push(`missing live env names: ${missingSecretEnvNames.join(',')}`);
  }
  if (!funderEnvDetected) {
    reasons.push(`no funder env detected from ${REQUIRED_FUNDER_ENV.join(',')}`);
  }
  if (signatureType !== 3) {
    reasons.push(`POLYMARKET_SIGNATURE_TYPE expected 3, got ${signatureTypeRaw || 'unset'}`);
  }
  if (!clobProbe.reachable) reasons.push(`CLOB host unreachable (${clobProbe.error})`);
  if (!rpcProbe.reachable) reasons.push(`Polygon RPC unreachable (${rpcProbe.error})`);
  if (!liveConfig.liveFinalBossReady) reasons.push('LIVE_FINAL_BOSS_READY=false');
  if (!Number.isFinite(liveConfig.liveTradingStage) || liveConfig.liveTradingStage < 1) {
    reasons.push(`LIVE_TRADING_STAGE=${liveConfig.liveTradingStage} (Stage 1+ required for micro-live readiness gate)`);
  }
  // Stage 1 signing-proof status is NOT executed here automatically because it
  // would require LIVE_SIGNING_TEST_ALLOW=true and readable secrets. Operator
  // must run `npm run live:final-boss-selfcheck` after fixing permissions.
  const signingProofKnown = false;
  reasons.push('signing proof not executed in readiness report; run `npm run live:final-boss-selfcheck` to verify');

  const ready = reasons.length === 0;
  const report = {
    READY_FOR_MICRO_LIVE: ready,
    pm2: {
      available: pm2.ok,
      processes: pm2Checks,
    },
    paperEngineHealth: {
      recentPortfolioReportFound,
      lastPortfolioReportAt: lastPortfolioReport ? new Date(lastPortfolioReport.ts).toISOString() : null,
      portfolioReportFreshMs: Number.isFinite(portfolioReportFreshMs) ? portfolioReportFreshMs : 900_000,
      currentProcessLogLines: currentEngineLines.length,
      usedPm2UptimeWindow: linesSinceUptime.length > 0,
      researchRefresh,
      openOrders: Number.isFinite(openOrders) ? openOrders : null,
      activePaperOrders,
      candidateEvaluationsLastHour,
      paperOrdersPlacedLastHour,
      paperOrdersFilledLastHour,
      paperOrdersExpiredNoFillLastHour,
      paperOrdersAdmittedLastHour,
      paperOrdersRejectedBySophieLastHour,
      ordersPlacedLastHour,
      fillsLastHour,
      duplicateSkipsLastHour,
      maxOpenOrderBlocksLastHour,
      fillRateLastHour,
      fillRateByPlacedOrdersLastHour,
      noFillStreakMax,
      oldestOpenOrderAgeSec,
      avgOpenOrderAgeSec,
      avgActiveOrderAgeSec,
      avgTimeToFillSec,
      fillProbabilityOverestimated,
      trustedFillsLastHour,
      untrustedFillsLastHour,
      currentPlacementDecision,
      currentPlacementReason,
      exposureAudit: exposureAuditReport?.values || null,
      exposureBuckets: exposureBucketsReport?.values || null,
      pipeline1h: pipelineReport?.values || null,
      paperFlow: paperFlowReport?.values || null,
      fillRealism: fillRealismReport?.values || null,
      fillsDetected: fillsLastHour > 0,
      makerOptimizerAdmitsLastHour,
      makerOptimizerBlocksLastHour,
      recentStarvationWarning,
      crashLoopOk,
      crashLoopEvidence,
      drawdownPct: Number.isFinite(drawdownPct) ? drawdownPct : null,
      maxDrawdownPct: CONFIG.maxDrawdownPct,
      totalExposureUsd: Number.isFinite(reportedPortfolioExposureUsd) ? reportedPortfolioExposureUsd : null,
      capBlockingExposureUsd: Number.isFinite(reportedCapBlockingExposureUsd) ? reportedCapBlockingExposureUsd : null,
      excludedDeadExposureUsd,
      maxTotalExposureUsd: CONFIG.maxTotalExposureUsd,
      openOrderExposureUsd: Number.isFinite(openOrderExposureUsd) ? openOrderExposureUsd : null,
      maxTotalOpenOrderUsd: CONFIG.maxTotalOpenOrderUsd,
    },
    liveFinalBossGate: {
      configuredReadyFlag: liveConfig.liveFinalBossReady,
      configuredStage: liveConfig.liveTradingStage,
      configuredStageProfile: liveConfig.liveStageProfile || null,
      submitAllowedAtStage: Boolean(liveConfig.liveStageProfile?.submitAllowed),
      canSubmitLive: liveConfig.enableLiveTrading
        && liveConfig.liveAutoExecute
        && !liveConfig.liveKillSwitch
        && !liveConfig.liveDryRunOnly
        && liveConfig.liveFinalBossReady
        && Boolean(liveConfig.liveStageProfile?.submitAllowed)
        && liveConfig.liveSubmitConfirm,
      secretsFilePresent: secrets.exists,
      secretsFileReadable: secrets.readable,
      secretsPath: secrets.path,
      requiredSecretEnvNames: REQUIRED_LIVE_SECRET_ENV,
      missingSecretEnvNames,
      acceptedFunderEnvNames: REQUIRED_FUNDER_ENV,
      funderEnvDetected,
      signatureTypeEnvName: 'POLYMARKET_SIGNATURE_TYPE',
      signatureTypePresent: signatureTypeRaw !== undefined,
      signatureTypeIsThree: signatureType === 3,
      polygonRpcConfigured: Boolean(polygonRpcUrl),
      clobHost: liveConfig.clobHost,
      clobReachable: clobProbe.reachable,
      clobReachableLatencyMs: clobProbe.latencyMs,
      clobReachableError: clobProbe.error,
      clobStatus: clobProbe.status,
      rpcReachable: rpcProbe.reachable,
      rpcReachableLatencyMs: rpcProbe.latencyMs,
      rpcReachableError: rpcProbe.error,
      rpcChainId: rpcProbe.chainId,
      authDryRunExecuted: false,
      authDryRunHint: 'run `node live_adapter_polymarket.js auth-dry-run` to execute full auth+signing proof (requires LIVE_AUTH_CHECK_ALLOW=true LIVE_SIGNING_TEST_ALLOW=true and readable secrets)',
      signingProofExecuted: signingProofKnown,
      signingProofHint: 'run `npm run live:final-boss-selfcheck` for strict end-to-end signing proof; must show signingProofPassed=true and signed=true',
      routerOracleSignalsAllowed,
    },
    safetyFlags,
    telegram: {
      doctorCommandExists: telegramDoctorExists,
      tokenPresent: Boolean(telegramConfig.telegramBotToken),
      chatIdPresent: Boolean(telegramConfig.telegramChatId),
      token: telegramConfig.telegramBotToken ? '[REDACTED]' : '',
      chatId: telegramConfig.telegramChatId ? '[REDACTED]' : '',
      messageSent: false,
    },
    dashboard: {
      syntaxOk: dashboardSyntax.ok,
      processOnline: pm2Checks.moneyMakerDashboard === 'online',
      manualHealthCommand: dashboardHealthCommand(),
    },
    syntax: {
      engineOk: engineSyntax.ok,
      dashboardOk: dashboardSyntax.ok,
    },
    reasons,
  };

  console.log(JSON.stringify(report, null, 2));
  if (ready) {
    console.log('READY_FOR_MICRO_LIVE=true (dry-run review only; live execution still gated by manual env change).');
  }
}

main().catch((err) => {
  console.error(`[LIVE-READINESS ERROR] ${err.stack || err.message}`);
  process.exit(1);
});
