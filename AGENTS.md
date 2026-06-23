# AGENTS.md — LangomonEscript Production Safety Rules

This repository is the production/runtime bot directory:

`/home/lango/langomonEscript`

## Absolute Safety Rules

* Do not enable live trading.
* Do not set `ENABLE_LIVE_TRADING=true`.
* Do not set `LIVE_AUTO_EXECUTE=true`.
* Do not set `LIVE_KILL_SWITCH=false`.
* Do not set `LIVE_DRY_RUN_ONLY=false`.
* Do not set `LIVE_FINAL_BOSS_READY=true`.
* Do not change `LIVE_TRADING_STAGE` unless the user explicitly asks in the current message.
* Do not submit real orders.
* Do not run any command that can submit real orders.
* Do not weaken `canSubmitLive()`.
* Do not bypass risk checks.
* Do not bypass Sophie checks.
* Do not bypass oracle confirmation checks.
* Do not bypass kill-switch checks.

## Secrets Rules

Never read, print, grep, cat, copy, edit, validate, or load these files:

* `.env.live.secrets`
* `.env.telegram`
* `.env`
* any private key file
* any API key file

Never print:

* private keys
* API keys
* API secrets
* passphrases
* wallet secrets
* relayer keys
* Telegram tokens

The user handles live secrets manually.

## Git Rules

Do not use:

`git add .`

Stage exact files only.

Never commit:

* `.env`
* `.env.live.secrets`
* `.env.telegram`
* state JSON files
* NDJSON files
* log files
* PM2 dumps
* runtime backups
* `node_modules`
* zip backups
* secret files

## Patch Rules

Make minimal patches only.

Do not rewrite major strategy logic unless the user explicitly asks.

Do not change trading thresholds unless the user explicitly asks.

Do not change live flags.

Do not restart PM2 processes unless checks pass and restart is necessary.

## Required Checks After Code Changes

Run:

`node --check moneymaker_v3.js`
`node --check dashboard_server.js`
`node --check live_adapter_polymarket.js`
`node --check live_intent_router.js`
`node --check scripts/live_readiness_report.js`
`node --check scripts/live_final_boss_selfcheck.js`
`npm run check`

Run additional selfchecks when relevant:

`npm run engine:gabagool-btc-selfcheck`
`npm run live:readiness`

Do not run real `auth-dry-run` if it loads `.env.live.secrets`. The user runs secret-loading checks manually.

## Final Report Requirements

Every final report must include:

* files changed
* checks run
* pass/fail result
* whether live trading stayed off
* whether any secrets were accessed
* whether any real order was submitted
* remaining blockers
* exact next manual command for the user
