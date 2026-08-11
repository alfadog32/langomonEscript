#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';
delete process.env.STAGE5_PAPER_CANDIDATE_DIAGNOSTICS_PATH;

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG, appendBoundedDiagnosticJsonLine } = require('../moneymaker_v3');

const ROOT = path.resolve(__dirname, '..');
const PROTECTED_FILES = [
  'auto_live_candidates.ndjson',
  'trade_intents.ndjson',
  'live_intent_router_events.ndjson',
  'live_adapter_events.ndjson',
  'live_execution_events.ndjson',
];
const FIXTURES_IMPORTING_PRODUCTION = [
  'dashboard_consistency_selfcheck.js',
  'stage5_candidate_shadow.js',
  'stage5_sizing_selfcheck.js',
  'stage5_writer_parity_selfcheck.js',
  'stage5_locked_off_diagnostic_selfcheck.js',
  'stage5_production_confidence_selfcheck.js',
  'stage5_shadow_upstream_instrumentation_selfcheck.js',
  'stage5_adjusted_risk_parity_selfcheck.js',
  'stage5_adapter_quantization_selfcheck.js',
  'stage5_diagnostic_isolation_selfcheck.js',
];

function state(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, size: null, sha256: null };
  const data = fs.readFileSync(filePath);
  return { exists: true, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

function protectedState() {
  return Object.fromEntries(PROTECTED_FILES.map((name) => [name, state(path.join(ROOT, name))]));
}

function assertFixtureGuards() {
  for (const name of FIXTURES_IMPORTING_PRODUCTION) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
    const mmGuard = source.indexOf("process.env.MM_SKIP_LOCAL_ENV_FILE = 'true'");
    const genericGuard = source.indexOf("process.env.SKIP_LOCAL_ENV_FILE = 'true'");
    const productionRequire = source.search(/require\('\.\.\/(?:moneymaker_v3|dashboard_server|live_intent_router|live_adapter_polymarket)'\)/);
    assert(mmGuard >= 0 && genericGuard >= 0, `${name} must set both environment isolation guards`);
    assert(productionRequire < 0 || (mmGuard < productionRequire && genericGuard < productionRequire), `${name} must set guards before importing production modules`);
  }
}

function assertNoRealEnvAccess(tempDir) {
  const protectedEnvPaths = new Set([
    path.join(ROOT, '.env'),
    path.join(ROOT, '.env.telegram'),
    path.join(ROOT, 'telegram', '.env.telegram'),
  ].map((value) => path.resolve(value)));
  const realRead = fs.readFileSync;
  const realExists = fs.existsSync;
  const guardedPath = (value) => typeof value === 'string' && protectedEnvPaths.has(path.resolve(value));
  fs.readFileSync = function guardedRead(value, ...args) {
    if (guardedPath(value)) throw new Error(`REAL_ENV_READ_ATTEMPT:${value}`);
    return realRead.call(this, value, ...args);
  };
  fs.existsSync = function guardedExists(value) {
    if (guardedPath(value)) throw new Error(`REAL_ENV_EXISTS_ATTEMPT:${value}`);
    return realExists.call(this, value);
  };
  try {
    for (const name of ['moneymaker_v3.js', 'dashboard_server.js', 'live_intent_router.js', 'live_adapter_polymarket.js']) {
      delete require.cache[require.resolve(path.join(ROOT, name))];
    }
    require(path.join(ROOT, 'moneymaker_v3.js'));
    require(path.join(ROOT, 'dashboard_server.js'));
    const router = require(path.join(ROOT, 'live_intent_router.js'));
    const adapter = require(path.join(ROOT, 'live_adapter_polymarket.js'));
    const fakeRoot = path.join(tempDir, 'fake-root');
    fs.mkdirSync(fakeRoot, { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, '.env'), 'STAGE5_ENV_ISOLATION_SENTINEL=must_not_load\n', 'utf8');
    delete process.env.STAGE5_ENV_ISOLATION_SENTINEL;
    router.readConfig(fakeRoot);
    adapter.readConfig(fakeRoot);
    assert.strictEqual(process.env.STAGE5_ENV_ISOLATION_SENTINEL, undefined, 'fixture .env was loaded despite isolation guards');
  } finally {
    fs.readFileSync = realRead;
    fs.existsSync = realExists;
  }
}

function main() {
  const before = protectedState();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-diagnostic-isolation-'));
  try {
    assert.strictEqual(
      CONFIG.stage5PaperCandidateDiagnosticsPath,
      './runtime_monitor/stage5_paper_candidate_diagnostics.ndjson',
      'diagnostic default must live outside the repository root'
    );
    assertFixtureGuards();
    assertNoRealEnvAccess(tempDir);

    const diagnosticPath = path.join(tempDir, 'nested', 'stage5-diagnostic.ndjson');
    const record = { timestamp: new Date().toISOString(), type: 'fixture', padding: 'x'.repeat(560) };
    for (let index = 0; index < 4; index += 1) {
      appendBoundedDiagnosticJsonLine(diagnosticPath, { ...record, index }, 1_024);
    }
    assert.strictEqual(fs.existsSync(path.dirname(diagnosticPath)), true, 'diagnostic parent directory was not created');
    assert.strictEqual(fs.existsSync(diagnosticPath), true, 'current diagnostic file missing');
    assert.strictEqual(fs.existsSync(`${diagnosticPath}.1`), true, 'bounded diagnostic rotation did not occur');
    assert(fs.statSync(diagnosticPath).size <= 1_024, 'current diagnostic file exceeded its bound');
    assert(fs.statSync(`${diagnosticPath}.1`).size <= 1_024, 'rotated diagnostic file exceeded its bound');

    for (const protectedName of PROTECTED_FILES) {
      const protectedPath = path.join(tempDir, protectedName);
      assert.throws(
        () => appendBoundedDiagnosticJsonLine(protectedPath, record, 1_024),
        /missing or protected/,
        `diagnostic writer must reject ${protectedName}`
      );
      assert.strictEqual(fs.existsSync(protectedPath), false);
    }
    assert.deepStrictEqual(protectedState(), before, 'diagnostic fixture modified a protected production event file');
    process.stdout.write('stage5 diagnostic path/rotation/env-isolation selfcheck: ok\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
