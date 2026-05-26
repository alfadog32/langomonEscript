# Polymarket MoneyMaker V3 — Paper EV Engine

This is a serious paper-first Polymarket research and execution engine. It uses public Gamma + CLOB market data, generates strategy signals, applies risk controls, and simulates paper orders/fills.

It does not place real orders, does not require private keys, and does not guarantee profit.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Safer test

```bash
INITIAL_CASH=10000 BASE_ORDER_USD=10 MAX_POSITION_USD=100 MAX_DRAWDOWN_PCT=5 npm start
```

## Main modules

- Market discovery via Gamma events.
- Public CLOB order-book reads.
- Optional CLOB market WebSocket refresh triggers.
- Strategy modules:
  - SpreadHunter
  - ComplementArb
  - InventoryExit
  - TailEndMispricing
- Central risk engine.
- Paper portfolio and order manager.
- Performance reporting.
- State persistence in `moneymaker_v3_state.json`.

## Review notes for other agents

The live-order layer is intentionally not implemented. Before adding live trading, require:

1. API authentication module.
2. Real order signing and cancel/replace logic.
3. Reconciliation against exchange balances and open orders.
4. Min-size/tick-size validation against current CLOB metadata.
5. Emergency kill-switch and max-loss guard.
6. A burn-in period with paper performance logs.
