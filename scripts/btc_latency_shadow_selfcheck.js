#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { normalizeBook, applyMarketMessage, partitionPriceChanges, markout, complement, firstAtOrAfter } = require('../lib/btc_latency_shadow');

const at = 1000;
const base = normalizeBook({ asset_id: 'up', market: 'm', bids: [{ price: '.49', size: '20' }], asks: [{ price: '.51', size: '20' }] }, at);
const changed = applyMarketMessage(base, { event_type: 'price_change', timestamp: '1001', price_changes: [{ asset_id: 'up', side: 'BUY', price: '.50', size: '10' }] }, 1001);
assert.equal(changed.bestBid, .5);
const partitioned = partitionPriceChanges({ price_changes: [{ asset_id: 'up', side: 'BUY', price: '.5', size: '1' }, { asset_id: 'down', side: 'SELL', price: '.5', size: '2' }] });
assert.equal(partitioned.size, 2);
assert.equal(partitioned.get('up').length, 1, 'multi-token packet must not cross-contaminate books');
assert.equal(firstAtOrAfter([base, changed], 1001), changed, 'no-lookahead lookup must choose first later observation');
const exit = normalizeBook({ bids: [{ price: '.56', size: '20' }], asks: [{ price: '.57', size: '20' }] }, 2000);
const scored = markout({ entryBook: base, exitBook: exit, feeRate: .07, feeExponent: 1 });
assert(scored.scorable && scored.netExecutablePnlPerUsd > 0);
assert.equal(markout({ entryBook: base, exitBook: exit }).reason, 'fee_metadata_unknown');
const down = normalizeBook({ bids: [{ price: '.47', size: '20' }], asks: [{ price: '.48', size: '20' }] }, at);
const arb = complement({ upBook: base, downBook: down, shares: 5, upFee: { rate: .07, exponent: 1 }, downFee: { rate: .07, exponent: 1 } });
assert(arb.scorable && arb.rawEdgeUsd > 0 && arb.netEdgeUsd < arb.rawEdgeUsd);
console.log('btc_latency_shadow_selfcheck: PASS');
