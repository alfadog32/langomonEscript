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
 *   npm install ws
 *   node moneymaker_v3.js
 *
 * Safer test:
 *   INITIAL_CASH=10000 BASE_ORDER_USD=10 MAX_POSITION_USD=100 node moneymaker_v3.js
 *
 * Aggressive paper research:
 *   HUNTER_MODE=true ENABLE_WS=true MAX_MARKETS=25 BASE_ORDER_USD=20 node moneymaker_v3.js
 */

// =========================
// OPTIONAL WEBSOCKET
// =========================

let WebSocketImpl = globalThis.WebSocket;
try {
  WebSocketImpl = WebSocketImpl || require('ws');
} catch {
  WebSocketImpl = null;
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// =========================
// CONFIG
// =========================

const CONFIG = {
  gammaBaseUrl: envStr('GAMMA_BASE_URL', 'https://gamma-api.polymarket.com'),
  clobBaseUrl: envStr('CLOB_BASE_URL', 'https://clob.polymarket.com'),
  clobWsUrl: envStr('CLOB_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),

  enableWs: envBool('ENABLE_WS', true),
  saveState: envBool('SAVE_STATE', true),
  stateFile: envStr('STATE_FILE', path.join(process.cwd(), 'moneymaker_v3_state.json')),

  initialCash: envNum('INITIAL_CASH', 10_000),

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
  maxOpenOrders: envInt('MAX_OPEN_ORDERS', 200),
  maxDrawdownPct: envNum('MAX_DRAWDOWN_PCT', 12),

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
  volatilityCooldownMs: envInt('VOL_COOLDOWN_MS', 60_000),
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
}

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
  constructor({ url, onMessage }) {
    this.url = url;
    this.onMessage = onMessage;
    this.ws = null;
    this.assetIds = new Set();
    this.connected = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
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
      this.ws.on('error', (e) => warn(`CLOB WS error: ${e.message || e}`));
      this.ws.on('close', () => this.handleClose());
    } else {
      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleRawMessage(event.data);
      this.ws.onerror = (event) => warn(`CLOB WS error: ${event?.message || 'unknown websocket error'}`);
      this.ws.onclose = () => this.handleClose();
    }
  }

  handleOpen() {
    if (this.connected) return;
    this.connected = true;
    info('CLOB WebSocket connected.');
    this.resubscribe();
    this.startPing();
  }

  handleClose() {
    this.connected = false;
    this.stopPing();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 5_000);
  }

  startPing() {
    this.stopPing();

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocketImpl.OPEN) {
        try {
          this.ws.send('{}');
        } catch (e) {
          warn(`WS ping failed: ${e.message}`);
        }
      }
    }, 25_000);
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
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      if (!text || text === 'PONG') return;

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
    metadata = {},
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

    if (!(bid < ask)) return [];

    const edgeEstimate = Math.max(0, (ask - bid) / 2 - this.config.slippageBuffer - this.config.adverseSelectionBuffer);
    if (edgeEstimate < this.config.minSignalEdge) return [];

    let baseUsd = this.config.baseOrderUsd;
    if (this.config.hunterMode && spread > 0.08) {
      const dangerScale = clamp(1 - ((spread - 0.08) / 0.14), 0.25, 1);
      baseUsd *= dangerScale;
    }

    const buyUsd = Math.max(0, baseUsd * (1 - Math.max(0, invRatio)));
    const sellUsd = Math.max(0, baseUsd * (1 + Math.min(0, invRatio)));
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
        reason: `Wide spread hunter: spread=${fmtPrice(spread)}, inv=${(invRatio * 100).toFixed(1)}%`,
        exitPlan: `Exit near ask ${fmtPrice(ask)} or stale/hold timeout`,
        ttlMs: this.config.orderTtlMs,
        maxHoldMs: this.config.maxHoldMs,
        metadata: { askTarget: ask, marketQuestion: asset.market.question, outcome: asset.outcome },
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
        reason: `Inventory/spread sell: spread=${fmtPrice(spread)}, inv=${(invRatio * 100).toFixed(1)}%`,
        exitPlan: 'Reduce inventory at wide spread',
        ttlMs: this.config.orderTtlMs,
        maxHoldMs: this.config.maxHoldMs,
        metadata: { bidTarget: bid, marketQuestion: asset.market.question, outcome: asset.outcome },
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
        exitPlan: 'Hold paired outcomes or exit if ask-sum normalizes',
        ttlMs: Math.min(this.config.orderTtlMs, 15_000),
        maxHoldMs: 24 * 60 * 60_000,
        metadata: { pairId: `${a.tokenId}:${b.tokenId}`, leg: 1, marketQuestion: a.market.question, outcome: a.outcome },
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
        exitPlan: 'Hold paired outcomes or exit if ask-sum normalizes',
        ttlMs: Math.min(this.config.orderTtlMs, 15_000),
        maxHoldMs: 24 * 60 * 60_000,
        metadata: { pairId: `${a.tokenId}:${b.tokenId}`, leg: 2, marketQuestion: b.market.question, outcome: b.outcome },
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

function confidenceFromPrice(mid) {
  return Math.abs(mid - 0.5) * 1.6;
}

// =========================
// RISK ENGINE
// =========================

class RiskEngine {
  constructor(config, portfolio, orders, cache, volGuard) {
    this.config = config;
    this.portfolio = portfolio;
    this.orders = orders;
    this.cache = cache;
    this.volGuard = volGuard;
    this.blacklist = new Set();
  }

  approve(signal, book) {
    if (!signal) return deny('empty signal');
    if (!['buy', 'sell'].includes(signal.side)) return deny('invalid side');
    if (!isBookComplete(book)) return deny('incomplete book');
    if (this.blacklist.has(signal.marketId) || this.blacklist.has(signal.tokenId)) return deny('blacklisted');

    if (signal.expectedEdge < this.config.minSignalEdge) return deny(`edge too low ${signal.expectedEdge.toFixed(4)}`);
    if (signal.confidence < this.config.minConfidence) return deny(`confidence too low ${signal.confidence.toFixed(2)}`);

    if (this.volGuard.isTripped(signal.tokenId) && !this.config.quoteDuringVolatility) {
      return deny('volatility guard active');
    }

    const price = signal.price;
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return deny('bad price');

    const usd = signal.sizeUsd;
    if (!Number.isFinite(usd) || usd < this.config.minOrderUsd) return deny('size too small');

    const openOrderUsd = this.orders.totalOpenUsd();
    if (openOrderUsd + usd > this.config.maxTotalOpenOrderUsd) return deny('open order usd limit');
    if (this.orders.openOrders.size >= this.config.maxOpenOrders) return deny('max open orders');

    const mark = book.midpoint;
    const currentAssetUsd = this.portfolio.positionUsd(signal.tokenId, mark);
    const nextAssetUsd = currentAssetUsd + (signal.side === 'buy' ? usd : -usd);

    if (Math.abs(nextAssetUsd) > this.config.maxPositionUsdPerAsset) {
      return deny('asset exposure limit');
    }

    const marketExposure = this.portfolio.marketExposureUsd(signal.marketId, this.cache.markPrices()) + usd;
    if (marketExposure > this.config.maxMarketExposureUsd) {
      return deny('market exposure limit');
    }

    const totalExposure = this.portfolio.totalGrossExposureUsd(this.cache.markPrices()) + usd;
    if (totalExposure > this.config.maxTotalExposureUsd) {
      return deny('total exposure limit');
    }

    const equity = this.portfolio.equity(this.cache.markPrices());
    if (signal.side === 'buy' && this.portfolio.cash < usd) return deny('insufficient paper cash');
    if (equity <= 0) return deny('bad equity');

    if (signal.side === 'sell') {
      const qty = this.portfolio.position(signal.tokenId);
      const requestedQty = usd / price;
      if (qty <= 0 || requestedQty > qty * 1.05) {
        return deny('cannot sell more paper inventory than held');
      }
    }

    return { ok: true, reason: 'approved' };
  }
}

function deny(reason) {
  return { ok: false, reason };
}

// =========================
// PAPER PORTFOLIO
// =========================

class PaperPortfolio {
  constructor(initialCash) {
    this.initialCash = initialCash;
    this.cash = initialCash;
    this.positions = new Map();
    this.lots = new Map();
    this.fills = [];
    this.realizedVolume = 0;
    this.realizedPnlByStrategy = new Map();
    this.peakEquity = initialCash;
  }

  position(tokenId) {
    return this.positions.get(String(tokenId)) || 0;
  }

  positionUsd(tokenId, mark) {
    return this.position(tokenId) * (Number.isFinite(mark) ? mark : 0);
  }

  marketExposureUsd(marketId, marks) {
    let total = 0;
    for (const [tokenId, qty] of this.positions.entries()) {
      const lot = this.lots.get(tokenId);
      if (lot?.marketId === marketId) {
        total += Math.abs(qty * (marks.get(tokenId) || lot.avgPrice || 0));
      }
    }
    return total;
  }

  totalGrossExposureUsd(marks) {
    let total = 0;
    for (const [tokenId, qty] of this.positions.entries()) {
      const lot = this.lots.get(tokenId);
      total += Math.abs(qty * (marks.get(tokenId) || lot?.avgPrice || 0));
    }
    return total;
  }

  applyFill(fill) {
    const tokenId = String(fill.tokenId);
    const oldQty = this.position(tokenId);
    const signedQty = fill.side === 'buy' ? fill.size : -fill.size;
    const newQty = oldQty + signedQty;
    const value = fill.price * fill.size;

    if (fill.side === 'buy') {
      this.cash -= value;
      this.updateLotOnBuy(fill, oldQty, newQty);
    } else {
      this.cash += value;
      this.updateLotOnSell(fill, oldQty, newQty);
    }

    if (Math.abs(newQty) < 1e-9) {
      this.positions.delete(tokenId);
    } else {
      this.positions.set(tokenId, newQty);
    }

    this.realizedVolume += value;
    this.fills.push(fill);
  }

  updateLotOnBuy(fill, oldQty, newQty) {
    const tokenId = String(fill.tokenId);
    const lot = this.lots.get(tokenId) || {
      qty: 0,
      avgPrice: 0,
      strategy: fill.strategy,
      marketId: fill.marketId,
      openedAt: fill.timestamp,
      marketQuestion: fill.marketQuestion,
      outcome: fill.outcome,
    };

    const oldCost = Math.max(0, oldQty) * lot.avgPrice;
    const addCost = fill.size * fill.price;
    const nextQty = Math.max(0, newQty);

    lot.qty = nextQty;
    lot.avgPrice = nextQty > 0 ? (oldCost + addCost) / nextQty : 0;
    lot.strategy = lot.strategy || fill.strategy;
    lot.marketId = fill.marketId;
    lot.marketQuestion = fill.marketQuestion;
    lot.outcome = fill.outcome;
    this.lots.set(tokenId, lot);
  }

  updateLotOnSell(fill, oldQty, newQty) {
    const tokenId = String(fill.tokenId);
    const lot = this.lots.get(tokenId);

    if (lot && oldQty > 0) {
      const closedQty = Math.min(fill.size, oldQty);
      const pnl = (fill.price - lot.avgPrice) * closedQty;
      const prev = this.realizedPnlByStrategy.get(fill.strategy) || 0;
      this.realizedPnlByStrategy.set(fill.strategy, prev + pnl);
    }

    if (newQty <= 1e-9) {
      this.lots.delete(tokenId);
    } else if (lot) {
      lot.qty = newQty;
      this.lots.set(tokenId, lot);
    }
  }

  equity(marks) {
    let total = this.cash;
    for (const [tokenId, qty] of this.positions.entries()) {
      const lot = this.lots.get(tokenId);
      total += qty * (marks.get(tokenId) || lot?.avgPrice || 0);
    }
    return total;
  }

  drawdownPct(marks) {
    const eq = this.equity(marks);
    this.peakEquity = Math.max(this.peakEquity, eq);
    if (this.peakEquity <= 0) return 0;
    return ((this.peakEquity - eq) / this.peakEquity) * 100;
  }

  toJSON() {
    return {
      initialCash: this.initialCash,
      cash: this.cash,
      positions: Object.fromEntries(this.positions.entries()),
      lots: Object.fromEntries(this.lots.entries()),
      fills: this.fills.slice(-1000),
      realizedVolume: this.realizedVolume,
      realizedPnlByStrategy: Object.fromEntries(this.realizedPnlByStrategy.entries()),
      peakEquity: this.peakEquity,
    };
  }

  static fromJSON(data, fallbackInitialCash) {
    const p = new PaperPortfolio(data?.initialCash || fallbackInitialCash);
    p.cash = Number.isFinite(data?.cash) ? data.cash : p.initialCash;
    p.positions = new Map(Object.entries(data?.positions || {}).map(([k, v]) => [k, Number(v)]));
    p.lots = new Map(Object.entries(data?.lots || {}));
    p.fills = Array.isArray(data?.fills) ? data.fills : [];
    p.realizedVolume = Number.isFinite(data?.realizedVolume) ? data.realizedVolume : 0;
    p.realizedPnlByStrategy = new Map(Object.entries(data?.realizedPnlByStrategy || {}).map(([k, v]) => [k, Number(v)]));
    p.peakEquity = Number.isFinite(data?.peakEquity) ? data.peakEquity : p.initialCash;
    return p;
  }
}

// =========================
// PAPER ORDER MANAGER
// =========================

class PaperOrderManager {
  constructor(config, portfolio) {
    this.config = config;
    this.portfolio = portfolio;
    this.openOrders = new Map();
    this.fillStats = {
      placed: 0,
      filled: 0,
      cancelled: 0,
      denied: 0,
    };
  }

  place(signal, book, asset) {
    const tick = book.tickSize || 0.01;
    const price = roundToTick(signal.price, tick);
    const minSize = book.minOrderSize || 5;
    const size = Math.max(minSize, signal.sizeUsd / price);

    const order = {
      id: crypto.randomUUID(),
      signalId: signal.id,
      strategy: signal.strategy,
      tokenId: signal.tokenId,
      marketId: signal.marketId,
      side: signal.side,
      price,
      size,
      value: price * size,
      tickSize: tick,
      createdAt: Date.now(),
      expiresAt: Date.now() + signal.ttlMs,
      maxHoldMs: signal.maxHoldMs,
      expectedEdge: signal.expectedEdge,
      confidence: signal.confidence,
      reason: signal.reason,
      exitPlan: signal.exitPlan,
      marketQuestion: asset.market.question,
      outcome: asset.outcome,
      status: 'OPEN',
    };

    this.openOrders.set(order.id, order);
    this.fillStats.placed++;
    return order;
  }

  cancelStale() {
    const now = Date.now();
    let n = 0;

    for (const [id, order] of this.openOrders.entries()) {
      if (order.expiresAt <= now) {
        this.openOrders.delete(id);
        this.fillStats.cancelled++;
        n++;
      }
    }

    return n;
  }

  cancelForToken(tokenId) {
    let n = 0;
    for (const [id, order] of this.openOrders.entries()) {
      if (order.tokenId === String(tokenId)) {
        this.openOrders.delete(id);
        this.fillStats.cancelled++;
        n++;
      }
    }
    return n;
  }

  totalOpenUsd() {
    return [...this.openOrders.values()].reduce((sum, o) => sum + o.value, 0);
  }

  simulateFills(asset, book) {
    const fills = [];

    for (const [id, order] of this.openOrders.entries()) {
      if (order.tokenId !== asset.tokenId) continue;

      const result = shouldPaperFill(order, book);
      if (!result.fill) continue;

      this.openOrders.delete(id);
      this.fillStats.filled++;

      fills.push({
        id: crypto.randomUUID(),
        orderId: id,
        signalId: order.signalId,
        strategy: order.strategy,
        tokenId: order.tokenId,
        marketId: order.marketId,
        side: order.side,
        price: order.price,
        size: order.size,
        value: order.price * order.size,
        expectedEdge: order.expectedEdge,
        confidence: order.confidence,
        marketQuestion: order.marketQuestion,
        outcome: order.outcome,
        timestamp: Date.now(),
        reason: result.reason,
      });
    }

    return fills;
  }

  toJSON() {
    return {
      openOrders: [...this.openOrders.values()],
      fillStats: this.fillStats,
    };
  }

  loadJSON(data) {
    this.openOrders = new Map();
    for (const order of data?.openOrders || []) {
      if (order?.id) this.openOrders.set(order.id, order);
    }
    if (data?.fillStats) this.fillStats = { ...this.fillStats, ...data.fillStats };
  }
}

function shouldPaperFill(order, book) {
  // Conservative maker-fill simulation:
  // - Buy fills only if live ask moves down through our bid.
  // - Sell fills only if live bid moves up through our ask.
  if (order.side === 'buy' && Number.isFinite(book.bestAsk) && book.bestAsk <= order.price) {
    return { fill: true, reason: `bestAsk ${fmtPrice(book.bestAsk)} <= bid ${fmtPrice(order.price)}` };
  }

  if (order.side === 'sell' && Number.isFinite(book.bestBid) && book.bestBid >= order.price) {
    return { fill: true, reason: `bestBid ${fmtPrice(book.bestBid)} >= ask ${fmtPrice(order.price)}` };
  }

  return { fill: false, reason: 'not crossed' };
}

// =========================
// VOLATILITY GUARD
// =========================

class VolatilityGuard {
  constructor(config) {
    this.config = config;
    this.history = new Map();
    this.trippedUntilByToken = new Map();
  }

  update(tokenId, price) {
    if (!Number.isFinite(price)) return false;

    const key = String(tokenId);
    const arr = this.history.get(key) || [];
    arr.push(price);
    while (arr.length > this.config.historyLookback) arr.shift();
    this.history.set(key, arr);

    const volPct = this.getVolPct(key);
    if (volPct > this.config.volatilityTripPct) {
      this.trippedUntilByToken.set(key, Date.now() + this.config.volatilityCooldownMs);
      warn(`Volatility guard tripped: ${shortId(key)} vol=${volPct.toFixed(2)}%`);
      return true;
    }

    return false;
  }

  getVolPct(tokenId) {
    const arr = this.history.get(String(tokenId)) || [];
    if (arr.length < 6) return 0;

    const returns = [];
    for (let i = 1; i < arr.length; i++) {
      returns.push((arr[i] - arr[i - 1]) / Math.max(0.0001, arr[i - 1]));
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * 100;
  }

  getVolMultiplier(tokenId) {
    const volPct = this.getVolPct(tokenId);
    return clamp(1 + (volPct / Math.max(1, this.config.volatilityTripPct)), 1, 3);
  }

  isTripped(tokenId) {
    const until = this.trippedUntilByToken.get(String(tokenId)) || 0;
    return Date.now() < until;
  }
}

// =========================
// PERFORMANCE ENGINE
// =========================

class PerformanceEngine {
  constructor(portfolio, orders, cache) {
    this.portfolio = portfolio;
    this.orders = orders;
    this.cache = cache;
    this.adverseSamples = [];
  }

  recordFillQuality(fill, bookAfter) {
    if (!bookAfter || !Number.isFinite(bookAfter.midpoint)) return;

    const signed = fill.side === 'buy'
      ? bookAfter.midpoint - fill.price
      : fill.price - bookAfter.midpoint;

    this.adverseSamples.push({
      timestamp: Date.now(),
      strategy: fill.strategy,
      tokenId: fill.tokenId,
      signedEdgeNow: signed,
      fillPrice: fill.price,
      mark: bookAfter.midpoint,
    });

    if (this.adverseSamples.length > 1000) this.adverseSamples.shift();
  }

  strategySummary() {
    const summary = new Map();

    for (const fill of this.portfolio.fills) {
      const s = summary.get(fill.strategy) || {
        fills: 0,
        volume: 0,
        avgExpectedEdge: 0,
      };

      s.fills++;
      s.volume += fill.value;
      s.avgExpectedEdge += fill.expectedEdge || 0;
      summary.set(fill.strategy, s);
    }

    for (const s of summary.values()) {
      s.avgExpectedEdge = s.fills > 0 ? s.avgExpectedEdge / s.fills : 0;
    }

    return summary;
  }

  adverseSummary() {
    if (this.adverseSamples.length === 0) return { count: 0, avg: 0 };
    const avg = this.adverseSamples.reduce((sum, x) => sum + x.signedEdgeNow, 0) / this.adverseSamples.length;
    return { count: this.adverseSamples.length, avg };
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
    this.research = new ResearchEngine(this.poly, this.cache, config);
    this.portfolio = this.loadPortfolio();
    this.orders = new PaperOrderManager(config, this.portfolio);
    this.volGuard = new VolatilityGuard(config);
    this.risk = new RiskEngine(config, this.portfolio, this.orders, this.cache, this.volGuard);
    this.performance = new PerformanceEngine(this.portfolio, this.orders, this.cache);

    this.strategies = [
      new SpreadHunterStrategy(config, this.cache, this.portfolio, this.volGuard),
      new ComplementArbStrategy(config, this.cache, this.portfolio, this.volGuard),
      new InventoryExitStrategy(config, this.cache, this.portfolio, this.volGuard),
      new TailEndMispricingStrategy(config, this.cache, this.portfolio, this.volGuard),
    ];

    this.candidates = [];
    this.cycle = 0;
    this.running = true;
    this.wsRefreshInFlight = new Set();

    this.clobWs = null;
    if (config.enableWs) {
      this.clobWs = new CLOBWebSocketClient({
        url: config.clobWsUrl,
        onMessage: (msg) => this.handleWsMessage(msg),
      });
    }

    this.loadOrders();
  }

  async start() {
    banner();

    if (typeof fetch !== 'function') {
      throw new Error('Node.js 18+ is required because this script uses built-in fetch.');
    }

    info('Starting MoneyMaker V3 in PAPER mode.');
    info(`Cash=$${this.portfolio.cash.toFixed(2)} State=${this.config.stateFile}`);

    if (this.clobWs) this.clobWs.connect();

    await this.refreshResearch();

    while (this.running) {
      try {
        this.cycle++;

        if (this.cycle % this.config.marketRefreshEveryCycles === 0 || this.candidates.length === 0) {
          await this.refreshResearch();
        }

        const cancelled = this.orders.cancelStale();
        if (cancelled > 0) info(`Cancelled ${cancelled} stale paper orders.`);

        for (const asset of this.candidates) {
          await this.processAsset(asset);
          await sleep(50);
        }

        const dd = this.portfolio.drawdownPct(this.cache.markPrices());
        if (dd >= this.config.maxDrawdownPct) {
          warn(`Max paper drawdown hit: ${dd.toFixed(2)}%. Stopping.`);
          this.running = false;
        }

        if (this.cycle % this.config.reportEveryCycles === 0) {
          this.report();
        }

        this.saveState();
        await sleep(this.config.loopDelayMs);
      } catch (e) {
        errlog(`Main loop error: ${e.stack || e.message}`);
        await sleep(5_000);
      }
    }

    this.report();
    this.saveState();
    info('MoneyMaker V3 stopped.');
  }

  async refreshResearch() {
    this.candidates = await this.research.discoverCandidates();
    this.cache.setCandidates(this.candidates);

    if (this.clobWs && this.candidates.length > 0) {
      this.clobWs.subscribe(this.candidates.map((a) => a.tokenId));
    }
  }

  handleWsMessage(msg) {
    const eventType = msg.event_type || msg.type;
    const tokenId = String(msg.asset_id || msg.assetId || msg.token_id || msg.tokenId || '');

    if (!tokenId) return;

    if (eventType === 'book' && Array.isArray(msg.bids) && Array.isArray(msg.asks)) {
      const book = normalizeBook(msg, tokenId);
      this.cache.setBook(tokenId, book);
    }

    if (eventType === 'best_bid_ask') {
      const cached = this.cache.getBook(tokenId) || {
        assetId: tokenId,
        bids: [],
        asks: [],
        tickSize: 0.01,
        minOrderSize: 5,
      };

      const bestBid = toNum(msg.best_bid ?? msg.bestBid ?? msg.bid, NaN);
      const bestAsk = toNum(msg.best_ask ?? msg.bestAsk ?? msg.ask, NaN);

      if (Number.isFinite(bestBid)) cached.bestBid = bestBid;
      if (Number.isFinite(bestAsk)) cached.bestAsk = bestAsk;
      if (Number.isFinite(cached.bestBid) && Number.isFinite(cached.bestAsk)) {
        cached.midpoint = (cached.bestBid + cached.bestAsk) / 2;
        cached.spread = cached.bestAsk - cached.bestBid;
        cached.cachedAt = Date.now();
        this.cache.setBook(tokenId, cached);
      }
    }

    if (['book', 'price_change', 'last_trade_price', 'best_bid_ask'].includes(eventType)) {
      this.queueWsAssetProcess(tokenId);
    }
  }

  queueWsAssetProcess(tokenId) {
    const key = String(tokenId);
    if (this.wsRefreshInFlight.has(key)) return;

    this.wsRefreshInFlight.add(key);
    setTimeout(async () => {
      try {
        const asset = this.cache.getAsset(key);
        if (asset) await this.processAsset(asset);
      } catch (e) {
        warn(`WS-triggered processing failed for ${shortId(key)}: ${e.message}`);
      } finally {
        this.wsRefreshInFlight.delete(key);
      }
    }, this.config.wsDebounceMs);
  }

  async processAsset(asset) {
    let book;
    try {
      book = await this.cache.getFreshBook(asset.tokenId);
    } catch (e) {
      warn(`Book refresh failed for ${shortId(asset.tokenId)}: ${e.message}`);
      return;
    }

    if (!isBookComplete(book)) return;

    this.volGuard.update(asset.tokenId, book.midpoint);

    const fills = this.orders.simulateFills(asset, book);
    for (const fill of fills) {
      this.portfolio.applyFill(fill);
      this.performance.recordFillQuality(fill, book);
      info(
        `PAPER FILL ${fill.strategy} ${fill.side.toUpperCase()} ${fill.outcome} ` +
        `${fill.size.toFixed(2)} @ ${fmtPrice(fill.price)} value=$${fill.value.toFixed(2)} :: ${fill.reason}`
      );
    }

    if (this.volGuard.isTripped(asset.tokenId) && !this.config.quoteDuringVolatility) {
      const n = this.orders.cancelForToken(asset.tokenId);
      if (n > 0) warn(`Volatility active; cancelled ${n} orders for ${shortId(asset.tokenId)}.`);
      return;
    }

    const signals = [];
    for (const strategy of this.strategies) {
      try {
        const generated = await strategy.generate(asset, book);
        signals.push(...generated);
      } catch (e) {
        warn(`Strategy ${strategy.name} failed: ${e.message}`);
      }
    }

    signals.sort((a, b) => {
      const av = a.expectedEdge * a.confidence;
      const bv = b.expectedEdge * b.confidence;
      return bv - av;
    });

    for (const signal of signals.slice(0, 3)) {
      const approval = this.risk.approve(signal, book);
      if (!approval.ok) {
        this.orders.fillStats.denied++;
        continue;
      }

      const order = this.orders.place(signal, book, asset);
      if (order) {
        info(
          `PAPER ORDER ${order.strategy} ${order.side.toUpperCase()} ${asset.outcome.padEnd(8)} ` +
          `${order.size.toFixed(2)} @ ${fmtPrice(order.price)} edge=${signal.expectedEdge.toFixed(4)} ` +
          `conf=${signal.confidence.toFixed(2)} :: ${signal.reason}`
        );
      }
    }
  }

  report() {
    const marks = this.cache.markPrices();
    const equity = this.portfolio.equity(marks);
    const pnl = equity - this.portfolio.initialCash;
    const pnlPct = (pnl / this.portfolio.initialCash) * 100;
    const dd = this.portfolio.drawdownPct(marks);
    const adverse = this.performance.adverseSummary();
    const strategySummary = this.performance.strategySummary();

    console.log('\n================ MONEYMAKER V3 PAPER REPORT ================');
    console.log(`Cycle:          ${this.cycle}`);
    console.log(`Cash:           $${this.portfolio.cash.toFixed(2)}`);
    console.log(`Equity:         $${equity.toFixed(2)}`);
    console.log(`PnL:            $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
    console.log(`Drawdown:       ${dd.toFixed(2)}%`);
    console.log(`Volume:         $${this.portfolio.realizedVolume.toFixed(2)}`);
    console.log(`Fills:          ${this.portfolio.fills.length}`);
    console.log(`Open orders:    ${this.orders.openOrders.size} ($${this.orders.totalOpenUsd().toFixed(2)})`);
    console.log(`Selected assets:${this.candidates.length}`);
    console.log(`Fill stats:     placed=${this.orders.fillStats.placed} filled=${this.orders.fillStats.filled} cancelled=${this.orders.fillStats.cancelled} denied=${this.orders.fillStats.denied}`);
    console.log(`Adverse sample: n=${adverse.count} avgNow=${adverse.avg.toFixed(4)}`);

    if (strategySummary.size > 0) {
      console.log('Strategy summary:');
      for (const [name, s] of strategySummary.entries()) {
        console.log(`  - ${name}: fills=${s.fills} volume=$${s.volume.toFixed(2)} avgEdge=${s.avgExpectedEdge.toFixed(4)}`);
      }
    }

    const positions = [...this.portfolio.positions.entries()]
      .filter(([, qty]) => Math.abs(qty) > 1e-8)
      .slice(0, 12);

    if (positions.length > 0) {
      console.log('Positions:');
      for (const [tokenId, qty] of positions) {
        const lot = this.portfolio.lots.get(tokenId);
        const mark = marks.get(tokenId) || lot?.avgPrice || 0;
        const pnl = lot ? (mark - lot.avgPrice) * qty : 0;
        console.log(
          `  - ${shortId(tokenId)} qty=${qty.toFixed(2)} mark=${fmtPrice(mark)} ` +
          `avg=${fmtPrice(lot?.avgPrice || 0)} uPnL=$${pnl.toFixed(2)} ${lot?.outcome || ''}`
        );
      }
    }

    console.log('============================================================\n');
  }

  stop() {
    this.running = false;
  }

  loadPortfolio() {
    if (!this.config.saveState || !fs.existsSync(this.config.stateFile)) {
      return new PaperPortfolio(this.config.initialCash);
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8'));
      return PaperPortfolio.fromJSON(data.portfolio, this.config.initialCash);
    } catch (e) {
      warn(`Could not load state; starting fresh: ${e.message}`);
      return new PaperPortfolio(this.config.initialCash);
    }
  }

  loadOrders() {
    if (!this.config.saveState || !fs.existsSync(this.config.stateFile)) return;

    try {
      const data = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8'));
      this.orders.loadJSON(data.orders);
    } catch (e) {
      warn(`Could not load orders: ${e.message}`);
    }
  }

  saveState() {
    if (!this.config.saveState) return;

    const state = {
      savedAt: new Date().toISOString(),
      mode: 'paper',
      config: {
        initialCash: this.config.initialCash,
        baseOrderUsd: this.config.baseOrderUsd,
        maxPositionUsdPerAsset: this.config.maxPositionUsdPerAsset,
        maxTotalExposureUsd: this.config.maxTotalExposureUsd,
      },
      portfolio: this.portfolio.toJSON(),
      orders: this.orders.toJSON(),
    };

    fs.writeFileSync(this.config.stateFile, JSON.stringify(state, null, 2));
  }
}

// =========================
// HELPERS
// =========================

function toNum(value, fallback = NaN) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = toNum(value, NaN);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function roundToTick(price, tick) {
  const t = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  return Math.round(price / t) * t;
}

function fmtPrice(x) {
  return Number.isFinite(x) ? Number(x).toFixed(3) : 'N/A';
}

function shortId(id) {
  const s = String(id || '');
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function msUntil(dateString) {
  if (!dateString) return NaN;
  const t = Date.parse(dateString);
  if (!Number.isFinite(t)) return NaN;
  return t - Date.now();
}

function hoursUntil(dateString) {
  return msUntil(dateString) / (60 * 60 * 1000);
}

function banner() {
  console.log('='.repeat(76));
  console.log('POLYMARKET MONEYMAKER V3 - PAPER EV ENGINE');
  console.log('Strategies: SpreadHunter | ComplementArb | InventoryExit | TailEndMispricing');
  console.log('Public data only. No private key. No real orders. Review before live trading.');
  console.log('='.repeat(76));
}

// =========================
// STARTUP
// =========================

const bot = new BotEngine(CONFIG);

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Stopping after current cycle...');
  bot.stop();
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM. Stopping after current cycle...');
  bot.stop();
});

bot.start().catch((e) => {
  errlog(`Fatal error: ${e.stack || e.message}`);
  process.exit(1);
});
