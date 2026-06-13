#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { CONFIG } = require('../moneymaker_v3');
const { readConfig: readLiveConfig } = require('../live_adapter_polymarket');
const { readConfig: readTelegramConfig } = require('../telegram/telegram_approval_bot');

const ROOT = process.cwd();
const REQUIRED_PM2 = ['langomonEscript', 'liveIntentRouter', 'telegramApprovalBot', 'moneyMakerDashboard'];

function loadEnvFile(filePath) {
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

function main() {
  loadEnvFile(path.join(ROOT, '.env'));

  const reasons = [];
  const pm2 = readPm2List();
  const byName = new Map(pm2.processes.map((proc) => [proc.name, proc]));
  const pm2Checks = {};

  if (!pm2.ok) {
    reasons.push(`pm2 status unavailable: ${pm2.error}`);
  }

  for (const name of REQUIRED_PM2) {
    const proc = byName.get(name);
    const online = proc?.pm2_env?.status === 'online';
    pm2Checks[name] = online ? 'online' : 'missing_or_not_online';
    if (!online) reasons.push(`${name} is not online`);
  }

  const engineProc = byName.get('langomonEscript');
  const engineLogPath = engineProc?.pm2_env?.pm_out_log_path || path.join(process.env.HOME || '', '.pm2/logs/langomonEscript-out.log');
  const engineErrorLogPath = engineProc?.pm2_env?.pm_err_log_path || path.join(process.env.HOME || '', '.pm2/logs/langomonEscript-error.log');
  const engineLines = tailLines(engineLogPath, 1000);
  const engineErrorLines = tailLines(engineErrorLogPath, 300);
  const pmUptime = Number(engineProc?.pm2_env?.pm_uptime || 0);
  const uptimeSec = pmUptime > 0 ? Math.max(0, Math.round((Date.now() - pmUptime) / 1000)) : null;
  const currentEngineLines = linesSince(engineLines, pmUptime);
  const currentEngineErrorLines = linesSince(engineErrorLines, pmUptime);
  const portfolioReportFreshMs = Number.parseInt(process.env.LIVE_READINESS_PORTFOLIO_FRESH_MS || '900000', 10);
  const lastPortfolioReport = lastTimedLine(currentEngineLines, /--- PORTFOLIO REPORT ---/);
  const recentPortfolioReportFound = Boolean(
    lastPortfolioReport && Date.now() - lastPortfolioReport.ts <= (Number.isFinite(portfolioReportFreshMs) ? portfolioReportFreshMs : 900_000)
  );
  const openOrders = parseLastNumber(currentEngineLines, /Open Orders:\s+(\d+)/);
  const drawdownPct = parseLastNumber(currentEngineLines, /Drawdown:\s+([0-9.]+)%/);
  const openOrderExposureUsd = parseLastNumber(currentEngineLines, /Open Order Exposure:\s+\$([0-9.]+)/);
  const totalExposureUsd = parseLastNumber(currentEngineLines, /Open Orders:\s+\d+\s+\|\s+Exposure:\s+\$([0-9.]+)/);
  const executionHealth = parseLastExecutionHealth(currentEngineLines);
  const fillsLastHour = Number.isFinite(executionHealth.fillsLastHour) ? executionHealth.fillsLastHour : countRecent(currentEngineLines, /\[FILL\]/);
  const candidateEvaluationsLastHour = Number.isFinite(executionHealth.candidateEvaluationsLastHour)
    ? executionHealth.candidateEvaluationsLastHour
    : countRecent(currentEngineLines, /\[SOPHIE ORDER QUALITY\]|\[SOPHIE CALIBRATED ADMIT\]|\[SOPHIE BOOTSTRAP ADMIT\]/);
  const paperOrdersAdmittedLastHour = Number.isFinite(executionHealth.paperOrdersAdmittedLastHour)
    ? executionHealth.paperOrdersAdmittedLastHour
    : countRecent(currentEngineLines, /\[SOPHIE ORDER QUALITY\].*decision=ADMIT|\[SOPHIE CALIBRATED ADMIT\]|\[SOPHIE BOOTSTRAP ADMIT\]/);
  const paperOrdersFilledLastHour = Number.isFinite(executionHealth.paperOrdersFilledLastHour)
    ? executionHealth.paperOrdersFilledLastHour
    : fillsLastHour;
  const paperOrdersExpiredNoFillLastHour = Number.isFinite(executionHealth.paperOrdersExpiredNoFillLastHour)
    ? executionHealth.paperOrdersExpiredNoFillLastHour
    : countRecent(currentEngineLines, /\[ORDER REPLACE\]/);
  const paperOrdersRejectedBySophieLastHour = Number.isFinite(executionHealth.paperOrdersRejectedBySophieLastHour)
    ? executionHealth.paperOrdersRejectedBySophieLastHour
    : countRecent(currentEngineLines, /\[SOPHIE ORDER QUALITY\].*BLOCK_LOW_QUALITY|\[SOPHIE EXECUTION THROTTLE\]/);
  const paperOrdersPlacedLastHour = Number.isFinite(executionHealth.paperOrdersPlacedLastHour)
    ? executionHealth.paperOrdersPlacedLastHour
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
  if (!Number.isFinite(openOrders) || openOrders <= 0) reasons.push(`no active paper orders; candidateEvaluationsLastHour=${candidateEvaluationsLastHour} paperOrdersAdmittedLastHour=${paperOrdersAdmittedLastHour} paperOrdersPlacedLastHour=${paperOrdersPlacedLastHour} makerOptimizerAdmitsLastHour=${makerOptimizerAdmitsLastHour} makerOptimizerBlocksLastHour=${makerOptimizerBlocksLastHour}`);
  if (!crashLoopOk) reasons.push('langomonEscript appears to be crash-looping');
  if (Number.isFinite(drawdownPct) && drawdownPct > CONFIG.maxDrawdownPct) reasons.push(`drawdown ${drawdownPct}% exceeds max ${CONFIG.maxDrawdownPct}%`);
  if (Number.isFinite(totalExposureUsd) && totalExposureUsd > CONFIG.maxTotalExposureUsd) reasons.push(`exposure $${totalExposureUsd} exceeds cap $${CONFIG.maxTotalExposureUsd}`);
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
      fillsDetected: fillsLastHour > 0,
      makerOptimizerAdmitsLastHour,
      makerOptimizerBlocksLastHour,
      recentStarvationWarning,
      crashLoopOk,
      crashLoopEvidence,
      drawdownPct: Number.isFinite(drawdownPct) ? drawdownPct : null,
      maxDrawdownPct: CONFIG.maxDrawdownPct,
      totalExposureUsd: Number.isFinite(totalExposureUsd) ? totalExposureUsd : null,
      maxTotalExposureUsd: CONFIG.maxTotalExposureUsd,
      openOrderExposureUsd: Number.isFinite(openOrderExposureUsd) ? openOrderExposureUsd : null,
      maxTotalOpenOrderUsd: CONFIG.maxTotalOpenOrderUsd,
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

  if (ready) {
    console.log('Ready for micro-live DRY-RUN review, not automatic live execution.');
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main();
