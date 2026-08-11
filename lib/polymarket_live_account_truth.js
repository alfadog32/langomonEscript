'use strict';

const DEFAULT_SNAPSHOT_TTL_MS = 30_000;
const HOUR_MS = 60 * 60_000;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function normalizeAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
}

function timestampMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function utcDayStart(nowMs) {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function uniqueBlockers(blockers) {
  return [...new Set(blockers.filter(Boolean))];
}

function resultEnvelope(result, fallbackSource, { authenticated = false } = {}) {
  if (!result || typeof result !== 'object') {
    return { source: fallbackSource, fetched: false, complete: false, authenticated, publicAddressScoped: false, identityBound: false, fresh: false, records: [], blocker: 'SOURCE_UNAVAILABLE' };
  }
  return {
    ...result,
    source: String(result.source || fallbackSource),
    fetched: result.fetched === true,
    complete: result.complete === true,
    authenticated: result.authenticated === true || authenticated,
    publicAddressScoped: result.publicAddressScoped === true,
    identityBound: result.identityBound === true,
    fresh: result.fresh !== false,
    records: Array.isArray(result.records) ? result.records : [],
    blocker: result.blocker || null,
  };
}

async function callSource(source, name, fallbackSource, options = {}) {
  try {
    if (!source || typeof source[name] !== 'function') return resultEnvelope(null, fallbackSource, options);
    return resultEnvelope(await source[name](), fallbackSource, options);
  } catch (error) {
    return {
      source: fallbackSource,
      fetched: false,
      complete: false,
      authenticated: options.authenticated === true,
      publicAddressScoped: false,
      identityBound: false,
      fresh: false,
      records: [],
      blocker: `${name.toUpperCase()}_FAILED`,
    };
  }
}

function resolveAccountIdentity(identity = {}) {
  const blockers = [];
  const signerAddress = normalizeAddress(identity.signerAddress);
  const configuredAccountWallet = normalizeAddress(identity.configuredAccountWallet);
  const resolvedAccountWallet = normalizeAddress(identity.resolvedAccountWallet);
  const configuredSignatureType = finite(identity.configuredSignatureType);
  const resolvedSignatureType = finite(identity.resolvedSignatureType);
  const resolvedWalletType = String(identity.resolvedWalletType || '').trim() || null;
  const expectedWalletTypeBySignature = new Map([[0, 'EOA'], [1, 'PROXY'], [2, 'SAFE'], [3, 'POLY_1271']]);

  if (!signerAddress || !configuredAccountWallet || !resolvedAccountWallet || configuredSignatureType === null || !resolvedWalletType) {
    blockers.push('ACCOUNT_IDENTITY_INCOMPLETE');
  }
  if (identity.expectedSignerAddress && signerAddress !== normalizeAddress(identity.expectedSignerAddress)) blockers.push('SIGNER_ADDRESS_MISMATCH');
  if (configuredAccountWallet && resolvedAccountWallet && configuredAccountWallet !== resolvedAccountWallet) blockers.push('ACCOUNT_WALLET_MISMATCH');
  if (resolvedSignatureType !== null && configuredSignatureType !== resolvedSignatureType) blockers.push('SIGNATURE_TYPE_MISMATCH');
  const expectedWalletType = expectedWalletTypeBySignature.get(configuredSignatureType);
  if (!resolvedWalletType) blockers.push('WALLET_TYPE_UNRESOLVED');
  else if (!expectedWalletType || resolvedWalletType !== expectedWalletType) blockers.push('SIGNATURE_TYPE_MISMATCH');
  if (configuredSignatureType === 0 && signerAddress && resolvedAccountWallet && signerAddress !== resolvedAccountWallet) blockers.push('SIGNER_ADDRESS_MISMATCH');

  return {
    signerAddress,
    configuredAccountWallet,
    resolvedAccountWallet,
    configuredSignatureType,
    resolvedWalletType,
    identityMatches: blockers.length === 0,
    authenticated: identity.authenticated === true,
    blockers: uniqueBlockers(blockers),
  };
}

function positionKey(record) {
  return String(record.asset || record.tokenId || record.token_id || [record.conditionId, record.outcomeIndex].filter((v) => v !== undefined).join(':') || '');
}

function normalizePositions(envelope, accountWallet) {
  const blockers = [];
  const byKey = new Map();
  for (const record of envelope.records) {
    const key = positionKey(record);
    const wallet = normalizeAddress(record.proxyWallet || record.accountWallet || record.user);
    const size = nonNegative(record.size ?? record.quantity ?? record.balance);
    if (!key || !wallet || wallet !== accountWallet || size === null) {
      blockers.push('POSITIONS_MALFORMED_OR_ACCOUNT_MISMATCH');
      continue;
    }
    if (!(size > 0)) continue;
    const values = [
      nonNegative(record.initialValue),
      nonNegative(record.currentValue),
      nonNegative(record.value),
      nonNegative(record.exposureUsd),
    ].filter((value) => value !== null);
    const averagePrice = nonNegative(record.avgPrice ?? record.averagePrice);
    const currentPrice = nonNegative(record.curPrice ?? record.currentPrice ?? record.price);
    if (averagePrice !== null) values.push(size * averagePrice);
    if (currentPrice !== null) values.push(size * currentPrice);
    if (!values.length) {
      blockers.push('POSITION_VALUATION_UNAVAILABLE');
      continue;
    }
    const normalized = { ...record, asset: key, size, conservativeExposureUsd: Math.max(...values) };
    if (byKey.has(key)) {
      const previous = byKey.get(key);
      if (Math.abs(previous.size - size) > 1e-9 || Math.abs(previous.conservativeExposureUsd - normalized.conservativeExposureUsd) > 1e-9) {
        blockers.push('CONFLICTING_DUPLICATE_POSITION');
      }
      continue;
    }
    byKey.set(key, normalized);
  }
  const records = [...byKey.values()];
  return {
    source: envelope.source,
    authenticated: false,
    publicAddressScoped: envelope.publicAddressScoped,
    identityBound: envelope.identityBound,
    fresh: envelope.fresh,
    fetched: envelope.fetched,
    complete: envelope.fetched && envelope.complete && blockers.length === 0,
    count: records.length,
    exposureUsd: envelope.fetched && envelope.complete && blockers.length === 0
      ? records.reduce((sum, record) => sum + record.conservativeExposureUsd, 0)
      : null,
    records,
    blockers,
    quantities: new Map(records.map((record) => [record.asset, record.size])),
  };
}

function orderId(record) {
  return String(record.id || record.orderId || record.order_id || '').trim();
}

function normalizeOpenOrders(envelope, accountWallet, positionQuantities) {
  const blockers = [];
  const byId = new Map();
  let buyExposure = 0;
  let reduceOnlySellNotional = 0;
  const sellSharesByAsset = new Map();
  for (const record of envelope.records) {
    const id = orderId(record);
    if (!id) {
      blockers.push('OPEN_ORDER_ID_MISSING');
      continue;
    }
    if (byId.has(id)) continue;
    const status = String(record.status || record.state || 'LIVE').toUpperCase();
    if (['CANCELLED', 'CANCELED', 'FILLED', 'MATCHED', 'EXPIRED', 'INACTIVE'].includes(status)) continue;
    const maker = normalizeAddress(record.maker_address || record.makerAddress || record.accountWallet);
    const asset = String(record.asset_id || record.assetId || record.tokenId || record.token_id || '').trim();
    const side = String(record.side || '').toUpperCase();
    const price = nonNegative(record.price);
    const original = nonNegative(record.original_size ?? record.originalSize ?? record.size);
    const matched = nonNegative(record.size_matched ?? record.sizeMatched ?? record.matchedSize ?? 0);
    if (!maker || maker !== accountWallet || !asset || !['BUY', 'SELL'].includes(side) || price === null || original === null || matched === null || matched > original + 1e-9) {
      blockers.push('OPEN_ORDER_MALFORMED_OR_ACCOUNT_MISMATCH');
      continue;
    }
    const remainingShares = Math.max(0, original - matched);
    if (!(remainingShares > 0)) continue;
    const remainingNotionalUsd = remainingShares * price;
    const normalized = { ...record, id, asset, side, price, remainingShares, remainingNotionalUsd };
    byId.set(id, normalized);
    if (side === 'BUY') buyExposure += remainingNotionalUsd;
    else {
      const alreadySelling = sellSharesByAsset.get(asset) || 0;
      const held = positionQuantities.get(asset) || 0;
      if (alreadySelling + remainingShares > held + 1e-9) blockers.push('OPEN_SELL_NOT_PROVEN_REDUCE_ONLY');
      else {
        sellSharesByAsset.set(asset, alreadySelling + remainingShares);
        reduceOnlySellNotional += remainingNotionalUsd;
      }
    }
  }
  const records = [...byId.values()];
  return {
    source: envelope.source,
    authenticated: envelope.authenticated,
    publicAddressScoped: false,
    identityBound: envelope.identityBound,
    fresh: envelope.fresh,
    fetched: envelope.fetched,
    complete: envelope.fetched && envelope.complete && envelope.authenticated && blockers.length === 0,
    count: records.length,
    remainingBuyExposureUsd: envelope.fetched && envelope.complete && blockers.length === 0 ? buyExposure : null,
    reduceOnlySellNotionalUsd: envelope.fetched && envelope.complete && blockers.length === 0 ? reduceOnlySellNotional : null,
    records,
    blockers,
  };
}

function normalizeCollateral(envelope) {
  const record = envelope.records[0] || envelope;
  const balanceUsd = finite(record.balanceUsd);
  const rawBalance = finite(record.balance);
  const decimals = Number.isInteger(Number(record.decimals)) ? Number(record.decimals) : 6;
  const normalizedBalance = balanceUsd !== null ? balanceUsd : rawBalance !== null ? rawBalance / (10 ** decimals) : null;
  const complete = envelope.fetched && envelope.complete && envelope.authenticated && envelope.identityBound && normalizedBalance !== null && normalizedBalance >= 0;
  return {
    source: envelope.source,
    authenticated: envelope.authenticated,
    publicAddressScoped: false,
    identityBound: envelope.identityBound,
    fresh: envelope.fresh,
    fetched: envelope.fetched,
    complete,
    balanceUsd: complete ? normalizedBalance : null,
    allowancesPresent: record.allowances && typeof record.allowances === 'object',
    blocker: complete ? null : 'LIVE_COLLATERAL_BALANCE_UNAVAILABLE',
  };
}

function tradeKey(record) {
  return String(record.id || record.tradeId || record.trade_id || [record.transaction_hash, record.asset_id, record.side, record.size, record.price].join(':'));
}

function calculateDailyRealizedPnl(tradesEnvelope, activityEnvelope, nowMs, accountWallet = null) {
  const blockers = [];
  const inventory = new Map();
  const dayStart = utcDayStart(nowMs);
  const tradeCoverageComplete = tradesEnvelope.fetched && tradesEnvelope.complete && tradesEnvelope.authenticated &&
    tradesEnvelope.coverageComplete === true && tradesEnvelope.paginationComplete === true &&
    tradesEnvelope.terminalCursorReached === true && tradesEnvelope.historyWindowStart === 'account_inception';
  const redemptionCoverageComplete = activityEnvelope.fetched && activityEnvelope.complete &&
    activityEnvelope.publicAddressScoped === true && activityEnvelope.identityBound === true &&
    activityEnvelope.coverageComplete === true && activityEnvelope.paginationComplete === true;
  if (!tradeCoverageComplete) blockers.push('LIVE_TRADE_HISTORY_INCOMPLETE', 'LIVE_OPENING_COST_BASIS_UNAVAILABLE');
  if (!redemptionCoverageComplete) blockers.push('LIVE_REDEMPTION_HISTORY_INCOMPLETE');
  const dedupe = new Set();
  const activityDedupe = new Set();
  let realizedPnlUsd = 0;
  const events = [];
  for (const record of tradesEnvelope.records) {
    const key = tradeKey(record);
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const asset = String(record.asset_id || record.assetId || record.tokenId || record.token_id || '').trim();
    const side = String(record.side || '').toUpperCase();
    const size = nonNegative(record.size ?? record.quantity);
    const price = nonNegative(record.price);
    const ts = timestampMs(record.match_time || record.matchTime || record.timestamp || record.created_at);
    const feeRateBps = nonNegative(record.fee_rate_bps ?? record.feeRateBps ?? 0);
    const feeValue = record.feeAmountUsd ?? record.fee_amount_usd;
    const feeUsd = nonNegative(feeValue);
    if (!asset || !['BUY', 'SELL'].includes(side) || size === null || price === null || ts === null || ts > nowMs || feeRateBps === null || (feeValue !== undefined && feeValue !== null && feeUsd === null)) {
      blockers.push('TRADE_HISTORY_MALFORMED');
      continue;
    }
    if (feeRateBps > 0 && feeUsd === null) blockers.push('LIVE_TRADE_FEES_INCOMPLETE');
    events.push({ type: side, asset, size, price, ts, feeUsd: feeUsd ?? 0 });
  }
  for (const record of activityEnvelope.records) {
    const activityWallet = normalizeAddress(record.proxyWallet || record.accountWallet);
    if (accountWallet && activityWallet !== accountWallet) {
      blockers.push('ACCOUNT_ACTIVITY_ACCOUNT_MISMATCH');
      continue;
    }
    const type = String(record.type || '').toUpperCase();
    if (type === 'TRADE') continue;
    const activityKey = String(record.id || record.transactionHash || record.transaction_hash || [type, record.asset, record.size, record.usdcSize, record.timestamp].join(':'));
    if (activityDedupe.has(activityKey)) continue;
    activityDedupe.add(activityKey);
    const ts = timestampMs(record.timestamp || record.created_at);
    if (!['REDEEM', 'MERGE', 'SPLIT', 'CONVERSION'].includes(type)) continue;
    if (ts === null || ts > nowMs) {
      blockers.push('ACCOUNT_ACTIVITY_MALFORMED');
      continue;
    }
    if (type !== 'REDEEM') {
      blockers.push(`UNSUPPORTED_${type}_ACTIVITY`);
      continue;
    }
    const asset = String(record.asset || record.asset_id || record.tokenId || '').trim();
    const size = nonNegative(record.size ?? record.quantity);
    const proceeds = nonNegative(record.usdcSize ?? record.usdc_size ?? record.proceedsUsd);
    if (!asset || size === null || proceeds === null) {
      blockers.push('LIVE_REDEMPTION_HISTORY_INCOMPLETE');
      continue;
    }
    events.push({ type: 'REDEEM', asset, size, proceeds, ts, feeUsd: 0 });
  }

  events.sort((left, right) => left.ts - right.ts);
  for (const event of events) {
    const held = inventory.get(event.asset) || { quantity: 0, costUsd: 0 };
    if (event.type === 'BUY') {
      held.quantity += event.size;
      held.costUsd += event.size * event.price + event.feeUsd;
    } else {
      if (event.size > held.quantity + 1e-9) {
        blockers.push(event.type === 'REDEEM' ? 'LIVE_REDEMPTION_HISTORY_INCOMPLETE' : 'LIVE_TRADE_HISTORY_INCOMPLETE');
        if (event.type !== 'REDEEM') blockers.push('LIVE_OPENING_COST_BASIS_UNAVAILABLE');
        continue;
      }
      const averageCost = held.quantity > 0 ? held.costUsd / held.quantity : 0;
      const proceeds = event.type === 'REDEEM' ? event.proceeds : event.size * event.price - event.feeUsd;
      if (event.ts >= dayStart && event.ts <= nowMs) realizedPnlUsd += proceeds - event.size * averageCost;
      held.quantity -= event.size;
      held.costUsd = Math.max(0, held.costUsd - event.size * averageCost);
    }
    inventory.set(event.asset, held);
  }

  const unique = uniqueBlockers(blockers);
  const complete = tradeCoverageComplete && redemptionCoverageComplete && unique.length === 0;
  return {
    source: `${tradesEnvelope.source} + ${activityEnvelope.source}`,
    fetched: tradesEnvelope.fetched && activityEnvelope.fetched,
    authenticated: tradesEnvelope.authenticated === true,
    publicAddressScoped: activityEnvelope.publicAddressScoped === true,
    identityBound: tradesEnvelope.identityBound === true && activityEnvelope.identityBound === true,
    fresh: tradesEnvelope.fresh !== false && activityEnvelope.fresh !== false,
    complete,
    tradingDayStart: new Date(dayStart).toISOString(),
    dayBoundaryPolicy: 'UTC [00:00:00.000Z, observedAt]',
    historyWindow: {
      start: tradesEnvelope.historyWindowStart || null,
      end: new Date(nowMs).toISOString(),
    },
    pagesFetched: Number(tradesEnvelope.pagesFetched || 0) + Number(activityEnvelope.pagesFetched || 0),
    tradePagesFetched: Number(tradesEnvelope.pagesFetched || 0),
    redemptionPagesFetched: Number(activityEnvelope.pagesFetched || 0),
    coverageComplete: tradeCoverageComplete && redemptionCoverageComplete,
    openingInventorySource: tradeCoverageComplete ? 'complete_all_time_authenticated_trade_history' : null,
    feesComplete: !unique.includes('LIVE_TRADE_FEES_INCOMPLETE'),
    redemptionsComplete: redemptionCoverageComplete && !unique.includes('LIVE_REDEMPTION_HISTORY_INCOMPLETE'),
    realizedPnlUsd: complete ? realizedPnlUsd : null,
    blocker: complete ? null : (unique[0] || 'LIVE_DAILY_PNL_UNCERTAIN'),
    blockers: unique,
    policy: 'UTC day; realized fills and redemptions only; unrealized PnL excluded; actual fees required when fee rate is nonzero; partial fills processed as trades',
  };
}

function calculateRecentOrders(envelope, nowMs, accountWallet = null) {
  const blockers = [];
  const windowStart = nowMs - HOUR_MS;
  const windowEnd = nowMs;
  const ids = new Set();
  const submittedIds = [];
  const timestamps = [];
  const sourceCoverageStart = timestampMs(envelope.requestedWindowStart);
  const sourceCoverageEnd = timestampMs(envelope.requestedWindowEnd);
  const coverageProven = envelope.authoritative === true && envelope.fetched && envelope.complete && envelope.authenticated &&
    envelope.coverageComplete === true && envelope.paginationComplete === true && envelope.terminalCursorReached === true &&
    sourceCoverageStart !== null && sourceCoverageStart <= windowStart && sourceCoverageEnd !== null && sourceCoverageEnd >= windowEnd;
  if (!coverageProven) blockers.push('LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE');
  for (const record of envelope.records) {
    const id = orderId(record);
    const ts = timestampMs(record.created_at || record.createdAt || record.submittedAt || record.timestamp);
    const maker = normalizeAddress(record.maker_address || record.makerAddress || record.accountWallet);
    const status = String(record.status || record.state || '').trim();
    if (!id || ts === null || ts > windowEnd || !status || (accountWallet && maker !== accountWallet)) {
      blockers.push('ORDER_HISTORY_MALFORMED');
      continue;
    }
    if (ids.has(id)) continue;
    ids.add(id);
    timestamps.push(ts);
    if (ts >= windowStart && ts <= windowEnd) submittedIds.push(id);
  }
  const unique = uniqueBlockers(blockers);
  const complete = coverageProven && unique.length === 0;
  return {
    source: envelope.source,
    authenticated: envelope.authenticated === true,
    publicAddressScoped: false,
    identityBound: envelope.identityBound === true,
    fresh: envelope.fresh !== false,
    fetched: envelope.fetched,
    complete,
    requestedWindowStart: new Date(windowStart).toISOString(),
    requestedWindowEnd: new Date(windowEnd).toISOString(),
    oneHourWindowStart: new Date(windowStart).toISOString(),
    pagesFetched: Number(envelope.pagesFetched || 0),
    recordsFetched: Number.isFinite(Number(envelope.recordsFetched)) ? Number(envelope.recordsFetched) : envelope.records.length,
    earliestReturnedTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    latestReturnedTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    coverageComplete: complete,
    deduplicatedSubmittedOrderIds: complete ? submittedIds : [],
    submittedCount: complete ? submittedIds.length : null,
    blocker: complete ? null : (unique[0] || 'LIVE_ORDER_HISTORY_SOURCE_INCOMPLETE'),
    blockers: unique,
    corroboratingEvidence: envelope.corroboratingEvidence || null,
  };
}

async function buildLiveAccountTruthSnapshot({ source, identity = {}, nowMs = Date.now(), maxAgeMs = DEFAULT_SNAPSHOT_TTL_MS, clock = () => nowMs } = {}) {
  const observedAt = new Date(nowMs).toISOString();
  const account = resolveAccountIdentity(identity);
  const positionEnvelope = await callSource(source, 'fetchPositions', 'official_data_api_current_positions');
  const openOrderEnvelope = await callSource(source, 'fetchOpenOrders', 'official_clob_authenticated_open_orders', { authenticated: true });
  const tradeEnvelope = await callSource(source, 'fetchTrades', 'official_clob_authenticated_trade_history', { authenticated: true });
  const activityEnvelope = await callSource(source, 'fetchActivity', 'official_data_api_account_activity');
  const orderHistoryEnvelope = await callSource(source, 'fetchOrderHistory', 'official_clob_authenticated_order_history', { authenticated: true });
  const collateralEnvelope = await callSource(source, 'fetchCollateralBalance', 'official_clob_authenticated_collateral_balance', { authenticated: true });

  const positions = normalizePositions(positionEnvelope, account.resolvedAccountWallet);
  const openOrders = normalizeOpenOrders(openOrderEnvelope, account.resolvedAccountWallet, positions.quantities);
  delete positions.quantities;
  const pnl = calculateDailyRealizedPnl(tradeEnvelope, activityEnvelope, nowMs, account.resolvedAccountWallet);
  const recentOrders = calculateRecentOrders(orderHistoryEnvelope, nowMs, account.resolvedAccountWallet);
  const collateral = normalizeCollateral(collateralEnvelope);
  const positionTrustComplete = positions.complete && positions.publicAddressScoped && positions.identityBound && positions.fresh;
  const openOrderTrustComplete = openOrders.complete && openOrders.authenticated && openOrders.identityBound && openOrders.fresh;
  const pnlTrustComplete = pnl.complete && pnl.authenticated && pnl.publicAddressScoped && pnl.identityBound && pnl.fresh;
  const orderTrustComplete = recentOrders.complete && recentOrders.authenticated && recentOrders.identityBound && recentOrders.fresh;
  const exposureReconciled = account.identityMatches && account.authenticated && positionTrustComplete && openOrderTrustComplete;
  const dailyPnlReconciled = account.identityMatches && account.authenticated && pnlTrustComplete;
  const orderCountReconciled = account.identityMatches && account.authenticated && orderTrustComplete;
  const blockers = uniqueBlockers([
    ...account.blockers,
    ...positions.blockers,
    ...openOrders.blockers,
    ...pnl.blockers,
    ...recentOrders.blockers,
    !positionEnvelope.fetched || !positionEnvelope.complete ? 'LIVE_POSITIONS_INCOMPLETE' : null,
    !openOrderEnvelope.fetched || !openOrderEnvelope.complete || !openOrderEnvelope.authenticated ? 'LIVE_OPEN_ORDERS_INCOMPLETE' : null,
    !dailyPnlReconciled ? 'LIVE_DAILY_PNL_UNCERTAIN' : null,
    !orderCountReconciled ? 'LIVE_ORDER_RATE_UNCERTAIN' : null,
    !exposureReconciled ? 'LIVE_EXPOSURE_UNCERTAIN' : null,
  ]);
  const snapshotAgeMs = Math.max(0, Number(clock()) - nowMs);
  const fresh = Number.isFinite(maxAgeMs) && maxAgeMs > 0 && snapshotAgeMs <= maxAgeMs;
  if (!fresh) blockers.push('LIVE_ACCOUNT_SNAPSHOT_STALE');

  return {
    observedAt,
    account: {
      signerAddress: account.signerAddress,
      configuredAccountWallet: account.configuredAccountWallet,
      resolvedAccountWallet: account.resolvedAccountWallet,
      configuredSignatureType: account.configuredSignatureType,
      resolvedSignatureType: finite(identity.resolvedSignatureType),
      resolvedWalletType: account.resolvedWalletType,
      identityMatches: account.identityMatches,
    },
    positions,
    openOrders,
    collateral,
    pnl,
    recentOrders,
    totals: {
      liveExposureUsd: exposureReconciled ? positions.exposureUsd + openOrders.remainingBuyExposureUsd : null,
      dailyRealizedPnlUsd: dailyPnlReconciled ? pnl.realizedPnlUsd : null,
      ordersLastHour: orderCountReconciled ? recentOrders.submittedCount : null,
    },
    reconciliation: {
      exposureReconciled,
      dailyPnlReconciled,
      orderCountReconciled,
      globalOrderHistoryReconciled: orderCountReconciled,
      trustStatus: exposureReconciled && dailyPnlReconciled && orderCountReconciled
        ? 'identity_bound_external_reconciliation'
        : 'incomplete_external_reconciliation',
      identityBoundExternalReconciliation: exposureReconciled && dailyPnlReconciled && orderCountReconciled,
      authenticatedComponentsComplete: account.authenticated && openOrderTrustComplete && pnl.authenticated && orderTrustComplete,
      publicAddressScopedComponentsComplete: positionTrustComplete && pnl.publicAddressScoped,
      identityBound: account.identityMatches && positions.identityBound && openOrders.identityBound && pnl.identityBound && recentOrders.identityBound,
      fresh,
      snapshotAgeMs,
      maxAgeMs,
      blockers: uniqueBlockers(blockers),
    },
  };
}

function validateCachedSnapshot(snapshot, { nowMs = Date.now(), maxAgeMs = DEFAULT_SNAPSHOT_TTL_MS } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, blocker: 'LIVE_ACCOUNT_SNAPSHOT_UNAVAILABLE', snapshot: null };
  const observedMs = timestampMs(snapshot.observedAt);
  if (observedMs === null) return { ok: false, blocker: 'LIVE_ACCOUNT_SNAPSHOT_MALFORMED', snapshot: null };
  const ageMs = Math.max(0, nowMs - observedMs);
  const fresh = ageMs <= maxAgeMs;
  return {
    ok: fresh,
    blocker: fresh ? null : 'LIVE_ACCOUNT_SNAPSHOT_STALE',
    snapshot: {
      ...snapshot,
      reconciliation: { ...(snapshot.reconciliation || {}), fresh, snapshotAgeMs: ageMs, maxAgeMs },
    },
  };
}

module.exports = {
  DEFAULT_SNAPSHOT_TTL_MS,
  buildLiveAccountTruthSnapshot,
  calculateDailyRealizedPnl,
  calculateRecentOrders,
  normalizeOpenOrders,
  normalizeCollateral,
  normalizePositions,
  resolveAccountIdentity,
  validateCachedSnapshot,
};
