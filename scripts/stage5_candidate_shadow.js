#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

// Offline-only Stage 5 candidate evaluator. It consumes operator-provided
// signal/book fixtures and writes only the requested shadow audit NDJSON; it
// never imports the router or adapter and never writes production candidates.
const fs = require('fs');
const path = require('path');
const { evaluateStage5CandidateShadow } = require('../moneymaker_v3');
const { resolveStage5GabagoolConfidenceFloor } = require('../lib/stage5_policy');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseInput(overrides = {}) {
  return {
    signal: { strategy: 'GabagoolBtcOracleStrategy', tokenId: 'token-up', marketId: 'market-5', side: 'buy', price: 0.8, sizeUsd: 5, confidence: 0.70, expectedEdge: 0.1 },
    asset: { market: { marketId: 'market-5', slug: 'btc-updown-5m-fixture' }, outcome: 'Up' },
    book: { bestBid: 0.79, bestAsk: 0.8, midpoint: 0.795, spread: 0.01, bids: [[0.79, 20]], asks: [[0.8, 20]], cachedAt: 1_000, minOrderSize: 5 },
    config: { liveTradingStage: 5, liveCanaryMarketId: 'market-5', stage5CanaryGabagoolMinConfidence: resolveStage5GabagoolConfidenceFloor(), gabagoolMinConfidenceLive: 0.70, autoLiveMaxBookAgeMs: 1_500, maxLiveOrderUsd: 5, maxLiveTotalExposureUsd: 5, liveDailyMaxLossUsd: 5, liveMaxOrdersPerHour: 1 },
    currentLiveExposureUsd: 0,
    upstreamGates: { oracleFresh: true, oracleConfirmed: true, duplicateSignal: false, volatilityAllowed: true, depthAllowed: true, highPriceAllowed: true, sophieApproved: true, riskApproved: true },
    now: 1_500,
    ...overrides,
  };
}

function selfcheck() {
  const incomplete = evaluateStage5CandidateShadow(baseInput({ upstreamGates: {} }));
  assert(incomplete.finalBlocker === 'shadow_input_incomplete' && incomplete.missingGates.includes('oracleFresh'), 'missing upstream gates must fail closed');
  const normal = evaluateStage5CandidateShadow(baseInput({ config: { ...baseInput().config, liveTradingStage: 4, liveCanaryMarketId: 'market-5' } }));
  assert(normal.finalBlocker === 'not_stage5', 'normal profile must not be treated as a Stage 5 canary');
  const pass = evaluateStage5CandidateShadow(baseInput());
  assert(pass.wouldWriteStage5Candidate, '0.70 must pass the authoritative Stage 5 floor');
  const belowFloor = evaluateStage5CandidateShadow(baseInput({ signal: { ...baseInput().signal, confidence: 0.69 } }));
  assert(belowFloor.finalBlocker === 'confidence_below_min', '0.69 must fail the authoritative 0.70 live floor');
  assert(evaluateStage5CandidateShadow(baseInput({ signal: { ...baseInput().signal, price: 0 } })).finalBlocker === 'invalid_price', 'zero price must block');
  assert(evaluateStage5CandidateShadow(baseInput({ upstreamGates: { ...baseInput().upstreamGates, depthAllowed: false } })).finalBlocker === 'depth_floor', 'depth guard must block');
  assert(evaluateStage5CandidateShadow(baseInput({ upstreamGates: { ...baseInput().upstreamGates, highPriceAllowed: false } })).finalBlocker === 'gabagool_high_price_entry_guard', 'high-price guard must block');
  assert(evaluateStage5CandidateShadow(baseInput({ upstreamGates: { ...baseInput().upstreamGates, duplicateSignal: true } })).finalBlocker === 'duplicate_oracle_signal', 'duplicate guard must block');
  const resized = evaluateStage5CandidateShadow(baseInput({ signal: { ...baseInput().signal, sizeUsd: 2 } }));
  assert(resized.wouldWriteStage5Candidate && resized.sizeUsd >= 4 && resized.sizeShares >= 5, 'Stage 5 must resize an undersized paper candidate');
  const aboveCap = evaluateStage5CandidateShadow(baseInput({
    signal: { ...baseInput().signal, price: 0.95, sizeUsd: 2 },
    book: { ...baseInput().book, bestBid: 0.94, bestAsk: 0.95, midpoint: 0.945, minOrderSize: 6 },
  }));
  assert(aboveCap.finalBlocker === 'minimum_viable_size_exceeds_order_cap', 'minimum viable size above Stage 5 cap must block');
  const before = ['auto_live_candidates.ndjson', 'trade_intents.ndjson', 'live_intent_router_events.ndjson', 'live_adapter_events.ndjson', 'live_execution_events.ndjson']
    .map((file) => fs.existsSync(file) ? fs.statSync(file).mtimeMs : null);
  evaluateStage5CandidateShadow(baseInput());
  const after = ['auto_live_candidates.ndjson', 'trade_intents.ndjson', 'live_intent_router_events.ndjson', 'live_adapter_events.ndjson', 'live_execution_events.ndjson']
    .map((file) => fs.existsSync(file) ? fs.statSync(file).mtimeMs : null);
  assert(JSON.stringify(before) === JSON.stringify(after), 'shadow evaluation must not write production event files');
  process.stdout.write('stage5 candidate shadow selfcheck: ok\n');
}

function main() {
  if (process.argv[2] === '--selfcheck') return selfcheck();
  const [inputPath, auditPath] = process.argv.slice(2);
  if (!inputPath || !auditPath) throw new Error('usage: stage5_candidate_shadow.js <input.ndjson> <shadow-audit.ndjson>');
  const rows = fs.readFileSync(path.resolve(inputPath), 'utf8').split(/\r?\n/).filter(Boolean);
  for (const row of rows) {
    const input = JSON.parse(row);
    const result = evaluateStage5CandidateShadow(input);
    const record = {
      timestamp: new Date().toISOString(),
      marketId: input.signal?.marketId || input.asset?.market?.marketId || null,
      slug: input.asset?.market?.slug || null,
      token: input.signal?.tokenId || null,
      outcome: input.asset?.outcome || null,
      direction: input.signal?.side || null,
      confidence: Number(input.signal?.confidence),
      effectiveStage5ConfidenceFloor: result.effectiveConfidenceFloor ?? Number(input.config?.stage5CanaryGabagoolMinConfidence),
      candidatePrice: Number(input.signal?.price),
      bestBid: Number(input.book?.bestBid),
      bestAsk: Number(input.book?.bestAsk),
      originalPaperSizeUsd: result.sizing?.proposedSizeUsd ?? Number(input.signal?.sizeUsd),
      proposedShares: result.sizing?.proposedShares ?? null,
      reportedMinimumShares: result.sizing?.reportedMinimumShares ?? null,
      effectiveMinimumShares: result.sizing?.effectiveMinimumShares ?? null,
      minimumViableSizeUsd: result.sizing?.minimumViableSizeUsd ?? null,
      adjustedStage5SizeUsd: result.sizing?.adjustedLiveSizeUsd ?? result.sizeUsd ?? null,
      adjustedShares: result.sizing?.adjustedShares ?? result.sizeShares ?? null,
      stage5OrderCap: result.sizing?.orderCap ?? null,
      currentStage5Exposure: result.sizing?.currentExposure ?? null,
      stage5ExposureCap: result.sizing?.exposureCap ?? null,
      wasResized: result.sizing?.wasResized === true,
      gates: result.gates,
      finalBlocker: result.finalBlocker,
      wouldWriteStage5Candidate: result.wouldWriteStage5Candidate,
    };
    fs.appendFileSync(path.resolve(auditPath), `${JSON.stringify(record)}\n`);
  }
}

main();
