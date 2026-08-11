#!/usr/bin/env node
'use strict';

/**
 * BTC oracle `poly_lag_not_confirmed` gate research (OFFLINE, READ-ONLY).
 *
 * Question: are `poly_lag_not_confirmed` rejections protecting capital, or are
 * they blocking executable alpha?
 *
 * This script NEVER places orders, never writes to production files, never
 * reads secrets, and never imports production trading logic. It reads
 * `external_signal_events.ndjson` and (optionally, with --resolve) performs
 * public unauthenticated Gamma GETs to recover terminal market resolution.
 *
 * STRICT NO-LOOKAHEAD CONTRACT
 * ----------------------------
 * Each recorded signal contains exactly two order-book observations:
 *   T0 = book_at_trigger          (BTC impulse detected)
 *   T1 = book_after_persistence   (persistence window elapsed; signal emitted)
 *
 * There are NO post-T1 book observations in this dataset. Therefore:
 *   - Entry at T0 ask, mark at T1 bid  -> arithmetically reconstructable, but
 *     SELECTION-BIASED and therefore NOT an executable expectancy. The bridge
 *     only writes a record once the BTC impulse has already survived its
 *     persistence window (see btc_poly_oracle_v5_sniper_bridge_FIXED.js: a
 *     failed persistence check emits `persistence_not_met` and no record).
 *     Impulses that triggered at T0 and then died are absent from this file.
 *     Selecting them at T0 requires information from after T0. The figure is
 *     reported ONLY as a bias-flagged upper bound, never as tradable edge.
 *   - Entry at T1 ask (the decision point the gate actually rejects), marked
 *     at any horizon 250ms..60s -> NOT RECONSTRUCTABLE. Reported as such.
 *     No value is imputed, interpolated, or modelled.
 *   - MAE/MFE along a path -> NOT RECONSTRUCTABLE (two points, no path).
 *
 * All economics are executable: BUY lifts the ASK, MARK/EXIT hits the BID.
 * Midpoint-to-midpoint economics are computed only as a labelled diagnostic
 * and are never used as evidence of profitability.
 *
 * Usage:
 *   node scripts/btc_lag_gate_markout_research.js
 *   node scripts/btc_lag_gate_markout_research.js --resolve
 *   node scripts/btc_lag_gate_markout_research.js --json=/tmp/out.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EVENTS = path.join(ROOT, 'external_signal_events.ndjson');
const GAMMA = 'https://gamma-api.polymarket.com';

// Notional used for every executable reconstruction.
const NOTIONAL_USD = 1;
// Polymarket CLOB conventional minimum order size in shares. The event records
// do not carry per-market min_order_size, so this is an explicit assumption and
// is reported separately rather than folded into the headline numbers.
const ASSUMED_MIN_SHARES = 5;

const HORIZONS_MS = [250, 500, 1000, 2000, 3000, 5000, 10000, 15000, 30000, 60000];

function arg(name, fallback = null) {
  const hit = process.argv.find((v) => v === `--${name}` || v.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readSignals(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const out = [];
  let unparseable = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      unparseable += 1;
      continue;
    }
    if (obj && obj.type === 'BTC_TEMPORAL_LAG_OBI_V5') out.push(obj);
  }
  return { signals: out, unparseable };
}

/**
 * Executable single-leg reconstruction: buy `notional` at the entry book's ASK,
 * mark at the exit book's BID. Returns null when either side is not executable.
 */
function executableMarkout(entryBook, exitBook, notionalUsd = NOTIONAL_USD) {
  if (!entryBook || !exitBook) return null;
  if (entryBook.valid !== true || exitBook.valid !== true) return null;

  const ask = num(entryBook.best_ask);
  const bid = num(exitBook.best_bid);
  if (ask === null || bid === null) return null;
  if (!(ask > 0 && ask < 1) || !(bid > 0 && bid < 1)) return null;

  const askDepthUsd = num(entryBook.ask_depth_usd) ?? 0;
  const bidDepthUsd = num(exitBook.bid_depth_usd) ?? 0;

  const shares = notionalUsd / ask;
  const proceedsUsd = shares * bid;
  const pnlUsd = proceedsUsd - notionalUsd;

  return {
    entryPrice: ask,
    exitPrice: bid,
    shares,
    pnlPerDollar: pnlUsd / notionalUsd,
    // Executable feasibility at the stated notional, top-of-book depth basis.
    entryDepthOk: askDepthUsd >= notionalUsd,
    exitDepthOk: bidDepthUsd >= notionalUsd,
    minSharesOk: shares >= ASSUMED_MIN_SHARES,
    askDepthUsd,
    bidDepthUsd,
    entrySpread: num(entryBook.spread),
    exitSpread: num(exitBook.spread),
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function describe(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) {
    return { n: 0, mean: null, median: null, p25: null, p75: null, min: null, max: null, sum: null, winRate: null };
  }
  const sorted = finite.slice().sort((a, b) => a - b);
  const sum = finite.reduce((a, b) => a + b, 0);
  const wins = finite.filter((v) => v > 0).length;
  return {
    n: finite.length,
    mean: sum / finite.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    sum,
    winRate: wins / finite.length,
  };
}

function bucketLatency(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  if (ageMs <= 100) return 'a_0_100ms';
  if (ageMs <= 250) return 'b_100_250ms';
  if (ageMs <= 500) return 'c_250_500ms';
  return 'd_over_500ms';
}

function bucketTimeToExpiry(msLeft) {
  if (!Number.isFinite(msLeft)) return 'unknown';
  if (msLeft <= 30_000) return 'a_under_30s';
  if (msLeft <= 60_000) return 'b_30_60s';
  if (msLeft <= 120_000) return 'c_60_120s';
  if (msLeft <= 240_000) return 'd_120_240s';
  return 'e_over_240s';
}

function groupStats(rows, keyFn, valueFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(valueFn(row));
  }
  const out = {};
  for (const [key, values] of [...groups.entries()].sort()) out[key] = describe(values);
  return out;
}

async function fetchResolution(slug, cache) {
  if (cache.has(slug)) return cache.get(slug);
  let result = { slug, resolved: false, reason: 'not_fetched' };
  try {
    const res = await fetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      result = { slug, resolved: false, reason: `http_${res.status}` };
    } else {
      const body = await res.json();
      const market = Array.isArray(body) ? body[0] : body;
      if (!market) {
        cache.set(slug, { slug, resolved: false, reason: 'market_not_found' });
        return cache.get(slug);
      }
      const closed = market?.closed === true;
      let prices = market?.outcomePrices;
      if (typeof prices === 'string') {
        try { prices = JSON.parse(prices); } catch { prices = null; }
      }
      let tokenIds = market?.clobTokenIds;
      if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
      }
      if (!closed || !Array.isArray(prices) || !Array.isArray(tokenIds)) {
        result = { slug, resolved: false, reason: closed ? 'payout_vector_unavailable' : 'not_closed' };
      } else {
        const payouts = prices.map((p) => Number(p));
        const exact = payouts.length === 2 && payouts.filter((p) => p === 1).length === 1 &&
          payouts.every((p) => p === 0 || p === 1);
        result = exact
          ? { slug, resolved: true, tokenIds: tokenIds.map(String), payouts }
          : { slug, resolved: false, reason: 'payout_vector_not_binary_exact' };
      }
    }
  } catch (e) {
    result = { slug, resolved: false, reason: `fetch_error:${e.message}` };
  }
  cache.set(slug, result);
  return result;
}

async function main() {
  const eventsPath = String(arg('events', DEFAULT_EVENTS));
  const wantResolve = Boolean(arg('resolve', false));
  const jsonOut = arg('json', null);

  if (!fs.existsSync(eventsPath)) {
    console.error(`events file not found: ${eventsPath}`);
    process.exitCode = 1;
    return;
  }

  const { signals, unparseable } = readSignals(eventsPath);

  // ---- Eligible set: rejected specifically on the poly-lag test. -----------
  const eligible = signals.filter((s) => s.poly_lag_confirmed === false);
  const lagConfirmed = signals.filter((s) => s.poly_lag_confirmed === true);

  // The counterfactual comparator: signals the gate actually let through.
  const fullyConfirmed = signals.filter(
    (s) => s.poly_lag_confirmed === true && s.lag_score_pass === true && s.obi_confirmed === true
  );
  const confirmedPnl = [];
  for (const s of fullyConfirmed) {
    const mk = executableMarkout(s.book_at_trigger, s.book_after_persistence, NOTIONAL_USD);
    if (mk) confirmedPnl.push(mk.pnlPerDollar);
  }

  const rows = [];
  const infeasible = { entry_book_invalid: 0, exit_book_invalid: 0, no_price: 0, entry_depth: 0, exit_depth: 0 };

  for (const s of eligible) {
    const t0 = s.book_at_trigger;
    const t1 = s.book_after_persistence;
    const mk = executableMarkout(t0, t1, NOTIONAL_USD);
    if (!mk) {
      if (t0?.valid !== true) infeasible.entry_book_invalid += 1;
      else if (t1?.valid !== true) infeasible.exit_book_invalid += 1;
      else infeasible.no_price += 1;
      continue;
    }
    if (!mk.entryDepthOk) infeasible.entry_depth += 1;
    if (!mk.exitDepthOk) infeasible.exit_depth += 1;

    const emittedMs = Date.parse(s.timestamp);
    const startSec = num(s.market_start_ts_sec);
    const msToExpiry = startSec !== null && Number.isFinite(emittedMs)
      ? ((startSec + 300) * 1000) - emittedMs
      : null;

    // Diagnostic only. Explicitly NOT used as profitability evidence.
    const midEntry = num(t0.midpoint);
    const midExit = num(t1.midpoint);
    const midToMid = midEntry && midExit ? (midExit - midEntry) / midEntry : null;

    // Cost to cross at the DECISION point (T1): the spread you must pay if you
    // enter when the gate fires. Executable, no lookahead, no future book used.
    const t1Ask = num(t1.best_ask);
    const t1Bid = num(t1.best_bid);
    const decisionRoundTripCost = t1Ask && t1Bid && t1Ask > 0 ? (t1Ask - t1Bid) / t1Ask : null;

    rows.push({
      timestamp: s.timestamp,
      slug: s.market_slug || null,
      tokenId: s.token_id || null,
      direction: s.direction || null,
      pnlPerDollar: mk.pnlPerDollar,
      entryPrice: mk.entryPrice,
      exitPrice: mk.exitPrice,
      shares: mk.shares,
      feasible: mk.entryDepthOk && mk.exitDepthOk,
      minSharesOk: mk.minSharesOk,
      entrySpread: mk.entrySpread,
      exitSpread: mk.exitSpread,
      askDepthUsd: mk.askDepthUsd,
      bidDepthUsd: mk.bidDepthUsd,
      entryAgeMs: num(t0.age_ms),
      exitAgeMs: num(t1.age_ms),
      obi: num(t1.obi),
      obiConfirmed: s.obi_confirmed === true,
      lagScore: num(s.lag_score),
      lagScorePass: s.lag_score_pass === true,
      btcPersistedMovePct: num(s.btc_persisted_move_pct),
      polyMidMovePct: num(s.poly_mid_move_pct),
      polyMoveWeightLimitPct: num(s.poly_move_weight_limit_pct),
      midToMidDiagnostic: midToMid,
      decisionRoundTripCost,
      msToExpiry,
      emittedMs,
    });
  }

  const feasibleRows = rows.filter((r) => r.feasible);
  const strictRows = feasibleRows.filter((r) => r.minSharesOk);

  // ---- Optional terminal resolution for the slug-bearing subsample. --------
  let resolution = { attempted: 0, resolved: 0, unresolved: 0, reasons: {}, stats: null, note: null };
  if (wantResolve) {
    const cache = new Map();
    const withSlug = rows.filter((r) => r.slug && r.tokenId);
    const uniqueSlugs = [...new Set(withSlug.map((r) => r.slug))];
    resolution.attempted = withSlug.length;
    for (const slug of uniqueSlugs) {
      // Sequential, unauthenticated, read-only. Deliberately unhurried.
      // eslint-disable-next-line no-await-in-loop
      await fetchResolution(slug, cache);
    }
    const terminalPnl = [];
    for (const r of withSlug) {
      const info = cache.get(r.slug);
      if (!info || info.resolved !== true) {
        const reason = info?.reason || 'unknown';
        resolution.reasons[reason] = (resolution.reasons[reason] || 0) + 1;
        resolution.unresolved += 1;
        continue;
      }
      const idx = info.tokenIds.indexOf(String(r.tokenId));
      if (idx < 0) {
        resolution.reasons.token_not_in_market = (resolution.reasons.token_not_in_market || 0) + 1;
        resolution.unresolved += 1;
        continue;
      }
      const payout = info.payouts[idx];
      // Buy at T0 executable ASK, hold to resolution, receive payout per share.
      terminalPnl.push(((r.shares * payout) - NOTIONAL_USD) / NOTIONAL_USD);
      resolution.resolved += 1;
    }
    resolution.stats = describe(terminalPnl);
    resolution.note =
      'Terminal outcome assumes entry at the T0 executable ASK and holding to resolution. ' +
      'It does not prove any intermediate horizon is tradable.';
  }

  const report = {
    generatedAt: new Date().toISOString(),
    eventsFile: eventsPath,
    notionalUsd: NOTIONAL_USD,
    assumedMinShares: ASSUMED_MIN_SHARES,

    dataset: {
      v5SignalsParsed: signals.length,
      unparseableLines: unparseable,
      windowStart: signals.length ? signals.reduce((a, s) => (s.timestamp < a ? s.timestamp : a), signals[0].timestamp) : null,
      windowEnd: signals.length ? signals.reduce((a, s) => (s.timestamp > a ? s.timestamp : a), signals[0].timestamp) : null,
    },

    eligibility: {
      polyLagNotConfirmed: eligible.length,
      polyLagConfirmed: lagConfirmed.length,
      polyLagConfirmedRate: signals.length ? lagConfirmed.length / signals.length : null,
    },

    reconstructability: {
      bookObservationsPerSignal: 2,
      reconstructableHorizons: ['trigger_to_post_persistence'],
      notReconstructableHorizonsMs: HORIZONS_MS,
      notReconstructableReason:
        'The dataset contains no order-book observation after book_after_persistence. ' +
        'Markouts measured from the rejection/decision timestamp at 250ms..60s cannot be ' +
        'reconstructed without lookahead-free forward book capture. No values are imputed.',
      maeMfeReconstructable: false,
      maeMfeReason: 'Two book observations per signal provide no intra-horizon path.',
      feeDataAuthoritative: false,
      feeReason: 'The event records carry no fee rate or fee exponent. All figures are gross of fees.',
    },

    executability: {
      eligibleWithBothBooks: rows.length,
      feasibleAtNotional: feasibleRows.length,
      feasibleAndMinShares: strictRows.length,
      infeasibleBreakdown: infeasible,
    },

    selectionBias: {
      triggerToPostPersistenceIsBiased: true,
      mechanism:
        'The bridge writes a signal record only after the BTC impulse survives its persistence ' +
        'window. Impulses that triggered and then failed persistence emit `persistence_not_met` ' +
        'and are never recorded. Conditioning on survival to T1 is information from after T0, so ' +
        'a T0 entry cannot be taken in real time on this population.',
      consequence:
        'Any positive T0->T1 markout is an upper bound contaminated by survivorship, not an ' +
        'executable expectancy. It must not be used to justify relaxing the gate.',
      unrecordedPopulationMeasurable: false,
      unrecordedPopulationNote:
        '`persistence_not_met` is logged on a re-check loop rather than once per impulse, so the ' +
        'exact selection ratio cannot be derived from the operator log.',
    },

    // Gate counterfactual: what actually got through.
    fullyConfirmedCohort: {
      description:
        'Signals passing all three gates (poly_lag + lag_score + obi). Same T0->T1 executable ' +
        'basis, and subject to the same survivorship caveat.',
      count: fullyConfirmed.length,
      rateOfAllSignals: signals.length ? fullyConfirmed.length / signals.length : null,
      stats: describe(confirmedPnl),
    },

    // Arithmetically reconstructable, but see selectionBias above.
    triggerToPostPersistence: {
      description: 'BUY at T0 executable ASK, MARK at T1 executable BID. Gross of fees. SELECTION-BIASED.',
      biased: true,
      allWithBooks: describe(rows.map((r) => r.pnlPerDollar)),
      depthFeasible: describe(feasibleRows.map((r) => r.pnlPerDollar)),
      depthFeasibleAndMinShares: describe(strictRows.map((r) => r.pnlPerDollar)),
      byLatencyBucket: groupStats(feasibleRows, (r) => bucketLatency(r.entryAgeMs), (r) => r.pnlPerDollar),
      byTimeToExpiry: groupStats(
        feasibleRows.filter((r) => Number.isFinite(r.msToExpiry)),
        (r) => bucketTimeToExpiry(r.msToExpiry),
        (r) => r.pnlPerDollar
      ),
      byObiConfirmed: groupStats(feasibleRows, (r) => (r.obiConfirmed ? 'obi_confirmed' : 'obi_not_confirmed'), (r) => r.pnlPerDollar),
      byLagScorePass: groupStats(feasibleRows, (r) => (r.lagScorePass ? 'lag_score_pass' : 'lag_score_fail'), (r) => r.pnlPerDollar),
    },

    decisionPointEntry: {
      description:
        'Entry at T1 (the point the gate actually rejects). Requires a post-T1 book to mark. ' +
        'NOT RECONSTRUCTABLE from this dataset.',
      reconstructable: false,
      roundTripCostAtDecision: describe(rows.map((r) => r.decisionRoundTripCost)),
      roundTripCostNote:
        'Executable cost of crossing the spread at the decision point, (ask-bid)/ask. ' +
        'A trade entered here must overcome at least this before any profit.',
    },

    repriceEvidence: {
      polyMidMovePct: describe(rows.map((r) => r.polyMidMovePct)),
      btcPersistedMovePct: describe(rows.map((r) => r.btcPersistedMovePct)),
      polyMoveWeightLimitPct: describe(rows.map((r) => r.polyMoveWeightLimitPct)),
      lagScore: describe(rows.map((r) => r.lagScore)),
      midToMidDiagnosticOnly: describe(rows.map((r) => r.midToMidDiagnostic)),
      midToMidWarning: 'Diagnostic only. Never used as profitability evidence.',
    },

    resolution,
  };

  if (jsonOut && typeof jsonOut === 'string') {
    fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(3)}%` : 'n/a');
  const money = (v) => (Number.isFinite(v) ? `$${v.toFixed(4)}` : 'n/a');

  const L = [];
  L.push('=== BTC poly_lag_not_confirmed gate research (offline, read-only) ===');
  L.push(`events=${report.dataset.v5SignalsParsed} window=${report.dataset.windowStart} -> ${report.dataset.windowEnd}`);
  L.push(`eligible(poly_lag_not_confirmed)=${report.eligibility.polyLagNotConfirmed} confirmed=${report.eligibility.polyLagConfirmed} confirmRate=${pct(report.eligibility.polyLagConfirmedRate)}`);
  L.push(`withBothBooks=${report.executability.eligibleWithBothBooks} depthFeasible=${report.executability.feasibleAtNotional} +minShares=${report.executability.feasibleAndMinShares}`);
  L.push('');
  L.push('!! SELECTION BIAS: records exist only for impulses that survived the persistence');
  L.push('!! window. A T0 entry cannot select this population in real time. The numbers below');
  L.push('!! are a survivorship-contaminated UPPER BOUND, not executable expectancy.');
  L.push('');
  L.push('-- BIASED UPPER BOUND: BUY T0 ask -> MARK T1 bid (gross of fees) --');
  for (const [label, st] of Object.entries({
    allWithBooks: report.triggerToPostPersistence.allWithBooks,
    depthFeasible: report.triggerToPostPersistence.depthFeasible,
    depthFeasibleAndMinShares: report.triggerToPostPersistence.depthFeasibleAndMinShares,
  })) {
    L.push(`  ${label.padEnd(26)} n=${String(st.n).padStart(5)} mean=${money(st.mean)} median=${money(st.median)} cum=${money(st.sum)} win=${pct(st.winRate)}`);
  }
  L.push('');
  L.push('-- by latency bucket (depth-feasible) --');
  for (const [k, st] of Object.entries(report.triggerToPostPersistence.byLatencyBucket)) {
    L.push(`  ${k.padEnd(16)} n=${String(st.n).padStart(5)} mean=${money(st.mean)} median=${money(st.median)} win=${pct(st.winRate)}`);
  }
  L.push('-- by time-to-expiry (depth-feasible, slug subsample) --');
  for (const [k, st] of Object.entries(report.triggerToPostPersistence.byTimeToExpiry)) {
    L.push(`  ${k.padEnd(16)} n=${String(st.n).padStart(5)} mean=${money(st.mean)} median=${money(st.median)} win=${pct(st.winRate)}`);
  }
  L.push('-- by OBI / lagScore --');
  for (const [k, st] of Object.entries({ ...report.triggerToPostPersistence.byObiConfirmed, ...report.triggerToPostPersistence.byLagScorePass })) {
    L.push(`  ${k.padEnd(20)} n=${String(st.n).padStart(5)} mean=${money(st.mean)} median=${money(st.median)} win=${pct(st.winRate)}`);
  }
  L.push('');
  const fc = report.fullyConfirmedCohort;
  L.push(`-- GATE COUNTERFACTUAL: fully-confirmed signals (all 3 gates) n=${fc.count} rate=${pct(fc.rateOfAllSignals)} --`);
  L.push(`  mean=${money(fc.stats.mean)} median=${money(fc.stats.median)} cum=${money(fc.stats.sum)} win=${pct(fc.stats.winRate)}`);
  L.push('');
  L.push('-- NOT RECONSTRUCTABLE --');
  L.push(`  horizons ${HORIZONS_MS.join('/')} ms from decision point: no post-T1 book exists.`);
  L.push('  MAE/MFE: no intra-horizon path exists.');
  L.push('  fees: no authoritative fee data in the event records.');
  L.push(`  round-trip cost to cross at decision point: mean=${pct(report.decisionPointEntry.roundTripCostAtDecision.mean)} median=${pct(report.decisionPointEntry.roundTripCostAtDecision.median)}`);
  L.push('');
  L.push('-- reprice evidence --');
  const re = report.repriceEvidence;
  L.push(`  polyMidMovePct   mean=${pct(re.polyMidMovePct.mean)} median=${pct(re.polyMidMovePct.median)}`);
  L.push(`  btcPersistedMove mean=${pct(re.btcPersistedMovePct.mean)} median=${pct(re.btcPersistedMovePct.median)}`);
  L.push(`  lagScore         mean=${re.lagScore.mean === null ? 'n/a' : re.lagScore.mean.toExponential(3)} max=${re.lagScore.max === null ? 'n/a' : re.lagScore.max.toExponential(3)}`);
  if (wantResolve) {
    L.push('');
    L.push(`-- terminal resolution -- resolved=${resolution.resolved} unresolved=${resolution.unresolved}`);
    if (resolution.stats) {
      L.push(`  hold-to-resolution from T0 ask: n=${resolution.stats.n} mean=${money(resolution.stats.mean)} median=${money(resolution.stats.median)} cum=${money(resolution.stats.sum)} win=${pct(resolution.stats.winRate)}`);
    }
    L.push(`  unresolved reasons: ${JSON.stringify(resolution.reasons)}`);
  }

  console.log(L.join('\n'));
  if (jsonOut && typeof jsonOut === 'string') console.log(`\njson written: ${jsonOut}`);
}

module.exports = { executableMarkout, describe, bucketLatency, bucketTimeToExpiry, readSignals, ASSUMED_MIN_SHARES, NOTIONAL_USD };

if (require.main === module) {
  main().catch((e) => {
    console.error(`research failed: ${e.stack || e.message}`);
    process.exitCode = 1;
  });
}
