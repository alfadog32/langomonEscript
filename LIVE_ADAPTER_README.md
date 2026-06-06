# MoneyMaker Polymarket Live Adapter

This package adds a standalone live adapter module for MoneyMaker.

Default behavior is safe: it refuses/dry-runs unless all live flags are enabled and the kill switch is off.

## Files

- `live_adapter_polymarket.js` - adapter module + CLI
- `live_order_intent.example.json` - example intent for dry-run testing

## Install dependencies later, only when ready for live CLOB testing

```bash
cd /home/lango/langomonEscript
npm install @polymarket/clob-client-v2 viem
```

Dry-run mode does not need these dependencies unless you ask it to fetch live CLOB metadata.

## First test

```bash
cd /home/lango/langomonEscript
node --check ./live_adapter_polymarket.js
node ./live_adapter_polymarket.js doctor
node ./live_adapter_polymarket.js dry-run ./live_order_intent.example.json
```

Expected current result: `REFUSED` because `ENABLE_LIVE_TRADING=false`, `LIVE_AUTO_EXECUTE=false`, `LIVE_KILL_SWITCH=true`, and `LIVE_DRY_RUN_ONLY=true`.

## Real live submission remains blocked unless all flags are changed

The adapter will not read `.env.live.secrets` unless all are true:

- `ENABLE_LIVE_TRADING=true`
- `LIVE_AUTO_EXECUTE=true`
- `LIVE_KILL_SWITCH=false`
- `LIVE_DRY_RUN_ONLY=false`

Do not enable these until the adapter is integrated and audited.
