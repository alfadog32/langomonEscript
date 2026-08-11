#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  breakEvenResolutionProbability,
  capitalClassification,
  evaluateVenueMinimumEntry,
  opportunityKey,
  reliableResolutionEvidence,
  scoreForwardBidMark,
  scoreResolution,
} = require('../lib/tailend_economic_validity');

const near = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

for (const [price, expected] of [[0.95, 0.952375], [0.97, 0.971455], [0.98, 0.98098], [0.99, 0.990495]]) {
  near(breakEvenResolutionProbability(price, 0.05, 1), expected);
}
near(breakEvenResolutionProbability(0.99, 0.07, 1), 0.990693);
near(breakEvenResolutionProbability(0.99, 0.07, 1, false), 0.99);
assert.equal(breakEvenResolutionProbability(1, 0.05, 1), null);
assert.equal(breakEvenResolutionProbability(0.99, null, 1), null);

const book = {
  minOrderSizeReported: true,
  minOrderSize: 5,
  asks: [{ price: 0.99, size: 3 }, { price: 0.995, size: 4 }],
  bids: [{ price: 0.985, size: 10 }],
};
const feeMeta = { source: 'official_clob_market_info', rate: 0.07, exponent: 1, takerOnly: true };
const entry = evaluateVenueMinimumEntry(book, feeMeta);
assert.equal(entry.ok, true);
near(entry.executablePrice, 0.992);
near(entry.requiredNotionalUsd, 4.96);
near(entry.entryFeeUsd, 5 * 0.07 * 0.992 * 0.008);
near(entry.requiredCapitalUsd, entry.requiredNotionalUsd + entry.entryFeeUsd);
near(entry.breakEvenProbability, 0.992 + 0.07 * 0.992 * 0.008);
assert.equal(entry.levelsUsed, 2);
near(entry.worstPriceReached, 0.995);
assert.equal(evaluateVenueMinimumEntry({ ...book, minOrderSizeReported: false }, feeMeta).reason, 'venue_minimum_unreported');
assert.equal(evaluateVenueMinimumEntry({ ...book, asks: [{ price: 0.99, size: 4 }] }, feeMeta).reason, 'insufficient_executable_ask_depth');
assert.equal(evaluateVenueMinimumEntry(book, null).reason, 'official_fee_metadata_unavailable');

const keyInput = { marketId: 'm1', tokenId: 't1', outcome: 'Yes' };
assert.equal(opportunityKey(keyInput), 'm1:t1:Yes');
assert.equal(opportunityKey(keyInput), opportunityKey({ ...keyInput }));

assert.equal(reliableResolutionEvidence({ closed: false }, 'Yes').reason, 'market_not_closed');
assert.equal(reliableResolutionEvidence({ closed: true }, 'Yes').reason, 'accepting_orders_evidence_missing');
assert.equal(reliableResolutionEvidence({ closed: true, acceptingOrders: true }, 'Yes').reason, 'market_still_accepting_orders');
assert.equal(reliableResolutionEvidence({ closed: true, acceptingOrders: false, resolutionStatus: 'proposed' }, 'Yes').reason, 'market_resolution_pending');
assert.equal(reliableResolutionEvidence({ closed: true, acceptingOrders: false, outcomes: ['Yes', 'No'], outcomePrices: [0.6, 0.4] }, 'Yes').reason, 'terminal_prices_not_decisive');
const winEvidence = reliableResolutionEvidence({
  closed: true, acceptingOrders: false, resolutionStatus: 'resolved',
  outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', closedTime: '2026-08-11T02:00:00.000Z',
}, 'Yes');
assert.equal(winEvidence.resolved, true);
assert.equal(winEvidence.correct, true);
const lossEvidence = reliableResolutionEvidence({
  closed: true, acceptingOrders: false, outcomes: ['Yes', 'No'], outcomePrices: [0, 1], closedTime: '2026-08-11T02:00:00.000Z',
}, 'Yes');
assert.equal(lossEvidence.resolved, true);
assert.equal(lossEvidence.correct, false);

const observation = {
  timestamp: '2026-08-11T01:00:00.000Z',
  entryEconomics: entry,
  venueMinimumRisk: { passed: false },
};
const winScore = scoreResolution(observation, winEvidence, Date.parse('2026-08-11T02:01:00.000Z'));
near(winScore.netPnlUsd, 5 - entry.requiredCapitalUsd);
near(winScore.maximumAdverseLossUsd, -entry.requiredCapitalUsd);
assert.equal(winScore.signalToResolutionMs, 60 * 60_000);
const lossScore = scoreResolution(observation, lossEvidence);
near(lossScore.netPnlUsd, -entry.requiredCapitalUsd);

const targetAtMs = Date.parse(observation.timestamp) + 5 * 60_000;
const mark = scoreForwardBidMark(observation, book, feeMeta, targetAtMs, targetAtMs + 1_500);
assert.equal(mark.ok, true);
near(mark.executableBidPrice, 0.985);
near(mark.exitFeeUsd, 5 * 0.07 * 0.985 * 0.015);
assert.equal(mark.noLookaheadDelayMs, 1_500);
assert.equal(scoreForwardBidMark(observation, { bids: [{ price: 0.98, size: 4 }] }, feeMeta, targetAtMs).reason, 'insufficient_executable_bid_depth');

assert.equal(capitalClassification(observation), 'D_UNRESOLVED_OR_INSUFFICIENT');
assert.equal(capitalClassification({ ...observation, resolutionScore: winScore }), 'A_POSITIVE_RESOLVED_PNL_BUT_CAP_BLOCKED');
assert.equal(capitalClassification({ ...observation, resolutionScore: lossScore }), 'B_CAP_BLOCKED_AND_NOT_ECONOMICALLY_JUSTIFIED');
assert.equal(capitalClassification({ ...observation, venueMinimumRisk: { passed: true }, resolutionScore: lossScore }), 'C_VENUE_MINIMUM_FITS_CAPS');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'fee_adjusted_break_even_probability',
    'venue_minimum_depth_walk_and_official_fee',
    'reliable_terminal_resolution',
    'hypothetical_resolution_pnl',
    'no_lookahead_executable_bid_mark',
    'capital_counterfactual_classification',
  ],
}));
