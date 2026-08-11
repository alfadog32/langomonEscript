'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LiveAdapter, normalizeIntent, evaluateStaticSafety, resolveLiveStageProfile } = require('../live_adapter_polymarket');

const now = Date.now();
const observedAt = new Date(now).toISOString();
const config = {
  enableLiveTrading: false, liveAutoExecute: false, liveKillSwitch: true, liveDryRunOnly: true,
  liveSubmitConfirm: false, liveFinalBossReady: false, liveTradingStage: 5,
  maxLiveOrderUsd: 5, maxLiveTotalExposureUsd: 5, liveDailyMaxLossUsd: 5, liveMaxOrdersPerHour: 1,
  liveCanaryMarketId: 'market', liveAccountTruthTtlMs: 30_000,
  liveRequireSophieApproval: true, liveSophieMinScore: 0.5, liveRequireRiskApproval: true,
  liveRequireOracleConfirmation: false, liveRequirePersistenceConfirmation: false,
  liveMinExpectedEdge: 0, liveRequireFreshBook: false, liveMaxBookAgeMs: 1500,
  liveMaxSignalAgeMs: 10_000, liveMaxDecisionLatencyMs: 2_000,
  liveWhaleCopyTrading: false, liveAllowOracleSniper: false, liveRequireBurnIn: false,
};
config.liveStageProfile = resolveLiveStageProfile(config);

function raw(overrides = {}) {
  return {
    id: 'truth-adapter-fixture', timestamp: observedAt, source: 'MONEYMAKER', strategy: 'GabagoolBtcOracleStrategy',
    tokenId: 'token', marketId: 'market', side: 'BUY', price: 0.74, sizeUsd: 3.7, sizeShares: 5,
    minOrderSize: 5, sophieApproved: true, consensusScore: 0.9, riskApproved: true,
    adjustedSizeRiskApproved: true, riskApprovedSizeUsd: 3.7, liveStage: 5,
    currentLiveExposureUsd: 0, currentLiveExposureAuthenticatedReconciliation: true,
    currentLiveExposureSource: 'official_data_api_current_positions + official_clob_authenticated_open_orders', currentLiveExposureObservedAt: observedAt,
    currentDailyLivePnlUsd: 0, currentDailyLivePnlReconciled: true, currentDailyLivePnlObservedAt: observedAt,
    liveOrdersLastHour: 0, liveOrdersLastHourReconciled: true, liveOrdersLastHourObservedAt: observedAt,
    accountIdentityMatches: true, liveAccountSnapshotFresh: true, liveAccountSnapshotObservedAt: observedAt,
    ...overrides,
  };
}

function reasons(overrides = {}, at = now) {
  return evaluateStaticSafety(config, normalizeIntent(raw(overrides)), { mode: 'dry-run', nowMs: at }).reasons;
}

assert(!reasons().some((reason) => reason.startsWith('LIVE_ACCOUNT_') || reason === 'LIVE_EXPOSURE_UNCERTAIN' || reason === 'LIVE_DAILY_PNL_UNCERTAIN' || reason === 'LIVE_ORDER_RATE_UNCERTAIN'), 'healthy truth passes account gates');
assert(reasons({ accountIdentityMatches: false }).includes('LIVE_ACCOUNT_IDENTITY_UNCERTAIN'));
assert(reasons({ liveAccountSnapshotFresh: false }).includes('LIVE_ACCOUNT_SNAPSHOT_STALE'));
assert(reasons({}, now + 30_001).includes('LIVE_ACCOUNT_SNAPSHOT_STALE'));
assert(reasons({ currentLiveExposureUsd: undefined, currentLiveExposureAuthenticatedReconciliation: false }).includes('LIVE_EXPOSURE_UNCERTAIN'));
assert(reasons({ currentDailyLivePnlUsd: undefined, currentDailyLivePnlReconciled: false }).includes('LIVE_DAILY_PNL_UNCERTAIN'));
assert(reasons({ liveOrdersLastHour: undefined, liveOrdersLastHourReconciled: false }).includes('LIVE_ORDER_RATE_UNCERTAIN'));
assert(reasons({ currentDailyLivePnlUsd: -5.01 }).includes('DAILY_MAX_LOSS_EXCEEDED'));
assert(reasons({ liveOrdersLastHour: 1 }).includes('MAX_LIVE_ORDERS_PER_HOUR_EXCEEDED'));

const missing = normalizeIntent(raw({ currentDailyLivePnlUsd: undefined, liveOrdersLastHour: undefined }));
assert(Number.isNaN(missing.currentDailyLivePnlUsd), 'missing PnL is unavailable, never zero');
assert(Number.isNaN(missing.currentLiveOrdersLastHour), 'missing order count is unavailable, never zero');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-account-truth-'));
  try {
    const legacy = await new LiveAdapter({ baseDir: tempDir }).reconcile();
    assert(legacy.reasons.includes('LEGACY_RECONCILE_DISABLED_USE_LIVE_ACCOUNT_TRUTH_READONLY'));
    assert.equal(legacy.positionsUsd, null, 'legacy reconcile cannot report missing positions as zero');
    assert.equal(legacy.openOrdersUsd, null, 'legacy reconcile cannot report missing orders as zero');
    console.log('adapter account-truth refusal selfcheck: PASS');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
