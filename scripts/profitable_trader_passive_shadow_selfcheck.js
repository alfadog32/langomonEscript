#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createPassiveOrders,
  revalidatePassiveOrder,
  opposingTradeEvidence,
  processPassiveOrder,
  observeOrderEconomics,
  summarizePassiveStudy,
} = require('../lib/profitable_trader_passive');
const { fetchMarketTrades } = require('../lib/profitable_trader_readonly');
const { parseArgs } = require('./profitable_trader_passive_shadow');

const NOW = 1_786_300_000_000;
const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '123456789';
const MARKET = `0x${'2'.repeat(64)}`;

function event(overrides = {}) {
  return {
    wallet: WALLET,
    leaderName: 'fixture-leader',
    tokenId: TOKEN,
    marketId: MARKET,
    marketSlug: 'fixture-market',
    category: 'OTHER',
    leaderPrice: 0.54,
    leaderShares: 10,
    leaderTimestampMs: NOW - 1_000,
    detectionTimestampMs: NOW,
    latencyMs: 1_000,
    consensus: { score: 0.7, independentLeaderCount: 1, reason: 'single_wallet' },
    ...overrides,
  };
}

function book(overrides = {}) {
  const bestBid = overrides.bestBid ?? 0.50;
  const bestAsk = overrides.bestAsk ?? 0.56;
  return {
    tokenId: TOKEN,
    marketId: MARKET,
    observedAtMs: overrides.observedAtMs ?? NOW,
    sourceTimestampMs: overrides.sourceTimestampMs ?? overrides.observedAtMs ?? NOW,
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    tickSize: 0.01,
    minOrderSizeShares: 5,
    hash: overrides.hash || 'placement-hash',
    bids: overrides.bids || [{ price: bestBid, size: 100 }, { price: bestBid - 0.01, size: 100 }],
    asks: overrides.asks || [{ price: bestAsk, size: 100 }, { price: bestAsk + 0.01, size: 100 }],
  };
}

function registeredOrders(overrides = {}) {
  return createPassiveOrders({
    opportunityId: overrides.opportunityId || 'fixture-opportunity',
    event: event(overrides.event),
    book: book(overrides.book),
    fee: { rate: 0.02, exponent: 1, takerOnly: true, evidence: 'fixture' },
    registeredAtMs: NOW,
  });
}

function selectOrder(registered, rule, ttlSeconds = 30, threshold = 4) {
  const order = registered.orders.find((row) => row.rule === rule && row.ttlSeconds === ttlSeconds && row.adverseMoveThresholdPct === threshold);
  assert(order, `missing ${rule}/${ttlSeconds}s/${threshold}% fixture order`);
  return order;
}

async function run() {
  const parsed = parseArgs(['--min-observe-seconds', '1', '--max-observe-seconds', '99999', '--output', '/tmp/passive-selfcheck.json']);
  assert.strictEqual(parsed.minObserveSeconds, 1_800, 'the operator command must enforce the 30-minute minimum');
  assert.strictEqual(parsed.maxObserveSeconds, 2_700, 'the operator command must enforce the 45-minute maximum');
  assert.throws(() => parseArgs(['--output', '/home/lango/langomonEscript/passive.json']), /must remain under \/tmp/);

  const registered = registeredOrders();
  assert(registered.orders.length >= 5 * 5 * 3, 'at least five passive rules, five TTLs, and three guard thresholds must register');
  assert(registered.orders.every((order) => order.price < order.placementAsk), 'every shadow quote must be non-marketable at registration');
  assert(registered.orders.every((order) => order.targetUsd === 1), 'minimum feasibility must not be manufactured by increasing size');
  assert(registered.orders.some((order) => order.rule === 'PASSIVE_BID'));
  assert(registered.orders.some((order) => order.rule === 'PASSIVE_BID_PLUS_1T'));
  assert(registered.orders.some((order) => order.rule === 'PASSIVE_MID'));
  assert(registered.orders.some((order) => order.rule === 'PASSIVE_LEADER'));
  assert(registered.orders.some((order) => order.rule === 'PASSIVE_ASK_MINUS_2C'));

  const unchanged = selectOrder(registeredOrders(), 'PASSIVE_BID_PLUS_1T');
  const unchangedResult = processPassiveOrder(unchanged, {
    book: book({ observedAtMs: NOW + 2_000, sourceTimestampMs: NOW + 2_000, hash: 'unchanged' }),
    trades: [],
    nowMs: NOW + 2_000,
  });
  assert.strictEqual(unchangedResult.filled, false, 'an unexecuted resting quote must not invent a fill');
  assert.strictEqual(unchanged.status, 'open');

  const oneCross = selectOrder(registeredOrders(), 'PASSIVE_BID_PLUS_1T');
  const marketableBookOne = book({
    bestBid: 0.50,
    bestAsk: 0.51,
    observedAtMs: NOW + 2_000,
    sourceTimestampMs: NOW + 2_000,
    hash: 'marketable-1',
    asks: [{ price: 0.51, size: 100 }],
  });
  assert.strictEqual(processPassiveOrder(oneCross, { book: marketableBookOne, nowMs: NOW + 2_000 }).filled, false, 'one future ask move alone is insufficient');
  assert.strictEqual(processPassiveOrder(oneCross, { book: marketableBookOne, nowMs: NOW + 2_500 }).filled, false, 'the same book hash cannot manufacture confirmation');
  const marketableBookTwo = { ...marketableBookOne, observedAtMs: NOW + 3_000, sourceTimestampMs: NOW + 3_000, hash: 'marketable-2' };
  const confirmed = processPassiveOrder(oneCross, { book: marketableBookTwo, nowMs: NOW + 3_000 });
  assert.strictEqual(confirmed.filled, true);
  assert.strictEqual(oneCross.fill.source, 'later_marketable_limit_confirmed');

  const touch = selectOrder(registeredOrders(), 'PASSIVE_BID_PLUS_1T');
  const touchTrade = {
    proxyWallet: '0x2222222222222222222222222222222222222222',
    side: 'SELL',
    asset: TOKEN,
    conditionId: MARKET,
    size: 10,
    price: touch.price,
    timestamp: (NOW + 2_000) / 1_000,
    transactionHash: '0xtouch',
  };
  const touchEvidence = opposingTradeEvidence(touch, [touchTrade], NOW + 2_000);
  assert.strictEqual(touchEvidence.queueCleared, true, 'haircut-adjusted opposing trade must clear a top-of-book shadow quote');
  const touchResult = processPassiveOrder(touch, {
    book: book({ observedAtMs: NOW + 2_000, sourceTimestampMs: NOW + 2_000, hash: 'touch-book' }),
    trades: [touchTrade],
    nowMs: NOW + 2_000,
  });
  assert.strictEqual(touchResult.filled, true);
  assert.strictEqual(touch.fill.source, 'opposing_side_execution_touch');

  const queued = selectOrder(registeredOrders(), 'PASSIVE_BID');
  const queueTrade = { ...touchTrade, price: queued.price, size: 210, transactionHash: '0xqueue' };
  const queueResult = processPassiveOrder(queued, {
    book: book({ observedAtMs: NOW + 2_000, sourceTimestampMs: NOW + 2_000, hash: 'queue-book' }),
    trades: [queueTrade],
    nowMs: NOW + 2_000,
  });
  assert.strictEqual(queueResult.filled, true, 'displayed queue plus shadow size must be cleared after the 50% haircut');
  assert.strictEqual(queued.fill.source, 'queue_depth_supported_maker_fill');

  const toxic = selectOrder(registeredOrders(), 'PASSIVE_BID_PLUS_1T');
  const toxicBook = book({
    bestBid: 0.47,
    bestAsk: 0.48,
    observedAtMs: NOW + 2_000,
    sourceTimestampMs: NOW + 2_000,
    hash: 'toxic-book',
    bids: [{ price: 0.47, size: 100 }],
    asks: [{ price: 0.48, size: 100 }],
  });
  const toxicResult = processPassiveOrder(toxic, { book: toxicBook, trades: [touchTrade], nowMs: NOW + 2_000 });
  assert.strictEqual(toxicResult.filled, false, 'revalidation must run before apparent fill evidence');
  assert.strictEqual(toxic.status, 'canceled');
  assert.strictEqual(toxic.closeReason, 'placement_bid_deterioration');

  const thresholdSet = registeredOrders();
  const thresholdTwo = selectOrder(thresholdSet, 'PASSIVE_BID_PLUS_1T', 30, 2);
  const thresholdFour = selectOrder(thresholdSet, 'PASSIVE_BID_PLUS_1T', 30, 4);
  const mildDeterioration = book({
    bestBid: 0.485,
    bestAsk: 0.55,
    observedAtMs: NOW + 2_000,
    sourceTimestampMs: NOW + 2_000,
    hash: 'mild-deterioration',
    bids: [{ price: 0.485, size: 100 }],
  });
  assert.strictEqual(revalidatePassiveOrder(thresholdTwo, mildDeterioration, NOW + 2_000).passed, false, '2% shadow guard must cancel a 3% deterioration');
  assert.strictEqual(revalidatePassiveOrder(thresholdFour, mildDeterioration, NOW + 2_000).passed, true, 'the proven 4% guard must remain unchanged');

  observeOrderEconomics(touch, book({
    bestBid: 0.53,
    bestAsk: 0.56,
    observedAtMs: NOW + 62_000,
    sourceTimestampMs: NOW + 62_000,
    hash: 'markout-book',
    bids: [{ price: 0.53, size: 100 }],
  }), NOW + 62_000);
  assert(touch.fillHorizons['5s']?.available);
  assert(touch.fillHorizons['60s']?.feeAdjustedPnlUsd > 0, 'filled passive economics must use executable BID depth');

  const summary = summarizePassiveStudy({
    opportunities: [{ opportunityId: touch.opportunityId }],
    orders: [touch, queued, oneCross, toxic, thresholdTwo, thresholdFour],
    priorTakerBaseline: { qualifiedCopyableBuys: 364 },
    observation: { stopReason: 'fixture' },
  });
  assert.strictEqual(summary.safety.orderPlacementCodePresent, false);
  assert.strictEqual(summary.safety.paperOrdersPlaced, 0);
  assert.strictEqual(summary.safety.liveOrdersPlaced, 0);
  assert(summary.passive.rulesTested.includes('PASSIVE_BID'));

  let requestedUrl = null;
  let requestedMethod = null;
  const trades = await fetchMarketTrades(MARKET, {
    limit: 25,
    side: 'SELL',
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      requestedMethod = options.method;
      return { ok: true, json: async () => [touchTrade] };
    },
  });
  assert.strictEqual(requestedMethod, 'GET', 'trade evidence collection must remain public GET only');
  assert.strictEqual(requestedUrl.origin, 'https://data-api.polymarket.com');
  assert.strictEqual(requestedUrl.pathname, '/trades');
  assert.strictEqual(requestedUrl.searchParams.get('market'), MARKET);
  assert.strictEqual(requestedUrl.searchParams.get('side'), 'SELL');
  assert.strictEqual(trades.length, 1);

  const runnerSource = fs.readFileSync(path.join(__dirname, 'profitable_trader_passive_shadow.js'), 'utf8');
  assert(!runnerSource.includes("require('../moneymaker_v3')"), 'research runner must not import production execution');
  assert(!runnerSource.includes("require('../live_adapter_polymarket')"), 'research runner must not import the live adapter');
  process.stdout.write('profitable trader passive shadow selfcheck passed\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
