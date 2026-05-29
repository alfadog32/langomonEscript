'use strict';

/**
 * Polymarket MoneyMaker V3 - Research + Paper Execution Engine
 * ------------------------------------------------------------
 * Serious paper-first EV hunting system for Polymarket public data.
 *
 * What it does:
 * - Discovers active CLOB-tradable Polymarket markets through Gamma events.
 * - Reads public CLOB order books through REST.
 * - Optionally subscribes to the public CLOB market WebSocket for faster refresh triggers.
 * - Runs multiple strategy modules that produce normalized trading signals.
 * - Applies a centralized risk engine before paper execution.
 * - Tracks paper fills, inventory, equity, drawdown, strategy P&L, adverse selection, and state.
 *
 * What it does NOT do:
 * - It does not place real orders.
 * - It does not use private keys.
 * - It does not guarantee profit.
 *
 * Requirements:
 * - Node.js 18+.
 * - Optional WebSocket: npm install ws
 *
 * Run:
 * npm install ws
 * node moneymaker_v3.js
 *
 * Safer test:
 * INITIAL_CASH=10000 BASE_ORDER_USD=10 MAX_POSITION_USD=100 node moneymaker_v3.js
 *
 * Aggressive paper research:
 * HUNTER_MODE=true ENABLE_WS=true MAX_MARKETS=25 BASE_ORDER_USD=20 node moneymaker_v3.js
 */

// =========================
// OPTIONAL WEBSOCKET
// =========================

let WebSocketImpl = null;
try {
  // Prefer the `ws` package over Node's built-in WebSocket so close/error
  // events are easier to inspect under PM2.
  WebSocketImpl = require('ws');
} catch {
  WebSocketImpl = globalThis.WebSocket || null;
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnvFile();

// =========================
// CONFIG
// =========================

const CONFIG = {
  gammaBaseUrl: envStr('GAMMA_BASE_URL', 'https://gamma-api.polymarket.com'),
  clobBaseUrl: envStr('CLOB_BASE_URL', 'https://clob.polymarket.com'),
  clobWsUrl: envStr('CLOB_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),

  // WebSocket is useful for speed, but REST polling is more reliable while
  // debugging. Turn it on from .env with ENABLE_WS=true after WS is stable.
  enableWs: envBool('ENABLE_WS', false),
  wsHeartbeatEnabled: envBool('WS_HEARTBEAT_ENABLED', true),
  wsHeartbeatMs: envInt('WS_HEARTBEAT_MS', 10_000),
  wsReconnectInitialMs: envInt('WS_RECONNECT_INITIAL_MS', 5_000),
  wsReconnectMaxMs: envInt('WS_RECONNECT_MAX_MS', 60_000),
  saveState: envBool('SAVE_STATE', true),
  stateFile: envStr('STATE_FILE', path.join(process.cwd(), 'moneymaker_v3_state.json')),

  initialCash: envNum('INITIAL_CASH', 250),

  eventLimit: envInt('EVENT_LIMIT', 100),
  eventPages: envInt('EVENT_PAGES', 2),
  maxMarkets: envInt('MAX_MARKETS', 20),
  maxOutcomesPerMarket: envInt('MAX_OUTCOMES_PER_MARKET', 2),
  marketRefreshEveryCycles: envInt('REFRESH_RESEARCH_EVERY', 10),

  minLiquidity: envNum('MIN_LIQUIDITY', 500),
  minVolume24h: envNum('MIN_VOLUME_24H', 50),
  minBestBid: envNum('MIN_BEST_BID', 0.02),
  maxBestAsk: envNum('MAX_BEST_ASK', 0.98),
  maxSpread: envNum('MAX_SPREAD', 0.18),

  hunterMode: envBool('HUNTER_MODE', true),
  hunterMaxSpread: envNum('HUNTER_MAX_SPREAD', 0.22),
  hunterMinTopDepthUsd: envNum('HUNTER_MIN_TOP_DEPTH_USD', 5),
  hunterMaxTopDepthUsd: envNum('HUNTER_MAX_TOP_DEPTH_USD', 4_000),

  baseOrderUsd: envNum('BASE_ORDER_USD', 25),
  minOrderUsd: envNum('MIN_ORDER_USD', 3),
  maxPositionUsdPerAsset: envNum('MAX_POSITION_USD', 200),
  maxMarketExposureUsd: envNum('MAX_MARKET_EXPOSURE_USD', 350),
  maxTotalExposureUsd: envNum('MAX_TOTAL_EXPOSURE_USD', 1_500),
  maxTotalOpenOrderUsd: envNum('MAX_TOTAL_OPEN_ORDER_USD', 1_000),
  maxOpenOrders: envInt('MAX_OPEN_ORDERS', 250),
  maxDrawdownPct: envNum('MAX_DRAWDOWN_PCT', 12),

  // Practical revenue/risk optimization controls.
  // These keep the paper engine realistic: no instant fantasy fills, no unlimited bags.
  stopLossPct: envNum('STOP_LOSS_PCT', 8),
  takeProfitPct: envNum('TAKE_PROFIT_PCT', 18),
  enableTakeProfit: envBool('ENABLE_TAKE_PROFIT', true),
  maxAdverseMovePct: envNum('MAX_ADVERSE_MOVE_PCT', 4),
  partialFillDepthFraction: envNum('PARTIAL_FILL_DEPTH_FRACTION', 0.35),
  minFillUsd: envNum('MIN_FILL_USD', 1),
  liquidityConsumedLimitPct: envNum('LIQUIDITY_CONSUMED_LIMIT_PCT', 0.20),
  liquidityDecayPower: envNum('LIQUIDITY_DECAY_POWER', 6.0),

  // Ghost mode records would-be orders and checks where the midpoint moved later.
  // This helps calibrate quote offsets without pretending every order fills.
  enableGhostMode: envBool('ENABLE_GHOST_MODE', true),
  ghostHorizonMs: envInt('GHOST_HORIZON_MS', 60_000),
  ghostMaxRecords: envInt('GHOST_MAX_RECORDS', 500),

  // 1) Order-book imbalance signals.
  enableImbalanceSignals: envBool('ENABLE_IMBALANCE_SIGNALS', true),
  imbalanceDepthLevels: envInt('IMBALANCE_DEPTH_LEVELS', 3),
  imbalanceStrongThreshold: envNum('IMBALANCE_STRONG_THRESHOLD', 0.25),
  imbalanceBalancedThreshold: envNum('IMBALANCE_BALANCED_THRESHOLD', 0.12),

  // 2) Adaptive position sizing.
  enableAdaptiveSizing: envBool('ENABLE_ADAPTIVE_SIZING', true),
  adaptiveMinSizeMultiplier: envNum('ADAPTIVE_MIN_SIZE_MULTIPLIER', 0.35),
  adaptiveMaxSizeMultiplier: envNum('ADAPTIVE_MAX_SIZE_MULTIPLIER', 1.35),
  adaptiveGhostPenalty: envNum('ADAPTIVE_GHOST_PENALTY', 0.65),

  // 3) Whale tracking hook. This reads public/externally collected whale events
  // from a local JSON file if you wire one in. It never invents whale data.
  enableWhaleTracking: envBool('ENABLE_WHALE_TRACKING', true),
  whaleEventsFile: envStr('WHALE_EVENTS_FILE', path.join(process.cwd(), 'whale_events.json')),
  whaleLookbackMs: envInt('WHALE_LOOKBACK_MS', 120_000),
  whaleMinUsd: envNum('WHALE_MIN_USD', 5_000),
  whaleAlignmentBoost: envNum('WHALE_ALIGNMENT_BOOST', 0.12),
  whaleDataApiUrl: envStr('WHALE_DATA_API_URL', 'https://data-api.polymarket.com'),
  whaleWallets: envList('WHALE_WALLETS', []),
  whalePollMs: envInt('WHALE_POLL_MS', 30_000),
  whaleApiTimeoutMs: envInt('WHALE_API_TIMEOUT_MS', 8_000),
  whaleTradesLimit: envInt('WHALE_TRADES_LIMIT', 50),
  whaleBatchSize: envInt('WHALE_BATCH_SIZE', 3),
  whaleBatchDelayMs: envInt('WHALE_BATCH_DELAY_MS', 1_000),
  enableWhaleCopyStrategy: envBool('ENABLE_WHALE_COPY_STRATEGY', true),
  whaleCopyFreshMs: envInt('WHALE_COPY_FRESH_MS', 30_000),
  whaleCopyBaseMultiplier: envNum('WHALE_COPY_BASE_MULTIPLIER', 0.4),
  whaleCopyWhaleFraction: envNum('WHALE_COPY_WHALE_FRACTION', 0.15),

  // Multi-view consensus gate. This is the reports.js idea rebuilt with real
  // MoneyMaker data instead of random fake scouts or a second wallet engine.
  enableConsensus: envBool('ENABLE_CONSENSUS', true),
  consensusThreshold: envNum('CONSENSUS_THRESHOLD', 0.68),
  consensusLogRejected: envBool('CONSENSUS_LOG_REJECTED', false),
  consensusBoostMax: envNum('CONSENSUS_BOOST_MAX', 1.15),
  consensusPenaltyMin: envNum('CONSENSUS_PENALTY_MIN', 0.70),
  consensusStableMaxSpread: envNum('CONSENSUS_STABLE_MAX_SPREAD', 0.12),
  consensusTrendMovePct: envNum('CONSENSUS_TREND_MOVE_PCT', 0.035),
  consensusSniperSizeMultiplier: envNum('CONSENSUS_SNIPER_SIZE_MULTIPLIER', 0.65),
  consensusMakerBoost: envNum('CONSENSUS_MAKER_BOOST', 1.05),
  targetWalletHandle: envStr('TARGET_WALLET_HANDLE', 'gabagool22'),
  targetWalletMode: envBool('TARGET_WALLET_MODE', true),
  targetWalletDisplacementPct: envNum('TARGET_WALLET_DISPLACEMENT_PCT', 0.015),
  makerSpreadMultiplier: envNum('MAKER_SPREAD_MULTIPLIER', 1.2),

  minSignalEdge: envNum('MIN_SIGNAL_EDGE', 0.008),
  minConfidence: envNum('MIN_CONFIDENCE', 0.45),
  slippageBuffer: envNum('SLIPPAGE_BUFFER', 0.004),
  adverseSelectionBuffer: envNum('ADVERSE_SELECTION_BUFFER', 0.006),

  quoteEdgeTicks: envInt('QUOTE_EDGE_TICKS', 1),
  orderTtlMs: envInt('ORDER_TTL_MS', 45_000),
  maxHoldMs: envInt('MAX_HOLD_MS', 20 * 60_000),

  loopDelayMs: envInt('LOOP_DELAY_MS', 6_000),
  wsDebounceMs: envInt('WS_DEBOUNCE_MS', 250),
  reportEveryCycles: envInt('REPORT_EVERY_CYCLES', 3),

  historyLookback: envInt('HISTORY_LOOKBACK', 30),
  volatilityTripPct: envNum('VOL_TRIP_PCT', 12),
  // Binary markets can move violently. Keep cooldown short, but make edge demands
  // stricter while volatility is elevated.
  volatilityCooldownMs: envInt('VOL_COOLDOWN_MS', 5_000),
  volatilityEdgeMultiplier: envNum('VOL_EDGE_MULTIPLIER', 1.75),
  quoteDuringVolatility: envBool('QUOTE_DURING_VOL', false),

  complementArbEnabled: envBool('STRAT_COMPLEMENT_ARB', true),
  spreadHunterEnabled: envBool('STRAT_SPREAD_HUNTER', true),
  inventoryExitEnabled: envBool('STRAT_INVENTORY_EXIT', true),
  tailEndEnabled: envBool('STRAT_TAIL_END', true),

  complementArbMinEdge: envNum('COMPLEMENT_ARB_MIN_EDGE', 0.012),
  spreadHunterMinEdge: envNum('SPREAD_HUNTER_MIN_EDGE', 0.01),
  tailEndHours: envNum('TAIL_END_HOURS', 36),
  tailEndMinConfidence: envNum('TAIL_END_MIN_CONFIDENCE', 0.58),
};

// =========================
// ENV HELPERS
// =========================

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

      if (        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  } catch (e) {
    console.warn(`[ENV] Failed to load .env file: ${e.message}`);
  }
}

function envStr(name, fallback) {
  return process.env[name] ?? fallback;
}

function envNum(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).toLowerCase());
}

function envList(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// =========================
// LOGGING
// =========================

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);
const errlog = (m) => log('ERROR', m);

// =========================
// HTTP CLIENT
// =========================

class HttpClient {
  constructor({ timeoutMs = 12_000, retries = 2 } = {}) {
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  async getJson(url) {
    let lastErr;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'moneymaker-v3-paper-bot/1.0',
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok) {
          const text = await safeText(res);
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 240)}`);
        }

        return await res.json();
      } catch (e) {
        clearTimeout(timeout);
        lastErr = e;
        if (attempt < this.retries) {
          await sleep(350 * (attempt + 1));
        }
      }
    }

    throw lastErr;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// =========================
// POLYMARKET PUBLIC CLIENT
// =========================

class PolymarketPublicClient {
  constructor(config) {
    this.config = config;
    this.http = new HttpClient();
  }

  async fetchActiveEvents() {
    const all = [];

    for (let page = 0; page < this.config.eventPages; page++) {
      const url = new URL('/events', this.config.gammaBaseUrl);
      url.searchParams.set('active', 'true');
      url.searchParams.set('closed', 'false');
      url.searchParams.set('order', 'volume_24hr');
      url.searchParams.set('ascending', 'false');
      url.searchParams.set('limit', String(this.config.eventLimit));
      url.searchParams.set('offset', String(page * this.config.eventLimit));

      const data = await this.http.getJson(url.toString());
      if (!Array.isArray(data)) {
        throw new Error('Unexpected Gamma /events response; expected an array');
      }

      all.push(...data);
      await sleep(100);
    }

    return all;
  }

  extractTradableMarkets(events) {
    const markets = [];

    for (const event of events) {
      const eventTitle = event.title || event.question || event.slug || `event:${event.id || 'unknown'}`;
      const eventMarkets = Array.isArray(event.markets) ? event.markets : [];

      for (const market of eventMarkets) {
        if (!isMarketTradable(market)) continue;

        const outcomes = parseMaybeJsonArray(market.outcomes);
        const tokenIds = parseMaybeJsonArray(market.clobTokenIds || market.clob_token_ids || market.tokenIds);
        const outcomePrices = parseMaybeJsonArray(market.outcomePrices || market.outcome_prices);

        if (!Array.isArray(tokenIds) || tokenIds.length === 0) continue;

        const liquidity = firstFinite(
          market.liquidityNum,
          market.liquidity_num,
          market.liquidity,
          market.orderBookLiquidity
        );

        const volume24h = firstFinite(
          market.volume24hr,
          market.volume_24hr,
          market.volume24h,
          market.volume_24h,
          market.volumeNum,
          market.volume
        );

        if (liquidity < this.config.minLiquidity) continue;
        if (volume24h < this.config.minVolume24h) continue;

        markets.push({
          marketId: String(market.id || market.conditionId || market.condition_id || crypto.randomUUID()),
          conditionId: String(market.conditionId || market.condition_id || ''),
          question: market.question || market.title || eventTitle,
          marketSlug: market.slug || '',
          eventTitle,
          eventSlug: event.slug || '',
          category: event.category || market.category || '',
          endDate: market.endDate || market.end_date_iso || market.endDateIso || event.endDate || event.end_date_iso || '',
          liquidity,
          volume24h,
          competitive: Boolean(market.competitive),
          restricted: Boolean(market.restricted || event.restricted),
          raw: market,
          outcomes: tokenIds.map((tokenId, i) => ({
            tokenId: String(tokenId),
            outcome: String(outcomes?.[i] || `Outcome ${i + 1}`),
            indicativePrice: toNum(outcomePrices?.[i], NaN),
          })),
        });
      }
    }

    return markets;
  }

  async getOrderBook(tokenId) {
    const url = new URL('/book', this.config.clobBaseUrl);
    url.searchParams.set('token_id', String(tokenId));

    const raw = await this.http.getJson(url.toString());
    return normalizeBook(raw, tokenId);
  }
}

function isMarketTradable(market) {
  const active = market.active !== false;
  const closed = market.closed === true;
  const archived = market.archived === true;
  const enableOrderBook =
    market.enableOrderBook === true ||
    market.enable_order_book === true ||
    market.enableOrderBook === 'true' ||
    market.enable_order_book === 'true';

  return active && !closed && !archived && enableOrderBook;
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
};

function normalizeBook(raw, fallbackAssetId = '') {
  const bids = normalizeLevels(raw?.bids, 'bid');
  const asks = normalizeLevels(raw?.asks, 'ask');

  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? toNum(raw?.best_bid ?? raw?.bestBid, NaN);
  const bestAsk = asks[0]?.price ?? toNum(raw?.best_ask ?? raw?.bestAsk, NaN);
  const safeBestBid = Number.isFinite(bestBid) ? bestBid : null;
  const safeBestAsk = Number.isFinite(bestAsk) ? bestAsk : null;
  const midpoint = safeBestBid !== null && safeBestAsk !== null ? (safeBestBid + safeBestAsk) / 2 : null;
  const spread = safeBestBid !== null && safeBestAsk !== null ? safeBestAsk - safeBestBid : null;

  return {
    assetId: String(raw?.asset_id || raw?.assetId || fallbackAssetId || ''),
    market: String(raw?.market || ''),
    timestamp: String(raw?.timestamp || ''),
    bids,
    asks,
    bestBid: safeBestBid,
    bestAsk: safeBestAsk,
    midpoint,
    spread,
    minOrderSize: toNum(raw?.min_order_size ?? raw?.minOrderSize, 5),
    tickSize: toNum(raw?.tick_size ?? raw?.tickSize, 0.01),
    lastTradePrice: toNum(raw?.last_trade_price ?? raw?.lastTradePrice, NaN),
    cachedAt: Date.now(),
  };
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];

  return levels
    .map((x) => ({
      price: toNum(x.price, NaN),
      size: toNum(x.size, NaN),
      side,
    }))
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0);
}

// =========================
// MARKET CACHE
// =========================

class MarketCache {
  constructor(poly) {
    this.poly = poly;
    this.books = new Map();
    this.marketsById = new Map();
    this.assetsByToken = new Map();
  }

  setCandidates(assets) {
    this.marketsById.clear();
    this.assetsByToken.clear();

    for (const asset of assets) {
      this.assetsByToken.set(asset.tokenId, asset);
      this.marketsById.set(asset.market.marketId, asset.market);
    }
  }

  getAsset(tokenId) {
    return this.assetsByToken.get(String(tokenId));
  }

  getMarketAssets(marketId) {
    return [...this.assetsByToken.values()].filter((asset) => asset.market.marketId === marketId);
  }

  setBook(tokenId, book) {
    if (!book) return;
    book.cachedAt = Date.now();
    this.books.set(String(tokenId), book);
  }

  getBook(tokenId) {
    return this.books.get(String(tokenId));
  }

  async getFreshBook(tokenId, maxAgeMs = 1_500) {
    const cached = this.getBook(tokenId);
    if (cached && Date.now() - (cached.cachedAt || 0) <= maxAgeMs && cached.midpoint !== null) {
      return cached;
    }

    const book = await this.poly.getOrderBook(tokenId);
    this.setBook(tokenId, book);
    return book;
  }

  markPrices() {
    const map = new Map();
    for (const [tokenId, book] of this.books.entries()) {
      if (Number.isFinite(book.midpoint)) {
        map.set(tokenId, book.midpoint);
      }
    }
    return map;
  }
}

// =========================
// PUBLIC CLOB WEBSOCKET
// =========================

class CLOBWebSocketClient {
  constructor({ url, onMessage, config = CONFIG }) {
    this.url = url;
    this.onMessage = onMessage;
    this.config = config;
    this.ws = null;
    this.assetIds = new Set();
    this.connected = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectDelayMs = config.wsReconnectInitialMs || 5_000;
  }

  connect() {
    if (!WebSocketImpl) {
      warn('WebSocket disabled: install optional dependency with `npm install ws`.');
      return;
    }

    if (this.ws && [WebSocketImpl.OPEN, WebSocketImpl.CONNECTING].includes(this.ws.readyState)) {
      return;
    }

    this.ws = new WebSocketImpl(this.url);

    if (typeof this.ws.on === 'function') {
      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleRawMessage(data));
      this.ws.on('error', (e) => warn(`CLOB WS error: ${formatWsError(e)}`));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));
    } else {
      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleRawMessage(event.data);
      this.ws.onerror = (event) => warn(`CLOB WS error: ${formatWsError(event)}`);
      this.ws.onclose = (event) => this.handleClose(event?.code, event?.reason);
    }
  }

  handleOpen() {
    if (this.connected) return;
    this.connected = true;
    this.reconnectDelayMs = this.config.wsReconnectInitialMs || 5_000;
    info('CLOB WebSocket connected.');
    this.resubscribe();
    this.startPing();
  }

  handleClose(code, reason) {
    this.connected = false;
    this.stopPing();
    clearTimeout(this.reconnectTimer);

    const cleanReason = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
    warn(`CLOB WS closed: code=${code ?? 'unknown'} reason=${cleanReason || 'none'} reconnectMs=${this.reconnectDelayMs}`);

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.config.wsReconnectMaxMs || 60_000,
      Math.floor(this.reconnectDelayMs * 1.5)
    );

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  startPing() {
    this.stopPing();
    if (!this.config.wsHeartbeatEnabled) return;

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocketImpl.OPEN) {
        try {
          this.ws.send('PING');
        } catch (e) {
          warn(`WS ping failed: ${e.message}`);
        }
      }
    }, this.config.wsHeartbeatMs || 10_000);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  subscribe(assetIds) {
    const ids = Array.isArray(assetIds) ? assetIds : [assetIds];
    let changed = false;

    for (const id of ids) {
      if (!id) continue;
      const s = String(id);
      if (!this.assetIds.has(s)) {
        this.assetIds.add(s);
        changed = true;
      }
    }

    if (changed) this.resubscribe();
  }

  resubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocketImpl.OPEN) return;
    const ids = [...this.assetIds];
    if (ids.length === 0) return;

    for (const chunk of chunks(ids, 100)) {
      this.ws.send(JSON.stringify({
        assets_ids: chunk,
        type: 'market',
        custom_feature_enabled: true,
      }));
    }

    info(`CLOB WS subscribed to ${ids.length} asset ids.`);
  }

  handleRawMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (!text || text === 'PONG') return;

    if (text.startsWith('INVALID OPERATION')) {
      warn(`CLOB WS protocol warning: ${text}`);
      return;
    }

    try {
      const parsed = JSON.parse(text);
      const messages = Array.isArray(parsed) ? parsed : [parsed];

      for (const msg of messages) {
        this.onMessage(msg);
      }
    } catch (e) {
      warn(`CLOB WS parse error: ${e.message}`);
    }
  }
}

// =========================
// RESEARCH ENGINE
// =========================

class ResearchEngine {
  constructor(poly, cache, config) {
    this.poly = poly;
    this.cache = cache;
    this.config = config;
  }

  async discoverCandidates() {
    info('Research refresh: fetching active events and books...');

    const events = await this.poly.fetchActiveEvents();
    const markets = this.poly.extractTradableMarkets(events);
    const assets = [];

    for (const market of markets) {
      const outcomes = market.outcomes.slice(0, this.config.maxOutcomesPerMarket);

      for (const outcome of outcomes) {
        try {
          const book = await this.poly.getOrderBook(outcome.tokenId);
          this.cache.setBook(outcome.tokenId, book);

          const scored = this.scoreAsset(market, outcome, book);
          if (scored) assets.push(scored);
        } catch (e) {
          warn(`Skipping book for ${shortId(outcome.tokenId)}: ${e.message}`);
        }

        await sleep(60);
      }
    }

    assets.sort((a, b) => b.score - a.score);
    const selected = assets.slice(0, this.config.maxMarkets);
    this.cache.setCandidates(selected);

    info(`Research selected ${selected.length} assets from ${assets.length} scored assets.`);
    for (const a of selected.slice(0, 10)) {
      info(
        `SELECT score=${a.score.toFixed(1)} ${a.outcome.padEnd(8)} ` +
        `bid=${fmtPrice(a.book.bestBid)} ask=${fmtPrice(a.book.bestAsk)} spread=${fmtPrice(a.book.spread)} ` +
        `liq=$${a.market.liquidity.toFixed(0)} vol24h=$${a.market.volume24h.toFixed(0)} :: ${a.market.question.slice(0, 90)}`
      );
    }

    return selected;
  }

  scoreAsset(market, outcome, book) {
    if (!isBookComplete(book)) return null;
    if (book.bestBid < this.config.minBestBid) return null;
    if (book.bestAsk > this.config.maxBestAsk) return null;

    const maxSpread = this.config.hunterMode ? this.config.hunterMaxSpread : this.config.maxSpread;
    if (book.spread <= 0 || book.spread > maxSpread) return null;

    const topBid1Usd = topDepthUsd(book.bids, 1);
    const topAsk1Usd = topDepthUsd(book.asks, 1);
    const topBid3Usd = topDepthUsd(book.bids, 3);
    const topAsk3Usd = topDepthUsd(book.asks, 3);
    const topOneSideUsd = Math.min(topBid1Usd, topAsk1Usd);
    const topDepthTotalUsd = topBid1Usd + topAsk1Usd;

    if (topOneSideUsd < this.config.hunterMinTopDepthUsd) return null;
    if (topDepthTotalUsd > this.config.hunterMaxTopDepthUsd) return null;

    const balance = Math.min(topBid3Usd, topAsk3Usd) / Math.max(1, Math.max(topBid3Usd, topAsk3Usd));
    const agePenalty = endingSoonPenalty(market.endDate);
    const extremePenalty = priceExtremePenalty(book.midpoint);

    let score;
    if (this.config.hunterMode) {
      const spreadScore = book.spread * 1000;
      const shallowBookBonus = Math.max(0, 140 - topDepthTotalUsd / 10);
      const volumeSanity = Math.min(70, Math.log10(1 + market.volume24h) * 17);
      const liquiditySanity = Math.min(50, Math.log10(1 + market.liquidity) * 11);
      const balanceScore = balance * 30;
      const tooWidePenalty = book.spread > 0.14 ? (book.spread - 0.14) * 700 : 0;

      score = spreadScore + shallowBookBonus + volumeSanity + liquiditySanity + balanceScore - extremePenalty - tooWidePenalty - agePenalty;
    } else {
      const liquidityScore = Math.log10(1 + market.liquidity) * 18;
      const volumeScore = Math.log10(1 + market.volume24h) * 14;
      const spreadScore = Math.min(45, book.spread * 500);
      const balanceScore = balance * 20;

      score = liquidityScore + volumeScore + spreadScore + balanceScore - extremePenalty - agePenalty;
    }

    return {
      assetKey: `${market.marketId}:${outcome.tokenId}`,
      market,
      outcome: outcome.outcome,
      tokenId: outcome.tokenId,
      book,
      score,
      topBidDepthUsd: topBid3Usd,
      topAskDepthUsd: topAsk3Usd,
      topDepthTotalUsd,
      discoveredAt: Date.now(),
    };
  }
}

function isBookComplete(book) {
  return Boolean(
    book &&
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    Number.isFinite(book.midpoint) &&
    Number.isFinite(book.spread) &&
    book.bestBid > 0 &&
    book.bestAsk > 0 &&
    book.bestBid < book.bestAsk
  );
}

function topDepthUsd(levels, n) {
  return (levels || []).slice(0, n).reduce((sum, level) => sum + level.price * level.size, 0);
}

function estimateLiquidityConsumption(book, side, sizeUsd, config = CONFIG) {
  if (!book || !Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return { consumedPct: 1, penalty: 0, topDepthUsd: 0 };
  }

  // For maker buys, queue/competition is best approximated by bid-side depth.
  // For maker sells, queue/competition is best approximated by ask-side depth.
  const depthUsd = side === 'buy'
    ? topDepthUsd(book.bids, 3)
    : topDepthUsd(book.asks, 3);

  const consumedPct = depthUsd > 0 ? sizeUsd / depthUsd : 1;
  const limit = Math.max(0.01, config.liquidityConsumedLimitPct || 0.20);

  // Above the limit, assume fill probability decays exponentially instead of
  // pretending the whole order gets equal queue priority.
  const excess = Math.max(0, consumedPct - limit);
  const penalty = excess <= 0
    ? 1
    : Math.exp(-excess * (config.liquidityDecayPower || 6.0));

  return {
    consumedPct,
    penalty: clamp(penalty, 0.05, 1),
    topDepthUsd: depthUsd,
  };
}

function computeOrderBookImbalance(book, levels = CONFIG.imbalanceDepthLevels) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    return { bidDepthUsd: 0, askDepthUsd: 0, imbalance: 0, direction: 'unknown', usable: false };
  }

  const bidDepthUsd = topDepthUsd(book.bids, levels);
  const askDepthUsd = topDepthUsd(book.asks, levels);
  const total = bidDepthUsd + askDepthUsd;
  const imbalance = total > 0 ? (bidDepthUsd - askDepthUsd) / total : 0;

  let direction = 'balanced';
  if (imbalance >= CONFIG.imbalanceStrongThreshold) direction = 'bid_heavy';
  if (imbalance <= -CONFIG.imbalanceStrongThreshold) direction = 'ask_heavy';

  return {
    bidDepthUsd,
    askDepthUsd,
    imbalance,
    direction,
    usable: total > 0,
  };
}

function priceExtremePenalty(mid) {
  if (!Number.isFinite(mid)) return 100;
  if (mid > 0.12 && mid < 0.88) return 0;
  if (mid > 0.05 && mid < 0.95) return 8;
  return 25;
}

function endingSoonPenalty(endDate) {
  const ms = msUntil(endDate);
  if (!Number.isFinite(ms)) return 0;
  if (ms < 2 * 60 * 60 * 1000) return 40;
  if (ms < 8 * 60 * 60 * 1000) return 15;
  return 0;
}

// =========================
// STRATEGY SIGNALS
// =========================

class Signal {
  constructor({
    strategy,
    tokenId,
    marketId,
    side,
    price,
    sizeUsd,
    expectedEdge,
    confidence,
    reason,
    exitPlan,
    ttlMs,
    maxHoldMs,
    metadata: {},
  }) {
    this.id = crypto.randomUUID();
    this.strategy = strategy;
    this.tokenId = String(tokenId);
    this.marketId = String(marketId || '');
    this.side = side;
    this.price = price;
    this.sizeUsd = sizeUsd;
    this.expectedEdge = expectedEdge;
    this.confidence = confidence;
    this.reason = reason;
    this.exitPlan = exitPlan;
    this.ttlMs = ttlMs;
    this.maxHoldMs = maxHoldMs;
    this.metadata = metadata;
    this.createdAt = Date.now();
  }
}

class Strategy {
  constructor(name, config, cache, portfolio, volGuard) {
    this.name = name;
    this.config = config;
    this.cache = cache;
    this.portfolio = portfolio;
    this.volGuard = volGuard;
  }

  async generate() {
    return [];
  }
}

class SpreadHunterStrategy extends Strategy {
  constructor(...args) {
    super('SpreadHunter', ...args);
  }

  async generate(asset, book) {
    if (!this.config.spreadHunterEnabled) return [];
    if (!isBookComplete(book)) return [];

    const tick = book.tickSize || 0.01;
    const mark = book.midpoint;
    const spread = book.spread;

    if (spread < this.config.spreadHunterMinEdge) return [];
    if (this.volGuard.isTripped(asset.tokenId) && !this.config.quoteDuringVolatility) return [];

    const posUsd = this.portfolio.positionUsd(asset.tokenId, mark);
    const invRatio = clamp(posUsd / this.config.maxPositionUsdPerAsset, -1, 1);
    const exponentialSkew = Math.pow(invRatio, 3) * 0.02;

    const volMultiplier = this.volGuard.getVolMultiplier(asset.tokenId);
    const half = Math.max(tick, (spread * 0.5) * volMultiplier);

    let bid = mark - half / 2 - exponentialSkew;
    let ask = mark + half / 2 - exponentialSkew;

    bid = Math.min(bid, book.bestAsk - tick);
    ask = Math.max(ask, book.bestBid + tick);

    bid = clamp(roundToTick(bid, tick), 0.01, 0.99);
    ask = clamp(roundToTick(ask, tick), 0.01, 0.99);

    // Boundary protection: inventory skew can shift the whole band. If bid/ask
    // collapse into each other, back away instead of creating impossible quotes.
    if (bid >= ask) {
      bid = clamp(roundToTick(mark - tick, tick), 0.01, 0.99);
      ask = clamp(roundToTick(mark + tick, tick), 0.01, 0.99);
    }
    if (!(bid < ask)) return [];

    let baseUsd = this.config.baseOrderUsd;
    if (this.config.hunterMode && spread > 0.08) {
      const dangerScale = clamp(1 - ((spread - 0.08) / 0.14), 0.25, 1);
      baseUsd *= dangerScale;
    }

    const buyUsd = Math.max(0, baseUsd * (1 - Math.max(0, invRatio)));
    const sellUsd = Math.max(0, baseUsd * (1 + Math.min(0, invRatio)));

    const buyLiquidity = estimateLiquidityConsumption(book, 'buy', buyUsd || this.config.baseOrderUsd, this.config);
    const sellLiquidity = estimateLiquidityConsumption(book, 'sell', sellUsd || this.config.baseOrderUsd, this.config);
    const worstLiquidityPenalty = Math.max(buyLiquidity.penalty, sellLiquidity.penalty);
    const volatilityEdgeMultiplier = this.volGuard.isTripped(asset.tokenId)
      ? this.config.volatilityEdgeMultiplier
      : 1;

    const edgeEstimate = Math.max(
      0,
      ((ask - bid) / 2 - this.config.slippageBuffer - this.config.adverseSelectionBuffer) * worstLiquidityPenalty
    );

    const requiredEdge = this.config.minSignalEdge * volatilityEdgeMultiplier;
    if (edgeEstimate < requiredEdge) return [];

    const confidence = clamp(0.35 + spread * 2 + Math.log10(1 + asset.market.volume24h) / 20, 0, 0.85);

    const signals = [];

    if (buyUsd >= this.config.minOrderUsd) {
      signals.push(new Signal({
        strategy: this.name,
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'buy',
        price: bid,
        sizeUsd: buyUsd,
        expectedEdge: edgeEstimate,
        confidence,
        reason: `Wide spread hunter: spread=${fmtPrice(spread)}, inv=${(invRatio * 100).toFixed(1)}%, liqUse=${(buyLiquidity.consumedPct * 100).toFixed(1)}%`,
        exitPlan: `Exit near ask ${fmtPrice(ask)} or stale/hold timeout`,
        ttlMs: this.config.orderTtlMs,
        maxHoldMs: this.config.maxHoldMs,
        metadata: {
          askTarget: ask,
          marketQuestion: asset.market.question,
          outcome: asset.outcome,
          liquidityConsumedPct: buyLiquidity.consumedPct,
          liquidityPenalty: buyLiquidity.penalty,
          entryMid: mark,
        },
      }));
    }

    if (sellUsd >= this.config.minOrderUsd && this.portfolio.position(asset.tokenId) > 0) {
      signals.push(new Signal({
        strategy: this.name,
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'sell',
        price: ask,
        sizeUsd: sellUsd,
        expectedEdge: edgeEstimate,
        confidence,
        reason: `Inventory/spread sell: spread=${fmtPrice(spread)}, inv=${(invRatio * 100).toFixed(1)}%, liqUse=${(sellLiquidity.consumedPct * 100).toFixed(1)}%`,
        exitPlan: 'Reduce inventory at wide spread',
        ttlMs: this.config.orderTtlMs,
        maxHoldMs: this.config.maxHoldMs,
        metadata: {
          bidTarget: bid,
          marketQuestion: asset.market.question,
          outcome: asset.outcome,
          liquidityConsumedPct: sellLiquidity.consumedPct,
          liquidityPenalty: sellLiquidity.penalty,
          entryMid: mark,
        },
      }));
    }

    return signals;
  }
}

class InventoryExitStrategy extends Strategy {
  constructor(...args) {
    super('InventoryExit', ...args);
  }

  async generate(asset, book) {
    if (!this.config.inventoryExitEnabled) return [];
    if (!isBookComplete(book)) return [];

    const qty = this.portfolio.position(asset.tokenId);
    if (qty <= 0) return [];

    const tick = book.tickSize || 0.01;
    const posUsd = qty * book.midpoint;
    const invRatio = clamp(posUsd / this.config.maxPositionUsdPerAsset, 0, 1);
    if (invRatio < 0.2) return [];

    const ask = clamp(roundToTick(Math.max(book.bestBid + tick, book.bestAsk - tick), tick), 0.01, 0.99);
    const sizeUsd = Math.min(posUsd, this.config.baseOrderUsd * (1 + invRatio));

    return [new Signal({
      strategy: this.name,
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      side: 'sell',
      price: ask,
      sizeUsd,
      expectedEdge: Math.max(0.002, book.spread / 2),
      confidence: clamp(0.55 + invRatio * 0.35, 0, 0.95),
      reason: `Exit inventory: posUsd=$${posUsd.toFixed(2)}, inv=${(invRatio * 100).toFixed(1)}%`,
      exitPlan: 'Reduce existing exposure',
      ttlMs: Math.min(this.config.orderTtlMs, 20_000),
      maxHoldMs: this.config.maxHoldMs,
      metadata: { marketQuestion: asset.market.question, outcome: asset.outcome },
    })];
  }
}

class ComplementArbStrategy extends Strategy {
  constructor(...args) {
    super('ComplementArb', ...args);
  }

  async generate(asset, book) {
    if (!this.config.complementArbEnabled) return [];
    if (!isBookComplete(book)) return [];

    const siblings = this.cache.getMarketAssets(asset.market.marketId);
    if (siblings.length < 2) return [];

    const a = siblings[0];
    const b = siblings[1];
    if (asset.tokenId !== a.tokenId) return []; // emit once per market

    let bookA;
    let bookB;

    try {
      bookA = await this.cache.getFreshBook(a.tokenId);
      bookB = await this.cache.getFreshBook(b.tokenId);
    } catch {
      return [];
    }

    if (!isBookComplete(bookA) || !isBookComplete(bookB)) return [];

    const buyBothCost = bookA.bestAsk + bookB.bestAsk;
    const lockedEdge = 1 - buyBothCost;

    // In a binary market, buying both outcomes below $1 can be a settlement arbitrage.
    // This still needs both sides filled; paper mode treats them separately and tracks strategy.
    if (lockedEdge < this.config.complementArbMinEdge) return [];

    const sizeUsdEach = Math.min(this.config.baseOrderUsd, this.config.maxMarketExposureUsd / 4);
    const confidence = clamp(0.65 + lockedEdge * 8, 0, 0.98);
    const pairId = crypto.randomUUID();

    return [
      new Signal({
        strategy: this.name,
        tokenId: a.tokenId,
        marketId: a.market.marketId,
        side: 'buy',
        price: bookA.bestAsk,
        sizeUsd: sizeUsdEach,
        expectedEdge: lockedEdge / 2,
        confidence,
        reason: `Complement buy arb: askSum=${buyBothCost.toFixed(3)} lockedEdge=${lockedEdge.toFixed(3)}`,
        exitPlan: 'Atomic paper pair: fill both legs together or cancel together',
        ttlMs: Math.min(this.config.orderTtlMs, 15_000),
        maxHoldMs: 24 * 60 * 60_000,
        metadata: { pairId, complementKey: `${a.tokenId}:${b.tokenId}`, leg: 1, marketQuestion: a.market.question, outcome: a.outcome },
      }),
      new Signal({
        strategy: this.name,
        tokenId: b.tokenId,
        marketId: b.market.marketId,
        side: 'buy',
        price: bookB.bestAsk,
        sizeUsd: sizeUsdEach,
        expectedEdge: lockedEdge / 2,
        confidence,
        reason: `Complement buy arb: askSum=${buyBothCost.toFixed(3)} lockedEdge=${lockedEdge.toFixed(3)}`,
        exitPlan: 'Atomic paper pair: fill both legs together or cancel together',
        ttlMs: Math.min(this.config.orderTtlMs, 15_000),
        maxHoldMs: 24 * 60 * 60_000,
        metadata: { pairId, complementKey: `${a.tokenId}:${b.tokenId}`, leg: 2, marketQuestion: b.market.question, outcome: b.outcome },
      }),
    ];
  }
}

class TailEndMispricingStrategy extends Strategy {
  constructor(...args) {
    super('TailEndMispricing', ...args);
  }

  async generate(asset, book) {
    if (!this.config.tailEndEnabled) return [];
    if (!isBookComplete(book)) return [];

    const until = msUntil(asset.market.endDate);
    if (!Number.isFinite(until)) return [];
    if (until <= 0 || until > this.config.tailEndHours * 60 * 60 * 1000) return [];

    const mid = book.midpoint;
    const spread = book.spread;
    const confidence = confidenceFromPrice(mid);

    if (confidence < this.config.tailEndMinConfidence) return [];
    if (spread > 0.08) return [];

    const side = mid > 0.5 ? 'buy' : 'sell';
    if (side === 'sell' && this.portfolio.position(asset.tokenId) <= 0) return [];

    const tick = book.tickSize || 0.01;
    const price = side === 'buy'
      ? clamp(roundToTick(Math.min(book.bestAsk, book.bestBid + tick), tick), 0.01, 0.99)
      : clamp(roundToTick(Math.max(book.bestBid, book.bestAsk - tick), tick), 0.01, 0.99);

    const edge = Math.abs(mid - 0.5) - spread - this.config.slippageBuffer;
    if (edge < this.config.minSignalEdge) return [];

    return [new Signal({
      strategy: this.name,
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      side,
      price,
      sizeUsd: this.config.baseOrderUsd * 0.6,
      expectedEdge: edge,
      confidence: clamp(confidence, 0, 0.9),
      reason: `Tail-end mispricing: ${hoursUntil(asset.market.endDate).toFixed(1)}h left, mid=${fmtPrice(mid)}`,
      exitPlan: 'Exit on spread collapse, confidence reversal, or hold timeout',
      ttlMs: Math.min(this.config.orderTtlMs, 20_000),
      maxHoldMs: Math.min(this.config.maxHoldMs, Math.max(15 * 60_000, until / 3)),
      metadata: { marketQuestion: asset.market.question, outcome: asset.outcome },
    })];
  }
}

class WhaleCopyStrategy extends Strategy {
  constructor(config, cache, portfolio, volGuard, whaleWatcher) {
    super('WhaleCopy', config, cache, portfolio, volGuard);
    this.whaleWatcher = whaleWatcher;
  }

  async generate(asset, book) {
    if (!this.config.enableWhaleTracking || !this.config.enableWhaleCopyStrategy || !this.whaleWatcher) return [];
    if (!isBookComplete(book)) return [];

    const recentWhale = this.whaleWatcher.findRecentForSignal({
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      metadata: { marketQuestion: asset.market.question },
    });

    if (!recentWhale) return [];
    if (Date.now() - recentWhale.timestamp > this.config.whaleCopyFreshMs) return [];

    // Opposite side: provide liquidity to the whale rather than blindly chasing.
    const oppositeSide = recentWhale.side === 'buy' ? 'sell' : 'buy';
    const offsetMultiplier = this.config.makerSpreadMultiplier || 1.2;
    const tick = book.tickSize || 0.01;

    let price;
    if (oppositeSide === 'sell') {
      price = clamp(roundToTick(book.bestAsk + book.spread * offsetMultiplier, tick), 0.01, 0.99);
    } else {
      price = clamp(roundToTick(book.bestBid - book.spread * offsetMultiplier, tick), 0.01, 0.99);
    }

    const sizeUsd = Math.min(
      this.config.baseOrderUsd * this.config.whaleCopyBaseMultiplier,
      recentWhale.sizeUsd * this.config.whaleCopyWhaleFraction
    );

    if (sizeUsd < this.config.minOrderUsd) return [];

    return [new Signal({
      strategy: this.name,
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      side: oppositeSide,
      price,
      sizeUsd,
      expectedEdge: Math.max(this.config.minSignalEdge, book.spread * 0.70),
      confidence: 0.65,
      reason: `Whale ${shortId(recentWhale.wallet || recentWhale.handle)} ${recentWhale.side} $${recentWhale.sizeUsd.toFixed(0)} -> providing ${oppositeSide} liquidity`,
      exitPlan: 'Whale-copy maker liquidity; exit on fill quality deterioration or timeout',
      ttlMs: 25_000,
      maxHoldMs: this.config.maxHoldMs,
      metadata: {
        marketQuestion: asset.market.question,
        outcome: asset.outcome,
        whaleWallet: recentWhale.wallet,
        whaleSide: recentWhale.side,
        whaleSizeUsd: recentWhale.sizeUsd,
        whaleAgeMs: Date.now() - recentWhale.timestamp,
        entryMid: book.midpoint,
      },
    })];
  }
}

function confidenceFromPrice(mid) {
  return Math.abs(mid - 0.5) * 1.6;
}

// =========================
// WHALE WATCHER (ASYNC)
// =========================

class AsyncWhaleWatcher {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.whaleDataApiUrl;
    this.wallets = config.whaleWallets || [];
    this.whaleState = new Map();
    this.events = [];
    this.lastPollMs = 0;
    this.inFlight = false;

    if (config.enableWhaleTracking && this.wallets.length === 0) {
      warn('[WhaleWatcher] Enabled but no WHALE_WALLETS configured. Tracking disabled until wallets are supplied.');
      this.config.enableWhaleTracking = false;
    }
  }

  tick() {
    if (!this.config.enableWhaleTracking || this.wallets.length === 0) return;

    const now = Date.now();
    if (this.inFlight) return;
    if (now - this.lastPollMs < this.config.whalePollMs) return;

    this.lastPollMs = now;
    this.updateWhaleIntel(this.wallets, this.config.whaleMinUsd).catch((e) => {
      warn(`[WhaleOracle] background update failed: ${e.message}`);
    });
  }

  async updateWhaleIntel(wallets, minUsd = this.config.whaleMinUsd) {
    if (!Array.isArray(wallets) || wallets.length === 0) return;
    if (this.inFlight) return;

    this.inFlight = true;

    try {
      const batchSize = Math.max(1, this.config.whaleBatchSize || 3);

      for (let i = 0; i < wallets.length; i += batchSize) {
        const batch = wallets.slice(i, i + batchSize);
        const promises = batch.map((wallet) => this.fetchWalletTrades(wallet, minUsd));
        await Promise.allSettled(promises);

        if (i + batchSize < wallets.length) {
          await sleep(this.config.whaleBatchDelayMs || 1000);
        }
      }

      this.prune();
    } finally {
      this.inFlight = false;
    }
  }

  async fetchWalletTrades(wallet, minUsd) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.whaleApiTimeoutMs);

    try {
      const url = new URL('/trades', this.baseUrl);
      url.searchParams.set('user', wallet);
      url.searchParams.set('limit', String(this.config.whaleTradesLimit));

      const response = await fetch(url.toString(), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const payload = await response.json();
      const trades = Array.isArray(payload) ? payload : payload?.trades || payload?.data || [];
      if (!Array.isArray(trades)) return;

      const normalized = trades
        .map((trade) => this.normalizeTrade(wallet, trade))
        .filter(Boolean)
        .filter((trade) => trade.sizeUsd >= minUsd);

      for (const trade of normalized) {
        this.storeTrade(wallet, trade);
      }
    } catch (error) {
      warn(`[WhaleOracle] Failed to update wallet ${shortId(wallet)}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  normalizeTrade(wallet, trade) {
    if (!trade) return null;

    const price = toNum(trade.price ?? trade.outcomePrice ?? trade.avgPrice, NaN);
    const size = toNum(trade.size ?? trade.shares ?? trade.amount, NaN);
    const directUsd = toNum(trade.sizeUsd ?? trade.usd ?? trade.notionalUsd ?? trade.value, NaN);
    const sizeUsd = Number.isFinite(directUsd)
      ? directUsd
      : Number.isFinite(price) && Number.isFinite(size)
        ? price * size
        : 0;

    const rawTs = trade.timestamp ?? trade.ts ?? trade.time ?? trade.createdAt ?? trade.created_at;
    let timestamp = Number(rawTs);
    if (Number.isFinite(timestamp) && timestamp < 10000000000) timestamp *= 1000;
    if (!Number.isFinite(timestamp)) timestamp = Date.parse(rawTs || '');
    if (!Number.isFinite(timestamp)) timestamp = Date.now();

    const sideRaw = String(trade.side ?? trade.action ?? trade.type ?? '').toLowerCase();
    const side = sideRaw.includes('sell') ? 'sell' : sideRaw.includes('buy') ? 'buy' : sideRaw;

    return {
      handle: wallet,
      wallet,
      tokenId: String(trade.tokenId ?? trade.assetId ?? trade.asset_id ?? trade.conditionTokenId ?? ''),
      marketId: String(trade.marketId ?? trade.conditionId ?? trade.condition_id ?? ''),
      marketTitle: String(trade.title ?? trade.marketTitle ?? trade.question ?? trade.market ?? ''),
      side,
      price,
      sizeUsd,
      timestamp,
      source: 'polymarket_data_api',
    };
  }

  storeTrade(wallet, trade) {
    const key = `${wallet}:${trade.tokenId || trade.marketId || trade.marketTitle}:${trade.timestamp}:${trade.side}:${trade.sizeUsd}`;
    if (this.events.some((e) => e.key === key)) return;

    const event = { ...trade, key };
    this.events.unshift(event);
    this.whaleState.set(wallet, event);
  }

  prune() {
    const now = Date.now();
    this.events = this.events
      .filter((event) => now - event.timestamp <= this.config.whaleLookbackMs)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 500);
  }

  isWhaleActiveOnMarket(marketTitle) {
    const now = Date.now();
    const title = normalizeTitle(marketTitle);
    const lookbackMs = this.config.whaleLookbackMs;

    for (const event of this.events) {
      if (now - event.timestamp > lookbackMs) continue;

      if (normalizeTitle(event.marketTitle) === title) {
        return { active: true, side: event.side, event, ageMs: now - event.timestamp };
      }
    }

    return { active: false, side: null, event: null };
  }

  findRecentForSignal(signal) {
    if (!this.config.enableWhaleTracking || !signal) return null;
    this.prune();
    const now = Date.now();

    return this.events.find((event) => {
      if (now - event.timestamp > this.config.whaleLookbackMs) return false;
      const tokenMatch = event.tokenId && event.tokenId === signal.tokenId;
      const marketMatch = event.marketId && event.marketId === signal.marketId;
      const titleMatch = event.marketTitle && signal.metadata?.marketQuestion && normalizeTitle(event.marketTitle) === normalizeTitle(signal.metadata.marketQuestion);
      return tokenMatch || marketMatch || titleMatch;
    }) || null;
  }
}

function formatWsError(e) {
  if (!e) return 'unknown websocket error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return String(e.code);
  if (e.type) return String(e.type);

  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function normalizeTitle(value) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ');

  return cleaned.split(' ').filter(Boolean).join(' ');
}

// =========================
// MULTI-VIEW CONSENSUS ENGINE
// =========================

class MultiConsensusEngine {
  constructor(config) {
    this.config = config;
    this.midHistory = new Map();
  }

  evaluateSignal(signal, asset, book, cache, portfolio, volGuard, whaleTracker = null) {
    if (!signal || !asset || !book) return null;

    const protectiveExit = ['InventoryExit', 'StopLossExit', 'TakeProfitExit'].includes(signal.strategy);
    if (protectiveExit) {
      signal.metadata = {
        ...(signal.metadata || {}),
        consensus: {
          score: 1,
          authorized: true,
          reason: 'Protective exit bypasses consensus gate',
        },
      };
      return signal;
    }

    this.recordMid(signal.tokenId, book.midpoint);

    const whaleEvent = whaleTracker?.findRecentForSignal?.(signal) || null;

    const components = {
      structure: this.scoreStructure(signal, asset, book, cache),
      depth: this.scoreDepth(book),
      imbalance: this.scoreImbalance(signal, book),
      momentum: this.scoreMomentum(signal, book),
      volatility: this.scoreVolatility(signal, book, volGuard),
      portfolio: this.scorePortfolio(signal, book, portfolio),
      timing: this.scoreTiming(signal, asset),
      whale: this.scoreWhale(signal, whaleEvent),
    };

    const weights = signal.strategy === 'ComplementArb'
      ? { structure: 0.34, depth: 0.13, imbalance: 0.08, momentum: 0.08, volatility: 0.17, portfolio: 0.12, timing: 0.04, whale: 0.04 }
      : { structure: 0.20, depth: 0.15, imbalance: 0.13, momentum: 0.13, volatility: 0.16, portfolio: 0.14, timing: 0.05, whale: 0.04 };

    const score = Object.entries(weights).reduce((sum, [name, weight]) => {
      return sum + (components[name] ?? 0) * weight;
    }, 0);

    const route = this.routeExecution({
      signal,
      asset,
      book,
      cache,
      portfolio,
      volGuard,
      components,
      score,
      whaleEvent,
    });

    const authorized = score >= this.config.consensusThreshold && route.authorized;

    signal.metadata = {
      ...(signal.metadata || {}),
      consensus: {
        score: Number(score.toFixed(4)),
        authorized,
        threshold: this.config.consensusThreshold,
        components: Object.fromEntries(
          Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(4))])
        ),
        route,
        whaleEvent: whaleEvent ? {
          handle: whaleEvent.handle,
          side: whaleEvent.side,
          sizeUsd: whaleEvent.sizeUsd,
          price: whaleEvent.price,
          source: whaleEvent.source,
          ageMs: Date.now() - whaleEvent.timestamp,
        } : null,
      },
    };

    if (!authorized) {
      if (this.config.consensusLogRejected) {
        warn(`[CONSENSUS BLOCK] ${signal.strategy} ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} score=${score.toFixed(3)} threshold=${this.config.consensusThreshold} route=${route.mode}:${route.state}`);
      }
      return null;
    }

    this.applyExecutionRoute(signal, route);
    this.applyWhaleConsensusAdjustment(signal, whaleEvent);
    this.applyAdaptivePositionSizing(signal, components, route, book, portfolio);

    // Consensus cannot bypass RiskEngine. It can only adjust quality scores
    // before the hard exposure/cash/drawdown rules run.
    const qualityMultiplier = clamp(
      this.config.consensusPenaltyMin + score * 0.45,
      this.config.consensusPenaltyMin,
      this.config.consensusBoostMax
    );

    signal.confidence = clamp(signal.confidence * qualityMultiplier, 0, 0.99);
    signal.expectedEdge = signal.expectedEdge * qualityMultiplier;

    return signal;
  }

  routeExecution(marketData) {
    const targetDisplacement = this.calculateTargetWalletDisplacement(marketData);
    const volatilityState = this.calculateVolatility(marketData, targetDisplacement);

    // New Sophie objective:
    // Do not chase YES/NO purely because trend is high. If target-wallet style
    // displacement appears, respond as a market maker around the displaced book.
    if (this.config.targetWalletMode && targetDisplacement.detected) {
      return this.executeMakerStrategy({
        ...marketData,
        targetDisplacement,
        forcedReason: `${this.config.targetWalletHandle} style displacement detected`,
      });
    }

    if (volatilityState === 'STABLE') {
      return this.executeMakerStrategy({ ...marketData, targetDisplacement });
    }

    // Sniper mode is now secondary and conservative. It only runs when the
    // signal is already aligned and no target-wallet displacement is available.
    if (volatilityState === 'TRENDING') {
      return this.executeSniperStrategy({ ...marketData, targetDisplacement });
    }

    return {
      mode: 'WAIT',
      state: volatilityState,
      authorized: false,
      reason: 'Market is neither stable enough for maker mode nor cleanly directional enough for sniper mode',
      confidenceMultiplier: 0,
      edgeMultiplier: 0,
      sizeMultiplier: 0,
      targetDisplacement,
    };
  }

  calculateVolatility({ signal, book, volGuard }, targetDisplacement = null) {
    if (!signal || !isBookComplete(book)) return 'WAIT';
    if (volGuard?.isTripped?.(signal.tokenId) && !this.config.quoteDuringVolatility) return 'WAIT';

    const arr = this.midHistory.get(String(signal.tokenId)) || [];
    const first = arr[0]?.mid;
    const last = arr[arr.length - 1]?.mid;
    const trendMovePct = Number.isFinite(first) && first > 0 && Number.isFinite(last)
      ? Math.abs((last - first) / first)
      : 0;

    if (book.spread > this.config.hunterMaxSpread) return 'WAIT';

    // A target-wallet/order-book displacement should not automatically make us
    // chase direction. It becomes a maker opportunity if spread/depth are usable.
    if (targetDisplacement?.detected) {
      return 'STABLE';
    }

    if (trendMovePct >= this.config.consensusTrendMovePct) {
      return 'TRENDING';
    }

    if (book.spread <= this.config.consensusStableMaxSpread) {
      return 'STABLE';
    }

    if (book.spread <= this.config.hunterMaxSpread && trendMovePct < this.config.consensusTrendMovePct * 0.65) {
      return 'STABLE';
    }

    return 'WAIT';
  }

  executeMakerStrategy({ signal, book, components, targetDisplacement, forcedReason }) {
    const makerStrategies = new Set(['SpreadHunter', 'ComplementArb']);
    const authorized = makerStrategies.has(signal.strategy) && components.depth >= 0.45 && components.volatility >= 0.36;

    const mid = book.midpoint;
    const spread = Math.max(book.spread, book.tickSize || 0.01);
    const offset = spread * this.config.makerSpreadMultiplier;
    const tick = book.tickSize || 0.01;

    const makerBid = clamp(roundToTick(mid - offset, tick), 0.01, 0.99);
    const makerAsk = clamp(roundToTick(mid + offset, tick), 0.01, 0.99);

    return {
      mode: 'MAKER',
      state: 'STABLE',
      authorized,
      reason: authorized
        ? (forcedReason || 'Stable/displaced book: route to maker mode for spread capture')
        : `Stable/displaced book but strategy ${signal.strategy} is not maker-compatible`,
      confidenceMultiplier: targetDisplacement?.detected ? this.config.consensusMakerBoost * 1.05 : this.config.consensusMakerBoost,
      edgeMultiplier: targetDisplacement?.detected ? this.config.consensusMakerBoost * 1.05 : this.config.consensusMakerBoost,
      sizeMultiplier: 1.0,
      makerBid,
      makerAsk,
      makerMid: Number(mid.toFixed(4)),
      makerOffset: Number(offset.toFixed(4)),
      spread: Number(book.spread.toFixed(4)),
      targetDisplacement,
    };
  }

  executeSniperStrategy({ signal, book, components }) {
    const arr = this.midHistory.get(String(signal.tokenId)) || [];
    const first = arr[0]?.mid;
    const last = arr[arr.length - 1]?.mid;
    const directionalMove = Number.isFinite(first) && Number.isFinite(last) ? last - first : 0;

    const aligned =
      (signal.side === 'buy' && directionalMove > 0) ||
      (signal.side === 'sell' && directionalMove < 0);

    const sniperCompatible = signal.strategy === 'TailEndMispricing' || aligned;
    const authorized = sniperCompatible && components.volatility >= 0.36 && components.portfolio >= 0.35;

    return {
      mode: 'SNIPER',
      state: 'TRENDING',
      authorized,
      reason: authorized
        ? 'Directional move detected: route to sniper mode with reduced size'
        : 'Trend detected but signal is not aligned with the move',
      confidenceMultiplier: aligned ? 1.08 : 0.88,
      edgeMultiplier: aligned ? 1.08 : 0.88,
      sizeMultiplier: this.config.consensusSniperSizeMultiplier,
      directionalMove: Number(directionalMove.toFixed(4)),
      spread: Number(book.spread.toFixed(4)),
    };
  }

  applyExecutionRoute(signal, route) {
    if (!signal || !route) return signal;
    signal.confidence = clamp(signal.confidence * (route.confidenceMultiplier ?? 1), 0, 0.99);
    signal.expectedEdge = signal.expectedEdge * (route.edgeMultiplier ?? 1);

    if (route.mode === 'MAKER') {
      // Flip Sophie from directional YES/NO chasing into market-maker placement.
      // Buy limits rest below midpoint; sell limits rest above midpoint.
      if (signal.side === 'buy' && Number.isFinite(route.makerBid)) {
        signal.price = route.makerBid;
      }
      if (signal.side === 'sell' && Number.isFinite(route.makerAsk)) {
        signal.price = route.makerAsk;
      }
      signal.metadata = {
        ...(signal.metadata || {}),
        makerRoute: {
          mid: route.makerMid,
          bid: route.makerBid,
          ask: route.makerAsk,
          offset: route.makerOffset,
          spread: route.spread,
          targetDisplacement: route.targetDisplacement,
        },
      };
      signal.exitPlan = `${signal.exitPlan} | Maker route: limit @ mid ± ${this.config.makerSpreadMultiplier}x spread`;
    }

    if (route.mode === 'SNIPER') {
      signal.sizeUsd = Math.max(this.config.minOrderUsd, signal.sizeUsd * (route.sizeMultiplier ?? 1));
      signal.ttlMs = Math.min(signal.ttlMs, 20_000);
      signal.exitPlan = `${signal.exitPlan} | Sniper route: smaller size, faster timeout`;
    }

    return signal;
  }

  applyWhaleConsensusAdjustment(signal, whaleEvent) {
    if (!this.config.enableWhaleTracking || !signal || !whaleEvent) return signal;

    const whaleSide = String(whaleEvent.side || '').toLowerCase();
    const aligned = whaleSide === signal.side;

    signal.metadata = {
      ...(signal.metadata || {}),
      whaleSignal: {
        aligned,
        wallet: whaleEvent.wallet,
        handle: whaleEvent.handle,
        side: whaleEvent.side,
        sizeUsd: whaleEvent.sizeUsd,
        ageMs: Date.now() - whaleEvent.timestamp,
      },
    };

    if (aligned) {
      signal.confidence = Math.min(0.95, signal.confidence * 1.25);
      signal.expectedEdge *= 1.15;
      info(`[WHALE_BOOST] ${signal.strategy} aligned with whale ${shortId(whaleEvent.wallet || whaleEvent.handle)}`);
    } else if (whaleSide) {
      signal.confidence *= 0.70;
      signal.expectedEdge *= 0.60;
      warn(`[WHALE_VETO] ${signal.strategy} opposing whale ${shortId(whaleEvent.wallet || whaleEvent.handle)}`);
    }

    return signal;
  }

  applyAdaptivePositionSizing(signal, components, route, book, portfolio) {
    if (!this.config.enableAdaptiveSizing || !signal || signal.side !== 'buy') return signal;

    const edgeQuality = clamp(signal.expectedEdge / Math.max(this.config.minSignalEdge, 0.0001), 0.35, 1.35);
    const depthQuality = clamp(components.depth || 0.5, 0.25, 1.0);
    const imbalanceQuality = clamp(components.imbalance || 0.5, 0.25, 1.0);
    const volatilityQuality = clamp(components.volatility || 0.5, 0.20, 1.0);
    const portfolioQuality = clamp(components.portfolio || 0.5, 0.20, 1.0);
    const whaleQuality = clamp(components.whale || 0.5, 0.40, 1.0);
    const routeQuality = route?.mode === 'MAKER' ? 1.0 : route?.mode === 'SNIPER' ? 0.75 : 0.50;

    let ghostQuality = 1.0;
    if (portfolio?.ghostStats?.total >= 10) {
      const favorableRate = portfolio.ghostStats.favorable / Math.max(1, portfolio.ghostStats.total);
      if (favorableRate < 0.45) ghostQuality = this.config.adaptiveGhostPenalty;
      if (favorableRate > 0.60) ghostQuality = 1.12;
    }

    const liquidity = estimateLiquidityConsumption(book, signal.side, signal.sizeUsd, this.config);
    const liquidityQuality = clamp(liquidity.penalty, 0.20, 1.0);

    const multiplier = clamp(
      edgeQuality * depthQuality * imbalanceQuality * volatilityQuality * portfolioQuality * whaleQuality * routeQuality * ghostQuality * liquidityQuality,
      this.config.adaptiveMinSizeMultiplier,
      this.config.adaptiveMaxSizeMultiplier
    );

    const originalSizeUsd = signal.sizeUsd;
    signal.sizeUsd = Math.max(this.config.minOrderUsd, signal.sizeUsd * multiplier);
    signal.metadata = {
      ...(signal.metadata || {}),
      adaptiveSizing: {
        originalSizeUsd: Number(originalSizeUsd.toFixed(2)),
        finalSizeUsd: Number(signal.sizeUsd.toFixed(2)),
        multiplier: Number(multiplier.toFixed(4)),
        edgeQuality: Number(edgeQuality.toFixed(4)),
        depthQuality: Number(depthQuality.toFixed(4)),
        imbalanceQuality: Number(imbalanceQuality.toFixed(4)),
        volatilityQuality: Number(volatilityQuality.toFixed(4)),
        portfolioQuality: Number(portfolioQuality.toFixed(4)),
        whaleQuality: Number(whaleQuality.toFixed(4)),
        ghostQuality: Number(ghostQuality.toFixed(4)),
        liquidityQuality: Number(liquidityQuality.toFixed(4)),
      },
    };

    return signal;
  }

  calculateTargetWalletDisplacement({ signal, book, whaleEvent }) {
    if (!this.config.targetWalletMode || !signal || !isBookComplete(book)) {
      return { detected: false, reason: 'target wallet mode disabled or incomplete book' };
    }

    if (whaleEvent) {
      const mid = book.midpoint;
      const price = toNum(whaleEvent.price, NaN);
      const displacementPct = Number.isFinite(price) && mid > 0 ? Math.abs(price - mid) / mid : 0;
      return {
        detected: true,
        source: whaleEvent.source || 'whale_tracker',
        handle: whaleEvent.handle || this.config.targetWalletHandle,
        side: whaleEvent.side,
        sizeUsd: whaleEvent.sizeUsd,
        price,
        displacementPct: Number(displacementPct.toFixed(4)),
        reason: 'Recent whale/target-wallet event matched this market or token',
      };
    }

    // If a future wallet-tracker module tags a signal with the observed target
    // execution, honor that direct evidence first. This avoids pretending we
    // have wallet-flow data when we only have public book movement.
    const direct = signal.metadata?.targetWalletExecution;
    if (direct) {
      const sizeUsd = toNum(direct.sizeUsd, 0);
      const price = toNum(direct.price, NaN);
      const side = String(direct.side || '').toLowerCase();
      const mid = book.midpoint;
      const displacementPct = Number.isFinite(price) && mid > 0 ? Math.abs(price - mid) / mid : 0;

      return {
        detected: true,
        source: 'direct_target_wallet_execution',
        handle: direct.handle || this.config.targetWalletHandle,
        side,
        sizeUsd,
        price,
        displacementPct: Number(displacementPct.toFixed(4)),
        reason: 'Signal carried direct target-wallet execution metadata',
      };
    }

    return { detected: false, reason: 'No recent whale/target-wallet event matched this signal' };
  }

  scoreWhale(signal, whaleEvent) {
    if (!this.config.enableWhaleTracking) return 0.5;
    if (!whaleEvent) return 0.5;

    const ageMs = Date.now() - whaleEvent.timestamp;
    const freshness = clamp(1 - ageMs / Math.max(1, this.config.whaleLookbackMs), 0, 1);
    const sizeQuality = clamp(Math.log10(1 + whaleEvent.sizeUsd) / 5, 0, 1);
    const side = String(whaleEvent.side || '').toLowerCase();

    if (!side) return 0.5 + freshness * 0.1;

    const aligned = side === signal.side;
    return aligned
      ? clamp(0.55 + freshness * 0.25 + sizeQuality * 0.20, 0, 1)
      : clamp(0.45 - freshness * 0.20, 0, 1);
  }

  recordMid(tokenId, mid) {
    if (!Number.isFinite(mid)) return;

    const key = String(tokenId);
    const arr = this.midHistory.get(key) || [];
    arr.push({ t: Date.now(), mid });

    while (arr.length > this.config.historyLookback) arr.shift();
    this.midHistory.set(key, arr);
  }

  scoreStructure(signal, asset, book, cache) {
    if (signal.strategy === 'ComplementArb') {
      const siblings = cache.getMarketAssets(asset.market.marketId);
      if (siblings.length < 2) return 0.25;

      const siblingBooks = siblings.map((s) => cache.getBook(s.tokenId)).filter(Boolean);
      if (siblingBooks.length < 2 || siblingBooks.some((b) => !isBookComplete(b))) return 0.35;

      const askSum = siblingBooks.slice(0, 2).reduce((sum, b) => sum + b.bestAsk, 0);
      const edge = 1 - askSum;
      return clamp(0.45 + edge * 15, 0, 1);
    }

    if (signal.strategy === 'SpreadHunter') {
      return clamp(0.35 + book.spread * 4 + Math.log10(1 + asset.market.volume24h) / 12, 0, 1);
    }

    if (signal.strategy === 'TailEndMispricing') {
      return clamp(0.40 + Math.abs(book.midpoint - 0.5), 0, 1);
    }

    return 0.5;
  }

  scoreDepth(book) {
    if (!isBookComplete(book)) return 0;
    const bidDepth = topDepthUsd(book.bids, this.config.imbalanceDepthLevels);
    const askDepth = topDepthUsd(book.asks, this.config.imbalanceDepthLevels);
    const weaker = Math.min(bidDepth, askDepth);
    const stronger = Math.max(bidDepth, askDepth);
    const balance = stronger > 0 ? weaker / stronger : 0;

    const depthQuality = clamp(Math.log10(1 + weaker) / 3.2, 0, 1);
    return clamp(depthQuality * 0.70 + balance * 0.30, 0, 1);
  }

  scoreImbalance(signal, book) {
    if (!this.config.enableImbalanceSignals) return 0.5;

    const ob = computeOrderBookImbalance(book, this.config.imbalanceDepthLevels);
    if (!ob.usable) return 0.4;

    const abs = Math.abs(ob.imbalance);
    const balancedBonus = abs <= this.config.imbalanceBalancedThreshold ? 0.65 : 0.50;
    const directionalBonus =
      (signal.side === 'buy' && ob.imbalance > 0) ||
      (signal.side === 'sell' && ob.imbalance < 0)
        ? 0.25
        : -0.10;

    return clamp(balancedBonus + directionalBonus + abs * 0.25, 0, 1);
  }

  scoreMomentum(signal, book) {
    const arr = this.midHistory.get(String(signal.tokenId)) || [];
    if (arr.length < 4) return 0.55;

    const first = arr[0].mid;
    const last = arr[arr.length - 1].mid;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return 0.5;

    const move = (last - first) / first;
    if (Math.abs(move) < 0.008) return 0.65;

    const aligned = (signal.side === 'buy' && move > 0) || (signal.side === 'sell' && move < 0);
    return aligned ? 0.72 : 0.38;
  }

  scoreVolatility(signal, book, volGuard) {
    if (!isBookComplete(book)) return 0;
    if (volGuard?.isTripped?.(signal.tokenId) && !this.config.quoteDuringVolatility) return 0.25;
    if (book.spread > this.config.hunterMaxSpread) return 0.2;
    return clamp(1 - (book.spread / Math.max(this.config.hunterMaxSpread, 0.01)) * 0.45, 0, 1);
  }

  scorePortfolio(signal, book, portfolio) {
    if (!portfolio || !isBookComplete(book)) return 0.5;

    const assetExposure = Math.abs(portfolio.positionUsd(signal.tokenId, book.midpoint));
    const marketExposure = Math.abs(portfolio.marketExposureUsd(signal.marketId, book.midpoint));
    const totalExposure = Math.abs(portfolio.totalExposureUsd(book.midpoint));
    const drawdown = portfolio.drawdownPct();

    const assetScore = 1 - clamp(assetExposure / Math.max(1, this.config.maxPositionUsdPerAsset), 0, 1);
    const marketScore = 1 - clamp(marketExposure / Math.max(1, this.config.maxMarketExposureUsd), 0, 1);
    const totalScore = 1 - clamp(totalExposure / Math.max(1, this.config.maxTotalExposureUsd), 0, 1);
    const drawdownScore = 1 - clamp(drawdown / Math.max(1, this.config.maxDrawdownPct), 0, 1);

    return clamp((assetScore * 0.32) + (marketScore * 0.24) + (totalScore * 0.24) + (drawdownScore * 0.20), 0, 1);
  }

  scoreTiming(signal, asset) {
    const ms = msUntil(asset.market.endDate);
    if (!Number.isFinite(ms)) return 0.55;
    if (ms < 30 * 60_000) return 0.2;
    if (ms < 2 * 60 * 60_000) return 0.45;
    return 0.65;
  }
}

// =========================
// VOLATILITY GUARD
// =========================

class VolatilityGuard {
  constructor(config) {
    this.config = config;
    this.history = new Map();
    this.trippedUntil = new Map();
  }

  update(tokenId, midpoint) {
    if (!Number.isFinite(midpoint)) return;

    const key = String(tokenId);
    const arr = this.history.get(key) || [];
    arr.push({ t: Date.now(), p: midpoint });

    while (arr.length > this.config.historyLookback) arr.shift();
    this.history.set(key, arr);

    if (arr.length < 6) return;

    const oldest = arr[0].p;
    const newest = arr[arr.length - 1].p;
    if (!oldest || !newest) return;

    const changePct = Math.abs((newest - oldest) / oldest) * 100;
    if (changePct >= this.config.volatilityTripPct) {
      this.trippedUntil.set(key, Date.now() + this.config.volatilityCooldownMs);
      warn(`VOL GUARD tripped for ${shortId(tokenId)} move=${changePct.toFixed(2)}%`);
    }
  }

  isTripped(tokenId) {
    const until = this.trippedUntil.get(String(tokenId)) || 0;
    return until > Date.now();
  }

  getVolMultiplier(tokenId) {
    return this.isTripped(tokenId) ? 3.0 : 1.0;
  }
}

// =========================
// PAPER PORTFOLIO / ACCOUNTING
// =========================

class PaperPortfolio {
  constructor(config) {
    this.config = config;
    this.cash = config.initialCash;
    this.startingCash = config.initialCash;
    this.peakEquity = config.initialCash;
    this.positions = new Map();
    this.costBasis = new Map();
    this.openOrders = new Map();
    this.closedPnl = 0;
    this.strategyPnl = new Map();
    this.fills = [];
    this.ghostOrders = [];
    this.ghostStats = { total: 0, favorable: 0, unfavorable: 0 };
  }

  position(tokenId) {
    return this.positions.get(String(tokenId)) || 0;
  }

  avgCost(tokenId) {
    return this.costBasis.get(String(tokenId)) || 0;
  }

  positionUsd(tokenId, mark) {
    return this.position(tokenId) * (Number.isFinite(mark) ? mark : this.avgCost(tokenId));
  }

  marketExposureUsd(marketId, fallbackMark = 0.5) {
    let total = 0;

    for (const order of this.openOrders.values()) {
      if (String(order.marketId || '') === String(marketId || '')) {
        total += order.remainingUsd();
      }
    }

    for (const fill of this.fills) {
      if (String(fill.marketId || '') === String(marketId || '') && fill.side === 'buy') {
        const qty = this.position(fill.tokenId);
        if (qty > 0) total += qty * fallbackMark;
      }
    }

    return total;
  }

  totalExposureUsd(fallbackMark = 0.5) {
    let total = 0;
    for (const [tokenId, qty] of this.positions.entries()) {
      if (qty > 0) total += qty * fallbackMark;
    }
    for (const order of this.openOrders.values()) {
      total += order.remainingUsd();
    }
    return total;
  }

  equity(markPrices = new Map()) {
    let value = this.cash;
    for (const [tokenId, qty] of this.positions.entries()) {
      if (qty <= 0) continue;
      const mark = markPrices.get(tokenId) ?? this.avgCost(tokenId) ?? 0;
      value += qty * mark;
    }

    this.peakEquity = Math.max(this.peakEquity, value);
    return value;
  }

  drawdownPct(markPrices = new Map()) {
    const eq = this.equity(markPrices);
    if (this.peakEquity <= 0) return 0;
    return Math.max(0, ((this.peakEquity - eq) / this.peakEquity) * 100);
  }

  getDrawdownPct(markPrices = new Map()) {
    return this.drawdownPct(markPrices);
  }

  totalOpenOrderUsd() {
    let total = 0;
    for (const order of this.openOrders.values()) {
      total += order.remainingUsd();
    }
    return total;
  }

  addOrder(order) {
    this.openOrders.set(order.id, order);
  }

  cancelOrder(orderId) {
    this.openOrders.delete(orderId);
  }

  recordGhostOrder(signal, book) {
    if (!this.config.enableGhostMode || !signal || !book || !Number.isFinite(book.midpoint)) return;

    this.ghostOrders.push({
      id: signal.id,
      tokenId: signal.tokenId,
      side: signal.side,
      price: signal.price,
      midAtCreate: book.midpoint,
      createdAt: Date.now(),
      horizonAt: Date.now() + this.config.ghostHorizonMs,
      strategy: signal.strategy,
    });

    while (this.ghostOrders.length > this.config.ghostMaxRecords) {
      this.ghostOrders.shift();
    }
  }

  updateGhostOrders(markPrices = new Map()) {
    if (!this.config.enableGhostMode) return;

    const now = Date.now();
    const remaining = [];

    for (const ghost of this.ghostOrders) {
      if (now < ghost.horizonAt) {
        remaining.push(ghost);
        continue;
      }

      const currentMid = markPrices.get(ghost.tokenId);
      if (!Number.isFinite(currentMid) || !Number.isFinite(ghost.midAtCreate)) {
        continue;
      }

      this.ghostStats.total += 1;

      const movedUp = currentMid > ghost.midAtCreate;
      const movedDown = currentMid < ghost.midAtCreate;

      const favorable =
        (ghost.side === 'buy' && movedUp) ||
        (ghost.side === 'sell' && movedDown);

      if (favorable) this.ghostStats.favorable += 1;
      else this.ghostStats.unfavorable += 1;
    }

    this.ghostOrders = remaining;
  }

  recordFill({ tokenId, marketId, side, price, size, strategy }) {
    tokenId = String(tokenId);
    marketId = String(marketId || '');

    const qty = Number(size);
    const px = Number(price);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(px) || px <= 0) return;

    if (!this.positionMarkets) this.positionMarkets = new Map();
    if (marketId) this.positionMarkets.set(tokenId, marketId);

    const value = qty * px;
    const currentQty = this.position(tokenId);
    const currentCost = this.avgCost(tokenId);

    if (side === 'buy') {
      const newQty = currentQty + qty;
      const newCost = newQty > 0 ? ((currentQty * currentCost) + value) / newQty : 0;

      this.cash -= value;
      this.positions.set(tokenId, newQty);
      this.costBasis.set(tokenId, newCost);
    }

    if (side === 'sell') {
      const sellQty = Math.min(qty, currentQty);
      if (sellQty <= 0) return;

      const realized = (px - currentCost) * sellQty;
      const newQty = currentQty - sellQty;

      this.cash += sellQty * px;
      this.closedPnl += realized;

      if (newQty <= 1e-9) {
        this.positions.delete(tokenId);
        this.costBasis.delete(tokenId);
      } else {
        this.positions.set(tokenId, newQty);
      }

      this.strategyPnl.set(strategy, (this.strategyPnl.get(strategy) || 0) + realized);
    }

    this.fills.push({
      ts: Date.now(),
      tokenId,
      marketId,
      side,
      price: px,
      size: qty,
      value,
      strategy,
    });
  }

  saveState() {
    if (!this.config.saveState) return;

    try {
      const data = {
        cash: this.cash,
        startingCash: this.startingCash,
        peakEquity: this.peakEquity,
        positions: Object.fromEntries(this.positions),
        costBasis: Object.fromEntries(this.costBasis),
        closedPnl: this.closedPnl,
        strategyPnl: Object.fromEntries(this.strategyPnl),
        ghostStats: this.ghostStats,
        fills: this.fills.slice(-500),
      };

      fs.writeFileSync(this.config.stateFile, JSON.stringify(data, null, 2));
    } catch (e) {
      warn(`State save failed: ${e.message}`);
    }
  }

  loadState() {
    if (!this.config.saveState) return;

    try {
      if (!fs.existsSync(this.config.stateFile)) return;

      const data = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8'));

      this.cash = Number.isFinite(Number(data.cash)) ? Number(data.cash) : this.cash;
      this.startingCash = Number.isFinite(Number(data.startingCash)) ? Number(data.startingCash) : this.startingCash;
      this.peakEquity = Number.isFinite(Number(data.peakEquity)) ? Number(data.peakEquity) : this.peakEquity;
      this.closedPnl = Number.isFinite(Number(data.closedPnl)) ? Number(data.closedPnl) : this.closedPnl;

      this.positions = new Map(Object.entries(data.positions || {}).map(([k, v]) => [k, Number(v)]));
      this.costBasis = new Map(Object.entries(data.costBasis || {}).map(([k, v]) => [k, Number(v)]));
      this.strategyPnl = new Map(Object.entries(data.strategyPnl || {}).map(([k, v]) => [k, Number(v)]));
      this.ghostStats = data.ghostStats || this.ghostStats;
      this.fills = Array.isArray(data.fills) ? data.fills : [];

      info(`Loaded state from ${this.config.stateFile}. Equity: $${this.equity().toFixed(2)}`);
    } catch (e) {
      warn(`State load failed: ${e.message}`);
    }
  }
}

class PaperOrder {
  constructor(signal) {
    this.id = signal.id;
    this.signal = signal;
    this.tokenId = signal.tokenId;
    this.marketId = signal.marketId;
    this.side = signal.side;
    this.price = signal.price;
    this.sizeUsd = signal.sizeUsd;
    this.strategy = signal.strategy;
    this.createdAt = Date.now();
    this.expiresAt = Date.now() + signal.ttlMs;
    this.filledUsd = 0;
    this.metadata = signal.metadata || {};
  }

  remainingUsd() {
    return Math.max(0, this.sizeUsd - this.filledUsd);
  }

  isExpired() {
    return Date.now() >= this.expiresAt;
  }
}

// =========================
// RISK ENGINE
// =========================

class RiskEngine {
  constructor(config, portfolio) {
    this.config = config;
    this.portfolio = portfolio;
  }

  evaluate(signal) {
    if (!signal) return null;
    if (!['buy', 'sell'].includes(signal.side)) return null;
    if (!Number.isFinite(signal.price) || signal.price <= 0) return null;
    if (!Number.isFinite(signal.sizeUsd) || signal.sizeUsd <= 0) return null;

    if (this.portfolio.openOrders.size >= this.config.maxOpenOrders) return null;

    const isProtectiveExit = ['InventoryExit', 'StopLossExit', 'TakeProfitExit'].includes(signal.strategy);
    if (!isProtectiveExit && signal.expectedEdge < this.config.minSignalEdge) return null;
    if (!isProtectiveExit && signal.confidence < this.config.minConfidence) return null;

    const openUsd = this.portfolio.totalOpenOrderUsd();
    if (openUsd + signal.sizeUsd > this.config.maxTotalOpenOrderUsd) return null;

    const totalEx = this.portfolio.totalExposureUsd();
    if (signal.side === 'buy' && totalEx + signal.sizeUsd > this.config.maxTotalExposureUsd) return null;

    const mktEx = this.portfolio.marketExposureUsd(signal.marketId);
    if (signal.side === 'buy' && mktEx + signal.sizeUsd > this.config.maxMarketExposureUsd) return null;

    const currentPosQty = this.portfolio.position(signal.tokenId);
    const currentPosUsd = currentPosQty * signal.price;

    if (signal.side === 'buy') {
      if (this.portfolio.cash < signal.sizeUsd) return null;
      if (currentPosUsd + signal.sizeUsd > this.config.maxPositionUsdPerAsset) return null;
    }

    if (signal.side === 'sell') {
      if (currentPosQty <= 0) return null;
      const maxSellUsd = currentPosQty * signal.price;
      signal.sizeUsd = Math.min(signal.sizeUsd, maxSellUsd);
      if (signal.sizeUsd < this.config.minOrderUsd) return null;
    }

    if (this.portfolio.getDrawdownPct() > this.config.maxDrawdownPct) return null;

    return signal;
  }
}

// =========================
// PAPER EXECUTION ENGINE
// =========================

class PaperExecutionEngine {
  constructor(config, portfolio, cache) {
    this.config = config;
    this.portfolio = portfolio;
    this.cache = cache;
  }

  place(signal, book) {
    const order = new PaperOrder(signal);
    this.portfolio.addOrder(order);
    this.portfolio.recordGhostOrder(signal, book);
    info(`[ORDER] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} @ ${fmtPrice(signal.price)} size=$${signal.sizeUsd.toFixed(2)} [${signal.strategy}]`);
  }

  processOpenOrders() {
    const now = Date.now();

    for (const [orderId, order] of [...this.portfolio.openOrders.entries()]) {
      if (order.isExpired()) {
        this.portfolio.cancelOrder(orderId);
        continue;
      }

      const book = this.cache.getBook(order.tokenId);
      if (!isBookComplete(book)) continue;

      const fill = this.computeFill(order, book);
      if (!fill || fill.fillUsd < this.config.minFillUsd) continue;

      const fillSize = fill.fillUsd / fill.price;

      this.portfolio.recordFill({
        tokenId: order.tokenId,
        marketId: order.marketId,
        side: order.side,
        price: fill.price,
        size: fillSize,
        strategy: order.strategy,
      });

      order.filledUsd += fill.fillUsd;

      info(`[FILL] ${order.side.toUpperCase()} ${shortId(order.tokenId)} @ ${fmtPrice(fill.price)} usd=$${fill.fillUsd.toFixed(2)} [${order.strategy}]`);

      if (order.remainingUsd() < this.config.minFillUsd) {
        this.portfolio.cancelOrder(orderId);
      }

      if (now - order.createdAt > order.signal.maxHoldMs) {
        this.portfolio.cancelOrder(orderId);
      }
    }
  }

  computeFill(order, book) {
    if (!isBookComplete(book)) return null;

    const remainingUsd = order.remainingUsd();
    if (remainingUsd <= 0) return null;

    let executable = false;
    let price = order.price;
    let sideDepthUsd = 0;

    if (order.side === 'buy') {
      // Buy fills only if the limit crosses the ask or the market moves down into it.
      executable = order.price >= book.bestAsk || book.bestBid <= order.price;
      price = Math.min(order.price, book.bestAsk);
      sideDepthUsd = topDepthUsd(book.asks, 3);
    }

    if (order.side === 'sell') {
      // Sell fills only if the limit crosses the bid or the market moves up into it.
      executable = order.price <= book.bestBid || book.bestAsk >= order.price;
      price = Math.max(order.price, book.bestBid);
      sideDepthUsd = topDepthUsd(book.bids, 3);
    }

    if (!executable) return null;

    const maxDepthFill = Math.max(0, sideDepthUsd * this.config.partialFillDepthFraction);
    const fillUsd = Math.min(remainingUsd, maxDepthFill);

    if (fillUsd <= 0) return null;

    return {
      price: clamp(price, 0.01, 0.99),
      fillUsd,
    };
  }

  generateProtectiveSignals(asset, book) {
    if (!isBookComplete(book)) return [];

    const qty = this.portfolio.position(asset.tokenId);
    if (qty <= 0) return [];

    const avgCost = this.portfolio.avgCost(asset.tokenId);
    if (!Number.isFinite(avgCost) || avgCost <= 0) return [];

    const mark = book.midpoint;
    const pnlPct = ((mark - avgCost) / avgCost) * 100;
    const tick = book.tickSize || 0.01;

    const signals = [];

    if (pnlPct <= -Math.abs(this.config.stopLossPct)) {
      signals.push(new Signal({
        strategy: 'StopLossExit',
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'sell',
        price: clamp(roundToTick(Math.max(book.bestBid, book.bestAsk - tick), tick), 0.01, 0.99),
        sizeUsd: qty * mark,
        expectedEdge: 0,
        confidence: 1,
        reason: `Stop loss triggered: pnl=${pnlPct.toFixed(2)}%`,
        exitPlan: 'Emergency risk reduction',
        ttlMs: 15_000,
        maxHoldMs: 60_000,
        metadata: { marketQuestion: asset.market.question, outcome: asset.outcome, pnlPct },
      }));
    }

    if (this.config.enableTakeProfit && pnlPct >= Math.abs(this.config.takeProfitPct)) {
      signals.push(new Signal({
        strategy: 'TakeProfitExit',
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'sell',
        price: clamp(roundToTick(Math.max(book.bestBid, book.bestAsk - tick), tick), 0.01, 0.99),
        sizeUsd: qty * mark,
        expectedEdge: 0,
        confidence: 1,
        reason: `Take profit triggered: pnl=${pnlPct.toFixed(2)}%`,
        exitPlan: 'Lock realized gains',
        ttlMs: 20_000,
        maxHoldMs: 60_000,
        metadata: { marketQuestion: asset.market.question, outcome: asset.outcome, pnlPct },
      }));
    }

    return signals;
  }
}

// =========================
// BOT ENGINE
// =========================

class BotEngine {
  constructor(config) {
    this.config = config;
    this.poly = new PolymarketPublicClient(config);
    this.cache = new MarketCache(this.poly);
    this.portfolio = new PaperPortfolio(config);
    this.portfolio.loadState();

    this.volGuard = new VolatilityGuard(config);
    this.risk = new RiskEngine(config, this.portfolio);
    this.execution = new PaperExecutionEngine(config, this.portfolio, this.cache);
    this.consensus = new MultiConsensusEngine(config);
    this.whaleTracker = config.enableWhaleTracking ? new AsyncWhaleWatcher(config) : null;

    this.research = new ResearchEngine(this.poly, this.cache, config);
    this.assets = [];
    this.cycle = 0;
    this.wsClient = null;

    this.strategies = [
      new SpreadHunterStrategy(config, this.cache, this.portfolio, this.volGuard),
      new ComplementArbStrategy(config, this.cache, this.portfolio, this.volGuard),
      new InventoryExitStrategy(config, this.cache, this.portfolio, this.volGuard),
      new TailEndMispricingStrategy(config, this.cache, this.portfolio, this.volGuard),
      new WhaleCopyStrategy(config, this.cache, this.portfolio, this.volGuard, this.whaleTracker),
    ];
  }

  async start() {
    banner();
    info('Starting Polymarket MoneyMaker V3 (Paper)...');

    await this.refreshResearch();

    if (this.config.enableWs) {
      this.startWebSocket();
    }

    while (true) {
      try {
        await this.tick();
        await sleep(this.config.loopDelayMs);
      } catch (e) {
        errlog(`Loop error: ${e.stack || e.message}`);
        await sleep(5_000);
      }
    }
  }

  async refreshResearch() {
    this.assets = await this.research.discoverCandidates();

    if (this.wsClient && this.assets.length > 0) {
      this.wsClient.subscribe(this.assets.map((a) => a.tokenId));
    }
  }

  startWebSocket() {
    this.wsClient = new CLOBWebSocketClient({
      url: this.config.clobWsUrl,
      config: this.config,
      onMessage: (msg) => {
        const eventType = msg.event_type || msg.event || msg.type;
        const assetId = String(msg.asset_id || msg.assetId || msg.token_id || msg.tokenId || '');

        if (!assetId) return;

        if (eventType === 'book' || eventType === 'orderbook' || eventType === 'price_change' || eventType === 'best_bid_ask') {
          // Do not treat partial price_change events as a full book.
          // They only mark the cached book stale; REST will refresh it.
          const asset = this.cache.getAsset(assetId);
          if (asset) {
            this.cache.getFreshBook(assetId, 0).catch(() => {});
          }
        }
      },
    });

    this.wsClient.connect();
    if (this.assets.length > 0) {
      this.wsClient.subscribe(this.assets.map((a) => a.tokenId));
    }
  }

  async tick() {
    this.cycle += 1;
    this.whaleTracker?.tick?.();

    if (this.cycle === 1 || this.cycle % this.config.marketRefreshEveryCycles === 0) {
      await this.refreshResearch();
    }

    const markPrices = this.cache.markPrices();
    this.portfolio.updateGhostOrders(markPrices);

    for (const asset of this.assets) {
      const book = await this.cache.getFreshBook(asset.tokenId, 3_000);
      if (!isBookComplete(book)) continue;

      this.volGuard.update(asset.tokenId, book.midpoint);
      this.consensus.recordMid(asset.tokenId, book.midpoint);

      const protectiveSignals = this.execution.generateProtectiveSignals(asset, book);
      for (const signal of protectiveSignals) {
        this.trySignal(signal, asset, book);
      }

      for (const strategy of this.strategies) {
        const signals = await strategy.generate(asset, book);

        for (const rawSignal of signals) {
          this.trySignal(rawSignal, asset, book);
        }
      }
    }

    this.execution.processOpenOrders();

    if (this.cycle % this.config.reportEveryCycles === 0) {
      this.report();
      this.portfolio.saveState();
    }
  }

  trySignal(rawSignal, asset, book) {
    let signal = rawSignal;

    if (this.config.enableConsensus) {
      signal = this.consensus.evaluateSignal(
        rawSignal,
        asset,
        book,
        this.cache,
        this.portfolio,
        this.volGuard,
        this.whaleTracker
      );
    }

    signal = this.risk.evaluate(signal);
    if (!signal) return;

    this.execution.place(signal, book);
  }

  report() {
    const markPrices = this.cache.markPrices();
    const equity = this.portfolio.equity(markPrices);
    const drawdown = this.portfolio.drawdownPct(markPrices);

    info('--- PORTFOLIO REPORT ---');
    info(`Equity: $${equity.toFixed(2)} | Cash: $${this.portfolio.cash.toFixed(2)} | Drawdown: ${drawdown.toFixed(2)}%`);
    info(`Open Orders: ${this.portfolio.openOrders.size} | Exposure: $${this.portfolio.totalExposureUsd().toFixed(2)} | Closed PnL: $${this.portfolio.closedPnl.toFixed(2)}`);

    if (this.portfolio.ghostStats.total > 0) {
      const favorableRate = (this.portfolio.ghostStats.favorable / this.portfolio.ghostStats.total) * 100;
      info(`Ghost calibration: total=${this.portfolio.ghostStats.total} favorable=${favorableRate.toFixed(1)}%`);
    }

    const positions = [...this.portfolio.positions.entries()].filter(([, qty]) => qty > 0);
    if (positions.length > 0) {
      for (const [tokenId, qty] of positions.slice(0, 10)) {
        const mark = markPrices.get(tokenId) ?? this.portfolio.avgCost(tokenId);
        info(`POS ${shortId(tokenId)} qty=${qty.toFixed(4)} avg=${fmtPrice(this.portfolio.avgCost(tokenId))} mark=${fmtPrice(mark)} value=$${(qty * mark).toFixed(2)}`);
      }
    }
  }
}

// =========================
// MATH / FORMAT UTILITIES
// =========================

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToTick(value, tick) {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(tick) || tick <= 0) return value;
  return Math.round(value / tick) * tick;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function shortId(value) {
  const s = String(value || '');
  if (s.length <= 10) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function fmtPrice(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `$${Number(value).toFixed(3)}`;
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function msUntil(dateLike) {
  if (!dateLike) return NaN;
  const t = Date.parse(dateLike);
  if (!Number.isFinite(t)) return NaN;
  return t - Date.now();
}

function hoursUntil(dateLike) {
  const ms = msUntil(dateLike);
  if (!Number.isFinite(ms)) return NaN;
  return ms / (60 * 60 * 1000);
}

function banner() {
  console.log('====================================================');
  console.log('  POLYMARKET MONEYMAKER V3.1.1 PAPER ENGINE');
  console.log('====================================================');
}

// =========================
// MAIN
// =========================

async function main() {
  const bot = new BotEngine(CONFIG);
  await bot.start();
}

main().catch((e) => {
  errlog(`Fatal start error: ${e.stack || e.message}`);
  process.exitCode = 1;
});
