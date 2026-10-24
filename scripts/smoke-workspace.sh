#!/usr/bin/env bash
# Project workspace across two real launches of the app on one profile, with two real project
# folders and the Anthropic-wire stand-in acting as the agent's model. The test command really
# runs (node test.js). Usage: npm run build && bash scripts/smoke-workspace.sh [app-binary]
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/lumen-ws.XXXXXX")"
A="$PROFILE/project alpha"; B="$PROFILE/project beta"
mkdir -p "$A/src" "$B"
printf 'exports.add = (a, b) => a - b;\n' > "$A/src/math.js"
printf "const { add } = require('./src/math');\nif (add(2, 3) !== 5) { console.error('add(2,3) = ' + add(2, 3)); process.exit(1); }\nconsole.log('ok');\n" > "$A/test.js"
printf 'SECRET=do-not-read\n' > "$A/.env"
printf 'const other = 1;\n' > "$B/other.js"
node scripts/standins.mjs > "$PROFILE/standins.json" &
STANDIN_PID=$!
trap 'kill $STANDIN_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -s "$PROFILE/standins.json" ] && break; sleep 0.1; done
export LUMEN_ANTHROPIC_BASE_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROFILE/standins.json','utf8')).anthropic)")
DELIM=$(node -e "process.stdout.write(require('path').delimiter)")
RUN=("${1:-npx}"); [ -z "${1:-}" ] && RUN=(npx electron .)
for phase in seed verify; do
  LUMEN_USER_DATA="$PROFILE/data" LUMEN_SMOKE_TEST=1 LUMEN_SMOKE_PHASE="workspace-$phase" LUMEN_SMOKE_FOLDERS="$A$DELIM$B" "${RUN[@]}" > "$PROFILE/$phase.log" 2>&1 || true
  grep -E "^WORKSPACE" "$PROFILE/$phase.log" || { echo "WORKSPACE $phase FAIL (no result)"; tail -20 "$PROFILE/$phase.log"; exit 1; }
  grep -q "^WORKSPACE $(echo "$phase" | tr a-z A-Z) PASS" "$PROFILE/$phase.log"
done
# The protected file was never sent to the model stand-in and is unchanged.
grep -q "SECRET=do-not-read" "$A/.env"
