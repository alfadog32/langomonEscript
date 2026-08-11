#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotEngine } = require('../moneymaker_v3');

const ROOT = path.resolve(__dirname, '..');
const protectedFiles = [
  'auto_live_candidates.ndjson',
  'trade_intents.ndjson',
  'live_intent_router_events.ndjson',
  'live_adapter_events.ndjson',
  'live_execution_events.ndjson',
];

function fileState(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, sha256: null, size: null };
  const data = fs.readFileSync(filePath);
  return { exists: true, sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
}

function protectedState() {
  return Object.fromEntries(protectedFiles.map((file) => [file, fileState(path.join(ROOT, file))]));
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-locked-diagnostic-'));
  try {
    const diagnosticPath = path.join(tempDir, 'paper-candidate-diagnostics.ndjson');
    const context = Object.create(BotEngine.prototype);
    Object.assign(context, {
      config: {
        enableLiveTrading: false,
        liveAutoExecute: false,
        liveKillSwitch: true,
        liveDryRunOnly: true,
        liveSubmitConfirm: false,
        liveFinalBossReady: false,
        liveTradingStage: 0,
        stage5PaperCandidateDiagnosticsPath: diagnosticPath,
        autoLiveCandidatesPath: path.join(tempDir, 'auto_live_candidates.ndjson'),
        autoLiveAllowedStrategies: ['GabagoolBtcOracleStrategy'],
        autoLiveBlockedStrategies: [],
        autoLiveCandidateCooldownMs: 0,
        autoLiveMaxBookAgeMs: 1_500,
        autoLiveMinConfidence: 0.7,
        autoLiveMinGhostFavorablePct: 0,
        enableConsensus: false,
        stage5CanaryGabagoolMinConfidence: 0.7,
      },
      portfolio: { ghostStats: { total: 0, favorable: 0 } },
      currentLiveExposureUsd: 0,
      currentLiveExposureSource: 'fixture_engine_maintained_unreconciled',
      currentLiveExposureReconciled: false,
      autoLiveCandidateLastWritten: new Map(),
      adjustedCandidateRiskApprovals: new WeakMap(),
      currentLiveExposureSnapshot: () => ({
        value: 0,
        source: 'fixture_authenticated_account_truth',
        authenticatedReconciliation: true,
      }),
    });
    const signal = {
      strategy: 'GabagoolBtcOracleStrategy', tokenId: 'token-up', marketId: 'market-5',
      side: 'buy', price: 0.74, sizeUsd: 2, confidence: 0.8, expectedEdge: 0.1,
      _riskApproved: true, metadata: { marketSlug: 'fixture', outcome: 'Up' },
    };
    const asset = { market: { marketId: 'market-5', slug: 'fixture' }, outcome: 'Up' };
    const book = {
      bestBid: 0.73, bestAsk: 0.74, midpoint: 0.735, spread: 0.01,
      bids: [[0.73, 20]], asks: [[0.74, 20]], cachedAt: Date.now() - 50, minOrderSize: 5,
    };
    context.adjustedCandidateRiskApprovals.set(signal, {
      paperRiskApprovedSizeUsd: 2,
      adjustedCandidateSizeUsd: 3.7,
      adjustedSizeRiskApproved: true,
      adjustedSizeRiskBlocker: null,
      riskApprovedSizeUsd: 3.7,
    });

    const before = protectedState();
    const record = context.recordPostPlacementStage5CandidateDiagnostic({ signal, asset, book });
    const after = protectedState();
    assert.deepStrictEqual(after, before, 'locked-off diagnostics must not modify production event files');
    assert(record && record.finalEligibility === true);
    assert.strictEqual(record.paperPlacementSucceeded, true);
    assert.strictEqual(record.stage5SizingEvaluated, true);
    assert.strictEqual(record.stage5CandidateGateEligible, true);
    assert.strictEqual(record.stage5AdjustedRiskEligible, true);
    assert.strictEqual(record.stage5EligibilityBlocker, null);
    assert.strictEqual(record.originalPaperSizeUsd, 2);
    assert(record.adjustedStage5SizeUsd >= 3.70);
    assert(record.adjustedShares >= 5);
    assert.strictEqual(record.wasResized, true);
    assert.strictEqual(fs.existsSync(diagnosticPath), true);
    assert.strictEqual(fs.existsSync(context.config.autoLiveCandidatesPath), false);
    for (const file of protectedFiles.slice(1)) {
      assert.strictEqual(fs.existsSync(path.join(tempDir, file)), false);
    }

    context.config.stage5PaperCandidateDiagnosticsPath = path.join(tempDir, 'trade_intents.ndjson');
    assert.strictEqual(context.recordPostPlacementStage5CandidateDiagnostic({ signal, asset, book }), false);
    assert.strictEqual(fs.existsSync(context.config.stage5PaperCandidateDiagnosticsPath), false);

    process.stdout.write('stage5 locked-off diagnostic no-write selfcheck: ok\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
