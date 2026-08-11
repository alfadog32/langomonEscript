#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const { BotEngine } = require('../moneymaker_v3');
const records = [];
const target = { target: { rawMarketId: 'fixture-market', slug: 'btc-updown-5m-fixture', BTC_UP_TOKEN_ID: 'up', BTC_DOWN_TOKEN_ID: 'down' } };
const oracleSignal = { token_id: 'up', direction: 'UP', confidence: 0.8, lag_score: 0.02 };
const book = { bestBid: 0.4, bestAsk: 0.5, midpoint: 0.45, spread: 0.1, cachedAt: Date.now(), bids: [{ price: 0.4, size: 2 }], asks: [{ price: 0.5, size: 2 }] };
const fake = {
  config: { gabagoolMaxPaperOrderUsd: 5 },
  buildGabagoolSyntheticAsset: (_target, tokenId) => ({ tokenId, market: { marketId: 'fixture-market', slug: 'btc-updown-5m-fixture' }, outcome: 'Up' }),
  gabagoolOutcomeForSignal: () => 'Up',
  recordStage5ShadowOpportunity: (record) => { records.push(record); return true; },
};
const invoke = BotEngine.prototype.recordGabagoolEntryPlanShadowBlock.bind(fake);
function assert(v, m) { if (!v) throw new Error(m); }
assert(invoke({ oracleSignal, oracleTarget: target, book, blocker: 'depth_floor', guard: { topBidUsd: 0.8, topAskUsd: 1, depthFloorUsd: 5 } }), 'depth helper must record');
assert(invoke({ oracleSignal, oracleTarget: target, book, blocker: 'volatility_guard', guard: { observedMovePct: 15, volatilityTripPct: 12 } }), 'volatility helper must record');
assert(records.length === 2, 'each terminal branch helper must create exactly one record');
assert(records[0].finalBlocker === 'depth_floor' && records[0].paperPlacement === 'NOT_REACHED', 'depth record mismatch');
assert(records[1].finalBlocker === 'volatility_guard' && records[1].paperPlacement === 'NOT_REACHED', 'volatility record mismatch');
assert(records[0].extra.guard.depthFloorUsd === 5 && records[1].extra.guard.observedMovePct === 15, 'guard diagnostics missing');
process.stdout.write('stage5 shadow upstream instrumentation selfcheck: ok\n');
