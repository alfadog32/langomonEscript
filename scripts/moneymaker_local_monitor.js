#!/usr/bin/env node
'use strict';

// Local, deterministic, read-only MoneyMaker monitor.
// The only files this script writes are runtime_monitor/latest.json and
// runtime_monitor/history.ndjson (or an explicitly configured output dir).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const childProcess = require('child_process');

// Import the production candidate evaluator without allowing MoneyMaker's
// module bootstrap to read the repository .env file.
process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
for (const key of Object.keys(process.env)) {
  if (/(?:PRIVATE|SECRET|PASSWORD|PASSPHRASE|TOKEN|API_KEY|TELEGRAM)/i.test(key)) delete process.env[key];
}
const { evaluateAutoLiveCandidateGates } = require('../moneymaker_v3');
const { resolveStage5GabagoolConfidenceFloor } = require('../lib/stage5_policy');

const VERSION = '1.0.0';
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'runtime_monitor');
const EXPECTED_PROCESSES = Object.freeze({
  engine: ['langomonEscript'],
  dashboard: ['langomon-dashboard', 'moneyMakerDashboard'],
  oracle: ['btcPolyOracle'],
  liveRouter: ['liveIntentRouter'],
  telegram: ['telegramApprovalBot'],
});
const EVENT_FILES = Object.freeze({
  liveCandidates: 'auto_live_candidates.ndjson',
  intents: 'trade_intents.ndjson',
  router: 'live_intent_router_events.ndjson',
  adapter: 'live_adapter_events.ndjson',
  execution: 'live_execution_events.ndjson',
  approvals: 'approval_decisions.ndjson',
  stage5Shadow: 'stage5_candidate_shadow.ndjson',
});
const WRITER_BLOCKER_CLASSIFICATION = Object.freeze({
  disabled: 'AUTO_LIVE_CANDIDATES_DISABLED',
  strategy_not_allowed: 'STRATEGY_NOT_ALLOWED',
  strategy_blocked: 'STRATEGY_BLOCKED',
  token_id_missing: 'MISSING_TOKEN',
  invalid_side: 'INVALID_SIDE',
  invalid_price: 'INVALID_PRICE',
  invalid_candidate_price: 'INVALID_PRICE',
  invalid_size_usd: 'INVALID_SIZE',
  confidence_below_min: 'CONFIDENCE_BELOW_MIN',
  consensus_not_authorized: 'CONSENSUS_NOT_AUTHORIZED',
  ghost_favorable_below_min: 'GHOST_FAVORABLE_BELOW_MIN',
  cooldown_active: 'COOLDOWN_ACTIVE',
  expected_edge_missing: 'EXPECTED_EDGE_MISSING',
  size_below_min_order: 'SIZE_BELOW_MIN_ORDER',
  canary_max_order_exceeded: 'ORDER_CAP_EXCEEDED',
  canary_exposure_cap_exceeded: 'EXPOSURE_CAP_EXCEEDED',
  risk_not_approved: 'RISK_NOT_APPROVED',
  LIVE_CANARY_MARKET_MISMATCH: 'CANARY_MARKET_MISMATCH',
  no_matching_market_activity: 'NO_MATCHING_MARKET_ACTIVITY',
  no_recent_paper_placement: 'NO_RECENT_PAPER_PLACEMENT',
});

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/^\$/, '').replace(/%$/, '') : value;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function isoOrNull(value) {
  const ms = timestampMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Number.isFinite(Number(value))) {
    const n = Number(value);
    return n < 10_000_000_000 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function lineTimestampMs(line) {
  const match = String(line || '').match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
  return match ? timestampMs(match[1]) : null;
}

function round(value, digits = 4) {
  const n = numberOrNull(value);
  if (n === null) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function redactLine(value) {
  return String(value || '')
    .replace(/\b([A-Z0-9_]*(?:PRIVATE|SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY)[A-Z0-9_]*)\s*[=:]\s*[^\s]+/gi, '$1=[REDACTED]')
    .replace(/\b0x[a-fA-F0-9]{40,}\b/g, '[REDACTED_HEX]')
    .slice(0, 500);
}

function tailText(filePath, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.toString('utf8').replace(/\0/g, '');
    if (stat.size > length) {
      const newline = text.indexOf('\n');
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return text;
  } catch (_) {
    return '';
  }
}

function safeStat(filePath, now = Date.now(), freshnessMs = 60_000) {
  try {
    const stat = fs.statSync(filePath);
    const ageMs = Math.max(0, now - stat.mtimeMs);
    return {
      path: path.resolve(filePath),
      exists: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ageMs: Math.round(ageMs),
      freshness: ageMs <= freshnessMs ? 'fresh' : 'stale',
      error: null,
    };
  } catch (error) {
    return {
      path: path.resolve(filePath), exists: false, sizeBytes: 0,
      modifiedAt: null, ageMs: null, freshness: 'missing', error: error.code || error.message,
    };
  }
}

function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error.message };
  }
}

function tailNdjson(filePath, maxBytes = 2 * 1024 * 1024, maxRows = 1000) {
  const text = tailText(filePath, maxBytes);
  const rows = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/).filter(Boolean).slice(-maxRows)) {
    try {
      rows.push(JSON.parse(line));
    } catch (_) {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

function parseValue(raw) {
  const text = String(raw ?? '').trim();
  if (text.toLowerCase() === 'true') return true;
  if (text.toLowerCase() === 'false') return false;
  const numeric = numberOrNull(text);
  return numeric !== null ? numeric : text;
}

function parseKeyValues(line) {
  const result = {};
  const body = String(line || '').replace(/^.*?\b(?:Signals 1h|Pipeline 1h|Exposure Audit|Exposure Buckets|Fill Realism|Live Safety|Confidence Floors|Action Rate 15m|Gabagool Health):\s*/, '');
  const regex = /([A-Za-z][A-Za-z0-9_]*)=([^\s]+)/g;
  let match;
  while ((match = regex.exec(body)) !== null) result[match[1]] = parseValue(match[2]);
  return result;
}

function lastLineContaining(lines, marker) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(marker)) return lines[i];
  }
  return null;
}

function parseEngineReports(logText, now = Date.now()) {
  const lines = String(logText || '').split(/\r?\n/).filter(Boolean);
  const header = lastLineContaining(lines, '--- BTC ORACLE / GABAGOOL REPORT ---');
  const portfolioHeader = lastLineContaining(lines, '--- PORTFOLIO REPORT ---');
  const signalsLine = lastLineContaining(lines, 'Signals 1h:');
  const pipelineLine = lastLineContaining(lines, 'Pipeline 1h:');
  const auditLine = lastLineContaining(lines, 'Exposure Audit:');
  const bucketsLine = lastLineContaining(lines, 'Exposure Buckets:');
  const exposureLine = [...lines].reverse().find((line) => /(?:\[INFO\]\s+)?Exposure:\s+position=/.test(line)) || null;
  const fillLine = lastLineContaining(lines, 'Fill Realism:');
  const safetyLine = lastLineContaining(lines, 'Live Safety:');
  const confidenceLine = lastLineContaining(lines, 'Confidence Floors:');
  const action15mLine = lastLineContaining(lines, 'Action Rate 15m:');
  const reportTs = lineTimestampMs(header) || lineTimestampMs(portfolioHeader);
  const exactWriterSkips = lines
    .filter((line) => line.includes('[AUTO-LIVE CANDIDATE SKIP]'))
    .map((line) => {
      const match = line.match(/^(\S+).*?SKIP\]\s+(BUY|SELL)\s+(\S+)\s+reason=([^\s]+)\s+\[([^\]]+)\]/);
      return match ? {
        timestamp: isoOrNull(match[1]), direction: match[2], tokenShort: match[3],
        blocker: match[4], strategy: match[5], evidence: redactLine(line),
      } : null;
    })
    .filter(Boolean);
  return {
    reportAt: isoOrNull(reportTs),
    reportAgeMs: Number.isFinite(reportTs) ? Math.max(0, now - reportTs) : null,
    reportFreshness: Number.isFinite(reportTs) && now - reportTs <= 15 * 60_000 ? 'fresh' : reportTs ? 'stale' : 'missing',
    signals1h: parseKeyValues(signalsLine),
    pipeline1h: parseKeyValues(pipelineLine),
    exposureAudit: parseKeyValues(auditLine),
    exposureBuckets: parseKeyValues(bucketsLine),
    exposure: parseKeyValues(exposureLine),
    fillRealism: parseKeyValues(fillLine),
    liveSafety: parseKeyValues(safetyLine),
    confidenceFloors: parseKeyValues(confidenceLine),
    action15m: parseKeyValues(action15mLine),
    exactWriterSkips: exactWriterSkips.slice(-50),
  };
}

function runCommand(command, args, timeoutMs = 5000) {
  const childEnv = {};
  for (const key of ['PATH', 'HOME', 'PM2_HOME', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR']) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  childEnv.MM_SKIP_LOCAL_ENV_FILE = 'true';
  const result = childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: redactLine(result.stderr || result.error?.message || ''),
  };
}

function parsePm2List(text) {
  const rows = stripAnsi(text).split(/\r?\n/)
    .map((line) => line.split('│').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 10);
  const headerIndex = rows.findIndex((cells) => cells.some((cell) => cell.toLowerCase() === 'name'));
  if (headerIndex < 0) return [];
  const header = rows[headerIndex].map((cell) => cell.toLowerCase());
  return rows.slice(headerIndex + 1)
    .filter((cells) => cells.length === header.length && /^\d+$/.test(cells[0]))
    .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index]])));
}

function parsePm2Describe(text) {
  const values = {};
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const cells = line.split('│').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 2 && cells[0]) values[cells[0].toLowerCase()] = cells[1];
  }
  return values;
}

function parseMemoryBytes(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*(b|kb|mb|gb)$/i);
  if (!match) return null;
  const multiplier = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[match[2].toLowerCase()];
  return Math.round(Number(match[1]) * multiplier);
}

function collectPm2(pm2Bin, now = Date.now(), logsDir = path.join(path.dirname(ROOT), '.pm2', 'logs')) {
  const listResult = runCommand(pm2Bin, ['list', '--no-color']);
  const listRows = listResult.ok ? parsePm2List(listResult.stdout) : [];
  const processes = {};
  for (const [role, aliases] of Object.entries(EXPECTED_PROCESSES)) {
    const row = listRows.find((candidate) => aliases.includes(candidate.name));
    const name = row?.name || aliases[0];
    const describe = row ? runCommand(pm2Bin, ['describe', name, '--no-color']) : { ok: false, stdout: '', stderr: 'process_not_listed' };
    const details = describe.ok ? parsePm2Describe(describe.stdout) : {};
    const status = details.status || row?.status || 'missing';
    const restarts = numberOrNull(details.restarts ?? row?.['↺'] ?? row?.restarts);
    const unstableRestarts = numberOrNull(details['unstable restarts']);
    const uptime = details.uptime || row?.uptime || null;
    const memoryDisplay = row?.mem || row?.memory || null;
    const defaultOutLog = path.join(logsDir, `${name}-out.log`);
    const defaultErrorLog = path.join(logsDir, `${name}-error.log`);
    const outLogPath = details['out log path'] || defaultOutLog;
    const errorLogPath = details['error log path'] || defaultErrorLog;
    processes[role] = {
      name,
      status,
      online: status === 'online',
      pid: numberOrNull(details.pid ?? row?.pid),
      restartCount: restarts,
      unstableRestarts,
      uptime,
      memory: memoryDisplay,
      memoryBytes: parseMemoryBytes(memoryDisplay),
      cpu: row?.cpu || null,
      outLogPath,
      errorLogPath,
      source: row ? 'pm2_list_and_describe' : 'pm2_list',
      error: row ? (describe.ok ? null : describe.stderr) : 'process_not_listed',
    };
  }
  const recentRuntimeErrors = new Map();
  for (const [role, proc] of Object.entries(processes)) {
    const metadata = safeStat(proc.errorLogPath, now, 60 * 60_000);
    if (!metadata.exists || metadata.ageMs > 60 * 60_000) continue;
    const lines = tailText(proc.errorLogPath, 256 * 1024).split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-100)) {
      const ts = lineTimestampMs(line);
      if (Number.isFinite(ts) && now - ts > 60 * 60_000) continue;
      if (/\berror\b|exception|unhandled|ECONNREFUSED|ETIMEDOUT|EPIPE|SIGKILL|crash/i.test(line)) {
        const message = redactLine(line);
        const key = `${role}:${message}`;
        const existing = recentRuntimeErrors.get(key);
        recentRuntimeErrors.set(key, {
          process: role,
          timestamp: isoOrNull(ts) || metadata.modifiedAt,
          timestampSource: Number.isFinite(ts) ? 'log_line' : 'error_log_mtime',
          message,
          count: (existing?.count || 0) + 1,
        });
      }
    }
  }
  return {
    available: listResult.ok,
    error: listResult.ok ? null : listResult.stderr || 'pm2_list_failed',
    processes,
    recentRuntimeErrors: [...recentRuntimeErrors.values()].slice(-30),
  };
}

function discoverStateFile(dashboardStatus = null, explicitPath = null) {
  const fromDashboard = dashboardStatus?.stateFile?.resolvedPath || dashboardStatus?.portfolio?.stateFile;
  if (fromDashboard && path.resolve(fromDashboard).startsWith(ROOT + path.sep)) {
    return { path: path.resolve(fromDashboard), source: 'dashboard_status' };
  }
  if (explicitPath || process.env.MM_MONITOR_STATE_FILE) {
    return { path: path.resolve(explicitPath || process.env.MM_MONITOR_STATE_FILE), source: 'monitor_override' };
  }
  if (process.env.STATE_FILE) {
    const resolved = path.resolve(ROOT, process.env.STATE_FILE);
    if (resolved.startsWith(ROOT + path.sep)) return { path: resolved, source: 'monitor_process_env' };
  }
  const candidates = fs.readdirSync(ROOT)
    .filter((name) => /^moneymaker_v3_state.*\.json$/.test(name) && !name.includes('.before_'))
    .map((name) => ({ path: path.join(ROOT, name), stat: safeStat(path.join(ROOT, name)) }))
    .filter((item) => item.stat.exists)
    .sort((a, b) => (timestampMs(b.stat.modifiedAt) || 0) - (timestampMs(a.stat.modifiedAt) || 0));
  return candidates[0]
    ? { path: candidates[0].path, source: 'freshest_repository_state_candidate' }
    : { path: path.join(ROOT, 'moneymaker_v3_state.json'), source: 'default' };
}

function countType(events, type) {
  return events.reduce((count, event) => count + (event?.type === type ? 1 : 0), 0);
}

function pipelineWindow(state, sinceMs, now = Date.now()) {
  const allEvents = Array.isArray(state?.executionEvents) ? state.executionEvents : [];
  const events = allEvents.filter((event) => Number(event?.ts || 0) >= sinceMs && Number(event?.ts || 0) <= now + 60_000);
  const allFills = Array.isArray(state?.fills) ? state.fills : [];
  const fills = allFills.filter((fill) => Number(fill?.ts || 0) >= sinceMs && Number(fill?.ts || 0) <= now + 60_000 && /Gabagool/i.test(String(fill?.strategy || '')));
  const fillSourceCounts = {};
  let trustedFills = 0;
  let untrustedFills = 0;
  for (const fill of fills) {
    const source = String(fill.fillSource || 'unknown');
    fillSourceCounts[source] = (fillSourceCounts[source] || 0) + 1;
    if (fill.trustedFill === true) trustedFills += 1;
    else untrustedFills += 1;
  }
  const oldest = allEvents.reduce((value, event) => Math.min(value, Number(event?.ts || Infinity)), Infinity);
  return {
    source: 'persisted_execution_events',
    coverageComplete: Number.isFinite(oldest) && oldest <= sinceMs,
    coverageStart: Number.isFinite(oldest) ? isoOrNull(oldest) : null,
    oracleSignalsRead: countType(events, 'gabagool_oracle_signal_read'),
    fresh: countType(events, 'gabagool_oracle_signal_fresh'),
    expired: countType(events, 'gabagool_oracle_signal_expired'),
    unconfirmed: countType(events, 'gabagool_oracle_signal_not_confirmed'),
    duplicateSuppressed: countType(events, 'gabagool_duplicate_oracle_signal'),
    gabagoolCandidatesBuilt: countType(events, 'gabagool_candidate_built'),
    zeroSizeBlocks: countType(events, 'gabagool_zero_size_blocked'),
    sophie: {
      evaluated: countType(events, 'gabagool_sophie_evaluated'),
      admitted: countType(events, 'gabagool_sophie_admitted'),
      blocked: countType(events, 'gabagool_sophie_blocked'),
    },
    risk: {
      evaluated: countType(events, 'gabagool_risk_evaluated'),
      admitted: countType(events, 'gabagool_risk_admitted'),
      blocked: countType(events, 'gabagool_risk_blocked'),
    },
    placements: {
      attempted: countType(events, 'gabagool_placement_attempted'),
      blocked: countType(events, 'gabagool_placement_blocked'),
    },
    ordersPlaced: countType(events, 'gabagool_order_placed'),
    fills: fills.length,
    exits: countType(events, 'gabagool_exit'),
    fillSourceCounts,
    trustedFills,
    untrustedFills,
  };
}

function pipelineHourFromReport(parsed) {
  const signals = parsed.signals1h || {};
  const pipeline = parsed.pipeline1h || {};
  const fill = parsed.fillRealism || {};
  const fillSourceCounts = {};
  const sourceText = String(fill.fillSourceCounts || fill.fillCountsBySource || '');
  for (const pair of sourceText.split(',')) {
    const [name, raw] = pair.split(':');
    if (name && numberOrNull(raw) !== null) fillSourceCounts[name] = numberOrNull(raw);
  }
  return {
    source: 'engine_structured_one_hour_report',
    coverageComplete: Boolean(Object.keys(pipeline).length),
    coverageStart: null,
    oracleSignalsRead: numberOrNull(signals.read),
    fresh: numberOrNull(signals.fresh),
    expired: numberOrNull(signals.expired),
    unconfirmed: numberOrNull(signals.notConfirmed),
    duplicateSuppressed: numberOrNull(signals.duplicateSkipped),
    gabagoolCandidatesBuilt: numberOrNull(pipeline.candidates),
    zeroSizeBlocks: numberOrNull(pipeline.zeroSizeBlocked),
    sophie: { evaluated: numberOrNull(pipeline.sophieEval), admitted: numberOrNull(pipeline.sophieAdmit), blocked: numberOrNull(pipeline.sophieBlock) },
    risk: { evaluated: numberOrNull(pipeline.riskEval), admitted: numberOrNull(pipeline.riskAdmit), blocked: numberOrNull(pipeline.riskBlock) },
    placements: { attempted: numberOrNull(pipeline.placementAttempt), blocked: numberOrNull(pipeline.placementBlock) },
    ordersPlaced: numberOrNull(pipeline.orders),
    fills: numberOrNull(pipeline.fills),
    exits: numberOrNull(pipeline.exits),
    fillSourceCounts,
    trustedFills: numberOrNull(fill.trustedFills ?? fill.trustedFillCountLastHour),
    untrustedFills: numberOrNull(fill.untrustedFills ?? fill.untrustedFillCountLastHour),
  };
}

function latestEventTimestamp(rows) {
  return rows.reduce((latest, row) => Math.max(latest, timestampMs(row?.timestamp ?? row?.ts) || 0), 0) || null;
}

function collectEventFiles(now = Date.now(), baseDir = ROOT) {
  const result = {};
  for (const [name, relativePath] of Object.entries(EVENT_FILES)) {
    const filePath = path.join(baseDir, relativePath);
    const stat = safeStat(filePath, now, 15 * 60_000);
    const parsed = stat.exists && stat.sizeBytes > 0 ? tailNdjson(filePath) : { rows: [], malformed: 0 };
    const latestTs = latestEventTimestamp(parsed.rows);
    const ageMs = latestTs ? Math.max(0, now - latestTs) : stat.ageMs;
    result[name] = {
      ...stat,
      latestEventAt: isoOrNull(latestTs),
      latestEventAgeMs: ageMs,
      freshness: !stat.exists ? 'missing' : parsed.malformed > 0 && parsed.rows.length === 0 ? 'malformed' : stat.sizeBytes === 0 ? 'empty' : ageMs <= 15 * 60_000 ? 'fresh' : 'stale',
      parsedTailRows: parsed.rows.length,
      malformedTailRows: parsed.malformed,
    };
  }
  return result;
}

function pickSafetyValue(name, engineSafety, dashboardStatus, supervisor) {
  const map = {
    enableLiveTrading: 'ENABLE_LIVE_TRADING', liveAutoExecute: 'LIVE_AUTO_EXECUTE',
    liveKillSwitch: 'LIVE_KILL_SWITCH', liveDryRunOnly: 'LIVE_DRY_RUN_ONLY',
    liveSubmitConfirm: 'LIVE_SUBMIT_CONFIRM', liveFinalBossReady: 'LIVE_FINAL_BOSS_READY',
  };
  const envName = map[name];
  if (Object.prototype.hasOwnProperty.call(engineSafety || {}, envName)) {
    return { value: boolOrNull(engineSafety[envName]), source: 'fresh_engine_report' };
  }
  const runtime = dashboardStatus?.settings?.runtime || {};
  const envFile = dashboardStatus?.settings?.envFile || {};
  if (Object.prototype.hasOwnProperty.call(runtime, envName)) return { value: boolOrNull(runtime[envName]), source: 'dashboard_sanitized_runtime' };
  if (Object.prototype.hasOwnProperty.call(envFile, envName)) return { value: boolOrNull(envFile[envName]), source: 'dashboard_sanitized_config' };
  if (supervisor?.flags?.[envName]) return { value: boolOrNull(supervisor.flags[envName].value), source: 'pre_live_supervisor_snapshot' };
  if (Object.prototype.hasOwnProperty.call(process.env, envName)) return { value: boolOrNull(process.env[envName]), source: 'monitor_process_env' };
  return { value: null, source: 'unavailable' };
}

function classifySafety(fields, shadowObservation) {
  const coreLocked = fields.enableLiveTrading.value === false
    && fields.liveAutoExecute.value === false
    && fields.liveKillSwitch.value === true
    && fields.liveDryRunOnly.value === true
    && fields.liveSubmitConfirm.value === false;
  const armed = fields.enableLiveTrading.value === true
    && fields.liveAutoExecute.value === true
    && fields.liveKillSwitch.value === false
    && fields.liveDryRunOnly.value === false
    && fields.liveSubmitConfirm.value === true
    && fields.liveFinalBossReady.value === true
    && Number(fields.liveStage.value) >= 2;
  if (armed) return 'LIVE_ARMED';
  if (coreLocked) return shadowObservation ? 'SHADOW_OBSERVATION_ONLY' : 'SAFE_LOCKED_OFF';
  return 'UNSAFE_CONFIGURATION';
}

function buildSafety(parsed, dashboardStatus, supervisor, routerRows, eventFiles) {
  const fields = {};
  for (const name of ['enableLiveTrading', 'liveAutoExecute', 'liveKillSwitch', 'liveDryRunOnly', 'liveSubmitConfirm', 'liveFinalBossReady']) {
    fields[name] = pickSafetyValue(name, parsed.liveSafety, dashboardStatus, supervisor);
  }
  const metrics = supervisor?.metrics || {};
  const latestRouterStart = [...routerRows].reverse().find((row) => row?.type === 'LIVE_ROUTER_STARTED');
  const dashboardRuntime = dashboardStatus?.settings?.runtime || {};
  fields.liveStage = { value: numberOrNull(metrics.liveTradingStage ?? dashboardRuntime.LIVE_TRADING_STAGE ?? process.env.LIVE_TRADING_STAGE), source: metrics.liveTradingStage != null ? 'pre_live_supervisor_snapshot' : dashboardRuntime.LIVE_TRADING_STAGE != null ? 'dashboard_sanitized_runtime' : 'monitor_process_env_or_default' };
  fields.routerMode = { value: latestRouterStart?.mode || null, source: latestRouterStart ? 'router_event_file' : 'unavailable' };
  fields.liveCanaryMarketId = { value: metrics.singleMarketId || dashboardRuntime.LIVE_CANARY_MARKET_ID || null, source: metrics.singleMarketId ? 'pre_live_supervisor_snapshot' : dashboardRuntime.LIVE_CANARY_MARKET_ID ? 'dashboard_sanitized_runtime' : 'unavailable' };
  fields.maximumOrderUsd = { value: numberOrNull(metrics.effectiveMaxLiveOrderUsd), source: metrics.effectiveMaxLiveOrderUsd != null ? 'pre_live_supervisor_snapshot' : 'unavailable' };
  fields.maximumExposureUsd = { value: numberOrNull(metrics.effectiveMaxLiveTotalExposureUsd), source: metrics.effectiveMaxLiveTotalExposureUsd != null ? 'pre_live_supervisor_snapshot' : 'unavailable' };
  fields.dailyLossCapUsd = { value: numberOrNull(metrics.effectiveLiveDailyMaxLossUsd), source: metrics.effectiveLiveDailyMaxLossUsd != null ? 'pre_live_supervisor_snapshot' : 'unavailable' };
  fields.ordersPerHourCap = { value: numberOrNull(metrics.effectiveMaxOrdersPerHour), source: metrics.effectiveMaxOrdersPerHour != null ? 'pre_live_supervisor_snapshot' : 'unavailable' };
  const shadowObservation = eventFiles.stage5Shadow?.freshness === 'fresh';
  const status = classifySafety(fields, shadowObservation);
  return {
    status,
    prominentWarning: status === 'SAFE_LOCKED_OFF' ? null : `WARNING: safety status is ${status}; monitor made no changes`,
    fields,
    canSubmitLive: fields.enableLiveTrading.value === true
      && fields.liveAutoExecute.value === true
      && fields.liveKillSwitch.value === false
      && fields.liveDryRunOnly.value === false
      && fields.liveSubmitConfirm.value === true
      && fields.liveFinalBossReady.value === true,
    snapshotAt: supervisor?.lastRun || null,
  };
}

function exposureFromReport(parsed) {
  const audit = parsed.exposureAudit || {};
  const buckets = parsed.exposureBuckets || {};
  return {
    source: 'engine_structured_paper_report',
    actualTradablePaperExposureUsd: numberOrNull(buckets.activeTradable),
    openOrderPaperExposureUsd: numberOrNull(parsed.exposure?.openOrders),
    capBlockingPaperExposureUsd: numberOrNull(audit.capBlockingExposureUsd ?? buckets.capBlocking),
    expiredBtcFiveMinutePaperExposureUsd: numberOrNull(buckets.expiredBtc5m),
    staleNoBidPaperExposureUsd: numberOrNull(buckets.staleNoBid),
    excludedDeadPaperExposureUsd: numberOrNull(audit.excludedDeadExposureUsd ?? buckets.excludedDead),
    dustPaperExposureUsd: numberOrNull(buckets.dust),
    externalLivePositions: {
      known: false,
      valueUsd: null,
      reason: 'no dedicated authenticated live-position source was accessed',
    },
  };
}

function findMatchedFill(order, fills) {
  return fills
    .filter((fill) => fill?.tokenId === order?.tokenId && String(fill?.side || '').toLowerCase() === String(order?.side || '').toLowerCase())
    .map((fill) => ({ fill, delta: Math.abs(Number(fill.ts || 0) - Number(order.ts || 0)) }))
    .filter((candidate) => candidate.delta <= 10_000)
    .sort((a, b) => a.delta - b.delta)[0]?.fill || null;
}

function nearestGateEvent(order, events, type) {
  return events.some((event) => event?.type === type
    && event?.tokenId === order?.tokenId
    && String(event?.side || '').toLowerCase() === String(order?.side || '').toLowerCase()
    && Math.abs(Number(event?.ts || 0) - Number(order?.ts || 0)) <= 10_000);
}

function sizingClassification(price, sizeUsd, effectiveRequiredShares, stage5MaxOrderUsd) {
  const shares = Number(price) > 0 ? Number(sizeUsd) / Number(price) : null;
  const minimumViableUsd = Number(price) * Number(effectiveRequiredShares);
  if (!Number.isFinite(shares) || shares >= effectiveRequiredShares) return null;
  return stage5MaxOrderUsd >= minimumViableUsd
    ? 'PAPER_SIZE_BELOW_CLOB_MINIMUM_STAGE5_CAN_RESIZE'
    : 'STAGE5_CAP_BELOW_CLOB_MINIMUM';
}

function classifyWriterBlocker(blocker, context = {}) {
  if (blocker == null || blocker === '') return 'ELIGIBLE';
  if (blocker === 'book_not_fresh') {
    return context.bookComplete === false ? 'BOOK_INCOMPLETE' : 'BOOK_STALE';
  }
  return WRITER_BLOCKER_CLASSIFICATION[blocker] || 'UNKNOWN_INSUFFICIENT_DIAGNOSTICS';
}

function correlateWriterSkip(order, skips) {
  const prefix = String(order?.tokenId || '').slice(0, 6);
  const suffix = String(order?.tokenId || '').slice(-4);
  return [...skips].reverse().find((skip) => {
    const skipMs = timestampMs(skip.timestamp);
    return skip.direction === String(order?.side || '').toUpperCase()
      && String(skip.tokenShort || '').startsWith(prefix)
      && String(skip.tokenShort || '').endsWith(suffix)
      && (!skipMs || Math.abs(skipMs - Number(order?.ts || 0)) <= 15_000);
  }) || null;
}

function buildCandidateDiagnostics(state, parsed, safety, now = Date.now()) {
  const events = Array.isArray(state?.executionEvents) ? state.executionEvents : [];
  const fills = Array.isArray(state?.fills) ? state.fills : [];
  const recentOrders = events
    .filter((event) => event?.type === 'gabagool_order_placed' && Number(event?.ts || 0) >= now - 60 * 60_000)
    .slice(-25);
  const opportunities = [];
  const stage5MaxOrderUsd = 5;
  const stage5MaxExposureUsd = 5;
  const confidenceFloor = resolveStage5GabagoolConfidenceFloor();
  for (const order of recentOrders) {
    const fill = findMatchedFill(order, fills);
    const bestBid = numberOrNull(fill?.bestBidAtPlacement);
    const bestAsk = numberOrNull(fill?.bestAskAtPlacement);
    const bookAgeMs = numberOrNull(fill?.bookAgeMs);
    const reportedMinimumShares = numberOrNull(fill?.minOrderSize ?? order?.minOrderSize);
    const effectiveRequiredShares = Math.max(5, reportedMinimumShares || 0);
    const bookCachedAt = Number(order.ts || now) - (bookAgeMs || 0);
    const book = {
      bestBid, bestAsk,
      midpoint: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      bids: bestBid !== null ? [[bestBid, 1]] : [],
      asks: bestAsk !== null ? [[bestAsk, 1]] : [],
      cachedAt: bookCachedAt,
      minOrderSize: effectiveRequiredShares,
    };
    const sophieApproved = nearestGateEvent(order, events, 'gabagool_sophie_admitted');
    const riskApproved = nearestGateEvent(order, events, 'gabagool_risk_admitted');
    const signal = {
      strategy: order.strategy,
      tokenId: order.tokenId,
      marketId: order.marketId,
      side: order.side,
      price: order.price,
      sizeUsd: order.sizeUsd,
      confidence: order.confidence,
      expectedEdge: order.expectedEdge,
      _riskApproved: riskApproved,
      metadata: {},
    };
    const stage5Config = {
      autoLiveCandidatesEnabled: true,
      autoLiveAllowedStrategies: ['GabagoolBtcOracleStrategy'],
      autoLiveBlockedStrategies: [],
      autoLiveMinConfidence: confidenceFloor,
      autoLiveMaxBookAgeMs: 1_500,
      enableConsensus: false,
      autoLiveMinGhostFavorablePct: 0,
      autoLiveCandidateCooldownMs: 0,
      liveTradingStage: 5,
      liveCanaryMarketId: String(order.marketId || ''),
      maxLiveOrderUsd: stage5MaxOrderUsd,
      maxLiveTotalExposureUsd: stage5MaxExposureUsd,
      liveDailyMaxLossUsd: 5,
      liveMaxOrdersPerHour: 1,
    };
    const decision = evaluateAutoLiveCandidateGates({
      signal,
      asset: { market: { marketId: order.marketId, slug: order.marketSlug }, outcome: order.outcome, minOrderSize: effectiveRequiredShares },
      book,
      config: stage5Config,
      currentLiveExposureUsd: 0,
      lastWrittenAt: 0,
      now: Number(order.ts || now),
      confidenceFloor,
    });
    const price = numberOrNull(order.price);
    const sizeUsd = numberOrNull(order.sizeUsd);
    const shares = price && sizeUsd ? sizeUsd / price : null;
    const minimumViableUsd = price === null ? null : price * effectiveRequiredShares;
    const exactSkip = correlateWriterSkip(order, parsed.exactWriterSkips);
    const configuredCanary = safety.fields.liveCanaryMarketId.value;
    const configuredCanaryMatch = configuredCanary ? String(configuredCanary) === String(order.marketId || '') : null;
    const bookComplete = bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0;
    const gateBlocker = decision.blocker;
    opportunities.push({
      source: 'persisted_paper_order_plus_fill_reconstruction',
      timestamp: isoOrNull(order.ts),
      marketId: order.marketId || null,
      slug: order.marketSlug || null,
      token: order.tokenId || null,
      outcome: order.outcome || null,
      direction: String(order.side || '').toUpperCase() || null,
      confidence: numberOrNull(order.confidence),
      confidenceThreshold: confidenceFloor,
      candidatePrice: price,
      bestBid,
      bestAsk,
      bookAgeMs,
      paperSizeUsd: sizeUsd,
      calculatedShares: round(shares, 6),
      reportedClobMinimumShares: reportedMinimumShares,
      effectiveRequiredShares,
      minimumViableUsd: round(minimumViableUsd, 4),
      stage5MaximumOrderUsd: stage5MaxOrderUsd,
      stage5MaximumExposureUsd: stage5MaxExposureUsd,
      sophieApproved,
      riskApproved,
      exactCurrentCandidateWriterBlocker: exactSkip?.blocker || null,
      exactCurrentCandidateWriterEvidence: exactSkip?.evidence || null,
      hypotheticalStage5CandidateWriterBlocker: gateBlocker,
      hypotheticalStage5Classification: classifyWriterBlocker(gateBlocker, { bookComplete }),
      sizingClassification: sizingClassification(price, sizeUsd, effectiveRequiredShares, stage5MaxOrderUsd),
      configuredCanaryMarketId: configuredCanary || null,
      configuredCanaryMatch,
      canaryAssumption: 'hypothetical Stage 5 evaluation binds the canary to this opportunity market, matching production shadow instrumentation',
      eligibleUnderHypotheticalStage5: decision.eligible === true,
      candidateWriterGates: decision.gates,
    });
  }
  const eligible = opportunities.filter((item) => item.eligibleUnderHypotheticalStage5);
  const blocked = opportunities.filter((item) => !item.eligibleUnderHypotheticalStage5);
  const counts = {};
  for (const item of blocked) {
    const classification = item.hypotheticalStage5Classification;
    counts[classification] = (counts[classification] || 0) + 1;
  }
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
    || (recentOrders.length === 0 ? 'NO_RECENT_PAPER_PLACEMENT' : null);
  const latestSizingExample = [...opportunities].reverse().find((item) => item.sizingClassification);
  return {
    authoritativeEvaluator: 'evaluateAutoLiveCandidateGates',
    writesProductionCandidateFile: false,
    opportunityCount: opportunities.length,
    eligibleCount: eligible.length,
    blockedCount: blocked.length,
    status: opportunities.length === 0 ? 'NO_RECENT_OPPORTUNITY' : eligible.length > 0 ? 'ELIGIBLE_OPPORTUNITY_OBSERVED' : 'BLOCKED',
    dominantBlocker: dominant,
    blockerCounts: counts,
    latestSizingExample: latestSizingExample || null,
    opportunities,
  };
}

function requestRaw(urlString, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 3000);
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      resolve({ reachable: false, statusCode: null, body: '', latencyMs: null, error: `invalid_url:${error.message}` });
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = transport.request(url, {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', 'user-agent': 'moneymaker-local-monitor/1.0' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        if (length < 256 * 1024) chunks.push(chunk);
        length += chunk.length;
      });
      res.on('end', () => resolve({
        reachable: true,
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 256 * 1024),
        latencyMs: Date.now() - start,
        error: null,
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ reachable: false, statusCode: null, body: '', latencyMs: Date.now() - start, error: error.code || error.message }));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function healthFromResponse(response, validator) {
  if (!response.reachable) return { status: 'unreachable', reachable: false, latencyMs: response.latencyMs, httpStatus: null, error: response.error };
  if (response.statusCode === 401 || response.statusCode === 403) {
    return { status: 'reachable_but_unauthorized', reachable: true, latencyMs: response.latencyMs, httpStatus: response.statusCode, error: `http_${response.statusCode}` };
  }
  const validated = validator(response);
  if (!validated.ok) return { status: 'reachable_with_malformed_response', reachable: true, latencyMs: response.latencyMs, httpStatus: response.statusCode, error: validated.error };
  return { status: 'healthy', reachable: true, latencyMs: response.latencyMs, httpStatus: response.statusCode, error: null, ...validated.details };
}

function assessOracleDataSource(filePath, stat, now = Date.now()) {
  if (!stat.exists) return { status: 'unreachable', ...stat, signalAt: null, expiresAt: null };
  const parsed = readJson(filePath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    return { status: 'reachable_with_malformed_response', ...stat, signalAt: null, expiresAt: null, error: parsed.error || 'oracle_payload_not_object' };
  }
  const payload = Array.isArray(parsed.value) ? parsed.value[parsed.value.length - 1] : parsed.value;
  const signalMs = timestampMs(payload?.timestamp ?? payload?.ts ?? payload?.generatedAt);
  const expiresMs = timestampMs(payload?.expires_at ?? payload?.expiresAt);
  if (!Number.isFinite(signalMs)) {
    return { status: 'reachable_with_malformed_response', ...stat, signalAt: null, expiresAt: isoOrNull(expiresMs), error: 'oracle_timestamp_missing_or_invalid' };
  }
  const stale = now - signalMs > 30_000 || (Number.isFinite(expiresMs) && now > expiresMs);
  return {
    status: stale ? 'reachable_but_stale' : 'healthy',
    ...stat,
    signalAt: isoOrNull(signalMs),
    signalAgeMs: Math.max(0, now - signalMs),
    expiresAt: isoOrNull(expiresMs),
    error: null,
  };
}

async function collectApiHealth(options, oracleStat, dashboardProbeResult, eventFiles, stateStat, stateParseError) {
  const clobUrl = options.clobHealthUrl || process.env.MM_MONITOR_CLOB_HEALTH_URL || 'https://clob.polymarket.com/time';
  const rpcUrl = options.rpcUrl || process.env.MM_MONITOR_RPC_URL || 'https://polygon-rpc.com';
  const [clobResponse, rpcResponse] = await Promise.all([
    requestRaw(clobUrl, { timeoutMs: options.networkTimeoutMs }),
    requestRaw(rpcUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }), timeoutMs: options.networkTimeoutMs }),
  ]);
  const clob = healthFromResponse(clobResponse, (response) => {
    if (response.statusCode < 200 || response.statusCode >= 500) return { ok: false, error: `http_${response.statusCode}` };
    let parsed;
    try { parsed = JSON.parse(response.body); } catch (_) { parsed = numberOrNull(response.body.trim()); }
    const serverTime = typeof parsed === 'object' ? numberOrNull(parsed?.server_time ?? parsed?.time ?? parsed?.timestamp) : numberOrNull(parsed);
    return serverTime === null ? { ok: false, error: 'missing_numeric_server_time' } : { ok: true, details: { serverTime } };
  });
  const rpc = healthFromResponse(rpcResponse, (response) => {
    let parsed;
    try { parsed = JSON.parse(response.body); } catch (error) { return { ok: false, error: `invalid_json:${error.message}` }; }
    return typeof parsed?.result === 'string'
      ? { ok: true, details: { chainId: parsed.result } }
      : { ok: false, error: parsed?.error?.message || 'missing_chain_id_result' };
  });
  const oracleHealth = assessOracleDataSource(options.oraclePath, oracleStat, options.now);
  const stateHealthStatus = !stateStat.exists
    ? 'unreachable'
    : stateParseError
      ? 'reachable_with_malformed_response'
      : stateStat.freshness === 'fresh' ? 'healthy' : 'reachable_but_stale';
  return {
    clobPublicReachability: clob,
    polygonRpcReachability: rpc,
    oracleDataFreshness: oracleHealth,
    localDashboardHealth: dashboardProbeResult.health,
    eventFileFreshness: eventFiles,
    stateFileFreshness: { status: stateHealthStatus, ...stateStat, parseError: stateParseError || null },
    authenticatedLivePositionsChecked: false,
    signingCredentialsLoaded: false,
  };
}

async function probeDashboard(url, timeoutMs) {
  const base = String(url || '').replace(/\/$/, '');
  const healthResponse = await requestRaw(`${base}/health`, { timeoutMs });
  const health = healthFromResponse(healthResponse, (response) => {
    let parsed;
    try { parsed = JSON.parse(response.body); } catch (error) { return { ok: false, error: `invalid_json:${error.message}` }; }
    return parsed?.ok === true ? { ok: true, details: {} } : { ok: false, error: 'health_ok_not_true' };
  });
  if (health.status !== 'healthy') return { health, status: null };
  const statusResponse = await requestRaw(`${base}/api/status`, { timeoutMs });
  if (!statusResponse.reachable || statusResponse.statusCode !== 200) return { health, status: null };
  try {
    const parsed = JSON.parse(statusResponse.body);
    return { health, status: parsed?.ok === true ? parsed : null };
  } catch (_) {
    return { health: { ...health, status: 'reachable_with_malformed_response', error: 'api_status_invalid_json' }, status: null };
  }
}

function buildOperatorSummary(report) {
  const pipeline = report.paperPipeline.hour1;
  const exposure = report.exposure;
  const candidate = report.candidateStarvationDiagnostics;
  const example = candidate.latestSizingExample;
  const api = report.apiAndDataSourceHealth;
  const allCoreOnline = ['engine', 'dashboard', 'oracle', 'liveRouter', 'telegram']
    .every((role) => report.runtimeHealth.processes[role]?.online === true);
  const paperHealthy = (pipeline.ordersPlaced || 0) > 0 && (pipeline.fills || 0) > 0;
  return {
    bot: allCoreOnline ? 'ONLINE' : report.runtimeHealth.pm2Available ? 'DEGRADED' : 'UNKNOWN',
    safety: report.safetyStatus.status,
    paperPipeline: paperHealthy ? `HEALTHY — ${pipeline.ordersPlaced} orders / ${pipeline.fills} fills last hour` : 'DEGRADED_OR_INSUFFICIENT_DATA',
    tradablePaperExposureUsd: exposure.actualTradablePaperExposureUsd,
    excludedExpiredPaperExposureUsd: exposure.expiredBtcFiveMinutePaperExposureUsd,
    stage5CandidateStatus: candidate.status,
    dominantBlocker: candidate.dominantBlocker || 'NONE',
    example: example ? `$${Number(example.paperSizeUsd).toFixed(2)} at $${Number(example.candidatePrice).toFixed(2)} = ${Number(example.calculatedShares).toFixed(2)} shares; ${example.effectiveRequiredShares} required; $${Number(example.minimumViableUsd).toFixed(2)} minimum` : null,
    apiStatus: `CLOB ${api.clobPublicReachability.status}, RPC ${api.polygonRpcReachability.status}, oracle ${api.oracleDataFreshness.status}`,
    action: candidate.dominantBlocker === 'SIZE_BELOW_MIN_ORDER'
      ? 'investigate Stage-5-only minimum-share resizing; do not extend the live window'
      : 'review the exact dominant blocker before any Stage 5 change',
  };
}

function formatMoney(value) {
  return numberOrNull(value) === null ? 'unknown' : `$${Number(value).toFixed(2)}`;
}

function formatConsole(report) {
  const runtime = report.runtimeHealth;
  const safety = report.safetyStatus;
  const p15 = report.paperPipeline.minutes15;
  const p1h = report.paperPipeline.hour1;
  const exposure = report.exposure;
  const candidate = report.candidateStarvationDiagnostics;
  const api = report.apiAndDataSourceHealth;
  const summary = report.operatorSummary;
  const processLine = (role) => {
    const proc = runtime.processes[role];
    return `${role}: ${String(proc?.status || 'unknown').toUpperCase()} restarts=${proc?.restartCount ?? 'unknown'} unstable=${proc?.unstableRestarts ?? 'unknown'} uptime=${proc?.uptime || 'unknown'} memory=${proc?.memory || 'unknown'}`;
  };
  const lines = [
    `MONEYMAKER LOCAL MONITOR — ${report.timestamp}`,
    '',
    'A. RUNTIME HEALTH',
    processLine('engine'), processLine('dashboard'), processLine('oracle'), processLine('liveRouter'), processLine('telegram'),
    `Recent runtime errors: ${runtime.recentRuntimeErrors.length}`,
    `State: ${runtime.stateFile.path} exists=${runtime.stateFile.exists} size=${runtime.stateFile.sizeBytes} ageMs=${runtime.stateFile.ageMs ?? 'unknown'} freshness=${runtime.stateFile.freshness}`,
    `Dashboard/report freshness: ${runtime.dashboardReport.freshness} ageMs=${runtime.dashboardReport.ageMs ?? 'unknown'}`,
    '',
    'B. SAFETY STATUS',
    `Status: ${safety.status}`,
    `liveEnabled=${safety.fields.enableLiveTrading.value} autoExecute=${safety.fields.liveAutoExecute.value} killSwitch=${safety.fields.liveKillSwitch.value} dryRunOnly=${safety.fields.liveDryRunOnly.value}`,
    `submitConfirm=${safety.fields.liveSubmitConfirm.value} finalBossReady=${safety.fields.liveFinalBossReady.value} liveStage=${safety.fields.liveStage.value ?? 'unknown'} routerMode=${safety.fields.routerMode.value || 'unknown'}`,
    `canaryMarket=${safety.fields.liveCanaryMarketId.value || 'unset'} maxOrder=${formatMoney(safety.fields.maximumOrderUsd.value)} maxExposure=${formatMoney(safety.fields.maximumExposureUsd.value)} dailyLossCap=${formatMoney(safety.fields.dailyLossCapUsd.value)} ordersPerHour=${safety.fields.ordersPerHourCap.value ?? 'unknown'}`,
  ];
  if (safety.prominentWarning) lines.push(`*** ${safety.prominentWarning} ***`);
  lines.push(
    '', 'C. PAPER PIPELINE',
    `15m${p15.coverageComplete ? '' : ' (captured-event lower bound)'}: oracle read=${p15.oracleSignalsRead} fresh=${p15.fresh} expired=${p15.expired} unconfirmed=${p15.unconfirmed} duplicate=${p15.duplicateSuppressed}; candidates=${p15.gabagoolCandidatesBuilt} zeroSize=${p15.zeroSizeBlocks}; Sophie=${p15.sophie.admitted}/${p15.sophie.evaluated}; risk=${p15.risk.admitted}/${p15.risk.evaluated}; placed=${p15.ordersPlaced} fills=${p15.fills} exits=${p15.exits}`,
    `1h: oracle read=${p1h.oracleSignalsRead ?? 'unknown'} fresh=${p1h.fresh ?? 'unknown'} expired=${p1h.expired ?? 'unknown'} unconfirmed=${p1h.unconfirmed ?? 'unknown'} duplicate=${p1h.duplicateSuppressed ?? 'unknown'}; candidates=${p1h.gabagoolCandidatesBuilt ?? 'unknown'} zeroSize=${p1h.zeroSizeBlocks ?? 'unknown'}; Sophie=${p1h.sophie.admitted ?? 'unknown'}/${p1h.sophie.evaluated ?? 'unknown'} blocked=${p1h.sophie.blocked ?? 'unknown'}; risk=${p1h.risk.admitted ?? 'unknown'}/${p1h.risk.evaluated ?? 'unknown'} blocked=${p1h.risk.blocked ?? 'unknown'}; placed=${p1h.ordersPlaced ?? 'unknown'} fills=${p1h.fills ?? 'unknown'} exits=${p1h.exits ?? 'unknown'}`,
    `Fill sources 1h: ${JSON.stringify(p1h.fillSourceCounts)} trusted=${p1h.trustedFills ?? 'unknown'} untrusted=${p1h.untrustedFills ?? 'unknown'}`,
    '', 'D. PAPER EXPOSURE (NOT LIVE EXPOSURE)',
    `Tradable=${formatMoney(exposure.actualTradablePaperExposureUsd)} openOrders=${formatMoney(exposure.openOrderPaperExposureUsd)} capBlocking=${formatMoney(exposure.capBlockingPaperExposureUsd)} expiredBTC5m=${formatMoney(exposure.expiredBtcFiveMinutePaperExposureUsd)} staleNoBid=${formatMoney(exposure.staleNoBidPaperExposureUsd)} excludedDead=${formatMoney(exposure.excludedDeadPaperExposureUsd)} dust=${formatMoney(exposure.dustPaperExposureUsd)}`,
    'External live positions: UNKNOWN — no authenticated live-position source was accessed',
    '', 'E/F. STAGE 5 CANDIDATE STARVATION',
    `Status=${candidate.status} opportunities=${candidate.opportunityCount} eligible=${candidate.eligibleCount} blocked=${candidate.blockedCount} dominant=${candidate.dominantBlocker || 'none'}`,
  );
  if (candidate.latestSizingExample) lines.push(`Sizing evidence: ${summary.example}; classification=${candidate.latestSizingExample.sizingClassification}`);
  for (const item of candidate.opportunities.slice(-5)) {
    lines.push(`${item.timestamp} ${item.direction} ${item.slug || item.marketId || 'unknown'} price=${item.candidatePrice} sizeUsd=${item.paperSizeUsd} shares=${item.calculatedShares}/${item.effectiveRequiredShares} bookAgeMs=${item.bookAgeMs ?? 'unknown'} blocker=${item.hypotheticalStage5CandidateWriterBlocker || 'eligible'} currentWriter=${item.exactCurrentCandidateWriterBlocker || 'not_correlated'}`);
  }
  lines.push(
    '', 'G. API AND DATA-SOURCE HEALTH',
    `CLOB=${api.clobPublicReachability.status} RPC=${api.polygonRpcReachability.status} oracle=${api.oracleDataFreshness.status} dashboard=${api.localDashboardHealth.status} events=${Object.values(api.eventFileFreshness).some((item) => item.freshness === 'malformed') ? 'malformed' : 'reported separately in JSON'} state=${api.stateFileFreshness.status}`,
    '', 'H. OPERATOR SUMMARY',
    `BOT: ${summary.bot}`,
    `SAFETY: ${summary.safety}`,
    `PAPER PIPELINE: ${summary.paperPipeline}`,
    `TRADABLE PAPER EXPOSURE: ${formatMoney(summary.tradablePaperExposureUsd)}`,
    `EXCLUDED EXPIRED PAPER EXPOSURE: ${formatMoney(summary.excludedExpiredPaperExposureUsd)}`,
    `STAGE5 CANDIDATE STATUS: ${summary.stage5CandidateStatus}`,
    `DOMINANT BLOCKER: ${summary.dominantBlocker}`,
    ...(summary.example ? [`EXAMPLE: ${summary.example}`] : []),
    `API STATUS: ${summary.apiStatus}`,
    `ACTION: ${summary.action}`,
  );
  return `${lines.join('\n')}\n`;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* best effort temp cleanup */ }
  }
}

function appendRotatingHistory(filePath, value, maxBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  const size = safeStat(filePath).sizeBytes || 0;
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
    const rotated = `${filePath}.1`;
    try { if (fs.existsSync(rotated)) fs.unlinkSync(rotated); } catch (_) { /* bounded monitor history only */ }
    fs.renameSync(filePath, rotated);
  }
  fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
}

function loadSupervisorSnapshot(filePath) {
  const parsed = readJson(filePath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return null;
  const source = parsed.value;
  return {
    lastRun: source.lastRun || null,
    flags: source.flags || {},
    metrics: source.metrics || {},
  };
}

function loadState(filePath) {
  const parsed = readJson(filePath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return { state: {}, error: parsed.error || 'state_not_object' };
  return { state: parsed.value, error: null };
}

function monitorOptions(overrides = {}) {
  return {
    now: overrides.now || Date.now(),
    outputDir: path.resolve(overrides.outputDir || process.env.MM_MONITOR_OUTPUT_DIR || DEFAULT_OUTPUT_DIR),
    historyMaxBytes: Number(overrides.historyMaxBytes || process.env.MM_MONITOR_HISTORY_MAX_BYTES || 10 * 1024 * 1024),
    intervalMs: Number(overrides.intervalMs || process.env.MM_MONITOR_INTERVAL_MS || 15_000),
    pm2Bin: overrides.pm2Bin || process.env.MM_MONITOR_PM2_BIN || 'pm2',
    logsDir: path.resolve(overrides.logsDir || process.env.MM_MONITOR_LOGS_DIR || path.join(path.dirname(ROOT), '.pm2', 'logs')),
    dashboardUrl: overrides.dashboardUrl || process.env.MM_MONITOR_DASHBOARD_URL || 'http://127.0.0.1:18888',
    clobHealthUrl: overrides.clobHealthUrl || process.env.MM_MONITOR_CLOB_HEALTH_URL,
    rpcUrl: overrides.rpcUrl || process.env.MM_MONITOR_RPC_URL,
    networkTimeoutMs: Number(overrides.networkTimeoutMs || process.env.MM_MONITOR_NETWORK_TIMEOUT_MS || 3_000),
    oraclePath: path.resolve(overrides.oraclePath || process.env.MM_MONITOR_ORACLE_PATH || path.join(ROOT, 'external_signals.json')),
    supervisorPath: path.resolve(overrides.supervisorPath || process.env.MM_MONITOR_SUPERVISOR_PATH || path.join(ROOT, 'pre_live_supervisor_status.json')),
    dataDir: path.resolve(overrides.dataDir || process.env.MM_MONITOR_DATA_DIR || ROOT),
    stateFile: overrides.stateFile || process.env.MM_MONITOR_STATE_FILE || null,
  };
}

async function collectReport(overrides = {}) {
  const options = monitorOptions(overrides);
  const now = options.now;
  const timestamp = new Date(now).toISOString();
  const dashboardProbe = await probeDashboard(options.dashboardUrl, options.networkTimeoutMs);
  const pm2 = collectPm2(options.pm2Bin, now, options.logsDir);
  const engineLogPath = pm2.processes.engine?.outLogPath || path.join(options.logsDir, 'langomonEscript-out.log');
  const parsedEngine = parseEngineReports(tailText(engineLogPath, 12 * 1024 * 1024), now);
  const stateSelection = discoverStateFile(dashboardProbe.status, options.stateFile);
  const stateStat = safeStat(stateSelection.path, now, 60_000);
  const loadedState = loadState(stateSelection.path);
  const oracleStat = safeStat(options.oraclePath, now, 30_000);
  const eventFiles = collectEventFiles(now, options.dataDir);
  const routerTail = tailNdjson(path.join(options.dataDir, EVENT_FILES.router)).rows;
  const supervisor = loadSupervisorSnapshot(options.supervisorPath);
  const safetyStatus = buildSafety(parsedEngine, dashboardProbe.status, supervisor, routerTail, eventFiles);
  const paperPipeline = {
    minutes15: pipelineWindow(loadedState.state, now - 15 * 60_000, now),
    hour1: pipelineHourFromReport(parsedEngine),
  };
  const exposure = exposureFromReport(parsedEngine);
  const candidateStarvationDiagnostics = buildCandidateDiagnostics(loadedState.state, parsedEngine, safetyStatus, now);
  const apiAndDataSourceHealth = await collectApiHealth(options, oracleStat, dashboardProbe, eventFiles, stateStat, loadedState.error);
  const processes = pm2.processes;
  const report = {
    timestamp,
    monitor: {
      version: VERSION,
      localOnly: true,
      deterministic: true,
      readOnlyScope: true,
      llmUsed: false,
      paidApiUsed: false,
      productionCandidateFileWritten: false,
      realOrderSubmitted: false,
    },
    runtimeHealth: {
      overall: pm2.available && processes.engine?.online && processes.dashboard?.online && processes.oracle?.online && processes.liveRouter?.online && processes.telegram?.online && pm2.recentRuntimeErrors.length === 0 ? 'HEALTHY' : pm2.available ? 'DEGRADED' : 'UNKNOWN',
      pm2Available: pm2.available,
      pm2Error: pm2.error,
      processes,
      recentRuntimeErrors: pm2.recentRuntimeErrors,
      stateFile: { ...stateStat, source: stateSelection.source, parseError: loadedState.error },
      dashboardReport: {
        endpointHealth: dashboardProbe.health.status,
        generatedAt: dashboardProbe.status?.generatedAt || parsedEngine.reportAt,
        ageMs: dashboardProbe.status?.generatedAt ? Math.max(0, now - timestampMs(dashboardProbe.status.generatedAt)) : parsedEngine.reportAgeMs,
        freshness: dashboardProbe.status?.generatedAt && now - timestampMs(dashboardProbe.status.generatedAt) <= 15 * 60_000 ? 'fresh' : parsedEngine.reportFreshness,
        source: dashboardProbe.status ? 'dashboard_api_status' : 'engine_structured_report',
      },
    },
    safetyStatus,
    paperPipeline,
    exposure,
    candidateStarvationDiagnostics,
    starvationClassification: {
      dominant: candidateStarvationDiagnostics.dominantBlocker,
      counts: candidateStarvationDiagnostics.blockerCounts,
      exactCurrentWriterBlockersObserved: parsedEngine.exactWriterSkips.reduce((counts, skip) => {
        const classification = classifyWriterBlocker(skip.blocker);
        counts[classification] = (counts[classification] || 0) + 1;
        return counts;
      }, {}),
      note: 'VOL GUARD log lines are not treated as Gabagool blockers; only exact Gabagool lifecycle and candidate-writer evidence is classified.',
    },
    apiAndDataSourceHealth,
    operatorSummary: null,
  };
  report.operatorSummary = buildOperatorSummary(report);
  return { report, options };
}

async function runOnce(overrides = {}) {
  const { report, options } = await collectReport(overrides);
  const latestPath = path.join(options.outputDir, 'latest.json');
  const historyPath = path.join(options.outputDir, 'history.ndjson');
  atomicWriteJson(latestPath, report);
  appendRotatingHistory(historyPath, report, Math.max(1024, options.historyMaxBytes));
  process.stdout.write(formatConsole(report));
  return report;
}

async function watch(overrides = {}) {
  const options = monitorOptions(overrides);
  let stopped = false;
  let timer = null;
  let wakeWait = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (wakeWait) wakeWait();
    process.stdout.write('\nMoneyMaker monitor stopped cleanly.\n');
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopped) {
    try {
      await runOnce({ ...options, now: Date.now() });
    } catch (error) {
      process.stderr.write(`[MONITOR ERROR] ${redactLine(error.stack || error.message)}\n`);
    }
    if (stopped) break;
    await new Promise((resolve) => {
      wakeWait = resolve;
      timer = setTimeout(resolve, options.intervalMs);
    });
    wakeWait = null;
  }
}

async function main() {
  const watchMode = process.argv.includes('--watch');
  if (watchMode) await watch();
  else await runOnce();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[MONITOR FATAL] ${redactLine(error.stack || error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  VERSION,
  atomicWriteJson,
  appendRotatingHistory,
  buildCandidateDiagnostics,
  buildSafety,
  classifySafety,
  classifyWriterBlocker,
  collectReport,
  formatConsole,
  parseEngineReports,
  parseKeyValues,
  parsePm2Describe,
  parsePm2List,
  pipelineWindow,
  runOnce,
  sizingClassification,
};
