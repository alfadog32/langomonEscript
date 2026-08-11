#!/usr/bin/env node
'use strict';

/**
 * Fixture-only selfcheck for scripts/btc_lag_gate_markout_research.js.
 *
 * Never touches production files, never uses the network, never places orders.
 * All fixtures are synthetic and written to a temporary directory.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  executableMarkout,
  describe,
  bucketLatency,
  bucketTimeToExpiry,
  readSignals,
  NOTIONAL_USD,
  ASSUMED_MIN_SHARES,
} = require('./btc_lag_gate_markout_research');

const RESEARCH = path.join(__dirname, 'btc_lag_gate_markout_research.js');
const PRODUCTION_UNTOUCHABLE = [
  'moneymaker_v3.js',
  'btc_poly_oracle_v5_sniper_bridge_FIXED.js',
  'external_signal_events.ndjson',
];

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function book({ bid, ask, bidDepth = 100, askDepth = 100, valid = true, ageMs = 50 }) {
  return {
    valid,
    reason: 'ok',
    age_ms: ageMs,
    best_bid: bid,
    best_ask: ask,
    midpoint: bid !== null && ask !== null ? (bid + ask) / 2 : null,
    spread: bid !== null && ask !== null ? ask - bid : null,
    bid_depth_usd: bidDepth,
    ask_depth_usd: askDepth,
    obi: 0,
  };
}

console.log('btc_lag_gate_markout_research selfcheck');

// --- executableMarkout: buys the ask, marks the bid -------------------------
check('buys ask and marks bid (loss when book unchanged)', () => {
  const mk = executableMarkout(book({ bid: 0.40, ask: 0.44 }), book({ bid: 0.40, ask: 0.44 }));
  assert.strictEqual(mk.entryPrice, 0.44);
  assert.strictEqual(mk.exitPrice, 0.40);
  // Unchanged book must lose the full spread, never break even.
  assert.ok(mk.pnlPerDollar < 0, 'unchanged book must be a loss');
  assert.ok(Math.abs(mk.pnlPerDollar - ((0.40 / 0.44) - 1)) < 1e-12);
});

check('profits only when the bid rises above the entry ask', () => {
  const mk = executableMarkout(book({ bid: 0.40, ask: 0.44 }), book({ bid: 0.50, ask: 0.54 }));
  assert.ok(mk.pnlPerDollar > 0);
  assert.ok(Math.abs(mk.pnlPerDollar - ((0.50 / 0.44) - 1)) < 1e-12);
});

check('never uses midpoint-to-midpoint economics', () => {
  // Mid rises 0.42 -> 0.44 but the executable bid is still below the entry ask.
  const mk = executableMarkout(book({ bid: 0.40, ask: 0.44 }), book({ bid: 0.42, ask: 0.46 }));
  assert.ok(mk.pnlPerDollar < 0, 'rising midpoint must not manufacture profit');
});

check('rejects invalid books', () => {
  assert.strictEqual(executableMarkout(book({ bid: 0.4, ask: 0.44, valid: false }), book({ bid: 0.4, ask: 0.44 })), null);
  assert.strictEqual(executableMarkout(book({ bid: 0.4, ask: 0.44 }), book({ bid: 0.4, ask: 0.44, valid: false })), null);
  assert.strictEqual(executableMarkout(null, book({ bid: 0.4, ask: 0.44 })), null);
});

check('rejects non-probability prices', () => {
  assert.strictEqual(executableMarkout(book({ bid: 0.4, ask: 1.0 }), book({ bid: 0.4, ask: 0.44 })), null);
  assert.strictEqual(executableMarkout(book({ bid: 0.4, ask: 0.44 }), book({ bid: 0, ask: 0.44 })), null);
});

check('flags depth and minimum-share infeasibility', () => {
  const thin = executableMarkout(book({ bid: 0.40, ask: 0.44, askDepth: 0.5, bidDepth: 0.25 }), book({ bid: 0.40, ask: 0.44, bidDepth: 0.25 }));
  assert.strictEqual(thin.entryDepthOk, false);
  assert.strictEqual(thin.exitDepthOk, false);
  // $1 at 0.44 buys ~2.27 shares, under the assumed 5-share minimum.
  assert.strictEqual(thin.minSharesOk, false);
  const cheap = executableMarkout(book({ bid: 0.08, ask: 0.10 }), book({ bid: 0.08, ask: 0.10 }));
  assert.ok(cheap.shares >= ASSUMED_MIN_SHARES, 'cheap token clears the share minimum');
  assert.strictEqual(cheap.minSharesOk, true);
});

// --- statistics -------------------------------------------------------------
check('describe reports mean/median/cumulative/win-rate', () => {
  const st = describe([-1, 1, 3]);
  assert.strictEqual(st.n, 3);
  assert.strictEqual(st.mean, 1);
  assert.strictEqual(st.median, 1);
  assert.strictEqual(st.sum, 3);
  assert.ok(Math.abs(st.winRate - (2 / 3)) < 1e-12);
  const empty = describe([]);
  assert.strictEqual(empty.n, 0);
  assert.strictEqual(empty.mean, null);
});

check('describe ignores non-finite values instead of imputing', () => {
  const st = describe([1, null, NaN, undefined, 3]);
  assert.strictEqual(st.n, 2);
  assert.strictEqual(st.mean, 2);
});

// --- bucketing --------------------------------------------------------------
check('latency and expiry buckets are monotone', () => {
  assert.strictEqual(bucketLatency(50), 'a_0_100ms');
  assert.strictEqual(bucketLatency(200), 'b_100_250ms');
  assert.strictEqual(bucketLatency(400), 'c_250_500ms');
  assert.strictEqual(bucketLatency(900), 'd_over_500ms');
  assert.strictEqual(bucketLatency(NaN), 'unknown');
  assert.strictEqual(bucketTimeToExpiry(10_000), 'a_under_30s');
  assert.strictEqual(bucketTimeToExpiry(300_000), 'e_over_240s');
  assert.strictEqual(bucketTimeToExpiry(null), 'unknown');
});

// --- parsing ----------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-lag-research-'));
const fixture = path.join(tmp, 'events.ndjson');

check('readSignals keeps V5 records, counts unparseable, drops other types', () => {
  const lines = [
    JSON.stringify({ type: 'BTC_TEMPORAL_LAG_OBI_V5', timestamp: '2026-08-02T00:00:00.000Z', poly_lag_confirmed: false, book_at_trigger: book({ bid: 0.4, ask: 0.44 }), book_after_persistence: book({ bid: 0.4, ask: 0.44 }) }),
    JSON.stringify({ type: 'BTC_TEMPORAL_LAG_OBI_REJECTED', timestamp: '2026-08-02T00:00:01.000Z' }),
    '{ this is not json',
    '',
    JSON.stringify({ type: 'BTC_TEMPORAL_LAG_OBI_V5', timestamp: '2026-08-02T00:00:02.000Z', poly_lag_confirmed: true, book_at_trigger: book({ bid: 0.4, ask: 0.44 }), book_after_persistence: book({ bid: 0.5, ask: 0.54 }) }),
  ];
  fs.writeFileSync(fixture, `${lines.join('\n')}\n`, 'utf8');
  const { signals, unparseable } = readSignals(fixture);
  assert.strictEqual(signals.length, 2);
  assert.strictEqual(unparseable, 1);
});

// --- end-to-end on the fixture, with no network -----------------------------
check('runs end-to-end offline and reports non-reconstructable horizons', () => {
  const jsonPath = path.join(tmp, 'out.json');
  const out = execFileSync(process.execPath, [RESEARCH, `--events=${fixture}`, `--json=${jsonPath}`], {
    encoding: 'utf8',
    env: { ...process.env, MM_SKIP_LOCAL_ENV_FILE: '1', SKIP_LOCAL_ENV_FILE: '1' },
  });
  assert.ok(out.includes('NOT RECONSTRUCTABLE'), 'must state what cannot be reconstructed');
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(report.eligibility.polyLagNotConfirmed, 1);
  assert.strictEqual(report.eligibility.polyLagConfirmed, 1);
  assert.strictEqual(report.reconstructability.maeMfeReconstructable, false);
  assert.strictEqual(report.reconstructability.feeDataAuthoritative, false);
  assert.strictEqual(report.decisionPointEntry.reconstructable, false);
  assert.deepStrictEqual(
    report.reconstructability.notReconstructableHorizonsMs,
    [250, 500, 1000, 2000, 3000, 5000, 10000, 15000, 30000, 60000]
  );
  // The single eligible fixture row has an unchanged book -> must be a loss.
  assert.ok(report.triggerToPostPersistence.allWithBooks.mean < 0);
  assert.strictEqual(report.resolution.attempted, 0, 'resolution must not run without --resolve');
  // The survivorship caveat must be machine-readable, not just prose.
  assert.strictEqual(report.selectionBias.triggerToPostPersistenceIsBiased, true);
  assert.strictEqual(report.triggerToPostPersistence.biased, true);
  assert.ok(out.includes('SELECTION BIAS'), 'human output must surface the bias');
  // The fixture's poly_lag_confirmed record lacks lag_score_pass/obi -> not fully confirmed.
  assert.strictEqual(report.fullyConfirmedCohort.count, 0);
});

check('fully-confirmed cohort requires all three gates', () => {
  const f2 = path.join(tmp, 'confirmed.ndjson');
  const mk = (over) => JSON.stringify({
    type: 'BTC_TEMPORAL_LAG_OBI_V5',
    timestamp: '2026-08-02T00:00:00.000Z',
    book_at_trigger: book({ bid: 0.4, ask: 0.44 }),
    book_after_persistence: book({ bid: 0.5, ask: 0.54 }),
    poly_lag_confirmed: true,
    lag_score_pass: true,
    obi_confirmed: true,
    ...over,
  });
  fs.writeFileSync(f2, `${[mk({}), mk({ obi_confirmed: false }), mk({ lag_score_pass: false })].join('\n')}\n`, 'utf8');
  const jsonPath = path.join(tmp, 'out2.json');
  execFileSync(process.execPath, [RESEARCH, `--events=${f2}`, `--json=${jsonPath}`], {
    encoding: 'utf8',
    env: { ...process.env, MM_SKIP_LOCAL_ENV_FILE: '1', SKIP_LOCAL_ENV_FILE: '1' },
  });
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(report.fullyConfirmedCohort.count, 1, 'only the all-three-gates record counts');
  assert.ok(report.fullyConfirmedCohort.stats.mean > 0, 'fixture confirmed record is a winner');
});

check('production files are untouched by the research run', () => {
  for (const rel of PRODUCTION_UNTOUCHABLE) {
    const p = path.join(__dirname, '..', rel);
    assert.ok(fs.existsSync(p), `${rel} must still exist`);
  }
  // The research module must not import production trading logic.
  const src = fs.readFileSync(RESEARCH, 'utf8');
  for (const needle of ['moneymaker_v3', 'live_adapter_polymarket', 'live_intent_router', '.env.live.secrets']) {
    assert.ok(!src.includes(`require('../${needle}`), `must not require ${needle}`);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nPASS ${passed} checks`);
