'use strict';

/**
 * Polymarket MoneyMaker V3 - Research + Paper Execution Engine
 * ------------------------------------------------------------
 * Serious paper-first EV hunting system for Polymarket public data.
 *
 * What it does:
 * - Discovers active CLOB-tradable Polymarket markets through Gamma events.
 * - Reads public CLOB order books through REST.
 * - Optionally subscribes to the public CLOB market WebSocket for faster refresh triggers.
 * - Runs multiple strategy modules that produce normalized trading signals.
 * - Applies a centralized risk engine before paper execution.
 * - Tracks paper fills, inventory, equity, drawdown, strategy P&L, adverse selection, and state.
 *
 * What it does NOT do:
 * - It does not place real orders.
 * - It does not use private keys.
 * - It does not guarantee profit.
 *
 * Requirements:
 * - Node.js 18+.
 * - Optional WebSocket: npm install ws
 *
 * Run:
 * npm install ws
 * node moneymaker_v3.js
 *
 * Safer test:
 * INITIAL_CASH=10000 BASE_ORDER_USD=10 MAX_POSITION_USD=100 node moneymaker_v3.js
 *
 * Aggressive paper research:
 * HUNTER_MODE=true ENABLE_WS=true MAX_MARKETS=25 BASE_ORDER_USD=20 node moneymaker_v3.js
 */

// =========================
// OPTIONAL WEBSOCKET
// =========================

let WebSocketImpl = null;
try {
  // Prefer the `ws` package over Node's built-in WebSocket so close/error
  // events are easier to inspect under PM2.
  WebSocketImpl = require('ws');
} catch {
  WebSocketImpl = globalThis.WebSocket || null;
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DEFAULT_PROXY_WALLET,
  DEFAULT_USERNAME,
  buildEntryPlan,
  buildExitPlan,
  deriveOracleExpectedEdge,
  isBtcFiveMinuteMarket,
  isBtcMarket,
  loadOracleSignalFile,
  loadOracleTargetFile,
  readJsonFile,
  refreshBehaviorModel,
} = require('./gabagool_btc_behavior');

loadDotEnvFile();

// =========================
// CONFIG
// =========================

const CONFIG = {
  gammaBaseUrl: envStr('GAMMA_BASE_URL', 'https://gamma-api.polymarket.com'),
  clobBaseUrl: envStr('CLOB_BASE_URL', 'https://clob.polymarket.com'),
  clobWsUrl: envStr('CLOB_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),

  // WebSocket is useful for speed, but REST polling is more reliable while
  // debugging. Turn it on from .env with ENABLE_WS=true after WS is stable.
  enableWs: envBool('ENABLE_WS', false),
  wsHeartbeatEnabled: envBool('WS_HEARTBEAT_ENABLED', true),
  wsTextPingEnabled: envBool('WS_TEXT_PING_ENABLED', false),
  wsHeartbeatMs: envInt('WS_HEARTBEAT_MS', 10_000),
  wsReconnectInitialMs: envInt('WS_RECONNECT_INITIAL_MS', 5_000),
  wsReconnectMaxMs: envInt('WS_RECONNECT_MAX_MS', 60_000),
  saveState: envBool('SAVE_STATE', true),
  stateFile: envStr('STATE_FILE', path.join(process.cwd(), 'moneymaker_v3_state.json')),

  initialCash: envNum('INITIAL_CASH', 250),
  paperDeadExposureCashReleaseEnabled: envBool('PAPER_DEAD_EXPOSURE_CASH_RELEASE_ENABLED', true),
  paperDeadExposureCashReleaseBatchUsd: envNum('PAPER_DEAD_EXPOSURE_CASH_RELEASE_BATCH_USD', 50),
  paperDeadExposureCashReleaseTriggerUsd: envNum('PAPER_DEAD_EXPOSURE_CASH_RELEASE_TRIGGER_USD', 5),

  eventLimit: envInt('EVENT_LIMIT', 100),
  eventPages: envInt('EVENT_PAGES', 2),
  maxMarkets: envInt('MAX_MARKETS', 20),
  maxOutcomesPerMarket: envInt('MAX_OUTCOMES_PER_MARKET', 2),
  marketRefreshEveryCycles: envInt('REFRESH_RESEARCH_EVERY', 10),

  minLiquidity: envNum('MIN_LIQUIDITY', 500),
  minVolume24h: envNum('MIN_VOLUME_24H', 50),
  minBestBid: envNum('MIN_BEST_BID', 0.02),
  maxBestAsk: envNum('MAX_BEST_ASK', 0.98),
  maxSpread: envNum('MAX_SPREAD', 0.18),

  hunterMode: envBool('HUNTER_MODE', true),
  hunterMaxSpread: envNum('HUNTER_MAX_SPREAD', 0.22),
  hunterMinTopDepthUsd: envNum('HUNTER_MIN_TOP_DEPTH_USD', 5),
  hunterMaxTopDepthUsd: envNum('HUNTER_MAX_TOP_DEPTH_USD', 4_000),

  baseOrderUsd: envNum('BASE_ORDER_USD', 25),
  minOrderUsd: envNum('MIN_ORDER_USD', 3),
  maxPositionUsdPerAsset: envNum('MAX_POSITION_USD', 200),
  maxMarketExposureUsd: envNum('MAX_MARKET_EXPOSURE_USD', 350),
  maxTotalExposureUsd: envNum('MAX_TOTAL_EXPOSURE_USD', 1_500),
  maxTotalOpenOrderUsd: envNum('MAX_TOTAL_OPEN_ORDER_USD', 1_000),
  maxOpenOrders: envInt('MAX_OPEN_ORDERS', 250),
  dedupeOpenOrders: envBool('DEDUP_OPEN_ORDERS', true),
  maxOpenOrdersPerTokenSideStrategy: envInt('MAX_OPEN_ORDERS_PER_TOKEN_SIDE_STRATEGY', 1),
  openOrderReplaceEnabled: envBool('OPEN_ORDER_REPLACE_ENABLED', true),
  openOrderReplaceMinPriceDeltaTicks: envInt('OPEN_ORDER_REPLACE_MIN_PRICE_DELTA_TICKS', 1),
  openOrderReplaceAfterMs: envInt('OPEN_ORDER_REPLACE_AFTER_MS', 15_000),
  openOrderReplaceMinAgeMs: envInt('ORDER_REPLACE_MIN_AGE_SEC', 45) * 1000,
  openOrderReplacePriceEpsilon: envNum('ORDER_REPLACE_PRICE_EPSILON', 0.001),
  openOrderReplaceAllowSamePrice: envBool('ORDER_REPLACE_ALLOW_SAME_PRICE', false),
  openOrderReplaceForceRefreshMs: envInt('ORDER_REPLACE_FORCE_REFRESH_SEC', 120) * 1000,
  orderReplaceDynamicEpsilonEnabled: envBool('ORDER_REPLACE_DYNAMIC_EPSILON_ENABLED', true),
  orderReplaceSkipLogBatchMs: envInt('ORDER_REPLACE_SKIP_LOG_BATCH_SEC', 300) * 1000,
  debugReplaceSkips: envBool('DEBUG_ORDER_REPLACE_SKIPS', false),
  dustExitSuppressEnabled: envBool('DUST_EXIT_SUPPRESS_ENABLED', true),
  dustExitLogCooldownMs: envInt('DUST_EXIT_LOG_COOLDOWN_SEC', 300) * 1000,
  fillStarvationWarnMs: envInt('FILL_STARVATION_WARN_SEC', 900) * 1000,
  sophieExecutionQualityEnabled: envBool('SOPHIE_EXECUTION_QUALITY_ENABLED', true),
  sophieMinExecutionQuality: envNum('SOPHIE_MIN_EXECUTION_QUALITY', 0.55),
  sophieSlotEvictionEnabled: envBool('SOPHIE_SLOT_EVICTION_ENABLED', true),
  sophieSlotEvictionMinImprovement: envNum('SOPHIE_SLOT_EVICTION_MIN_IMPROVEMENT', 0.08),
  sophieSlotEvictionMinOpenOrderAgeMs: envInt('SOPHIE_SLOT_EVICTION_MIN_OPEN_ORDER_AGE_SEC', 60) * 1000,
  sophieNoFillCooldownMs: envInt('SOPHIE_NO_FILL_COOLDOWN_SEC', 600) * 1000,
  sophieMinFillRateTarget: envNum('SOPHIE_MIN_FILL_RATE_TARGET', 0.01),
  sophieDuplicatePressureWindowMs: envInt('SOPHIE_DUPLICATE_PRESSURE_WINDOW_SEC', 900) * 1000,
  sophieMaxDuplicateSkipsPerTokenWindow: envInt('SOPHIE_MAX_DUPLICATE_SKIPS_PER_TOKEN_WINDOW', 20),
  sophieMaxAttemptsPerTokenWindow: envInt('SOPHIE_MAX_ATTEMPTS_PER_TOKEN_WINDOW', 12),
  sophieCalibratedAdmissionEnabled: envBool('SOPHIE_CALIBRATED_ADMISSION_ENABLED', true),
  sophieCalibratedMinQuality: envNum('SOPHIE_CALIBRATED_MIN_QUALITY', 0.47),
  sophieCalibratedMinEdge: envNum('SOPHIE_CALIBRATED_MIN_EDGE', 0.02),
  sophieCalibratedMinConfidence: envNum('SOPHIE_CALIBRATED_MIN_CONFIDENCE', 0.42),
  sophieCalibratedMinFillProb: envNum('SOPHIE_CALIBRATED_MIN_FILL_PROB', 0.38),
  sophieCalibratedMaxDistanceFromTouch: envNum('SOPHIE_CALIBRATED_MAX_DISTANCE_FROM_TOUCH', 0.03),
  sophieCalibratedMaxAdmissionsPerScan: envInt('SOPHIE_CALIBRATED_MAX_ADMISSIONS_PER_SCAN', 2),
  sophieCalibratedMaxActiveOrders: envInt('SOPHIE_CALIBRATED_MAX_ACTIVE_ORDERS', 4),
  sophieTargetActivePaperOrders: envInt('SOPHIE_TARGET_ACTIVE_PAPER_ORDERS', 2),
  sophieTargetActiveMaxPaperOrders: envInt('SOPHIE_TARGET_ACTIVE_MAX_PAPER_ORDERS', 4),
  sophieBootstrapAdmissionEnabled: envBool('SOPHIE_BOOTSTRAP_ADMISSION_ENABLED', true),
  sophieBootstrapOnlyWhenOpenOrdersBelow: envInt('SOPHIE_BOOTSTRAP_ONLY_WHEN_OPEN_ORDERS_BELOW', 2),
  sophieBootstrapMaxActiveOrders: envInt('SOPHIE_BOOTSTRAP_MAX_ACTIVE_ORDERS', 2),
  sophieBootstrapMaxAdmissionsPerScan: envInt('SOPHIE_BOOTSTRAP_MAX_ADMISSIONS_PER_SCAN', 1),
  sophieBootstrapMinQuality: envNum('SOPHIE_BOOTSTRAP_MIN_QUALITY', 0.40),
  sophieBootstrapMinEdge: envNum('SOPHIE_BOOTSTRAP_MIN_EDGE', 0.016),
  sophieBootstrapMinConfidence: envNum('SOPHIE_BOOTSTRAP_MIN_CONFIDENCE', 0.38),
  sophieBootstrapMinFillProb: envNum('SOPHIE_BOOTSTRAP_MIN_FILL_PROB', 0.33),
  sophieBootstrapMaxDistanceFromTouch: envNum('SOPHIE_BOOTSTRAP_MAX_DISTANCE_FROM_TOUCH', 0.07),
  sophieBootstrapMinSignalScore: envNum('SOPHIE_BOOTSTRAP_MIN_SIGNAL_SCORE', 0.70),
  sophieFillDistancePenaltyEnabled: envBool('SOPHIE_FILL_DISTANCE_PENALTY_ENABLED', true),
  sophieFillDistanceIdeal: envNum('SOPHIE_FILL_DISTANCE_IDEAL', 0.02),
  sophieFillDistanceMaxReasonable: envNum('SOPHIE_FILL_DISTANCE_MAX_REASONABLE', 0.05),
  sophieFillDistanceHardCap: envNum('SOPHIE_FILL_DISTANCE_HARD_CAP', 0.07),
  sophieFillProbCapWhenFar: envNum('SOPHIE_FILL_PROB_CAP_WHEN_FAR', 0.20),
  sophieFillProbCapWhenVeryFar: envNum('SOPHIE_FILL_PROB_CAP_WHEN_VERY_FAR', 0.10),
  sophieNoFillLearningEnabled: envBool('SOPHIE_NO_FILL_LEARNING_ENABLED', true),
  sophieNoFillStreakLimit: envInt('SOPHIE_NO_FILL_STREAK_LIMIT', 3),
  sophieNoFillTokenCooldownMs: envInt('SOPHIE_NO_FILL_TOKEN_COOLDOWN_SEC', 900) * 1000,
  sophieNoFillFillProbMultiplier: envNum('SOPHIE_NO_FILL_FILLPROB_MULTIPLIER', 0.50),
  sophieBootstrapSameTokenCooldownMs: envInt('SOPHIE_BOOTSTRAP_SAME_TOKEN_COOLDOWN_SEC', 300) * 1000,
  sophieBootstrapMaxSameTokenAdmissionsPerHour: envInt('SOPHIE_BOOTSTRAP_MAX_SAME_TOKEN_ADMISSIONS_PER_HOUR', 3),
  sophieBootstrapRequireImprovementAfterNoFill: envBool('SOPHIE_BOOTSTRAP_REQUIRE_IMPROVEMENT_AFTER_NO_FILL', true),
  sophieBootstrapMinQualityImprovement: envNum('SOPHIE_BOOTSTRAP_MIN_QUALITY_IMPROVEMENT', 0.04),
  sophieLowQualityBlockCooldownMs: envInt('SOPHIE_LOW_QUALITY_BLOCK_COOLDOWN_SEC', 120) * 1000,
  sophieLowQualityBlockSummaryMs: envInt('SOPHIE_LOW_QUALITY_BLOCK_SUMMARY_SEC', 300) * 1000,
  sophieRepeatCandidateCooldownMs: envInt('SOPHIE_REPEAT_CANDIDATE_COOLDOWN_SEC', 90) * 1000,
  sophieMaxRepeatCandidateLogsPerWindow: envInt('SOPHIE_MAX_REPEAT_CANDIDATE_LOGS_PER_WINDOW', 3),
  paperMakerOptimizerEnabled: envBool('PAPER_MAKER_OPTIMIZER_ENABLED', true),
  paperMakerOptimizerMinEdgeAfterMove: envNum('PAPER_MAKER_OPTIMIZER_MIN_EDGE_AFTER_MOVE', 0.012),
  paperMakerOptimizerMaxTicks: envInt('PAPER_MAKER_OPTIMIZER_MAX_TICKS', 1),
  paperMakerRecoveryMinEdgeAfterMove: envNum('PAPER_MAKER_RECOVERY_MIN_EDGE_AFTER_MOVE', 0.006),
  paperMakerRecoveryMaxActive: envInt('PAPER_MAKER_RECOVERY_MAX_ACTIVE', 1),
  paperMakerRecoveryMinSignalScore: envNum('PAPER_MAKER_RECOVERY_MIN_SIGNAL_SCORE', 0.70),
  paperMakerRecoveryMinConfidence: envNum('PAPER_MAKER_RECOVERY_MIN_CONFIDENCE', 0.35),
  paperActionBurnInEnabled: envBool('PAPER_ACTION_BURNIN_ENABLED', true),
  paperActionBurnInWindowMs: envInt('PAPER_ACTION_BURNIN_WINDOW_MS', 15 * 60_000),
  paperActionBurnInMaxBankrollUsd: envNum('PAPER_ACTION_BURNIN_MAX_BANKROLL_USD', 60),
  paperActionBurnInTargetOrdersPer15m: envInt('PAPER_ACTION_BURNIN_TARGET_ORDERS_PER_15M', 3),
  paperActionBurnInTargetFillsPer15m: envInt('PAPER_ACTION_BURNIN_TARGET_FILLS_PER_15M', 0),
  paperActionBurnInMaxOpenOrders: envInt('PAPER_ACTION_BURNIN_MAX_OPEN_ORDERS', 0),
  paperActionBurnInProbationOrderUsd: envNum('PAPER_ACTION_BURNIN_PROBATION_ORDER_USD', 1),
  paperActionBurnInMaxSpread: envNum('PAPER_ACTION_BURNIN_MAX_SPREAD', 0.10),
  paperActionBurnInMaxLiquidityConsumedPct: envNum('PAPER_ACTION_BURNIN_MAX_LIQUIDITY_CONSUMED_PCT', 0.35),
  paperActionBurnInGhostGracePct: envNum('PAPER_ACTION_BURNIN_GHOST_GRACE_PCT', 2),
  paperActionBurnInGhostMinConfidence: envNum('PAPER_ACTION_BURNIN_GHOST_MIN_CONFIDENCE', 0.30),
  paperBurnInResetMode: envBool('PAPER_BURNIN_RESET_MODE', false),
  paperBurnInLabel: envStr('PAPER_BURNIN_LABEL', ''),
  paperMakerDistanceDecayPerNoFill: envNum('PAPER_MAKER_DISTANCE_DECAY_PER_NOFILL', 0.18),
  paperMakerMinOptimizedDistance: envNum('PAPER_MAKER_MIN_OPTIMIZED_DISTANCE', 0.015),
  paperMakerMaxNoFillDecayStreak: envInt('PAPER_MAKER_MAX_NOFILL_DECAY_STREAK', 5),
  paperMakerNudgeEnabled: envBool('PAPER_MAKER_NUDGE_ENABLED', false),
  paperMakerNudgeMaxTicks: envInt('PAPER_MAKER_NUDGE_MAX_TICKS', 1),
  paperMakerNudgeMinEdgeAfterNudge: envNum('PAPER_MAKER_NUDGE_MIN_EDGE_AFTER_NUDGE', 0.012),
  paperMakerNudgeMaxDistanceFromTouch: envNum('PAPER_MAKER_NUDGE_MAX_DISTANCE_FROM_TOUCH', 0.05),
  paperMakerNudgeOnlyAfterNoFillMs: envInt('PAPER_MAKER_NUDGE_ONLY_AFTER_NO_FILL_SEC', 900) * 1000,
  maxDrawdownPct: envNum('MAX_DRAWDOWN_PCT', 12),

  // Practical revenue/risk optimization controls.
  // These keep the paper engine realistic: no instant fantasy fills, no unlimited bags.
  stopLossPct: envNum('STOP_LOSS_PCT', 8),
  takeProfitPct: envNum('TAKE_PROFIT_PCT', 18),
  enableTakeProfit: envBool('ENABLE_TAKE_PROFIT', true),
  maxAdverseMovePct: envNum('MAX_ADVERSE_MOVE_PCT', 4),
  partialFillDepthFraction: envNum('PARTIAL_FILL_DEPTH_FRACTION', 0.35),
  minFillUsd: envNum('MIN_FILL_USD', 1),
  liquidityConsumedLimitPct: envNum('LIQUIDITY_CONSUMED_LIMIT_PCT', 0.20),
  liquidityDecayPower: envNum('LIQUIDITY_DECAY_POWER', 6.0),

  // Ghost mode records would-be orders and checks where the midpoint moved later.
  // This helps calibrate quote offsets without pretending every order fills.
  enableGhostMode: envBool('ENABLE_GHOST_MODE', true),
  ghostHorizonMs: envInt('GHOST_HORIZON_MS', 60_000),
  ghostMaxRecords: envInt('GHOST_MAX_RECORDS', 500),
  spreadHunterGhostGateEnabled: envBool('SPREAD_HUNTER_GHOST_GATE_ENABLED', false),
  spreadHunterMinGhostFavorablePct: envNum('SPREAD_HUNTER_MIN_GHOST_FAVORABLE_PCT', 25),
  spreadHunterGhostMinSamples: envInt('SPREAD_HUNTER_GHOST_MIN_SAMPLES', 200),
  spreadHunterGhostSizeMultiplier: envNum('SPREAD_HUNTER_GHOST_SIZE_MULTIPLIER', 0.50),

  // 1) Order-book imbalance signals.
  enableImbalanceSignals: envBool('ENABLE_IMBALANCE_SIGNALS', true),
  imbalanceDepthLevels: envInt('IMBALANCE_DEPTH_LEVELS', 3),
  imbalanceStrongThreshold: envNum('IMBALANCE_STRONG_THRESHOLD', 0.25),
  imbalanceBalancedThreshold: envNum('IMBALANCE_BALANCED_THRESHOLD', 0.12),

  // 2) Adaptive position sizing.
  enableAdaptiveSizing: envBool('ENABLE_ADAPTIVE_SIZING', true),
  adaptiveMinSizeMultiplier: envNum('ADAPTIVE_MIN_SIZE_MULTIPLIER', 0.35),
  adaptiveMaxSizeMultiplier: envNum('ADAPTIVE_MAX_SIZE_MULTIPLIER', 1.35),
  adaptiveGhostPenalty: envNum('ADAPTIVE_GHOST_PENALTY', 0.65),

  // 3) Whale tracking hook. This reads public/externally collected whale events
  // from a local JSON file if you wire one in. It never invents whale data.
  enableWhaleTracking: envBool('ENABLE_WHALE_TRACKING', true),
  whaleEventsFile: envStr('WHALE_EVENTS_FILE', path.join(process.cwd(), 'whale_events.json')),
  whaleLookbackMs: envInt('WHALE_LOOKBACK_MS', 120_000),
  whaleMinUsd: envNum('WHALE_MIN_USD', 5_000),
  whaleAlignmentBoost: envNum('WHALE_ALIGNMENT_BOOST', 0.12),
  whaleDataApiUrl: envStr('WHALE_DATA_API_URL', 'https://data-api.polymarket.com'),
  whaleWallets: envList('WHALE_WALLETS', []),
  whalePollMs: envInt('WHALE_POLL_MS', 30_000),
  whaleApiTimeoutMs: envInt('WHALE_API_TIMEOUT_MS', 8_000),
  whaleTradesLimit: envInt('WHALE_TRADES_LIMIT', 50),
  whaleBatchSize: envInt('WHALE_BATCH_SIZE', 3),
  whaleBatchDelayMs: envInt('WHALE_BATCH_DELAY_MS', 1_000),
  enableWhaleCopyStrategy: envBool('ENABLE_WHALE_COPY_STRATEGY', true),
  whaleCopyFreshMs: envInt('WHALE_COPY_FRESH_MS', 30_000),
  whaleCopyBaseMultiplier: envNum('WHALE_COPY_BASE_MULTIPLIER', 0.4),
  whaleCopyWhaleFraction: envNum('WHALE_COPY_WHALE_FRACTION', 0.15),

  // Multi-view consensus gate. This is the reports.js idea rebuilt with real
  // MoneyMaker data instead of random fake scouts or a second wallet engine.
  enableConsensus: envBool('ENABLE_CONSENSUS', true),
  consensusThreshold: envNum('CONSENSUS_THRESHOLD', 0.68),
  consensusLogRejected: envBool('CONSENSUS_LOG_REJECTED', false),
  consensusBoostMax: envNum('CONSENSUS_BOOST_MAX', 1.15),
  consensusPenaltyMin: envNum('CONSENSUS_PENALTY_MIN', 0.70),
  consensusStableMaxSpread: envNum('CONSENSUS_STABLE_MAX_SPREAD', 0.12),
  consensusTrendMovePct: envNum('CONSENSUS_TREND_MOVE_PCT', 0.035),
  consensusSniperSizeMultiplier: envNum('CONSENSUS_SNIPER_SIZE_MULTIPLIER', 0.65),
  consensusMakerBoost: envNum('CONSENSUS_MAKER_BOOST', 1.05),
  routeAuthMaxBookAgeMs: envInt('ROUTE_AUTH_MAX_BOOK_AGE_MS', 3_000),
  engineStarvationWindow: envInt('ENGINE_STARVATION_WINDOW', 50),
  engineStarvationMinPassingCandidates: envInt('ENGINE_STARVATION_MIN_PASSING_CANDIDATES', 20),
  engineStarvationRouteBlockPct: envNum('ENGINE_STARVATION_ROUTE_BLOCK_PCT', 0.80),
  engineStarvationWarnCooldownMs: envInt('ENGINE_STARVATION_WARN_COOLDOWN_MS', 120_000),
  targetWalletHandle: envStr('TARGET_WALLET_HANDLE', 'gabagool22'),
  targetWalletMode: envBool('TARGET_WALLET_MODE', true),
  targetWalletDisplacementPct: envNum('TARGET_WALLET_DISPLACEMENT_PCT', 0.015),
  makerSpreadMultiplier: envNum('MAKER_SPREAD_MULTIPLIER', 1.2),

  minSignalEdge: envNum('MIN_SIGNAL_EDGE', 0.008),
  standardMinSignalEdge: envNum('STANDARD_MIN_SIGNAL_EDGE', 0.004),
  paperConfidenceProfile: envStr('PAPER_CONFIDENCE_PROFILE', 'balanced'),
  spreadHunterMinConfidencePaper: envNum('SPREADHUNTER_MIN_CONFIDENCE_PAPER', 0.35),
  standardPaperMinConfidence: envNum('STANDARD_PAPER_MIN_CONFIDENCE', 0.58),
  standardChurnCooldownMs: envInt('STANDARD_CHURN_COOLDOWN_SEC', 60) * 1000,
  standardChurnMinEdgeImprovement: envNum('STANDARD_CHURN_MIN_EDGE_IMPROVEMENT', 0.003),
  minConfidence: envNum('MIN_CONFIDENCE', 0.45),
  paperRealisticFills: envBool('PAPER_REALISTIC_FILLS', true),
  paperFillMinDelayMs: envInt('PAPER_FILL_MIN_DELAY_MS', 1_000),
  paperFillMaxBookAgeMs: envInt('PAPER_FILL_MAX_BOOK_AGE_MS', 3_000),
  paperQueueHaircutPct: envNum('PAPER_QUEUE_HAIRCUT_PCT', 0.50),
  slippageBuffer: envNum('SLIPPAGE_BUFFER', 0.004),
  adverseSelectionBuffer: envNum('ADVERSE_SELECTION_BUFFER', 0.006),

  quoteEdgeTicks: envInt('QUOTE_EDGE_TICKS', 1),
  orderTtlMs: envInt('ORDER_TTL_MS', 45_000),
  maxHoldMs: envInt('MAX_HOLD_MS', 20 * 60_000),

  loopDelayMs: envInt('LOOP_DELAY_MS', 6_000),
  wsDebounceMs: envInt('WS_DEBOUNCE_MS', 250),
  reportEveryCycles: envInt('REPORT_EVERY_CYCLES', 3),
  nonBlockingResearchRefresh: envBool('NON_BLOCKING_RESEARCH_REFRESH', true),
  researchRefreshTimeoutMs: envInt('RESEARCH_REFRESH_TIMEOUT_MS', 60_000),
  researchStuckResetMs: envInt('RESEARCH_STUCK_RESET_MS', 90_000),

  historyLookback: envInt('HISTORY_LOOKBACK', 30),
  volatilityTripPct: envNum('VOL_TRIP_PCT', 12),
  // Binary markets can move violently. Keep cooldown short, but make edge demands
  // stricter while volatility is elevated.
  volatilityCooldownMs: envInt('VOL_COOLDOWN_MS', 5_000),
  volatilityEdgeMultiplier: envNum('VOL_EDGE_MULTIPLIER', 1.75),
  quoteDuringVolatility: envBool('QUOTE_DURING_VOL', false),

  complementArbEnabled: envBool('STRAT_COMPLEMENT_ARB', true),
  spreadHunterEnabled: envBool('STRAT_SPREAD_HUNTER', true),
  inventoryExitEnabled: envBool('STRAT_INVENTORY_EXIT', true),
  tailEndEnabled: envBool('STRAT_TAIL_END', true),

  complementArbMinEdge: envNum('COMPLEMENT_ARB_MIN_EDGE', 0.012),
  spreadHunterMinEdge: envNum('SPREAD_HUNTER_MIN_EDGE', 0.01),
  tailEndHours: envNum('TAIL_END_HOURS', 36),
  tailEndMinConfidence: envNum('TAIL_END_MIN_CONFIDENCE', 0.58),

  autoLiveCandidatesEnabled: envBool('AUTO_LIVE_CANDIDATES_ENABLED', false),
  autoLiveCandidatesPath: envStr('AUTO_LIVE_CANDIDATES_PATH', './auto_live_candidates.ndjson'),
  autoLiveCandidateCooldownMs: envInt('AUTO_LIVE_CANDIDATE_COOLDOWN_MS', 45_000),
  autoLiveMaxBookAgeMs: envInt('AUTO_LIVE_MAX_BOOK_AGE_MS', 1_500),
  autoLiveMinConfidence: envNum('AUTO_LIVE_MIN_CONFIDENCE', 0.55),
  autoLiveAllowedStrategies: envList('AUTO_LIVE_ALLOWED_STRATEGIES', ['SpreadHunter', 'InventoryExit', 'StopLossExit', 'TakeProfitExit']),
  autoLiveBlockedStrategies: envList('AUTO_LIVE_BLOCKED_STRATEGIES', ['ComplementArb', 'WhaleCopy', 'TailEndMispricing']),
  autoLiveMinGhostFavorablePct: envNum('AUTO_LIVE_MIN_GHOST_FAVORABLE_PCT', 0),

  enableGabagoolBtcImitation: envBool('ENABLE_GABAGOOL_BTC_IMITATION', false),
  gabagoolLookbackTrades: envInt('GABAGOOL_LOOKBACK_TRADES', 500),
  gabagoolBtcOnly: envBool('GABAGOOL_BTC_ONLY', true),
  gabagoolMaxPaperOrderUsd: envNum('GABAGOOL_MAX_PAPER_ORDER_USD', 1),
  gabagoolRequireOracleSignal: envBool('GABAGOOL_REQUIRE_ORACLE_SIGNAL', true),
  gabagoolRequireSophie: envBool('GABAGOOL_REQUIRE_SOPHIE', true),
  gabagoolRequireRisk: envBool('GABAGOOL_REQUIRE_RISK', true),
  gabagoolTelegramUpdates: envBool('GABAGOOL_TELEGRAM_UPDATES', true),
  gabagoolTelegramNotifyDetected: envBool('GABAGOOL_TELEGRAM_NOTIFY_DETECTED', false),
  gabagoolTelegramNotifyPresophieBlocks: envBool('GABAGOOL_TELEGRAM_NOTIFY_PRESOPHIE_BLOCKS', false),
  gabagoolTelegramNotifySophieBlocks: envBool('GABAGOOL_TELEGRAM_NOTIFY_SOPHIE_BLOCKS', true),
  gabagoolTelegramNotifyRiskBlocks: envBool('GABAGOOL_TELEGRAM_NOTIFY_RISK_BLOCKS', true),
  gabagoolTelegramNotifyOrders: envBool('GABAGOOL_TELEGRAM_NOTIFY_ORDERS', true),
  gabagoolTelegramNotifyFills: envBool('GABAGOOL_TELEGRAM_NOTIFY_FILLS', true),
  paperTelegramDigestEnabled: envBool('PAPER_TELEGRAM_DIGEST_ENABLED', true),
  paperTelegramDigestEveryMs: envInt('PAPER_TELEGRAM_DIGEST_EVERY_MS', 300_000),
  gabagoolTelegramBlockDedupeMs: envInt('GABAGOOL_TELEGRAM_BLOCK_DEDUPE_MS', 60_000),
  gabagoolTelegramRiskBlockDedupeMs: envInt(
    'GABAGOOL_TELEGRAM_RISK_BLOCK_DEDUPE_MS',
    envInt('GABAGOOL_TELEGRAM_BLOCK_DEDUPE_MS', 120_000)
  ),
  gabagoolMaxPaperDrawdownPct: envNum('GABAGOOL_MAX_PAPER_DRAWDOWN_PCT', 2.0),
  gabagoolMaxPaperClosedLossUsd: envNum('GABAGOOL_MAX_PAPER_CLOSED_LOSS_USD', 0.75),
  gabagoolPauseEntriesOnLoss: envBool('GABAGOOL_PAUSE_ENTRIES_ON_LOSS', true),
  gabagoolLossGuardCooldownMs: envInt('GABAGOOL_LOSS_GUARD_COOLDOWN_MS', 10 * 60_000),
  gabagoolLossGuardBlockedExitCooldownMs: envInt('GABAGOOL_LOSS_GUARD_BLOCKED_EXIT_COOLDOWN_MS', 5 * 60_000),
  gabagoolLossGuardExitMode: envStr('GABAGOOL_LOSS_GUARD_EXIT_MODE', 'reduce_only'),
  gabagoolMaxRoundTripsPerTokenPerMarket: envInt('GABAGOOL_MAX_ROUND_TRIPS_PER_TOKEN_PER_MARKET', 2),
  gabagoolReenterCooldownMs: envInt('GABAGOOL_REENTER_COOLDOWN_MS', 30_000),
  gabagoolAllowMarketReentry: envBool('GABAGOOL_ALLOW_MARKET_REENTRY', false),
  gabagoolAllowDustExits: envBool('GABAGOOL_ALLOW_DUST_EXITS', true),
  gabagoolMinDustExitUsd: envNum('GABAGOOL_MIN_DUST_EXIT_USD', 0.01),
  gabagoolMinProfitBuffer: envNum('GABAGOOL_MIN_PROFIT_BUFFER', 0.01),
  gabagoolMinPrice: envNum('GABAGOOL_MIN_PRICE', 0.02),
  gabagoolMaxEntryPrice: envNum('GABAGOOL_MAX_ENTRY_PRICE', 0.85),
  gabagoolMaxPrice: envNum('GABAGOOL_MAX_PRICE', 0.98),
  gabagoolAllowHighPriceEntryEdge: envNum('GABAGOOL_ALLOW_HIGH_PRICE_ENTRY_EDGE', 0.20),
  gabagoolMinConfidence: envNum('GABAGOOL_MIN_CONFIDENCE', 0.50),
  gabagoolMinConfidenceLive: envNum('GABAGOOL_MIN_CONFIDENCE_LIVE', 0.70),
  gabagoolMinExpectedEdge: envNum('GABAGOOL_MIN_EXPECTED_EDGE', 0.0001),
  mixedModeBtcOrderShareCap: envNum('MIXED_MODE_BTC_ORDER_SHARE_CAP', 0.75),
  btcExposureBucketShare: envNum('BTC_EXPOSURE_BUCKET_SHARE', 0.5),
  standardExposureBucketShare: envNum('STANDARD_EXPOSURE_BUCKET_SHARE', 0.5),
  reduceOnlyMinExitUsd: envNum('REDUCE_ONLY_MIN_EXIT_USD', 0.01),
  enableBtcOracleReport: envBool('ENABLE_BTC_ORACLE_REPORT', true),
  btcOracleReportEveryMs: envInt('BTC_ORACLE_REPORT_EVERY_MS', 60_000),
  btcOracleReportTelegram: envBool('BTC_ORACLE_REPORT_TELEGRAM', false),
  btcOracleReportTelegramEveryMs: envInt('BTC_ORACLE_REPORT_TELEGRAM_EVERY_MS', 300_000),
  btcOracleThreshold: envNum('BTC_ORACLE_THRESHOLD', 0.003),
  btcOraclePersistenceMs: envInt('BTC_ORACLE_PERSISTENCE_MS', 4_000),
  btcOraclePersistenceMinPct: envNum('BTC_ORACLE_PERSISTENCE_MIN_PCT', 0.002),
  enableLiveTrading: envBool('ENABLE_LIVE_TRADING', false),
  liveAutoExecute: envBool('LIVE_AUTO_EXECUTE', false),
  liveKillSwitch: envBool('LIVE_KILL_SWITCH', true),
  liveDryRunOnly: envBool('LIVE_DRY_RUN_ONLY', true),
  liveSubmitConfirm: envBool('LIVE_SUBMIT_CONFIRM', false),
  gabagoolUsername: envStr('GABAGOOL_USERNAME', DEFAULT_USERNAME),
  gabagoolProxyWallet: envStr('GABAGOOL_PROXY_WALLET', DEFAULT_PROXY_WALLET),
  gabagoolBehaviorModelPath: envStr('GABAGOOL_BEHAVIOR_MODEL_PATH', './gabagool22_btc_behavior_model.json'),
  gabagoolSignalPath: envStr('GABAGOOL_SIGNAL_PATH', './external_signals.json'),
  gabagoolTargetPath: envStr('GABAGOOL_TARGET_PATH', './btc_oracle_market_target.json'),
  gabagoolTelegramEventsPath: envStr('GABAGOOL_TELEGRAM_EVENTS_PATH', './gabagool_paper_updates.ndjson'),
  telegramBotToken: envStr('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: envStr('TELEGRAM_CHAT_ID', ''),
};

// =========================
// ENV HELPERS
// =========================

function loadDotEnvFile(filePath = path.join(process.cwd(), '.env')) {
  try {
    if (!localEnvFileReadEnabled()) return;
    if (!fs.existsSync(filePath)) return;

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq <= 0) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      if (!key || process.env[key] !== undefined) continue;

      if (        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  } catch (e) {
    console.warn(`[ENV] Failed to load .env file: ${e.message}`);
  }
}

function localEnvFileReadEnabled() {
  const raw = String(
    process.env.MM_SKIP_LOCAL_ENV_FILE ||
    process.env.SKIP_LOCAL_ENV_FILE ||
    ''
  ).trim().toLowerCase();
  return !['1', 'true', 'yes', 'on'].includes(raw);
}

function envStr(name, fallback) {
  return process.env[name] ?? fallback;
}

function envNum(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).toLowerCase());
}

function deriveBurnInStateBasename(config = {}, explicitProfileUsd = null) {
  const hasExplicitProfileUsd =
    explicitProfileUsd !== null &&
    explicitProfileUsd !== undefined &&
    String(explicitProfileUsd).trim() !== '';
  const profileUsd = Math.max(
    1,
    hasExplicitProfileUsd && Number.isFinite(Number(explicitProfileUsd))
      ? Number(explicitProfileUsd)
      : Number(config.initialCash || 0)
  );
  return `moneymaker_v3_state_post_patch_burnin_${Math.round(profileUsd)}.json`;
}

function burnInStateLabel(config = {}) {
  return String(config.paperBurnInLabel || '').trim() || 'post_patch_burnin';
}

function envList(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// =========================
// LOGGING
// =========================

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);
const errlog = (m) => log('ERROR', m);

// =========================
// HTTP CLIENT
// =========================

class HttpClient {
  constructor({ timeoutMs = 12_000, retries = 2 } = {}) {
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  async getJson(url) {
    let lastErr;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'moneymaker-v3-paper-bot/1.0',
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok) {
          const text = await safeText(res);
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 240)}`);
        }

        return await res.json();
      } catch (e) {
        clearTimeout(timeout);
        lastErr = e;
        if (attempt < this.retries) {
          await sleep(350 * (attempt + 1));
        }
      }
    }

    throw lastErr;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// =========================
// POLYMARKET PUBLIC CLIENT
// =========================

class PolymarketPublicClient {
  constructor(config) {
    this.config = config;
    this.http = new HttpClient();
  }

  async fetchActiveEvents() {
    const all = [];

    for (let page = 0; page < this.config.eventPages; page++) {
      const url = new URL('/events', this.config.gammaBaseUrl);
      url.searchParams.set('active', 'true');
      url.searchParams.set('closed', 'false');
      url.searchParams.set('order', 'volume_24hr');
      url.searchParams.set('ascending', 'false');
      url.searchParams.set('limit', String(this.config.eventLimit));
      url.searchParams.set('offset', String(page * this.config.eventLimit));

      const data = await this.http.getJson(url.toString());
      if (!Array.isArray(data)) {
        throw new Error('Unexpected Gamma /events response; expected an array');
      }

      all.push(...data);
      await sleep(100);
    }

    return all;
  }

  extractTradableMarkets(events) {
    const markets = [];

    for (const event of events) {
      const eventTitle = event.title || event.question || event.slug || `event:${event.id || 'unknown'}`;
      const eventMarkets = Array.isArray(event.markets) ? event.markets : [];

      for (const market of eventMarkets) {
        if (!isMarketTradable(market)) continue;

        const outcomes = parseMaybeJsonArray(market.outcomes);
        const tokenIds = parseMaybeJsonArray(market.clobTokenIds || market.clob_token_ids || market.tokenIds);
        const outcomePrices = parseMaybeJsonArray(market.outcomePrices || market.outcome_prices);

        if (!Array.isArray(tokenIds) || tokenIds.length === 0) continue;

        const liquidity = firstFinite(
          market.liquidityNum,
          market.liquidity_num,
          market.liquidity,
          market.orderBookLiquidity
        );

        const volume24h = firstFinite(
          market.volume24hr,
          market.volume_24hr,
          market.volume24h,
          market.volume_24h,
          market.volumeNum,
          market.volume
        );

        if (liquidity < this.config.minLiquidity) continue;
        if (volume24h < this.config.minVolume24h) continue;

        markets.push({
          marketId: String(market.id || market.conditionId || market.condition_id || crypto.randomUUID()),
          conditionId: String(market.conditionId || market.condition_id || ''),
          question: market.question || market.title || eventTitle,
          marketSlug: market.slug || '',
          eventTitle,
          eventSlug: event.slug || '',
          category: event.category || market.category || '',
          endDate: market.endDate || market.end_date_iso || market.endDateIso || event.endDate || event.end_date_iso || '',
          liquidity,
          volume24h,
          competitive: Boolean(market.competitive),
          restricted: Boolean(market.restricted || event.restricted),
          raw: market,
          outcomes: tokenIds.map((tokenId, i) => ({
            tokenId: String(tokenId),
            outcome: String(outcomes?.[i] || `Outcome ${i + 1}`),
            indicativePrice: toNum(outcomePrices?.[i], NaN),
          })),
        });
      }
    }

    return markets;
  }

  async getOrderBook(tokenId) {
    const url = new URL('/book', this.config.clobBaseUrl);
    url.searchParams.set('token_id', String(tokenId));

    const raw = await this.http.getJson(url.toString());
    return normalizeBook(raw, tokenId);
  }
}

function isMarketTradable(market) {
  const active = market.active !== false;
  const closed = market.closed === true;
  const archived = market.archived === true;
  const enableOrderBook =
    market.enableOrderBook === true ||
    market.enable_order_book === true ||
    market.enableOrderBook === 'true' ||
    market.enable_order_book === 'true';

  return active && !closed && !archived && enableOrderBook;
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
};

function normalizeBook(raw, fallbackAssetId = '') {
  const bids = normalizeLevels(raw?.bids, 'bid');
  const asks = normalizeLevels(raw?.asks, 'ask');

  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? toNum(raw?.best_bid ?? raw?.bestBid, NaN);
  const bestAsk = asks[0]?.price ?? toNum(raw?.best_ask ?? raw?.bestAsk, NaN);
  const safeBestBid = Number.isFinite(bestBid) ? bestBid : null;
  const safeBestAsk = Number.isFinite(bestAsk) ? bestAsk : null;
  const midpoint = safeBestBid !== null && safeBestAsk !== null ? (safeBestBid + safeBestAsk) / 2 : null;
  const spread = safeBestBid !== null && safeBestAsk !== null ? safeBestAsk - safeBestBid : null;

  return {
    assetId: String(raw?.asset_id || raw?.assetId || fallbackAssetId || ''),
    market: String(raw?.market || ''),
    timestamp: String(raw?.timestamp || ''),
    bids,
    asks,
    bestBid: safeBestBid,
    bestAsk: safeBestAsk,
    midpoint,
    spread,
    minOrderSize: toNum(raw?.min_order_size ?? raw?.minOrderSize, 5),
    tickSize: toNum(raw?.tick_size ?? raw?.tickSize, 0.01),
    lastTradePrice: toNum(raw?.last_trade_price ?? raw?.lastTradePrice, NaN),
    cachedAt: Date.now(),
  };
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];

  return levels
    .map((x) => ({
      price: toNum(x.price, NaN),
      size: toNum(x.size, NaN),
      side,
    }))
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0);
}

// =========================
// MARKET CACHE
// =========================

class MarketCache {
  constructor(poly) {
    this.poly = poly;
    this.books = new Map();
    this.marketsById = new Map();
    this.assetsByToken = new Map();
    this.negativeBookCache = new Map();
  }

  setCandidates(assets) {
    this.marketsById.clear();
    this.assetsByToken.clear();

    for (const asset of assets) {
      this.assetsByToken.set(asset.tokenId, asset);
      this.marketsById.set(asset.market.marketId, asset.market);
    }
  }

  getAsset(tokenId) {
    return this.assetsByToken.get(String(tokenId));
  }

  getMarketAssets(marketId) {
    return [...this.assetsByToken.values()].filter((asset) => asset.market.marketId === marketId);
  }

  setBook(tokenId, book) {
    if (!book) return;
    book.cachedAt = Date.now();
    this.books.set(String(tokenId), book);
  }

  getBook(tokenId) {
    return this.books.get(String(tokenId));
  }

  async getFreshBook(tokenId, maxAgeMs = 1_500) {
    const key = String(tokenId || '');
    const negativeCache = this.negativeBookCache.get(key);
    if (negativeCache && Number(negativeCache.expiresAt || 0) > Date.now()) {
      const cooldownMsRemaining = Math.max(0, Number(negativeCache.expiresAt || 0) - Date.now());
      const cachedError = new Error(
        `Negative-cached orderbook miss for ${key}: ${negativeCache.message || negativeCache.reason || 'unknown'}`
      );
      cachedError.mmBookFetchStatus = 'stale_token_cooldown';
      cachedError.mmNoOrderbookConfirmed = true;
      cachedError.mmNegativeCacheHit = true;
      cachedError.mmCooldownMsRemaining = cooldownMsRemaining;
      cachedError.mmOriginalBookFetchReason = negativeCache.reason || null;
      cachedError.mmOriginalErrorMessage = negativeCache.message || null;
      throw cachedError;
    }
    if (negativeCache) this.negativeBookCache.delete(key);

    const cached = this.getBook(key);
    if (cached && Date.now() - (cached.cachedAt || 0) <= maxAgeMs && cached.midpoint !== null) {
      return cached;
    }

    try {
      const book = await this.poly.getOrderBook(key);
      this.negativeBookCache.delete(key);
      this.setBook(key, book);
      return book;
    } catch (error) {
      const message = String(error?.message || '');
      const confirmedNoOrderbook = /HTTP\s+404\b/i.test(message) && /No orderbook exists/i.test(message);
      if (confirmedNoOrderbook) {
        const cooldownMs = 5 * 60_000;
        this.negativeBookCache.set(key, {
          reason: 'no_orderbook_404',
          message,
          tokenId: key,
          ts: Date.now(),
          expiresAt: Date.now() + cooldownMs,
        });
        error.mmBookFetchStatus = 'no_orderbook_404';
        error.mmNoOrderbookConfirmed = true;
        error.mmNegativeCacheHit = false;
        error.mmCooldownMsRemaining = cooldownMs;
      }
      throw error;
    }
  }

  markPrices() {
    const map = new Map();
    for (const [tokenId, book] of this.books.entries()) {
      if (Number.isFinite(book.midpoint)) {
        map.set(tokenId, book.midpoint);
      }
    }
    return map;
  }
}

// =========================
// PUBLIC CLOB WEBSOCKET
// =========================

class CLOBWebSocketClient {
  constructor({ url, onMessage, config = CONFIG }) {
    this.url = url;
    this.onMessage = onMessage;
    this.config = config;
    this.ws = null;
    this.assetIds = new Set();
    this.connected = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectDelayMs = config.wsReconnectInitialMs || 5_000;
  }

  connect() {
    if (!WebSocketImpl) {
      warn('WebSocket disabled: install optional dependency with `npm install ws`.');
      return;
    }

    if (this.ws && [WebSocketImpl.OPEN, WebSocketImpl.CONNECTING].includes(this.ws.readyState)) {
      return;
    }

    this.ws = new WebSocketImpl(this.url);

    if (typeof this.ws.on === 'function') {
      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleRawMessage(data));
      this.ws.on('error', (e) => warn(`CLOB WS error: ${formatWsError(e)}`));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));
    } else {
      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleRawMessage(event.data);
      this.ws.onerror = (event) => warn(`CLOB WS error: ${formatWsError(event)}`);
      this.ws.onclose = (event) => this.handleClose(event?.code, event?.reason);
    }
  }

  handleOpen() {
    if (this.connected) return;
    this.connected = true;
    this.reconnectDelayMs = this.config.wsReconnectInitialMs || 5_000;
    info('CLOB WebSocket connected.');
    this.resubscribe();
    this.startPing();
  }

  handleClose(code, reason) {
    this.connected = false;
    this.stopPing();
    clearTimeout(this.reconnectTimer);

    const cleanReason = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
    warn(`CLOB WS closed: code=${code ?? 'unknown'} reason=${cleanReason || 'none'} reconnectMs=${this.reconnectDelayMs}`);

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.config.wsReconnectMaxMs || 60_000,
      Math.floor(this.reconnectDelayMs * 1.5)
    );

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  startPing() {
    this.stopPing();
    if (!this.config.wsHeartbeatEnabled) return;

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocketImpl.OPEN) {
        try {
          if (typeof this.ws.ping === 'function') {
            this.ws.ping();
          } else if (this.config.wsTextPingEnabled) {
            this.ws.send('PING');
          }
        } catch (e) {
          warn(`WS ping failed: ${e.message}`);
        }
      }
    }, this.config.wsHeartbeatMs || 10_000);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  subscribe(assetIds) {
    const ids = Array.isArray(assetIds) ? assetIds : [assetIds];
    let changed = false;

    for (const id of ids) {
      if (!id) continue;
      const s = String(id);
      if (!this.assetIds.has(s)) {
        this.assetIds.add(s);
        changed = true;
      }
    }

    if (changed) this.resubscribe();
  }

  resubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocketImpl.OPEN) return;
    const ids = [...this.assetIds];
    if (ids.length === 0) return;

    for (const chunk of chunks(ids, 100)) {
      this.ws.send(JSON.stringify({
        assets_ids: chunk,
        type: 'market',
      }));
    }

    info(`CLOB WS subscribed to ${ids.length} asset ids.`);
  }

  handleRawMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (!text || text === 'PONG') return;

    if (text.startsWith('INVALID OPERATION')) {
      warn(`CLOB WS protocol warning: ${text}`);
      return;
    }

    try {
      const parsed = JSON.parse(text);
      const messages = Array.isArray(parsed) ? parsed : [parsed];

      for (const msg of messages) {
        this.onMessage(msg);
      }
    } catch (e) {
      warn(`CLOB WS parse error: ${e.message}`);
    }
  }
}

// =========================
// RESEARCH ENGINE
// =========================

class ResearchEngine {
  constructor(poly, cache, config) {
    this.poly = poly;
    this.cache = cache;
    this.config = config;
  }

  async discoverCandidates() {
    info('Research refresh: fetching active events and books...');

    const events = await this.poly.fetchActiveEvents();
    const markets = this.poly.extractTradableMarkets(events);
    const assets = [];

    for (const market of markets) {
      const outcomes = market.outcomes.slice(0, this.config.maxOutcomesPerMarket);

      for (const outcome of outcomes) {
        try {
          const book = await this.poly.getOrderBook(outcome.tokenId);
          this.cache.setBook(outcome.tokenId, book);

          const scored = this.scoreAsset(market, outcome, book);
          if (scored) assets.push(scored);
        } catch (e) {
          warn(`Skipping book for ${shortId(outcome.tokenId)}: ${e.message}`);
        }

        await sleep(60);
      }
    }

    assets.sort((a, b) => b.score - a.score);
    const selected = assets.slice(0, this.config.maxMarkets);
    this.cache.setCandidates(selected);

    info(`Research selected ${selected.length} assets from ${assets.length} scored assets.`);
    for (const a of selected.slice(0, 10)) {
      info(
        `SELECT score=${a.score.toFixed(1)} ${a.outcome.padEnd(8)} ` +
        `bid=${fmtPrice(a.book.bestBid)} ask=${fmtPrice(a.book.bestAsk)} spread=${fmtPrice(a.book.spread)} ` +
        `liq=$${a.market.liquidity.toFixed(0)} vol24h=$${a.market.volume24h.toFixed(0)} :: ${a.market.question.slice(0, 90)}`
      );
    }

    return selected;
  }

  scoreAsset(market, outcome, book) {
    if (!isBookComplete(book)) return null;
    if (book.bestBid < this.config.minBestBid) return null;
    if (book.bestAsk > this.config.maxBestAsk) return null;

    const maxSpread = this.config.hunterMode ? this.config.hunterMaxSpread : this.config.maxSpread;
    if (book.spread <= 0 || book.spread > maxSpread) return null;

    const topBid1Usd = topDepthUsd(book.bids, 1);
    const topAsk1Usd = topDepthUsd(book.asks, 1);
    const topBid3Usd = topDepthUsd(book.bids, 3);
    const topAsk3Usd = topDepthUsd(book.asks, 3);
    const topOneSideUsd = Math.min(topBid1Usd, topAsk1Usd);
    const topDepthTotalUsd = topBid1Usd + topAsk1Usd;

    if (topOneSideUsd < this.config.hunterMinTopDepthUsd) return null;
    if (topDepthTotalUsd > this.config.hunterMaxTopDepthUsd) return null;

    const balance = Math.min(topBid3Usd, topAsk3Usd) / Math.max(1, Math.max(topBid3Usd, topAsk3Usd));
    const agePenalty = endingSoonPenalty(market.endDate);
    const extremePenalty = priceExtremePenalty(book.midpoint);

    let score;
    if (this.config.hunterMode) {
      const spreadScore = book.spread * 1000;
      const shallowBookBonus = Math.max(0, 140 - topDepthTotalUsd / 10);
      const volumeSanity = Math.min(70, Math.log10(1 + market.volume24h) * 17);
      const liquiditySanity = Math.min(50, Math.log10(1 + market.liquidity) * 11);
      const balanceScore = balance * 30;
      const tooWidePenalty = book.spread > 0.14 ? (book.spread - 0.14) * 700 : 0;

      score = spreadScore + shallowBookBonus + volumeSanity + liquiditySanity + balanceScore - extremePenalty - tooWidePenalty - agePenalty;
    } else {
      const liquidityScore = Math.log10(1 + market.liquidity) * 18;
      const volumeScore = Math.log10(1 + market.volume24h) * 14;
      const spreadScore = Math.min(45, book.spread * 500);
      const balanceScore = balance * 20;

      score = liquidityScore + volumeScore + spreadScore + balanceScore - extremePenalty - agePenalty;
    }

    return {
      assetKey: `${market.marketId}:${outcome.tokenId}`,
      market,
      outcome: outcome.outcome,
      tokenId: outcome.tokenId,
      book,
      score,
      topBidDepthUsd: topBid3Usd,
      topAskDepthUsd: topAsk3Usd,
      topDepthTotalUsd,
      discoveredAt: Date.now(),
    };
  }
}

function isBookComplete(book) {
  return Boolean(
    book &&
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    Number.isFinite(book.midpoint) &&
    Number.isFinite(book.spread) &&
    book.bestBid > 0 &&
    book.bestAsk > 0 &&
    book.bestBid < book.bestAsk
  );
}

function incompleteBookCause(book) {
  if (!book) return 'missing_book';
  const failures = [];
  if (!Number.isFinite(book.bestBid)) failures.push('best_bid_not_finite');
  if (!Number.isFinite(book.bestAsk)) failures.push('best_ask_not_finite');
  if (!Number.isFinite(book.midpoint)) failures.push('midpoint_not_finite');
  if (!Number.isFinite(book.spread)) failures.push('spread_not_finite');
  if (Number.isFinite(book.bestBid) && book.bestBid <= 0) failures.push('best_bid_non_positive');
  if (Number.isFinite(book.bestAsk) && book.bestAsk <= 0) failures.push('best_ask_non_positive');
  if (
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    book.bestBid >= book.bestAsk
  ) {
    failures.push('crossed_or_locked_book');
  }
  if (!Array.isArray(book.bids) || book.bids.length === 0) failures.push('missing_bids');
  if (!Array.isArray(book.asks) || book.asks.length === 0) failures.push('missing_asks');
  return failures.join(',') || 'unknown_incomplete_book';
}

function topDepthUsd(levels, n) {
  return (levels || []).slice(0, n).reduce((sum, level) => sum + level.price * level.size, 0);
}

const PAPER_FILL_SOURCES = new Set([
  'crossed_bid_ask',
  'resting_queue',
  'touch_fill',
  'instant_sim',
  'forced_test_fill',
  'unknown',
]);

function normalizePaperFillSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return PAPER_FILL_SOURCES.has(source) ? source : 'unknown';
}

function bestBidAskExecutable(side, orderPrice, bestBid, bestAsk, epsilon = 1e-9) {
  const px = Number(orderPrice);
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  const normalizedSide = String(side || '').toLowerCase();
  if (!Number.isFinite(px) || px <= 0) return false;
  if (normalizedSide === 'buy') {
    return Number.isFinite(ask) && ask > 0 && px + epsilon >= ask;
  }
  if (normalizedSide === 'sell') {
    return Number.isFinite(bid) && bid > 0 && px <= bid + epsilon;
  }
  return false;
}

function isZeroSecondPaperFill(fillDelayMs) {
  return Number.isFinite(Number(fillDelayMs)) && Number(fillDelayMs) >= 0 && Number(fillDelayMs) < 1_000;
}

function paperFillTrusted(fill, config = CONFIG) {
  const source = normalizePaperFillSource(fill?.fillSource);
  const invalidSource = source === 'instant_sim' || source === 'forced_test_fill' || source === 'unknown';
  const executableAtFill = fill?.wasExecutableAtFill === true;
  const staleBook = Number.isFinite(Number(fill?.bookAgeMs)) &&
    Number(fill.bookAgeMs) > Math.max(0, Number(config?.paperFillMaxBookAgeMs || 0));
  const zeroSecondNeedsProof = isZeroSecondPaperFill(fill?.fillDelayMs) && source !== 'crossed_bid_ask';
  return !invalidSource && executableAtFill && !staleBook && !zeroSecondNeedsProof;
}

function fillSourceCountsObject(fills = []) {
  const counts = {
    crossed_bid_ask: 0,
    resting_queue: 0,
    touch_fill: 0,
    instant_sim: 0,
    forced_test_fill: 0,
    unknown: 0,
  };
  for (const fill of fills || []) {
    const source = normalizePaperFillSource(fill?.fillSource);
    counts[source] += 1;
  }
  return counts;
}

function formatFillSourceCounts(counts = {}) {
  return [
    `crossed_bid_ask:${Number(counts.crossed_bid_ask || 0)}`,
    `resting_queue:${Number(counts.resting_queue || 0)}`,
    `touch_fill:${Number(counts.touch_fill || 0)}`,
    `instant_sim:${Number(counts.instant_sim || 0)}`,
    `forced_test_fill:${Number(counts.forced_test_fill || 0)}`,
    `unknown:${Number(counts.unknown || 0)}`,
  ].join(',');
}

function estimateLiquidityConsumption(book, side, sizeUsd, config = CONFIG) {
  if (!book || !Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return { consumedPct: 1, penalty: 0, topDepthUsd: 0 };
  }

  // For maker buys, queue/competition is best approximated by bid-side depth.
  // For maker sells, queue/competition is best approximated by ask-side depth.
  const depthUsd = side === 'buy'
    ? topDepthUsd(book.bids, 3)
    : topDepthUsd(book.asks, 3);

  const consumedPct = depthUsd > 0 ? sizeUsd / depthUsd : 1;
  const limit = Math.max(0.01, config.liquidityConsumedLimitPct || 0.20);

  // Above the limit, assume fill probability decays exponentially instead of
  // pretending the whole order gets equal queue priority.
  const excess = Math.max(0, consumedPct - limit);
  const penalty = excess <= 0
    ? 1
    : Math.exp(-excess * (config.liquidityDecayPower || 6.0));

  return {
    consumedPct,
    penalty: clamp(penalty, 0.05, 1),
    topDepthUsd: depthUsd,
  };
}

function computeOrderBookImbalance(book, levels = CONFIG.imbalanceDepthLevels) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    return { bidDepthUsd: 0, askDepthUsd: 0, imbalance: 0, direction: 'unknown', usable: false };
  }

  const bidDepthUsd = topDepthUsd(book.bids, levels);
  const askDepthUsd = topDepthUsd(book.asks, levels);
  const total = bidDepthUsd + askDepthUsd;
  const imbalance = total > 0 ? (bidDepthUsd - askDepthUsd) / total : 0;

  let direction = 'balanced';
  if (imbalance >= CONFIG.imbalanceStrongThreshold) direction = 'bid_heavy';
  if (imbalance <= -CONFIG.imbalanceStrongThreshold) direction = 'ask_heavy';

  return {
    bidDepthUsd,
    askDepthUsd,
    imbalance,
    direction,
    usable: total > 0,
  };
}

function priceExtremePenalty(mid) {
  if (!Number.isFinite(mid)) return 100;
  if (mid > 0.12 && mid < 0.88) return 0;
  if (mid > 0.05 && mid < 0.95) return 8;
  return 25;
}

function endingSoonPenalty(endDate) {
  const ms = msUntil(endDate);
  if (!Number.isFinite(ms)) return 0;
  if (ms < 2 * 60 * 60 * 1000) return 40;
  if (ms < 8 * 60 * 60 * 1000) return 15;
  return 0;
}

// =========================
// STRATEGY SIGNALS
// =========================

class Signal {
  constructor({
    strategy,
    tokenId,
    marketId,
    side,
    price,
    sizeUsd,
    expectedEdge,
    confidence,
    reason,
    exitPlan,
    ttlMs,
    maxHoldMs,
    metadata = {},
  }) {
    this.id = crypto.randomUUID();
    this.strategy = strategy;
    this.tokenId = String(tokenId);
    this.marketId = String(marketId || '');
    this.side = side;
    this.price = price;
    this.sizeUsd = sizeUsd;
    this.expectedEdge = expectedEdge;
    this.confidence = confidence;
    this.reason = reason;
    this.exitPlan = exitPlan;
    this.ttlMs = ttlMs;
    this.maxHoldMs = maxHoldMs;
    this.metadata = metadata;
    this.createdAt = Date.now();
  }
}

class Strategy {
  constructor(name, config, cache, portfolio, volGuard) {
    this.name = name;
    this.config = config;
    this.cache = cache;
    this.portfolio = portfolio;
    this.volGuard = volGuard;
    this.lastDiagnosticLog = new Map();
  }

  async generate() {
    return [];
  }

  diagnosticKey(asset, reason) {
    return `${this.name}:${asset?.tokenId || 'unknown'}:${reason}`;
  }

  shouldLogDiagnostic(asset, reason, cooldownMs = 60_000) {
    const key = this.diagnosticKey(asset, reason);
    const now = Date.now();
    const last = this.lastDiagnosticLog.get(key) || 0;
    if (now - last < cooldownMs) return false;
    this.lastDiagnosticLog.set(key, now);
    return true;
  }

  formatGenerateContext(asset, book, extra = {}) {
    const fields = {
      strategy: this.name,
      token: shortId(asset?.tokenId),
      outcome: asset?.outcome,
      bid: book?.bestBid,
      ask: book?.bestAsk,
      spread: book?.spread,
      mid: book?.midpoint,
      topBid1Usd: book ? topDepthUsd(book.bids, 1) : null,
      topAsk1Usd: book ? topDepthUsd(book.asks, 1) : null,
      bookComplete: isBookComplete(book),
      incompleteBookCause: isBookComplete(book) ? null : incompleteBookCause(book),
      ...extra,
    };

    return Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${cleanLogValue(value)}`)
      .join(' ');
  }

  skip(asset, book, reason, extra = {}) {
    this.portfolio?.recordExecutionEvent?.('strategy_skip', {
      tokenId: asset?.tokenId,
      marketId: asset?.market?.marketId,
      marketSlug: asset?.market?.marketSlug,
      outcome: asset?.outcome,
      strategy: this.name,
      side: extra?.side || null,
      reason,
      price: numericOrNull(book?.midpoint),
      expectedEdge: numericOrNull(extra?.edgeEstimate),
      confidence: numericOrNull(extra?.confidence),
      source: 'strategy_generate_skip',
    });
    if (this.shouldLogDiagnostic(asset, reason)) {
      info(`[RAW SIGNAL COUNT] count=0 skipReason=${reason} ${this.formatGenerateContext(asset, book, extra)}`);
    }
    return [];
  }

  emit(asset, book, signals, extra = {}) {
    const count = Array.isArray(signals) ? signals.length : 0;
    info(`[RAW SIGNAL COUNT] count=${count} ${this.formatGenerateContext(asset, book, extra)}`);
    return signals;
  }
}

class SpreadHunterStrategy extends Strategy {
  constructor(...args) {
    super('SpreadHunter', ...args);
  }

  async generate(asset, book) {
    if (!this.config.spreadHunterEnabled) return this.skip(asset, book, 'strategy_disabled');
    if (!isBookComplete(book)) return this.skip(asset, book, 'incomplete_book');

    const tick = book.tickSize || 0.01;
    const mark = book.midpoint;
    const spread = book.spread;

    if (spread < this.config.spreadHunterMinEdge) {
      return this.skip(asset, book, 'spread_below_min_edge', {
        spread,
        minSpreadEdge: this.config.spreadHunterMinEdge,
      });
    }
    if (this.volGuard.isTripped(asset.tokenId) && !this.config.quoteDuringVolatility) {
      return this.skip(asset, book, 'volatility_guard', {
        quoteDuringVolatility: this.config.quoteDuringVolatility,
      });
    }

    const posUsd = this.portfolio.positionUsd(asset.tokenId, mark);
    const invRatio = clamp(posUsd / this.config.maxPositionUsdPerAsset, -1, 1);
    const exponentialSkew = Math.pow(invRatio, 3) * 0.02;

    const volMultiplier = this.volGuard.getVolMultiplier(asset.tokenId);
    const half = Math.max(tick, (spread * 0.5) * volMultiplier);

    let bid = mark - half / 2 - exponentialSkew;
    let ask = mark + half / 2 - exponentialSkew;

    bid = Math.min(bid, book.bestAsk - tick);
    ask = Math.max(ask, book.bestBid + tick);

    bid = clamp(roundToTick(bid, tick), 0.01, 0.99);
    ask = clamp(roundToTick(ask, tick), 0.01, 0.99);

    // Boundary protection: inventory skew can shift the whole band. If bid/ask
    // collapse into each other, back away instead of creating impossible quotes.
    if (bid >= ask) {
      bid = clamp(roundToTick(mark - tick, tick), 0.01, 0.99);
      ask = clamp(roundToTick(mark + tick, tick), 0.01, 0.99);
    }
    if (!(bid < ask)) {
      return this.skip(asset, book, 'quote_band_collapsed', { bid, ask, tick, mark, spread });
    }

    let baseUsd = this.config.baseOrderUsd;
    if (this.config.hunterMode && spread > 0.08) {
      const dangerScale = clamp(1 - ((spread - 0.08) / 0.14), 0.25, 1);
      baseUsd *= dangerScale;
    }

    const minOrderUsd = Math.max(0.01, Number(this.config.minOrderUsd || 0));
    let buyUsd = Math.max(0, baseUsd * (1 - Math.max(0, invRatio)));
    let sellUsd = Math.max(0, baseUsd * (1 + Math.min(0, invRatio)));
    let ghostThrottle = null;

    if (
      this.config.spreadHunterGhostGateEnabled &&
      this.portfolio.ghostStats.total >= this.config.spreadHunterGhostMinSamples
    ) {
      const favorablePct = (this.portfolio.ghostStats.favorable / Math.max(1, this.portfolio.ghostStats.total)) * 100;
      if (favorablePct < this.config.spreadHunterMinGhostFavorablePct) {
        const multiplier = clamp(this.config.spreadHunterGhostSizeMultiplier, 0.05, 1);
        const buyUsdBeforeGhost = buyUsd;
        buyUsd *= multiplier;
        const action = buyUsd >= minOrderUsd
          ? 'entry_size_reduced'
          : (sellUsd >= minOrderUsd && this.portfolio.position(asset.tokenId) > 0 ? 'exits_only' : 'entry_blocked');
        ghostThrottle = {
          favorablePct: Number(favorablePct.toFixed(2)),
          thresholdPct: this.config.spreadHunterMinGhostFavorablePct,
          samples: this.portfolio.ghostStats.total,
          sizeMultiplier: multiplier,
          action,
          buyUsdBefore: Number(buyUsdBeforeGhost.toFixed(6)),
          buyUsdAfter: Number(buyUsd.toFixed(6)),
          reason: 'SpreadHunter ghost favorable rate below threshold',
        };
        if (this.shouldLogDiagnostic(asset, 'ghost_throttle', 15_000)) {
          warn(
            `[GHOST THROTTLE] favorable=${ghostThrottle.favorablePct} action=${action} ` +
            `token=${shortId(asset?.tokenId)} threshold=${cleanLogValue(ghostThrottle.thresholdPct)} ` +
            `samples=${ghostThrottle.samples} buyUsdBefore=${cleanLogValue(ghostThrottle.buyUsdBefore)} ` +
            `buyUsdAfter=${cleanLogValue(ghostThrottle.buyUsdAfter)}`
          );
        }
      }
    }

    const buyLiquidity = estimateLiquidityConsumption(book, 'buy', buyUsd || this.config.baseOrderUsd, this.config);
    const sellLiquidity = estimateLiquidityConsumption(book, 'sell', sellUsd || this.config.baseOrderUsd, this.config);
    // Lower liquidity penalty is worse, so use the weaker side for edge realism.
    const worstLiquidityPenalty = Math.min(buyLiquidity.penalty, sellLiquidity.penalty);
    const makerLiquidityPenalty = clamp(Math.sqrt(worstLiquidityPenalty), 0.35, 1);
    const volatilityEdgeMultiplier = this.volGuard.isTripped(asset.tokenId)
      ? this.config.volatilityEdgeMultiplier
      : 1;

    const edgeEstimate = Math.max(
      0,
      ((ask - bid) / 2 - this.config.slippageBuffer - this.config.adverseSelectionBuffer) * makerLiquidityPenalty
    );

    const strategyMinEdge = minSignalEdgeForCandidate({ strategy: this.name }, this.config);
    const requiredEdge = strategyMinEdge * volatilityEdgeMultiplier;
    const edgeDiagnostics = {
      bid,
      ask,
      quoteWidth: ask - bid,
      grossHalfSpreadEdge: (ask - bid) / 2,
      slippageBuffer: this.config.slippageBuffer,
      adverseSelectionBuffer: this.config.adverseSelectionBuffer,
      buyUsd,
      sellUsd,
      buyConsumedPct: buyLiquidity.consumedPct,
      sellConsumedPct: sellLiquidity.consumedPct,
      worstLiquidityPenalty,
      makerLiquidityPenalty,
      edgeEstimate,
      strategyMinEdge,
      requiredEdge,
      volatilityEdgeMultiplier,
    };
    if (edgeEstimate < requiredEdge) {
      return this.skip(asset, book, 'edge_below_required', edgeDiagnostics);
    }

    let confidence = clamp(0.35 + spread * 2 + Math.log10(1 + asset.market.volume24h) / 20, 0, 0.85);
    if (ghostThrottle) {
      confidence = clamp(confidence * ghostThrottle.sizeMultiplier, 0, 0.85);
    }

    const health = this.portfolio.executionHealth(Date.now());
    const actionBurnIn = BotEngine.prototype.paperActionBurnInState.call({
      config: this.config,
      portfolio: this.portfolio,
    }, Date.now(), health);
    const paperFlowStarved = actionBurnIn.probationWindowOpen;
    const baseConfidenceFloor = Number(this.config.minConfidence || 0);
    const standardPaperConfidenceFloor = Number.isFinite(Number(this.config.standardPaperMinConfidence))
      ? Number(this.config.standardPaperMinConfidence)
      : baseConfidenceFloor;
    const spreadHunterPaperConfidenceFloor = Number.isFinite(Number(this.config.spreadHunterMinConfidencePaper))
      ? Number(this.config.spreadHunterMinConfidencePaper)
      : standardPaperConfidenceFloor;
    const strictPaperConfidenceFloor = clamp(
      Math.max(
        Math.min(baseConfidenceFloor, standardPaperConfidenceFloor),
        Math.min(baseConfidenceFloor, spreadHunterPaperConfidenceFloor)
      ),
      0,
      1
    );
    const probationConfidenceFloor = clamp(
      Math.max(
        0.34,
        Math.min(
          strictPaperConfidenceFloor - 0.01,
          Number(this.config.paperMakerRecoveryMinConfidence || 0.35) - 0.01,
          Number(this.config.sophieBootstrapMinConfidence || 0.38) - 0.04
        )
      ),
      0,
      1
    );
    const probationTinyOrderUsd = Math.max(0.5, Number(this.config.paperActionBurnInProbationOrderUsd || 1));
    const ghostNearThreshold = Boolean(
      ghostThrottle &&
      Number(ghostThrottle.favorablePct) < Number(ghostThrottle.thresholdPct) &&
      Number(ghostThrottle.favorablePct) >= (
        Number(ghostThrottle.thresholdPct) - Math.max(0, Number(this.config.paperActionBurnInGhostGracePct || 0))
      )
    );
    const probationMaxSpread = Math.max(0.01, Number(this.config.paperActionBurnInMaxSpread || 0.10));
    const probationMaxLiquidityConsumedPct = clamp(Number(this.config.paperActionBurnInMaxLiquidityConsumedPct || 0.35), 0, 1);
    const ghostProbationConfidenceFloor = clamp(
      Math.min(
        probationConfidenceFloor,
        Math.max(0.25, Number(this.config.paperActionBurnInGhostMinConfidence || 0.30))
      ),
      0,
      1
    );
    const ghostProbationEligible = (
      paperFlowStarved &&
      ghostNearThreshold &&
      Number(edgeEstimate) >= strategyMinEdge &&
      Number(spread) <= probationMaxSpread &&
      Number(buyLiquidity.consumedPct) <= probationMaxLiquidityConsumedPct &&
      Number(confidence) < strictPaperConfidenceFloor &&
      Number(confidence) >= ghostProbationConfidenceFloor
    );
    const confidenceProbationEligible = (
      paperFlowStarved &&
      !ghostThrottle &&
      Number(edgeEstimate) >= strategyMinEdge &&
      Number(confidence) < strictPaperConfidenceFloor &&
      Number(confidence) >= probationConfidenceFloor
    );
    const probationEligible = ghostProbationEligible || confidenceProbationEligible;
    const probationTrigger = ghostProbationEligible
      ? 'ghost_near_threshold_probation_admission'
      : confidenceProbationEligible
        ? 'confidence_action_burnin_probation_admission'
        : null;
    const probationFloorApplied = ghostProbationEligible ? ghostProbationConfidenceFloor : probationConfidenceFloor;

    const signals = [];

    if (buyUsd >= this.config.minOrderUsd || probationEligible) {
      const paperProbation = probationEligible
        ? {
          active: true,
          paperOnly: true,
          trigger: probationTrigger,
          admissionReason: 'probation_admission',
          minConfidence: Number(probationFloorApplied.toFixed(3)),
          strictMinConfidence: Number(strictPaperConfidenceFloor.toFixed(3)),
          tinySizeUsd: Number(probationTinyOrderUsd.toFixed(2)),
          edgeFloor: Number(strategyMinEdge.toFixed(4)),
          ordersPlacedLastHour: Number(health.paperOrdersPlacedLastHour || 0),
          ordersPlacedLast15m: Number(health.paperOrdersPlacedLast15m || 0),
          fillsLast15m: Number(health.paperOrdersFilledLast15m || 0),
          targetOrdersPer15m: Number(actionBurnIn.targetOrdersPer15m || 0),
          targetFillsPer15m: Number(actionBurnIn.targetFillsPer15m || 0),
          openOrders: Number(this.portfolio.openOrders.size || 0),
          ghostThrottleActive: ghostThrottle ? true : false,
          ghostNearThreshold,
          buyUsdBefore: Number(buyUsd.toFixed(6)),
          buyUsdAfter: Number(probationTinyOrderUsd.toFixed(6)),
          maxOrderUsd: Number(probationTinyOrderUsd.toFixed(2)),
          maxSpread: Number(probationMaxSpread.toFixed(4)),
          maxLiquidityConsumedPct: Number(probationMaxLiquidityConsumedPct.toFixed(4)),
          referenceBankrollUsd: Number(actionBurnIn.referenceBankrollUsd || 0),
          maxBankrollUsd: Number(actionBurnIn.maxBankrollUsd || 0),
        }
        : null;
      signals.push(new Signal({
        strategy: this.name,
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'buy',
        price: bid,
        sizeUsd: probationEligible ? probationTinyOrderUsd : buyUsd,
        expectedEdge: edgeEstimate,
        confidence,
        reason: `Wide spread hunter: spread=${fmtPrice(spread)}, inv=${(invRatio * 100).toFixed(1)}%, liqUse=${(buyLiquidity.consumedPct * 100).toFixed(1)}%`,
        exitPlan: `Exit near ask ${fmtPrice(ask)} or stale/hold timeout`,
        ttlMs: this.config.orderTtlMs,
        maxHoldMs: this.config.maxHoldMs,
        metadata: {
          askTarget: ask,
          marketQuestion: asset.market.question,
          outcome: asset.outcome,
          liquidityConsumedPct: buyLiquidity.consumedPct,
          liquidityPenalty: buyLiquidity.penalty,
          entryMid: mark,
          paperActionBurnIn: actionBurnIn,
          ...(paperProbation ? { paperProbation } : {}),
          ...(ghostThrottle ? { ghostThrottle } : {}),
        },
      }));
      const probationTraceNearFloor = (
        paperFlowStarved &&
        Number(edgeEstimate) >= strategyMinEdge &&
        Number(confidence) >= Math.max(0, probationConfidenceFloor - 0.05) &&
        Number(confidence) <= Math.min(1, strictPaperConfidenceFloor + 0.02)
      );
      if (probationTraceNearFloor && this.shouldLogDiagnostic(asset, 'paper_probation_trace', 30_000)) {
        const probationTraceReason = probationEligible
          ? 'eligible'
          : Number(confidence) < probationConfidenceFloor
            ? 'confidence_below_probation_floor'
            : Number(confidence) >= strictPaperConfidenceFloor
              ? 'confidence_at_or_above_strict_floor'
              : Number(edgeEstimate) < strategyMinEdge
                ? 'edge_below_standard_min'
                : 'paper_flow_not_starved';
        info(
          `[PAPER PROBATION TRACE] stage=generate strategy=${this.name} token=${shortId(asset?.tokenId)} ` +
          `edge=${cleanLogValue(edgeEstimate)} confidence=${cleanLogValue(confidence)} ` +
          `probationEligible=${probationEligible ? 'true' : 'false'} ` +
          `hasPaperProbationMetadata=${probationEligible ? 'true' : 'false'} ` +
          `paperFlowStarved=${paperFlowStarved ? 'true' : 'false'} ` +
          `actionRateStatus=${actionBurnIn.status} ` +
          `orders15m=${actionBurnIn.ordersPlacedLast15m} targetOrders15m=${actionBurnIn.targetOrdersPer15m} ` +
          `strictFloor=${cleanLogValue(strictPaperConfidenceFloor)} probationFloor=${cleanLogValue(probationConfidenceFloor)} ` +
          `reason=${probationTraceReason}`
        );
      }
    }

    if (sellUsd >= this.config.minOrderUsd && this.portfolio.position(asset.tokenId) > 0) {
      signals.push(new Signal({
        strategy: this.name,
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'sell',
        price: ask,
        sizeUsd: sellUsd,
        expectedEdge: edgeEstimate,
        confidence,
        reason: `Inventory/spread sell: spread=${fmtPrice(spread)}, inv=${(invRatio * 100).toFixed(1)}%, liqUse=${(sellLiquidity.consumedPct * 100).toFixed(1)}%`,
        exitPlan: 'Reduce inventory at wide spread',
        ttlMs: this.config.orderTtlMs,
        maxHoldMs: this.config.maxHoldMs,
        metadata: {
          bidTarget: bid,
          marketQuestion: asset.market.question,
          outcome: asset.outcome,
          liquidityConsumedPct: sellLiquidity.consumedPct,
          liquidityPenalty: sellLiquidity.penalty,
          entryMid: mark,
          ...(ghostThrottle ? { ghostThrottle } : {}),
        },
      }));
    }

    if (signals.length === 0 && ghostThrottle) {
      return this.skip(asset, book, 'ghost_throttle', {
        ...edgeDiagnostics,
        confidence,
        favorablePct: ghostThrottle.favorablePct,
        thresholdPct: ghostThrottle.thresholdPct,
        samples: ghostThrottle.samples,
        buyUsdBeforeGhost: ghostThrottle.buyUsdBefore,
        buyUsdAfterGhost: ghostThrottle.buyUsdAfter,
        ghostThrottleAction: ghostThrottle.action,
      });
    }

    if (signals.length === 0) {
      return this.skip(asset, book, 'size_below_min_or_no_sell_inventory', {
        ...edgeDiagnostics,
        minOrderUsd: this.config.minOrderUsd,
        positionQty: this.portfolio.position(asset.tokenId),
      });
    }

    return this.emit(asset, book, signals, edgeDiagnostics);
  }
}

class InventoryExitStrategy extends Strategy {
  constructor(...args) {
    super('InventoryExit', ...args);
  }

  async generate(asset, book) {
    if (!this.config.inventoryExitEnabled) return this.skip(asset, book, 'strategy_disabled');
    if (!isBookComplete(book)) return this.skip(asset, book, 'incomplete_book');

    const qty = this.portfolio.position(asset.tokenId);
    if (qty <= 0) return this.skip(asset, book, 'no_position', { qty });

    const tick = book.tickSize || 0.01;
    const posUsd = qty * book.midpoint;
    const invRatio = clamp(posUsd / this.config.maxPositionUsdPerAsset, 0, 1);
    if (invRatio < 0.2) return this.skip(asset, book, 'inventory_ratio_below_exit_threshold', { qty, posUsd, invRatio });

    const ask = clamp(roundToTick(Math.max(book.bestBid + tick, book.bestAsk - tick), tick), 0.01, 0.99);
    const sizeUsd = Math.min(posUsd, this.config.baseOrderUsd * (1 + invRatio));

    return this.emit(asset, book, [new Signal({
      strategy: this.name,
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      side: 'sell',
      price: ask,
      sizeUsd,
      expectedEdge: Math.max(0.002, book.spread / 2),
      confidence: clamp(0.55 + invRatio * 0.35, 0, 0.95),
      reason: `Exit inventory: posUsd=$${posUsd.toFixed(2)}, inv=${(invRatio * 100).toFixed(1)}%`,
      exitPlan: 'Reduce existing exposure',
      ttlMs: Math.min(this.config.orderTtlMs, 20_000),
      maxHoldMs: this.config.maxHoldMs,
      metadata: { marketQuestion: asset.market.question, outcome: asset.outcome },
    })], { qty, posUsd, invRatio });
  }
}

class ComplementArbStrategy extends Strategy {
  constructor(...args) {
    super('ComplementArb', ...args);
  }

  async generate(asset, book) {
    if (!this.config.complementArbEnabled) return this.skip(asset, book, 'strategy_disabled');
    if (!isBookComplete(book)) return this.skip(asset, book, 'incomplete_book');

    const siblings = this.cache.getMarketAssets(asset.market.marketId);
    if (siblings.length < 2) return this.skip(asset, book, 'missing_complement_sibling', { siblings: siblings.length });

    const a = siblings[0];
    const b = siblings[1];
    if (asset.tokenId !== a.tokenId) return this.skip(asset, book, 'complement_emit_once_per_market'); // emit once per market

    let bookA;
    let bookB;

    try {
      bookA = await this.cache.getFreshBook(a.tokenId);
      bookB = await this.cache.getFreshBook(b.tokenId);
    } catch {
      return this.skip(asset, book, 'complement_book_fetch_failed');
    }

    if (!isBookComplete(bookA) || !isBookComplete(bookB)) {
      return this.skip(asset, book, 'incomplete_complement_book', {
        legAIncomplete: incompleteBookCause(bookA),
        legBIncomplete: incompleteBookCause(bookB),
      });
    }

    const buyBothCost = bookA.bestAsk + bookB.bestAsk;
    const lockedEdge = 1 - buyBothCost;

    // In a binary market, buying both outcomes below $1 can be a settlement arbitrage.
    // This still needs both sides filled; paper mode treats them separately and tracks strategy.
    if (lockedEdge < this.config.complementArbMinEdge) {
      return this.skip(asset, book, 'complement_edge_below_min', {
        buyBothCost,
        lockedEdge,
        minComplementEdge: this.config.complementArbMinEdge,
      });
    }

    const sizeUsdEach = Math.min(this.config.baseOrderUsd, this.config.maxMarketExposureUsd / 4);
    const confidence = clamp(0.65 + lockedEdge * 8, 0, 0.98);
    const pairId = crypto.randomUUID();

    return this.emit(asset, book, [
      new Signal({
        strategy: this.name,
        tokenId: a.tokenId,
        marketId: a.market.marketId,
        side: 'buy',
        price: bookA.bestAsk,
        sizeUsd: sizeUsdEach,
        expectedEdge: lockedEdge / 2,
        confidence,
        reason: `Complement buy arb: askSum=${buyBothCost.toFixed(3)} lockedEdge=${lockedEdge.toFixed(3)}`,
        exitPlan: 'Atomic paper pair: fill both legs together or cancel together',
        ttlMs: Math.min(this.config.orderTtlMs, 15_000),
        maxHoldMs: 24 * 60 * 60_000,
        metadata: { pairId, complementKey: `${a.tokenId}:${b.tokenId}`, leg: 1, marketQuestion: a.market.question, outcome: a.outcome },
      }),
      new Signal({
        strategy: this.name,
        tokenId: b.tokenId,
        marketId: b.market.marketId,
        side: 'buy',
        price: bookB.bestAsk,
        sizeUsd: sizeUsdEach,
        expectedEdge: lockedEdge / 2,
        confidence,
        reason: `Complement buy arb: askSum=${buyBothCost.toFixed(3)} lockedEdge=${lockedEdge.toFixed(3)}`,
        exitPlan: 'Atomic paper pair: fill both legs together or cancel together',
        ttlMs: Math.min(this.config.orderTtlMs, 15_000),
        maxHoldMs: 24 * 60 * 60_000,
        metadata: { pairId, complementKey: `${a.tokenId}:${b.tokenId}`, leg: 2, marketQuestion: b.market.question, outcome: b.outcome },
      }),
    ], { buyBothCost, lockedEdge });
  }
}

class TailEndMispricingStrategy extends Strategy {
  constructor(...args) {
    super('TailEndMispricing', ...args);
  }

  async generate(asset, book) {
    if (!this.config.tailEndEnabled) return this.skip(asset, book, 'strategy_disabled');
    if (!isBookComplete(book)) return this.skip(asset, book, 'incomplete_book');

    const until = msUntil(asset.market.endDate);
    if (!Number.isFinite(until)) return this.skip(asset, book, 'missing_end_date');
    if (until <= 0 || until > this.config.tailEndHours * 60 * 60 * 1000) {
      return this.skip(asset, book, 'outside_tail_window', {
        hoursUntilEnd: until / (60 * 60 * 1000),
        tailEndHours: this.config.tailEndHours,
      });
    }

    const mid = book.midpoint;
    const spread = book.spread;
    const confidence = confidenceFromPrice(mid);

    if (confidence < this.config.tailEndMinConfidence) {
      return this.skip(asset, book, 'tail_confidence_below_min', { confidence, minConfidence: this.config.tailEndMinConfidence });
    }
    if (spread > 0.08) return this.skip(asset, book, 'tail_spread_too_wide', { spread, maxTailSpread: 0.08 });

    const side = mid > 0.5 ? 'buy' : 'sell';
    if (side === 'sell' && this.portfolio.position(asset.tokenId) <= 0) {
      return this.skip(asset, book, 'tail_sell_no_position', { side, position: this.portfolio.position(asset.tokenId) });
    }

    const tick = book.tickSize || 0.01;
    const price = side === 'buy'
      ? clamp(roundToTick(Math.min(book.bestAsk, book.bestBid + tick), tick), 0.01, 0.99)
      : clamp(roundToTick(Math.max(book.bestBid, book.bestAsk - tick), tick), 0.01, 0.99);

    const edge = Math.abs(mid - 0.5) - spread - this.config.slippageBuffer;
    if (edge < this.config.minSignalEdge) {
      return this.skip(asset, book, 'tail_edge_below_min', { edge, minSignalEdge: this.config.minSignalEdge });
    }

    return this.emit(asset, book, [new Signal({
      strategy: this.name,
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      side,
      price,
      sizeUsd: this.config.baseOrderUsd * 0.6,
      expectedEdge: edge,
      confidence: clamp(confidence, 0, 0.9),
      reason: `Tail-end mispricing: ${hoursUntil(asset.market.endDate).toFixed(1)}h left, mid=${fmtPrice(mid)}`,
      exitPlan: 'Exit on spread collapse, confidence reversal, or hold timeout',
      ttlMs: Math.min(this.config.orderTtlMs, 20_000),
      maxHoldMs: Math.min(this.config.maxHoldMs, Math.max(15 * 60_000, until / 3)),
      metadata: { marketQuestion: asset.market.question, outcome: asset.outcome },
    })], { edge, confidence, hoursUntilEnd: until / (60 * 60 * 1000) });
  }
}

class WhaleCopyStrategy extends Strategy {
  constructor(config, cache, portfolio, volGuard, whaleWatcher) {
    super('WhaleCopy', config, cache, portfolio, volGuard);
    this.whaleWatcher = whaleWatcher;
  }

  async generate(asset, book) {
    if (!this.config.enableWhaleTracking || !this.config.enableWhaleCopyStrategy || !this.whaleWatcher) {
      return this.skip(asset, book, 'strategy_disabled', {
        enableWhaleTracking: this.config.enableWhaleTracking,
        enableWhaleCopyStrategy: this.config.enableWhaleCopyStrategy,
      });
    }
    if (!isBookComplete(book)) return this.skip(asset, book, 'incomplete_book');

    const recentWhale = this.whaleWatcher.findRecentForSignal({
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      metadata: { marketQuestion: asset.market.question },
    });

    if (!recentWhale) return this.skip(asset, book, 'no_recent_whale');
    if (Date.now() - recentWhale.timestamp > this.config.whaleCopyFreshMs) {
      return this.skip(asset, book, 'whale_event_stale', { whaleAgeMs: Date.now() - recentWhale.timestamp });
    }

    // Opposite side: provide liquidity to the whale rather than blindly chasing.
    const oppositeSide = recentWhale.side === 'buy' ? 'sell' : 'buy';
    const offsetMultiplier = this.config.makerSpreadMultiplier || 1.2;
    const tick = book.tickSize || 0.01;

    let price;
    if (oppositeSide === 'sell') {
      price = clamp(roundToTick(book.bestAsk + book.spread * offsetMultiplier, tick), 0.01, 0.99);
    } else {
      price = clamp(roundToTick(book.bestBid - book.spread * offsetMultiplier, tick), 0.01, 0.99);
    }

    const sizeUsd = Math.min(
      this.config.baseOrderUsd * this.config.whaleCopyBaseMultiplier,
      recentWhale.sizeUsd * this.config.whaleCopyWhaleFraction
    );

    if (sizeUsd < this.config.minOrderUsd) {
      return this.skip(asset, book, 'whale_size_below_min_order', { sizeUsd, minOrderUsd: this.config.minOrderUsd });
    }

    return this.emit(asset, book, [new Signal({
      strategy: this.name,
      tokenId: asset.tokenId,
      marketId: asset.market.marketId,
      side: oppositeSide,
      price,
      sizeUsd,
      expectedEdge: Math.max(this.config.minSignalEdge, book.spread * 0.70),
      confidence: 0.65,
      reason: `Whale ${shortId(recentWhale.wallet || recentWhale.handle)} ${recentWhale.side} $${recentWhale.sizeUsd.toFixed(0)} -> providing ${oppositeSide} liquidity`,
      exitPlan: 'Whale-copy maker liquidity; exit on fill quality deterioration or timeout',
      ttlMs: 25_000,
      maxHoldMs: this.config.maxHoldMs,
      metadata: {
        marketQuestion: asset.market.question,
        outcome: asset.outcome,
        whaleWallet: recentWhale.wallet,
        whaleSide: recentWhale.side,
        whaleSizeUsd: recentWhale.sizeUsd,
        whaleAgeMs: Date.now() - recentWhale.timestamp,
        entryMid: book.midpoint,
      },
    })], { sizeUsd, whaleAgeMs: Date.now() - recentWhale.timestamp });
  }
}

function confidenceFromPrice(mid) {
  return Math.abs(mid - 0.5) * 1.6;
}

// =========================
// WHALE WATCHER (ASYNC)
// =========================

class AsyncWhaleWatcher {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.whaleDataApiUrl;
    this.wallets = config.whaleWallets || [];
    this.whaleState = new Map();
    this.events = [];
    this.lastPollMs = 0;
    this.inFlight = false;

    if (config.enableWhaleTracking && this.wallets.length === 0) {
      warn('[WhaleWatcher] Enabled but no WHALE_WALLETS configured. Tracking disabled until wallets are supplied.');
      this.config.enableWhaleTracking = false;
    }
  }

  tick() {
    if (!this.config.enableWhaleTracking || this.wallets.length === 0) return;

    const now = Date.now();
    if (this.inFlight) return;
    if (now - this.lastPollMs < this.config.whalePollMs) return;

    this.lastPollMs = now;
    this.updateWhaleIntel(this.wallets, this.config.whaleMinUsd).catch((e) => {
      warn(`[WhaleOracle] background update failed: ${e.message}`);
    });
  }

  async updateWhaleIntel(wallets, minUsd = this.config.whaleMinUsd) {
    if (!Array.isArray(wallets) || wallets.length === 0) return;
    if (this.inFlight) return;

    this.inFlight = true;

    try {
      const batchSize = Math.max(1, this.config.whaleBatchSize || 3);

      for (let i = 0; i < wallets.length; i += batchSize) {
        const batch = wallets.slice(i, i + batchSize);
        const promises = batch.map((wallet) => this.fetchWalletTrades(wallet, minUsd));
        await Promise.allSettled(promises);

        if (i + batchSize < wallets.length) {
          await sleep(this.config.whaleBatchDelayMs || 1000);
        }
      }

      this.prune();
    } finally {
      this.inFlight = false;
    }
  }

  async fetchWalletTrades(wallet, minUsd) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.whaleApiTimeoutMs);

    try {
      const url = new URL('/trades', this.baseUrl);
      url.searchParams.set('user', wallet);
      url.searchParams.set('limit', String(this.config.whaleTradesLimit));

      const response = await fetch(url.toString(), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const payload = await response.json();
      const trades = Array.isArray(payload) ? payload : payload?.trades || payload?.data || [];
      if (!Array.isArray(trades)) return;

      const normalized = trades
        .map((trade) => this.normalizeTrade(wallet, trade))
        .filter(Boolean)
        .filter((trade) => trade.sizeUsd >= minUsd);

      for (const trade of normalized) {
        this.storeTrade(wallet, trade);
      }
    } catch (error) {
      warn(`[WhaleOracle] Failed to update wallet ${shortId(wallet)}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  normalizeTrade(wallet, trade) {
    if (!trade) return null;

    const price = toNum(trade.price ?? trade.outcomePrice ?? trade.avgPrice, NaN);
    const size = toNum(trade.size ?? trade.shares ?? trade.amount, NaN);
    const directUsd = toNum(trade.sizeUsd ?? trade.usd ?? trade.notionalUsd ?? trade.value, NaN);
    const sizeUsd = Number.isFinite(directUsd)
      ? directUsd
      : Number.isFinite(price) && Number.isFinite(size)
        ? price * size
        : 0;

    const rawTs = trade.timestamp ?? trade.ts ?? trade.time ?? trade.createdAt ?? trade.created_at;
    let timestamp = Number(rawTs);
    if (Number.isFinite(timestamp) && timestamp < 10000000000) timestamp *= 1000;
    if (!Number.isFinite(timestamp)) timestamp = Date.parse(rawTs || '');
    if (!Number.isFinite(timestamp)) timestamp = Date.now();

    const sideRaw = String(trade.side ?? trade.action ?? trade.type ?? '').toLowerCase();
    const side = sideRaw.includes('sell') ? 'sell' : sideRaw.includes('buy') ? 'buy' : sideRaw;

    return {
      handle: wallet,
      wallet,
      tokenId: String(trade.tokenId ?? trade.assetId ?? trade.asset_id ?? trade.conditionTokenId ?? ''),
      marketId: String(trade.marketId ?? trade.conditionId ?? trade.condition_id ?? ''),
      marketTitle: String(trade.title ?? trade.marketTitle ?? trade.question ?? trade.market ?? ''),
      side,
      price,
      sizeUsd,
      timestamp,
      source: 'polymarket_data_api',
    };
  }

  storeTrade(wallet, trade) {
    const key = `${wallet}:${trade.tokenId || trade.marketId || trade.marketTitle}:${trade.timestamp}:${trade.side}:${trade.sizeUsd}`;
    if (this.events.some((e) => e.key === key)) return;

    const event = { ...trade, key };
    this.events.unshift(event);
    this.whaleState.set(wallet, event);
  }

  prune() {
    const now = Date.now();
    this.events = this.events
      .filter((event) => now - event.timestamp <= this.config.whaleLookbackMs)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 500);
  }

  isWhaleActiveOnMarket(marketTitle) {
    const now = Date.now();
    const title = normalizeTitle(marketTitle);
    const lookbackMs = this.config.whaleLookbackMs;

    for (const event of this.events) {
      if (now - event.timestamp > lookbackMs) continue;

      if (normalizeTitle(event.marketTitle) === title) {
        return { active: true, side: event.side, event, ageMs: now - event.timestamp };
      }
    }

    return { active: false, side: null, event: null };
  }

  findRecentForSignal(signal) {
    if (!this.config.enableWhaleTracking || !signal) return null;
    this.prune();
    const now = Date.now();

    return this.events.find((event) => {
      if (now - event.timestamp > this.config.whaleLookbackMs) return false;
      const tokenMatch = event.tokenId && event.tokenId === signal.tokenId;
      const marketMatch = event.marketId && event.marketId === signal.marketId;
      const titleMatch = event.marketTitle && signal.metadata?.marketQuestion && normalizeTitle(event.marketTitle) === normalizeTitle(signal.metadata.marketQuestion);
      return tokenMatch || marketMatch || titleMatch;
    }) || null;
  }
}

function formatWsError(e) {
  if (!e) return 'unknown websocket error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return String(e.code);
  if (e.type) return String(e.type);

  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function normalizeTitle(value) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ');

  return cleaned.split(' ').filter(Boolean).join(' ');
}

// =========================
// MULTI-VIEW CONSENSUS ENGINE
// =========================

class EngineDiagnostics {
  constructor(config) {
    this.config = config;
    this.events = [];
    this.lastStarvationWarningAt = 0;
  }

  record(event = {}) {
    this.events.push({ ...event, ts: Date.now() });

    const max = Math.max(10, this.config.engineStarvationWindow || 50);
    while (this.events.length > max) this.events.shift();

    this.maybeWarnStarvation();
  }

  maybeWarnStarvation() {
    const now = Date.now();
    if (now - this.lastStarvationWarningAt < this.config.engineStarvationWarnCooldownMs) return;

    const passingCandidates = this.events.filter((e) => e.scorePassed).length;
    const routeBlocks = this.events.filter((e) => e.blockReason === 'route_not_authorized').length;
    const placed = this.events.filter((e) => e.blockReason === 'order_placed').length;
    const duplicateSkips = this.events.filter((e) => e.blockReason === 'order_skip_duplicate').length;
    const routeBlockPct = passingCandidates > 0 ? routeBlocks / passingCandidates : 0;

    if (
      passingCandidates >= this.config.engineStarvationMinPassingCandidates &&
      routeBlockPct >= this.config.engineStarvationRouteBlockPct &&
      placed === 0 &&
      duplicateSkips === 0
    ) {
      warn(
        `[ENGINE STARVATION WARNING] passingCandidates=${passingCandidates} routeBlocks=${routeBlocks} ` +
        `placed=0 duplicateSkips=0 likelyRouteModelOverblocking=true`
      );
      this.lastStarvationWarningAt = now;
    }
  }
}

class MultiConsensusEngine {
  constructor(config, diagnostics = null) {
    this.config = config;
    this.diagnostics = diagnostics;
    this.midHistory = new Map();
  }

  evaluateSignal(signal, asset, book, cache, portfolio, volGuard, whaleTracker = null) {
    if (!signal || !asset || !book) {
      warn(
        `[CONSENSUS BLOCK] block=invalid_input signalPresent=${Boolean(signal)} ` +
        `assetPresent=${Boolean(asset)} bookPresent=${Boolean(book)}`
      );
      return null;
    }

    const protectiveExit = ['InventoryExit', 'StopLossExit', 'TakeProfitExit'].includes(signal.strategy);
    if (protectiveExit) {
      signal.metadata = {
        ...(signal.metadata || {}),
        consensus: {
          score: 1,
          authorized: true,
          reason: 'Protective exit authorized as risk-reducing route',
          route: {
            mode: 'RISK_EXIT',
            state: signal.strategy === 'InventoryExit' ? 'INVENTORY_EXIT' : 'PROTECTIVE_EXIT',
            authorized: true,
            reason: 'Protective exit authorized as risk-reducing route',
          },
        },
      };
      info(
        `[CONSENSUS PASS] ${signal.strategy} ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
        `score=1.000 threshold=${this.config.consensusThreshold} route=RISK_EXIT:${signal.strategy === 'InventoryExit' ? 'INVENTORY_EXIT' : 'PROTECTIVE_EXIT'} reason="protective_exit"`
      );
      return signal;
    }

    this.recordMid(signal.tokenId, book.midpoint);

    const whaleEvent = whaleTracker?.findRecentForSignal?.(signal) || null;

    const components = {
      structure: this.scoreStructure(signal, asset, book, cache),
      depth: this.scoreDepth(book),
      imbalance: this.scoreImbalance(signal, book),
      momentum: this.scoreMomentum(signal, book),
      volatility: this.scoreVolatility(signal, book, volGuard),
      portfolio: this.scorePortfolio(signal, book, portfolio),
      timing: this.scoreTiming(signal, asset),
      whale: this.scoreWhale(signal, whaleEvent),
    };

    const weights = signal.strategy === 'ComplementArb'
      ? { structure: 0.34, depth: 0.13, imbalance: 0.08, momentum: 0.08, volatility: 0.17, portfolio: 0.12, timing: 0.04, whale: 0.04 }
      : { structure: 0.20, depth: 0.15, imbalance: 0.13, momentum: 0.13, volatility: 0.16, portfolio: 0.14, timing: 0.05, whale: 0.04 };

    const score = Object.entries(weights).reduce((sum, [name, weight]) => {
      return sum + (components[name] ?? 0) * weight;
    }, 0);

    const route = this.routeExecution({
      signal,
      asset,
      book,
      cache,
      portfolio,
      volGuard,
      components,
      score,
      whaleEvent,
    });

    const authorized = score >= this.config.consensusThreshold && route.authorized;
    const scorePass = score >= this.config.consensusThreshold;

    signal.metadata = {
      ...(signal.metadata || {}),
      consensus: {
        score: Number(score.toFixed(4)),
        authorized,
        threshold: this.config.consensusThreshold,
        components: Object.fromEntries(
          Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(4))])
        ),
        route,
        whaleEvent: whaleEvent ? {
          handle: whaleEvent.handle,
          side: whaleEvent.side,
          sizeUsd: whaleEvent.sizeUsd,
          price: whaleEvent.price,
          source: whaleEvent.source,
          ageMs: Date.now() - whaleEvent.timestamp,
        } : null,
      },
    };

    if (!authorized) {
      const routeAuth = Boolean(route.authorized);
      const blockReason = [
        scorePass ? null : 'score_below_threshold',
        routeAuth ? null : (route.blockReason || 'route_not_authorized'),
      ].filter(Boolean).join('+') || 'unknown';

      this.diagnostics?.record({
        strategy: signal.strategy,
        route: `${route.mode}:${route.state}`,
        scorePassed: scorePass,
        blockReason: routeAuth ? 'score_below_threshold' : (route.blockReason || 'route_not_authorized'),
      });

      const componentText = Object.entries(components)
        .map(([name, value]) => `${name}=${Number(value || 0).toFixed(3)}`)
        .join(' ');
      const routeReason = route?.reason ? String(route.reason).replace(/\s+/g, ' ') : 'no route reason';

      warn(
        `[CONSENSUS BLOCK] ${signal.strategy} ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
        `block=${blockReason} score=${score.toFixed(3)} threshold=${this.config.consensusThreshold} ` +
        `route=${route.mode}:${route.state} routeAuth=${routeAuth} reason="${routeReason}" ` +
        `spread=${cleanLogValue(book.spread)} edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)} ${componentText}`
      );
      return null;
    }

    this.diagnostics?.record({
      strategy: signal.strategy,
      route: `${route.mode}:${route.state}`,
      scorePassed: true,
      blockReason: 'route_authorized',
    });

    info(
      `[CONSENSUS PASS] ${signal.strategy} ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `score=${score.toFixed(3)} threshold=${this.config.consensusThreshold} route=${route.mode}:${route.state} ` +
      `reason="${String(route.reason || 'authorized').replace(/\s+/g, ' ')}" ` +
      `spread=${cleanLogValue(book.spread)} edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)}`
    );

    this.applyExecutionRoute(signal, route);
    this.applyWhaleConsensusAdjustment(signal, whaleEvent);
    this.applyAdaptivePositionSizing(signal, components, route, book, portfolio);

    // Consensus cannot bypass RiskEngine. It can only adjust quality scores
    // before the hard exposure/cash/drawdown rules run.
    const qualityMultiplier = clamp(
      this.config.consensusPenaltyMin + score * 0.45,
      this.config.consensusPenaltyMin,
      this.config.consensusBoostMax
    );

    signal.confidence = clamp(signal.confidence * qualityMultiplier, 0, 0.99);
    signal.expectedEdge = signal.expectedEdge * qualityMultiplier;

    return signal;
  }

  routeExecution(marketData) {
    const { signal, book, volGuard } = marketData;
    if (!signal || !isBookComplete(book) || !this.isBookFreshForRoute(book)) {
      return {
        mode: 'WAIT',
        state: 'WAIT',
        authorized: false,
        reason: 'stale_book',
        blockReason: 'stale_book',
        confidenceMultiplier: 0,
        edgeMultiplier: 0,
        sizeMultiplier: 0,
      };
    }

    if (volGuard?.isTripped?.(signal.tokenId) && !this.config.quoteDuringVolatility) {
      return {
        mode: 'WAIT',
        state: 'WAIT',
        authorized: false,
        reason: 'volatility_guard',
        blockReason: 'volatility_guard',
        confidenceMultiplier: 0,
        edgeMultiplier: 0,
        sizeMultiplier: 0,
      };
    }

    if (isGabagoolStrategy(signal)) {
      return this.executeGabagoolOracleStrategy(marketData);
    }

    const targetDisplacement = this.calculateTargetWalletDisplacement(marketData);
    const volatilityState = this.calculateVolatility(marketData, targetDisplacement);

    // New Sophie objective:
    // Do not chase YES/NO purely because trend is high. If target-wallet style
    // displacement appears, respond as a market maker around the displaced book.
    if (this.config.targetWalletMode && targetDisplacement.detected) {
      return this.executeMakerStrategy({
        ...marketData,
        targetDisplacement,
        forcedReason: `${this.config.targetWalletHandle} style displacement detected`,
      });
    }

    if (volatilityState === 'STABLE') {
      return this.executeMakerStrategy({ ...marketData, targetDisplacement });
    }

    // Sniper mode is now secondary and conservative. It only runs when the
    // signal is already aligned and no target-wallet displacement is available.
    if (volatilityState === 'TRENDING') {
      return this.executeSniperStrategy({ ...marketData, targetDisplacement });
    }

    return {
      mode: 'WAIT',
      state: volatilityState,
      authorized: false,
      reason: 'Market is neither stable enough for maker mode nor cleanly directional enough for sniper mode',
      blockReason: 'route_not_authorized',
      confidenceMultiplier: 0,
      edgeMultiplier: 0,
      sizeMultiplier: 0,
      targetDisplacement,
    };
  }

  calculateVolatility({ signal, book, volGuard }, targetDisplacement = null) {
    if (!signal || !isBookComplete(book)) return 'WAIT';
    if (volGuard?.isTripped?.(signal.tokenId) && !this.config.quoteDuringVolatility) return 'WAIT';

    const arr = this.midHistory.get(String(signal.tokenId)) || [];
    const first = arr[0]?.mid;
    const last = arr[arr.length - 1]?.mid;
    const trendMovePct = Number.isFinite(first) && first > 0 && Number.isFinite(last)
      ? Math.abs((last - first) / first)
      : 0;

    if (book.spread > this.config.hunterMaxSpread) return 'WAIT';

    // A target-wallet/order-book displacement should not automatically make us
    // chase direction. It becomes a maker opportunity if spread/depth are usable.
    if (targetDisplacement?.detected) {
      return 'STABLE';
    }

    if (trendMovePct >= this.config.consensusTrendMovePct) {
      return 'TRENDING';
    }

    if (book.spread <= this.config.consensusStableMaxSpread) {
      return 'STABLE';
    }

    if (book.spread <= this.config.hunterMaxSpread && trendMovePct < this.config.consensusTrendMovePct * 0.65) {
      return 'STABLE';
    }

    return 'WAIT';
  }

  isBookFreshForRoute(book) {
    if (!book || !book.cachedAt) return true;
    return Date.now() - book.cachedAt <= this.config.routeAuthMaxBookAgeMs;
  }

  spreadHunterMakerStableDecision({ signal, book, volGuard }) {
    if (signal.strategy !== 'SpreadHunter') return null;
    if (!isBookComplete(book)) return { authorized: false, reason: 'stale_book', blockReason: 'stale_book' };
    if (!this.isBookFreshForRoute(book)) return { authorized: false, reason: 'stale_book', blockReason: 'stale_book' };
    if (book.spread > this.config.hunterMaxSpread) return { authorized: false, reason: 'spread exceeds configured max', blockReason: 'route_not_authorized' };
    if (volGuard?.isTripped?.(signal.tokenId) && !this.config.quoteDuringVolatility) {
      return { authorized: false, reason: 'volatility_guard', blockReason: 'volatility_guard' };
    }
    if (!Number.isFinite(signal.expectedEdge) || signal.expectedEdge < this.config.minSignalEdge) {
      return { authorized: false, reason: 'edge below minimum', blockReason: 'route_not_authorized' };
    }

    const topBidUsd = topDepthUsd(book.bids, 1);
    const topAskUsd = topDepthUsd(book.asks, 1);
    if (Math.min(topBidUsd, topAskUsd) < this.config.hunterMinTopDepthUsd) {
      return { authorized: false, reason: 'depth/liquidity below SpreadHunter minimum', blockReason: 'route_not_authorized' };
    }

    const liquidityPenalty = Number(signal.metadata?.liquidityPenalty ?? NaN);
    if (Number.isFinite(liquidityPenalty) && liquidityPenalty <= 0) {
      return { authorized: false, reason: 'depth/liquidity failed execution estimate', blockReason: 'route_not_authorized' };
    }

    const ghostThrottle = signal.metadata?.ghostThrottle;
    if (ghostThrottle && Number(ghostThrottle.sizeMultiplier) <= 0) {
      return { authorized: false, reason: 'ghost_throttle', blockReason: 'ghost_throttle' };
    }

    return {
      authorized: true,
      reason: 'SpreadHunter authorized for maker-stable spread capture',
      blockReason: null,
    };
  }

  complementArbMakerStableDecision({ signal, components }) {
    if (signal.strategy !== 'ComplementArb') return null;
    const authorized = components.structure >= 0.45 && components.depth >= 0.45 && components.volatility >= 0.36;
    return {
      authorized,
      reason: authorized
        ? 'ComplementArb authorized for complement maker route'
        : 'ComplementArb maker route requires complement-arbitrage structure, depth, and volatility checks',
      blockReason: authorized ? null : 'route_not_authorized',
    };
  }

  makerStableDecision(context) {
    return (
      this.spreadHunterMakerStableDecision(context) ||
      this.complementArbMakerStableDecision(context) ||
      {
        authorized: false,
        reason: `Stable/displaced book but strategy ${context.signal.strategy} is not maker-compatible`,
        blockReason: 'route_not_authorized',
      }
    );
  }

  executeMakerStrategy({ signal, book, components, targetDisplacement, forcedReason, volGuard }) {
    const decision = this.makerStableDecision({ signal, book, components, targetDisplacement, forcedReason, volGuard });
    const authorized = decision.authorized;

    const mid = book.midpoint;
    const spread = Math.max(book.spread, book.tickSize || 0.01);
    const offset = spread * this.config.makerSpreadMultiplier;
    const tick = book.tickSize || 0.01;

    const makerBid = clamp(roundToTick(mid - offset, tick), 0.01, 0.99);
    const makerAsk = clamp(roundToTick(mid + offset, tick), 0.01, 0.99);

    return {
      mode: 'MAKER',
      state: 'STABLE',
      authorized,
      reason: authorized
        ? (forcedReason || decision.reason)
        : decision.reason,
      blockReason: decision.blockReason || null,
      confidenceMultiplier: targetDisplacement?.detected ? this.config.consensusMakerBoost * 1.05 : this.config.consensusMakerBoost,
      edgeMultiplier: targetDisplacement?.detected ? this.config.consensusMakerBoost * 1.05 : this.config.consensusMakerBoost,
      sizeMultiplier: 1.0,
      makerBid,
      makerAsk,
      makerMid: Number(mid.toFixed(4)),
      makerOffset: Number(offset.toFixed(4)),
      spread: Number(book.spread.toFixed(4)),
      targetDisplacement,
    };
  }

  executeSniperStrategy({ signal, book, components }) {
    const arr = this.midHistory.get(String(signal.tokenId)) || [];
    const first = arr[0]?.mid;
    const last = arr[arr.length - 1]?.mid;
    const directionalMove = Number.isFinite(first) && Number.isFinite(last) ? last - first : 0;

    const aligned =
      (signal.side === 'buy' && directionalMove > 0) ||
      (signal.side === 'sell' && directionalMove < 0);

    const sniperCompatible = signal.strategy === 'TailEndMispricing';
    const authorized = sniperCompatible && aligned && components.volatility >= 0.36 && components.portfolio >= 0.35;
    const reason = authorized
      ? 'Directional move detected: route to sniper mode with reduced size'
      : !aligned
        ? 'Trend detected but signal is not aligned with the move'
        : `Trend detected but strategy ${signal.strategy} is not sniper-compatible`;

    return {
      mode: 'SNIPER',
      state: 'TRENDING',
      authorized,
      reason,
      blockReason: authorized ? null : 'route_not_authorized',
      confidenceMultiplier: aligned ? 1.08 : 0.88,
      edgeMultiplier: aligned ? 1.08 : 0.88,
      sizeMultiplier: this.config.consensusSniperSizeMultiplier,
      directionalMove: Number(directionalMove.toFixed(4)),
      spread: Number(book.spread.toFixed(4)),
    };
  }

  executeGabagoolOracleStrategy({ signal, book, volGuard }) {
    if (!isBookComplete(book)) {
      return {
        mode: 'ORACLE_SCALP',
        state: 'WAIT',
        authorized: false,
        reason: 'stale_book',
        blockReason: 'stale_book',
        confidenceMultiplier: 0,
        edgeMultiplier: 0,
        sizeMultiplier: 0,
      };
    }
    if (volGuard?.isTripped?.(signal.tokenId) && !this.config.quoteDuringVolatility) {
      return {
        mode: 'ORACLE_SCALP',
        state: 'WAIT',
        authorized: false,
        reason: 'volatility_guard',
        blockReason: 'volatility_guard',
        confidenceMultiplier: 0,
        edgeMultiplier: 0,
        sizeMultiplier: 0,
      };
    }

    const topBidUsd = topDepthUsd(book.bids, 1);
    const topAskUsd = topDepthUsd(book.asks, 1);
    const freshOracle = signal.metadata?.gabagool?.oracleSignalFresh === true;
    const exitIntent = signal.metadata?.gabagool?.exitIntent === true;
    const authorized = (
      (freshOracle || exitIntent) &&
      Number.isFinite(signal.expectedEdge) &&
      signal.expectedEdge >= this.config.minSignalEdge &&
      Math.min(topBidUsd, topAskUsd) >= Math.max(this.config.hunterMinTopDepthUsd, 5) &&
      Number.isFinite(book.spread) &&
      book.spread <= Math.min(this.config.hunterMaxSpread, 0.12)
    );

    return {
      mode: 'ORACLE_SCALP',
      state: freshOracle ? 'BTC_ORACLE' : 'EXIT',
      authorized,
      reason: authorized
        ? 'Gabagool BTC oracle scalp authorized for aggressive paper entry/exit'
        : 'Gabagool BTC oracle scalp failed freshness/depth/spread/edge checks',
      blockReason: authorized ? null : 'route_not_authorized',
      confidenceMultiplier: exitIntent ? 1.0 : 1.04,
      edgeMultiplier: 1.0,
      sizeMultiplier: 1.0,
    };
  }

  applyExecutionRoute(signal, route) {
    if (!signal || !route) return signal;
    signal.confidence = clamp(signal.confidence * (route.confidenceMultiplier ?? 1), 0, 0.99);
    signal.expectedEdge = signal.expectedEdge * (route.edgeMultiplier ?? 1);

    if (route.mode === 'MAKER') {
      // Flip Sophie from directional YES/NO chasing into market-maker placement.
      // Buy limits rest below midpoint; sell limits rest above midpoint.
      if (signal.side === 'buy' && Number.isFinite(route.makerBid)) {
        signal.price = route.makerBid;
      }
      if (signal.side === 'sell' && Number.isFinite(route.makerAsk)) {
        signal.price = route.makerAsk;
      }
      signal.metadata = {
        ...(signal.metadata || {}),
        makerRoute: {
          mid: route.makerMid,
          bid: route.makerBid,
          ask: route.makerAsk,
          offset: route.makerOffset,
          spread: route.spread,
          targetDisplacement: route.targetDisplacement,
        },
      };
      signal.exitPlan = `${signal.exitPlan} | Maker route: limit @ mid ± ${this.config.makerSpreadMultiplier}x spread`;
    }

    if (route.mode === 'SNIPER') {
      signal.sizeUsd = Math.max(this.config.minOrderUsd, signal.sizeUsd * (route.sizeMultiplier ?? 1));
      signal.ttlMs = Math.min(signal.ttlMs, 20_000);
      signal.exitPlan = `${signal.exitPlan} | Sniper route: smaller size, faster timeout`;
    }

    if (route.mode === 'ORACLE_SCALP') {
      signal.ttlMs = Math.min(signal.ttlMs, 12_000);
      signal.metadata = {
        ...(signal.metadata || {}),
        oracleRoute: {
          mode: route.mode,
          state: route.state,
          aggressive: true,
        },
      };
    }

    return signal;
  }

  applyWhaleConsensusAdjustment(signal, whaleEvent) {
    if (!this.config.enableWhaleTracking || !signal || !whaleEvent) return signal;

    const whaleSide = String(whaleEvent.side || '').toLowerCase();
    const aligned = whaleSide === signal.side;

    signal.metadata = {
      ...(signal.metadata || {}),
      whaleSignal: {
        aligned,
        wallet: whaleEvent.wallet,
        handle: whaleEvent.handle,
        side: whaleEvent.side,
        sizeUsd: whaleEvent.sizeUsd,
        ageMs: Date.now() - whaleEvent.timestamp,
      },
    };

    if (aligned) {
      signal.confidence = Math.min(0.95, signal.confidence * 1.25);
      signal.expectedEdge *= 1.15;
      info(`[WHALE_BOOST] ${signal.strategy} aligned with whale ${shortId(whaleEvent.wallet || whaleEvent.handle)}`);
    } else if (whaleSide) {
      signal.confidence *= 0.70;
      signal.expectedEdge *= 0.60;
      warn(`[WHALE_VETO] ${signal.strategy} opposing whale ${shortId(whaleEvent.wallet || whaleEvent.handle)}`);
    }

    return signal;
  }

  applyAdaptivePositionSizing(signal, components, route, book, portfolio) {
    if (!this.config.enableAdaptiveSizing || !signal || signal.side !== 'buy') return signal;

    const edgeQuality = clamp(signal.expectedEdge / Math.max(this.config.minSignalEdge, 0.0001), 0.35, 1.35);
    const depthQuality = clamp(components.depth || 0.5, 0.25, 1.0);
    const imbalanceQuality = clamp(components.imbalance || 0.5, 0.25, 1.0);
    const volatilityQuality = clamp(components.volatility || 0.5, 0.20, 1.0);
    const portfolioQuality = clamp(components.portfolio || 0.5, 0.20, 1.0);
    const whaleQuality = clamp(components.whale || 0.5, 0.40, 1.0);
    const routeQuality = route?.mode === 'MAKER' ? 1.0 : route?.mode === 'SNIPER' ? 0.75 : 0.50;

    let ghostQuality = 1.0;
    if (portfolio?.ghostStats?.total >= 10) {
      const favorableRate = portfolio.ghostStats.favorable / Math.max(1, portfolio.ghostStats.total);
      if (favorableRate < 0.45) ghostQuality = this.config.adaptiveGhostPenalty;
      if (favorableRate > 0.60) ghostQuality = 1.12;
    }

    const liquidity = estimateLiquidityConsumption(book, signal.side, signal.sizeUsd, this.config);
    const liquidityQuality = clamp(liquidity.penalty, 0.20, 1.0);

    const multiplier = clamp(
      edgeQuality * depthQuality * imbalanceQuality * volatilityQuality * portfolioQuality * whaleQuality * routeQuality * ghostQuality * liquidityQuality,
      this.config.adaptiveMinSizeMultiplier,
      this.config.adaptiveMaxSizeMultiplier
    );

    const originalSizeUsd = signal.sizeUsd;
    signal.sizeUsd = Math.max(this.config.minOrderUsd, signal.sizeUsd * multiplier);
    signal.metadata = {
      ...(signal.metadata || {}),
      adaptiveSizing: {
        originalSizeUsd: Number(originalSizeUsd.toFixed(2)),
        finalSizeUsd: Number(signal.sizeUsd.toFixed(2)),
        multiplier: Number(multiplier.toFixed(4)),
        edgeQuality: Number(edgeQuality.toFixed(4)),
        depthQuality: Number(depthQuality.toFixed(4)),
        imbalanceQuality: Number(imbalanceQuality.toFixed(4)),
        volatilityQuality: Number(volatilityQuality.toFixed(4)),
        portfolioQuality: Number(portfolioQuality.toFixed(4)),
        whaleQuality: Number(whaleQuality.toFixed(4)),
        ghostQuality: Number(ghostQuality.toFixed(4)),
        liquidityQuality: Number(liquidityQuality.toFixed(4)),
      },
    };

    return signal;
  }

  calculateTargetWalletDisplacement({ signal, book, whaleEvent }) {
    if (!this.config.targetWalletMode || !signal || !isBookComplete(book)) {
      return { detected: false, reason: 'target wallet mode disabled or incomplete book' };
    }

    if (whaleEvent) {
      const mid = book.midpoint;
      const price = toNum(whaleEvent.price, NaN);
      const displacementPct = Number.isFinite(price) && mid > 0 ? Math.abs(price - mid) / mid : 0;
      return {
        detected: true,
        source: whaleEvent.source || 'whale_tracker',
        handle: whaleEvent.handle || this.config.targetWalletHandle,
        side: whaleEvent.side,
        sizeUsd: whaleEvent.sizeUsd,
        price,
        displacementPct: Number(displacementPct.toFixed(4)),
        reason: 'Recent whale/target-wallet event matched this market or token',
      };
    }

    // If a future wallet-tracker module tags a signal with the observed target
    // execution, honor that direct evidence first. This avoids pretending we
    // have wallet-flow data when we only have public book movement.
    const direct = signal.metadata?.targetWalletExecution;
    if (direct) {
      const sizeUsd = toNum(direct.sizeUsd, 0);
      const price = toNum(direct.price, NaN);
      const side = String(direct.side || '').toLowerCase();
      const mid = book.midpoint;
      const displacementPct = Number.isFinite(price) && mid > 0 ? Math.abs(price - mid) / mid : 0;

      return {
        detected: true,
        source: 'direct_target_wallet_execution',
        handle: direct.handle || this.config.targetWalletHandle,
        side,
        sizeUsd,
        price,
        displacementPct: Number(displacementPct.toFixed(4)),
        reason: 'Signal carried direct target-wallet execution metadata',
      };
    }

    return { detected: false, reason: 'No recent whale/target-wallet event matched this signal' };
  }

  scoreWhale(signal, whaleEvent) {
    if (!this.config.enableWhaleTracking) return 0.5;
    if (!whaleEvent) return 0.5;

    const ageMs = Date.now() - whaleEvent.timestamp;
    const freshness = clamp(1 - ageMs / Math.max(1, this.config.whaleLookbackMs), 0, 1);
    const sizeQuality = clamp(Math.log10(1 + whaleEvent.sizeUsd) / 5, 0, 1);
    const side = String(whaleEvent.side || '').toLowerCase();

    if (!side) return 0.5 + freshness * 0.1;

    const aligned = side === signal.side;
    return aligned
      ? clamp(0.55 + freshness * 0.25 + sizeQuality * 0.20, 0, 1)
      : clamp(0.45 - freshness * 0.20, 0, 1);
  }

  recordMid(tokenId, mid) {
    if (!Number.isFinite(mid)) return;

    const key = String(tokenId);
    const arr = this.midHistory.get(key) || [];
    arr.push({ t: Date.now(), mid });

    while (arr.length > this.config.historyLookback) arr.shift();
    this.midHistory.set(key, arr);
  }

  scoreStructure(signal, asset, book, cache) {
    if (isGabagoolStrategy(signal)) {
      const freshOracle = signal.metadata?.gabagool?.oracleSignalFresh === true;
      const exitIntent = signal.metadata?.gabagool?.exitIntent === true;
      return clamp((freshOracle ? 0.72 : 0.55) + (exitIntent ? 0.06 : 0), 0, 1);
    }

    if (signal.strategy === 'ComplementArb') {
      const siblings = cache.getMarketAssets(asset.market.marketId);
      if (siblings.length < 2) return 0.25;

      const siblingBooks = siblings.map((s) => cache.getBook(s.tokenId)).filter(Boolean);
      if (siblingBooks.length < 2 || siblingBooks.some((b) => !isBookComplete(b))) return 0.35;

      const askSum = siblingBooks.slice(0, 2).reduce((sum, b) => sum + b.bestAsk, 0);
      const edge = 1 - askSum;
      return clamp(0.45 + edge * 15, 0, 1);
    }

    if (signal.strategy === 'SpreadHunter') {
      return clamp(0.35 + book.spread * 4 + Math.log10(1 + asset.market.volume24h) / 12, 0, 1);
    }

    if (signal.strategy === 'TailEndMispricing') {
      return clamp(0.40 + Math.abs(book.midpoint - 0.5), 0, 1);
    }

    return 0.5;
  }

  scoreDepth(book) {
    if (!isBookComplete(book)) return 0;
    const bidDepth = topDepthUsd(book.bids, this.config.imbalanceDepthLevels);
    const askDepth = topDepthUsd(book.asks, this.config.imbalanceDepthLevels);
    const weaker = Math.min(bidDepth, askDepth);
    const stronger = Math.max(bidDepth, askDepth);
    const balance = stronger > 0 ? weaker / stronger : 0;

    const depthQuality = clamp(Math.log10(1 + weaker) / 3.2, 0, 1);
    return clamp(depthQuality * 0.70 + balance * 0.30, 0, 1);
  }

  scoreImbalance(signal, book) {
    if (!this.config.enableImbalanceSignals) return 0.5;

    const ob = computeOrderBookImbalance(book, this.config.imbalanceDepthLevels);
    if (!ob.usable) return 0.4;

    const abs = Math.abs(ob.imbalance);
    const balancedBonus = abs <= this.config.imbalanceBalancedThreshold ? 0.65 : 0.50;
    const directionalBonus =
      (signal.side === 'buy' && ob.imbalance > 0) ||
      (signal.side === 'sell' && ob.imbalance < 0)
        ? 0.25
        : -0.10;

    return clamp(balancedBonus + directionalBonus + abs * 0.25, 0, 1);
  }

  scoreMomentum(signal, book) {
    const arr = this.midHistory.get(String(signal.tokenId)) || [];
    if (arr.length < 4) return 0.55;

    const first = arr[0].mid;
    const last = arr[arr.length - 1].mid;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return 0.5;

    const move = (last - first) / first;
    if (Math.abs(move) < 0.008) return 0.65;

    const aligned = (signal.side === 'buy' && move > 0) || (signal.side === 'sell' && move < 0);
    return aligned ? 0.72 : 0.38;
  }

  scoreVolatility(signal, book, volGuard) {
    if (!isBookComplete(book)) return 0;
    if (volGuard?.isTripped?.(signal.tokenId) && !this.config.quoteDuringVolatility) return 0.25;
    if (book.spread > this.config.hunterMaxSpread) return 0.2;
    return clamp(1 - (book.spread / Math.max(this.config.hunterMaxSpread, 0.01)) * 0.45, 0, 1);
  }

  scorePortfolio(signal, book, portfolio) {
    if (!portfolio || !isBookComplete(book)) return 0.5;

    const assetExposure = Math.abs(portfolio.positionUsd(signal.tokenId, book.midpoint));
    const marketExposure = Math.abs(portfolio.marketExposureUsd(signal.marketId, book.midpoint));
    const totalExposure = Math.abs(portfolio.totalExposureUsd(book.midpoint));
    const drawdown = portfolio.drawdownPct();

    const assetScore = 1 - clamp(assetExposure / Math.max(1, this.config.maxPositionUsdPerAsset), 0, 1);
    const marketScore = 1 - clamp(marketExposure / Math.max(1, this.config.maxMarketExposureUsd), 0, 1);
    const totalScore = 1 - clamp(totalExposure / Math.max(1, this.config.maxTotalExposureUsd), 0, 1);
    const drawdownScore = 1 - clamp(drawdown / Math.max(1, this.config.maxDrawdownPct), 0, 1);

    return clamp((assetScore * 0.32) + (marketScore * 0.24) + (totalScore * 0.24) + (drawdownScore * 0.20), 0, 1);
  }

  scoreTiming(signal, asset) {
    if (isGabagoolStrategy(signal)) {
      const exitIntent = signal.metadata?.gabagool?.exitIntent === true;
      const secondsIntoWindow = Number(signal.metadata?.gabagool?.secondsIntoWindow);
      if (exitIntent) return 0.78;
      if (!Number.isFinite(secondsIntoWindow)) return 0.62;
      if (secondsIntoWindow <= 60) return 0.86;
      if (secondsIntoWindow <= 150) return 0.72;
      if (secondsIntoWindow <= 240) return 0.48;
      return 0.30;
    }

    const ms = msUntil(asset.market.endDate);
    if (!Number.isFinite(ms)) return 0.55;
    if (ms < 30 * 60_000) return 0.2;
    if (ms < 2 * 60 * 60_000) return 0.45;
    return 0.65;
  }
}

// =========================
// VOLATILITY GUARD
// =========================

class VolatilityGuard {
  constructor(config) {
    this.config = config;
    this.history = new Map();
    this.trippedUntil = new Map();
  }

  update(tokenId, midpoint) {
    if (!Number.isFinite(midpoint)) return;

    const key = String(tokenId);
    const arr = this.history.get(key) || [];
    arr.push({ t: Date.now(), p: midpoint });

    while (arr.length > this.config.historyLookback) arr.shift();
    this.history.set(key, arr);

    if (arr.length < 6) return;

    const oldest = arr[0].p;
    const newest = arr[arr.length - 1].p;
    if (!oldest || !newest) return;

    const changePct = Math.abs((newest - oldest) / oldest) * 100;
    if (changePct >= this.config.volatilityTripPct) {
      this.trippedUntil.set(key, Date.now() + this.config.volatilityCooldownMs);
      warn(`VOL GUARD tripped for ${shortId(tokenId)} move=${changePct.toFixed(2)}%`);
    }
  }

  isTripped(tokenId) {
    const until = this.trippedUntil.get(String(tokenId)) || 0;
    return until > Date.now();
  }

  getVolMultiplier(tokenId) {
    return this.isTripped(tokenId) ? 3.0 : 1.0;
  }
}

// =========================
// PAPER PORTFOLIO / ACCOUNTING
// =========================

class PaperPortfolio {
  constructor(config) {
    this.config = config;
    this.resetInMemoryState('constructor_boot');
  }

  resolvedStateFilePath() {
    return path.resolve(process.cwd(), String(this.config.stateFile || 'moneymaker_v3_state.json'));
  }

  pendingBurnInResetStateFilePath() {
    return `${this.resolvedStateFilePath()}.burnin-reset-pending.json`;
  }

  stateBackupDirPath() {
    return path.join(path.dirname(this.resolvedStateFilePath()), 'state_backups');
  }

  recommendedFreshBurnInStateFile(explicitProfileUsd = null) {
    return deriveBurnInStateBasename(this.config, explicitProfileUsd);
  }

  createBurnInState(reason = 'fresh_state', now = Date.now()) {
    return {
      label: burnInStateLabel(this.config),
      intendedProfileUsd: Number(this.config.initialCash || 0),
      stateFile: path.basename(String(this.config.stateFile || '')),
      recommendedFreshStateFile: this.recommendedFreshBurnInStateFile(),
      lifecycleStatus: 'clean_burnin_running',
      lifecycleReason: reason,
      createdAt: new Date(now).toISOString(),
      lastResetAt: new Date(now).toISOString(),
      resetModeApplied: this.config.paperBurnInResetMode === true,
      failedAt: null,
      failedReason: null,
      failedDrawdownPct: null,
      failedClosedPnl: null,
      freshStateRequired: false,
    };
  }

  resetInMemoryState(reason = 'manual_reset', now = Date.now()) {
    this.cash = this.config.initialCash;
    this.startingCash = this.config.initialCash;
    this.peakEquity = this.config.initialCash;
    this.positions = new Map();
    this.costBasis = new Map();
    this.positionMarkets = new Map();
    this.latestMarks = new Map();
    this.openOrders = new Map();
    this.closedPnl = 0;
    this.strategyPnl = new Map();
    this.fills = [];
    this.deadExposureCashReserveOutstandingUsd = 0;
    this.deadExposureCashReserveCreditsUsd = 0;
    this.deadExposureCashReserveRepaymentsUsd = 0;
    this.ghostOrders = [];
    this.ghostStats = { total: 0, favorable: 0, unfavorable: 0 };
    this.executionEvents = [];
    this.executionTotals = {
      paperOrdersPlaced: 0,
      paperOrderReplacements: 0,
      paperDuplicateSkips: 0,
      paperFills: 0,
    };
    this.burnInState = this.createBurnInState(reason, now);
    this.paperTokenTradeability = new Map();
    this.lastStateSaveSkipLog = { key: '', ts: 0 };
  }

  markBurnInFailedByDrawdown({
    reason = 'drawdown_limit',
    drawdownPct = this.getDrawdownPct(),
    closedPnl = this.closedPnl,
    now = Date.now(),
  } = {}) {
    const current = this.burnInState || this.createBurnInState('restored_state', now);
    if (current.lifecycleStatus === 'burn_in_failed_by_drawdown') return current;
    this.burnInState = {
      ...current,
      lifecycleStatus: 'burn_in_failed_by_drawdown',
      lifecycleReason: reason,
      failedAt: new Date(now).toISOString(),
      failedReason: reason,
      failedDrawdownPct: Number.isFinite(Number(drawdownPct)) ? Number(drawdownPct) : null,
      failedClosedPnl: Number.isFinite(Number(closedPnl)) ? Number(closedPnl) : null,
      freshStateRequired: true,
      recommendedFreshStateFile: current.recommendedFreshStateFile || this.recommendedFreshBurnInStateFile(),
    };
    return this.burnInState;
  }

  buildPersistedState() {
    return {
      cash: this.cash,
      startingCash: this.startingCash,
      peakEquity: this.peakEquity,
      deadExposureCashReserveOutstandingUsd: this.deadExposureCashReserveOutstanding(),
      deadExposureCashReserveCreditsUsd: Number(this.deadExposureCashReserveCreditsUsd || 0),
      deadExposureCashReserveRepaymentsUsd: Number(this.deadExposureCashReserveRepaymentsUsd || 0),
      positions: Object.fromEntries(this.positions),
      positionMarkets: Object.fromEntries(this.positionMarkets),
      costBasis: Object.fromEntries(this.costBasis),
      latestMarks: Object.fromEntries(this.latestMarks),
      closedPnl: this.closedPnl,
      strategyPnl: Object.fromEntries(this.strategyPnl),
      ghostStats: this.ghostStats,
      fills: this.fills.slice(-500),
      executionTotals: this.executionTotals,
      executionEvents: this.executionEvents.slice(-1000),
      burnInState: this.burnInState || this.createBurnInState('state_save'),
    };
  }

  writeJsonFileAtomic(filePath, data) {
    const resolved = path.resolve(process.cwd(), String(filePath || ''));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tempPath = path.join(
      path.dirname(resolved),
      `.${path.basename(resolved)}.tmp-${process.pid}-${Date.now()}`
    );
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, resolved);
    return resolved;
  }

  readJsonFileSafe(filePath) {
    const resolved = path.resolve(process.cwd(), String(filePath || ''));
    if (!resolved || !fs.existsSync(resolved)) return null;
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      warn(`State read failed for ${resolved}: ${e.message}`);
      return null;
    }
  }

  burnInResetEpochMs(state = null) {
    const burnInState = state && typeof state === 'object' ? state.burnInState : this.burnInState;
    const parsed = Date.parse(String(burnInState?.lastResetAt || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  persistedStateSummary(data = null) {
    const source = data && typeof data === 'object' ? data : this.buildPersistedState();
    const positions = source.positions && typeof source.positions === 'object' ? source.positions : {};
    const costBasis = source.costBasis && typeof source.costBasis === 'object' ? source.costBasis : {};
    const latestMarks = source.latestMarks && typeof source.latestMarks === 'object' ? source.latestMarks : {};
    const openOrders = source.openOrders && typeof source.openOrders === 'object' ? source.openOrders : {};
    let positionKeys = 0;
    let totalExposureUsd = 0;
    for (const [tokenId, rawQty] of Object.entries(positions)) {
      const qty = Number(rawQty);
      if (!(qty > 0)) continue;
      positionKeys += 1;
      const mark = Number(latestMarks[tokenId]);
      const cost = Number(costBasis[tokenId]);
      const px = Number.isFinite(mark) && mark > 0
        ? mark
        : (Number.isFinite(cost) && cost > 0 ? cost : 0);
      totalExposureUsd += qty * px;
    }
    return {
      positionKeys,
      totalExposureUsd: Number(totalExposureUsd.toFixed(6)),
      openOrdersCount: Object.keys(openOrders).length,
      activePaperOrdersCount: Object.keys(openOrders).length,
      fillsCount: Array.isArray(source.fills) ? source.fills.length : 0,
      executionEventsCount: Array.isArray(source.executionEvents) ? source.executionEvents.length : 0,
      latestMarksCount: Object.keys(latestMarks).length,
      positionMarketsCount: source.positionMarkets && typeof source.positionMarkets === 'object'
        ? Object.keys(source.positionMarkets).length
        : 0,
      cash: Number(source.cash || 0),
      startingCash: Number(source.startingCash || 0),
      lifecycleStatus: String(source.burnInState?.lifecycleStatus || ''),
      lastResetAt: String(source.burnInState?.lastResetAt || ''),
    };
  }

  backupExistingStateFile(reason = 'burnin_reset', now = Date.now()) {
    const stateFile = this.resolvedStateFilePath();
    if (!fs.existsSync(stateFile)) return null;
    const stat = fs.statSync(stateFile);
    if (!(stat.size > 0)) return null;
    const backupDir = this.stateBackupDirPath();
    fs.mkdirSync(backupDir, { recursive: true });
    const ext = path.extname(stateFile) || '.json';
    const base = path.basename(stateFile, ext);
    const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `${base}.${reason}.${timestamp}${ext}`);
    fs.copyFileSync(stateFile, backupPath);
    return backupPath;
  }

  readPersistedStateFile() {
    return this.readJsonFileSafe(this.resolvedStateFilePath());
  }

  readPendingBurnInResetStateFile() {
    const filePath = this.pendingBurnInResetStateFilePath();
    const data = this.readJsonFileSafe(filePath);
    if (!data) return null;
    return { filePath, data };
  }

  clearPendingBurnInResetStateFile() {
    const filePath = this.pendingBurnInResetStateFilePath();
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  shouldSkipStateSaveForNewerReset(nextData = null) {
    const currentState = this.readPersistedStateFile();
    if (!currentState) return { skip: false };
    const currentResetMs = this.burnInResetEpochMs(currentState);
    const nextResetMs = this.burnInResetEpochMs(nextData);
    if (!(currentResetMs > 0) || !(nextResetMs > 0) || currentResetMs <= nextResetMs) {
      return { skip: false };
    }
    return {
      skip: true,
      currentResetMs,
      nextResetMs,
      currentSummary: this.persistedStateSummary(currentState),
      nextSummary: this.persistedStateSummary(nextData),
    };
  }

  writeFreshBurnInStateFile(reason = 'paper_burnin_reset_mode') {
    const now = Date.now();
    const backupPath = this.backupExistingStateFile('before_burnin_reset', now);
    this.resetInMemoryState(reason, now);
    const data = this.buildPersistedState();
    this.writeJsonFileAtomic(this.resolvedStateFilePath(), data);
    this.writeJsonFileAtomic(this.pendingBurnInResetStateFilePath(), data);
    return {
      stateFile: this.config.stateFile,
      backupPath,
      pendingResetStateFile: this.pendingBurnInResetStateFilePath(),
      initialCash: Number(this.config.initialCash || 0),
      lifecycleStatus: data.burnInState.lifecycleStatus,
      recommendedFreshStateFile: data.burnInState.recommendedFreshStateFile,
      liveTradingEnabled: this.config.enableLiveTrading === true,
      liveKillSwitch: this.config.liveKillSwitch === true,
      liveDryRunOnly: this.config.liveDryRunOnly === true,
    };
  }

  fillTrustFlags(fill = {}) {
    const source = normalizePaperFillSource(fill?.fillSource);
    const trustedFill = paperFillTrusted(fill, this.config);
    const invalidSource = source === 'instant_sim' || source === 'forced_test_fill' || source === 'unknown';
    const staleBook = Number.isFinite(Number(fill?.bookAgeMs)) &&
      Number(fill.bookAgeMs) > Math.max(0, Number(this.config.paperFillMaxBookAgeMs || 0));
    const zeroSecondWithoutCross = isZeroSecondPaperFill(fill?.fillDelayMs) && source !== 'crossed_bid_ask';
    return {
      fillSource: source,
      trustedFill,
      fillInvalid: invalidSource || staleBook || zeroSecondWithoutCross || fill?.wasExecutableAtFill === false,
      fillInvalidReason: invalidSource
        ? `invalid_source:${source}`
        : fill?.wasExecutableAtFill === false
          ? 'non_executable_fill'
          : staleBook
            ? 'stale_book'
            : zeroSecondWithoutCross
              ? 'zero_second_without_cross'
              : null,
    };
  }

  fillsForToken(tokenId) {
    const key = String(tokenId || '');
    return this.fills
      .filter((fill) => String(fill?.tokenId || '') === key)
      .slice()
      .sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
  }

  reconstructLotsForToken(tokenId) {
    const relevantFills = this.fillsForToken(tokenId);
    const lots = [];
    for (const fill of relevantFills) {
      const qty = Number(fill?.size || 0);
      const price = Number(fill?.price || 0);
      if (!(qty > 0) || !(price > 0)) continue;
      if (String(fill?.side || '').toLowerCase() === 'buy') {
        const trust = this.fillTrustFlags(fill);
        lots.push({
          qty,
          price,
          ts: Number(fill?.ts || 0),
          trustedFill: trust.trustedFill,
          fillSource: trust.fillSource,
        });
        continue;
      }
      if (String(fill?.side || '').toLowerCase() !== 'sell') continue;
      let remainingQty = qty;
      while (remainingQty > 1e-9 && lots.length > 0) {
        const lot = lots[0];
        const matchedQty = Math.min(remainingQty, lot.qty);
        lot.qty -= matchedQty;
        remainingQty -= matchedQty;
        if (lot.qty <= 1e-9) lots.shift();
      }
    }
    return lots;
  }

  position(tokenId) {
    return this.positions.get(String(tokenId)) || 0;
  }

  avgCost(tokenId) {
    return this.costBasis.get(String(tokenId)) || 0;
  }

  positionCostDetails(tokenId) {
    const key = String(tokenId || '');
    const currentQty = this.position(key);
    const fallbackAvgEntryPrice = this.avgCost(key);
    if (!(currentQty > 0)) {
      return {
        tokenId: key,
        qty: 0,
        costUsd: 0,
        avgEntryPrice: 0,
        source: 'no_position',
      };
    }

    const lots = this.reconstructLotsForToken(key);

    const reconstructedQty = lots.reduce((sum, lot) => sum + Number(lot.qty || 0), 0);
    const reconstructedCostUsd = lots.reduce((sum, lot) => sum + (Number(lot.qty || 0) * Number(lot.price || 0)), 0);
    const qtyMatches = Math.abs(reconstructedQty - currentQty) <= Math.max(1e-6, currentQty * 1e-4);
    if (!qtyMatches || !(reconstructedQty > 0) || !(reconstructedCostUsd > 0)) {
      return {
        tokenId: key,
        qty: currentQty,
        costUsd: currentQty * fallbackAvgEntryPrice,
        avgEntryPrice: fallbackAvgEntryPrice,
        source: 'cost_basis_fallback',
        reconstructedQty,
      };
    }

    return {
      tokenId: key,
      qty: reconstructedQty,
      costUsd: reconstructedCostUsd,
      avgEntryPrice: reconstructedCostUsd / reconstructedQty,
      source: 'fills',
    };
  }

  positionUsd(tokenId, mark) {
    return this.position(tokenId) * (Number.isFinite(mark) ? mark : this.avgCost(tokenId));
  }

  setMarkPrice(tokenId, mark) {
    const key = String(tokenId || '');
    if (!key) return;
    if (Number.isFinite(Number(mark)) && Number(mark) > 0) {
      this.latestMarks.set(key, Number(mark));
      return;
    }
    this.latestMarks.delete(key);
  }

  setMarkPrices(markPrices = new Map()) {
    if (!markPrices || typeof markPrices.entries !== 'function') return;
    for (const [tokenId, mark] of markPrices.entries()) {
      this.setMarkPrice(tokenId, mark);
    }
  }

  markPricesSnapshot() {
    return new Map(this.latestMarks);
  }

  positionMarketId(tokenId) {
    const key = String(tokenId || '');
    if (!key) return '';
    const direct = String(this.positionMarkets.get(key) || '');
    if (direct) return direct;
    for (let i = this.fills.length - 1; i >= 0; i -= 1) {
      const fill = this.fills[i];
      if (String(fill?.tokenId || '') !== key) continue;
      const marketId = String(fill?.marketId || '');
      if (!marketId) continue;
      this.positionMarkets.set(key, marketId);
      return marketId;
    }
    return '';
  }

  resolveExposureContext(markSource = null) {
    if (markSource instanceof Map) {
      return {
        markMap: markSource,
        numericFallback: null,
      };
    }
    if (Number.isFinite(Number(markSource)) && Number(markSource) > 0) {
      return {
        markMap: null,
        numericFallback: Number(markSource),
      };
    }
    return {
      markMap: null,
      numericFallback: null,
    };
  }

  markPriceForExposure(tokenId, markSource = null) {
    const key = String(tokenId || '');
    const { markMap, numericFallback } = this.resolveExposureContext(markSource);
    const mapMark = markMap?.get(key);
    if (Number.isFinite(Number(mapMark)) && Number(mapMark) > 0) return Number(mapMark);
    const cachedMark = this.latestMarks.get(key);
    if (Number.isFinite(Number(cachedMark)) && Number(cachedMark) > 0) return Number(cachedMark);
    const avgCost = this.avgCost(key);
    if (Number.isFinite(Number(avgCost)) && Number(avgCost) > 0) return Number(avgCost);
    if (Number.isFinite(Number(numericFallback)) && Number(numericFallback) > 0) return Number(numericFallback);
    return 0;
  }

  positionExposureEntries(markSource = null) {
    return [...this.positions.entries()]
      .filter(([, qty]) => Number(qty) > 0)
      .map(([tokenId, qty]) => {
        const marketId = this.positionMarketId(tokenId);
        const mark = this.markPriceForExposure(tokenId, markSource);
        return {
          tokenId: String(tokenId),
          marketId,
          qty: Number(qty),
          mark,
          valueUsd: Number(qty) * mark,
        };
      });
  }

  positionExposureUsd(markSource = null) {
    return this.positionExposureEntries(markSource)
      .reduce((sum, entry) => sum + entry.valueUsd, 0);
  }

  exposureIncreasingOpenOrders(filterFn = null) {
    return [...this.openOrders.values()]
      .filter((order) => order.side === 'buy')
      .filter((order) => (typeof filterFn === 'function' ? filterFn(order) : true));
  }

  grossOpenOrderUsd() {
    let total = 0;
    for (const order of this.openOrders.values()) {
      total += order.remainingUsd();
    }
    return total;
  }

  marketExposureUsd(marketId, markSource = null) {
    const targetMarketId = String(marketId || '');
    const positionExposureUsd = this.positionExposureEntries(markSource)
      .filter((entry) => String(entry.marketId || '') === targetMarketId)
      .reduce((sum, entry) => sum + entry.valueUsd, 0);
    const openOrderExposureUsd = this.exposureIncreasingOpenOrders(
      (order) => String(order.marketId || '') === targetMarketId
    ).reduce((sum, order) => sum + order.remainingUsd(), 0);
    return positionExposureUsd + openOrderExposureUsd;
  }

  totalExposureUsd(markSource = null) {
    return this.positionExposureUsd(markSource) + this.openOrderExposureUsd();
  }

  portfolioExposureBreakdown(markSource = null) {
    const positionExposureUsd = this.positionExposureUsd(markSource);
    const openOrderExposureUsd = this.openOrderExposureUsd();
    return {
      positionExposureUsd,
      openOrderExposureUsd,
      totalExposureUsd: positionExposureUsd + openOrderExposureUsd,
    };
  }

  equity(markPrices = new Map()) {
    let value = this.cash;
    for (const [tokenId, qty] of this.positions.entries()) {
      if (qty <= 0) continue;
      const mark = markPrices.get(tokenId) ?? this.avgCost(tokenId) ?? 0;
      value += qty * mark;
    }
    value -= this.deadExposureCashReserveOutstanding();

    this.peakEquity = Math.max(this.peakEquity, value);
    return value;
  }

  drawdownPct(markPrices = new Map()) {
    const eq = this.equity(markPrices);
    if (this.peakEquity <= 0) return 0;
    return Math.max(0, ((this.peakEquity - eq) / this.peakEquity) * 100);
  }

  getDrawdownPct(markPrices = new Map()) {
    return this.drawdownPct(markPrices);
  }

  totalOpenOrderUsd() {
    return this.grossOpenOrderUsd();
  }

  openBuyOrderUsd() {
    let total = 0;
    for (const order of this.openOrders.values()) {
      if (order.side === 'buy') total += order.remainingUsd();
    }
    return total;
  }

  openSellQty(tokenId) {
    let total = 0;
    for (const order of this.openOrders.values()) {
      if (order.side !== 'sell') continue;
      if (String(order.tokenId) !== String(tokenId)) continue;
      if (!Number.isFinite(order.price) || order.price <= 0) continue;
      total += order.remainingUsd() / order.price;
    }
    return total;
  }

  availableCash() {
    return Math.max(0, this.cash - this.openBuyOrderUsd());
  }

  deadExposureCashReserveOutstanding() {
    return Math.max(0, Number(this.deadExposureCashReserveOutstandingUsd || 0));
  }

  deadExposureCashReserveState() {
    return {
      outstandingUsd: this.deadExposureCashReserveOutstanding(),
      creditsUsd: Math.max(0, Number(this.deadExposureCashReserveCreditsUsd || 0)),
      repaymentsUsd: Math.max(0, Number(this.deadExposureCashReserveRepaymentsUsd || 0)),
    };
  }

  applyDeadExposureCashReserve({ amountUsd = 0, ts = Date.now() } = {}) {
    const roundedAmountUsd = roundMoney(Number(amountUsd) || 0);
    if (!(roundedAmountUsd > 0)) return null;
    this.cash = roundMoney(this.cash + roundedAmountUsd);
    this.deadExposureCashReserveOutstandingUsd = roundMoney(this.deadExposureCashReserveOutstanding() + roundedAmountUsd);
    this.deadExposureCashReserveCreditsUsd = roundMoney(Number(this.deadExposureCashReserveCreditsUsd || 0) + roundedAmountUsd);
    return {
      ts,
      amountUsd: roundedAmountUsd,
      outstandingUsd: this.deadExposureCashReserveOutstanding(),
      cashUsd: roundMoney(this.cash),
    };
  }

  repayDeadExposureCashReserve({ amountUsd = 0, ts = Date.now() } = {}) {
    const roundedAmountUsd = roundMoney(Number(amountUsd) || 0);
    const outstandingUsd = this.deadExposureCashReserveOutstanding();
    if (!(roundedAmountUsd > 0) || !(outstandingUsd > 0)) return null;
    const repaymentUsd = roundMoney(Math.min(roundedAmountUsd, outstandingUsd, Math.max(0, this.cash)));
    if (!(repaymentUsd > 0)) return null;
    this.cash = roundMoney(this.cash - repaymentUsd);
    this.deadExposureCashReserveOutstandingUsd = roundMoney(outstandingUsd - repaymentUsd);
    this.deadExposureCashReserveRepaymentsUsd = roundMoney(Number(this.deadExposureCashReserveRepaymentsUsd || 0) + repaymentUsd);
    return {
      ts,
      amountUsd: repaymentUsd,
      outstandingUsd: this.deadExposureCashReserveOutstanding(),
      cashUsd: roundMoney(this.cash),
    };
  }

  availablePositionQty(tokenId) {
    return Math.max(0, this.position(tokenId) - this.openSellQty(tokenId));
  }

  findOpenOrdersBySignal(signal) {
    if (!signal) return [];
    return [...this.openOrders.entries()]
      .filter(([, order]) => (
        String(order.tokenId) === String(signal.tokenId) &&
        order.side === signal.side &&
        order.strategy === signal.strategy
      ))
      .map(([id, order]) => ({ id, order }))
      .sort((a, b) => a.order.createdAt - b.order.createdAt);
  }

  openOrderExposureUsd() {
    return this.exposureIncreasingOpenOrders()
      .reduce((sum, order) => sum + order.remainingUsd(), 0);
  }

  dustPositions(markSource = null) {
    return [...this.positions.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([tokenId, qty]) => {
        const mark = this.markPriceForExposure(tokenId, markSource);
        return { tokenId, qty, mark, value: qty * mark };
      })
      .filter((pos) => pos.value > 0 && pos.value < this.config.minOrderUsd);
  }

  dustSummary(markSource = null) {
    const positions = this.dustPositions(markSource);
    return {
      count: positions.length,
      valueUsd: positions.reduce((sum, pos) => sum + pos.value, 0),
    };
  }

  topPositions(markSource = null, limit = 10) {
    return [...this.positions.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([tokenId, qty]) => {
        const mark = this.markPriceForExposure(tokenId, markSource);
        return { tokenId, qty, mark, avg: this.avgCost(tokenId), value: qty * mark };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }

  topOpenOrders(limit = 10) {
    return [...this.openOrders.values()]
      .map((order) => ({
        tokenId: order.tokenId,
        side: order.side,
        strategy: order.strategy,
        price: order.price,
        remainingUsd: order.remainingUsd(),
        ageMs: Date.now() - order.createdAt,
      }))
      .sort((a, b) => b.remainingUsd - a.remainingUsd)
      .slice(0, limit);
  }

  strategyOpenOrderExposure() {
    const totals = new Map();
    for (const order of this.exposureIncreasingOpenOrders()) {
      const key = order.strategy || 'UNKNOWN';
      totals.set(key, (totals.get(key) || 0) + order.remainingUsd());
    }
    return [...totals.entries()]
      .map(([strategy, exposureUsd]) => ({ strategy, exposureUsd }))
      .sort((a, b) => b.exposureUsd - a.exposureUsd);
  }

  openOrderExposureByStrategy(strategyMatcher = () => true, { includeSellOrders = false } = {}) {
    const perToken = new Map();
    let totalUsd = 0;
    let maxExposureUsd = 0;
    const orders = includeSellOrders
      ? [...this.openOrders.values()]
      : this.exposureIncreasingOpenOrders();
    for (const order of orders) {
      if (!strategyMatcher(order.strategy)) continue;
      const remainingUsd = Number(order.remainingUsd() || 0);
      if (!(remainingUsd > 0)) continue;
      totalUsd += remainingUsd;
      maxExposureUsd = Math.max(maxExposureUsd, remainingUsd);
      const key = String(order.tokenId || '');
      const current = perToken.get(key) || {
        tokenId: key,
        marketId: String(order.marketId || ''),
        strategy: order.strategy || null,
        openOrderExposureUsd: 0,
      };
      current.openOrderExposureUsd += remainingUsd;
      perToken.set(key, current);
    }
    return {
      totalUsd,
      maxExposureUsd,
      perToken: [...perToken.values()].sort((a, b) => b.openOrderExposureUsd - a.openOrderExposureUsd),
    };
  }

  strategyLedger(strategyMatcher = () => true, markPrices = new Map(), now = Date.now()) {
    const relevantFills = this.fills
      .filter((fill) => strategyMatcher(fill.strategy))
      .slice()
      .sort((a, b) => a.ts - b.ts);
    const tokenState = new Map();
    let grossBuyUsd = 0;
    let grossSellUsd = 0;
    let grossBuyQty = 0;
    let grossSellQty = 0;
    let realizedPnl = 0;
    let trustedClosedPnl = 0;
    let untrustedClosedPnl = 0;
    let holdQty = 0;
    let holdWeightedSeconds = 0;
    let winCount = 0;
    let lossCount = 0;
    let breakevenCount = 0;
    let dustExitPnl = 0;
    const roundTrips = [];

    for (const fill of relevantFills) {
      const tokenId = String(fill.tokenId || '');
      if (!tokenState.has(tokenId)) {
        tokenState.set(tokenId, {
          tokenId,
          marketId: String(fill.marketId || this.positionMarkets?.get?.(tokenId) || ''),
          marketSlug: String(fill.marketSlug || ''),
          lots: [],
          grossBuyUsd: 0,
          grossSellUsd: 0,
          grossBuyQty: 0,
          grossSellQty: 0,
        });
      }
      const state = tokenState.get(tokenId);
      state.marketId = state.marketId || String(fill.marketId || this.positionMarkets?.get?.(tokenId) || '');
      state.marketSlug = state.marketSlug || String(fill.marketSlug || '');
      const qty = Number(fill.size || 0);
      const price = Number(fill.price || 0);
      const value = Number.isFinite(Number(fill.value)) ? Number(fill.value) : qty * price;
      if (!(qty > 0) || !(price > 0)) continue;

      if (fill.side === 'buy') {
        const fillTrust = this.fillTrustFlags(fill);
        grossBuyUsd += value;
        grossBuyQty += qty;
        state.grossBuyUsd += value;
        state.grossBuyQty += qty;
        state.lots.push({
          qty,
          price,
          ts: Number(fill.ts) || now,
          trustedFill: fillTrust.trustedFill,
          fillSource: fillTrust.fillSource,
        });
        continue;
      }

      if (fill.side !== 'sell') continue;

      grossSellUsd += value;
      grossSellQty += qty;
      state.grossSellUsd += value;
      state.grossSellQty += qty;

      let remainingQty = qty;
      let realizedForFill = 0;
      let matchedQtyTotal = 0;
      let matchedCostUsd = 0;
      let holdWeightedSecondsForFill = 0;
      let trustedMatchedQty = 0;
      let untrustedMatchedQty = 0;
      let trustedRealizedForFill = 0;
      let untrustedRealizedForFill = 0;
      const sellTrust = this.fillTrustFlags(fill);
      while (remainingQty > 1e-9 && state.lots.length > 0) {
        const lot = state.lots[0];
        const matchedQty = Math.min(remainingQty, lot.qty);
        const pnlContribution = (price - lot.price) * matchedQty;
        realizedForFill += pnlContribution;
        const holdSeconds = matchedQty * Math.max(0, ((Number(fill.ts) || now) - lot.ts) / 1000);
        holdWeightedSeconds += holdSeconds;
        holdWeightedSecondsForFill += holdSeconds;
        holdQty += matchedQty;
        matchedQtyTotal += matchedQty;
        matchedCostUsd += matchedQty * lot.price;
        if (sellTrust.trustedFill && lot.trustedFill) {
          trustedMatchedQty += matchedQty;
          trustedRealizedForFill += pnlContribution;
        } else {
          untrustedMatchedQty += matchedQty;
          untrustedRealizedForFill += pnlContribution;
        }
        lot.qty -= matchedQty;
        remainingQty -= matchedQty;
        if (lot.qty <= 1e-9) state.lots.shift();
      }
      realizedPnl += realizedForFill;
      trustedClosedPnl += trustedRealizedForFill;
      untrustedClosedPnl += untrustedRealizedForFill;
      if (matchedQtyTotal > 1e-9) {
        const averageEntryPrice = matchedCostUsd / matchedQtyTotal;
        const exitClassification = classifyGabagoolExit({
          filledUsd: value,
          avgEntryPrice: averageEntryPrice,
          sellPrice: price,
          realizedPnl: realizedForFill,
          positionQtyBefore: matchedQtyTotal,
          positionQtyAfter: 0,
          minOrderUsd: Number(this.config.minOrderUsd || 0),
        });
        const isDustExit = exitClassification === 'dust_exit';
        if (isDustExit) dustExitPnl += realizedForFill;
        roundTrips.push({
          tokenId: state.tokenId,
          marketId: state.marketId || '',
          marketSlug: state.marketSlug || '',
          exitTs: Number(fill.ts) || now,
          realizedPnl: realizedForFill,
          filledUsd: value,
          filledQty: matchedQtyTotal,
          entryPrice: averageEntryPrice,
          exitPrice: price,
          holdSeconds: holdWeightedSecondsForFill / matchedQtyTotal,
          classification: exitClassification,
          trustedPnl: sellTrust.trustedFill && untrustedMatchedQty <= 1e-9,
          trustedRealizedPnl: trustedRealizedForFill,
          untrustedRealizedPnl: untrustedRealizedForFill,
          fillSource: sellTrust.fillSource,
        });
      }
      if (realizedForFill > 1e-9) winCount += 1;
      else if (realizedForFill < -1e-9) lossCount += 1;
      else breakevenCount += 1;
    }

    const perTokenExposure = [];
    let currentPositionExposureUsd = 0;
    let unrealizedPnl = 0;
    let trustedOpenPnl = 0;
    let untrustedOpenPnl = 0;
    for (const state of tokenState.values()) {
      const qty = state.lots.reduce((sum, lot) => sum + lot.qty, 0);
      if (qty <= 1e-9) continue;
      const costUsd = state.lots.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
      const avgEntryPrice = qty > 0 ? costUsd / qty : 0;
      const mark = markPrices.get(state.tokenId) ?? avgEntryPrice;
      const positionExposureUsd = qty * mark;
      const tokenUnrealizedPnl = state.lots.reduce((sum, lot) => sum + ((mark - lot.price) * lot.qty), 0);
      const tokenTrustedUnrealizedPnl = state.lots.reduce((sum, lot) => (
        sum + (lot.trustedFill ? ((mark - lot.price) * lot.qty) : 0)
      ), 0);
      const tokenUntrustedUnrealizedPnl = tokenUnrealizedPnl - tokenTrustedUnrealizedPnl;
      currentPositionExposureUsd += positionExposureUsd;
      unrealizedPnl += tokenUnrealizedPnl;
      trustedOpenPnl += tokenTrustedUnrealizedPnl;
      untrustedOpenPnl += tokenUntrustedUnrealizedPnl;
      perTokenExposure.push({
        tokenId: state.tokenId,
        marketId: state.marketId || '',
        marketSlug: state.marketSlug || '',
        qty,
        avgEntryPrice,
        mark,
        positionExposureUsd,
        unrealizedPnl: tokenUnrealizedPnl,
        trustedUnrealizedPnl: tokenTrustedUnrealizedPnl,
        untrustedUnrealizedPnl: tokenUntrustedUnrealizedPnl,
      });
    }

    const openOrders = this.openOrderExposureByStrategy(strategyMatcher);
    const totalExposureUsd = currentPositionExposureUsd + openOrders.totalUsd;
    const feesEstimate = 0;
    const realizedPlusUnrealized = realizedPnl + unrealizedPnl;
    const relevantFillTrust = relevantFills.map((fill) => this.fillTrustFlags(fill));
    const trustedFillCount = relevantFillTrust.filter((fill) => fill.trustedFill).length;
    const untrustedFillCount = relevantFillTrust.length - trustedFillCount;
    const invalidFillCount = relevantFillTrust.filter((fill) => fill.fillInvalid).length;
    const fillCountsBySource = fillSourceCountsObject(relevantFills);
    return {
      fillsCount: relevantFills.length,
      trustedFillCount,
      untrustedFillCount,
      invalidFillCount,
      fillCountsBySource,
      grossBuyUsd,
      grossSellUsd,
      grossBuyQty,
      grossSellQty,
      averageEntryPrice: grossBuyQty > 0 ? grossBuyUsd / grossBuyQty : null,
      averageExitPrice: grossSellQty > 0 ? grossSellUsd / grossSellQty : null,
      averageHoldSeconds: holdQty > 0 ? holdWeightedSeconds / holdQty : null,
      realizedPnl,
      unrealizedPnl,
      closedPnl: realizedPnl,
      openPnl: unrealizedPnl,
      trustedClosedPnl,
      untrustedClosedPnl,
      trustedOpenPnl,
      untrustedOpenPnl,
      equityContribution: realizedPlusUnrealized,
      feesEstimate,
      netAfterFeesEstimate: realizedPlusUnrealized - feesEstimate,
      currentPositionExposureUsd,
      currentOpenOrderExposureUsd: openOrders.totalUsd,
      totalExposureUsd,
      maxOpenOrderExposureUsd: openOrders.maxExposureUsd,
      roundTrips,
      roundTripsCount: roundTrips.length,
      averageRoundTripPnl: roundTrips.length > 0
        ? roundTrips.reduce((sum, trip) => sum + Number(trip.realizedPnl || 0), 0) / roundTrips.length
        : null,
      dustExitPnl,
      perTokenExposure: perTokenExposure
        .map((item) => {
          const openOrder = openOrders.perToken.find((entry) => entry.tokenId === item.tokenId);
          return {
            ...item,
            openOrderExposureUsd: openOrder?.openOrderExposureUsd || 0,
            totalExposureUsd: item.positionExposureUsd + (openOrder?.openOrderExposureUsd || 0),
          };
        })
        .sort((a, b) => b.totalExposureUsd - a.totalExposureUsd),
      openOrderExposurePerToken: openOrders.perToken,
      winCount,
      lossCount,
      breakevenCount,
      winLossProxy: winCount + lossCount > 0 ? `${winCount}/${lossCount}` : '0/0',
    };
  }

  pnlBreakdownByStrategy(markPrices = new Map(), now = Date.now()) {
    const strategyNames = new Set();
    for (const fill of this.fills) {
      const strategy = resolveStrategyName(fill?.strategy) || String(fill?.strategy || '').trim();
      if (strategy) strategyNames.add(strategy);
    }
    for (const order of this.openOrders.values()) {
      const strategy = resolveStrategyName(order?.strategy) || String(order?.strategy || '').trim();
      if (strategy) strategyNames.add(strategy);
    }

    const pnlByStrategy = {};
    const trustedPnlByStrategy = {};
    const untrustedPnlByStrategy = {};
    for (const strategy of strategyNames) {
      const ledger = this.strategyLedger((value) => resolveStrategyName(value) === strategy, markPrices, now);
      pnlByStrategy[strategy] = {
        closedPnl: Number(ledger.closedPnl || 0),
        openPnl: Number(ledger.openPnl || 0),
        netPnl: Number(ledger.closedPnl || 0) + Number(ledger.openPnl || 0),
      };
      trustedPnlByStrategy[strategy] = {
        closedPnl: Number(ledger.trustedClosedPnl || 0),
        openPnl: Number(ledger.trustedOpenPnl || 0),
        netPnl: Number(ledger.trustedClosedPnl || 0) + Number(ledger.trustedOpenPnl || 0),
      };
      untrustedPnlByStrategy[strategy] = {
        closedPnl: Number(ledger.untrustedClosedPnl || 0),
        openPnl: Number(ledger.untrustedOpenPnl || 0),
        netPnl: Number(ledger.untrustedClosedPnl || 0) + Number(ledger.untrustedOpenPnl || 0),
      };
    }

    return {
      pnlByStrategy,
      trustedPnlByStrategy,
      untrustedPnlByStrategy,
    };
  }

  addOrder(order) {
    this.openOrders.set(order.id, order);
  }

  cancelOrder(orderId) {
    this.openOrders.delete(orderId);
  }

  recordExecutionEvent(type, details = {}, ts = Date.now()) {
    const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
    this.executionEvents.push({
      type,
      ts,
      tokenId: details.tokenId ? String(details.tokenId) : null,
      marketId: details.marketId ? String(details.marketId) : null,
      marketSlug: details.marketSlug ? String(details.marketSlug) : null,
      outcome: details.outcome ? String(details.outcome) : null,
      side: details.side ? String(details.side).toLowerCase() : null,
      strategy: details.strategy || null,
      reason: details.reason || null,
      source: details.source ? String(details.source) : null,
      exitMode: details.exitMode ? String(details.exitMode) : null,
      price: numeric(details.price),
      sizeUsd: numeric(details.sizeUsd ?? details.value),
      expectedEdge: numeric(details.expectedEdge),
      confidence: numeric(details.confidence),
      quality: numeric(details.quality ?? details.sophieExecutionQuality),
      distanceFromTouch: numeric(details.distanceFromTouch),
      predictedFillProbability: numeric(details.predictedFillProbability),
      timeToFillSec: numeric(details.timeToFillSec),
      fillDelayMs: numeric(details.fillDelayMs),
      bookAgeMs: numeric(details.bookAgeMs),
      filledUsd: numeric(details.filledUsd),
      fillSource: normalizePaperFillSource(details.fillSource),
      bestBidAtPlacement: numeric(details.bestBidAtPlacement),
      bestAskAtPlacement: numeric(details.bestAskAtPlacement),
      bestBidAtFill: numeric(details.bestBidAtFill),
      bestAskAtFill: numeric(details.bestAskAtFill),
      orderPrice: numeric(details.orderPrice),
      wasExecutableAtPlacement: details.wasExecutableAtPlacement === true ? true : details.wasExecutableAtPlacement === false ? false : null,
      wasExecutableAtFill: details.wasExecutableAtFill === true ? true : details.wasExecutableAtFill === false ? false : null,
      queueHaircutApplied: numeric(details.queueHaircutApplied),
      slippageApplied: numeric(details.slippageApplied),
      adverseSelectionBufferApplied: numeric(details.adverseSelectionBufferApplied),
      trustedFill: details.trustedFill === true ? true : details.trustedFill === false ? false : null,
      trustedPnl: details.trustedPnl === true ? true : details.trustedPnl === false ? false : null,
      fillInvalid: details.fillInvalid === true ? true : details.fillInvalid === false ? false : null,
      fillInvalidReason: details.fillInvalidReason ? String(details.fillInvalidReason) : null,
      avgEntryPrice: numeric(details.avgEntryPrice),
      realizedPnl: numeric(details.realizedPnl),
      trustedRealizedPnl: numeric(details.trustedRealizedPnl),
      untrustedRealizedPnl: numeric(details.untrustedRealizedPnl),
      drawdownGateActive: details.drawdownGateActive === true ? true : details.drawdownGateActive === false ? false : null,
      paperProbationActive: details.paperProbationActive === true ? true : details.paperProbationActive === false ? false : null,
      probationAdmission: details.probationAdmission ? String(details.probationAdmission) : null,
      paperProbationTrigger: details.paperProbationTrigger ? String(details.paperProbationTrigger) : null,
      sophieDecision: details.sophieDecision ? String(details.sophieDecision) : null,
      finalBlockerAfterProbation: details.finalBlockerAfterProbation ? String(details.finalBlockerAfterProbation) : null,
      positionQtyBefore: numeric(details.positionQtyBefore),
      positionQtyAfter: numeric(details.positionQtyAfter),
      positionQty: numeric(details.positionQty),
      availableSellQty: numeric(details.availableSellQty),
      currentValueUsd: numeric(details.currentValueUsd),
      roundedExitSizeUsd: numeric(details.roundedExitSizeUsd),
      positionsScanned: numeric(details.positionsScanned),
      positionsClosable: numeric(details.positionsClosable),
      exitsAttempted: numeric(details.exitsAttempted),
      exitsPlaced: numeric(details.exitsPlaced),
      exitBlockedReason: details.exitBlockedReason ? String(details.exitBlockedReason) : null,
    });
    while (this.executionEvents.length > 5000) this.executionEvents.shift();

    if (type === 'order_placed') this.executionTotals.paperOrdersPlaced += 1;
    if (type === 'order_replacement') this.executionTotals.paperOrderReplacements += 1;
    if (type === 'duplicate_skip') this.executionTotals.paperDuplicateSkips += 1;
    if (type === 'fill') this.executionTotals.paperFills += 1;
  }

  executionHealth(now = Date.now()) {
    const hourAgo = now - 60 * 60_000;
    const actionWindowMs = Math.max(60_000, Number(this.config.paperActionBurnInWindowMs || 15 * 60_000));
    const actionWindowAgo = now - actionWindowMs;
    const recent = this.executionEvents.filter((event) => Number(event.ts) >= hourAgo);
    const recentActionWindow = this.executionEvents.filter((event) => Number(event.ts) >= actionWindowAgo);
    const countType = (type) => recent.filter((event) => event.type === type).length;
    const countGabagoolType = (type) => recent.filter((event) => event.type === type && isBtcOracleStrategy(event.strategy)).length;
    const gabagoolEvents = this.executionEvents.filter((event) => isBtcOracleStrategy(event.strategy));
    const latestGabagoolReason = (type) => {
      for (let i = gabagoolEvents.length - 1; i >= 0; i -= 1) {
        if (gabagoolEvents[i].type === type) return gabagoolEvents[i].reason || null;
      }
      return null;
    };
    const latestGabagoolField = (type, field) => {
      for (let i = gabagoolEvents.length - 1; i >= 0; i -= 1) {
        if (gabagoolEvents[i].type === type && gabagoolEvents[i][field] != null) return gabagoolEvents[i][field];
      }
      return null;
    };
    const latestGabagoolTs = (type) => {
      for (let i = gabagoolEvents.length - 1; i >= 0; i -= 1) {
        if (gabagoolEvents[i].type === type) return gabagoolEvents[i].ts || null;
      }
      return null;
    };
    const countGabagoolReason = (type, reason) => recent.filter((event) => (
      event.type === type &&
      isBtcOracleStrategy(event.strategy) &&
      event.reason === reason
    )).length;
    const openOrders = [...this.openOrders.values()];
    const agesSec = openOrders.map((order) => Math.max(0, (now - order.createdAt) / 1000));
    const exposureBreakdown = new RiskEngine(this.config, this).exposureBreakdown();
    const candidateEvaluationsLastHour = countType('candidate_evaluation');
    const paperOrdersPlacedLastHour = countType('order_placed');
    const paperOrdersFilledLastHour = countType('fill');
    const paperOrdersExpiredNoFillLastHour = countType('order_expired_no_fill') + countType('order_replaced_no_fill');
    const paperOrdersAdmittedLastHour = countType('order_admitted');
    const paperOrdersRejectedBySophieLastHour = countType('quality_block') + countType('quality_throttle');
    const fillsLastHour = countType('fill');
    const paperOrdersPlacedLast15m = recentActionWindow.filter((event) => event.type === 'order_placed').length;
    const paperOrdersFilledLast15m = recentActionWindow.filter((event) => event.type === 'fill').length;
    const duplicateSkipsLastHour = countType('duplicate_skip');
    const replacementsLastHour = countType('order_replacement');
    const maxOpenOrderBlocksLastHour = countType('max_open_orders_block');
    const oldestOpenOrderAgeSec = agesSec.length ? Math.max(...agesSec) : 0;
    const avgOpenOrderAgeSec = agesSec.length
      ? agesSec.reduce((sum, age) => sum + age, 0) / agesSec.length
      : 0;
    const noFillStreaks = this.noFillStreaks(now);
    const noFillStreakMax = noFillStreaks.length ? Math.max(...noFillStreaks.map((item) => item.noFillStreak)) : 0;
    const fillEvents = recent.filter((event) => event.type === 'fill');
    const fillEventsWithTime = fillEvents.filter((event) => Number.isFinite(event.timeToFillSec));
    const avgTimeToFillSec = fillEventsWithTime.length
      ? fillEventsWithTime.reduce((sum, event) => sum + event.timeToFillSec, 0) / fillEventsWithTime.length
      : null;
    const fillEventsWithDelay = fillEvents.filter((event) => Number.isFinite(event.fillDelayMs));
    const avgFillDelayMs = fillEventsWithDelay.length
      ? fillEventsWithDelay.reduce((sum, event) => sum + Number(event.fillDelayMs || 0), 0) / fillEventsWithDelay.length
      : null;
    const zeroSecondFillCountLastHour = fillEvents.filter((event) => isZeroSecondPaperFill(event.fillDelayMs)).length;
    const fillCountsBySourceLastHour = fillSourceCountsObject(fillEvents);
    const invalidOrUntrustedFillCountLastHour = fillEvents.filter((event) => (
      event.fillInvalid === true || event.trustedFill === false
    )).length;
    const trustedFillCountLastHour = fillEvents.filter((event) => event.trustedFill === true).length;
    const untrustedFillCountLastHour = fillEvents.filter((event) => event.trustedFill === false).length;
    const orderRealismBlocksLastHour = countType('order_realism_block');
    const strategyOrderCountsLastHour = {};
    for (const event of recent) {
      if (event.type !== 'order_placed') continue;
      const strategy = resolveStrategyName(event.strategy) || event.strategy || 'UNKNOWN';
      strategyOrderCountsLastHour[strategy] = Number(strategyOrderCountsLastHour[strategy] || 0) + 1;
    }
    const strategyFillCountsLastHour = {};
    for (const event of fillEvents) {
      const strategy = resolveStrategyName(event.strategy) || event.strategy || 'UNKNOWN';
      strategyFillCountsLastHour[strategy] = Number(strategyFillCountsLastHour[strategy] || 0) + 1;
    }
    const gabagoolRepeatedSameMarketSameTokenEntriesLastHour = [...recent
      .filter((event) => event.type === 'order_placed' && isBtcOracleStrategy(event.strategy) && String(event.side || '').toLowerCase() === 'buy')
      .reduce((map, event) => {
        const key = `${String(event.marketId || event.marketSlug || '')}:${String(event.tokenId || '')}`;
        map.set(key, Number(map.get(key) || 0) + 1);
        return map;
      }, new Map()).values()]
      .reduce((sum, count) => sum + Math.max(0, Number(count || 0) - 1), 0);
    const oracleSignalsReadLastHour = countGabagoolType('gabagool_oracle_signal_read');
    const oracleSignalsFreshLastHour = countGabagoolType('gabagool_oracle_signal_fresh');
    const oracleSignalsExpiredLastHour = countGabagoolType('gabagool_oracle_signal_expired');
    const oracleSignalsNotConfirmedLastHour = countGabagoolType('gabagool_oracle_signal_not_confirmed');
    const oracleSignalsConfirmedLastHour = countGabagoolType('gabagool_oracle_signal_confirmed');
    const duplicateOracleSignalsSkippedLastHour = countGabagoolType('gabagool_duplicate_oracle_signal');
    const gabagoolCandidatesBuiltLastHour = countGabagoolType('gabagool_candidate_built');
    const gabagoolSophieEvaluatedLastHour = countGabagoolType('gabagool_sophie_evaluated');
    const gabagoolSophieAdmittedLastHour = countGabagoolType('gabagool_sophie_admitted');
    const gabagoolSophieBlockedLastHour = countGabagoolType('gabagool_sophie_blocked');
    const gabagoolRiskEvaluatedLastHour = countGabagoolType('gabagool_risk_evaluated');
    const gabagoolRiskAdmittedLastHour = countGabagoolType('gabagool_risk_admitted');
    const gabagoolRiskBlockedLastHour = countGabagoolType('gabagool_risk_blocked');
    const gabagoolPlacementAttemptedLastHour = countGabagoolType('gabagool_placement_attempted');
    const gabagoolPlacementBlockedLastHour = countGabagoolType('gabagool_placement_blocked');
    const gabagoolOrdersPlacedLastHour = countGabagoolType('gabagool_order_placed');
    const gabagoolFillsLastHour = countGabagoolType('gabagool_fill');
    const gabagoolExitsLastHour = countGabagoolType('gabagool_exit');
    const gabagoolTelegramSuppressedLastHour = countGabagoolType('gabagool_telegram_suppressed');
    const gabagoolZeroSizeBlockedLastHour = countGabagoolType('gabagool_zero_size_blocked');
    const gabagoolDustExitsLastHour = countGabagoolReason('gabagool_exit', 'dust_exit');
    const gabagoolDustExitsSuppressedLastHour = countGabagoolType('gabagool_dust_exit_suppressed');
    const gabagoolDustExitAllowedLastHour = countGabagoolType('gabagool_dust_exit_allowed');
    const gabagoolDustPositionRemainingLastHour = countGabagoolType('gabagool_dust_position_remaining');
    const gabagoolProfitExitsLastHour = countGabagoolReason('gabagool_exit', 'profit_exit');
    const gabagoolLossExitsLastHour = countGabagoolReason('gabagool_exit', 'loss_exit');
    const gabagoolLossExitBlocksLastHour = countGabagoolType('gabagool_blocked_loss_exit');
    const gabagoolInventoryReducesLastHour = countGabagoolReason('gabagool_exit', 'inventory_reduce');
    const gabagoolInvalidZeroSizeLastHour = gabagoolZeroSizeBlockedLastHour;
    const gabagoolEntryPauseBlocksLastHour = countGabagoolType('gabagool_entry_paused');
    const gabagoolChurnBlocksLastHour = countGabagoolType('gabagool_churn_blocked');
    const gabagoolSameMarketDirectionBlocksLastHour = countGabagoolType('gabagool_same_market_direction_blocked');
    const gabagoolStaleDustIgnoredLastHour = countGabagoolType('gabagool_stale_dust_ignored');
    const gabagoolSameMarketUnknownDirectionIgnoredLastHour = countGabagoolType('gabagool_same_market_unknown_direction_ignored');
    const gabagoolReentryBlocksLastHour = countGabagoolType('gabagool_reentry_blocked');
    const gabagoolHighPriceEntryBlocksLastHour = countGabagoolType('gabagool_high_price_entry_blocked');
    const gabagoolLossGuardExitScanLastHour = countGabagoolType('gabagool_loss_guard_exit_scan');
    const gabagoolLossGuardExitCandidatesLastHour = countGabagoolType('gabagool_loss_guard_exit_candidate');
    const gabagoolLossGuardExitsAttemptedLastHour = countGabagoolType('gabagool_loss_guard_exit_attempted');
    const gabagoolLossGuardExitsPlacedLastHour = countGabagoolType('gabagool_loss_guard_exit_placed');
    const gabagoolLossGuardExitsFilledLastHour = countGabagoolType('gabagool_loss_guard_exit_filled');
    const gabagoolLossGuardDustRemainingLastHour = countGabagoolType('gabagool_loss_guard_dust_remaining');
    const gabagoolReduceOnlyExitScanLastHour = countGabagoolType('gabagool_reduce_only_exit_scan');
    const gabagoolReduceOnlyExitCandidatesLastHour = countGabagoolType('gabagool_reduce_only_exit_candidate');
    const gabagoolReduceOnlyExitAttemptsLastHour = countGabagoolType('gabagool_reduce_only_exit_attempted');
    const gabagoolReduceOnlyExitOrdersLastHour = countGabagoolType('gabagool_reduce_only_exit_placed');
    const gabagoolReduceOnlyExitFillsLastHour = countGabagoolType('gabagool_reduce_only_exit_filled');
    const gabagoolRepeatedBlockedLossExitCountLastHour = countGabagoolType('gabagool_blocked_loss_exit_repeat');
    const gabagoolExposureCapBlockedReasonCounts = new Map();
    for (const event of recent) {
      if (
        event.type === 'gabagool_reduce_only_exit_blocked' &&
        isBtcOracleStrategy(event.strategy) &&
        event.reason
      ) {
        gabagoolExposureCapBlockedReasonCounts.set(
          event.reason,
          Number(gabagoolExposureCapBlockedReasonCounts.get(event.reason) || 0) + 1
        );
      }
      if (
        (event.type === 'gabagool_risk_blocked' || event.type === 'gabagool_sophie_blocked' || event.type === 'gabagool_placement_blocked') &&
        isBtcOracleStrategy(event.strategy) &&
        String(event.exitMode || '') === 'exposure_cap_reduce_only'
      ) {
        gabagoolExposureCapBlockedReasonCounts.set(
          'valid_but_risk_or_execution_blocked',
          Number(gabagoolExposureCapBlockedReasonCounts.get('valid_but_risk_or_execution_blocked') || 0) + 1
        );
      }
    }
    const spreadHunterGhostBlocksLastHour = recent.filter((event) => (
      resolveStrategyName(event.strategy) === 'SpreadHunter' && event.reason === 'ghost_throttle'
    )).length;
    const spreadHunterSophieBlocksLastHour = recent.filter((event) => (
      resolveStrategyName(event.strategy) === 'SpreadHunter' && event.type === 'quality_block'
    )).length;
    const spreadHunterConfidenceBlocksLastHour = recent.filter((event) => (
      resolveStrategyName(event.strategy) === 'SpreadHunter' &&
      event.type === 'risk_block' &&
      event.reason === 'confidence_below_min'
    )).length;
    const spreadHunterCooldownBlocksLastHour = recent.filter((event) => (
      resolveStrategyName(event.strategy) === 'SpreadHunter' &&
      (
        event.type === 'quality_throttle' ||
        event.type === 'standard_churn_block'
      )
    )).length;
    const spreadHunterExecutionRealismBlocksLastHour = recent.filter((event) => (
      resolveStrategyName(event.strategy) === 'SpreadHunter' && event.type === 'order_realism_block'
    )).length;
    const probationAdmissionsLastHour = countType('paper_probation_admit');
    const probationBlocksLastHour = countType('paper_probation_block');
    const probationAdmissionsBeforeRisk = probationAdmissionsLastHour;
    const probationOrdersBlockedByDrawdown = recent.filter((event) => (
      event.type === 'risk_block' &&
      event.reason === 'drawdown_limit' &&
      event.paperProbationActive === true
    )).length;
    const sophieAdmittedRiskBlocksLastHour = recent.filter((event) => (
      event.type === 'risk_block' &&
      ['ADMIT', 'PAPER_PROBATION_ADMIT', 'CALIBRATED_ADMIT', 'OPTIMIZED_MAKER_ADMIT'].includes(String(event.sophieDecision || ''))
    ));
    const sophieAdmittedButRiskBlockedLastHour = sophieAdmittedRiskBlocksLastHour.length;
    const sophieAdmittedButRiskBlockedByDrawdownLastHour = sophieAdmittedRiskBlocksLastHour
      .filter((event) => event.reason === 'drawdown_limit')
      .length;
    const finalProbationBlockers = new Map();
    for (const event of recent) {
      if (event.type !== 'risk_block' && event.type !== 'placement_block') continue;
      if (event.paperProbationActive !== true) continue;
      const key = String(event.reason || 'unknown_final_blocker');
      finalProbationBlockers.set(key, Number(finalProbationBlockers.get(key) || 0) + 1);
    }
    const finalBlockerAfterProbation = [...finalProbationBlockers.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })[0]?.[0] || 'none';
    const drawdownGateActive = this.getDrawdownPct() > this.config.maxDrawdownPct;
    const topBlockReasons = new Map();
    for (const event of recent) {
      let key = null;
      if (event.type === 'strategy_skip' && event.reason) key = `strategy:${event.reason}`;
      if (event.type === 'quality_block') key = `sophie:${event.reason || 'quality_block'}`;
      if (event.type === 'quality_throttle') key = `throttle:${event.reason || 'quality_throttle'}`;
      if (event.type === 'risk_block') key = `risk:${event.reason || 'risk_block'}`;
      if (event.type === 'standard_churn_block') key = `churn:${event.reason || 'standard_churn_block'}`;
      if (event.type === 'order_realism_block') key = `realism:${event.reason || 'order_realism_block'}`;
      if (event.type === 'paper_probation_block') key = `probation:${event.reason || 'paper_probation_block'}`;
      if (!key) continue;
      topBlockReasons.set(key, Number(topBlockReasons.get(key) || 0) + 1);
    }
    const topBlockReasonsLastHour = [...topBlockReasons.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 5)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(',') || 'none';
    const whyTotalOrdersZeroLastHour = paperOrdersPlacedLastHour === 0
      ? [
        openOrders.length > 0 ? `openOrders=${openOrders.length}` : null,
        paperOrdersAdmittedLastHour > 0 ? `admitted=${paperOrdersAdmittedLastHour}` : null,
        paperOrdersRejectedBySophieLastHour > 0 ? `sophieRejected=${paperOrdersRejectedBySophieLastHour}` : null,
        sophieAdmittedButRiskBlockedLastHour > 0 ? `sophieAdmittedButRiskBlocked=${sophieAdmittedButRiskBlockedLastHour}` : null,
        probationOrdersBlockedByDrawdown > 0 ? `probationBlockedByDrawdown=${probationOrdersBlockedByDrawdown}` : null,
        finalBlockerAfterProbation !== 'none' ? `finalBlockerAfterProbation=${finalBlockerAfterProbation}` : null,
        spreadHunterGhostBlocksLastHour > 0 ? `ghost=${spreadHunterGhostBlocksLastHour}` : null,
        spreadHunterConfidenceBlocksLastHour > 0 ? `confidence=${spreadHunterConfidenceBlocksLastHour}` : null,
        probationBlocksLastHour > 0 ? `probationBlocked=${probationBlocksLastHour}` : null,
        topBlockReasonsLastHour !== 'none' ? `topBlocks=${topBlockReasonsLastHour}` : null,
      ].filter(Boolean).join(' ') || 'no_orders_recorded'
      : null;
    const actionRateTopBlocks = new Map();
    for (const event of recentActionWindow) {
      let key = null;
      if (event.reason === 'ghost_throttle') key = 'ghost_throttle';
      else if (event.type === 'risk_block' && event.reason === 'confidence_below_min') key = 'confidence_below_min';
      else if (event.type === 'quality_block') key = `quality_block:${event.reason || 'unknown'}`;
      else if (event.type === 'quality_throttle') key = `quality_throttle:${event.reason || 'unknown'}`;
      if (!key) continue;
      actionRateTopBlocks.set(key, Number(actionRateTopBlocks.get(key) || 0) + 1);
    }
    const dominantActionRateBlock = [...actionRateTopBlocks.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })[0] || null;
    const targetOrdersPer15m = Math.max(0, Number(this.config.paperActionBurnInTargetOrdersPer15m || 0));
    const targetFillsPer15m = Math.max(0, Number(this.config.paperActionBurnInTargetFillsPer15m || 0));
    const paperActionBurnInActive = (
      this.config.enableLiveTrading !== true &&
      this.config.paperActionBurnInEnabled === true &&
      Math.max(
        0,
        Number(this.startingCash || 0),
        Number(this.config.initialCash || 0),
        Number(this.equity() || 0)
      ) <= Math.max(0, Number(this.config.paperActionBurnInMaxBankrollUsd || 0))
    );
    const actionRateBelowTarget = (
      paperActionBurnInActive &&
      (
        (targetOrdersPer15m > 0 && paperOrdersPlacedLast15m < targetOrdersPer15m) ||
        (targetFillsPer15m > 0 && paperOrdersFilledLast15m < targetFillsPer15m)
      )
    );
    const actionRateStatus = paperActionBurnInActive
      ? (actionRateBelowTarget ? 'action_rate_below_target' : 'action_rate_on_target')
      : 'action_rate_not_applicable';
    const finalRiskGateBlockedAfterAdmission = (
      actionRateBelowTarget &&
      paperOrdersPlacedLast15m === 0 &&
      sophieAdmittedButRiskBlockedByDrawdownLastHour > 0
    );
    const actionRateReason = actionRateBelowTarget
      ? [
        'action_rate_below_target',
        `orders15m=${paperOrdersPlacedLast15m}/${targetOrdersPer15m}`,
        `fills15m=${paperOrdersFilledLast15m}/${targetFillsPer15m}`,
        finalRiskGateBlockedAfterAdmission
          ? 'sophie_admitted_but_final_risk_gate_blocked'
          : null,
        finalRiskGateBlockedAfterAdmission ? 'finalBlocker=drawdown_limit' : null,
        finalRiskGateBlockedAfterAdmission
          ? `probationAdmissionsBeforeRisk=${probationAdmissionsBeforeRisk}`
          : null,
        finalRiskGateBlockedAfterAdmission
          ? `probationOrdersBlockedByDrawdown=${probationOrdersBlockedByDrawdown}`
          : null,
        !finalRiskGateBlockedAfterAdmission && dominantActionRateBlock
          ? `dominantBlock=${dominantActionRateBlock[0]}:${dominantActionRateBlock[1]}`
          : null,
      ].filter(Boolean).join(' ')
      : actionRateStatus;
    const burnInLifecycle = this.burnInLifecycleState(now);
    const lastFillEvent = fillEvents.slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0] || null;
    const deadExposureCashReserve = this.deadExposureCashReserveState();

    return {
      ...this.executionTotals,
      activePaperOrders: openOrders.length,
      candidateEvaluationsLastHour,
      paperOrdersPlacedLastHour,
      paperOrdersFilledLastHour,
      paperOrdersExpiredNoFillLastHour,
      paperOrdersAdmittedLastHour,
      paperOrdersRejectedBySophieLastHour,
      ordersPlacedLastHour: paperOrdersPlacedLastHour,
      fillsLastHour,
      duplicateSkipsLastHour,
      replacementsLastHour,
      maxOpenOrderBlocksLastHour,
      oldestOpenOrderAgeSec,
      avgOpenOrderAgeSec,
      avgActiveOrderAgeSec: avgOpenOrderAgeSec,
      noFillStreakMax,
      avgTimeToFillSec,
      avgFillDelayMs,
      zeroSecondFillCountLastHour,
      fillCountsBySourceLastHour,
      invalidOrUntrustedFillCountLastHour,
      trustedFillCountLastHour,
      untrustedFillCountLastHour,
      orderRealismBlocksLastHour,
      strategyOrderCountsLastHour,
      strategyFillCountsLastHour,
      gabagoolRepeatedSameMarketSameTokenEntriesLastHour,
      openOrderExposureUsd: this.openOrderExposureUsd(),
      staleExposureUsd: Number(exposureBreakdown.staleUntradeablePositionExposureUsd || 0),
      tradableExposureUsd: Number(exposureBreakdown.tradablePositionExposureUsd || 0),
      activeTradableExposureUsd: Number(exposureBreakdown.activeTradableExposureUsd || 0),
      staleNoBidExposureUsd: Number(exposureBreakdown.staleNoBidExposureUsd || 0),
      confirmedNoOrderbook404ExposureUsd: Number(exposureBreakdown.confirmedNoOrderbook404ExposureUsd || 0),
      expiredBtc5mExposureUsd: Number(exposureBreakdown.expiredBtc5mExposureUsd || 0),
      resolutionPendingExposureUsd: Number(exposureBreakdown.resolutionPendingExposureUsd || 0),
      dustExposureUsd: Number(exposureBreakdown.dustPositionExposureUsd || 0),
      staleExposureCount: Number(exposureBreakdown.staleUntradeablePositionCount || 0),
      tradableExposureCount: Number(exposureBreakdown.tradablePositionCount || 0),
      activeTradableExposureCount: Number(exposureBreakdown.activeTradableExposureCount || 0),
      staleNoBidExposureCount: Number(exposureBreakdown.staleNoBidExposureCount || 0),
      confirmedNoOrderbook404ExposureCount: Number(exposureBreakdown.confirmedNoOrderbook404ExposureCount || 0),
      expiredBtc5mExposureCount: Number(exposureBreakdown.expiredBtc5mExposureCount || 0),
      resolutionPendingExposureCount: Number(exposureBreakdown.resolutionPendingExposureCount || 0),
      dustExposureCount: Number(exposureBreakdown.dustPositionCount || 0),
      capBlockingExposureUsd: Number(exposureBreakdown.capBlockingExposureUsd || 0),
      excludedDeadExposureUsd: Number(exposureBreakdown.excludedDeadExposureUsd || 0),
      excludedDeadExposureReasonSummary: exposureBreakdown.excludedDeadExposureReasonSummary || 'none',
      deadExposureCashReserveOutstandingUsd: deadExposureCashReserve.outstandingUsd,
      deadExposureCashReserveCreditsUsd: deadExposureCashReserve.creditsUsd,
      deadExposureCashReserveRepaymentsUsd: deadExposureCashReserve.repaymentsUsd,
      gabagoolExposureCapBlockedReasonCountsLastHour: [...gabagoolExposureCapBlockedReasonCounts.entries()]
        .sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        })
        .map(([reason, count]) => `${reason}:${count}`)
        .join(',') || 'none',
      fillRateLastHour: paperOrdersPlacedLastHour > 0 ? (fillsLastHour / paperOrdersPlacedLastHour) * 100 : 0,
      fillRateByPlacedOrdersLastHour: paperOrdersPlacedLastHour > 0 ? (paperOrdersFilledLastHour / paperOrdersPlacedLastHour) * 100 : 0,
      fillStarvationReason: openOrders.length > 0 && fillsLastHour === 0 ? 'no_recent_fills' : null,
      oracleSignalsReadLastHour,
      oracleSignalsFreshLastHour,
      oracleSignalsExpiredLastHour,
      oracleSignalsNotConfirmedLastHour,
      oracleSignalsConfirmedLastHour,
      duplicateOracleSignalsSkippedLastHour,
      gabagoolCandidatesBuiltLastHour,
      gabagoolSophieEvaluatedLastHour,
      gabagoolSophieAdmittedLastHour,
      gabagoolSophieBlockedLastHour,
      gabagoolRiskEvaluatedLastHour,
      gabagoolRiskAdmittedLastHour,
      gabagoolRiskBlockedLastHour,
      gabagoolPlacementAttemptedLastHour,
      gabagoolPlacementBlockedLastHour,
      gabagoolOrdersPlacedLastHour,
      gabagoolFillsLastHour,
      gabagoolExitsLastHour,
      gabagoolTelegramSuppressedLastHour,
      gabagoolZeroSizeBlockedLastHour,
      gabagoolDustExitsLastHour,
      gabagoolDustExitsSuppressedLastHour,
      gabagoolDustExitAllowedLastHour,
      gabagoolDustPositionRemainingLastHour,
      gabagoolProfitExitsLastHour,
      gabagoolLossExitsLastHour,
      gabagoolLossExitBlocksLastHour,
      gabagoolInventoryReducesLastHour,
      gabagoolInvalidZeroSizeLastHour,
      gabagoolEntryPauseBlocksLastHour,
      gabagoolChurnBlocksLastHour,
      gabagoolSameMarketDirectionBlocksLastHour,
      gabagoolStaleDustIgnoredLastHour,
      gabagoolSameMarketUnknownDirectionIgnoredLastHour,
      gabagoolReentryBlocksLastHour,
      gabagoolHighPriceEntryBlocksLastHour,
      gabagoolLossGuardExitScanLastHour,
      gabagoolLossGuardExitCandidatesLastHour,
      gabagoolLossGuardExitsAttemptedLastHour,
      gabagoolLossGuardExitsPlacedLastHour,
      gabagoolLossGuardExitsFilledLastHour,
      gabagoolLossGuardDustRemainingLastHour,
      gabagoolReduceOnlyExitScanLastHour,
      gabagoolReduceOnlyExitCandidatesLastHour,
      gabagoolReduceOnlyExitAttemptsLastHour,
      gabagoolReduceOnlyExitOrdersLastHour,
      gabagoolReduceOnlyExitFillsLastHour,
      gabagoolRepeatedBlockedLossExitCountLastHour,
      spreadHunterGhostBlocksLastHour,
      spreadHunterSophieBlocksLastHour,
      spreadHunterConfidenceBlocksLastHour,
      spreadHunterCooldownBlocksLastHour,
      spreadHunterExecutionRealismBlocksLastHour,
      probationAdmissionsLastHour,
      probationAdmissionsBeforeRisk,
      probationBlocksLastHour,
      probationOrdersBlockedByDrawdown,
      finalBlockerAfterProbation,
      sophieAdmittedButRiskBlockedLastHour,
      sophieAdmittedButRiskBlockedByDrawdownLastHour,
      drawdownGateActive,
      topBlockReasonsLastHour,
      whyTotalOrdersZeroLastHour,
      paperOrdersPlacedLast15m,
      paperOrdersFilledLast15m,
      actionRateWindowMinutes: Math.round(actionWindowMs / 60_000),
      targetOrdersPer15m,
      targetFillsPer15m,
      paperActionBurnInActive,
      actionRateStatus,
      actionRateReason,
      burnInLifecycleStatus: burnInLifecycle.lifecycleStatus,
      burnInLifecycleReason: burnInLifecycle.lifecycleReason,
      burnInFreshStateRequired: burnInLifecycle.freshStateRequired,
      burnInRecommendedFreshStateFile: burnInLifecycle.recommendedFreshStateFile,
      gabagoolLossGuardExitBlockedLastReason: latestGabagoolReason('gabagool_loss_guard_exit_blocked'),
      gabagoolLossGuardPositionsScanned: latestGabagoolField('gabagool_loss_guard_exit_scan', 'positionsScanned') || 0,
      gabagoolLossGuardPositionsClosable: latestGabagoolField('gabagool_loss_guard_exit_scan', 'positionsClosable') || 0,
      gabagoolReduceOnlyExitBlockedLastReason: latestGabagoolReason('gabagool_reduce_only_exit_blocked'),
      gabagoolReduceOnlyPositionsScanned: latestGabagoolField('gabagool_reduce_only_exit_scan', 'positionsScanned') || 0,
      gabagoolReduceOnlyPositionsClosable: latestGabagoolField('gabagool_reduce_only_exit_scan', 'positionsClosable') || 0,
      gabagoolPlacementBlockReasonLast: latestGabagoolReason('gabagool_placement_blocked'),
      gabagoolLastRiskBlockReason: latestGabagoolReason('gabagool_risk_blocked'),
      gabagoolLastSophieBlockReason: latestGabagoolReason('gabagool_sophie_blocked'),
      gabagoolLastPlacementDecision: latestGabagoolReason('gabagool_placement_decision'),
      gabagoolLastPlacementDecisionAt: latestGabagoolTs('gabagool_placement_decision'),
      gabagoolLastRiskBlockAt: latestGabagoolTs('gabagool_risk_blocked'),
      gabagoolLastSophieBlockAt: latestGabagoolTs('gabagool_sophie_blocked'),
      gabagoolMarketLockoutReasonLast: latestGabagoolReason('gabagool_market_lockout_set'),
      gabagoolLastExitClassification: latestGabagoolReason('gabagool_exit'),
      gabagoolLastExitAt: latestGabagoolTs('gabagool_exit'),
      gabagoolLastExitPnl: latestGabagoolField('gabagool_exit', 'realizedPnl'),
      lastExitAvgEntry: latestGabagoolField('gabagool_exit', 'avgEntryPrice'),
      lastExitSellPrice: latestGabagoolField('gabagool_exit', 'price'),
      gabagoolEntryPauseReason: latestGabagoolReason('gabagool_entry_paused'),
      gabagoolZeroSizeSourceLast: latestGabagoolField('gabagool_zero_size_blocked', 'source'),
      lastFillAudit: lastFillEvent ? {
        fillSource: lastFillEvent.fillSource,
        fillDelayMs: lastFillEvent.fillDelayMs,
        bookAgeMs: lastFillEvent.bookAgeMs,
        bestBidAtPlacement: lastFillEvent.bestBidAtPlacement,
        bestAskAtPlacement: lastFillEvent.bestAskAtPlacement,
        bestBidAtFill: lastFillEvent.bestBidAtFill,
        bestAskAtFill: lastFillEvent.bestAskAtFill,
        orderPrice: lastFillEvent.orderPrice,
        wasExecutableAtPlacement: lastFillEvent.wasExecutableAtPlacement,
        wasExecutableAtFill: lastFillEvent.wasExecutableAtFill,
        queueHaircutApplied: lastFillEvent.queueHaircutApplied,
        slippageApplied: lastFillEvent.slippageApplied,
        adverseSelectionBufferApplied: lastFillEvent.adverseSelectionBufferApplied,
        trustedPnl: lastFillEvent.trustedPnl,
      } : null,
    };
  }

  burnInLifecycleState(now = Date.now()) {
    const current = this.burnInState || this.createBurnInState('computed_runtime', now);
    const drawdownGateActive = this.getDrawdownPct() > this.config.maxDrawdownPct;
    if (drawdownGateActive && current.lifecycleStatus !== 'burn_in_failed_by_drawdown') {
      return this.markBurnInFailedByDrawdown({
        reason: 'drawdown_limit',
        drawdownPct: this.getDrawdownPct(),
        closedPnl: this.closedPnl,
        now,
      });
    }
    return {
      ...current,
      stateFile: path.basename(String(this.config.stateFile || '')),
      recommendedFreshStateFile: current.recommendedFreshStateFile || this.recommendedFreshBurnInStateFile(),
    };
  }

  gabagoolDrawdownBreakdown(markPrices = new Map(), now = Date.now()) {
    const ledger = this.strategyLedger(isBtcOracleStrategy, markPrices, now);
    const breachEvent = this.executionEvents.find((event) => (
      isBtcOracleStrategy(event?.strategy) &&
      event.type === 'risk_block' &&
      event.reason === 'drawdown_limit'
    )) || null;
    const breachTs = breachEvent ? Number(breachEvent.ts || 0) : NaN;
    const gabagoolBuyFills = this.fills
      .filter((fill) => (
        isBtcOracleStrategy(fill?.strategy) &&
        String(fill?.side || '').toLowerCase() === 'buy'
      ))
      .slice()
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    const entriesBeforeBreach = Number.isFinite(breachTs)
      ? gabagoolBuyFills.filter((fill) => Number(fill.ts || 0) <= breachTs)
      : gabagoolBuyFills;
    const avgEntryPriceBeforeBreach = entriesBeforeBreach.length > 0
      ? entriesBeforeBreach.reduce((sum, fill) => sum + Number(fill.price || 0), 0) / entriesBeforeBreach.length
      : null;
    const postBreachEntries = Number.isFinite(breachTs)
      ? gabagoolBuyFills.filter((fill) => Number(fill.ts || 0) > breachTs).length
      : 0;
    const lossesByToken = new Map();
    for (const trip of ledger.roundTrips || []) {
      const pnl = Number(trip.realizedPnl || 0);
      if (!(pnl < 0)) continue;
      const key = [
        String(trip.marketSlug || trip.marketId || 'unknown_market'),
        String(trip.tokenId || 'unknown_token'),
      ].join('/');
      lossesByToken.set(key, Number(lossesByToken.get(key) || 0) + pnl);
    }
    const lossPerMarketToken = [...lossesByToken.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .map(([key, pnl]) => `${key}:${Number(pnl).toFixed(2)}`)
      .join(',') || 'none';
    return {
      entriesBeforeDrawdownBreach: entriesBeforeBreach.length,
      averageEntryPriceBeforeDrawdownBreach: avgEntryPriceBeforeBreach,
      lastExitClassification: (ledger.roundTrips || []).slice(-1)[0]?.classification || 'none',
      lossPerMarketToken,
      lossGuardTriggeredTooLate: postBreachEntries > 0,
      repeatedEntriesAlreadyBlocked: this.executionHealth(now).gabagoolRepeatedSameMarketSameTokenEntriesLastHour === 0,
    };
  }

  noFillStreaks(now = Date.now(), windowMs = 60 * 60_000) {
    const since = now - windowMs;
    const grouped = new Map();
    for (const event of this.executionEvents) {
      if (Number(event.ts) < since) continue;
      const key = `${event.tokenId}:${event.side}:${event.strategy}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    }

    return [...grouped.entries()].map(([key, events]) => {
      const sorted = events.slice().sort((a, b) => a.ts - b.ts);
      let streak = 0;
      for (const event of sorted) {
        if (event.type === 'fill') streak = 0;
        if (event.type === 'order_expired_no_fill' || event.type === 'order_replaced_no_fill') streak += 1;
      }
      return { key, noFillStreak: streak };
    });
  }

  executionStatsFor(signal, windowMs = 60 * 60_000, now = Date.now()) {
    const tokenId = String(signal?.tokenId || '');
    const side = String(signal?.side || '').toLowerCase();
    const strategy = signal?.strategy || null;
    const since = now - windowMs;
    const matchingEvents = this.executionEvents.filter((event) => (
      Number(event.ts) >= since &&
      String(event.tokenId || '') === tokenId &&
      String(event.side || '').toLowerCase() === side &&
      (!strategy || event.strategy === strategy)
    ));
    const strategyEvents = this.executionEvents.filter((event) => (
      Number(event.ts) >= since &&
      (!strategy || event.strategy === strategy)
    ));
    const count = (events, type) => events.filter((event) => event.type === type).length;
    const comparableOpenOrders = [...this.openOrders.values()].filter((order) => (
      String(order.tokenId || '') === tokenId &&
      String(order.side || '').toLowerCase() === side &&
      (!strategy || order.strategy === strategy)
    ));
    const agesSec = comparableOpenOrders.map((order) => Math.max(0, (now - order.createdAt) / 1000));
    const fillsLastHour = count(matchingEvents, 'fill');
    const admittedLastHour = count(matchingEvents, 'order_admitted');
    const freshOrdersLastHour = count(matchingEvents, 'order_placed');
    const placedLastHour = freshOrdersLastHour;
    const expiredNoFillLastHour = count(matchingEvents, 'order_expired_no_fill') + count(matchingEvents, 'order_replaced_no_fill');
    const replacementsLastHour = count(matchingEvents, 'order_replacement');
    const duplicateSkipsLastHour = count(matchingEvents, 'duplicate_skip');
    const attemptsLastHour = freshOrdersLastHour + replacementsLastHour + duplicateSkipsLastHour + count(matchingEvents, 'quality_block') + count(matchingEvents, 'quality_throttle');
    const strategyFills = count(strategyEvents, 'fill');
    const strategyAttempts = count(strategyEvents, 'order_placed') + count(strategyEvents, 'order_replacement') + count(strategyEvents, 'duplicate_skip');
    const fillEvents = matchingEvents.filter((event) => event.type === 'fill').sort((a, b) => b.ts - a.ts);
    const orderEvents = matchingEvents.filter((event) => event.type === 'order_placed').sort((a, b) => b.ts - a.ts);
    const lifecycleEvents = matchingEvents
      .filter((event) => event.type === 'fill' || event.type === 'order_expired_no_fill' || event.type === 'order_replaced_no_fill')
      .sort((a, b) => a.ts - b.ts);
    let noFillStreak = 0;
    for (const event of lifecycleEvents) {
      if (event.type === 'fill') noFillStreak = 0;
      if (event.type === 'order_expired_no_fill' || event.type === 'order_replaced_no_fill') noFillStreak += 1;
    }
    const fillsWithTime = matchingEvents.filter((event) => event.type === 'fill' && Number.isFinite(event.timeToFillSec));
    const avgTimeToFillSec = fillsWithTime.length
      ? fillsWithTime.reduce((sum, event) => sum + event.timeToFillSec, 0) / fillsWithTime.length
      : null;
    const qualities = matchingEvents
      .filter((event) => event.type === 'order_admitted' && Number.isFinite(event.quality))
      .map((event) => event.quality);
    const bestAdmittedQualityLastHour = qualities.length ? Math.max(...qualities) : null;
    const lastAdmitted = matchingEvents
      .filter((event) => event.type === 'order_admitted')
      .sort((a, b) => b.ts - a.ts)[0] || null;

    return {
      attemptsLastHour,
      admittedLastHour,
      placedLastHour,
      freshOrdersLastHour,
      expiredNoFillLastHour,
      replacementsLastHour,
      duplicateSkipsLastHour,
      fillsLastHour,
      fillRateLastHour: attemptsLastHour > 0 ? fillsLastHour / attemptsLastHour : 0,
      realizedFillRateLastHour: placedLastHour > 0 ? fillsLastHour / placedLastHour : 0,
      strategyFillRateLastHour: strategyAttempts > 0 ? strategyFills / strategyAttempts : 0,
      noFillStreak,
      avgTimeToFillSec,
      bestAdmittedQualityLastHour,
      lastAdmittedTs: lastAdmitted?.ts || null,
      lastAdmittedQuality: lastAdmitted?.quality ?? null,
      lastAdmittedDistanceFromTouch: lastAdmitted?.distanceFromTouch ?? null,
      lastFillTs: fillEvents[0]?.ts || null,
      lastOrderTs: orderEvents[0]?.ts || null,
      oldestOpenOrderAgeSec: agesSec.length ? Math.max(...agesSec) : 0,
      avgOpenOrderAgeSec: agesSec.length ? agesSec.reduce((sum, age) => sum + age, 0) / agesSec.length : 0,
      maxOpenOrderBlocksLastHour: count(matchingEvents, 'max_open_orders_block'),
    };
  }

  recordGhostOrder(signal, book) {
    if (!this.config.enableGhostMode || !signal || !book || !Number.isFinite(book.midpoint)) return;

    this.ghostOrders.push({
      id: signal.id,
      tokenId: signal.tokenId,
      side: signal.side,
      price: signal.price,
      midAtCreate: book.midpoint,
      createdAt: Date.now(),
      horizonAt: Date.now() + this.config.ghostHorizonMs,
      strategy: signal.strategy,
    });

    while (this.ghostOrders.length > this.config.ghostMaxRecords) {
      this.ghostOrders.shift();
    }
  }

  updateGhostOrders(markPrices = new Map()) {
    if (!this.config.enableGhostMode) return;

    const now = Date.now();
    const remaining = [];

    for (const ghost of this.ghostOrders) {
      if (now < ghost.horizonAt) {
        remaining.push(ghost);
        continue;
      }

      const currentMid = markPrices.get(ghost.tokenId);
      if (!Number.isFinite(currentMid) || !Number.isFinite(ghost.midAtCreate)) {
        continue;
      }

      this.ghostStats.total += 1;

      const movedUp = currentMid > ghost.midAtCreate;
      const movedDown = currentMid < ghost.midAtCreate;

      const favorable =
        (ghost.side === 'buy' && movedUp) ||
        (ghost.side === 'sell' && movedDown);

      if (favorable) this.ghostStats.favorable += 1;
      else this.ghostStats.unfavorable += 1;
    }

    this.ghostOrders = remaining;
  }

  recordFill({
    tokenId,
    marketId,
    side,
    price,
    size,
    strategy,
    marketSlug = null,
    outcome = null,
    ts = Date.now(),
    fillSource = 'unknown',
    fillDelayMs = null,
    bookAgeMs = null,
    bestBidAtPlacement = null,
    bestAskAtPlacement = null,
    bestBidAtFill = null,
    bestAskAtFill = null,
    orderPrice = null,
    wasExecutableAtPlacement = null,
    wasExecutableAtFill = null,
    queueHaircutApplied = 0,
    slippageApplied = 0,
    adverseSelectionBufferApplied = 0,
    fillInvalidReason = null,
  }) {
    tokenId = String(tokenId);
    marketId = String(marketId || '');

    const qty = Number(size);
    const px = Number(price);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(px) || px <= 0) return null;

    if (!this.positionMarkets) this.positionMarkets = new Map();
    if (marketId) this.positionMarkets.set(tokenId, marketId);

    const value = qty * px;
    const currentQty = this.position(tokenId);
    const currentCost = this.avgCost(tokenId);
    const fillRecord = {
      ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
      tokenId,
      marketId,
      marketSlug: marketSlug ? String(marketSlug) : '',
      outcome: outcome ? String(outcome) : '',
      side,
      price: px,
      size: qty,
      value,
      strategy,
      fillSource: normalizePaperFillSource(fillSource),
      fillDelayMs: numericOrNull(fillDelayMs),
      bookAgeMs: numericOrNull(bookAgeMs),
      bestBidAtPlacement: numericOrNull(bestBidAtPlacement),
      bestAskAtPlacement: numericOrNull(bestAskAtPlacement),
      bestBidAtFill: numericOrNull(bestBidAtFill),
      bestAskAtFill: numericOrNull(bestAskAtFill),
      orderPrice: numericOrNull(orderPrice),
      wasExecutableAtPlacement: wasExecutableAtPlacement === true ? true : wasExecutableAtPlacement === false ? false : null,
      wasExecutableAtFill: wasExecutableAtFill === true ? true : wasExecutableAtFill === false ? false : null,
      queueHaircutApplied: numericOrNull(queueHaircutApplied) ?? 0,
      slippageApplied: numericOrNull(slippageApplied) ?? 0,
      adverseSelectionBufferApplied: numericOrNull(adverseSelectionBufferApplied) ?? 0,
      fillInvalidReason: fillInvalidReason ? String(fillInvalidReason) : null,
    };
    const fillTrust = this.fillTrustFlags(fillRecord);
    fillRecord.trustedFill = fillTrust.trustedFill;
    fillRecord.fillInvalid = fillTrust.fillInvalid;
    fillRecord.fillInvalidReason = fillRecord.fillInvalidReason || fillTrust.fillInvalidReason;
    fillRecord.trustedPnl = fillTrust.trustedFill;
    fillRecord.trustedRealizedPnl = 0;
    fillRecord.untrustedRealizedPnl = 0;

    if (side === 'buy') {
      const newQty = currentQty + qty;
      const newCost = newQty > 0 ? ((currentQty * currentCost) + value) / newQty : 0;

      this.cash -= value;
      this.positions.set(tokenId, newQty);
      this.costBasis.set(tokenId, newCost);

      this.fills.push(fillRecord);
      return {
        ts: fillRecord.ts,
        tokenId,
        marketId,
        side,
        price: px,
        qty,
        value,
        avgEntryPrice: newCost,
        positionQtyBefore: currentQty,
        positionQtyAfter: newQty,
        realizedPnl: 0,
        trustedFill: fillTrust.trustedFill,
        trustedPnl: fillTrust.trustedFill,
        fillInvalid: fillTrust.fillInvalid,
        fillInvalidReason: fillRecord.fillInvalidReason,
        fillSource: fillRecord.fillSource,
        fillDelayMs: fillRecord.fillDelayMs,
        bookAgeMs: fillRecord.bookAgeMs,
        bestBidAtPlacement: fillRecord.bestBidAtPlacement,
        bestAskAtPlacement: fillRecord.bestAskAtPlacement,
        bestBidAtFill: fillRecord.bestBidAtFill,
        bestAskAtFill: fillRecord.bestAskAtFill,
        orderPrice: fillRecord.orderPrice,
        wasExecutableAtPlacement: fillRecord.wasExecutableAtPlacement,
        wasExecutableAtFill: fillRecord.wasExecutableAtFill,
        queueHaircutApplied: fillRecord.queueHaircutApplied,
        slippageApplied: fillRecord.slippageApplied,
        adverseSelectionBufferApplied: fillRecord.adverseSelectionBufferApplied,
      };
    }

    if (side === 'sell') {
      const sellQty = Math.min(qty, currentQty);
      if (sellQty <= 0) return null;

      const realized = (px - currentCost) * sellQty;
      const newQty = currentQty - sellQty;
      const priorLots = this.reconstructLotsForToken(tokenId);
      let remainingQty = sellQty;
      let matchedQtyTotal = 0;
      let matchedCostUsd = 0;
      let trustedMatchedQty = 0;
      let trustedRealizedPnl = 0;
      let untrustedRealizedPnl = 0;
      for (const lot of priorLots) {
        if (remainingQty <= 1e-9) break;
        const matchedQty = Math.min(remainingQty, lot.qty);
        const pnlContribution = (px - lot.price) * matchedQty;
        matchedQtyTotal += matchedQty;
        matchedCostUsd += matchedQty * lot.price;
        if (fillTrust.trustedFill && lot.trustedFill) {
          trustedMatchedQty += matchedQty;
          trustedRealizedPnl += pnlContribution;
        } else {
          untrustedRealizedPnl += pnlContribution;
        }
        remainingQty -= matchedQty;
      }
      const avgEntryPrice = matchedQtyTotal > 0 ? matchedCostUsd / matchedQtyTotal : currentCost;
      const trustedPnl = fillTrust.trustedFill && trustedMatchedQty >= sellQty - 1e-9;
      fillRecord.size = sellQty;
      fillRecord.value = sellQty * px;
      fillRecord.trustedPnl = trustedPnl;
      fillRecord.trustedRealizedPnl = trustedRealizedPnl;
      fillRecord.untrustedRealizedPnl = untrustedRealizedPnl;

      this.cash += sellQty * px;
      this.closedPnl += realized;

      if (newQty <= 1e-9) {
        this.positions.delete(tokenId);
        this.costBasis.delete(tokenId);
      } else {
        this.positions.set(tokenId, newQty);
      }

      this.strategyPnl.set(strategy, (this.strategyPnl.get(strategy) || 0) + realized);

      this.fills.push(fillRecord);
      return {
        ts: fillRecord.ts,
        tokenId,
        marketId,
        side,
        price: px,
        qty: sellQty,
        value: sellQty * px,
        avgEntryPrice,
        positionQtyBefore: currentQty,
        positionQtyAfter: Math.max(0, newQty),
        realizedPnl: realized,
        trustedFill: fillTrust.trustedFill,
        trustedPnl,
        fillInvalid: fillTrust.fillInvalid,
        fillInvalidReason: fillRecord.fillInvalidReason,
        trustedRealizedPnl,
        untrustedRealizedPnl,
        fillSource: fillRecord.fillSource,
        fillDelayMs: fillRecord.fillDelayMs,
        bookAgeMs: fillRecord.bookAgeMs,
        bestBidAtPlacement: fillRecord.bestBidAtPlacement,
        bestAskAtPlacement: fillRecord.bestAskAtPlacement,
        bestBidAtFill: fillRecord.bestBidAtFill,
        bestAskAtFill: fillRecord.bestAskAtFill,
        orderPrice: fillRecord.orderPrice,
        wasExecutableAtPlacement: fillRecord.wasExecutableAtPlacement,
        wasExecutableAtFill: fillRecord.wasExecutableAtFill,
        queueHaircutApplied: fillRecord.queueHaircutApplied,
        slippageApplied: fillRecord.slippageApplied,
        adverseSelectionBufferApplied: fillRecord.adverseSelectionBufferApplied,
      };
    }

    this.fills.push(fillRecord);
    return {
      ts: fillRecord.ts,
      tokenId,
      marketId,
      side,
      price: px,
      qty,
      value,
      avgEntryPrice: currentCost,
      positionQtyBefore: currentQty,
      positionQtyAfter: currentQty,
      realizedPnl: 0,
      trustedFill: fillTrust.trustedFill,
      trustedPnl: fillTrust.trustedFill,
      fillInvalid: fillTrust.fillInvalid,
      fillInvalidReason: fillRecord.fillInvalidReason,
      fillSource: fillRecord.fillSource,
      fillDelayMs: fillRecord.fillDelayMs,
      bookAgeMs: fillRecord.bookAgeMs,
      bestBidAtPlacement: fillRecord.bestBidAtPlacement,
      bestAskAtPlacement: fillRecord.bestAskAtPlacement,
      bestBidAtFill: fillRecord.bestBidAtFill,
      bestAskAtFill: fillRecord.bestAskAtFill,
      orderPrice: fillRecord.orderPrice,
      wasExecutableAtPlacement: fillRecord.wasExecutableAtPlacement,
      wasExecutableAtFill: fillRecord.wasExecutableAtFill,
      queueHaircutApplied: fillRecord.queueHaircutApplied,
      slippageApplied: fillRecord.slippageApplied,
      adverseSelectionBufferApplied: fillRecord.adverseSelectionBufferApplied,
    };
  }

  saveState() {
    if (!this.config.saveState) return;

    try {
      const data = this.buildPersistedState();
      const skip = this.shouldSkipStateSaveForNewerReset(data);
      if (skip.skip) {
        const key = `${skip.currentResetMs}:${skip.nextResetMs}`;
        const now = Date.now();
        if (this.lastStateSaveSkipLog.key !== key || (now - Number(this.lastStateSaveSkipLog.ts || 0)) >= 30_000) {
          this.lastStateSaveSkipLog = { key, ts: now };
          warn(
            `[STATE SAVE SKIPPED] reason=newer_burnin_reset_on_disk stateFile=${path.basename(this.resolvedStateFilePath())} ` +
            `onDiskResetAt=${new Date(skip.currentResetMs).toISOString()} inMemoryResetAt=${new Date(skip.nextResetMs).toISOString()} ` +
            `onDiskPositionKeys=${skip.currentSummary?.positionKeys || 0} inMemoryPositionKeys=${skip.nextSummary?.positionKeys || 0} ` +
            `onDiskExposureUsd=${fmtMoney(skip.currentSummary?.totalExposureUsd || 0)} ` +
            `inMemoryExposureUsd=${fmtMoney(skip.nextSummary?.totalExposureUsd || 0)}`
          );
        }
        return { ok: false, skipped: true, reason: 'newer_burnin_reset_on_disk' };
      }
      this.writeJsonFileAtomic(this.resolvedStateFilePath(), data);
      if (fs.existsSync(this.pendingBurnInResetStateFilePath())) {
        this.clearPendingBurnInResetStateFile();
      }
      return { ok: true, skipped: false };
    } catch (e) {
      warn(`State save failed: ${e.message}`);
      return { ok: false, skipped: false, error: e.message };
    }
  }

  hydratePersistedState(data = {}) {
    this.cash = Number.isFinite(Number(data.cash)) ? Number(data.cash) : this.cash;
    this.startingCash = Number.isFinite(Number(data.startingCash)) ? Number(data.startingCash) : this.startingCash;
    this.peakEquity = Number.isFinite(Number(data.peakEquity)) ? Number(data.peakEquity) : this.peakEquity;
    this.closedPnl = Number.isFinite(Number(data.closedPnl)) ? Number(data.closedPnl) : this.closedPnl;
    this.deadExposureCashReserveOutstandingUsd = Number.isFinite(Number(data.deadExposureCashReserveOutstandingUsd))
      ? Number(data.deadExposureCashReserveOutstandingUsd)
      : this.deadExposureCashReserveOutstandingUsd;
    this.deadExposureCashReserveCreditsUsd = Number.isFinite(Number(data.deadExposureCashReserveCreditsUsd))
      ? Number(data.deadExposureCashReserveCreditsUsd)
      : this.deadExposureCashReserveCreditsUsd;
    this.deadExposureCashReserveRepaymentsUsd = Number.isFinite(Number(data.deadExposureCashReserveRepaymentsUsd))
      ? Number(data.deadExposureCashReserveRepaymentsUsd)
      : this.deadExposureCashReserveRepaymentsUsd;

    this.positions = new Map(Object.entries(data.positions || {}).map(([k, v]) => [k, Number(v)]));
    this.positionMarkets = new Map(Object.entries(data.positionMarkets || {}).map(([k, v]) => [k, String(v)]));
    this.costBasis = new Map(Object.entries(data.costBasis || {}).map(([k, v]) => [k, Number(v)]));
    this.latestMarks = new Map(Object.entries(data.latestMarks || {}).map(([k, v]) => [k, Number(v)]));
    this.openOrders = new Map(Object.entries(data.openOrders || {}).map(([k, v]) => [k, v]));
    this.strategyPnl = new Map(Object.entries(data.strategyPnl || {}).map(([k, v]) => [k, Number(v)]));
    this.ghostStats = data.ghostStats || this.ghostStats;
    this.fills = Array.isArray(data.fills) ? data.fills : [];
    this.executionTotals = {
      ...this.executionTotals,
      ...(data.executionTotals || {}),
    };
    this.executionEvents = Array.isArray(data.executionEvents) ? data.executionEvents : [];
    this.burnInState = data.burnInState && typeof data.burnInState === 'object'
      ? {
        ...this.createBurnInState('restored_state'),
        ...data.burnInState,
        stateFile: path.basename(String(this.config.stateFile || '')),
        recommendedFreshStateFile: data.burnInState.recommendedFreshStateFile || this.recommendedFreshBurnInStateFile(),
        resetModeApplied: this.config.paperBurnInResetMode === true,
      }
      : this.createBurnInState('restored_state');
    for (const fill of this.fills) {
      const tokenId = String(fill?.tokenId || '');
      const marketId = String(fill?.marketId || '');
      if (tokenId && marketId && !this.positionMarkets.has(tokenId)) {
        this.positionMarkets.set(tokenId, marketId);
      }
    }
  }

  loadState() {
    if (!this.config.saveState) return;

    try {
      if (this.config.paperBurnInResetMode === true) {
        const freshState = this.writeFreshBurnInStateFile('paper_burnin_reset_mode');
        info(
          `[BURN-IN RESET] stateFile=${freshState.stateFile} initialCash=${cleanLogValue(freshState.initialCash)} ` +
          `lifecycleStatus=${freshState.lifecycleStatus} recommendedFreshStateFile=${freshState.recommendedFreshStateFile} ` +
          `liveTradingEnabled=${freshState.liveTradingEnabled ? 'true' : 'false'} ` +
          `liveKillSwitch=${freshState.liveKillSwitch ? 'true' : 'false'} ` +
          `liveDryRunOnly=${freshState.liveDryRunOnly ? 'true' : 'false'}`
        );
        return;
      }
      let data = null;
      const pendingResetState = this.readPendingBurnInResetStateFile();
      if (pendingResetState?.data) {
        data = pendingResetState.data;
        this.writeJsonFileAtomic(this.resolvedStateFilePath(), data);
        this.clearPendingBurnInResetStateFile();
        info(
          `[BURN-IN RESET PENDING APPLIED] stateFile=${path.basename(this.resolvedStateFilePath())} ` +
          `pendingResetStateFile=${path.basename(pendingResetState.filePath)} ` +
          `lifecycleStatus=${cleanLogValue(data?.burnInState?.lifecycleStatus)} ` +
          `lastResetAt=${cleanLogValue(data?.burnInState?.lastResetAt)}`
        );
      } else {
        data = this.readPersistedStateFile();
      }
      if (!data) return;

      this.hydratePersistedState(data);

      if (!this.burnInState?.lifecycleStatus) {
        this.burnInState = this.createBurnInState('restored_state');
      }

      info(`Loaded state from ${this.config.stateFile}. Equity: $${this.equity().toFixed(2)}`);
    } catch (e) {
      warn(`State load failed: ${e.message}`);
    }
  }
}

class PaperOrder {
  constructor(signal) {
    this.id = signal.id;
    this.signal = signal;
    this.tokenId = signal.tokenId;
    this.marketId = signal.marketId;
    this.side = signal.side;
    this.price = signal.price;
    this.sizeUsd = signal.sizeUsd;
    this.strategy = signal.strategy;
    this.createdAt = Date.now();
    this.expiresAt = Date.now() + signal.ttlMs;
    this.filledUsd = 0;
    this.metadata = signal.metadata || {};
    this.placementAudit = signal.metadata?.paperPlacementAudit || null;
    this.lastRealismBlockReason = null;
    this.lastRealismBlockAt = 0;
  }

  remainingUsd() {
    return Math.max(0, this.sizeUsd - this.filledUsd);
  }

  isExpired() {
    return Date.now() >= this.expiresAt;
  }
}

// =========================
// RISK ENGINE
// =========================

class RiskEngine {
  constructor(config, portfolio, diagnostics = null) {
    this.config = config;
    this.portfolio = portfolio;
    this.diagnostics = diagnostics;
    this.lastBlockReason = null;
    this.lastBlockDetails = null;
    this.lastBtcBucketFullLog = new Map();
    this.lastExpiredExposureExcludedLog = new Map();
  }

  minSignalEdgeForSignal(signal) {
    return minSignalEdgeForCandidate(signal, this.config);
  }

  gabagoolPositionContext(tokenId, marketId) {
    return BotEngine.prototype.gabagoolPositionContext.call({
      portfolio: this.portfolio,
      lastGabagoolOracleTarget: null,
    }, tokenId, marketId);
  }

  gabagoolExposureCleanupState(context = {}, now = Date.now()) {
    return BotEngine.prototype.gabagoolExposureCleanupState.call({
      gabagoolMarketWindowState: BotEngine.prototype.gabagoolMarketWindowState,
      gabagoolMarketStartSec: BotEngine.prototype.gabagoolMarketStartSec,
    }, context, now);
  }

  logExpiredPaperExposureExcluded({ tokenId, marketSlug, valueUsd, tradeabilityStatus, cleanupState }) {
    const exposureUsd = Number(valueUsd || 0);
    if (!(exposureUsd > 0)) return;
    const slug = String(marketSlug || 'unknown');
    const key = `${String(tokenId || '')}:${slug}`;
    const now = Date.now();
    const lastLoggedAt = this.lastExpiredExposureExcludedLog.get(key) || 0;
    if (now - lastLoggedAt < 5 * 60_000) return;
    this.lastExpiredExposureExcludedLog.set(key, now);
    info(
      `[GABAGOOL PAPER EXPIRED EXPOSURE EXCLUDED] token=${shortId(tokenId)} ` +
      `marketSlug=${slug} valueUsd=${fmtMoney(exposureUsd)} ` +
      `tradeability=${tradeabilityStatus || 'unknown'} ` +
      `secondsIntoWindow=${cleanLogValue(cleanupState?.secondsIntoWindow)} ` +
      `lastEvidenceAgeMs=${cleanLogValue(cleanupState?.lastEvidenceAgeMs)}`
    );
  }

  classifyExposureBuckets({
    positionEntries = [],
    btcOracleTokenIds = new Set(),
    btcOraclePositionContextByToken = new Map(),
    tradeability = new Map(),
    minOrderUsd = Math.max(0.01, Number(this.config.minOrderUsd || 0)),
    now = Date.now(),
    logExpiredExclusions = false,
  } = {}) {
    const totals = {
      activeTradableExposureUsd: 0,
      staleNoBidExposureUsd: 0,
      confirmedNoOrderbook404ExposureUsd: 0,
      expiredBtc5mExposureUsd: 0,
      resolutionPendingExposureUsd: 0,
      dustExposureUsd: 0,
      activeTradableExposureCount: 0,
      staleNoBidExposureCount: 0,
      confirmedNoOrderbook404ExposureCount: 0,
      expiredBtc5mExposureCount: 0,
      resolutionPendingExposureCount: 0,
      dustExposureCount: 0,
      btcOracleActiveTradableExposureUsd: 0,
      btcOracleStaleNoBidExposureUsd: 0,
      btcOracleConfirmedNoOrderbook404ExposureUsd: 0,
      btcOracleExpiredBtc5mExposureUsd: 0,
      btcOracleResolutionPendingExposureUsd: 0,
      btcOracleDustExposureUsd: 0,
      activeTradableBtcOraclePositionCount: 0,
      staleNoBidBtcOraclePositionCount: 0,
      confirmedNoOrderbook404BtcOraclePositionCount: 0,
      expiredBtc5mBtcOraclePositionCount: 0,
      resolutionPendingBtcOraclePositionCount: 0,
      dustBtcOraclePositionCount: 0,
      staleUntradeablePositionExposureUsd: 0,
      tradablePositionExposureUsd: 0,
      staleUntradeablePositionCount: 0,
      tradablePositionCount: 0,
      staleBtcOraclePositionExposureUsd: 0,
      tradableBtcOraclePositionExposureUsd: 0,
      staleNonBtcPositionExposureUsd: 0,
      tradableNonBtcPositionExposureUsd: 0,
      excludedDeadExposureUsd: 0,
      excludedDeadBtcOracleExposureUsd: 0,
    };
    const excludedDeadReasonExposure = new Map();

    for (const entry of positionEntries) {
      const valueUsd = Number(entry?.valueUsd || 0);
      if (!(valueUsd > 0)) continue;
      const tokenId = String(entry?.tokenId || '');
      const isBtcOraclePosition = btcOracleTokenIds.has(tokenId);
      const tokenTradeability = tradeability.get(tokenId) || null;
      const tradeabilityStatus = String(tokenTradeability?.status || '');
      const ledgerContext = isBtcOraclePosition
        ? (btcOraclePositionContextByToken.get(tokenId) || null)
        : null;
      let context = isBtcOraclePosition
        ? this.gabagoolPositionContext(tokenId, ledgerContext?.marketId || entry?.marketId)
        : null;
      if (context && ledgerContext?.marketSlug) {
        const fallbackSlugSource = !context.marketSlug || ['position_market_id', 'token_fallback', 'unknown'].includes(String(context.marketSlugSource || ''));
        if (fallbackSlugSource) {
          context = {
            ...context,
            marketSlug: String(ledgerContext.marketSlug),
            marketSlugSource: 'strategy_ledger',
          };
        }
      }
      const cleanupState = isBtcOraclePosition
        ? this.gabagoolExposureCleanupState(context, now)
        : null;
      const isDust = valueUsd < minOrderUsd;
      let bucketKey = 'activeTradableExposureUsd';
      let countKey = 'activeTradableExposureCount';
      let btcBucketKey = isBtcOraclePosition ? 'btcOracleActiveTradableExposureUsd' : null;
      let btcCountKey = isBtcOraclePosition ? 'activeTradableBtcOraclePositionCount' : null;
      let excludedDeadReason = null;

      if (isBtcOraclePosition && tradeabilityStatus === 'no_orderbook_404') {
        bucketKey = 'confirmedNoOrderbook404ExposureUsd';
        countKey = 'confirmedNoOrderbook404ExposureCount';
        btcBucketKey = 'btcOracleConfirmedNoOrderbook404ExposureUsd';
        btcCountKey = 'confirmedNoOrderbook404BtcOraclePositionCount';
        excludedDeadReason = 'confirmed_no_orderbook_404';
      } else if (isBtcOraclePosition && cleanupState?.staleMarket === true) {
        bucketKey = 'expiredBtc5mExposureUsd';
        countKey = 'expiredBtc5mExposureCount';
        btcBucketKey = 'btcOracleExpiredBtc5mExposureUsd';
        btcCountKey = 'expiredBtc5mBtcOraclePositionCount';
        excludedDeadReason = 'expired_btc_5m_window';
      } else if (
        isBtcOraclePosition &&
        cleanupState?.staleEvidence === true &&
        (tradeabilityStatus === 'stale_token_cooldown' || tradeabilityStatus === 'no_bid')
      ) {
        bucketKey = 'resolutionPendingExposureUsd';
        countKey = 'resolutionPendingExposureCount';
        btcBucketKey = 'btcOracleResolutionPendingExposureUsd';
        btcCountKey = 'resolutionPendingBtcOraclePositionCount';
      } else if (
        isBtcOraclePosition &&
        (tradeabilityStatus === 'stale_token_cooldown' || tradeabilityStatus === 'no_bid')
      ) {
        bucketKey = 'staleNoBidExposureUsd';
        countKey = 'staleNoBidExposureCount';
        btcBucketKey = 'btcOracleStaleNoBidExposureUsd';
        btcCountKey = 'staleNoBidBtcOraclePositionCount';
      }

      totals[bucketKey] += valueUsd;
      totals[countKey] += 1;
      if (btcBucketKey) totals[btcBucketKey] += valueUsd;
      if (btcCountKey) totals[btcCountKey] += 1;

      if (isDust) {
        totals.dustExposureUsd += valueUsd;
        totals.dustExposureCount += 1;
        if (isBtcOraclePosition) {
          totals.btcOracleDustExposureUsd += valueUsd;
          totals.dustBtcOraclePositionCount += 1;
        }
      }

      if (bucketKey === 'activeTradableExposureUsd') {
        totals.tradablePositionExposureUsd += valueUsd;
        totals.tradablePositionCount += 1;
        if (isBtcOraclePosition) totals.tradableBtcOraclePositionExposureUsd += valueUsd;
        else totals.tradableNonBtcPositionExposureUsd += valueUsd;
      } else {
        totals.staleUntradeablePositionExposureUsd += valueUsd;
        totals.staleUntradeablePositionCount += 1;
        if (isBtcOraclePosition) totals.staleBtcOraclePositionExposureUsd += valueUsd;
        else totals.staleNonBtcPositionExposureUsd += valueUsd;
      }

      if (excludedDeadReason) {
        totals.excludedDeadExposureUsd += valueUsd;
        if (isBtcOraclePosition) totals.excludedDeadBtcOracleExposureUsd += valueUsd;
        excludedDeadReasonExposure.set(
          excludedDeadReason,
          Number(excludedDeadReasonExposure.get(excludedDeadReason) || 0) + valueUsd
        );
        if (logExpiredExclusions === true && excludedDeadReason === 'expired_btc_5m_window') {
          this.logExpiredPaperExposureExcluded({
            tokenId,
            marketSlug: context?.marketSlug || ledgerContext?.marketSlug || entry?.marketId || null,
            valueUsd,
            tradeabilityStatus,
            cleanupState,
          });
        }
      }
    }

    return {
      ...totals,
      capBlockingPositionExposureUsd: Math.max(0, (
        Number(totals.activeTradableExposureUsd || 0) +
        Number(totals.staleNoBidExposureUsd || 0) +
        Number(totals.resolutionPendingExposureUsd || 0)
      )),
      capBlockingBtcOraclePositionExposureUsd: Math.max(0, (
        Number(totals.btcOracleActiveTradableExposureUsd || 0) +
        Number(totals.btcOracleStaleNoBidExposureUsd || 0) +
        Number(totals.btcOracleResolutionPendingExposureUsd || 0)
      )),
      excludedDeadExposureReasonSummary: [...excludedDeadReasonExposure.entries()]
        .sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        })
        .map(([reason, exposureUsd]) => `${reason}:${Number(exposureUsd).toFixed(2)}`)
        .join(',') || 'none',
      excludedDeadExposureReasons: Object.fromEntries(excludedDeadReasonExposure.entries()),
    };
  }

  exposureBreakdown(signal = null, options = {}) {
    const optionMarkPrices = options && typeof options === 'object' && options.markPrices instanceof Map
      ? options.markPrices
      : null;
    const markPrices = optionMarkPrices || this.portfolio.markPricesSnapshot();
    const portfolioExposure = this.portfolio.portfolioExposureBreakdown(markPrices);
    const now = Date.now();
    const btcOracleLedger = this.portfolio.strategyLedger(isBtcOracleStrategy, markPrices, now);
    const btcOraclePositionExposureUsd = Number(btcOracleLedger.currentPositionExposureUsd || 0);
    const btcOracleOpenOrderExposureUsd = Number(btcOracleLedger.currentOpenOrderExposureUsd || 0);
    const btcOracleTokenIds = new Set(
      Array.isArray(btcOracleLedger.perTokenExposure)
        ? btcOracleLedger.perTokenExposure.map((entry) => String(entry?.tokenId || '')).filter(Boolean)
        : []
    );
    const btcOraclePositionContextByToken = new Map(
      Array.isArray(btcOracleLedger.perTokenExposure)
        ? btcOracleLedger.perTokenExposure
          .map((entry) => ([
            String(entry?.tokenId || ''),
            {
              tokenId: String(entry?.tokenId || ''),
              marketId: String(entry?.marketId || ''),
              marketSlug: String(entry?.marketSlug || ''),
            },
          ]))
          .filter(([tokenId]) => Boolean(tokenId))
        : []
    );
    const positionEntries = this.portfolio.positionExposureEntries(markPrices);
    const tradeability = this.portfolio.paperTokenTradeability instanceof Map
      ? this.portfolio.paperTokenTradeability
      : new Map();
    const minOrderUsd = Math.max(0.01, Number(this.config.minOrderUsd || 0));
    const bucketSummary = this.classifyExposureBuckets({
      positionEntries,
      btcOracleTokenIds,
      btcOraclePositionContextByToken,
      tradeability,
      minOrderUsd,
      now,
      logExpiredExclusions: this.config.enableLiveTrading !== true,
    });
    const paperEntryExposureExclusionActive = this.config.enableLiveTrading !== true;
    const paperEntryExposureExclusionUsd = paperEntryExposureExclusionActive
      ? Number(bucketSummary.excludedDeadExposureUsd || 0)
      : 0;
    const paperEntryBtcBucketExposureExclusionUsd = paperEntryExposureExclusionActive
      ? Number(bucketSummary.excludedDeadBtcOracleExposureUsd || 0)
      : 0;
    const paperEntryStandardBucketExposureExclusionUsd = 0;
    const rawTotalExposureUsd = Number(portfolioExposure.totalExposureUsd || 0);
    const riskTotalExposureUsd = Math.max(
      0,
      Number(bucketSummary.capBlockingPositionExposureUsd || 0) + Number(portfolioExposure.openOrderExposureUsd || 0)
    );
    const candidateSizeUsd = Number(signal?.sizeUsd);
    const buyDeltaUsd = signal?.side === 'buy' && Number.isFinite(candidateSizeUsd) ? candidateSizeUsd : 0;
    return {
      riskTotalExposureUsd,
      rawTotalExposureUsd,
      portfolioPositionExposureUsd: Number(portfolioExposure.positionExposureUsd || 0),
      portfolioOpenOrderExposureUsd: Number(portfolioExposure.openOrderExposureUsd || 0),
      ...bucketSummary,
      dustPositionExposureUsd: Number(bucketSummary.dustExposureUsd || 0),
      dustPositionCount: Number(bucketSummary.dustExposureCount || 0),
      paperEntryExposureExclusionActive,
      paperEntryExposureExclusionUsd,
      paperEntryBtcBucketExposureExclusionUsd,
      paperEntryStandardBucketExposureExclusionUsd,
      btcOraclePositionExposureUsd,
      btcOracleOpenOrderExposureUsd,
      nonBtcPositionExposureUsd: Number(portfolioExposure.positionExposureUsd || 0) - btcOraclePositionExposureUsd,
      nonBtcOpenOrderExposureUsd: Number(portfolioExposure.openOrderExposureUsd || 0) - btcOracleOpenOrderExposureUsd,
      maxTotalExposureUsd: Number(this.config.maxTotalExposureUsd || 0),
      exposureAvailableUsd: Number(this.config.maxTotalExposureUsd || 0) - riskTotalExposureUsd,
      capBlockingExposureUsd: riskTotalExposureUsd,
      excludedDeadExposureUsd: Number(bucketSummary.excludedDeadExposureUsd || 0),
      excludedDeadBtcOracleExposureUsd: Number(bucketSummary.excludedDeadBtcOracleExposureUsd || 0),
      candidateSizeUsd,
      wouldTotalExposureUsd: riskTotalExposureUsd + buyDeltaUsd,
    };
  }

  exposureBucketState(signal = null, exposureBreakdown = this.exposureBreakdown(signal)) {
    const bucket = isBtcOracleStrategy(signal) ? 'btc' : 'standard';
    const rawCurrentExposureUsd = bucket === 'btc'
      ? Number(exposureBreakdown.btcOraclePositionExposureUsd || 0) + Number(exposureBreakdown.btcOracleOpenOrderExposureUsd || 0)
      : Number(exposureBreakdown.nonBtcPositionExposureUsd || 0) + Number(exposureBreakdown.nonBtcOpenOrderExposureUsd || 0);
    const bucketExposureExclusionUsd = bucket === 'btc'
      ? Number(exposureBreakdown.paperEntryBtcBucketExposureExclusionUsd || 0)
      : Number(exposureBreakdown.paperEntryStandardBucketExposureExclusionUsd || 0);
    const currentExposureUsd = Math.max(0, rawCurrentExposureUsd - bucketExposureExclusionUsd);
    const configuredShare = bucket === 'btc'
      ? Number(this.config.btcExposureBucketShare ?? 0.5)
      : Number(this.config.standardExposureBucketShare ?? 0.5);
    const bucketShare = clamp(configuredShare, 0, 1);
    const capUsd = Number(this.config.maxTotalExposureUsd || 0) * bucketShare;
    const buyDeltaUsd = signal?.side === 'buy' && Number.isFinite(Number(signal?.sizeUsd))
      ? Number(signal.sizeUsd)
      : 0;
    return {
      strategyBucket: bucket,
      strategyBucketCapUsd: capUsd,
      strategyBucketExposureRawUsd: rawCurrentExposureUsd,
      strategyBucketExposureExclusionUsd: bucketExposureExclusionUsd,
      strategyBucketExposureUsd: currentExposureUsd,
      strategyBucketWouldExposureUsd: currentExposureUsd + buyDeltaUsd,
    };
  }

  logBtcBucketFull(action, bucketState = {}, extra = {}) {
    const exposure = Number(bucketState?.strategyBucketExposureUsd || 0);
    const projectedExposure = Number(bucketState?.strategyBucketWouldExposureUsd || exposure);
    const cap = Number(bucketState?.strategyBucketCapUsd || 0);
    if (!(cap > 0) || Math.max(exposure, projectedExposure) < cap - 1e-9) return;
    const key = `${action}:${Math.round(exposure * 100)}:${Math.round(projectedExposure * 100)}:${Math.round(cap * 100)}`;
    const now = Date.now();
    const last = this.lastBtcBucketFullLog.get(key) || 0;
    if (now - last < 30_000) return;
    this.lastBtcBucketFullLog.set(key, now);
    info(
      `[BTC BUCKET FULL] exposure=${cleanLogValue(exposure)} cap=${cleanLogValue(cap)} action=${action} ` +
      `projectedExposure=${cleanLogValue(projectedExposure)} ` +
      `token=${shortId(extra?.tokenId)} sizeUsd=${cleanLogValue(extra?.sizeUsd)}`
    );
  }

  sellReducesExistingExposure(signal, availableSellQty = null) {
    if (!signal || signal.side !== 'sell') return false;
    const availableQty = Number.isFinite(Number(availableSellQty))
      ? Number(availableSellQty)
      : this.portfolio.availablePositionQty(signal.tokenId);
    if (!(availableQty > 0)) return false;
    if (!Number.isFinite(Number(signal.price)) || Number(signal.price) <= 0) return false;
    return true;
  }

  paperConfidenceProfile() {
    const profile = String(this.config.paperConfidenceProfile || 'balanced').trim().toLowerCase();
    return ['conservative', 'balanced', 'capital_velocity'].includes(profile) ? profile : 'balanced';
  }

  isPaperSpreadHunterOverrideEligible(signal) {
    if (!signal || signal.strategy !== 'SpreadHunter') return false;
    const profile = this.paperConfidenceProfile();
    if (profile !== 'capital_velocity') return false;

    const route = signal.metadata?.consensus?.route || {};
    return route.authorized === true && route.mode === 'MAKER' && route.state === 'STABLE';
  }

  minOrderUsdForSignal(signal) {
    const dustExitPolicy = gabagoolDustExitPolicy(signal, this.portfolio, this.config);
    if (dustExitPolicy.eligible) {
      return dustExitPolicy.minDustExitUsd;
    }
    const reduceOnlyExitPolicy = reduceOnlyPaperExitPolicy(signal, this.portfolio, this.config);
    if (reduceOnlyExitPolicy.eligible) {
      return reduceOnlyExitPolicy.minReduceOnlyExitUsd;
    }
    if (isGabagoolStrategy(signal) && this.config.enableGabagoolBtcImitation) {
      const gabagoolCap = Number(this.config.gabagoolMaxPaperOrderUsd);
      if (Number.isFinite(gabagoolCap) && gabagoolCap > 0) {
        return Math.max(0.5, Math.min(this.config.minOrderUsd, gabagoolCap));
      }
    }
    const paperProbation = signal?.metadata?.paperProbation || null;
    if (
      this.config.enableLiveTrading !== true &&
      paperProbation?.active === true &&
      paperProbation?.paperOnly === true
    ) {
      const tinySizeUsd = Number(paperProbation.tinySizeUsd || 0);
      if (Number.isFinite(tinySizeUsd) && tinySizeUsd > 0) {
        return Math.max(0.5, Math.min(this.config.minOrderUsd, tinySizeUsd));
      }
    }
    return this.config.minOrderUsd;
  }

  gabagoolConfidenceThreshold(signal, baseMinConfidence = this.config.minConfidence) {
    if (!isGabagoolStrategy(signal)) return null;
    const liveMode = this.config.enableLiveTrading === true;
    const configuredMin = Number(liveMode ? this.config.gabagoolMinConfidenceLive : this.config.gabagoolMinConfidence);
    const fallbackMin = liveMode ? Math.max(baseMinConfidence, 0.70) : baseMinConfidence;
    const selectedMin = Number.isFinite(configuredMin) && configuredMin > 0
      ? configuredMin
      : fallbackMin;
    const minConfidence = clamp(selectedMin, 0, 1);
    return {
      minConfidence,
      confidenceProfile: this.paperConfidenceProfile(),
      thresholdSource: liveMode ? 'GABAGOOL_MIN_CONFIDENCE_LIVE' : 'GABAGOOL_MIN_CONFIDENCE',
      paperConfidenceOverrideEligible: liveMode ? false : true,
      gabagoolConfidenceMode: liveMode ? 'live' : 'paper',
      configuredGabagoolMinConfidence: Number(this.config.gabagoolMinConfidence),
      configuredGabagoolMinConfidenceLive: Number(this.config.gabagoolMinConfidenceLive),
      paperConfidenceOverrideReason: liveMode
        ? 'gabagool_live_confidence_floor'
        : 'gabagool_paper_confidence_floor',
    };
  }

  confidenceThreshold(signal) {
    const base = this.config.minConfidence;
    const profile = this.paperConfidenceProfile();
    const gabagoolThreshold = this.gabagoolConfidenceThreshold(signal, base);

    if (gabagoolThreshold) return gabagoolThreshold;

    const strategy = resolveStrategyName(signal);
    const paperProbation = signal?.metadata?.paperProbation || null;
    if (
      !this.config.enableLiveTrading &&
      strategy === 'SpreadHunter' &&
      String(signal?.side || '').toLowerCase() === 'buy' &&
      paperProbation?.active === true
    ) {
      const probationMinConfidence = Number(paperProbation.minConfidence);
      if (Number.isFinite(probationMinConfidence) && probationMinConfidence > 0) {
        return {
          minConfidence: clamp(probationMinConfidence, 0, 1),
          confidenceProfile: profile,
          thresholdSource: 'SPREADHUNTER_PAPER_PROBATION',
          paperConfidenceOverrideEligible: true,
          paperConfidenceOverrideReason: 'spreadhunter_paper_probation',
          paperProbationActive: true,
          paperProbationStrictMinConfidence: Number(paperProbation.strictMinConfidence || base),
          paperProbationTrigger: String(paperProbation.trigger || 'unknown'),
        };
      }
    }
    const standardOverrideEligible = (
      !this.config.enableLiveTrading &&
      ['SpreadHunter', 'ComplementArb', 'TailEndMispricing', 'WhaleCopy'].includes(strategy)
    );
    if (standardOverrideEligible) {
      const paperMin = Number(this.config.standardPaperMinConfidence);
      if (Number.isFinite(paperMin) && paperMin > 0) {
        return {
          minConfidence: Math.min(base, paperMin),
          confidenceProfile: profile,
          thresholdSource: 'STANDARD_PAPER_MIN_CONFIDENCE',
          paperConfidenceOverrideEligible: true,
          paperConfidenceOverrideReason: 'mixed_mode_standard_paper_floor',
        };
      }
    }

    const overrideEligible = this.isPaperSpreadHunterOverrideEligible(signal);

    if (!overrideEligible) {
      return {
        minConfidence: base,
        confidenceProfile: profile,
        thresholdSource: 'MIN_CONFIDENCE',
        paperConfidenceOverrideEligible: false,
      };
    }

    const paperMin = Number(this.config.spreadHunterMinConfidencePaper);
    if (!Number.isFinite(paperMin) || paperMin <= 0) {
      return {
        minConfidence: base,
        confidenceProfile: profile,
        thresholdSource: 'MIN_CONFIDENCE',
        paperConfidenceOverrideEligible: true,
        paperConfidenceOverrideReason: 'spreadhunter_override_config_invalid',
      };
    }

    return {
      minConfidence: Math.min(base, paperMin),
      confidenceProfile: profile,
      thresholdSource: 'SPREADHUNTER_MIN_CONFIDENCE_PAPER',
      paperConfidenceOverrideEligible: true,
      paperConfidenceOverrideReason: 'spreadhunter_capital_velocity',
    };
  }

  riskDetails(signal) {
    if (!signal) return { signalPresent: false };

    const minOrderUsd = this.minOrderUsdForSignal(signal);
    const matchingOrders = this.portfolio.findOpenOrdersBySignal(signal);
    const replaceSellQty = this.config.openOrderReplaceEnabled
      ? matchingOrders.reduce((sum, { order }) => {
        if (order.side !== 'sell' || !Number.isFinite(order.price) || order.price <= 0) return sum;
        return sum + order.remainingUsd() / order.price;
      }, 0)
      : 0;
    const currentPosQty = this.portfolio.position(signal.tokenId);
    const availableSellQty = this.portfolio.availablePositionQty(signal.tokenId) + replaceSellQty;
    const exposureBreakdown = this.exposureBreakdown(signal);
    const totalExposureUsd = exposureBreakdown.riskTotalExposureUsd;
    const marketExposureUsd = this.portfolio.marketExposureUsd(signal.marketId, this.portfolio.markPricesSnapshot());
    const currentPosUsd = Number.isFinite(signal.price) ? currentPosQty * signal.price : NaN;
    const drawdownPct = this.portfolio.getDrawdownPct();
    const confidenceThreshold = this.confidenceThreshold(signal);
    const minSignalEdge = this.minSignalEdgeForSignal(signal);
    const bucketState = this.exposureBucketState(signal, exposureBreakdown);

    return {
      strategy: signal.strategy || null,
      side: signal.side || null,
      tokenId: signal.tokenId || null,
      price: Number(signal.price),
      sizeUsd: Number(signal.sizeUsd),
      minOrderUsd,
      expectedEdge: Number(signal.expectedEdge),
      minSignalEdge,
      confidence: Number(signal.confidence),
      minConfidence: confidenceThreshold.minConfidence,
      configuredMinConfidence: this.config.minConfidence,
      confidenceProfile: confidenceThreshold.confidenceProfile,
      thresholdSource: confidenceThreshold.thresholdSource,
      paperConfidenceOverrideEligible: confidenceThreshold.paperConfidenceOverrideEligible,
      gabagoolConfidenceMode: confidenceThreshold.gabagoolConfidenceMode || null,
      configuredGabagoolMinConfidence: confidenceThreshold.configuredGabagoolMinConfidence,
      configuredGabagoolMinConfidenceLive: confidenceThreshold.configuredGabagoolMinConfidenceLive,
      ...(confidenceThreshold.paperConfidenceOverrideReason
        ? { paperConfidenceOverrideReason: confidenceThreshold.paperConfidenceOverrideReason }
        : {}),
      availableCash: this.portfolio.availableCash(),
      currentPositionQty: currentPosQty,
      availableSellQty,
      currentPositionUsd: currentPosUsd,
      totalExposureUsd,
      rawTotalExposureUsd: Number(exposureBreakdown.rawTotalExposureUsd || totalExposureUsd),
      staleExposureUsd: Number(exposureBreakdown.staleUntradeablePositionExposureUsd || 0),
      tradableExposureUsd: Number(exposureBreakdown.tradablePositionExposureUsd || 0),
      dustExposureUsd: Number(exposureBreakdown.dustPositionExposureUsd || 0),
      staleExposureCount: Number(exposureBreakdown.staleUntradeablePositionCount || 0),
      tradableExposureCount: Number(exposureBreakdown.tradablePositionCount || 0),
      dustExposureCount: Number(exposureBreakdown.dustPositionCount || 0),
      paperEntryExposureExclusionActive: exposureBreakdown.paperEntryExposureExclusionActive === true,
      paperEntryExposureExclusionUsd: Number(exposureBreakdown.paperEntryExposureExclusionUsd || 0),
      ...exposureBreakdown,
      ...bucketState,
      marketExposureUsd,
      maxMarketExposureUsd: this.config.maxMarketExposureUsd,
      maxPositionUsdPerAsset: this.config.maxPositionUsdPerAsset,
      totalOpenOrderUsd: this.portfolio.openOrderExposureUsd(),
      maxTotalOpenOrderUsd: this.config.maxTotalOpenOrderUsd,
      openOrders: this.portfolio.openOrders.size,
      maxOpenOrders: this.config.maxOpenOrders,
      drawdownPct,
      maxDrawdownPct: this.config.maxDrawdownPct,
    };
  }

  block(signal, reason, extra = {}) {
    this.lastBlockReason = reason;
    this.lastBlockDetails = {
      ...this.riskDetails(signal),
      drawdownGateActive: this.portfolio.getDrawdownPct() > this.config.maxDrawdownPct,
      paperProbationActive: signal?.metadata?.paperProbation?.active === true,
      probationAdmission: signal?.metadata?.paperProbation?.admissionReason || null,
      paperProbationTrigger: signal?.metadata?.paperProbation?.trigger || null,
      finalBlockerAfterProbation: signal?.metadata?.paperProbation?.active === true ? reason : null,
      ...extra,
    };
    this.diagnostics?.record({
      strategy: signal?.strategy,
      scorePassed: Boolean(signal?.metadata?.consensus?.score >= this.config.consensusThreshold),
      blockReason: reason,
    });
    return null;
  }

  evaluate(signal) {
    this.lastBlockReason = null;
    this.lastBlockDetails = null;
    if (!signal) return this.block(signal, 'invalid_signal');
    if (!['buy', 'sell'].includes(signal.side)) return this.block(signal, 'invalid_side');
    if (!Number.isFinite(signal.price) || signal.price <= 0 || signal.price >= 1) return this.block(signal, 'invalid_price');
    const minOrderUsd = this.minOrderUsdForSignal(signal);
    if (!Number.isFinite(signal.sizeUsd) || signal.sizeUsd <= 0 || signal.sizeUsd < minOrderUsd) return this.block(signal, 'invalid_size', { minOrderUsd });

    if (this.portfolio.openOrders.size >= this.config.maxOpenOrders) return this.block(signal, 'max_open_orders');

    const isProtectiveExit = ['InventoryExit', 'StopLossExit', 'TakeProfitExit'].includes(signal.strategy);
    const minSignalEdge = this.minSignalEdgeForSignal(signal);
    if (!isProtectiveExit && signal.expectedEdge < minSignalEdge) return this.block(signal, 'edge_below_min', { minSignalEdge });
    const confidenceThreshold = this.confidenceThreshold(signal);
    if (
      !isProtectiveExit &&
      isGabagoolStrategy(signal) &&
      Number.isFinite(Number(signal.confidence)) &&
      Number(signal.confidence) < this.config.minConfidence
    ) {
      const floorStatus = Number(signal.confidence) >= confidenceThreshold.minConfidence ? 'ALLOW' : 'BLOCK';
      const floorMessage = [
        `[GABAGOOL CONFIDENCE FLOOR ${floorStatus}]`,
        signal.strategy,
        String(signal.side || '').toUpperCase() || 'UNKNOWN',
        shortId(signal.tokenId),
        `expectedEdge=${cleanLogValue(signal.expectedEdge)}`,
        `confidence=${cleanLogValue(signal.confidence)}`,
        `minConfidence=${cleanLogValue(confidenceThreshold.minConfidence)}`,
        `globalMinConfidence=${cleanLogValue(this.config.minConfidence)}`,
        `gabagoolMode=${confidenceThreshold.gabagoolConfidenceMode || 'paper'}`,
        `gabagoolPaperMin=${cleanLogValue(this.config.gabagoolMinConfidence)}`,
        `gabagoolLiveMin=${cleanLogValue(this.config.gabagoolMinConfidenceLive)}`,
        `reason=${confidenceThreshold.paperConfidenceOverrideReason || 'not_applicable'}`,
      ].join(' ');
      info(floorMessage);
    }
    if (!isProtectiveExit && signal.confidence < confidenceThreshold.minConfidence) {
      return this.block(signal, 'confidence_below_min', confidenceThreshold);
    }

    const matchingOrders = this.portfolio.findOpenOrdersBySignal(signal);
    const replaceCreditUsd = this.config.openOrderReplaceEnabled
      ? matchingOrders.reduce((sum, { order }) => sum + order.remainingUsd(), 0)
      : 0;
    const replaceSellQty = this.config.openOrderReplaceEnabled
      ? matchingOrders.reduce((sum, { order }) => {
        if (order.side !== 'sell' || !Number.isFinite(order.price) || order.price <= 0) return sum;
        return sum + order.remainingUsd() / order.price;
      }, 0)
      : 0;

    const currentPosQty = this.portfolio.position(signal.tokenId);
    const currentPosUsd = currentPosQty * signal.price;

    if (signal.side === 'buy') {
      const openUsd = this.portfolio.openOrderExposureUsd();
      if (openUsd + signal.sizeUsd > this.config.maxTotalOpenOrderUsd) return this.block(signal, 'max_total_open_order_usd');

      const exposureBreakdown = this.exposureBreakdown(signal);
      if (exposureBreakdown.wouldTotalExposureUsd > this.config.maxTotalExposureUsd) {
        return this.block(signal, 'max_total_exposure', exposureBreakdown);
      }
      const bucketState = this.exposureBucketState(signal, exposureBreakdown);
      if (
        bucketState.strategyBucketCapUsd > 0 &&
        bucketState.strategyBucketWouldExposureUsd > bucketState.strategyBucketCapUsd
      ) {
        const blockReason = bucketState.strategyBucket === 'btc'
          ? 'btc_bucket_exposure'
          : 'standard_bucket_exposure';
        if (bucketState.strategyBucket === 'btc') {
          this.logBtcBucketFull(
            Number(bucketState.strategyBucketExposureUsd || 0) > 0 ? 'prioritize_exit' : 'block_new_entry',
            bucketState,
            { tokenId: signal.tokenId, sizeUsd: signal.sizeUsd }
          );
        }
        return this.block(signal, blockReason, {
          ...exposureBreakdown,
          ...bucketState,
        });
      }

      const mktEx = this.portfolio.marketExposureUsd(signal.marketId, this.portfolio.markPricesSnapshot());
      if (mktEx + signal.sizeUsd > this.config.maxMarketExposureUsd) return this.block(signal, 'max_market_exposure');

      if (this.portfolio.availableCash() + replaceCreditUsd < signal.sizeUsd) return this.block(signal, 'cash_cap');
      if (currentPosUsd + signal.sizeUsd > this.config.maxPositionUsdPerAsset) return this.block(signal, 'max_position_per_asset');
    }

    if (signal.side === 'sell') {
      const availableQty = this.portfolio.availablePositionQty(signal.tokenId) + replaceSellQty;
      if (availableQty <= 0) return this.block(signal, 'no_available_position', { availableSellQty: availableQty });
      const maxSellUsd = availableQty * signal.price;
      signal.sizeUsd = Math.min(signal.sizeUsd, maxSellUsd);
      signal.metadata = {
        ...(signal.metadata || {}),
        availableSellQtyOverride: availableQty,
      };
      const reducesExistingExposure = this.sellReducesExistingExposure(signal, availableQty);
      const requestedSellUsdBeforeDustBatch = Number(signal.sizeUsd || 0);
      const remainingValueAfterSellUsd = Math.max(0, maxSellUsd - signal.sizeUsd);
      if (
        reducesExistingExposure &&
        remainingValueAfterSellUsd > 0 &&
        remainingValueAfterSellUsd < this.config.minOrderUsd
      ) {
        signal.sizeUsd = maxSellUsd;
        signal.metadata = {
          ...(signal.metadata || {}),
          dust_exit_batch: true,
          dust_exit_requested_below_min_usd: requestedSellUsdBeforeDustBatch < this.config.minOrderUsd,
          dust_exit_batch_remaining_before_usd: remainingValueAfterSellUsd,
        };
      }
      const sellDustExitPolicy = gabagoolDustExitPolicy(signal, this.portfolio, this.config);
      const sellReduceOnlyPolicy = reduceOnlyPaperExitPolicy(signal, this.portfolio, this.config);
      const sellMinOrderUsd = sellDustExitPolicy.eligible
        ? sellDustExitPolicy.minDustExitUsd
        : sellReduceOnlyPolicy.eligible
          ? sellReduceOnlyPolicy.minReduceOnlyExitUsd
          : minOrderUsd;
      if (signal.sizeUsd < sellMinOrderUsd) {
        return this.block(signal, 'sell_size_below_min', {
          availableSellQty: availableQty,
          maxSellUsd,
          minOrderUsd: sellMinOrderUsd,
        });
      }
      const gabagoolReduceOnlyExitMode = isGabagoolStrategy(signal) && reducesExistingExposure
        ? String(signal.metadata?.gabagool?.exitMode || signal.metadata?.exitMode || '')
        : '';
      const gabagoolReduceOnlyExitAllowed = (
        gabagoolReduceOnlyExitMode === 'loss_guard_reduce_only' ||
        gabagoolReduceOnlyExitMode === 'exposure_cap_reduce_only'
      );
      if (gabagoolReduceOnlyExitAllowed) {
        signal.metadata = {
          ...(signal.metadata || {}),
          exitMode: gabagoolReduceOnlyExitMode,
          loss_guard_reduce_exit_allowed: gabagoolReduceOnlyExitMode === 'loss_guard_reduce_only',
          exposure_cap_reduce_exit_allowed: gabagoolReduceOnlyExitMode === 'exposure_cap_reduce_only',
          risk_exposure_reduce_allowed: true,
        };
        info(
          `[GABAGOOL REDUCE EXIT ALLOWED] exitMode=${gabagoolReduceOnlyExitMode} ` +
          `loss_guard_reduce_exit_allowed=${gabagoolReduceOnlyExitMode === 'loss_guard_reduce_only' ? 'true' : 'false'} ` +
          `exposure_cap_reduce_exit_allowed=${gabagoolReduceOnlyExitMode === 'exposure_cap_reduce_only' ? 'true' : 'false'} ` +
          `risk_exposure_reduce_allowed=true token=${shortId(signal.tokenId)} ` +
          `sizeUsd=${cleanLogValue(signal.sizeUsd)} availableSellQty=${cleanLogValue(availableQty)}`
        );
      }
      const dustExitPolicy = sellDustExitPolicy;
      if (dustExitPolicy.eligible && signal.sizeUsd < this.config.minOrderUsd) {
        signal.metadata = {
          ...(signal.metadata || {}),
          dust_exit_allowed: true,
        };
        info(
          `[GABAGOOL DUST EXIT ALLOWED] dust_exit_allowed=true token=${shortId(signal.tokenId)} ` +
          `sizeUsd=${cleanLogValue(signal.sizeUsd)} minOrderUsd=${cleanLogValue(this.config.minOrderUsd)} ` +
          `dustFloorUsd=${cleanLogValue(dustExitPolicy.minDustExitUsd)}`
        );
      }
      const exposureBreakdown = this.exposureBreakdown(signal);
      const bucketState = this.exposureBucketState(signal, exposureBreakdown);
      if (bucketState.strategyBucket === 'btc' && reducesExistingExposure) {
        this.logBtcBucketFull('reduce_only', bucketState, {
          tokenId: signal.tokenId,
          sizeUsd: signal.sizeUsd,
        });
      }
      if (
        reducesExistingExposure &&
        exposureBreakdown.riskTotalExposureUsd >= this.config.maxTotalExposureUsd
      ) {
        signal.metadata = {
          ...(signal.metadata || {}),
          risk_exposure_reduce_allowed: true,
        };
        info(
          `[RISK EXPOSURE REDUCE ALLOWED] strategy=${signal.strategy || 'UNKNOWN'} ` +
          `risk_exposure_reduce_allowed=true token=${shortId(signal.tokenId)} ` +
          `sizeUsd=${cleanLogValue(signal.sizeUsd)} riskTotalExposureUsd=${cleanLogValue(exposureBreakdown.riskTotalExposureUsd)} ` +
          `maxTotalExposureUsd=${cleanLogValue(this.config.maxTotalExposureUsd)}`
        );
      }
    }

    if (this.portfolio.getDrawdownPct() > this.config.maxDrawdownPct) {
      if (this.config.enableLiveTrading !== true && this.config.paperActionBurnInEnabled === true) {
        this.portfolio.markBurnInFailedByDrawdown({
          reason: 'drawdown_limit',
          drawdownPct: this.portfolio.getDrawdownPct(),
          closedPnl: this.portfolio.closedPnl,
        });
      }
      return this.block(signal, 'drawdown_limit', {
        burnInLifecycleStatus: this.portfolio.burnInState?.lifecycleStatus || null,
        burnInFreshStateRequired: this.portfolio.burnInState?.freshStateRequired === true,
        recommendedFreshStateFile: this.portfolio.burnInState?.recommendedFreshStateFile || this.portfolio.recommendedFreshBurnInStateFile?.(),
      });
    }

    return signal;
  }
}

// =========================
// PAPER EXECUTION ENGINE
// =========================

class PaperExecutionEngine {
  constructor(config, portfolio, cache, diagnostics = null) {
    this.config = config;
    this.portfolio = portfolio;
    this.cache = cache;
    this.diagnostics = diagnostics;
    this.lastPlacementDecision = null;
    this.replaceSkipBatch = {
      windowStartedAt: Date.now(),
      ageSkips: 0,
      samePriceSkips: 0,
      tokenIds: new Set(),
    };
  }

  findComparableOpenOrders(signal) {
    if (!this.config.dedupeOpenOrders || !signal) return [];
    return this.portfolio.findOpenOrdersBySignal(signal);
  }

  shouldReplaceOpenOrder(existingOrder, signal, book) {
    if (!this.config.openOrderReplaceEnabled) return { replace: false, reason: 'disabled' };

    const tick = book?.tickSize || signal.metadata?.tickSize || 0.01;
    const minTicks = Math.max(1, this.config.openOrderReplaceMinPriceDeltaTicks || 1);
    const minPriceDelta = tick * minTicks;
    const priceDelta = Math.abs(Number(signal.price) - Number(existingOrder.price));
    const ageMs = Date.now() - existingOrder.createdAt;
    const epsilon = this.replacementEpsilon(signal, book);
    const samePrice = priceDelta < epsilon;
    const minAgeMs = Math.max(0, this.config.openOrderReplaceMinAgeMs || 0);
    const forceRefreshMs = Math.max(minAgeMs, this.config.openOrderReplaceForceRefreshMs || 0);

    if (ageMs < minAgeMs) {
      return { replace: false, reason: 'age', ageMs, minAgeMs, priceDelta, epsilon, samePrice };
    }

    if (samePrice && !this.config.openOrderReplaceAllowSamePrice && ageMs < forceRefreshMs) {
      return { replace: false, reason: 'same_price', ageMs, minAgeMs, forceRefreshMs, priceDelta, epsilon, samePrice };
    }

    const legacyReplace = priceDelta >= minPriceDelta || ageMs >= this.config.openOrderReplaceAfterMs;
    const forceRefresh = samePrice && ageMs >= forceRefreshMs;
    const meaningfulPriceChange = !samePrice && priceDelta >= Math.max(epsilon, minPriceDelta);

    return {
      replace: forceRefresh || meaningfulPriceChange || legacyReplace,
      reason: forceRefresh ? 'force_refresh' : meaningfulPriceChange ? 'price_change' : legacyReplace ? 'legacy' : 'duplicate',
      ageMs,
      minAgeMs,
      forceRefreshMs,
      priceDelta,
      epsilon,
      samePrice,
    };
  }

  replacementEpsilon(signal, book) {
    const base = Math.max(0, Number(this.config.openOrderReplacePriceEpsilon) || 0);
    if (!this.config.orderReplaceDynamicEpsilonEnabled || !book) return base;

    const tick = Number(book.tickSize || signal.metadata?.tickSize || 0.01);
    const spread = Number(book.spread);
    const spreadComponent = Number.isFinite(spread) ? spread * 0.05 : 0;
    const tickComponent = Number.isFinite(tick) && tick > 0 ? tick * 0.5 : 0;
    return Math.max(base, spreadComponent, tickComponent);
  }

  recordReplaceSkip(reason, signal, decision, existingOrder = null) {
    const now = Date.now();
    const batchMs = Math.max(0, this.config.orderReplaceSkipLogBatchMs || 0);

    if (batchMs <= 0 || now - this.replaceSkipBatch.windowStartedAt >= batchMs) {
      if (this.replaceSkipBatch.ageSkips || this.replaceSkipBatch.samePriceSkips) {
        info(
          `[ORDER REPLACE SKIP SUMMARY] ageSkips=${this.replaceSkipBatch.ageSkips} ` +
          `samePriceSkips=${this.replaceSkipBatch.samePriceSkips} tokenCount=${this.replaceSkipBatch.tokenIds.size} ` +
          `windowSec=${Math.round(batchMs / 1000)}`
        );
      }
      this.replaceSkipBatch = { windowStartedAt: now, ageSkips: 0, samePriceSkips: 0, tokenIds: new Set() };
    }

    if (reason === 'age') this.replaceSkipBatch.ageSkips += 1;
    if (reason === 'same_price') this.replaceSkipBatch.samePriceSkips += 1;
    if (signal?.tokenId) this.replaceSkipBatch.tokenIds.add(String(signal.tokenId));

    if (!this.config.debugReplaceSkips) return;

    if (reason === 'age') {
      info(
        `[ORDER REPLACE SKIP AGE] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
        `age=${Math.round((decision.ageMs || 0) / 1000)}s minAge=${Math.round((decision.minAgeMs || 0) / 1000)}s`
      );
    } else if (reason === 'same_price') {
      info(
        `[ORDER REPLACE SKIP SAME PRICE] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
        `old=${fmtPrice(existingOrder?.price)} new=${fmtPrice(signal.price)} ` +
        `age=${Math.round((decision.ageMs || 0) / 1000)}s epsilon=${decision.epsilon}`
      );
    }
  }

  minOrderUsdForPlacement(signal) {
    const dustExitPolicy = gabagoolDustExitPolicy(signal, this.portfolio, this.config);
    if (dustExitPolicy.eligible) {
      return dustExitPolicy.minDustExitUsd;
    }
    const reduceOnlyExitPolicy = reduceOnlyPaperExitPolicy(signal, this.portfolio, this.config);
    if (reduceOnlyExitPolicy.eligible) {
      return reduceOnlyExitPolicy.minReduceOnlyExitUsd;
    }
    if (isGabagoolStrategy(signal) && this.config.enableGabagoolBtcImitation) {
      const gabagoolCap = Number(this.config.gabagoolMaxPaperOrderUsd);
      if (Number.isFinite(gabagoolCap) && gabagoolCap > 0) {
        return Math.max(0.5, Math.min(this.config.minOrderUsd, gabagoolCap));
      }
    }
    return this.config.minOrderUsd;
  }

  minFillUsdForOrder(order) {
    const dustExitPolicy = gabagoolDustExitPolicy(order?.signal || order, this.portfolio, this.config);
    if (dustExitPolicy.eligible) {
      return dustExitPolicy.minDustExitUsd;
    }
    const reduceOnlyExitPolicy = reduceOnlyPaperExitPolicy(order?.signal || order, this.portfolio, this.config);
    if (reduceOnlyExitPolicy.eligible) {
      return reduceOnlyExitPolicy.minReduceOnlyExitUsd;
    }
    return this.config.minFillUsd;
  }

  setPlacementDecision(signal, decision = {}) {
    this.lastPlacementDecision = {
      ts: Date.now(),
      strategy: signal?.strategy || null,
      tokenId: signal?.tokenId ? String(signal.tokenId) : null,
      marketId: signal?.marketId ? String(signal.marketId) : null,
      side: signal?.side ? String(signal.side).toLowerCase() : null,
      price: Number.isFinite(Number(signal?.price)) ? Number(signal.price) : null,
      sizeUsd: Number.isFinite(Number(signal?.sizeUsd)) ? Number(signal.sizeUsd) : null,
      placed: decision.placed === true,
      reason: decision.reason || null,
      detail: decision.detail || null,
      comparableOrders: Number.isFinite(Number(decision.comparableOrders)) ? Number(decision.comparableOrders) : 0,
    };
    return this.lastPlacementDecision;
  }

  recordRealismBlock(order, blockReason, audit = {}, now = Date.now()) {
    if (!order || !blockReason) return;
    if (
      order.lastRealismBlockReason === blockReason &&
      now - Number(order.lastRealismBlockAt || 0) < 30_000
    ) {
      return;
    }
    order.lastRealismBlockReason = blockReason;
    order.lastRealismBlockAt = now;
    this.portfolio.recordExecutionEvent('order_realism_block', {
      ...order,
      marketSlug: order.signal?.metadata?.marketSlug,
      outcome: order.signal?.metadata?.outcome,
      expectedEdge: order.signal?.expectedEdge,
      confidence: order.signal?.confidence,
      timeToFillSec: Math.max(0, (now - order.createdAt) / 1000),
      fillDelayMs: Math.max(0, now - order.createdAt),
      reason: blockReason,
      ...audit,
    });
  }

  place(signal, book) {
    this.lastPlacementDecision = null;
    if (!signal) {
      this.setPlacementDecision(signal, { placed: false, reason: 'final_gate_block', detail: 'missing_signal' });
      return false;
    }
    if (!signal.tokenId) {
      this.setPlacementDecision(signal, { placed: false, reason: 'no_valid_token' });
      return false;
    }
    if (!Number.isFinite(Number(signal.price)) || Number(signal.price) <= 0 || Number(signal.price) >= 1) {
      this.setPlacementDecision(signal, { placed: false, reason: 'no_valid_price' });
      return false;
    }
    const minOrderUsd = this.minOrderUsdForPlacement(signal);
    if (!Number.isFinite(Number(signal.sizeUsd)) || Number(signal.sizeUsd) < minOrderUsd) {
      this.setPlacementDecision(signal, { placed: false, reason: 'order_size_below_min' });
      return false;
    }

    const comparableOrders = this.findComparableOpenOrders(signal);
    const maxComparable = Math.max(1, this.config.maxOpenOrdersPerTokenSideStrategy || 1);

    if (comparableOrders.length >= maxComparable) {
      const decisions = comparableOrders.map(({ id, order }) => ({
        id,
        order,
        decision: this.shouldReplaceOpenOrder(order, signal, book),
      }));
      const replaceable = decisions.filter(({ decision }) => decision.replace);

      if (replaceable.length === 0) {
        const decision = decisions[0]?.decision || {};
        if (decision.reason === 'age') {
          this.recordReplaceSkip('age', signal, decision, decisions[0]?.order);
        } else if (decision.reason === 'same_price') {
          this.recordReplaceSkip('same_price', signal, decision, decisions[0]?.order);
        } else {
          info(`[ORDER SKIP DUPLICATE] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} @ ${fmtPrice(signal.price)} [${signal.strategy}] active=${comparableOrders.length}`);
        }
        this.portfolio.recordExecutionEvent('duplicate_skip', signal);
        this.diagnostics?.record({
          strategy: signal.strategy,
          scorePassed: true,
          blockReason: 'order_skip_duplicate',
        });
        this.setPlacementDecision(signal, {
          placed: false,
          reason: 'duplicate_order',
          detail: decision.reason || 'duplicate',
          comparableOrders: comparableOrders.length,
        });
        return false;
      }

      for (const { id, order } of comparableOrders) {
        if ((order.filledUsd || 0) <= 0) {
          this.portfolio.recordExecutionEvent('order_replaced_no_fill', {
            ...order,
            reason: 'replacement',
            quality: order.signal?.metadata?.sophieExecution?.sophieExecutionQuality,
            distanceFromTouch: order.signal?.metadata?.sophieExecution?.distanceFromTouch,
            predictedFillProbability: order.signal?.metadata?.sophieExecution?.predictedFillProbability,
          });
        }
        this.portfolio.cancelOrder(id);
        this.portfolio.recordExecutionEvent('order_replacement', signal);
        info(`[ORDER REPLACE] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} old=${fmtPrice(order.price)} new=${fmtPrice(signal.price)} age=${Math.round((Date.now() - order.createdAt) / 1000)}s [${signal.strategy}]`);
      }
    }

    try {
      const placementBestBid = Number.isFinite(Number(book?.bestBid)) ? Number(book.bestBid) : null;
      const placementBestAsk = Number.isFinite(Number(book?.bestAsk)) ? Number(book.bestAsk) : null;
      const placementAudit = {
        placedAtTs: Date.now(),
        bestBidAtPlacement: placementBestBid,
        bestAskAtPlacement: placementBestAsk,
        bookAgeMs: Number.isFinite(Number(book?.cachedAt)) ? Math.max(0, Date.now() - Number(book.cachedAt)) : null,
        orderPrice: Number(signal.price),
        wasExecutableAtPlacement: bestBidAskExecutable(signal.side, signal.price, placementBestBid, placementBestAsk),
      };
      signal.metadata = {
        ...(signal.metadata || {}),
        paperPlacementAudit: placementAudit,
      };
      const order = new PaperOrder(signal);
      this.portfolio.addOrder(order);
      this.portfolio.recordExecutionEvent('order_placed', signal);
      this.portfolio.recordGhostOrder(signal, book);
      info(`[ORDER] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} @ ${fmtPrice(signal.price)} size=$${signal.sizeUsd.toFixed(2)} [${signal.strategy}]`);
      if (isStandardPaperStrategy(signal.strategy)) {
        info(
          `[STANDARD ORDER] strategy=${signal.strategy} side=${signal.side.toUpperCase()} token=${shortId(signal.tokenId)} ` +
          `price=${fmtPrice(signal.price)} sizeUsd=${cleanLogValue(signal.sizeUsd)}`
        );
      }
      this.diagnostics?.record({
        strategy: signal.strategy,
        scorePassed: true,
        blockReason: 'order_placed',
      });
      this.setPlacementDecision(signal, { placed: true, reason: 'order_placed' });
      return true;
    } catch (error) {
      warn(
        `[PAPER ORDER BLOCK] ${String(signal.side || '').toUpperCase()} ${shortId(signal.tokenId)} ` +
        `strategy=${signal.strategy} reason=unknown_placement_block error=${error.message}`
      );
      this.setPlacementDecision(signal, {
        placed: false,
        reason: 'unknown_placement_block',
        detail: error.message,
      });
      return false;
    }
  }

  processOpenOrders() {
    const now = Date.now();

    for (const [orderId, order] of [...this.portfolio.openOrders.entries()]) {
      if (order.isExpired()) {
        if ((order.filledUsd || 0) <= 0) {
          this.portfolio.recordExecutionEvent('order_expired_no_fill', {
            ...order,
            reason: 'expired',
            quality: order.signal?.metadata?.sophieExecution?.sophieExecutionQuality,
            distanceFromTouch: order.signal?.metadata?.sophieExecution?.distanceFromTouch,
            predictedFillProbability: order.signal?.metadata?.sophieExecution?.predictedFillProbability,
          });
        }
        this.portfolio.cancelOrder(orderId);
        continue;
      }

      const book = this.cache.getBook(order.tokenId);
      if (!isBookComplete(book)) continue;
      this.portfolio.setMarkPrice(order.tokenId, book.midpoint);

      const fill = this.computeFill(order, book, now);
      const minFillUsd = this.minFillUsdForOrder(order);
      if (!fill || fill.canFill !== true) {
        if (fill?.blockReason) this.recordRealismBlock(order, fill.blockReason, fill, now);
        continue;
      }
      if (fill.fillUsd < minFillUsd) continue;

      order.lastRealismBlockReason = null;
      order.lastRealismBlockAt = 0;

      const fillSize = fill.fillUsd / fill.price;

      const fillDetails = this.portfolio.recordFill({
        tokenId: order.tokenId,
        marketId: order.marketId,
        marketSlug: order.signal?.metadata?.marketSlug,
        outcome: order.signal?.metadata?.outcome,
        side: order.side,
        price: fill.price,
        size: fillSize,
        strategy: order.strategy,
        ts: now,
        fillSource: fill.fillSource,
        fillDelayMs: fill.fillDelayMs,
        bookAgeMs: fill.bookAgeMs,
        bestBidAtPlacement: fill.bestBidAtPlacement,
        bestAskAtPlacement: fill.bestAskAtPlacement,
        bestBidAtFill: fill.bestBidAtFill,
        bestAskAtFill: fill.bestAskAtFill,
        orderPrice: fill.orderPrice,
        wasExecutableAtPlacement: fill.wasExecutableAtPlacement,
        wasExecutableAtFill: fill.wasExecutableAtFill,
        queueHaircutApplied: fill.queueHaircutApplied,
        slippageApplied: fill.slippageApplied,
        adverseSelectionBufferApplied: fill.adverseSelectionBufferApplied,
        fillInvalidReason: fill.fillInvalidReason,
      });
      const fillEventBase = {
        ...order,
        timeToFillSec: Math.max(0, (now - order.createdAt) / 1000),
        fillDelayMs: fill.fillDelayMs,
        filledUsd: fill.fillUsd,
        price: fill.price,
        sizeUsd: fill.fillUsd,
        marketSlug: order.signal?.metadata?.marketSlug,
        outcome: order.signal?.metadata?.outcome,
        expectedEdge: order.signal?.expectedEdge,
        confidence: order.signal?.confidence,
        fillSource: fill.fillSource,
        bookAgeMs: fill.bookAgeMs,
        bestBidAtPlacement: fill.bestBidAtPlacement,
        bestAskAtPlacement: fill.bestAskAtPlacement,
        bestBidAtFill: fill.bestBidAtFill,
        bestAskAtFill: fill.bestAskAtFill,
        orderPrice: fill.orderPrice,
        wasExecutableAtPlacement: fill.wasExecutableAtPlacement,
        wasExecutableAtFill: fill.wasExecutableAtFill,
        queueHaircutApplied: fill.queueHaircutApplied,
        slippageApplied: fill.slippageApplied,
        adverseSelectionBufferApplied: fill.adverseSelectionBufferApplied,
        trustedFill: fillDetails?.trustedFill,
        trustedPnl: fillDetails?.trustedPnl,
        fillInvalid: fillDetails?.fillInvalid,
        fillInvalidReason: fillDetails?.fillInvalidReason,
        trustedRealizedPnl: fillDetails?.trustedRealizedPnl,
        untrustedRealizedPnl: fillDetails?.untrustedRealizedPnl,
      };
      this.portfolio.recordExecutionEvent('fill', {
        ...fillEventBase,
      });
      let exitClassification = null;
      if (isBtcOracleStrategy(order.strategy)) {
        this.portfolio.recordExecutionEvent('gabagool_fill', {
          ...fillEventBase,
        });
        if (order.side === 'sell') {
          if (order.signal?.metadata?.gabagool?.exitMode === 'loss_guard_reduce_only') {
            this.portfolio.recordExecutionEvent('gabagool_loss_guard_exit_filled', {
              ...fillEventBase,
              marketSlug: order.signal?.metadata?.marketSlug,
              outcome: order.signal?.metadata?.outcome,
              side: order.side,
              price: fill.price,
              sizeUsd: fill.fillUsd,
              reason: 'loss_guard_reduce_only',
              exitMode: 'loss_guard_reduce_only',
            });
          }
          if (order.signal?.metadata?.gabagool?.exitMode === 'exposure_cap_reduce_only') {
            this.portfolio.recordExecutionEvent('gabagool_reduce_only_exit_filled', {
              ...fillEventBase,
              marketSlug: order.signal?.metadata?.marketSlug,
              outcome: order.signal?.metadata?.outcome,
              side: order.side,
              price: fill.price,
              sizeUsd: fill.fillUsd,
              reason: order.signal?.metadata?.gabagool?.exitTrigger || 'exposure_cap_reduce_only',
              exitMode: 'exposure_cap_reduce_only',
            });
          }
          let exitClassification = classifyGabagoolExit({
            signal: order.signal,
            filledUsd: fill.fillUsd,
            avgEntryPrice: fillDetails?.avgEntryPrice,
            sellPrice: fill.price,
            realizedPnl: fillDetails?.realizedPnl,
            positionQtyBefore: fillDetails?.positionQtyBefore,
            positionQtyAfter: fillDetails?.positionQtyAfter,
            minOrderUsd: Number(this.config.minOrderUsd || 0),
          });
            if (
              String(order?.side || '').toLowerCase() === 'sell' &&
              (
                order.signal?.metadata?.dust_exit_allowed === true ||
                order.signal?.metadata?.dust_exit_requested_below_min_usd === true
              )
            ) {
              exitClassification = 'dust_exit';
            }

          this.bot?.onGabagoolSellFill?.({
            order,
            fillDetails,
            exitClassification,
            now,
          });
          if (
            order.signal?.metadata?.dust_exit_allowed === true ||
            order.signal?.metadata?.dust_exit_requested_below_min_usd === true
          ) {
            this.portfolio.recordExecutionEvent('gabagool_dust_exit_allowed', {
              ...order,
              marketSlug: order.signal?.metadata?.marketSlug,
              outcome: order.signal?.metadata?.outcome,
              side: order.side,
              price: fill.price,
              sizeUsd: fill.fillUsd,
              reason: order.signal?.metadata?.dust_exit_requested_below_min_usd === true ? 'dust_exit_batch_allowed' : 'dust_exit_allowed',
              dustExitBatch: order.signal?.metadata?.dust_exit_requested_below_min_usd === true,
            });
          }
          info(
            `[GABAGOOL EXIT] class=${exitClassification} avgEntry=${fmtPrice(fillDetails?.avgEntryPrice)} ` +
            `sellPrice=${fmtPrice(fill.price)} realizedPnl=${fmtMoney(fillDetails?.realizedPnl)} ` +
            `qtyBefore=${fmtCount(fillDetails?.positionQtyBefore, 4)} qtyAfter=${fmtCount(fillDetails?.positionQtyAfter, 4)} ` +
            `token=${shortId(order.tokenId)} fillSource=${fill.fillSource} trustedPnl=${fillDetails?.trustedPnl === true ? 'true' : 'false'}`
          );
          this.portfolio.recordExecutionEvent('gabagool_exit', {
            ...fillEventBase,
            reason: exitClassification,
            avgEntryPrice: fillDetails?.avgEntryPrice,
            realizedPnl: fillDetails?.realizedPnl,
            positionQtyBefore: fillDetails?.positionQtyBefore,
            positionQtyAfter: fillDetails?.positionQtyAfter,
          });
          const remainingQty = this.portfolio.position(order.tokenId);
          const remainingValueUsd = Number.isFinite(Number(book?.bestBid)) ? remainingQty * Number(book.bestBid) : 0;
          if (remainingQty > 0 && remainingValueUsd > 0 && remainingValueUsd < this.config.minOrderUsd) {
            this.portfolio.recordExecutionEvent('gabagool_dust_position_remaining', {
              ...order,
              marketSlug: order.signal?.metadata?.marketSlug,
              outcome: order.signal?.metadata?.outcome,
              side: order.side,
              price: book.bestBid,
              sizeUsd: remainingValueUsd,
              reason: 'dust_position_remaining',
              source: 'post_exit_fill_remaining_inventory',
              positionQty: remainingQty,
              availableSellQty: remainingQty,
              currentValueUsd: remainingValueUsd,
              roundedExitSizeUsd: Math.round(remainingValueUsd * 100) / 100,
            });
            warn(
              `[GABAGOOL DUST POSITION REMAINING] token=${shortId(order.tokenId)} ` +
              `positionQty=${fmtCount(remainingQty, 6)} currentValueUsd=${fmtMoney(remainingValueUsd)} ` +
              `dust_position_remaining=true`
            );
          }
        }
      }

      order.filledUsd += fill.fillUsd;

      info(
        `[FILL] ${order.side.toUpperCase()} ${shortId(order.tokenId)} @ ${fmtPrice(fill.price)} ` +
        `usd=$${fill.fillUsd.toFixed(2)} fillSource=${fill.fillSource} fillDelayMs=${Math.round(fill.fillDelayMs || 0)} ` +
        `trustedPnl=${fillDetails?.trustedPnl === true ? 'true' : 'false'} [${order.strategy}]`
      );
      if (isStandardPaperStrategy(order.strategy)) {
        info(
          `[STANDARD FILL] strategy=${order.strategy} side=${order.side.toUpperCase()} token=${shortId(order.tokenId)} ` +
          `price=${fmtPrice(fill.price)} filledUsd=${cleanLogValue(fill.fillUsd)} fillSource=${fill.fillSource} ` +
          `trustedPnl=${fillDetails?.trustedPnl === true ? 'true' : 'false'}`
        );
      }
      if (
        String(order.side || '').toLowerCase() === 'sell' &&
        (order.signal?.metadata?.dust_exit_allowed === true || order.signal?.metadata?.dust_exit_batch === true)
      ) {
        info(
          `[DUST EXIT] token=${shortId(order.tokenId)} qty=${fmtCount(fillSize, 6)} ` +
          `valueUsd=${fmtMoney(fill.fillUsd)} bid=${fmtPrice(fill.price)} action=filled`
        );
      }
      this.bot?.updateStandardChurnCooldownOnFill?.({
        order,
        fillDetails,
        fillPrice: fill.price,
        now,
        book,
      });

      if (this.paperUpdates && isGabagoolStrategy(order)) {
        if (order.side === 'sell') {
          const remainingQty = Number(fillDetails?.positionQtyAfter || 0);
          const remainingValueUsd = Number.isFinite(Number(book?.bestBid)) ? remainingQty * Number(book.bestBid) : 0;
          const tradeCompleted = remainingQty <= 1e-9 || (remainingValueUsd > 0 && remainingValueUsd < this.config.minOrderUsd);
          if (tradeCompleted) {
            this.paperUpdates.record('trade_summary', {
              strategy: order.strategy,
              marketSlug: order.signal?.metadata?.marketSlug,
              marketQuestion: order.signal?.metadata?.marketQuestion,
              tokenId: order.tokenId,
              outcome: order.signal?.metadata?.outcome,
              side: order.side,
              price: fill.price,
              sizeUsd: fill.fillUsd,
              expectedEdge: order.signal?.expectedEdge,
              confidence: order.signal?.confidence,
              avgEntryPrice: fillDetails?.avgEntryPrice,
              realizedPnl: fillDetails?.realizedPnl,
              exitClassification,
              fillSource: fill.fillSource,
              fillDelayMs: fill.fillDelayMs,
              bookAgeMs: fill.bookAgeMs,
              bestBidAtPlacement: fill.bestBidAtPlacement,
              bestAskAtPlacement: fill.bestAskAtPlacement,
              bestBidAtFill: fill.bestBidAtFill,
              bestAskAtFill: fill.bestAskAtFill,
              orderPrice: fill.orderPrice,
              wasExecutableAtPlacement: fill.wasExecutableAtPlacement,
              wasExecutableAtFill: fill.wasExecutableAtFill,
              queueHaircutApplied: fill.queueHaircutApplied,
              slippageApplied: fill.slippageApplied,
              adverseSelectionBufferApplied: fill.adverseSelectionBufferApplied,
              trustedPnl: fillDetails?.trustedPnl,
              sophieDecision: order.signal?.metadata?.sophieExecution?.qualityDecision || 'ADMIT',
              riskDecision: 'ADMIT',
              oracleEventKey: order.signal?.metadata?.gabagool?.oracleEventKey || null,
            });
          }
        } else {
          this.paperUpdates.record('fill', {
            strategy: order.strategy,
            marketSlug: order.signal?.metadata?.marketSlug,
            marketQuestion: order.signal?.metadata?.marketQuestion,
            tokenId: order.tokenId,
            outcome: order.signal?.metadata?.outcome,
            side: order.side,
            price: fill.price,
            sizeUsd: fill.fillUsd,
            expectedEdge: order.signal?.expectedEdge,
            confidence: order.signal?.confidence,
            fillSource: fill.fillSource,
            fillDelayMs: fill.fillDelayMs,
            bookAgeMs: fill.bookAgeMs,
            bestBidAtPlacement: fill.bestBidAtPlacement,
            bestAskAtPlacement: fill.bestAskAtPlacement,
            bestBidAtFill: fill.bestBidAtFill,
            bestAskAtFill: fill.bestAskAtFill,
            orderPrice: fill.orderPrice,
            wasExecutableAtPlacement: fill.wasExecutableAtPlacement,
            wasExecutableAtFill: fill.wasExecutableAtFill,
            queueHaircutApplied: fill.queueHaircutApplied,
            slippageApplied: fill.slippageApplied,
            adverseSelectionBufferApplied: fill.adverseSelectionBufferApplied,
            trustedPnl: fillDetails?.trustedPnl,
            sophieDecision: order.signal?.metadata?.sophieExecution?.qualityDecision || 'ADMIT',
            riskDecision: 'ADMIT',
            oracleEventKey: order.signal?.metadata?.gabagool?.oracleEventKey || null,
          });
        }
      }

      if (order.remainingUsd() < minFillUsd) {
        this.portfolio.cancelOrder(orderId);
      }

      if (now - order.createdAt > order.signal.maxHoldMs) {
        this.portfolio.cancelOrder(orderId);
      }
    }
  }

  computeFill(order, book, now = Date.now()) {
    if (!isBookComplete(book)) return null;

    const remainingUsd = order.remainingUsd();
    if (remainingUsd <= 0) return null;

    const placementAudit = order?.placementAudit || order?.signal?.metadata?.paperPlacementAudit || {};
    const bestBidAtPlacement = numericOrNull(placementAudit.bestBidAtPlacement);
    const bestAskAtPlacement = numericOrNull(placementAudit.bestAskAtPlacement);
    const bestBidAtFill = numericOrNull(book.bestBid);
    const bestAskAtFill = numericOrNull(book.bestAsk);
    const orderPrice = Number(order.price);
    const fillDelayMs = Math.max(0, now - Number(order.createdAt || now));
    const bookAgeMs = Number.isFinite(Number(book?.cachedAt)) ? Math.max(0, now - Number(book.cachedAt)) : null;
    const wasExecutableAtPlacement = placementAudit.wasExecutableAtPlacement === true
      ? true
      : bestBidAskExecutable(order.side, orderPrice, bestBidAtPlacement, bestAskAtPlacement);
    const wasExecutableAtFill = bestBidAskExecutable(order.side, orderPrice, bestBidAtFill, bestAskAtFill);
    const tick = Number(book.tickSize || order.signal?.metadata?.tickSize || 0.01);
    const touchEpsilon = Math.max(1e-9, tick / 2);
    const oppositeDepthUsd = order.side === 'buy'
      ? topDepthUsd(book.asks, 3)
      : topDepthUsd(book.bids, 3);

    let fillSource = 'unknown';
    if (wasExecutableAtPlacement) {
      fillSource = 'crossed_bid_ask';
    } else if (wasExecutableAtFill) {
      const touchFill = order.side === 'buy'
        ? Math.abs(Number(bestAskAtFill) - orderPrice) <= touchEpsilon
        : Math.abs(Number(bestBidAtFill) - orderPrice) <= touchEpsilon;
      const throughBuffer = order.side === 'buy'
        ? Number(bestAskAtFill) < orderPrice - Number(this.config.adverseSelectionBuffer || 0)
        : Number(bestBidAtFill) > orderPrice + Number(this.config.adverseSelectionBuffer || 0);
      fillSource = throughBuffer ? 'resting_queue' : touchFill ? 'touch_fill' : 'unknown';
    }

    const audit = {
      fillSource,
      fillDelayMs,
      bookAgeMs,
      bestBidAtPlacement,
      bestAskAtPlacement,
      bestBidAtFill,
      bestAskAtFill,
      orderPrice,
      wasExecutableAtPlacement,
      wasExecutableAtFill,
      queueHaircutApplied: 0,
      slippageApplied: 0,
      adverseSelectionBufferApplied: 0,
      fillInvalidReason: null,
      blockReason: null,
      canFill: false,
    };

    if (this.config.paperRealisticFills && Number.isFinite(bookAgeMs) && bookAgeMs > this.config.paperFillMaxBookAgeMs) {
      audit.blockReason = 'stale_book';
      audit.fillInvalidReason = 'stale_book';
      return audit;
    }
    if (!wasExecutableAtFill) {
      audit.blockReason = 'non_executable_bid_ask';
      audit.fillInvalidReason = 'non_executable_bid_ask';
      return audit;
    }
    if (!wasExecutableAtPlacement && fillDelayMs < Math.max(0, Number(this.config.paperFillMinDelayMs || 0))) {
      audit.fillSource = 'instant_sim';
      audit.blockReason = 'zero_delay_non_cross';
      audit.fillInvalidReason = 'zero_delay_non_cross';
      return audit;
    }
    if (this.config.paperRealisticFills && fillSource === 'unknown') {
      audit.blockReason = 'unknown_fill_source';
      audit.fillInvalidReason = 'unknown_fill_source';
      return audit;
    }
    if (fillSource === 'touch_fill') {
      audit.queueHaircutApplied = clamp(Number(this.config.paperQueueHaircutPct || 0) / 2, 0, 0.95);
    } else if (fillSource === 'resting_queue') {
      audit.queueHaircutApplied = clamp(Number(this.config.paperQueueHaircutPct || 0), 0, 0.95);
      audit.adverseSelectionBufferApplied = Number(this.config.adverseSelectionBuffer || 0);
    }

    const queueMultiplier = 1 - clamp(Number(audit.queueHaircutApplied || 0), 0, 0.95);
    const maxDepthFill = Math.max(0, oppositeDepthUsd * this.config.partialFillDepthFraction * queueMultiplier);
    const fillUsd = Math.min(remainingUsd, maxDepthFill);
    if (fillUsd <= 0) {
      audit.blockReason = 'no_fillable_depth';
      audit.fillInvalidReason = 'no_fillable_depth';
      return audit;
    }

    let price = orderPrice;
    if (fillSource === 'crossed_bid_ask') {
      if (String(order.side || '').toLowerCase() === 'buy') {
        price = Math.min(orderPrice, Number(bestAskAtFill));
        audit.slippageApplied = Math.max(0, price - orderPrice);
      } else {
        price = Math.max(orderPrice, Number(bestBidAtFill));
        audit.slippageApplied = Math.max(0, orderPrice - price);
      }
    }

    return {
      ...audit,
      canFill: true,
      price: clamp(price, 0.01, 0.99),
      fillUsd,
    };
  }

  generateProtectiveSignals(asset, book) {
    if (!isBookComplete(book)) return [];

    const qty = this.portfolio.position(asset.tokenId);
    if (qty <= 0) return [];

    const avgCost = this.portfolio.avgCost(asset.tokenId);
    if (!Number.isFinite(avgCost) || avgCost <= 0) return [];

    const mark = book.midpoint;
    const pnlPct = ((mark - avgCost) / avgCost) * 100;
    const tick = book.tickSize || 0.01;

    const signals = [];

    if (pnlPct <= -Math.abs(this.config.stopLossPct)) {
      signals.push(new Signal({
        strategy: 'StopLossExit',
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'sell',
        price: clamp(roundToTick(Math.max(book.bestBid, book.bestAsk - tick), tick), 0.01, 0.99),
        sizeUsd: qty * mark,
        expectedEdge: 0,
        confidence: 1,
        reason: `Stop loss triggered: pnl=${pnlPct.toFixed(2)}%`,
        exitPlan: 'Emergency risk reduction',
        ttlMs: 15_000,
        maxHoldMs: 60_000,
        metadata: { marketQuestion: asset.market.question, outcome: asset.outcome, pnlPct },
      }));
    }

    if (this.config.enableTakeProfit && pnlPct >= Math.abs(this.config.takeProfitPct)) {
      signals.push(new Signal({
        strategy: 'TakeProfitExit',
        tokenId: asset.tokenId,
        marketId: asset.market.marketId,
        side: 'sell',
        price: clamp(roundToTick(Math.max(book.bestBid, book.bestAsk - tick), tick), 0.01, 0.99),
        sizeUsd: qty * mark,
        expectedEdge: 0,
        confidence: 1,
        reason: `Take profit triggered: pnl=${pnlPct.toFixed(2)}%`,
        exitPlan: 'Lock realized gains',
        ttlMs: 20_000,
        maxHoldMs: 60_000,
        metadata: { marketQuestion: asset.market.question, outcome: asset.outcome, pnlPct },
      }));
    }

    return signals;
  }
}

const GABAGOOL_TELEGRAM_EVENT_STATES = {
  candidate_ready: 'PAPER ONLY BTC GABAGOOL CANDIDATE_READY',
  presophie_block_summary: 'PAPER ONLY BTC GABAGOOL PRESOPHIE_BLOCK_SUMMARY',
  sophie_blocked: 'PAPER ONLY BTC GABAGOOL SOPHIE_BLOCKED',
  risk_blocked: 'PAPER ONLY BTC GABAGOOL RISK_BLOCKED',
  order_placed: 'PAPER ONLY BTC GABAGOOL ORDER_PLACED',
  fill: 'PAPER ONLY BTC GABAGOOL FILL',
  exit: 'PAPER ONLY BTC GABAGOOL EXIT',
  trade_summary: 'PAPER ONLY BTC GABAGOOL TRADE_SUMMARY',
};

class PaperTelegramUpdateRelay {
  constructor(config, portfolio) {
    this.config = config;
    this.portfolio = portfolio;
    this.events = [];
    this.blockDedupe = new Map();
    this.lastDigestAt = 0;
    this.lastDigestKey = null;
    this.lastDigestStatusKey = null;
    this.lastDigestStatusAt = 0;
  }

  enabledForStrategy(strategy) {
    return this.config.gabagoolTelegramUpdates && isGabagoolStrategy(strategy);
  }

  accountSnapshot() {
    return {
      equityUsd: roundMoney(this.portfolio.equity()),
      cashUsd: roundMoney(this.portfolio.cash),
      exposureUsd: roundMoney(this.portfolio.totalExposureUsd()),
      openOrderExposureUsd: roundMoney(this.portfolio.openOrderExposureUsd()),
    };
  }

  notificationState(eventType) {
    return GABAGOOL_TELEGRAM_EVENT_STATES[eventType] || `PAPER ONLY BTC GABAGOOL ${String(eventType || 'UPDATE').toUpperCase()}`;
  }

  shouldRecordEvent(eventType) {
    if (eventType === 'presophie_block_summary') {
      return this.config.gabagoolTelegramNotifyPresophieBlocks;
    }
    return [
      'candidate_ready',
      'sophie_blocked',
      'risk_blocked',
      'order_placed',
      'fill',
      'exit',
      'trade_summary',
    ].includes(eventType);
  }

  shouldNotifyEvent(eventType) {
    if (eventType === 'candidate_ready') return this.config.gabagoolTelegramNotifyDetected;
    if (eventType === 'presophie_block_summary') return this.config.gabagoolTelegramNotifyPresophieBlocks;
    if (eventType === 'sophie_blocked') return this.config.gabagoolTelegramNotifySophieBlocks;
    if (eventType === 'risk_blocked') return this.config.gabagoolTelegramNotifyRiskBlocks;
    if (eventType === 'order_placed') return this.config.gabagoolTelegramNotifyOrders;
    if (eventType === 'fill' || eventType === 'exit') return this.config.gabagoolTelegramNotifyFills;
    if (eventType === 'trade_summary') return this.config.gabagoolTelegramNotifyFills;
    return false;
  }

  blockDedupeKey(record) {
    if (!record.blockReason) return null;
    if (record.oracleEventKey) {
      return `${record.eventType}:${record.blockReason}:${record.oracleEventKey}`;
    }
    return [
      record.eventType,
      record.marketSlug || 'unknown',
      record.tokenId || 'unknown',
      record.outcome || 'unknown',
      String(record.side || '').toLowerCase() || 'unknown',
      record.blockReason,
    ].join(':');
  }

  blockDedupeMs(record) {
    if (record.eventType === 'risk_blocked' && record.blockReason === 'max_total_exposure') {
      return Math.max(1_000, Number(this.config.gabagoolTelegramRiskBlockDedupeMs || 120_000));
    }
    return Math.max(1_000, Number(this.config.gabagoolTelegramBlockDedupeMs || 60_000));
  }

  consumeBlockDedupe(record) {
    const key = this.blockDedupeKey(record);
    if (!key) return { duplicate: false, repeatCount: 0, dedupeWindowMs: 0 };
    const now = Date.now();
    const dedupeMs = this.blockDedupeMs(record);
    for (const [existingKey, entry] of this.blockDedupe.entries()) {
      const expiresAt = Number(entry?.expiresAt || 0);
      const lastSeenAt = Number(entry?.lastSeenAt || 0);
      if ((expiresAt + (dedupeMs * 5)) <= now || (lastSeenAt + (dedupeMs * 5)) <= now) {
        this.blockDedupe.delete(existingKey);
      }
    }
    const entry = this.blockDedupe.get(key);
    if (entry && Number(entry.expiresAt || 0) > now) {
      entry.suppressedCount = Number(entry.suppressedCount || 0) + 1;
      entry.lastSeenAt = now;
      this.blockDedupe.set(key, entry);
      return {
        duplicate: true,
        repeatCount: Number(entry.suppressedCount || 0),
        dedupeWindowMs: dedupeMs,
      };
    }
    const repeatCount = entry ? Number(entry.suppressedCount || 0) : 0;
    this.blockDedupe.set(key, {
      expiresAt: now + dedupeMs,
      lastSeenAt: now,
      suppressedCount: 0,
    });
    return {
      duplicate: false,
      repeatCount,
      dedupeWindowMs: dedupeMs,
    };
  }

  markSuppressed(record, reason) {
    this.portfolio.recordExecutionEvent('gabagool_telegram_suppressed', {
      strategy: record.strategy || 'GabagoolBtcOracleStrategy',
      tokenId: record.tokenId,
      side: record.side,
      reason,
    });
  }

  formatMessage(record) {
    const lines = [
      record.notificationState,
      `strategy=${record.strategy || 'GabagoolBtcOracleStrategy'}`,
      `marketSlug=${record.marketSlug || 'unknown'}`,
      `token=${shortId(record.tokenId)}`,
      `outcome=${record.outcome || 'unknown'}`,
      `action=${String(record.side || '').toUpperCase() || 'UNKNOWN'}`,
      `price=${fmtPrice(record.price)}`,
      `sizeUsd=${record.sizeUsd == null ? 'n/a' : Number(record.sizeUsd).toFixed(2)}`,
      `expectedEdge=${cleanLogValue(record.expectedEdge)}`,
      `confidence=${cleanLogValue(record.confidence)}`,
      `sophie=${record.sophieDecision || 'NOT_RUN'}`,
      `risk=${record.riskDecision || 'NOT_RUN'}`,
      `paperEquity=${record.paperEquityUsd == null ? 'n/a' : record.paperEquityUsd.toFixed(2)}`,
      `paperCash=${record.paperCashUsd == null ? 'n/a' : record.paperCashUsd.toFixed(2)}`,
      `paperExposure=${record.paperExposureUsd == null ? 'n/a' : record.paperExposureUsd.toFixed(2)}`,
    ];
    if (record.paperOpenOrderExposureUsd != null) {
      lines.push(`paperOpenOrderExposure=${record.paperOpenOrderExposureUsd.toFixed(2)}`);
    }
    if (record.fillSource) lines.push(`fillSource=${record.fillSource}`);
    if (record.fillDelayMs != null) lines.push(`fillDelayMs=${Math.round(Number(record.fillDelayMs))}`);
    if (record.bookAgeMs != null) lines.push(`bookAgeMs=${Math.round(Number(record.bookAgeMs))}`);
    if (record.orderPrice != null) lines.push(`orderPrice=${fmtPrice(record.orderPrice)}`);
    if (record.bestBidAtPlacement != null || record.bestAskAtPlacement != null) {
      lines.push(`placementBidAsk=${fmtPrice(record.bestBidAtPlacement)}/${fmtPrice(record.bestAskAtPlacement)}`);
    }
    if (record.bestBidAtFill != null || record.bestAskAtFill != null) {
      lines.push(`fillBidAsk=${fmtPrice(record.bestBidAtFill)}/${fmtPrice(record.bestAskAtFill)}`);
    }
    if (record.wasExecutableAtPlacement != null) lines.push(`wasExecutableAtPlacement=${record.wasExecutableAtPlacement === true ? 'true' : 'false'}`);
    if (record.wasExecutableAtFill != null) lines.push(`wasExecutableAtFill=${record.wasExecutableAtFill === true ? 'true' : 'false'}`);
    if (record.queueHaircutApplied != null) lines.push(`queueHaircutApplied=${cleanLogValue(record.queueHaircutApplied)}`);
    if (record.slippageApplied != null) lines.push(`slippageApplied=${cleanLogValue(record.slippageApplied)}`);
    if (record.adverseSelectionBufferApplied != null) lines.push(`adverseSelectionBufferApplied=${cleanLogValue(record.adverseSelectionBufferApplied)}`);
    if (record.trustedPnl != null) lines.push(`trustedPnl=${record.trustedPnl === true ? 'true' : 'false'}`);
    if (record.avgEntryPrice != null) lines.push(`avgEntry=${fmtPrice(record.avgEntryPrice)}`);
    if (record.realizedPnl != null) lines.push(`realizedPnl=${fmtMoney(record.realizedPnl)}`);
    if (record.exitClassification) lines.push(`exitClassification=${record.exitClassification}`);
    if (record.blockReason) lines.push(`blocked=${record.blockReason}`);
    if (record.fillInvalidReason) lines.push(`fillInvalidReason=${record.fillInvalidReason}`);
    if (record.blockRepeatCount > 0) {
      lines.push(`repeatCount=${record.blockRepeatCount}`);
      lines.push(`repeatWindowMs=${record.blockRepeatWindowMs || 0}`);
    }
    const exposureKeys = [
      'riskTotalExposureUsd',
      'portfolioPositionExposureUsd',
      'portfolioOpenOrderExposureUsd',
      'btcOraclePositionExposureUsd',
      'btcOracleOpenOrderExposureUsd',
      'activeTradableExposureUsd',
      'staleNoBidExposureUsd',
      'confirmedNoOrderbook404ExposureUsd',
      'expiredBtc5mExposureUsd',
      'resolutionPendingExposureUsd',
      'dustExposureUsd',
      'capBlockingExposureUsd',
      'excludedDeadExposureUsd',
      'btcOracleActiveTradableExposureUsd',
      'btcOracleStaleNoBidExposureUsd',
      'btcOracleConfirmedNoOrderbook404ExposureUsd',
      'btcOracleExpiredBtc5mExposureUsd',
      'btcOracleResolutionPendingExposureUsd',
      'btcOracleDustExposureUsd',
      'nonBtcPositionExposureUsd',
      'nonBtcOpenOrderExposureUsd',
      'strategyBucketExposureRawUsd',
      'strategyBucketExposureExclusionUsd',
      'strategyBucketExposureUsd',
      'strategyBucketWouldExposureUsd',
      'maxTotalExposureUsd',
      'exposureAvailableUsd',
      'candidateSizeUsd',
      'wouldTotalExposureUsd',
    ];
    for (const key of exposureKeys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const value = record[key];
      if (value == null || !Number.isFinite(Number(value))) continue;
      lines.push(`${key}=${value == null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(2)}`);
    }
    return lines.join('\n');
  }

  logDigestStatus(sent, reason, extra = {}) {
    const now = Date.now();
    const key = [
      sent === true ? 'true' : 'false',
      reason || 'unknown',
      extra.windowMin || 'na',
      extra.btcOrders || 'na',
      extra.standardOrders || 'na',
      extra.dustSuppressed || 'na',
    ].join(':');
    if (this.lastDigestStatusKey === key && now - this.lastDigestStatusAt < 60_000) return;
    this.lastDigestStatusKey = key;
    this.lastDigestStatusAt = now;
    const fields = [
      `[TELEGRAM DIGEST] sent=${sent === true ? 'true' : 'false'}`,
      `reason=${reason || 'unknown'}`,
    ];
    for (const [name, value] of Object.entries(extra)) {
      if (value == null) continue;
      fields.push(`${name}=${cleanLogValue(value)}`);
    }
    info(fields.join(' '));
  }

  sendToTelegram(message, options = {}) {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      if (options.logDigest === true) {
        this.logDigestStatus(false, 'missing_telegram_config', options.metrics || {});
      }
      return Promise.resolve(false);
    }
    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.telegramChatId,
        text: message,
        disable_web_page_preview: true,
      }),
    }).then(() => {
      if (options.logDigest === true) {
        this.logDigestStatus(true, 'sent', options.metrics || {});
      }
      return true;
    }).catch((error) => {
      warn(`[GABAGOOL TELEGRAM] send failed: ${error.message}`);
      if (options.logDigest === true) {
        this.logDigestStatus(false, 'send_failed', {
          ...(options.metrics || {}),
          error: error.message,
        });
      }
      return false;
    });
  }

  buildDigest(now = Date.now()) {
    const windowMs = Math.max(60_000, Number(this.config.paperTelegramDigestEveryMs || 300_000));
    const since = now - windowMs;
    const recentEvents = this.portfolio.executionEvents.filter((event) => Number(event.ts) >= since);
    const countType = (type, matcher = null) => recentEvents.filter((event) => (
      event.type === type && (typeof matcher === 'function' ? matcher(event) : true)
    )).length;
    const recentOrders = recentEvents.filter((event) => event.type === 'order_placed');
    const strategyCounts = new Map();
    for (const event of recentOrders) {
      const strategy = event.strategy || 'UNKNOWN';
      strategyCounts.set(strategy, (strategyCounts.get(strategy) || 0) + 1);
    }
    const strategyMix = [...strategyCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([strategy, count]) => `${strategy}:${count}`)
      .join(', ') || 'none';
    const markPrices = this.portfolio.markPricesSnapshot();
    const dust = this.portfolio.dustSummary(markPrices);
    const health = this.portfolio.executionHealth(now);
    const btcLedger = this.portfolio.strategyLedger(isBtcOracleStrategy, markPrices, now);
    const standardLedger = this.portfolio.strategyLedger((strategy) => !isBtcOracleStrategy(strategy), markPrices, now);
    const totalPnl = Number(this.portfolio.equity(markPrices) - this.portfolio.startingCash);
    const openPnl = totalPnl - Number(this.portfolio.closedPnl || 0);
    const btcOrders = countType('order_placed', (event) => isBtcOracleStrategy(event.strategy));
    const standardOrders = countType('order_placed', (event) => !isBtcOracleStrategy(event.strategy));
    const dustSuppressed = countType('dust_exit_blocked');
    const telegramSuppressed = countType('gabagool_telegram_suppressed');
    const key = [
      Math.round(since / 1000),
      btcOrders,
      standardOrders,
      recentOrders.length,
      dustSuppressed,
      telegramSuppressed,
      dust.count,
      roundMoney(dust.valueUsd),
      roundMoney(this.portfolio.closedPnl),
      roundMoney(totalPnl),
      strategyMix,
    ].join('|');
    const lines = [
      'PAPER ONLY MIXED MODE DIGEST',
      `windowMin=${Math.round(windowMs / 60_000)}`,
      `btcOrders=${btcOrders} standardOrders=${standardOrders} totalOrders=${recentOrders.length}`,
      `btcExposure=${fmtMoney(btcLedger.totalExposureUsd)} standardExposure=${fmtMoney(standardLedger.totalExposureUsd)}`,
      `pnlClosed=${fmtMoney(this.portfolio.closedPnl)} pnlOpen=${fmtMoney(openPnl)} pnlNet=${fmtMoney(totalPnl)}`,
      `dustCount=${dust.count} dustValue=${fmtMoney(dust.valueUsd)} suppressed=${dustSuppressed} telegramSuppressed=${telegramSuppressed}`,
      `probationAdmissions=${health.probationAdmissionsLastHour || 0} probationBlocks=${health.probationBlocksLastHour || 0}`,
      `topBlockReasons=${health.topBlockReasonsLastHour || 'none'}`,
      recentOrders.length === 0 ? `whyTotalOrdersZero=${health.whyTotalOrdersZeroLastHour || 'none'}` : null,
      `strategyMix=${strategyMix}`,
    ].filter(Boolean);
    return {
      key,
      message: lines.join('\n'),
      metrics: {
        windowMin: Math.round(windowMs / 60_000),
        btcOrders,
        standardOrders,
        totalOrders: recentOrders.length,
        dustCount: dust.count,
        dustSuppressed,
        telegramSuppressed,
      },
    };
  }

  maybeSendDigest(now = Date.now()) {
    if (!this.config.gabagoolTelegramUpdates) {
      this.logDigestStatus(false, 'telegram_updates_disabled');
      return false;
    }
    if (!this.config.paperTelegramDigestEnabled) {
      this.logDigestStatus(false, 'digest_disabled');
      return false;
    }
    const intervalMs = Math.max(60_000, Number(this.config.paperTelegramDigestEveryMs || 300_000));
    if (now - this.lastDigestAt < intervalMs) return false;
    const digest = this.buildDigest(now);
    this.lastDigestAt = now;
    if (!digest?.message) {
      this.logDigestStatus(false, 'empty_digest');
      return false;
    }
    if (digest.key === this.lastDigestKey) {
      this.logDigestStatus(false, 'duplicate_digest', digest.metrics || {});
      return false;
    }
    this.lastDigestKey = digest.key;
    this.sendToTelegram(digest.message, {
      logDigest: true,
      metrics: digest.metrics || {},
    });
    return true;
  }

  record(eventType, payload = {}) {
    if (!this.enabledForStrategy(payload.strategy || 'GabagoolBtcOracleStrategy')) return null;
    const account = this.accountSnapshot();
    const record = {
      timestamp: nowIso(),
      eventType,
      strategy: payload.strategy || 'GabagoolBtcOracleStrategy',
      marketSlug: payload.marketSlug || payload.metadata?.marketSlug || null,
      marketQuestion: payload.marketQuestion || payload.metadata?.marketQuestion || null,
      tokenId: payload.tokenId || null,
      outcome: payload.outcome || payload.metadata?.outcome || null,
      side: payload.side || null,
      price: payload.price != null && Number.isFinite(Number(payload.price)) ? Number(payload.price) : null,
      sizeUsd: payload.sizeUsd != null && Number.isFinite(Number(payload.sizeUsd)) ? Number(payload.sizeUsd) : null,
      expectedEdge: payload.expectedEdge != null && Number.isFinite(Number(payload.expectedEdge)) ? Number(payload.expectedEdge) : null,
      confidence: payload.confidence != null && Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : null,
      fillSource: payload.fillSource == null ? null : normalizePaperFillSource(payload.fillSource),
      fillDelayMs: numericOrNull(payload.fillDelayMs),
      bookAgeMs: numericOrNull(payload.bookAgeMs),
      bestBidAtPlacement: numericOrNull(payload.bestBidAtPlacement),
      bestAskAtPlacement: numericOrNull(payload.bestAskAtPlacement),
      bestBidAtFill: numericOrNull(payload.bestBidAtFill),
      bestAskAtFill: numericOrNull(payload.bestAskAtFill),
      orderPrice: numericOrNull(payload.orderPrice),
      wasExecutableAtPlacement: payload.wasExecutableAtPlacement === true ? true : payload.wasExecutableAtPlacement === false ? false : null,
      wasExecutableAtFill: payload.wasExecutableAtFill === true ? true : payload.wasExecutableAtFill === false ? false : null,
      queueHaircutApplied: numericOrNull(payload.queueHaircutApplied),
      slippageApplied: numericOrNull(payload.slippageApplied),
      adverseSelectionBufferApplied: numericOrNull(payload.adverseSelectionBufferApplied),
      trustedPnl: payload.trustedPnl === true ? true : payload.trustedPnl === false ? false : null,
      fillInvalidReason: payload.fillInvalidReason ? String(payload.fillInvalidReason) : null,
      avgEntryPrice: payload.avgEntryPrice != null && Number.isFinite(Number(payload.avgEntryPrice)) ? Number(payload.avgEntryPrice) : null,
      realizedPnl: payload.realizedPnl != null && Number.isFinite(Number(payload.realizedPnl)) ? Number(payload.realizedPnl) : null,
      exitClassification: payload.exitClassification ? String(payload.exitClassification) : null,
      sophieDecision: payload.sophieDecision || 'NOT_RUN',
      riskDecision: payload.riskDecision || 'NOT_RUN',
      blockReason: payload.blockReason || null,
      oracleEventKey: payload.oracleEventKey || payload.metadata?.gabagool?.oracleEventKey || null,
      notificationState: this.notificationState(eventType),
      paperEquityUsd: account.equityUsd,
      paperCashUsd: account.cashUsd,
      paperExposureUsd: account.exposureUsd,
      paperOpenOrderExposureUsd: account.openOrderExposureUsd,
      riskTotalExposureUsd: numericOrNull(payload.riskTotalExposureUsd),
      portfolioPositionExposureUsd: numericOrNull(payload.portfolioPositionExposureUsd),
      portfolioOpenOrderExposureUsd: numericOrNull(payload.portfolioOpenOrderExposureUsd),
      btcOraclePositionExposureUsd: numericOrNull(payload.btcOraclePositionExposureUsd),
      btcOracleOpenOrderExposureUsd: numericOrNull(payload.btcOracleOpenOrderExposureUsd),
      activeTradableExposureUsd: numericOrNull(payload.activeTradableExposureUsd),
      staleNoBidExposureUsd: numericOrNull(payload.staleNoBidExposureUsd),
      confirmedNoOrderbook404ExposureUsd: numericOrNull(payload.confirmedNoOrderbook404ExposureUsd),
      expiredBtc5mExposureUsd: numericOrNull(payload.expiredBtc5mExposureUsd),
      resolutionPendingExposureUsd: numericOrNull(payload.resolutionPendingExposureUsd),
      dustExposureUsd: numericOrNull(payload.dustExposureUsd),
      capBlockingExposureUsd: numericOrNull(payload.capBlockingExposureUsd),
      excludedDeadExposureUsd: numericOrNull(payload.excludedDeadExposureUsd),
      btcOracleActiveTradableExposureUsd: numericOrNull(payload.btcOracleActiveTradableExposureUsd),
      btcOracleStaleNoBidExposureUsd: numericOrNull(payload.btcOracleStaleNoBidExposureUsd),
      btcOracleConfirmedNoOrderbook404ExposureUsd: numericOrNull(payload.btcOracleConfirmedNoOrderbook404ExposureUsd),
      btcOracleExpiredBtc5mExposureUsd: numericOrNull(payload.btcOracleExpiredBtc5mExposureUsd),
      btcOracleResolutionPendingExposureUsd: numericOrNull(payload.btcOracleResolutionPendingExposureUsd),
      btcOracleDustExposureUsd: numericOrNull(payload.btcOracleDustExposureUsd),
      nonBtcPositionExposureUsd: numericOrNull(payload.nonBtcPositionExposureUsd),
      nonBtcOpenOrderExposureUsd: numericOrNull(payload.nonBtcOpenOrderExposureUsd),
      strategyBucketExposureRawUsd: numericOrNull(payload.strategyBucketExposureRawUsd),
      strategyBucketExposureExclusionUsd: numericOrNull(payload.strategyBucketExposureExclusionUsd),
      strategyBucketExposureUsd: numericOrNull(payload.strategyBucketExposureUsd),
      strategyBucketWouldExposureUsd: numericOrNull(payload.strategyBucketWouldExposureUsd),
      maxTotalExposureUsd: numericOrNull(payload.maxTotalExposureUsd),
      exposureAvailableUsd: numericOrNull(payload.exposureAvailableUsd),
      candidateSizeUsd: numericOrNull(payload.candidateSizeUsd),
      wouldTotalExposureUsd: numericOrNull(payload.wouldTotalExposureUsd),
      riskExposureReduceAllowed: payload.risk_exposure_reduce_allowed === true,
      blockRepeatCount: 0,
      blockRepeatWindowMs: 0,
    };
    if (!this.shouldRecordEvent(eventType)) {
      this.markSuppressed(record, 'record_disabled');
      return null;
    }
    const dedupeState = this.consumeBlockDedupe(record);
    if (dedupeState.duplicate) {
      this.markSuppressed(record, 'dedupe_window');
      return null;
    }
    record.blockRepeatCount = dedupeState.repeatCount;
    record.blockRepeatWindowMs = dedupeState.dedupeWindowMs;
    const shouldNotify = this.shouldNotifyEvent(eventType);
    if (!shouldNotify) {
      record.suppressionReason = 'notify_disabled';
      this.markSuppressed(record, 'notify_disabled');
    }
    this.events.push(record);
    while (this.events.length > 500) this.events.shift();
    appendJsonLine(this.config.gabagoolTelegramEventsPath, record);
    if (shouldNotify) {
      this.sendToTelegram(this.formatMessage(record));
    }
    return record;
  }
}

// =========================
// BOT ENGINE
// =========================

class BotEngine {
  constructor(config) {
    this.config = config;
    this.poly = new PolymarketPublicClient(config);
    this.cache = new MarketCache(this.poly);
    this.portfolio = new PaperPortfolio(config);
    this.portfolio.loadState();

    this.volGuard = new VolatilityGuard(config);
    this.diagnostics = new EngineDiagnostics(config);
    this.risk = new RiskEngine(config, this.portfolio, this.diagnostics);
    this.execution = new PaperExecutionEngine(config, this.portfolio, this.cache, this.diagnostics);
    this.consensus = new MultiConsensusEngine(config, this.diagnostics);
    this.whaleTracker = config.enableWhaleTracking ? new AsyncWhaleWatcher(config) : null;
    this.paperUpdates = new PaperTelegramUpdateRelay(config, this.portfolio);
    this.execution.paperUpdates = this.paperUpdates;
    this.execution.bot = this;

    this.research = new ResearchEngine(this.poly, this.cache, config);
    this.assets = [];
    this.cycle = 0;
    this.wsClient = null;
    this.researchInFlight = null;
    this.researchInFlightStartedAt = 0;
    this.researchRefreshToken = 0;
    this.researchRefreshTimedOut = false;
    this.autoLiveCandidateLastWritten = new Map();
    this.dustExitLastLogged = new Map();
    this.lastDustExitSuppressed = null;
    this.lastFillStarvationWarningAt = 0;
    this.sophieNoFillCooldownUntil = new Map();
    this.lastSophieQualityDecision = null;
    this.sophieCalibratedAdmissionsThisScan = 0;
    this.sophieBootstrapAdmissionsThisScan = 0;
    this.sophieBootstrapCandidates = [];
    this.sophieMakerRecoveryCandidates = [];
    this.sophieBootstrapLastLogged = new Map();
    this.sophieFillProbLastLogged = new Map();
    this.sophieNoFillLearnLastLogged = new Map();
    this.sophieBootstrapTokenCooldownUntil = new Map();
    this.sophieLowQualityLastLogged = new Map();
    this.sophieLowQualitySummary = { windowStartedAt: Date.now(), blocked: 0, qualities: [], tokenIds: new Set() };
    this.sophieRepeatCandidateCooldownUntil = new Map();
    this.sophieRepeatCandidateLogs = new Map();
    this.paperProbationTraceLastLogged = new Map();
    this.assetBookSkipLastLogged = new Map();
    this.standardQualifiedCandidateKeysThisScan = new Set();
    this.lastMixedModePaceLog = { key: null, ts: 0 };
    this.standardChurnCooldowns = new Map();
    this.standardChurnLastLogged = new Map();
    this.gabagoolBehaviorModel = null;
    this.gabagoolOracleEventSeen = new Map();
    this.gabagoolPresophieBlockLogged = new Map();
    this.lastGabagoolOracleSignal = null;
    this.lastGabagoolOracleTarget = null;
    this.lastGabagoolBooks = { up: null, down: null };
    this.lastGabagoolBlockedReason = null;
    this.lastGabagoolConfirmCheck = null;
    this.lastGabagoolSophieBlockReason = null;
    this.lastGabagoolRiskBlockReason = null;
    this.lastGabagoolPlacementBlockReason = null;
    this.lastGabagoolPlacementDecision = null;
    this.gabagoolOracleSignalHistory = [];
    this.gabagoolExitSizingLogged = new Map();
    this.gabagoolTokenEntryGuards = new Map();
    this.gabagoolMarketLockouts = new Map();
    this.lastGabagoolMarketLockoutReason = null;
    this.gabagoolBlockedLossExitDedupe = new Map();
    this.currentGabagoolCycle = {
      ts: Date.now(),
      startedAt: new Date().toISOString(),
      decision: null,
      idleReason: null,
      positionsScanned: 0,
      positionsClosable: 0,
      exitsAttempted: 0,
      exitsPlaced: 0,
      exitBlockedReason: null,
      dominantExitBlockedReason: null,
      blockedReasonSummary: 'none',
      noExitReason: null,
      exitMode: null,
      exposureCapWaitingForExit: false,
      exitUnfreezeReason: null,
      largestExposurePositions: [],
    };
    this.lastBtcOracleReportAt = 0;
    this.lastBtcOracleReportTelegramAt = 0;
    this.lastBtcOracleReportKey = null;
    this.lastBtcOracleReportTelegramKey = null;
    this.lastBtcOracleReport = null;
    this.btcOracleExposureSamples = [];

    this.strategies = [
      new SpreadHunterStrategy(config, this.cache, this.portfolio, this.volGuard),
      new ComplementArbStrategy(config, this.cache, this.portfolio, this.volGuard),
      new InventoryExitStrategy(config, this.cache, this.portfolio, this.volGuard),
      new TailEndMispricingStrategy(config, this.cache, this.portfolio, this.volGuard),
      new WhaleCopyStrategy(config, this.cache, this.portfolio, this.volGuard, this.whaleTracker),
    ];
  }

  syncPortfolioMarks(markPrices = this.cache.markPrices()) {
    this.portfolio.setMarkPrices(markPrices);
    return markPrices;
  }

  rebalancePaperDeadExposureCashReserve(markPrices = this.cache.markPrices(), now = Date.now()) {
    if (this.config.enableLiveTrading === true) {
      return { changed: false, action: 'disabled_live_mode' };
    }
    if (this.config.paperDeadExposureCashReleaseEnabled !== true) {
      return { changed: false, action: 'disabled_config' };
    }
    const releaseBatchUsd = Math.max(0, Number(this.config.paperDeadExposureCashReleaseBatchUsd || 0));
    const triggerCashUsd = Math.max(0, Number(this.config.paperDeadExposureCashReleaseTriggerUsd || 0));
    if (!(releaseBatchUsd > 0)) {
      return { changed: false, action: 'disabled_batch' };
    }

    this.syncPortfolioMarks(markPrices);
    const exposure = this.risk.exposureBreakdown();
    const excludedDeadExposureUsd = Math.max(0, Number(exposure.excludedDeadExposureUsd || 0));
    const excludedDeadExposureReasonSummary = exposure.excludedDeadExposureReasonSummary || 'none';
    const availableCashBefore = this.portfolio.availableCash();
    const reserveOutstandingBefore = this.portfolio.deadExposureCashReserveOutstanding();
    const reserveHeadroomUsd = Math.max(0, excludedDeadExposureUsd - reserveOutstandingBefore);

    if (availableCashBefore <= triggerCashUsd + 1e-9 && reserveHeadroomUsd > 1e-9) {
      const releaseUsd = roundMoney(Math.min(releaseBatchUsd, reserveHeadroomUsd));
      const reserve = this.portfolio.applyDeadExposureCashReserve({ amountUsd: releaseUsd, ts: now });
      if (reserve) {
        this.portfolio.recordExecutionEvent('paper_dead_exposure_cash_release', {
          strategy: 'SYSTEM',
          reason: 'excluded_dead_exposure_cash_release',
          source: excludedDeadExposureReasonSummary,
          sizeUsd: reserve.amountUsd,
        }, now);
        info(
          `[PAPER CASH RELEASE] amount=$${reserve.amountUsd.toFixed(2)} ` +
          `cashBefore=$${availableCashBefore.toFixed(2)} cashAfter=$${this.portfolio.availableCash().toFixed(2)} ` +
          `outstanding=$${reserve.outstandingUsd.toFixed(2)} backingExcludedDead=$${excludedDeadExposureUsd.toFixed(2)} ` +
          `reasons=${excludedDeadExposureReasonSummary}`
        );
        return {
          changed: true,
          action: 'release',
          amountUsd: reserve.amountUsd,
          availableCashBefore,
          availableCashAfter: this.portfolio.availableCash(),
          reserveOutstandingUsd: reserve.outstandingUsd,
          excludedDeadExposureUsd,
          excludedDeadExposureReasonSummary,
        };
      }
    }

    if (reserveOutstandingBefore > 1e-9 && availableCashBefore > releaseBatchUsd + 1e-9) {
      const repayUsd = roundMoney(Math.min(availableCashBefore - releaseBatchUsd, reserveOutstandingBefore));
      const repayment = this.portfolio.repayDeadExposureCashReserve({ amountUsd: repayUsd, ts: now });
      if (repayment) {
        this.portfolio.recordExecutionEvent('paper_dead_exposure_cash_repay', {
          strategy: 'SYSTEM',
          reason: 'excluded_dead_exposure_cash_repay',
          source: excludedDeadExposureReasonSummary,
          sizeUsd: repayment.amountUsd,
        }, now);
        info(
          `[PAPER CASH REPAY] amount=$${repayment.amountUsd.toFixed(2)} ` +
          `cashBefore=$${availableCashBefore.toFixed(2)} cashAfter=$${this.portfolio.availableCash().toFixed(2)} ` +
          `outstanding=$${repayment.outstandingUsd.toFixed(2)} backingExcludedDead=$${excludedDeadExposureUsd.toFixed(2)} ` +
          `reasons=${excludedDeadExposureReasonSummary}`
        );
        return {
          changed: true,
          action: 'repay',
          amountUsd: repayment.amountUsd,
          availableCashBefore,
          availableCashAfter: this.portfolio.availableCash(),
          reserveOutstandingUsd: repayment.outstandingUsd,
          excludedDeadExposureUsd,
          excludedDeadExposureReasonSummary,
        };
      }
    }

    return {
      changed: false,
      action: 'none',
      availableCashBefore,
      reserveOutstandingUsd: reserveOutstandingBefore,
      excludedDeadExposureUsd,
      excludedDeadExposureReasonSummary,
    };
  }

  async start() {
    banner();
    info('Starting Polymarket MoneyMaker V3 (Paper)...');
    const sourceMtime = (() => {
      try {
        return fs.statSync(__filename).mtime.toISOString();
      } catch {
        return 'unknown';
      }
    })();
    info(
      `[PATCH STAMP] staleExposureV2=true gabagoolPrefetchUsesGetGabagoolBook=true ` +
      `paperProbationV2=true sourceMtime=${sourceMtime} ` +
      `liveTrading=${this.config.enableLiveTrading === true ? 'true' : 'false'}`
    );
    info(
      `[CONFIDENCE CONFIG] profile=${this.risk.paperConfidenceProfile()} ` +
      `minConfidence=${this.config.minConfidence} ` +
      `spreadHunterPaperMin=${this.config.spreadHunterMinConfidencePaper} ` +
      `standardPaperMin=${this.config.standardPaperMinConfidence}`
    );

    if (this.config.enableGabagoolBtcImitation) {
      await this.ensureGabagoolBehaviorModel();
    }

    if (this.config.nonBlockingResearchRefresh) {
      this.requestResearchRefresh();
    } else {
      await this.refreshResearch();
    }

    if (this.config.enableWs) {
      this.startWebSocket();
    }

    while (true) {
      try {
        await this.tick();
        await sleep(this.config.loopDelayMs);
      } catch (e) {
        errlog(`Loop error: ${e.stack || e.message}`);
        await sleep(5_000);
      }
    }
  }

  researchRefreshAgeMs(now = Date.now()) {
    if (!this.researchInFlight || !this.researchInFlightStartedAt) return 0;
    return Math.max(0, now - this.researchInFlightStartedAt);
  }

  recoverStuckResearchRefresh(now = Date.now()) {
    if (!this.researchInFlight) return false;

    const ageMs = this.researchRefreshAgeMs(now);
    const timeoutMs = Math.max(1, Number(this.config.researchRefreshTimeoutMs || 60_000));
    const stuckResetMs = Math.max(1, Number(this.config.researchStuckResetMs || 90_000));
    const resetMs = Math.min(timeoutMs, stuckResetMs);
    if (ageMs < resetMs) return false;

    warn(`[RESEARCH REFRESH TIMEOUT] ageMs=${Math.round(ageMs)} timeoutMs=${timeoutMs} stuckResetMs=${stuckResetMs}`);
    this.researchRefreshToken += 1;
    this.researchInFlight = null;
    this.researchInFlightStartedAt = 0;
    this.researchRefreshTimedOut = true;
    warn('[RESEARCH REFRESH UNSTUCK]');
    return true;
  }

  async runResearchRefresh({ background = false, token = null } = {}) {
    info(background ? '[RESEARCH REFRESH START] background=true' : '[RESEARCH REFRESH START]');
    try {
      const selected = await this.research.discoverCandidates();
      const tokenCurrent = token === null || token === this.researchRefreshToken;
      const canSeedEmptyAssets = !tokenCurrent && this.assets.length === 0 && selected.length > 0;
      if (tokenCurrent || canSeedEmptyAssets) {
        this.assets = selected;
        if (this.wsClient && this.assets.length > 0) {
          this.wsClient.subscribe(this.assets.map((a) => a.tokenId));
        }
        info(
          `[RESEARCH REFRESH COMPLETE] selected=${selected.length} ` +
          `lateSeed=${canSeedEmptyAssets} tokenCurrent=${tokenCurrent}`
        );
      } else {
        info(
          `[RESEARCH REFRESH LATE RESULT IGNORED] selected=${selected.length} ` +
          `token=${token} currentToken=${this.researchRefreshToken} activeAssets=${this.assets.length}`
        );
      }
      return selected;
    } catch (e) {
      warn(`[RESEARCH REFRESH FAILED] ${e.stack || e.message}`);
      throw e;
    }
  }

  async refreshResearch() {
    const token = ++this.researchRefreshToken;
    this.researchInFlight = Promise.resolve();
    this.researchInFlightStartedAt = Date.now();
    this.researchRefreshTimedOut = false;
    const timeoutMs = Math.max(1, Number(this.config.researchRefreshTimeoutMs || 60_000));
    let timeoutId = null;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        if (token !== this.researchRefreshToken) {
          resolve(null);
          return;
        }
        const ageMs = this.researchRefreshAgeMs();
        warn(`[RESEARCH REFRESH TIMEOUT] ageMs=${Math.round(ageMs)} timeoutMs=${timeoutMs} stuckResetMs=${Math.max(1, Number(this.config.researchStuckResetMs || 90_000))}`);
        this.researchRefreshToken += 1;
        this.researchInFlight = null;
        this.researchInFlightStartedAt = 0;
        this.researchRefreshTimedOut = true;
        warn('[RESEARCH REFRESH UNSTUCK]');
        resolve(null);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.runResearchRefresh({ token }), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (token === this.researchRefreshToken) {
        this.researchInFlight = null;
        this.researchInFlightStartedAt = 0;
      }
    }
  }

  requestResearchRefresh() {
    if (!this.config.nonBlockingResearchRefresh) {
      return this.refreshResearch();
    }

    this.recoverStuckResearchRefresh();

    if (this.researchInFlight) {
      info('[RESEARCH REFRESH SKIPPED already running]');
      return this.researchInFlight;
    }

    const token = ++this.researchRefreshToken;
    this.researchInFlightStartedAt = Date.now();
    this.researchRefreshTimedOut = false;
    const promise = this.runResearchRefresh({ background: true, token })
      .catch((e) => {
        return null;
      })
      .finally(() => {
        if (token === this.researchRefreshToken && this.researchInFlight === promise) {
          this.researchInFlight = null;
          this.researchInFlightStartedAt = 0;
        }
      });

    this.researchInFlight = promise;
    return this.researchInFlight;
  }

  recordBtcOracleExposureSample(markPrices = this.cache.markPrices(), now = Date.now()) {
    this.syncPortfolioMarks(markPrices);
    const ledger = this.portfolio.strategyLedger(isBtcOracleStrategy, markPrices, now);
    this.btcOracleExposureSamples.push({
      ts: now,
      totalExposureUsd: Number(ledger.totalExposureUsd || 0),
      positionExposureUsd: Number(ledger.currentPositionExposureUsd || 0),
      openOrderExposureUsd: Number(ledger.currentOpenOrderExposureUsd || 0),
    });

    const retentionMs = 2 * 60 * 60_000;
    while (
      this.btcOracleExposureSamples.length > 0 &&
      (now - Number(this.btcOracleExposureSamples[0].ts || 0)) > retentionMs
    ) {
      this.btcOracleExposureSamples.shift();
    }
  }

  async ensureGabagoolBehaviorModel(forceRefresh = false) {
    if (!this.config.enableGabagoolBtcImitation) return null;
    if (!forceRefresh && this.gabagoolBehaviorModel) return this.gabagoolBehaviorModel;

    if (!forceRefresh) {
      const cached = readJsonFile(this.config.gabagoolBehaviorModelPath, null);
      if (cached?.strategyProfile && cached?.source?.walletMatched !== false) {
        this.gabagoolBehaviorModel = cached;
        return cached;
      }
    }

    try {
      const refreshed = await refreshBehaviorModel({
        username: this.config.gabagoolUsername,
        expectedProxyWallet: this.config.gabagoolProxyWallet,
        lookbackTrades: this.config.gabagoolLookbackTrades,
        outputPath: this.config.gabagoolBehaviorModelPath,
      });

      if (refreshed?.source?.walletMatched !== true) {
        warn(
          `[GABAGOOL MODEL BLOCKED] resolvedWallet=${refreshed?.source?.resolvedProxyWallet || 'missing'} ` +
          `expectedWallet=${this.config.gabagoolProxyWallet}`
        );
        return null;
      }
      if (refreshed?.source?.usernameMatched !== true) {
        warn(
          `[GABAGOOL MODEL BLOCKED] resolvedName=${refreshed?.source?.resolvedName || 'missing'} ` +
          `expectedName=${this.config.gabagoolUsername}`
        );
        return null;
      }

      this.gabagoolBehaviorModel = refreshed;
      info(
        `[GABAGOOL MODEL READY] tradesFetched=${refreshed.diagnostics?.tradesFetched || 0} ` +
        `btc5mTrades=${refreshed.diagnostics?.btcFiveMinuteTrades || 0} ` +
        `path=${path.resolve(this.config.gabagoolBehaviorModelPath)}`
      );
      return refreshed;
    } catch (error) {
      warn(`[GABAGOOL MODEL REFRESH FAILED] ${error.message}`);
      const fallback = readJsonFile(this.config.gabagoolBehaviorModelPath, null);
      if (fallback?.strategyProfile && fallback?.source?.walletMatched !== false) {
        this.gabagoolBehaviorModel = fallback;
        return fallback;
      }
      return null;
    }
  }

  buildGabagoolSyntheticAsset(targetPayload, tokenId) {
    const target = targetPayload?.target;
    if (!target || !tokenId) return null;
    const upToken = String(target.BTC_UP_TOKEN_ID || '');
    const downToken = String(target.BTC_DOWN_TOKEN_ID || '');
    let outcome = 'Unknown';
    if (String(tokenId) === upToken) outcome = 'Up';
    if (String(tokenId) === downToken) outcome = 'Down';
    return {
      tokenId: String(tokenId),
      outcome,
      market: {
        marketId: String(target.rawMarketId || target.slug || ''),
        question: String(target.question || ''),
        marketSlug: String(target.slug || ''),
        eventSlug: String(target.slug || ''),
        volume24h: 10_000,
        liquidity: 10_000,
        endDate: Number.isFinite(Number(target.ts))
          ? new Date((Number(target.ts) + 300) * 1000).toISOString()
          : new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    };
  }

  gabagoolLossGuardExitMode() {
    const mode = String(this.config.gabagoolLossGuardExitMode || 'reduce_only').trim().toLowerCase();
    return mode === 'reduce_only' ? mode : 'reduce_only';
  }

  resetGabagoolCurrentCycle(now = Date.now()) {
    this.currentGabagoolCycle = {
      ts: now,
      startedAt: new Date(now).toISOString(),
      decision: null,
      idleReason: null,
      positionsScanned: 0,
      positionsClosable: 0,
      exitsAttempted: 0,
      exitsPlaced: 0,
      exitBlockedReason: null,
      dominantExitBlockedReason: null,
      blockedReasonSummary: 'none',
      noExitReason: null,
      exitMode: this.gabagoolLossGuardExitMode(),
      exposureCapWaitingForExit: false,
      exitUnfreezeReason: null,
      largestExposurePositions: [],
    };
    return this.currentGabagoolCycle;
  }

  updateGabagoolCurrentCycle(fields = {}) {
    this.currentGabagoolCycle = {
      ...(this.currentGabagoolCycle || this.resetGabagoolCurrentCycle()),
      ...fields,
    };
    return this.currentGabagoolCycle;
  }

  gabagoolPositionContext(tokenId, marketId = '') {
    const key = String(tokenId || '');
    const fallbackTarget = this.lastGabagoolOracleTarget || null;
    let resolvedMarketId = String(marketId || this.portfolio.positionMarketId(key) || '');
    let marketSlug = '';
    let marketQuestion = '';
    let outcome = null;
    let marketSlugSource = '';
    let outcomeSource = '';
    let lastEvidenceTs = 0;
    for (let i = this.portfolio.executionEvents.length - 1; i >= 0; i -= 1) {
      const event = this.portfolio.executionEvents[i];
      if (!isBtcOracleStrategy(event?.strategy)) continue;
      if (String(event?.tokenId || '') !== key) continue;
      if (!resolvedMarketId && String(event?.marketId || '')) resolvedMarketId = String(event.marketId);
      if (!marketSlug && String(event?.marketSlug || '')) {
        marketSlug = String(event.marketSlug);
        marketSlugSource = 'execution_event';
      }
      if (!outcome && String(event?.outcome || '')) {
        outcome = String(event.outcome);
        outcomeSource = 'execution_event';
      }
      lastEvidenceTs = Math.max(lastEvidenceTs, Number(event?.ts || 0));
      break;
    }
    for (let i = this.portfolio.fills.length - 1; i >= 0 && (!marketSlug || !outcome); i -= 1) {
      const fill = this.portfolio.fills[i];
      if (String(fill?.tokenId || '') !== key) continue;
      if (!resolvedMarketId && String(fill?.marketId || '')) resolvedMarketId = String(fill.marketId);
      if (!marketSlug && String(fill?.marketSlug || '')) {
        marketSlug = String(fill.marketSlug);
        marketSlugSource = 'fill';
      }
      if (!outcome && String(fill?.outcome || '')) {
        outcome = String(fill.outcome);
        outcomeSource = 'fill';
      }
      lastEvidenceTs = Math.max(lastEvidenceTs, Number(fill?.ts || 0));
    }
    if (fallbackTarget) {
      if (!marketSlug && String(fallbackTarget.slug || '')) {
        marketSlug = String(fallbackTarget.slug);
        marketSlugSource = 'fallback_target';
      }
      if (!marketQuestion && String(fallbackTarget.question || '')) marketQuestion = String(fallbackTarget.question);
      const upToken = String(fallbackTarget.BTC_UP_TOKEN_ID || '');
      const downToken = String(fallbackTarget.BTC_DOWN_TOKEN_ID || '');
      if (!outcome && key && key === upToken) {
        outcome = 'Up';
        outcomeSource = 'fallback_target';
      }
      if (!outcome && key && key === downToken) {
        outcome = 'Down';
        outcomeSource = 'fallback_target';
      }
    }
    if (!marketSlug) {
      marketSlug = resolvedMarketId || key;
      marketSlugSource = resolvedMarketId ? 'position_market_id' : 'token_fallback';
    }
    return {
      tokenId: key,
      marketId: resolvedMarketId || marketSlug || key,
      marketSlug,
      marketQuestion: marketQuestion || marketSlug || 'Gabagool BTC market',
      outcome: outcome || 'Unknown',
      marketSlugSource: marketSlugSource || 'unknown',
      outcomeSource: outcomeSource || 'unknown',
      directMarketEvidence: marketSlugSource === 'execution_event' || marketSlugSource === 'fill',
      directOutcomeEvidence: outcomeSource === 'execution_event' || outcomeSource === 'fill',
      lastEvidenceTs,
    };
  }

  buildGabagoolSyntheticAssetFromContext(context = {}) {
    const tokenId = String(context.tokenId || '');
    if (!tokenId) return null;
    const marketId = String(context.marketId || context.marketSlug || tokenId);
    const marketSlug = String(context.marketSlug || marketId || tokenId);
    const marketQuestion = String(context.marketQuestion || marketSlug || 'Gabagool BTC market');
    return {
      tokenId,
      outcome: String(context.outcome || 'Unknown'),
      market: {
        marketId,
        question: marketQuestion,
        marketSlug,
        eventSlug: marketSlug,
        volume24h: 10_000,
        liquidity: 10_000,
        endDate: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    };
  }

  gabagoolMarketStartSec(marketSlug = '') {
    const match = String(marketSlug || '').match(/btc-updown-5m-(\d+)/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  gabagoolMarketWindowState(marketSlug = '', now = Date.now()) {
    const startSec = this.gabagoolMarketStartSec(marketSlug);
    const secondsIntoWindow = Number.isFinite(startSec)
      ? Math.max(0, Math.floor(now / 1000) - startSec)
      : null;
    return {
      startSec,
      secondsIntoWindow,
      staleMarket: Number.isFinite(secondsIntoWindow) && secondsIntoWindow >= 300,
    };
  }

  gabagoolExposureCleanupState(context = {}, now = Date.now()) {
    const windowState = this.gabagoolMarketWindowState(context.marketSlug, now);
    const lastEvidenceTs = Number(context.lastEvidenceTs || 0);
    const lastEvidenceAgeMs = lastEvidenceTs > 0 ? Math.max(0, now - lastEvidenceTs) : null;
    const staleEvidence = Number.isFinite(lastEvidenceAgeMs) && lastEvidenceAgeMs >= 10 * 60_000;
    return {
      ...windowState,
      lastEvidenceAgeMs,
      staleEvidence,
      staleOrExpired: windowState.staleMarket || staleEvidence,
    };
  }

  gabagoolPaperExposurePositionState(position = {}, now = Date.now()) {
    const context = this.gabagoolPositionContext(position.tokenId, position.marketId);
    const tradeability = this.portfolio.paperTokenTradeability instanceof Map
      ? (this.portfolio.paperTokenTradeability.get(String(position.tokenId || '')) || null)
      : null;
    const tradeabilityStatus = String(tradeability?.status || '');
    const cleanupState = this.gabagoolExposureCleanupState(context, now);
    const totalExposureUsd = Math.max(0, Number(position.totalExposureUsd || position.positionExposureUsd || 0));
    const excludedDeadReason = tradeabilityStatus === 'no_orderbook_404'
      ? 'confirmed_no_orderbook_404'
      : cleanupState?.staleMarket === true
        ? 'expired_btc_5m_window'
        : null;
    let capBlockingBucket = 'activeTradableExposureUsd';
    if (
      cleanupState?.staleEvidence === true &&
      (tradeabilityStatus === 'stale_token_cooldown' || tradeabilityStatus === 'no_bid')
    ) {
      capBlockingBucket = 'resolutionPendingExposureUsd';
    } else if (tradeabilityStatus === 'stale_token_cooldown' || tradeabilityStatus === 'no_bid') {
      capBlockingBucket = 'staleNoBidExposureUsd';
    }
    return {
      position,
      context,
      tradeability,
      tradeabilityStatus,
      cleanupState,
      totalExposureUsd,
      excludedDeadReason,
      excludedFromCapBlocking: Boolean(excludedDeadReason),
      capBlockingBucket,
    };
  }

  gabagoolPaperExposureCapView(options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const markPrices = options.markPrices instanceof Map ? options.markPrices : this.cache.markPrices();
    const ledger = options.ledger || this.gabagoolLedger(markPrices, now);
    const riskExposure = options.riskExposure || this.risk.exposureBreakdown(null, { markPrices });
    const classifiedPositions = (ledger.perTokenExposure || [])
      .filter((item) => Number(item.qty || 0) > 0)
      .map((position) => this.gabagoolPaperExposurePositionState(position, now));
    const capBlockingPositions = [];
    let activeTradableExposureUsd = 0;
    let staleNoBidExposureUsd = 0;
    let resolutionPendingExposureUsd = 0;
    let expiredBtc5mExposureUsd = 0;
    let confirmedNoOrderbook404ExposureUsd = 0;

    for (const state of classifiedPositions) {
      if (!(state.totalExposureUsd > 0)) continue;
      if (state.excludedDeadReason === 'expired_btc_5m_window') {
        expiredBtc5mExposureUsd += state.totalExposureUsd;
        continue;
      }
      if (state.excludedDeadReason === 'confirmed_no_orderbook_404') {
        confirmedNoOrderbook404ExposureUsd += state.totalExposureUsd;
        continue;
      }
      if (state.capBlockingBucket === 'staleNoBidExposureUsd') {
        staleNoBidExposureUsd += state.totalExposureUsd;
      } else if (state.capBlockingBucket === 'resolutionPendingExposureUsd') {
        resolutionPendingExposureUsd += state.totalExposureUsd;
      } else {
        activeTradableExposureUsd += state.totalExposureUsd;
      }
      capBlockingPositions.push(state);
    }

    const excludedDeadExposureUsd = expiredBtc5mExposureUsd + confirmedNoOrderbook404ExposureUsd;
    const rawPortfolioExposureUsd = Math.max(
      Number(ledger.totalExposureUsd || 0),
      Number(riskExposure.rawTotalExposureUsd || 0)
    );
    const capBlockingExposureUsdAfterExclusions = Math.max(0, (
      Number(riskExposure.nonBtcPositionExposureUsd || 0) +
      Number(riskExposure.portfolioOpenOrderExposureUsd || 0) +
      activeTradableExposureUsd +
      staleNoBidExposureUsd +
      resolutionPendingExposureUsd
    ));
    const maxTotalExposureUsd = Math.max(0, Number(this.config.maxTotalExposureUsd || 0));
    const rawExcessExposureUsd = maxTotalExposureUsd > 0
      ? Math.max(0, rawPortfolioExposureUsd - maxTotalExposureUsd)
      : 0;
    const excessExposureUsdAfterExclusions = maxTotalExposureUsd > 0
      ? Math.max(0, capBlockingExposureUsdAfterExclusions - maxTotalExposureUsd)
      : 0;
    const bypassedBecauseOnlyExpiredDeadExposure = rawExcessExposureUsd > 1e-9 &&
      excessExposureUsdAfterExclusions <= 1e-9 &&
      excludedDeadExposureUsd > 1e-9 &&
      activeTradableExposureUsd <= 1e-9 &&
      staleNoBidExposureUsd <= 1e-9 &&
      resolutionPendingExposureUsd <= 1e-9;

    return {
      classifiedPositions,
      capBlockingPositions,
      rawPortfolioExposureUsd,
      activeTradableExposureUsd,
      staleNoBidExposureUsd,
      resolutionPendingExposureUsd,
      expiredBtc5mExposureUsd,
      confirmedNoOrderbook404ExposureUsd,
      excludedDeadExposureUsd,
      capBlockingExposureUsdAfterExclusions,
      rawExcessExposureUsd,
      excessExposureUsdAfterExclusions,
      bypassedBecauseOnlyExpiredDeadExposure,
    };
  }

  gabagoolProfitBufferBypassAllowed(signal = null) {
    return (
      this.gabagoolExplicitLossExitAllowed(signal) ||
      signal?.metadata?.exitMode === 'exposure_cap_reduce_only' ||
      signal?.metadata?.gabagool?.exitMode === 'exposure_cap_reduce_only' ||
      signal?.metadata?.gabagool?.exitTrigger === 'exposure_cap_reduce_only'
    );
  }

  async getGabagoolBook(tokenId, books = new Map()) {
    const key = String(tokenId || '');
    if (!key) return null;
    if (books.has(key)) return books.get(key);
    if (!(this.portfolio.paperTokenTradeability instanceof Map)) {
      this.portfolio.paperTokenTradeability = new Map();
    }
    if (!(this.gabagoolBookFetchLastLogged instanceof Map)) {
      this.gabagoolBookFetchLastLogged = new Map();
    }
    try {
      const book = await this.cache.getFreshBook(key, 0);
      this.cache.setBook(key, book);
      books.set(key, book);
      this.portfolio.setMarkPrice(key, book?.midpoint);
      this.portfolio.paperTokenTradeability.set(key, {
        status: Number.isFinite(Number(book?.bestBid)) && Number(book.bestBid) > 0
          ? 'tradable'
          : 'no_bid',
        tokenId: key,
        ts: Date.now(),
        bestBid: Number.isFinite(Number(book?.bestBid)) ? Number(book.bestBid) : null,
        midpoint: Number.isFinite(Number(book?.midpoint)) ? Number(book.midpoint) : null,
      });
      if (Number.isFinite(Number(book?.midpoint))) {
        this.volGuard.update(key, Number(book.midpoint));
        this.consensus.recordMid(key, Number(book.midpoint));
      }
      return book;
    } catch (error) {
      const status = String(error?.mmBookFetchStatus || '');
      const cooldownMsRemaining = Math.max(0, Number(error?.mmCooldownMsRemaining || 0));
      if (status === 'no_orderbook_404' || status === 'stale_token_cooldown') {
        this.portfolio.paperTokenTradeability.set(key, {
          status,
          tokenId: key,
          ts: Date.now(),
          expiresAt: cooldownMsRemaining > 0 ? Date.now() + cooldownMsRemaining : null,
          cooldownMsRemaining,
          source: status === 'no_orderbook_404' ? 'confirmed_404' : 'negative_cache',
          message: String(error?.message || ''),
        });
        const logKey = `${key}:${status}`;
        const lastLoggedAt = this.gabagoolBookFetchLastLogged.get(logKey) || 0;
        const logCooldownMs = status === 'no_orderbook_404' ? 60_000 : 300_000;
        if (Date.now() - lastLoggedAt >= logCooldownMs) {
          this.gabagoolBookFetchLastLogged.set(logKey, Date.now());
          warn(
            `[GABAGOOL BOOK FETCH FAILED] token=${shortId(key)} reason=${status} ` +
            `cooldownSec=${Math.round(cooldownMsRemaining / 1000)} error=${error.message}`
          );
        }
        return null;
      }
      warn(`[GABAGOOL BOOK FETCH FAILED] token=${shortId(key)} error=${error.message}`);
      return null;
    }
  }

  dominantGabagoolLossGuardReason(reasonCounts = new Map()) {
    const ranked = [...reasonCounts.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });
    return ranked[0]?.[0] || null;
  }

  shouldLogPaperProbationTrace(signal, stage = 'unknown', cooldownMs = 30_000) {
    const key = [
      stage,
      signal?.tokenId || 'unknown',
      String(signal?.side || '').toLowerCase() || 'unknown',
      resolveStrategyName(signal) || 'unknown',
    ].join(':');
    const now = Date.now();
    const last = this.paperProbationTraceLastLogged.get(key) || 0;
    if (now - last < cooldownMs) return false;
    this.paperProbationTraceLastLogged.set(key, now);
    return true;
  }

  logPaperProbationTrace(signal, details = {}, stage = 'unknown') {
    if (!signal) return;
    if (this.config.enableLiveTrading === true) return;
    if (resolveStrategyName(signal) !== 'SpreadHunter') return;
    if (String(signal?.side || '').toLowerCase() !== 'buy') return;
    if (this.portfolio.openOrders.size !== 0) return;
    const health = this.portfolio.executionHealth(Date.now());
    if (Number(health.paperOrdersPlacedLastHour || 0) !== 0) return;
    const minEdge = minSignalEdgeForCandidate(signal, this.config);
    if (Number(signal?.expectedEdge || 0) < minEdge) return;
    const paperProbation = signal?.metadata?.paperProbation || null;
    const traceFloor = Number(
      paperProbation?.minConfidence ??
      Math.max(
        0.30,
        Number(this.config.paperMakerRecoveryMinConfidence || 0.35) - 0.01
      )
    );
    const confidence = Number(signal?.confidence || 0);
    const nearProbationFloor = paperProbation?.active === true ||
      (confidence >= Math.max(0, traceFloor - 0.05) && confidence <= Math.min(1, traceFloor + 0.05));
    if (!nearProbationFloor) return;
    if (!this.shouldLogPaperProbationTrace(signal, stage)) return;
    info(
      `[PAPER PROBATION TRACE] stage=${stage} strategy=${resolveStrategyName(signal)} token=${shortId(signal.tokenId)} ` +
      `edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)} ` +
      `probationEligible=${details.probationEligible === true ? 'true' : 'false'} ` +
      `probationActive=${details.probationActive === true ? 'true' : 'false'} ` +
      `hasPaperProbationMetadata=${paperProbation?.active === true ? 'true' : 'false'} ` +
      `repeatCooldownBypassed=${details.repeatCooldownBypassed === true ? 'true' : 'false'} ` +
      `repeatCooldownBlocked=${details.repeatCooldownBlocked === true ? 'true' : 'false'} ` +
      `reason=${details.reason || 'none'}`
    );
  }

  paperActionBurnInState(now = Date.now(), health = this.portfolio.executionHealth(now)) {
    const targetOrdersPer15m = Math.max(0, Number(this.config.paperActionBurnInTargetOrdersPer15m || 0));
    const targetFillsPer15m = Math.max(0, Number(this.config.paperActionBurnInTargetFillsPer15m || 0));
    const maxOpenOrders = Math.max(0, Number(this.config.paperActionBurnInMaxOpenOrders || 0));
    const maxBankrollUsd = Math.max(0, Number(this.config.paperActionBurnInMaxBankrollUsd || 0));
    const referenceBankrollUsd = Math.max(
      0,
      Number(this.portfolio.startingCash || 0),
      Number(this.config.initialCash || 0),
      Number(this.portfolio.equity() || 0)
    );
    const active = (
      this.config.enableLiveTrading !== true &&
      this.config.paperActionBurnInEnabled === true &&
      maxBankrollUsd > 0 &&
      referenceBankrollUsd <= maxBankrollUsd
    );
    const ordersPlacedLast15m = Math.max(0, Number(health.paperOrdersPlacedLast15m || 0));
    const fillsLast15m = Math.max(0, Number(health.paperOrdersFilledLast15m || 0));
    const belowOrdersTarget = targetOrdersPer15m > 0 && ordersPlacedLast15m < targetOrdersPer15m;
    const belowFillsTarget = targetFillsPer15m > 0 && fillsLast15m < targetFillsPer15m;
    const actionRateBelowTarget = active && (belowOrdersTarget || belowFillsTarget);
    let status = 'disabled';
    let reason = 'paper_action_burnin_disabled';
    if (this.config.enableLiveTrading === true) {
      reason = 'live_mode';
    } else if (this.config.paperActionBurnInEnabled !== true) {
      reason = 'paper_action_burnin_disabled';
    } else if (!(maxBankrollUsd > 0) || referenceBankrollUsd > maxBankrollUsd) {
      reason = 'bankroll_above_burnin_cap';
    } else if (actionRateBelowTarget) {
      status = 'action_rate_below_target';
      reason = 'action_rate_below_target';
    } else {
      status = 'action_rate_on_target';
      reason = 'action_rate_on_target';
    }
    return {
      active,
      status,
      reason,
      actionRateBelowTarget,
      referenceBankrollUsd,
      maxBankrollUsd,
      targetOrdersPer15m,
      targetFillsPer15m,
      ordersPlacedLast15m,
      fillsLast15m,
      maxOpenOrders,
      openOrders: Number(this.portfolio.openOrders.size || 0),
      probationWindowOpen: active && actionRateBelowTarget && Number(this.portfolio.openOrders.size || 0) <= maxOpenOrders,
    };
  }

  async buildGabagoolLossGuardExitScan({ model, books = new Map(), now = Date.now() } = {}) {
    const lossGuard = this.gabagoolLossGuardState(this.cache.markPrices(), now);
    const exitMode = this.gabagoolLossGuardExitMode();
    const scan = {
      active: lossGuard.paused && exitMode === 'reduce_only',
      reason: lossGuard.reason,
      exitMode,
      positionsScanned: 0,
      positionsClosable: 0,
      candidates: [],
      noExitReason: null,
      blockedReasons: new Map(),
      lossGuard,
    };
    if (!scan.active) return scan;

    const positions = (lossGuard.ledger?.perTokenExposure || [])
      .filter((item) => Number(item.qty || 0) > 0);
    if (positions.length === 0) {
      scan.noExitReason = 'no_position_inventory';
      this.recordGabagoolMetric('gabagool_loss_guard_exit_scan', {
        reason: scan.noExitReason,
        positionsScanned: 0,
        positionsClosable: 0,
        source: scan.noExitReason,
        exitMode,
      });
      this.updateGabagoolCurrentCycle({
        positionsScanned: 0,
        positionsClosable: 0,
        noExitReason: scan.noExitReason,
        exitMode,
      });
      return scan;
    }

    const noteBlockedReason = (reason) => {
      if (!reason) return;
      scan.blockedReasons.set(reason, (scan.blockedReasons.get(reason) || 0) + 1);
    };

    for (const position of positions) {
      scan.positionsScanned += 1;
      const context = this.gabagoolPositionContext(position.tokenId, position.marketId);
      const availableSellQty = this.portfolio.availablePositionQty(position.tokenId);
      const commonDetails = {
        tokenId: String(position.tokenId),
        marketId: context.marketId,
        marketSlug: context.marketSlug,
        outcome: context.outcome,
        positionQty: Number(position.qty || 0),
        availableSellQty,
      };
      if (!(availableSellQty > 0)) {
        noteBlockedReason('inventory_validation_failed');
        continue;
      }

      const book = await this.getGabagoolBook(position.tokenId, books);
      if (!book) {
        noteBlockedReason('no_bid_available');
        continue;
      }
      if (!Number.isFinite(Number(book.bestBid))) {
        noteBlockedReason('no_bid_available');
        continue;
      }
      if (!(Number(book.bestBid) > 0) || Number(book.bestBid) >= 1) {
        noteBlockedReason('exit_price_invalid');
        continue;
      }

      const currentValueUsd = availableSellQty * Number(book.bestBid);
      const roundedExitSizeUsd = Math.max(0, Math.round(currentValueUsd * 100) / 100);
      const minDustExitUsd = Math.max(0.01, Number(this.config.gabagoolMinDustExitUsd || 0.01));
      if (!(currentValueUsd > 0) || !(roundedExitSizeUsd > 0) || roundedExitSizeUsd < minDustExitUsd) {
        const tinyReason = 'position_value_below_dust_min';
        this.recordGabagoolTinyExitState('gabagool_dust_position_remaining', {
          ...commonDetails,
          price: Number(book.bestBid),
          book,
          reason: 'dust_exit_below_min',
          source: 'loss_guard_position_value_below_dust_floor',
          currentValueUsd,
          roundedExitSizeUsd,
        }, {
          skipPresophieBlock: true,
        });
        this.recordGabagoolMetric('gabagool_loss_guard_dust_remaining', {
          ...commonDetails,
          side: 'sell',
          price: Number(book.bestBid),
          sizeUsd: roundedExitSizeUsd,
          currentValueUsd,
          roundedExitSizeUsd,
          reason: tinyReason,
          source: 'loss_guard_position_value_below_dust_floor',
          exitMode,
        });
        noteBlockedReason(tinyReason);
        continue;
      }

      scan.positionsClosable += 1;
      const asset = this.buildGabagoolSyntheticAssetFromContext(context);
      const signal = new Signal({
        strategy: 'GabagoolBtcOracleStrategy',
        tokenId: String(position.tokenId),
        marketId: context.marketId,
        side: 'sell',
        price: round(Number(book.bestBid)),
        sizeUsd: roundedExitSizeUsd,
        expectedEdge: round(Math.max(Number(this.config.minSignalEdge || 0), Math.abs(Number(book.bestBid) - Number(position.avgEntryPrice || 0)))),
        confidence: round(clamp(Number(position.mark || book.midpoint || book.bestBid) >= Number(position.avgEntryPrice || 0) ? 0.68 : 0.62, 0.35, 0.95)),
        reason: 'gabagool loss guard reduce-only exit',
        exitPlan: 'Reduce-only inventory cleanup while loss guard is active',
        ttlMs: 10_000,
        maxHoldMs: 20_000,
        metadata: {
          marketSlug: context.marketSlug,
          marketQuestion: context.marketQuestion,
          outcome: context.outcome,
          reduceOnly: true,
          exitMode,
          loss_guard_reduce_exit_allowed: true,
          gabagool: {
            oracleSignalFresh: false,
            exitIntent: true,
            exitTrigger: 'loss_guard_reduce_only',
            exitMode,
            lossGuardReduceExitAllowed: true,
            sourceWallet: model?.source?.resolvedProxyWallet || DEFAULT_PROXY_WALLET,
          },
        },
      });
      scan.candidates.push({ signal, asset, book, context, currentValueUsd, roundedExitSizeUsd });
      this.recordGabagoolMetric('gabagool_loss_guard_exit_candidate', {
        ...commonDetails,
        side: 'sell',
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        currentValueUsd,
        roundedExitSizeUsd,
        reason: 'loss_guard_reduce_only',
        exitMode,
      });
    }

    if (!scan.noExitReason && scan.positionsClosable === 0) {
      scan.noExitReason = this.dominantGabagoolLossGuardReason(scan.blockedReasons) || 'all_exits_blocked';
    }
    this.recordGabagoolMetric('gabagool_loss_guard_exit_scan', {
      reason: scan.noExitReason || 'scan_complete',
      positionsScanned: scan.positionsScanned,
      positionsClosable: scan.positionsClosable,
      source: scan.noExitReason,
      exitMode,
    });
    this.updateGabagoolCurrentCycle({
      positionsScanned: scan.positionsScanned,
      positionsClosable: scan.positionsClosable,
      noExitReason: scan.noExitReason,
      exitMode,
    });
    return scan;
  }

  async buildGabagoolExposureCapExitScan({ model, books = new Map(), now = Date.now() } = {}) {
    const markPrices = this.cache.markPrices();
    const ledger = this.gabagoolLedger(markPrices, now);
    const riskExposure = this.risk.exposureBreakdown(null, { markPrices });
    const exposureCapView = this.gabagoolPaperExposureCapView({
      markPrices,
      ledger,
      riskExposure,
      now,
    });
    const maxTotalExposureUsd = Math.max(0, Number(this.config.maxTotalExposureUsd || 0));
    const rawPortfolioExposureUsd = Math.max(0, Number(exposureCapView.rawPortfolioExposureUsd || 0));
    const capBlockingExposureUsdAfterExclusions = Math.max(0, Number(exposureCapView.capBlockingExposureUsdAfterExclusions || 0));
    const excludedDeadExposureUsd = Math.max(0, Number(exposureCapView.excludedDeadExposureUsd || 0));
    const activeTradableExposureUsd = Math.max(0, Number(exposureCapView.activeTradableExposureUsd || 0));
    const excessExposureUsd = maxTotalExposureUsd > 0
      ? Math.max(0, capBlockingExposureUsdAfterExclusions - maxTotalExposureUsd)
      : 0;
    const positions = exposureCapView.capBlockingPositions
      .slice()
      .sort((a, b) => Number(b.totalExposureUsd || 0) - Number(a.totalExposureUsd || 0));
    const largestExposurePositions = exposureCapView.classifiedPositions
      .slice()
      .sort((a, b) => Number(b.totalExposureUsd || 0) - Number(a.totalExposureUsd || 0))
      .slice(0, 5)
      .map((state) => ({
      tokenId: String(state.position?.tokenId || ''),
      marketSlug: String(state.context?.marketSlug || state.position?.marketSlug || ''),
      outcome: state.context?.outcome || state.position?.outcome || 'Unknown',
      totalExposureUsd: Number(state.position?.totalExposureUsd || state.position?.positionExposureUsd || 0),
      positionExposureUsd: Number(state.position?.positionExposureUsd || 0),
      openOrderExposureUsd: Number(state.position?.openOrderExposureUsd || 0),
      avgEntryPrice: Number.isFinite(Number(state.position?.avgEntryPrice)) ? Number(state.position.avgEntryPrice) : null,
      mark: Number.isFinite(Number(state.position?.mark)) ? Number(state.position.mark) : null,
      qty: Number(state.position?.qty || 0),
    }));
    const scan = {
      active: excessExposureUsd > 1e-9 && positions.length > 0,
      reason: excessExposureUsd > 1e-9 ? 'exposure_cap_waiting_for_exit' : null,
      capTriggerReason: excessExposureUsd > 1e-9 ? 'active_tradable_exposure_over_cap' : null,
      exitMode: 'exposure_cap_reduce_only',
      positionsScanned: 0,
      positionsClosable: 0,
      candidates: [],
      noExitReason: null,
      blockedReasons: new Map(),
      totalExposureUsd: capBlockingExposureUsdAfterExclusions,
      capBlockingExposureUsd: capBlockingExposureUsdAfterExclusions,
      portfolioExposureUsd: rawPortfolioExposureUsd,
      rawPortfolioExposureUsd,
      excludedDeadExposureUsd,
      excludedDeadExposureReasonSummary: riskExposure.excludedDeadExposureReasonSummary || 'none',
      capBlockingExposureUsdAfterExclusions,
      activeTradableExposureUsd,
      maxTotalExposureUsd,
      excessExposureUsd,
      largestExposurePositions,
      unfreezeReasonLast: null,
      stallGateBypassedBecauseOnlyExpiredDeadExposure: exposureCapView.bypassedBecauseOnlyExpiredDeadExposure === true,
    };
    if (!scan.active) return scan;

    const noteBlockedReason = (reason) => {
      if (!reason) return;
      scan.blockedReasons.set(reason, (scan.blockedReasons.get(reason) || 0) + 1);
    };
    const recordExposureCapBlocked = (reason, details = {}) => {
      noteBlockedReason(reason);
      this.recordGabagoolMetric('gabagool_reduce_only_exit_blocked', {
        reason,
        exitMode: scan.exitMode,
        ...details,
      });
    };
    const minDustExitUsd = Math.max(0.01, Number(this.config.gabagoolMinDustExitUsd || 0.01));
    const minReduceOnlyExitUsd = Math.max(0.01, Number(this.config.reduceOnlyMinExitUsd || 0.01));
    let remainingExcessUsd = excessExposureUsd;
    const classifyNoExitBidReason = (tradeabilityStatus, cleanupState) => {
      if (tradeabilityStatus === 'no_orderbook_404') return 'confirmed_no_orderbook_404';
      if (cleanupState?.staleMarket === true) return 'expired_btc_5m_no_bid';
      if (cleanupState?.staleEvidence === true) return 'resolution_pending_no_bid';
      if (tradeabilityStatus === 'stale_token_cooldown') return 'stale_token_cooldown_active_window';
      return 'no_exit_bid_available';
    };

    for (const positionState of positions) {
      const position = positionState.position;
      scan.positionsScanned += 1;
      const context = positionState.context;
      const cleanupState = positionState.cleanupState;
      const asset = this.buildGabagoolSyntheticAssetFromContext(context);
      const book = await this.getGabagoolBook(position.tokenId, books);
      const availableSellQty = this.portfolio.availablePositionQty(position.tokenId);
      const avgEntryPrice = Number(position.avgEntryPrice || this.portfolio.positionCostDetails(position.tokenId).avgEntryPrice || 0);
      const commonDetails = {
        tokenId: String(position.tokenId),
        marketId: context.marketId,
        marketSlug: context.marketSlug,
        marketQuestion: context.marketQuestion,
        outcome: context.outcome,
        positionQty: Number(position.qty || 0),
        availableSellQty,
      };
      if (!(availableSellQty > 0)) {
        recordExposureCapBlocked('valid_but_risk_or_execution_blocked', {
          ...commonDetails,
          source: 'inventory_validation_failed',
        });
        continue;
      }
      let tradeability = positionState.tradeability;
      if (!tradeability && this.portfolio.paperTokenTradeability instanceof Map) {
        tradeability = this.portfolio.paperTokenTradeability.get(String(position.tokenId || '')) || null;
      }
      if (!book) {
        if (this.portfolio.paperTokenTradeability instanceof Map) {
          tradeability = this.portfolio.paperTokenTradeability.get(String(position.tokenId || '')) || tradeability;
        }
        const tradeabilityStatus = String(tradeability?.status || '');
        const blockedReason = classifyNoExitBidReason(tradeabilityStatus, cleanupState);
        recordExposureCapBlocked(blockedReason, {
          ...commonDetails,
          source: tradeabilityStatus || 'book_fetch_failed',
          cooldownSec: Math.max(0, Math.round(Number(tradeability?.cooldownMsRemaining || 0) / 1000)),
        });
        continue;
      }
      if (!Number.isFinite(Number(book.bestBid)) || !(Number(book.bestBid) > 0) || Number(book.bestBid) >= 1) {
        recordExposureCapBlocked(classifyNoExitBidReason(String(tradeability?.status || ''), cleanupState), {
          ...commonDetails,
          source: 'best_bid_missing_or_invalid',
          price: Number.isFinite(Number(book?.bestBid)) ? Number(book.bestBid) : null,
        });
        continue;
      }
      if (!(avgEntryPrice > 0)) {
        recordExposureCapBlocked('valid_but_risk_or_execution_blocked', {
          ...commonDetails,
          source: 'invalid_avg_cost',
          price: Number(book.bestBid),
        });
        continue;
      }

      const currentValueUsd = availableSellQty * Number(book.bestBid);
      const roundedExitSizeUsd = Math.max(0, Math.round(currentValueUsd * 100) / 100);
      const minProfitPrice = avgEntryPrice + Math.max(0, Number(this.config.gabagoolMinProfitBuffer || 0));
      if (!(currentValueUsd > 0) || !(roundedExitSizeUsd > 0)) {
        this.recordGabagoolTinyExitState('gabagool_zero_size_blocked', {
          ...commonDetails,
          price: Number(book.bestBid),
          book,
          reason: 'zero_size_candidate',
          source: !(currentValueUsd > 0) ? 'position_value_non_positive' : 'position_value_rounds_to_zero',
          currentValueUsd,
          roundedExitSizeUsd,
        }, {
          skipPresophieBlock: true,
        });
        recordExposureCapBlocked('dust', {
          ...commonDetails,
          price: Number(book.bestBid),
          currentValueUsd,
          roundedExitSizeUsd,
          source: !(currentValueUsd > 0) ? 'position_value_non_positive' : 'position_value_rounds_to_zero',
        });
        continue;
      }
      if (roundedExitSizeUsd < minDustExitUsd) {
        this.recordGabagoolTinyExitState('gabagool_dust_position_remaining', {
          ...commonDetails,
          price: Number(book.bestBid),
          book,
          reason: 'dust_exit_below_min',
          source: cleanupState.staleOrExpired === true
            ? 'stale_market_position_value_below_dust_floor'
            : 'exposure_cap_position_value_below_dust_floor',
          currentValueUsd,
          roundedExitSizeUsd,
        }, {
          skipPresophieBlock: true,
        });
        recordExposureCapBlocked('dust', {
          ...commonDetails,
          price: Number(book.bestBid),
          currentValueUsd,
          roundedExitSizeUsd,
          source: cleanupState.staleOrExpired === true
            ? 'stale_market_position_value_below_dust_floor'
            : 'exposure_cap_position_value_below_dust_floor',
        });
        continue;
      }

      const profitableAtCost = Number(book.bestBid) >= avgEntryPrice - 1e-9;
      const profitableWithBuffer = Number(book.bestBid) >= minProfitPrice - 1e-9;
      if (!profitableAtCost) {
        this.recordGabagoolBlockedLossExit({
          ...commonDetails,
          side: 'sell',
          price: Number(book.bestBid),
          sizeUsd: roundedExitSizeUsd,
          avgEntryPrice,
          minProfitPrice,
          source: cleanupState.staleOrExpired ? 'exposure_cap_stale_market_blocked_loss_exit' : 'exposure_cap_blocked_loss_exit',
        }, now);
        recordExposureCapBlocked('valid_but_risk_or_execution_blocked', {
          ...commonDetails,
          side: 'sell',
          price: Number(book.bestBid),
          sizeUsd: roundedExitSizeUsd,
          avgEntryPrice,
          minProfitPrice,
          source: cleanupState.staleOrExpired ? 'exposure_cap_stale_market_blocked_loss_exit' : 'exposure_cap_blocked_loss_exit',
        });
        continue;
      }

      let candidateReason = null;
      let candidateSizeUsd = roundedExitSizeUsd;
      if (profitableWithBuffer) {
        candidateReason = cleanupState.staleOrExpired ? 'stale_market_profit_exit' : 'executable_profit_exit';
      } else if (cleanupState.staleOrExpired) {
        candidateReason = 'stale_market_cleanup';
      } else if (roundedExitSizeUsd < Math.max(0.01, Number(this.config.minOrderUsd || 0))) {
        candidateReason = 'reduce_only_dust_exit';
      } else if (remainingExcessUsd > 0) {
        candidateReason = 'exposure_cap_inventory_reduce';
        candidateSizeUsd = Math.max(minReduceOnlyExitUsd, Math.min(currentValueUsd, remainingExcessUsd));
        candidateSizeUsd = Math.round(candidateSizeUsd * 100) / 100;
        const remainingAfterSellUsd = Math.max(0, currentValueUsd - candidateSizeUsd);
        if (remainingAfterSellUsd > 0 && remainingAfterSellUsd < minReduceOnlyExitUsd) {
          candidateSizeUsd = roundedExitSizeUsd;
        }
      } else {
        recordExposureCapBlocked('valid_but_risk_or_execution_blocked', {
          ...commonDetails,
          price: Number(book.bestBid),
          currentValueUsd,
          roundedExitSizeUsd,
          avgEntryPrice,
          minProfitPrice,
          source: 'profit_buffer_not_met',
        });
        continue;
      }

      if (!(candidateSizeUsd > 0) || candidateSizeUsd < minReduceOnlyExitUsd) {
        recordExposureCapBlocked('dust', {
          ...commonDetails,
          price: Number(book.bestBid),
          sizeUsd: candidateSizeUsd,
          currentValueUsd,
          roundedExitSizeUsd,
          source: 'reduce_only_exit_below_min',
        });
        continue;
      }

      const signal = new Signal({
        strategy: 'GabagoolBtcOracleStrategy',
        tokenId: String(position.tokenId),
        marketId: context.marketId,
        side: 'sell',
        price: round(Number(book.bestBid)),
        sizeUsd: candidateSizeUsd,
        expectedEdge: round(Math.max(Number(this.config.minSignalEdge || 0), Math.abs(Number(book.bestBid) - avgEntryPrice))),
        confidence: round(clamp(
          candidateReason === 'executable_profit_exit' || candidateReason === 'stale_market_profit_exit' ? 0.74 :
            candidateReason === 'stale_market_cleanup' ? 0.68 :
              candidateReason === 'reduce_only_dust_exit' ? 0.66 : 0.64,
          0.35,
          0.95
        )),
        reason: `gabagool exposure-cap exit reason=${candidateReason}`,
        exitPlan: `Reduce-only exposure relief while max exposure is exceeded (${candidateReason})`,
        ttlMs: 10_000,
        maxHoldMs: 20_000,
        metadata: {
          marketSlug: context.marketSlug,
          marketQuestion: context.marketQuestion,
          outcome: context.outcome,
          exitMode: 'exposure_cap_reduce_only',
          gabagool: {
            oracleSignalFresh: false,
            exitIntent: true,
            exitTrigger: candidateReason,
            exitMode: 'exposure_cap_reduce_only',
            exposureCapWaitingForExit: true,
            sourceWallet: model?.source?.resolvedProxyWallet || DEFAULT_PROXY_WALLET,
          },
        },
      });
      scan.positionsClosable += 1;
      scan.unfreezeReasonLast = candidateReason;
      scan.candidates.push({
        signal,
        asset,
        book,
        context,
        currentValueUsd,
        roundedExitSizeUsd,
        candidateReason,
      });
      this.recordGabagoolMetric('gabagool_reduce_only_exit_candidate', {
        ...commonDetails,
        side: 'sell',
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        reason: candidateReason,
        exitMode: scan.exitMode,
        currentValueUsd,
        roundedExitSizeUsd,
        positionsScanned: scan.positionsScanned,
        positionsClosable: scan.positionsClosable,
        exposureAvailableUsd: Number(riskExposure.exposureAvailableUsd || 0),
        riskTotalExposureUsd: capBlockingExposureUsdAfterExclusions,
        maxTotalExposureUsd,
      });
      remainingExcessUsd = Math.max(0, remainingExcessUsd - candidateSizeUsd);
    }

    if (!scan.noExitReason && scan.positionsClosable === 0) {
      scan.noExitReason = this.dominantGabagoolLossGuardReason(scan.blockedReasons) || 'all_exits_blocked';
    }
    this.recordGabagoolMetric('gabagool_reduce_only_exit_scan', {
      reason: scan.noExitReason || 'scan_complete',
      capTriggerReason: scan.capTriggerReason,
      positionsScanned: scan.positionsScanned,
      positionsClosable: scan.positionsClosable,
      exitMode: scan.exitMode,
      riskTotalExposureUsd: capBlockingExposureUsdAfterExclusions,
      maxTotalExposureUsd,
      exposureAvailableUsd: Number(riskExposure.exposureAvailableUsd || 0),
      capBlockingExposureUsd: capBlockingExposureUsdAfterExclusions,
      rawPortfolioExposureUsd,
      capBlockingExposureUsdAfterExclusions,
      activeTradableExposureUsd,
      excludedDeadExposureUsd,
      blockedReasonSummary: [...scan.blockedReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}:${count}`)
        .join(',') || 'none',
      source: scan.noExitReason,
    });
    scan.dominantBlockedReason = this.dominantGabagoolLossGuardReason(scan.blockedReasons) || null;
    scan.blockedReasonSummary = [...scan.blockedReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}:${count}`)
      .join(',') || 'none';
    return scan;
  }

  lastStrategyFillTs(tokenId, strategy) {
    const fills = this.portfolio.fills
      .filter((fill) => String(fill.tokenId || '') === String(tokenId) && fill.strategy === strategy)
      .sort((a, b) => b.ts - a.ts);
    return fills[0]?.ts || null;
  }

  emitGabagoolUpdate(eventType, payload = {}) {
    return this.paperUpdates.record(eventType, payload);
  }

  recordGabagoolMetric(type, details = {}) {
    this.portfolio.recordExecutionEvent(type, {
      strategy: 'GabagoolBtcOracleStrategy',
      ...details,
    });
  }

  maybeEmitGabagoolExposureCapRiskRelay(signal, {
    sophieDecision = 'NOT_RUN',
    quality = null,
  } = {}) {
    if (!isGabagoolStrategy(signal) || String(signal?.side || '').toLowerCase() !== 'buy') return false;
    const maxTotalExposureUsd = Number(this.config.maxTotalExposureUsd || 0);
    if (!(maxTotalExposureUsd > 0)) return false;
    const riskDetails = this.risk.riskDetails(signal);
    if (!(Number(riskDetails?.wouldTotalExposureUsd || 0) > maxTotalExposureUsd)) return false;
    this.emitGabagoolUpdate('risk_blocked', {
      strategy: signal.strategy,
      marketSlug: signal.metadata?.marketSlug,
      marketQuestion: signal.metadata?.marketQuestion,
      tokenId: signal.tokenId,
      outcome: signal.metadata?.outcome,
      side: signal.side,
      price: signal.price,
      sizeUsd: signal.sizeUsd,
      expectedEdge: signal.expectedEdge,
      confidence: signal.confidence,
      sophieDecision,
      riskDecision: 'BLOCK:max_total_exposure',
      blockReason: 'max_total_exposure',
      oracleEventKey: signal.metadata?.gabagool?.oracleEventKey || null,
      distanceFromTouch: quality?.distanceFromTouch,
      predictedFillProbability: quality?.predictedFillProbability,
      ...riskDetails,
    });
    return true;
  }

  maybeRecordGabagoolDuplicatePlacementGuard(signal, book) {
    if (!isGabagoolStrategy(signal) || String(signal?.side || '').toLowerCase() !== 'buy') return false;
    const comparableOrders = this.execution.findComparableOpenOrders(signal);
    if (comparableOrders.length === 0) return false;
    const decisions = comparableOrders.map((order) => this.execution.shouldReplaceOpenOrder(order, signal, book));
    if (decisions.some((decision) => decision?.replace === true)) return false;

    const decision = decisions[0] || {};
    this.lastGabagoolPlacementBlockReason = 'duplicate_order';
    this.lastGabagoolPlacementDecision = 'PLACEMENT_BLOCKED:duplicate_order';
    this.recordGabagoolMetric('gabagool_placement_attempted', {
      tokenId: signal.tokenId,
      marketId: signal.marketId,
      marketSlug: signal.metadata?.marketSlug,
      outcome: signal.metadata?.outcome,
      side: signal.side,
      price: signal.price,
      sizeUsd: signal.sizeUsd,
      expectedEdge: signal.expectedEdge,
      confidence: signal.confidence,
      reason: 'attempt',
    });
    this.recordGabagoolMetric('gabagool_placement_blocked', {
      tokenId: signal.tokenId,
      marketId: signal.marketId,
      marketSlug: signal.metadata?.marketSlug,
      outcome: signal.metadata?.outcome,
      side: signal.side,
      price: signal.price,
      sizeUsd: signal.sizeUsd,
      expectedEdge: signal.expectedEdge,
      confidence: signal.confidence,
      reason: 'duplicate_order',
    });
    this.recordGabagoolMetric('gabagool_placement_decision', {
      tokenId: signal.tokenId,
      marketId: signal.marketId,
      marketSlug: signal.metadata?.marketSlug,
      outcome: signal.metadata?.outcome,
      side: signal.side,
      price: signal.price,
      sizeUsd: signal.sizeUsd,
      expectedEdge: signal.expectedEdge,
      confidence: signal.confidence,
      reason: this.lastGabagoolPlacementDecision,
    });
    this.portfolio.recordExecutionEvent('placement_block', {
      ...signal,
      marketSlug: signal?.metadata?.marketSlug,
      outcome: signal?.metadata?.outcome,
      reason: 'duplicate_order',
      detail: decision.reason || 'duplicate',
      source: 'gabagool_entry_guard_duplicate_open_order',
    });
    warn(
      `[GABAGOOL NO PLACE] stage=entry_guard reason=duplicate_order token=${shortId(signal.tokenId)} ` +
      `price=${fmtPrice(signal.price)} sizeUsd=${cleanLogValue(signal.sizeUsd)} detail=${cleanLogValue(decision.reason || 'duplicate')}`
    );
    return true;
  }

  recordGabagoolBlockedLossExit(details = {}, now = Date.now()) {
    const payload = {
      tokenId: details.tokenId ? String(details.tokenId) : null,
      marketId: details.marketId ? String(details.marketId) : null,
      marketSlug: details.marketSlug ? String(details.marketSlug) : null,
      marketQuestion: details.marketQuestion ? String(details.marketQuestion) : null,
      outcome: details.outcome ? String(details.outcome) : null,
      side: details.side || 'sell',
      price: Number.isFinite(Number(details.price)) ? Number(details.price) : null,
      sizeUsd: Number.isFinite(Number(details.sizeUsd)) ? Number(details.sizeUsd) : null,
      expectedEdge: Number.isFinite(Number(details.expectedEdge)) ? Number(details.expectedEdge) : null,
      confidence: Number.isFinite(Number(details.confidence)) ? Number(details.confidence) : null,
      avgEntryPrice: Number.isFinite(Number(details.avgEntryPrice)) ? Number(details.avgEntryPrice) : null,
      minProfitPrice: Number.isFinite(Number(details.minProfitPrice)) ? Number(details.minProfitPrice) : null,
      oracleEventKey: details.oracleEventKey || null,
      source: details.source || null,
    };
    const reentryCooldownMs = Math.max(1_000, Number(this.config.gabagoolReenterCooldownMs || 0));
    if (payload.marketSlug && payload.tokenId) {
      this.rememberGabagoolTokenEntryGuard({
        marketSlug: payload.marketSlug,
        tokenId: payload.tokenId,
        outcome: payload.outcome,
        reason: 'blocked_loss_exit_cooldown',
        expiresAt: now + reentryCooldownMs,
        permanent: false,
        ts: now,
      });
    }
    const suppression = this.consumeBlockedLossExitSuppression({
      tokenId: payload.tokenId,
      marketSlug: payload.marketSlug,
      outcome: payload.outcome,
    }, now);

    this.recordGabagoolMetric('gabagool_blocked_loss_exit', {
      ...payload,
      reason: 'blocked_loss_exit',
    });
    if (suppression.suppressed) {
      this.recordGabagoolMetric('gabagool_blocked_loss_exit_repeat', {
        ...payload,
        reason: 'blocked_loss_exit',
        source: details.source || 'suppressed_repeat',
      });
    } else {
      this.emitGabagoolUpdate('risk_blocked', {
        strategy: 'GabagoolBtcOracleStrategy',
        marketSlug: payload.marketSlug,
        marketQuestion: payload.marketQuestion,
        tokenId: payload.tokenId,
        outcome: payload.outcome,
        side: payload.side,
        price: payload.price,
        sizeUsd: payload.sizeUsd,
        expectedEdge: payload.expectedEdge,
        confidence: payload.confidence,
        blockReason: 'blocked_loss_exit',
        avgEntryPrice: payload.avgEntryPrice,
        sophieDecision: 'NOT_RUN',
        riskDecision: 'BLOCK:blocked_loss_exit',
        oracleEventKey: payload.oracleEventKey,
      });
      warn(
        `[GABAGOOL CAPITAL PROTECTION] reason=blocked_loss_exit token=${shortId(payload.tokenId)} ` +
        `marketSlug=${payload.marketSlug || 'unknown'} avgEntry=${fmtPrice(payload.avgEntryPrice)} ` +
        `sellPrice=${fmtPrice(payload.price)} minProfitPrice=${fmtPrice(payload.minProfitPrice)}`
      );
    }
    return suppression;
  }

  consumeBlockedLossExitSuppression(payload = {}, now = Date.now()) {
    const marketSlug = String(payload.marketSlug || 'unknown');
    const tokenId = String(payload.tokenId || 'unknown');
    const outcome = String(payload.outcome || 'unknown');
    const key = `${marketSlug}:${tokenId}:${outcome}`;
    const cooldownMs = Math.max(1_000, Number(this.config.gabagoolTelegramRiskBlockDedupeMs || 120_000));
    const current = this.gabagoolBlockedLossExitDedupe.get(key) || null;
    if (current && Number(current.expiresAt || 0) > now) {
      current.repeatCount = Number(current.repeatCount || 0) + 1;
      current.lastSeenAt = now;
      this.gabagoolBlockedLossExitDedupe.set(key, current);
      return {
        suppressed: true,
        repeatCount: current.repeatCount,
        cooldownMs,
      };
    }
    const repeatCount = current ? Number(current.repeatCount || 0) : 0;
    this.gabagoolBlockedLossExitDedupe.set(key, {
      expiresAt: now + cooldownMs,
      lastSeenAt: now,
      repeatCount: 0,
    });
    return {
      suppressed: false,
      repeatCount,
      cooldownMs,
    };
  }

  gabagoolLedger(markPrices = this.cache.markPrices(), now = Date.now()) {
    this.syncPortfolioMarks(markPrices);
    return this.portfolio.strategyLedger(isBtcOracleStrategy, markPrices, now);
  }

  gabagoolNetPnl(ledger = null) {
    const selectedLedger = ledger || this.gabagoolLedger();
    return Number(
      selectedLedger?.netAfterFeesEstimate ??
      ((Number(selectedLedger?.realizedPnl || 0)) + (Number(selectedLedger?.unrealizedPnl || 0)))
    );
  }

  gabagoolDrawdownPct(ledger = null) {
    const netPnl = this.gabagoolNetPnl(ledger);
    const baseCapitalUsd = Math.max(1, Number(this.config.initialCash || 0));
    return Math.max(0, (-netPnl / baseCapitalUsd) * 100);
  }

  gabagoolLossGuardTriggerEvent(now = Date.now()) {
    let fallback = null;
    for (let i = this.portfolio.executionEvents.length - 1; i >= 0; i -= 1) {
      const event = this.portfolio.executionEvents[i];
      const eventTs = Number(event?.ts || 0);
      if (!(eventTs > 0) || eventTs > now) continue;
      if (!isBtcOracleStrategy(event?.strategy)) continue;
      if (
        event.type === 'gabagool_blocked_loss_exit' ||
        (event.type === 'gabagool_exit' && (event.reason === 'loss_exit' || event.reason === 'blocked_loss_exit'))
      ) {
        return {
          ts: eventTs,
          type: event.type,
          reason: event.reason || event.type,
          source: event.type === 'gabagool_blocked_loss_exit'
            ? 'blocked_loss_exit'
            : String(event.reason || 'loss_exit'),
        };
      }
      if (fallback == null && (event.type === 'gabagool_exit' || event.type === 'fill')) {
        fallback = {
          ts: eventTs,
          type: event.type,
          reason: event.reason || event.type,
          source: event.type === 'gabagool_exit' ? 'recent_exit_fallback' : 'recent_fill_fallback',
        };
      }
    }
    if (fallback == null && Array.isArray(this.portfolio.fills)) {
      for (let i = this.portfolio.fills.length - 1; i >= 0; i -= 1) {
        const fill = this.portfolio.fills[i];
        const fillTs = Number(fill?.ts || 0);
        if (!(fillTs > 0) || fillTs > now) continue;
        if (!isBtcOracleStrategy(fill?.strategy)) continue;
        return {
          ts: fillTs,
          type: 'fill',
          reason: fill.side === 'sell' ? 'loss_exit_fill_fallback' : 'recent_fill_fallback',
          source: fill.side === 'sell' ? 'loss_exit_fill_fallback' : 'recent_fill_fallback',
        };
      }
    }
    return fallback;
  }

  gabagoolLossGuardState(markPrices = this.cache.markPrices(), now = Date.now()) {
    const ledger = this.gabagoolLedger(markPrices, now);
    const riskExposure = this.risk?.exposureBreakdown
      ? this.risk.exposureBreakdown(null, { markPrices, now })
      : {};
    const closedPnl = Number(ledger.closedPnl || 0);
    const closedLossUsd = Math.max(0, -closedPnl);
    const drawdownPct = this.gabagoolDrawdownPct(ledger);
    const pauseOnLoss = this.config.gabagoolPauseEntriesOnLoss === true;
    const maxDrawdownPct = Math.max(0, Number(this.config.gabagoolMaxPaperDrawdownPct || 0));
    const maxClosedLossUsd = Math.max(0, Number(this.config.gabagoolMaxPaperClosedLossUsd || 0));
    const cooldownMs = Math.max(0, Number(this.config.gabagoolLossGuardCooldownMs || 0));
    const blockedExitCooldownMs = Math.max(0, Number(this.config.gabagoolLossGuardBlockedExitCooldownMs || 0));
    const reasons = [];
    if (pauseOnLoss && drawdownPct > maxDrawdownPct) reasons.push('drawdown_pct_exceeded');
    if (pauseOnLoss && closedLossUsd > maxClosedLossUsd) reasons.push('closed_loss_exceeded');
    const thresholdTriggered = pauseOnLoss && reasons.length > 0;
    const triggerEvent = thresholdTriggered ? this.gabagoolLossGuardTriggerEvent(now) : null;
    const cooldownRemainingMs = triggerEvent
      ? Math.max(0, (Number(triggerEvent.ts || 0) + cooldownMs) - now)
      : 0;
    const activeBtcPositionExposureUsd = Number(riskExposure.btcOracleActiveTradableExposureUsd || 0);
    const openBtcOrderExposureUsd = Number(ledger.currentOpenOrderExposureUsd || 0);
    const staleBtcExposureUsd = (
      Number(riskExposure.btcOracleStaleNoBidExposureUsd || 0) +
      Number(riskExposure.btcOracleConfirmedNoOrderbook404ExposureUsd || 0)
    );
    const unresolvedBtcExposureUsd = (
      Number(riskExposure.btcOracleExpiredBtc5mExposureUsd || 0) +
      Number(riskExposure.btcOracleResolutionPendingExposureUsd || 0)
    );
    const dustBtcExposureUsd = Number(riskExposure.btcOracleDustExposureUsd || 0);
    let recentBlockedLossExitTs = null;
    for (let i = this.portfolio.executionEvents.length - 1; i >= 0; i -= 1) {
      const event = this.portfolio.executionEvents[i];
      const eventTs = Number(event?.ts || 0);
      if (!(eventTs > 0)) continue;
      if (eventTs < now - blockedExitCooldownMs) break;
      if (!isBtcOracleStrategy(event?.strategy)) continue;
      if (event.type !== 'gabagool_blocked_loss_exit') continue;
      recentBlockedLossExitTs = eventTs;
      break;
    }
    const recoveryBlockedReasons = [];
    if (thresholdTriggered && triggerEvent == null) recoveryBlockedReasons.push('loss_guard_trigger_not_observed');
    if (thresholdTriggered && cooldownRemainingMs > 0) recoveryBlockedReasons.push('cooldown_active');
    if (thresholdTriggered && activeBtcPositionExposureUsd > 0.01) recoveryBlockedReasons.push('active_btc_positions');
    if (thresholdTriggered && openBtcOrderExposureUsd > 0.01) recoveryBlockedReasons.push('open_btc_orders');
    if (thresholdTriggered && staleBtcExposureUsd > 0.01) recoveryBlockedReasons.push('stale_btc_exposure');
    if (thresholdTriggered && unresolvedBtcExposureUsd > 0.01) recoveryBlockedReasons.push('unresolved_btc_exposure');
    if (thresholdTriggered && dustBtcExposureUsd > 0.01) recoveryBlockedReasons.push('dust_btc_exposure');
    if (thresholdTriggered && recentBlockedLossExitTs != null) recoveryBlockedReasons.push('recent_blocked_loss_exit');
    const recoveryEligible = (
      thresholdTriggered &&
      this.config.enableLiveTrading !== true &&
      recoveryBlockedReasons.length === 0
    );
    return {
      paused: thresholdTriggered && !recoveryEligible,
      reason: thresholdTriggered && !recoveryEligible ? 'gabagool_loss_guard' : null,
      reasons,
      thresholdTriggered,
      ledger,
      drawdownPct,
      closedPnl,
      closedLossUsd,
      unrealizedPnl: Number(ledger.unrealizedPnl || 0),
      netPnl: this.gabagoolNetPnl(ledger),
      maxDrawdownPct,
      maxClosedLossUsd,
      cooldownMs,
      cooldownRemainingMs,
      triggerEvent,
      recoveryEligible,
      recoveryActive: recoveryEligible,
      recoveryBlockedReason: recoveryBlockedReasons[0] || null,
      recoveryBlockedReasons,
      activeBtcPositionExposureUsd,
      openBtcOrderExposureUsd,
      staleBtcExposureUsd,
      unresolvedBtcExposureUsd,
      dustBtcExposureUsd,
      recentBlockedLossExitTs,
      blockedExitCooldownMs,
    };
  }

  gabagoolNormalizeOutcome(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'up') return 'Up';
    if (normalized === 'down') return 'Down';
    return value ? String(value) : null;
  }

  gabagoolKnownOutcome(value) {
    const normalized = this.gabagoolNormalizeOutcome(value);
    return normalized === 'Up' || normalized === 'Down' ? normalized : null;
  }

  gabagoolMarketSlugForSignal(signal = null) {
    return String(signal?.metadata?.marketSlug || signal?.marketSlug || signal?.marketId || '');
  }

  gabagoolTargetOutcomeForToken(tokenId, marketSlug = '') {
    const target = this.lastGabagoolOracleTarget || null;
    if (!target || !tokenId) return null;
    const targetSlug = String(target.slug || '');
    if (targetSlug && marketSlug && String(marketSlug) !== targetSlug) return null;
    const key = String(tokenId || '');
    if (key === String(target.BTC_UP_TOKEN_ID || '')) return 'Up';
    if (key === String(target.BTC_DOWN_TOKEN_ID || '')) return 'Down';
    return null;
  }

  gabagoolTokenGuardKey(marketSlug, tokenId) {
    const slug = String(marketSlug || '');
    const token = String(tokenId || '');
    if (!slug || !token) return '';
    return `${slug}:${token}`;
  }

  pruneGabagoolSafetyGuards(now = Date.now()) {
    const retentionMs = 2 * 60 * 60_000;
    for (const [key, entry] of this.gabagoolTokenEntryGuards.entries()) {
      const expiresAt = Number(entry?.expiresAt || 0);
      const ts = Number(entry?.ts || 0);
      const permanent = entry?.permanent === true;
      if (!permanent && expiresAt > 0 && expiresAt <= now) {
        this.gabagoolTokenEntryGuards.delete(key);
        continue;
      }
      if (ts > 0 && (now - ts) > retentionMs) {
        this.gabagoolTokenEntryGuards.delete(key);
      }
    }
    for (const [key, entry] of this.gabagoolMarketLockouts.entries()) {
      const ts = Number(entry?.ts || 0);
      if (ts > 0 && (now - ts) > retentionMs) {
        this.gabagoolMarketLockouts.delete(key);
      }
    }
  }

  rememberGabagoolTokenEntryGuard({
    marketSlug,
    tokenId,
    reason,
    outcome = null,
    expiresAt = 0,
    permanent = false,
    ts = Date.now(),
  } = {}) {
    const key = this.gabagoolTokenGuardKey(marketSlug, tokenId);
    if (!key) return null;
    const nextEntry = {
      marketSlug: String(marketSlug || ''),
      tokenId: String(tokenId || ''),
      reason: reason || 'guarded',
      outcome: this.gabagoolNormalizeOutcome(outcome),
      expiresAt: Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : 0,
      permanent: permanent === true,
      ts,
    };
    const previous = this.gabagoolTokenEntryGuards.get(key);
    if (previous?.permanent === true && nextEntry.permanent !== true) {
      return previous;
    }
    this.gabagoolTokenEntryGuards.set(key, nextEntry);
    return nextEntry;
  }

  rememberGabagoolMarketLockout({
    marketSlug,
    reason,
    tokenId = null,
    outcome = null,
    ts = Date.now(),
    notify = false,
  } = {}) {
    const slug = String(marketSlug || '');
    if (!slug) return false;
    const prior = this.gabagoolMarketLockouts.get(slug) || null;
    const nextEntry = {
      marketSlug: slug,
      reason: reason || 'market_lockout',
      tokenId: tokenId ? String(tokenId) : null,
      outcome: this.gabagoolNormalizeOutcome(outcome),
      ts,
    };
    const changed = !prior ||
      prior.reason !== nextEntry.reason ||
      prior.tokenId !== nextEntry.tokenId ||
      prior.outcome !== nextEntry.outcome;
    this.gabagoolMarketLockouts.set(slug, nextEntry);
    this.lastGabagoolMarketLockoutReason = nextEntry.reason;
    if (!changed) return false;

    this.recordGabagoolMetric('gabagool_market_lockout_set', {
      tokenId: nextEntry.tokenId,
      marketSlug: slug,
      outcome: nextEntry.outcome,
      side: 'buy',
      reason: nextEntry.reason,
    });
    if (notify) {
      this.emitGabagoolUpdate('risk_blocked', {
        strategy: 'GabagoolBtcOracleStrategy',
        marketSlug: slug,
        tokenId: nextEntry.tokenId,
        outcome: nextEntry.outcome,
        side: 'buy',
        blockReason: nextEntry.reason,
        sophieDecision: 'NOT_RUN',
        riskDecision: `BLOCK:${nextEntry.reason}`,
      });
    }
    return true;
  }

  gabagoolActiveMarketDirections(marketSlug = '', markPrices = this.cache.markPrices()) {
    const targetSlug = String(marketSlug || '');
    if (!targetSlug) {
      return {
        outcomes: [],
        tokenIds: [],
        ignoredStaleDust: [],
        ignoredUnknownDirection: [],
      };
    }
    const outcomes = new Set();
    const tokenIds = new Set();
    const ignoredStaleDust = [];
    const ignoredUnknownDirection = [];
    const minDustUsd = Math.max(0.01, Number(this.config.gabagoolMinDustExitUsd || 0.01));

    const resolveKnownOutcome = (tokenId, rawOutcome) => {
      const directOutcome = this.gabagoolKnownOutcome(rawOutcome);
      if (directOutcome) return { outcome: directOutcome, source: 'direct' };
      const derivedOutcome = this.gabagoolTargetOutcomeForToken(tokenId, targetSlug);
      if (derivedOutcome) return { outcome: derivedOutcome, source: 'target_token_match' };
      return { outcome: null, source: 'unknown' };
    };

    for (const order of this.portfolio.openOrders.values()) {
      if (!isGabagoolStrategy(order?.strategy)) continue;
      if (this.gabagoolMarketSlugForSignal(order?.signal || order) !== targetSlug) continue;
      const resolvedOutcome = resolveKnownOutcome(
        order?.tokenId,
        order?.signal?.metadata?.outcome || order?.metadata?.outcome
      );
      if (!resolvedOutcome.outcome) {
        ignoredUnknownDirection.push({
          tokenId: String(order?.tokenId || ''),
          marketSlug: targetSlug,
          outcome: this.gabagoolNormalizeOutcome(order?.signal?.metadata?.outcome || order?.metadata?.outcome) || 'Unknown',
          source: 'open_order_unknown_direction',
          outcomeSource: resolvedOutcome.source,
        });
        continue;
      }
      outcomes.add(resolvedOutcome.outcome);
      if (order?.tokenId) tokenIds.add(String(order.tokenId));
    }

    for (const [tokenId, qty] of this.portfolio.positions.entries()) {
      if (!(Number(qty) > 0)) continue;
      const hasGabagoolHistory =
        this.portfolio.executionEvents.some((event) => (
          isBtcOracleStrategy(event?.strategy) &&
          String(event?.tokenId || '') === String(tokenId)
        )) ||
        this.portfolio.fills.some((fill) => (
          isBtcOracleStrategy(fill?.strategy) &&
          String(fill?.tokenId || '') === String(tokenId)
        ));
      if (!hasGabagoolHistory) continue;
      const context = this.gabagoolPositionContext(tokenId, this.portfolio.positionMarketId(tokenId));
      if (String(context.marketSlug || '') !== targetSlug) continue;
      const mark = Number(this.portfolio.markPriceForExposure(tokenId, markPrices));
      const currentValueUsd = Number(qty) * (Number.isFinite(mark) && mark > 0 ? mark : 0);
      if (!(currentValueUsd > minDustUsd + 1e-9)) {
        ignoredStaleDust.push({
          tokenId: String(tokenId),
          marketSlug: targetSlug,
          outcome: this.gabagoolNormalizeOutcome(context.outcome) || 'Unknown',
          currentValueUsd,
          positionQty: Number(qty),
          marketSlugSource: context.marketSlugSource,
          outcomeSource: context.outcomeSource,
          reason: context.directMarketEvidence === true
            ? 'same_market_dust_position'
            : 'stale_or_unconfirmed_dust_position',
        });
        if (
          context.directMarketEvidence !== true ||
          !this.gabagoolKnownOutcome(context.outcome)
        ) {
          ignoredUnknownDirection.push({
            tokenId: String(tokenId),
            marketSlug: targetSlug,
            outcome: this.gabagoolNormalizeOutcome(context.outcome) || 'Unknown',
            currentValueUsd,
            positionQty: Number(qty),
            marketSlugSource: context.marketSlugSource,
            outcomeSource: context.outcomeSource,
            reason: 'dust_position_unknown_or_unconfirmed_direction',
          });
        }
        continue;
      }
      if (context.directMarketEvidence !== true) {
        ignoredUnknownDirection.push({
          tokenId: String(tokenId),
          marketSlug: targetSlug,
          outcome: this.gabagoolNormalizeOutcome(context.outcome) || 'Unknown',
          currentValueUsd,
          positionQty: Number(qty),
          marketSlugSource: context.marketSlugSource,
          outcomeSource: context.outcomeSource,
          reason: 'same_market_unconfirmed_direction',
        });
        continue;
      }
      const resolvedOutcome = resolveKnownOutcome(tokenId, context.outcome);
      if (!resolvedOutcome.outcome) {
        ignoredUnknownDirection.push({
          tokenId: String(tokenId),
          marketSlug: targetSlug,
          outcome: this.gabagoolNormalizeOutcome(context.outcome) || 'Unknown',
          currentValueUsd,
          positionQty: Number(qty),
          marketSlugSource: context.marketSlugSource,
          outcomeSource: context.outcomeSource,
          reason: 'same_market_unknown_direction',
        });
        continue;
      }
      outcomes.add(resolvedOutcome.outcome);
      tokenIds.add(String(tokenId));
    }

    return {
      outcomes: [...outcomes],
      tokenIds: [...tokenIds],
      ignoredStaleDust,
      ignoredUnknownDirection,
    };
  }

  gabagoolExplicitLossExitAllowed(signal = null) {
    return (
      signal?.metadata?.reduceOnly === true ||
      signal?.metadata?.exitMode === 'loss_guard_reduce_only' ||
      signal?.metadata?.gabagool?.exitMode === 'loss_guard_reduce_only' ||
      signal?.metadata?.gabagool?.exitTrigger === 'loss_guard_reduce_only'
    );
  }

  gabagoolExitGuard(signal, now = Date.now()) {
    if (!isGabagoolStrategy(signal) || String(signal?.side || '').toLowerCase() !== 'sell') {
      return { blocked: false, reason: null };
    }

    const tokenId = String(signal?.tokenId || '');
    const marketSlug = this.gabagoolMarketSlugForSignal(signal);
    const outcome = this.gabagoolNormalizeOutcome(signal?.metadata?.outcome);
    const sellPrice = Number(signal?.price);
    const positionCost = this.portfolio.positionCostDetails(tokenId);
    const avgEntryPrice = Number(positionCost?.avgEntryPrice || this.portfolio.avgCost(tokenId) || 0);
    const minProfitBuffer = Math.max(0, Number(this.config.gabagoolMinProfitBuffer || 0));
    const minProfitPrice = avgEntryPrice + minProfitBuffer;
    const explicitLossExitAllowed = this.gabagoolExplicitLossExitAllowed(signal);
    const profitBufferBypassAllowed = this.gabagoolProfitBufferBypassAllowed(signal);

    if (!(avgEntryPrice > 0) || !Number.isFinite(sellPrice) || sellPrice <= 0) {
      return { blocked: false, reason: null };
    }
    if (!explicitLossExitAllowed && sellPrice < avgEntryPrice - 1e-9) {
      return {
        blocked: true,
        reason: 'blocked_loss_exit',
        marketSlug,
        tokenId,
        outcome,
        avgEntryPrice,
        sellPrice,
        minProfitPrice,
        minProfitBuffer,
      };
    }
    if (!profitBufferBypassAllowed && sellPrice < minProfitPrice - 1e-9) {
      return {
        blocked: true,
        reason: 'profit_buffer_not_met',
        marketSlug,
        tokenId,
        outcome,
        avgEntryPrice,
        sellPrice,
        minProfitPrice,
        minProfitBuffer,
      };
    }
    return {
      blocked: false,
      reason: null,
      marketSlug,
      tokenId,
      outcome,
      avgEntryPrice,
      sellPrice,
      minProfitPrice,
      minProfitBuffer,
      explicitLossExitAllowed,
      profitBufferBypassAllowed,
      forcedLossExit: explicitLossExitAllowed && sellPrice < avgEntryPrice - 1e-9,
    };
  }

  gabagoolLifecycleConflictGuard(signal, now = Date.now()) {
    if (!isGabagoolStrategy(signal)) return { blocked: false, reason: null };
    this.pruneGabagoolSafetyGuards(now);

    const tokenId = String(signal?.tokenId || '');
    const marketSlug = this.gabagoolMarketSlugForSignal(signal);
    const side = String(signal?.side || '').toLowerCase();
    if (!tokenId || !marketSlug || !side) return { blocked: false, reason: null };

    const opposingOrder = [...this.portfolio.openOrders.values()].find((order) => (
      isGabagoolStrategy(order?.strategy) &&
      String(order?.tokenId || '') === tokenId &&
      this.gabagoolMarketSlugForSignal(order?.signal || order) === marketSlug &&
      String(order?.side || '').toLowerCase() !== side
    ));
    if (!opposingOrder) return { blocked: false, reason: null };

    return {
      blocked: true,
      reason: side === 'buy' ? 'gabagool_reentry_guard' : 'gabagool_lifecycle_overlap',
      guardType: 'opposing_open_order',
      tokenId,
      marketSlug,
      opposingSide: String(opposingOrder.side || '').toLowerCase(),
    };
  }

  onGabagoolSellPlaced(signal, now = Date.now()) {
    const exitGuard = this.gabagoolExitGuard(signal, now);
    if (exitGuard.forcedLossExit) {
      this.rememberGabagoolMarketLockout({
        marketSlug: exitGuard.marketSlug,
        reason: 'loss_exit_market_lockout',
        tokenId: exitGuard.tokenId,
        outcome: exitGuard.outcome,
        ts: now,
        notify: true,
      });
    }
  }

  onGabagoolSellFill({ order, fillDetails, exitClassification, now = Date.now() } = {}) {
    if (!order || !fillDetails) return null;
    const marketSlug = this.gabagoolMarketSlugForSignal(order.signal || order);
    const tokenId = String(order.tokenId || '');
    const outcome = this.gabagoolNormalizeOutcome(order.signal?.metadata?.outcome);
    const cooldownMs = Math.max(0, Number(this.config.gabagoolReenterCooldownMs || 0));
    const expiresAt = cooldownMs > 0 ? now + cooldownMs : now;

    if (marketSlug && tokenId) {
      this.rememberGabagoolTokenEntryGuard({
        marketSlug,
        tokenId,
        outcome,
        reason: 'recent_sell_cooldown',
        expiresAt,
        permanent: false,
        ts: now,
      });
    }

    const positionQtyAfter = Number(fillDetails.positionQtyAfter || 0);
    const remainingMark = Number(this.portfolio.markPriceForExposure(tokenId));
    const remainingValueUsd = positionQtyAfter * (
      Number.isFinite(remainingMark) && remainingMark > 0
        ? remainingMark
        : Number(fillDetails?.sellPrice || order?.price || 0)
    );
    const completedRoundTrip = (
      positionQtyAfter <= 1e-9 ||
      (remainingValueUsd > 0 && remainingValueUsd < Math.max(0.01, Number(this.config.minOrderUsd || 0)))
    );
    if (completedRoundTrip && marketSlug && tokenId) {
      this.rememberGabagoolTokenEntryGuard({
        marketSlug,
        tokenId,
        outcome,
        reason: this.config.gabagoolAllowMarketReentry === true
          ? 'recent_sell_cooldown'
          : 'round_trip_reentry_disabled',
        expiresAt,
        permanent: this.config.gabagoolAllowMarketReentry !== true,
        ts: now,
      });
    }

    if (exitClassification === 'loss_exit' || exitClassification === 'blocked_loss_exit') {
      this.rememberGabagoolMarketLockout({
        marketSlug,
        reason: 'loss_exit_market_lockout',
        tokenId,
        outcome,
        ts: now,
        notify: true,
      });
      if (marketSlug && tokenId) {
        this.rememberGabagoolTokenEntryGuard({
          marketSlug,
          tokenId,
          outcome,
          reason: 'loss_exit_market_lockout',
          expiresAt,
          permanent: true,
          ts: now,
        });
      }
    }

    return {
      marketSlug,
      tokenId,
      outcome,
      cooldownMs,
    };
  }

  gabagoolRecentSameTokenLossState({
    tokenId,
    marketSlug,
    outcome = null,
    now = Date.now(),
  } = {}) {
    const key = String(tokenId || '');
    if (!key) {
      return {
        blocked: true,
        reason: 'gabagool_reentry_guard_uncertain_state',
        guardType: 'missing_token_id',
      };
    }

    const knownOutcome = this.gabagoolKnownOutcome(outcome);
    const maxAgeMs = Math.max(1_000, Number(this.config.gabagoolReenterCooldownMs || 0));
    const cutoffTs = now - maxAgeMs;
    for (let i = this.portfolio.executionEvents.length - 1; i >= 0; i -= 1) {
      const event = this.portfolio.executionEvents[i];
      const eventTs = Number(event?.ts || 0);
      if (eventTs > 0 && eventTs < cutoffTs) break;
      if (!isBtcOracleStrategy(event?.strategy)) continue;
      if (String(event?.tokenId || '') !== key) continue;
      if (
        event.type !== 'gabagool_blocked_loss_exit' &&
        !(event.type === 'gabagool_exit' && (event.reason === 'loss_exit' || event.reason === 'blocked_loss_exit'))
      ) {
        continue;
      }

      const eventMarketSlug = String(event?.marketSlug || event?.marketId || '');
      const eventOutcome = this.gabagoolKnownOutcome(event?.outcome);
      if (
        (marketSlug && eventMarketSlug && eventMarketSlug !== marketSlug) ||
        (knownOutcome && eventOutcome && eventOutcome !== knownOutcome)
      ) {
        return {
          blocked: true,
          reason: 'gabagool_reentry_guard_uncertain_state',
          guardType: 'conflicting_recent_loss_state',
          tokenId: key,
          marketSlug,
          outcome: knownOutcome,
          recentEventType: event.type,
          recentEventReason: event.reason || null,
          recentEventMarketSlug: eventMarketSlug || null,
          recentEventOutcome: eventOutcome || null,
          recentEventAgeMs: eventTs > 0 ? Math.max(0, now - eventTs) : null,
        };
      }
      return {
        blocked: true,
        reason: 'gabagool_reentry_guard',
        guardType: event.type === 'gabagool_blocked_loss_exit'
          ? 'recent_blocked_loss_exit'
          : 'recent_loss_exit',
        tokenId: key,
        marketSlug: marketSlug || eventMarketSlug || null,
        outcome: knownOutcome || eventOutcome || null,
        recentEventType: event.type,
        recentEventReason: event.reason || null,
        recentEventAgeMs: eventTs > 0 ? Math.max(0, now - eventTs) : null,
        reenterCooldownMs: maxAgeMs,
      };
    }
    return { blocked: false, reason: null };
  }

  gabagoolSameTokenEntryGuard(signal, markPrices = this.cache.markPrices(), now = Date.now()) {
    if (!isGabagoolStrategy(signal) || String(signal?.side || '').toLowerCase() !== 'buy') {
      return { blocked: false, reason: null };
    }

    const tokenId = String(signal?.tokenId || '');
    if (!tokenId) {
      return {
        blocked: true,
        reason: 'gabagool_reentry_guard_uncertain_state',
        guardType: 'missing_token_id',
      };
    }

    const marketSlug = this.gabagoolMarketSlugForSignal(signal);
    const outcome = this.gabagoolKnownOutcome(signal?.metadata?.outcome) ||
      this.gabagoolTargetOutcomeForToken(tokenId, marketSlug);
    const matchingOrders = [...this.portfolio.openOrders.values()]
      .filter((order) => (
        isGabagoolStrategy(order?.strategy) &&
        String(order?.tokenId || '') === tokenId &&
        Number(order?.remainingUsd?.() || 0) > 0
      ))
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    if (matchingOrders.length > 0) {
      const conflictingOrder = matchingOrders.find((order) => {
        const orderMarketSlug = this.gabagoolMarketSlugForSignal(order?.signal || order);
        const orderOutcome = this.gabagoolKnownOutcome(order?.signal?.metadata?.outcome || order?.metadata?.outcome) ||
          this.gabagoolTargetOutcomeForToken(order?.tokenId, orderMarketSlug || marketSlug);
        return (
          (marketSlug && orderMarketSlug && orderMarketSlug !== marketSlug) ||
          (outcome && orderOutcome && orderOutcome !== outcome)
        );
      });
      if (conflictingOrder) {
        return {
          blocked: true,
          reason: 'gabagool_reentry_guard_uncertain_state',
          guardType: 'conflicting_open_order_state',
          tokenId,
          marketSlug,
          outcome,
          conflictingOrderSide: String(conflictingOrder?.side || '').toLowerCase() || null,
          conflictingOrderMarketSlug: this.gabagoolMarketSlugForSignal(conflictingOrder?.signal || conflictingOrder) || null,
          conflictingOrderOutcome: this.gabagoolKnownOutcome(
            conflictingOrder?.signal?.metadata?.outcome || conflictingOrder?.metadata?.outcome
          ) || null,
          openOrderCount: matchingOrders.length,
        };
      }
      const order = matchingOrders[0];
      return {
        blocked: true,
        reason: 'gabagool_reentry_guard',
        guardType: 'same_token_open_order',
        tokenId,
        marketSlug,
        outcome,
        openOrderSide: String(order?.side || '').toLowerCase() || null,
        openOrderCount: matchingOrders.length,
        openOrderAgeMs: Number(order?.createdAt) > 0 ? Math.max(0, now - Number(order.createdAt)) : null,
      };
    }

    const positionQty = Number(this.portfolio.position(tokenId) || 0);
    if (positionQty > 0) {
      const context = this.gabagoolPositionContext(tokenId, this.portfolio.positionMarketId(tokenId) || signal?.marketId);
      const contextOutcome = this.gabagoolKnownOutcome(context?.outcome) ||
        this.gabagoolTargetOutcomeForToken(tokenId, context?.marketSlug || marketSlug);
      if (
        (marketSlug && context?.marketSlug && String(context.marketSlug) !== marketSlug) ||
        (outcome && contextOutcome && contextOutcome !== outcome)
      ) {
        return {
          blocked: true,
          reason: 'gabagool_reentry_guard_uncertain_state',
          guardType: 'conflicting_position_state',
          tokenId,
          marketSlug,
          outcome,
          positionMarketSlug: context?.marketSlug || null,
          positionOutcome: contextOutcome || null,
          positionQty,
        };
      }
      const cleanupState = this.gabagoolExposureCleanupState(context, now);
      const tradeability = this.portfolio.paperTokenTradeability instanceof Map
        ? (this.portfolio.paperTokenTradeability.get(tokenId) || null)
        : null;
      const tradeabilityStatus = String(tradeability?.status || '');
      const mark = Number(this.portfolio.markPriceForExposure(tokenId, markPrices));
      const positionValueUsd = positionQty * (
        Number.isFinite(mark) && mark > 0
          ? mark
          : Number(signal?.price || 0)
      );
      let guardType = 'active_position';
      if (cleanupState?.staleMarket === true) {
        guardType = 'expired_btc_5m_exposure';
      } else if (tradeabilityStatus === 'no_orderbook_404') {
        guardType = 'confirmed_no_orderbook_404_exposure';
      } else if (
        cleanupState?.staleEvidence === true ||
        tradeabilityStatus === 'stale_token_cooldown' ||
        tradeabilityStatus === 'no_bid'
      ) {
        guardType = 'unresolved_btc_5m_exposure';
      }
      return {
        blocked: true,
        reason: 'gabagool_reentry_guard',
        guardType,
        tokenId,
        marketSlug,
        outcome: outcome || contextOutcome || null,
        positionQty,
        positionValueUsd,
        tradeabilityStatus: tradeabilityStatus || null,
        staleMarket: cleanupState?.staleMarket === true,
        staleEvidence: cleanupState?.staleEvidence === true,
        lastEvidenceAgeMs: Number.isFinite(Number(cleanupState?.lastEvidenceAgeMs))
          ? Number(cleanupState.lastEvidenceAgeMs)
          : null,
      };
    }

    return this.gabagoolRecentSameTokenLossState({
      tokenId,
      marketSlug,
      outcome,
      now,
    });
  }

  recordGabagoolSameMarketIgnores(signal, activeDirections = {}) {
    if (!signal || !activeDirections) return;
    if (!signal.metadata || typeof signal.metadata !== 'object') signal.metadata = {};
    if (!signal.metadata.gabagool || typeof signal.metadata.gabagool !== 'object') {
      signal.metadata.gabagool = {};
    }
    if (signal.metadata.gabagool.sameMarketIgnoreMetricsRecorded === true) return;

    const common = {
      tokenId: signal?.tokenId,
      marketId: signal?.marketId,
      marketSlug: this.gabagoolMarketSlugForSignal(signal),
      outcome: signal?.metadata?.outcome,
      side: signal?.side,
      price: signal?.price,
      sizeUsd: signal?.sizeUsd,
      expectedEdge: signal?.expectedEdge,
      confidence: signal?.confidence,
    };

    for (const ignored of activeDirections.ignoredStaleDust || []) {
      this.recordGabagoolMetric('gabagool_stale_dust_ignored', {
        ...common,
        sourceTokenId: ignored.tokenId,
        sourceOutcome: ignored.outcome,
        sourceCurrentValueUsd: ignored.currentValueUsd,
        sourcePositionQty: ignored.positionQty,
        marketSlugSource: ignored.marketSlugSource,
        outcomeSource: ignored.outcomeSource,
        reason: ignored.reason || 'same_market_stale_dust_ignored',
      });
    }
    for (const ignored of activeDirections.ignoredUnknownDirection || []) {
      this.recordGabagoolMetric('gabagool_same_market_unknown_direction_ignored', {
        ...common,
        sourceTokenId: ignored.tokenId,
        sourceOutcome: ignored.outcome,
        sourceCurrentValueUsd: ignored.currentValueUsd,
        sourcePositionQty: ignored.positionQty,
        marketSlugSource: ignored.marketSlugSource,
        outcomeSource: ignored.outcomeSource,
        reason: ignored.reason || 'same_market_unknown_direction_ignored',
      });
    }

    signal.metadata.gabagool.sameMarketIgnoreMetricsRecorded = true;
  }

  gabagoolRoundTripState(tokenId, marketId, markPrices = this.cache.markPrices(), now = Date.now()) {
    const ledger = this.gabagoolLedger(markPrices, now);
    const roundTrips = (ledger.roundTrips || [])
      .filter((trip) => String(trip.tokenId || '') === String(tokenId || ''))
      .filter((trip) => String(trip.marketId || '') === String(marketId || ''))
      .sort((a, b) => Number(a.exitTs || 0) - Number(b.exitTs || 0));
    const realizedPnl = roundTrips.reduce((sum, trip) => sum + Number(trip.realizedPnl || 0), 0);
    const lastTrip = roundTrips[roundTrips.length - 1] || null;
    const lastTripImprovedRealizedPnl = Number(lastTrip?.realizedPnl || 0) > 0;
    const lastExitAgeMs = lastTrip ? Math.max(0, now - Number(lastTrip.exitTs || 0)) : null;
    const withinCooldown = lastExitAgeMs != null && lastExitAgeMs < Math.max(0, Number(this.config.gabagoolReenterCooldownMs || 0));
    const roundTripCapReached = roundTrips.length >= Math.max(1, Number(this.config.gabagoolMaxRoundTripsPerTokenPerMarket || 1));
    return {
      ledger,
      roundTrips,
      realizedPnl,
      lastTrip,
      lastTripImprovedRealizedPnl,
      lastExitAgeMs,
      withinCooldown,
      roundTripCapReached,
    };
  }

  gabagoolEntryGuard(signal, markPrices = this.cache.markPrices(), now = Date.now()) {
    if (!isGabagoolStrategy(signal) || String(signal?.side || '').toLowerCase() !== 'buy') {
      return { blocked: false, reason: null };
    }

    this.pruneGabagoolSafetyGuards(now);

    const marketSlug = this.gabagoolMarketSlugForSignal(signal);
    const tokenId = String(signal?.tokenId || '');
    const outcome = this.gabagoolNormalizeOutcome(signal?.metadata?.outcome);
    const tokenGuardKey = this.gabagoolTokenGuardKey(marketSlug, tokenId);
    const marketLockout = marketSlug ? (this.gabagoolMarketLockouts.get(marketSlug) || null) : null;
    if (marketLockout) {
      return {
        blocked: true,
        reason: 'gabagool_market_lockout',
        guardType: 'market_lockout',
        tokenId,
        marketSlug,
        outcome,
        marketLockoutReason: marketLockout.reason,
      };
    }

    const tokenGuard = tokenGuardKey ? (this.gabagoolTokenEntryGuards.get(tokenGuardKey) || null) : null;
    if (
      tokenGuard &&
      (
        tokenGuard.permanent === true ||
        Number(tokenGuard.expiresAt || 0) > now
      )
    ) {
      const tokenGuardType = tokenGuard.permanent === true
        ? 'round_trip_lockout'
        : tokenGuard.reason === 'blocked_loss_exit_cooldown'
          ? 'recent_blocked_loss_exit'
          : 'recent_sell_cooldown';
      return {
        blocked: true,
        reason: 'gabagool_reentry_guard',
        guardType: tokenGuardType,
        tokenId,
        marketSlug,
        outcome,
        reenterCooldownMs: Math.max(0, Number(this.config.gabagoolReenterCooldownMs || 0)),
        guardReason: tokenGuard.reason,
        expiresAt: Number(tokenGuard.expiresAt || 0),
      };
    }

    const sameTokenGuard = this.gabagoolSameTokenEntryGuard(signal, markPrices, now);
    if (sameTokenGuard.blocked) return sameTokenGuard;

    const activeDirections = this.gabagoolActiveMarketDirections(marketSlug, markPrices);
    this.recordGabagoolSameMarketIgnores(signal, activeDirections);
    if (
      outcome &&
      activeDirections.outcomes.length > 0 &&
      activeDirections.outcomes.some((value) => value && value !== outcome)
    ) {
      return {
        blocked: true,
        reason: 'gabagool_same_market_direction_guard',
        guardType: 'same_market_direction',
        tokenId,
        marketSlug,
        outcome,
        activeDirections: activeDirections.outcomes.join('|'),
        ignoredStaleDustCount: (activeDirections.ignoredStaleDust || []).length,
        ignoredUnknownDirectionCount: (activeDirections.ignoredUnknownDirection || []).length,
      };
    }

    const lossGuard = this.gabagoolLossGuardState(markPrices, now);
    if (lossGuard.paused) {
      return {
        blocked: true,
        reason: 'gabagool_loss_guard',
        guardType: 'loss_guard',
        gabagoolEntriesPaused: true,
        gabagoolEntryPauseReason: 'gabagool_loss_guard',
        gabagool_entries_paused_loss_guard: true,
        drawdownPct: lossGuard.drawdownPct,
        closedLossUsd: lossGuard.closedLossUsd,
        closedPnl: lossGuard.closedPnl,
        unrealizedPnl: lossGuard.unrealizedPnl,
        netPnl: lossGuard.netPnl,
        maxDrawdownPct: lossGuard.maxDrawdownPct,
        maxClosedLossUsd: lossGuard.maxClosedLossUsd,
        lossGuardReasons: lossGuard.reasons.join('|'),
        lossGuardCooldownMs: lossGuard.cooldownMs,
        lossGuardCooldownRemainingMs: lossGuard.cooldownRemainingMs,
        lossGuardRecoveryEligible: lossGuard.recoveryEligible === true,
        lossGuardRecoveryBlockedReason: lossGuard.recoveryBlockedReason || null,
        lossGuardRecoveryBlockedReasons: lossGuard.recoveryBlockedReasons.join('|'),
        lossGuardTriggerSource: lossGuard.triggerEvent?.source || null,
      };
    }

    const roundTripState = this.gabagoolRoundTripState(signal.tokenId, signal.marketId, markPrices, now);
    if (
      roundTripState.lastTrip &&
      roundTripState.withinCooldown &&
      !roundTripState.lastTripImprovedRealizedPnl
    ) {
      return {
        blocked: true,
        reason: 'gabagool_churn_guard',
        guardType: 'reenter_cooldown',
        tokenId,
        marketSlug,
        outcome,
        roundTrips: roundTripState.roundTrips.length,
        realizedPnl: roundTripState.realizedPnl,
        lastRoundTripPnl: Number(roundTripState.lastTrip.realizedPnl || 0),
        lastExitAgeMs: roundTripState.lastExitAgeMs,
        reenterCooldownMs: Math.max(0, Number(this.config.gabagoolReenterCooldownMs || 0)),
      };
    }
    if (roundTripState.roundTripCapReached && roundTripState.realizedPnl <= 0) {
      return {
        blocked: true,
        reason: 'gabagool_churn_guard',
        guardType: 'round_trip_cap',
        tokenId,
        marketSlug,
        outcome,
        roundTrips: roundTripState.roundTrips.length,
        realizedPnl: roundTripState.realizedPnl,
        maxRoundTripsPerTokenPerMarket: Math.max(1, Number(this.config.gabagoolMaxRoundTripsPerTokenPerMarket || 1)),
      };
    }

    const paceState = this.mixedModePaceState(now);
    this.logMixedModePace(paceState);
    if (paceState.blocked) {
      return {
        blocked: true,
        reason: 'gabagool_mixed_mode_pace',
        guardType: 'mixed_mode_pace',
        tokenId,
        marketSlug,
        outcome,
        btcOrdersLastHour: paceState.btcOrdersLastHour,
        standardOrdersLastHour: paceState.standardOrdersLastHour,
        projectedBtcShare: paceState.projectedBtcShare,
        mixedModeBtcOrderShareCap: paceState.mixedModeBtcOrderShareCap,
        standardExposureUsd: paceState.standardExposureUsd,
        standardExposureCapUsd: paceState.standardExposureCapUsd,
        standardQualifiedCandidatesThisScan: paceState.standardQualifiedCandidatesThisScan,
      };
    }

    if (
      Number.isFinite(Number(signal.price)) &&
      Number(signal.price) > Number(this.config.gabagoolMaxEntryPrice || 0.85) &&
      Number(signal.expectedEdge || 0) < Number(this.config.gabagoolAllowHighPriceEntryEdge || 0.20)
    ) {
      return {
        blocked: true,
        reason: 'gabagool_high_price_entry_guard',
        guardType: 'high_price_entry',
        price: Number(signal.price),
        maxEntryPrice: Number(this.config.gabagoolMaxEntryPrice || 0.85),
        expectedEdge: Number(signal.expectedEdge || 0),
        allowHighPriceEntryEdge: Number(this.config.gabagoolAllowHighPriceEntryEdge || 0.20),
      };
    }

    return { blocked: false, reason: null };
  }

  shouldLogGabagoolExitSizingState(key, ttlMs = 60_000) {
    const now = Date.now();
    for (const [existingKey, expiresAt] of this.gabagoolExitSizingLogged.entries()) {
      if (Number(expiresAt || 0) <= now) this.gabagoolExitSizingLogged.delete(existingKey);
    }
    if (this.gabagoolExitSizingLogged.has(key)) return false;
    this.gabagoolExitSizingLogged.set(key, now + ttlMs);
    return true;
  }

  recordGabagoolTinyExitState(
    type,
    details = {},
    { oracleTarget = null, oracleSignal = null, oracleEventKey = null, skipPresophieBlock = false } = {}
  ) {
    const tokenId = String(details.tokenId || '');
    const marketSlug = details.marketSlug || oracleTarget?.target?.slug || null;
    const outcome = details.outcome || (String(oracleTarget?.target?.BTC_UP_TOKEN_ID || '') === tokenId ? 'Up' : 'Down');
    const stateKey = [
      type,
      marketSlug || 'unknown',
      tokenId || 'unknown',
      cleanLogValue(details.positionQty),
      cleanLogValue(details.currentValueUsd),
      details.source || details.reason || 'unknown',
    ].join(':');
    if (!this.shouldLogGabagoolExitSizingState(stateKey)) return false;

    const payload = {
      tokenId,
      marketId: details.marketId || String(oracleTarget?.target?.rawMarketId || oracleTarget?.target?.slug || ''),
      marketSlug,
      outcome,
      side: 'sell',
      price: details.price,
      sizeUsd: details.roundedExitSizeUsd ?? details.currentValueUsd ?? 0,
      expectedEdge: details.expectedEdge,
      confidence: details.confidence,
      reason: details.reason,
      source: details.source,
      positionQty: details.positionQty,
      availableSellQty: details.availableSellQty,
      currentValueUsd: details.currentValueUsd,
      roundedExitSizeUsd: details.roundedExitSizeUsd,
    };
    this.recordGabagoolMetric(type, payload);

    if (type === 'gabagool_zero_size_blocked') {
      warn(
        `[GABAGOOL ZERO SIZE PREVENTED] source=${payload.source || 'unknown'} token=${shortId(payload.tokenId)} ` +
        `positionQty=${fmtCount(payload.positionQty, 6)} availableSellQty=${fmtCount(payload.availableSellQty, 6)} ` +
        `currentValueUsd=${fmtMoney(payload.currentValueUsd)} roundedExitSizeUsd=${fmtMoney(payload.roundedExitSizeUsd)} ` +
        `reason=${payload.reason || 'zero_size_candidate'}`
      );
    } else if (type === 'gabagool_dust_position_remaining') {
      warn(
        `[GABAGOOL DUST POSITION REMAINING] source=${payload.source || 'unknown'} token=${shortId(payload.tokenId)} ` +
        `positionQty=${fmtCount(payload.positionQty, 6)} availableSellQty=${fmtCount(payload.availableSellQty, 6)} ` +
        `currentValueUsd=${fmtMoney(payload.currentValueUsd)} roundedExitSizeUsd=${fmtMoney(payload.roundedExitSizeUsd)} ` +
        `reason=${payload.reason || 'dust_exit_below_min'} dust_position_remaining=true`
      );
    }

    if (!skipPresophieBlock) {
      this.logGabagoolPresophieBlock(payload.reason || type, this.gabagoolPresophiePayload({
        oracleTarget,
        oracleSignal,
        book: details.book || null,
        side: 'sell',
        price: payload.price,
        sizeUsd: payload.sizeUsd,
        expectedEdge: payload.expectedEdge,
        oracleEventKey,
      }));
    }
    return true;
  }

  gabagoolNoPlacementReasonFromRisk(reason, signal = null) {
    switch (String(reason || '')) {
      case 'max_total_exposure':
        return 'risk_total_exposure_cap';
      case 'max_market_exposure':
        return 'risk_market_exposure_cap';
      case 'max_position_per_asset':
        return 'risk_position_cap';
      case 'invalid_size':
      case 'sell_size_below_min':
        return 'order_size_below_min';
      case 'invalid_price':
        return 'no_valid_price';
      case 'invalid_signal':
        return signal?.tokenId ? 'final_gate_block' : 'no_valid_token';
      case 'confidence_below_min':
        return 'risk_confidence_below_min';
      case 'cash_cap':
      case 'max_total_open_order_usd':
      case 'max_open_orders':
      case 'no_available_position':
      case 'drawdown_limit':
      case 'edge_below_min':
      case 'invalid_side':
        return 'final_gate_block';
      default:
        return 'final_gate_block';
    }
  }

  gabagoolNoPlacementReasonFromExecution(decision = {}, signal = null) {
    switch (String(decision?.reason || '')) {
      case 'paper_trading_disabled':
        return 'paper_trading_disabled';
      case 'duplicate_order':
        return 'duplicate_order';
      case 'order_size_below_min':
        return 'order_size_below_min';
      case 'no_valid_price':
        return 'no_valid_price';
      case 'no_valid_token':
        return 'no_valid_token';
      case 'final_gate_block':
        return 'final_gate_block';
      case 'unknown_placement_block':
        return 'unknown_placement_block';
      default:
        if (!signal?.tokenId) return 'no_valid_token';
        if (!Number.isFinite(Number(signal?.price)) || Number(signal?.price) <= 0 || Number(signal?.price) >= 1) {
          return 'no_valid_price';
        }
        return 'unknown_placement_block';
    }
  }

  rememberGabagoolOracleSignal(oracleSignal, oracleTarget = null, now = Date.now()) {
    if (!oracleSignal) return;
    const timestampMs = Date.parse(String(oracleSignal.timestamp || ''));
    this.gabagoolOracleSignalHistory.push({
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : now,
      direction: String(oracleSignal.direction || '').toUpperCase(),
      tokenId: String(oracleSignal.token_id || ''),
      marketSlug: String(oracleTarget?.target?.slug || ''),
    });
    const retentionMs = 2 * 60 * 60_000;
    while (
      this.gabagoolOracleSignalHistory.length > 0 &&
      (now - Number(this.gabagoolOracleSignalHistory[0].timestampMs || 0)) > retentionMs
    ) {
      this.gabagoolOracleSignalHistory.shift();
    }
  }

  gabagoolConfirmCheck({ oracleSignal, oracleTarget, now = Date.now() } = {}) {
    const target = oracleTarget?.target || {};
    const marketSlug = String(target.slug || '');
    const targetMarket = {
      title: String(target.question || ''),
      slug: marketSlug,
      eventSlug: marketSlug,
    };
    const timestampMs = Date.parse(String(oracleSignal?.timestamp || ''));
    const expiryMs = Date.parse(String(oracleSignal?.expires_at || ''));
    const signalAgeMs = Number.isFinite(timestampMs) ? Math.max(0, now - timestampMs) : null;
    const freshnessPass = Number.isFinite(timestampMs);
    const expiryPass = Number.isFinite(expiryMs) && expiryMs > now;
    const marketTypePass = isBtcMarket(targetMarket) && isBtcFiveMinuteMarket(targetMarket);
    const secondsIntoWindow = Number.isFinite(Number(target.ts))
      ? Math.max(0, Math.floor(now / 1000) - Number(target.ts))
      : null;
    const currentWindowPass = !Number.isFinite(secondsIntoWindow) || secondsIntoWindow < 300;
    const marketPass = marketTypePass && currentWindowPass;

    const tokenId = String(oracleSignal?.token_id || '');
    const direction = String(oracleSignal?.direction || '').toUpperCase();
    const upToken = String(target.BTC_UP_TOKEN_ID || '');
    const downToken = String(target.BTC_DOWN_TOKEN_ID || '');
    const tokenPass = Boolean(tokenId) && (tokenId === upToken || tokenId === downToken);
    const directionPass = direction === 'UP' || direction === 'DOWN';
    const outcome = tokenId === upToken ? 'Up' : tokenId === downToken ? 'Down' : null;
    const expectedOutcome = direction === 'UP' ? 'Up' : direction === 'DOWN' ? 'Down' : null;
    const outcomePass = tokenPass && directionPass && outcome === expectedOutcome;

    const suggestedAction = String(oracleSignal?.suggested_action || '').toUpperCase();
    const rawAction = String(oracleSignal?.action || '').toUpperCase();
    const expectedSuggestedAction = direction === 'UP'
      ? 'BUY_BTC_UP_TOKEN'
      : direction === 'DOWN'
        ? 'BUY_BTC_DOWN_TOKEN'
        : null;
    let actionPass = true;
    if (suggestedAction) {
      actionPass = !expectedSuggestedAction || suggestedAction === expectedSuggestedAction;
    } else if (rawAction && rawAction !== 'TELEGRAM_ALERT_ONLY') {
      actionPass = rawAction.includes('BUY');
    }

    const embeddedBook = oracleSignal?.book_after_persistence || oracleSignal?.book_at_trigger || {};
    const embeddedPrice = firstFinite(
      embeddedBook.best_ask,
      embeddedBook.midpoint,
      embeddedBook.best_bid
    );
    const pricePass = (
      embeddedBook.valid !== false &&
      Number.isFinite(embeddedPrice) &&
      embeddedPrice > 0 &&
      embeddedPrice < 1 &&
      embeddedPrice >= Number(this.config.gabagoolMinPrice || 0) &&
      embeddedPrice <= Number(this.config.gabagoolMaxPrice || 1)
    );

    const derivedExpectedEdge = deriveOracleExpectedEdge(oracleSignal);
    const edgePass = Number.isFinite(derivedExpectedEdge) &&
      derivedExpectedEdge >= Number(this.config.gabagoolMinExpectedEdge || 0.0001);

    const initialBtcPrice = Number(oracleSignal?.initial_btc_price);
    const triggerBtcPrice = Number(oracleSignal?.trigger_btc_price);
    const currentBtcPrice = Number(oracleSignal?.current_btc_price);
    const currentVsInitialMovePct = Number.isFinite(initialBtcPrice) && initialBtcPrice > 0 && Number.isFinite(currentBtcPrice)
      ? Math.abs((currentBtcPrice - initialBtcPrice) / initialBtcPrice)
      : NaN;
    const currentVsTriggerMovePct = Number.isFinite(triggerBtcPrice) && triggerBtcPrice > 0 && Number.isFinite(currentBtcPrice)
      ? Math.abs((currentBtcPrice - triggerBtcPrice) / triggerBtcPrice)
      : NaN;
    const observedBtcMovePct = maxFinite(
      absNum(oracleSignal?.btc_trigger_move_pct),
      absNum(oracleSignal?.btc_persisted_move_pct),
      currentVsInitialMovePct,
      currentVsTriggerMovePct
    );
    const btcMovePass = Number.isFinite(observedBtcMovePct) &&
      observedBtcMovePct >= Math.max(0, Number(this.config.btcOracleThreshold || 0));

    const hasPersistenceField = Number.isFinite(Number(oracleSignal?.btc_persisted_move_pct));
    const observedPersistenceMovePct = hasPersistenceField
      ? Math.abs(Number(oracleSignal.btc_persisted_move_pct))
      : NaN;
    const persistenceWindowMs = Math.max(250, Number(this.config.btcOraclePersistenceMs || 4_000));
    const historyPersistencePass = Number.isFinite(timestampMs) && this.gabagoolOracleSignalHistory.some((entry) => (
      entry.marketSlug === marketSlug &&
      entry.direction === direction &&
      entry.tokenId === tokenId &&
      entry.timestampMs < timestampMs &&
      (timestampMs - entry.timestampMs) <= (persistenceWindowMs * 2)
    ));
    const agePersistencePass = Number.isFinite(signalAgeMs) && signalAgeMs >= persistenceWindowMs;
    const persistencePass = hasPersistenceField
      ? observedPersistenceMovePct >= Math.max(0, Number(this.config.btcOraclePersistenceMinPct || 0))
      : (historyPersistencePass || agePersistencePass);

    const hasConfirmedField = Object.prototype.hasOwnProperty.call(oracleSignal || {}, 'confirmed');
    const explicitConfirmedPass = !hasConfirmedField || oracleSignal.confirmed === true;
    const confirmedSource = hasConfirmedField
      ? 'explicit_field'
      : (hasPersistenceField || historyPersistencePass || agePersistencePass)
        ? 'derived_from_persistence'
        : 'derived_from_btc_move';

    let blockReason = null;
    if (!freshnessPass || !expiryPass) blockReason = 'oracle_signal_expired';
    else if (!marketTypePass) blockReason = 'non_btc_market';
    else if (!currentWindowPass) blockReason = 'stale_market';
    else if (!tokenPass) blockReason = 'invalid_token_id';
    else if (!directionPass || !outcomePass) blockReason = 'invalid_outcome';
    else if (!actionPass) blockReason = 'invalid_action';
    else if (!pricePass) blockReason = 'invalid_price';
    else if (!edgePass) blockReason = 'expected_edge_zero';
    else if (!explicitConfirmedPass) blockReason = 'explicit_confirmed_false';
    else if (!btcMovePass) blockReason = 'btc_move_below_threshold';
    else if (!persistencePass) blockReason = 'persistence_not_satisfied';

    const confirmed = blockReason == null;
    return {
      confirmed,
      blockReason,
      confirmedSource,
      hasConfirmedField,
      explicitConfirmedPass,
      freshnessPass,
      expiryPass,
      marketPass,
      tokenPass,
      outcomePass,
      actionPass,
      pricePass,
      edgePass,
      btcMovePass,
      persistencePass,
      signalAgeMs,
      secondsIntoWindow,
      expectedEdge: cleanLogValue(derivedExpectedEdge),
      observedBtcMovePct: cleanLogValue(observedBtcMovePct),
      observedPersistenceMovePct: Number.isFinite(observedPersistenceMovePct)
        ? cleanLogValue(observedPersistenceMovePct)
        : null,
      historyPersistencePass,
      agePersistencePass,
      suggestedAction: suggestedAction || null,
      action: rawAction || null,
      legacyConfirmFields: {
        polyLagConfirmed: booleanOrNull(oracleSignal?.poly_lag_confirmed),
        lagScorePass: booleanOrNull(oracleSignal?.lag_score_pass),
        obiConfirmed: booleanOrNull(oracleSignal?.obi_confirmed),
      },
    };
  }

  gabagoolOutcomeForSignal(oracleSignal, oracleTarget = null) {
    const target = oracleTarget?.target || oracleTarget || {};
    const tokenId = String(oracleSignal?.token_id || '');
    const upToken = String(target.BTC_UP_TOKEN_ID || '');
    const downToken = String(target.BTC_DOWN_TOKEN_ID || '');
    if (tokenId && tokenId === upToken) return 'Up';
    if (tokenId && tokenId === downToken) return 'Down';
    const direction = String(oracleSignal?.direction || '').toUpperCase();
    if (direction === 'UP') return 'Up';
    if (direction === 'DOWN') return 'Down';
    return null;
  }

  gabagoolOracleEventKey(oracleSignal, oracleTarget = null) {
    const target = oracleTarget?.target || oracleTarget || {};
    return JSON.stringify({
      marketSlug: String(target.slug || ''),
      eventId: String(oracleSignal?.event_id || oracleSignal?.id || ''),
      timestamp: String(oracleSignal?.timestamp || ''),
      expiresAt: String(oracleSignal?.expires_at || ''),
      tokenId: String(oracleSignal?.token_id || ''),
      direction: String(oracleSignal?.direction || '').toUpperCase(),
      polyLagConfirmed: oracleSignal?.poly_lag_confirmed === true,
      lagScorePass: oracleSignal?.lag_score_pass === true,
      obiConfirmed: oracleSignal?.obi_confirmed === true,
      bestAsk: cleanLogValue(oracleSignal?.book_after_persistence?.best_ask ?? oracleSignal?.book_after_persistence?.midpoint),
      lagScore: cleanLogValue(oracleSignal?.lag_score),
    });
  }

  hasSeenGabagoolOracleEvent(oracleEventKey, now = Date.now()) {
    const retentionMs = 2 * 60 * 60_000;
    for (const [key, seenAt] of this.gabagoolOracleEventSeen.entries()) {
      if (now - seenAt > retentionMs) this.gabagoolOracleEventSeen.delete(key);
    }
    return this.gabagoolOracleEventSeen.has(oracleEventKey);
  }

  markGabagoolOracleEventSeen(oracleEventKey, now = Date.now()) {
    this.gabagoolOracleEventSeen.set(oracleEventKey, now);
  }

  gabagoolPresophiePayload({
    oracleTarget = null,
    oracleSignal = null,
    book = null,
    side = 'buy',
    price = null,
    sizeUsd = null,
    expectedEdge = null,
    oracleEventKey = null,
    confirmCheck = null,
  } = {}) {
    return {
      strategy: 'GabagoolBtcOracleStrategy',
      marketSlug: oracleTarget?.target?.slug || null,
      marketQuestion: oracleTarget?.target?.question || null,
      tokenId: oracleSignal?.token_id || null,
      outcome: this.gabagoolOutcomeForSignal(oracleSignal, oracleTarget),
      side,
      price: Number.isFinite(Number(price))
        ? Number(price)
        : Number.isFinite(Number(book?.bestAsk))
          ? Number(book.bestAsk)
          : Number.isFinite(Number(oracleSignal?.book_after_persistence?.best_ask))
          ? Number(oracleSignal.book_after_persistence.best_ask)
          : Number.isFinite(Number(oracleSignal?.book_after_persistence?.midpoint))
            ? Number(oracleSignal.book_after_persistence.midpoint)
            : null,
      sizeUsd: Number.isFinite(Number(sizeUsd)) ? Number(sizeUsd) : this.config.gabagoolMaxPaperOrderUsd,
      expectedEdge: expectedEdge != null && Number.isFinite(Number(expectedEdge))
        ? Number(expectedEdge)
        : deriveOracleExpectedEdge(oracleSignal),
      confidence: Number.isFinite(Number(oracleSignal?.confidence)) ? Number(oracleSignal.confidence) : null,
      sophieDecision: 'NOT_RUN',
      riskDecision: 'NOT_RUN',
      oracleEventKey,
      confirmCheck,
    };
  }

  logGabagoolPresophieBlock(blockReason, payload = {}) {
    const logPayload = {
      strategy: 'GabagoolBtcOracleStrategy',
      side: 'buy',
      ...payload,
      blockReason,
      sophieDecision: 'NOT_RUN',
      riskDecision: 'NOT_RUN',
    };
    this.lastGabagoolBlockedReason = blockReason;
    if (this.lastGabagoolOracleSignal) this.lastGabagoolOracleSignal.blockedReason = blockReason;
    this.recordGabagoolMetric('gabagool_presophie_block', {
      tokenId: logPayload.tokenId,
      marketSlug: logPayload.marketSlug,
      outcome: logPayload.outcome,
      side: logPayload.side,
      price: logPayload.price,
      sizeUsd: logPayload.sizeUsd,
      expectedEdge: logPayload.expectedEdge,
      confidence: logPayload.confidence,
      reason: blockReason,
    });
    const dedupeKey = logPayload.oracleEventKey
      ? `${blockReason}:${logPayload.oracleEventKey}`
      : [
        logPayload.marketSlug || 'unknown',
        logPayload.tokenId || 'unknown',
        logPayload.outcome || 'unknown',
        String(logPayload.side || '').toLowerCase() || 'unknown',
        blockReason,
      ].join(':');
    const now = Date.now();
    const dedupeMs = Math.max(1_000, Number(this.config.gabagoolTelegramBlockDedupeMs || 60_000));
    for (const [key, expiresAt] of this.gabagoolPresophieBlockLogged.entries()) {
      if (expiresAt <= now) this.gabagoolPresophieBlockLogged.delete(key);
    }
    if (!this.gabagoolPresophieBlockLogged.has(dedupeKey)) {
      const confirmDiagnostic = blockReason === 'oracle_signal_not_confirmed' && logPayload.confirmCheck
        ? ` confirmSource=${logPayload.confirmCheck.confirmedSource || 'unknown'} ` +
          `lastNotConfirmedReason=${logPayload.confirmCheck.blockReason || 'unknown'} ` +
          `lastConfirmCheck=${formatGabagoolConfirmCheck(logPayload.confirmCheck)}`
        : '';
      warn(
        `[GABAGOOL PRESOPHIE BLOCK] block=${blockReason} marketSlug=${logPayload.marketSlug || 'unknown'} ` +
        `token=${shortId(logPayload.tokenId)} outcome=${logPayload.outcome || 'unknown'} ` +
        `action=${String(logPayload.side || '').toUpperCase() || 'UNKNOWN'} price=${fmtPrice(logPayload.price)} ` +
        `expectedEdge=${cleanLogValue(logPayload.expectedEdge)} confidence=${cleanLogValue(logPayload.confidence)}` +
        confirmDiagnostic
      );
      this.gabagoolPresophieBlockLogged.set(dedupeKey, now + dedupeMs);
    }
    if (this.config.gabagoolTelegramNotifyPresophieBlocks) {
      this.emitGabagoolUpdate('presophie_block_summary', logPayload);
    } else {
      this.recordGabagoolMetric('gabagool_telegram_suppressed', {
        tokenId: logPayload.tokenId,
        side: logPayload.side,
        reason: 'presophie_blocks_disabled',
      });
    }
  }

  async runGabagoolBtcOracleImitation() {
    if (!this.config.enableGabagoolBtcImitation) return;

    const model = await this.ensureGabagoolBehaviorModel();
    if (!model) return;

    const oracleSignal = loadOracleSignalFile(this.config.gabagoolSignalPath);
    const oracleTarget = loadOracleTargetFile(this.config.gabagoolTargetPath);
    const now = Date.now();
    this.resetGabagoolCurrentCycle(now);
    this.lastGabagoolOracleTarget = oracleTarget?.target
      ? JSON.parse(JSON.stringify(oracleTarget.target))
      : null;
    this.lastGabagoolOracleSignal = oracleSignal
      ? {
        timestamp: oracleSignal.timestamp || null,
        direction: String(oracleSignal.direction || '').toUpperCase() || null,
        outcome: this.gabagoolOutcomeForSignal(oracleSignal, oracleTarget),
        marketSlug: oracleTarget?.target?.slug || null,
        blockedReason: this.lastGabagoolBlockedReason,
        tokenId: oracleSignal.token_id || null,
        currentBtcPrice: Number.isFinite(Number(oracleSignal.current_btc_price)) ? Number(oracleSignal.current_btc_price) : null,
        btcPersistedMovePct: Number.isFinite(Number(oracleSignal.btc_persisted_move_pct)) ? Number(oracleSignal.btc_persisted_move_pct) : null,
        lagScore: Number.isFinite(Number(oracleSignal.lag_score)) ? Number(oracleSignal.lag_score) : null,
        hasConfirmedField: Object.prototype.hasOwnProperty.call(oracleSignal, 'confirmed'),
        confirmedSource: null,
        lastNotConfirmedReason: null,
        confirmCheck: null,
      }
      : null;
    this.lastGabagoolConfirmCheck = null;

    if (!oracleTarget?.target) {
      this.logGabagoolPresophieBlock('missing_oracle_target');
      return;
    }

    let eligibleOracleSignal = null;
    let eligibleOracleEventKey = null;
    if (!oracleSignal) {
      if (this.config.gabagoolRequireOracleSignal) {
        this.logGabagoolPresophieBlock('missing_oracle_signal', this.gabagoolPresophiePayload({ oracleTarget }));
      }
    } else {
      const oracleEventKey = this.gabagoolOracleEventKey(oracleSignal, oracleTarget);
      const presophiePayload = this.gabagoolPresophiePayload({
        oracleTarget,
        oracleSignal,
        oracleEventKey,
      });
      this.recordGabagoolMetric('gabagool_oracle_signal_read', {
        tokenId: oracleSignal.token_id,
        marketSlug: oracleTarget?.target?.slug || null,
        outcome: this.gabagoolOutcomeForSignal(oracleSignal, oracleTarget),
        side: 'buy',
        reason: null,
        expectedEdge: oracleSignal.lag_score,
        confidence: oracleSignal.confidence,
      });
      if (this.hasSeenGabagoolOracleEvent(oracleEventKey, now)) {
        this.lastGabagoolBlockedReason = 'duplicate_oracle_signal';
        if (this.lastGabagoolOracleSignal) this.lastGabagoolOracleSignal.blockedReason = 'duplicate_oracle_signal';
        this.recordGabagoolMetric('gabagool_duplicate_oracle_signal', {
          tokenId: oracleSignal.token_id,
          marketSlug: oracleTarget?.target?.slug || null,
          outcome: this.gabagoolOutcomeForSignal(oracleSignal, oracleTarget),
          side: 'buy',
          reason: 'duplicate_oracle_signal',
          expectedEdge: oracleSignal.lag_score,
          confidence: oracleSignal.confidence,
        });
        this.recordGabagoolMetric('gabagool_telegram_suppressed', {
          tokenId: oracleSignal.token_id,
          side: 'buy',
          reason: 'duplicate_oracle_signal',
        });
      } else {
        this.markGabagoolOracleEventSeen(oracleEventKey, now);
        this.rememberGabagoolOracleSignal(oracleSignal, oracleTarget, now);
        const freshUntilMs = Date.parse(String(oracleSignal.expires_at || ''));
        if (!Number.isFinite(freshUntilMs) || freshUntilMs <= now) {
          this.recordGabagoolMetric('gabagool_oracle_signal_expired', {
            tokenId: oracleSignal.token_id,
            side: 'buy',
          });
          this.logGabagoolPresophieBlock('oracle_signal_expired', presophiePayload);
        } else {
          this.recordGabagoolMetric('gabagool_oracle_signal_fresh', {
            tokenId: oracleSignal.token_id,
            marketSlug: oracleTarget?.target?.slug || null,
            outcome: this.gabagoolOutcomeForSignal(oracleSignal, oracleTarget),
            side: 'buy',
            expectedEdge: oracleSignal.lag_score,
            confidence: oracleSignal.confidence,
          });
          const confirmCheck = this.gabagoolConfirmCheck({
            oracleSignal,
            oracleTarget,
            now,
          });
          this.lastGabagoolConfirmCheck = confirmCheck;
          if (this.lastGabagoolOracleSignal) {
            this.lastGabagoolOracleSignal.hasConfirmedField = confirmCheck.hasConfirmedField;
            this.lastGabagoolOracleSignal.confirmedSource = confirmCheck.confirmedSource;
            this.lastGabagoolOracleSignal.lastNotConfirmedReason = confirmCheck.confirmed ? null : confirmCheck.blockReason;
            this.lastGabagoolOracleSignal.confirmCheck = confirmCheck;
          }
          if (!confirmCheck.confirmed) {
            this.recordGabagoolMetric('gabagool_oracle_signal_not_confirmed', {
              tokenId: oracleSignal.token_id,
              marketSlug: oracleTarget?.target?.slug || null,
              outcome: this.gabagoolOutcomeForSignal(oracleSignal, oracleTarget),
              side: 'buy',
              reason: confirmCheck.blockReason || 'oracle_signal_not_confirmed',
              expectedEdge: confirmCheck.expectedEdge,
              confidence: oracleSignal.confidence,
            });
            this.logGabagoolPresophieBlock('oracle_signal_not_confirmed', {
              ...presophiePayload,
              expectedEdge: confirmCheck.expectedEdge,
              confirmCheck,
            });
          } else {
            this.recordGabagoolMetric('gabagool_oracle_signal_confirmed', {
              tokenId: oracleSignal.token_id,
              marketSlug: oracleTarget?.target?.slug || null,
              outcome: this.gabagoolOutcomeForSignal(oracleSignal, oracleTarget),
              side: 'buy',
              expectedEdge: confirmCheck.expectedEdge,
              confidence: oracleSignal.confidence,
            });
            this.lastGabagoolBlockedReason = null;
            if (this.lastGabagoolOracleSignal) this.lastGabagoolOracleSignal.blockedReason = null;
            if (this.lastGabagoolOracleSignal) this.lastGabagoolOracleSignal.confirmedSource = confirmCheck.confirmedSource;
            eligibleOracleSignal = oracleSignal;
            eligibleOracleSignal.gabagoolConfirmCheck = confirmCheck;
            eligibleOracleEventKey = oracleEventKey;
          }
        }
      }
    }

    const targetTokenIds = [
      oracleTarget.target.BTC_UP_TOKEN_ID,
      oracleTarget.target.BTC_DOWN_TOKEN_ID,
    ].filter(Boolean);
    const books = new Map();

    for (const tokenId of targetTokenIds) {
      const book = await this.getGabagoolBook(tokenId, books);
      if (!book) continue;
      this.portfolio.setMarkPrice(tokenId, book.midpoint);
      this.volGuard.update(tokenId, book.midpoint);
      this.consensus.recordMid(tokenId, book.midpoint);
    }
    this.lastGabagoolBooks = {
      up: books.get(String(oracleTarget.target.BTC_UP_TOKEN_ID || '')) || null,
      down: books.get(String(oracleTarget.target.BTC_DOWN_TOKEN_ID || '')) || null,
    };
    const lossGuardExitScan = await this.buildGabagoolLossGuardExitScan({ model, books, now });
    const exposureCapExitScan = await this.buildGabagoolExposureCapExitScan({ model, books, now });

    const entryTokenId = String(eligibleOracleSignal?.token_id || '');
    const entryBook = books.get(entryTokenId);
    const entryAsset = this.buildGabagoolSyntheticAsset(oracleTarget, entryTokenId);
    const idleSignalFallback = eligibleOracleSignal
      ? {
        tokenId: eligibleOracleSignal.token_id || null,
        metadata: {
          marketSlug: oracleTarget?.target?.slug || null,
        },
      }
      : null;
    const exitSignals = [];
    const attemptGabagoolExits = () => {
      const useLossGuardExitMode = lossGuardExitScan.active;
      const useExposureCapExitMode = !useLossGuardExitMode && exposureCapExitScan.active;
      const activeExitScan = useLossGuardExitMode
        ? lossGuardExitScan
        : useExposureCapExitMode
          ? exposureCapExitScan
          : null;
      const candidates = activeExitScan ? activeExitScan.candidates : exitSignals;
      let attempts = 0;
      let placed = 0;
      let lastBlockedReason = null;
      for (const candidate of candidates) {
        attempts += 1;
        if (useLossGuardExitMode) {
          this.recordGabagoolMetric('gabagool_loss_guard_exit_attempted', {
            tokenId: candidate.signal.tokenId,
            marketId: candidate.signal.marketId,
            marketSlug: candidate.signal.metadata?.marketSlug,
            outcome: candidate.signal.metadata?.outcome,
            side: candidate.signal.side,
            price: candidate.signal.price,
            sizeUsd: candidate.signal.sizeUsd,
            expectedEdge: candidate.signal.expectedEdge,
            confidence: candidate.signal.confidence,
            reason: 'loss_guard_reduce_only',
            exitMode: lossGuardExitScan.exitMode,
          });
        }
        if (useExposureCapExitMode) {
          this.recordGabagoolMetric('gabagool_reduce_only_exit_attempted', {
            tokenId: candidate.signal.tokenId,
            marketId: candidate.signal.marketId,
            marketSlug: candidate.signal.metadata?.marketSlug,
            outcome: candidate.signal.metadata?.outcome,
            side: candidate.signal.side,
            price: candidate.signal.price,
            sizeUsd: candidate.signal.sizeUsd,
            expectedEdge: candidate.signal.expectedEdge,
            confidence: candidate.signal.confidence,
            reason: candidate.candidateReason || candidate.signal.metadata?.gabagool?.exitTrigger || 'exposure_cap_reduce_only',
            exitMode: exposureCapExitScan.exitMode,
          });
        }
        this.execution.lastPlacementDecision = null;
        this.trySignal(candidate.signal, candidate.asset, candidate.book);
        const placedThisAttempt = this.execution.lastPlacementDecision?.placed === true;
        if (placedThisAttempt) {
          placed += 1;
          continue;
        }
        lastBlockedReason = this.lastGabagoolPlacementBlockReason ||
          this.lastGabagoolRiskBlockReason ||
          this.lastGabagoolSophieBlockReason ||
          this.lastGabagoolBlockedReason ||
          'all_exits_blocked';
        if (useLossGuardExitMode) {
          this.recordGabagoolMetric('gabagool_loss_guard_exit_blocked', {
            tokenId: candidate.signal.tokenId,
            marketId: candidate.signal.marketId,
            marketSlug: candidate.signal.metadata?.marketSlug,
            outcome: candidate.signal.metadata?.outcome,
            side: candidate.signal.side,
            price: candidate.signal.price,
            sizeUsd: candidate.signal.sizeUsd,
            expectedEdge: candidate.signal.expectedEdge,
            confidence: candidate.signal.confidence,
            reason: lastBlockedReason,
            exitMode: lossGuardExitScan.exitMode,
          });
        }
        if (useExposureCapExitMode) {
          this.recordGabagoolMetric('gabagool_reduce_only_exit_blocked', {
            tokenId: candidate.signal.tokenId,
            marketId: candidate.signal.marketId,
            marketSlug: candidate.signal.metadata?.marketSlug,
            outcome: candidate.signal.metadata?.outcome,
            side: candidate.signal.side,
            price: candidate.signal.price,
            sizeUsd: candidate.signal.sizeUsd,
            expectedEdge: candidate.signal.expectedEdge,
            confidence: candidate.signal.confidence,
            reason: lastBlockedReason,
            exitMode: exposureCapExitScan.exitMode,
          });
        }
      }
      const noExitReason = activeExitScan
        ? (
          candidates.length === 0
            ? (activeExitScan.noExitReason || 'no_position_inventory')
            : placed > 0
              ? null
              : 'all_exits_blocked'
        )
        : null;
      const dominantBlockedReason = activeExitScan?.dominantBlockedReason || null;
      const blockedReasonSummary = activeExitScan?.blockedReasonSummary || 'none';
      if (useLossGuardExitMode) {
        this.updateGabagoolCurrentCycle({
          decision: placed > 0 ? 'LOSS_GUARD_EXIT_ORDER_PLACED' : 'IDLE:gabagool_loss_guard',
          idleReason: placed > 0 ? null : 'gabagool_loss_guard',
          positionsScanned: lossGuardExitScan.positionsScanned,
          positionsClosable: lossGuardExitScan.positionsClosable,
          exitsAttempted: attempts,
          exitsPlaced: placed,
          exitBlockedReason: lastBlockedReason,
          dominantExitBlockedReason: dominantBlockedReason,
          blockedReasonSummary,
          noExitReason,
          exitMode: lossGuardExitScan.exitMode,
        });
      }
      if (useExposureCapExitMode) {
        this.updateGabagoolCurrentCycle({
          decision: placed > 0 ? 'EXPOSURE_CAP_EXIT_ORDER_PLACED' : 'IDLE:exposure_cap_waiting_for_exit',
          idleReason: placed > 0 ? null : 'exposure_cap_waiting_for_exit',
          positionsScanned: exposureCapExitScan.positionsScanned,
          positionsClosable: exposureCapExitScan.positionsClosable,
          exitsAttempted: attempts,
          exitsPlaced: placed,
          exitBlockedReason: lastBlockedReason,
          dominantExitBlockedReason: dominantBlockedReason,
          blockedReasonSummary,
          noExitReason,
          exitMode: exposureCapExitScan.exitMode,
          exposureCapWaitingForExit: true,
          exitUnfreezeReason: exposureCapExitScan.unfreezeReasonLast,
          largestExposurePositions: exposureCapExitScan.largestExposurePositions,
          stallGateBypassedBecauseOnlyExpiredDeadExposure: exposureCapExitScan.stallGateBypassedBecauseOnlyExpiredDeadExposure === true,
        });
      }
      return {
        attempts,
        placed,
        lastBlockedReason,
        dominantBlockedReason,
        blockedReasonSummary,
        noExitReason,
        activeLossGuardExitMode: useLossGuardExitMode,
        activeExposureCapExitMode: useExposureCapExitMode,
        positionsScanned: activeExitScan?.positionsScanned || 0,
        positionsClosable: activeExitScan?.positionsClosable || 0,
        exitMode: activeExitScan?.exitMode || null,
        exitUnfreezeReason: useExposureCapExitMode ? exposureCapExitScan.unfreezeReasonLast : null,
        largestExposurePositions: useExposureCapExitMode ? exposureCapExitScan.largestExposurePositions : [],
        totalExposureUsd: useExposureCapExitMode ? exposureCapExitScan.totalExposureUsd : null,
        capBlockingExposureUsd: useExposureCapExitMode ? exposureCapExitScan.capBlockingExposureUsd : null,
        portfolioExposureUsd: useExposureCapExitMode ? exposureCapExitScan.portfolioExposureUsd : null,
        rawPortfolioExposureUsd: useExposureCapExitMode ? exposureCapExitScan.rawPortfolioExposureUsd : null,
        capBlockingExposureUsdAfterExclusions: useExposureCapExitMode ? exposureCapExitScan.capBlockingExposureUsdAfterExclusions : null,
        activeTradableExposureUsd: useExposureCapExitMode ? exposureCapExitScan.activeTradableExposureUsd : null,
        excludedDeadExposureUsd: useExposureCapExitMode ? exposureCapExitScan.excludedDeadExposureUsd : null,
        excludedDeadExposureReasonSummary: useExposureCapExitMode ? exposureCapExitScan.excludedDeadExposureReasonSummary : 'none',
        capTriggerReason: useExposureCapExitMode ? exposureCapExitScan.capTriggerReason : null,
        maxTotalExposureUsd: useExposureCapExitMode ? exposureCapExitScan.maxTotalExposureUsd : null,
        excessExposureUsd: useExposureCapExitMode ? exposureCapExitScan.excessExposureUsd : null,
        stallGateBypassedBecauseOnlyExpiredDeadExposure: useExposureCapExitMode ? exposureCapExitScan.stallGateBypassedBecauseOnlyExpiredDeadExposure === true : false,
      };
    };
    const maybeLogLossGuardIdle = (exitAttemptSummary, rawSignal = null) => {
      if (!exitAttemptSummary?.activeLossGuardExitMode || exitAttemptSummary.placed > 0) return;
      const tokenForLog = rawSignal?.tokenId || lossGuardExitScan.candidates[0]?.signal?.tokenId || null;
      const marketSlugForLog = rawSignal?.metadata?.marketSlug ||
        lossGuardExitScan.candidates[0]?.signal?.metadata?.marketSlug ||
        'unknown';
      warn(
        `[GABAGOOL IDLE] reason=gabagool_loss_guard token=${shortId(tokenForLog)} ` +
        `marketSlug=${marketSlugForLog} exitMode=${lossGuardExitScan.exitMode} ` +
        `positionsScanned=${exitAttemptSummary.positionsScanned} positionsClosable=${exitAttemptSummary.positionsClosable} ` +
        `exitsAttempted=${exitAttemptSummary.attempts} noExitReason=${exitAttemptSummary.noExitReason || 'none'} ` +
        `exitBlockedReason=${exitAttemptSummary.lastBlockedReason || 'none'} ` +
        `dominantBlockedReason=${exitAttemptSummary.dominantBlockedReason || 'none'} ` +
        `blockedReasonSummary=${exitAttemptSummary.blockedReasonSummary || 'none'} ` +
        `closedLossUsd=${cleanLogValue(lossGuardExitScan.lossGuard.closedLossUsd)} ` +
        `maxClosedLossUsd=${cleanLogValue(lossGuardExitScan.lossGuard.maxClosedLossUsd)}`
      );
    };
    const maybeLogExposureCapIdle = (exitAttemptSummary, rawSignal = null) => {
      if (!exitAttemptSummary?.activeExposureCapExitMode || exitAttemptSummary.placed > 0) return;
      const anchorPosition = exitAttemptSummary.largestExposurePositions?.[0] || exposureCapExitScan.largestExposurePositions[0] || null;
      const tokenForLog = rawSignal?.tokenId || anchorPosition?.tokenId || null;
      const marketSlugForLog = rawSignal?.metadata?.marketSlug || anchorPosition?.marketSlug || 'unknown';
      warn(
        `[GABAGOOL EXPOSURE STALL] reason=exposure_cap_waiting_for_exit token=${shortId(tokenForLog)} ` +
        `marketSlug=${marketSlugForLog} totalExposureUsd=${fmtMoney(exitAttemptSummary.totalExposureUsd)} ` +
        `rawPortfolioExposureUsd=${fmtMoney(exitAttemptSummary.rawPortfolioExposureUsd)} ` +
        `portfolioExposureUsd=${fmtMoney(exitAttemptSummary.portfolioExposureUsd)} ` +
        `capBlockingExposureUsd=${fmtMoney(exitAttemptSummary.capBlockingExposureUsd)} ` +
        `capBlockingExposureUsdAfterExclusions=${fmtMoney(exitAttemptSummary.capBlockingExposureUsdAfterExclusions)} ` +
        `activeTradableExposureUsd=${fmtMoney(exitAttemptSummary.activeTradableExposureUsd)} ` +
        `excludedDeadExposureUsd=${fmtMoney(exitAttemptSummary.excludedDeadExposureUsd)} ` +
        `maxTotalExposureUsd=${fmtMoney(exitAttemptSummary.maxTotalExposureUsd)} excessExposureUsd=${fmtMoney(exitAttemptSummary.excessExposureUsd)} ` +
        `positionsScanned=${exitAttemptSummary.positionsScanned} positionsClosable=${exitAttemptSummary.positionsClosable} ` +
        `exitsAttempted=${exitAttemptSummary.attempts} exitsPlaced=${exitAttemptSummary.placed} ` +
        `noExitReason=${exitAttemptSummary.noExitReason || 'none'} ` +
        `capTriggerReason=${exitAttemptSummary.capTriggerReason || 'none'} ` +
        `exitBlockedReason=${exitAttemptSummary.lastBlockedReason || 'none'} ` +
        `dominantBlockedReason=${exitAttemptSummary.dominantBlockedReason || 'none'} ` +
        `blockedReasonSummary=${exitAttemptSummary.blockedReasonSummary || 'none'} ` +
        `excludedDeadExposureReasons=${exitAttemptSummary.excludedDeadExposureReasonSummary || 'none'} ` +
        `exitUnfreezeReason=${exitAttemptSummary.exitUnfreezeReason || 'none'} ` +
        `stallGateBypassedBecauseOnlyExpiredDeadExposure=${exitAttemptSummary.stallGateBypassedBecauseOnlyExpiredDeadExposure === true ? 'true' : 'false'}`
      );
    };
    const maybeLogActiveExitIdle = (exitAttemptSummary, rawSignal = null) => {
      maybeLogLossGuardIdle(exitAttemptSummary, rawSignal);
      maybeLogExposureCapIdle(exitAttemptSummary, rawSignal);
    };

    for (const tokenId of targetTokenIds) {
      const qty = this.portfolio.position(tokenId);
      if (qty <= 0) continue;
      const book = books.get(String(tokenId));
      const asset = this.buildGabagoolSyntheticAsset(oracleTarget, tokenId);
      if (!book || !asset) continue;
      const availableSellQty = this.portfolio.availablePositionQty(tokenId);
      const currentValueUsd = Number.isFinite(Number(book.bestBid)) ? availableSellQty * Number(book.bestBid) : 0;
      const roundedExitSizeUsd = Math.max(0, Math.round(currentValueUsd * 100) / 100);
      const minDustExitUsd = Math.max(0.01, Number(this.config.gabagoolMinDustExitUsd || 0.01));
      const commonSizingDetails = {
        tokenId: String(tokenId),
        marketId: String(oracleTarget?.target?.rawMarketId || oracleTarget?.target?.slug || ''),
        marketSlug: oracleTarget?.target?.slug || null,
        outcome: String(oracleTarget?.target?.BTC_UP_TOKEN_ID || '') === String(tokenId) ? 'Up' : 'Down',
        price: Number.isFinite(Number(book.bestBid)) ? Number(book.bestBid) : null,
        book,
        positionQty: qty,
        availableSellQty,
        currentValueUsd,
        roundedExitSizeUsd,
      };
      if (!(currentValueUsd > 0) || !(roundedExitSizeUsd > 0)) {
        this.recordGabagoolTinyExitState('gabagool_zero_size_blocked', {
          ...commonSizingDetails,
          reason: 'zero_size_candidate',
          source: !(currentValueUsd > 0) ? 'position_value_non_positive' : 'position_value_rounds_to_zero',
        }, {
          oracleTarget,
          oracleSignal,
          oracleEventKey: eligibleOracleEventKey,
        });
        continue;
      }
      if (roundedExitSizeUsd < minDustExitUsd) {
        this.recordGabagoolTinyExitState('gabagool_dust_position_remaining', {
          ...commonSizingDetails,
          reason: 'dust_exit_below_min',
          source: 'position_value_below_dust_floor',
        }, {
          oracleTarget,
          oracleSignal,
          oracleEventKey: eligibleOracleEventKey,
        });
        continue;
      }

      const exitPlanResult = buildExitPlan({
        model,
        tokenId,
        positionQty: qty,
        avgCost: this.portfolio.positionCostDetails(tokenId).avgEntryPrice,
        lastFillTs: this.lastStrategyFillTs(tokenId, 'GabagoolBtcOracleStrategy'),
        oracleSignal,
        oracleTarget,
        book,
        now: Date.now(),
        minEdge: this.config.minSignalEdge,
        minProfitBuffer: this.config.gabagoolMinProfitBuffer,
        allowDustExit: this.config.gabagoolAllowDustExits === true,
        minDustExitUsd: this.config.gabagoolMinDustExitUsd,
      });

      if (!exitPlanResult.plan) {
        if (exitPlanResult.blockReason === 'blocked_loss_exit') {
          this.lastGabagoolBlockedReason = 'blocked_loss_exit';
          this.lastGabagoolPlacementDecision = 'IDLE:blocked_loss_exit';
          const blockedLossExitPayload = {
            tokenId: String(tokenId),
            marketSlug: commonSizingDetails.marketSlug,
            outcome: commonSizingDetails.outcome,
          };
          const suppression = this.consumeBlockedLossExitSuppression(blockedLossExitPayload, Date.now());
          this.recordGabagoolMetric('gabagool_blocked_loss_exit', {
            ...commonSizingDetails,
            side: 'sell',
            sizeUsd: roundedExitSizeUsd,
            reason: 'blocked_loss_exit',
            avgEntryPrice: exitPlanResult.avgEntryPrice,
            price: exitPlanResult.sellPrice,
          });
          if (suppression.suppressed) {
            this.recordGabagoolMetric('gabagool_blocked_loss_exit_repeat', {
              ...commonSizingDetails,
              side: 'sell',
              sizeUsd: roundedExitSizeUsd,
              reason: 'blocked_loss_exit',
              avgEntryPrice: exitPlanResult.avgEntryPrice,
              price: exitPlanResult.sellPrice,
              source: 'suppressed_repeat',
            });
          }
          this.recordGabagoolMetric('gabagool_placement_decision', {
            tokenId: String(tokenId),
            marketId: commonSizingDetails.marketId,
            marketSlug: commonSizingDetails.marketSlug,
            outcome: commonSizingDetails.outcome,
            side: 'sell',
            price: exitPlanResult.sellPrice,
            sizeUsd: roundedExitSizeUsd,
            reason: this.lastGabagoolPlacementDecision,
          });
          if (!suppression.suppressed) {
            warn(
              `[GABAGOOL CAPITAL PROTECTION] reason=blocked_loss_exit token=${shortId(tokenId)} ` +
              `marketSlug=${commonSizingDetails.marketSlug || 'unknown'} avgEntry=${fmtPrice(exitPlanResult.avgEntryPrice)} ` +
              `sellPrice=${fmtPrice(exitPlanResult.sellPrice)} minProfitPrice=${fmtPrice(exitPlanResult.minProfitPrice)}`
            );
            this.emitGabagoolUpdate('risk_blocked', {
              strategy: 'GabagoolBtcOracleStrategy',
              marketSlug: commonSizingDetails.marketSlug,
              marketQuestion: asset?.market?.question || null,
              tokenId: String(tokenId),
              outcome: commonSizingDetails.outcome,
              side: 'sell',
              price: exitPlanResult.sellPrice,
              sizeUsd: roundedExitSizeUsd,
              blockReason: 'blocked_loss_exit',
              avgEntryPrice: exitPlanResult.avgEntryPrice,
              sophieDecision: 'NOT_RUN',
              riskDecision: 'BLOCK:blocked_loss_exit',
              oracleEventKey: eligibleOracleEventKey,
            });
          }
        }
        if (exitPlanResult.blockReason === 'zero_size_candidate' || exitPlanResult.blockReason === 'dust_exit_below_min') {
          const commonBlockDetails = {
            ...commonSizingDetails,
            reason: exitPlanResult.blockReason,
            source: exitPlanResult.source || null,
            currentValueUsd: Number.isFinite(Number(exitPlanResult.currentValueUsd))
              ? Number(exitPlanResult.currentValueUsd)
              : currentValueUsd,
            roundedExitSizeUsd: Number.isFinite(Number(exitPlanResult.roundedExitSizeUsd))
              ? Number(exitPlanResult.roundedExitSizeUsd)
              : roundedExitSizeUsd,
          };
          if (exitPlanResult.blockReason === 'zero_size_candidate') {
            this.recordGabagoolTinyExitState('gabagool_zero_size_blocked', commonBlockDetails, {
              oracleTarget,
              oracleSignal,
              oracleEventKey: eligibleOracleEventKey,
            });
          }
          if (exitPlanResult.blockReason === 'dust_exit_below_min') {
            this.recordGabagoolTinyExitState('gabagool_dust_position_remaining', commonBlockDetails, {
              oracleTarget,
              oracleSignal,
              oracleEventKey: eligibleOracleEventKey,
            });
          }
        }
        continue;
      }

      exitSignals.push({
        signal: new Signal({
          strategy: 'GabagoolBtcOracleStrategy',
          tokenId: exitPlanResult.plan.tokenId,
          marketId: exitPlanResult.plan.marketId,
          side: exitPlanResult.plan.side,
          price: exitPlanResult.plan.price,
          sizeUsd: exitPlanResult.plan.sizeUsd,
          expectedEdge: exitPlanResult.plan.expectedEdge,
          confidence: exitPlanResult.plan.confidence,
          reason: exitPlanResult.plan.reason,
          exitPlan: exitPlanResult.plan.exitPlan,
          ttlMs: exitPlanResult.plan.ttlMs,
          maxHoldMs: exitPlanResult.plan.maxHoldMs,
          metadata: {
            marketSlug: exitPlanResult.plan.marketSlug,
            marketQuestion: exitPlanResult.plan.marketQuestion,
            outcome: exitPlanResult.plan.outcome,
            gabagool: {
              oracleSignalFresh: Date.parse(String(oracleSignal?.expires_at || '')) > Date.now(),
              direction: exitPlanResult.plan.metadata.direction,
              secondsIntoWindow: exitPlanResult.plan.metadata.secondsIntoWindow,
              exitIntent: true,
              exitTrigger: exitPlanResult.plan.metadata.trigger,
              sourceWallet: exitPlanResult.plan.metadata.sourceWallet,
            },
          },
        }),
        asset,
        book,
      });
    }

    if (eligibleOracleSignal) {
      const currentPositionUsd = entryBook && Number.isFinite(Number(entryBook.midpoint))
        ? this.portfolio.positionUsd(entryTokenId, entryBook.midpoint)
        : 0;
      const entryPlanResult = buildEntryPlan({
        model,
        oracleSignal: eligibleOracleSignal,
        oracleTarget,
        book: entryBook,
        now,
        maxPaperOrderUsd: this.config.gabagoolMaxPaperOrderUsd,
        currentPositionUsd,
        minEdge: this.config.minSignalEdge,
        minExpectedEdge: this.config.gabagoolMinExpectedEdge,
        minPrice: this.config.gabagoolMinPrice,
        maxEntryPrice: this.config.gabagoolMaxEntryPrice,
        maxPrice: this.config.gabagoolMaxPrice,
        allowHighPriceEntryEdge: this.config.gabagoolAllowHighPriceEntryEdge,
        maxSpread: Math.min(this.config.hunterMaxSpread, 0.12),
        depthFloorUsd: Math.max(this.config.hunterMinTopDepthUsd, 5),
      });

      if (entryPlanResult.plan && entryAsset && entryBook) {
        const rawSignal = new Signal({
          strategy: 'GabagoolBtcOracleStrategy',
          tokenId: entryPlanResult.plan.tokenId,
          marketId: entryPlanResult.plan.marketId,
          side: entryPlanResult.plan.side,
          price: entryPlanResult.plan.price,
          sizeUsd: entryPlanResult.plan.sizeUsd,
          expectedEdge: entryPlanResult.plan.expectedEdge,
          confidence: entryPlanResult.plan.confidence,
          reason: entryPlanResult.plan.reason,
          exitPlan: entryPlanResult.plan.exitPlan,
          ttlMs: entryPlanResult.plan.ttlMs,
          maxHoldMs: entryPlanResult.plan.maxHoldMs,
          metadata: {
            marketSlug: entryPlanResult.plan.marketSlug,
            marketQuestion: entryPlanResult.plan.marketQuestion,
            outcome: entryPlanResult.plan.outcome,
            gabagool: {
              oracleSignalFresh: true,
              validBook: isBookComplete(entryBook),
              volatilityGuardPassed: !this.volGuard?.isTripped?.(entryPlanResult.plan.tokenId),
              lateEntryWindowPassed: true,
              direction: entryPlanResult.plan.metadata.direction,
              secondsIntoWindow: entryPlanResult.plan.metadata.secondsIntoWindow,
              signalExpiresAt: entryPlanResult.plan.metadata.signalExpiresAt,
              sourceWallet: entryPlanResult.plan.metadata.sourceWallet,
              oracleEventKey: eligibleOracleEventKey,
            },
          },
        });
        this.recordGabagoolMetric('gabagool_candidate_built', {
          tokenId: rawSignal.tokenId,
          marketId: rawSignal.marketId,
          marketSlug: entryPlanResult.plan.marketSlug,
          outcome: entryPlanResult.plan.outcome,
          side: rawSignal.side,
          price: rawSignal.price,
          sizeUsd: rawSignal.sizeUsd,
          expectedEdge: rawSignal.expectedEdge,
          confidence: rawSignal.confidence,
        });
        const entryGuard = this.gabagoolEntryGuard(rawSignal, this.cache.markPrices(), now);
        if (entryGuard.blocked) {
          const exitAttemptSummary = attemptGabagoolExits();
          this.lastGabagoolBlockedReason = entryGuard.reason;
          this.lastGabagoolPlacementDecision = `IDLE:${entryGuard.reason}`;
          const duplicatePlacementGuarded = (
            entryGuard.reason === 'gabagool_reentry_guard' &&
            entryGuard.guardType === 'same_token_open_order' &&
            this.maybeRecordGabagoolDuplicatePlacementGuard(rawSignal, entryBook)
          );
          if (entryGuard.reason === 'gabagool_loss_guard') {
            this.recordGabagoolMetric('gabagool_entry_paused', {
              tokenId: rawSignal.tokenId,
              marketId: rawSignal.marketId,
              marketSlug: rawSignal.metadata?.marketSlug,
              outcome: rawSignal.metadata?.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              reason: entryGuard.reason,
            });
          } else if (entryGuard.reason === 'gabagool_same_market_direction_guard') {
            this.recordGabagoolMetric('gabagool_same_market_direction_blocked', {
              tokenId: rawSignal.tokenId,
              marketId: rawSignal.marketId,
              marketSlug: rawSignal.metadata?.marketSlug,
              outcome: rawSignal.metadata?.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              reason: entryGuard.reason,
            });
          } else if (
            entryGuard.reason === 'gabagool_reentry_guard' ||
            entryGuard.reason === 'gabagool_reentry_guard_uncertain_state' ||
            entryGuard.reason === 'gabagool_market_lockout'
          ) {
            if (!duplicatePlacementGuarded) {
              this.recordGabagoolMetric('gabagool_reentry_blocked', {
                tokenId: rawSignal.tokenId,
                marketId: rawSignal.marketId,
                marketSlug: rawSignal.metadata?.marketSlug,
                outcome: rawSignal.metadata?.outcome,
                side: rawSignal.side,
                price: rawSignal.price,
                sizeUsd: rawSignal.sizeUsd,
                expectedEdge: rawSignal.expectedEdge,
                confidence: rawSignal.confidence,
                reason: entryGuard.reason,
              });
            }
          } else if (entryGuard.reason === 'gabagool_churn_guard') {
            this.recordGabagoolMetric('gabagool_churn_blocked', {
              tokenId: rawSignal.tokenId,
              marketId: rawSignal.marketId,
              marketSlug: rawSignal.metadata?.marketSlug,
              outcome: rawSignal.metadata?.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              reason: entryGuard.reason,
            });
          } else if (entryGuard.reason === 'gabagool_high_price_entry_guard') {
            this.recordGabagoolMetric('gabagool_high_price_entry_blocked', {
              tokenId: rawSignal.tokenId,
              marketId: rawSignal.marketId,
              marketSlug: rawSignal.metadata?.marketSlug,
              outcome: rawSignal.metadata?.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              reason: entryGuard.reason,
            });
          } else if (entryGuard.reason === 'gabagool_mixed_mode_pace') {
            this.recordGabagoolMetric('gabagool_placement_blocked', {
              tokenId: rawSignal.tokenId,
              marketId: rawSignal.marketId,
              marketSlug: rawSignal.metadata?.marketSlug,
              outcome: rawSignal.metadata?.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              reason: entryGuard.reason,
            });
          }
          if (!duplicatePlacementGuarded) {
            this.recordGabagoolMetric('gabagool_placement_decision', {
              tokenId: rawSignal.tokenId,
              marketId: rawSignal.marketId,
              marketSlug: rawSignal.metadata?.marketSlug,
              outcome: rawSignal.metadata?.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              reason: this.lastGabagoolPlacementDecision,
            });
          }
          this.maybeEmitGabagoolExposureCapRiskRelay(rawSignal, {
            sophieDecision: 'NOT_RUN',
          });
          if (!duplicatePlacementGuarded) {
            warn(
              `[GABAGOOL IDLE] reason=${entryGuard.reason} token=${shortId(rawSignal.tokenId)} ` +
              `marketSlug=${rawSignal.metadata?.marketSlug || 'unknown'} exitsAttempted=${exitAttemptSummary.attempts} ` +
              `${Object.entries(entryGuard)
                .filter(([key, value]) => !['blocked', 'reason'].includes(key) && value != null)
                .map(([key, value]) => `${key}=${cleanLogValue(value)}`)
                .join(' ')}`
            );
          }
          maybeLogActiveExitIdle(exitAttemptSummary, rawSignal);
        } else {
          const exposureBreakdown = this.risk.exposureBreakdown(rawSignal);
          const exposureCapView = this.gabagoolPaperExposureCapView({
            markPrices: this.cache.markPrices(),
            riskExposure: exposureBreakdown,
            now: Date.now(),
          });
          if (
            exposureBreakdown.wouldTotalExposureUsd > this.config.maxTotalExposureUsd &&
            exposureCapView.bypassedBecauseOnlyExpiredDeadExposure !== true
          ) {
            const exitAttemptSummary = attemptGabagoolExits();
            this.lastGabagoolBlockedReason = 'exposure_cap_waiting_for_exit';
            this.lastGabagoolRiskBlockReason = 'max_total_exposure';
            this.lastGabagoolPlacementDecision = 'IDLE:exposure_cap_waiting_for_exit';
            this.recordGabagoolMetric('gabagool_placement_decision', {
              tokenId: rawSignal.tokenId,
              marketId: rawSignal.marketId,
              marketSlug: rawSignal.metadata?.marketSlug,
              outcome: rawSignal.metadata?.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              reason: this.lastGabagoolPlacementDecision,
              ...exposureBreakdown,
            });
            warn(
              `[GABAGOOL IDLE] reason=exposure_cap_waiting_for_exit token=${shortId(rawSignal.tokenId)} ` +
              `marketSlug=${rawSignal.metadata?.marketSlug || 'unknown'} exitsAttempted=${exitAttemptSummary.attempts} ` +
              `${formatRiskBlockDetails(exposureBreakdown)}`
            );
            maybeLogActiveExitIdle(exitAttemptSummary, rawSignal);
          } else {
            if (
              exposureBreakdown.wouldTotalExposureUsd > this.config.maxTotalExposureUsd &&
              exposureCapView.bypassedBecauseOnlyExpiredDeadExposure === true
            ) {
              info(
                `[GABAGOOL EXPOSURE CAP BYPASS] token=${shortId(rawSignal.tokenId)} ` +
                `marketSlug=${rawSignal.metadata?.marketSlug || 'unknown'} ` +
                `rawPortfolioExposureUsd=${fmtMoney(exposureCapView.rawPortfolioExposureUsd)} ` +
                `excludedDeadExposureUsd=${fmtMoney(exposureCapView.excludedDeadExposureUsd)} ` +
                `capBlockingExposureUsdAfterExclusions=${fmtMoney(exposureCapView.capBlockingExposureUsdAfterExclusions)} ` +
                `activeTradableExposureUsd=${fmtMoney(exposureCapView.activeTradableExposureUsd)} ` +
                `bypass=true reason=only_expired_dead_btc_5m_exposure_remains`
              );
            }
            this.emitGabagoolUpdate('candidate_ready', {
              strategy: rawSignal.strategy,
              marketSlug: entryPlanResult.plan.marketSlug,
              marketQuestion: entryPlanResult.plan.marketQuestion,
              tokenId: rawSignal.tokenId,
              outcome: entryPlanResult.plan.outcome,
              side: rawSignal.side,
              price: rawSignal.price,
              sizeUsd: rawSignal.sizeUsd,
              expectedEdge: rawSignal.expectedEdge,
              confidence: rawSignal.confidence,
              sophieDecision: 'NOT_RUN',
              riskDecision: 'NOT_RUN',
              oracleEventKey: eligibleOracleEventKey,
            });
            this.trySignal(rawSignal, entryAsset, entryBook);
            maybeLogActiveExitIdle(
          attemptGabagoolExits(),
          rawSignal || idleSignalFallback
        );
          }
        }
      } else if (entryPlanResult.blockReason) {
        if (entryPlanResult.blockReason === 'gabagool_high_price_entry_guard') {
          this.recordGabagoolMetric('gabagool_high_price_entry_blocked', {
            tokenId: eligibleOracleSignal?.token_id,
            marketId: oracleTarget?.target?.rawMarketId || oracleTarget?.target?.slug || null,
            marketSlug: oracleTarget?.target?.slug || null,
            outcome: this.gabagoolOutcomeForSignal(eligibleOracleSignal, oracleTarget),
            side: 'buy',
            price: entryBook?.bestAsk,
            sizeUsd: this.config.gabagoolMaxPaperOrderUsd,
            expectedEdge: entryPlanResult.expectedEdge,
            confidence: eligibleOracleSignal?.confidence,
            reason: entryPlanResult.blockReason,
          });
        }
        this.logGabagoolPresophieBlock(
          entryPlanResult.blockReason,
          this.gabagoolPresophiePayload({
            oracleTarget,
            oracleSignal: eligibleOracleSignal,
            book: entryBook,
            oracleEventKey: eligibleOracleEventKey,
          })
        );
        maybeLogActiveExitIdle(
          attemptGabagoolExits(),
          idleSignalFallback
        );
      } else {
        maybeLogActiveExitIdle(
          attemptGabagoolExits(),
          idleSignalFallback
        );
      }
    } else {
      maybeLogActiveExitIdle(attemptGabagoolExits());
    }
  }

  buildBtcOracleReport(markPrices = this.cache.markPrices(), now = Date.now()) {
    this.syncPortfolioMarks(markPrices);
    const health = this.portfolio.executionHealth(now);
    const ledger = this.portfolio.strategyLedger(isBtcOracleStrategy, markPrices, now);
    const standardLedger = this.portfolio.strategyLedger((strategy) => !isBtcOracleStrategy(strategy), markPrices, now);
    const spreadHunterLedger = this.portfolio.strategyLedger((strategy) => resolveStrategyName(strategy) === 'SpreadHunter', markPrices, now);
    const strategyPnlBreakdown = this.portfolio.pnlBreakdownByStrategy(markPrices, now);
    const hourAgo = now - 60 * 60_000;
    const recentEvents = this.portfolio.executionEvents.filter((event) => (
      Number(event.ts) >= hourAgo && isBtcOracleStrategy(event.strategy)
    ));
    const candidateQualityEvents = recentEvents.filter((event) => event.type === 'gabagool_candidate_built');
    const qualityEvents = candidateQualityEvents.length > 0
      ? candidateQualityEvents
      : recentEvents.filter((event) => (
        Number.isFinite(event.expectedEdge) || Number.isFinite(event.confidence)
      ));
    const fillEvents = recentEvents.filter((event) => event.type === 'gabagool_fill');
    const blockedEvents = recentEvents.filter((event) => (
      event.reason &&
      (
        event.type === 'gabagool_presophie_block' ||
        event.type === 'gabagool_sophie_blocked' ||
        event.type === 'gabagool_risk_blocked' ||
        event.type === 'gabagool_placement_blocked' ||
        event.type === 'gabagool_duplicate_oracle_signal'
      )
    ));
    const blockedReasonCounts = new Map();
    for (const event of blockedEvents) {
      const reason = String(event.reason || '');
      if (!reason) continue;
      blockedReasonCounts.set(reason, (blockedReasonCounts.get(reason) || 0) + 1);
    }
    const mostCommonBlockedReason = [...blockedReasonCounts.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })[0]?.[0] || null;
    const averageExpectedEdge = averageFinite(
      qualityEvents.map((event) => Number(event.expectedEdge))
    );
    const averageConfidence = averageFinite(
      qualityEvents.map((event) => Number(event.confidence))
    );
    const averageTimeToFillSec = averageFinite(
      fillEvents.map((event) => Number(event.timeToFillSec))
    );
    const fillSourceCountsLastHour = health.fillCountsBySourceLastHour || fillSourceCountsObject(fillEvents);

    const target = this.lastGabagoolOracleTarget || null;
    const lastSignal = this.lastGabagoolOracleSignal || null;
    const upTokenId = String(target?.BTC_UP_TOKEN_ID || '');
    const downTokenId = String(target?.BTC_DOWN_TOKEN_ID || '');
    const combinedExposure = new Map();
    const ensureExposure = (tokenId) => {
      const key = String(tokenId || '');
      if (!key) return null;
      if (!combinedExposure.has(key)) {
        combinedExposure.set(key, {
          tokenId: key,
          marketId: '',
          outcome: key === upTokenId ? 'Up' : key === downTokenId ? 'Down' : null,
          qty: 0,
          avgEntryPrice: null,
          mark: markPrices.get(key) ?? null,
          positionExposureUsd: 0,
          openOrderExposureUsd: 0,
          totalExposureUsd: 0,
          unrealizedPnl: 0,
        });
      }
      return combinedExposure.get(key);
    };

    for (const item of ledger.perTokenExposure) {
      const entry = ensureExposure(item.tokenId);
      if (!entry) continue;
      entry.marketId = item.marketId || entry.marketId;
      entry.qty = Number(item.qty || 0);
      entry.avgEntryPrice = Number.isFinite(Number(item.avgEntryPrice)) ? Number(item.avgEntryPrice) : null;
      entry.mark = Number.isFinite(Number(item.mark)) ? Number(item.mark) : entry.mark;
      entry.positionExposureUsd = Number(item.positionExposureUsd || 0);
      entry.openOrderExposureUsd = Number(item.openOrderExposureUsd || 0);
      entry.totalExposureUsd = Number(item.totalExposureUsd || (entry.positionExposureUsd + entry.openOrderExposureUsd));
      entry.unrealizedPnl = Number(item.unrealizedPnl || 0);
    }

    for (const item of ledger.openOrderExposurePerToken) {
      const entry = ensureExposure(item.tokenId);
      if (!entry) continue;
      entry.marketId = item.marketId || entry.marketId;
      entry.openOrderExposureUsd = Number(item.openOrderExposureUsd || 0);
      entry.totalExposureUsd = Number(entry.positionExposureUsd || 0) + Number(entry.openOrderExposureUsd || 0);
    }

    const perTokenExposure = [...combinedExposure.values()]
      .filter((item) => item.totalExposureUsd > 0 || item.positionExposureUsd > 0 || item.openOrderExposureUsd > 0)
      .sort((a, b) => b.totalExposureUsd - a.totalExposureUsd);
    const activeUpTokenExposureUsd = upTokenId ? (combinedExposure.get(upTokenId)?.totalExposureUsd || 0) : 0;
    const activeDownTokenExposureUsd = downTokenId ? (combinedExposure.get(downTokenId)?.totalExposureUsd || 0) : 0;
    const exposureSamplesLastHour = this.btcOracleExposureSamples.filter((sample) => Number(sample.ts) >= hourAgo);
    const maxExposureUsedLastHour = Math.max(
      Number(ledger.totalExposureUsd || 0),
      ...exposureSamplesLastHour.map((sample) => Number(sample.totalExposureUsd || 0))
    );

    const capCandidates = [
      Number(this.config.maxPositionUsdPerAsset),
      Number(this.config.maxMarketExposureUsd),
      Number(this.config.maxTotalExposureUsd),
    ].filter((value) => Number.isFinite(value) && value > 0);
    const currentExposureCapUsd = capCandidates.length > 0 ? Math.min(...capCandidates) : null;
    const portfolioExposure = this.portfolio.portfolioExposureBreakdown(markPrices);
    const riskExposure = this.risk.exposureBreakdown(null, { markPrices });
    const gabagoolNetPnl = this.gabagoolNetPnl(ledger);
    const gabagoolDrawdownPct = this.gabagoolDrawdownPct(ledger);
    const gabagoolClosedLossUsd = Math.max(0, -Number(ledger.closedPnl || 0));
    const lossGuard = this.gabagoolLossGuardState(markPrices, now);
    const gabagoolEntriesPaused = lossGuard.paused;
    const exposureCapView = this.gabagoolPaperExposureCapView({
      markPrices,
      ledger,
      riskExposure,
      now,
    });
    const roundTripsLastHour = (ledger.roundTrips || []).filter((trip) => Number(trip.exitTs || 0) >= hourAgo);
    const gabagoolAvgRoundTripPnl = roundTripsLastHour.length > 0
      ? roundTripsLastHour.reduce((sum, trip) => sum + Number(trip.realizedPnl || 0), 0) / roundTripsLastHour.length
      : null;
    const dustPositions = perTokenExposure.filter((item) => (
      Number(item.positionExposureUsd || 0) > 0 &&
      Number(item.positionExposureUsd || 0) < Number(this.config.minOrderUsd || 0)
    ));
    const riskExposureUsd = Number(riskExposure.riskTotalExposureUsd || 0);
    const portfolioExposureUsd = Number(portfolioExposure.totalExposureUsd || 0);
    const btcOracleExposureUsd = Number(ledger.totalExposureUsd || 0);
    const exposureExclusionUsd = Number(riskExposure.paperEntryExposureExclusionUsd || 0);
    const excludedDeadExposureReasonSummary = String(riskExposure.excludedDeadExposureReasonSummary || 'none');
    const exposureMismatchUsd = (riskExposureUsd + exposureExclusionUsd) - portfolioExposureUsd;
    const exposureMismatchReason = Math.abs(exposureMismatchUsd) <= 0.01
      ? (
        exposureExclusionUsd > 0.01
          ? (
            excludedDeadExposureReasonSummary.startsWith('expired_btc_5m_window:')
              ? 'intentional_expired_btc_5m_exclusion'
              : 'intentional_dead_exposure_exclusion'
          )
          : 'none'
      )
      : 'portfolio_and_risk_formulas_diverged';

    const marketStartMs = Number.isFinite(Number(target?.ts)) ? Number(target.ts) * 1000 : null;
    const marketEndMs = marketStartMs == null ? null : marketStartMs + (5 * 60_000);
    const timeRemainingSec = marketEndMs == null ? null : Math.max(0, Math.round((marketEndMs - now) / 1000));
    const upBook = this.lastGabagoolBooks?.up || null;
    const downBook = this.lastGabagoolBooks?.down || null;
    const btcOraclePaperTradingFlag = Object.prototype.hasOwnProperty.call(process.env, 'ENABLE_BTC_ORACLE_PAPER_TRADING')
      ? (envFlagEnabled(process.env.ENABLE_BTC_ORACLE_PAPER_TRADING) ? 'enabled_not_required' : 'disabled_not_required')
      : 'not_required';

    return {
      generatedAt: new Date(now).toISOString(),
      strategyStatus: {
        enableGabagoolBtcImitation: this.config.enableGabagoolBtcImitation === true,
        enableBtcOraclePaperTrading: btcOraclePaperTradingFlag,
        telegramUpdatesEnabled: this.config.gabagoolTelegramUpdates === true,
        globalMinConfidence: Number(this.config.minConfidence),
        gabagoolMinConfidencePaper: Number(this.config.gabagoolMinConfidence),
        gabagoolMinConfidenceLive: Number(this.config.gabagoolMinConfidenceLive),
        gabagoolActiveConfidenceMode: this.config.enableLiveTrading === true ? 'live' : 'paper',
        gabagoolActiveMinConfidence: this.config.enableLiveTrading === true
          ? Math.max(Number(this.config.minConfidence), Number(this.config.gabagoolMinConfidenceLive))
          : Number(this.config.gabagoolMinConfidence),
        gabagoolEntriesPaused,
        gabagoolEntryPauseReason: gabagoolEntriesPaused ? 'gabagool_loss_guard' : 'none',
        gabagoolDrawdownPct,
        gabagoolLossGuardConfiguredClosedLossUsd: Number(lossGuard.maxClosedLossUsd || 0),
        gabagoolLossGuardCurrentClosedLossUsd: Number(lossGuard.closedLossUsd || 0),
        gabagoolLossGuardCooldownMs: Number(lossGuard.cooldownMs || 0),
        gabagoolLossGuardCooldownRemainingMs: Number(lossGuard.cooldownRemainingMs || 0),
        gabagoolLossGuardRecoveryEligible: lossGuard.recoveryEligible === true,
        gabagoolLossGuardRecoveryActive: lossGuard.recoveryActive === true,
        gabagoolLossGuardRecoveryBlockedReason: lossGuard.recoveryBlockedReason || 'none',
        gabagoolLossGuardTriggerSource: lossGuard.triggerEvent?.source || 'none',
        gabagoolLossGuardActivePositionExposureUsd: Number(lossGuard.activeBtcPositionExposureUsd || 0),
        gabagoolLossGuardOpenOrderExposureUsd: Number(lossGuard.openBtcOrderExposureUsd || 0),
        gabagoolLossGuardStaleExposureUsd: Number(lossGuard.staleBtcExposureUsd || 0),
        gabagoolLossGuardUnresolvedExposureUsd: Number(lossGuard.unresolvedBtcExposureUsd || 0),
        gabagoolLossGuardDustExposureUsd: Number(lossGuard.dustBtcExposureUsd || 0),
        liveFlags: {
          enableLiveTrading: this.config.enableLiveTrading === true,
          liveAutoExecute: this.config.liveAutoExecute === true,
          liveKillSwitch: this.config.liveKillSwitch === true,
          liveDryRunOnly: this.config.liveDryRunOnly === true,
          liveSubmitConfirm: this.config.liveSubmitConfirm === true,
        },
      },
      signalStats: {
        oracleSignalsReadLastHour: health.oracleSignalsReadLastHour,
        oracleSignalsFreshLastHour: health.oracleSignalsFreshLastHour,
        oracleSignalsExpiredLastHour: health.oracleSignalsExpiredLastHour,
        oracleSignalsNotConfirmedLastHour: health.oracleSignalsNotConfirmedLastHour,
        oracleSignalsConfirmedLastHour: health.oracleSignalsConfirmedLastHour,
        duplicateOracleSignalsSkippedLastHour: health.duplicateOracleSignalsSkippedLastHour,
        lastOracleSignalTimestamp: formatTimestampValue(lastSignal?.timestamp),
        lastOracleSignalDirection: lastSignal?.direction || null,
        lastOracleSignalOutcome: lastSignal?.outcome || null,
        lastOracleSignalMarketSlug: lastSignal?.marketSlug || target?.slug || null,
        lastOracleSignalBlockedReason: lastSignal?.blockedReason || this.lastGabagoolBlockedReason || null,
        lastNotConfirmedReason: lastSignal?.lastNotConfirmedReason || null,
        lastConfirmCheck: lastSignal?.confirmCheck || this.lastGabagoolConfirmCheck || null,
        confirmedSource: lastSignal?.confirmedSource || null,
        hasConfirmedField: lastSignal?.hasConfirmedField === true,
      },
      pipelineStats: {
        gabagoolCandidatesBuiltLastHour: health.gabagoolCandidatesBuiltLastHour,
        gabagoolZeroSizeBlockedLastHour: health.gabagoolZeroSizeBlockedLastHour,
        gabagoolSophieEvaluatedLastHour: health.gabagoolSophieEvaluatedLastHour,
        gabagoolSophieAdmittedLastHour: health.gabagoolSophieAdmittedLastHour,
        gabagoolSophieBlockedLastHour: health.gabagoolSophieBlockedLastHour,
        gabagoolRiskEvaluatedLastHour: health.gabagoolRiskEvaluatedLastHour,
        gabagoolRiskAdmittedLastHour: health.gabagoolRiskAdmittedLastHour,
        gabagoolRiskBlockedLastHour: health.gabagoolRiskBlockedLastHour,
        gabagoolPlacementAttemptedLastHour: health.gabagoolPlacementAttemptedLastHour,
        gabagoolPlacementBlockedLastHour: health.gabagoolPlacementBlockedLastHour,
        gabagoolOrdersPlacedLastHour: health.gabagoolOrdersPlacedLastHour,
        gabagoolFillsLastHour: health.gabagoolFillsLastHour,
        gabagoolExitsLastHour: health.gabagoolExitsLastHour,
        gabagoolRepeatedSameMarketSameTokenEntriesLastHour: health.gabagoolRepeatedSameMarketSameTokenEntriesLastHour,
        gabagoolTelegramSuppressedLastHour: health.gabagoolTelegramSuppressedLastHour,
        gabagoolChurnBlocksLastHour: health.gabagoolChurnBlocksLastHour,
        gabagoolSameMarketDirectionBlocksLastHour: health.gabagoolSameMarketDirectionBlocksLastHour,
        gabagoolStaleDustIgnoredLastHour: health.gabagoolStaleDustIgnoredLastHour,
        gabagoolSameMarketUnknownDirectionIgnoredLastHour: health.gabagoolSameMarketUnknownDirectionIgnoredLastHour,
        gabagoolReentryBlocksLastHour: health.gabagoolReentryBlocksLastHour,
        gabagoolHighPriceEntryBlocksLastHour: health.gabagoolHighPriceEntryBlocksLastHour,
        gabagoolPlacementBlockReasonLast: health.gabagoolPlacementBlockReasonLast || this.lastGabagoolPlacementBlockReason || null,
        gabagoolLastRiskBlockReason: health.gabagoolLastRiskBlockReason || this.lastGabagoolRiskBlockReason || null,
        gabagoolLastSophieBlockReason: health.gabagoolLastSophieBlockReason || this.lastGabagoolSophieBlockReason || null,
        gabagoolLastPlacementDecision: health.gabagoolLastPlacementDecision || this.lastGabagoolPlacementDecision || null,
        gabagoolMarketLockoutReasonLast: health.gabagoolMarketLockoutReasonLast || this.lastGabagoolMarketLockoutReason || null,
        gabagoolZeroSizeSourceLast: health.gabagoolZeroSizeSourceLast || null,
      },
      exitStats: {
        gabagoolDustExitsLastHour: health.gabagoolDustExitsLastHour,
        gabagoolDustExitsSuppressedLastHour: health.gabagoolDustExitsSuppressedLastHour,
        gabagoolDustExitAllowedLastHour: health.gabagoolDustExitAllowedLastHour,
        gabagoolDustPositionRemainingLastHour: health.gabagoolDustPositionRemainingLastHour,
        gabagoolProfitExitsLastHour: health.gabagoolProfitExitsLastHour,
        gabagoolLossExitsLastHour: health.gabagoolLossExitsLastHour,
        gabagoolLossExitBlocksLastHour: health.gabagoolLossExitBlocksLastHour,
        gabagoolRepeatedBlockedLossExitCountLastHour: health.gabagoolRepeatedBlockedLossExitCountLastHour,
        gabagoolInventoryReducesLastHour: health.gabagoolInventoryReducesLastHour,
        gabagoolInvalidZeroSizeLastHour: health.gabagoolInvalidZeroSizeLastHour,
        gabagoolLastExitClassification: health.gabagoolLastExitClassification || null,
        gabagoolLastExitPnl: health.gabagoolLastExitPnl == null ? null : Number(health.gabagoolLastExitPnl),
        lastExitAvgEntry: health.lastExitAvgEntry == null ? null : Number(health.lastExitAvgEntry),
        lastExitSellPrice: health.lastExitSellPrice == null ? null : Number(health.lastExitSellPrice),
      },
      pnl: {
        btcOraclePaperClosedPnl: Number(ledger.closedPnl || 0),
        btcOraclePaperOpenPnl: Number(ledger.openPnl || 0),
        btcOraclePaperRealizedPnl: Number(ledger.realizedPnl || 0),
        btcOraclePaperUnrealizedPnl: Number(ledger.unrealizedPnl || 0),
        trustedClosedPnl: Number(ledger.trustedClosedPnl || 0),
        untrustedClosedPnl: Number(ledger.untrustedClosedPnl || 0),
        trustedOpenPnl: Number(ledger.trustedOpenPnl || 0),
        untrustedOpenPnl: Number(ledger.untrustedOpenPnl || 0),
        gabagoolPaperClosedPnl: Number(ledger.closedPnl || 0),
        gabagoolPaperUnrealizedPnl: Number(ledger.unrealizedPnl || 0),
        gabagoolPaperNetPnl: gabagoolNetPnl,
        spreadHunterPaperClosedPnl: Number(spreadHunterLedger.closedPnl || 0),
        spreadHunterPaperOpenPnl: Number(spreadHunterLedger.openPnl || 0),
        spreadHunterTrustedClosedPnl: Number(spreadHunterLedger.trustedClosedPnl || 0),
        spreadHunterTrustedOpenPnl: Number(spreadHunterLedger.trustedOpenPnl || 0),
        btcOraclePaperEquityContribution: Number(ledger.equityContribution || 0),
        btcOraclePaperGrossBuyUsd: Number(ledger.grossBuyUsd || 0),
        btcOraclePaperGrossSellUsd: Number(ledger.grossSellUsd || 0),
        btcOraclePaperFeesEstimate: Number(ledger.feesEstimate || 0),
        btcOraclePaperNetAfterFeesEstimate: Number(ledger.netAfterFeesEstimate || 0),
        pnlByStrategy: strategyPnlBreakdown.pnlByStrategy,
        trustedPnlByStrategy: strategyPnlBreakdown.trustedPnlByStrategy,
        untrustedPnlByStrategy: strategyPnlBreakdown.untrustedPnlByStrategy,
      },
      exposure: {
        currentBtcOraclePositionExposureUsd: Number(ledger.currentPositionExposureUsd || 0),
        currentBtcOracleOpenOrderExposureUsd: Number(ledger.currentOpenOrderExposureUsd || 0),
        totalBtcOracleExposureUsd: Number(ledger.totalExposureUsd || 0),
        perTokenExposure,
        currentBtcMarketSlug: target?.slug || lastSignal?.marketSlug || null,
        activeUpTokenExposureUsd,
        activeDownTokenExposureUsd,
        maxBtcOracleExposureUsedLastHourUsd: maxExposureUsedLastHour,
        currentExposureCapUsd,
        exposureCapComponents: {
          maxPositionUsdPerAsset: Number(this.config.maxPositionUsdPerAsset || 0),
          maxMarketExposureUsd: Number(this.config.maxMarketExposureUsd || 0),
          maxTotalExposureUsd: Number(this.config.maxTotalExposureUsd || 0),
        },
        buckets: {
          activeTradableExposureUsd: Number(riskExposure.activeTradableExposureUsd || 0),
          staleNoBidExposureUsd: Number(riskExposure.staleNoBidExposureUsd || 0),
          confirmedNoOrderbook404ExposureUsd: Number(riskExposure.confirmedNoOrderbook404ExposureUsd || 0),
          expiredBtc5mExposureUsd: Number(riskExposure.expiredBtc5mExposureUsd || 0),
          resolutionPendingExposureUsd: Number(riskExposure.resolutionPendingExposureUsd || 0),
          dustExposureUsd: Number(riskExposure.dustExposureUsd || riskExposure.dustPositionExposureUsd || 0),
          capBlockingExposureUsd: Number(riskExposure.capBlockingExposureUsd || 0),
          excludedDeadExposureUsd: Number(riskExposure.excludedDeadExposureUsd || 0),
          excludedDeadExposureReasonSummary: riskExposure.excludedDeadExposureReasonSummary || 'none',
        },
        btcBuckets: {
          activeTradableExposureUsd: Number(riskExposure.btcOracleActiveTradableExposureUsd || 0),
          staleNoBidExposureUsd: Number(riskExposure.btcOracleStaleNoBidExposureUsd || 0),
          confirmedNoOrderbook404ExposureUsd: Number(riskExposure.btcOracleConfirmedNoOrderbook404ExposureUsd || 0),
          expiredBtc5mExposureUsd: Number(riskExposure.btcOracleExpiredBtc5mExposureUsd || 0),
          resolutionPendingExposureUsd: Number(riskExposure.btcOracleResolutionPendingExposureUsd || 0),
          dustExposureUsd: Number(riskExposure.btcOracleDustExposureUsd || 0),
          capBlockingExposureUsd: Number(riskExposure.capBlockingBtcOraclePositionExposureUsd || 0),
          excludedDeadExposureUsd: Number(riskExposure.excludedDeadBtcOracleExposureUsd || 0),
          excludedDeadExposureReasonSummary: riskExposure.excludedDeadExposureReasonSummary || 'none',
        },
        audit: {
          riskExposureUsd,
          portfolioExposureUsd,
          rawPortfolioExposureUsd: Number(exposureCapView.rawPortfolioExposureUsd || 0),
          btcOracleExposureUsd,
          exposureMismatchUsd,
          exposureMismatchReason,
          maxTotalExposureUsd: Number(this.config.maxTotalExposureUsd || 0),
          exposureAvailableUsd: Number(riskExposure.exposureAvailableUsd || 0),
          capBlockingExposureUsd: Number(exposureCapView.capBlockingExposureUsdAfterExclusions || 0),
          capBlockingExposureUsdAfterExclusions: Number(exposureCapView.capBlockingExposureUsdAfterExclusions || 0),
          activeTradableExposureUsd: Number(exposureCapView.activeTradableExposureUsd || 0),
          excludedDeadExposureUsd: Number(exposureCapView.excludedDeadExposureUsd || 0),
          excludedDeadExposureReasonSummary: excludedDeadExposureReasonSummary,
          stallGateBypassedBecauseOnlyExpiredDeadExposure: exposureCapView.bypassedBecauseOnlyExpiredDeadExposure === true,
        },
      },
      tradeQuality: {
        averageBtcOracleEntryPrice: ledger.averageEntryPrice,
        averageBtcOracleExitPrice: ledger.averageExitPrice,
        averageHoldSeconds: ledger.averageHoldSeconds,
        averageTimeToFillSeconds: averageTimeToFillSec,
        gabagoolRoundTripsLastHour: roundTripsLastHour.length,
        gabagoolAvgRoundTripPnl,
        gabagoolWinCount: Number(ledger.winCount || 0),
        gabagoolLossCount: Number(ledger.lossCount || 0),
        gabagoolDustExitPnl: Number(ledger.dustExitPnl || 0),
        fillRateLastHour: health.gabagoolOrdersPlacedLastHour > 0
          ? (health.gabagoolFillsLastHour / health.gabagoolOrdersPlacedLastHour) * 100
          : 0,
        winLossProxy: ledger.winLossProxy,
        averageExpectedEdge,
        averageConfidence,
        mostCommonBlockedReason,
        priceSanityBlocksLastHour: blockedEvents.filter((event) => event.reason === 'invalid_price').length,
        zeroEdgeBlocksLastHour: blockedEvents.filter((event) => event.reason === 'expected_edge_zero').length,
      },
      fillRealism: {
        paperRealisticFills: this.config.paperRealisticFills === true,
        avgFillDelayMs: health.avgFillDelayMs,
        avgTimeToFillSec: health.avgTimeToFillSec,
        zeroSecondFillCountLastHour: health.zeroSecondFillCountLastHour,
        invalidOrUntrustedFillCountLastHour: health.invalidOrUntrustedFillCountLastHour,
        trustedFillCountLastHour: health.trustedFillCountLastHour,
        untrustedFillCountLastHour: health.untrustedFillCountLastHour,
        fillCountsBySourceLastHour: fillSourceCountsLastHour,
        orderRealismBlocksLastHour: health.orderRealismBlocksLastHour,
        lastFillAudit: health.lastFillAudit,
      },
      spreadHunterStatus: {
        closedPnl: Number(spreadHunterLedger.closedPnl || 0),
        openPnl: Number(spreadHunterLedger.openPnl || 0),
        trustedClosedPnl: Number(spreadHunterLedger.trustedClosedPnl || 0),
        trustedOpenPnl: Number(spreadHunterLedger.trustedOpenPnl || 0),
        untrustedClosedPnl: Number(spreadHunterLedger.untrustedClosedPnl || 0),
        untrustedOpenPnl: Number(spreadHunterLedger.untrustedOpenPnl || 0),
        ordersPlacedLastHour: Number(health.strategyOrderCountsLastHour?.SpreadHunter || 0),
        fillsLastHour: Number(health.strategyFillCountsLastHour?.SpreadHunter || 0),
        blockedByGhostLastHour: health.spreadHunterGhostBlocksLastHour,
        blockedBySophieLastHour: health.spreadHunterSophieBlocksLastHour,
        blockedByConfidenceLastHour: health.spreadHunterConfidenceBlocksLastHour,
        blockedByCooldownLastHour: health.spreadHunterCooldownBlocksLastHour,
        blockedByExecutionRealismLastHour: health.spreadHunterExecutionRealismBlocksLastHour,
      },
      marketSnapshot: {
        marketSlug: target?.slug || null,
        timeRemainingSec,
        upBid: Number.isFinite(Number(upBook?.bestBid)) ? Number(upBook.bestBid) : null,
        upAsk: Number.isFinite(Number(upBook?.bestAsk)) ? Number(upBook.bestAsk) : null,
        upSpread: Number.isFinite(Number(upBook?.spread)) ? Number(upBook.spread) : null,
        downBid: Number.isFinite(Number(downBook?.bestBid)) ? Number(downBook.bestBid) : null,
        downAsk: Number.isFinite(Number(downBook?.bestAsk)) ? Number(downBook.bestAsk) : null,
        downSpread: Number.isFinite(Number(downBook?.spread)) ? Number(downBook.spread) : null,
        btcSpotPriceUsedByOracle: Number.isFinite(Number(lastSignal?.currentBtcPrice)) ? Number(lastSignal.currentBtcPrice) : null,
        btcMovePercentUsedByOracle: Number.isFinite(Number(lastSignal?.btcPersistedMovePct)) ? Number(lastSignal.btcPersistedMovePct) : null,
        oracleThreshold: Number.isFinite(Number(this.config.btcOracleThreshold)) ? Number(this.config.btcOracleThreshold) : null,
        persistenceMs: Number.isFinite(Number(this.config.btcOraclePersistenceMs)) ? Number(this.config.btcOraclePersistenceMs) : null,
        persistenceMinPct: Number.isFinite(Number(this.config.btcOraclePersistenceMinPct)) ? Number(this.config.btcOraclePersistenceMinPct) : null,
      },
      dust: {
        gabagoolDustPositionsCount: dustPositions.length,
        gabagoolDustValueUsd: dustPositions.reduce((sum, item) => sum + Number(item.positionExposureUsd || 0), 0),
      },
    };
  }

  formatBtcOracleReport(report) {
    const lines = ['--- BTC ORACLE / GABAGOOL REPORT ---'];
    lines.push(
      `Status: gabagoolEnabled=${formatBool(report.strategyStatus.enableGabagoolBtcImitation)} ` +
      `btcOraclePaperTrading=${formatFlagState(report.strategyStatus.enableBtcOraclePaperTrading)} ` +
      `telegramUpdates=${formatBool(report.strategyStatus.telegramUpdatesEnabled)} ` +
      `reportTelegram=${formatBool(this.config.btcOracleReportTelegram === true)}`
    );
    lines.push(
      `Live Safety: ENABLE_LIVE_TRADING=${formatBool(report.strategyStatus.liveFlags.enableLiveTrading)} ` +
      `LIVE_AUTO_EXECUTE=${formatBool(report.strategyStatus.liveFlags.liveAutoExecute)} ` +
      `LIVE_KILL_SWITCH=${formatBool(report.strategyStatus.liveFlags.liveKillSwitch)} ` +
      `LIVE_DRY_RUN_ONLY=${formatBool(report.strategyStatus.liveFlags.liveDryRunOnly)} ` +
      `LIVE_SUBMIT_CONFIRM=${formatBool(report.strategyStatus.liveFlags.liveSubmitConfirm)}`
    );
    lines.push(
      `Confidence Floors: global=${fmtCount(report.strategyStatus.globalMinConfidence, 3)} ` +
      `gabagoolPaper=${fmtCount(report.strategyStatus.gabagoolMinConfidencePaper, 3)} ` +
      `gabagoolLive=${fmtCount(report.strategyStatus.gabagoolMinConfidenceLive, 3)} ` +
      `activeMode=${report.strategyStatus.gabagoolActiveConfidenceMode} ` +
      `activeGabagoolMin=${fmtCount(report.strategyStatus.gabagoolActiveMinConfidence, 3)}`
    );
    lines.push(
      `Entry Guard: gabagoolEntriesPaused=${formatBool(report.strategyStatus.gabagoolEntriesPaused)} ` +
      `gabagoolEntryPauseReason=${report.strategyStatus.gabagoolEntryPauseReason || 'none'} ` +
      `gabagoolDrawdownPct=${fmtCount(report.strategyStatus.gabagoolDrawdownPct, 2)}`
    );
    lines.push(
      `Loss Guard: configuredClosedLossUsd=${fmtMoney(report.strategyStatus.gabagoolLossGuardConfiguredClosedLossUsd)} ` +
      `currentClosedLossUsd=${fmtMoney(report.strategyStatus.gabagoolLossGuardCurrentClosedLossUsd)} ` +
      `cooldownMs=${fmtCount(report.strategyStatus.gabagoolLossGuardCooldownMs, 0)} ` +
      `cooldownRemainingMs=${fmtCount(report.strategyStatus.gabagoolLossGuardCooldownRemainingMs, 0)} ` +
      `recoveryEligible=${formatBool(report.strategyStatus.gabagoolLossGuardRecoveryEligible)} ` +
      `recoveryActive=${formatBool(report.strategyStatus.gabagoolLossGuardRecoveryActive)} ` +
      `recoveryBlockedReason=${report.strategyStatus.gabagoolLossGuardRecoveryBlockedReason || 'none'} ` +
      `triggerSource=${report.strategyStatus.gabagoolLossGuardTriggerSource || 'none'}`
    );
    lines.push(
      `Signals 1h: read=${report.signalStats.oracleSignalsReadLastHour} ` +
      `fresh=${report.signalStats.oracleSignalsFreshLastHour} ` +
      `expired=${report.signalStats.oracleSignalsExpiredLastHour} ` +
      `notConfirmed=${report.signalStats.oracleSignalsNotConfirmedLastHour} ` +
      `confirmed=${report.signalStats.oracleSignalsConfirmedLastHour} ` +
      `duplicateSkipped=${report.signalStats.duplicateOracleSignalsSkippedLastHour}`
    );
    lines.push(
      `Last Signal: ts=${report.signalStats.lastOracleSignalTimestamp || 'n/a'} ` +
      `direction=${report.signalStats.lastOracleSignalDirection || 'n/a'} ` +
      `outcome=${report.signalStats.lastOracleSignalOutcome || 'n/a'} ` +
      `marketSlug=${report.signalStats.lastOracleSignalMarketSlug || 'n/a'} ` +
      `blocked=${report.signalStats.lastOracleSignalBlockedReason || 'none'}`
    );
    lines.push(
      `Confirm Diagnostics: confirmedSource=${report.signalStats.confirmedSource || 'n/a'} ` +
      `hasConfirmedField=${formatBool(report.signalStats.hasConfirmedField === true)} ` +
      `lastNotConfirmedReason=${report.signalStats.lastNotConfirmedReason || 'none'} ` +
      `lastConfirmCheck=${formatGabagoolConfirmCheck(report.signalStats.lastConfirmCheck)}`
    );
    lines.push(
      `Pipeline 1h: candidates=${report.pipelineStats.gabagoolCandidatesBuiltLastHour} ` +
      `zeroSizeBlocked=${report.pipelineStats.gabagoolZeroSizeBlockedLastHour} ` +
      `sophieEval=${report.pipelineStats.gabagoolSophieEvaluatedLastHour} ` +
      `sophieAdmit=${report.pipelineStats.gabagoolSophieAdmittedLastHour} ` +
      `sophieBlock=${report.pipelineStats.gabagoolSophieBlockedLastHour} ` +
      `riskEval=${report.pipelineStats.gabagoolRiskEvaluatedLastHour} ` +
      `riskAdmit=${report.pipelineStats.gabagoolRiskAdmittedLastHour} ` +
      `riskBlock=${report.pipelineStats.gabagoolRiskBlockedLastHour} ` +
      `placementAttempt=${report.pipelineStats.gabagoolPlacementAttemptedLastHour} ` +
      `placementBlock=${report.pipelineStats.gabagoolPlacementBlockedLastHour} ` +
      `churnBlocks=${report.pipelineStats.gabagoolChurnBlocksLastHour} ` +
      `sameMarketDirectionBlocks=${report.pipelineStats.gabagoolSameMarketDirectionBlocksLastHour} ` +
      `staleDustIgnored=${report.pipelineStats.gabagoolStaleDustIgnoredLastHour} ` +
      `unknownDirectionIgnored=${report.pipelineStats.gabagoolSameMarketUnknownDirectionIgnoredLastHour} ` +
      `reentryBlocks=${report.pipelineStats.gabagoolReentryBlocksLastHour} ` +
      `highPriceEntryBlocks=${report.pipelineStats.gabagoolHighPriceEntryBlocksLastHour} ` +
      `orders=${report.pipelineStats.gabagoolOrdersPlacedLastHour} ` +
      `fills=${report.pipelineStats.gabagoolFillsLastHour} ` +
      `exits=${report.pipelineStats.gabagoolExitsLastHour} ` +
      `repeatSameTokenEntries=${report.pipelineStats.gabagoolRepeatedSameMarketSameTokenEntriesLastHour} ` +
      `telegramSuppressed=${report.pipelineStats.gabagoolTelegramSuppressedLastHour}`
    );
    lines.push(
      `Exit Stats: dustExits=${report.exitStats.gabagoolDustExitsLastHour} ` +
      `dustExitsSuppressed=${report.exitStats.gabagoolDustExitsSuppressedLastHour} ` +
      `dustExitAllowed=${report.exitStats.gabagoolDustExitAllowedLastHour} ` +
      `dustPositionRemaining=${report.exitStats.gabagoolDustPositionRemainingLastHour} ` +
      `profitExits=${report.exitStats.gabagoolProfitExitsLastHour} ` +
      `lossExits=${report.exitStats.gabagoolLossExitsLastHour} ` +
      `lossExitBlocks=${report.exitStats.gabagoolLossExitBlocksLastHour} ` +
      `repeatedLossExitBlocks=${report.exitStats.gabagoolRepeatedBlockedLossExitCountLastHour} ` +
      `inventoryReduces=${report.exitStats.gabagoolInventoryReducesLastHour} ` +
      `invalidZeroSize=${report.exitStats.gabagoolInvalidZeroSizeLastHour} ` +
      `lastExitClassification=${report.exitStats.gabagoolLastExitClassification || 'none'} ` +
      `lastExitPnl=${fmtMoney(report.exitStats.gabagoolLastExitPnl)} ` +
      `lastExitAvgEntry=${fmtPrice(report.exitStats.lastExitAvgEntry)} ` +
      `lastExitSellPrice=${fmtPrice(report.exitStats.lastExitSellPrice)}`
    );
    lines.push(
      `Last Decisions: sophieBlock=${report.pipelineStats.gabagoolLastSophieBlockReason || 'none'} ` +
      `riskBlock=${report.pipelineStats.gabagoolLastRiskBlockReason || 'none'} ` +
      `placementBlock=${report.pipelineStats.gabagoolPlacementBlockReasonLast || 'none'} ` +
      `placementDecision=${report.pipelineStats.gabagoolLastPlacementDecision || 'none'} ` +
      `marketLockout=${report.pipelineStats.gabagoolMarketLockoutReasonLast || 'none'} ` +
      `zeroSizeSourceLast=${report.pipelineStats.gabagoolZeroSizeSourceLast || 'none'}`
    );
    lines.push(
      `PnL: closed=${fmtMoney(report.pnl.btcOraclePaperClosedPnl)} ` +
      `open=${fmtMoney(report.pnl.btcOraclePaperOpenPnl)} ` +
      `trustedClosed=${fmtMoney(report.pnl.trustedClosedPnl)} ` +
      `untrustedClosed=${fmtMoney(report.pnl.untrustedClosedPnl)} ` +
      `trustedOpen=${fmtMoney(report.pnl.trustedOpenPnl)} ` +
      `untrustedOpen=${fmtMoney(report.pnl.untrustedOpenPnl)} ` +
      `realized=${fmtMoney(report.pnl.btcOraclePaperRealizedPnl)} ` +
      `unrealized=${fmtMoney(report.pnl.btcOraclePaperUnrealizedPnl)} ` +
      `equityContribution=${fmtMoney(report.pnl.btcOraclePaperEquityContribution)} ` +
      `grossBuy=${fmtMoney(report.pnl.btcOraclePaperGrossBuyUsd)} ` +
      `grossSell=${fmtMoney(report.pnl.btcOraclePaperGrossSellUsd)} ` +
      `fees=${fmtMoney(report.pnl.btcOraclePaperFeesEstimate)} ` +
      `netAfterFees=${fmtMoney(report.pnl.btcOraclePaperNetAfterFeesEstimate)}`
    );
    lines.push(
      `Gabagool PnL: gabagoolPaperClosedPnl=${fmtMoney(report.pnl.gabagoolPaperClosedPnl)} ` +
      `gabagoolPaperUnrealizedPnl=${fmtMoney(report.pnl.gabagoolPaperUnrealizedPnl)} ` +
      `gabagoolPaperNetPnl=${fmtMoney(report.pnl.gabagoolPaperNetPnl)}`
    );
    lines.push(
      `SpreadHunter PnL: closed=${fmtMoney(report.spreadHunterStatus.closedPnl)} ` +
      `open=${fmtMoney(report.spreadHunterStatus.openPnl)} ` +
      `trustedClosed=${fmtMoney(report.spreadHunterStatus.trustedClosedPnl)} ` +
      `trustedOpen=${fmtMoney(report.spreadHunterStatus.trustedOpenPnl)} ` +
      `untrustedClosed=${fmtMoney(report.spreadHunterStatus.untrustedClosedPnl)} ` +
      `untrustedOpen=${fmtMoney(report.spreadHunterStatus.untrustedOpenPnl)}`
    );
    lines.push(
      `Exposure: position=${fmtMoney(report.exposure.currentBtcOraclePositionExposureUsd)} ` +
      `openOrders=${fmtMoney(report.exposure.currentBtcOracleOpenOrderExposureUsd)} ` +
      `total=${fmtMoney(report.exposure.totalBtcOracleExposureUsd)} ` +
      `up=${fmtMoney(report.exposure.activeUpTokenExposureUsd)} ` +
      `down=${fmtMoney(report.exposure.activeDownTokenExposureUsd)} ` +
      `max1h=${fmtMoney(report.exposure.maxBtcOracleExposureUsedLastHourUsd)} ` +
      `cap=${fmtMoney(report.exposure.currentExposureCapUsd)} ` +
      `marketSlug=${report.exposure.currentBtcMarketSlug || 'n/a'}`
    );
    lines.push(
      `Exposure Audit: riskExposureUsd=${fmtMoney(report.exposure.audit.riskExposureUsd)} ` +
      `portfolioExposureUsd=${fmtMoney(report.exposure.audit.portfolioExposureUsd)} ` +
      `btcOracleExposureUsd=${fmtMoney(report.exposure.audit.btcOracleExposureUsd)} ` +
      `exposureMismatchUsd=${fmtMoney(report.exposure.audit.exposureMismatchUsd)} ` +
      `exposureMismatchReason=${report.exposure.audit.exposureMismatchReason || 'unknown'} ` +
      `maxTotalExposureUsd=${fmtMoney(report.exposure.audit.maxTotalExposureUsd)} ` +
      `exposureAvailableUsd=${fmtMoney(report.exposure.audit.exposureAvailableUsd)} ` +
      `capBlockingExposureUsd=${fmtMoney(report.exposure.audit.capBlockingExposureUsd)} ` +
      `excludedDeadExposureUsd=${fmtMoney(report.exposure.audit.excludedDeadExposureUsd)} ` +
      `excludedDeadExposureReasons=${report.exposure.audit.excludedDeadExposureReasonSummary || 'none'}`
    );
    lines.push(
      `Exposure Buckets: activeTradable=${fmtMoney(report.exposure.buckets.activeTradableExposureUsd)} ` +
      `staleNoBid=${fmtMoney(report.exposure.buckets.staleNoBidExposureUsd)} ` +
      `confirmed404=${fmtMoney(report.exposure.buckets.confirmedNoOrderbook404ExposureUsd)} ` +
      `expiredBtc5m=${fmtMoney(report.exposure.buckets.expiredBtc5mExposureUsd)} ` +
      `resolutionPending=${fmtMoney(report.exposure.buckets.resolutionPendingExposureUsd)} ` +
      `dust=${fmtMoney(report.exposure.buckets.dustExposureUsd)} ` +
      `capBlocking=${fmtMoney(report.exposure.buckets.capBlockingExposureUsd)} ` +
      `excludedDead=${fmtMoney(report.exposure.buckets.excludedDeadExposureUsd)}`
    );
    lines.push(
      `BTC Exposure Buckets: activeTradable=${fmtMoney(report.exposure.btcBuckets.activeTradableExposureUsd)} ` +
      `staleNoBid=${fmtMoney(report.exposure.btcBuckets.staleNoBidExposureUsd)} ` +
      `confirmed404=${fmtMoney(report.exposure.btcBuckets.confirmedNoOrderbook404ExposureUsd)} ` +
      `expiredBtc5m=${fmtMoney(report.exposure.btcBuckets.expiredBtc5mExposureUsd)} ` +
      `resolutionPending=${fmtMoney(report.exposure.btcBuckets.resolutionPendingExposureUsd)} ` +
      `dust=${fmtMoney(report.exposure.btcBuckets.dustExposureUsd)} ` +
      `capBlocking=${fmtMoney(report.exposure.btcBuckets.capBlockingExposureUsd)} ` +
      `excludedDead=${fmtMoney(report.exposure.btcBuckets.excludedDeadExposureUsd)}`
    );
    lines.push(
      `Round Trips: gabagoolRoundTripsLastHour=${report.tradeQuality.gabagoolRoundTripsLastHour} ` +
      `gabagoolAvgRoundTripPnl=${fmtMoney(report.tradeQuality.gabagoolAvgRoundTripPnl)} ` +
      `winCount=${report.tradeQuality.gabagoolWinCount} lossCount=${report.tradeQuality.gabagoolLossCount} ` +
      `dustExitPnl=${fmtMoney(report.tradeQuality.gabagoolDustExitPnl)}`
    );
    lines.push(
      `Dust Inventory: gabagoolDustPositionsCount=${report.dust.gabagoolDustPositionsCount} ` +
      `gabagoolDustValueUsd=${fmtMoney(report.dust.gabagoolDustValueUsd)}`
    );
    if (report.exposure.perTokenExposure.length > 0) {
      lines.push(
        `Per Token Exposure: ${report.exposure.perTokenExposure.map((item) => (
          `${shortId(item.tokenId)}:${item.outcome || 'n/a'} pos=${fmtMoney(item.positionExposureUsd)} ` +
          `open=${fmtMoney(item.openOrderExposureUsd)} total=${fmtMoney(item.totalExposureUsd)}`
        )).join(' | ')}`
      );
    } else {
      lines.push('Per Token Exposure: none');
    }
    lines.push(
      `Trade Quality: avgEntry=${fmtPrice(report.tradeQuality.averageBtcOracleEntryPrice)} ` +
      `avgExit=${fmtPrice(report.tradeQuality.averageBtcOracleExitPrice)} ` +
      `avgHoldSec=${fmtCount(report.tradeQuality.averageHoldSeconds, 1)} ` +
      `avgFillSec=${fmtCount(report.tradeQuality.averageTimeToFillSeconds, 1)} ` +
      `fillRate1h=${fmtPercent(report.tradeQuality.fillRateLastHour)} ` +
      `winLoss=${report.tradeQuality.winLossProxy || '0/0'} ` +
      `avgEdge=${fmtCount(report.tradeQuality.averageExpectedEdge, 6)} ` +
      `avgConfidence=${fmtCount(report.tradeQuality.averageConfidence, 3)} ` +
      `commonBlock=${report.tradeQuality.mostCommonBlockedReason || 'none'} ` +
      `priceBlocks=${report.tradeQuality.priceSanityBlocksLastHour} ` +
      `zeroEdgeBlocks=${report.tradeQuality.zeroEdgeBlocksLastHour}`
    );
    lines.push(
      `Fill Realism: mode=${formatBool(report.fillRealism.paperRealisticFills)} ` +
      `avgFillDelayMs=${fmtCount(report.fillRealism.avgFillDelayMs, 0)} ` +
      `avgFillSec=${fmtCount(report.fillRealism.avgTimeToFillSec, 1)} ` +
      `zeroSecondFills=${report.fillRealism.zeroSecondFillCountLastHour} ` +
      `invalidUntrustedFills=${report.fillRealism.invalidOrUntrustedFillCountLastHour} ` +
      `trustedFills=${report.fillRealism.trustedFillCountLastHour} ` +
      `untrustedFills=${report.fillRealism.untrustedFillCountLastHour} ` +
      `orderRealismBlocks=${report.fillRealism.orderRealismBlocksLastHour} ` +
      `fillSourceCounts=${formatFillSourceCounts(report.fillRealism.fillCountsBySourceLastHour)}`
    );
    if (report.fillRealism.lastFillAudit) {
      lines.push(
        `Last Fill Audit: fillSource=${report.fillRealism.lastFillAudit.fillSource || 'unknown'} ` +
        `fillDelayMs=${fmtCount(report.fillRealism.lastFillAudit.fillDelayMs, 0)} ` +
        `bookAgeMs=${fmtCount(report.fillRealism.lastFillAudit.bookAgeMs, 0)} ` +
        `placementBidAsk=${fmtPrice(report.fillRealism.lastFillAudit.bestBidAtPlacement)}/${fmtPrice(report.fillRealism.lastFillAudit.bestAskAtPlacement)} ` +
        `fillBidAsk=${fmtPrice(report.fillRealism.lastFillAudit.bestBidAtFill)}/${fmtPrice(report.fillRealism.lastFillAudit.bestAskAtFill)} ` +
        `orderPrice=${fmtPrice(report.fillRealism.lastFillAudit.orderPrice)} ` +
        `wasExecutableAtPlacement=${formatBool(report.fillRealism.lastFillAudit.wasExecutableAtPlacement === true)} ` +
        `wasExecutableAtFill=${formatBool(report.fillRealism.lastFillAudit.wasExecutableAtFill === true)} ` +
        `queueHaircutApplied=${fmtCount(report.fillRealism.lastFillAudit.queueHaircutApplied, 3)} ` +
        `slippageApplied=${fmtCount(report.fillRealism.lastFillAudit.slippageApplied, 3)} ` +
        `adverseSelectionBufferApplied=${fmtCount(report.fillRealism.lastFillAudit.adverseSelectionBufferApplied, 3)} ` +
        `trustedPnl=${formatBool(report.fillRealism.lastFillAudit.trustedPnl === true)}`
      );
    }
    lines.push(
      `SpreadHunter Blocks: ghost=${report.spreadHunterStatus.blockedByGhostLastHour} ` +
      `sophie=${report.spreadHunterStatus.blockedBySophieLastHour} ` +
      `confidence=${report.spreadHunterStatus.blockedByConfidenceLastHour} ` +
      `cooldown=${report.spreadHunterStatus.blockedByCooldownLastHour} ` +
      `executionRealism=${report.spreadHunterStatus.blockedByExecutionRealismLastHour} ` +
      `orders=${report.spreadHunterStatus.ordersPlacedLastHour} fills=${report.spreadHunterStatus.fillsLastHour}`
    );
    lines.push(
      `Market Snapshot: marketSlug=${report.marketSnapshot.marketSlug || 'n/a'} ` +
      `timeRemainingSec=${fmtCount(report.marketSnapshot.timeRemainingSec, 0)} ` +
      `upBid=${fmtPrice(report.marketSnapshot.upBid)} upAsk=${fmtPrice(report.marketSnapshot.upAsk)} upSpread=${fmtCount(report.marketSnapshot.upSpread, 3)} ` +
      `downBid=${fmtPrice(report.marketSnapshot.downBid)} downAsk=${fmtPrice(report.marketSnapshot.downAsk)} downSpread=${fmtCount(report.marketSnapshot.downSpread, 3)} ` +
      `btcSpot=${fmtMoney(report.marketSnapshot.btcSpotPriceUsedByOracle)} ` +
      `btcMovePct=${fmtRatioPercent(report.marketSnapshot.btcMovePercentUsedByOracle, 3)} ` +
      `threshold=${fmtRatioPercent(report.marketSnapshot.oracleThreshold, 3)} ` +
      `persistenceMs=${fmtCount(report.marketSnapshot.persistenceMs, 0)} ` +
      `persistenceMinPct=${fmtRatioPercent(report.marketSnapshot.persistenceMinPct, 3)}`
    );
    return lines.join('\n');
  }

  formatBtcOracleReportTelegram(report) {
    const lastBlockReason = report.pipelineStats.gabagoolPlacementBlockReasonLast ||
      report.pipelineStats.gabagoolLastRiskBlockReason ||
      report.pipelineStats.gabagoolLastSophieBlockReason ||
      report.signalStats.lastOracleSignalBlockedReason ||
      'none';
    return [
      'PAPER ONLY BTC ORACLE REPORT',
      `equityContribution=${fmtMoney(report.pnl.btcOraclePaperEquityContribution)} ` +
        `closedPnl=${fmtMoney(report.pnl.btcOraclePaperClosedPnl)} ` +
        `openPnl=${fmtMoney(report.pnl.btcOraclePaperOpenPnl)} ` +
        `trustedClosed=${fmtMoney(report.pnl.trustedClosedPnl)} ` +
        `untrustedClosed=${fmtMoney(report.pnl.untrustedClosedPnl)}`,
      `orders/fills1h=${report.pipelineStats.gabagoolOrdersPlacedLastHour}/${report.pipelineStats.gabagoolFillsLastHour} ` +
        `sophieA/B=${report.pipelineStats.gabagoolSophieAdmittedLastHour}/${report.pipelineStats.gabagoolSophieBlockedLastHour} ` +
        `riskA/B=${report.pipelineStats.gabagoolRiskAdmittedLastHour}/${report.pipelineStats.gabagoolRiskBlockedLastHour} ` +
        `fillSources=${formatFillSourceCounts(report.fillRealism.fillCountsBySourceLastHour)}`,
      `signals C/E/NC=${report.signalStats.oracleSignalsConfirmedLastHour}/${report.signalStats.oracleSignalsExpiredLastHour}/${report.signalStats.oracleSignalsNotConfirmedLastHour} ` +
        `exposure=${fmtMoney(report.exposure.totalBtcOracleExposureUsd)} ` +
        `lastBlock=${lastBlockReason} ` +
        `zeroSecondFills=${report.fillRealism.zeroSecondFillCountLastHour} ` +
        `invalidUntrustedFills=${report.fillRealism.invalidOrUntrustedFillCountLastHour}`,
    ].join('\n');
  }

  maybeEmitBtcOracleReport({ markPrices = this.cache.markPrices(), now = Date.now() } = {}) {
    const report = this.buildBtcOracleReport(markPrices, now);
    this.lastBtcOracleReport = report;
    if (!this.config.enableBtcOracleReport) return report;

    const logIntervalMs = Math.max(1_000, Number(this.config.btcOracleReportEveryMs || 60_000));
    const logKey = String(Math.floor(now / logIntervalMs));
    if ((now - this.lastBtcOracleReportAt) >= logIntervalMs && this.lastBtcOracleReportKey !== logKey) {
      info(this.formatBtcOracleReport(report));
      this.lastBtcOracleReportAt = now;
      this.lastBtcOracleReportKey = logKey;
    }

    if (this.config.btcOracleReportTelegram) {
      const telegramIntervalMs = Math.max(1_000, Number(this.config.btcOracleReportTelegramEveryMs || 300_000));
      const telegramKey = String(Math.floor(now / telegramIntervalMs));
      if (
        (now - this.lastBtcOracleReportTelegramAt) >= telegramIntervalMs &&
        this.lastBtcOracleReportTelegramKey !== telegramKey
      ) {
        this.paperUpdates.sendToTelegram(this.formatBtcOracleReportTelegram(report));
        this.lastBtcOracleReportTelegramAt = now;
        this.lastBtcOracleReportTelegramKey = telegramKey;
      }
    }

    return report;
  }

  startWebSocket() {
    this.wsClient = new CLOBWebSocketClient({
      url: this.config.clobWsUrl,
      config: this.config,
      onMessage: (msg) => {
        const eventType = msg.event_type || msg.event || msg.type;
        const assetId = String(msg.asset_id || msg.assetId || msg.token_id || msg.tokenId || '');

        if (!assetId) return;

        if (eventType === 'book' || eventType === 'orderbook' || eventType === 'price_change' || eventType === 'best_bid_ask') {
          // Do not treat partial price_change events as a full book.
          // They only mark the cached book stale; REST will refresh it.
          const asset = this.cache.getAsset(assetId);
          if (asset) {
            this.cache.getFreshBook(assetId, 0).catch(() => {});
          }
        }
      },
    });

    this.wsClient.connect();
    if (this.assets.length > 0) {
      this.wsClient.subscribe(this.assets.map((a) => a.tokenId));
    }
  }

  async tick() {
    this.cycle += 1;
    this.sophieCalibratedAdmissionsThisScan = 0;
    this.sophieBootstrapAdmissionsThisScan = 0;
    this.sophieBootstrapCandidates = [];
    this.sophieMakerRecoveryCandidates = [];
    this.standardQualifiedCandidateKeysThisScan = new Set();
    this.whaleTracker?.tick?.();

    if (this.cycle === 1 || this.cycle % this.config.marketRefreshEveryCycles === 0) {
      if (this.config.nonBlockingResearchRefresh) {
        this.requestResearchRefresh();
      } else {
        await this.refreshResearch();
      }
    }

    const markPrices = this.syncPortfolioMarks(this.cache.markPrices());
    this.portfolio.updateGhostOrders(markPrices);
    this.rebalancePaperDeadExposureCashReserve(markPrices);

    for (const asset of this.assets) {
      let book;
      try {
        book = await this.cache.getFreshBook(asset.tokenId, 3_000);
      } catch (e) {
        this.logAssetBookSkip(asset, null, 'book_fetch_failed', { error: e.message });
        continue;
      }
      if (!isBookComplete(book)) {
        this.logAssetBookSkip(asset, book, 'incomplete_book');
        continue;
      }
      this.portfolio.setMarkPrice(asset.tokenId, book.midpoint);

      this.volGuard.update(asset.tokenId, book.midpoint);
      this.consensus.recordMid(asset.tokenId, book.midpoint);

      const protectiveSignals = this.execution.generateProtectiveSignals(asset, book);
      for (const signal of protectiveSignals) {
        this.trySignal(signal, asset, book);
      }

      for (const strategy of this.strategies) {
        const signals = await strategy.generate(asset, book);

        for (const rawSignal of signals) {
          this.trySignal(rawSignal, asset, book);
        }
      }
    }

    await this.runGabagoolBtcOracleImitation();

    this.flushSophieBootstrapCandidates();
    this.flushSophieMakerRecoveryCandidates();
    this.execution.processOpenOrders();
    const postOrderMarkPrices = this.syncPortfolioMarks(this.cache.markPrices());
    this.rebalancePaperDeadExposureCashReserve(postOrderMarkPrices);
    this.recordBtcOracleExposureSample(postOrderMarkPrices);
    this.maybeEmitBtcOracleReport({ markPrices: postOrderMarkPrices });
    this.paperUpdates?.maybeSendDigest?.();

    if (this.cycle % this.config.reportEveryCycles === 0) {
      this.report(postOrderMarkPrices);
      this.portfolio.saveState();
    }
  }

  logAssetBookSkip(asset, book, reason, extra = {}) {
    const key = `${asset?.tokenId || 'unknown'}:${reason}`;
    const now = Date.now();
    const last = this.assetBookSkipLastLogged.get(key) || 0;
    if (now - last < 60_000) return;
    this.assetBookSkipLastLogged.set(key, now);

    warn(
      `[ASSET PIPELINE SKIP] reason=${reason} token=${shortId(asset?.tokenId)} outcome=${asset?.outcome || 'unknown'} ` +
      `bid=${cleanLogValue(book?.bestBid)} ask=${cleanLogValue(book?.bestAsk)} spread=${cleanLogValue(book?.spread)} ` +
      `incompleteBookCause=${incompleteBookCause(book)} ${Object.entries(extra).map(([k, v]) => `${k}=${cleanLogValue(v)}`).join(' ')}`
    );
  }

  standardCandidateQualifiesForMixedModePacing(signal) {
    if (!isStandardPaperStrategy(signal)) return false;
    if (String(signal?.side || '').toLowerCase() !== 'buy') return false;
    if (isProtectiveExitStrategy(signal?.strategy)) return false;
    if (!Number.isFinite(Number(signal?.price)) || Number(signal.price) <= 0 || Number(signal.price) >= 1) return false;
    if (!Number.isFinite(Number(signal?.sizeUsd)) || Number(signal.sizeUsd) < Number(this.config.minOrderUsd || 0)) return false;
    if (!Number.isFinite(Number(signal?.expectedEdge)) || Number(signal.expectedEdge) < this.risk.minSignalEdgeForSignal(signal)) {
      return false;
    }
    const confidenceThreshold = this.risk.confidenceThreshold(signal);
    if (!Number.isFinite(Number(signal?.confidence)) || Number(signal.confidence) < Number(confidenceThreshold.minConfidence || 0)) {
      return false;
    }
    return true;
  }

  trackStandardMixedModeCandidate(signal) {
    if (!this.standardCandidateQualifiesForMixedModePacing(signal)) return false;
    const key = [
      signal.strategy || 'UNKNOWN',
      signal.marketId || signal.metadata?.marketSlug || 'unknown',
      signal.tokenId || 'unknown',
      String(signal.side || '').toLowerCase(),
    ].join(':');
    this.standardQualifiedCandidateKeysThisScan.add(key);
    this.logMixedModePace(this.mixedModePaceState());
    return true;
  }

  mixedModePaceState(now = Date.now()) {
    const candidateCount = this.standardQualifiedCandidateKeysThisScan.size;
    if (candidateCount <= 0) {
      return { considered: false, blocked: false, action: 'no_standard_candidate' };
    }
    const health = this.portfolio.executionHealth(now);
    const btcOrdersLastHour = Number(health.gabagoolOrdersPlacedLastHour || 0);
    const standardOrdersLastHour = Math.max(0, Number(health.paperOrdersPlacedLastHour || 0) - btcOrdersLastHour);
    const totalOrdersLastHour = btcOrdersLastHour + standardOrdersLastHour;
    const projectedBtcShare = (btcOrdersLastHour + 1) / Math.max(1, totalOrdersLastHour + 1);
    const paceCap = clamp(Number(this.config.mixedModeBtcOrderShareCap ?? 0.75), 0, 1);
    const standardLedger = this.portfolio.strategyLedger((strategy) => !isBtcOracleStrategy(strategy), this.cache.markPrices(), now);
    const standardExposureUsd = Number(standardLedger.totalExposureUsd || 0);
    const standardExposureCapUsd = Number(this.config.maxTotalExposureUsd || 0) *
      clamp(Number(this.config.standardExposureBucketShare ?? 0.5), 0, 1);
    const standardUnderCap = standardExposureCapUsd > 0 &&
      standardExposureUsd + Number(this.config.minOrderUsd || 0) <= standardExposureCapUsd + 1e-9;
    const blocked = standardUnderCap && btcOrdersLastHour >= 3 && projectedBtcShare > paceCap;
    return {
      considered: true,
      blocked,
      action: blocked ? 'defer_btc_to_standard' : 'allow_btc',
      btcOrdersLastHour,
      standardOrdersLastHour,
      projectedBtcShare,
      mixedModeBtcOrderShareCap: paceCap,
      standardExposureUsd,
      standardExposureCapUsd,
      standardQualifiedCandidatesThisScan: candidateCount,
    };
  }

  logMixedModePace(state = {}) {
    if (!state || state.considered !== true) return;
    const now = Date.now();
    const key = [
      state.action || 'unknown',
      state.btcOrdersLastHour || 0,
      state.standardOrdersLastHour || 0,
      state.standardQualifiedCandidatesThisScan || 0,
    ].join(':');
    if (this.lastMixedModePaceLog.key === key && now - Number(this.lastMixedModePaceLog.ts || 0) < 15_000) return;
    this.lastMixedModePaceLog = { key, ts: now };
    info(
      `[MIXED MODE PACE] btcOrdersLastHour=${state.btcOrdersLastHour || 0} ` +
      `standardOrdersLastHour=${state.standardOrdersLastHour || 0} action=${state.action || 'unknown'} ` +
      `projectedBtcShare=${cleanLogValue(state.projectedBtcShare)} ` +
      `shareCap=${cleanLogValue(state.mixedModeBtcOrderShareCap)} ` +
      `standardExposure=${cleanLogValue(state.standardExposureUsd)} ` +
      `standardCap=${cleanLogValue(state.standardExposureCapUsd)} ` +
      `standardQualifiedCandidates=${state.standardQualifiedCandidatesThisScan || 0}`
    );
  }

  standardChurnKey(signal) {
    return [
      signal?.marketId || signal?.metadata?.marketSlug || 'unknown',
      signal?.tokenId || 'unknown',
    ].join(':');
  }

  logStandardChurnGuard(signal, action, reason, extra = {}) {
    const key = [
      action || 'unknown',
      reason || 'unknown',
      this.standardChurnKey(signal),
    ].join(':');
    const now = Date.now();
    const last = this.standardChurnLastLogged.get(key) || 0;
    if (now - last < 15_000) return;
    this.standardChurnLastLogged.set(key, now);
    info(
      `[STANDARD CHURN GUARD] token=${shortId(signal?.tokenId)} action=${action} reason=${reason} ` +
      `expectedEdge=${cleanLogValue(signal?.expectedEdge)} lastExitEdge=${cleanLogValue(extra?.lastExitEdge)} ` +
      `minImprovement=${cleanLogValue(extra?.minImprovement)} cooldownSec=${cleanLogValue(extra?.cooldownSec)}`
    );
  }

  standardChurnDecision(signal, now = Date.now()) {
    if (!isStandardPaperStrategy(signal)) return { blocked: false, reason: 'not_standard_strategy' };
    if (String(signal?.side || '').toLowerCase() !== 'buy') return { blocked: false, reason: 'not_buy_entry' };
    if (isProtectiveExitStrategy(signal?.strategy)) return { blocked: false, reason: 'protective_exit' };
    const key = this.standardChurnKey(signal);
    const state = this.standardChurnCooldowns.get(key);
    if (!state) return { blocked: false, reason: 'no_recent_round_trip' };
    if (Number(state.cooldownUntil || 0) <= now) {
      this.standardChurnCooldowns.delete(key);
      this.logStandardChurnGuard(signal, 'allow', 'cooldown_expired', {
        lastExitEdge: state.lastExitEdge,
        minImprovement: this.config.standardChurnMinEdgeImprovement,
        cooldownSec: 0,
      });
      return { blocked: false, reason: 'cooldown_expired' };
    }
    const expectedEdge = Number(signal?.expectedEdge || 0);
    const lastExitEdge = Number(state.lastExitEdge || 0);
    const minImprovement = Math.max(0, Number(this.config.standardChurnMinEdgeImprovement || 0));
    if (expectedEdge >= lastExitEdge + minImprovement) {
      this.logStandardChurnGuard(signal, 'allow', 'edge_improved', {
        lastExitEdge,
        minImprovement,
        cooldownSec: Math.max(0, Math.round((Number(state.cooldownUntil || now) - now) / 1000)),
      });
      return { blocked: false, reason: 'edge_improved' };
    }
    const cooldownSec = Math.max(0, Math.round((Number(state.cooldownUntil || now) - now) / 1000));
    this.logStandardChurnGuard(signal, 'block', 'recent_round_trip_cooldown', {
      lastExitEdge,
      minImprovement,
      cooldownSec,
    });
    this.portfolio.recordExecutionEvent('standard_churn_block', {
      tokenId: signal?.tokenId,
      marketId: signal?.marketId,
      marketSlug: signal?.metadata?.marketSlug,
      side: signal?.side,
      strategy: signal?.strategy,
      price: signal?.price,
      sizeUsd: signal?.sizeUsd,
      expectedEdge,
      confidence: signal?.confidence,
      reason: 'recent_round_trip_cooldown',
      cooldownSec,
      lastExitEdge,
    });
    return { blocked: true, reason: 'recent_round_trip_cooldown', cooldownSec, lastExitEdge, minImprovement };
  }

  updateStandardChurnCooldownOnFill({ order, fillDetails, fillPrice, now = Date.now(), book = null } = {}) {
    if (!isStandardPaperStrategy(order?.strategy)) return;
    if (String(order?.side || '').toLowerCase() !== 'sell') return;
    const remainingQty = Number(fillDetails?.positionQtyAfter || this.portfolio.position(order?.tokenId) || 0);
    const referenceBid = Number.isFinite(Number(book?.bestBid)) ? Number(book.bestBid) : Number(fillPrice || order?.price || 0);
    const remainingValueUsd = remainingQty > 0 && Number.isFinite(referenceBid) && referenceBid > 0
      ? remainingQty * referenceBid
      : 0;
    const roundTripCompleted = remainingQty <= 1e-9 || (remainingValueUsd > 0 && remainingValueUsd < this.config.minOrderUsd);
    if (!roundTripCompleted) return;
    const key = this.standardChurnKey(order);
    this.standardChurnCooldowns.set(key, {
      cooldownUntil: now + Math.max(0, Number(this.config.standardChurnCooldownMs || 0)),
      lastExitEdge: Number(order?.signal?.expectedEdge || 0),
      lastExitPrice: Number(fillPrice || order?.price || 0),
      tokenId: String(order?.tokenId || ''),
      marketId: String(order?.marketId || ''),
      ts: now,
    });
  }

  trySignal(rawSignal, asset, book) {
    let signal = rawSignal;
    const gabagoolSignal = isGabagoolStrategy(rawSignal);
    const gabagoolNow = Date.now();
    let quality = null;
    if (Number.isFinite(Number(book?.midpoint))) {
      this.portfolio.setMarkPrice(rawSignal?.tokenId || asset?.tokenId, Number(book.midpoint));
    }
    this.trackStandardMixedModeCandidate(rawSignal);
    const standardChurnDecision = this.standardChurnDecision(rawSignal, gabagoolNow);
    if (standardChurnDecision.blocked) {
      this.execution.setPlacementDecision(rawSignal, {
        placed: false,
        reason: 'standard_churn_guard',
        detail: standardChurnDecision.reason,
      });
      warn(
        `[STANDARD BLOCK] strategy=${rawSignal?.strategy || 'UNKNOWN'} side=${String(rawSignal?.side || '').toUpperCase() || 'UNKNOWN'} ` +
        `token=${shortId(rawSignal?.tokenId)} reason=${standardChurnDecision.reason}`
      );
      return false;
    }
    if (gabagoolSignal && (!Number.isFinite(Number(rawSignal?.sizeUsd)) || Number(rawSignal.sizeUsd) <= 0)) {
      const zeroSizeReason = 'zero_size_candidate';
      const positionQty = this.portfolio.position(rawSignal?.tokenId);
      const availableSellQty = this.portfolio.availablePositionQty(rawSignal?.tokenId);
      this.lastGabagoolBlockedReason = zeroSizeReason;
      this.lastGabagoolPlacementDecision = `PRESOPHIE_BLOCKED:${zeroSizeReason}`;
      this.recordGabagoolMetric('gabagool_zero_size_blocked', {
        tokenId: rawSignal?.tokenId,
        marketId: rawSignal?.marketId,
        marketSlug: rawSignal?.metadata?.marketSlug,
        outcome: rawSignal?.metadata?.outcome,
        side: rawSignal?.side,
        price: rawSignal?.price,
        sizeUsd: rawSignal?.sizeUsd,
        expectedEdge: rawSignal?.expectedEdge,
        confidence: rawSignal?.confidence,
        reason: zeroSizeReason,
        source: 'trySignal_invalid_or_zero_size',
        positionQty,
        availableSellQty,
      });
      this.recordGabagoolMetric('gabagool_placement_decision', {
        tokenId: rawSignal?.tokenId,
        marketId: rawSignal?.marketId,
        marketSlug: rawSignal?.metadata?.marketSlug,
        outcome: rawSignal?.metadata?.outcome,
        side: rawSignal?.side,
        price: rawSignal?.price,
        sizeUsd: rawSignal?.sizeUsd,
        expectedEdge: rawSignal?.expectedEdge,
        confidence: rawSignal?.confidence,
        reason: this.lastGabagoolPlacementDecision,
      });
      this.logGabagoolPresophieBlock(zeroSizeReason, {
        strategy: rawSignal?.strategy || 'GabagoolBtcOracleStrategy',
        marketSlug: rawSignal?.metadata?.marketSlug || asset?.market?.marketSlug || null,
        marketQuestion: rawSignal?.metadata?.marketQuestion || asset?.market?.question || null,
        tokenId: rawSignal?.tokenId || null,
        outcome: rawSignal?.metadata?.outcome || asset?.outcome || null,
        side: rawSignal?.side || 'sell',
        price: rawSignal?.price,
        sizeUsd: rawSignal?.sizeUsd,
        expectedEdge: rawSignal?.expectedEdge,
        confidence: rawSignal?.confidence,
        oracleEventKey: rawSignal?.metadata?.gabagool?.oracleEventKey || null,
      });
      return;
    }

    if (gabagoolSignal) {
      const lifecycleGuard = this.gabagoolLifecycleConflictGuard(rawSignal, gabagoolNow);
      if (lifecycleGuard.blocked) {
        this.lastGabagoolBlockedReason = lifecycleGuard.reason;
        this.lastGabagoolPlacementDecision = `IDLE:${lifecycleGuard.reason}`;
        this.recordGabagoolMetric('gabagool_reentry_blocked', {
          tokenId: rawSignal?.tokenId,
          marketId: rawSignal?.marketId,
          marketSlug: rawSignal?.metadata?.marketSlug,
          outcome: rawSignal?.metadata?.outcome,
          side: rawSignal?.side,
          price: rawSignal?.price,
          sizeUsd: rawSignal?.sizeUsd,
          expectedEdge: rawSignal?.expectedEdge,
          confidence: rawSignal?.confidence,
          reason: lifecycleGuard.reason,
        });
        this.recordGabagoolMetric('gabagool_placement_decision', {
          tokenId: rawSignal?.tokenId,
          marketId: rawSignal?.marketId,
          marketSlug: rawSignal?.metadata?.marketSlug,
          outcome: rawSignal?.metadata?.outcome,
          side: rawSignal?.side,
          price: rawSignal?.price,
          sizeUsd: rawSignal?.sizeUsd,
          expectedEdge: rawSignal?.expectedEdge,
          confidence: rawSignal?.confidence,
          reason: this.lastGabagoolPlacementDecision,
        });
        warn(
          `[GABAGOOL LIFECYCLE BLOCK] reason=${lifecycleGuard.reason} token=${shortId(rawSignal?.tokenId)} ` +
          `marketSlug=${rawSignal?.metadata?.marketSlug || 'unknown'} side=${String(rawSignal?.side || '').toUpperCase()} ` +
          `opposingSide=${lifecycleGuard.opposingSide || 'unknown'}`
        );
        return;
      }
    }

    if (gabagoolSignal && String(rawSignal?.side || '').toLowerCase() === 'buy') {
      const entryGuard = this.gabagoolEntryGuard(rawSignal, this.cache.markPrices(), gabagoolNow);
      if (entryGuard.blocked) {
        this.lastGabagoolBlockedReason = entryGuard.reason;
        this.lastGabagoolPlacementDecision = `IDLE:${entryGuard.reason}`;
        let metricType = 'gabagool_placement_blocked';
        if (entryGuard.reason === 'gabagool_loss_guard') {
          metricType = 'gabagool_entry_paused';
        } else if (entryGuard.reason === 'gabagool_same_market_direction_guard') {
          metricType = 'gabagool_same_market_direction_blocked';
        } else if (
          entryGuard.reason === 'gabagool_reentry_guard' ||
          entryGuard.reason === 'gabagool_reentry_guard_uncertain_state' ||
          entryGuard.reason === 'gabagool_market_lockout'
        ) {
          metricType = 'gabagool_reentry_blocked';
        } else if (entryGuard.reason === 'gabagool_churn_guard') {
          metricType = 'gabagool_churn_blocked';
        } else if (entryGuard.reason === 'gabagool_high_price_entry_guard') {
          metricType = 'gabagool_high_price_entry_blocked';
        }
        this.recordGabagoolMetric(metricType, {
          tokenId: rawSignal?.tokenId,
          marketId: rawSignal?.marketId,
          marketSlug: rawSignal?.metadata?.marketSlug,
          outcome: rawSignal?.metadata?.outcome,
          side: rawSignal?.side,
          price: rawSignal?.price,
          sizeUsd: rawSignal?.sizeUsd,
          expectedEdge: rawSignal?.expectedEdge,
          confidence: rawSignal?.confidence,
          reason: entryGuard.reason,
        });
        this.recordGabagoolMetric('gabagool_placement_decision', {
          tokenId: rawSignal?.tokenId,
          marketId: rawSignal?.marketId,
          marketSlug: rawSignal?.metadata?.marketSlug,
          outcome: rawSignal?.metadata?.outcome,
          side: rawSignal?.side,
          price: rawSignal?.price,
          sizeUsd: rawSignal?.sizeUsd,
          expectedEdge: rawSignal?.expectedEdge,
          confidence: rawSignal?.confidence,
          reason: this.lastGabagoolPlacementDecision,
        });
        this.maybeEmitGabagoolExposureCapRiskRelay(rawSignal, {
          sophieDecision: 'NOT_RUN',
        });
        warn(
          `[GABAGOOL IDLE] reason=${entryGuard.reason} token=${shortId(rawSignal?.tokenId)} ` +
          `${Object.entries(entryGuard)
            .filter(([key, value]) => !['blocked', 'reason'].includes(key) && value != null)
            .map(([key, value]) => `${key}=${cleanLogValue(value)}`)
            .join(' ')}`
        );
        return;
      }
    }

    if (gabagoolSignal && String(rawSignal?.side || '').toLowerCase() === 'sell') {
      const exitGuard = this.gabagoolExitGuard(rawSignal, gabagoolNow);
      if (exitGuard.blocked) {
        this.lastGabagoolBlockedReason = exitGuard.reason;
        this.lastGabagoolPlacementDecision = `IDLE:${exitGuard.reason}`;
        let blockedLossExitSuppressed = false;
        if (exitGuard.reason === 'blocked_loss_exit') {
          const suppression = this.consumeBlockedLossExitSuppression({
            tokenId: rawSignal?.tokenId,
            marketSlug: rawSignal?.metadata?.marketSlug,
            outcome: rawSignal?.metadata?.outcome,
          }, gabagoolNow);
          blockedLossExitSuppressed = suppression.suppressed === true;
          this.recordGabagoolMetric('gabagool_blocked_loss_exit', {
            tokenId: rawSignal?.tokenId,
            marketId: rawSignal?.marketId,
            marketSlug: rawSignal?.metadata?.marketSlug,
            outcome: rawSignal?.metadata?.outcome,
            side: rawSignal?.side,
            price: rawSignal?.price,
            sizeUsd: rawSignal?.sizeUsd,
            expectedEdge: rawSignal?.expectedEdge,
            confidence: rawSignal?.confidence,
            reason: exitGuard.reason,
            avgEntryPrice: exitGuard.avgEntryPrice,
          });
          if (suppression.suppressed) {
            this.recordGabagoolMetric('gabagool_blocked_loss_exit_repeat', {
              tokenId: rawSignal?.tokenId,
              marketId: rawSignal?.marketId,
              marketSlug: rawSignal?.metadata?.marketSlug,
              outcome: rawSignal?.metadata?.outcome,
              side: rawSignal?.side,
              price: rawSignal?.price,
              sizeUsd: rawSignal?.sizeUsd,
              expectedEdge: rawSignal?.expectedEdge,
              confidence: rawSignal?.confidence,
              reason: exitGuard.reason,
              avgEntryPrice: exitGuard.avgEntryPrice,
              source: 'suppressed_repeat',
            });
          } else {
            this.emitGabagoolUpdate('risk_blocked', {
              strategy: rawSignal?.strategy,
              marketSlug: rawSignal?.metadata?.marketSlug,
              marketQuestion: rawSignal?.metadata?.marketQuestion,
              tokenId: rawSignal?.tokenId,
              outcome: rawSignal?.metadata?.outcome,
              side: rawSignal?.side,
              price: rawSignal?.price,
              sizeUsd: rawSignal?.sizeUsd,
              expectedEdge: rawSignal?.expectedEdge,
              confidence: rawSignal?.confidence,
              blockReason: 'blocked_loss_exit',
              avgEntryPrice: exitGuard.avgEntryPrice,
              sophieDecision: 'NOT_RUN',
              riskDecision: 'BLOCK:blocked_loss_exit',
              oracleEventKey: rawSignal?.metadata?.gabagool?.oracleEventKey || null,
            });
          }
        }
        this.recordGabagoolMetric('gabagool_placement_decision', {
          tokenId: rawSignal?.tokenId,
          marketId: rawSignal?.marketId,
          marketSlug: rawSignal?.metadata?.marketSlug,
          outcome: rawSignal?.metadata?.outcome,
          side: rawSignal?.side,
          price: rawSignal?.price,
          sizeUsd: rawSignal?.sizeUsd,
          expectedEdge: rawSignal?.expectedEdge,
          confidence: rawSignal?.confidence,
          reason: this.lastGabagoolPlacementDecision,
        });
        if (!blockedLossExitSuppressed) {
          warn(
            `[GABAGOOL CAPITAL PROTECTION] reason=${exitGuard.reason} token=${shortId(rawSignal?.tokenId)} ` +
            `marketSlug=${exitGuard.marketSlug || 'unknown'} avgEntry=${fmtPrice(exitGuard.avgEntryPrice)} ` +
            `sellPrice=${fmtPrice(exitGuard.sellPrice)} minProfitPrice=${fmtPrice(exitGuard.minProfitPrice)}`
          );
        }
        return;
      }
    }

    if (rawSignal && !isProtectiveExitStrategy(rawSignal.strategy)) {
      this.portfolio.recordExecutionEvent('candidate_evaluation', rawSignal);
      info(
        `[CANDIDATE EVALUATION] stage=raw strategy=${rawSignal.strategy} side=${String(rawSignal.side || '').toUpperCase()} ` +
        `token=${shortId(rawSignal.tokenId)} price=${fmtPrice(rawSignal.price)} sizeUsd=${cleanLogValue(rawSignal.sizeUsd)} ` +
        `edge=${cleanLogValue(rawSignal.expectedEdge)} confidence=${cleanLogValue(rawSignal.confidence)}`
      );
      if (isStandardPaperStrategy(rawSignal.strategy)) {
        info(
          `[STANDARD CANDIDATE] stage=raw strategy=${rawSignal.strategy} side=${String(rawSignal.side || '').toUpperCase()} ` +
          `token=${shortId(rawSignal.tokenId)} price=${fmtPrice(rawSignal.price)} sizeUsd=${cleanLogValue(rawSignal.sizeUsd)} ` +
          `edge=${cleanLogValue(rawSignal.expectedEdge)} confidence=${cleanLogValue(rawSignal.confidence)}`
        );
      }
    }

    if (this.config.enableConsensus && !gabagoolSignal) {
      signal = this.consensus.evaluateSignal(
        rawSignal,
        asset,
        book,
        this.cache,
        this.portfolio,
        this.volGuard,
        this.whaleTracker
      );
      if (!signal) {
        return;
      }
    }

    if (this.shouldSuppressDustExit(signal)) {
      this.suppressDustExit(signal);
      return;
    }

    quality = this.evaluateSophieExecutionQuality(signal, book);
    signal.metadata = {
      ...(signal.metadata || {}),
      sophieExecution: quality,
    };
    if (gabagoolSignal) {
      this.recordGabagoolMetric('gabagool_sophie_evaluated', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
      });
    }

    const nudged = this.maybeApplyPaperMakerNudge(signal, book, quality);
    if (nudged) {
      signal = nudged;
      const nudgedQuality = this.evaluateSophieExecutionQuality(signal, book);
      signal.metadata = {
        ...(signal.metadata || {}),
        sophieExecution: nudgedQuality,
      };
      Object.assign(quality, nudgedQuality);
    }

    if (!this.applySophieExecutionGate(signal, asset, book, quality)) {
      if (gabagoolSignal) {
        this.lastGabagoolBlockedReason = quality.qualityDecision;
        this.lastGabagoolSophieBlockReason = quality.qualityDecision;
        this.lastGabagoolPlacementDecision = `SOPHIE_BLOCKED:${quality.qualityDecision || 'unknown'}`;
        this.recordGabagoolMetric('gabagool_sophie_blocked', {
          tokenId: signal.tokenId,
          marketId: signal.marketId,
          marketSlug: signal.metadata?.marketSlug,
          outcome: signal.metadata?.outcome,
          side: signal.side,
          price: signal.price,
          sizeUsd: signal.sizeUsd,
          expectedEdge: signal.expectedEdge,
          confidence: signal.confidence,
          reason: quality.qualityDecision,
          sophieExecutionQuality: quality?.sophieExecutionQuality,
          distanceFromTouch: quality?.distanceFromTouch,
          predictedFillProbability: quality?.predictedFillProbability,
        });
        this.recordGabagoolMetric('gabagool_placement_decision', {
          tokenId: signal.tokenId,
          marketId: signal.marketId,
          marketSlug: signal.metadata?.marketSlug,
          outcome: signal.metadata?.outcome,
          side: signal.side,
          price: signal.price,
          sizeUsd: signal.sizeUsd,
          expectedEdge: signal.expectedEdge,
          confidence: signal.confidence,
          reason: this.lastGabagoolPlacementDecision,
        });
        this.emitGabagoolUpdate('sophie_blocked', {
          strategy: signal.strategy,
          marketSlug: signal.metadata?.marketSlug,
          marketQuestion: signal.metadata?.marketQuestion,
          tokenId: signal.tokenId,
          outcome: signal.metadata?.outcome,
          side: signal.side,
          price: signal.price,
          sizeUsd: signal.sizeUsd,
          expectedEdge: signal.expectedEdge,
          confidence: signal.confidence,
          sophieDecision: quality.qualityDecision,
          riskDecision: 'NOT_RUN',
          blockReason: quality.qualityDecision,
          oracleEventKey: signal.metadata?.gabagool?.oracleEventKey || null,
        });
      }
      return;
    }

    if (gabagoolSignal) {
      this.recordGabagoolMetric('gabagool_sophie_admitted', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        reason: quality?.qualityDecision || 'ADMIT',
        sophieExecutionQuality: quality?.sophieExecutionQuality,
        distanceFromTouch: quality?.distanceFromTouch,
        predictedFillProbability: quality?.predictedFillProbability,
      });
      this.recordGabagoolMetric('gabagool_risk_evaluated', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
      });
    }
    signal = this.risk.evaluate(signal);
    if (!signal) {
      const riskBlockReason = this.risk.lastBlockReason || 'invalid_signal';
      const probationActive = rawSignal?.metadata?.paperProbation?.active === true;
      const probationAdmission = rawSignal?.metadata?.paperProbation?.admissionReason || null;
      const sophieDecision = quality?.qualityDecision || 'ADMIT';
      if (rawSignal) {
        this.portfolio.recordExecutionEvent('risk_block', {
          ...rawSignal,
          marketSlug: rawSignal?.metadata?.marketSlug,
          outcome: rawSignal?.metadata?.outcome,
          reason: riskBlockReason,
          drawdownGateActive: riskBlockReason === 'drawdown_limit',
          paperProbationActive: probationActive,
          probationAdmission,
          paperProbationTrigger: rawSignal?.metadata?.paperProbation?.trigger || null,
          sophieDecision,
          finalBlockerAfterProbation: probationActive ? riskBlockReason : null,
          ...this.risk.lastBlockDetails,
        });
      }
      if (
        rawSignal &&
        this.config.enableLiveTrading !== true &&
        isStandardPaperStrategy(rawSignal.strategy) &&
        riskBlockReason === 'drawdown_limit' &&
        ['ADMIT', 'PAPER_PROBATION_ADMIT', 'CALIBRATED_ADMIT', 'OPTIMIZED_MAKER_ADMIT'].includes(sophieDecision)
      ) {
        warn(
          `[PAPER BURN-IN FINAL BLOCK] strategy=${rawSignal.strategy} side=${String(rawSignal.side || '').toUpperCase()} ` +
          `token=${shortId(rawSignal.tokenId)} sophieDecision=${sophieDecision} ` +
          `paperProbationActive=${probationActive ? 'true' : 'false'} ` +
          `probationAdmission=${probationAdmission || 'none'} finalBlocker=drawdown_limit ` +
          `drawdownPct=${cleanLogValue(this.risk.lastBlockDetails?.drawdownPct)} ` +
          `maxDrawdownPct=${cleanLogValue(this.risk.lastBlockDetails?.maxDrawdownPct)} ` +
          `recommendedAction=fresh_state_required stateFile=${path.basename(String(this.config.stateFile || ''))}`
        );
      }
      if (gabagoolSignal) {
        const noPlacementReason = this.gabagoolNoPlacementReasonFromRisk(riskBlockReason, rawSignal);
        this.lastGabagoolBlockedReason = riskBlockReason;
        this.lastGabagoolRiskBlockReason = riskBlockReason;
        this.lastGabagoolPlacementDecision = `RISK_BLOCKED:${noPlacementReason}`;
        this.recordGabagoolMetric('gabagool_risk_blocked', {
          tokenId: rawSignal.tokenId,
          marketId: rawSignal.marketId,
          marketSlug: rawSignal.metadata?.marketSlug,
          outcome: rawSignal.metadata?.outcome,
          side: rawSignal.side,
          price: rawSignal.price,
          sizeUsd: rawSignal.sizeUsd,
          expectedEdge: rawSignal.expectedEdge,
          confidence: rawSignal.confidence,
          reason: riskBlockReason,
          sophieExecutionQuality: quality?.sophieExecutionQuality,
          distanceFromTouch: quality?.distanceFromTouch,
          predictedFillProbability: quality?.predictedFillProbability,
          riskTotalExposureUsd: this.risk.lastBlockDetails?.riskTotalExposureUsd,
          portfolioPositionExposureUsd: this.risk.lastBlockDetails?.portfolioPositionExposureUsd,
          portfolioOpenOrderExposureUsd: this.risk.lastBlockDetails?.portfolioOpenOrderExposureUsd,
          btcOraclePositionExposureUsd: this.risk.lastBlockDetails?.btcOraclePositionExposureUsd,
          btcOracleOpenOrderExposureUsd: this.risk.lastBlockDetails?.btcOracleOpenOrderExposureUsd,
          activeTradableExposureUsd: this.risk.lastBlockDetails?.activeTradableExposureUsd,
          staleNoBidExposureUsd: this.risk.lastBlockDetails?.staleNoBidExposureUsd,
          confirmedNoOrderbook404ExposureUsd: this.risk.lastBlockDetails?.confirmedNoOrderbook404ExposureUsd,
          expiredBtc5mExposureUsd: this.risk.lastBlockDetails?.expiredBtc5mExposureUsd,
          resolutionPendingExposureUsd: this.risk.lastBlockDetails?.resolutionPendingExposureUsd,
          dustExposureUsd: this.risk.lastBlockDetails?.dustExposureUsd,
          capBlockingExposureUsd: this.risk.lastBlockDetails?.capBlockingExposureUsd,
          excludedDeadExposureUsd: this.risk.lastBlockDetails?.excludedDeadExposureUsd,
          btcOracleActiveTradableExposureUsd: this.risk.lastBlockDetails?.btcOracleActiveTradableExposureUsd,
          btcOracleStaleNoBidExposureUsd: this.risk.lastBlockDetails?.btcOracleStaleNoBidExposureUsd,
          btcOracleConfirmedNoOrderbook404ExposureUsd: this.risk.lastBlockDetails?.btcOracleConfirmedNoOrderbook404ExposureUsd,
          btcOracleExpiredBtc5mExposureUsd: this.risk.lastBlockDetails?.btcOracleExpiredBtc5mExposureUsd,
          btcOracleResolutionPendingExposureUsd: this.risk.lastBlockDetails?.btcOracleResolutionPendingExposureUsd,
          btcOracleDustExposureUsd: this.risk.lastBlockDetails?.btcOracleDustExposureUsd,
          nonBtcPositionExposureUsd: this.risk.lastBlockDetails?.nonBtcPositionExposureUsd,
          nonBtcOpenOrderExposureUsd: this.risk.lastBlockDetails?.nonBtcOpenOrderExposureUsd,
          strategyBucketExposureRawUsd: this.risk.lastBlockDetails?.strategyBucketExposureRawUsd,
          strategyBucketExposureExclusionUsd: this.risk.lastBlockDetails?.strategyBucketExposureExclusionUsd,
          strategyBucketExposureUsd: this.risk.lastBlockDetails?.strategyBucketExposureUsd,
          strategyBucketWouldExposureUsd: this.risk.lastBlockDetails?.strategyBucketWouldExposureUsd,
          maxTotalExposureUsd: this.risk.lastBlockDetails?.maxTotalExposureUsd,
          exposureAvailableUsd: this.risk.lastBlockDetails?.exposureAvailableUsd,
          candidateSizeUsd: this.risk.lastBlockDetails?.candidateSizeUsd,
          wouldTotalExposureUsd: this.risk.lastBlockDetails?.wouldTotalExposureUsd,
        });
        this.recordGabagoolMetric('gabagool_placement_decision', {
          tokenId: rawSignal.tokenId,
          marketId: rawSignal.marketId,
          marketSlug: rawSignal.metadata?.marketSlug,
          outcome: rawSignal.metadata?.outcome,
          side: rawSignal.side,
          price: rawSignal.price,
          sizeUsd: rawSignal.sizeUsd,
          expectedEdge: rawSignal.expectedEdge,
          confidence: rawSignal.confidence,
          reason: this.lastGabagoolPlacementDecision,
        });
        warn(
          `[GABAGOOL NO PLACE] stage=risk reason=${noPlacementReason} rawRisk=${riskBlockReason} ` +
          `token=${shortId(rawSignal.tokenId)} price=${fmtPrice(rawSignal.price)} sizeUsd=${cleanLogValue(rawSignal.sizeUsd)} ` +
          `expectedEdge=${cleanLogValue(rawSignal.expectedEdge)} confidence=${cleanLogValue(rawSignal.confidence)} ` +
          `${formatRiskBlockDetails(this.risk.lastBlockDetails)}`
        );
        this.emitGabagoolUpdate('risk_blocked', {
          strategy: rawSignal.strategy,
          marketSlug: rawSignal.metadata?.marketSlug,
          marketQuestion: rawSignal.metadata?.marketQuestion,
          tokenId: rawSignal.tokenId,
          outcome: rawSignal.metadata?.outcome,
          side: rawSignal.side,
          price: rawSignal.price,
          sizeUsd: rawSignal.sizeUsd,
          expectedEdge: rawSignal.expectedEdge,
          confidence: rawSignal.confidence,
          sophieDecision: quality?.qualityDecision || 'ADMIT',
          riskDecision: `BLOCK:${this.risk.lastBlockReason || 'invalid_signal'}`,
          blockReason: this.risk.lastBlockReason || 'invalid_signal',
          oracleEventKey: rawSignal.metadata?.gabagool?.oracleEventKey || null,
          ...this.risk.lastBlockDetails,
        });
      }
      if (this.config.consensusLogRejected && rawSignal) {
        const details = formatRiskBlockDetails(this.risk.lastBlockDetails);
        warn(
          `[SIGNAL BLOCK] ${rawSignal.strategy} ${String(rawSignal.side || '').toUpperCase()} ${shortId(rawSignal.tokenId)} ` +
          `block=${this.risk.lastBlockReason || 'invalid_signal'} ${details}`
        );
      }
      if (rawSignal && isStandardPaperStrategy(rawSignal.strategy)) {
        warn(
          `[STANDARD BLOCK] stage=risk strategy=${rawSignal.strategy} side=${String(rawSignal.side || '').toUpperCase()} ` +
          `token=${shortId(rawSignal.tokenId)} reason=${this.risk.lastBlockReason || 'invalid_signal'} ` +
          `${formatRiskBlockDetails(this.risk.lastBlockDetails)}`
        );
      }
      return;
    }

    if (gabagoolSignal) {
      this.recordGabagoolMetric('gabagool_risk_admitted', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        reason: 'ADMIT',
        sophieExecutionQuality: quality?.sophieExecutionQuality,
        distanceFromTouch: quality?.distanceFromTouch,
        predictedFillProbability: quality?.predictedFillProbability,
      });
      this.recordGabagoolMetric('gabagool_placement_attempted', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        reason: 'attempt',
      });
    }
    const placed = this.execution.place(signal, book);
    const placementDecision = this.execution.lastPlacementDecision || null;
    if (!placed && signal) {
      this.portfolio.recordExecutionEvent('placement_block', {
        ...signal,
        marketSlug: signal?.metadata?.marketSlug,
        outcome: signal?.metadata?.outcome,
        reason: placementDecision?.reason || 'unknown_placement_block',
        source: 'execution_place',
      });
    }
    if (gabagoolSignal && !placed) {
      const placementBlockReason = this.gabagoolNoPlacementReasonFromExecution(placementDecision, signal);
      this.lastGabagoolPlacementBlockReason = placementBlockReason;
      this.lastGabagoolPlacementDecision = `PLACEMENT_BLOCKED:${placementBlockReason}`;
      this.recordGabagoolMetric('gabagool_placement_blocked', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        reason: placementBlockReason,
      });
      this.recordGabagoolMetric('gabagool_placement_decision', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: signal.sizeUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        reason: this.lastGabagoolPlacementDecision,
      });
      warn(
        `[GABAGOOL NO PLACE] stage=placement reason=${placementBlockReason} rawPlacement=${placementDecision?.reason || 'unknown'} ` +
        `token=${shortId(signal.tokenId)} price=${fmtPrice(signal.price)} sizeUsd=${cleanLogValue(signal.sizeUsd)} ` +
        `expectedEdge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)}`
      );
    }
    if (!gabagoolSignal && !placed && isStandardPaperStrategy(signal.strategy)) {
      warn(
        `[STANDARD BLOCK] stage=placement strategy=${signal.strategy} side=${String(signal.side || '').toUpperCase()} ` +
        `token=${shortId(signal.tokenId)} reason=${placementDecision?.reason || 'unknown'} ` +
        `price=${fmtPrice(signal.price)} sizeUsd=${cleanLogValue(signal.sizeUsd)} ` +
        `edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)}`
      );
    }
    if (placed) {
      if (gabagoolSignal) {
        this.lastGabagoolPlacementDecision = 'ORDER_PLACED';
        this.recordGabagoolMetric('gabagool_placement_decision', {
          tokenId: signal.tokenId,
          marketId: signal.marketId,
          marketSlug: signal.metadata?.marketSlug,
          outcome: signal.metadata?.outcome,
          side: signal.side,
          price: signal.price,
          sizeUsd: signal.sizeUsd,
          expectedEdge: signal.expectedEdge,
          confidence: signal.confidence,
          reason: this.lastGabagoolPlacementDecision,
        });
        this.recordGabagoolMetric('gabagool_order_placed', {
          tokenId: signal.tokenId,
          marketId: signal.marketId,
          marketSlug: signal.metadata?.marketSlug,
          outcome: signal.metadata?.outcome,
          side: signal.side,
          price: signal.price,
          sizeUsd: signal.sizeUsd,
          expectedEdge: signal.expectedEdge,
          confidence: signal.confidence,
          reason: 'ADMIT',
          sophieExecutionQuality: quality?.sophieExecutionQuality,
          distanceFromTouch: quality?.distanceFromTouch,
          predictedFillProbability: quality?.predictedFillProbability,
        });
        if (signal.metadata?.gabagool?.exitMode === 'loss_guard_reduce_only') {
          this.recordGabagoolMetric('gabagool_loss_guard_exit_placed', {
            tokenId: signal.tokenId,
            marketId: signal.marketId,
            marketSlug: signal.metadata?.marketSlug,
            outcome: signal.metadata?.outcome,
            side: signal.side,
            price: signal.price,
            sizeUsd: signal.sizeUsd,
            expectedEdge: signal.expectedEdge,
            confidence: signal.confidence,
            reason: 'loss_guard_reduce_only',
            exitMode: 'loss_guard_reduce_only',
          });
        }
        if (signal.metadata?.gabagool?.exitMode === 'exposure_cap_reduce_only') {
          this.recordGabagoolMetric('gabagool_reduce_only_exit_placed', {
            tokenId: signal.tokenId,
            marketId: signal.marketId,
            marketSlug: signal.metadata?.marketSlug,
            outcome: signal.metadata?.outcome,
            side: signal.side,
            price: signal.price,
            sizeUsd: signal.sizeUsd,
            expectedEdge: signal.expectedEdge,
            confidence: signal.confidence,
            reason: signal.metadata?.gabagool?.exitTrigger || 'exposure_cap_reduce_only',
            exitMode: 'exposure_cap_reduce_only',
          });
        }
        if (String(signal.side || '').toLowerCase() === 'sell') {
          this.onGabagoolSellPlaced(signal, gabagoolNow);
        } else {
          this.emitGabagoolUpdate('order_placed', {
            strategy: signal.strategy,
            marketSlug: signal.metadata?.marketSlug,
            marketQuestion: signal.metadata?.marketQuestion,
            tokenId: signal.tokenId,
            outcome: signal.metadata?.outcome,
            side: signal.side,
            price: signal.price,
            sizeUsd: signal.sizeUsd,
            expectedEdge: signal.expectedEdge,
            confidence: signal.confidence,
            sophieDecision: quality?.qualityDecision || 'ADMIT',
            riskDecision: 'ADMIT',
            oracleEventKey: signal.metadata?.gabagool?.oracleEventKey || null,
          });
        }
      }
      signal._riskApproved = true;
      this.maybeWriteLiveCandidate(signal, asset, book);
    }
  }

  admitSignalThroughRisk(signal, asset, book) {
    const rawSignal = signal;
    const risked = this.risk.evaluate(signal);
    if (!risked) {
      if (rawSignal) {
        this.portfolio.recordExecutionEvent('risk_block', {
          ...rawSignal,
          marketSlug: rawSignal?.metadata?.marketSlug,
          outcome: rawSignal?.metadata?.outcome,
          reason: this.risk.lastBlockReason || 'invalid_signal',
          drawdownGateActive: (this.risk.lastBlockReason || 'invalid_signal') === 'drawdown_limit',
          paperProbationActive: rawSignal?.metadata?.paperProbation?.active === true,
          probationAdmission: rawSignal?.metadata?.paperProbation?.admissionReason || null,
          paperProbationTrigger: rawSignal?.metadata?.paperProbation?.trigger || null,
          sophieDecision: this.lastSophieQualityDecision?.qualityDecision || 'ADMIT',
          finalBlockerAfterProbation: rawSignal?.metadata?.paperProbation?.active === true
            ? (this.risk.lastBlockReason || 'invalid_signal')
            : null,
          ...this.risk.lastBlockDetails,
        });
      }
      if (this.config.consensusLogRejected && rawSignal) {
        const details = formatRiskBlockDetails(this.risk.lastBlockDetails);
        warn(
          `[SIGNAL BLOCK] ${rawSignal.strategy} ${String(rawSignal.side || '').toUpperCase()} ${shortId(rawSignal.tokenId)} ` +
          `block=${this.risk.lastBlockReason || 'invalid_signal'} ${details}`
        );
      }
      if (rawSignal && isStandardPaperStrategy(rawSignal.strategy)) {
        warn(
          `[STANDARD BLOCK] stage=risk strategy=${rawSignal.strategy} side=${String(rawSignal.side || '').toUpperCase()} ` +
          `token=${shortId(rawSignal.tokenId)} reason=${this.risk.lastBlockReason || 'invalid_signal'} ` +
          `${formatRiskBlockDetails(this.risk.lastBlockDetails)}`
        );
      }
      return false;
    }

    const placed = this.execution.place(risked, book);
    if (!placed && rawSignal && isStandardPaperStrategy(rawSignal.strategy)) {
      warn(
        `[STANDARD BLOCK] stage=placement strategy=${rawSignal.strategy} side=${String(rawSignal.side || '').toUpperCase()} ` +
        `token=${shortId(rawSignal.tokenId)} reason=${this.execution.lastPlacementDecision?.reason || 'unknown'} ` +
        `price=${fmtPrice(rawSignal.price)} sizeUsd=${cleanLogValue(rawSignal.sizeUsd)} ` +
        `edge=${cleanLogValue(rawSignal.expectedEdge)} confidence=${cleanLogValue(rawSignal.confidence)}`
      );
    }
    if (placed) {
      risked._riskApproved = true;
      this.maybeWriteLiveCandidate(risked, asset, book);
    }
    return Boolean(placed);
  }

  sophieExecutionKey(signal) {
    return `${signal.tokenId}:${String(signal.side || '').toLowerCase()}:${signal.strategy}`;
  }

  spreadHunterOpenOrderCount() {
    return [...this.portfolio.openOrders.values()]
      .filter((order) => order.strategy === 'SpreadHunter')
      .length;
  }

  repeatCandidateKey(signal) {
    return [
      signal.tokenId,
      String(signal.side || '').toLowerCase(),
      signal.strategy,
      Number(signal.price).toFixed(4),
      Number(signal.expectedEdge || 0).toFixed(4),
      Number(signal.confidence || 0).toFixed(4),
    ].join(':');
  }

  quoteDistanceFromTouch(signal, book) {
    if (!signal || !book) return 0.5;
    if (signal.side === 'buy' && Number.isFinite(book.bestBid)) {
      return Math.max(0, Number(book.bestBid) - Number(signal.price));
    }
    if (signal.side === 'sell' && Number.isFinite(book.bestAsk)) {
      return Math.max(0, Number(signal.price) - Number(book.bestAsk));
    }
    return 0.5;
  }

  evaluateSophieExecutionQuality(signal, book, existingOrder = null) {
    const stats = this.portfolio.executionStatsFor(signal, 60 * 60_000);
    const consensus = signal.metadata?.consensus || {};
    const signalScore = clamp(firstFinite(consensus.score, signal.confidence, 0.5), 0, 1);
    const edgeScore = clamp((Number(signal.expectedEdge) || 0) / 0.04, 0, 1);
    const confidenceScore = clamp(Number(signal.confidence) || 0, 0, 1);
    const spread = Number(book?.spread);
    const spreadQuality = Number.isFinite(spread)
      ? clamp(1 - (spread / Math.max(0.01, this.config.hunterMaxSpread || 0.22)), 0, 1)
      : 0.5;
    const topDepth = book ? Math.min(topDepthUsd(book.bids || [], 1), topDepthUsd(book.asks || [], 1)) : NaN;
    const depthQuality = Number.isFinite(topDepth)
      ? clamp(topDepth / Math.max(1, this.config.hunterMinTopDepthUsd * 4), 0, 1)
      : 0.5;
    const distanceFromTouch = this.quoteDistanceFromTouch(signal, book);
    const quoteDistanceQuality = clamp(1 - (distanceFromTouch / Math.max(0.01, spread || this.config.hunterMaxSpread || 0.22)), 0, 1);
    const ghostTotal = this.portfolio.ghostStats?.total || 0;
    const ghostRate = ghostTotal > 0 ? this.portfolio.ghostStats.favorable / ghostTotal : 0.5;
    const historicalFillRate = stats.attemptsLastHour > 0 ? stats.fillRateLastHour : 0.005;
    const strategyFillRate = stats.strategyFillRateLastHour || 0.005;
    const duplicatePressure = clamp(stats.duplicateSkipsLastHour / Math.max(1, this.config.sophieMaxDuplicateSkipsPerTokenWindow), 0, 1);
    const noFillPressure = clamp(stats.noFillStreak / Math.max(1, this.config.sophieMaxAttemptsPerTokenWindow), 0, 1);
    const churnPressure = clamp(stats.replacementsLastHour / Math.max(1, this.config.sophieMaxAttemptsPerTokenWindow), 0, 1);
    const slotPressure = clamp(this.portfolio.openOrders.size / Math.max(1, this.config.maxOpenOrders), 0, 1);
    const agePressure = existingOrder
      ? clamp((Date.now() - existingOrder.createdAt) / Math.max(1, this.config.orderTtlMs), 0, 1)
      : clamp(stats.avgOpenOrderAgeSec / Math.max(1, this.config.orderTtlMs / 1000), 0, 1);
    const fillProbDefaultsUsed = stats.attemptsLastHour === 0 && stats.strategyFillRateLastHour === 0;
    const rawPredictedFillProbability = clamp(
      (historicalFillRate * 0.20) +
      (strategyFillRate * 0.15) +
      (quoteDistanceQuality * 0.20) +
      (spreadQuality * 0.10) +
      (depthQuality * 0.15) +
      (ghostRate * 0.10) +
      ((1 - duplicatePressure) * 0.05) +
      ((1 - noFillPressure) * 0.05),
      0,
      1
    );
    const fillCalibration = this.calibratePredictedFillProbability(signal, rawPredictedFillProbability, distanceFromTouch, stats);
    const predictedFillProbability = fillCalibration.adjustedFillProbability;
    const executionQuality = clamp(
      (signalScore * 0.20) +
      (edgeScore * 0.15) +
      (confidenceScore * 0.10) +
      (predictedFillProbability * 0.30) +
      (depthQuality * 0.08) +
      (spreadQuality * 0.07) +
      (ghostRate * 0.05) -
      (duplicatePressure * 0.08) -
      (noFillPressure * 0.10) -
      (churnPressure * 0.05) -
      (slotPressure * 0.04) -
      (agePressure * 0.03) +
      0.03,
      0,
      1
    );
    const quoteMode = distanceFromTouch <= 0.001 ? 'AT_TOUCH' : 'PASSIVE';

    return {
      sophieSignalScore: Number(signalScore.toFixed(4)),
      sophieExecutionQuality: Number(executionQuality.toFixed(4)),
      rawPredictedFillProbability: Number(rawPredictedFillProbability.toFixed(4)),
      predictedFillProbability: Number(predictedFillProbability.toFixed(4)),
      fillProbabilityCalibrationReason: fillCalibration.reason,
      fillProbabilityOverestimated: Boolean(fillCalibration.overestimated),
      slotPressure: Number(slotPressure.toFixed(4)),
      duplicatePressure: Number(duplicatePressure.toFixed(4)),
      noFillPressure: Number(noFillPressure.toFixed(4)),
      churnPressure: Number(churnPressure.toFixed(4)),
      quoteMode,
      distanceFromTouch: Number(distanceFromTouch.toFixed(6)),
      spreadQuality: Number(spreadQuality.toFixed(4)),
      depthQuality: Number(depthQuality.toFixed(4)),
      ghostQuality: Number(ghostRate.toFixed(4)),
      fillProbDefaultsUsed,
      stats,
      qualityDecision: 'PENDING',
    };
  }

  calibratePredictedFillProbability(signal, rawFillProb, distanceFromTouch, stats) {
    let adjusted = clamp(rawFillProb, 0, 1);
    let reason = 'none';
    let overestimated = false;

    if (this.config.sophieFillDistancePenaltyEnabled) {
      const ideal = Math.max(0, this.config.sophieFillDistanceIdeal);
      const maxReasonable = Math.max(ideal, this.config.sophieFillDistanceMaxReasonable);
      const hardCap = Math.max(maxReasonable, this.config.sophieFillDistanceHardCap);

      const beyondIdeal = distanceFromTouch > ideal + 1e-9;
      if (beyondIdeal && distanceFromTouch <= maxReasonable) {
        const progress = clamp((distanceFromTouch - ideal) / Math.max(0.001, maxReasonable - ideal), 0, 1);
        const multiplier = 1 - (progress * 0.45);
        adjusted *= multiplier;
        reason = 'distance_penalty';
      }

      if (distanceFromTouch > maxReasonable) {
        adjusted = Math.min(adjusted, this.config.sophieFillProbCapWhenFar);
        reason = 'far_from_touch';
        overestimated = true;
      }

      if (distanceFromTouch >= hardCap) {
        adjusted = Math.min(adjusted, this.config.sophieFillProbCapWhenVeryFar);
        reason = 'very_far_from_touch';
        overestimated = true;
      }
    }

    if (this.config.sophieNoFillLearningEnabled && stats.noFillStreak >= this.config.sophieNoFillStreakLimit) {
      adjusted *= clamp(this.config.sophieNoFillFillProbMultiplier, 0, 1);
      reason = reason === 'none' ? 'no_fill_streak' : `${reason}+no_fill_streak`;
      overestimated = true;
      this.logNoFillLearning(signal, stats, rawFillProb, adjusted);
    }

    if (adjusted < rawFillProb) {
      this.logFillProbabilityCalibration(signal, rawFillProb, adjusted, distanceFromTouch, reason);
    }

    return {
      adjustedFillProbability: clamp(adjusted, 0, 1),
      reason,
      overestimated,
    };
  }

  logFillProbabilityCalibration(signal, rawFillProb, adjustedFillProb, distanceFromTouch, reason) {
    const key = `${this.sophieExecutionKey(signal)}:${reason}`;
    const now = Date.now();
    const last = this.sophieFillProbLastLogged.get(key) || 0;
    if (now - last < this.config.sophieLowQualityBlockCooldownMs) return;
    this.sophieFillProbLastLogged.set(key, now);
    info(
      `[SOPHIE FILL PROB CALIBRATED] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `rawFillProb=${rawFillProb.toFixed(3)} adjustedFillProb=${adjustedFillProb.toFixed(3)} ` +
      `distanceFromTouch=${Number(distanceFromTouch).toFixed(3)} reason=${reason}`
    );
  }

  logNoFillLearning(signal, stats, rawFillProb, adjustedFillProb) {
    const key = this.sophieExecutionKey(signal);
    const now = Date.now();
    const last = this.sophieNoFillLearnLastLogged.get(key) || 0;
    if (now - last < this.config.sophieLowQualityBlockCooldownMs) return;
    this.sophieNoFillLearnLastLogged.set(key, now);
    warn(
      `[SOPHIE NO-FILL LEARN] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `noFillStreak=${stats.noFillStreak} rawFillProb=${rawFillProb.toFixed(3)} ` +
      `adjustedFillProb=${adjustedFillProb.toFixed(3)} cooldownSec=${Math.round(this.config.sophieNoFillTokenCooldownMs / 1000)}`
    );
  }

  maybeApplyPaperMakerNudge(signal, book, quality) {
    if (!signal || signal.strategy !== 'SpreadHunter') return null;
    if (isProtectiveExitStrategy(signal.strategy) || !isBookComplete(book)) return null;
    if (!Number.isFinite(signal.price) || !Number.isFinite(signal.expectedEdge)) return null;
    if (quality.distanceFromTouch <= this.config.paperMakerNudgeMaxDistanceFromTouch) return null;

    const stats = this.portfolio.executionStatsFor(signal, 60 * 60_000);
    const now = Date.now();
    const hasOldNoFillOrder = stats.oldestOpenOrderAgeSec * 1000 >= this.config.paperMakerNudgeOnlyAfterNoFillMs;
    const hasNoFillHistory = stats.noFillStreak > 0 || (stats.lastOrderTs && now - stats.lastOrderTs >= this.config.paperMakerNudgeOnlyAfterNoFillMs);
    if (!hasOldNoFillOrder && !hasNoFillHistory) return null;

    const tick = Number(book.tickSize || signal.metadata?.tickSize || 0.01);
    if (!Number.isFinite(tick) || tick <= 0) return null;
    const move = tick * Math.max(1, this.config.paperMakerNudgeMaxTicks || 1);
    let suggestedPrice = Number(signal.price);
    if (signal.side === 'buy') {
      suggestedPrice = Math.min(Number(signal.price) + move, Number(book.bestAsk) - tick);
    } else if (signal.side === 'sell') {
      suggestedPrice = Math.max(Number(signal.price) - move, Number(book.bestBid) + tick);
    } else {
      return null;
    }

    suggestedPrice = roundToTick(clamp(suggestedPrice, 0.01, 0.99), tick);
    if (!Number.isFinite(suggestedPrice) || suggestedPrice === signal.price) return null;

    const oldPrice = Number(signal.price);
    const priceDelta = Math.abs(suggestedPrice - oldPrice);
    const edgeAfterNudge = Number(signal.expectedEdge) - priceDelta;
    if (edgeAfterNudge < this.config.paperMakerNudgeMinEdgeAfterNudge) return null;

    info(
      `[PAPER MAKER NUDGE SUGGESTED] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `oldPrice=${fmtPrice(oldPrice)} suggestedPrice=${fmtPrice(suggestedPrice)} ` +
      `edgeAfterNudge=${edgeAfterNudge.toFixed(3)} reason=no_fills_far_from_touch enabled=${this.config.paperMakerNudgeEnabled}`
    );

    if (!this.config.paperMakerNudgeEnabled) return null;

    signal.price = suggestedPrice;
    signal.expectedEdge = edgeAfterNudge;
    signal.metadata = {
      ...(signal.metadata || {}),
      paperMakerNudge: {
        applied: true,
        oldPrice,
        suggestedPrice,
        edgeAfterNudge,
      },
    };
    return signal;
  }

  buildStarvedPaperMakerQuote(signal, book, quality, reason = 'low_quality') {
    if (!this.config.paperMakerOptimizerEnabled) return null;
    if (!signal || signal.strategy !== 'SpreadHunter') return null;
    if (isProtectiveExitStrategy(signal.strategy) || !isBookComplete(book)) return null;
    if (this.portfolio.openOrders.size > 0 || this.spreadHunterOpenOrderCount() > 0) {
      this.logStarvedOptimizerBlock(signal, quality, 'active_orders_present');
      return null;
    }
    if (!['buy', 'sell'].includes(String(signal.side || '').toLowerCase())) return null;
    if (!Number.isFinite(signal.price) || !Number.isFinite(signal.expectedEdge)) return null;

    const bootstrapFailures = this.bootstrapAdmissionFailures(signal, quality);
    const allowedFailures = new Set(['edge', 'fill_probability', 'distance_from_touch']);
    const disallowedFailures = bootstrapFailures.filter((failure) => !allowedFailures.has(failure));
    if (disallowedFailures.length > 0) {
      this.logStarvedOptimizerBlock(signal, quality, 'not_recovery_failure_set', null, null, null, null, { disallowedFailures: disallowedFailures.join(',') });
      return null;
    }

    const tick = Number(book.tickSize || signal.metadata?.tickSize || 0.01);
    if (!Number.isFinite(tick) || tick <= 0) return null;

    const oldPrice = Number(signal.price);
    const baseDistance = Math.max(0, Number(quality.distanceFromTouch || this.quoteDistanceFromTouch(signal, book)));
    const stats = this.portfolio.executionStatsFor(signal, 60 * 60_000);
    const noFillStreak = Math.max(0, Number(stats.noFillStreak || 0));
    const cappedNoFillStreak = Math.min(Math.max(0, this.config.paperMakerMaxNoFillDecayStreak || 0), noFillStreak);
    const decayPerNoFill = clamp(Number(this.config.paperMakerDistanceDecayPerNoFill), 0, 0.95);
    const decayMultiplier = Math.pow(1 - decayPerNoFill, cappedNoFillStreak);
    const targetDistance = Math.max(
      Math.max(0, Number(this.config.paperMakerMinOptimizedDistance || 0)),
      baseDistance * decayMultiplier
    );
    const edgeMoveBudget = Math.max(
      0,
      Number(signal.expectedEdge) - Math.max(this.config.paperMakerRecoveryMinEdgeAfterMove, this.config.minSignalEdge || 0)
    );
    const maxTicks = Math.max(1, this.config.paperMakerOptimizerMaxTicks || 1);
    const oneTickPrice = signal.side === 'buy'
      ? oldPrice + tick * maxTicks
      : oldPrice - tick * maxTicks;
    let desiredPrice;
    let edgeLimitedPrice;
    let makerLimitedPrice;
    let optimizedPrice = oldPrice;

    info(
      `[SOPHIE MAKER DISTANCE DECAY] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `baseDistance=${cleanLogValue(baseDistance)} noFillStreak=${noFillStreak} decayPerNoFill=${cleanLogValue(decayPerNoFill)} ` +
      `decayMultiplier=${cleanLogValue(decayMultiplier)} targetDistance=${cleanLogValue(targetDistance)}`
    );

    if (signal.side === 'buy') {
      const touchPrice = Number(book.bestBid);
      desiredPrice = cappedNoFillStreak > 0 ? touchPrice - targetDistance : oneTickPrice;
      edgeLimitedPrice = oldPrice + edgeMoveBudget;
      makerLimitedPrice = Math.min(Number(book.bestBid), Number(book.bestAsk) - tick);
      optimizedPrice = Math.min(desiredPrice, edgeLimitedPrice, makerLimitedPrice);
    } else {
      const touchPrice = Number(book.bestAsk);
      desiredPrice = cappedNoFillStreak > 0 ? touchPrice + targetDistance : oneTickPrice;
      edgeLimitedPrice = oldPrice - edgeMoveBudget;
      makerLimitedPrice = Math.max(Number(book.bestAsk), Number(book.bestBid) + tick);
      optimizedPrice = Math.max(desiredPrice, edgeLimitedPrice, makerLimitedPrice);
    }

    optimizedPrice = roundToTick(clamp(optimizedPrice, 0.01, 0.99), tick);
    if (!Number.isFinite(optimizedPrice) || Math.abs(optimizedPrice - oldPrice) < 1e-9) {
      this.logStarvedOptimizerBlock(signal, quality, 'no_safe_tick_available', oldPrice, optimizedPrice, null, null, {
        noFillStreak,
        decayMultiplier,
        targetDistance,
      });
      return null;
    }

    if (signal.side === 'buy' && optimizedPrice >= Number(book.bestAsk)) {
      this.logStarvedOptimizerBlock(signal, quality, 'would_cross_spread', oldPrice, optimizedPrice, null, null, {
        noFillStreak,
        decayMultiplier,
        targetDistance,
      });
      return null;
    }
    if (signal.side === 'sell' && optimizedPrice <= Number(book.bestBid)) {
      this.logStarvedOptimizerBlock(signal, quality, 'would_cross_spread', oldPrice, optimizedPrice, null, null, {
        noFillStreak,
        decayMultiplier,
        targetDistance,
      });
      return null;
    }

    const priceDelta = Math.abs(optimizedPrice - oldPrice);
    const edgeAfterMove = Number(signal.expectedEdge) - priceDelta;

    const optimized = new Signal({
      ...signal,
      price: optimizedPrice,
      expectedEdge: edgeAfterMove,
      metadata: {
        ...(signal.metadata || {}),
        paperMakerOptimizer: {
          applied: true,
          reason,
          oldPrice,
          optimizedPrice,
          edgeBeforeMove: Number(signal.expectedEdge),
          edgeAfterMove,
          ticksMoved: Math.round(priceDelta / tick),
          noFillStreak,
          decayMultiplier,
          targetDistance,
          neverCrossSpread: true,
          paperOnly: true,
        },
      },
    });
    const optimizedQuality = this.evaluateSophieExecutionQuality(optimized, book);
    optimized.metadata.sophieExecution = optimizedQuality;
    optimizedQuality.qualityDecision = 'OPTIMIZED_MAKER_RECOVERY_QUEUED';

    const recoveryFloor = {
      minEdgeAfterMove: this.config.paperMakerRecoveryMinEdgeAfterMove,
      minSignalScore: this.config.paperMakerRecoveryMinSignalScore,
      minConfidence: this.config.paperMakerRecoveryMinConfidence,
      maxActive: this.config.paperMakerRecoveryMaxActive,
      riskMinEdge: this.config.minSignalEdge,
    };
    const failed = [];
    if (edgeAfterMove < recoveryFloor.minEdgeAfterMove) failed.push('edge_after_move');
    if (Number.isFinite(recoveryFloor.riskMinEdge) && edgeAfterMove < recoveryFloor.riskMinEdge) failed.push('risk_min_edge');
    if (optimizedQuality.distanceFromTouch > baseDistance + 1e-9) failed.push('distance_not_improved');
    if (optimizedQuality.predictedFillProbability <= quality.predictedFillProbability + 1e-9) failed.push('fill_probability_not_improved');
    if (quality.sophieSignalScore < recoveryFloor.minSignalScore) failed.push('signal_score');
    if (Number(signal.confidence) < recoveryFloor.minConfidence) failed.push('confidence');
    if (this.portfolio.openOrders.size >= recoveryFloor.maxActive) failed.push('active_order_cap');
    if (failed.length > 0) {
      this.logStarvedOptimizerBlock(signal, quality, 'recovery_floor_failed', oldPrice, optimizedPrice, edgeAfterMove, optimizedQuality, {
        failed: failed.join(','),
        recoveryFloor: this.formatMakerRecoveryFloor(recoveryFloor),
        noFillStreak,
        decayMultiplier,
        targetDistance,
      });
      return null;
    }

    return {
      signal: optimized,
      quality: optimizedQuality,
      asset: null,
      book,
      reason,
      oldPrice,
      optimizedPrice,
      edgeBefore: Number(signal.expectedEdge),
      edgeAfterMove,
      oldDistance: quality.distanceFromTouch,
      optimizedDistance: optimizedQuality.distanceFromTouch,
      optimizedFillProb: optimizedQuality.predictedFillProbability,
      noFillStreak,
      decayMultiplier,
      targetDistance,
      recoveryFloor,
      utility: this.makerRecoveryUtility(optimized, optimizedQuality, edgeAfterMove),
    };
  }

  formatMakerRecoveryFloor(floor = {}) {
    return [
      `edge>=${cleanLogValue(floor.minEdgeAfterMove)}`,
      Number.isFinite(floor.riskMinEdge) ? `riskEdge>=${cleanLogValue(floor.riskMinEdge)}` : null,
      `signalScore>=${cleanLogValue(floor.minSignalScore)}`,
      `confidence>=${cleanLogValue(floor.minConfidence)}`,
      `maxActive=${floor.maxActive}`,
    ].filter(Boolean).join('|');
  }

  makerRecoveryUtility(signal, quality, edgeAfterMove) {
    return (
      (0.45 * clamp(edgeAfterMove / 0.02, 0, 1)) +
      (0.25 * clamp(quality.predictedFillProbability, 0, 1)) +
      (0.20 * clamp(quality.sophieSignalScore, 0, 1)) +
      (0.10 * clamp(Number(signal.confidence) || 0, 0, 1))
    );
  }

  queueStarvedPaperMakerQuote(signal, asset, book, quality, reason = 'low_quality') {
    const candidate = this.buildStarvedPaperMakerQuote(signal, book, quality, reason);
    if (!candidate) return false;
    candidate.asset = asset;
    this.sophieMakerRecoveryCandidates.push(candidate);
    quality.qualityDecision = 'OPTIMIZED_MAKER_RECOVERY_QUEUED';
    this.lastSophieQualityDecision = quality;
    return true;
  }

  flushSophieMakerRecoveryCandidates() {
    if (!this.sophieMakerRecoveryCandidates.length) return;
    if (this.portfolio.openOrders.size > 0 || this.spreadHunterOpenOrderCount() > 0) {
      for (const candidate of this.sophieMakerRecoveryCandidates) {
        this.logStarvedOptimizerBlock(candidate.signal, candidate.quality, 'active_orders_present', candidate.oldPrice, candidate.optimizedPrice, candidate.edgeAfterMove, candidate.quality, {
          recoveryFloor: this.formatMakerRecoveryFloor(candidate.recoveryFloor),
        });
      }
      this.sophieMakerRecoveryCandidates = [];
      return;
    }

    const ranked = this.sophieMakerRecoveryCandidates
      .slice()
      .sort((a, b) => b.utility - a.utility)
      .slice(0, Math.max(1, this.config.paperMakerRecoveryMaxActive));

    for (const candidate of ranked) {
      if (this.portfolio.openOrders.size >= this.config.paperMakerRecoveryMaxActive) {
        this.logStarvedOptimizerBlock(candidate.signal, candidate.quality, 'active_order_cap', candidate.oldPrice, candidate.optimizedPrice, candidate.edgeAfterMove, candidate.quality, {
          recoveryFloor: this.formatMakerRecoveryFloor(candidate.recoveryFloor),
        });
        continue;
      }

      const risked = this.risk.evaluate(candidate.signal);
      if (!risked) {
        this.portfolio.recordExecutionEvent('risk_block', {
          ...candidate.signal,
          marketSlug: candidate.signal?.metadata?.marketSlug,
          outcome: candidate.signal?.metadata?.outcome,
          reason: this.risk.lastBlockReason || 'invalid_signal',
          drawdownGateActive: (this.risk.lastBlockReason || 'invalid_signal') === 'drawdown_limit',
          paperProbationActive: candidate.signal?.metadata?.paperProbation?.active === true,
          probationAdmission: candidate.signal?.metadata?.paperProbation?.admissionReason || null,
          paperProbationTrigger: candidate.signal?.metadata?.paperProbation?.trigger || null,
          sophieDecision: 'OPTIMIZED_MAKER_ADMIT',
          finalBlockerAfterProbation: candidate.signal?.metadata?.paperProbation?.active === true
            ? (this.risk.lastBlockReason || 'invalid_signal')
            : null,
          ...this.risk.lastBlockDetails,
        });
        this.logStarvedOptimizerBlock(candidate.signal, candidate.quality, 'risk_rejected', candidate.oldPrice, candidate.optimizedPrice, candidate.edgeAfterMove, candidate.quality, {
          recoveryFloor: this.formatMakerRecoveryFloor(candidate.recoveryFloor),
          riskOk: false,
          riskReason: this.risk.lastBlockReason || 'invalid_signal',
        });
        continue;
      }

      candidate.quality.qualityDecision = 'OPTIMIZED_MAKER_ADMIT';
      this.lastSophieQualityDecision = candidate.quality;
      this.recordSophieAdmission(candidate.signal, candidate.quality);
      info(
        `[SOPHIE MAKER OPTIMIZER ADMIT] ${candidate.signal.side.toUpperCase()} ${shortId(candidate.signal.tokenId)} ` +
        `oldPrice=${fmtPrice(candidate.oldPrice)} optimizedPrice=${fmtPrice(candidate.optimizedPrice)} ` +
        `edgeBefore=${cleanLogValue(candidate.edgeBefore)} edgeAfter=${cleanLogValue(candidate.edgeAfterMove)} ` +
        `optimizedFillProb=${candidate.optimizedFillProb} oldDistance=${candidate.oldDistance} optimizedDistance=${candidate.optimizedDistance} ` +
        `noFillStreak=${candidate.noFillStreak} decayMultiplier=${cleanLogValue(candidate.decayMultiplier)} ` +
        `recoveryFloor=${this.formatMakerRecoveryFloor(candidate.recoveryFloor)} riskOk=true paperOnly=true`
      );
      this.execution.place(risked, candidate.book);
    }

    this.sophieMakerRecoveryCandidates = [];
  }

  logStarvedOptimizerBlock(signal, quality, reason, oldPrice = null, optimizedPrice = null, edgeAfterMove = null, optimizedQuality = null, extra = {}) {
    const recoveryFloor = extra.recoveryFloor || this.formatMakerRecoveryFloor({
      minEdgeAfterMove: this.config.paperMakerRecoveryMinEdgeAfterMove,
      riskMinEdge: this.config.minSignalEdge,
      minSignalScore: this.config.paperMakerRecoveryMinSignalScore,
      minConfidence: this.config.paperMakerRecoveryMinConfidence,
      maxActive: this.config.paperMakerRecoveryMaxActive,
    });
    warn(
      `[SOPHIE MAKER OPTIMIZER BLOCK] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `reason=${reason} openOrders=${this.portfolio.openOrders.size} oldPrice=${Number.isFinite(oldPrice) ? fmtPrice(oldPrice) : 'NA'} ` +
      `optimizedPrice=${Number.isFinite(optimizedPrice) ? fmtPrice(optimizedPrice) : 'NA'} ` +
      `edgeBefore=${cleanLogValue(signal.expectedEdge)} edgeAfter=${Number.isFinite(edgeAfterMove) ? cleanLogValue(edgeAfterMove) : 'NA'} ` +
      `optimizedFillProb=${optimizedQuality?.predictedFillProbability ?? 'NA'} oldDistance=${quality.distanceFromTouch} ` +
      `optimizedDistance=${optimizedQuality?.distanceFromTouch ?? 'NA'} signalScore=${quality.sophieSignalScore} ` +
      `confidence=${cleanLogValue(signal.confidence)} recoveryFloor=${recoveryFloor} ` +
      `noFillStreak=${extra.noFillStreak ?? 'NA'} decayMultiplier=${Number.isFinite(extra.decayMultiplier) ? cleanLogValue(extra.decayMultiplier) : 'NA'} ` +
      `targetDistance=${Number.isFinite(extra.targetDistance) ? cleanLogValue(extra.targetDistance) : 'NA'} ` +
      `failed=${extra.failed || reason} riskOk=${extra.riskOk ?? 'NA'} riskReason=${extra.riskReason || 'NA'} ` +
      `disallowedFailures=${extra.disallowedFailures || 'none'} paperOnly=true`
    );
  }

  applySophieExecutionGate(signal, asset, book, quality) {
    if (!this.config.sophieExecutionQualityEnabled || isProtectiveExitStrategy(signal.strategy)) {
      return true;
    }

    const key = this.sophieExecutionKey(signal);
    const repeatKey = this.repeatCandidateKey(signal);
    const now = Date.now();
    const health = this.portfolio.executionHealth(now);
    const actionBurnIn = this.paperActionBurnInState(now, health);
    const paperProbation = signal?.metadata?.paperProbation || null;
    const probationActive = (
      this.config.enableLiveTrading !== true &&
      resolveStrategyName(signal) === 'SpreadHunter' &&
      String(signal?.side || '').toLowerCase() === 'buy' &&
      paperProbation?.active === true &&
      actionBurnIn.probationWindowOpen
    );
    const probationTraceReasonBase = paperProbation?.active === true
      ? 'metadata_present'
      : 'metadata_missing';
    this.logPaperProbationTrace(signal, {
      probationEligible: paperProbation?.active === true,
      probationActive,
      reason: probationTraceReasonBase,
    }, 'sophie_gate_entry');
    const recordProbationAdmit = (reason = 'paper_flow_probation') => {
      this.portfolio.recordExecutionEvent('paper_probation_admit', {
        ...signal,
        quality: quality.sophieExecutionQuality,
        distanceFromTouch: quality.distanceFromTouch,
        predictedFillProbability: quality.predictedFillProbability,
        reason,
        source: 'paper_probation',
        probationAdmission: paperProbation?.admissionReason || null,
        ordersPlacedLast15m: Number(actionBurnIn.ordersPlacedLast15m || 0),
        fillsLast15m: Number(actionBurnIn.fillsLast15m || 0),
        targetOrdersPer15m: Number(actionBurnIn.targetOrdersPer15m || 0),
        targetFillsPer15m: Number(actionBurnIn.targetFillsPer15m || 0),
        maxOrderUsd: Number(paperProbation?.maxOrderUsd || signal.sizeUsd || 0),
        maxSpread: Number(paperProbation?.maxSpread || 0),
        maxLiquidityConsumedPct: Number(paperProbation?.maxLiquidityConsumedPct || 0),
      });
    };
    const recordProbationBlock = (reason = 'paper_flow_probation_blocked') => {
      this.portfolio.recordExecutionEvent('paper_probation_block', {
        ...signal,
        quality: quality.sophieExecutionQuality,
        distanceFromTouch: quality.distanceFromTouch,
        predictedFillProbability: quality.predictedFillProbability,
        reason,
        source: 'paper_probation',
        probationAdmission: paperProbation?.admissionReason || null,
        ordersPlacedLast15m: Number(actionBurnIn.ordersPlacedLast15m || 0),
        fillsLast15m: Number(actionBurnIn.fillsLast15m || 0),
        targetOrdersPer15m: Number(actionBurnIn.targetOrdersPer15m || 0),
        targetFillsPer15m: Number(actionBurnIn.targetFillsPer15m || 0),
      });
    };
    const logProbationAdmission = (reason) => {
      if (!probationActive) return;
      info(
        `[PAPER ACTION BURN-IN] probation_admission=true reason=${reason} strategy=${resolveStrategyName(signal)} ` +
        `token=${shortId(signal.tokenId)} sizeUsd=${cleanLogValue(signal.sizeUsd)} ` +
        `orders15m=${actionBurnIn.ordersPlacedLast15m} fills15m=${actionBurnIn.fillsLast15m} ` +
        `targetOrders15m=${actionBurnIn.targetOrdersPer15m} targetFills15m=${actionBurnIn.targetFillsPer15m} ` +
        `maxOrderUsd=${cleanLogValue(paperProbation?.maxOrderUsd || signal.sizeUsd)} ` +
        `maxSpread=${cleanLogValue(paperProbation?.maxSpread)} ` +
        `maxLiquidityConsumedPct=${cleanLogValue(paperProbation?.maxLiquidityConsumedPct)} ` +
        `trigger=${paperProbation?.trigger || 'unknown'} paperOnly=true`
      );
    };
    const repeatCooldownUntil = this.sophieRepeatCandidateCooldownUntil.get(repeatKey) || 0;
    if (repeatCooldownUntil > now) {
      if (!probationActive) {
        this.logPaperProbationTrace(signal, {
          probationEligible: paperProbation?.active === true,
          probationActive,
          repeatCooldownBlocked: true,
          reason: paperProbation?.active === true ? 'repeat_cooldown_probation_inactive' : 'repeat_cooldown_no_probation_metadata',
        }, 'sophie_repeat_cooldown');
        quality.qualityDecision = 'REPEAT_COOLDOWN';
        this.lastSophieQualityDecision = quality;
        this.recordRepeatCandidateSuppression(signal, repeatKey);
        this.portfolio.recordExecutionEvent('quality_block', {
          ...signal,
          reason: 'repeat_cooldown',
          source: 'sophie_execution_gate',
        });
        return false;
      }
      quality.repeatCooldownBypassed = true;
      this.logPaperProbationTrace(signal, {
        probationEligible: paperProbation?.active === true,
        probationActive,
        repeatCooldownBypassed: true,
        reason: 'repeat_cooldown_bypassed_for_probation',
      }, 'sophie_repeat_cooldown');
    }

    const cooldownUntil = this.sophieNoFillCooldownUntil.get(key) || 0;
    if (cooldownUntil > now) {
      quality.qualityDecision = 'THROTTLE';
      this.lastSophieQualityDecision = quality;
      this.portfolio.recordExecutionEvent('quality_throttle', {
        ...signal,
        reason: 'token_cooldown',
        source: 'sophie_execution_gate',
      });
      return false;
    }

    const windowStats = this.portfolio.executionStatsFor(signal, this.config.sophieDuplicatePressureWindowMs);
    if (
      this.config.sophieNoFillLearningEnabled &&
      windowStats.noFillStreak >= this.config.sophieNoFillStreakLimit
    ) {
      this.sophieNoFillCooldownUntil.set(key, now + this.config.sophieNoFillTokenCooldownMs);
      quality.qualityDecision = 'THROTTLE_NO_FILL_LEARN';
      this.lastSophieQualityDecision = quality;
      this.portfolio.recordExecutionEvent('quality_throttle', {
        ...signal,
        reason: 'no_fill_learning',
        source: 'sophie_execution_gate',
      });
      this.logNoFillLearning(signal, windowStats, quality.rawPredictedFillProbability, quality.predictedFillProbability);
      return false;
    }

    if (
      windowStats.attemptsLastHour >= this.config.sophieMaxAttemptsPerTokenWindow &&
      windowStats.duplicateSkipsLastHour >= this.config.sophieMaxDuplicateSkipsPerTokenWindow &&
      windowStats.fillsLastHour === 0 &&
      windowStats.fillRateLastHour < this.config.sophieMinFillRateTarget
    ) {
      this.sophieNoFillCooldownUntil.set(key, now + this.config.sophieNoFillCooldownMs);
      quality.qualityDecision = 'THROTTLE';
      this.lastSophieQualityDecision = quality;
      this.portfolio.recordExecutionEvent('quality_throttle', {
        ...signal,
        reason: 'no_fill_window',
        source: 'sophie_execution_gate',
      });
      warn(
        `[SOPHIE EXECUTION THROTTLE] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} strategy=${signal.strategy} ` +
        `reason=no_fills attemptsWindow=${windowStats.attemptsLastHour} duplicateSkipsWindow=${windowStats.duplicateSkipsLastHour} ` +
        `fillsWindow=${windowStats.fillsLastHour} cooldownSec=${Math.round(this.config.sophieNoFillCooldownMs / 1000)}`
      );
      return false;
    }

    if (quality.sophieExecutionQuality < this.config.sophieMinExecutionQuality) {
      if (this.shouldCalibratedAdmit(signal, quality)) {
        this.sophieCalibratedAdmissionsThisScan += 1;
        quality.qualityDecision = 'CALIBRATED_ADMIT';
        this.lastSophieQualityDecision = quality;
        this.recordSophieAdmission(signal, quality);
        info(
          `[SOPHIE CALIBRATED ADMIT] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
          `quality=${quality.sophieExecutionQuality} minQuality=${this.config.sophieCalibratedMinQuality} ` +
          `edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)} ` +
          `fillProb=${quality.predictedFillProbability} distanceFromTouch=${quality.distanceFromTouch}`
        );
        if (this.portfolio.openOrders.size >= this.config.maxOpenOrders) {
          return this.applySophieSlotManagement(signal, book, quality);
        }
        return true;
      }

      if (probationActive) {
        const probationFailures = [];
        const probationMinConfidence = Number(paperProbation?.minConfidence || 0);
        if (quality.sophieExecutionQuality < Number(this.config.sophieBootstrapMinQuality || 0)) probationFailures.push('quality');
        if (Number(signal.expectedEdge) < this.risk.minSignalEdgeForSignal(signal)) probationFailures.push('edge');
        if (Number(signal.confidence) < probationMinConfidence) probationFailures.push('confidence');
        if (quality.predictedFillProbability < Number(this.config.sophieBootstrapMinFillProb || 0)) probationFailures.push('fill_probability');
        if (quality.distanceFromTouch > Number(this.config.sophieBootstrapMaxDistanceFromTouch || 0)) probationFailures.push('distance_from_touch');
        if (probationFailures.length === 0) {
          quality.qualityDecision = 'PAPER_PROBATION_ADMIT';
          this.lastSophieQualityDecision = quality;
          recordProbationAdmit('paper_flow_probation_low_quality_recovery');
          logProbationAdmission('paper_flow_probation_low_quality_recovery');
          this.recordSophieAdmission(signal, quality);
          info(
            `[SOPHIE PAPER PROBATION ADMIT] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
            `quality=${quality.sophieExecutionQuality} confidence=${cleanLogValue(signal.confidence)} ` +
            `fillProb=${quality.predictedFillProbability} distanceFromTouch=${quality.distanceFromTouch} ` +
            `trigger=${paperProbation?.trigger || 'unknown'} sizeUsd=${cleanLogValue(signal.sizeUsd)} paperOnly=true`
          );
          return true;
        }
      }

      if (this.shouldBootstrapQueue(signal, quality)) {
        this.queueSophieBootstrapCandidate(signal, asset, book, quality);
        return false;
      }

      if (this.config.sophieBootstrapAdmissionEnabled && signal.strategy === 'SpreadHunter') {
        this.recordBootstrapBlock(signal, quality);
      }
      if (this.queueStarvedPaperMakerQuote(signal, asset, book, quality, 'zero_open_orders_low_quality')) {
        return false;
      }
      if (probationActive) {
        const probationReasons = [];
        const probationMinConfidence = Number(paperProbation?.minConfidence || 0);
        if (quality.sophieExecutionQuality < Number(this.config.sophieBootstrapMinQuality || 0)) probationReasons.push('quality');
        if (Number(signal.expectedEdge) < this.risk.minSignalEdgeForSignal(signal)) probationReasons.push('edge');
        if (Number(signal.confidence) < probationMinConfidence) probationReasons.push('confidence');
        if (quality.predictedFillProbability < Number(this.config.sophieBootstrapMinFillProb || 0)) probationReasons.push('fill_probability');
        if (quality.distanceFromTouch > Number(this.config.sophieBootstrapMaxDistanceFromTouch || 0)) probationReasons.push('distance_from_touch');
        recordProbationBlock(probationReasons.join('+') || 'low_quality');
      }
      this.recordLowQualityBlock(signal, quality);
      if (!probationActive) {
        this.sophieRepeatCandidateCooldownUntil.set(repeatKey, now + this.config.sophieRepeatCandidateCooldownMs);
      }
      quality.qualityDecision = 'BLOCK_LOW_QUALITY';
      this.lastSophieQualityDecision = quality;
      this.portfolio.recordExecutionEvent('quality_block', {
        ...signal,
        reason: probationActive ? 'low_quality_probation_blocked' : 'low_execution_quality',
        source: 'sophie_execution_gate',
      });
      return false;
    }

    if (this.portfolio.openOrders.size >= this.config.maxOpenOrders) {
      return this.applySophieSlotManagement(signal, book, quality);
    }

    quality.qualityDecision = 'ADMIT';
    this.lastSophieQualityDecision = quality;
    if (probationActive) {
      recordProbationAdmit(paperProbation?.trigger || 'paper_flow_probation');
      logProbationAdmission(paperProbation?.trigger || 'paper_flow_probation');
    }
    this.recordSophieAdmission(signal, quality);
    info(
      `[SOPHIE ORDER QUALITY] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `signalScore=${quality.sophieSignalScore} executionQuality=${quality.sophieExecutionQuality} ` +
      `fillProb=${quality.predictedFillProbability} edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)} ` +
      `quoteMode=${quality.quoteMode} distanceFromTouch=${quality.distanceFromTouch} decision=ADMIT`
    );
    return true;
  }

  recordSophieAdmission(signal, quality) {
    this.portfolio.recordExecutionEvent('order_admitted', {
      ...signal,
      quality: quality.sophieExecutionQuality,
      distanceFromTouch: quality.distanceFromTouch,
      predictedFillProbability: quality.predictedFillProbability,
    });
  }

  shouldBootstrapQueue(signal, quality) {
    if (!this.config.sophieBootstrapAdmissionEnabled) return false;
    if (signal.strategy !== 'SpreadHunter') return false;
    if (this.bootstrapSameTokenCooldownActive(signal, quality)) return false;
    if (this.spreadHunterOpenOrderCount() >= this.config.sophieBootstrapOnlyWhenOpenOrdersBelow) return false;
    if (this.spreadHunterOpenOrderCount() >= this.config.sophieBootstrapMaxActiveOrders) return false;
    if (this.sophieBootstrapAdmissionsThisScan >= this.config.sophieBootstrapMaxAdmissionsPerScan) return false;

    return this.bootstrapAdmissionFailures(signal, quality).length === 0;
  }

  bootstrapSameTokenCooldownActive(signal, quality) {
    const key = this.sophieExecutionKey(signal);
    const now = Date.now();
    const cooldownUntil = this.sophieBootstrapTokenCooldownUntil.get(key) || 0;
    if (cooldownUntil > now) return true;

    const stats = this.portfolio.executionStatsFor(signal, 60 * 60_000);
    const admissionsTooHigh = stats.admittedLastHour >= this.config.sophieBootstrapMaxSameTokenAdmissionsPerHour;
    const repeatedNoFill = stats.noFillStreak >= this.config.sophieNoFillStreakLimit;
    if (!admissionsTooHigh && !repeatedNoFill) return false;

    if (this.config.sophieBootstrapRequireImprovementAfterNoFill) {
      const lastQuality = Number(stats.bestAdmittedQualityLastHour);
      const qualityImproved = Number.isFinite(lastQuality) &&
        quality.sophieExecutionQuality >= lastQuality + this.config.sophieBootstrapMinQualityImprovement;
      const lastDistance = Number(stats.lastAdmittedDistanceFromTouch);
      const distanceImproved = Number.isFinite(lastDistance) &&
        quality.distanceFromTouch <= Math.max(0, lastDistance - this.config.sophieFillDistanceIdeal);
      if (qualityImproved || distanceImproved) return false;
    }

    this.sophieBootstrapTokenCooldownUntil.set(key, now + this.config.sophieBootstrapSameTokenCooldownMs);
    warn(
      `[SOPHIE BOOTSTRAP COOLDOWN] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `reason=repeated_no_fill admissionsLastHour=${stats.admittedLastHour} noFillStreak=${stats.noFillStreak} ` +
      `cooldownSec=${Math.round(this.config.sophieBootstrapSameTokenCooldownMs / 1000)}`
    );
    return true;
  }

  bootstrapAdmissionFailures(signal, quality) {
    const failures = [];
    if (quality.sophieSignalScore < this.config.sophieBootstrapMinSignalScore) failures.push('signal_score');
    if (quality.sophieExecutionQuality < this.config.sophieBootstrapMinQuality) failures.push('quality');
    if (Number(signal.expectedEdge) < this.config.sophieBootstrapMinEdge) failures.push('edge');
    if (Number(signal.confidence) < this.config.sophieBootstrapMinConfidence) failures.push('confidence');
    if (quality.predictedFillProbability < this.config.sophieBootstrapMinFillProb) failures.push('fill_probability');
    if (quality.distanceFromTouch > this.config.sophieBootstrapMaxDistanceFromTouch) failures.push('distance_from_touch');
    if (this.spreadHunterOpenOrderCount() >= this.config.sophieBootstrapOnlyWhenOpenOrdersBelow) failures.push('open_order_target');
    if (this.spreadHunterOpenOrderCount() >= this.config.sophieBootstrapMaxActiveOrders) failures.push('active_order_cap');
    if (this.sophieBootstrapAdmissionsThisScan >= this.config.sophieBootstrapMaxAdmissionsPerScan) failures.push('scan_cap');
    return failures;
  }

  bootstrapUtility(signal, quality) {
    const normalizedExpectedEdge = clamp((Number(signal.expectedEdge) || 0) / 0.04, 0, 1);
    const confidence = clamp(Number(signal.confidence) || 0, 0, 1);
    const maxDistance = Math.max(0.001, this.config.sophieBootstrapMaxDistanceFromTouch);
    const touchProximityScore = clamp(1 - (quality.distanceFromTouch / maxDistance), 0, 1);
    return (
      (0.25 * quality.sophieSignalScore) +
      (0.20 * quality.sophieExecutionQuality) +
      (0.20 * quality.predictedFillProbability) +
      (0.15 * normalizedExpectedEdge) +
      (0.10 * confidence) +
      (0.10 * touchProximityScore)
    );
  }

  queueSophieBootstrapCandidate(signal, asset, book, quality) {
    quality.qualityDecision = 'BOOTSTRAP_QUEUED';
    this.lastSophieQualityDecision = quality;
    this.sophieBootstrapCandidates.push({
      signal,
      asset,
      book,
      quality,
      utility: this.bootstrapUtility(signal, quality),
    });
  }

  flushSophieBootstrapCandidates() {
    if (!this.sophieBootstrapCandidates.length) return;

    const ranked = this.sophieBootstrapCandidates
      .slice()
      .sort((a, b) => b.utility - a.utility);

    for (const candidate of ranked) {
      if (this.sophieBootstrapAdmissionsThisScan >= this.config.sophieBootstrapMaxAdmissionsPerScan) {
        this.recordBootstrapBlock(candidate.signal, candidate.quality, ['scan_cap']);
        continue;
      }
      if (this.spreadHunterOpenOrderCount() >= this.config.sophieBootstrapOnlyWhenOpenOrdersBelow) {
        this.recordBootstrapBlock(candidate.signal, candidate.quality, ['open_order_target']);
        continue;
      }
      if (this.spreadHunterOpenOrderCount() >= this.config.sophieBootstrapMaxActiveOrders) {
        this.recordBootstrapBlock(candidate.signal, candidate.quality, ['active_order_cap']);
        continue;
      }

      const failures = this.bootstrapAdmissionFailures(candidate.signal, candidate.quality);
      if (failures.length > 0) {
        this.recordBootstrapBlock(candidate.signal, candidate.quality, failures);
        continue;
      }

      this.sophieBootstrapAdmissionsThisScan += 1;
      candidate.quality.qualityDecision = 'BOOTSTRAP_ADMIT';
      this.lastSophieQualityDecision = candidate.quality;
      this.recordSophieAdmission(candidate.signal, candidate.quality);
      info(
        `[SOPHIE BOOTSTRAP ADMIT] ${candidate.signal.side.toUpperCase()} ${shortId(candidate.signal.tokenId)} ` +
        `signalScore=${candidate.quality.sophieSignalScore} quality=${candidate.quality.sophieExecutionQuality} ` +
        `edge=${cleanLogValue(candidate.signal.expectedEdge)} confidence=${cleanLogValue(candidate.signal.confidence)} ` +
        `fillProb=${candidate.quality.predictedFillProbability} distanceFromTouch=${candidate.quality.distanceFromTouch} ` +
        `activeOrders=${this.spreadHunterOpenOrderCount()} maxBootstrapActive=${this.config.sophieBootstrapMaxActiveOrders}`
      );

      this.admitSignalThroughRisk(candidate.signal, candidate.asset, candidate.book);
    }

    this.sophieBootstrapCandidates = [];
  }

  recordBootstrapBlock(signal, quality, failures = null) {
    const failed = failures || this.bootstrapAdmissionFailures(signal, quality);
    const key = this.sophieExecutionKey(signal);
    const now = Date.now();
    const last = this.sophieBootstrapLastLogged.get(key) || 0;
    if (now - last < this.config.sophieLowQualityBlockCooldownMs) return;
    this.sophieBootstrapLastLogged.set(key, now);
    warn(
      `[SOPHIE BOOTSTRAP BLOCK] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `failed=${failed.join(',') || 'none'} quality=${quality.sophieExecutionQuality} ` +
      `edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)} ` +
      `fillProb=${quality.predictedFillProbability} distanceFromTouch=${quality.distanceFromTouch}`
    );
  }

  shouldCalibratedAdmit(signal, quality) {
    if (!this.config.sophieCalibratedAdmissionEnabled) return false;
    if (signal.strategy !== 'SpreadHunter') return false;
    if (this.sophieCalibratedAdmissionsThisScan >= this.config.sophieCalibratedMaxAdmissionsPerScan) return false;
    if (this.spreadHunterOpenOrderCount() >= this.config.sophieCalibratedMaxActiveOrders) return false;
    if (this.spreadHunterOpenOrderCount() >= this.config.sophieTargetActiveMaxPaperOrders) return false;

    return (
      quality.sophieExecutionQuality >= this.config.sophieCalibratedMinQuality &&
      Number(signal.expectedEdge) >= this.config.sophieCalibratedMinEdge &&
      Number(signal.confidence) >= this.config.sophieCalibratedMinConfidence &&
      quality.predictedFillProbability >= this.config.sophieCalibratedMinFillProb &&
      quality.distanceFromTouch <= this.config.sophieCalibratedMaxDistanceFromTouch
    );
  }

  calibratedAdmissionFailures(signal, quality) {
    const failures = [];
    if (quality.sophieExecutionQuality < this.config.sophieCalibratedMinQuality) failures.push('quality');
    if (Number(signal.expectedEdge) < this.config.sophieCalibratedMinEdge) failures.push('edge');
    if (Number(signal.confidence) < this.config.sophieCalibratedMinConfidence) failures.push('confidence');
    if (quality.predictedFillProbability < this.config.sophieCalibratedMinFillProb) failures.push('fill_probability');
    if (quality.distanceFromTouch > this.config.sophieCalibratedMaxDistanceFromTouch) failures.push('distance_from_touch');
    if (this.spreadHunterOpenOrderCount() >= this.config.sophieCalibratedMaxActiveOrders) failures.push('active_order_cap');
    if (this.sophieCalibratedAdmissionsThisScan >= this.config.sophieCalibratedMaxAdmissionsPerScan) failures.push('scan_cap');
    return failures;
  }

  recordLowQualityBlock(signal, quality) {
    const now = Date.now();
    const summaryMs = Math.max(1, this.config.sophieLowQualityBlockSummaryMs || 300_000);
    if (now - this.sophieLowQualitySummary.windowStartedAt >= summaryMs) {
      const qualities = this.sophieLowQualitySummary.qualities;
      if (this.sophieLowQualitySummary.blocked > 0 && qualities.length > 0) {
        const avg = qualities.reduce((sum, value) => sum + value, 0) / qualities.length;
        const max = Math.max(...qualities);
        warn(
          `[SOPHIE LOW QUALITY SUMMARY] blocked=${this.sophieLowQualitySummary.blocked} ` +
          `uniqueTokens=${this.sophieLowQualitySummary.tokenIds.size} avgQuality=${avg.toFixed(3)} ` +
          `maxQuality=${max.toFixed(3)} windowSec=${Math.round(summaryMs / 1000)}`
        );
      }
      this.sophieLowQualitySummary = { windowStartedAt: now, blocked: 0, qualities: [], tokenIds: new Set() };
    }

    this.sophieLowQualitySummary.blocked += 1;
    this.sophieLowQualitySummary.qualities.push(quality.sophieExecutionQuality);
    this.sophieLowQualitySummary.tokenIds.add(String(signal.tokenId));

    const key = this.sophieExecutionKey(signal);
    const last = this.sophieLowQualityLastLogged.get(key) || 0;
    if (now - last < this.config.sophieLowQualityBlockCooldownMs) return;
    this.sophieLowQualityLastLogged.set(key, now);

    const failed = this.calibratedAdmissionFailures(signal, quality);
    const bootstrapFailed = signal.strategy === 'SpreadHunter'
      ? this.bootstrapAdmissionFailures(signal, quality)
      : [];
    warn(
      `[SOPHIE ORDER QUALITY] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
      `signalScore=${quality.sophieSignalScore} executionQuality=${quality.sophieExecutionQuality} ` +
      `fillProb=${quality.predictedFillProbability} edge=${cleanLogValue(signal.expectedEdge)} confidence=${cleanLogValue(signal.confidence)} ` +
      `quoteMode=${quality.quoteMode} distanceFromTouch=${quality.distanceFromTouch} decision=BLOCK_LOW_QUALITY ` +
      `calibratedFailed=${failed.join(',') || 'none'} bootstrapFailed=${bootstrapFailed.join(',') || 'none'}`
    );
  }

  recordRepeatCandidateSuppression(signal, repeatKey) {
    const now = Date.now();
    const state = this.sophieRepeatCandidateLogs.get(repeatKey) || { windowStartedAt: now, count: 0 };
    if (now - state.windowStartedAt >= this.config.sophieRepeatCandidateCooldownMs) {
      state.windowStartedAt = now;
      state.count = 0;
    }
    state.count += 1;
    this.sophieRepeatCandidateLogs.set(repeatKey, state);

    if (state.count <= this.config.sophieMaxRepeatCandidateLogsPerWindow) {
      info(
        `[SOPHIE REPEAT CANDIDATE COOLDOWN] ${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
        `strategy=${signal.strategy} cooldownSec=${Math.round(this.config.sophieRepeatCandidateCooldownMs / 1000)}`
      );
    }
  }

  applySophieSlotManagement(signal, book, quality) {
    const now = Date.now();
    const eligible = [...this.portfolio.openOrders.entries()]
      .filter(([, order]) => !isProtectiveExitStrategy(order.strategy))
      .filter(([, order]) => now - order.createdAt >= this.config.sophieSlotEvictionMinOpenOrderAgeMs)
      .filter(([, order]) => order.remainingUsd() >= signal.sizeUsd)
      .map(([id, order]) => ({
        id,
        order,
        quality: this.evaluateSophieExecutionQuality(order.signal || order, this.cache.getBook(order.tokenId) || book, order).sophieExecutionQuality,
      }))
      .sort((a, b) => a.quality - b.quality);

    const weakest = eligible[0] || null;
    const weakestQuality = weakest ? weakest.quality : 1;
    const improvement = quality.sophieExecutionQuality - weakestQuality;

    if (
      this.config.sophieSlotEvictionEnabled &&
      weakest &&
      improvement > this.config.sophieSlotEvictionMinImprovement
    ) {
      this.portfolio.cancelOrder(weakest.id);
      this.portfolio.recordExecutionEvent('slot_evict', signal);
      this.recordSophieAdmission(signal, quality);
      quality.qualityDecision = 'EVICT_ADMIT';
      this.lastSophieQualityDecision = quality;
      warn(
        `[SOPHIE SLOT EVICT] evict=${weakest.order.side.toUpperCase()} ${shortId(weakest.order.tokenId)} ` +
        `quality=${weakestQuality.toFixed(2)} admit=${signal.side.toUpperCase()} ${shortId(signal.tokenId)} ` +
        `quality=${quality.sophieExecutionQuality.toFixed(2)} improvement=${improvement.toFixed(2)}`
      );
      return true;
    }

    quality.qualityDecision = 'BLOCK_SLOT';
    this.lastSophieQualityDecision = quality;
    this.portfolio.recordExecutionEvent('max_open_orders_block', signal);
    warn(
      `[SOPHIE SLOT BLOCK] reason=max_open_orders candidateQuality=${quality.sophieExecutionQuality.toFixed(2)} ` +
      `weakestOpenQuality=${weakestQuality.toFixed(2)}`
    );
    return false;
  }

  shouldSuppressDustExit(signal) {
    if (!this.config.dustExitSuppressEnabled) return false;
    if (!signal || signal.side !== 'sell') return false;
    if (!Number.isFinite(signal.price) || signal.price <= 0) return false;

    const availableSellQty = this.portfolio.availablePositionQty(signal.tokenId);
    const availableSellUsd = availableSellQty * signal.price;
    const requestedSellUsd = Number.isFinite(Number(signal.sizeUsd))
      ? Math.max(0, Math.min(Number(signal.sizeUsd), availableSellUsd))
      : availableSellUsd;
    const gabagoolPolicy = gabagoolDustExitPolicy(signal, this.portfolio, this.config);
    if (gabagoolPolicy.eligible) {
      return requestedSellUsd > 0 && requestedSellUsd < gabagoolPolicy.minDustExitUsd;
    }
    const reduceOnlyPolicy = reduceOnlyPaperExitPolicy(signal, this.portfolio, this.config);
    if (reduceOnlyPolicy.eligible) {
      return requestedSellUsd > 0 && requestedSellUsd < reduceOnlyPolicy.minReduceOnlyExitUsd;
    }
    return requestedSellUsd > 0 && requestedSellUsd < this.risk.minOrderUsdForSignal(signal);
  }

  suppressDustExit(signal) {
    const availableSellQty = this.portfolio.availablePositionQty(signal.tokenId);
    const availableSellUsd = availableSellQty * signal.price;
    const requestedSellUsd = Number.isFinite(Number(signal.sizeUsd))
      ? Math.max(0, Math.min(Number(signal.sizeUsd), availableSellUsd))
      : availableSellUsd;
    const cooldownMs = Math.max(0, this.config.dustExitLogCooldownMs || 0);
    const cooldownSec = Math.round(cooldownMs / 1000);
    const minOrderUsd = this.risk.minOrderUsdForSignal(signal);
    const key = `${signal.strategy}:${signal.side}:${signal.tokenId}`;
    const now = Date.now();
    const last = this.dustExitLastLogged.get(key) || 0;
    const dustExitPolicy = gabagoolDustExitPolicy(signal, this.portfolio, this.config);
    const reduceOnlyExitPolicy = reduceOnlyPaperExitPolicy(signal, this.portfolio, this.config);
    let suppressReason = 'dust_exit_suppressed';
    if (dustExitPolicy.eligible) {
      suppressReason = dustExitPolicy.belowDustFloor ? 'gabagool_dust_exit_below_floor' : 'dust_exit_below_min';
    } else if (reduceOnlyExitPolicy.eligible) {
      suppressReason = reduceOnlyExitPolicy.belowDustFloor
        ? 'reduce_only_exit_below_dust_floor'
        : 'reduce_only_exit_below_min';
    }

    this.lastDustExitSuppressed = {
      reason: suppressReason,
      strategy: signal.strategy,
      side: signal.side,
      tokenId: signal.tokenId,
      availableSellQty,
      availableSellUsd,
      requestedSellUsd,
      minOrderUsd,
      cooldownSec,
    };
    if (dustExitPolicy.eligible) {
      this.recordGabagoolMetric('gabagool_dust_exit_suppressed', {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        marketSlug: signal.metadata?.marketSlug,
        outcome: signal.metadata?.outcome,
        side: signal.side,
        price: signal.price,
        sizeUsd: requestedSellUsd,
        expectedEdge: signal.expectedEdge,
        confidence: signal.confidence,
        reason: suppressReason,
      });
    }
    this.portfolio.recordExecutionEvent('dust_exit_blocked', {
      strategy: signal.strategy,
      tokenId: signal.tokenId,
      marketId: signal.marketId,
      marketSlug: signal.metadata?.marketSlug,
      outcome: signal.metadata?.outcome,
      side: signal.side,
      price: signal.price,
      sizeUsd: requestedSellUsd,
      reason: suppressReason,
      availableSellQty,
      currentValueUsd: availableSellUsd,
      roundedExitSizeUsd: requestedSellUsd,
    });

    if (now - last >= cooldownMs) {
      this.dustExitLastLogged.set(key, now);
      warn(
        `[DUST EXIT BLOCK] reason=${suppressReason} token=${shortId(signal.tokenId)} ` +
        `qty=${fmtCount(availableSellQty, 6)} bid=${fmtPrice(signal.price)} valueUsd=${fmtMoney(availableSellUsd)} ` +
        `requestedSellUsd=${cleanLogValue(requestedSellUsd)} minOrderUsd=${cleanLogValue(minOrderUsd)} ` +
        `strategy=${signal.strategy || 'UNKNOWN'} cooldownSec=${cooldownSec}`
      );
      info(
        `[DUST EXIT] token=${shortId(signal.tokenId)} qty=${fmtCount(availableSellQty, 6)} ` +
        `valueUsd=${fmtMoney(availableSellUsd)} bid=${fmtPrice(signal.price)} action=skipped`
      );
    }
  }

  maybeWriteLiveCandidate(signal, asset, book) {
    if (!this.config.autoLiveCandidatesEnabled) return false;
    if (!signal || !asset || !book) return false;

    const strategy = String(signal.strategy || '');
    const allowed = new Set(this.config.autoLiveAllowedStrategies || []);
    const blocked = new Set(this.config.autoLiveBlockedStrategies || []);
    const side = String(signal.side || '').toUpperCase();
    const bookAgeMs = Date.now() - (book.cachedAt || 0);
    const bookFresh = isBookComplete(book) && bookAgeMs <= this.config.autoLiveMaxBookAgeMs;
    const consensus = signal.metadata?.consensus || null;

    if (blocked.has(strategy)) return false;
    if (allowed.size > 0 && !allowed.has(strategy)) return false;
    if (!signal.tokenId) return false;
    if (!['BUY', 'SELL'].includes(side)) return false;
    if (!Number.isFinite(signal.price) || signal.price <= 0 || signal.price >= 1) return false;
    if (!Number.isFinite(signal.sizeUsd) || signal.sizeUsd <= 0) return false;
    if (!Number.isFinite(signal.confidence) || signal.confidence < this.config.autoLiveMinConfidence) return false;
    if (!bookFresh) return false;
    if (this.config.enableConsensus && consensus?.authorized !== true) return false;

    const ghostTotal = this.portfolio.ghostStats?.total || 0;
    const ghostFavorablePct = ghostTotal > 0
      ? (this.portfolio.ghostStats.favorable / Math.max(1, ghostTotal)) * 100
      : null;

    if (
      Number.isFinite(ghostFavorablePct) &&
      this.config.autoLiveMinGhostFavorablePct > 0 &&
      ghostFavorablePct < this.config.autoLiveMinGhostFavorablePct
    ) {
      return false;
    }

    const key = `${signal.tokenId}:${side}:${strategy}`;
    const last = this.autoLiveCandidateLastWritten.get(key) || 0;
    if (Date.now() - last < this.config.autoLiveCandidateCooldownMs) return false;
    this.autoLiveCandidateLastWritten.set(key, Date.now());

    const candidateId = `moneymaker_${Date.now()}_${shortId(signal.tokenId).replace(/\W/g, '')}`;
    const route = consensus?.route ? `${consensus.route.mode}:${consensus.route.state}` : 'UNKNOWN';
    const paperBurnIn = {
      ok: true,
      reports: this.cycle,
      closedPnlUsd: Number(this.portfolio.closedPnl || 0),
      drawdownPct: Number(this.portfolio.drawdownPct(this.cache.markPrices()) || 0),
      ghostFavorablePct: Number.isFinite(ghostFavorablePct) ? Number(ghostFavorablePct.toFixed(2)) : null,
    };

    const expectedEdge = Number(signal.expectedEdge);
    if (!Number.isFinite(expectedEdge)) {
      info(`[AUTO-LIVE CANDIDATE SKIP] ${side} ${shortId(signal.tokenId)} reason=expected_edge_missing [${strategy}]`);
      return false;
    }

    const minOrderSize = Number(
      book.minOrderSize ??
      book.min_order_size ??
      book.minimum_order_size ??
      asset.minOrderSize ??
      asset.min_order_size ??
      5
    );
    const sizeUsd = Number(signal.sizeUsd);
    const price = Number(signal.price);
    const sizeShares = sizeUsd / price;
    if (
      Number.isFinite(minOrderSize) &&
      minOrderSize > 0 &&
      Number.isFinite(sizeShares) &&
      sizeShares < minOrderSize
    ) {
      info(
        `[AUTO-LIVE CANDIDATE SKIP] ${side} ${shortId(signal.tokenId)} reason=size_below_min_order ` +
        `sizeShares=${cleanLogValue(sizeShares)} minOrderSize=${cleanLogValue(minOrderSize)} ` +
        `price=${fmtPrice(price)} sizeUsd=$${sizeUsd.toFixed(2)} [${strategy}]`
      );
      return false;
    }

    // Stage 2 canary exposure cap check
    const maxOrderUsd = Number(process.env.MAX_LIVE_ORDER_USD) || 1;
    const maxTotalExposureUsd = Number(process.env.MAX_LIVE_TOTAL_EXPOSURE_USD) || 1;
    const currentLiveExposureUsd = Number(this.currentLiveExposureUsd || 0);
    if (sizeUsd > maxOrderUsd) {
      info(
        `[AUTO-LIVE CANDIDATE SKIP] ${side} ${shortId(signal.tokenId)} reason=canary_max_order_exceeded ` +
        `sizeUsd=$${sizeUsd.toFixed(2)} maxOrderUsd=$${maxOrderUsd.toFixed(2)} [${strategy}]`
      );
      return false;
    }
    if (currentLiveExposureUsd + sizeUsd > maxTotalExposureUsd) {
      info(
        `[AUTO-LIVE CANDIDATE SKIP] ${side} ${shortId(signal.tokenId)} reason=canary_exposure_cap_exceeded ` +
        `currentExposure=$${currentLiveExposureUsd.toFixed(2)} sizeUsd=$${sizeUsd.toFixed(2)} ` +
        `maxTotalExposureUsd=$${maxTotalExposureUsd.toFixed(2)} [${strategy}]`
      );
      return false;
    }

    const riskApproved = Boolean(signal._riskApproved);
    if (!riskApproved) {
      info(
        `[AUTO-LIVE CANDIDATE SKIP] ${side} ${shortId(signal.tokenId)} reason=risk_not_approved ` +
        `strategy=${strategy} price=${fmtPrice(price)} sizeUsd=$${sizeUsd.toFixed(2)} expectedEdge=${cleanLogValue(expectedEdge)}`
      );
      return false;
    }

    const marketSlug = asset.market?.slug || signal.metadata?.marketSlug || signal.metadata?.market_slug || null;
    const marketQuestion = asset.market?.question || signal.metadata?.marketQuestion || signal.metadata?.market_question || null;
    const outcome = asset.outcome || signal.metadata?.outcome || null;

    const candidate = {
      id: candidateId,
      candidate_id: candidateId,
      timestamp: nowIso(),
      source: 'MONEYMAKER',
      strategy,
      tokenId: signal.tokenId,
      token_id: signal.tokenId,
      marketId: signal.marketId || asset.market?.marketId || null,
      market_id: signal.marketId || asset.market?.marketId || null,
      side,
      price,
      sizeUsd,
      size_usd: sizeUsd,
      sizeShares: Number.isFinite(sizeShares) ? sizeShares : null,
      size_shares: Number.isFinite(sizeShares) ? sizeShares : null,
      confidence: Number(signal.confidence),
      consensusScore: Number(consensus?.score ?? signal.confidence),
      consensus_score: Number(consensus?.score ?? signal.confidence),
      expectedEdge,
      expected_edge: expectedEdge,
      sophieApproved: true,
      sophie_approved: true,
      riskApproved: true,
      risk_approved: true,
      bookFresh: true,
      book_fresh: true,
      bookAgeMs,
      book_age_ms: bookAgeMs,
      minOrderSize: Number.isFinite(minOrderSize) && minOrderSize > 0 ? Number(minOrderSize) : null,
      min_order_size: Number.isFinite(minOrderSize) && minOrderSize > 0 ? Number(minOrderSize) : null,
      marketSlug,
      market_slug: marketSlug,
      marketQuestion,
      market_question: marketQuestion,
      outcome,
      reason: signal.reason || 'MoneyMaker paper-approved candidate',
      route,
      paperBurnIn,
      metadata: {
        marketQuestion,
        outcome,
        expectedEdge,
        riskApproved: true,
        risk_approved: true,
        consensus,
      },
    };

    appendJsonLine(this.config.autoLiveCandidatesPath, candidate);
    info(
      `[AUTO-LIVE CANDIDATE WRITTEN] ${side} ${shortId(signal.tokenId)} @ ${fmtPrice(price)} ` +
      `sizeUsd=$${sizeUsd.toFixed(2)} sizeShares=${cleanLogValue(sizeShares)} minOrderSize=${cleanLogValue(minOrderSize)} ` +
      `expectedEdge=${cleanLogValue(expectedEdge)} confidence=${cleanLogValue(signal.confidence)} ` +
      `riskApproved=true bookAgeMs=${bookAgeMs} [${strategy}]`
    );
    return true;
  }

  report(markPrices = this.cache.markPrices()) {
    this.syncPortfolioMarks(markPrices);
    const equity = this.portfolio.equity(markPrices);
    const drawdown = this.portfolio.drawdownPct(markPrices);

    info('--- PORTFOLIO REPORT ---');
    info(`Equity: $${equity.toFixed(2)} | Cash: $${this.portfolio.cash.toFixed(2)} | Drawdown: ${drawdown.toFixed(2)}%`);
    info(`Open Orders: ${this.portfolio.openOrders.size} | Exposure: $${this.portfolio.totalExposureUsd(markPrices).toFixed(2)} | Closed PnL: $${this.portfolio.closedPnl.toFixed(2)}`);
    info(`Position Exposure: $${this.portfolio.positionExposureUsd(markPrices).toFixed(2)} | Open Order Exposure: $${this.portfolio.openOrderExposureUsd().toFixed(2)} | Available Cash: $${this.portfolio.availableCash().toFixed(2)}`);

    const dust = this.portfolio.dustSummary(markPrices);
    info(`Dust Positions: count=${dust.count} value=$${dust.valueUsd.toFixed(2)}`);
    const now = Date.now();
    const btcLedger = this.portfolio.strategyLedger(isBtcOracleStrategy, markPrices, now);
    const standardLedger = this.portfolio.strategyLedger((strategy) => !isBtcOracleStrategy(strategy), markPrices, now);
    const spreadHunterLedger = this.portfolio.strategyLedger((strategy) => resolveStrategyName(strategy) === 'SpreadHunter', markPrices, now);
    const pnlBreakdown = this.portfolio.pnlBreakdownByStrategy(markPrices, now);

    const health = this.portfolio.executionHealth();
    const burnInLifecycle = this.portfolio.burnInLifecycleState(now);
    const gabagoolDrawdownBreakdown = this.portfolio.gabagoolDrawdownBreakdown(markPrices, now);
    info(
      `Execution Health: candidateEvaluationsLastHour=${health.candidateEvaluationsLastHour} ` +
      `paperOrdersPlacedLastHour=${health.paperOrdersPlacedLastHour} ` +
      `paperOrdersFilledLastHour=${health.paperOrdersFilledLastHour} ` +
      `paperOrdersExpiredNoFillLastHour=${health.paperOrdersExpiredNoFillLastHour} ` +
      `paperOrdersAdmittedLastHour=${health.paperOrdersAdmittedLastHour} ` +
      `paperOrdersRejectedBySophieLastHour=${health.paperOrdersRejectedBySophieLastHour} ` +
      `activePaperOrders=${health.activePaperOrders} ` +
      `ordersPlacedLastHour=${health.ordersPlacedLastHour} ` +
      `fillsLastHour=${health.fillsLastHour} duplicateSkipsLastHour=${health.duplicateSkipsLastHour} ` +
      `replacementsLastHour=${health.replacementsLastHour} ` +
      `oldestOpenOrderAgeSec=${Math.round(health.oldestOpenOrderAgeSec)} ` +
      `avgOpenOrderAgeSec=${Math.round(health.avgOpenOrderAgeSec)} ` +
      `avgActiveOrderAgeSec=${Math.round(health.avgActiveOrderAgeSec)} ` +
      `noFillStreakMax=${health.noFillStreakMax} ` +
      `avgTimeToFillSec=${health.avgTimeToFillSec == null ? 'NA' : Math.round(health.avgTimeToFillSec)} ` +
      `maxOpenOrderBlocksLastHour=${health.maxOpenOrderBlocksLastHour} ` +
      `fillRateLastHour=${health.fillRateLastHour.toFixed(1)}% ` +
      `fillRateByPlacedOrdersLastHour=${health.fillRateByPlacedOrdersLastHour.toFixed(1)}%`
    );
    info(
      `PnL Trust: trustedClosedPnl=$${Number(btcLedger.trustedClosedPnl || 0).toFixed(2)} ` +
      `untrustedClosedPnl=$${Number(btcLedger.untrustedClosedPnl || 0).toFixed(2)} ` +
      `trustedOpenPnl=$${Number(btcLedger.trustedOpenPnl || 0).toFixed(2)} ` +
      `untrustedOpenPnl=$${Number(btcLedger.untrustedOpenPnl || 0).toFixed(2)}`
    );
    info(
      `Strategy PnL: btcGabagoolClosed=$${Number(btcLedger.closedPnl || 0).toFixed(2)} ` +
      `btcGabagoolTrustedClosed=$${Number(btcLedger.trustedClosedPnl || 0).toFixed(2)} ` +
      `spreadHunterClosed=$${Number(spreadHunterLedger.closedPnl || 0).toFixed(2)} ` +
      `spreadHunterTrustedClosed=$${Number(spreadHunterLedger.trustedClosedPnl || 0).toFixed(2)}`
    );
    info(
      `Fill Realism: paperRealisticFills=${this.config.paperRealisticFills === true ? 'true' : 'false'} ` +
      `avgFillDelayMs=${health.avgFillDelayMs == null ? 'NA' : Math.round(health.avgFillDelayMs)} ` +
      `zeroSecondFillCountLastHour=${health.zeroSecondFillCountLastHour} ` +
      `invalidUntrustedFillCountLastHour=${health.invalidOrUntrustedFillCountLastHour} ` +
      `trustedFillCountLastHour=${health.trustedFillCountLastHour} ` +
      `untrustedFillCountLastHour=${health.untrustedFillCountLastHour} ` +
      `fillCountsBySource=${formatFillSourceCounts(health.fillCountsBySourceLastHour)}`
    );
    if (health.lastFillAudit) {
      info(
        `Last Fill Audit: fillSource=${health.lastFillAudit.fillSource || 'unknown'} ` +
        `fillDelayMs=${health.lastFillAudit.fillDelayMs == null ? 'NA' : Math.round(health.lastFillAudit.fillDelayMs)} ` +
        `bookAgeMs=${health.lastFillAudit.bookAgeMs == null ? 'NA' : Math.round(health.lastFillAudit.bookAgeMs)} ` +
        `bestBidAtPlacement=${fmtPrice(health.lastFillAudit.bestBidAtPlacement)} ` +
        `bestAskAtPlacement=${fmtPrice(health.lastFillAudit.bestAskAtPlacement)} ` +
        `bestBidAtFill=${fmtPrice(health.lastFillAudit.bestBidAtFill)} ` +
        `bestAskAtFill=${fmtPrice(health.lastFillAudit.bestAskAtFill)} ` +
        `orderPrice=${fmtPrice(health.lastFillAudit.orderPrice)} ` +
        `wasExecutableAtPlacement=${health.lastFillAudit.wasExecutableAtPlacement === true ? 'true' : 'false'} ` +
        `wasExecutableAtFill=${health.lastFillAudit.wasExecutableAtFill === true ? 'true' : 'false'} ` +
        `queueHaircutApplied=${cleanLogValue(health.lastFillAudit.queueHaircutApplied)} ` +
        `slippageApplied=${cleanLogValue(health.lastFillAudit.slippageApplied)} ` +
        `adverseSelectionBufferApplied=${cleanLogValue(health.lastFillAudit.adverseSelectionBufferApplied)} ` +
        `trustedPnl=${health.lastFillAudit.trustedPnl === true ? 'true' : 'false'}`
      );
    }
    info(
      `Loss Exit Audit: blockedLossExitCountLastHour=${health.gabagoolLossExitBlocksLastHour} ` +
      `repeatedBlockedLossExitCountLastHour=${health.gabagoolRepeatedBlockedLossExitCountLastHour} ` +
      `repeatedSameMarketSameTokenEntriesLastHour=${health.gabagoolRepeatedSameMarketSameTokenEntriesLastHour}`
    );
    info(
      `Exposure Split: portfolioExposure=$${Number(this.portfolio.totalExposureUsd(markPrices) || 0).toFixed(2)} ` +
      `capBlockingExposure=$${Number(health.capBlockingExposureUsd || 0).toFixed(2)} ` +
      `activeTradableExposure=$${Number(health.activeTradableExposureUsd || 0).toFixed(2)} ` +
      `staleNoBidExposure=$${Number(health.staleNoBidExposureUsd || 0).toFixed(2)} ` +
      `confirmedNoOrderbook404Exposure=$${Number(health.confirmedNoOrderbook404ExposureUsd || 0).toFixed(2)} ` +
      `expiredBtc5mExposure=$${Number(health.expiredBtc5mExposureUsd || 0).toFixed(2)} ` +
      `resolutionPendingExposure=$${Number(health.resolutionPendingExposureUsd || 0).toFixed(2)} ` +
      `dustExposure=$${Number(health.dustExposureUsd || 0).toFixed(2)} ` +
      `excludedDeadExposure=$${Number(health.excludedDeadExposureUsd || 0).toFixed(2)} ` +
      `excludedDeadExposureReasons=${health.excludedDeadExposureReasonSummary || 'none'}`
    );
    info(
      `Paper Cash Reserve: outstanding=$${Number(health.deadExposureCashReserveOutstandingUsd || 0).toFixed(2)} ` +
      `credits=$${Number(health.deadExposureCashReserveCreditsUsd || 0).toFixed(2)} ` +
      `repayments=$${Number(health.deadExposureCashReserveRepaymentsUsd || 0).toFixed(2)} ` +
      `releaseBatch=$${Number(this.config.paperDeadExposureCashReleaseBatchUsd || 0).toFixed(2)} ` +
      `triggerCash=$${Number(this.config.paperDeadExposureCashReleaseTriggerUsd || 0).toFixed(2)}`
    );
    info(
      `Gabagool Exit Blocks: exposureCap=${health.gabagoolExposureCapBlockedReasonCountsLastHour || 'none'} ` +
      `lastPlacementDecision=${health.gabagoolLastPlacementDecision || 'none'}`
    );
    info(
      `SpreadHunter Blocks: ghost=${health.spreadHunterGhostBlocksLastHour} ` +
      `sophie=${health.spreadHunterSophieBlocksLastHour} ` +
      `confidence=${health.spreadHunterConfidenceBlocksLastHour} ` +
      `cooldown=${health.spreadHunterCooldownBlocksLastHour} ` +
      `executionRealism=${health.spreadHunterExecutionRealismBlocksLastHour}`
    );
    info(
      `Paper Flow: totalOrders=${health.paperOrdersPlacedLastHour} ` +
      `whyTotalOrdersZero=${health.whyTotalOrdersZeroLastHour || 'none'} ` +
      `topBlockReasons=${health.topBlockReasonsLastHour || 'none'} ` +
      `probationAdmissions=${health.probationAdmissionsLastHour || 0} ` +
      `probationAdmissionsBeforeRisk=${health.probationAdmissionsBeforeRisk || 0} ` +
      `probationOrdersBlockedByDrawdown=${health.probationOrdersBlockedByDrawdown || 0} ` +
      `finalBlockerAfterProbation=${health.finalBlockerAfterProbation || 'none'} ` +
      `drawdownGateActive=${health.drawdownGateActive === true ? 'true' : 'false'} ` +
      `sophieAdmittedButRiskBlocked=${health.sophieAdmittedButRiskBlockedLastHour || 0} ` +
      `probationBlocks=${health.probationBlocksLastHour || 0}`
    );
    info(
      `Action Rate 15m: status=${health.actionRateStatus || 'action_rate_not_applicable'} ` +
      `ordersPlacedLast15m=${health.paperOrdersPlacedLast15m || 0} ` +
      `fillsLast15m=${health.paperOrdersFilledLast15m || 0} ` +
      `targetOrdersPer15m=${health.targetOrdersPer15m || 0} ` +
      `targetFillsPer15m=${health.targetFillsPer15m || 0} ` +
      `reason=${health.actionRateReason || 'none'} ` +
      `paperActionBurnInActive=${health.paperActionBurnInActive === true ? 'true' : 'false'}`
    );
    info(
      `Burn-In Lifecycle: status=${burnInLifecycle.lifecycleStatus || 'unknown'} ` +
      `reason=${burnInLifecycle.lifecycleReason || 'none'} ` +
      `freshStateRequired=${burnInLifecycle.freshStateRequired === true ? 'true' : 'false'} ` +
      `recommendedFreshStateFile=${burnInLifecycle.recommendedFreshStateFile || 'none'}`
    );
    info(
      `Strategy Orders 1h: ${Object.entries(health.strategyOrderCountsLastHour || {})
        .sort((a, b) => b[1] - a[1])
        .map(([strategy, count]) => `${strategy}:${count}`)
        .join(', ') || 'none'}`
    );
    info(
      `Live Safety: ENABLE_LIVE_TRADING=${this.config.enableLiveTrading === true ? 'true' : 'false'} ` +
      `LIVE_AUTO_EXECUTE=${this.config.liveAutoExecute === true ? 'true' : 'false'} ` +
      `LIVE_KILL_SWITCH=${this.config.liveKillSwitch === true ? 'true' : 'false'} ` +
      `LIVE_DRY_RUN_ONLY=${this.config.liveDryRunOnly === true ? 'true' : 'false'} ` +
      `LIVE_SUBMIT_CONFIRM=${this.config.liveSubmitConfirm === true ? 'true' : 'false'}`
    );
    info(
      `[MIXED MODE REPORT] btcOrdersLastHour=${health.gabagoolOrdersPlacedLastHour} ` +
      `standardOrdersLastHour=${Math.max(0, health.paperOrdersPlacedLastHour - health.gabagoolOrdersPlacedLastHour)} ` +
      `btcExposure=${fmtMoney(btcLedger.totalExposureUsd)} standardExposure=${fmtMoney(standardLedger.totalExposureUsd)} ` +
      `dustCount=${dust.count}`
    );
    info(
      `PnL By Strategy: ${Object.entries(pnlBreakdown.pnlByStrategy || {})
        .map(([strategy, value]) => (
          `${strategy}:closed=${fmtMoney(value.closedPnl)} open=${fmtMoney(value.openPnl)} net=${fmtMoney(value.netPnl)}`
        ))
        .join(' | ') || 'none'}`
    );
    info(
      `Gabagool Health: oracleSignalsReadLastHour=${health.oracleSignalsReadLastHour} ` +
      `oracleSignalsFreshLastHour=${health.oracleSignalsFreshLastHour} ` +
      `oracleSignalsExpiredLastHour=${health.oracleSignalsExpiredLastHour} ` +
      `oracleSignalsNotConfirmedLastHour=${health.oracleSignalsNotConfirmedLastHour} ` +
      `gabagoolCandidatesBuiltLastHour=${health.gabagoolCandidatesBuiltLastHour} ` +
      `gabagoolZeroSizeBlockedLastHour=${health.gabagoolZeroSizeBlockedLastHour} ` +
      `gabagoolSophieEvaluatedLastHour=${health.gabagoolSophieEvaluatedLastHour} ` +
      `gabagoolSophieAdmittedLastHour=${health.gabagoolSophieAdmittedLastHour} ` +
      `gabagoolSophieBlockedLastHour=${health.gabagoolSophieBlockedLastHour} ` +
      `gabagoolRiskEvaluatedLastHour=${health.gabagoolRiskEvaluatedLastHour} ` +
      `gabagoolRiskAdmittedLastHour=${health.gabagoolRiskAdmittedLastHour} ` +
      `gabagoolRiskBlockedLastHour=${health.gabagoolRiskBlockedLastHour} ` +
      `gabagoolPlacementAttemptedLastHour=${health.gabagoolPlacementAttemptedLastHour} ` +
      `gabagoolPlacementBlockedLastHour=${health.gabagoolPlacementBlockedLastHour} ` +
      `gabagoolOrdersPlacedLastHour=${health.gabagoolOrdersPlacedLastHour} ` +
      `gabagoolDustExitsLastHour=${health.gabagoolDustExitsLastHour} ` +
      `gabagoolDustExitsSuppressedLastHour=${health.gabagoolDustExitsSuppressedLastHour} ` +
      `gabagoolProfitExitsLastHour=${health.gabagoolProfitExitsLastHour} ` +
      `gabagoolLossExitsLastHour=${health.gabagoolLossExitsLastHour} ` +
      `gabagoolInventoryReducesLastHour=${health.gabagoolInventoryReducesLastHour} ` +
      `gabagoolTelegramSuppressedLastHour=${health.gabagoolTelegramSuppressedLastHour} ` +
      `gabagoolPlacementBlockReasonLast=${health.gabagoolPlacementBlockReasonLast || 'none'} ` +
      `gabagoolLastRiskBlockReason=${health.gabagoolLastRiskBlockReason || 'none'} ` +
      `gabagoolLastSophieBlockReason=${health.gabagoolLastSophieBlockReason || 'none'} ` +
      `gabagoolLastPlacementDecision=${health.gabagoolLastPlacementDecision || 'none'} ` +
      `gabagoolLastExitClassification=${health.gabagoolLastExitClassification || 'none'} ` +
      `gabagoolLastExitPnl=${fmtMoney(health.gabagoolLastExitPnl)}`
    );
    info(
      `Gabagool Drawdown Breakdown: entriesBeforeDrawdownBreach=${gabagoolDrawdownBreakdown.entriesBeforeDrawdownBreach} ` +
      `averageEntryPriceBeforeDrawdownBreach=${fmtPrice(gabagoolDrawdownBreakdown.averageEntryPriceBeforeDrawdownBreach)} ` +
      `lastExitClassification=${gabagoolDrawdownBreakdown.lastExitClassification || 'none'} ` +
      `lossPerMarketToken=${gabagoolDrawdownBreakdown.lossPerMarketToken || 'none'} ` +
      `lossGuardTriggeredTooLate=${gabagoolDrawdownBreakdown.lossGuardTriggeredTooLate === true ? 'true' : 'false'} ` +
      `repeatedEntriesAlreadyBlocked=${gabagoolDrawdownBreakdown.repeatedEntriesAlreadyBlocked === true ? 'true' : 'false'}`
    );

    if (
      this.portfolio.openOrders.size > 0 &&
      health.fillsLastHour === 0 &&
      health.oldestOpenOrderAgeSec >= this.config.fillStarvationWarnMs / 1000 &&
      Date.now() - this.lastFillStarvationWarningAt >= this.config.fillStarvationWarnMs
    ) {
      this.lastFillStarvationWarningAt = Date.now();
      warn(
        `[ENGINE STARVATION WARNING] openOrders=${this.portfolio.openOrders.size} ` +
        `oldestOpenOrderAgeSec=${Math.round(health.oldestOpenOrderAgeSec)} fillsLastHour=0 reason=no_recent_fills`
      );
    }

    if (this.portfolio.ghostStats.total > 0) {
      const favorableRate = (this.portfolio.ghostStats.favorable / this.portfolio.ghostStats.total) * 100;
      info(`Ghost calibration: total=${this.portfolio.ghostStats.total} favorable=${favorableRate.toFixed(1)}% unfavorable=${this.portfolio.ghostStats.unfavorable}`);
    }

    const positions = this.portfolio.topPositions(markPrices, 10);
    if (positions.length > 0) {
      for (const pos of positions) {
        info(`POS ${shortId(pos.tokenId)} qty=${pos.qty.toFixed(4)} avg=${fmtPrice(pos.avg)} mark=${fmtPrice(pos.mark)} value=$${pos.value.toFixed(2)}`);
      }
    }

    const openOrders = this.portfolio.topOpenOrders(8);
    if (openOrders.length > 0) {
      for (const order of openOrders) {
        info(`OPEN ${order.side.toUpperCase()} ${shortId(order.tokenId)} @ ${fmtPrice(order.price)} remaining=$${order.remainingUsd.toFixed(2)} age=${Math.round(order.ageMs / 1000)}s [${order.strategy}]`);
      }
    }

    const strategyExposure = this.portfolio.strategyOpenOrderExposure();
    if (strategyExposure.length > 0) {
      info(`Open Order Exposure by Strategy: ${strategyExposure.map((x) => `${x.strategy}=$${x.exposureUsd.toFixed(2)}`).join(' | ')}`);
    }
  }
}

// =========================
// MATH / FORMAT UTILITIES
// =========================

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function roundToTick(value, tick) {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(tick) || tick <= 0) return value;
  return Math.round(value / tick) * tick;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function numericOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isProtectiveExitStrategy(strategy) {
  return ['InventoryExit', 'StopLossExit', 'TakeProfitExit'].includes(strategy);
}

function isReduceOnlyPaperExitSignal(signal) {
  if (String(signal?.side || '').toLowerCase() !== 'sell') return false;
  if (signal?.metadata?.reduceOnly === true) return true;
  if (isProtectiveExitStrategy(resolveStrategyName(signal))) return true;
  return (
    signal?.metadata?.exitMode === 'loss_guard_reduce_only' ||
    signal?.metadata?.exitMode === 'exposure_cap_reduce_only' ||
    signal?.metadata?.gabagool?.exitMode === 'loss_guard_reduce_only' ||
    signal?.metadata?.gabagool?.exitMode === 'exposure_cap_reduce_only' ||
    signal?.metadata?.gabagool?.exitTrigger === 'loss_guard_reduce_only' ||
    signal?.metadata?.gabagool?.exitTrigger === 'exposure_cap_reduce_only'
  );
}

function shortId(value) {
  const s = String(value || '');
  if (s.length <= 10) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function fmtPrice(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `$${Number(value).toFixed(3)}`;
}

function fmtMoney(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `$${Number(value).toFixed(2)}`;
}

function fmtCount(value, digits = 2) {
  if (value === null || value === undefined || value === '') return 'n/a';
  if (!Number.isFinite(Number(value))) return 'n/a';
  return Number(value).toFixed(digits);
}

function formatLargestExposurePositions(positions = []) {
  if (!Array.isArray(positions) || positions.length === 0) return 'none';
  return positions.map((item) => (
    `${shortId(item.tokenId)}:${item.outcome || 'n/a'} ` +
    `total=${fmtMoney(item.totalExposureUsd)} pos=${fmtMoney(item.positionExposureUsd)} ` +
    `open=${fmtMoney(item.openOrderExposureUsd)} avg=${fmtPrice(item.avgEntryPrice)} ` +
    `mark=${fmtPrice(item.mark)} qty=${fmtCount(item.qty, 4)} ` +
    `market=${item.marketSlug || 'n/a'}`
  )).join(' | ');
}

function fmtPercent(value, digits = 2) {
  if (value === null || value === undefined || value === '') return 'n/a';
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `${Number(value).toFixed(digits)}%`;
}

function fmtRatioPercent(value, digits = 2) {
  if (value === null || value === undefined || value === '') return 'n/a';
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function averageFinite(values = []) {
  const finite = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function absNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : NaN;
}

function maxFinite(...values) {
  const finite = values.filter((value) => Number.isFinite(Number(value))).map((value) => Number(value));
  return finite.length > 0 ? Math.max(...finite) : NaN;
}

function cleanLogValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  if (value === undefined) return null;
  return value;
}

function formatBool(value) {
  return value === true ? 'true' : 'false';
}

function formatFlagState(value) {
  if (typeof value === 'string') return value;
  return formatBool(value === true);
}

function booleanOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function envFlagEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function formatTimestampValue(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return String(value);
}

function formatGabagoolConfirmCheck(confirmCheck = null) {
  if (!confirmCheck || typeof confirmCheck !== 'object') return 'n/a';
  const fields = [
    `fresh=${formatBool(confirmCheck.freshnessPass === true)}`,
    `expiry=${formatBool(confirmCheck.expiryPass === true)}`,
    `market=${formatBool(confirmCheck.marketPass === true)}`,
    `token=${formatBool(confirmCheck.tokenPass === true)}`,
    `outcome=${formatBool(confirmCheck.outcomePass === true)}`,
    `action=${formatBool(confirmCheck.actionPass === true)}`,
    `price=${formatBool(confirmCheck.pricePass === true)}`,
    `edge=${formatBool(confirmCheck.edgePass === true)}`,
    `btcMove=${formatBool(confirmCheck.btcMovePass === true)}`,
    `persistence=${formatBool(confirmCheck.persistencePass === true)}`,
  ];
  if (confirmCheck.blockReason) fields.push(`reason=${confirmCheck.blockReason}`);
  if (Number.isFinite(Number(confirmCheck.observedBtcMovePct))) {
    fields.push(`btcMovePct=${cleanLogValue(confirmCheck.observedBtcMovePct)}`);
  }
  if (Number.isFinite(Number(confirmCheck.observedPersistenceMovePct))) {
    fields.push(`persistedMovePct=${cleanLogValue(confirmCheck.observedPersistenceMovePct)}`);
  }
  if (Number.isFinite(Number(confirmCheck.expectedEdge))) {
    fields.push(`expectedEdge=${cleanLogValue(confirmCheck.expectedEdge)}`);
  }
  return fields.join('|');
}

function resolveStrategyName(candidate) {
  if (typeof candidate === 'string') return candidate.trim();
  if (!candidate || typeof candidate !== 'object') return '';
  const candidates = [
    candidate.strategy,
    candidate.strategyName,
    candidate.metadata?.strategy,
    candidate.metadata?.strategyName,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isBtcOracleStrategy(strategy) {
  const normalized = resolveStrategyName(strategy);
  if (!normalized) return false;
  if (normalized === 'GabagoolBtcOracleStrategy' || normalized === 'BtcOracleScalpStrategy') return true;
  return /btc.*oracle|oracle.*btc/i.test(normalized);
}

function isStandardPaperStrategy(strategy) {
  const normalized = resolveStrategyName(strategy);
  return Boolean(normalized) && !isBtcOracleStrategy(normalized);
}

function isGabagoolStrategy(strategy) {
  return resolveStrategyName(strategy) === 'GabagoolBtcOracleStrategy';
}

function minSignalEdgeForCandidate(signal, config = {}) {
  const globalMinEdge = Math.max(0, Number(config?.minSignalEdge || 0));
  const standardMinEdge = Math.max(0, Number(config?.standardMinSignalEdge ?? globalMinEdge));
  const strategy = resolveStrategyName(signal);
  if (!strategy) return globalMinEdge;
  if (strategy === 'GabagoolBtcOracleStrategy') {
    return Math.max(0, Number(config?.gabagoolMinExpectedEdge ?? globalMinEdge));
  }
  if (strategy === 'SpreadHunter') {
    return standardMinEdge;
  }
  if (strategy === 'ComplementArb') {
    const complementFloor = Math.max(0, Number(config?.complementArbMinEdge || 0) / 2);
    return Math.max(standardMinEdge, complementFloor);
  }
  return globalMinEdge;
}

function gabagoolDustExitPolicy(signal, portfolio, config) {
  const configuredMinDustExitUsd = Number(
    config?.gabagoolMinDustExitUsd || (config?.enableLiveTrading === true ? 0.05 : 0.01)
  );
  const minDustExitUsd = Math.max(0.01, configuredMinDustExitUsd);
  const minOrderUsd = Math.max(0.01, Number(config?.minOrderUsd || 0));
  if (!config?.enableGabagoolBtcImitation || config?.gabagoolAllowDustExits !== true) {
    return { eligible: false, minDustExitUsd, minOrderUsd };
  }
  if (!isGabagoolStrategy(signal)) return { eligible: false, minDustExitUsd, minOrderUsd };
  if (String(signal?.side || '').toLowerCase() !== 'sell') return { eligible: false, minDustExitUsd, minOrderUsd };
  const price = Number(signal?.price);
  if (!Number.isFinite(price) || price <= 0) return { eligible: false, minDustExitUsd, minOrderUsd };
  const availableQtyOverride = Number(signal?.metadata?.availableSellQtyOverride ?? signal?.availableSellQtyOverride);
  const availableQty = Number.isFinite(availableQtyOverride) && availableQtyOverride > 0
    ? availableQtyOverride
    : Number(portfolio?.availablePositionQty?.(signal?.tokenId) ?? portfolio?.position?.(signal?.tokenId) ?? 0);
  if (!(availableQty > 0)) return { eligible: false, minDustExitUsd, minOrderUsd };
  const availableSellUsd = availableQty * price;
  const rawRequestedSellUsd = Number(signal?.sizeUsd);
  const requestedSellUsd = Number.isFinite(rawRequestedSellUsd)
    ? Math.max(0, Math.min(rawRequestedSellUsd, availableSellUsd))
    : availableSellUsd;
  return {
    eligible: true,
    minDustExitUsd,
    minOrderUsd,
    availableQty,
    availableSellUsd,
    requestedSellUsd,
    isDustExit: requestedSellUsd > 0 && requestedSellUsd < minOrderUsd,
    belowDustFloor: requestedSellUsd > 0 && requestedSellUsd < minDustExitUsd,
  };
}

function reduceOnlyPaperExitPolicy(signal, portfolio, config) {
  const configuredMinExitUsd = Number(config?.reduceOnlyMinExitUsd || 0.01);
  const minReduceOnlyExitUsd = Math.max(0.01, configuredMinExitUsd);
  if (String(signal?.side || '').toLowerCase() !== 'sell') {
    return { eligible: false, minReduceOnlyExitUsd };
  }
  const price = Number(signal?.price);
  if (!Number.isFinite(price) || price <= 0) {
    return { eligible: false, minReduceOnlyExitUsd };
  }
  const availableQtyOverride = Number(signal?.metadata?.availableSellQtyOverride ?? signal?.availableSellQtyOverride);
  const availableQty = Number.isFinite(availableQtyOverride) && availableQtyOverride > 0
    ? availableQtyOverride
    : Number(portfolio?.availablePositionQty?.(signal?.tokenId) ?? portfolio?.position?.(signal?.tokenId) ?? 0);
  if (!(availableQty > 0)) {
    return { eligible: false, minReduceOnlyExitUsd };
  }
  const availableSellUsd = availableQty * price;
  const rawRequestedSellUsd = Number(signal?.sizeUsd);
  const requestedSellUsd = Number.isFinite(rawRequestedSellUsd)
    ? Math.max(0, Math.min(rawRequestedSellUsd, availableSellUsd))
    : availableSellUsd;
  const explicitReduceOnly = isReduceOnlyPaperExitSignal(signal);
  return {
    eligible: requestedSellUsd > 0,
    explicitReduceOnly,
    minReduceOnlyExitUsd,
    availableQty,
    availableSellUsd,
    requestedSellUsd,
    belowDustFloor: requestedSellUsd > 0 && requestedSellUsd < minReduceOnlyExitUsd,
  };
}

function classifyGabagoolExit({
  signal = null,
  filledUsd = null,
  avgEntryPrice = null,
  sellPrice = null,
  realizedPnl = null,
  positionQtyBefore = null,
  positionQtyAfter = null,
  minOrderUsd = null,
} = {}) {
  const usd = Number(filledUsd);
  const pnl = Number(realizedPnl);
  const beforeQty = Number(positionQtyBefore);
  const afterQty = Number(positionQtyAfter);
  const avgEntry = Number(avgEntryPrice);
  const sell = Number(sellPrice);
  const explicitLossExitAllowed =
    signal?.metadata?.reduceOnly === true ||
    signal?.metadata?.exitMode === 'loss_guard_reduce_only' ||
    signal?.metadata?.gabagool?.exitMode === 'loss_guard_reduce_only' ||
    signal?.metadata?.gabagool?.exitTrigger === 'loss_guard_reduce_only';
  if (!Number.isFinite(usd) || usd <= 0) return 'invalid_zero_size';
  if (Number.isFinite(avgEntry) && avgEntry > 0 && Number.isFinite(sell) && sell < avgEntry - 1e-9) {
    return explicitLossExitAllowed ? 'loss_exit' : 'blocked_loss_exit';
  }
  if (Number.isFinite(minOrderUsd) && usd < minOrderUsd) return 'dust_exit';
  if (Number.isFinite(pnl) && pnl > 1e-9) return 'profit_exit';
  if (Number.isFinite(pnl) && pnl < -1e-9) return 'loss_exit';
  if (
    signal?.metadata?.gabagool?.exitIntent === true ||
    (Number.isFinite(beforeQty) && Number.isFinite(afterQty) && afterQty < beforeQty)
  ) {
    return 'inventory_reduce';
  }
  return 'unknown_exit';
}

function formatRiskBlockDetails(details = {}) {
  const orderedKeys = [
    'expectedEdge',
    'minSignalEdge',
    'confidence',
    'minConfidence',
    'confidenceProfile',
    'thresholdSource',
    'gabagoolConfidenceMode',
    'paperConfidenceOverrideEligible',
    'paperConfidenceOverrideReason',
    'configuredGabagoolMinConfidence',
    'configuredGabagoolMinConfidenceLive',
    'sizeUsd',
    'minOrderUsd',
    'availableCash',
    'currentPositionQty',
    'availableSellQty',
    'currentPositionUsd',
    'riskTotalExposureUsd',
    'portfolioPositionExposureUsd',
    'portfolioOpenOrderExposureUsd',
    'btcOraclePositionExposureUsd',
    'btcOracleOpenOrderExposureUsd',
    'activeTradableExposureUsd',
    'staleNoBidExposureUsd',
    'confirmedNoOrderbook404ExposureUsd',
    'expiredBtc5mExposureUsd',
    'resolutionPendingExposureUsd',
    'dustExposureUsd',
    'capBlockingExposureUsd',
    'excludedDeadExposureUsd',
    'btcOracleActiveTradableExposureUsd',
    'btcOracleStaleNoBidExposureUsd',
    'btcOracleConfirmedNoOrderbook404ExposureUsd',
    'btcOracleExpiredBtc5mExposureUsd',
    'btcOracleResolutionPendingExposureUsd',
    'btcOracleDustExposureUsd',
    'nonBtcPositionExposureUsd',
    'nonBtcOpenOrderExposureUsd',
    'strategyBucket',
    'strategyBucketCapUsd',
    'strategyBucketExposureRawUsd',
    'strategyBucketExposureExclusionUsd',
    'strategyBucketExposureUsd',
    'strategyBucketWouldExposureUsd',
    'totalExposureUsd',
    'maxTotalExposureUsd',
    'exposureAvailableUsd',
    'candidateSizeUsd',
    'wouldTotalExposureUsd',
    'marketExposureUsd',
    'maxMarketExposureUsd',
    'maxPositionUsdPerAsset',
    'totalOpenOrderUsd',
    'maxTotalOpenOrderUsd',
    'openOrders',
    'maxOpenOrders',
    'drawdownPct',
    'maxDrawdownPct',
  ];

  return orderedKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(details, key))
    .map((key) => `${key}=${cleanLogValue(details[key])}`)
    .join(' ');
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function appendJsonLine(filePath, obj) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, `${JSON.stringify(obj)}\n`, 'utf8');
}

function msUntil(dateLike) {
  if (!dateLike) return NaN;
  const t = Date.parse(dateLike);
  if (!Number.isFinite(t)) return NaN;
  return t - Date.now();
}

function hoursUntil(dateLike) {
  const ms = msUntil(dateLike);
  if (!Number.isFinite(ms)) return NaN;
  return ms / (60 * 60 * 1000);
}

function banner() {
  console.log('====================================================');
  console.log('  POLYMARKET MONEYMAKER V3.1.1 PAPER ENGINE');
  console.log('====================================================');
}

// =========================
// MAIN
// =========================

async function main() {
  const command = String(process.argv[2] || '').trim().toLowerCase();
  if (command === 'burnin-reset-state') {
    const portfolio = new PaperPortfolio(CONFIG);
    const result = portfolio.writeFreshBurnInStateFile('cli_burnin_reset_state');
    console.log(JSON.stringify({
      ok: true,
      command: 'burnin-reset-state',
      stateFile: result.stateFile,
      backupPath: result.backupPath ? path.basename(result.backupPath) : null,
      pendingResetStateFile: result.pendingResetStateFile ? path.basename(result.pendingResetStateFile) : null,
      lifecycleStatus: result.lifecycleStatus,
      initialCash: result.initialCash,
      recommendedFreshStateFile: result.recommendedFreshStateFile,
      liveTradingEnabled: result.liveTradingEnabled,
      liveKillSwitch: result.liveKillSwitch,
      liveDryRunOnly: result.liveDryRunOnly,
    }, null, 2));
    return;
  }
  if (command === 'burnin-state-summary') {
    const portfolio = new PaperPortfolio(CONFIG);
    const pendingReset = portfolio.readPendingBurnInResetStateFile();
    if (pendingReset?.data) {
      portfolio.hydratePersistedState(pendingReset.data);
    } else {
      portfolio.loadState();
    }
    const markPrices = portfolio.markPricesSnapshot();
    const risk = new RiskEngine(CONFIG, portfolio);
    const exposure = risk.exposureBreakdown(null, { markPrices });
    const health = portfolio.executionHealth(Date.now());
    console.log(JSON.stringify({
      ok: true,
      command: 'burnin-state-summary',
      stateFile: path.basename(portfolio.resolvedStateFilePath()),
      source: pendingReset?.data ? 'pending_burnin_reset' : 'state_file',
      pendingResetStateFile: pendingReset?.filePath ? path.basename(pendingReset.filePath) : null,
      lifecycleStatus: portfolio.burnInState?.lifecycleStatus || null,
      initialCash: Number(portfolio.startingCash || 0),
      cash: Number(portfolio.cash || 0),
      positionKeys: [...portfolio.positions.entries()].filter(([, qty]) => Number(qty) > 0).length,
      totalExposureUsd: Number(portfolio.totalExposureUsd(markPrices) || 0),
      portfolioExposureUsd: Number(exposure.rawTotalExposureUsd || 0),
      capBlockingExposureUsd: Number(exposure.capBlockingExposureUsd || 0),
      excludedDeadExposureUsd: Number(exposure.excludedDeadExposureUsd || 0),
      activeTradableExposureUsd: Number(exposure.activeTradableExposureUsd || 0),
      openOrdersCount: Number(portfolio.openOrders.size || 0),
      activePaperOrdersCount: Number(health.activePaperOrders || 0),
      latestMarksCount: Number(portfolio.latestMarks.size || 0),
      positionMarketsCount: Number(portfolio.positionMarkets.size || 0),
      fillsCount: Array.isArray(portfolio.fills) ? portfolio.fills.length : 0,
      executionEventsCount: Array.isArray(portfolio.executionEvents) ? portfolio.executionEvents.length : 0,
    }, null, 2));
    return;
  }
  const bot = new BotEngine(CONFIG);
  await bot.start();
}

if (require.main === module) {
  main().catch((e) => {
    errlog(`Fatal start error: ${e.stack || e.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIG,
  BotEngine,
  EngineDiagnostics,
  MultiConsensusEngine,
  RiskEngine,
  PaperExecutionEngine,
  PaperTelegramUpdateRelay,
  PaperPortfolio,
  PaperOrder,
  Signal,
  SpreadHunterStrategy,
  VolatilityGuard,
  isBookComplete,
  topDepthUsd,
};
