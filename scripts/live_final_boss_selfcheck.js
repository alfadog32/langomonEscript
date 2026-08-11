#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  LiveAdapter,
  resolveLiveStageProfile,
  resolvePolymarketFunderAddress,
  resolvePolymarketBuilderCode,
} = require('../live_adapter_polymarket');

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
    'DEPOSIT_WALLET_ADDRESS=0x1111111111111111111111111111111111111111',
    'POLYMARKET_PROXY_WALLET_ADDRESS=0x1111111111111111111111111111111111111111',
    'POLYMARKET_FUNDER_ADDRESS=0x1111111111111111111111111111111111111111',
    'POLYMARKET_SIGNATURE_TYPE=3',
    'POLY_BUILDER_CODE=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

  withEnv({
    POLYMARKET_SIGNATURE_TYPE: '3',
    DEPOSIT_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
    POLYMARKET_FUNDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    POLYMARKET_PROXY_WALLET_ADDRESS: '0x2222222222222222222222222222222222222222',
  }, () => {
    const resolution = resolvePolymarketFunderAddress(process.env);
    assert.strictEqual(resolution.source, 'DEPOSIT_WALLET_ADDRESS', 'type-3 funder must prefer deposit wallet');
    assert.strictEqual(
      String(resolution.funderAddress || '').toLowerCase(),
      '0x1111111111111111111111111111111111111111',
      'type-3 funder must resolve to deposit/funder address'
    );
    assert(resolution.warnings.includes('TYPE_3_PROXY_IGNORED'), 'type-3 proxy override must be ignored');
  });

  withEnv({
    POLYMARKET_SIGNATURE_TYPE: '3',
    DEPOSIT_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
    POLYMARKET_FUNDER_ADDRESS: '0x3333333333333333333333333333333333333333',
    POLYMARKET_PROXY_WALLET_ADDRESS: '0x2222222222222222222222222222222222222222',
  }, () => {
    const resolution = resolvePolymarketFunderAddress(process.env);
    assert(resolution.errors.includes('TYPE_3_FUNDER_DEPOSIT_MISMATCH'), 'type-3 deposit/funder mismatch must fail closed');
  });

  withEnv({
    POLYMARKET_SIGNATURE_TYPE: '3',
    DEPOSIT_WALLET_ADDRESS: undefined,
    POLYMARKET_FUNDER_ADDRESS: undefined,
    POLYMARKET_PROXY_WALLET_ADDRESS: '0x2222222222222222222222222222222222222222',
  }, () => {
    const resolution = resolvePolymarketFunderAddress(process.env);
    assert(resolution.errors.includes('TYPE_3_FUNDER_MISSING'), 'type-3 missing funder/deposit must fail closed');
  });

  withEnv({
    POLY_BUILDER_CODE: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }, () => {
    const resolution = resolvePolymarketBuilderCode(process.env);
    assert.strictEqual(resolution.present, true, 'builder code should be detected when set');
    assert.strictEqual(resolution.valid, true, 'hex builder code should validate');
  });

  withEnv({
    POLY_BUILDER_CODE: 'builder-code-invalid',
  }, () => {
    const resolution = resolvePolymarketBuilderCode(process.env);
    assert.strictEqual(resolution.present, true, 'invalid builder code should still count as present');
    assert.strictEqual(resolution.valid, false, 'non-hex builder code must fail validation');
    assert(resolution.errors.includes('POLY_BUILDER_CODE_INVALID_HEX'), 'invalid builder code reason must be reported');
  });

  await withEnv({ ...baseEnv, LIVE_KILL_SWITCH: 'true' }, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    const evaluation = await adapter.evaluate(makeIntent(), { mode: 'submit', fetchMetadata: false });
    assert(evaluation.reasons.includes('KILL_SWITCH_ACTIVE'), 'kill switch must block submit');
  });

  await withEnv(baseEnv, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    let networkOrSigningCalls = 0;
    adapter.live.init = async () => { networkOrSigningCalls += 1; throw new Error('fixture must refuse before init'); };
    adapter.live.getOpenOrders = async () => { networkOrSigningCalls += 1; throw new Error('fixture must refuse before network'); };
    adapter.live.signOrderOnly = async () => { networkOrSigningCalls += 1; throw new Error('fixture must refuse before signing'); };
    adapter.live.postSignedOrder = async () => { networkOrSigningCalls += 1; throw new Error('fixture must refuse before submission'); };
    const result = await adapter.handleIntent(makeIntent(), { mode: 'dry-run', fetchMetadata: false });
    assert.strictEqual(result.decision, 'REFUSED', 'missing authenticated account truth must fail closed even in dry-run mode');
    assert(result.reasons.includes('LIVE_ACCOUNT_IDENTITY_UNCERTAIN'), 'missing authenticated identity must be reported');
    assert(result.reasons.includes('LIVE_ACCOUNT_SNAPSHOT_STALE'), 'missing authenticated snapshot must be reported');
    assert.strictEqual(result.safety.submitted, false, 'account-truth refusal must not submit');
    assert.strictEqual(result.safety.signed, false, 'account-truth refusal must not sign');
    assert.strictEqual(result.safety.privateKeyAccessed, false, 'account-truth refusal must not access a private key');
    assert.strictEqual(networkOrSigningCalls, 0, 'account-truth refusal must not initialize, sign, query, or submit');
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

  // The authoritative self-check stays fully locked off. Account-truth and
  // safety refusal must happen before initialization, signing, or networking.
  await withEnv({
    ...baseEnv,
    ENABLE_LIVE_TRADING: 'false',
    LIVE_AUTO_EXECUTE: 'false',
    LIVE_KILL_SWITCH: 'true',
    LIVE_DRY_RUN_ONLY: 'true',
    LIVE_SUBMIT_CONFIRM: 'false',
    LIVE_FINAL_BOSS_READY: 'false',
  }, async () => {
    const adapter = new LiveAdapter({ baseDir: root });
    let networkOrSigningCalls = 0;
    adapter.live.init = async () => { networkOrSigningCalls += 1; throw new Error('locked-off fixture must refuse before init'); };
    adapter.live.getOpenOrders = async () => { networkOrSigningCalls += 1; throw new Error('locked-off fixture must refuse before network'); };
    adapter.live.signOrderOnly = async () => { networkOrSigningCalls += 1; throw new Error('locked-off fixture must refuse before signing'); };
    adapter.live.postSignedOrder = async () => { networkOrSigningCalls += 1; throw new Error('locked-off fixture must refuse before submission'); };
    const result = await adapter.handleIntent(makeIntent(), { mode: 'submit', fetchMetadata: false });
    assert.strictEqual(result.decision, 'REFUSED', 'locked-off configuration must refuse live submission');
    assert(result.reasons.includes('LIVE_DISABLED'), 'locked-off refusal must report live trading disabled');
    assert(result.reasons.includes('AUTO_EXECUTE_DISABLED'), 'locked-off refusal must report auto-execute disabled');
    assert(result.reasons.includes('KILL_SWITCH_ACTIVE'), 'locked-off refusal must report the kill switch');
    assert(result.reasons.includes('DRY_RUN_ONLY'), 'locked-off refusal must report dry-run-only mode');
    assert.strictEqual(result.safety.submitted, false, 'locked-off refusal must not submit');
    assert.strictEqual(result.safety.signed, false, 'locked-off refusal must not sign');
    assert.strictEqual(result.safety.privateKeyAccessed, false, 'locked-off refusal must not access a private key');
    assert.strictEqual(networkOrSigningCalls, 0, 'locked-off refusal must not initialize, sign, query, or submit');
  });

  {
    const stage2 = resolveLiveStageProfile({
      liveTradingStage: 2,
      maxLiveOrderUsd: 5,
      maxLiveTotalExposureUsd: 5,
      liveDailyMaxLossUsd: 5,
      liveMaxOrdersPerHour: 1,
    });
    assert.strictEqual(stage2.name, 'canary_live', 'stage 2 profile name should remain canary_live');
    assert.strictEqual(stage2.maxLiveOrderUsd, 1, 'stage 2 must stay hard-capped at $1');
    assert.strictEqual(stage2.maxLiveTotalExposureUsd, 1, 'stage 2 must stay hard-capped at $1 total exposure');
    assert.strictEqual(stage2.liveDailyMaxLossUsd, 1, 'stage 2 must stay hard-capped at $1 daily loss');
  }

  {
    const stage3 = resolveLiveStageProfile({
      liveTradingStage: 3,
      maxLiveOrderUsd: 5,
      maxLiveTotalExposureUsd: 5,
      liveDailyMaxLossUsd: 5,
      liveMaxOrdersPerHour: 1,
      liveCanaryMarketId: 'stage3-market',
    });
    assert.strictEqual(stage3.name, 'micro_live', 'stage 3 should remain the existing micro_live profile');
    assert.strictEqual(stage3.maxLiveOrderUsd, 2, 'stage 3 should remain capped at $2');
    assert.strictEqual(stage3.maxLiveTotalExposureUsd, 2, 'stage 3 should remain capped at $2 total exposure');
    assert.strictEqual(stage3.liveDailyMaxLossUsd, 5, 'stage 3 should retain its $5 daily max loss');
    assert.strictEqual(stage3.maxOrdersPerHour, 6, 'stage 3 should retain its broader order/hour limit');
    assert.strictEqual(stage3.singleMarketOnly, false, 'stage 3 should remain multi-market');
    assert.strictEqual(stage3.singleMarketId, 'stage3-market', 'stage 3 may still carry an optional market id without enforcing it');
  }

  {
    const stage5 = resolveLiveStageProfile({
      liveTradingStage: 5,
      maxLiveOrderUsd: 5,
      maxLiveTotalExposureUsd: 5,
      liveDailyMaxLossUsd: 5,
      liveMaxOrdersPerHour: 1,
      liveCanaryMarketId: 'stage5-market',
    });
    assert.strictEqual(stage5.name, 'min_viable_canary', 'stage 5 should be the explicit minimum viable canary profile');
    assert.strictEqual(stage5.maxLiveOrderUsd, 5, 'stage 5 should allow a $5 single order cap when explicitly configured');
    assert.strictEqual(stage5.maxLiveTotalExposureUsd, 5, 'stage 5 should allow a $5 total exposure cap when explicitly configured');
    assert.strictEqual(stage5.liveDailyMaxLossUsd, 5, 'stage 5 should allow a $5 daily max loss cap when explicitly configured');
    assert.strictEqual(stage5.maxOrdersPerHour, 1, 'stage 5 should remain one order per hour');
    assert.strictEqual(stage5.singleMarketOnly, true, 'stage 5 should remain single-market-only');
    assert.strictEqual(stage5.singleMarketId, 'stage5-market', 'stage 5 should carry the explicit canary market id');
  }

  console.log('live_final_boss_selfcheck: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
