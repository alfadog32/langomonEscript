'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildLiveAccountTruthSnapshot, validateCachedSnapshot } = require('../lib/polymarket_live_account_truth');
const { createReadOnlyAccountTruthSource } = require('../lib/polymarket_live_account_truth_readonly_client');
const { runReadonlyAccountTruth } = require('./live_account_truth_readonly');
const { readLiveAccountTruthSnapshot } = require('../dashboard_server');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PROTECTED = [
  'auto_live_candidates.ndjson', 'trade_intents.ndjson', 'live_intent_router_events.ndjson',
  'live_adapter_events.ndjson', 'live_execution_events.ndjson',
];

function fileState(file) {
  const target = path.join(ROOT, file);
  if (!fs.existsSync(target)) return { exists: false };
  return { exists: true, hash: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), size: fs.statSync(target).size };
}

function healthySource(overrides = {}) {
  const base = {
    async fetchPositions() {
      return { source: 'official_data_api_current_positions', fetched: true, complete: true, publicAddressScoped: true, identityBound: true, records: [
        { proxyWallet: WALLET, asset: 'token-a', size: 8, avgPrice: 0.4, initialValue: 3.2, currentValue: 4 },
      ] };
    },
    async fetchOpenOrders() {
      return { source: 'official_clob_authenticated_open_orders', authenticated: true, identityBound: true, fetched: true, complete: true, records: [
        { id: 'buy-1', maker_address: WALLET, asset_id: 'token-b', side: 'BUY', price: 0.2, original_size: 5, size_matched: 0, status: 'LIVE' },
        { id: 'sell-1', maker_address: WALLET, asset_id: 'token-a', side: 'SELL', price: 0.6, original_size: 2, size_matched: 0, status: 'LIVE' },
      ] };
    },
    async fetchTrades() {
      return { source: 'official_clob_authenticated_trade_history', authenticated: true, identityBound: true, fetched: true, complete: true, coverageComplete: true, paginationComplete: true, terminalCursorReached: true, historyWindowStart: 'account_inception', pagesFetched: 1, records: [
        { id: 'trade-buy', asset_id: 'token-a', side: 'BUY', size: 10, price: 0.4, match_time: '2026-08-02T11:00:00Z', fee_rate_bps: 0 },
        { id: 'trade-sell', asset_id: 'token-a', side: 'SELL', size: 2, price: 0.6, match_time: '2026-08-03T11:00:00Z', fee_rate_bps: 0 },
      ] };
    },
    async fetchActivity() {
      return { source: 'official_data_api_account_activity', fetched: true, complete: true, publicAddressScoped: true, identityBound: true, coverageComplete: true, paginationComplete: true, pagesFetched: 1, records: [] };
    },
    async fetchOrderHistory() {
      return { source: 'fixture_authoritative_order_history', authoritative: true, authenticated: true, identityBound: true, fetched: true, complete: true, coverageComplete: true, paginationComplete: true, terminalCursorReached: true, requestedWindowStart: NOW - 3_600_000, requestedWindowEnd: NOW, pagesFetched: 1, records: [] };
    },
  };
  return { ...base, ...overrides };
}

function identity(overrides = {}) {
  return {
    signerAddress: WALLET,
    expectedSignerAddress: WALLET,
    configuredAccountWallet: WALLET,
    resolvedAccountWallet: WALLET,
    configuredSignatureType: 0,
    resolvedSignatureType: 0,
    resolvedWalletType: 'EOA',
    authenticated: true,
    ...overrides,
  };
}

async function snapshot(source = healthySource(), account = identity()) {
  return buildLiveAccountTruthSnapshot({ source, identity: account, nowMs: NOW, maxAgeMs: 30_000 });
}

async function main() {
  const before = Object.fromEntries(PROTECTED.map((file) => [file, fileState(file)]));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-account-truth-'));

  try {

  const healthy = await snapshot();
  assert.equal(healthy.reconciliation.exposureReconciled, true, 'healthy exposure reconciles');
  assert.equal(healthy.reconciliation.dailyPnlReconciled, true, 'healthy PnL reconciles');
  assert.equal(healthy.reconciliation.orderCountReconciled, true, 'healthy order count reconciles');
  assert.equal(healthy.totals.liveExposureUsd, 5, 'position 4 + open BUY 1');
  assert(Math.abs(healthy.totals.dailyRealizedPnlUsd - 0.4) < 1e-9, 'positive daily realized PnL');
  assert.equal(healthy.totals.ordersLastHour, 0, 'zero orders in last hour is explicit complete truth');
  assert.equal(healthy.openOrders.reduceOnlySellNotionalUsd, 1.2, 'reduce-only SELL is reported but not added');

  const signerMismatch = await snapshot(healthySource(), identity({ expectedSignerAddress: OTHER }));
  assert(signerMismatch.reconciliation.blockers.includes('SIGNER_ADDRESS_MISMATCH'));
  const walletMismatch = await snapshot(healthySource(), identity({ configuredAccountWallet: OTHER }));
  assert(walletMismatch.reconciliation.blockers.includes('ACCOUNT_WALLET_MISMATCH'));
  const signatureMismatch = await snapshot(healthySource(), identity({ configuredSignatureType: 3 }));
  assert(signatureMismatch.reconciliation.blockers.includes('SIGNATURE_TYPE_MISMATCH'));

  const positionFailure = await snapshot(healthySource({ async fetchPositions() { throw new Error('fixture'); } }));
  assert.equal(positionFailure.totals.liveExposureUsd, null);
  assert(positionFailure.reconciliation.blockers.includes('LIVE_POSITIONS_INCOMPLETE'));
  const orderFailure = await snapshot(healthySource({ async fetchOpenOrders() { throw new Error('fixture'); } }));
  assert.equal(orderFailure.totals.liveExposureUsd, null);
  assert(orderFailure.reconciliation.blockers.includes('LIVE_OPEN_ORDERS_INCOMPLETE'));
  const malformed = await snapshot(healthySource({ async fetchPositions() { return { fetched: true, complete: true, records: [{ nope: true }] }; } }));
  assert.equal(malformed.reconciliation.exposureReconciled, false);
  assert(malformed.reconciliation.blockers.includes('POSITIONS_MALFORMED_OR_ACCOUNT_MISMATCH'));

  const stale = validateCachedSnapshot(healthy, { nowMs: NOW + 31_000, maxAgeMs: 30_000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.blocker, 'LIVE_ACCOUNT_SNAPSHOT_STALE');

  const duplicate = await snapshot(healthySource({
    async fetchPositions() {
      const row = { proxyWallet: WALLET, asset: 'token-a', size: 8, avgPrice: 0.4, currentValue: 4 };
      return { fetched: true, complete: true, publicAddressScoped: true, identityBound: true, records: [row, { ...row }] };
    },
    async fetchOpenOrders() {
      const row = { id: 'buy-1', maker_address: WALLET, asset_id: 'token-b', side: 'BUY', price: 0.2, original_size: 5, size_matched: 0, status: 'LIVE' };
      return { authenticated: true, identityBound: true, fetched: true, complete: true, records: [row, { ...row }] };
    },
  }));
  assert.equal(duplicate.positions.count, 1);
  assert.equal(duplicate.openOrders.count, 1);
  assert.equal(duplicate.totals.liveExposureUsd, 5, 'duplicates are not double-counted');

  const loss = await snapshot(healthySource({
    async fetchTrades() {
      return { authenticated: true, identityBound: true, fetched: true, complete: true, coverageComplete: true, paginationComplete: true, terminalCursorReached: true, historyWindowStart: 'account_inception', pagesFetched: 1, records: [
        { id: 'b', asset_id: 'token-a', side: 'BUY', size: 10, price: 0.9, match_time: '2026-08-02T11:00:00Z', fee_rate_bps: 0 },
        { id: 's', asset_id: 'token-a', side: 'SELL', size: 10, price: 0.1, match_time: '2026-08-03T11:00:00Z', fee_rate_bps: 0 },
      ] };
    },
  }));
  assert(loss.totals.dailyRealizedPnlUsd < -5, 'loss beyond Stage 5 limit is preserved');
  const pnlUnavailable = await snapshot(healthySource({ async fetchTrades() { throw new Error('fixture'); } }));
  assert.equal(pnlUnavailable.totals.dailyRealizedPnlUsd, null, 'missing daily PnL never becomes zero');
  assert(pnlUnavailable.reconciliation.blockers.includes('LIVE_DAILY_PNL_UNCERTAIN'));

  const oneOrder = await snapshot(healthySource({
    async fetchOrderHistory() {
      return { authoritative: true, authenticated: true, identityBound: true, fetched: true, complete: true, coverageComplete: true, paginationComplete: true, terminalCursorReached: true, requestedWindowStart: NOW - 3_600_000, requestedWindowEnd: NOW, pagesFetched: 1, records: [{ id: 'one', maker_address: WALLET, status: 'FILLED', created_at: NOW - 1000 }] };
    },
  }));
  assert.equal(oneOrder.totals.ordersLastHour, 1);
  const orderHistoryUnavailable = await snapshot(healthySource({ async fetchOrderHistory() { throw new Error('fixture'); } }));
  assert.equal(orderHistoryUnavailable.totals.ordersLastHour, null);
  assert(orderHistoryUnavailable.reconciliation.blockers.includes('LIVE_ORDER_RATE_UNCERTAIN'));

  let mutationCalls = 0;
  const mockClob = {
    async getOpenOrders() { return []; },
    async getTradesPaginated() { return { trades: [], next_cursor: 'LTE=', count: 0, limit: 100 }; },
    async getNotifications() { return []; },
    async getOrder() { throw new Error('not reached'); },
    async getBalanceAllowance() { return { balance: '100000000', allowances: {} }; },
    async createOrder() { mutationCalls += 1; },
    async postOrder() { mutationCalls += 1; },
    async cancelOrder() { mutationCalls += 1; },
  };
  const mockFetch = async (url) => ({ ok: true, async json() { return String(url).includes('/positions') || String(url).includes('/activity') ? [] : {}; } });
  const officialSource = createReadOnlyAccountTruthSource({ clobClient: mockClob, fetchImpl: mockFetch, accountWallet: WALLET });
  const official = await snapshot(officialSource);
  assert.equal(official.reconciliation.orderCountReconciled, false);
  assert(official.reconciliation.blockers.includes('LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE'));
  assert.equal(mutationCalls, 0, 'read-only source cannot create, sign, submit or cancel');

  let signerCalls = 0;
  class MockClobClient {
    constructor(options) { this.options = options; }
    async getOpenOrders() { return []; }
    async getTradesPaginated() { return { trades: [], next_cursor: 'LTE=', count: 0, limit: 100 }; }
    async getNotifications() { return []; }
    async getOrder() { throw new Error('not reached'); }
    async getBalanceAllowance() { return { balance: '100000000', allowances: {} }; }
    async createOrder() { signerCalls += 1; }
    async postOrder() { signerCalls += 1; }
  }
  const outputPath = path.join(tempDir, 'operator', 'account-truth.json');
  const operatorEnv = {
    ENABLE_LIVE_TRADING: 'false', LIVE_AUTO_EXECUTE: 'false', LIVE_KILL_SWITCH: 'true',
    LIVE_DRY_RUN_ONLY: 'true', LIVE_SUBMIT_CONFIRM: 'false', LIVE_FINAL_BOSS_READY: 'false',
    POLYMARKET_SIGNATURE_TYPE: '0', LIVE_EXPECTED_SIGNER_ADDRESS: WALLET, POLYMARKET_FUNDER_ADDRESS: WALLET,
    POLYMARKET_PRIVATE_KEY: 'fixture-private-key-never-used-by-real-crypto',
    POLYMARKET_API_KEY: 'fixture-key', POLYMARKET_API_SECRET: 'fixture-secret', POLYMARKET_API_PASSPHRASE: 'fixture-passphrase',
    LIVE_ACCOUNT_TRUTH_SNAPSHOT_PATH: outputPath,
  };
  const operator = await runReadonlyAccountTruth({ env: operatorEnv, baseDir: tempDir, fetchImpl: mockFetch, sdk: { ClobClient: MockClobClient }, deriveSignerAddress: async () => WALLET });
  assert(operator.snapshot.reconciliation.blockers.includes('LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE'), 'operator fails closed without all-status order history');
  assert.equal(signerCalls, 0, 'operator command never creates, signs or submits');
  const dashboardTruth = readLiveAccountTruthSnapshot(outputPath, Date.now(), 30_000);
  assert.equal(dashboardTruth.available, true);
  assert.equal(dashboardTruth.reconciliation.orderCountReconciled, false);
  await assert.rejects(
    runReadonlyAccountTruth({ env: { ...operatorEnv, ENABLE_LIVE_TRADING: 'true' }, baseDir: tempDir, fetchImpl: mockFetch, sdk: { ClobClient: MockClobClient }, deriveSignerAddress: async () => WALLET }),
    /READ_ONLY_ACCOUNT_TRUTH_REFUSED/,
    'operator command refuses unless every live control is locked off'
  );

  const originalRead = fs.readFileSync;
  const forbiddenReads = [];
  fs.readFileSync = function guardedRead(file, ...args) {
    const base = path.basename(String(file));
    if (base === '.env' || base === '.env.live.secrets') forbiddenReads.push(String(file));
    return originalRead.call(this, file, ...args);
  };
  try {
    delete require.cache[require.resolve('../live_intent_router')];
    delete require.cache[require.resolve('../live_adapter_polymarket')];
    delete require.cache[require.resolve('../moneymaker_v3')];
    delete require.cache[require.resolve('../dashboard_server')];
    delete require.cache[require.resolve('./live_account_truth_watch')];
    delete require.cache[require.resolve('./live_account_truth_runner_policy')];
    require('../live_intent_router');
    require('../live_adapter_polymarket');
    require('../moneymaker_v3');
    require('../dashboard_server');
    require('./live_account_truth_watch');
    require('./live_account_truth_runner_policy');
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.deepEqual(forbiddenReads, [], 'fixtures cannot load real env or live secrets');

  const after = Object.fromEntries(PROTECTED.map((file) => [file, fileState(file)]));
  assert.deepEqual(after, before, 'protected production event files unchanged');
  console.log('live account truth selfcheck: PASS (healthy, identity, exposure, PnL, rate, read-only, env isolation, protected files)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
