#!/usr/bin/env node
'use strict';

// Pre-Live Supervisor — read-only watchdog for paper burn-in stability.
//
// Writes ONLY to:
//   pre_live_supervisor_status.json
//   pre_live_supervisor_events.ndjson
//
// Does NOT modify any state, config, env, or trading files.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = process.cwd();
const STATUS_FILE = path.join(ROOT, 'pre_live_supervisor_status.json');
const EVENTS_FILE = path.join(ROOT, 'pre_live_supervisor_events.ndjson');

// PM2 process names to inspect
const PM2_PROCESS_NAMES = [
  'langomonEscript',
  'langomon-dashboard',
  'liveIntentRouter',
  'telegramApprovalBot',
  'btcPolyOracle',
];

// Decision/event files to inspect (read-only)
const DECISION_FILES = [
  'approval_decisions.ndjson',
  'trade_intents.ndjson',
  'auto_live_candidates.ndjson',
  'sniper_route_requests.ndjson',
];

// Unsafe live flags (env key => expected safe value)
const UNSAFE_FLAG_CHECKS = {
  ENABLE_LIVE_TRADING: 'false',
  LIVE_AUTO_EXECUTE: 'false',
  LIVE_KILL_SWITCH: 'true',
  LIVE_DRY_RUN_ONLY: 'true',
  LIVE_FINAL_BOSS_READY: 'false',
};

// Secrets files — check existence/readability only, never read contents
const SECRET_FILES = [
  '.env.live.secrets',
  '.env.telegram',
];

// Stable proof thresholds
const PROOF_CYCLES = 3;
const PROOF_INTERVAL_MS = 5 * 60 * 1000; // ~5 minutes
const PROOF_THRESHOLDS = {
  maxDrawdownPct: 5,
  minFillsLastHour: 3,
  minTrustedFills: 1, // > 0 means >= 1
  maxUntrustedFills: 0,
  maxRepeatSameTokenEntries: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function runCommand(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout || 15000,
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

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tailLines(filePath, maxLines = 200) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch (_) {
    return [];
  }
}

function tailNdjson(filePath, maxLines = 50) {
  const lines = tailLines(filePath, maxLines);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (_) { /* skip malformed */ }
  }
  return records;
}

function appendEvent(event) {
  const record = { ts: new Date().toISOString(), ...event };
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + '\n');
  } catch (_) { /* best effort */ }
}

function writeStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
  } catch (err) {
    console.error(`Failed to write status file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Inspectors
// ---------------------------------------------------------------------------

function inspectReadiness() {
  const result = runCommand('node', ['scripts/live_readiness_report.js'], { timeout: 30000 });
  if (!result.ok) {
    return { ok: false, error: result.stderr || 'readiness report failed', report: null };
  }
  try {
    const report = JSON.parse(result.stdout);
    return { ok: true, error: null, report };
  } catch (err) {
    return { ok: false, error: `readiness parse failed: ${err.message}`, report: null };
  }
}

function inspectPm2Logs() {
  const results = {};
  for (const name of PM2_PROCESS_NAMES) {
    const result = runCommand('pm2', ['logs', name, '--lines', '80', '--nostream'], { timeout: 8000 });
    const lines = result.ok ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
    const errors = lines.filter((l) =>
      /\bError\b|ERR!|ECONNREFUSED|ETIMEDOUT|crash|UnhandledPromise|SIGTERM|SIGKILL/i.test(l)
    );
    const crashPatterns = lines.filter((l) => /restart|Process failed to|Script .*? had too many/i.test(l));
    results[name] = {
      available: result.ok,
      lineCount: lines.length,
      errorLines: errors.slice(-10),
      crashIndicators: crashPatterns.slice(-5),
    };
  }
  return results;
}

function inspectDecisionFiles() {
  const results = {};
  for (const filename of DECISION_FILES) {
    const fullPath = path.join(ROOT, filename);
    const exists = fs.existsSync(fullPath);
    let lineCount = 0;
    let recentRecords = [];
    if (exists) {
      const lines = tailLines(fullPath, 20);
      lineCount = lines.length;
      recentRecords = tailNdjson(fullPath, 10);
    }
    results[filename] = { exists, lineCount, recentRecordCount: recentRecords.length };
  }
  return results;
}

function inspectUnsafeFlags() {
  const flags = {};
  const unsafe = [];
  for (const [key, expectedSafe] of Object.entries(UNSAFE_FLAG_CHECKS)) {
    const value = String(process.env[key] || '').trim().toLowerCase();
    const isSafe = value === '' || value === expectedSafe;
    flags[key] = { value: value || '(unset)', expected: expectedSafe, safe: isSafe };
    if (!isSafe) unsafe.push(`${key}=${value} (expected ${expectedSafe})`);
  }
  return { flags, unsafe };
}

function inspectSecretFiles() {
  const results = {};
  for (const filename of SECRET_FILES) {
    const fullPath = path.join(ROOT, filename);
    const exists = fs.existsSync(fullPath);
    let readable = false;
    if (exists) {
      try {
        fs.accessSync(fullPath, fs.constants.R_OK);
        readable = true;
      } catch (_) { /* not readable */ }
    }
    // Report existence/readability status only — never read content
    results[filename] = { exists, readable };
  }
  return results;
}

function inspectCrashLoops() {
  const result = runCommand('pm2', ['jlist'], { timeout: 5000 });
  if (!result.ok) return { available: false, processes: {} };
  try {
    const parsed = JSON.parse(result.stdout);
    const processes = {};
    for (const proc of (Array.isArray(parsed) ? parsed : [])) {
      const name = proc.name || '';
      if (!PM2_PROCESS_NAMES.includes(name)) continue;
      const restarts = proc.pm2_env?.restart_time || 0;
      const unstableRestarts = proc.pm2_env?.unstable_restarts || 0;
      const status = proc.pm2_env?.status || 'unknown';
      const uptimeMs = proc.pm2_env?.pm_uptime
        ? Math.max(0, Date.now() - proc.pm2_env.pm_uptime)
        : 0;
      // Crash loop heuristic: require crash evidence — errored status, unstable
      // (abnormal) restarts, or very rapid restart churn. A high lifetime restart
      // count alone (e.g. after controlled `pm2 restart` for patching/arming) is
      // not treated as a crash loop.
      const rapidChurn = restarts > 5 && uptimeMs < 60_000;
      const crashLoop = status === 'errored'
        || unstableRestarts > 3
        || (unstableRestarts > 0 && uptimeMs < 120_000)
        || rapidChurn;
      processes[name] = { status, restarts, unstableRestarts, uptimeMs, crashLoop };
    }
    return { available: true, processes };
  } catch (_) {
    return { available: false, processes: {} };
  }
}

function inspectTelegramPolling() {
  const logResult = runCommand('pm2', ['logs', 'telegramApprovalBot', '--lines', '200', '--nostream'], { timeout: 8000 });
  if (!logResult.ok) return { available: false, failures: 0, recoveries: 0, lastError: null };
  const lines = logResult.stdout.split(/\r?\n/).filter(Boolean);
  const failures = lines.filter((l) => /polling error|ETELEGRAM|EFATAL|getUpdates.*failed|connect ETIMEDOUT/i.test(l));
  const recoveries = lines.filter((l) => /polling recovered|reconnected|getUpdates.*ok/i.test(l));
  return {
    available: true,
    failures: failures.length,
    recoveries: recoveries.length,
    lastError: failures.length > 0 ? failures[failures.length - 1].slice(0, 200) : null,
  };
}

// ---------------------------------------------------------------------------
// Single cycle
// ---------------------------------------------------------------------------

function runCycle() {
  const ts = new Date().toISOString();
  const detections = [];

  // 1. Run live:readiness
  const readiness = inspectReadiness();
  let readinessReport = readiness.report;
  if (!readiness.ok) {
    detections.push({ type: 'readiness_error', detail: readiness.error });
  }

  // Extract key metrics from readiness report
  const health = readinessReport?.paperEngineHealth || {};
  const stateProfile = health.stateProfile || {};
  const burnInLifecycle = health.burnInLifecycle || {};
  const safetyFlags = readinessReport?.safetyFlags || {};
  const liveFinalBoss = readinessReport?.liveFinalBossGate || {};

  // 2. Unsafe live flags
  const flagInspection = inspectUnsafeFlags();
  if (flagInspection.unsafe.length > 0) {
    detections.push({ type: 'unsafe_live_flags', detail: flagInspection.unsafe.join('; ') });
  }
  // Also check readiness report safety flags
  for (const [name, check] of Object.entries(safetyFlags)) {
    if (check && !check.ok) {
      detections.push({ type: 'unsafe_live_flags', detail: `${name} expected=${check.expected} got=${check.value}` });
    }
  }
  // Check canSubmitLive from readiness report
  if (liveFinalBoss.canSubmitLive === true) {
    detections.push({ type: 'unsafe_live_flags', detail: 'canSubmitLive=true — live submission is armed' });
  }

  // 3. Runtime errors from PM2 logs
  const pm2Logs = inspectPm2Logs();
  for (const [name, info] of Object.entries(pm2Logs)) {
    if (info.errorLines.length > 0) {
      detections.push({ type: 'runtime_errors', process: name, detail: info.errorLines.slice(-3).join(' | ') });
    }
  }

  // 4. Crash loops
  const crashInfo = inspectCrashLoops();
  for (const [name, info] of Object.entries(crashInfo.processes)) {
    if (info.crashLoop) {
      detections.push({ type: 'crash_loop', process: name, detail: `status=${info.status} restarts=${info.restarts} unstableRestarts=${info.unstableRestarts}` });
    }
  }

  // 5. state_profile_mismatch
  if (stateProfile.status === 'state_profile_mismatch') {
    detections.push({ type: 'state_profile_mismatch', detail: stateProfile.summary || 'state profile does not match runtime' });
  }

  // 6. burn_in_failed_by_drawdown
  if (burnInLifecycle.status === 'burn_in_failed_by_drawdown' || stateProfile.status === 'burn_in_failed_by_drawdown') {
    detections.push({ type: 'burn_in_failed_by_drawdown', detail: `reason=${burnInLifecycle.reason || 'unknown'}` });
  }

  // 6b. gabagool loss guard active / closed loss over limit
  const gabagoolGuard = health.gabagoolEntryGuard || {};
  const gabagoolEntriesPaused = gabagoolGuard.entriesPaused === true;
  const gabagoolEntryPauseReason = String(gabagoolGuard.pauseReason || 'none');
  const gabagoolClosedLossUsd = numberOrNull(gabagoolGuard.currentClosedLossUsd);
  const gabagoolMaxClosedLossUsd = numberOrNull(gabagoolGuard.maxClosedLossUsd);
  if (gabagoolGuard.lossGuardActive === true || gabagoolEntriesPaused || gabagoolEntryPauseReason === 'gabagool_loss_guard') {
    detections.push({
      type: 'gabagool_loss_guard',
      detail: `gabagoolEntriesPaused=${gabagoolEntriesPaused} reason=${gabagoolEntryPauseReason} ` +
        `currentClosedLossUsd=${gabagoolClosedLossUsd ?? 'NA'} maxClosedLossUsd=${gabagoolMaxClosedLossUsd ?? 'NA'} ` +
        `cooldownRemainingMs=${gabagoolGuard.cooldownRemainingMs ?? 'NA'} recoveryActive=${gabagoolGuard.recoveryActive === true}`,
    });
  }
  if (gabagoolClosedLossUsd !== null && gabagoolMaxClosedLossUsd !== null && gabagoolClosedLossUsd > gabagoolMaxClosedLossUsd) {
    detections.push({
      type: 'gabagool_closed_loss_over_limit',
      detail: `currentClosedLossUsd=${gabagoolClosedLossUsd} > maxClosedLossUsd=${gabagoolMaxClosedLossUsd}`,
    });
  }

  // 7. action_rate_below_target
  const reasons = readinessReport?.reasons || [];
  const actionRateReason = reasons.find((r) => /action_rate_below_target/i.test(r));
  if (actionRateReason) {
    detections.push({ type: 'action_rate_below_target', detail: actionRateReason });
  }

  // 8. Sophie admitted but final Risk blocked
  const sophieBlockedReason = reasons.find((r) => /sophie_admitted_but_final_risk_gate_blocked/i.test(r));
  if (sophieBlockedReason) {
    detections.push({ type: 'sophie_admitted_risk_blocked', detail: sophieBlockedReason });
  }

  // 9. fills below target
  const fillsLastHour = numberOrNull(health.fillsLastHour);
  if (fillsLastHour !== null && fillsLastHour < 3) {
    detections.push({ type: 'fills_below_target', detail: `fillsLastHour=${fillsLastHour} (required >= 3)` });
  }

  // 10. repeatSameTokenEntries > 0
  // Primary: pipeline1h.repeatSameTokenEntries from live_readiness_report.
  // Fallback: any older fillRealism repeated-entry field.
  const pipeline1h = health.pipeline1h || {};
  const repeatFromPipeline = numberOrNull(pipeline1h.repeatSameTokenEntries);
  const repeatFromFillRealism = numberOrNull(
    health.fillRealism?.repeatedSameMarketSameTokenEntriesLastHour ??
    health.fillRealism?.repeatSameTokenEntries ??
    health.repeatedSameMarketSameTokenEntriesLastHour
  );
  const repeatSameToken = repeatFromPipeline !== null ? repeatFromPipeline : repeatFromFillRealism;

  if (repeatSameToken === null) {
    detections.push({
      type: 'repeat_same_token_entries_unavailable',
      detail: 'repeatSameTokenEntries telemetry missing from pipeline1h and fillRealism'
    });
  } else if (repeatSameToken > 0) {
    detections.push({
      type: 'repeat_same_token_entries',
      detail: `repeatSameTokenEntries=${repeatSameToken}`
    });
  }

  // 11. unexplained exposure mismatch
  const exposureAudit = health.exposureAudit || {};
  if (exposureAudit.unexplainedExposureUsd != null && Number(exposureAudit.unexplainedExposureUsd) > 1) {
    detections.push({ type: 'unexplained_exposure_mismatch', detail: `unexplainedExposureUsd=${exposureAudit.unexplainedExposureUsd}` });
  }

  // 12. Telegram polling failures/recoveries
  const telegram = inspectTelegramPolling();
  if (telegram.failures > 3) {
    detections.push({ type: 'telegram_polling_failures', detail: `failures=${telegram.failures} recoveries=${telegram.recoveries} lastError=${telegram.lastError || 'none'}` });
  }

  // 13. Secrets status (existence/readability only, never values)
  const secrets = inspectSecretFiles();

  // 14. Decision files status
  const decisionFiles = inspectDecisionFiles();

  // Drawdown
  const drawdownPct = numberOrNull(health.drawdownPct);
  const trustedFills = numberOrNull(health.trustedFillsLastHour);
  const untrustedFills = numberOrNull(health.untrustedFillsLastHour);

  const cycleResult = {
    ts,
    readinessOk: readiness.ok,
    readyForMicroLive: readinessReport?.READY_FOR_MICRO_LIVE || false,
    detections,
    metrics: {
      ordersPlacedLastHour: numberOrNull(health.ordersPlacedLastHour ?? health.paperOrdersPlacedLastHour),
      fillsLastHour,
      fillRateLastHour: numberOrNull(health.fillRateLastHour),
      fillRateByPlacedOrdersLastHour: numberOrNull(health.fillRateByPlacedOrdersLastHour),
      trustedFillsLastHour: trustedFills,
      untrustedFillsLastHour: untrustedFills,
      drawdownPct,
      repeatSameTokenEntries: repeatSameToken,
      burnInLifecycleStatus: burnInLifecycle.status || null,
      stateProfileStatus: stateProfile.status || null,
      openOrders: numberOrNull(health.openOrders),
      candidateEvaluationsLastHour: numberOrNull(health.candidateEvaluationsLastHour),
      paperOrdersPlacedLastHour: numberOrNull(health.paperOrdersPlacedLastHour),
      gabagoolEntriesPaused,
      gabagoolEntryPauseReason,
      gabagoolClosedLossUsd,
      gabagoolMaxClosedLossUsd,
      gabagoolLossGuardCooldownRemainingMs: numberOrNull(gabagoolGuard.cooldownRemainingMs),
      gabagoolLossGuardRecoveryActive: gabagoolGuard.recoveryActive === true,
    },
    flags: flagInspection.flags,
    secrets,
    crashLoops: crashInfo.processes,
    telegram,
    decisionFiles,
    pm2LogSummary: Object.fromEntries(
      Object.entries(pm2Logs).map(([k, v]) => [k, { available: v.available, errors: v.errorLines.length, crashes: v.crashIndicators.length }])
    ),
    reasons: readinessReport?.reasons || [],
  };

  appendEvent({ type: 'cycle', ...cycleResult });
  return cycleResult;
}

// ---------------------------------------------------------------------------
// Stable proof mode
// ---------------------------------------------------------------------------

function isProofCyclePassing(cycle) {
  const blockers = [];

  // live safety remains OFF
  if (cycle.detections.some((d) => d.type === 'unsafe_live_flags')) {
    blockers.push('unsafe_live_flags_detected');
  }

  // state profile clean
  if (cycle.metrics.stateProfileStatus !== 'state_profile_clean') {
    blockers.push(`state_profile_status=${cycle.metrics.stateProfileStatus || 'unknown'}`);
  }

  // burn-in clean
  const burnInStatus = cycle.metrics.burnInLifecycleStatus || '';
  if (burnInStatus === 'burn_in_failed_by_drawdown') {
    blockers.push('burn_in_failed_by_drawdown');
  }

  // gabagool loss guard must be clear before a live canary can be considered stable
  if (cycle.metrics.gabagoolEntriesPaused === true || cycle.metrics.gabagoolEntryPauseReason === 'gabagool_loss_guard') {
    blockers.push('gabagool_loss_guard_active (do not arm live canary yet)');
  }
  const gabagoolClosedLoss = cycle.metrics.gabagoolClosedLossUsd;
  const gabagoolMaxClosedLoss = cycle.metrics.gabagoolMaxClosedLossUsd;
  if (gabagoolClosedLoss !== null && gabagoolMaxClosedLoss !== null && gabagoolClosedLoss > gabagoolMaxClosedLoss) {
    blockers.push(`gabagool_closed_loss_over_limit ${gabagoolClosedLoss} > ${gabagoolMaxClosedLoss}`);
  }

  // no runtime errors (crash loops)
  if (cycle.detections.some((d) => d.type === 'crash_loop')) {
    blockers.push('crash_loop_detected');
  }

  // readiness report must have run successfully
  if (!cycle.readinessOk) {
    blockers.push('readiness_report_failed');
  }

  // repeatSameTokenEntries=0. Fail closed if telemetry is unavailable.
  const repeat = cycle.metrics.repeatSameTokenEntries;
  if (repeat === null) {
    blockers.push('repeatSameTokenEntries_unavailable');
  } else if (repeat > PROOF_THRESHOLDS.maxRepeatSameTokenEntries) {
    blockers.push(`repeatSameTokenEntries=${repeat}`);
  }

  // drawdown < 5
  const dd = cycle.metrics.drawdownPct;
  if (dd !== null && dd >= PROOF_THRESHOLDS.maxDrawdownPct) {
    blockers.push(`drawdownPct=${dd} >= ${PROOF_THRESHOLDS.maxDrawdownPct}`);
  }

  // fillsLastHour >= 3
  const fills = cycle.metrics.fillsLastHour;
  if (fills === null || fills < PROOF_THRESHOLDS.minFillsLastHour) {
    blockers.push(`fillsLastHour=${fills} < ${PROOF_THRESHOLDS.minFillsLastHour}`);
  }

  // trusted fills > 0
  const trusted = cycle.metrics.trustedFillsLastHour;
  if (trusted === null || trusted < PROOF_THRESHOLDS.minTrustedFills) {
    blockers.push(`trustedFillsLastHour=${trusted} < ${PROOF_THRESHOLDS.minTrustedFills}`);
  }

  // untrusted fills = 0
  const untrusted = cycle.metrics.untrustedFillsLastHour;
  if (untrusted !== null && untrusted > PROOF_THRESHOLDS.maxUntrustedFills) {
    blockers.push(`untrustedFillsLastHour=${untrusted} > ${PROOF_THRESHOLDS.maxUntrustedFills}`);
  }

  // no unexplained exposure mismatch
  if (cycle.detections.some((d) => d.type === 'unexplained_exposure_mismatch')) {
    blockers.push('unexplained_exposure_mismatch');
  }

  return { passing: blockers.length === 0, blockers };
}

async function runStableProof() {
  console.log(`\n=== PRE-LIVE SUPERVISOR: STABLE PROOF MODE ===`);
  console.log(`Cycles: ${PROOF_CYCLES}, interval: ~${Math.round(PROOF_INTERVAL_MS / 1000)}s\n`);

  const cycleResults = [];

  for (let i = 0; i < PROOF_CYCLES; i++) {
    const cycleNum = i + 1;
    console.log(`--- Cycle ${cycleNum}/${PROOF_CYCLES} @ ${new Date().toISOString()} ---`);

    const cycle = runCycle();
    const rawProofCheck = isProofCyclePassing(cycle);
    const labeledBlockers = rawProofCheck.blockers.map((blocker) => {
      const text = String(blocker);
      if (text.startsWith('fillsLastHour=')) return `fills_below_target_cycle_${cycleNum}: ${text}`;
      if (text === 'repeatSameTokenEntries_unavailable') return `repeatSameTokenEntries_unavailable_cycle_${cycleNum}`;
      return text;
    });
    const proofCheck = { passing: rawProofCheck.passing, blockers: labeledBlockers };
    cycleResults.push({ cycle: cycleNum, ...proofCheck, metrics: cycle.metrics, detectionCount: cycle.detections.length });

    console.log(`  Detections: ${cycle.detections.length}`);
    console.log(`  Orders: ${cycle.metrics.ordersPlacedLastHour}, Fills: ${cycle.metrics.fillsLastHour}, FillRate: ${cycle.metrics.fillRateLastHour}%`);
    console.log(`  Trusted: ${cycle.metrics.trustedFillsLastHour}, Untrusted: ${cycle.metrics.untrustedFillsLastHour}`);
    console.log(`  Drawdown: ${cycle.metrics.drawdownPct}%`);
    console.log(`  RepeatSameToken: ${cycle.metrics.repeatSameTokenEntries}`);
    console.log(`  BurnIn: ${cycle.metrics.burnInLifecycleStatus}`);
    console.log(`  StateProfile: ${cycle.metrics.stateProfileStatus}`);
    console.log(`  Proof passing: ${proofCheck.passing}${proofCheck.blockers.length > 0 ? ' — blockers: ' + proofCheck.blockers.join(', ') : ''}`);

    if (i < PROOF_CYCLES - 1) {
      console.log(`  Waiting ${Math.round(PROOF_INTERVAL_MS / 1000)}s for next cycle...\n`);
      await new Promise((resolve) => setTimeout(resolve, PROOF_INTERVAL_MS));
    }
  }

  const allPassing = cycleResults.every((r) => r.passing);
  const allBlockers = [...new Set(cycleResults.flatMap((r) => r.blockers))];

  const proofResult = {
    ts: new Date().toISOString(),
    mode: 'stable_proof',
    cycles: PROOF_CYCLES,
    intervalMs: PROOF_INTERVAL_MS,
    allPassing,
    cycleResults,
    allBlockers,
  };

  appendEvent({ type: 'stable_proof_result', ...proofResult });

  const status = {
    lastRun: new Date().toISOString(),
    mode: 'stable_proof',
    PAPER_STABLE_FOR_CANARY: allPassing,
    cycles: PROOF_CYCLES,
    allBlockers,
    cycleResults,
  };
  writeStatus(status);

  console.log('\n=== STABLE PROOF RESULT ===');
  if (allPassing) {
    console.log('PAPER_STABLE_FOR_CANARY=true');
  } else {
    console.log('PAPER_STABLE_FOR_CANARY=false');
    console.log(`Blockers: ${allBlockers.join(', ')}`);
  }
  console.log('');

  return proofResult;
}

// ---------------------------------------------------------------------------
// Single-shot inspection mode
// ---------------------------------------------------------------------------

function runSingleInspection() {
  console.log(`\n=== PRE-LIVE SUPERVISOR: SINGLE INSPECTION ===`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const cycle = runCycle();
  const proofCheck = isProofCyclePassing(cycle);

  const status = {
    lastRun: new Date().toISOString(),
    mode: 'single',
    PAPER_STABLE_FOR_CANARY: proofCheck.passing,
    cycles: 1,
    allBlockers: proofCheck.blockers,
    metrics: cycle.metrics,
    detections: cycle.detections,
    flags: cycle.flags,
    secrets: cycle.secrets,
    crashLoops: cycle.crashLoops,
    telegram: cycle.telegram,
    decisionFiles: cycle.decisionFiles,
    pm2LogSummary: cycle.pm2LogSummary,
    reasons: cycle.reasons,
  };
  writeStatus(status);

  console.log('Detections:');
  if (cycle.detections.length === 0) {
    console.log('  (none)');
  } else {
    for (const d of cycle.detections) {
      console.log(`  [${d.type}] ${d.detail || ''}${d.process ? ' (process: ' + d.process + ')' : ''}`);
    }
  }

  console.log('\nMetrics:');
  console.log(`  ordersPlacedLastHour: ${cycle.metrics.ordersPlacedLastHour}`);
  console.log(`  fillsLastHour: ${cycle.metrics.fillsLastHour}`);
  console.log(`  fillRateLastHour: ${cycle.metrics.fillRateLastHour}%`);
  console.log(`  trustedFillsLastHour: ${cycle.metrics.trustedFillsLastHour}`);
  console.log(`  untrustedFillsLastHour: ${cycle.metrics.untrustedFillsLastHour}`);
  console.log(`  drawdownPct: ${cycle.metrics.drawdownPct}%`);
  console.log(`  repeatSameTokenEntries: ${cycle.metrics.repeatSameTokenEntries}`);
  console.log(`  burnInLifecycleStatus: ${cycle.metrics.burnInLifecycleStatus}`);
  console.log(`  stateProfileStatus: ${cycle.metrics.stateProfileStatus}`);
  console.log(`  openOrders: ${cycle.metrics.openOrders}`);
  console.log(`  gabagoolEntriesPaused: ${cycle.metrics.gabagoolEntriesPaused} (reason=${cycle.metrics.gabagoolEntryPauseReason})`);
  console.log(`  gabagoolClosedLossUsd: ${cycle.metrics.gabagoolClosedLossUsd} (max ${cycle.metrics.gabagoolMaxClosedLossUsd}, cooldownRemainingMs=${cycle.metrics.gabagoolLossGuardCooldownRemainingMs}, recoveryActive=${cycle.metrics.gabagoolLossGuardRecoveryActive})`);

  console.log('\nFlags:');
  for (const [key, info] of Object.entries(cycle.flags)) {
    const mark = info.safe ? 'SAFE' : 'UNSAFE';
    console.log(`  ${key}: ${info.value} [${mark}]`);
  }

  console.log('\nSecrets (existence/readability only):');
  for (const [file, info] of Object.entries(cycle.secrets)) {
    console.log(`  ${file}: exists=${info.exists} readable=${info.readable}`);
  }

  console.log('\nCrash loop status:');
  for (const [name, info] of Object.entries(cycle.crashLoops)) {
    const mark = info.crashLoop ? 'CRASH-LOOP' : 'ok';
    console.log(`  ${name}: ${info.status} restarts=${info.restarts} [${mark}]`);
  }

  console.log('\nTelegram polling:');
  console.log(`  available: ${cycle.telegram.available}`);
  console.log(`  failures: ${cycle.telegram.failures}`);
  console.log(`  recoveries: ${cycle.telegram.recoveries}`);

  console.log('\nDecision files:');
  for (const [file, info] of Object.entries(cycle.decisionFiles)) {
    console.log(`  ${file}: exists=${info.exists} recentRecords=${info.recentRecordCount}`);
  }

  console.log('\nReadiness reasons:');
  if (cycle.reasons.length === 0) {
    console.log('  (none — ready)');
  } else {
    for (const r of cycle.reasons) {
      console.log(`  - ${r}`);
    }
  }

  console.log('\nProof check:');
  if (proofCheck.passing) {
    console.log('  PAPER_STABLE_FOR_CANARY=true');
  } else {
    console.log('  PAPER_STABLE_FOR_CANARY=false');
    console.log(`  Blockers: ${proofCheck.blockers.join(', ')}`);
  }
  console.log('');

  return status;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  loadEnvFile(path.join(ROOT, '.env'));

  const args = process.argv.slice(2);
  const mode = args[0] || 'single';

  if (mode === 'proof' || mode === 'stable-proof') {
    await runStableProof();
  } else {
    runSingleInspection();
  }
}

main().catch((err) => {
  console.error(`[PRE-LIVE SUPERVISOR ERROR] ${err.stack || err.message}`);
  process.exit(1);
});
