'use strict';

const fs = require('fs');
const { SCOPE: SINGLE_CANARY_SCOPE, evaluateSingleCanaryBaseline, GLOBAL_HISTORY_BLOCKERS } = require('../lib/stage5_canary_session');

function evaluateAccountTruthWatcherHealth(health, { phase = 'prearm', nowMs = Date.now(), snapshot = null, candidate = null, existingSession = null } = {}) {
  const scope = String(health?.readinessScope || 'global');
  if (scope === SINGLE_CANARY_SCOPE && phase === 'prearm') {
    const policy = evaluateSingleCanaryBaseline({ snapshot, watcherHealth: health, candidate, existingSession, nowMs, requireWatcher: true });
    return {
      ok: policy.eligible,
      action: policy.eligible ? 'CONTINUE' : 'ABORT_AND_RESTORE_LOCKOFF',
      ageMs: policy.snapshotAgeMs,
      blockers: policy.blockers,
      scope,
      globalOrderHistoryReconciled: policy.globalOrderHistoryReconciled,
      singleCanarySessionEligible: policy.eligible,
    };
  }
  const blockers = [];
  if (!health || typeof health !== 'object' || health.running !== true || !Number.isInteger(Number(health.watcherPid)) || Number(health.watcherPid) <= 0) blockers.push('LIVE_ACCOUNT_TRUTH_WATCHER_NOT_RUNNING');
  const observedMs = Date.parse(health?.lastSuccessfulRefresh || '');
  const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : Infinity;
  const reconciliationBlockers = Array.isArray(health?.exactBlockers) ? health.exactBlockers : ['WATCHER_HEALTH_MALFORMED'];
  if (phase === 'prearm') {
    if (Number(health?.consecutiveSuccessfulSnapshots || 0) < 2) blockers.push('LIVE_ACCOUNT_TRUTH_TWO_SNAPSHOTS_REQUIRED');
    if (ageMs >= 15_000) blockers.push('LIVE_ACCOUNT_SNAPSHOT_STALE');
    if (Number(health?.consecutiveFailures || 0) !== 0) blockers.push('LIVE_ACCOUNT_TRUTH_REFRESH_FAILURE');
    blockers.push(...reconciliationBlockers);
  } else {
    if (Number(health?.consecutiveFailures || 0) >= 2) blockers.push('LIVE_ACCOUNT_TRUTH_TWO_REFRESH_FAILURES');
    if (health?.lastFailureKind === 'reconciliation') blockers.push('LIVE_ACCOUNT_TRUTH_RECONCILIATION_FAILED');
    if (ageMs > 20_000) blockers.push('LIVE_ACCOUNT_SNAPSHOT_STALE');
    const snapshotBlockers = Array.isArray(snapshot?.reconciliation?.blockers) ? snapshot.reconciliation.blockers : [];
    const disallowedSnapshotBlockers = scope === SINGLE_CANARY_SCOPE
      ? snapshotBlockers.filter((blocker) => !GLOBAL_HISTORY_BLOCKERS.has(blocker))
      : snapshotBlockers;
    if (snapshot && (snapshot.account?.identityMatches !== true || snapshot.reconciliation?.exposureReconciled !== true || snapshot.reconciliation?.dailyPnlReconciled !== true || (scope !== SINGLE_CANARY_SCOPE && snapshot.reconciliation?.orderCountReconciled !== true) || disallowedSnapshotBlockers.length > 0)) {
      blockers.push('LIVE_ACCOUNT_TRUTH_RECONCILIATION_FAILED');
    }
  }
  const unique = [...new Set(blockers)];
  return { ok: unique.length === 0, action: unique.length ? 'ABORT_AND_RESTORE_LOCKOFF' : 'CONTINUE', ageMs, blockers: unique, scope, globalOrderHistoryReconciled: snapshot?.reconciliation?.orderCountReconciled === true, singleCanarySessionEligible: scope === SINGLE_CANARY_SCOPE && unique.length === 0 };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

if (require.main === module) {
  const [healthPath, phase = 'prearm', snapshotPath, sessionPath] = process.argv.slice(2);
  try {
    const health = readJson(healthPath);
    const snapshot = snapshotPath ? readJson(snapshotPath) : null;
    const existingSession = sessionPath && fs.existsSync(sessionPath) ? readJson(sessionPath) : null;
    const result = evaluateAccountTruthWatcherHealth(health, { phase, snapshot, existingSession });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, action: 'ABORT_AND_RESTORE_LOCKOFF', blockers: ['LIVE_ACCOUNT_TRUTH_WATCHER_HEALTH_UNAVAILABLE'] }));
    process.exitCode = 1;
  }
}

module.exports = { evaluateAccountTruthWatcherHealth };
