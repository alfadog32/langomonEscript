'use strict';

/**
 * BTC + Polymarket Temporal-Lag / OBI Oracle Hub v5
 *
 * Adds true Polymarket midpoint lag measurement:
 *   1. Detect BTC impulse inside BTC_ORACLE_TRIGGER_WINDOW_MS.
 *   2. Snapshot Polymarket target-token midpoint at trigger time.
 *   3. Wait BTC_ORACLE_PERSISTENCE_MS.
 *   4. Confirm BTC move persisted.
 *   5. Compare Polymarket midpoint movement vs BTC movement.
 *   6. Upgrade to HARD_INTERRUPT_REQUEST only when lag + depth + OBI pass.
 *
 * Install:
 *   npm install ws
 *
 * Run:
 *   node btc_poly_oracle_v5.js
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

loadDotEnvFile();

function loadDotEnvFile(filePath = path.join(process.cwd(), '.env')) {
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (!key || process.env[key] !== undefined) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (e) {
    console.warn(`[ENV] Failed to load .env: ${e.message}`);
  }
}

function envStr(key, fallback) {
  return process.env[key] || fallback;
}

function envNum(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(key, fallback) {
  const n = Number.parseInt(process.env[key], 10);
  return Number.isFinite(n) ? n : fallback;
}

const CONFIG = {
  binanceWs: envStr('BTC_ORACLE_BINANCE_WS', 'wss://stream.binance.com:9443/ws/btcusdt@trade'),
  clobWs: envStr('POLYMARKET_CLOB_WS', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),

  upTokenId: envStr('BTC_UP_TOKEN_ID', ''),
  downTokenId: envStr('BTC_DOWN_TOKEN_ID', ''),

  signalPath: envStr('BTC_ORACLE_SIGNAL_PATH', './external_signals.json'),
  signalLogPath: envStr('BTC_ORACLE_SIGNAL_LOG_PATH', './external_signal_events.ndjson'),

  triggerThreshold: envNum('BTC_ORACLE_THRESHOLD', 0.003),
  triggerWindowMs: envInt('BTC_ORACLE_TRIGGER_WINDOW_MS', 1000),
  lookbackWindowMs: envInt('BTC_ORACLE_LOOKBACK_WINDOW_MS', 5000),
  persistenceMs: envInt('BTC_ORACLE_PERSISTENCE_MS', 4000),
  persistenceMinPct: envNum('BTC_ORACLE_PERSISTENCE_MIN_PCT', 0.002),

  // NEW: true midpoint-lag rule.
  // Example: if BTC moved 0.30%, and polyMoveWeight=0.50,
  // Polymarket midpoint must have moved <= 0.15% to count as lagging.
  polyMoveWeight: envNum('BTC_ORACLE_POLY_MOVE_WEIGHT', 0.50),
  minLagScore: envNum('BTC_ORACLE_MIN_LAG_SCORE', 0.001),

  minDepthUsd: envNum('OBI_MIN_DEPTH_USD', 25),
  execDepthUsd: envNum('OBI_EXEC_DEPTH_USD', 10),
  obiThreshold: envNum('OBI_THRESHOLD', 0.65),
  depthLevels: envInt('OBI_DEPTH_LEVELS', 3),
  maxSpread: envNum('ORACLE_MAX_SPREAD', 0.20),
  maxBookAgeMs: envInt('ORACLE_MAX_BOOK_AGE_MS', 3000),

  cooldownMs: envInt('BTC_ORACLE_COOLDOWN_MS', 8000),
  signalTtlMs: envInt('BTC_ORACLE_SIGNAL_TTL_MS', 15000),
  suggestedMaxPaperUsd: envNum('BTC_ORACLE_MAX_SUGGESTED_PAPER_USD', 10),
};

let tradeHistory = [];
const books = new Map();
let pendingImpulse = null;
let lastSignalAt = 0;
let polyWs = null;
let binanceWs = null;
let stopping = false;

function nowIso() {
  return new Date().toISOString();
}

function fmtPct(x) {
  return `${(x * 100).toFixed(3)}%`;
}

function pctMove(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return 0;
  return (to - from) / from;
}

function shortId(id) {
  if (!id) return 'none';
  const s = String(id);
  return s.length > 12 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
}

function safeMkdirForFile(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath, obj) {
  safeMkdirForFile(filePath);
  const abs = path.resolve(filePath);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, abs);
}

function appendNdjson(filePath, obj) {
  safeMkdirForFile(filePath);
  fs.appendFileSync(path.resolve(filePath), `${JSON.stringify(obj)}\n`);
}

function emitStdout(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];

  const normalized = levels
    .map((level) => {
      const price = Number(level.price ?? level.p ?? level[0]);
      const size = Number(level.size ?? level.s ?? level[1]);
      return { price, size };
    })
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0);

  if (side === 'bid') normalized.sort((a, b) => b.price - a.price);
  if (side === 'ask') normalized.sort((a, b) => a.price - b.price);

  return normalized;
}

function topDepthUsd(levels, n) {
  return levels.slice(0, n).reduce((sum, level) => sum + level.price * level.size, 0);
}

function snapshotBook(tokenId) {
  const raw = tokenId ? books.get(tokenId) : null;

  if (!raw) {
    return {
      valid: false,
      reason: 'missing_book',
      tokenId,
      updatedAt: 0,
      ageMs: Infinity,
      bids: [],
      asks: [],
      bestBid: null,
      bestAsk: null,
      midpoint: null,
      spread: null,
      bidDepth: 0,
      askDepth: 0,
      obi: 0,
    };
  }

  const bids = normalizeLevels(raw.bids, 'bid');
  const asks = normalizeLevels(raw.asks, 'ask');
  const ageMs = Date.now() - raw.updatedAt;

  if (!bids.length || !asks.length) {
    return {
      valid: false,
      reason: 'empty_side',
      tokenId,
      updatedAt: raw.updatedAt,
      ageMs,
      bids,
      asks,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      midpoint: null,
      spread: null,
      bidDepth: 0,
      askDepth: 0,
      obi: 0,
    };
  }

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const midpoint = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const bidDepth = topDepthUsd(bids, CONFIG.depthLevels);
  const askDepth = topDepthUsd(asks, CONFIG.depthLevels);
  const denom = bidDepth + askDepth;
  const obi = denom > 0 ? (bidDepth - askDepth) / denom : 0;

  const valid =
    ageMs <= CONFIG.maxBookAgeMs &&
    bestBid > 0 &&
    bestAsk > 0 &&
    bestBid < bestAsk &&
    spread <= CONFIG.maxSpread &&
    (bidDepth >= CONFIG.minDepthUsd || askDepth >= CONFIG.minDepthUsd) &&
    askDepth >= CONFIG.execDepthUsd;

  return {
    valid,
    reason: valid ? 'ok' : 'failed_book_gates',
    tokenId,
    updatedAt: raw.updatedAt,
    ageMs,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint,
    spread,
    bidDepth,
    askDepth,
    obi,
  };
}

function tokenForDirection(direction) {
  return direction === 'UP' ? CONFIG.upTokenId : CONFIG.downTokenId;
}

function subscribePolymarket(ws) {
  const assets = [CONFIG.upTokenId, CONFIG.downTokenId].filter(Boolean);

  if (!assets.length) {
    console.warn('[POLY] No BTC_UP_TOKEN_ID / BTC_DOWN_TOKEN_ID configured. Polymarket validation disabled.');
    return;
  }

  ws.send(JSON.stringify({
    assets_ids: assets,
    type: 'market',
    custom_feature_enabled: true,
  }));

  console.log(`[POLY] Subscribed to ${assets.map(shortId).join(', ')}`);
}

function connectPolymarket() {
  polyWs = new WebSocket(CONFIG.clobWs);

  polyWs.on('open', () => {
    console.log('[POLY] WebSocket connected.');
    subscribePolymarket(polyWs);
  });

  polyWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const items = Array.isArray(msg) ? msg : [msg];

      for (const item of items) {
        if (item.event_type !== 'book') continue;

        const assetId = String(item.asset_id || item.assetId || item.token_id || item.tokenId || '');
        if (!assetId) continue;

        books.set(assetId, {
          bids: item.bids || [],
          asks: item.asks || [],
          updatedAt: Date.now(),
        });
      }
    } catch (e) {
      console.warn(`[POLY] Bad message: ${e.message}`);
    }
  });

  polyWs.on('error', (e) => {
    console.warn(`[POLY] WebSocket error: ${e.message}`);
  });

  polyWs.on('close', () => {
    if (stopping) return;
    console.warn('[POLY] WebSocket closed. Reconnecting in 5s...');
    setTimeout(connectPolymarket, 5000);
  });
}

function directionObiConfirmed(direction, finalBook) {
  // We are buying the UP token after UP BTC impulses and buying the DOWN token after DOWN BTC impulses.
  // For the chosen target token, positive OBI means bid-side support outweighs ask-side pressure.
  if (!finalBook.valid) return false;
  if (finalBook.obi < CONFIG.obiThreshold) return false;
  if (finalBook.askDepth < CONFIG.execDepthUsd) return false;
  return direction === 'UP' || direction === 'DOWN';
}

function emitSignal({ impulse, latest, persistedAbsMove, finalBook }) {
  const polyMidMovePct =
    impulse.initialBook.valid &&
    finalBook.valid &&
    Number.isFinite(impulse.initialBook.midpoint) &&
    Number.isFinite(finalBook.midpoint)
      ? Math.abs(pctMove(impulse.initialBook.midpoint, finalBook.midpoint))
      : null;

  const polyLagConfirmed =
    polyMidMovePct !== null &&
    polyMidMovePct <= persistedAbsMove * CONFIG.polyMoveWeight;

  const lagScore = Math.max(0, persistedAbsMove - (polyMidMovePct ?? 0));
  const lagScorePass = lagScore >= CONFIG.minLagScore;
  const obiConfirmed = directionObiConfirmed(impulse.direction, finalBook);

  const hardInterrupt = polyLagConfirmed && lagScorePass && obiConfirmed;

  const signal = {
    timestamp: nowIso(),
    expires_at: new Date(Date.now() + CONFIG.signalTtlMs).toISOString(),

    type: 'BTC_TEMPORAL_LAG_OBI_V5',
    interrupt_level: hardInterrupt ? 'HARD_INTERRUPT_REQUEST' : 'PRIORITY_ALERT',

    external_source: 'binance_btcusdt_trade_ws',
    polymarket_source: 'polymarket_clob_market_ws',

    direction: impulse.direction,
    suggested_action: impulse.direction === 'UP' ? 'BUY_BTC_UP_TOKEN' : 'BUY_BTC_DOWN_TOKEN',
    token_id: impulse.tokenId || null,

    initial_btc_price: impulse.initialPrice,
    trigger_btc_price: impulse.triggerPrice,
    current_btc_price: latest.price,

    btc_trigger_move_pct: impulse.triggerMovePct,
    btc_persisted_move_pct: persistedAbsMove,

    // NEW: true midpoint-lag measurement.
    poly_mid_at_trigger: impulse.initialBook.midpoint,
    poly_mid_after_persistence: finalBook.midpoint,
    poly_mid_move_pct: polyMidMovePct,
    poly_move_weight_limit_pct: persistedAbsMove * CONFIG.polyMoveWeight,
    poly_lag_confirmed: polyLagConfirmed,
    lag_score: lagScore,
    lag_score_pass: lagScorePass,

    book_at_trigger: {
      valid: impulse.initialBook.valid,
      reason: impulse.initialBook.reason,
      age_ms: impulse.initialBook.ageMs === Infinity ? null : impulse.initialBook.ageMs,
      best_bid: impulse.initialBook.bestBid,
      best_ask: impulse.initialBook.bestAsk,
      midpoint: impulse.initialBook.midpoint,
      spread: impulse.initialBook.spread,
      bid_depth_usd: Number((impulse.initialBook.bidDepth || 0).toFixed(2)),
      ask_depth_usd: Number((impulse.initialBook.askDepth || 0).toFixed(2)),
      obi: Number((impulse.initialBook.obi || 0).toFixed(6)),
    },

    book_after_persistence: {
      valid: finalBook.valid,
      reason: finalBook.reason,
      age_ms: finalBook.ageMs === Infinity ? null : finalBook.ageMs,
      best_bid: finalBook.bestBid,
      best_ask: finalBook.bestAsk,
      midpoint: finalBook.midpoint,
      spread: finalBook.spread,
      bid_depth_usd: Number((finalBook.bidDepth || 0).toFixed(2)),
      ask_depth_usd: Number((finalBook.askDepth || 0).toFixed(2)),
      obi: Number((finalBook.obi || 0).toFixed(6)),
    },

    obi_confirmed: obiConfirmed,
    confidence: Math.max(0.35, Math.min(0.95, 0.50 + lagScore * 60 + (polyLagConfirmed ? 0.10 : 0) + (obiConfirmed ? 0.10 : 0))),
    suggested_max_paper_usd: CONFIG.suggestedMaxPaperUsd,
    action: hardInterrupt ? 'TELEGRAM_HARD_INTERRUPT_REQUEST' : 'TELEGRAM_ALERT_ONLY',

    safety: {
      do_not_auto_trade: true,
      telegram_approval_required: true,
      do_not_disable_risk_engine: true,
      do_not_cancel_profit_exits: true,
      do_not_sweep_without_depth_check: true,
    },
  };

  atomicWriteJson(CONFIG.signalPath, signal);
  appendNdjson(CONFIG.signalLogPath, signal);
  emitStdout(signal);

  lastSignalAt = Date.now();

  console.log(
    `[ORACLE] ${signal.interrupt_level} ${signal.direction} ` +
    `BTC=${fmtPct(persistedAbsMove)} poly=${polyMidMovePct === null ? 'n/a' : fmtPct(polyMidMovePct)} ` +
    `lag=${fmtPct(lagScore)} OBI=${finalBook.obi.toFixed(4)} token=${shortId(impulse.tokenId)}`
  );
}

function startPersistenceCheck(candidate) {
  pendingImpulse = candidate;

  setTimeout(() => {
    const impulse = pendingImpulse;
    pendingImpulse = null;

    if (!impulse) return;

    const latest = tradeHistory[tradeHistory.length - 1];
    if (!latest) return;

    const persistedSigned = pctMove(impulse.initialPrice, latest.price);
    const persistedDirection = persistedSigned > 0 ? 'UP' : 'DOWN';
    const persistedAbs = Math.abs(persistedSigned);

    if (persistedDirection !== impulse.direction || persistedAbs < CONFIG.persistenceMinPct) {
      const rejected = {
        timestamp: nowIso(),
        type: 'BTC_TEMPORAL_LAG_OBI_REJECTED',
        reason: 'impulse_failed_persistence',
        direction: impulse.direction,
        btc_trigger_move_pct: impulse.triggerMovePct,
        btc_persisted_move_pct: persistedAbs,
        persisted_direction: persistedDirection,
      };
      appendNdjson(CONFIG.signalLogPath, rejected);
      console.log(
        `[ORACLE] Rejected ${impulse.direction}: persistence failed. ` +
        `trigger=${fmtPct(impulse.triggerMovePct)} persisted=${fmtPct(persistedAbs)}`
      );
      return;
    }

    const finalBook = snapshotBook(impulse.tokenId);
    emitSignal({ impulse, latest, persistedAbsMove: persistedAbs, finalBook });
  }, CONFIG.persistenceMs);
}

function handleBinanceTrade(raw) {
  const msg = JSON.parse(raw);
  const price = Number(msg.p);
  const ts = Number(msg.T || msg.E || Date.now());

  if (!Number.isFinite(price) || price <= 0) return;

  const now = Date.now();
  tradeHistory.push({ price, ts, receivedAt: now });
  tradeHistory = tradeHistory.filter((t) => t.ts > ts - CONFIG.lookbackWindowMs);

  if (pendingImpulse) return;
  if (now - lastSignalAt < CONFIG.cooldownMs) return;

  const windowStart = ts - CONFIG.triggerWindowMs;
  const windowTrades = tradeHistory.filter((t) => t.ts >= windowStart);
  if (windowTrades.length < 2) return;

  const initial = windowTrades[0];
  const signedMove = pctMove(initial.price, price);
  const absMove = Math.abs(signedMove);

  if (absMove < CONFIG.triggerThreshold) return;

  const direction = signedMove > 0 ? 'UP' : 'DOWN';
  const tokenId = tokenForDirection(direction);
  const initialBook = snapshotBook(tokenId);

  console.log(
    `[ORACLE] Candidate ${direction}: ${fmtPct(absMove)} over ${ts - initial.ts}ms. ` +
    `polyMid=${initialBook.midpoint ?? 'n/a'} bookAge=${initialBook.ageMs === Infinity ? 'n/a' : initialBook.ageMs}ms. Checking persistence...`
  );

  startPersistenceCheck({
    direction,
    tokenId,
    initialPrice: initial.price,
    triggerPrice: price,
    triggerMovePct: absMove,
    triggerTs: ts,
    initialBook,
  });
}

function connectBinance() {
  binanceWs = new WebSocket(CONFIG.binanceWs);

  binanceWs.on('open', () => {
    console.log(`[BINANCE] Connected: ${CONFIG.binanceWs}`);
  });

  binanceWs.on('message', (data) => {
    try {
      handleBinanceTrade(data.toString());
    } catch (e) {
      console.warn(`[BINANCE] Bad message: ${e.message}`);
    }
  });

  binanceWs.on('error', (e) => {
    console.warn(`[BINANCE] WebSocket error: ${e.message}`);
  });

  binanceWs.on('close', () => {
    if (stopping) return;
    console.warn('[BINANCE] WebSocket closed. Reconnecting in 5s...');
    setTimeout(connectBinance, 5000);
  });
}

process.on('SIGINT', () => {
  stopping = true;
  try { binanceWs?.close(); } catch (_) {}
  try { polyWs?.close(); } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopping = true;
  try { binanceWs?.close(); } catch (_) {}
  try { polyWs?.close(); } catch (_) {}
  process.exit(0);
});

console.log('[ORACLE] BTC + Polymarket OBI Hub v5 Online.');
console.log(`[ORACLE] BTC threshold=${fmtPct(CONFIG.triggerThreshold)} persistence=${CONFIG.persistenceMs}ms minPersist=${fmtPct(CONFIG.persistenceMinPct)}`);
console.log(`[ORACLE] Poly lag rule: polyMove <= btcMove * ${CONFIG.polyMoveWeight}`);
console.log(`[ORACLE] OBI threshold=${CONFIG.obiThreshold} minDepth=$${CONFIG.minDepthUsd} execDepth=$${CONFIG.execDepthUsd} maxSpread=$${CONFIG.maxSpread}`);
console.log(`[ORACLE] UP token=${shortId(CONFIG.upTokenId)} DOWN token=${shortId(CONFIG.downTokenId)}`);

connectPolymarket();
connectBinance();
