# MoneyMaker Engine Review

## Pipeline Summary

MoneyMaker paper flow starts in `ResearchEngine.discoverCandidates()`. It fetches active Polymarket events, filters CLOB-tradable outcomes, reads order books, and scores assets for usable spread, depth, balance, volume, liquidity, and time-to-expiry. Selected assets are cached and revisited by `BotEngine.tick()`, which refreshes each book with `MarketCache.getFreshBook()`.

`SpreadHunterStrategy.generate()` emits maker-style buy and sell candidates only when the book is complete, spread is large enough, the volatility guard allows quoting, estimated edge beats `MIN_SIGNAL_EDGE`, liquidity consumption is usable, order size is above `MIN_ORDER_USD`, and optional ghost throttling has not reduced size below viability.

Signals then enter `MultiConsensusEngine.evaluateSignal()`. This scores structure, depth, imbalance, momentum, volatility, portfolio exposure, timing, and whale alignment. The score gate is separate from route authorization: a signal must pass both `score >= CONSENSUS_THRESHOLD` and a strategy-compatible route.

Approved signals then pass through `RiskEngine.evaluate()`, which enforces side/price/size validity, max open orders, edge and confidence, total open order exposure, total and market exposure, available cash, per-asset cap, sell inventory availability, and drawdown. `PaperExecutionEngine.place()` then performs duplicate-open-order suppression before adding a paper order and recording ghost calibration. Live candidates are emitted only after paper placement succeeds and only when `AUTO_LIVE_CANDIDATES_ENABLED=true`.

## Blockers And Meanings

- `score_below_threshold`: Sophie/consensus score did not meet `CONSENSUS_THRESHOLD`.
- `route_not_authorized`: the strategy is not compatible with the selected route, or route-specific prerequisites failed.
- `stale_book`: the book was incomplete or older than the route authorization freshness window.
- `volatility_guard`: volatility guard is tripped and quoting during volatility is disabled.
- `risk_blocked`: generic risk validity, edge, confidence, sell inventory, or drawdown rejection.
- `exposure_cap`: max open orders, open-order exposure, total exposure, market exposure, or per-asset exposure would be exceeded.
- `cash_cap`: available paper cash after open buy reservations is insufficient.
- `ghost_throttle`: ghost/risk throttle made a candidate unsafe for route authorization.
- `order_placed`: a paper order was accepted.
- `order_skip_duplicate`: a matching open paper order already exists and replacement is not allowed.

## Strategy Route Model

- `SpreadHunter`: maker/spread-compatible. It is authorized on `MAKER:STABLE` when the book is fresh and complete, spread is within configured max, volatility guard is not tripped, expected edge passes, top-of-book depth passes, and liquidity/ghost checks remain viable. It is not broadly authorized for sniper routes.
- `ComplementArb`: maker-compatible only when complement-arbitrage structure, depth, and volatility components pass.
- `InventoryExit`, `StopLossExit`, `TakeProfitExit`: risk-reducing exits bypass the consensus score gate as `RISK_EXIT` routes and still pass paper risk checks.
- `TailEndMispricing`: sniper-compatible on `SNIPER:TRENDING` only when aligned with the detected move and route quality checks pass.
- `WAIT:WAIT`: never authorizes an order.

## Starvation Root Cause

The old maker route authorization mixed route compatibility with component thresholds:

`makerStrategies.has(signal.strategy) && components.depth >= 0.45 && components.volatility >= 0.36`

When a valid SpreadHunter candidate passed the score threshold but one of those component thresholds failed, the route returned `authorized=false` with the misleading reason `Stable/displaced book but strategy SpreadHunter is not maker-compatible`. That overblocked maker-stable spread capture and kept paper open orders at zero even though candidates were being found.

The fix replaces that implicit check with an explicit strategy-route model. SpreadHunter now has a dedicated maker-stable decision that honors the normal safety gates already used by the strategy and paper engine instead of treating depth/volatility component scores as a separate compatibility veto.

## Regression Coverage

`scripts/engine_route_selfcheck.js` runs without network access or live secrets. It proves:

- SpreadHunter plus safe `MAKER:STABLE` authorizes.
- Misaligned SpreadHunter on `SNIPER:TRENDING` blocks.
- Duplicate paper candidate skips instead of adding a second open order.
- Stale book blocks.
- Volatility guard blocks.
- Exposure cap blocks.
- InventoryExit remains allowed as a risk-reducing route.
- `WAIT:WAIT` does not authorize.

`EngineDiagnostics` also records recent candidate outcomes and emits `[ENGINE STARVATION WARNING]` if passing candidates are dominated by route blocks while no orders or duplicate skips occur.
