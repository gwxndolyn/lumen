#!/usr/bin/env bash
# Restart persistence check: launch the real app twice on one profile. Phase 1 writes data and
# quits through the normal quit path; phase 2 verifies sessions, conversation, context, settings
# and that the database was closed cleanly. Usage: npm run build && bash scripts/smoke-restart.sh [app-binary]
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/lumen-restart.XXXXXX")"
# Same local Anthropic-wire stand-in as the smoke test (packaged builds refuse development mode).
node scripts/standins.mjs > "$PROFILE/standins.json" &
STANDIN_PID=$!
trap 'kill $STANDIN_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -s "$PROFILE/standins.json" ] && break; sleep 0.1; done
export LUMEN_ANTHROPIC_BASE_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROFILE/standins.json','utf8')).anthropic)")
RUN=("${1:-npx}"); [ -z "${1:-}" ] && RUN=(npx electron .)
for phase in seed verify; do
  LUMEN_USER_DATA="$PROFILE" LUMEN_SMOKE_TEST=1 LUMEN_SMOKE_PHASE=$phase "${RUN[@]}" > "$PROFILE/$phase.log" 2>&1 || true
  grep -E "^RESTART" "$PROFILE/$phase.log" || { echo "RESTART $phase FAIL (no result)"; tail -20 "$PROFILE/$phase.log"; exit 1; }
  grep -q "^RESTART $(echo "$phase" | tr a-z A-Z) PASS" "$PROFILE/$phase.log"
done
