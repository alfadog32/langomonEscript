#!/usr/bin/env node
'use strict';

// Locked-off observer only. It neither changes process configuration nor starts
// PM2; the engine must already be running with its safe shadow flag enabled.
const fs = require('fs');
const path = require('path');
const { resolveStage5GabagoolConfidenceFloor } = require('../lib/stage5_policy');

const required = {
  ENABLE_LIVE_TRADING: 'false', LIVE_AUTO_EXECUTE: 'false', LIVE_KILL_SWITCH: 'true',
  LIVE_DRY_RUN_ONLY: 'true', LIVE_SUBMIT_CONFIRM: 'false', LIVE_FINAL_BOSS_READY: 'false',
  LIVE_TRADING_STAGE: '2', STAGE5_CANARY_GABAGOOL_MIN_CONFIDENCE: '0.70',
};
const bad = Object.keys(required).filter((key) => process.env[key] !== required[key]);
if (bad.length || process.env.STAGE5_CANDIDATE_SHADOW_ENABLED !== 'true') {
  throw new Error(`locked-off Stage 5 shadow watch refused: ${[...bad, 'STAGE5_CANDIDATE_SHADOW_ENABLED'].join(',')}`);
}
const file = path.resolve(process.env.STAGE5_CANDIDATE_SHADOW_PATH || './stage5_candidate_shadow.ndjson');
const out = path.resolve(process.env.STAGE5_CANDIDATE_SHADOW_SUMMARY_PATH || './stage5_candidate_shadow_summary.json');
const timeoutMs = Math.min(15 * 60_000, Math.max(1_000, Number(process.env.STAGE5_SHADOW_WATCH_MS || 15 * 60_000)));
const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;
const started = Date.now();
const records = [];
const timer = setInterval(() => {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  for (const line of lines.slice(before + records.length)) records.push(JSON.parse(line));
  const eligible = records.find((row) => row.wouldWriteStage5Candidate === true);
  if (eligible || Date.now() - started >= timeoutMs) {
    clearInterval(timer);
    const blockers = {};
    for (const row of records) blockers[row.finalBlocker || 'unknown'] = (blockers[row.finalBlocker || 'unknown'] || 0) + 1;
    const numeric = (key) => records.map((row) => Number(row[key])).filter(Number.isFinite);
    const confidence = numeric('confidence'); const prices = numeric('candidatePrice'); const shares = numeric('sizeShares');
    const summary = { startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), evaluationCount: records.length,
      eligibleCount: records.filter((row) => row.wouldWriteStage5Candidate === true).length, blockerCounts: blockers,
      dominantBlocker: Object.entries(blockers).sort((a,b) => b[1] - a[1])[0]?.[0] || null,
      highestObservedConfidence: confidence.length ? Math.max(...confidence) : null, effectiveStage5Floor: resolveStage5GabagoolConfidenceFloor(),
      minObservedPrice: prices.length ? Math.min(...prices) : null, maxObservedPrice: prices.length ? Math.max(...prices) : null,
      minObservedSizeShares: shares.length ? Math.min(...shares) : null, maxObservedSizeShares: shares.length ? Math.max(...shares) : null,
      eligibleMarketId: eligible?.marketId || null, eligibleMarketSlug: eligible?.marketSlug || null };
    fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`stage5 shadow watch: ${eligible ? 'eligible opportunity observed' : 'timeout'}; ${out}\n`);
    process.exit(0);
  }
}, 1000);
