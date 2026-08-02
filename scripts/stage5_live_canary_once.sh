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
BASELINE_VERIFIED=0
ARMING_STARTED=0
PM2_RESTARTED_FOR_ARM=0
BASELINE_MISMATCHES=()

BASELINE_KEYS=(
  ENABLE_LIVE_TRADING LIVE_AUTO_EXECUTE LIVE_KILL_SWITCH LIVE_DRY_RUN_ONLY
  LIVE_SUBMIT_CONFIRM LIVE_FINAL_BOSS_READY LIVE_TRADING_STAGE LIVE_CANARY_MARKET_ID
  MAX_LIVE_ORDER_USD MAX_LIVE_TOTAL_EXPOSURE_USD LIVE_DAILY_MAX_LOSS_USD
  LIVE_MAX_ORDERS_PER_HOUR AUTO_LIVE_MIN_CONFIDENCE LIVE_ROUTER_MODE
)
BASELINE_EXPECTED=(
  false false true true false false 2 '' 1 1 1 1 0.67 dry-run
)

mkdir -p "$RUN_DIR"

say() { printf '[stage5-canary] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

matching_assignment_count() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { count += 1 }
    END { print count + 0 }
  ' "$ENV_FILE"
}

first_assignment_raw_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub(/^[^=]*=/, ""); print; exit
    }
  ' "$ENV_FILE"
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

baseline_diagnostics() {
  local i key expected count raw trimmed problem
  BASELINE_MISMATCHES=()
  if [[ ! -f "$ENV_FILE" ]]; then
    say "baseline .env is missing: $ENV_FILE"
    BASELINE_MISMATCHES+=(.env_missing)
    return 1
  fi
  for i in "${!BASELINE_KEYS[@]}"; do
    key="${BASELINE_KEYS[$i]}"
    expected="${BASELINE_EXPECTED[$i]}"
    count="$(matching_assignment_count "$key")"
    raw="$(first_assignment_raw_value "$key")"
    trimmed="$(trim_value "$raw")"
    problem='ok'
    if [[ "$count" == 0 ]]; then
      problem='missing'
    elif [[ "$count" != 1 ]]; then
      problem='duplicate'
    elif [[ "$raw" == '"'* || "$raw" == "'"* ]]; then
      problem='quoted'
    elif [[ "$raw" != "$trimmed" ]]; then
      problem='whitespace-different'
    elif [[ "$trimmed" != "$expected" ]]; then
      problem='incorrect'
    fi
    printf '[stage5-canary] baseline key=%s expected=%q actual=%q assignments=%s status=%s\n' \
      "$key" "$expected" "$raw" "$count" "$problem"
    [[ "$problem" == ok ]] || BASELINE_MISMATCHES+=("$key:$problem")
  done
  ((${#BASELINE_MISMATCHES[@]} == 0))
}

require_safe_baseline() {
  if ! baseline_diagnostics; then
    die "LOCK LIVE OFF FIRST: baseline mismatches: ${BASELINE_MISMATCHES[*]}"
  fi
  BASELINE_VERIFIED=1
}

baseline_parser_selfcheck() {
  local fixture previous_env
  fixture="$(mktemp /tmp/stage5-baseline-selfcheck.XXXXXX)"
  previous_env="$ENV_FILE"
  printf '%s\n' \
    'ENABLE_LIVE_TRADING=false' 'ENABLE_LIVE_TRADING=false' \
    'LIVE_AUTO_EXECUTE=false' 'LIVE_KILL_SWITCH=true' 'LIVE_DRY_RUN_ONLY=true' \
    'LIVE_SUBMIT_CONFIRM=false' 'LIVE_FINAL_BOSS_READY=false' 'LIVE_TRADING_STAGE=2' \
    'LIVE_CANARY_MARKET_ID=' 'MAX_LIVE_ORDER_USD=1' 'MAX_LIVE_TOTAL_EXPOSURE_USD=1' \
    'LIVE_DAILY_MAX_LOSS_USD=1' 'LIVE_MAX_ORDERS_PER_HOUR=1' \
    'AUTO_LIVE_MIN_CONFIDENCE=0.67' 'LIVE_ROUTER_MODE="dry-run"' > "$fixture"
  ENV_FILE="$fixture"
  if baseline_diagnostics; then
    rm -f "$fixture"
    ENV_FILE="$previous_env"
    die 'baseline parser selfcheck expected duplicate/quoted values to fail'
  fi
  [[ " ${BASELINE_MISMATCHES[*]} " == *' ENABLE_LIVE_TRADING:duplicate '* ]] || die 'baseline parser selfcheck missed duplicate'
  [[ " ${BASELINE_MISMATCHES[*]} " == *' LIVE_ROUTER_MODE:quoted '* ]] || die 'baseline parser selfcheck missed quoted value'
  rm -f "$fixture"
  ENV_FILE="$previous_env"
  say 'baseline parser selfcheck: ok'
}

if [[ "${1:-}" == '--selfcheck-baseline' ]]; then
  baseline_parser_selfcheck
  exit 0
fi

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

env_checksum() {
  if [[ -f "$ENV_FILE" ]]; then
    cksum "$ENV_FILE"
  else
    printf 'MISSING\n'
  fi
}

restore_safe_baseline_if_changed() {
  local before after
  before="$(env_checksum)"
  set_safe_stage2_baseline
  after="$(env_checksum)"
  [[ "$before" != "$after" ]]
}

post_lockoff_audit() {
  say 'safe flag grep:'
  grep -E '^(ENABLE_LIVE_TRADING|LIVE_AUTO_EXECUTE|LIVE_KILL_SWITCH|LIVE_DRY_RUN_ONLY|LIVE_SUBMIT_CONFIRM|LIVE_FINAL_BOSS_READY|LIVE_TRADING_STAGE|LIVE_CANARY_MARKET_ID|MAX_LIVE_ORDER_USD|MAX_LIVE_TOTAL_EXPOSURE_USD|LIVE_DAILY_MAX_LOSS_USD|LIVE_MAX_ORDERS_PER_HOUR|AUTO_LIVE_MIN_CONFIDENCE|LIVE_ROUTER_MODE)=' "$ENV_FILE" || true
  npm run supervisor:prelive || true
  say 'recent candidates:'; tail -n 20 auto_live_candidates.ndjson 2>/dev/null || true
  say 'recent intents:'; tail -n 20 trade_intents.ndjson 2>/dev/null || true
  say 'recent filtered PM2 logs:'
  grep -Ein 'AUTO-LIVE CANDIDATE|LIVE-ADAPTER|LIVE INTENT|submitted|refused|AUTO_EXECUTE_DISABLED|LIVE_CANARY_MARKET|MAX_LIVE|ORDER_PLACED|Live Safety|gabagool_loss_guard' \
    /home/lango/.pm2/logs/langomonEscript* /home/lango/.pm2/logs/liveIntentRouter* /home/lango/.pm2/logs/telegramApprovalBot* 2>/dev/null | tail -n 300 || true
}

lock_off() {
  local rc="$?"
  [[ "$LOCKED" == 1 ]] && return "$rc"
  LOCKED=1
  set +e
  if (( ARMING_STARTED )); then
    say 'arming began: restoring the Stage 2 safe baseline and restarting PM2'
    (( PM2_RESTARTED_FOR_ARM )) && say 'PM2 had already been restarted for the armed configuration'
    restore_safe_baseline_if_changed
    restart_canary_processes
  elif (( BASELINE_VERIFIED )); then
    say 'pre-arm failure: baseline was verified; leaving .env and PM2 unchanged'
  else
    say 'baseline was not verified: restoring the Stage 2 safe baseline only if changed'
    if restore_safe_baseline_if_changed; then
      say '.env changed during safe-baseline restoration; restarting PM2'
      restart_canary_processes
    else
      say '.env already matched the safe baseline; PM2 restart skipped'
    fi
  fi
  post_lockoff_audit
  return "$rc"
}
trap lock_off EXIT INT TERM ERR

validate_precheck_evidence() {
  node - "$RUN_DIR/readiness.json" "$RUN_DIR/supervisor.out" "$RUN_DIR" <<'NODE'
const fs = require('fs');
const [readinessPath, supervisorPath, runDir] = process.argv.slice(2);
const readiness = JSON.parse(fs.readFileSync(readinessPath, 'utf8'));
const health = readiness.paperEngineHealth || {};
const audit = health.exposureAudit || {};
const guard = health.gabagagoolEntryGuard || health.gabagoolEntryGuard || {};
const bad = [];
const stage5CapUsd = 5;
const capBlockingExposureUsd = Number(audit.capBlockingExposureUsd);
const riskExposureUsd = Number(audit.riskExposureUsd ?? health.activeTradableExposureUsd);
const excludedDeadExposureUsd = Number(audit.excludedDeadExposureUsd || 0);
const portfolioExposureUsd = Number(audit.portfolioExposureUsd ?? health.totalExposureUsd ?? 0);
const exposureAvailableUsd = Number(audit.exposureAvailableUsd ?? NaN);
const excludedDeadExposureReasons = String(audit.excludedDeadExposureReasons || '');
const summary = {
  portfolioExposureUsd,
  excludedDeadExposureUsd,
  capBlockingExposureUsd,
  riskExposureUsd,
  stage5CapUsd,
  exposureAvailableUsd,
  excludedDeadExposureReasons,
};
fs.writeFileSync(`${runDir}/prearm-exposure-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[stage5-canary] pre-arm exposure summary ${JSON.stringify(summary)}`);
if (Number(health.openOrders) !== 0) bad.push('openOrders must be 0');
if (!Number.isFinite(capBlockingExposureUsd) || capBlockingExposureUsd > stage5CapUsd) bad.push('capBlockingExposureUsd must be <= $5');
if (!Number.isFinite(riskExposureUsd) || riskExposureUsd > stage5CapUsd) bad.push('riskExposureUsd must be <= $5');
if (excludedDeadExposureUsd > 0 && !/(excluded|dead|expired.*btc.*5m)/i.test(excludedDeadExposureReasons)) {
  bad.push('excludedDeadExposureUsd is not labeled excluded/dead expired BTC 5m exposure');
}
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
grep -qx 'live_final_boss_selfcheck: ok' "$RUN_DIR/final-boss.out" || die 'final-boss selfcheck did not pass'
npm run live:readiness | tee "$RUN_DIR/readiness.raw" || true
awk '/^[[:space:]]*\{/{printing=1} printing{print}' "$RUN_DIR/readiness.raw" > "$RUN_DIR/readiness.json"
npm run supervisor:prelive > "$RUN_DIR/supervisor.out" 2>&1 || true
validate_precheck_evidence

CANARY_MARKET_ID="$(read_fresh_target)"
say "arming Stage 5 single-market canary for marketId=$CANARY_MARKET_ID"
ARMING_STARTED=1
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
PM2_RESTARTED_FOR_ARM=1
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
  if { tail -n "+$((ENGINE_LINES_BEFORE + 1))" /home/lango/.pm2/logs/langomonEscript-out.log 2>/dev/null; tail -n "+$((ROUTER_LINES_BEFORE + 1))" /home/lango/.pm2/logs/liveIntentRouter-out.log 2>/dev/null; } | grep -Eqi 'LIVE-ADAPTER.*(submit|refus)|submitted|LIVE_CANARY_MARKET_MISMATCH|MAX_LIVE_.*_EXCEEDED'; then die 'live adapter/router stop condition'; fi
  if { tail -n "+$((ERROR_LINES_BEFORE + 1))" /home/lango/.pm2/logs/langomonEscript-error.log 2>/dev/null; tail -n "+$((ROUTER_ERROR_LINES_BEFORE + 1))" /home/lango/.pm2/logs/liveIntentRouter-error.log 2>/dev/null; } | grep -Eqi '.+'; then die 'process error detected'; fi
  sleep 2
done

say "completed bounded ${WINDOW_SECONDS}-second armed window without a stop condition"
