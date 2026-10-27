#!/usr/bin/env bash
# Runs one WebTestBench arm on the OpenCode Go subscription (never OpenRouter).
#
#   scripts/run-arm.sh <name> <workspace> <backendPort> <vitePort> [apps]
#
# Needs .env.opencode (BENCH_OPENCODE_KEY, see .env.opencode.example). Raw output: results/wtb-ab-<name>-<date>/ (ignored);
# the summary is also written to ../reports/wtb-ab-<name>-<date>.md by the runner (src/cli.ts).
# The original (lost) version was 11 lines; this is the same command with the knobs exposed as env vars.
set -euo pipefail
name="${1:?usage: run-arm.sh <name> <workspace> <backendPort> <vitePort> [apps]}"; ws="$(cd "$2" && pwd)"; bport="$3"; vport="$4"
apps="${5:-wtb-0003,wtb-0007,wtb-0008,wtb-0011,wtb-0013,wtb-0021,wtb-0022,wtb-0024,wtb-0030,wtb-0033}"
cd "$(dirname "$0")/.."
set -a; . ./.env.opencode; set +a
model="${BENCH_MODEL:-opencode-go/deepseek-v4.1-flash}"
export BENCH_WORKSPACE="$ws" BENCH_NO_OPENROUTER=1 BENCH_AGENT_MODEL="$model" BENCH_TURN_CAP_MS="${BENCH_TURN_CAP_MS:-1800000}"
npm run bench -- --scenarios "$apps" --prompt agent --runs "${RUNS:-1}" --no-build \
  --chat-model "$model" --backend-port "$bport" --vite-port "$vport" \
  --out "results/wtb-ab-$name-${DATE:-$(date +%F)}"
