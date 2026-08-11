'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const { normalizeCandidate, toLiveAdapterIntent } = require('../live_intent_router');

const observedAt = new Date().toISOString();
const raw = {
  id: 'account-truth-propagation',
  source: 'MONEYMAKER', strategy: 'GabagoolBtcOracleStrategy', tokenId: 'token', marketId: 'market',
  side: 'BUY', price: 0.74, sizeUsd: 3.7, sizeShares: 5, confidence: 0.9,
  riskApproved: true, sophieApproved: true, adjustedSizeRiskApproved: true, riskApprovedSizeUsd: 3.7,
  currentLiveExposureUsd: 1.25,
  currentLiveExposureSource: 'official_data_api_current_positions + official_clob_authenticated_open_orders',
  currentLiveExposureAuthenticatedReconciliation: true,
  currentLiveExposureObservedAt: observedAt,
  currentDailyLivePnlUsd: -0.25,
  currentDailyLivePnlReconciled: true,
  currentDailyLivePnlObservedAt: observedAt,
  liveOrdersLastHour: 0,
  liveOrdersLastHourReconciled: true,
  liveOrdersLastHourObservedAt: observedAt,
  accountIdentityMatches: true,
  liveAccountSnapshotFresh: true,
  liveAccountSnapshotObservedAt: observedAt,
  metadata: { liveStageProfile: { stage: 5 }, liveAccountTruth: { observedAt, fresh: true, accountIdentityMatches: true, dailyLivePnlReconciled: true, liveOrdersLastHourReconciled: true } },
};

const normalized = normalizeCandidate(raw, '/tmp/account-truth-fixture.ndjson');
const intent = toLiveAdapterIntent(normalized);
for (const field of [
  'currentLiveExposureUsd', 'currentLiveExposureSource', 'currentLiveExposureAuthenticatedReconciliation',
  'currentLiveExposureObservedAt', 'currentDailyLivePnlUsd', 'currentDailyLivePnlReconciled',
  'currentDailyLivePnlObservedAt', 'liveOrdersLastHour', 'liveOrdersLastHourReconciled',
  'liveOrdersLastHourObservedAt', 'accountIdentityMatches', 'liveAccountSnapshotFresh',
  'liveAccountSnapshotObservedAt',
]) assert.deepStrictEqual(intent[field], raw[field], `router preserves ${field}`);

const missing = toLiveAdapterIntent(normalizeCandidate({ ...raw, currentDailyLivePnlUsd: undefined, liveOrdersLastHour: undefined }, '/tmp/account-truth-missing.ndjson'));
assert(Number.isNaN(missing.currentDailyLivePnlUsd), 'missing PnL is not zero');
assert(Number.isNaN(missing.liveOrdersLastHour), 'missing order count is not zero');
console.log('router account-truth propagation selfcheck: PASS');
