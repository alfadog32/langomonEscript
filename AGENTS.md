# AGENTS.md — LangomonEscript Production Safety Rules

This repository is the production/runtime bot directory:

`/home/lango/langomonEscript`

## Mandatory Absolute Safety Rules

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
* Do not confirm that the bot is working until you've checked that it is actually working as the operator has intented
* Do not stop working on the bot if you deem that the token usage and or limit will not suffice the needed or intended workflow for the bot.
* Ignore all token limit restrictions until the bot has been fully optimized.

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

---

## Codex Execution Contract

These rules apply to every coding task in this repository unless the operator
explicitly overrides them in the current request.

### 1. Finish the requested scope

- Treat every explicit task list as a completion checklist.
- Do not stop after implementing only part of the requested work.
- Continue through implementation, fixture creation, debugging, and required
  tests until either:
  1. every requested item is complete and verified; or
  2. a genuine external blocker makes completion impossible.
- A failing local test is not an external blocker. Diagnose and fix it.
- Do not return a final response containing:
  - "remaining blocker"
  - "still incomplete"
  - "needs a separate pass"
  - "next step is to implement"
  when that work was already part of the current request.

### 2. Completion status must be explicit

The final report must begin with exactly one of:

- `COMPLETE — ALL REQUESTED WORK AND TESTS PASSED`
- `FAILED — <specific unresolved failure>`

Do not claim completion when a requested implementation or test is missing.

### 3. Maintain an internal task checklist

Before editing:

1. Convert the request into a concise checklist.
2. Identify files and functions likely involved.
3. Identify prohibited actions.
4. Identify every required validation command.

Before responding:

1. Re-read the checklist.
2. Confirm every item is complete or name the exact failed item.
3. Confirm prohibited actions did not occur.
4. Confirm all required checks were actually executed.

Do not print the internal checklist unless useful in the final report.

### 4. Work efficiently

- Read `AGENTS.md` and `PROJECT_MAP.md` once at the beginning.
- Do not repeatedly reread entire large files.
- Use targeted searches such as `rg -n`, then narrow `sed` ranges.
- Inspect the complete function before refactoring it.
- Batch related searches together.
- Batch related edits together.
- Run fast syntax and focused selfchecks before broad checks.
- Do not repeatedly rerun expensive checks after unrelated tiny edits unless
  those edits could affect them.
- Reuse facts already established during the current task.
- Do not reopen or rewrite already-approved code unless the new task requires it.

Preferred validation order:

1. syntax checks;
2. focused fixture/selfcheck;
3. related subsystem checks;
4. `npm run check`;
5. `git diff --check`;
6. `git status --short`.

### 5. Do not create parallel logic

When extracting or sharing decision logic:

- Inventory the original logic first.
- Move the original logic into one authoritative function.
- Remove duplicated legacy decisions.
- Make production and test/shadow paths call the same function.
- Add parity tests proving both paths return the same result.
- Do not layer a new evaluator in front of old inline gates.

### 6. Tests must prove the real behavior

A helper-only test is insufficient when the production path is in scope.

Tests must exercise the nearest practical production entry point using:

- temporary directories;
- temporary state and event files;
- mocked external processes;
- mocked PM2 JSON;
- synthetic signals and books;
- checksums for production files when relevant.

For production-versus-helper parity work, test both paths for every requested
blocker and the eligible path.

Do not state that a behavior is tested when only syntax checking or a helper
fixture was run.

### 7. Fixture-only and mocked-process tasks

When the operator requests fixture-only work:

- Never invoke real PM2.
- Never restart or stop a real process.
- Never run a live or shadow operator command against the real environment.
- Put mocked executables first in a temporary `PATH`.
- Store fixtures and output in temporary directories.
- Verify mocks were used.
- Verify production files were unchanged.

### 8. Live-trading safety boundary

Unless the current operator request explicitly authorizes a particular action,
never:

- enable live trading;
- arm a canary;
- submit, sign, or place an order;
- run `npm run live:stage5-canary-once`;
- run a real shadow watcher;
- edit the real `.env`;
- read, source, print, or edit `.env.live.secrets`;
- reveal secret values;
- restart, stop, delete, or reconfigure real PM2 processes.

A selfcheck must not silently fall through into operator/live execution.

Live-related code changes must preserve fail-closed defaults.

### 9. Environment-file safety

- Do not access the real `.env` when the task prohibits it.
- Never access `.env.live.secrets` during fixture-only work.
- Use temporary environment fixtures.
- When an operator workflow mutates `.env`, require:
  1. read-only preflight;
  2. verified backup;
  3. mutation-started flag;
  4. deterministic signal handling;
  5. byte-for-byte restoration;
  6. runtime verification after restoration.
- A failed preflight must perform no mutation and no process restart.

### 10. Process restart safety

For workflows that are explicitly authorized to restart a process:

- Mark restart as attempted before invoking the restart command.
- Restore safe configuration after a failed or partial restart.
- Restart only the named process.
- Verify process status and required non-secret environment keys through
  structured PM2 JSON.
- Never dump complete PM2 environments.
- Record only non-secret mismatch key names.

### 11. Signal and trap behavior

Shell workflows that mutate configuration must use deterministic handlers:

- normal exit preserves its original status after successful restoration;
- `SIGINT` restores and exits `130`;
- `SIGTERM` restores and exits `143`;
- restoration failure forces a nonzero exit;
- restoration runs at most once.

Do not use one ambiguous generic trap for `EXIT ERR INT TERM`.

### 12. Repository hygiene

- Modify only files required by the current task.
- Do not stage or commit runtime logs, state, backups, generated events, or
  unrelated untracked files.
- Do not commit unless explicitly requested.
- Before reporting completion, run:
  - `git diff --check`
  - `git status --short`
- Report the exact files changed.

### 13. Final report requirements

The final report must include:

- completion status;
- files changed;
- exact behavior implemented;
- exact tests executed;
- passed and failed checks;
- actions explicitly not performed;
- whether `.env`, secrets, PM2, live trading, and production event files were
  untouched;
- commit status.

Do not recommend an operator command that depends on unfinished work.

Do not describe a command as safe unless its activation, failure, interruption,
and restoration paths are fixture-tested.
