'use strict';

const STAGE5_GABAGOOL_MIN_CONFIDENCE = 0.70;

function isGabagoolStrategyName(value) {
  return /gabagool|btc[_ -]?oracle/i.test(String(value || ''));
}

function resolveStage5GabagoolConfidenceFloor() {
  return STAGE5_GABAGOOL_MIN_CONFIDENCE;
}

function resolveLiveCandidateConfidenceFloor(config = {}, strategy = '') {
  if (Number(config.liveTradingStage) === 5 && isGabagoolStrategyName(strategy)) {
    return resolveStage5GabagoolConfidenceFloor();
  }
  const configured = Number(config.autoLiveMinConfidence);
  return Number.isFinite(configured) ? configured : STAGE5_GABAGOOL_MIN_CONFIDENCE;
}

module.exports = {
  STAGE5_GABAGOOL_MIN_CONFIDENCE,
  isGabagoolStrategyName,
  resolveLiveCandidateConfidenceFloor,
  resolveStage5GabagoolConfidenceFloor,
};
