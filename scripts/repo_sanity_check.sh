#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[repo-sanity] node syntax checks"
node --check moneymaker_v3.js
node --check live_adapter_polymarket.js
node --check live_intent_router.js
node --check telegram/telegram_approval_bot.js
node --check dashboard_server.js

echo "[repo-sanity] engine selfchecks"
npm run engine:route-selfcheck
npm run engine:risk-selfcheck
npm run engine:confidence-selfcheck
npm run dashboard:check

echo "[repo-sanity] git status"
git status --short

echo "[repo-sanity] forbidden staged files"
forbidden_re='(^|/)(\.env|\.env\.telegram|\.env\.live\.secrets|\.dashboard_token|node_modules)(/|$)|(^|/)telegram/\.env\.telegram$|\.ndjson$|_state\.json$|(^|/)moneymaker_v3_state\.json$|(^|/)live_reconcile_snapshot\.json$|\.bak|(^|/)langomonEscript/|(^|/)archived_'
if git diff --cached --name-only | grep -E "$forbidden_re"; then
  echo "[repo-sanity] refused: forbidden files are staged" >&2
  exit 1
fi

echo "[repo-sanity] ignore rules"
git check-ignore -q .dashboard_token
git check-ignore -q .env.live.secrets
git check-ignore -q telegram/.env.telegram
git check-ignore -q auto_live_candidates.ndjson

echo "[repo-sanity] passed"
