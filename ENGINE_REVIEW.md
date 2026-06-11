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

## Operational Stabilization Before Live-Readiness Review

Tiny sellable positions below `MIN_ORDER_USD` are now treated as dust. When a SELL or exit signal has `availableSellUsd > 0` and `availableSellUsd < MIN_ORDER_USD`, the engine suppresses the paper order instead of repeatedly producing full risk-block logs. The position remains in portfolio state and reports; it is not deleted, force-sold, or marked as filled. Suppression is controlled by `DUST_EXIT_SUPPRESS_ENABLED` and `DUST_EXIT_LOG_COOLDOWN_SEC`, and emits concise `[DUST EXIT SUPPRESSED]` logs.

Paper order replacement now has churn guards. Same-price replacements are skipped unless the order reaches `ORDER_REPLACE_FORCE_REFRESH_SEC`, orders younger than `ORDER_REPLACE_MIN_AGE_SEC` are not replaced, and price changes smaller than `ORDER_REPLACE_PRICE_EPSILON` are treated as same-price. Duplicate protection remains active and replacements do not double-count open-order exposure.

Portfolio reports now include dust and execution-health summaries:

```text
Dust Positions: count=N value=$X.XX
Execution Health: candidateEvaluationsLastHour=N paperOrdersPlacedLastHour=N paperOrdersAdmittedLastHour=N paperOrdersRejectedBySophieLastHour=N ordersPlacedLastHour=N fillsLastHour=N duplicateSkipsLastHour=N replacementsLastHour=N oldestOpenOrderAgeSec=N fillRateLastHour=X%
```

If open orders age beyond `FILL_STARVATION_WARN_SEC` with no fills in the last hour, the engine logs `[ENGINE STARVATION WARNING] ... reason=no_recent_fills`. This is diagnostic only; it does not loosen strategy, risk, routing, duplicate, stale-book, volatility, exposure, drawdown, or ghost controls.

`npm run live:readiness` is a read-only operator report. It does not place orders, read live private keys, send Telegram messages, or enable live flags. It checks PM2 process presence, recent paper health, safety flags, Telegram token/chat-id presence with redaction, and dashboard syntax. `READY_FOR_MICRO_LIVE=false` is expected until paper health and process checks are clean; even a passing report is only for dry-run review, not automatic live execution.

## Sophie Execution Quality

The current paper problem is no longer starvation from confidence blocks. The engine is active but inefficient: recent operations showed roughly 1 fill from about 580 paper order placements, or about `1 / 580 = 0.17%`, with duplicate skips and max-open-order pressure dominating the loop. Raising `MAX_OPEN_ORDERS` would hide the symptom by letting more low-fill orders rest; it would not improve fill probability, order-slot quality, or churn. Force-selling dust is also unsafe because sub-`MIN_ORDER_USD` positions cannot be assumed executable; dust remains suppression-only and tracked in reports/state.

Sophie now scores paper execution quality separately from theoretical signal quality. The signal score still answers whether the strategy signal is attractive. The execution-quality score asks whether the order is likely to fill efficiently without wasting a scarce paper order slot.

The implemented formula blends:

- `sophieSignalScore`: consensus score when available, otherwise signal confidence.
- Edge and confidence quality.
- `predictedFillProbability`, estimated from token/side/strategy fill history, strategy fill history, quote distance from touch, spread quality, top-depth quality, ghost favorable rate, duplicate pressure, and no-fill pressure.
- Slot, duplicate, no-fill, churn, and open-order age penalties.

The paper gate uses `SOPHIE_MIN_EXECUTION_QUALITY` for non-protective entries. Protective exits bypass the Sophie throttle. Low-fill token/side/strategy combinations can enter a cooldown when attempts and duplicate skips are high with no fills. When order slots are saturated, the slot manager uses:

```text
candidateUtility > weakestOpenOrderUtility + replacementFriction
```

where `replacementFriction` is `SOPHIE_SLOT_EVICTION_MIN_IMPROVEMENT`. Eviction is paper-only, never targets protective exits, requires the open order to be older than `SOPHIE_SLOT_EVICTION_MIN_OPEN_ORDER_AGE_SEC`, and only admits candidates that do not increase open-order exposure relative to the evicted order.

After the first Sophie gate pass, observed paper quality improved to `fillsLastHour=3` and `fillRateLastHour=1.2%`, but order flow was still too noisy (`ordersPlacedLastHour=257`, `duplicateSkipsLastHour=740`) and active paper orders could fall to zero. Runtime logs showed many candidates clustered around `sophieExecutionQuality=0.39-0.48`, including some with strong edge, confidence, fill probability, and near-touch pricing. That indicates the execution-quality scale is compressed for current market conditions, not that confidence should be lowered or order capacity should be raised.

Sophie now has a calibrated paper-only admission band below the strict `SOPHIE_MIN_EXECUTION_QUALITY` threshold. A near-threshold candidate may be admitted only when all hard floors pass: minimum calibrated quality, edge, confidence, predicted fill probability, maximum distance from touch, active SpreadHunter order cap, and per-scan admission cap. These candidates still run through RiskEngine afterward. This is safer than lowering confidence or raising `MAX_OPEN_ORDERS` because it admits only bounded, near-touch, high-edge paper candidates while keeping cash, exposure, drawdown, stale-book, volatility, duplicate, dust, and ghost safety intact.

The latest calibration then over-filtered: `Open Orders=0`, `Open Order Exposure=$0.00`, `ordersPlacedLastHour=7`, `fillsLastHour=0`, and no duplicate/replacement/max-open-order pressure. Observed candidates were still clustered below the strict gate, for example `sophieExecutionQuality=0.425-0.439`, `predictedFillProbability=0.305-0.375`, edge around `0.016-0.027`, and distance from touch around `0.05-0.09`. That created zero active paper orders even though some candidates were strong enough to test in a bounded paper bootstrap lane.

Sophie now includes paper-only bootstrap admission for zero-order starvation. Strict admission is checked first, calibrated admission second, and bootstrap admission only runs when active paper SpreadHunter orders are below the configured target. Bootstrap candidates must pass hard floors for signal score, execution quality, expected edge, confidence, predicted fill probability, and distance from touch; they are collected for the scan, ranked by bootstrap utility, and admitted only up to the per-scan and active-order caps. Bootstrap utility weights signal score, execution quality, predicted fill probability, normalized edge, confidence, and touch proximity. This is safer than raising `MAX_OPEN_ORDERS` or disabling Sophie because it admits at most the best bounded paper candidates and still requires normal RiskEngine, stale-book, volatility, cash, exposure, drawdown, duplicate, dust, and ghost checks.

Execution-health metrics now distinguish scan pressure from real order placement: `candidateEvaluationsLastHour`, `paperOrdersAdmittedLastHour`, `paperOrdersRejectedBySophieLastHour`, and `paperOrdersPlacedLastHour`. Readiness uses actual `paperOrdersPlacedLastHour` for the order-volume cap while still reporting candidate evaluations.

Repeated low-quality blocks are cooldown-limited and summarized so the same token/side/strategy does not flood logs every scan. Repeated unchanged candidates can also enter a short cooldown after low-quality blocks, reducing duplicate pressure without deleting existing orders or pretending fills happened.

`npm run live:readiness` now keeps `READY_FOR_MICRO_LIVE=false` unless all safety and efficiency checks pass: expected PM2 processes online, safe live flags, recent portfolio report, `fillsLastHour >= 3`, `fillRateLastHour >= 1.0%`, `ordersPlacedLastHour <= 150`, `duplicateSkipsLastHour <= 500`, `maxOpenOrderBlocksLastHour <= 50`, and no recent engine starvation warning. Passing readiness still means dry-run review only, not automatic live execution.

## Live Dependency Audit Caution

`npm audit fix` without `--force` leaves known transitive vulnerabilities under the live adapter dependency chain. The remaining advisories are not caused by the paper engine and are not fixed safely by npm without a breaking downgrade:

- `@polymarket/clob-client-v2@1.0.6` depends on `@ethersproject/providers@5.8.0` and `@ethersproject/wallet@5.8.0`.
- The ethers v5 chain depends on `elliptic@6.6.1`, which npm flags for risky cryptographic primitive implementation.
- `@ethersproject/providers@5.8.0` also carries a nested `ws@8.18.0`, which npm flags for uninitialized memory disclosure.

Npm recommends `npm audit fix --force`, but that would install `@polymarket/clob-client-v2@0.0.3` as a breaking change. Do not take that downgrade without a dedicated live-adapter compatibility review. The paper engine does not import live secrets, does not sign orders, and does not submit live orders; these advisories are a live-readiness caution until the Polymarket client or ethers dependency chain can be upgraded safely.
