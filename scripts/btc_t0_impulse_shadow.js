#!/usr/bin/env node
'use strict';

/**
 * BTC raw-impulse (T0) forward SHADOW collector. READ-ONLY RESEARCH.
 *
 * Question: does positive executable expectancy exist at the raw BTC impulse T0,
 * before the existing oracle's persistence/confirmation decision point, and does
 * it decay with latency?
 *
 * The decision-point experiment already answered the later question: at the
 * oracle decision point, poly_lag_not_confirmed rejections protect capital. That
 * gate is NOT touched by this script. Nothing here reads or writes production
 * trading state, thresholds, Sophie, Risk, .env, PM2 or live settings, and no
 * order of any kind is ever created.
 *
 * INDEPENDENCE FROM THE ORACLE
 * ----------------------------
 * Triggers are generated directly from the Binance trade stream. This script does
 * NOT let external_signal_events.ndjson decide what becomes a sample. That file is
 * tailed only to ANNOTATE an episode with what the existing oracle later did.
 * Impulses the oracle never emitted are first-class samples recorded as
 * `never_emitted` -- which is what removes the survivorship conditioning present in
 * every prior measurement.
 *
 * STRICT ECONOMICS
 * ----------------
 * Entry lifts the ASK, exit hits the BID, depth-walked against displayed levels
 * only, fee-adjusted with official CLOB metadata. Unknown fees make a sample
 * unscorable; they are never assumed to be zero. Midpoint economics are recorded
 * as a labelled diagnostic and never feed a reported expectancy field. Missing
 * future books yield null; nothing is imputed, interpolated or back-filled.
 *
 * Usage:
 *   node scripts/btc_t0_impulse_shadow.js --duration-ms=720000 --output=/tmp/t0.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const {
  applyMarketMessage, normalizeBook, partitionPriceChanges, markout,
  firstAtOrAfter, lastAtOrBefore, stats, compactBookSnapshot, boundRing,
} = require('../lib/btc_latency_shadow');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'btc_oracle_market_target.json');
const EVENTS = path.join(ROOT, 'external_signal_events.ndjson');
const OUTPUT = path.resolve(process.argv.find((v) => v.startsWith('--output='))?.slice(9) || `/tmp/btc_t0_impulse_shadow_${Date.now()}.json`);
const MAX_MS = Math.min(3_600_000, Math.max(10_000, Number(process.argv.find((v) => v.startsWith('--duration-ms='))?.slice(14)) || 3_600_000));
const CHECKPOINT_EVERY_MS = Math.max(15_000, Number(process.argv.find((v) => v.startsWith('--checkpoint-ms='))?.slice(16)) || 30_000);
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade';
const CLOB = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// PRE-REGISTRATION. Fixed before any data is collected; embedded in every report.
// ---------------------------------------------------------------------------
const PREREGISTRATION = {
  primaryQuestion: 'Does arm_1.0bp show positive executable ASK->future BID expectancy at raw BTC T0 that decays with latency?',
  arms: [
    { name: 'arm_0.5bp', thresholdPct: 0.00005, role: 'exploratory: power and response-curve shape' },
    { name: 'arm_1.0bp', thresholdPct: 0.00010, role: 'PRIMARY: matches BTC_ORACLE_THRESHOLD, the only arm that classifies A/B/C' },
    { name: 'arm_2.0bp', thresholdPct: 0.00020, role: 'strong-impulse: do larger moves behave differently' },
  ],
  primaryArm: 'arm_1.0bp',
  armsPooled: false,
  armsNested: 'A 2bp move fires all three arms at the same T0 (subject to per-arm throttle). Cross-arm comparison describes one process at three selectivities, NOT three independent experiments.',
  postHocArmSelectionProhibited: 'No arm may be chosen after seeing results and called the strategy. Any production threshold decision requires a separate pre-registered validation run.',
  t0Definition: 'Local receipt timestamp of the Binance trade that crosses an arm threshold.',
  lookbackMs: 1_000,
  perArmThrottleMs: 500,
  primaryEntry: 'firstAtOrAfter(ring, T0).bestAsk -- first confirmed book at or after T0. Never stale, cannot look ahead, concedes source->poly latency to the market.',
  secondaryEntry: 'lastAtOrBefore(ring, T0).bestAsk, gated to staleness <= 250ms. RECORDED, NEVER THE HEADLINE.',
  exit: 'firstAtOrAfter(ring, T0 + h).bestBid, depth-walked against displayed levels, fee-adjusted.',
  horizonsMs: [0, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000],
  horizonZeroMeaning: 'h=0 is the instantaneous round-trip crossing cost (bid-ask)/ask. Reported as a cost baseline, never as a return.',
  predictedSide: 'UP impulse -> buy UP token; DOWN impulse -> buy DOWN token.',
  interpretation: {
    A: 'T0 ALSO NEGATIVE: arm_1.0bp conservative expectancy <= 0 across short horizons -> reject the BTC directional latency hypothesis.',
    B: 'T0 POSITIVE, DECAYS WITH LATENCY: arm_1.0bp conservative expectancy > 0 at the shortest horizons and monotonically decaying -> real upstream latency edge; next work is architecture-speed redesign, NOT threshold loosening.',
    C: 'INCONCLUSIVE: underpowered, mixed, or positive only under the secondary entry.',
  },
  noMidpointProfitabilityClaims: true,
  targetUsd: 1,
};

const HORIZONS = PREREGISTRATION.horizonsMs;
const ARMS = PREREGISTRATION.arms;
const LOOKBACK_MS = PREREGISTRATION.lookbackMs;
const ARM_THROTTLE_MS = PREREGISTRATION.perArmThrottleMs;
const SECONDARY_MAX_STALENESS_MS = 250;
const TARGET_USD = PREREGISTRATION.targetUsd;

// --- Structural memory bounds. Longest horizon is 10s, so history is short. ---
const RING_MAX_AGE_MS = 60_000;
const RING_MIN_INTERVAL_MS = 25;
const RING_MAX_SNAPSHOTS = 6_000;
const RING_LADDER_LEVELS = 12;
const RING_MIN_REQUIRED_SPAN_MS = Math.max(...HORIZONS) + 20_000;
const BTC_TICK_MAX = 2_000;
const ARM_TRIGGER_MAX = 2_000;
const EPISODE_MAX = 5_000;
const ORACLE_ANNOTATION_WINDOW_MS = 10_000;
const SCORE_READY_MARGIN_MS = 2_000;
const RETIRED_TOKEN_GRACE_MS = Math.max(...HORIZONS) + 30_000;

const startedAtMs = Date.now();
const stopAtMs = startedAtMs + MAX_MS;
let eventOffset = fs.existsSync(EVENTS) ? fs.statSync(EVENTS).size : 0;
let eventRemainder = '';
let target = null;
let polySocket = null;
let binanceSocket = null;
const feeByToken = new Map();
const books = new Map();
const rings = new Map();
const retiredTokens = new Map();
const btcTicks = [];
const armState = new Map(ARMS.map((arm) => [arm.name, { lastDetectedAtMs: null, triggers: [] }]));
const episodes = [];
const wsCounts = { book: 0, price_change: 0, best_bid_ask: 0, last_trade_price: 0, other: 0 };
const oracleAnnotationsSeen = { matched: 0, unmatched: 0 };
let stopped = false;
let lastCheckpointAtMs = 0;
let checkpointCount = 0;
let lastCheckpointError = null;
let tokensEvicted = 0;
let lastMemorySampleAtMs = 0;
const memorySamples = [];
const MEMORY_SAMPLE_EVERY_MS = 30_000;
const MEMORY_SAMPLE_MAX = 500;

function safeJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function nowIso(ms = Date.now()) { return new Date(ms).toISOString(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function activeTokens() {
  const raw = target?.target;
  return raw ? [String(raw.BTC_UP_TOKEN_ID), String(raw.BTC_DOWN_TOKEN_ID)] : [];
}

function tokenForDirection(direction) {
  const raw = target?.target;
  if (!raw) return null;
  return String(direction === 'UP' ? raw.BTC_UP_TOKEN_ID : raw.BTC_DOWN_TOKEN_ID);
}

function marketExpiryMs() {
  const ts = num(target?.target?.ts);
  return ts === null ? null : (ts + 300) * 1000;
}

function appendRing(token, book) {
  if (!book?.bestBid || !book?.bestAsk) return;
  const ring = rings.get(token) || [];
  const last = ring.length ? ring.at(-1) : null;
  // Downsample depth-only churn; every top-of-book move is always retained.
  if (last) {
    const topUnchanged = last.bestBid === book.bestBid && last.bestAsk === book.bestAsk;
    if (topUnchanged && (book.observedAtMs - last.observedAtMs) < RING_MIN_INTERVAL_MS) return;
  }
  ring.push(compactBookSnapshot(book, { maxLevels: RING_LADDER_LEVELS }));
  boundRing(ring, { maxAgeMs: RING_MAX_AGE_MS, maxCount: RING_MAX_SNAPSHOTS, nowMs: Date.now() });
  rings.set(token, ring);
}

function evictRetiredTokens(nowMs = Date.now()) {
  const active = new Set(activeTokens());
  for (const token of books.keys()) {
    if (!active.has(token) && !retiredTokens.has(token)) retiredTokens.set(token, nowMs);
  }
  let evicted = 0;
  for (const [token, retiredAtMs] of [...retiredTokens]) {
    if (active.has(token)) { retiredTokens.delete(token); continue; }
    if (nowMs - retiredAtMs < RETIRED_TOKEN_GRACE_MS) continue;
    if (episodes.some((ep) => ep.tokenId === token && !ep.scored)) continue;
    books.delete(token); rings.delete(token); feeByToken.delete(token);
    retiredTokens.delete(token);
    evicted += 1;
  }
  return evicted;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshToken(token) {
  try {
    const rawBook = await getJson(`${CLOB}/book?token_id=${encodeURIComponent(token)}`);
    const book = normalizeBook(rawBook, Date.now());
    books.set(token, book); appendRing(token, book);
    const marketInfo = book.marketId ? await getJson(`${CLOB}/clob-markets/${encodeURIComponent(book.marketId)}`) : null;
    const rate = num(marketInfo?.fd?.r); const exponent = num(marketInfo?.fd?.e);
    feeByToken.set(token, rate !== null && exponent !== null
      ? { rate, exponent, takerOnly: marketInfo.fd.to !== false, source: 'official_clob_market_info' }
      : null);
  } catch {
    feeByToken.set(token, null);
  }
}

function refreshTarget() {
  const next = safeJson(TARGET);
  if (!next?.activeKey || next.activeKey === target?.activeKey) return;
  target = next;
  Promise.all(activeTokens().map(refreshToken)).finally(connectPoly);
}

function connectPoly() {
  const tokens = activeTokens();
  if (polySocket) { polySocket.removeAllListeners(); polySocket.close(); }
  if (tokens.length !== 2) return;
  polySocket = new WebSocket(CLOB_WS);
  polySocket.on('open', () => polySocket.send(JSON.stringify({ assets_ids: tokens, type: 'market', custom_feature_enabled: true })));
  polySocket.on('message', (data) => {
    const received = Date.now();
    let parsed; try { parsed = JSON.parse(String(data)); } catch { return; }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const kind = message.event_type || 'other';
      wsCounts[kind] = (wsCounts[kind] || 0) + 1;
      if (!['book', 'price_change', 'best_bid_ask'].includes(kind)) continue;
      let changesByToken = new Map();
      if (kind === 'price_change') {
        changesByToken = partitionPriceChanges(message);
      } else {
        const token = String(message.asset_id || '');
        if (token) changesByToken.set(token, null);
      }
      for (const [token, changes] of changesByToken) {
        const scoped = changes ? { ...message, price_changes: changes } : message;
        const next = applyMarketMessage(books.get(token), scoped, received);
        if (next) { books.set(token, next); appendRing(token, next); }
      }
    }
  });
  polySocket.on('close', () => { if (!stopped) setTimeout(connectPoly, 1000).unref(); });
  polySocket.on('error', () => {});
}

// ---------------------------------------------------------------------------
// Raw BTC impulse detection. Independent of external_signal_events.ndjson.
// ---------------------------------------------------------------------------
function openEpisode({ arm, direction, receivedAtMs, exchangeAtMs, initial, price, move, episodeId }) {
  const tokenId = tokenForDirection(direction);
  if (!tokenId) return null;
  const expiry = marketExpiryMs();
  const episode = {
    episodeId,
    arm,
    direction,
    tokenId,
    marketSlug: target?.target?.slug || null,
    t0AtMs: receivedAtMs,
    t0At: nowIso(receivedAtMs),
    sourceExchangeAtMs: exchangeAtMs,
    localReceiptAtMs: receivedAtMs,
    sourceToLocalReceiptMs: Number.isFinite(exchangeAtMs) ? receivedAtMs - exchangeAtMs : null,
    initialPrice: initial.price,
    triggerPrice: price,
    movePct: move,
    absMovePct: Math.abs(move),
    timeToExpiryMs: expiry === null ? null : expiry - receivedAtMs,
    // Decomposition chain. Populated as evidence arrives; never inferred.
    firstPolyResponseAtMs: null,
    sourceToFirstPolyResponseMs: null,
    persistenceCompletedAtMs: null,
    oracleDecisionAtMs: null,
    oracleOutcome: 'never_emitted',
    oracleConfirmed: null,
    oracleBlockers: null,
    oracleEventId: null,
    oracleLagScore: null,
    oracleBtcPersistedMovePct: null,
    // Scoring
    scored: false,
    scoredAtMs: null,
    primary: {},
    secondary: {},
    entryStalenessMs: null,
    feeEvidence: null,
    minOrderSizeShares: null,
    minOrderFeasible: null,
    spreadAtEntry: null,
    bidDepthUsdAtEntry: null,
    askDepthUsdAtEntry: null,
    obiAtEntry: null,
    midpointDiagnosticOnly: {},
  };
  episodes.push(episode);
  while (episodes.length > EPISODE_MAX) episodes.shift();
  return episode;
}

function connectBinance() {
  binanceSocket = new WebSocket(BINANCE_WS);
  binanceSocket.on('message', (data) => {
    const receivedAtMs = Date.now();
    let trade; try { trade = JSON.parse(String(data)); } catch { return; }
    const price = num(trade.p);
    const exchangeAtMs = num(trade.T ?? trade.E);
    if (price === null || !(price > 0)) return;

    btcTicks.push({ price, exchangeAtMs, receivedAtMs });
    while (btcTicks.length && btcTicks[0].receivedAtMs < receivedAtMs - LOOKBACK_MS * 10) btcTicks.shift();
    while (btcTicks.length > BTC_TICK_MAX) btcTicks.shift();

    const initial = btcTicks.find((tick) => tick.receivedAtMs >= receivedAtMs - LOOKBACK_MS) || btcTicks[0];
    if (!initial || !(initial.price > 0)) return;
    const move = (price - initial.price) / initial.price;
    const absMove = Math.abs(move);
    const direction = move > 0 ? 'UP' : 'DOWN';

    // One tick may open an episode in several arms. They share an episodeId so
    // nesting is visible, but each arm records its own trigger and episode row.
    const episodeId = crypto.randomUUID();
    for (const arm of ARMS) {
      if (absMove < arm.thresholdPct) continue;
      const state = armState.get(arm.name);
      const last = state.lastDetectedAtMs;
      const throttleClear = !Number.isFinite(last) || (receivedAtMs - last) > ARM_THROTTLE_MS;
      if (!throttleClear) continue;
      state.lastDetectedAtMs = receivedAtMs;
      state.triggers.push({ direction, detectedAtMs: receivedAtMs, sourceExchangeAtMs: exchangeAtMs, move, initialPrice: initial.price, triggerPrice: price, episodeId });
      while (state.triggers.length > ARM_TRIGGER_MAX) state.triggers.shift();
      openEpisode({ arm: arm.name, direction, receivedAtMs, exchangeAtMs, initial, price, move, episodeId });
    }
  });
  binanceSocket.on('close', () => { if (!stopped) setTimeout(connectBinance, 1000).unref(); });
  binanceSocket.on('error', () => {});
}

// ---------------------------------------------------------------------------
// Oracle ANNOTATION ONLY. Never creates, filters or gates an episode.
// ---------------------------------------------------------------------------
function annotateFromOracleEvent(event) {
  if (event?.type !== 'BTC_TEMPORAL_LAG_OBI_V5') return;
  const emittedAtMs = Date.parse(event.timestamp);
  if (!Number.isFinite(emittedAtMs)) return;
  let matched = false;
  for (const episode of episodes) {
    if (episode.oracleDecisionAtMs !== null) continue;
    if (episode.direction !== event.direction) continue;
    const age = emittedAtMs - episode.t0AtMs;
    if (age < 0 || age > ORACLE_ANNOTATION_WINDOW_MS) continue;
    episode.oracleDecisionAtMs = emittedAtMs;
    episode.oracleOutcome = event.confirmed === true ? 'confirmed' : 'rejected';
    episode.oracleConfirmed = event.confirmed === true;
    episode.oracleBlockers = Array.isArray(event.confirmation_blockers) ? event.confirmation_blockers.slice() : null;
    episode.oracleEventId = `${event.timestamp}:${String(event.token_id || '')}`;
    episode.oracleLagScore = num(event.lag_score);
    episode.oracleBtcPersistedMovePct = num(event.btc_persisted_move_pct);
    // The oracle emits once its persistence window has elapsed, so its emission
    // timestamp is the observable completion of that stage.
    episode.persistenceCompletedAtMs = emittedAtMs;
    matched = true;
  }
  if (matched) oracleAnnotationsSeen.matched += 1; else oracleAnnotationsSeen.unmatched += 1;
}

function tailEvents() {
  if (!fs.existsSync(EVENTS)) return;
  const size = fs.statSync(EVENTS).size;
  if (size < eventOffset) { eventOffset = 0; eventRemainder = ''; }
  if (size === eventOffset) return;
  const length = size - eventOffset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(EVENTS, 'r');
  fs.readSync(fd, buffer, 0, length, eventOffset);
  fs.closeSync(fd);
  eventOffset = size;
  const chunks = (eventRemainder + buffer.toString('utf8')).split('\n');
  eventRemainder = chunks.pop();
  for (const line of chunks) { try { annotateFromOracleEvent(JSON.parse(line)); } catch {} }
}

// ---------------------------------------------------------------------------
// Scoring: once, when horizons have elapsed, then frozen.
// ---------------------------------------------------------------------------
function crossingCost(book) {
  if (!book?.bestAsk || !book?.bestBid) return null;
  return (book.bestBid - book.bestAsk) / book.bestAsk;
}

function scoreEpisode(episode) {
  const ring = rings.get(episode.tokenId) || [];
  const fee = feeByToken.get(episode.tokenId) || null;
  episode.feeEvidence = fee;

  const primaryEntry = firstAtOrAfter(ring, episode.t0AtMs);
  const secondaryRaw = lastAtOrBefore(ring, episode.t0AtMs);
  const secondaryStaleness = secondaryRaw ? episode.t0AtMs - secondaryRaw.observedAtMs : null;
  const secondaryEntry = secondaryRaw && secondaryStaleness <= SECONDARY_MAX_STALENESS_MS ? secondaryRaw : null;

  episode.firstPolyResponseAtMs = primaryEntry ? primaryEntry.observedAtMs : null;
  episode.sourceToFirstPolyResponseMs = primaryEntry ? primaryEntry.observedAtMs - episode.t0AtMs : null;
  episode.entryStalenessMs = secondaryStaleness;

  if (primaryEntry) {
    episode.spreadAtEntry = primaryEntry.spread ?? null;
    episode.bidDepthUsdAtEntry = primaryEntry.bidDepthUsd ?? null;
    episode.askDepthUsdAtEntry = primaryEntry.askDepthUsd ?? null;
    episode.obiAtEntry = primaryEntry.obi ?? null;
    episode.minOrderSizeShares = primaryEntry.minOrderSizeShares ?? null;
    const shares = primaryEntry.bestAsk > 0 ? TARGET_USD / primaryEntry.bestAsk : null;
    episode.minOrderFeasible = Number.isFinite(episode.minOrderSizeShares) && shares !== null
      ? shares >= episode.minOrderSizeShares
      : null;
  }

  for (const horizon of HORIZONS) {
    // h=0 is the instantaneous round-trip crossing cost, not a return.
    const exit = horizon === 0 ? primaryEntry : firstAtOrAfter(ring, episode.t0AtMs + horizon);
    episode.primary[horizon] = primaryEntry && exit
      ? markout({ entryBook: primaryEntry, exitBook: exit, targetUsd: TARGET_USD, feeRate: fee?.rate, feeExponent: fee?.exponent })
      : { scorable: false, reason: primaryEntry ? 'missing_future_book' : 'missing_entry_book' };

    const secondaryExit = horizon === 0 ? secondaryEntry : firstAtOrAfter(ring, episode.t0AtMs + horizon);
    episode.secondary[horizon] = secondaryEntry && secondaryExit
      ? markout({ entryBook: secondaryEntry, exitBook: secondaryExit, targetUsd: TARGET_USD, feeRate: fee?.rate, feeExponent: fee?.exponent })
      : { scorable: false, reason: secondaryEntry ? 'missing_future_book' : 'no_fresh_pre_t0_book' };

    // Diagnostic only. Never used as a profitability field.
    const mid = primaryEntry && exit && Number.isFinite(primaryEntry.midpoint) && Number.isFinite(exit.midpoint)
      ? (exit.midpoint - primaryEntry.midpoint) / primaryEntry.midpoint
      : null;
    episode.midpointDiagnosticOnly[horizon] = mid;
  }
  episode.crossingCostAtEntry = crossingCost(primaryEntry);
}

function episodeReadyToScore(episode, nowMs = Date.now()) {
  return nowMs >= episode.t0AtMs + Math.max(...HORIZONS) + SCORE_READY_MARGIN_MS;
}

function scoreReadyEpisodes(nowMs = Date.now()) {
  let scored = 0;
  for (const episode of episodes) {
    if (episode.scored || !episodeReadyToScore(episode, nowMs)) continue;
    scoreEpisode(episode);
    episode.scored = true;
    episode.scoredAtMs = nowMs;
    episode.scoredIncomplete = false;
    scored += 1;
  }
  return scored;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function describe(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { n: 0, mean: null, median: null, cumulative: null, winRate: null, min: null, max: null };
  const sorted = finite.slice().sort((a, b) => a - b);
  const sum = finite.reduce((a, b) => a + b, 0);
  return {
    n: finite.length,
    mean: sum / finite.length,
    median: sorted[Math.floor(sorted.length / 2)],
    cumulative: sum,
    winRate: finite.filter((v) => v > 0).length / finite.length,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function horizonTable(rows, field) {
  const out = {};
  for (const horizon of HORIZONS) {
    const scorable = rows.map((r) => r[field][horizon]).filter((m) => m?.scorable);
    const unscorable = {};
    for (const r of rows) {
      const m = r[field][horizon];
      if (m && !m.scorable) unscorable[m.reason] = (unscorable[m.reason] || 0) + 1;
    }
    out[horizon] = {
      ...describe(scorable.map((m) => m.netExecutablePnlPerUsd)),
      grossMean: describe(scorable.map((m) => m.grossExecutablePnlPerUsd)).mean,
      unscorable,
    };
  }
  return out;
}

function armReport(armName) {
  const rows = episodes.filter((e) => e.arm === armName && e.scored);
  const all = episodes.filter((e) => e.arm === armName);
  const magnitudeBuckets = {};
  for (const r of rows) {
    const bp = r.absMovePct * 10_000;
    const key = bp < 1 ? 'a_under_1bp' : bp < 2 ? 'b_1_2bp' : bp < 5 ? 'c_2_5bp' : 'd_over_5bp';
    (magnitudeBuckets[key] ||= []).push(r.primary[1000]?.scorable ? r.primary[1000].netExecutablePnlPerUsd : null);
  }
  const magnitudeVsExpectancy = {};
  for (const [k, v] of Object.entries(magnitudeBuckets)) magnitudeVsExpectancy[k] = describe(v);

  return {
    arm: armName,
    role: ARMS.find((a) => a.name === armName)?.role,
    thresholdPct: ARMS.find((a) => a.name === armName)?.thresholdPct,
    isPrimary: armName === PREREGISTRATION.primaryArm,
    triggers: armState.get(armName)?.triggers.length ?? 0,
    episodes: all.length,
    scored: rows.length,
    pending: all.length - rows.length,
    primaryEntryHorizons: horizonTable(rows, 'primary'),
    secondaryEntryHorizons: horizonTable(rows, 'secondary'),
    latency: {
      sourceToLocalReceiptMs: stats(rows.map((r) => r.sourceToLocalReceiptMs)),
      sourceToFirstPolyResponseMs: stats(rows.map((r) => r.sourceToFirstPolyResponseMs)),
      t0ToOracleDecisionMs: stats(rows.filter((r) => r.oracleDecisionAtMs).map((r) => r.oracleDecisionAtMs - r.t0AtMs)),
    },
    market: {
      spreadAtEntry: stats(rows.map((r) => r.spreadAtEntry)),
      crossingCostAtEntry: stats(rows.map((r) => r.crossingCostAtEntry)),
      bidDepthUsdAtEntry: stats(rows.map((r) => r.bidDepthUsdAtEntry)),
      askDepthUsdAtEntry: stats(rows.map((r) => r.askDepthUsdAtEntry)),
      timeToExpiryMs: stats(rows.map((r) => r.timeToExpiryMs)),
    },
    feasibility: {
      targetUsd: TARGET_USD,
      minOrderFeasible: rows.filter((r) => r.minOrderFeasible === true).length,
      minOrderInfeasible: rows.filter((r) => r.minOrderFeasible === false).length,
      minOrderUnknown: rows.filter((r) => r.minOrderFeasible === null).length,
      resizedToManufactureFeasibility: false,
    },
    fees: {
      withAuthoritativeMetadata: rows.filter((r) => r.feeEvidence).length,
      withoutMetadataTreatedAsUnscorable: rows.filter((r) => !r.feeEvidence).length,
    },
    decompositionFunnel: {
      episodes: all.length,
      withFirstPolyResponse: rows.filter((r) => r.firstPolyResponseAtMs !== null).length,
      oracleEmitted: all.filter((r) => r.oracleDecisionAtMs !== null).length,
      oracleConfirmed: all.filter((r) => r.oracleConfirmed === true).length,
      oracleRejected: all.filter((r) => r.oracleOutcome === 'rejected').length,
      oracleNeverEmitted: all.filter((r) => r.oracleOutcome === 'never_emitted').length,
    },
    magnitudeVsExpectancy: { horizonMs: 1000, buckets: magnitudeVsExpectancy },
    directions: { up: all.filter((r) => r.direction === 'UP').length, down: all.filter((r) => r.direction === 'DOWN').length },
  };
}

function memoryUsage() {
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576), heapTotalMb: Math.round(m.heapTotal / 1048576) };
}

function stateSizes() {
  let ringSnapshots = 0; let minSpanMs = null;
  for (const ring of rings.values()) {
    ringSnapshots += ring.length;
    if (ring.length > 1) {
      const span = ring.at(-1).observedAtMs - ring[0].observedAtMs;
      minSpanMs = minSpanMs === null ? span : Math.min(minSpanMs, span);
    }
  }
  return {
    trackedTokens: books.size,
    ringTokens: rings.size,
    ringSnapshots,
    ringSpanMsMin: minSpanMs,
    ringSpanSufficientForLongestHorizon: minSpanMs === null ? null : minSpanMs >= RING_MIN_REQUIRED_SPAN_MS,
    ringCountCapBinding: [...rings.values()].some((r) => r.length >= RING_MAX_SNAPSHOTS),
    btcTicks: btcTicks.length,
    episodes: episodes.length,
    triggersByArm: Object.fromEntries([...armState].map(([k, v]) => [k, v.triggers.length])),
    retiredAwaitingEviction: retiredTokens.size,
    caps: { RING_MAX_AGE_MS, RING_MAX_SNAPSHOTS, RING_MIN_INTERVAL_MS, RING_LADDER_LEVELS, BTC_TICK_MAX, ARM_TRIGGER_MAX, EPISODE_MAX, RETIRED_TOKEN_GRACE_MS },
  };
}

function buildReport(reason) {
  for (const episode of episodes) {
    if (episode.scored) continue;
    scoreEpisode(episode);
    episode.scoredIncomplete = !episodeReadyToScore(episode);
  }
  return {
    study: 'BTC_T0_RAW_IMPULSE_READ_ONLY_SHADOW_V1',
    reason,
    preRegistration: PREREGISTRATION,
    startedAt: nowIso(startedAtMs),
    finishedAt: nowIso(),
    durationMs: Date.now() - startedAtMs,
    safety: { productionOrders: false, paperOrders: false, liveTradingMutated: false, oracleMutated: false, productionFilesWritten: false },
    independence: {
      triggerSource: 'binance_btcusdt_trade_ws',
      oracleFileRole: 'annotation_only',
      oracleFileNeverGatesSamples: true,
      note: 'Impulses the oracle never emitted are recorded as never_emitted, removing the survivorship conditioning present in NDJSON-driven measurements.',
    },
    arms: ARMS.map((a) => armReport(a.name)),
    oracleAnnotations: oracleAnnotationsSeen,
    runtime: {
      memory: memoryUsage(),
      memorySamples: memorySamples.slice(),
      state: stateSizes(),
      tokensEvicted,
      checkpoints: checkpointCount,
      lastCheckpointAt: lastCheckpointAtMs ? nowIso(lastCheckpointAtMs) : null,
      lastCheckpointError,
      scoring: {
        scored: episodes.filter((e) => e.scored).length,
        pending: episodes.filter((e) => !e.scored).length,
        readyMarginMs: SCORE_READY_MARGIN_MS,
      },
      wsCounts,
    },
    partial: false,
    episodes,
  };
}

function writeReportAtomic(report) {
  const tmp = `${OUTPUT}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, OUTPUT);
  try { fs.chmodSync(OUTPUT, 0o600); } catch {}
}

function writeCheckpoint(reason = 'checkpoint') {
  try {
    const report = buildReport(reason);
    report.partial = true;
    report.checkpoint = { sequence: checkpointCount + 1, writtenAt: nowIso(), reason };
    writeReportAtomic(report);
    checkpointCount += 1;
    lastCheckpointAtMs = Date.now();
    lastCheckpointError = null;
    return true;
  } catch (error) {
    lastCheckpointError = error.message;
    return false;
  }
}

function finish(reason, exitCode = 0) {
  if (stopped) return;
  stopped = true;
  let report = null;
  try {
    report = buildReport(reason);
    writeReportAtomic(report);
  } catch (error) {
    console.error(JSON.stringify({ status: 'final_report_failed', reason, error: error.message, checkpointsWritten: checkpointCount, output: OUTPUT }));
    try { polySocket?.close(); binanceSocket?.close(); } catch {}
    process.exit(1);
  }
  console.log(JSON.stringify({
    output: OUTPUT, reason, partial: false,
    arms: report.arms.map((a) => ({ arm: a.arm, isPrimary: a.isPrimary, triggers: a.triggers, episodes: a.episodes, scored: a.scored })),
    runtime: report.runtime, oracleAnnotations: report.oracleAnnotations,
  }, null, 2));
  try { polySocket?.close(); binanceSocket?.close(); } catch {}
  process.exit(exitCode);
}

function start() {
refreshTarget();
connectBinance();
const interval = setInterval(() => {
  refreshTarget();
  tailEvents();
  scoreReadyEpisodes();
  tokensEvicted += evictRetiredTokens();
  const now = Date.now();
  if (now - lastMemorySampleAtMs >= MEMORY_SAMPLE_EVERY_MS) {
    lastMemorySampleAtMs = now;
    memorySamples.push({ atMs: now, elapsedMs: now - startedAtMs, ...memoryUsage(), ...stateSizes() });
    while (memorySamples.length > MEMORY_SAMPLE_MAX) memorySamples.shift();
  }
  if (now - lastCheckpointAtMs >= CHECKPOINT_EVERY_MS) writeCheckpoint('periodic');
  if (now >= stopAtMs) finish('clock_limit');
}, 100);
const ping = setInterval(() => { if (polySocket?.readyState === WebSocket.OPEN) polySocket.send('PING'); }, 10_000);
void interval; void ping;
process.on('SIGINT', () => finish('sigint'));
process.on('SIGTERM', () => finish('sigterm'));
for (const fatal of ['uncaughtException', 'unhandledRejection']) {
  process.on(fatal, (error) => {
    if (stopped) return;
    const salvaged = writeCheckpoint(`${fatal}:${error?.message || 'unknown'}`);
    console.error(JSON.stringify({ status: fatal, error: String(error?.stack || error?.message || error), salvagedCheckpoint: salvaged, output: OUTPUT }));
    stopped = true;
    try { polySocket?.close(); binanceSocket?.close(); } catch {}
    process.exit(1);
  });
}
writeCheckpoint('startup');
console.log(JSON.stringify({ status: 'started', study: 'BTC_T0_RAW_IMPULSE_READ_ONLY_SHADOW_V1', output: OUTPUT, maxDurationMs: MAX_MS, checkpointEveryMs: CHECKPOINT_EVERY_MS, arms: ARMS, startedAt: nowIso() }));
}

// Importing this module must never open a socket or start collecting.
if (require.main === module) start();

module.exports = {
  PREREGISTRATION, HORIZONS, ARMS, ARM_THROTTLE_MS, LOOKBACK_MS,
  SECONDARY_MAX_STALENESS_MS, describe, crossingCost, episodeReadyToScore,
};
