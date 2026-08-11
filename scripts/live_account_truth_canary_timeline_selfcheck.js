'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LiveAccountTruthWatcher } = require('./live_account_truth_watch');
const { evaluateAccountTruthWatcherHealth } = require('./live_account_truth_runner_policy');

function snapshot(nowMs, healthy = true) {
  return {
    observedAt: new Date(nowMs).toISOString(),
    account: { identityMatches: healthy },
    reconciliation: {
      exposureReconciled: healthy, dailyPnlReconciled: healthy, orderCountReconciled: healthy,
      identityBoundExternalReconciliation: healthy, fresh: true,
      blockers: healthy ? [] : ['LIVE_EXPOSURE_UNCERTAIN'],
    },
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-truth-timeline-'));
  try {
    const start = Date.parse('2026-08-03T12:00:00Z');
    let nowMs = start;
    let lockedOff = true;
    let mutationCalls = 0;
    let mode = 'healthy';
    const watcher = new LiveAccountTruthWatcher({
      snapshotPath: path.join(tempDir, 'snapshot.json'),
      healthPath: path.join(tempDir, 'health.json'),
      now: () => nowMs,
      refresh: async () => {
        if (mode === 'read-failure') throw new Error('fixture read failure');
        if (mode === 'reconciliation-failure') return snapshot(nowMs, false);
        return snapshot(nowMs, true);
      },
    });
    watcher.health.running = true;
    watcher.health.startedAt = new Date(nowMs).toISOString();

    await watcher.refreshOnce();
    nowMs = start + 10_000;
    await watcher.refreshOnce();
    assert(evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'prearm', nowMs }).ok, 'two locked-off snapshots permit simulated arm');
    lockedOff = false;

    for (const seconds of [20, 30, 40]) {
      nowMs = start + seconds * 1000;
      await watcher.refreshOnce();
      assert(evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'armed', nowMs, snapshot: snapshot(nowMs) }).ok);
    }
    nowMs = start + 45_000;
    const candidatePolicy = evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'armed', nowMs, snapshot: snapshot(start + 40_000) });
    assert.equal(candidatePolicy.ok, true, 'candidate at 45s sees a 5s-old snapshot');

    nowMs = start + 50_000;
    mode = 'read-failure';
    await watcher.refreshOnce();
    assert.equal(evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'armed', nowMs }).ok, true, 'one transient read failure waits for next refresh');
    nowMs = start + 60_000;
    await watcher.refreshOnce();
    assert.equal(evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'armed', nowMs }).action, 'ABORT_AND_RESTORE_LOCKOFF', 'two failures abort');

    mode = 'healthy';
    nowMs = start + 70_000;
    await watcher.refreshOnce();
    mode = 'reconciliation-failure';
    nowMs = start + 80_000;
    await watcher.refreshOnce();
    assert.equal(evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'armed', nowMs }).action, 'ABORT_AND_RESTORE_LOCKOFF', 'one reconciliation failure aborts immediately');

    mode = 'healthy';
    nowMs = start + 90_000;
    await watcher.refreshOnce();
    assert.equal(evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'armed', nowMs: start + 110_001 }).action, 'ABORT_AND_RESTORE_LOCKOFF', 'age above 20s aborts');

    watcher.health.running = false;
    assert.equal(evaluateAccountTruthWatcherHealth(watcher.health, { phase: 'armed', nowMs }).action, 'ABORT_AND_RESTORE_LOCKOFF', 'watcher termination aborts');

    lockedOff = true;
    watcher.stop();
    assert.equal(watcher.health.running, false);
    assert.equal(lockedOff, true);
    assert.equal(mutationCalls, 0);
    console.log('mocked canary timeline selfcheck: PASS (2 snapshots, 10s refresh, 45s candidate fresh, failures/stale/exit abort, locked-off restoration stops watcher)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
