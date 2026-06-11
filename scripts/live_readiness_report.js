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
      paperOrdersAdmittedLastHour: get('paperOrdersAdmittedLastHour'),
      paperOrdersRejectedBySophieLastHour: get('paperOrdersRejectedBySophieLastHour'),
      ordersPlacedLastHour: get('ordersPlacedLastHour'),
      fillsLastHour: get('fillsLastHour'),
      duplicateSkipsLastHour: get('duplicateSkipsLastHour'),
      replacementsLastHour: get('replacementsLastHour'),
      oldestOpenOrderAgeSec: get('oldestOpenOrderAgeSec'),
      maxOpenOrderBlocksLastHour: get('maxOpenOrderBlocksLastHour'),
      fillRateLastHour: get('fillRateLastHour'),
    };
  }
  return {};
}

function countRecent(lines, pattern, now = Date.now(), windowMs = 60 * 60_000) {
  let count = 0;
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    const ts = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(ts) || now - ts <= windowMs) count += 1;
  }
  return count;
}

function boolStatus(value, expected) {
  return { value, expected, ok: value === expected };
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
  const engineLines = tailLines(engineLogPath, 1000);
  const recentPortfolioReportFound = engineLines.some((line) => line.includes('--- PORTFOLIO REPORT ---'));
  const openOrders = parseLastNumber(engineLines, /Open Orders:\s+(\d+)/);
  const drawdownPct = parseLastNumber(engineLines, /Drawdown:\s+([0-9.]+)%/);
  const openOrderExposureUsd = parseLastNumber(engineLines, /Open Order Exposure:\s+\$([0-9.]+)/);
  const totalExposureUsd = parseLastNumber(engineLines, /Open Orders:\s+\d+\s+\|\s+Exposure:\s+\$([0-9.]+)/);
  const executionHealth = parseLastExecutionHealth(engineLines);
  const fillsLastHour = Number.isFinite(executionHealth.fillsLastHour) ? executionHealth.fillsLastHour : countRecent(engineLines, /\[FILL\]/);
  const candidateEvaluationsLastHour = Number.isFinite(executionHealth.candidateEvaluationsLastHour)
    ? executionHealth.candidateEvaluationsLastHour
    : countRecent(engineLines, /\[SOPHIE ORDER QUALITY\]|\[SOPHIE CALIBRATED ADMIT\]|\[SOPHIE BOOTSTRAP ADMIT\]/);
  const paperOrdersAdmittedLastHour = Number.isFinite(executionHealth.paperOrdersAdmittedLastHour)
    ? executionHealth.paperOrdersAdmittedLastHour
    : countRecent(engineLines, /\[SOPHIE ORDER QUALITY\].*decision=ADMIT|\[SOPHIE CALIBRATED ADMIT\]|\[SOPHIE BOOTSTRAP ADMIT\]/);
  const paperOrdersRejectedBySophieLastHour = Number.isFinite(executionHealth.paperOrdersRejectedBySophieLastHour)
    ? executionHealth.paperOrdersRejectedBySophieLastHour
    : countRecent(engineLines, /\[SOPHIE ORDER QUALITY\].*BLOCK_LOW_QUALITY|\[SOPHIE EXECUTION THROTTLE\]/);
  const paperOrdersPlacedLastHour = Number.isFinite(executionHealth.paperOrdersPlacedLastHour)
    ? executionHealth.paperOrdersPlacedLastHour
    : (Number.isFinite(executionHealth.ordersPlacedLastHour) ? executionHealth.ordersPlacedLastHour : countRecent(engineLines, /\[ORDER\]/));
  const ordersPlacedLastHour = paperOrdersPlacedLastHour;
  const duplicateSkipsLastHour = Number.isFinite(executionHealth.duplicateSkipsLastHour) ? executionHealth.duplicateSkipsLastHour : countRecent(engineLines, /\[ORDER SKIP DUPLICATE\]/);
  const maxOpenOrderBlocksLastHour = Number.isFinite(executionHealth.maxOpenOrderBlocksLastHour)
    ? executionHealth.maxOpenOrderBlocksLastHour
    : countRecent(engineLines, /\[SOPHIE SLOT BLOCK\]|block=max_open_orders/);
  const fillRateLastHour = Number.isFinite(executionHealth.fillRateLastHour) ? executionHealth.fillRateLastHour : (ordersPlacedLastHour > 0 ? (fillsLastHour / ordersPlacedLastHour) * 100 : 0);
  const recentStarvationWarning = countRecent(engineLines, /\[ENGINE STARVATION WARNING\]/) > 0;
  const crashLoopOk = !engineProc || ((engineProc.pm2_env?.unstable_restarts || 0) === 0 && (engineProc.pm2_env?.restart_time || 0) < 10);

  if (!recentPortfolioReportFound) reasons.push('recent portfolio report not found');
  if (!Number.isFinite(openOrders) || openOrders <= 0) reasons.push('no active paper orders; Sophie bootstrap/calibrated gates admitted no candidates');
  if (!crashLoopOk) reasons.push('langomonEscript appears to be crash-looping');
  if (Number.isFinite(drawdownPct) && drawdownPct > CONFIG.maxDrawdownPct) reasons.push(`drawdown ${drawdownPct}% exceeds max ${CONFIG.maxDrawdownPct}%`);
  if (Number.isFinite(totalExposureUsd) && totalExposureUsd > CONFIG.maxTotalExposureUsd) reasons.push(`exposure $${totalExposureUsd} exceeds cap $${CONFIG.maxTotalExposureUsd}`);
  if (Number.isFinite(openOrderExposureUsd) && openOrderExposureUsd > CONFIG.maxTotalOpenOrderUsd) reasons.push(`open order exposure $${openOrderExposureUsd} exceeds cap $${CONFIG.maxTotalOpenOrderUsd}`);
  if (fillsLastHour < 3) reasons.push(`fillsLastHour ${fillsLastHour} below required 3`);
  if (fillRateLastHour < 1.0) reasons.push(`fillRateLastHour ${fillRateLastHour}% below required 1.0%`);
  if (ordersPlacedLastHour > 150) reasons.push(`ordersPlacedLastHour ${ordersPlacedLastHour} exceeds max 150`);
  if (duplicateSkipsLastHour > 500) reasons.push(`duplicateSkipsLastHour ${duplicateSkipsLastHour} exceeds max 500`);
  if (maxOpenOrderBlocksLastHour > 50) reasons.push(`maxOpenOrderBlocksLastHour ${maxOpenOrderBlocksLastHour} exceeds max 50`);
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
      openOrders: Number.isFinite(openOrders) ? openOrders : null,
      candidateEvaluationsLastHour,
      paperOrdersPlacedLastHour,
      paperOrdersAdmittedLastHour,
      paperOrdersRejectedBySophieLastHour,
      ordersPlacedLastHour,
      fillsLastHour,
      duplicateSkipsLastHour,
      maxOpenOrderBlocksLastHour,
      fillRateLastHour,
      fillsDetected: fillsLastHour > 0,
      recentStarvationWarning,
      crashLoopOk,
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
    reasons,
  };

  if (ready) {
    console.log('Ready for micro-live DRY-RUN review, not automatic live execution.');
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main();
