#!/usr/bin/env bash
# Boots the packaged-mode app with an isolated profile and runs the built-in UI smoke test.
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="$(mktemp -d)"
SHOTS="${LUMEN_SMOKE_SHOTS:-$PROFILE/shots}"
LUMEN_USER_DATA="$PROFILE" LUMEN_SMOKE_TEST=1 LUMEN_SMOKE_SHOTS="$SHOTS" npx electron . 2>&1 | grep -E "^SMOKE" || true
echo "screenshots: $SHOTS"
