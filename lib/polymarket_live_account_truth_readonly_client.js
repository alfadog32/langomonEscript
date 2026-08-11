'use strict';

const ALLOWED_CLOB_METHODS = Object.freeze([
  'getOpenOrders',
  'getTradesPaginated',
  'getNotifications',
  'getOrder',
  'getBalanceAllowance',
]);
const TERMINAL_CURSOR = 'LTE=';

function assertReadOnlyClobClient(client) {
  for (const method of ALLOWED_CLOB_METHODS) {
    if (!client || typeof client[method] !== 'function') throw new Error(`READ_ONLY_CLOB_METHOD_MISSING:${method}`);
  }
  return Object.freeze(Object.fromEntries(ALLOWED_CLOB_METHODS.map((method) => [method, client[method].bind(client)])));
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response || response.ok !== true) throw new Error(`READ_ONLY_HTTP_${response?.status || 'FAILED'}`);
  return response.json();
}

async function fetchAllOffsetPages(fetchImpl, baseUrl, pathname, params, { pageSize = 500, maxPages = 100 } = {}) {
  const records = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries({ ...params, limit: pageSize, offset: page * pageSize })) url.searchParams.set(key, String(value));
    const batch = await fetchJson(fetchImpl, url);
    if (!Array.isArray(batch)) throw new Error('READ_ONLY_DATA_API_MALFORMED');
    records.push(...batch);
    if (batch.length < pageSize) {
      return {
        records,
        pagesFetched: page + 1,
        recordsFetched: records.length,
        paginationComplete: true,
        terminalCursorReached: true,
        coverageComplete: true,
      };
    }
  }
  throw new Error('READ_ONLY_DATA_API_PAGINATION_LIMIT');
}

async function fetchAllTradePages(clob, { maxPages = 10_000 } = {}) {
  const records = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await clob.getTradesPaginated(undefined, cursor);
    if (!response || !Array.isArray(response.trades) || typeof response.next_cursor !== 'string') {
      throw new Error('READ_ONLY_TRADE_HISTORY_MALFORMED');
    }
    records.push(...response.trades);
    if (response.next_cursor === TERMINAL_CURSOR) {
      return {
        records,
        pagesFetched: page + 1,
        recordsFetched: records.length,
        paginationComplete: true,
        terminalCursorReached: true,
        coverageComplete: true,
        historyWindowStart: 'account_inception',
      };
    }
    if (!response.next_cursor || seenCursors.has(response.next_cursor)) throw new Error('READ_ONLY_TRADE_HISTORY_CURSOR_INVALID');
    seenCursors.add(response.next_cursor);
    cursor = response.next_cursor;
  }
  throw new Error('READ_ONLY_TRADE_HISTORY_PAGINATION_LIMIT');
}

function collectOrderIds(openOrders, trades, notifications) {
  const ids = new Set();
  for (const order of openOrders) if (order?.id) ids.add(String(order.id));
  for (const trade of trades) {
    if (trade?.taker_order_id) ids.add(String(trade.taker_order_id));
    for (const maker of Array.isArray(trade?.maker_orders) ? trade.maker_orders : []) if (maker?.order_id) ids.add(String(maker.order_id));
  }
  for (const notification of notifications) {
    const payload = notification?.payload || {};
    for (const candidate of [payload.order_id, payload.orderId, payload.id]) if (candidate) ids.add(String(candidate));
    for (const candidate of Array.isArray(payload.order_ids) ? payload.order_ids : []) if (candidate) ids.add(String(candidate));
  }
  return [...ids];
}

function trustedEnvelope(source, records, metadata = {}) {
  return {
    source,
    fetched: true,
    complete: true,
    authenticated: false,
    publicAddressScoped: false,
    identityBound: true,
    fresh: true,
    records,
    ...metadata,
  };
}

function createReadOnlyAccountTruthSource({ clobClient, fetchImpl = globalThis.fetch, dataApiBaseUrl = 'https://data-api.polymarket.com', accountWallet } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('READ_ONLY_FETCH_UNAVAILABLE');
  const clob = assertReadOnlyClobClient(clobClient);
  let cachedOpenOrders = null;
  let cachedTrades = null;
  let cachedNotifications = null;

  async function openOrders() {
    if (!cachedOpenOrders) cachedOpenOrders = await clob.getOpenOrders();
    if (!Array.isArray(cachedOpenOrders)) throw new Error('OPEN_ORDERS_MALFORMED');
    return cachedOpenOrders;
  }

  async function trades() {
    if (!cachedTrades) cachedTrades = await fetchAllTradePages(clob);
    return cachedTrades;
  }

  async function notifications() {
    if (!cachedNotifications) cachedNotifications = await clob.getNotifications();
    if (!Array.isArray(cachedNotifications)) throw new Error('NOTIFICATIONS_MALFORMED');
    return cachedNotifications;
  }

  return Object.freeze({
    async fetchPositions() {
      const page = await fetchAllOffsetPages(fetchImpl, dataApiBaseUrl, '/positions', { user: accountWallet });
      return trustedEnvelope('official_data_api_current_positions', page.records, {
        ...page,
        authenticated: false,
        publicAddressScoped: true,
      });
    },
    async fetchOpenOrders() {
      return trustedEnvelope('official_clob_authenticated_open_orders', await openOrders(), { authenticated: true });
    },
    async fetchTrades() {
      const page = await trades();
      return trustedEnvelope('official_clob_authenticated_trade_history', page.records, { ...page, authenticated: true });
    },
    async fetchActivity() {
      const page = await fetchAllOffsetPages(fetchImpl, dataApiBaseUrl, '/activity', { user: accountWallet });
      return trustedEnvelope('official_data_api_account_activity', page.records, {
        ...page,
        authenticated: false,
        publicAddressScoped: true,
      });
    },
    async fetchCollateralBalance() {
      const response = await clob.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      if (!response || typeof response !== 'object' || !Number.isFinite(Number(response.balance))) throw new Error('COLLATERAL_BALANCE_MALFORMED');
      return trustedEnvelope('official_clob_authenticated_collateral_balance', [{ ...response, decimals: 6 }], { authenticated: true });
    },
    async fetchOrderHistory() {
      const [open, tradePage, notificationRecords] = await Promise.all([openOrders(), trades(), notifications()]);
      const ids = collectOrderIds(open, tradePage.records, notificationRecords);
      const records = [];
      for (const id of ids) {
        const order = await clob.getOrder(id);
        if (!order || typeof order !== 'object') throw new Error('ORDER_HISTORY_RECORD_MALFORMED');
        records.push(order);
      }
      return {
        source: 'corroborating_open_orders_trades_notifications',
        fetched: true,
        complete: false,
        authoritative: false,
        authenticated: true,
        publicAddressScoped: false,
        identityBound: true,
        fresh: true,
        coverageComplete: false,
        paginationComplete: false,
        terminalCursorReached: false,
        pagesFetched: tradePage.pagesFetched,
        recordsFetched: records.length,
        records,
        blocker: 'LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE',
        corroboratingEvidence: {
          openOrderCount: open.length,
          tradeCount: tradePage.records.length,
          notificationCount: notificationRecords.length,
          reconstructedOrderIdCount: ids.length,
        },
      };
    },
  });
}

async function resolveOfficialWalletIdentity({ fetchImpl = globalThis.fetch, relayerBaseUrl = 'https://relayer-v2.polymarket.com', gammaBaseUrl = 'https://gamma-api.polymarket.com', signerAddress, accountWallet, signatureType } = {}) {
  const numericSignatureType = Number(signatureType);
  if (numericSignatureType === 0) {
    return { resolvedAccountWallet: signerAddress, resolvedSignatureType: 0, resolvedWalletType: 'EOA', authenticated: String(signerAddress).toLowerCase() === String(accountWallet).toLowerCase() };
  }
  const profileUrl = new URL('/public-profile', gammaBaseUrl);
  profileUrl.searchParams.set('address', signerAddress);
  const profile = await fetchJson(fetchImpl, profileUrl);
  const profileWallet = String(profile?.proxyWallet || '').toLowerCase();
  if (!profileWallet || profileWallet !== String(accountWallet || '').toLowerCase()) {
    return { resolvedAccountWallet: profileWallet || null, resolvedSignatureType: null, resolvedWalletType: null, authenticated: false };
  }
  if (numericSignatureType === 1) {
    return { resolvedAccountWallet: profileWallet, resolvedSignatureType: 1, resolvedWalletType: 'PROXY', authenticated: true };
  }
  const expected = numericSignatureType === 2 ? 'SAFE' : numericSignatureType === 3 ? 'WALLET' : null;
  if (!expected) return { resolvedAccountWallet: accountWallet, resolvedSignatureType: null, resolvedWalletType: null, authenticated: false };
  const other = expected === 'SAFE' ? 'WALLET' : 'SAFE';
  const deployed = await fetchJson(fetchImpl, `${relayerBaseUrl}/deployed?address=${encodeURIComponent(accountWallet)}&type=${expected}`);
  const conflicting = await fetchJson(fetchImpl, `${relayerBaseUrl}/deployed?address=${encodeURIComponent(accountWallet)}&type=${other}`);
  const isDeployed = deployed === true || deployed?.deployed === true;
  const conflictDeployed = conflicting === true || conflicting?.deployed === true;
  if (!isDeployed || conflictDeployed) {
    return { resolvedAccountWallet: profileWallet, resolvedSignatureType: null, resolvedWalletType: null, authenticated: false };
  }
  return {
    resolvedAccountWallet: profileWallet,
    resolvedSignatureType: numericSignatureType,
    resolvedWalletType: expected === 'SAFE' ? 'SAFE' : 'POLY_1271',
    authenticated: true,
  };
}

module.exports = {
  ALLOWED_CLOB_METHODS,
  TERMINAL_CURSOR,
  assertReadOnlyClobClient,
  collectOrderIds,
  createReadOnlyAccountTruthSource,
  fetchAllOffsetPages,
  fetchAllTradePages,
  resolveOfficialWalletIdentity,
};
