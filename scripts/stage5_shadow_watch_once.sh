#!/usr/bin/env bash
# OPERATOR-ONLY SAFE SHADOW WORKFLOW. Never arms live trading or loads secrets.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
ENV_FILE="$ROOT/.env"; RUN_DIR="$ROOT/runtime_backups/stage5_shadow_$(date -u +%Y%m%dT%H%M%SZ)_$$"
BACKUP="$RUN_DIR/.env.before"; SHADOW_PATH="$RUN_DIR/stage5_candidate_shadow.ndjson"; RESTORED=0; MUTATION_STARTED=0; ENGINE_RESTART_ATTEMPTED=0
keys=(ENABLE_LIVE_TRADING LIVE_AUTO_EXECUTE LIVE_KILL_SWITCH LIVE_DRY_RUN_ONLY LIVE_SUBMIT_CONFIRM LIVE_FINAL_BOSS_READY LIVE_TRADING_STAGE LIVE_ROUTER_MODE STAGE5_CANDIDATE_SHADOW_ENABLED STAGE5_CANDIDATE_SHADOW_PATH STAGE5_SHADOW_EVAL_MIN_CONFIDENCE STAGE5_CANARY_GABAGOOL_MIN_CONFIDENCE)
vals=(false false true true false false 2 dry-run false '' 0.70 0.70)
say(){ printf '[stage5-shadow] %s\n' "$*"; }; die(){ say "ERROR: $*" >&2; exit 1; }
value(){ awk -v k="$1" '$0 ~ "^[[:space:]]*" k "[[:space:]]*=" {sub(/^[^=]*=/,""); print; n++} END {if(n!=1) exit 1}' "$ENV_FILE"; }
safe_profile(){ local i; for i in "${!keys[@]}"; do [[ "$(value "${keys[$i]}")" == "${vals[$i]}" ]] || return 1; done; }
set_value(){ local k="$1" v="$2" t="$ENV_FILE.shadow.$$.tmp"; awk -v k="$k" -v v="$v" 'BEGIN{d=0} $0 ~ "^[[:space:]]*" k "[[:space:]]*=" {if(!d) print k "=" v; d=1; next} {print} END{if(!d) print k "=" v}' "$ENV_FILE" > "$t"; mv "$t" "$ENV_FILE"; }
load_safe_env(){ set -a; . "$ENV_FILE"; set +a; }
pm2_json(){ if [[ -n "${PM2_JLIST_FIXTURE:-}" ]]; then node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]))' "$PM2_JLIST_FIXTURE"; else pm2 jlist; fi; }
verify_pm2(){ local enabled="$1" path="$2"; pm2_json | node -e '
const fs=require("fs"),x=JSON.parse(fs.readFileSync(0,"utf8")); const [enabled,p]=process.argv.slice(1); const i=x.find(v=>v.name==="langomonEscript"); const e=i?.pm2_env?.env||{}; const want={ENABLE_LIVE_TRADING:"false",LIVE_AUTO_EXECUTE:"false",LIVE_KILL_SWITCH:"true",LIVE_DRY_RUN_ONLY:"true",LIVE_SUBMIT_CONFIRM:"false",LIVE_FINAL_BOSS_READY:"false",LIVE_TRADING_STAGE:"2",LIVE_ROUTER_MODE:"dry-run",STAGE5_CANDIDATE_SHADOW_ENABLED:enabled,STAGE5_SHADOW_EVAL_MIN_CONFIDENCE:"0.70",STAGE5_CANARY_GABAGOOL_MIN_CONFIDENCE:"0.70",STAGE5_CANDIDATE_SHADOW_PATH:enabled==="true"?p:""}; const bad=!i||i.pm2_env.status!=="online"||Object.keys(want).filter(k=>String(e[k]??"")!==want[k]).length; process.exit(bad?1:0)' "$enabled" "$path"; }
restore(){ local rc="$1"; [[ "$RESTORED" == 1 ]] && return "$rc"; RESTORED=1; set +e; if (( MUTATION_STARTED )) && [[ -r "$BACKUP" ]]; then cp -- "$BACKUP" "$ENV_FILE"; load_safe_env; if (( ENGINE_RESTART_ATTEMPTED )); then pm2 restart langomonEscript --update-env || rc=1; verify_pm2 false '' || rc=1; fi; fi; return "$rc"; }
on_exit(){ local rc="$?"; restore "$rc"; return $?; }
on_err(){ return 1; }
on_int(){ restore 130; exit 130; }
on_term(){ restore 143; exit 143; }
selfcheck(){ local d before; d="$(mktemp -d /tmp/stage5-shadow-wrapper.XXXXXX)"; ENV_FILE="$d/.env"; printf '%s\n' 'ENABLE_LIVE_TRADING=false' 'LIVE_AUTO_EXECUTE=false' 'LIVE_KILL_SWITCH=true' 'LIVE_DRY_RUN_ONLY=true' 'LIVE_SUBMIT_CONFIRM=false' 'LIVE_FINAL_BOSS_READY=false' 'LIVE_TRADING_STAGE=2' 'LIVE_ROUTER_MODE=dry-run' 'STAGE5_CANDIDATE_SHADOW_ENABLED=false' 'STAGE5_CANDIDATE_SHADOW_PATH=' 'STAGE5_SHADOW_EVAL_MIN_CONFIDENCE=0.70' 'STAGE5_CANARY_GABAGOOL_MIN_CONFIDENCE=0.70' > "$ENV_FILE"; before="$(cksum "$ENV_FILE")"; safe_profile || die selfcheck_safe; set_value ENABLE_LIVE_TRADING true; safe_profile && die selfcheck_unsafe; [[ "$(cksum "$ENV_FILE")" != "$before" ]] || die selfcheck_fixture; rm -rf "$d"; say 'shadow wrapper selfcheck: ok'; }
[[ "${1:-}" == --selfcheck ]] && { selfcheck; exit 0; }
[[ -r "$ENV_FILE" ]] || die '.env is not readable'
safe_profile || die 'LOCK LIVE OFF FIRST'
mkdir -p "$RUN_DIR"
cp -- "$ENV_FILE" "$BACKUP"
[[ -r "$BACKUP" ]] || die 'shadow backup is not readable'
MUTATION_STARTED=1
trap on_exit EXIT
trap on_err ERR
trap on_int INT
trap on_term TERM
set_value STAGE5_CANDIDATE_SHADOW_ENABLED true; set_value STAGE5_CANDIDATE_SHADOW_PATH "$SHADOW_PATH"; set_value STAGE5_SHADOW_EVAL_MIN_CONFIDENCE 0.70
load_safe_env
ENGINE_RESTART_ATTEMPTED=1
pm2 restart langomonEscript --update-env
verify_pm2 true "$SHADOW_PATH" || die 'safe shadow PM2 runtime verification failed'
STAGE5_CANDIDATE_SHADOW_PATH="$SHADOW_PATH" STAGE5_CANDIDATE_SHADOW_SUMMARY_PATH="$RUN_DIR/shadow-summary.json" STAGE5_SHADOW_WATCH_MS=900000 node scripts/stage5_shadow_watch.js
