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

## Risk Engine Diagnostic Review

Risk evaluation now separates consensus rejection from post-consensus risk rejection. `BotEngine.trySignal()` returns immediately when consensus does not authorize a signal, so consensus route blocks no longer get relabeled as RiskEngine failures.

RiskEngine block logs use precise reasons instead of generic `risk_blocked`: `invalid_signal`, `invalid_side`, `invalid_price`, `invalid_size`, `edge_below_min`, `confidence_below_min`, `max_open_orders`, `max_total_open_order_usd`, `max_total_exposure`, `max_market_exposure`, `max_position_per_asset`, `cash_cap`, `no_available_position`, `sell_size_below_min`, and `drawdown_limit`.

`[SIGNAL BLOCK]` logs include the threshold/cap values needed to diagnose runtime failures: expected edge, minimum edge, confidence, minimum confidence, signal size, minimum order size, available cash, current position quantity, available sell quantity, current position USD, total exposure, market exposure, open-order exposure, and drawdown. SpreadHunter BUY failures should now identify whether the signal fell below edge/confidence after consensus adjustment, hit cash/exposure/position caps, or had invalid size/price. TakeProfitExit and StopLossExit SELL failures should identify whether there was no available inventory or the sell was clamped below `MIN_ORDER_USD`.

## Paper Confidence Profiles

After route authorization was fixed, runtime paper flow was still starved because valid SpreadHunter `MAKER:STABLE` candidates had expected edge above `MIN_SIGNAL_EDGE` but confidence around `0.35-0.40`, below the global `MIN_CONFIDENCE=0.45`. Cash, exposure, open-order, and drawdown limits were not the active blocker.

MoneyMaker now separates paper confidence calibration from live safety with `PAPER_CONFIDENCE_PROFILE`:

- `conservative`: always uses normal `MIN_CONFIDENCE`.
- `balanced`: default paper profile; uses normal `MIN_CONFIDENCE` and keeps the safer baseline.
- `capital_velocity`: paper-only research mode that lets authorized SpreadHunter `MAKER:STABLE` candidates use `SPREADHUNTER_MIN_CONFIDENCE_PAPER` instead of the global confidence threshold.

The lower paper threshold does not bypass consensus route authorization, expected edge, stale-book checks, volatility guard, cash, exposure, drawdown, duplicate-open-order protection, or ghost safety. It only changes the confidence threshold after those upstream maker-stable safety checks are already satisfied. `[SIGNAL BLOCK]` logs now show the actual `minConfidence` used plus `confidenceProfile` and `thresholdSource`, so a confidence block can be traced to either `MIN_CONFIDENCE` or `SPREADHUNTER_MIN_CONFIDENCE_PAPER`.

To manually test order flow in paper mode on the server, set:

```bash
PAPER_CONFIDENCE_PROFILE=capital_velocity
SPREADHUNTER_MIN_CONFIDENCE_PAPER=0.35
MIN_CONFIDENCE=0.45
```

Do not change live trading flags for this paper calibration. Live submission remains disabled unless explicitly enabled in the separate live adapter flow.

## Live Dependency Audit Caution

`npm audit fix` without `--force` leaves known transitive vulnerabilities under the live adapter dependency chain. The remaining advisories are not caused by the paper engine and are not fixed safely by npm without a breaking downgrade:

- `@polymarket/clob-client-v2@1.0.6` depends on `@ethersproject/providers@5.8.0` and `@ethersproject/wallet@5.8.0`.
- The ethers v5 chain depends on `elliptic@6.6.1`, which npm flags for risky cryptographic primitive implementation.
- `@ethersproject/providers@5.8.0` also carries a nested `ws@8.18.0`, which npm flags for uninitialized memory disclosure.

Npm recommends `npm audit fix --force`, but that would install `@polymarket/clob-client-v2@0.0.3` as a breaking change. Do not take that downgrade without a dedicated live-adapter compatibility review. The paper engine does not import live secrets, does not sign orders, and does not submit live orders; these advisories are a live-readiness caution until the Polymarket client or ethers dependency chain can be upgraded safely.
