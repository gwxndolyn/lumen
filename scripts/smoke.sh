#!/usr/bin/env bash
# Boots the real app with an isolated profile and runs the built-in end-to-end smoke test against
# local wire-compatible stand-ins for the Anthropic and Deepgram APIs.
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="$(mktemp -d)"
SHOTS="${LUMEN_SMOKE_SHOTS:-$PROFILE/shots}"
node scripts/standins.mjs > "$PROFILE/standins.json" &
STANDIN_PID=$!
trap 'kill $STANDIN_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -s "$PROFILE/standins.json" ] && break; sleep 0.1; done
ANTHROPIC_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROFILE/standins.json','utf8')).anthropic)")
DEEPGRAM_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROFILE/standins.json','utf8')).deepgram)")
LUMEN_USER_DATA="$PROFILE" LUMEN_SMOKE_TEST=1 LUMEN_SMOKE_SHOTS="$SHOTS" \
  LUMEN_ANTHROPIC_BASE_URL="$ANTHROPIC_URL" LUMEN_DEEPGRAM_URL="$DEEPGRAM_URL" \
  npx electron . 2>&1 | grep -E -A12 "^SMOKE" || true
echo "screenshots: $SHOTS"
