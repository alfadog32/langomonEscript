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
RUN_MONITOR_BASELINES_CAPTURED=0
RUN_MONITOR_END_BOUNDARY_CAPTURED=0
RUN_STARTED_AT=''
ARMED_AT=''
RUN_MONITOR_ENDED_AT=''
LOCKED_OFF_AT=''
CANARY_MARKET_ID=''
CANDIDATE_SEEN=0
INTENT_SEEN=0
ADAPTER_SUBMITTED=0
ADAPTER_REFUSED=0
PIPELINE_STALLED=0
PROCESS_ERROR=0
CANDIDATE_SEEN_SECONDS=0
INTENT_SEEN_SECONDS=0
TERMINAL_REASONS=()
CANDIDATES_BEFORE=0 INTENTS_BEFORE=0 ROUTER_EVENTS_BEFORE=0 ADAPTER_EVENTS_BEFORE=0 EXECUTION_EVENTS_BEFORE=0
ENGINE_OUT_LINES_BEFORE=0 ENGINE_ERROR_LINES_BEFORE=0 ROUTER_OUT_LINES_BEFORE=0 ROUTER_ERROR_LINES_BEFORE=0
CANDIDATES_END=0 INTENTS_END=0 ROUTER_EVENTS_END=0 ADAPTER_EVENTS_END=0 EXECUTION_EVENTS_END=0
ENGINE_OUT_LINES_END=0 ENGINE_ERROR_LINES_END=0 ROUTER_OUT_LINES_END=0 ROUTER_ERROR_LINES_END=0
SAFE_BASELINE_RESTORED=false
SAFE_BASELINE_MISMATCHES=()
ARMED_RUNTIME_VERIFIED=false
ARMED_RUNTIME_MISMATCHES=()
ROUTER_MODE_OBSERVED_DURING_ARM=''
ENGINE_PM2_ENV_VERIFIED=false
ROUTER_PM2_ENV_VERIFIED=false
SAFE_RUNTIME_VERIFIED=false
SAFE_RUNTIME_MISMATCHES=()
ROUTER_MODE_OBSERVED_AFTER_LOCKOFF=''
ENGINE_OUT_LINES_AT_ARM_RESTART=0
ENGINE_OUT_LINES_AT_SAFE_RESTART=0

CANDIDATES_FILE="$ROOT/auto_live_candidates.ndjson"
INTENTS_FILE="$ROOT/trade_intents.ndjson"
# Defaults verified from live_intent_router.js and live_adapter_polymarket.js.
ROUTER_EVENTS_FILE="$ROOT/live_intent_router_events.ndjson"
ADAPTER_EVENTS_FILE="$ROOT/live_adapter_events.ndjson"
EXECUTION_EVENTS_FILE="$ROOT/live_execution_events.ndjson"
ENGINE_OUT_LOG='/home/lango/.pm2/logs/langomonEscript-out.log'
ENGINE_ERROR_LOG='/home/lango/.pm2/logs/langomonEscript-error.log'
ROUTER_OUT_LOG='/home/lango/.pm2/logs/liveIntentRouter-out.log'
ROUTER_ERROR_LOG='/home/lango/.pm2/logs/liveIntentRouter-error.log'
SECRETS_FILE="$ROOT/.env.live.secrets"

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

line_count() {
  local file="$1"
  [[ -f "$file" ]] && wc -l < "$file" || printf '0\n'
}

appended_lines() {
  local file="$1" offset="$2"
  [[ -f "$file" ]] && tail -n "+$((offset + 1))" "$file" || true
}

bounded_lines() {
  local file="$1" start="$2" end="$3"
  [[ -f "$file" && "$end" -gt "$start" ]] || return 0
  sed -n "$((start + 1)),$end p" "$file"
}

capture_run_monitor_end_boundary() {
  (( RUN_MONITOR_BASELINES_CAPTURED && ! RUN_MONITOR_END_BOUNDARY_CAPTURED )) || return 0
  RUN_MONITOR_ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  CANDIDATES_END="$(line_count "$CANDIDATES_FILE")"
  INTENTS_END="$(line_count "$INTENTS_FILE")"
  ROUTER_EVENTS_END="$(line_count "$ROUTER_EVENTS_FILE")"
  ADAPTER_EVENTS_END="$(line_count "$ADAPTER_EVENTS_FILE")"
  EXECUTION_EVENTS_END="$(line_count "$EXECUTION_EVENTS_FILE")"
  ENGINE_OUT_LINES_END="$(line_count "$ENGINE_OUT_LOG")"
  ENGINE_ERROR_LINES_END="$(line_count "$ENGINE_ERROR_LOG")"
  ROUTER_OUT_LINES_END="$(line_count "$ROUTER_OUT_LOG")"
  ROUTER_ERROR_LINES_END="$(line_count "$ROUTER_ERROR_LOG")"
  RUN_MONITOR_END_BOUNDARY_CAPTURED=1
  validate_run_monitor_end_boundary
}

add_terminal_reason_once() {
  local reason="$1" existing
  for existing in "${TERMINAL_REASONS[@]}"; do
    [[ "$existing" == "$reason" ]] && return 0
  done
  TERMINAL_REASONS+=("$reason")
}

validate_run_monitor_end_boundary() {
  if (( CANDIDATES_END < CANDIDATES_BEFORE || INTENTS_END < INTENTS_BEFORE || ROUTER_EVENTS_END < ROUTER_EVENTS_BEFORE || ADAPTER_EVENTS_END < ADAPTER_EVENTS_BEFORE || EXECUTION_EVENTS_END < EXECUTION_EVENTS_BEFORE || ENGINE_OUT_LINES_END < ENGINE_OUT_LINES_BEFORE || ENGINE_ERROR_LINES_END < ENGINE_ERROR_LINES_BEFORE || ROUTER_OUT_LINES_END < ROUTER_OUT_LINES_BEFORE || ROUTER_ERROR_LINES_END < ROUTER_ERROR_LINES_BEFORE )); then
    PROCESS_ERROR=1
    add_terminal_reason_once LOG_ROTATED_OR_TRUNCATED_AT_END_BOUNDARY
  fi
}

nonnegative_delta() {
  local start="$1" end="$2"
  (( end >= start )) && printf '%s' "$((end - start))" || printf '0'
}

derive_run_result() {
  if (( PROCESS_ERROR )); then printf 'PROCESS_ERROR';
  elif (( ARMING_STARTED )) && [[ "$ARMED_RUNTIME_VERIFIED" != true ]]; then printf 'PROCESS_ERROR';
  elif (( ADAPTER_SUBMITTED )); then printf 'SUBMITTED';
  elif (( ADAPTER_REFUSED )); then printf 'ADAPTER_REFUSED';
  elif (( PIPELINE_STALLED )); then printf 'PIPELINE_STALLED';
  elif (( INTENT_SEEN )); then printf 'INTENT_ONLY';
  elif (( CANDIDATE_SEEN )); then printf 'CANDIDATE_ONLY';
  else printf 'NO_CANDIDATE'; fi
}

run_summary_selfcheck() {
  local saved_candidate="$CANDIDATE_SEEN" saved_intent="$INTENT_SEEN" saved_submitted="$ADAPTER_SUBMITTED"
  local saved_refused="$ADAPTER_REFUSED" saved_stalled="$PIPELINE_STALLED" saved_error="$PROCESS_ERROR"
  CANDIDATE_SEEN=0 INTENT_SEEN=0 ADAPTER_SUBMITTED=0 ADAPTER_REFUSED=0 PIPELINE_STALLED=0 PROCESS_ERROR=0
  [[ "$(derive_run_result)" == NO_CANDIDATE ]] || die 'run summary selfcheck missed NO_CANDIDATE'
  CANDIDATE_SEEN=1
  [[ "$(derive_run_result)" == CANDIDATE_ONLY ]] || die 'run summary selfcheck missed CANDIDATE_ONLY'
  INTENT_SEEN=1
  [[ "$(derive_run_result)" == INTENT_ONLY ]] || die 'run summary selfcheck missed INTENT_ONLY'
  INTENT_SEEN=0 PIPELINE_STALLED=1
  [[ "$(derive_run_result)" == PIPELINE_STALLED ]] || die 'run summary selfcheck missed PIPELINE_STALLED'
  PIPELINE_STALLED=0 INTENT_SEEN=1
  ADAPTER_REFUSED=1
  [[ "$(derive_run_result)" == ADAPTER_REFUSED ]] || die 'run summary selfcheck missed ADAPTER_REFUSED'
  ADAPTER_REFUSED=0 ADAPTER_SUBMITTED=1
  [[ "$(derive_run_result)" == SUBMITTED ]] || die 'run summary selfcheck missed SUBMITTED'
  PROCESS_ERROR=1
  [[ "$(derive_run_result)" == PROCESS_ERROR ]] || die 'run summary selfcheck missed PROCESS_ERROR'
  CANDIDATE_SEEN="$saved_candidate" INTENT_SEEN="$saved_intent" ADAPTER_SUBMITTED="$saved_submitted"
  ADAPTER_REFUSED="$saved_refused" PIPELINE_STALLED="$saved_stalled" PROCESS_ERROR="$saved_error"
  CANDIDATES_BEFORE=5 INTENTS_BEFORE=5 ROUTER_EVENTS_BEFORE=5 ADAPTER_EVENTS_BEFORE=5 EXECUTION_EVENTS_BEFORE=5
  ENGINE_OUT_LINES_BEFORE=5 ENGINE_ERROR_LINES_BEFORE=5 ROUTER_OUT_LINES_BEFORE=5 ROUTER_ERROR_LINES_BEFORE=5
  CANDIDATES_END=5 INTENTS_END=4 ROUTER_EVENTS_END=5 ADAPTER_EVENTS_END=5 EXECUTION_EVENTS_END=5
  ENGINE_OUT_LINES_END=5 ENGINE_ERROR_LINES_END=5 ROUTER_OUT_LINES_END=5 ROUTER_ERROR_LINES_END=5
  PROCESS_ERROR=0 TERMINAL_REASONS=()
  validate_run_monitor_end_boundary
  [[ "$PROCESS_ERROR" == 1 && " ${TERMINAL_REASONS[*]} " == *' LOG_ROTATED_OR_TRUNCATED_AT_END_BOUNDARY '* ]] || die 'run summary selfcheck missed end-boundary truncation'
  say 'run summary state-machine selfcheck: ok'
}

runtime_environment_selfcheck() {
  local dir previous_env previous_secrets previous_fixture
  dir="$(mktemp -d /tmp/stage5-runtime-env-selfcheck.XXXXXX)"
  previous_env="$ENV_FILE"; previous_secrets="$SECRETS_FILE"; previous_fixture="${PM2_JLIST_FIXTURE:-}"
  ENV_FILE="$dir/runtime.env"; SECRETS_FILE="$dir/runtime.secrets"
  printf '%s\n' 'ENABLE_LIVE_TRADING=true' 'LIVE_AUTO_EXECUTE=true' 'LIVE_KILL_SWITCH=false' 'LIVE_DRY_RUN_ONLY=false' 'LIVE_SUBMIT_CONFIRM=true' 'LIVE_FINAL_BOSS_READY=true' 'LIVE_TRADING_STAGE=5' 'LIVE_CANARY_MARKET_ID=fixture-market' 'MAX_LIVE_ORDER_USD=5' 'MAX_LIVE_TOTAL_EXPOSURE_USD=5' 'LIVE_DAILY_MAX_LOSS_USD=5' 'LIVE_MAX_ORDERS_PER_HOUR=1' 'AUTO_LIVE_MIN_CONFIDENCE=0.47' 'LIVE_ROUTER_MODE=submit' > "$ENV_FILE"
  printf '%s\n' 'TEST_SECRET_SENTINEL=fixture-only-not-printed' > "$SECRETS_FILE"
  load_runtime_environment && verify_shell_profile armed fixture-market || die 'runtime environment selfcheck missed armed load'
  node -e 'const fs=require("fs"); const env={ENABLE_LIVE_TRADING:"true",LIVE_AUTO_EXECUTE:"true",LIVE_KILL_SWITCH:"false",LIVE_DRY_RUN_ONLY:"false",LIVE_SUBMIT_CONFIRM:"true",LIVE_FINAL_BOSS_READY:"true",LIVE_TRADING_STAGE:"5",LIVE_CANARY_MARKET_ID:"fixture-market",MAX_LIVE_ORDER_USD:"5",MAX_LIVE_TOTAL_EXPOSURE_USD:"5",LIVE_DAILY_MAX_LOSS_USD:"5",LIVE_MAX_ORDERS_PER_HOUR:"1",AUTO_LIVE_MIN_CONFIDENCE:"0.47",LIVE_ROUTER_MODE:"submit"}; fs.writeFileSync(process.argv[1],JSON.stringify(["liveIntentRouter","langomonEscript"].map(name=>({name,pm2_env:{status:"online",env}}))))' "$dir/pm2.json"
  PM2_JLIST_FIXTURE="$dir/pm2.json"
  pm2_profile_matches liveIntentRouter armed fixture-market true && pm2_profile_matches langomonEscript armed fixture-market true || die 'runtime environment selfcheck missed armed PM2 profile'
  printf '%s\n' 'ENABLE_LIVE_TRADING=false' 'LIVE_AUTO_EXECUTE=false' 'LIVE_KILL_SWITCH=true' 'LIVE_DRY_RUN_ONLY=true' 'LIVE_SUBMIT_CONFIRM=false' 'LIVE_FINAL_BOSS_READY=false' 'LIVE_TRADING_STAGE=2' 'LIVE_CANARY_MARKET_ID=' 'MAX_LIVE_ORDER_USD=1' 'MAX_LIVE_TOTAL_EXPOSURE_USD=1' 'LIVE_DAILY_MAX_LOSS_USD=1' 'LIVE_MAX_ORDERS_PER_HOUR=1' 'AUTO_LIVE_MIN_CONFIDENCE=0.67' 'LIVE_ROUTER_MODE=dry-run' > "$ENV_FILE"
  load_runtime_environment && verify_shell_profile safe '' || die 'runtime environment selfcheck missed safe replacement'
  node -e 'const fs=require("fs"); const env={ENABLE_LIVE_TRADING:"false",LIVE_AUTO_EXECUTE:"false",LIVE_KILL_SWITCH:"true",LIVE_DRY_RUN_ONLY:"true",LIVE_SUBMIT_CONFIRM:"false",LIVE_FINAL_BOSS_READY:"false",LIVE_TRADING_STAGE:"2",LIVE_CANARY_MARKET_ID:"",MAX_LIVE_ORDER_USD:"1",MAX_LIVE_TOTAL_EXPOSURE_USD:"1",LIVE_DAILY_MAX_LOSS_USD:"1",LIVE_MAX_ORDERS_PER_HOUR:"1",AUTO_LIVE_MIN_CONFIDENCE:"0.67",LIVE_ROUTER_MODE:"dry-run"}; fs.writeFileSync(process.argv[1],JSON.stringify(["liveIntentRouter","langomonEscript"].map(name=>({name,pm2_env:{status:"online",env}}))))' "$dir/pm2.json"
  pm2_profile_matches liveIntentRouter safe '' true && pm2_profile_matches langomonEscript safe '' true || die 'runtime environment selfcheck missed safe PM2 profile'
  node -e 'const fs=require("fs"),p=process.argv[1],x=JSON.parse(fs.readFileSync(p)); x[0].pm2_env.env.MAX_LIVE_ORDER_USD="9"; fs.writeFileSync(p,JSON.stringify(x))' "$dir/pm2.json"
  if pm2_profile_matches liveIntentRouter safe '' true; then die 'runtime environment selfcheck missed MAX_LIVE_ORDER_USD mismatch'; fi
  [[ " ${SAFE_RUNTIME_MISMATCHES[*]} " == *' liveIntentRouter:MAX_LIVE_ORDER_USD '* ]] || die 'runtime environment selfcheck missed non-secret mismatch name'
  node -e 'const fs=require("fs"),p=process.argv[1],x=JSON.parse(fs.readFileSync(p)); x[0].pm2_env.env.MAX_LIVE_ORDER_USD="1"; x[0].pm2_env.env.AUTO_LIVE_MIN_CONFIDENCE="0.9"; fs.writeFileSync(p,JSON.stringify(x))' "$dir/pm2.json"
  if pm2_profile_matches liveIntentRouter safe '' true; then die 'runtime environment selfcheck missed AUTO_LIVE_MIN_CONFIDENCE mismatch'; fi
  node -e 'const fs=require("fs"),p=process.argv[1],x=JSON.parse(fs.readFileSync(p)); x[0].pm2_env.env.AUTO_LIVE_MIN_CONFIDENCE="0.67"; x[0].pm2_env.env.LIVE_ROUTER_MODE="submit"; fs.writeFileSync(p,JSON.stringify(x))' "$dir/pm2.json"
  if pm2_profile_matches liveIntentRouter safe '' true; then die 'runtime environment selfcheck missed LIVE_ROUTER_MODE mismatch'; fi
  node -e 'const fs=require("fs"),p=process.argv[1],x=JSON.parse(fs.readFileSync(p)); x[0].pm2_env.env.LIVE_ROUTER_MODE="dry-run"; x[0].pm2_env.status="stopped"; fs.writeFileSync(p,JSON.stringify(x))' "$dir/pm2.json"
  if pm2_profile_matches liveIntentRouter safe '' true; then die 'runtime environment selfcheck missed offline status'; fi
  rm -rf "$dir"
  ENV_FILE="$previous_env"; SECRETS_FILE="$previous_secrets"; PM2_JLIST_FIXTURE="$previous_fixture"
  say 'runtime environment propagation selfcheck: ok'
}

if [[ "${1:-}" == '--selfcheck-baseline' ]]; then
  baseline_parser_selfcheck
  exit 0
fi
if [[ "${1:-}" == '--selfcheck-run-summary' ]]; then
  run_summary_selfcheck
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

load_runtime_environment() {
  [[ -r "$ENV_FILE" && -r "$SECRETS_FILE" ]] || return 1
  set -a
  # Intentionally no tracing or environment output: this only prepares PM2.
  . "$ENV_FILE"
  . "$SECRETS_FILE"
  set +a
}

verify_shell_profile() {
  local profile="$1" market="$2" key expected i
  local -a keys values
  if [[ "$profile" == armed ]]; then
    keys=(ENABLE_LIVE_TRADING LIVE_AUTO_EXECUTE LIVE_KILL_SWITCH LIVE_DRY_RUN_ONLY LIVE_SUBMIT_CONFIRM LIVE_FINAL_BOSS_READY LIVE_TRADING_STAGE LIVE_CANARY_MARKET_ID MAX_LIVE_ORDER_USD MAX_LIVE_TOTAL_EXPOSURE_USD LIVE_DAILY_MAX_LOSS_USD LIVE_MAX_ORDERS_PER_HOUR AUTO_LIVE_MIN_CONFIDENCE LIVE_ROUTER_MODE)
    values=(true true false false true true 5 "$market" 5 5 5 1 0.47 submit)
  else
    keys=(ENABLE_LIVE_TRADING LIVE_AUTO_EXECUTE LIVE_KILL_SWITCH LIVE_DRY_RUN_ONLY LIVE_SUBMIT_CONFIRM LIVE_FINAL_BOSS_READY LIVE_TRADING_STAGE LIVE_CANARY_MARKET_ID MAX_LIVE_ORDER_USD MAX_LIVE_TOTAL_EXPOSURE_USD LIVE_DAILY_MAX_LOSS_USD LIVE_MAX_ORDERS_PER_HOUR AUTO_LIVE_MIN_CONFIDENCE LIVE_ROUTER_MODE)
    values=(false false true true false false 2 '' 1 1 1 1 0.67 dry-run)
  fi
  for i in "${!keys[@]}"; do
    key="${keys[$i]}"
    expected="${values[$i]}"
    [[ "${!key:-}" == "$expected" ]] || return 1
  done
}

pm2_jlist() {
  if [[ -n "${PM2_JLIST_FIXTURE:-}" ]]; then
    node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]))' "$PM2_JLIST_FIXTURE"
  else
    pm2 jlist
  fi
}

record_runtime_mismatches() {
  local profile="$1" details="$2" entry existing
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    if [[ "$profile" == armed ]]; then
      for existing in "${ARMED_RUNTIME_MISMATCHES[@]}"; do [[ "$existing" == "$entry" ]] && continue 2; done
      ARMED_RUNTIME_MISMATCHES+=("$entry")
    else
      for existing in "${SAFE_RUNTIME_MISMATCHES[@]}"; do [[ "$existing" == "$entry" ]] && continue 2; done
      SAFE_RUNTIME_MISMATCHES+=("$entry")
    fi
  done <<< "$details"
}

pm2_profile_matches() {
  local process_name="$1" profile="$2" market="$3" include_router_mode="$4"
  local details
  if details="$(pm2_jlist | node -e '
const fs = require("fs");
const [name, profile, market, includeRouterMode] = process.argv.slice(1);
const items = JSON.parse(fs.readFileSync(0, "utf8"));
const item = items.find((x) => x.name === name);
const env = item?.pm2_env?.env || {};
const expected = profile === "armed"
  ? { ENABLE_LIVE_TRADING: "true", LIVE_AUTO_EXECUTE: "true", LIVE_KILL_SWITCH: "false", LIVE_DRY_RUN_ONLY: "false", LIVE_SUBMIT_CONFIRM: "true", LIVE_FINAL_BOSS_READY: "true", LIVE_TRADING_STAGE: "5", LIVE_CANARY_MARKET_ID: market, MAX_LIVE_ORDER_USD: "5", MAX_LIVE_TOTAL_EXPOSURE_USD: "5", LIVE_DAILY_MAX_LOSS_USD: "5", LIVE_MAX_ORDERS_PER_HOUR: "1", AUTO_LIVE_MIN_CONFIDENCE: "0.47", LIVE_ROUTER_MODE: "submit" }
  : { ENABLE_LIVE_TRADING: "false", LIVE_AUTO_EXECUTE: "false", LIVE_KILL_SWITCH: "true", LIVE_DRY_RUN_ONLY: "true", LIVE_SUBMIT_CONFIRM: "false", LIVE_FINAL_BOSS_READY: "false", LIVE_TRADING_STAGE: "2", LIVE_CANARY_MARKET_ID: "", MAX_LIVE_ORDER_USD: "1", MAX_LIVE_TOTAL_EXPOSURE_USD: "1", LIVE_DAILY_MAX_LOSS_USD: "1", LIVE_MAX_ORDERS_PER_HOUR: "1", AUTO_LIVE_MIN_CONFIDENCE: "0.67", LIVE_ROUTER_MODE: "dry-run" };
const bad = Object.keys(expected).filter((key) => String(env[key] ?? "") !== expected[key]);
if (!item) { console.log(`${name}:missing`); process.exit(1); }
if (item.pm2_env?.status !== "online") bad.unshift("status");
if (bad.length) { for (const key of bad) console.log(`${name}:${key}`); process.exit(1); }
' \
  "$process_name" "$profile" "$market" "$include_router_mode")"; then
    return 0
  fi
  record_runtime_mismatches "$profile" "$details"
  return 1
}

wait_for_runtime_profile() {
  local profile="$1" market="$2" router_offset="$3" engine_offset="$4" deadline mode='' engine_safety=''
  deadline=$((SECONDS + 15))
  while (( SECONDS < deadline )); do
    mode="$(appended_lines "$ROUTER_EVENTS_FILE" "$router_offset" | sed -n 's/.*"type":"LIVE_ROUTER_STARTED".*"mode":"\([^"]*\)".*/\1/p' | tail -n 1)"
    if [[ "$profile" == armed ]]; then ROUTER_MODE_OBSERVED_DURING_ARM="$mode"; else ROUTER_MODE_OBSERVED_AFTER_LOCKOFF="$mode"; fi
    engine_safety="$(appended_lines "$ENGINE_OUT_LOG" "$engine_offset" | grep 'Live Safety:' | tail -n 1 || true)"
    if [[ -n "$engine_safety" && "$profile" == armed ]] && ! grep -q 'ENABLE_LIVE_TRADING=true LIVE_AUTO_EXECUTE=true LIVE_KILL_SWITCH=false LIVE_DRY_RUN_ONLY=false LIVE_SUBMIT_CONFIRM=true' <<< "$engine_safety"; then
      sleep 1; continue
    fi
    if [[ "$mode" == "$([[ "$profile" == armed ]] && printf submit || printf dry-run)" ]] && pm2_profile_matches liveIntentRouter "$profile" "$market" true && pm2_profile_matches langomonEscript "$profile" "$market" true; then
      [[ "$profile" == armed ]] && { ARMED_RUNTIME_VERIFIED=true; ROUTER_PM2_ENV_VERIFIED=true; ENGINE_PM2_ENV_VERIFIED=true; } || SAFE_RUNTIME_VERIFIED=true
      return 0
    fi
    sleep 1
  done
  return 1
}

if [[ "${1:-}" == '--selfcheck-runtime-environment' ]]; then
  runtime_environment_selfcheck
  exit 0
fi

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

write_run_summary() {
  (( RUN_MONITOR_BASELINES_CAPTURED && RUN_MONITOR_END_BOUNDARY_CAPTURED )) || return 0
  local result candidate_delta intent_delta router_event_delta adapter_event_delta execution_event_delta
  result="$(derive_run_result)"
  candidate_delta="$(nonnegative_delta "$CANDIDATES_BEFORE" "$CANDIDATES_END")"
  intent_delta="$(nonnegative_delta "$INTENTS_BEFORE" "$INTENTS_END")"
  router_event_delta="$(nonnegative_delta "$ROUTER_EVENTS_BEFORE" "$ROUTER_EVENTS_END")"
  adapter_event_delta="$(nonnegative_delta "$ADAPTER_EVENTS_BEFORE" "$ADAPTER_EVENTS_END")"
  execution_event_delta="$(nonnegative_delta "$EXECUTION_EVENTS_BEFORE" "$EXECUTION_EVENTS_END")"
  node - "$RUN_DIR/run-summary.json" "$RUN_STARTED_AT" "$ARMED_AT" "$RUN_MONITOR_ENDED_AT" "$LOCKED_OFF_AT" "$CANARY_MARKET_ID" \
    "$candidate_delta" "$intent_delta" "$router_event_delta" "$adapter_event_delta" "$execution_event_delta" \
    "$CANDIDATE_SEEN" "$INTENT_SEEN" "$ADAPTER_SUBMITTED" "$ADAPTER_REFUSED" "$SAFE_BASELINE_RESTORED" \
    "${SAFE_BASELINE_MISMATCHES[*]:-}" "$ARMED_RUNTIME_VERIFIED" "${ARMED_RUNTIME_MISMATCHES[*]:-}" \
    "$ROUTER_MODE_OBSERVED_DURING_ARM" "$ENGINE_PM2_ENV_VERIFIED" "$ROUTER_PM2_ENV_VERIFIED" \
    "$SAFE_RUNTIME_VERIFIED" "${SAFE_RUNTIME_MISMATCHES[*]:-}" "$ROUTER_MODE_OBSERVED_AFTER_LOCKOFF" "$result" "${TERMINAL_REASONS[*]:-}" <<'NODE'
const fs = require('fs');
const [file, runStartedAt, armedAt, runMonitorEndedAt, lockedOffAt, marketId, candidateDelta, intentDelta, routerEventDelta, adapterEventDelta, executionEventDelta, candidateSeen, intentSeen, adapterSubmitted, adapterRefused, safeBaselineRestored, baselineMismatches, armedRuntimeVerified, armedRuntimeMismatches, routerModeObservedDuringArm, enginePm2EnvVerified, routerPm2EnvVerified, safeRuntimeVerified, safeRuntimeMismatches, routerModeObservedAfterLockoff, result, reasons] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  runStartedAt, armedAt, runMonitorEndedAt, lockedOffAt, marketId,
  candidateDelta: Number(candidateDelta), intentDelta: Number(intentDelta), routerEventDelta: Number(routerEventDelta),
  adapterEventDelta: Number(adapterEventDelta), executionEventDelta: Number(executionEventDelta),
  candidateSeen: candidateSeen === '1', intentSeen: intentSeen === '1', adapterSubmitted: adapterSubmitted === '1',
  adapterRefused: adapterRefused === '1', safeBaselineRestored: safeBaselineRestored === 'true',
  safeBaselineMismatches: baselineMismatches ? baselineMismatches.split(' ') : [],
  armedRuntimeVerified: armedRuntimeVerified === 'true', armedRuntimeMismatches: armedRuntimeMismatches ? armedRuntimeMismatches.split(' ') : [],
  routerModeObservedDuringArm, enginePm2EnvVerified: enginePm2EnvVerified === 'true', routerPm2EnvVerified: routerPm2EnvVerified === 'true',
  safeRuntimeVerified: safeRuntimeVerified === 'true', safeRuntimeMismatches: safeRuntimeMismatches ? safeRuntimeMismatches.split(' ') : [],
  routerModeObservedAfterLockoff, terminalReasons: reasons ? reasons.split(' ') : [], result,
}, null, 2)}\n`);
NODE
}

post_lockoff_audit() {
  (( RUN_MONITOR_BASELINES_CAPTURED && RUN_MONITOR_END_BOUNDARY_CAPTURED )) || return 0
  say 'armed-window candidates:'; bounded_lines "$CANDIDATES_FILE" "$CANDIDATES_BEFORE" "$CANDIDATES_END"
  say 'armed-window intents:'; bounded_lines "$INTENTS_FILE" "$INTENTS_BEFORE" "$INTENTS_END"
  say 'armed-window router events:'; bounded_lines "$ROUTER_EVENTS_FILE" "$ROUTER_EVENTS_BEFORE" "$ROUTER_EVENTS_END"
  say 'armed-window adapter events:'; bounded_lines "$ADAPTER_EVENTS_FILE" "$ADAPTER_EVENTS_BEFORE" "$ADAPTER_EVENTS_END"
  say 'armed-window execution events:'; bounded_lines "$EXECUTION_EVENTS_FILE" "$EXECUTION_EVENTS_BEFORE" "$EXECUTION_EVENTS_END"
  say 'run-scoped engine/router logs:'
  { bounded_lines "$ENGINE_OUT_LOG" "$ENGINE_OUT_LINES_BEFORE" "$ENGINE_OUT_LINES_END"; bounded_lines "$ENGINE_ERROR_LOG" "$ENGINE_ERROR_LINES_BEFORE" "$ENGINE_ERROR_LINES_END"; bounded_lines "$ROUTER_OUT_LOG" "$ROUTER_OUT_LINES_BEFORE" "$ROUTER_OUT_LINES_END"; bounded_lines "$ROUTER_ERROR_LOG" "$ROUTER_ERROR_LINES_BEFORE" "$ROUTER_ERROR_LINES_END"; } | tail -n 300 || true
  say 'run summary:'; [[ -f "$RUN_DIR/run-summary.json" ]] && cat "$RUN_DIR/run-summary.json" || true
}

lock_off() {
  local rc="$?"
  [[ "$LOCKED" == 1 ]] && return "$rc"
  LOCKED=1
  # Freeze the armed-window boundary before changing .env or restarting PM2.
  capture_run_monitor_end_boundary
  (( PROCESS_ERROR )) && rc=1
  set +e
  if (( ARMING_STARTED )); then
    say 'arming began: restoring the Stage 2 safe baseline and restarting PM2'
    (( PM2_RESTARTED_FOR_ARM )) && say 'PM2 had already been restarted for the armed configuration'
    restore_safe_baseline_if_changed
    if load_runtime_environment && verify_shell_profile safe ''; then
      ENGINE_OUT_LINES_AT_SAFE_RESTART="$(line_count "$ENGINE_OUT_LOG")"
      restart_canary_processes
      if ! wait_for_runtime_profile safe '' "$ROUTER_EVENTS_END" "$ENGINE_OUT_LINES_AT_SAFE_RESTART"; then
        SAFE_RUNTIME_MISMATCHES+=(router_startup_or_pm2_environment)
        rc=1
      fi
    else
      SAFE_RUNTIME_MISMATCHES=(safe_shell_environment_or_secrets_unavailable)
      rc=1
    fi
  elif (( BASELINE_VERIFIED )); then
    say 'pre-arm failure: baseline was verified; leaving .env and PM2 unchanged'
  else
    say 'baseline was not verified: restoring the Stage 2 safe baseline only if changed'
    if restore_safe_baseline_if_changed; then
      say '.env changed during safe-baseline restoration; restarting PM2'
      if load_runtime_environment && verify_shell_profile safe ''; then
        ENGINE_OUT_LINES_AT_SAFE_RESTART="$(line_count "$ENGINE_OUT_LOG")"
        restart_canary_processes
        wait_for_runtime_profile safe '' "$ROUTER_EVENTS_END" "$ENGINE_OUT_LINES_AT_SAFE_RESTART" || { SAFE_RUNTIME_MISMATCHES+=(router_startup_or_pm2_environment); rc=1; }
      else
        SAFE_RUNTIME_MISMATCHES=(safe_shell_environment_or_secrets_unavailable); rc=1
      fi
    else
      say '.env already matched the safe baseline; PM2 restart skipped'
    fi
  fi
  if baseline_diagnostics; then
    SAFE_BASELINE_RESTORED=true
    SAFE_BASELINE_MISMATCHES=()
    say 'safe baseline verification: PASS'
  else
    SAFE_BASELINE_RESTORED=false
    SAFE_BASELINE_MISMATCHES=("${BASELINE_MISMATCHES[@]}")
    say "ERROR: SAFE BASELINE VERIFICATION FAILED: ${SAFE_BASELINE_MISMATCHES[*]}" >&2
    rc=1
  fi
  LOCKED_OFF_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_run_summary
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
# Capture the complete run boundary before any Stage 5 mutation or PM2 restart.
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CANDIDATES_BEFORE="$(line_count "$CANDIDATES_FILE")"
INTENTS_BEFORE="$(line_count "$INTENTS_FILE")"
ROUTER_EVENTS_BEFORE="$(line_count "$ROUTER_EVENTS_FILE")"
ADAPTER_EVENTS_BEFORE="$(line_count "$ADAPTER_EVENTS_FILE")"
EXECUTION_EVENTS_BEFORE="$(line_count "$EXECUTION_EVENTS_FILE")"
ENGINE_OUT_LINES_BEFORE="$(line_count "$ENGINE_OUT_LOG")"
ENGINE_ERROR_LINES_BEFORE="$(line_count "$ENGINE_ERROR_LOG")"
ROUTER_OUT_LINES_BEFORE="$(line_count "$ROUTER_OUT_LOG")"
ROUTER_ERROR_LINES_BEFORE="$(line_count "$ROUTER_ERROR_LOG")"
RUN_MONITOR_BASELINES_CAPTURED=1
say "captured pre-arm run boundary at $RUN_STARTED_AT for marketId=$CANARY_MARKET_ID"
say "arming Stage 5 single-market canary for marketId=$CANARY_MARKET_ID"
ARMING_STARTED=1
ARMED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
load_runtime_environment || die 'required runtime environment file is not readable'
verify_shell_profile armed "$CANARY_MARKET_ID" || die 'armed shell environment does not match requested Stage 5 profile'
PM2_RESTARTED_FOR_ARM=1
ENGINE_OUT_LINES_AT_ARM_RESTART="$(line_count "$ENGINE_OUT_LOG")"
restart_canary_processes
if ! wait_for_runtime_profile armed "$CANARY_MARKET_ID" "$ROUTER_EVENTS_BEFORE" "$ENGINE_OUT_LINES_AT_ARM_RESTART"; then
  PROCESS_ERROR=1
  add_terminal_reason_once ARM_RUNTIME_CONFIG_MISMATCH
  ARMED_RUNTIME_MISMATCHES=(router_startup_or_pm2_environment)
  die 'ARM_RUNTIME_CONFIG_MISMATCH: PM2 did not receive the Stage 5 runtime environment'
fi

deadline=$((SECONDS + WINDOW_SECONDS))
while (( SECONDS < deadline )); do
  if (( $(line_count "$CANDIDATES_FILE") < CANDIDATES_BEFORE || $(line_count "$INTENTS_FILE") < INTENTS_BEFORE || $(line_count "$ROUTER_EVENTS_FILE") < ROUTER_EVENTS_BEFORE || $(line_count "$ADAPTER_EVENTS_FILE") < ADAPTER_EVENTS_BEFORE || $(line_count "$EXECUTION_EVENTS_FILE") < EXECUTION_EVENTS_BEFORE || $(line_count "$ENGINE_OUT_LOG") < ENGINE_OUT_LINES_BEFORE || $(line_count "$ENGINE_ERROR_LOG") < ENGINE_ERROR_LINES_BEFORE || $(line_count "$ROUTER_OUT_LOG") < ROUTER_OUT_LINES_BEFORE || $(line_count "$ROUTER_ERROR_LOG") < ROUTER_ERROR_LINES_BEFORE )); then
    PROCESS_ERROR=1; TERMINAL_REASONS+=(LOG_ROTATED_OR_TRUNCATED); die 'LOG_ROTATED_OR_TRUNCATED: monitored source became shorter than its pre-arm offset'
  fi
  candidate_delta=$(( $(line_count "$CANDIDATES_FILE") - CANDIDATES_BEFORE ))
  intent_delta=$(( $(line_count "$INTENTS_FILE") - INTENTS_BEFORE ))
  if (( candidate_delta > 0 && ! CANDIDATE_SEEN )); then
    CANDIDATE_SEEN=1; CANDIDATE_SEEN_SECONDS=$SECONDS; say 'candidate observed; awaiting intent or terminal adapter result'
  fi
  if (( intent_delta > 0 && ! INTENT_SEEN )); then
    INTENT_SEEN=1; INTENT_SEEN_SECONDS=$SECONDS; say 'intent observed; awaiting terminal adapter result'
  fi
  router_events_new="$(appended_lines "$ROUTER_EVENTS_FILE" "$ROUTER_EVENTS_BEFORE")"
  adapter_events_new="$(appended_lines "$ADAPTER_EVENTS_FILE" "$ADAPTER_EVENTS_BEFORE")"
  execution_events_new="$(appended_lines "$EXECUTION_EVENTS_FILE" "$EXECUTION_EVENTS_BEFORE")"
  tagged_live_logs="$(printf '%s\n%s\n' \
    "$(appended_lines "$ENGINE_OUT_LOG" "$ENGINE_OUT_LINES_BEFORE")" \
    "$(appended_lines "$ROUTER_OUT_LOG" "$ROUTER_OUT_LINES_BEFORE")")"
  structured_events="$(printf '%s\n%s\n%s\n' \
    "$router_events_new" \
    "$adapter_events_new" \
    "$execution_events_new")"
  if grep -Eqi 'LIVE_ROUTER_ADAPTER_RESULT.*"adapter_decision"[[:space:]]*:[[:space:]]*"SUBMITTED"|LIVE_ORDER_SUBMITTED.*"decision"[[:space:]]*:[[:space:]]*"SUBMITTED"' <<< "$structured_events" || grep -Eqi '(LIVE-ADAPTER|\[live-router\]).*(submitted|LIVE_ORDER_SUBMITTED)' <<< "$tagged_live_logs"; then
    ADAPTER_SUBMITTED=1; TERMINAL_REASONS+=(STRUCTURED_OR_TAGGED_LIVE_SUBMISSION); die 'terminal adapter submission observed'
  fi
  if grep -Eqi 'LIVE_ROUTER_ADAPTER_RESULT.*"adapter_decision"[[:space:]]*:[[:space:]]*"REFUSED"|LIVE_(SUBMISSION|ADAPTER_EVALUATION)_REFUSED|LIVE_ADAPTER_EVALUATION.*"decision"[[:space:]]*:[[:space:]]*"REFUSED"|LIVE_CANARY_MARKET_MISMATCH|MAX_LIVE_.*_EXCEEDED|AUTO_EXECUTE_DISABLED' <<< "$structured_events" || grep -Eqi '(LIVE-ADAPTER|\[live-router\]).*(refus|LIVE_CANARY_MARKET_MISMATCH|MAX_LIVE_.*_EXCEEDED|AUTO_EXECUTE_DISABLED)' <<< "$tagged_live_logs"; then
    ADAPTER_REFUSED=1; TERMINAL_REASONS+=(STRUCTURED_OR_TAGGED_LIVE_REFUSAL); die 'terminal adapter refusal or safety block observed'
  fi
  if { appended_lines "$ENGINE_ERROR_LOG" "$ENGINE_ERROR_LINES_BEFORE"; appended_lines "$ROUTER_ERROR_LOG" "$ROUTER_ERROR_LINES_BEFORE"; } | grep -Eqi '.+'; then
    PROCESS_ERROR=1; TERMINAL_REASONS+=(PROCESS_ERROR); die 'process error detected'
  fi
  if (( CANDIDATE_SEEN && ! INTENT_SEEN && SECONDS - CANDIDATE_SEEN_SECONDS >= 20 )); then
    PIPELINE_STALLED=1; TERMINAL_REASONS+=(PIPELINE_STALLED_AFTER_CANDIDATE); die 'PIPELINE_STALLED: candidate did not reach intent or terminal adapter result within 20 seconds'
  fi
  if (( INTENT_SEEN && SECONDS - INTENT_SEEN_SECONDS >= 20 )); then
    PIPELINE_STALLED=1; TERMINAL_REASONS+=(PIPELINE_STALLED_AFTER_INTENT); die 'PIPELINE_STALLED: intent did not reach terminal adapter result within 20 seconds'
  fi
  sleep 2
done

if (( CANDIDATE_SEEN )); then
  TERMINAL_REASONS+=(WINDOW_EXPIRED_WITH_PIPELINE_ACTIVITY)
else
  TERMINAL_REASONS+=(NO_CANDIDATE)
fi
say "completed bounded ${WINDOW_SECONDS}-second armed window with result=$(derive_run_result)"
