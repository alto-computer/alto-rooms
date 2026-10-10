#!/usr/bin/env bash
# The F2-8 perf gate: React render work to open a 30-turn thread, trunk against head, with no
# surface plugin. Builds both with ROOMS_PROFILE=1 (react-dom/profiling), then runs the probe in
# commit mode N times each, alternating, against one head roomsd. Prints p50 and spread per side and
# the head/trunk ratio; exits 1 when head's p50 is more than 10 % over trunk's.
#   apps/desktop/e2e/perf/gate.sh [runs=20] [trunk-ref=origin/main]
set -euo pipefail
RUNS=${1:-20}
TRUNK_REF=${2:-origin/main}
DESKTOP=$(cd "$(dirname "$0")/../.." && pwd)
REPO=$(cd "$DESKTOP/../.." && pwd)
OUT=${ROOMS_PERF_OUT:-$DESKTOP/dist-perf}
TRUNK_WT="$OUT/trunk-src"
LOG="$OUT/gate.log"
mkdir -p "$OUT"

echo "== head build ($(git -C "$REPO" rev-parse --short HEAD)) -> $OUT/head"
(cd "$DESKTOP" && ROOMS_PROFILE=1 bun run --silent build -- --outDir "$OUT/head" >/dev/null)

if [ ! -d "$TRUNK_WT" ]; then
  git -C "$REPO" worktree add -q --detach "$TRUNK_WT" "$TRUNK_REF"
  (cd "$TRUNK_WT" && bun install --frozen-lockfile --silent)
fi
git -C "$TRUNK_WT" checkout -q --detach "$TRUNK_REF"
# The alias behind ROOMS_PROFILE=1 is head's; trunk's own vite config has no such switch.
cp "$DESKTOP/vite.config.ts" "$TRUNK_WT/apps/desktop/vite.config.ts"
echo "== trunk build ($(git -C "$TRUNK_WT" rev-parse --short HEAD)) -> $OUT/trunk"
(cd "$TRUNK_WT/apps/desktop" && ROOMS_PROFILE=1 bun run --silent build -- --outDir "$OUT/trunk" >/dev/null)
git -C "$TRUNK_WT" checkout -q -- apps/desktop/vite.config.ts

: > "$LOG"
for i in $(seq 1 "$RUNS"); do
  for side in head trunk; do
    printf '%s run %d/%d... ' "$side" "$i" "$RUNS"
    line=$(cd "$DESKTOP" && ROOMS_PERF=1 ROOMS_PERF_MODE=commit ROOMS_PERF_DIST="$OUT/$side" \
      bunx playwright test --config e2e/perf/playwright.perf.config.ts 2>&1 | grep '^PERF ' | grep open-30-turns || true)
    if [ -z "$line" ]; then echo "no sample"; echo "$side FAILED" >> "$LOG"; continue; fi
    echo "$side ${line#PERF }" >> "$LOG"
    echo "${line#PERF }"
  done
done

node - "$LOG" <<'EOF'
const fs = require("node:fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").filter((l) => !l.endsWith("FAILED"));
const by = { head: [], trunk: [] };
for (const l of rows) {
  const side = l.slice(0, l.indexOf(" "));
  by[side].push(JSON.parse(l.slice(side.length + 1)));
}
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const stat = (xs) => `n=${xs.length} p50=${q(xs, 0.5).toFixed(1)} min=${Math.min(...xs).toFixed(1)} max=${Math.max(...xs).toFixed(1)}`;
for (const side of ["trunk", "head"]) {
  console.log(`${side}: renderMs ${stat(by[side].map((r) => r.renderMs))}; wallMs ${stat(by[side].map((r) => r.wallMs))}; commits ${stat(by[side].map((r) => r.commits))}`);
}
const ratio = q(by.head.map((r) => r.renderMs), 0.5) / q(by.trunk.map((r) => r.renderMs), 0.5);
console.log(`head/trunk render p50: ${ratio.toFixed(3)} (gate: <= 1.10)`);
process.exit(ratio <= 1.1 ? 0 : 1);
EOF
