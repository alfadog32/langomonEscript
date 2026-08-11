'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const { calculateRecentOrders } = require('../lib/polymarket_live_account_truth');
const { createReadOnlyAccountTruthSource } = require('../lib/polymarket_live_account_truth_readonly_client');

const NOW = Date.parse('2026-08-03T12:00:00Z');
const WALLET = '0x1111111111111111111111111111111111111111';

function authoritative(records, overrides = {}) {
  return {
    source: 'fixture_complete_all_status_authenticated_order_history',
    authoritative: true,
    fetched: true,
    complete: true,
    authenticated: true,
    identityBound: true,
    fresh: true,
    coverageComplete: true,
    paginationComplete: true,
    terminalCursorReached: true,
    requestedWindowStart: NOW - 3_600_000,
    requestedWindowEnd: NOW,
    pagesFetched: 3,
    recordsFetched: records.length,
    records,
    ...overrides,
  };
}

function order(id, offsetMs, status) {
  return { id, maker_address: WALLET, created_at: NOW + offsetMs, status };
}

async function main() {
  const records = [
    order('open', -1_000, 'LIVE'),
    order('filled', -2_000, 'FILLED'),
    order('cancelled', -3_000, 'CANCELLED'),
    order('expired', -4_000, 'EXPIRED'),
    order('duplicate', -5_000, 'CANCELLED'),
    order('duplicate', -5_000, 'CANCELLED'),
    order('inside', -3_599_999, 'FILLED'),
    order('outside', -3_600_001, 'FILLED'),
  ];
  const complete = calculateRecentOrders(authoritative(records), NOW, WALLET);
  assert.equal(complete.complete, true);
  assert.equal(complete.submittedCount, 6, 'all statuses inside the wall-clock hour count once');
  assert.equal(complete.pagesFetched, 3);
  assert.equal(complete.recordsFetched, 8);
  assert.equal(complete.coverageComplete, true);
  assert(complete.earliestReturnedTimestamp && complete.latestReturnedTimestamp);

  for (const envelope of [
    authoritative(records, { paginationComplete: false }),
    authoritative(records, { terminalCursorReached: false }),
    authoritative(records, { coverageComplete: false }),
    authoritative(records, { complete: false }),
    authoritative(records, { authoritative: false }),
  ]) {
    const result = calculateRecentOrders(envelope, NOW, WALLET);
    assert.equal(result.complete, false);
    assert.equal(result.submittedCount, null);
    assert.equal(result.blocker, 'LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE');
  }
  const missingTimestamp = calculateRecentOrders(authoritative([{ id: 'bad', maker_address: WALLET, status: 'CANCELLED' }]), NOW, WALLET);
  assert.equal(missingTimestamp.complete, false);
  assert(missingTimestamp.blockers.includes('ORDER_HISTORY_MALFORMED'));

  const clob = {
    async getOpenOrders() { return [order('open', -1_000, 'LIVE')]; },
    async getTradesPaginated() { return { trades: [], next_cursor: 'LTE=', count: 0, limit: 100 }; },
    async getNotifications() { return []; },
    async getOrder() { return order('open', -1_000, 'LIVE'); },
    async getBalanceAllowance() { return { balance: '100000000', allowances: {} }; },
  };
  const fetchImpl = async () => ({ ok: true, async json() { return []; } });
  const source = createReadOnlyAccountTruthSource({ clobClient: clob, fetchImpl, accountWallet: WALLET });
  const officialInstalledSource = await source.fetchOrderHistory();
  assert.equal(officialInstalledSource.authoritative, false);
  assert.equal(officialInstalledSource.coverageComplete, false);
  assert.equal(officialInstalledSource.blocker, 'LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE');
  const failedClosed = calculateRecentOrders(officialInstalledSource, NOW, WALLET);
  assert.equal(failedClosed.submittedCount, null);
  assert.equal(failedClosed.blocker, 'LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE');

  console.log('authoritative order-history selfcheck: PASS (all statuses, pagination, coverage, dedupe, hour boundary, installed-source refusal)');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
