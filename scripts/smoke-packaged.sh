#!/usr/bin/env bash
# Run the built-in end-to-end smoke test inside the PACKAGED app (release/*), against local
# wire-compatible stand-ins. Usage: npm run package:dir && npm run smoke:packaged
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)" in
  Darwin) APP=$(ls -d release/mac*/Lumen.app/Contents/MacOS/Lumen | head -1) ;;
  MINGW*|MSYS*|CYGWIN*) APP=$(ls release/win-unpacked/Lumen.exe) ;;
  *) APP=$(ls release/linux-unpacked/lumen-assistant 2>/dev/null || ls release/linux-unpacked/* | head -1) ;;
esac
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/lumen-smoke.XXXXXX")"
node scripts/standins.mjs > "$PROFILE/standins.json" &
STANDIN_PID=$!
trap 'kill $STANDIN_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -s "$PROFILE/standins.json" ] && break; sleep 0.1; done
AU=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROFILE/standins.json','utf8')).anthropic)")
DU=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROFILE/standins.json','utf8')).deepgram)")
OUT="$PROFILE/out.log"
LUMEN_USER_DATA="$PROFILE" LUMEN_SMOKE_TEST=1 LUMEN_SMOKE_FIXTURES="$PWD/src/test/fixtures" \
  LUMEN_SMOKE_SHOTS="${LUMEN_SMOKE_SHOTS:-$PROFILE/shots}" LUMEN_ANTHROPIC_BASE_URL="$AU" LUMEN_DEEPGRAM_URL="$DU" \
  "$APP" > "$OUT" 2>&1 || true
grep -E "^SMOKE" -A2 "$OUT" || { echo "SMOKE FAIL (no result)"; tail -20 "$OUT"; exit 1; }
grep -q "^SMOKE PASS" "$OUT"
