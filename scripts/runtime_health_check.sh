#!/usr/bin/env bash
set -u

APP_NAME="${PM2_APP_NAME:-langomonEscript}"
LINES="${PM2_LOG_LINES:-400}"

echo "== Git =="
git branch --show-current 2>/dev/null || true
git rev-parse --short HEAD 2>/dev/null || true

echo
echo "== PM2 List =="
pm2 list 2>/dev/null || echo "pm2 unavailable"

TMP_LOG="$(mktemp)"
trap 'rm -f "$TMP_LOG"' EXIT

pm2 logs "$APP_NAME" --lines "$LINES" --nostream 2>/dev/null > "$TMP_LOG" || true

echo
echo "== Last Portfolio Report =="
grep -n -- "--- PORTFOLIO REPORT ---" "$TMP_LOG" | tail -1 | cut -d: -f1 | while read -r line; do
  if [ -n "$line" ]; then
    sed -n "${line},$((line + 8))p" "$TMP_LOG"
  fi
done

echo
echo "== Recent MoneyMaker Lines =="
grep -E "\\[ORDER\\]|\\[ORDER SKIP DUPLICATE\\]|\\[CONSENSUS BLOCK\\]|\\[ENGINE STARVATION WARNING\\]|VOL GUARD|RESEARCH REFRESH" "$TMP_LOG" | tail -100 || true

order_count="$(grep -c "\\[ORDER\\]" "$TMP_LOG" || true)"
duplicate_count="$(grep -c "\\[ORDER SKIP DUPLICATE\\]" "$TMP_LOG" || true)"
route_block_count="$(grep -c "route_not_authorized" "$TMP_LOG" || true)"
spreadhunter_maker_route_blocks="$(grep "route_not_authorized" "$TMP_LOG" | grep -c "SpreadHunter.*route=MAKER:STABLE" || true)"

echo
echo "== Counts =="
echo "orderPlacements=$order_count"
echo "duplicateSkips=$duplicate_count"
echo "routeNotAuthorizedBlocks=$route_block_count"
echo "spreadHunterMakerStableRouteBlocks=$spreadhunter_maker_route_blocks"
