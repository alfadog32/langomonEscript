'use strict';

const fs = require('fs');
const path = require('path');
const { buildLiveAccountTruthSnapshot, DEFAULT_SNAPSHOT_TTL_MS } = require('../lib/polymarket_live_account_truth');
const { createReadOnlyAccountTruthSource, resolveOfficialWalletIdentity } = require('../lib/polymarket_live_account_truth_readonly_client');

const REQUIRED_LOCKED_CONTROLS = Object.freeze({
  ENABLE_LIVE_TRADING: 'false',
  LIVE_AUTO_EXECUTE: 'false',
  LIVE_KILL_SWITCH: 'true',
  LIVE_DRY_RUN_ONLY: 'true',
  LIVE_SUBMIT_CONFIRM: 'false',
  LIVE_FINAL_BOSS_READY: 'false',
});

function normalizeBool(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return 'true';
  if (['0', 'false', 'no', 'off'].includes(text)) return 'false';
  return null;
}

function assertLockedOff(env = process.env) {
  const blockers = [];
  for (const [key, expected] of Object.entries(REQUIRED_LOCKED_CONTROLS)) {
    if (normalizeBool(env[key]) !== expected) blockers.push(`${key}_MUST_BE_${expected.toUpperCase()}`);
  }
  if (blockers.length) throw new Error(`READ_ONLY_ACCOUNT_TRUTH_REFUSED:${blockers.join(',')}`);
}

function requiredEnv(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`READ_ONLY_ACCOUNT_TRUTH_MISSING:${key}`);
  return value;
}

function readOperatorConfig(env = process.env, baseDir = process.cwd()) {
  assertLockedOff(env);
  const signatureType = Number(requiredEnv(env, 'POLYMARKET_SIGNATURE_TYPE'));
  if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 3) throw new Error('READ_ONLY_ACCOUNT_TRUTH_INVALID_SIGNATURE_TYPE');
  return {
    baseDir,
    clobHost: env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
    dataApiBaseUrl: env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com',
    relayerBaseUrl: env.POLYMARKET_RELAYER_API_URL || 'https://relayer-v2.polymarket.com',
    gammaBaseUrl: env.POLYMARKET_GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    chainId: Number(env.POLYMARKET_CHAIN_ID || 137),
    expectedSignerAddress: requiredEnv(env, 'LIVE_EXPECTED_SIGNER_ADDRESS'),
    privateKey: requiredEnv(env, 'POLYMARKET_PRIVATE_KEY'),
    accountWallet: requiredEnv(env, 'POLYMARKET_FUNDER_ADDRESS'),
    signatureType,
    apiCreds: {
      key: requiredEnv(env, 'POLYMARKET_API_KEY'),
      secret: requiredEnv(env, 'POLYMARKET_API_SECRET'),
      passphrase: requiredEnv(env, 'POLYMARKET_API_PASSPHRASE'),
    },
    outputPath: path.resolve(baseDir, env.LIVE_ACCOUNT_TRUTH_SNAPSHOT_PATH || './runtime_monitor/polymarket_live_account_truth.json'),
    ttlMs: Number(env.LIVE_ACCOUNT_TRUTH_TTL_MS || DEFAULT_SNAPSHOT_TTL_MS),
  };
}

function createRefusingSigner(signerAddress) {
  async function refuse() { throw new Error('READ_ONLY_SIGNER_REFUSES_SIGNING'); }
  return Object.freeze({
    account: Object.freeze({ address: signerAddress }),
    signTypedData: refuse,
    signMessage: refuse,
    signTransaction: refuse,
    sendTransaction: refuse,
  });
}

function writeSnapshotAtomic(filePath, snapshot) {
  const protectedBasenames = new Set([
    'auto_live_candidates.ndjson',
    'trade_intents.ndjson',
    'live_intent_router_events.ndjson',
    'live_adapter_events.ndjson',
    'live_execution_events.ndjson',
  ]);
  if (protectedBasenames.has(path.basename(filePath))) throw new Error('READ_ONLY_SNAPSHOT_PATH_PROTECTED');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

async function initializeReadonlyAccountTruth({ env = process.env, baseDir = process.cwd(), fetchImpl = globalThis.fetch, sdk = null, deriveSignerAddress = null } = {}) {
  const config = readOperatorConfig(env, baseDir);
  const officialSdk = sdk || await import('@polymarket/clob-client-v2');
  const deriveAddress = deriveSignerAddress || (async (privateKey) => {
    const { privateKeyToAccount } = await import('viem/accounts');
    const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    return privateKeyToAccount(normalized).address;
  });
  const signerAddress = await deriveAddress(config.privateKey);
  config.privateKey = null;
  const signer = createRefusingSigner(signerAddress);
  const rawClient = new officialSdk.ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer,
    creds: config.apiCreds,
    signatureType: config.signatureType,
    funderAddress: config.accountWallet,
    throwOnError: true,
  });
  const resolved = await resolveOfficialWalletIdentity({
    fetchImpl,
    relayerBaseUrl: config.relayerBaseUrl,
    gammaBaseUrl: config.gammaBaseUrl,
    signerAddress,
    accountWallet: config.accountWallet,
    signatureType: config.signatureType,
  });
  const identity = {
      signerAddress,
      expectedSignerAddress: config.expectedSignerAddress,
      configuredAccountWallet: config.accountWallet,
      configuredSignatureType: config.signatureType,
      ...resolved,
  };
  return Object.freeze({
    config: Object.freeze({ ...config, apiCreds: undefined, privateKey: undefined }),
    async refresh({ nowMs = Date.now() } = {}) {
      const source = createReadOnlyAccountTruthSource({
        clobClient: rawClient,
        fetchImpl,
        dataApiBaseUrl: config.dataApiBaseUrl,
        accountWallet: config.accountWallet,
      });
      return buildLiveAccountTruthSnapshot({ source, identity, nowMs, maxAgeMs: config.ttlMs, clock: () => nowMs });
    },
  });
}

async function runReadonlyAccountTruth(options = {}) {
  const runtime = await initializeReadonlyAccountTruth(options);
  const snapshot = await runtime.refresh();
  const outputPath = runtime.config.outputPath;
  writeSnapshotAtomic(outputPath, snapshot);
  return { snapshot, outputPath };
}

function sanitizedErrorMessage(error, env = process.env) {
  let message = String(error?.message || error || 'unknown error');
  for (const key of ['POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE', 'POLYMARKET_PRIVATE_KEY', 'PRIVATE_KEY']) {
    const secret = String(env[key] || '');
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message;
}

if (require.main === module) {
  runReadonlyAccountTruth().then(({ snapshot, outputPath }) => {
    console.log(JSON.stringify({ outputPath, snapshot }, null, 2));
    if (snapshot.reconciliation.blockers.length > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: sanitizedErrorMessage(error) }));
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_LOCKED_CONTROLS,
  assertLockedOff,
  createRefusingSigner,
  initializeReadonlyAccountTruth,
  readOperatorConfig,
  runReadonlyAccountTruth,
  sanitizedErrorMessage,
  writeSnapshotAtomic,
};
