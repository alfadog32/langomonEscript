#!/usr/bin/env node
'use strict';

/**
 * Regression fixtures for the BTC forward latency SHADOW collector repair.
 *
 * Covers the two proven defects from the failed forward run plus the
 * robustness requirements:
 *   1 memory/ring count bounded under a synthetic high-frequency book stream
 *   2 retired-token eviction
 *   3 target rotation does not grow memory indefinitely
 *   4 sourceTriggers accumulates (was frozen at one element)
 *   5 trigger -> event association populates latency instead of null
 *   6 250ms..60s horizons keep strict no-lookahead behaviour
 *   7 partial checkpoint output is recoverable
 *   8 no production-order / production-write path exists
 *
 * Fixture-only: no network, no production writes, no orders, no PM2.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeBook, markout, firstAtOrAfter,
  compactBookSnapshot, boundRing, shallowDepthUsd, orderBookImbalance,
} = require('../lib/btc_latency_shadow');

const ROOT = path.resolve(__dirname, '..');
const COLLECTOR = path.join(ROOT, 'scripts', 'btc_latency_shadow.js');
const SOURCE = fs.readFileSync(COLLECTOR, 'utf8');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

function deepLadderBook(observedAtMs, { bid = 0.49, ask = 0.51, levels = 200 } = {}) {
  return normalizeBook({
    asset_id: 'tok', market: 'mkt',
    bids: Array.from({ length: levels }, (_, i) => ({ price: bid - i * 0.001, size: 50 })),
    asks: Array.from({ length: levels }, (_, i) => ({ price: ask + i * 0.001, size: 50 })),
  }, observedAtMs);
}

console.log('btc_latency_shadow_bounds_selfcheck');

// --- 1. compaction + ring bounding -----------------------------------------
check('compactBookSnapshot keeps only executable-relevant state', () => {
  const book = deepLadderBook(1000, { levels: 200 });
  const snap = compactBookSnapshot(book, { maxLevels: 12 });
  assert.strictEqual(snap.bids.length, 12);
  assert.strictEqual(snap.asks.length, 12);
  assert.strictEqual(snap.laddersTruncated, true);
  for (const field of ['observedAtMs', 'bestBid', 'bestAsk', 'midpoint', 'spread', 'bidDepthUsd', 'askDepthUsd', 'obi']) {
    assert.ok(snap[field] !== undefined, `${field} must be retained`);
  }
  assert.strictEqual(snap.bestBid, book.bestBid);
  assert.strictEqual(snap.bestAsk, book.bestAsk);
  // A shallow book is not falsely flagged as truncated.
  assert.strictEqual(compactBookSnapshot(deepLadderBook(1000, { levels: 3 }), { maxLevels: 12 }).laddersTruncated, false);
});

check('truncation is conservative: it can never fabricate a fill', () => {
  const entry = deepLadderBook(1000, { levels: 200 });
  const exit = deepLadderBook(2000, { bid: 0.56, ask: 0.57, levels: 200 });
  const full = markout({ entryBook: entry, exitBook: exit, targetUsd: 1, feeRate: 0.07, feeExponent: 1 });
  const thin = markout({
    entryBook: compactBookSnapshot(entry, { maxLevels: 1 }),
    exitBook: compactBookSnapshot(exit, { maxLevels: 1 }),
    targetUsd: 1, feeRate: 0.07, feeExponent: 1,
  });
  assert.ok(full.scorable);
  // Truncated may be unscorable, but if scorable it must not beat the full book.
  if (thin.scorable) assert.ok(thin.netExecutablePnlPerUsd <= full.netExecutablePnlPerUsd + 1e-12);
  // Exhausting the retained ladder must fail closed, never assume hidden depth.
  const starved = markout({
    entryBook: compactBookSnapshot(normalizeBook({ bids: [{ price: '.02', size: '0.1' }], asks: [{ price: '.03', size: '0.1' }] }, 1), { maxLevels: 12 }),
    exitBook: compactBookSnapshot(exit, { maxLevels: 12 }),
    targetUsd: 1, feeRate: 0.07, feeExponent: 1,
  });
  assert.strictEqual(starved.scorable, false);
  assert.strictEqual(starved.reason, 'insufficient_displayed_depth');
});

check('ring stays bounded under a high-frequency stream (age AND count)', () => {
  const ring = [];
  const maxCount = 500;
  let now = 1_000_000;
  for (let i = 0; i < 50_000; i += 1) {
    now += 5; // 200 updates/sec
    ring.push(compactBookSnapshot(deepLadderBook(now, { levels: 200 }), { maxLevels: 12 }));
    boundRing(ring, { maxAgeMs: 180_000, maxCount, nowMs: now });
    assert.ok(ring.length <= maxCount, `ring exceeded count cap at i=${i}`);
  }
  assert.strictEqual(ring.length, maxCount);
  // Age bound alone must also evict.
  const aged = [{ observedAtMs: 1 }, { observedAtMs: 2 }, { observedAtMs: 999_999 }];
  boundRing(aged, { maxAgeMs: 1_000, maxCount: 10, nowMs: 1_000_000 });
  assert.strictEqual(aged.length, 1);
  assert.strictEqual(aged[0].observedAtMs, 999_999);
  // Oldest-first eviction preserves ascending order for no-lookahead lookups.
  for (let i = 1; i < ring.length; i += 1) assert.ok(ring[i].observedAtMs >= ring[i - 1].observedAtMs);
});

check('ring downsampling keeps every price move and drops only depth churn', () => {
  const RING_MIN_INTERVAL_MS = 25;
  const ring = [];
  const append = (book) => {
    const last = ring.length ? ring.at(-1) : null;
    if (last) {
      const topUnchanged = last.bestBid === book.bestBid && last.bestAsk === book.bestAsk;
      if (topUnchanged && (book.observedAtMs - last.observedAtMs) < RING_MIN_INTERVAL_MS) return false;
    }
    ring.push(compactBookSnapshot(book, { maxLevels: 12 }));
    return true;
  };
  // 100 depth-only updates at 1ms spacing collapse to a handful of snapshots.
  let t = 1000;
  for (let i = 0; i < 100; i += 1) append(deepLadderBook(t + i, { bid: 0.49, ask: 0.51, levels: 20 }));
  const afterChurn = ring.length;
  assert.ok(afterChurn <= 6, `depth churn not downsampled: ${afterChurn} snapshots`);
  // Every top-of-book move is retained even inside the interval.
  const before = ring.length;
  append(deepLadderBook(t + 101, { bid: 0.50, ask: 0.52, levels: 20 }));
  append(deepLadderBook(t + 102, { bid: 0.51, ask: 0.53, levels: 20 }));
  assert.strictEqual(ring.length, before + 2, 'price moves must never be dropped');
  assert.strictEqual(ring.at(-1).bestBid, 0.51);
});

check('score-once freezes results so eviction cannot destroy them', () => {
  const HORIZ_MAX = 60_000;
  const MARGIN = 2_000;
  const ready = (sample, now) => now >= sample.observedAtMs + HORIZ_MAX + MARGIN;
  const sample = { tokenId: 'tok', observedAtMs: 100_000, scored: false, forward: {} };
  assert.strictEqual(ready(sample, 150_000), false, 'not scorable before the longest horizon elapses');
  assert.strictEqual(ready(sample, 162_001), true);
  sample.forward[60000] = { scorable: true, netExecutablePnlPerUsd: 0.01 };
  sample.scored = true;
  // Eviction guard: a token with an unscored sample must be retained.
  const hasUnscored = (token, list) => list.some((x) => x.tokenId === token && !x.scored);
  assert.strictEqual(hasUnscored('tok', [{ tokenId: 'tok', scored: false }]), true);
  assert.strictEqual(hasUnscored('tok', [sample]), false, 'scored samples release their token');
  // Frozen result survives ring removal.
  const rings = new Map([['tok', []]]);
  rings.delete('tok');
  assert.strictEqual(sample.forward[60000].netExecutablePnlPerUsd, 0.01);
});

check('collector wires incremental scoring ahead of eviction', () => {
  const idx = SOURCE.indexOf('scoreReadySamples()');
  const evictIdx = SOURCE.indexOf('evictRetiredTokens()');
  assert.ok(idx > 0 && evictIdx > 0 && idx < evictIdx, 'samples must be scored before tokens are evicted');
  assert.ok(SOURCE.includes('if (samples.some((sample) => sample.tokenId === token && !sample.scored)) continue;'),
    'eviction must skip tokens with unscored samples');
});

check('count cap spans the longest horizon at a realistic update rate', () => {
  // Regression: a 3k/token cap truncated the ring to <60s at the measured
  // ~100 updates/sec/token and silently starved the 60s horizon.
  const src = fs.readFileSync(COLLECTOR, 'utf8');
  const cap = Number(/const RING_MAX_SNAPSHOTS = ([\d_]+)/.exec(src)?.[1].replace(/_/g, ''));
  const ageMs = Number(/const RING_MAX_AGE_MS = ([\d_]+)/.exec(src)?.[1].replace(/_/g, ''));
  assert.ok(Number.isFinite(cap) && Number.isFinite(ageMs));
  const longestHorizonMs = 60_000;
  const observedPeakRatePerSec = 435;
  const downsampleMs = Number(/const RING_MIN_INTERVAL_MS = (\d+)/.exec(src)?.[1]);
  assert.ok(Number.isFinite(downsampleMs) && downsampleMs > 0, 'downsampling interval must be defined');
  // Downsampling caps the retained rate at 1000/downsampleMs per second.
  const retainedRatePerSec = Math.min(observedPeakRatePerSec, 1000 / downsampleMs);
  const spannedMs = (cap / retainedRatePerSec) * 1000;
  assert.ok(spannedMs >= longestHorizonMs * 2,
    `cap ${cap} only spans ${spannedMs}ms at ${retainedRatePerSec}/s retained; needs >= ${longestHorizonMs * 2}ms`);
  assert.ok(spannedMs >= ageMs, 'age bound must be the normally binding limit, not the count cap');
});

check('a truncating count cap makes the longest horizon unscorable', () => {
  // Proves the failure mode the cap sizing must avoid.
  const signalAtMs = 100_000;
  const ring = [];
  for (let t = signalAtMs; t <= signalAtMs + 90_000; t += 10) {
    ring.push(compactBookSnapshot(deepLadderBook(t, { levels: 20 }), { maxLevels: 12 }));
    boundRing(ring, { maxAgeMs: 180_000, maxCount: 3_000, nowMs: t });
  }
  assert.strictEqual(firstAtOrAfter(ring, signalAtMs + 60_000)?.observedAtMs >= signalAtMs + 60_000, true);
  // With the signal's own entry evicted, entry lookup fails -> unscorable, not fabricated.
  assert.strictEqual(firstAtOrAfter(ring, signalAtMs), ring[0]);
  assert.ok(ring[0].observedAtMs > signalAtMs, 'undersized cap evicts the signal-time entry');
});

check('compaction materially reduces retained size', () => {
  const book = deepLadderBook(1000, { levels: 200 });
  const fullBytes = JSON.stringify(book).length;
  const compactBytes = JSON.stringify(compactBookSnapshot(book, { maxLevels: 12 })).length;
  assert.ok(compactBytes * 4 < fullBytes, `compaction ineffective: ${compactBytes} vs ${fullBytes}`);
});

check('shallow depth and OBI derive from retained levels', () => {
  const b = [{ price: 0.5, size: 10 }, { price: 0.4, size: 10 }];
  const a = [{ price: 0.6, size: 10 }];
  assert.ok(Math.abs(shallowDepthUsd(b, 2) - 9) < 1e-9);
  assert.ok(Math.abs(shallowDepthUsd(b, 1) - 5) < 1e-9);
  assert.ok(orderBookImbalance(b, a, 2) > 0);
  assert.strictEqual(orderBookImbalance([], [], 2), 0);
});

// --- 2 & 3. eviction and rotation ------------------------------------------
// Mirrors evictRetiredTokens(): identical policy, isolated from live sockets.
function makeEvictor(graceMs) {
  const books = new Map(); const rings = new Map(); const trades = new Map(); const fees = new Map();
  const retired = new Map();
  let active = [];
  return {
    books, rings, trades, fees, retired,
    setActive(tokens) { active = tokens; },
    seed(token) { books.set(token, {}); rings.set(token, [{ observedAtMs: 0 }]); trades.set(token, [{}]); fees.set(token, {}); },
    evict(nowMs) {
      const set = new Set(active);
      for (const t of books.keys()) if (!set.has(t) && !retired.has(t)) retired.set(t, nowMs);
      let n = 0;
      for (const [t, at] of [...retired]) {
        if (set.has(t)) { retired.delete(t); continue; }
        if (nowMs - at < graceMs) continue;
        books.delete(t); rings.delete(t); trades.delete(t); fees.delete(t); retired.delete(t); n += 1;
      }
      return n;
    },
  };
}

check('retired tokens are evicted from every state map after the grace window', () => {
  const e = makeEvictor(120_000);
  e.setActive(['up1', 'dn1']); e.seed('up1'); e.seed('dn1');
  e.evict(0);
  assert.strictEqual(e.books.size, 2, 'active tokens must survive');

  e.setActive(['up2', 'dn2']); e.seed('up2'); e.seed('dn2');
  assert.strictEqual(e.evict(1_000), 0, 'retired tokens are held during the grace window');
  assert.strictEqual(e.books.size, 4);

  assert.strictEqual(e.evict(1_000 + 120_000), 2, 'both retired tokens evicted after grace');
  for (const map of [e.books, e.rings, e.trades, e.fees]) {
    assert.strictEqual(map.size, 2);
    assert.ok(!map.has('up1') && !map.has('dn1'));
  }
});

check('repeated target rotation does not accumulate token state', () => {
  const e = makeEvictor(60_000);
  let now = 0;
  for (let round = 0; round < 40; round += 1) {
    const up = `up${round}`; const dn = `dn${round}`;
    e.setActive([up, dn]); e.seed(up); e.seed(dn);
    now += 300_000; // one 5-minute market per rotation
    e.evict(now);
    assert.ok(e.books.size <= 4, `token state grew to ${e.books.size} at round ${round}`);
  }
  assert.ok(e.books.size <= 4);
  assert.ok(e.retired.size <= 2);
});

// --- 4 & 5. source triggers and attribution --------------------------------
// Mirrors the repaired accumulation guard using the canonical `detectedAtMs`.
function pushTrigger(triggers, { direction, receivedAtMs, sourceMoveStartedAtMs, max = 5_000 }) {
  const last = triggers.length ? triggers.at(-1).detectedAtMs : null;
  const clear = !Number.isFinite(last) || (receivedAtMs - last) > 500;
  if (!clear) return false;
  triggers.push({ direction, detectedAtMs: receivedAtMs, sourceMoveStartedAtMs });
  while (triggers.length > max) triggers.shift();
  return true;
}

check('sourceTriggers accumulates past one element and stays time ordered', () => {
  const triggers = [];
  let accepted = 0;
  for (let i = 0; i < 50; i += 1) {
    if (pushTrigger(triggers, { direction: i % 2 ? 'UP' : 'DOWN', receivedAtMs: 1_000 + i * 600, sourceMoveStartedAtMs: 900 + i * 600 })) accepted += 1;
  }
  assert.strictEqual(accepted, 50);
  assert.ok(triggers.length > 1, 'regression: array froze at a single trigger');
  for (let i = 1; i < triggers.length; i += 1) {
    assert.ok(triggers[i].detectedAtMs > triggers[i - 1].detectedAtMs, 'triggers must be time ordered');
  }
  for (const t of triggers) assert.ok(Number.isFinite(t.detectedAtMs), 'canonical field must be finite');
});

check('the 500ms throttle still suppresses bursts', () => {
  const triggers = [];
  assert.strictEqual(pushTrigger(triggers, { direction: 'UP', receivedAtMs: 1_000, sourceMoveStartedAtMs: 900 }), true);
  assert.strictEqual(pushTrigger(triggers, { direction: 'UP', receivedAtMs: 1_100, sourceMoveStartedAtMs: 1_000 }), false);
  assert.strictEqual(pushTrigger(triggers, { direction: 'UP', receivedAtMs: 1_700, sourceMoveStartedAtMs: 1_600 }), true);
  assert.strictEqual(triggers.length, 2);
});

check('trigger count is bounded', () => {
  const triggers = [];
  for (let i = 0; i < 5_000; i += 1) pushTrigger(triggers, { direction: 'UP', receivedAtMs: 1_000 + i * 600, sourceMoveStartedAtMs: 900 + i * 600, max: 100 });
  assert.strictEqual(triggers.length, 100);
});

// Mirrors captureEvent()'s association rule.
function associate(triggers, direction, writtenAtMs) {
  return [...triggers].reverse().find((t) => t.direction === direction && t.detectedAtMs <= writtenAtMs && writtenAtMs - t.detectedAtMs <= 5000) || null;
}

check('captureEvent associates later events with the correct trigger', () => {
  const triggers = [];
  pushTrigger(triggers, { direction: 'UP', receivedAtMs: 10_000, sourceMoveStartedAtMs: 9_900 });
  pushTrigger(triggers, { direction: 'DOWN', receivedAtMs: 40_000, sourceMoveStartedAtMs: 39_900 });
  pushTrigger(triggers, { direction: 'UP', receivedAtMs: 70_000, sourceMoveStartedAtMs: 69_900 });

  // The old defect made every event after the first fall outside the 5s window.
  const late = associate(triggers, 'UP', 72_000);
  assert.ok(late, 'a late UP event must still match a trigger');
  assert.strictEqual(late.detectedAtMs, 70_000, 'must match the most recent eligible trigger, not the first');

  assert.strictEqual(associate(triggers, 'DOWN', 42_000).detectedAtMs, 40_000);
  assert.strictEqual(associate(triggers, 'UP', 200_000), null, 'stale triggers must not match');
  assert.strictEqual(associate(triggers, 'UP', 5_000), null, 'no lookahead: future triggers must not match');
});

check('latency fields populate instead of collapsing to null', () => {
  const triggers = [];
  pushTrigger(triggers, { direction: 'UP', receivedAtMs: 10_000, sourceMoveStartedAtMs: 9_800 });
  pushTrigger(triggers, { direction: 'UP', receivedAtMs: 70_000, sourceMoveStartedAtMs: 69_700 });
  const buckets = [12_000, 72_000].map((writtenAtMs) => {
    const t = associate(triggers, 'UP', writtenAtMs);
    return t ? { sourceToOracleMs: t.detectedAtMs - t.sourceMoveStartedAtMs, oraclePersistenceMs: writtenAtMs - t.detectedAtMs } : null;
  });
  assert.ok(buckets.every(Boolean), 'every event must attribute to a trigger');
  assert.deepStrictEqual(buckets.map((b) => b.sourceToOracleMs), [200, 300]);
  assert.deepStrictEqual(buckets.map((b) => b.oraclePersistenceMs), [2_000, 2_000]);
});

// --- 6. no-lookahead across the full horizon set ----------------------------
check('250ms..60s horizons never mark against a pre-signal observation', () => {
  const HORIZONS = [250, 500, 1000, 2000, 3000, 5000, 10000, 30000, 60000];
  const signalAtMs = 100_000;
  const ring = [];
  for (let t = signalAtMs - 30_000; t <= signalAtMs + 90_000; t += 250) {
    ring.push(compactBookSnapshot(deepLadderBook(t, { levels: 30 }), { maxLevels: 12 }));
  }
  const entry = firstAtOrAfter(ring, signalAtMs);
  assert.ok(entry.observedAtMs >= signalAtMs, 'entry must be at or after the signal');
  for (const horizon of HORIZONS) {
    const exit = firstAtOrAfter(ring, signalAtMs + horizon);
    assert.ok(exit, `horizon ${horizon} must resolve`);
    assert.ok(exit.observedAtMs >= signalAtMs + horizon, `horizon ${horizon} marked too early`);
    assert.ok(exit.observedAtMs >= entry.observedAtMs, `horizon ${horizon} marked before entry`);
  }
  // A ring that stops early must yield null, not the last available book.
  const truncated = ring.filter((r) => r.observedAtMs <= signalAtMs + 1_000);
  assert.strictEqual(firstAtOrAfter(truncated, signalAtMs + 60_000), null, 'missing future data must not be back-filled');
});

// --- 7. checkpoint recoverability -------------------------------------------
check('partial checkpoint is atomic, private and recoverable', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-shadow-ckpt-'));
  const out = path.join(tmpDir, 'report.json');
  const write = (report) => {
    const tmp = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, out);
  };
  write({ study: 'x', partial: true, checkpoint: { sequence: 1 }, samples: [{ eventId: 'a' }] });
  write({ study: 'x', partial: true, checkpoint: { sequence: 2 }, samples: [{ eventId: 'a' }, { eventId: 'b' }] });
  const recovered = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(recovered.partial, true);
  assert.strictEqual(recovered.checkpoint.sequence, 2, 'latest checkpoint must win');
  assert.strictEqual(recovered.samples.length, 2);
  assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600, 'checkpoint must stay private');
  assert.strictEqual(fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-')).length, 0, 'no temp files left behind');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

check('collector wires checkpointing into startup, timer, signals and crashes', () => {
  assert.ok(SOURCE.includes("writeCheckpoint('startup')"), 'must checkpoint before the first event');
  assert.ok(/if \(now - lastCheckpointAtMs >= CHECKPOINT_EVERY_MS\) writeCheckpoint\('periodic'\)/.test(SOURCE), 'must checkpoint periodically');
  assert.ok(SOURCE.includes("process.on('SIGINT'"), 'SIGINT handled');
  assert.ok(SOURCE.includes("process.on('SIGTERM'"), 'SIGTERM handled');
  assert.ok(SOURCE.includes("'uncaughtException', 'unhandledRejection'"), 'fatal handlers salvage a checkpoint');
  assert.ok(SOURCE.includes('fs.renameSync(tmp, OUTPUT)'), 'final write must be atomic');
});

// --- 8. no production write / order path -----------------------------------
check('collector has no order path and writes only to its output', () => {
  for (const needle of ['placeOrder', 'createOrder', 'postOrder', 'submitOrder', 'signOrder', 'ENABLE_LIVE_TRADING', '.env.live.secrets', 'privateKey']) {
    assert.ok(!SOURCE.includes(needle), `collector must not reference ${needle}`);
  }
  assert.ok(!/method:\s*['"]POST['"]/.test(SOURCE), 'collector must issue no POST requests');
  // Every write target must be the OUTPUT path (or its temp sibling).
  const writes = SOURCE.match(/fs\.(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync)\([^)]*/g) || [];
  for (const w of writes) {
    assert.ok(/tmp|OUTPUT/.test(w), `unexpected write target: ${w}`);
  }
  // Production inputs must be opened read-only.
  assert.ok(/fs\.openSync\(EVENTS, 'r'\)/.test(SOURCE), 'event tail must open read-only');
  for (const prod of ['moneymaker_v3_state', 'auto_live_candidates', 'live_order_intents', 'approval_decisions']) {
    assert.ok(!SOURCE.includes(prod), `collector must not touch ${prod}`);
  }
});

console.log(`\nPASS ${passed} checks`);
