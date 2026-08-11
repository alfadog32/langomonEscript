'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LiveAccountTruthWatcher } = require('./live_account_truth_watch');
const { ALLOWED_CLOB_METHODS, assertReadOnlyClobClient } = require('../lib/polymarket_live_account_truth_readonly_client');
const { createRefusingSigner } = require('./live_account_truth_readonly');

function healthySnapshot(nowMs) {
  return {
    observedAt: new Date(nowMs).toISOString(),
    account: { identityMatches: true },
    reconciliation: {
      exposureReconciled: true,
      dailyPnlReconciled: true,
      orderCountReconciled: true,
      identityBoundExternalReconciliation: true,
      fresh: true,
      blockers: [],
    },
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-truth-watch-'));
  try {
    let nowMs = Date.parse('2026-08-03T12:00:00Z');
    let refreshes = 0;
    const snapshotPath = path.join(tempDir, 'snapshot.json');
    const healthPath = path.join(tempDir, 'health.json');
    const watcher = new LiveAccountTruthWatcher({
      snapshotPath,
      healthPath,
      now: () => nowMs,
      refresh: async () => { refreshes += 1; return healthySnapshot(nowMs); },
    });
    watcher.health.running = true;
    await watcher.refreshOnce();
    nowMs += 10_000;
    await watcher.refreshOnce();
    assert.equal(refreshes, 2);
    assert.equal(watcher.health.consecutiveSuccessfulSnapshots, 2);
    assert.equal(watcher.health.consecutiveFailures, 0);
    assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(healthPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(healthPath, 'utf8')).snapshotPath, snapshotPath);

    watcher.refresh = async () => ({ ...healthySnapshot(nowMs), reconciliation: { ...healthySnapshot(nowMs).reconciliation, orderCountReconciled: false, blockers: ['LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE'] } });
    const failed = await watcher.refreshOnce();
    assert.equal(failed.ok, false);
    assert.equal(watcher.health.lastFailureKind, 'reconciliation');
    assert.deepEqual(watcher.health.exactBlockers, ['LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE', 'LIVE_ORDER_RATE_UNCERTAIN']);

    let mutationCalls = 0;
    const raw = {};
    for (const method of ALLOWED_CLOB_METHODS) raw[method] = async () => method === 'getTradesPaginated' ? { trades: [], next_cursor: 'LTE=' } : [];
    for (const method of ['createOrder', 'createAndPostOrder', 'postOrder', 'cancelOrder', 'cancelAll', 'updateBalanceAllowance']) raw[method] = async () => { mutationCalls += 1; };
    const facade = assertReadOnlyClobClient(raw);
    assert.deepEqual(Object.keys(facade), ALLOWED_CLOB_METHODS);
    assert.equal('postOrder' in facade, false);
    assert.equal(mutationCalls, 0);

    const signer = createRefusingSigner('0x1111111111111111111111111111111111111111');
    for (const method of ['signTypedData', 'signMessage', 'signTransaction', 'sendTransaction']) await assert.rejects(signer[method](), /REFUSES_SIGNING/);

    watcher.stop();
    assert.equal(watcher.health.running, false);
    assert(watcher.health.stoppedAt);
    console.log('live account-truth watcher selfcheck: PASS (10s refresh, atomic 0600, health, fail-fast reconciliation, mutation-proof façade, refusing signer)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
