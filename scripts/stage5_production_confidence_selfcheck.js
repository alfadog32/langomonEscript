#!/usr/bin/env node
'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

// Exercises the production RiskEngine threshold method only. No state, router,
// adapter, candidate, intent, or execution path is created.
const { RiskEngine, BotEngine, evaluateAutoLiveCandidateGates } = require('../moneymaker_v3');
const { resolveStage5GabagoolConfidenceFloor } = require('../lib/stage5_policy');

const signal = { strategy: 'GabagoolBtcOracleStrategy', confidence: 0.50 };
const base = {
  minConfidence: 0.70,
  paperConfidenceProfile: 'balanced',
  gabagoolMinConfidence: 0.50,
  gabagoolMinConfidenceLive: 0.70,
  stage5CanaryGabagoolMinConfidence: 0.70,
};
function floor(config) { return new RiskEngine(config, {}, null).gabagoolConfidenceThreshold(signal).minConfidence; }
function assert(value, message) { if (!value) throw new Error(message); }

assert(floor({ ...base, enableLiveTrading: true, liveTradingStage: 4 }) === 0.70, 'Stage 4 must retain 0.70');
assert(floor({ ...base, enableLiveTrading: true, liveTradingStage: 5, stage5CanaryGabagoolMinConfidence: 0.47 }) === resolveStage5GabagoolConfidenceFloor(), 'paper or environment overrides must not lower Stage 5 below 0.70');
assert(floor({ ...base, enableLiveTrading: true, liveTradingStage: 5 }) === 0.70, 'missing Stage 5 override must fail closed at 0.70');
assert(floor({ ...base, enableLiveTrading: false, liveTradingStage: 2, stage5CanaryGabagoolMinConfidence: 0.70 }) === 0.50, 'safe Stage 2 must not use a live floor');
const safeShadowConfig = { stage5CandidateShadowEnabled: true, enableLiveTrading: false, liveAutoExecute: false, liveKillSwitch: true, liveDryRunOnly: true, liveSubmitConfirm: false, liveFinalBossReady: false };
assert(BotEngine.prototype.stage5ShadowSafeProfile.call({ config: safeShadowConfig }) === true, 'locked-off shadow profile must pass');
assert(BotEngine.prototype.stage5ShadowSafeProfile.call({ config: { ...safeShadowConfig, liveAutoExecute: true } }) === false, 'shadow must refuse an unsafe profile');
const candidate = { strategy: 'GabagoolBtcOracleStrategy', tokenId: 'fixture', marketId: 'market', side: 'buy', price: 0.8, sizeUsd: 5, confidence: 0.70, expectedEdge: 0.1, _riskApproved: true, metadata: {} };
const book = { bestBid: 0.79, bestAsk: 0.8, midpoint: 0.795, spread: 0.01, cachedAt: Date.now(), minOrderSize: 5 };
const gateConfig = { ...base, liveTradingStage: 5, liveCanaryMarketId: 'market', autoLiveCandidatesEnabled: true, autoLiveAllowedStrategies: ['GabagoolBtcOracleStrategy'], autoLiveBlockedStrategies: [], autoLiveMinConfidence: 0.47, autoLiveMaxBookAgeMs: 1500, enableConsensus: false, autoLiveMinGhostFavorablePct: 0, autoLiveCandidateCooldownMs: 0, minSignalEdge: 0, maxLiveOrderUsd: 5, maxLiveTotalExposureUsd: 5, liveDailyMaxLossUsd: 5, liveMaxOrdersPerHour: 1 };
const gateArgs = { signal: candidate, asset: { market: { marketId: 'market' } }, book, config: gateConfig, portfolio: { ghostStats: { total: 0, favorable: 0 } }, currentLiveExposureUsd: 0 };
assert(evaluateAutoLiveCandidateGates({ ...gateArgs, signal: { ...candidate, confidence: 0.69 } }).blocker === 'confidence_below_min', '0.69 must remain live-canary ineligible even when AUTO/paper confidence is 0.47');
assert(evaluateAutoLiveCandidateGates(gateArgs).eligible, '0.70 must be eligible when all other writer gates pass');
assert(evaluateAutoLiveCandidateGates({ ...gateArgs, signal: { ...candidate, price: 0 } }).blocker === 'invalid_price', 'shared writer gate must reject invalid price identically for shadow/write');
process.stdout.write('stage5 production confidence selfcheck: ok (no production files written)\n');
