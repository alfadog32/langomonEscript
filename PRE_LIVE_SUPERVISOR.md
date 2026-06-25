# PRE_LIVE_SUPERVISOR.md

## Purpose

Read-only watchdog that inspects the paper burn-in system and determines
whether it is stable enough to advance to a live canary.

It writes only two files:
- `pre_live_supervisor_status.json` — latest run status
- `pre_live_supervisor_events.ndjson` — append-only event log

It never modifies state files, env files, config, or trading data.

## Running

### Single inspection (fast, one-shot)

```bash
npm run supervisor:prelive
```

Runs one cycle: inspects readiness, PM2 logs, crash loops, safety flags,
decision files, Telegram polling, and secret file existence. Prints a
summary and writes status.

### Stable proof mode (3 cycles, ~10 min)

```bash
npm run supervisor:prelive:proof
```

Runs 3 inspection cycles approximately 5 minutes apart. Passes only if
every cycle meets all thresholds. Prints the final verdict:

- `PAPER_STABLE_FOR_CANARY=true` — all clear for canary
- `PAPER_STABLE_FOR_CANARY=false` — with the exact blocker(s)

## What must be green before live canary

All of the following must hold across all 3 proof cycles:

| Check | Threshold |
|-------|-----------|
| Live safety flags | All OFF (ENABLE_LIVE_TRADING=false, LIVE_AUTO_EXECUTE=false, LIVE_KILL_SWITCH=true, LIVE_DRY_RUN_ONLY=true) |
| State profile | `state_profile_clean` |
| Burn-in lifecycle | Not `burn_in_failed_by_drawdown` |
| Runtime errors | No crash loops detected |
| repeatSameTokenEntries | = 0 |
| Drawdown | < 5% |
| fillsLastHour | >= 3 |
| trustedFillsLastHour | > 0 |
| untrustedFillsLastHour | = 0 |
| Exposure mismatch | No unexplained exposure |

## What it detects and reports

- Unsafe live flags
- Runtime errors in PM2 logs
- Crash loops (excessive restarts in short windows)
- `state_profile_mismatch` between state file and runtime config
- `burn_in_failed_by_drawdown`
- `action_rate_below_target`
- Sophie admitted but final Risk blocked
- Fills below target
- `repeatSameTokenEntries > 0`
- Unexplained exposure mismatch
- Telegram polling failures/recoveries
- Secret file existence/readability (never reads contents)

## Output files

### pre_live_supervisor_status.json

Contains the latest run result including `PAPER_STABLE_FOR_CANARY`,
blockers, metrics, flag status, and detection details.

### pre_live_supervisor_events.ndjson

Append-only log of every cycle and proof result. Useful for tracking
stability over time.

## Typical workflow

```bash
# 1. Verify syntax
node --check scripts/pre_live_supervisor.js

# 2. Quick single check
npm run supervisor:prelive

# 3. Full stable proof (~10 min)
npm run supervisor:prelive:proof

# 4. Check result
cat pre_live_supervisor_status.json | head -5
# Look for: "PAPER_STABLE_FOR_CANARY": true
```

Only proceed to live canary when `PAPER_STABLE_FOR_CANARY=true`.
