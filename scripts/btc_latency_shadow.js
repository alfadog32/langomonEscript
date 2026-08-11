#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { applyMarketMessage, normalizeBook, partitionPriceChanges, markout, complement, firstAtOrAfter, stats, compactBookSnapshot, boundRing } = require('../lib/btc_latency_shadow');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'btc_oracle_market_target.json');
const EVENTS = path.join(ROOT, 'external_signal_events.ndjson');
const OUTPUT = path.resolve(process.argv.find((v) => v.startsWith('--output='))?.slice(9) || `/tmp/btc_latency_shadow_${Date.now()}.json`);
const MAX_MS = Math.min(3_600_000, Math.max(10_000, Number(process.argv.find((v) => v.startsWith('--duration-ms='))?.slice(14)) || 3_600_000));
const TARGET_EVENTS = Math.max(1, Number(process.argv.find((v) => v.startsWith('--target-events='))?.slice(16)) || 20);
const TAIL_MS = Math.max(1_000, Number(process.argv.find((v) => v.startsWith('--tail-ms='))?.slice(10)) || 60_000);
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade';
const CLOB = 'https://clob.polymarket.com';
const HORIZONS = [250, 500, 1000, 2000, 3000, 5000, 10000, 30000, 60000];
const ENTRY_DELAYS = [0, 250, 500, 1000, 2000, 3000, 5000];

// --- Structural memory bounds. Not a heap-size workaround: every unbounded
// --- accumulator in the collector is capped by age AND by element count.
// History only needs to outlive the longest horizon plus a scoring margin,
// because samples are scored incrementally and then release their ring.
const RING_MAX_AGE_MS = 150_000;
// Measured live rate is ~435 book updates/sec/token, almost all of it depth
// churn at unchanged top-of-book. Retaining every update needed ~65k snapshots
// per token to span the 60s horizon. Instead the ring is DOWNSAMPLED: a
// snapshot is kept when the top of book moves, or at most every
// RING_MIN_INTERVAL_MS otherwise. That preserves every price change exactly
// while cutting volume by ~20x, so the count cap stops truncating history.
const RING_MIN_INTERVAL_MS = 25;
const RING_MAX_SNAPSHOTS = 12_000;
// Minimum history a ring must retain for the longest horizon to be scorable.
const RING_MIN_REQUIRED_SPAN_MS = Math.max(...HORIZONS) + 30_000;
// Ring entries keep a truncated ladder only. `markout()` walks at most
// targetUsd/bestAsk shares (<= 50 shares at a $0.02 book), which the top
// levels satisfy; deeper levels are never required and are not retained.
const RING_LADDER_LEVELS = 12;
const TRADE_MAX_PER_TOKEN = 2_000;
const BTC_TICK_MAX = 2_000;
const SOURCE_TRIGGER_MAX = 5_000;
const COMPLEMENT_EPISODE_MAX = 2_000;
// Retired tokens are kept long enough for in-flight samples to complete their
// longest horizon plus the tail, then evicted.
const RETIRED_TOKEN_GRACE_MS = Math.max(...HORIZONS) + TAIL_MS;
const CHECKPOINT_EVERY_MS = Math.max(15_000, Number(process.argv.find((v) => v.startsWith('--checkpoint-ms='))?.slice(16)) || 30_000);

const startedAtMs = Date.now();
let stopAtMs = startedAtMs + MAX_MS;
let eventOffset = fs.existsSync(EVENTS) ? fs.statSync(EVENTS).size : 0;
let eventRemainder = '';
let target = null;
let polySocket = null;
let binanceSocket = null;
let feeByToken = new Map();
const books = new Map();
const rings = new Map();
const trades = new Map();
const btcTicks = [];
const sourceTriggers = [];
const samples = [];
const wsCounts = { book: 0, price_change: 0, best_bid_ask: 0, last_trade_price: 0, other: 0 };
const complementEpisodes = [];
const retiredTokens = new Map();
let openComplement = null;
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

function appendRing(token, book) {
  if (!book?.bestBid || !book?.bestAsk) return;
  const ring = rings.get(token) || [];
  const last = ring.length ? ring.at(-1) : null;
  // Downsample depth-only churn. Any top-of-book move is always retained, so no
  // price change is ever lost; only redundant same-price updates are dropped.
  if (last) {
    const topUnchanged = last.bestBid === book.bestBid && last.bestAsk === book.bestAsk;
    if (topUnchanged && (book.observedAtMs - last.observedAtMs) < RING_MIN_INTERVAL_MS) return;
  }
  // Store a compacted snapshot: full ladders are needed for live incremental
  // updates (kept in `books`) but never for historical markout scoring.
  ring.push(compactBookSnapshot(book, { maxLevels: RING_LADDER_LEVELS }));
  boundRing(ring, { maxAgeMs: RING_MAX_AGE_MS, maxCount: RING_MAX_SNAPSHOTS, nowMs: Date.now() });
  rings.set(token, ring);
}

// Drop all state for tokens that left the active target long enough ago that no
// in-flight sample can still need them.
function evictRetiredTokens(nowMs = Date.now()) {
  const active = new Set(activeTokens());
  for (const token of books.keys()) {
    if (!active.has(token) && !retiredTokens.has(token)) retiredTokens.set(token, nowMs);
  }
  let evicted = 0;
  for (const [token, retiredAtMs] of [...retiredTokens]) {
    if (active.has(token)) { retiredTokens.delete(token); continue; }
    if (nowMs - retiredAtMs < RETIRED_TOKEN_GRACE_MS) continue;
    // Never discard history an unscored sample still depends on.
    if (samples.some((sample) => sample.tokenId === token && !sample.scored)) continue;
    books.delete(token); rings.delete(token); trades.delete(token); feeByToken.delete(token);
    retiredTokens.delete(token);
    evicted += 1;
  }
  return evicted;
}

function memoryUsage() {
  const mem = process.memoryUsage();
  return {
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    heapTotalMb: Math.round(mem.heapTotal / 1048576),
  };
}

function stateSizes() {
  let ringSnapshots = 0;
  let minSpanMs = null;
  for (const ring of rings.values()) {
    ringSnapshots += ring.length;
    if (ring.length > 1) {
      const span = ring.at(-1).observedAtMs - ring[0].observedAtMs;
      minSpanMs = minSpanMs === null ? span : Math.min(minSpanMs, span);
    }
  }
  let tradeEntries = 0;
  for (const ring of trades.values()) tradeEntries += ring.length;
  return {
    trackedTokens: books.size,
    ringTokens: rings.size,
    ringSnapshots,
    // Observed history span. If this drops below the longest horizon the count
    // cap is truncating history and long-horizon markouts will not score.
    ringSpanMsMin: minSpanMs,
    ringSpanSufficientForLongestHorizon: minSpanMs === null ? null : minSpanMs >= RING_MIN_REQUIRED_SPAN_MS,
    ringCountCapBinding: [...rings.values()].some((r) => r.length >= RING_MAX_SNAPSHOTS),
    tradeEntries,
    btcTicks: btcTicks.length,
    sourceTriggers: sourceTriggers.length,
    complementEpisodes: complementEpisodes.length,
    samples: samples.length,
    retiredAwaitingEviction: retiredTokens.size,
    caps: {
      ringMaxAgeMs: RING_MAX_AGE_MS,
      ringMaxSnapshotsPerToken: RING_MAX_SNAPSHOTS,
      ringLadderLevels: RING_LADDER_LEVELS,
      tradeMaxPerToken: TRADE_MAX_PER_TOKEN,
      btcTickMax: BTC_TICK_MAX,
      sourceTriggerMax: SOURCE_TRIGGER_MAX,
      complementEpisodeMax: COMPLEMENT_EPISODE_MAX,
      retiredTokenGraceMs: RETIRED_TOKEN_GRACE_MS,
    },
  };
}

// Atomic private write. Never targets a production state/config file.
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
    const rate = Number(marketInfo?.fd?.r); const exponent = Number(marketInfo?.fd?.e);
    feeByToken.set(token, Number.isFinite(rate) && Number.isFinite(exponent)
      ? { rate, exponent, takerOnly: marketInfo.fd.to !== false, source: 'official_clob_market_info' }
      : null);
  } catch (error) {
    feeByToken.set(token, null);
  }
}

function activeTokens() {
  const raw = target?.target;
  return raw ? [String(raw.BTC_UP_TOKEN_ID), String(raw.BTC_DOWN_TOKEN_ID)] : [];
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
      const kind = message.event_type || 'other'; wsCounts[kind] = (wsCounts[kind] || 0) + 1;
      if (kind === 'last_trade_price') {
        const token = String(message.asset_id || '');
        const ring = trades.get(token) || [];
        ring.push({ observedAtMs: received, price: Number(message.price), size: Number(message.size), side: String(message.side || '').toUpperCase() });
        while (ring.length && ring[0].observedAtMs < received - 180_000) ring.shift();
        while (ring.length > TRADE_MAX_PER_TOKEN) ring.shift();
        trades.set(token, ring);
        continue;
      }
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
    scanComplement(received);
  });
  polySocket.on('close', () => { if (!stopped) setTimeout(connectPoly, 1000).unref(); });
  polySocket.on('error', () => {});
}

function scanComplement(at) {
  const [up, down] = activeTokens();
  const upBook = books.get(up); const downBook = books.get(down);
  if (!upBook || !downBook || upBook.observedAtMs !== downBook.observedAtMs) return;
  const minShares = Math.max(upBook.minOrderSizeShares || 5, downBook.minOrderSizeShares || 5);
  const result = complement({ upBook, downBook, shares: minShares, upFee: feeByToken.get(up), downFee: feeByToken.get(down) });
  if (result.scorable && result.netEdgeUsd > 0) {
    if (!openComplement) openComplement = { startAt: nowIso(at), startAtMs: at, observations: 0, maxNetEdgePerShare: result.netEdgePerShare };
    openComplement.observations += 1;
    openComplement.lastAt = nowIso(at); openComplement.lastAtMs = at;
    openComplement.maxNetEdgePerShare = Math.max(openComplement.maxNetEdgePerShare, result.netEdgePerShare);
  } else if (openComplement) {
    complementEpisodes.push({ ...openComplement, durationMs: openComplement.lastAtMs - openComplement.startAtMs }); openComplement = null;
    while (complementEpisodes.length > COMPLEMENT_EPISODE_MAX) complementEpisodes.shift();
  }
}

function connectBinance() {
  binanceSocket = new WebSocket(BINANCE_WS);
  binanceSocket.on('message', (data) => {
    const receivedAtMs = Date.now();
    let trade; try { trade = JSON.parse(String(data)); } catch { return; }
    const price = Number(trade.p); const exchangeAtMs = Number(trade.T || trade.E);
    if (!(price > 0)) return;
    btcTicks.push({ price, exchangeAtMs, receivedAtMs, monotonicNs: process.hrtime.bigint().toString() });
    while (btcTicks.length && btcTicks[0].receivedAtMs < receivedAtMs - 10_000) btcTicks.shift();
    while (btcTicks.length > BTC_TICK_MAX) btcTicks.shift();
    const initial = btcTicks.find((tick) => tick.receivedAtMs >= receivedAtMs - 1000) || btcTicks[0];
    if (!initial) return;
    const move = (price - initial.price) / initial.price;
    // `detectedAtMs` is the single canonical trigger timestamp. The previous
    // code wrote `oracleEquivalentDetectedAtMs` but throttled on `detectedAtMs`,
    // so the comparison was NaN, the guard was permanently false, and the array
    // froze at one element -- which left every event with a null trigger.
    const lastDetectedAtMs = sourceTriggers.length ? sourceTriggers.at(-1).detectedAtMs : null;
    const throttleClear = !Number.isFinite(lastDetectedAtMs) || (receivedAtMs - lastDetectedAtMs) > 500;
    if (Math.abs(move) >= .0001 && throttleClear) {
      sourceTriggers.push({ direction: move > 0 ? 'UP' : 'DOWN', sourceMoveStartedAtMs: initial.exchangeAtMs, sourceMoveStartedReceivedAtMs: initial.receivedAtMs, detectedAtMs: receivedAtMs, sourceExchangeAtMs: exchangeAtMs, move, initialPrice: initial.price, triggerPrice: price });
      while (sourceTriggers.length > SOURCE_TRIGGER_MAX) sourceTriggers.shift();
    }
  });
  binanceSocket.on('close', () => { if (!stopped) setTimeout(connectBinance, 1000).unref(); });
  binanceSocket.on('error', () => {});
}

function captureEvent(event) {
  if (event.type !== 'BTC_TEMPORAL_LAG_OBI_V5' || !(Math.abs(Number(event.btc_persisted_move_pct)) >= Number(event.confirmation_config?.persistence_min_pct || .00005))) return;
  const writtenAtMs = Date.parse(event.timestamp);
  const token = String(event.token_id);
  const trigger = [...sourceTriggers].reverse().find((item) => item.direction === event.direction && item.detectedAtMs <= writtenAtMs && writtenAtMs - item.detectedAtMs <= 5000) || null;
  const book = books.get(token);
  const sample = {
    eventId: `${event.timestamp}:${token}`,
    direction: event.direction,
    marketSlug: event.market_slug,
    tokenId: token,
    outcome: event.direction === 'UP' ? 'Up' : 'Down',
    sourceMoveStartedAt: trigger ? nowIso(trigger.sourceMoveStartedAtMs) : null,
    sourceMoveConfirmedAt: event.timestamp,
    oracleDetectedAt: trigger ? nowIso(trigger.detectedAtMs) : null,
    oracleSignalWrittenAt: event.timestamp,
    polyBookObservedAt: book ? nowIso(book.observedAtMs) : null,
    candidateBuiltAt: event.confirmed ? null : null,
    sophieEvaluatedAt: null,
    riskEvaluatedAt: null,
    stageReasons: { sourceTiming: trigger ? 'independent_binance_trigger_matched' : 'no_independent_trigger_match', productionCandidate: event.confirmed ? 'not_observable_in_producer' : `not_reached:${(event.confirmation_blockers || []).join(',')}`, sophie: 'not_reached', risk: 'not_reached' },
    observedAtMs: writtenAtMs,
    btcTriggerMovePct: Number(event.btc_trigger_move_pct),
    btcPersistedMovePct: Number(event.btc_persisted_move_pct),
    oracleConfirmed: Boolean(event.confirmed),
    oracleLagScore: Number(event.lag_score),
    oraclePersistenceMs: trigger ? writtenAtMs - trigger.detectedAtMs : null,
    sourceToOracleMs: trigger ? trigger.detectedAtMs - trigger.sourceMoveStartedAtMs : null,
    oracleToPolyObservationMs: book ? book.observedAtMs - writtenAtMs : null,
    timeRemainingMs: Date.parse(event.market_end_time) - writtenAtMs,
    frozenBook: book || null,
    feeEvidence: feeByToken.get(token) || null,
    forward: {}, speedDecay: {},
    passive: book?.bestBid ? {
      limitPrice: book.bestBid,
      registeredAtMs: writtenAtMs,
      nonMarketableAtRegistration: book.bestBid < book.bestAsk,
      queueAheadShares: book.bids.find((level) => level.price === book.bestBid)?.size ?? null,
      queueHaircut: 0.5,
      ttlMs: 5000,
    } : null,
  };
  sample.scored = false;
  sample.scoredAtMs = null;
  samples.push(sample);
  if (samples.length >= TARGET_EVENTS) stopAtMs = Math.min(stopAtMs, Date.now() + TAIL_MS);
}

function tailEvents() {
  if (!fs.existsSync(EVENTS)) return;
  const size = fs.statSync(EVENTS).size;
  if (size < eventOffset) { eventOffset = 0; eventRemainder = ''; }
  if (size === eventOffset) return;
  const length = size - eventOffset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(EVENTS, 'r'); fs.readSync(fd, buffer, 0, length, eventOffset); fs.closeSync(fd); eventOffset = size;
  const chunks = (eventRemainder + buffer.toString('utf8')).split('\n'); eventRemainder = chunks.pop();
  for (const line of chunks) { try { captureEvent(JSON.parse(line)); } catch {} }
}

function refreshTarget() {
  const next = safeJson(TARGET);
  if (!next?.activeKey || next.activeKey === target?.activeKey) return;
  target = next;
  Promise.all(activeTokens().map(refreshToken)).finally(connectPoly);
}

// A sample is scorable once its longest horizon has elapsed. Scoring is done
// once and frozen, so the sample never depends on live ring state again --
// which is what lets retired tokens be evicted without destroying results.
const SCORE_READY_MARGIN_MS = 2_000;

function sampleReadyToScore(sample, nowMs = Date.now()) {
  return nowMs >= sample.observedAtMs + Math.max(...HORIZONS) + SCORE_READY_MARGIN_MS;
}

function scoreReadySamples(nowMs = Date.now()) {
  let scored = 0;
  for (const sample of samples) {
    if (sample.scored || !sampleReadyToScore(sample, nowMs)) continue;
    scoreSample(sample);
    sample.scored = true;
    sample.scoredAtMs = nowMs;
    // Cleared explicitly: an earlier checkpoint may have marked this sample
    // incomplete while its horizons were still elapsing.
    sample.scoredIncomplete = false;
    scored += 1;
  }
  return scored;
}

function score() {
  // Score anything still outstanding (run ended before its horizons elapsed).
  for (const sample of samples) {
    if (sample.scored) continue;
    scoreSample(sample);
    sample.scoredIncomplete = !sampleReadyToScore(sample);
  }
}

function scoreSample(sample) {
  {
    const ring = rings.get(sample.tokenId) || [];
    const entry0 = firstAtOrAfter(ring, sample.observedAtMs) || sample.frozenBook;
    const firstUpdate = firstAtOrAfter(ring, sample.observedAtMs);
    sample.polyFirstAfterSignalAt = firstUpdate ? nowIso(firstUpdate.observedAtMs) : null;
    sample.oracleToFirstPolyUpdateMs = firstUpdate ? firstUpdate.observedAtMs - sample.observedAtMs : null;
    for (const horizon of HORIZONS) {
      sample.forward[horizon] = markout({ entryBook: entry0, exitBook: firstAtOrAfter(ring, sample.observedAtMs + horizon), feeRate: sample.feeEvidence?.rate, feeExponent: sample.feeEvidence?.exponent });
    }
    for (const delay of ENTRY_DELAYS) {
      const entry = firstAtOrAfter(ring, sample.observedAtMs + delay);
      sample.speedDecay[delay] = {};
      for (const horizon of [5000, 10000, 30000, 60000]) {
        sample.speedDecay[delay][horizon] = markout({ entryBook: entry, exitBook: firstAtOrAfter(ring, sample.observedAtMs + horizon), feeRate: sample.feeEvidence?.rate, feeExponent: sample.feeEvidence?.exponent });
      }
    }
    if (sample.passive?.nonMarketableAtRegistration && Number.isFinite(sample.passive.queueAheadShares)) {
      const shares = 1 / sample.passive.limitPrice;
      let opposingVolume = 0;
      let fillAtMs = null;
      for (const trade of trades.get(sample.tokenId) || []) {
        if (trade.observedAtMs <= sample.observedAtMs || trade.observedAtMs > sample.observedAtMs + sample.passive.ttlMs) continue;
        if (trade.side === 'SELL' && trade.price <= sample.passive.limitPrice) opposingVolume += trade.size * sample.passive.queueHaircut;
        if (opposingVolume >= sample.passive.queueAheadShares + shares) { fillAtMs = trade.observedAtMs; break; }
      }
      sample.passive.fillAtMs = fillAtMs;
      sample.passive.realisticFill = Number.isFinite(fillAtMs);
      sample.passive.fillEvidence = fillAtMs ? 'opposing_sell_volume_after_queue_haircut' : 'none';
      sample.passive.markouts = {};
      if (fillAtMs) {
        const passiveEntry = { ...sample.frozenBook, bestAsk: sample.passive.limitPrice, midpoint: sample.passive.limitPrice, asks: [{ price: sample.passive.limitPrice, size: shares }] };
        for (const horizon of [5000, 10000, 30000, 60000]) {
          sample.passive.markouts[horizon] = markout({ entryBook: passiveEntry, exitBook: firstAtOrAfter(ring, fillAtMs + horizon), feeRate: 0, feeExponent: 1 });
        }
      }
    }
  }
}

function maxDrawdown(values) {
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const value of values.filter(Number.isFinite)) { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return drawdown;
}

function buildReport(reason) {
  score();
  const horizonSummary = {};
  for (const horizon of HORIZONS) {
    horizonSummary[horizon] = {
      raw: stats(samples.map((s) => s.forward[horizon]?.rawMidpointPnlPerUsd)),
      executable: stats(samples.map((s) => s.forward[horizon]?.netExecutablePnlPerUsd)),
    };
  }
  const speedDecay = {};
  for (const delay of ENTRY_DELAYS) {
    speedDecay[delay] = {};
    for (const horizon of [5000, 10000, 30000, 60000]) speedDecay[delay][horizon] = stats(samples.map((s) => s.speedDecay[delay]?.[horizon]?.netExecutablePnlPerUsd));
  }
  const minFeasible = samples.filter((sample) => {
    const book = sample.frozenBook;
    return book?.bestAsk && Number.isFinite(book.minOrderSizeShares) && 1 / book.bestAsk >= book.minOrderSizeShares;
  }).length;
  const passiveFilled = samples.filter((sample) => sample.passive?.realisticFill);
  const executable60 = samples.map((sample) => sample.forward[60000]?.netExecutablePnlPerUsd).filter(Number.isFinite);
  const directionAccuracy = samples.map((sample) => sample.forward[10000]?.rawMidpointPnlPerUsd).filter(Number.isFinite);
  const magnitudes = { '0.10%-0.15%': 0, '0.15%-0.20%': 0, '0.20%-0.30%': 0, '0.30%-0.50%': 0, '>=0.50%': 0, '<0.10%': 0 };
  for (const sample of samples) {
    const pct = Math.abs(sample.btcPersistedMovePct) * 100;
    if (pct < .1) magnitudes['<0.10%']++; else if (pct < .15) magnitudes['0.10%-0.15%']++; else if (pct < .2) magnitudes['0.15%-0.20%']++; else if (pct < .3) magnitudes['0.20%-0.30%']++; else if (pct < .5) magnitudes['0.30%-0.50%']++; else magnitudes['>=0.50%']++;
  }
  return {
    study: 'BTC_LATENCY_READ_ONLY_SHADOW_V1', reason,
    startedAt: nowIso(startedAtMs), finishedAt: nowIso(), durationMs: Date.now() - startedAtMs,
    stoppingRule: { targetPersistenceConfirmedEvents: TARGET_EVENTS, maxDurationMs: MAX_MS, tailMs: TAIL_MS },
    safety: { productionOrders: false, paperOrders: false, liveTradingMutated: false, oracleMutated: false },
    methodology: { eligibility: 'new V5 events passing existing BTC persistence minimum; frozen at signal write receipt', targetUsd: 1, entry: 'depth-weighted executable ask', exit: 'depth-weighted executable bid', fee: 'official CLOB market-info fd parameters; unknown fails closed', sourceTiming: 'independent Binance trade WS correlation', polyTiming: 'public CLOB market WS full and incremental book updates' },
    counts: { persistenceConfirmedEvents: samples.length, fullyOracleConfirmedEvents: samples.filter((s) => s.oracleConfirmed).length, markets: new Set(samples.map((s) => s.marketSlug)).size, directions: { up: samples.filter((s) => s.direction === 'UP').length, down: samples.filter((s) => s.direction === 'DOWN').length }, wsCounts },
    latency: { sourceToOracle: stats(samples.map((s) => s.sourceToOracleMs)), oraclePersistenceObserved: stats(samples.map((s) => s.oraclePersistenceMs)), oracleToFirstPolyUpdate: stats(samples.map((s) => s.oracleToFirstPolyUpdateMs)) },
    magnitudeBuckets: magnitudes,
    directionalValidation: { horizonMs: 10000, scorable: directionAccuracy.length, correct: directionAccuracy.filter((value) => value > 0).length, accuracy: directionAccuracy.length ? directionAccuracy.filter((value) => value > 0).length / directionAccuracy.length : null },
    feasibility: { targetUsd: 1, shadowExecutable: samples.filter((s) => s.frozenBook?.bestAsk).length, paperRealistic: minFeasible, liveMinimumFeasible: minFeasible, resizedToManufactureFeasibility: false },
    executionStyles: { taker: 'depth_walked_ask_to_bid', fakEquivalent: 'same visible-depth economics; no unavailable depth assumed', passive: { rule: 'best_bid_5s_opposing_sell_queue_haircut_50pct', registered: samples.filter((s) => s.passive?.nonMarketableAtRegistration).length, realisticFills: passiveFilled.length, fillRate: samples.length ? passiveFilled.length / samples.length : null, markout60: stats(passiveFilled.map((s) => s.passive.markouts?.[60000]?.netExecutablePnlPerUsd)) } },
    riskDistribution: { executable60MaxDrawdownPerUsd: maxDrawdown(executable60), largestAbsoluteObservationShare: executable60.length ? Math.max(...executable60.map(Math.abs)) / executable60.reduce((sum, value) => sum + Math.abs(value), 0) : null },
    horizonSummary, speedDecay,
    complement: { positiveNetEpisodes: complementEpisodes.length + (openComplement ? 1 : 0), episodes: openComplement ? [...complementEpisodes, { ...openComplement, durationMs: Date.now() - openComplement.startAtMs }] : complementEpisodes },
    runtime: {
      memory: memoryUsage(),
      memorySamples: memorySamples.slice(),
      state: stateSizes(),
      tokensEvicted,
      checkpoints: checkpointCount,
      lastCheckpointAt: lastCheckpointAtMs ? nowIso(lastCheckpointAtMs) : null,
      lastCheckpointError,
      scoring: {
        scored: samples.filter((x) => x.scored).length,
        pending: samples.filter((x) => !x.scored).length,
        scoredIncomplete: samples.filter((x) => x.scoredIncomplete).length,
        readyMarginMs: SCORE_READY_MARGIN_MS,
      },
      triggerAttribution: {
        sourceTriggers: sourceTriggers.length,
        samplesWithTrigger: samples.filter((s) => s.sourceMoveStartedAt !== null).length,
        samplesWithoutTrigger: samples.filter((s) => s.sourceMoveStartedAt === null).length,
      },
    },
    partial: false,
    samples,
  };
}

function finish(reason, exitCode = 0) {
  if (stopped) return; stopped = true;
  if (openComplement) { complementEpisodes.push({ ...openComplement, durationMs: Date.now() - openComplement.startAtMs }); openComplement = null; }
  let report = null;
  try {
    report = buildReport(reason);
    writeReportAtomic(report);
  } catch (error) {
    console.error(JSON.stringify({ status: 'final_report_failed', reason, error: error.message, checkpointsWritten: checkpointCount, output: OUTPUT }));
    try { polySocket?.close(); binanceSocket?.close(); } catch {}
    process.exit(1);
  }
  console.log(JSON.stringify({ output: OUTPUT, reason, partial: false, counts: report.counts, latency: report.latency, runtime: report.runtime, horizonSummary: report.horizonSummary, complement: report.complement }, null, 2));
  try { polySocket?.close(); binanceSocket?.close(); } catch {}
  process.exit(exitCode);
}

refreshTarget(); connectBinance();
const interval = setInterval(() => {
  refreshTarget();
  tailEvents();
  scoreReadySamples();
  tokensEvicted += evictRetiredTokens();
  const now = Date.now();
  if (now - lastMemorySampleAtMs >= MEMORY_SAMPLE_EVERY_MS) {
    lastMemorySampleAtMs = now;
    memorySamples.push({ atMs: now, elapsedMs: now - startedAtMs, ...memoryUsage(), ...stateSizes() });
    while (memorySamples.length > MEMORY_SAMPLE_MAX) memorySamples.shift();
  }
  // Checkpoint early and often so a kill, timeout or crash still leaves data.
  if (now - lastCheckpointAtMs >= CHECKPOINT_EVERY_MS) writeCheckpoint('periodic');
  if (now >= stopAtMs) finish(samples.length >= TARGET_EVENTS ? 'target_events_plus_tail' : 'clock_limit');
}, 100);
const ping = setInterval(() => { if (polySocket?.readyState === WebSocket.OPEN) polySocket.send('PING'); }, 10_000);
process.on('SIGINT', () => finish('sigint'));
process.on('SIGTERM', () => finish('sigterm'));
for (const fatal of ['uncaughtException', 'unhandledRejection']) {
  process.on(fatal, (error) => {
    if (stopped) return;
    // Salvage whatever has been collected before surrendering the process.
    const salvaged = writeCheckpoint(`${fatal}:${error?.message || 'unknown'}`);
    console.error(JSON.stringify({ status: fatal, error: String(error?.stack || error?.message || error), salvagedCheckpoint: salvaged, output: OUTPUT }));
    stopped = true;
    try { polySocket?.close(); binanceSocket?.close(); } catch {}
    process.exit(1);
  });
}
writeCheckpoint('startup');
console.log(JSON.stringify({ status: 'started', output: OUTPUT, targetEvents: TARGET_EVENTS, maxDurationMs: MAX_MS, checkpointEveryMs: CHECKPOINT_EVERY_MS, memoryCaps: stateSizes().caps, startedAt: nowIso() }));
