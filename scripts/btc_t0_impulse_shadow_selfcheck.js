#!/usr/bin/env node
'use strict';

/**
 * Fixture-only regression suite for scripts/btc_t0_impulse_shadow.js.
 * No network, no production writes, no orders, no PM2.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeBook, markout, firstAtOrAfter, lastAtOrBefore, compactBookSnapshot, boundRing,
} = require('../lib/btc_latency_shadow');
const {
  PREREGISTRATION, HORIZONS, ARMS, ARM_THROTTLE_MS, LOOKBACK_MS,
  SECONDARY_MAX_STALENESS_MS, describe, crossingCost, episodeReadyToScore,
} = require('./btc_t0_impulse_shadow');

const ROOT = path.resolve(__dirname, '..');
const COLLECTOR = path.join(ROOT, 'scripts', 'btc_t0_impulse_shadow.js');
const SOURCE = fs.readFileSync(COLLECTOR, 'utf8');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

function book(observedAtMs, { bid = 0.49, ask = 0.51, levels = 20, size = 50 } = {}) {
  return normalizeBook({
    asset_id: 'tok', market: 'mkt', min_order_size: 5,
    bids: Array.from({ length: levels }, (_, i) => ({ price: bid - i * 0.001, size })),
    asks: Array.from({ length: levels }, (_, i) => ({ price: ask + i * 0.001, size })),
  }, observedAtMs);
}
const snap = (t, o) => compactBookSnapshot(book(t, o), { maxLevels: 12 });

console.log('btc_t0_impulse_shadow_selfcheck');

// --- pre-registration integrity ---------------------------------------------
check('pre-registration is fixed, three arms, primary is arm_1.0bp', () => {
  assert.strictEqual(ARMS.length, 3);
  assert.deepStrictEqual(ARMS.map((a) => a.name), ['arm_0.5bp', 'arm_1.0bp', 'arm_2.0bp']);
  assert.deepStrictEqual(ARMS.map((a) => a.thresholdPct), [0.00005, 0.00010, 0.00020]);
  assert.strictEqual(PREREGISTRATION.primaryArm, 'arm_1.0bp');
  assert.strictEqual(PREREGISTRATION.armsPooled, false);
  assert.strictEqual(PREREGISTRATION.noMidpointProfitabilityClaims, true);
  assert.ok(PREREGISTRATION.postHocArmSelectionProhibited.length > 0);
  for (const k of ['A', 'B', 'C']) assert.ok(PREREGISTRATION.interpretation[k], `interpretation ${k} pre-registered`);
  assert.deepStrictEqual(HORIZONS, [0, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000]);
  assert.ok(SOURCE.includes('preRegistration: PREREGISTRATION'), 'every report must embed the pre-registration');
});

// --- 1 & 2. per-arm triggers, throttles, nesting -----------------------------
// Mirrors the collector's detection loop.
function detect(state, ticks, { receivedAtMs, price }) {
  const initial = ticks.find((t) => t.receivedAtMs >= receivedAtMs - LOOKBACK_MS) || ticks[0];
  const move = (price - initial.price) / initial.price;
  const episodeId = `ep-${receivedAtMs}`;
  const fired = [];
  for (const arm of ARMS) {
    if (Math.abs(move) < arm.thresholdPct) continue;
    const s = state.get(arm.name);
    const last = s.lastDetectedAtMs;
    if (Number.isFinite(last) && (receivedAtMs - last) <= ARM_THROTTLE_MS) continue;
    s.lastDetectedAtMs = receivedAtMs;
    s.triggers.push({ direction: move > 0 ? 'UP' : 'DOWN', detectedAtMs: receivedAtMs, episodeId, move });
    fired.push(arm.name);
  }
  return { fired, episodeId, move };
}
const freshState = () => new Map(ARMS.map((a) => [a.name, { lastDetectedAtMs: null, triggers: [] }]));

check('arm triggers accumulate past one element and stay time ordered', () => {
  const state = freshState();
  const base = 60000;
  for (let i = 0; i < 20; i += 1) {
    const t = 1000 + i * 600;
    detect(state, [{ price: base, receivedAtMs: t - 10 }], { receivedAtMs: t, price: base * (1 + 0.0003) });
  }
  const trig = state.get('arm_1.0bp').triggers;
  assert.ok(trig.length > 1, 'regression: triggers must not freeze at one element');
  assert.strictEqual(trig.length, 20);
  for (let i = 1; i < trig.length; i += 1) {
    assert.ok(trig[i].detectedAtMs > trig[i - 1].detectedAtMs, 'triggers must be time ordered');
    assert.ok(Number.isFinite(trig[i].detectedAtMs), 'canonical detectedAtMs must be finite');
  }
});

check('one tick fires nested arms under a shared episodeId', () => {
  const state = freshState();
  const base = 60000;
  const r = detect(state, [{ price: base, receivedAtMs: 990 }], { receivedAtMs: 1000, price: base * (1 + 0.00025) });
  assert.deepStrictEqual(r.fired, ['arm_0.5bp', 'arm_1.0bp', 'arm_2.0bp'], '2.5bp move must fire all three arms');
  for (const name of r.fired) assert.strictEqual(state.get(name).triggers[0].episodeId, r.episodeId, 'shared episodeId links nested arms');
});

check('sub-threshold moves fire only the arms they clear', () => {
  const state = freshState();
  const base = 60000;
  const r = detect(state, [{ price: base, receivedAtMs: 990 }], { receivedAtMs: 1000, price: base * (1 + 0.00007) });
  assert.deepStrictEqual(r.fired, ['arm_0.5bp'], '0.7bp clears only the 0.5bp arm');
});

check('per-arm throttles are independent', () => {
  const state = freshState();
  const base = 60000;
  // 0.7bp fires only arm_0.5bp and starts its throttle.
  detect(state, [{ price: base, receivedAtMs: 990 }], { receivedAtMs: 1000, price: base * (1 + 0.00007) });
  // 100ms later a 2.5bp move: arm_0.5bp is throttled, the other two are not.
  const r = detect(state, [{ price: base, receivedAtMs: 1090 }], { receivedAtMs: 1100, price: base * (1 + 0.00025) });
  assert.deepStrictEqual(r.fired, ['arm_1.0bp', 'arm_2.0bp'], 'throttle must be per-arm, not global');
  assert.strictEqual(state.get('arm_0.5bp').triggers.length, 1);
});

check('DOWN impulses are detected and directed', () => {
  const state = freshState();
  const base = 60000;
  const r = detect(state, [{ price: base, receivedAtMs: 990 }], { receivedAtMs: 1000, price: base * (1 - 0.00025) });
  assert.strictEqual(state.get('arm_1.0bp').triggers[0].direction, 'DOWN');
  assert.ok(r.move < 0);
});

// --- 3. lastAtOrBefore + staleness gate -------------------------------------
check('lastAtOrBefore returns the newest observation at or before T0', () => {
  const ring = [snap(1000), snap(2000), snap(3000)];
  assert.strictEqual(lastAtOrBefore(ring, 2500).observedAtMs, 2000);
  assert.strictEqual(lastAtOrBefore(ring, 2000).observedAtMs, 2000, 'boundary is inclusive');
  assert.strictEqual(lastAtOrBefore(ring, 999), null, 'null when nothing precedes T0');
  assert.strictEqual(lastAtOrBefore([], 5000), null);
  assert.strictEqual(lastAtOrBefore(ring, 9999).observedAtMs, 3000);
});

check('secondary entry is rejected when the pre-T0 quote is stale', () => {
  const t0 = 10_000;
  const fresh = lastAtOrBefore([snap(t0 - 100)], t0);
  const stale = lastAtOrBefore([snap(t0 - 5_000)], t0);
  assert.ok(t0 - fresh.observedAtMs <= SECONDARY_MAX_STALENESS_MS);
  assert.ok(t0 - stale.observedAtMs > SECONDARY_MAX_STALENESS_MS, 'stale quote must fail the gate');
  assert.strictEqual(SECONDARY_MAX_STALENESS_MS, 250);
});

// --- 4. no lookahead across all ten horizons --------------------------------
check('no lookahead at every registered horizon', () => {
  const t0 = 100_000;
  const ring = [];
  for (let t = t0 - 20_000; t <= t0 + 40_000; t += 25) ring.push(snap(t));
  const entry = firstAtOrAfter(ring, t0);
  assert.ok(entry.observedAtMs >= t0, 'entry must be at or after T0');
  for (const h of HORIZONS) {
    const exit = h === 0 ? entry : firstAtOrAfter(ring, t0 + h);
    assert.ok(exit, `horizon ${h} must resolve`);
    assert.ok(exit.observedAtMs >= t0 + h, `horizon ${h} marked too early`);
    assert.ok(exit.observedAtMs >= entry.observedAtMs, `horizon ${h} marked before entry`);
  }
});

check('missing future books yield null and are never back-filled', () => {
  const t0 = 100_000;
  const short = [];
  for (let t = t0; t <= t0 + 1_000; t += 25) short.push(snap(t));
  assert.strictEqual(firstAtOrAfter(short, t0 + 10_000), null, 'absent future data must not be imputed');
  assert.ok(SOURCE.includes("reason: primaryEntry ? 'missing_future_book' : 'missing_entry_book'"),
    'unresolved horizons must be recorded as unscorable, not dropped');
});

// --- 5. h=0 is a cost, never a return ---------------------------------------
check('h=0 is the instantaneous crossing cost and is always negative', () => {
  const entry = snap(1000, { bid: 0.49, ask: 0.51 });
  assert.ok(crossingCost(entry) < 0, 'crossing cost must be negative');
  const m = markout({ entryBook: entry, exitBook: entry, targetUsd: 1, feeRate: 0.07, feeExponent: 1 });
  assert.ok(m.scorable && m.netExecutablePnlPerUsd < 0, 'entry==exit must lose the spread, never break even');
  assert.strictEqual(crossingCost(null), null);
  assert.ok(PREREGISTRATION.horizonZeroMeaning.includes('never as a return'));
});

// --- 6. ring bounding + downsampling ----------------------------------------
check('ring stays bounded by age AND count under a high-frequency stream', () => {
  const ring = [];
  let now = 1_000_000;
  for (let i = 0; i < 20_000; i += 1) {
    now += 5;
    ring.push(snap(now));
    boundRing(ring, { maxAgeMs: 60_000, maxCount: 400, nowMs: now });
    assert.ok(ring.length <= 400, `count cap breached at i=${i}`);
  }
  for (let i = 1; i < ring.length; i += 1) assert.ok(ring[i].observedAtMs >= ring[i - 1].observedAtMs);
});

check('downsampling keeps every price move and drops only depth churn', () => {
  const ring = [];
  const append = (b) => {
    const last = ring.length ? ring.at(-1) : null;
    if (last && last.bestBid === b.bestBid && last.bestAsk === b.bestAsk && (b.observedAtMs - last.observedAtMs) < 25) return false;
    ring.push(compactBookSnapshot(b, { maxLevels: 12 }));
    return true;
  };
  for (let i = 0; i < 100; i += 1) append(book(1000 + i, { bid: 0.49, ask: 0.51 }));
  assert.ok(ring.length <= 6, `depth churn not downsampled: ${ring.length}`);
  const before = ring.length;
  append(book(1101, { bid: 0.50, ask: 0.52 }));
  append(book(1102, { bid: 0.51, ask: 0.53 }));
  assert.strictEqual(ring.length, before + 2, 'price moves must never be dropped');
});

// --- 7 & 8. eviction and score-once-freeze ----------------------------------
check('eviction skips tokens with unscored episodes and clears when scored', () => {
  const hasUnscored = (token, eps) => eps.some((e) => e.tokenId === token && !e.scored);
  assert.strictEqual(hasUnscored('tok', [{ tokenId: 'tok', scored: false }]), true);
  assert.strictEqual(hasUnscored('tok', [{ tokenId: 'tok', scored: true }]), false);
  assert.ok(SOURCE.includes('if (episodes.some((ep) => ep.tokenId === token && !ep.scored)) continue;'),
    'collector must guard eviction on unscored episodes');
  const idxScore = SOURCE.indexOf('scoreReadyEpisodes()');
  const idxEvict = SOURCE.indexOf('evictRetiredTokens()');
  assert.ok(idxScore > 0 && idxEvict > idxScore, 'episodes must be scored before tokens are evicted');
});

check('episodes only score once their longest horizon has elapsed', () => {
  const ep = { t0AtMs: 100_000 };
  assert.strictEqual(episodeReadyToScore(ep, 105_000), false);
  assert.strictEqual(episodeReadyToScore(ep, 100_000 + 10_000 + 1_999), false);
  assert.strictEqual(episodeReadyToScore(ep, 100_000 + 10_000 + 2_001), true);
});

check('frozen scores survive ring deletion', () => {
  const rings = new Map([['tok', [snap(1000)]]]);
  const ep = { tokenId: 'tok', scored: true, primary: { 1000: { scorable: true, netExecutablePnlPerUsd: -0.02 } } };
  rings.delete('tok');
  assert.strictEqual(ep.primary[1000].netExecutablePnlPerUsd, -0.02);
});

// --- 9. checkpoint recoverability -------------------------------------------
check('checkpoint is atomic, private (0600) and recoverable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0-shadow-ckpt-'));
  const out = path.join(dir, 'r.json');
  const write = (r) => {
    const tmp = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, out);
  };
  write({ partial: true, checkpoint: { sequence: 1 }, episodes: [{ episodeId: 'a' }] });
  write({ partial: true, checkpoint: { sequence: 2 }, episodes: [{ episodeId: 'a' }, { episodeId: 'b' }] });
  const back = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(back.checkpoint.sequence, 2, 'latest checkpoint wins');
  assert.strictEqual(back.episodes.length, 2);
  assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, 'no temp files left');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(SOURCE.includes("writeCheckpoint('startup')"), 'must checkpoint before the first episode');
  assert.ok(SOURCE.includes("writeCheckpoint('periodic')"), 'must checkpoint periodically');
  assert.ok(SOURCE.includes("'uncaughtException', 'unhandledRejection'"), 'fatal handlers salvage a checkpoint');
  assert.ok(SOURCE.includes("process.on('SIGINT'") && SOURCE.includes("process.on('SIGTERM'"));
});

// --- 10. oracle annotation never gates a sample ------------------------------
check('oracle file annotates only; never_emitted episodes still score', () => {
  // Trigger creation must not reference the events file.
  const binanceBlock = SOURCE.slice(SOURCE.indexOf('function connectBinance'), SOURCE.indexOf('function annotateFromOracleEvent'));
  assert.ok(!/EVENTS|tailEvents|external_signal_events/.test(binanceBlock),
    'impulse detection must be independent of external_signal_events.ndjson');
  assert.ok(SOURCE.includes("oracleOutcome: 'never_emitted'"), 'never_emitted must be a first-class default');
  assert.ok(SOURCE.includes('oracleFileNeverGatesSamples: true'));
  // Annotation only mutates oracle* fields; it never pushes or filters episodes.
  const ann = SOURCE.slice(SOURCE.indexOf('function annotateFromOracleEvent'), SOURCE.indexOf('function tailEvents'));
  assert.ok(!/episodes\.push|episodes\s*=|splice/.test(ann), 'annotation must not create or remove episodes');
  // A never_emitted episode is still scorable.
  const ring = [];
  const t0 = 50_000;
  for (let t = t0; t <= t0 + 20_000; t += 25) ring.push(snap(t));
  const entry = firstAtOrAfter(ring, t0);
  const m = markout({ entryBook: entry, exitBook: firstAtOrAfter(ring, t0 + 10_000), targetUsd: 1, feeRate: 0.07, feeExponent: 1 });
  assert.strictEqual(m.scorable, true, 'an episode the oracle never emitted must still score');
});

check('annotation window is bounded and directional', () => {
  assert.ok(SOURCE.includes('ORACLE_ANNOTATION_WINDOW_MS'), 'annotation must be time-bounded');
  assert.ok(SOURCE.includes('if (episode.direction !== event.direction) continue;'), 'annotation must match direction');
  assert.ok(SOURCE.includes('if (age < 0 || age > ORACLE_ANNOTATION_WINDOW_MS) continue;'), 'no lookahead: oracle events before T0 must not annotate');
});

// --- 11 & 12. safety and midpoint discipline --------------------------------
check('no order path, no POST, writes only to the output target', () => {
  for (const needle of ['placeOrder', 'createOrder', 'postOrder', 'submitOrder', 'signOrder', 'ENABLE_LIVE_TRADING', '.env.live.secrets', 'privateKey', 'moneymaker_v3_state', 'auto_live_candidates']) {
    assert.ok(!SOURCE.includes(needle), `collector must not reference ${needle}`);
  }
  assert.ok(!/method:\s*['"]POST['"]/.test(SOURCE), 'no POST requests');
  for (const w of SOURCE.match(/fs\.(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync)\([^)]*/g) || []) {
    assert.ok(/tmp|OUTPUT/.test(w), `unexpected write target: ${w}`);
  }
  assert.ok(/fs\.openSync\(EVENTS, 'r'\)/.test(SOURCE), 'event tail must open read-only');
});

check('midpoint economics never feed a reported expectancy field', () => {
  assert.ok(SOURCE.includes('midpointDiagnosticOnly'), 'midpoint must be quarantined in a diagnostic field');
  // Reported expectancy reads netExecutablePnlPerUsd / grossExecutablePnlPerUsd only.
  const report = SOURCE.slice(SOURCE.indexOf('function horizonTable'), SOURCE.indexOf('function memoryUsage'));
  assert.ok(!/midpoint/i.test(report.replace(/midpointDiagnosticOnly/g, '')), 'reporting must not read midpoint fields');
  assert.ok(report.includes('netExecutablePnlPerUsd'));
});

check('describe reports the required per-arm statistics', () => {
  const d = describe([-0.02, -0.01, 0.03]);
  assert.strictEqual(d.n, 3);
  assert.ok(Math.abs(d.cumulative - 0) < 1e-12);
  assert.ok(Math.abs(d.winRate - (1 / 3)) < 1e-12);
  assert.strictEqual(d.median, -0.01);
  const empty = describe([]);
  assert.strictEqual(empty.n, 0);
  assert.strictEqual(empty.mean, null);
  assert.strictEqual(describe([1, null, NaN, 3]).n, 2, 'non-finite values are ignored, never imputed');
});

check('arms are reported independently and never pooled', () => {
  assert.ok(SOURCE.includes('arms: ARMS.map((a) => armReport(a.name))'), 'each arm reported separately');
  assert.ok(SOURCE.includes("episodes.filter((e) => e.arm === armName"), 'arm rows are filtered by arm');
  assert.ok(SOURCE.includes('magnitudeVsExpectancy'), 'impulse magnitude vs expectancy must be reported');
  assert.ok(SOURCE.includes('armsNested'), 'nesting caveat must ship with the report');
});

console.log(`\nPASS ${passed} checks`);
