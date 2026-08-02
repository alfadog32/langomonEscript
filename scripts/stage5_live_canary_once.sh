#!/usr/bin/env bash
# OPERATOR-ONLY: DO NOT RUN WITHOUT AN EXPLICIT LIVE-CANARY AUTHORIZATION.
# This script may place at most one real order, up to $5, during its 180-second
# Stage 5 window. It always returns .env to the Stage 2 locked-off baseline.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"
RUN_DIR="$ROOT/runtime_backups/stage5_live_canary_$(date -u +%Y%m%dT%H%M%SZ)_$$"
BACKUP_FILE="$RUN_DIR/.env.before_stage5_canary"
WINDOW_SECONDS=180
LOCKED=0

mkdir -p "$RUN_DIR"

say() { printf '[stage5-canary] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

env_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub(/^[^=]*=/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit
    }
  ' "$ENV_FILE"
}

require_env_value() {
  local key="$1" expected="$2" actual
  actual="$(env_value "$key")"
  [[ "$actual" == "$expected" ]] || return 1
}

require_safe_baseline() {
  [[ -f "$ENV_FILE" ]] || die 'LOCK LIVE OFF FIRST'
  require_env_value ENABLE_LIVE_TRADING false &&
  require_env_value LIVE_AUTO_EXECUTE false &&
  require_env_value LIVE_KILL_SWITCH true &&
  require_env_value LIVE_DRY_RUN_ONLY true &&
  require_env_value LIVE_SUBMIT_CONFIRM false &&
  require_env_value LIVE_FINAL_BOSS_READY false &&
  require_env_value LIVE_TRADING_STAGE 2 &&
  require_env_value LIVE_CANARY_MARKET_ID '' &&
  require_env_value MAX_LIVE_ORDER_USD 1 &&
  require_env_value MAX_LIVE_TOTAL_EXPOSURE_USD 1 &&
  require_env_value LIVE_DAILY_MAX_LOSS_USD 1 &&
  require_env_value LIVE_MAX_ORDERS_PER_HOUR 1 &&
  require_env_value AUTO_LIVE_MIN_CONFIDENCE 0.67 &&
  require_env_value LIVE_ROUTER_MODE dry-run || die 'LOCK LIVE OFF FIRST'
}

set_env_value() {
  local key="$1" value="$2" tmp="$ENV_FILE.stage5-canary.$$.tmp"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      if (!done) print key "=" value
      done = 1
      next
    }
    { print }
    END { if (!done) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

set_safe_stage2_baseline() {
  set_env_value ENABLE_LIVE_TRADING false
  set_env_value LIVE_AUTO_EXECUTE false
  set_env_value LIVE_KILL_SWITCH true
  set_env_value LIVE_DRY_RUN_ONLY true
  set_env_value LIVE_SUBMIT_CONFIRM false
  set_env_value LIVE_FINAL_BOSS_READY false
  set_env_value LIVE_TRADING_STAGE 2
  set_env_value LIVE_CANARY_MARKET_ID ''
  set_env_value MAX_LIVE_ORDER_USD 1
  set_env_value MAX_LIVE_TOTAL_EXPOSURE_USD 1
  set_env_value LIVE_DAILY_MAX_LOSS_USD 1
  set_env_value LIVE_MAX_ORDERS_PER_HOUR 1
  set_env_value AUTO_LIVE_MIN_CONFIDENCE 0.67
  set_env_value LIVE_ROUTER_MODE dry-run
}

restart_canary_processes() {
  pm2 restart langomonEscript --update-env
  pm2 restart liveIntentRouter --update-env
  pm2 restart telegramApprovalBot --update-env
}

post_lockoff_audit() {
  say 'safe flag grep:'
  rg -n '^(ENABLE_LIVE_TRADING|LIVE_AUTO_EXECUTE|LIVE_KILL_SWITCH|LIVE_DRY_RUN_ONLY|LIVE_SUBMIT_CONFIRM|LIVE_FINAL_BOSS_READY|LIVE_TRADING_STAGE|LIVE_CANARY_MARKET_ID|MAX_LIVE_ORDER_USD|MAX_LIVE_TOTAL_EXPOSURE_USD|LIVE_DAILY_MAX_LOSS_USD|LIVE_MAX_ORDERS_PER_HOUR|AUTO_LIVE_MIN_CONFIDENCE|LIVE_ROUTER_MODE)=' "$ENV_FILE" || true
  npm run supervisor:prelive || true
  say 'recent candidates:'; tail -n 20 auto_live_candidates.ndjson 2>/dev/null || true
  say 'recent intents:'; tail -n 20 trade_intents.ndjson 2>/dev/null || true
  say 'recent filtered PM2 logs:'
  rg -n -i 'AUTO-LIVE CANDIDATE|LIVE-ADAPTER|LIVE INTENT|submitted|refused|AUTO_EXECUTE_DISABLED|LIVE_CANARY_MARKET|MAX_LIVE|ORDER_PLACED|Live Safety|gabagool_loss_guard' \
    /home/lango/.pm2/logs/langomonEscript* /home/lango/.pm2/logs/liveIntentRouter* /home/lango/.pm2/logs/telegramApprovalBot* 2>/dev/null | tail -n 300 || true
}

lock_off() {
  local rc="$?"
  [[ "$LOCKED" == 1 ]] && return "$rc"
  LOCKED=1
  say 'locking off and restoring the Stage 2 safe baseline'
  set +e
  [[ -f "$ENV_FILE" ]] && set_safe_stage2_baseline
  restart_canary_processes
  post_lockoff_audit
  return "$rc"
}
trap lock_off EXIT INT TERM ERR

validate_precheck_evidence() {
  node - "$RUN_DIR/readiness.json" "$RUN_DIR/supervisor.out" <<'NODE'
const fs = require('fs');
const [readinessPath, supervisorPath] = process.argv.slice(2);
const readiness = JSON.parse(fs.readFileSync(readinessPath, 'utf8'));
const health = readiness.paperEngineHealth || {};
const audit = health.exposureAudit || {};
const guard = health.gabagagoolEntryGuard || health.gabagoolEntryGuard || {};
const bad = [];
if (Number(health.openOrders) !== 0) bad.push('openOrders must be 0');
if (Number(audit.capBlockingExposureUsd) !== 0) bad.push('capBlockingExposureUsd must be 0');
const tradable = Number(audit.riskExposureUsd ?? health.activeTradableExposureUsd ?? 0);
if (!Number.isFinite(tradable) || tradable > 5) bad.push('tradable exposure must be <= $5');
if (guard.lossGuardActive === true) bad.push('gabagool loss guard is active');
if (health.crashLoopOk === false) bad.push('serious crash-loop blocker');
const supervisor = fs.readFileSync(supervisorPath, 'utf8');
if (/unsafe_live_flags|serious.*crash|crash_loop/i.test(supervisor) && !/controlled restart-count noise/i.test(supervisor)) bad.push('supervisor reports a serious blocker');
if (bad.length) throw new Error(bad.join('; '));
NODE
}

read_fresh_target() {
  node - "$ROOT/btc_oracle_market_target.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const target = doc.target || {};
const timestamp = Date.parse(doc.timestamp || target.timestamp || target.utc || '');
if (!String(target.slug || '').startsWith('btc-updown-5m-')) throw new Error('target slug is not btc-updown-5m');
if (!String(target.rawMarketId || '').trim()) throw new Error('target.rawMarketId missing');
if (!Number.isFinite(timestamp) || Date.now() - timestamp > 90_000 || timestamp - Date.now() > 90_000) throw new Error('target is stale');
process.stdout.write(String(target.rawMarketId));
NODE
}

require_safe_baseline
cp -- "$ENV_FILE" "$BACKUP_FILE"
say "saved pre-arm .env backup at $BACKUP_FILE"

npm run check
npm run live:stage5-router-refusal-selfcheck
npm run live:final-boss-selfcheck | tee "$RUN_DIR/final-boss.out"
rg -qx 'live_final_boss_selfcheck: ok' "$RUN_DIR/final-boss.out" || die 'final-boss selfcheck did not pass'
npm run live:readiness | tee "$RUN_DIR/readiness.raw" || true
awk '/^[[:space:]]*\{/{printing=1} printing{print}' "$RUN_DIR/readiness.raw" > "$RUN_DIR/readiness.json"
npm run supervisor:prelive > "$RUN_DIR/supervisor.out" 2>&1 || true
validate_precheck_evidence

CANARY_MARKET_ID="$(read_fresh_target)"
say "arming Stage 5 single-market canary for marketId=$CANARY_MARKET_ID"
set_env_value ENABLE_LIVE_TRADING true
set_env_value LIVE_AUTO_EXECUTE true
set_env_value LIVE_KILL_SWITCH false
set_env_value LIVE_DRY_RUN_ONLY false
set_env_value LIVE_SUBMIT_CONFIRM true
set_env_value LIVE_FINAL_BOSS_READY true
set_env_value LIVE_TRADING_STAGE 5
set_env_value LIVE_CANARY_MARKET_ID "$CANARY_MARKET_ID"
set_env_value MAX_LIVE_ORDER_USD 5
set_env_value MAX_LIVE_TOTAL_EXPOSURE_USD 5
set_env_value LIVE_DAILY_MAX_LOSS_USD 5
set_env_value LIVE_MAX_ORDERS_PER_HOUR 1
set_env_value AUTO_LIVE_MIN_CONFIDENCE 0.47
set_env_value LIVE_ROUTER_MODE submit
restart_canary_processes

CANDIDATES_BEFORE="$(wc -l < auto_live_candidates.ndjson 2>/dev/null || printf 0)"
INTENTS_BEFORE="$(wc -l < trade_intents.ndjson 2>/dev/null || printf 0)"
ENGINE_LINES_BEFORE="$(wc -l < /home/lango/.pm2/logs/langomonEscript-out.log 2>/dev/null || printf 0)"
ROUTER_LINES_BEFORE="$(wc -l < /home/lango/.pm2/logs/liveIntentRouter-out.log 2>/dev/null || printf 0)"
ERROR_LINES_BEFORE="$(wc -l < /home/lango/.pm2/logs/langomonEscript-error.log 2>/dev/null || printf 0)"
ROUTER_ERROR_LINES_BEFORE="$(wc -l < /home/lango/.pm2/logs/liveIntentRouter-error.log 2>/dev/null || printf 0)"

deadline=$((SECONDS + WINDOW_SECONDS))
while (( SECONDS < deadline )); do
  if (( $(wc -l < auto_live_candidates.ndjson 2>/dev/null || printf 0) > CANDIDATES_BEFORE )); then die 'new auto_live_candidates.ndjson line'; fi
  if (( $(wc -l < trade_intents.ndjson 2>/dev/null || printf 0) > INTENTS_BEFORE )); then die 'new trade_intents.ndjson line'; fi
  if { tail -n "+$((ENGINE_LINES_BEFORE + 1))" /home/lango/.pm2/logs/langomonEscript-out.log 2>/dev/null; tail -n "+$((ROUTER_LINES_BEFORE + 1))" /home/lango/.pm2/logs/liveIntentRouter-out.log 2>/dev/null; } | rg -qi 'LIVE-ADAPTER.*(submit|refus)|submitted|LIVE_CANARY_MARKET_MISMATCH|MAX_LIVE_.*_EXCEEDED'; then die 'live adapter/router stop condition'; fi
  if { tail -n "+$((ERROR_LINES_BEFORE + 1))" /home/lango/.pm2/logs/langomonEscript-error.log 2>/dev/null; tail -n "+$((ROUTER_ERROR_LINES_BEFORE + 1))" /home/lango/.pm2/logs/liveIntentRouter-error.log 2>/dev/null; } | rg -qi '.+'; then die 'process error detected'; fi
  sleep 2
done

say "completed bounded ${WINDOW_SECONDS}-second armed window without a stop condition"
