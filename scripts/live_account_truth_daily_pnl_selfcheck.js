'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const { calculateDailyRealizedPnl } = require('../lib/polymarket_live_account_truth');
const { fetchAllTradePages } = require('../lib/polymarket_live_account_truth_readonly_client');

const NOW = Date.parse('2026-08-03T12:00:00Z');
const WALLET = '0x1111111111111111111111111111111111111111';

function trades(records, overrides = {}) {
  return {
    source: 'fixture_complete_all_time_authenticated_trades', fetched: true, complete: true, authenticated: true,
    identityBound: true, fresh: true, coverageComplete: true, paginationComplete: true,
    terminalCursorReached: true, historyWindowStart: 'account_inception', pagesFetched: 2, records, ...overrides,
  };
}

function activity(records = [], overrides = {}) {
  return {
    source: 'fixture_complete_public_address_activity', fetched: true, complete: true, authenticated: false,
    publicAddressScoped: true, identityBound: true, fresh: true, coverageComplete: true,
    paginationComplete: true, terminalCursorReached: true, pagesFetched: 1, records, ...overrides,
  };
}

function trade(id, side, size, price, timestamp, extra = {}) {
  return { id, asset_id: 'asset-a', side, size, price, match_time: timestamp, fee_rate_bps: 0, ...extra };
}

function pnl(records, activities = []) {
  return calculateDailyRealizedPnl(trades(records), activity(activities), NOW, WALLET);
}

function close(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

async function main() {
  const today = pnl([
    trade('b', 'BUY', 10, 0.4, '2026-08-03T01:00:00Z'),
    trade('s', 'SELL', 4, 0.7, '2026-08-03T02:00:00Z'),
  ]);
  close(today.realizedPnlUsd, 1.2, 'buy and sell today');
  assert.equal(today.openingInventorySource, 'complete_all_time_authenticated_trade_history');

  const prior = pnl([
    trade('b', 'BUY', 10, 0.25, '2026-08-02T01:00:00Z'),
    trade('s', 'SELL', 10, 0.75, '2026-08-03T02:00:00Z'),
  ]);
  close(prior.realizedPnlUsd, 5, 'pre-day inventory has reconstructed basis');

  const partial = pnl([
    trade('b', 'BUY', 10, 0.2, '2026-08-02T01:00:00Z'),
    trade('s', 'SELL', 3, 0.5, '2026-08-03T02:00:00Z'),
  ]);
  close(partial.realizedPnlUsd, 0.9, 'partial sale');

  const average = pnl([
    trade('b1', 'BUY', 5, 0.2, '2026-08-01T01:00:00Z'),
    trade('b2', 'BUY', 5, 0.6, '2026-08-02T01:00:00Z'),
    trade('s', 'SELL', 5, 0.8, '2026-08-03T02:00:00Z'),
  ]);
  close(average.realizedPnlUsd, 2, 'weighted average cost');

  const fees = pnl([
    trade('b', 'BUY', 10, 0.4, '2026-08-02T01:00:00Z', { fee_rate_bps: 10, feeAmountUsd: 0.04 }),
    trade('s', 'SELL', 10, 0.6, '2026-08-03T02:00:00Z', { fee_rate_bps: 10, feeAmountUsd: 0.06 }),
  ]);
  close(fees.realizedPnlUsd, 1.9, 'actual fees included');
  const missingFee = calculateDailyRealizedPnl(trades([
    trade('b', 'BUY', 1, 0.4, '2026-08-02T01:00:00Z', { fee_rate_bps: 10 }),
  ]), activity(), NOW, WALLET);
  assert.equal(missingFee.realizedPnlUsd, null);
  assert(missingFee.blockers.includes('LIVE_TRADE_FEES_INCOMPLETE'));

  const redeemed = pnl([
    trade('b', 'BUY', 5, 0.3, '2026-08-02T01:00:00Z'),
  ], [{ id: 'r', proxyWallet: WALLET, type: 'REDEEM', asset: 'asset-a', size: 5, usdcSize: 5, timestamp: '2026-08-03T03:00:00Z' }]);
  close(redeemed.realizedPnlUsd, 3.5, 'redemption realized PnL');

  for (const broken of [
    trades([], { paginationComplete: false }),
    trades([], { terminalCursorReached: false }),
    trades([], { historyWindowStart: '2026-08-03T00:00:00Z' }),
  ]) {
    const result = calculateDailyRealizedPnl(broken, activity(), NOW, WALLET);
    assert.equal(result.realizedPnlUsd, null);
    assert(result.blockers.includes('LIVE_TRADE_HISTORY_INCOMPLETE'));
    assert(result.blockers.includes('LIVE_OPENING_COST_BASIS_UNAVAILABLE'));
  }
  const redemptionIncomplete = calculateDailyRealizedPnl(trades([]), activity([], { coverageComplete: false }), NOW, WALLET);
  assert(redemptionIncomplete.blockers.includes('LIVE_REDEMPTION_HISTORY_INCOMPLETE'));

  const negative = pnl([trade('s', 'SELL', 1, 0.8, '2026-08-03T02:00:00Z')]);
  assert.equal(negative.realizedPnlUsd, null);
  assert(negative.blockers.includes('LIVE_TRADE_HISTORY_INCOMPLETE'));

  const duplicateTrade = trade('same', 'BUY', 2, 0.4, '2026-08-02T01:00:00Z');
  const deduped = pnl([duplicateTrade, { ...duplicateTrade }, trade('s', 'SELL', 2, 0.7, '2026-08-03T02:00:00Z')]);
  close(deduped.realizedPnlUsd, 0.6, 'duplicate trades ignored');

  const provenEmpty = pnl([]);
  assert.equal(provenEmpty.complete, true);
  assert.equal(provenEmpty.realizedPnlUsd, 0);
  const unprovenEmpty = calculateDailyRealizedPnl(trades([], { coverageComplete: false }), activity(), NOW, WALLET);
  assert.equal(unprovenEmpty.realizedPnlUsd, null);

  const requestedCursors = [];
  const paginated = await fetchAllTradePages({
    async getTradesPaginated(params, cursor) {
      requestedCursors.push(cursor || null);
      return cursor
        ? { trades: [trade('page-2', 'BUY', 1, 0.2, '2026-08-02T00:00:00Z')], next_cursor: 'LTE=', count: 1, limit: 100 }
        : { trades: [trade('page-1', 'BUY', 1, 0.1, '2026-08-01T00:00:00Z')], next_cursor: 'cursor-2', count: 1, limit: 100 };
    },
  });
  assert.deepEqual(requestedCursors, [null, 'cursor-2']);
  assert.equal(paginated.pagesFetched, 2);
  assert.equal(paginated.recordsFetched, 2);
  assert.equal(paginated.terminalCursorReached, true);
  await assert.rejects(fetchAllTradePages({
    async getTradesPaginated() { return { trades: [], next_cursor: 'repeated', count: 0, limit: 100 }; },
  }), /CURSOR_INVALID/, 'repeated cursor proves pagination incomplete');

  console.log('authoritative daily-PnL selfcheck: PASS (all-time basis, pagination, fees, redemption, partials, dedupe, fail-closed inputs)');
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
