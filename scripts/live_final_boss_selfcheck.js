#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { LiveAdapter } = require('../live_adapter_polymarket');

function tempPath(name, ext = 'env') {
  return path.join('/tmp', `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
}

function tempDir(name) {
  return fs.mkdtempSync(path.join('/tmp', `${name}-${process.pid}-`));
}

function writeTempSecrets() {
  const filePath = tempPath('live-final-boss-secrets');
  fs.writeFileSync(filePath, [
    'POLYMARKET_PRIVATE_KEY=0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'POLYMARKET_API_KEY=dummy-api-key',
    'POLYMARKET_API_SECRET=dummy-api-secret',
    'POLYMARKET_API_PASSPHRASE=dummy-api-passphrase',
    'POLYMARKET_PROXY_WALLET_ADDRESS=0x1111111111111111111111111111111111111111',
    'POLYMARKET_FUNDER_ADDRESS=0x1111111111111111111111111111111111111111',
    'POLYMARKET_SIGNATURE_TYPE=3',
    'POLYMARKET_CHAIN_ID=137',
  ].join('\n'));
  return filePath;
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = new Map();
  for (const key of keys) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  const finalize = () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

function makeIntent(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    source: 'READINESS_TEST',
    strategy: 'SpreadHunter',
    route: 'READINESS',
    tokenId: '1234567890',
    marketId: 'readiness-test-market',
    side: 'BUY',
    price: 0.55,
    sizeUsd: 1,
    reason: 'live final boss selfcheck',
    confidence: 0.8,
    sophieApproved: true,
    consensusScore: 0.8,
    riskApproved: true,
    oracleSignal: false,
    oracleConfirmed: true,
    persistenceConfirmed: true,
    expectedEdge: 0.05,
    bookFresh: true,
    bookAgeMs: 250,
    bestBid: 0.54,
    bestAsk: 0.56,
    signalAgeMs: 250,
    decisionLatencyMs: 100,
    currentLiveExposureUsd: 0,
    currentDailyLivePnlUsd: 0,
    currentLiveOrdersLastHour: 0,
    tickSize: '0.01',
    minOrderSize: 0,
    negRisk: false,
    paperBurnIn: {
      ok: true,
      reports: 5,
      closedPnlUsd: 2,
      drawdownPct: 0.5,
      ghostFavorablePct: 25,
    },
    ...overrides,
  };
}

async function main() {
  const root = tempDir('live-final-boss-selfcheck');
  const tempSecrets = writeTempSecrets();
  const missingSecrets = tempPath('live-final-boss-missing');

  const baseEnv = {
    ENABLE_LIVE_TRADING: 'true',
    LIVE_AUTO_EXECUTE: 'true',
    LIVE_KILL_SWITCH: 'false',
    LIVE_DRY_RUN_ONLY: 'false',
    LIVE_SUBMIT_CONFIRM: 'true',
    LIVE_FINAL_BOSS_READY: 'true',
    LIVE_TRADING_STAGE: '2',
    LIVE_CANARY_MARKET_ID: 'readiness-test-market',
    LIVE_REQUIRE_BURN_IN: 'true',
    LIVE_REQUIRE_SOPHIE_APPROVAL: 'true',
    LIVE_REQUIRE_RISK_APPROVAL: 'true',
    LIVE_REQUIRE_ORACLE_CONFIRMATION: 'false',
    LIVE_REQUIRE_PERSISTENCE_CONFIRMATION: 'false',
    LIVE_MIN_EXPECTED_EDGE: '0.02',
    MAX_LIVE_ORDER_USD: '1',
    MAX_LIVE_TOTAL_EXPOSURE_USD: '1',
    LIVE_DAILY_MAX_LOSS_USD: '5',
    LIVE_MAX_BOOK_AGE_MS: '1500',
    LIVE_MAX_SIGNAL_AGE_MS: '10000',
    LIVE_MAX_DECISION_LATENCY_MS: '2000',
    LIVE_SIGNING_TEST_ALLOW: 'true',
    LIVE_AUTH_CHECK_ALLOW: 'true',
    LIVE_SECRETS_PATH: tempSecrets,
  };

  await withEnv({ ...baseEnv, LIVE_SECRETS_PATH: missingSecrets }, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const decision = adapter.live.secretAccessDecision('submit');
    assert.strictEqual(decision.ok, false, 'missing secrets must block live submit');
    assert(decision.reasons.includes('LIVE_SECRETS_FILE_MISSING'), 'missing secrets reason should be reported');
  });

  await withEnv({ ...baseEnv, LIVE_KILL_SWITCH: 'true' }, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const evaluation = await adapter.evaluate(makeIntent(), { mode: 'submit', fetchMetadata: false });
    assert(evaluation.reasons.includes('KILL_SWITCH_ACTIVE'), 'kill switch must block submit');
  });

  await withEnv(baseEnv, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const result = await adapter.handleIntent(makeIntent(), { mode: 'dry-run', fetchMetadata: false });
    assert.strictEqual(result.decision, 'DRY_RUN_ALLOWED_BUT_NOT_SUBMITTED', 'dry-run must not submit');
  });

  await withEnv(baseEnv, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const evaluation = await adapter.evaluate(makeIntent({ sizeUsd: 1.25 }), { mode: 'submit', fetchMetadata: false });
    assert(evaluation.reasons.includes('MAX_LIVE_ORDER_USD_EXCEEDED'), 'oversized live order must be blocked');
  });

  await withEnv(baseEnv, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const evaluation = await adapter.evaluate(makeIntent({ bookFresh: false, bookAgeMs: 5_000 }), { mode: 'submit', fetchMetadata: false });
    assert(evaluation.reasons.includes('BOOK_NOT_FRESH') || evaluation.reasons.includes('BOOK_TOO_OLD'), 'stale book must be blocked');
  });

  await withEnv(baseEnv, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const evaluation = await adapter.evaluate(makeIntent({ expectedEdge: 0.005 }), { mode: 'submit', fetchMetadata: false });
    assert(evaluation.reasons.includes('EXPECTED_EDGE_TOO_LOW'), 'weak edge must be blocked');
  });

  await withEnv(baseEnv, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const evaluation = await adapter.evaluate(makeIntent({ sophieApproved: true, riskApproved: false }), { mode: 'submit', fetchMetadata: false });
    assert(evaluation.reasons.includes('RISK_NOT_APPROVED'), 'risk disagreement must block submit');
  });

  // Stage 1 signing proof: kill switch stays ON, dry-run stays ON, only the
  // explicit LIVE_SIGNING_TEST_ALLOW env opt-in unlocks the non-submitting
  // signing proof path.  This proves the kill switch does NOT block auth/signing
  // proofs while it still blocks every real submit/cancel/reconcile path.
  await withEnv({
    ...baseEnv,
    LIVE_KILL_SWITCH: 'true',
    LIVE_DRY_RUN_ONLY: 'true',
    LIVE_SIGNING_TEST_ALLOW: 'true',
    LIVE_AUTH_CHECK_ALLOW: 'true',
    LIVE_TRADING_STAGE: '1',
    LIVE_FINAL_BOSS_READY: 'false',
  }, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const result = await adapter.signingTest(makeIntent());
    assert.strictEqual(result.submitted, false, 'signing test must never submit');

    // Strict: if signing did not actually produce a signed order, the only
    // acceptable classification is that the network is required and unreachable
    // here. We do NOT treat that as a Stage 1 pass — we classify it and FAIL
    // the readiness gate so callers know real network/CLOB/RPC access is needed.
    if (result.signed !== true) {
      const offline =
        result.signingProofError === 'NETWORK_REQUIRED_FOR_SIGNING_PROOF' ||
        result.clobReachable === false ||
        result.rpcReachable === false;
      if (offline) {
        // Exit with a distinct, non-zero, network-required code so CI / human
        // operators see it but do NOT mistake it for a pass.
        console.log(JSON.stringify({
          status: 'NETWORK_REQUIRED_FOR_SIGNING_PROOF',
          message: 'Stage 1 signing proof requires CLOB and Polygon RPC connectivity. Re-run with network access.',
          clobReachable: result.clobReachable,
          clobReachableError: result.clobReachableError,
          rpcReachable: result.rpcReachable,
          rpcReachableError: result.rpcReachableError,
          signingProofError: result.signingProofError,
          signingProofPassed: false,
          errors: result.errors || [],
        }, null, 2));
        process.exit(2);
      }
      // Any other signing failure (with reachable network) is a hard fail.
      throw new Error(
        `signing test failed without a network classification; ` +
        `errors=${JSON.stringify(result.errors || [])} ` +
        `signingProofError=${result.signingProofError}`
      );
    }

    assert.strictEqual(result.signingProofPassed, true, 'signingProofPassed must be true on signed proof');
    assert.strictEqual(result.clobReachable, true, 'clobReachable must be true when signing proof passed');
    assert.strictEqual(result.rpcReachable, true, 'rpcReachable must be true when signing proof passed');
    assert(Number.isFinite(result.orderConstructionLatencyMs), 'orderConstructionLatencyMs must be reported');
  });

  console.log('live_final_boss_selfcheck: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
