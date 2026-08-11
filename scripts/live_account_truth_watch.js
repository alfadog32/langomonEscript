'use strict';

const path = require('path');
const { initializeReadonlyAccountTruth, sanitizedErrorMessage, writeSnapshotAtomic } = require('./live_account_truth_readonly');
const { SCOPE: SINGLE_CANARY_SCOPE, evaluateSingleCanaryBaseline, hashObject } = require('../lib/stage5_canary_session');

const DEFAULT_REFRESH_INTERVAL_MS = 10_000;
const DEFAULT_HEALTH_PATH = './runtime_monitor/polymarket_live_account_truth_watch_health.json';

function snapshotBlockers(snapshot, { scope = 'global', nowMs = Date.now() } = {}) {
  if (scope === SINGLE_CANARY_SCOPE) {
    return evaluateSingleCanaryBaseline({ snapshot, nowMs, requireWatcher: false }).blockers;
  }
  const reconciliation = snapshot?.reconciliation || {};
  const blockers = Array.isArray(reconciliation.blockers) ? [...reconciliation.blockers] : [];
  if (snapshot?.account?.identityMatches !== true) blockers.push('LIVE_ACCOUNT_IDENTITY_UNCERTAIN');
  if (reconciliation.exposureReconciled !== true) blockers.push('LIVE_EXPOSURE_UNCERTAIN');
  if (reconciliation.dailyPnlReconciled !== true) blockers.push('LIVE_DAILY_PNL_UNCERTAIN');
  if (reconciliation.orderCountReconciled !== true) blockers.push('LIVE_ORDER_RATE_UNCERTAIN');
  if (reconciliation.fresh !== true) blockers.push('LIVE_ACCOUNT_SNAPSHOT_STALE');
  return [...new Set(blockers)];
}

class LiveAccountTruthWatcher {
  constructor({ refresh, snapshotPath, healthPath, intervalMs = DEFAULT_REFRESH_INTERVAL_MS, now = Date.now, pid = process.pid, schedule = setTimeout, cancel = clearTimeout, readinessScope = 'global' } = {}) {
    if (typeof refresh !== 'function') throw new Error('ACCOUNT_TRUTH_WATCH_REFRESH_REQUIRED');
    if (!snapshotPath || !healthPath) throw new Error('ACCOUNT_TRUTH_WATCH_PATH_REQUIRED');
    this.refresh = refresh;
    this.snapshotPath = snapshotPath;
    this.healthPath = healthPath;
    this.intervalMs = intervalMs;
    this.now = now;
    this.pid = pid;
    this.schedule = schedule;
    this.cancel = cancel;
    this.readinessScope = readinessScope;
    this.timer = null;
    this.stopped = false;
    this.health = {
      watcherPid: pid,
      running: false,
      startedAt: null,
      lastAttemptAt: null,
      lastSuccessfulRefresh: null,
      refreshAgeMs: null,
      consecutiveFailures: 0,
      consecutiveSuccessfulSnapshots: 0,
      exactBlockers: ['WATCHER_NOT_STARTED'],
      snapshotPath,
      readinessScope,
      healthGeneration: null,
      stoppedAt: null,
    };
  }

  writeHealth() {
    const successMs = Date.parse(this.health.lastSuccessfulRefresh || '');
    this.health.refreshAgeMs = Number.isFinite(successMs) ? Math.max(0, this.now() - successMs) : null;
    writeSnapshotAtomic(this.healthPath, this.health);
  }

  async refreshOnce() {
    this.health.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const rawSnapshot = await this.refresh({ nowMs: this.now() });
      const nextSuccessCount = this.health.consecutiveSuccessfulSnapshots + 1;
      const healthGeneration = hashObject({ observedAt: rawSnapshot.observedAt, pid: this.pid, success: nextSuccessCount, scope: this.readinessScope });
      const snapshot = {
        ...rawSnapshot,
        watcher: {
          readinessScope: this.readinessScope,
          healthGeneration,
          running: true,
          watcherPid: this.pid,
          lastSuccessfulRefresh: rawSnapshot.observedAt,
          consecutiveSuccessfulSnapshots: nextSuccessCount,
          consecutiveFailures: 0,
        },
      };
      const blockers = snapshotBlockers(snapshot, { scope: this.readinessScope, nowMs: this.now() });
      if (blockers.length) throw Object.assign(new Error('ACCOUNT_TRUTH_RECONCILIATION_INCOMPLETE'), { blockers });
      writeSnapshotAtomic(this.snapshotPath, snapshot);
      this.health.lastSuccessfulRefresh = snapshot.observedAt;
      this.health.consecutiveFailures = 0;
      this.health.consecutiveSuccessfulSnapshots += 1;
      this.health.healthGeneration = healthGeneration;
      this.health.globalReconciliationBlockers = Array.isArray(snapshot.reconciliation?.blockers) ? snapshot.reconciliation.blockers : [];
      this.health.singleCanarySessionEligible = this.readinessScope === SINGLE_CANARY_SCOPE;
      this.health.exactBlockers = [];
      this.health.lastFailureKind = null;
      this.writeHealth();
      return { ok: true, snapshot };
    } catch (error) {
      this.health.consecutiveFailures += 1;
      this.health.consecutiveSuccessfulSnapshots = 0;
      this.health.exactBlockers = Array.isArray(error.blockers) && error.blockers.length
        ? [...new Set(error.blockers)]
        : ['LIVE_ACCOUNT_TRUTH_REFRESH_FAILED'];
      this.health.lastFailureKind = error.blockers ? 'reconciliation' : 'read';
      this.health.lastError = sanitizedErrorMessage(error);
      this.writeHealth();
      return { ok: false, blockers: this.health.exactBlockers };
    }
  }

  async tick() {
    if (this.stopped) return;
    await this.refreshOnce();
    if (!this.stopped) this.timer = this.schedule(() => this.tick(), this.intervalMs);
  }

  async start() {
    if (this.health.running) return;
    this.stopped = false;
    this.health.running = true;
    this.health.startedAt = new Date(this.now()).toISOString();
    this.health.exactBlockers = [];
    this.writeHealth();
    await this.tick();
  }

  stop() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.stopped = true;
    this.health.running = false;
    this.health.stoppedAt = new Date(this.now()).toISOString();
    this.writeHealth();
  }
}

async function runWatcher({ env = process.env, baseDir = process.cwd(), runtimeFactory = initializeReadonlyAccountTruth } = {}) {
  const runtime = await runtimeFactory({ env, baseDir });
  const healthPath = path.resolve(baseDir, env.LIVE_ACCOUNT_TRUTH_WATCH_HEALTH_PATH || DEFAULT_HEALTH_PATH);
  const intervalMs = Number(env.LIVE_ACCOUNT_TRUTH_REFRESH_INTERVAL_MS || DEFAULT_REFRESH_INTERVAL_MS);
  const readinessScope = String(env.LIVE_ACCOUNT_TRUTH_WATCH_SCOPE || 'global');
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new Error('ACCOUNT_TRUTH_WATCH_INTERVAL_INVALID');
  const watcher = new LiveAccountTruthWatcher({
    refresh: runtime.refresh,
    snapshotPath: runtime.config.outputPath,
    healthPath,
    intervalMs,
    readinessScope,
  });
  const stop = () => {
    watcher.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await watcher.start();
  return watcher;
}

if (require.main === module) {
  runWatcher().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: sanitizedErrorMessage(error) }));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_HEALTH_PATH,
  DEFAULT_REFRESH_INTERVAL_MS,
  LiveAccountTruthWatcher,
  runWatcher,
  snapshotBlockers,
};
