#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="${1:?Pass absolute NEW log directory outside extracted package}"
mkdir -p "$LOGS"; LOGS="$(cd "$LOGS" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
python3 - "$ROOT/input/R1.10.2_bd7d3462_ORIGINAL.zip" "$WORK/input" <<'PY'
import zipfile,sys
with zipfile.ZipFile(sys.argv[1]) as z:z.extractall(sys.argv[2])
PY
git clone -q --branch phase/04-corrections-round191 "$ROOT/verification/accepted-history.bundle" "$WORK/repo"
cd "$WORK/repo"
test "$(git rev-parse HEAD)" = f70205648922d0f8e60619e45e5d54e6e87b8f1b
diff -r --exclude=.git "$ROOT/source" . > "$LOGS/source-pre-overlay.log"
if [ -n "${PIXEL_NODE_MODULES:-}" ]; then ln -s "$PIXEL_NODE_MODULES" node_modules; else npm ci --ignore-scripts > "$LOGS/npm-ci.log" 2>&1; fi
cp -a "$WORK/input/audit-tools" ./audit-tools
./node_modules/.bin/vitest run --config audit-tools/vitest.config.trace.mjs --maxWorkers=1 > "$LOGS/supplied37.log" 2>&1
echo 'SUPPLIED_37_EXIT=0'
cp -a "$ROOT/manager-evidence/manager-probes" ./audit-tools/
cp "$ROOT/manager-evidence/vitest.config.manager.mjs" ./audit-tools/
set +e
./node_modules/.bin/vitest run --config audit-tools/vitest.config.manager.mjs > "$LOGS/counterexamples.log" 2>&1
RC=$?
set -e
echo "COUNTEREXAMPLE_EXIT=$RC (expected1:3F/1P)"; test "$RC" -eq 1
python3 - "$LOGS/counterexamples.log" <<'PY'
import re,sys
s=re.sub(r'\x1b\[[0-9;]*m','',open(sys.argv[1]).read())
assert re.search(r'Tests\s+3 failed\s*\|\s*1 passed',s), 'unexpected counterexample composition'
PY
git diff --exit-code > "$LOGS/accepted-source-diff.log"
echo 'REPRODUCTION_OK; accepted tracked diff0'
