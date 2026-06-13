'use strict';

/**
 * BTC Polymarket 5m Auto-Discovery Runner
 * ---------------------------------------
 * Discovers the active Polymarket BTC Up/Down 5-minute market, writes
 * btc_oracle_market_target.json, and runs btc_poly_oracle_v5_sniper_bridge_FIXED.js
 * with BTC_UP_TOKEN_ID / BTC_DOWN_TOKEN_ID injected into the child environment.
 *
 * This runner does NOT place trades. It only discovers target tokens and starts
 * the oracle bridge that emits alert/signal files.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

loadDotEnvFile();

const CONFIG = {
  gammaBaseUrl: envStr('GAMMA_BASE_URL', 'https://gamma-api.polymarket.com'),
  slugPrefix: envStr('BTC_ORACLE_SLUG_PREFIX', 'btc-updown-5m'),
  intervalMs: envInt('BTC_ORACLE_INTERVAL_MS', 5 * 60 * 1000),
  lookbackWindows: envInt('BTC_ORACLE_LOOKBACK_WINDOWS', 1),
  lookaheadWindows: envInt('BTC_ORACLE_LOOKAHEAD_WINDOWS', 3),
  pollMs: envInt('BTC_ORACLE_DISCOVERY_POLL_MS', 20_000),
  requestTimeoutMs: envInt('BTC_ORACLE_DISCOVERY_TIMEOUT_MS', 8_000),
  requestRetries: envInt('BTC_ORACLE_DISCOVERY_RETRIES', 1),
  targetPath: envStr('BTC_ORACLE_TARGET_PATH', './btc_oracle_market_target.json'),
  bridgeFile: envStr('BTC_ORACLE_BRIDGE_FILE', './btc_poly_oracle_v5_sniper_bridge_FIXED.js'),
  autoStartChild: envBool('BTC_ORACLE_AUTOSTART_CHILD', true),
  childRestartMs: envInt('BTC_ORACLE_CHILD_RESTART_MS', 5_000),
  staleTargetGraceMs: envInt('BTC_ORACLE_STALE_TARGET_GRACE_MS', 45_000),
  heartbeatMs: envInt('BTC_ORACLE_RUNNER_HEALTH_MS', 30_000),
  logPrefix: envStr('BTC_ORACLE_RUNNER_LOG_PREFIX', '[BTC-AUTO]'),
  externalSignalEventsPath: envStr('BTC_ORACLE_EXTERNAL_EVENTS_PATH', './external_signal_events.ndjson'),
  externalSignalsPath: envStr('BTC_ORACLE_EXTERNAL_SIGNALS_JSON_PATH', './external_signals.json'),
  tradeIntentPath: envStr('BTC_ORACLE_TRADE_INTENTS_PATH', './trade_intents.ndjson'),
  sniperRoutePath: envStr('BTC_ORACLE_SNIPER_ROUTE_PATH', './sniper_route_requests.ndjson'),
  autoLiveCandidatesPath: envStr('AUTO_LIVE_CANDIDATES_PATH', './auto_live_candidates.ndjson'),
  writeTestEvent: envBool('BTC_ORACLE_WRITE_TEST_EVENT', false),
};

let activeKey = null;
let activeTarget = null;
let child = null;
let childRestartTimer = null;
let pendingTargetStart = null;
let stopping = false;
let cycleInFlight = false;
let lastDiscoveryAt = 0;
let lastPollAt = 0;
let nextPollAt = 0;
let lastBridgeStartAt = 0;
let lastBridgeExitAt = 0;
let bridgeRestartCount = 0;
let lastBridgeRestartReason = 'none';
const expectedStops = new Map();

function loadDotEnvFile(filePath = path.join(process.cwd(), '.env')) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');

    for (const originalLine of raw.split(/\r?\n/)) {
      const line = originalLine.trim();
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
  } catch (error) {
    warn(`Failed to load .env: ${error.message}`);
  }
}

function envStr(name, fallback) {
  return process.env[name] ?? fallback;
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function nowIso() {
  return new Date().toISOString();
}

function info(message) {
  console.log(`${nowIso()} ${CONFIG.logPrefix} ${message}`);
}

function warn(message) {
  console.warn(`${nowIso()} ${CONFIG.logPrefix} WARN ${message}`);
}

function error(message) {
  console.error(`${nowIso()} ${CONFIG.logPrefix} ERROR ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMkdirForFile(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function pathDiagnostics(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const root = path.resolve(process.cwd());
  const dir = path.dirname(resolved);
  const underProject = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  let directoryExists = false;
  let directoryWritable = false;
  let error = null;

  try {
    directoryExists = fs.existsSync(dir);
    if (directoryExists) {
      fs.accessSync(dir, fs.constants.W_OK);
      directoryWritable = true;
    }
  } catch (err) {
    error = err.message;
  }

  return { path: filePath, resolved, dir, directoryExists, directoryWritable, underProject, error };
}

function outputPathDiagnostics() {
  return {
    externalSignalEventsPath: pathDiagnostics(CONFIG.externalSignalEventsPath),
    externalSignalsPath: pathDiagnostics(CONFIG.externalSignalsPath),
    tradeIntentPath: pathDiagnostics(CONFIG.tradeIntentPath),
    sniperRoutePath: pathDiagnostics(CONFIG.sniperRoutePath),
    autoLiveCandidatesPath: pathDiagnostics(CONFIG.autoLiveCandidatesPath),
  };
}

function atomicWriteJson(filePath, obj) {
  safeMkdirForFile(filePath);
  const abs = path.resolve(filePath);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, abs);
}

function parseMaybeJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;

    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {
      return trimmed.split(',').map((x) => x.trim()).filter(Boolean);
    }
  }

  return fallback;
}

function currentWindowStartSec(nowMs = Date.now()) {
  const intervalSec = Math.max(60, Math.floor(CONFIG.intervalMs / 1000));
  return Math.floor(Math.floor(nowMs / 1000) / intervalSec) * intervalSec;
}

function buildCandidateSlugs(nowMs = Date.now()) {
  const start = currentWindowStartSec(nowMs);
  const intervalSec = Math.max(60, Math.floor(CONFIG.intervalMs / 1000));
  const candidates = [];

  for (let offset = -Math.max(0, CONFIG.lookbackWindows); offset <= Math.max(0, CONFIG.lookaheadWindows); offset += 1) {
    const ts = start + offset * intervalSec;
    candidates.push({
      slug: `${CONFIG.slugPrefix}-${ts}`,
      ts,
      utc: new Date(ts * 1000).toISOString(),
      selection: offset === 0 ? 'current' : offset < 0 ? 'previous' : 'next',
    });
  }

  candidates.sort((a, b) => {
    const rank = { current: 0, next: 1, previous: 2 };
    const ra = rank[a.selection] ?? 9;
    const rb = rank[b.selection] ?? 9;
    if (ra !== rb) return ra - rb;
    return Math.abs(a.ts - start) - Math.abs(b.ts - start);
  });

  return candidates;
}

async function fetchJsonWithRetry(url) {
  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.requestRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'btc-poly-oracle-auto-discovery-runner/1.0',
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < CONFIG.requestRetries) await sleep(300 * (attempt + 1));
    }
  }

  throw lastError;
}

function normalizeMarketPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.markets)) return payload.markets;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

function extractTokens(market) {
  const outcomes = parseMaybeJson(market.outcomes ?? market.outcomeNames ?? market.shortOutcomes, []);
  const tokenIds = parseMaybeJson(market.clobTokenIds ?? market.clob_token_ids ?? market.tokens, []);

  let normalizedTokens = tokenIds.map((token) => {
    if (typeof token === 'string' || typeof token === 'number' || typeof token === 'bigint') return String(token);
    return String(token?.token_id ?? token?.tokenId ?? token?.id ?? token?.asset_id ?? token?.assetId ?? '');
  }).filter(Boolean);

  if (normalizedTokens.length < 2 && Array.isArray(market.tokens)) {
    normalizedTokens = market.tokens
      .map((token) => String(token.token_id ?? token.tokenId ?? token.id ?? token.asset_id ?? token.assetId ?? ''))
      .filter(Boolean);
  }

  const normalizedOutcomes = outcomes.map((outcome) => {
    if (typeof outcome === 'string' || typeof outcome === 'number' || typeof outcome === 'bigint') return String(outcome);
    return String(outcome?.name ?? outcome?.outcome ?? outcome?.title ?? '');
  }).filter(Boolean);

  if (normalizedTokens.length < 2) {
    return { ok: false, reason: 'missing_clob_token_ids', outcomes: normalizedOutcomes, clobTokenIds: normalizedTokens };
  }

  let upIndex = normalizedOutcomes.findIndex((x) => /\bup\b/i.test(x));
  let downIndex = normalizedOutcomes.findIndex((x) => /\bdown\b/i.test(x));

  if (upIndex < 0) upIndex = 0;
  if (downIndex < 0) downIndex = upIndex === 0 ? 1 : 0;

  return {
    ok: true,
    reason: 'ok',
    outcomes: normalizedOutcomes.length ? normalizedOutcomes : ['Up', 'Down'],
    clobTokenIds: normalizedTokens,
    upTokenId: normalizedTokens[upIndex],
    downTokenId: normalizedTokens[downIndex],
  };
}

function marketLooksUsable(market) {
  if (!market || typeof market !== 'object') return false;
  if (market.closed === true) return false;
  if (market.archived === true) return false;
  if (market.acceptingOrders === false) return false;
  if (market.enableOrderBook === false) return false;
  return true;
}

async function fetchMarketBySlug(candidate) {
  const url = new URL('/markets', CONFIG.gammaBaseUrl);
  url.searchParams.set('slug', candidate.slug);

  const payload = await fetchJsonWithRetry(url.toString());
  const markets = normalizeMarketPayload(payload).filter(marketLooksUsable);

  if (markets.length === 0) {
    return { ok: false, reason: 'market_not_found_or_unusable', candidate, sourceUrl: url.toString() };
  }

  const market = markets[0];
  const tokens = extractTokens(market);

  if (!tokens.ok) {
    return { ok: false, reason: tokens.reason, candidate, market, sourceUrl: url.toString() };
  }

  const question = String(market.question ?? market.title ?? market.slug ?? candidate.slug);
  const slug = String(market.slug ?? candidate.slug);
  const activeKey = `${slug}:${tokens.upTokenId}:${tokens.downTokenId}`;

  return {
    ok: true,
    activeKey,
    target: {
      question,
      slug,
      ts: candidate.ts,
      utc: candidate.utc,
      outcomes: tokens.outcomes,
      clobTokenIds: tokens.clobTokenIds,
      BTC_UP_TOKEN_ID: tokens.upTokenId,
      BTC_DOWN_TOKEN_ID: tokens.downTokenId,
      selection: candidate.selection,
      sourceUrl: url.toString(),
      rawMarketId: String(market.id ?? market.conditionId ?? market.condition_id ?? ''),
    },
  };
}

async function discoverTarget() {
  const testedSlugs = [];
  const errors = [];

  for (const candidate of buildCandidateSlugs()) {
    testedSlugs.push(`${candidate.slug} ${candidate.utc}`);

    try {
      const result = await fetchMarketBySlug(candidate);
      if (result.ok) {
        return {
          timestamp: nowIso(),
          note: 'target-found',
          activeKey: result.activeKey,
          childPid: child?.pid ?? null,
          target: {
            ...result.target,
            testedSlugs,
          },
        };
      }
      errors.push({ slug: candidate.slug, reason: result.reason });
    } catch (err) {
      errors.push({ slug: candidate.slug, reason: err.message });
    }
  }

  return {
    timestamp: nowIso(),
    note: 'target-not-found',
    activeKey: null,
    childPid: child?.pid ?? null,
    target: null,
    testedSlugs,
    errors,
  };
}

function bridgeAbsPath() {
  return path.resolve(process.cwd(), CONFIG.bridgeFile);
}

function stopChild(reason = 'stopping') {
  clearTimeout(childRestartTimer);
  childRestartTimer = null;

  if (!child || child.exitCode !== null) return false;

  const oldChild = child;
  expectedStops.set(oldChild.pid, { reason, at: Date.now() });

  info(`Stopping bridge child pid=${oldChild.pid} reason=${reason}`);
  try {
    oldChild.kill('SIGTERM');
  } catch (err) {
    warn(`Failed to signal bridge child pid=${oldChild.pid}: ${err.message}`);
  }

  setTimeout(() => {
    if (oldChild.exitCode === null && oldChild.signalCode === null) {
      try {
        oldChild.kill('SIGKILL');
        warn(`Force killed bridge child pid=${oldChild.pid} after SIGTERM grace`);
      } catch (_) {
        // ignored
      }
    }
  }, 5_000).unref?.();
  return true;
}

function startChildForTarget(targetDoc) {
  if (!CONFIG.autoStartChild) {
    info('Child autostart disabled by BTC_ORACLE_AUTOSTART_CHILD=false');
    return;
  }

  if (!targetDoc?.target?.BTC_UP_TOKEN_ID || !targetDoc?.target?.BTC_DOWN_TOKEN_ID) {
    warn('Refusing to start child: target token IDs are missing');
    return;
  }

  const bridge = bridgeAbsPath();
  if (!fs.existsSync(bridge)) {
    warn(`Refusing to start child: bridge file missing at ${bridge}`);
    return;
  }

  if (child && child.exitCode === null) {
    pendingTargetStart = targetDoc;
    stopChild('new target or restart');
    info(`Deferring bridge start until previous child exits nextSlug=${targetDoc.target.slug}`);
    return;
  }

  pendingTargetStart = null;

  const env = {
    ...process.env,
    BTC_UP_TOKEN_ID: targetDoc.target.BTC_UP_TOKEN_ID,
    BTC_DOWN_TOKEN_ID: targetDoc.target.BTC_DOWN_TOKEN_ID,
    BTC_ORACLE_MARKET_SLUG: targetDoc.target.slug,
    BTC_ORACLE_MARKET_QUESTION: targetDoc.target.question,
    BTC_ORACLE_TARGET_PATH: path.resolve(CONFIG.targetPath),
  };

  child = spawn(process.execPath, [bridge], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });

  lastBridgeStartAt = Date.now();
  bridgeRestartCount += 1;
  lastBridgeRestartReason = 'new target or restart';
  info(`Started bridge child pid=${child.pid} slug=${targetDoc.target.slug} up=${shortId(targetDoc.target.BTC_UP_TOKEN_ID)} down=${shortId(targetDoc.target.BTC_DOWN_TOKEN_ID)}`);

  const startedAt = lastBridgeStartAt;
  const slug = targetDoc.target.slug;
  const pid = child.pid;
  child.on('exit', (code, signal) => {
    const uptimeSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const expected = expectedStops.get(pid) || null;
    expectedStops.delete(pid);
    lastBridgeExitAt = Date.now();
    if (child?.pid === pid) child = null;
    info(`[BTC-AUTO BRIDGE EXIT] pid=${pid} code=${code ?? 'null'} signal=${signal ?? 'null'} uptimeSec=${uptimeSec} expected=${Boolean(expected)} reason=${expected?.reason || 'unexpected_exit'}`);
    if (code === 0 && uptimeSec < 10) {
      warn(`[BTC-AUTO BRIDGE SHORT EXIT] pid=${pid} code=0 uptimeSec=${uptimeSec} slug=${slug} note=bridge exited too quickly after start`);
    }

    if (stopping || !activeTarget || !CONFIG.autoStartChild) return;
    if (pendingTargetStart) {
      const nextTarget = pendingTargetStart;
      pendingTargetStart = null;
      startChildForTarget(nextTarget);
      return;
    }
    if (targetIsStale(activeTarget)) {
      info('Not restarting bridge child because target is stale/expired');
      return;
    }

    clearTimeout(childRestartTimer);
    childRestartTimer = setTimeout(() => {
      lastBridgeRestartReason = 'unexpected child exit';
      if (!stopping && activeTarget && !child) startChildForTarget(activeTarget);
    }, CONFIG.childRestartMs);
  });
}

function shortId(value) {
  const s = String(value || '');
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function targetIsStale(targetDoc) {
  const ts = Number(targetDoc?.target?.ts);
  if (!Number.isFinite(ts)) return false;
  const endMs = ts * 1000 + CONFIG.intervalMs;
  return Date.now() > endMs + CONFIG.staleTargetGraceMs;
}

async function cycle() {
  if (cycleInFlight) return;
  cycleInFlight = true;
  lastPollAt = Date.now();
  nextPollAt = lastPollAt + Math.max(5_000, CONFIG.pollMs);

  try {
    const discovered = await discoverTarget();
    lastDiscoveryAt = Date.now();

    if (discovered.note !== 'target-found') {
      atomicWriteJson(CONFIG.targetPath, discovered);
      warn(`No target found. Tested: ${(discovered.testedSlugs || []).join(', ')}`);

      if (activeTarget && targetIsStale(activeTarget)) {
        stopChild('active target stale and no replacement found');
        activeKey = null;
        activeTarget = null;
      }
      return;
    }

    if (discovered.activeKey !== activeKey) {
      activeKey = discovered.activeKey;
      activeTarget = discovered;
      atomicWriteJson(CONFIG.targetPath, discovered);
      info(`Target found: ${discovered.target.question} slug=${discovered.target.slug}`);
      startChildForTarget(discovered);
      return;
    }

    activeTarget = {
      ...discovered,
      childPid: child?.pid ?? null,
    };
    atomicWriteJson(CONFIG.targetPath, activeTarget);
  } catch (err) {
    error(`Discovery cycle failed: ${err.stack || err.message}`);
  } finally {
    cycleInFlight = false;
  }
}

function bridgeAlive() {
  return Boolean(child && !child.killed && child.exitCode === null);
}

function heartbeat() {
  const now = Date.now();
  const targetTs = Number(activeTarget?.target?.ts);
  const targetAgeSec = Number.isFinite(targetTs) ? Math.max(0, Math.round((now - targetTs * 1000) / 1000)) : null;
  const bridgeUptimeSec = bridgeAlive() && lastBridgeStartAt ? Math.max(0, Math.round((now - lastBridgeStartAt) / 1000)) : 0;
  info(
    `[BTC-AUTO HEALTH] currentSlug=${activeTarget?.target?.slug || 'none'} ` +
    `upToken=${shortId(activeTarget?.target?.BTC_UP_TOKEN_ID)} downToken=${shortId(activeTarget?.target?.BTC_DOWN_TOKEN_ID)} ` +
    `bridgePid=${child?.pid || 'none'} bridgeAlive=${bridgeAlive()} targetAgeSec=${targetAgeSec ?? 'NA'} ` +
    `lastDiscoveryAgeSec=${lastDiscoveryAt ? Math.round((now - lastDiscoveryAt) / 1000) : 'NA'} ` +
    `pollMs=${CONFIG.pollMs} bridgeRestartCount=${bridgeRestartCount} lastBridgeRestartReason=${lastBridgeRestartReason} ` +
    `lastBridgeExitAgeSec=${lastBridgeExitAt ? Math.round((now - lastBridgeExitAt) / 1000) : 'NA'} ` +
    `bridgeUptimeSec=${bridgeUptimeSec} nextPollDueSec=${nextPollAt ? Math.max(0, Math.round((nextPollAt - now) / 1000)) : 'NA'}`
  );
}

function printDoctor() {
  const bridge = bridgeAbsPath();
  const report = {
    mode: 'doctor',
    cwd: process.cwd(),
    config: {
      gammaBaseUrl: CONFIG.gammaBaseUrl,
      slugPrefix: CONFIG.slugPrefix,
      intervalMs: CONFIG.intervalMs,
      pollMs: CONFIG.pollMs,
      autoStartChild: CONFIG.autoStartChild,
      writeTestEvent: CONFIG.writeTestEvent,
    },
    bridge: {
      path: bridge,
      exists: fs.existsSync(bridge),
    },
    target: pathDiagnostics(CONFIG.targetPath),
    outputPaths: outputPathDiagnostics(),
    networkConnectionsStarted: false,
    bridgeStarted: false,
    filesWritten: false,
    tradingEnabled: false,
  };
  console.log(JSON.stringify(report, null, 2));
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  info(`Received ${signal}; shutting down runner`);
  clearTimeout(childRestartTimer);
  pendingTargetStart = null;
  stopChild(`runner ${signal}`);
  setTimeout(() => process.exit(0), 500).unref?.();
}

async function main() {
  if (process.argv[2] === 'doctor') {
    printDoctor();
    return;
  }

  info('Starting BTC oracle auto-discovery runner');
  info(`cwd=${process.cwd()} bridge=${bridgeAbsPath()} pollMs=${CONFIG.pollMs}`);
  info(`outputs externalEvents=${path.resolve(CONFIG.externalSignalEventsPath)} externalSignals=${path.resolve(CONFIG.externalSignalsPath)} tradeIntents=${path.resolve(CONFIG.tradeIntentPath)} sniperRoute=${path.resolve(CONFIG.sniperRoutePath)}`);

  await cycle();
  setInterval(cycle, Math.max(5_000, CONFIG.pollMs));
  setInterval(heartbeat, Math.max(5_000, CONFIG.heartbeatMs));
}

if (require.main === module) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    error(`Uncaught exception: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (err) => {
    error(`Unhandled rejection: ${err?.stack || err?.message || err}`);
  });

  main().catch((err) => {
    error(`Fatal start error: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIG,
  buildCandidateSlugs,
  extractTokens,
  pathDiagnostics,
  outputPathDiagnostics,
  printDoctor,
};
