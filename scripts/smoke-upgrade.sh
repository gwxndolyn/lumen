#!/usr/bin/env bash
# Upgrade check: create a profile with an OLDER commit's own storage code, then open it with the
# current build and verify sessions, messages, transcripts, memories, usage, settings and search.
# Usage: bash scripts/smoke-upgrade.sh [old-ref] [app-binary]   (default old-ref e6f64de = schema 6)
set -euo pipefail
cd "$(dirname "$0")/.."
OLD_REF="${1:-e6f64de}"
WT="$(mktemp -d "${TMPDIR:-/tmp}/lumen-old.XXXXXX")"
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/lumen-upgrade.XXXXXX")"
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
rmdir "$WT" && git worktree add -q --detach "$WT" "$OLD_REF"
ln -s "$PWD/node_modules" "$WT/node_modules"
(cd "$WT" && npx tsc -p tsconfig.node.json > /dev/null)
node scripts/upgrade-seed.mjs "$WT" "$PROFILE"
RUN=("${2:-npx}"); [ -z "${2:-}" ] && RUN=(npx electron .)
LUMEN_USER_DATA="$PROFILE" LUMEN_SMOKE_TEST=1 LUMEN_SMOKE_PHASE=upgrade "${RUN[@]}" > "$PROFILE/out.log" 2>&1 || true
grep -E "^UPGRADE" "$PROFILE/out.log" || { echo "UPGRADE FAIL (no result)"; tail -20 "$PROFILE/out.log"; exit 1; }
ls "$PROFILE" | grep -q "lumen.db.backup-v" || { echo "UPGRADE FAIL (no pre-migration backup)"; exit 1; }
grep -q "^UPGRADE PASS" "$PROFILE/out.log"
