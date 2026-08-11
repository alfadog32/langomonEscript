'use strict';

const DATA_API = 'https://data-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPublicJson(url, { fetchImpl = global.fetch, timeoutMs = 12_000, retries = 5, retryBaseMs = 1_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation unavailable');
  const parsed = new URL(url);
  if (![DATA_API, CLOB_API].includes(parsed.origin)) {
    throw new Error(`read-only source refused: ${parsed.origin}`);
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(parsed.toString(), {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'langomon-profitable-trader-shadow/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
          const waitMs = Number.isFinite(retryAfterSeconds)
            ? Math.max(250, retryAfterSeconds * 1_000)
            : Math.min(30_000, retryBaseMs * 2 ** attempt);
          await sleep(waitMs);
          continue;
        }
        throw new Error(`HTTP ${response.status} ${body.slice(0, 160)}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('public GET retry budget exhausted');
}

async function fetchLeaderboard({ category = 'OVERALL', timePeriod = 'MONTH', orderBy = 'PNL', limit = 50, offset = 0, ...options } = {}) {
  const url = new URL('/v1/leaderboard', DATA_API);
  url.searchParams.set('category', category);
  url.searchParams.set('timePeriod', timePeriod);
  url.searchParams.set('orderBy', orderBy);
  url.searchParams.set('limit', String(Math.max(1, Math.min(50, limit))));
  url.searchParams.set('offset', String(Math.max(0, Math.min(1000, offset))));
  const payload = await fetchPublicJson(url, options);
  return Array.isArray(payload) ? payload : [];
}

async function fetchWalletActivity(wallet, { limit = 500, start = null, end = null, ...options } = {}) {
  const pageSize = Math.min(500, Math.max(1, limit));
  const records = [];
  for (let offset = 0; offset < limit; offset += pageSize) {
    const url = new URL('/activity', DATA_API);
    url.searchParams.set('user', String(wallet));
    url.searchParams.set('type', 'TRADE');
    url.searchParams.set('limit', String(Math.min(pageSize, limit - offset)));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('sortBy', 'TIMESTAMP');
    url.searchParams.set('sortDirection', 'DESC');
    if (Number.isFinite(start)) url.searchParams.set('start', String(Math.floor(start / 1000)));
    if (Number.isFinite(end)) url.searchParams.set('end', String(Math.ceil(end / 1000)));
    const page = await fetchPublicJson(url, options);
    if (!Array.isArray(page)) break;
    records.push(...page);
    if (page.length < Math.min(pageSize, limit - offset)) break;
  }
  return records.slice(0, limit);
}

async function fetchMarketTrades(conditionId, { limit = 1_000, side = null, takerOnly = true, ...options } = {}) {
  const url = new URL('/trades', DATA_API);
  url.searchParams.set('market', String(conditionId));
  url.searchParams.set('limit', String(Math.max(1, Math.min(10_000, Math.floor(limit)))));
  url.searchParams.set('takerOnly', takerOnly === false ? 'false' : 'true');
  if (side) url.searchParams.set('side', String(side).toUpperCase());
  const payload = await fetchPublicJson(url, options);
  return Array.isArray(payload) ? payload : [];
}

async function fetchClosedPositions(wallet, { limit = 300, pageDelayMs = 150, ...options } = {}) {
  const records = [];
  for (let offset = 0; offset < limit; offset += 50) {
    const pageSize = Math.min(50, limit - offset);
    const url = new URL('/closed-positions', DATA_API);
    url.searchParams.set('user', String(wallet));
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('sortBy', 'TIMESTAMP');
    url.searchParams.set('sortDirection', 'DESC');
    const page = await fetchPublicJson(url, options);
    if (!Array.isArray(page)) break;
    records.push(...page);
    if (page.length < pageSize) break;
    if (offset + pageSize < limit && pageDelayMs > 0) await sleep(pageDelayMs);
  }
  return records;
}

async function fetchOrderBook(tokenId, options = {}) {
  const url = new URL('/book', CLOB_API);
  url.searchParams.set('token_id', String(tokenId));
  return fetchPublicJson(url, options);
}

async function fetchClobMarketInfo(conditionId, options = {}) {
  const url = new URL(`/clob-markets/${encodeURIComponent(String(conditionId))}`, CLOB_API);
  return fetchPublicJson(url, options);
}

module.exports = {
  DATA_API,
  CLOB_API,
  fetchPublicJson,
  fetchLeaderboard,
  fetchWalletActivity,
  fetchMarketTrades,
  fetchClosedPositions,
  fetchOrderBook,
  fetchClobMarketInfo,
};
