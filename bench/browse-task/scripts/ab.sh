#!/usr/bin/env bash
# A/B on WebTestBench: arms A and B in parallel on separate ports (3095/5195 and 3096/5196).
#
#   scripts/ab.sh <workspaceA> <workspaceB> [apps]
#
# Prepare the workspaces with scripts/ab-workspace.sh. Optional STOP_AFTER=wtb-0013 stops both arms right after that
# app finished (SIGINT, then SIGTERM) - what the 27.10 run did. Per-arm console logs: results/ab-<date>/arm-{A,B}.log.
# Decision rule used on 27.10 (set BEFORE the start, see ../reports/wtb-ab-2026-10-27.md): do not stop early,
# roll back if macro F1(B) < F1(A) by >= 8 points; a smaller gap cannot be told from noise at n=1.
set -euo pipefail
cd "$(dirname "$0")/.."
a="${1:?usage: ab.sh <workspaceA> <workspaceB> [apps]}"; b="${2:?}"; apps="${3:-}"
log="results/ab-$(date +%F)"; mkdir -p "$log"
export DATE; DATE="$(date +%F)"
scripts/run-arm.sh A "$a" 3095 5195 ${apps:+"$apps"} > "$log/arm-A.log" 2>&1 & pa=$!
scripts/run-arm.sh B "$b" 3096 5196 ${apps:+"$apps"} > "$log/arm-B.log" 2>&1 & pb=$!
if [ -n "${STOP_AFTER:-}" ]; then
  for arm in A B; do
    ( until grep -q "$STOP_AFTER #" "$log/arm-$arm.log"; do sleep 15; done
      pkill -INT -f "results/wtb-ab-$arm-$DATE"; sleep 20; pkill -TERM -f "results/wtb-ab-$arm-$DATE" ) &
  done
fi
wait "$pa" || true; wait "$pb" || true
echo "done: see $log/ and ../reports/wtb-ab-{A,B}-$DATE.md"
