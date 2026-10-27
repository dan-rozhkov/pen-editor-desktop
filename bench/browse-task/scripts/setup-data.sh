#!/usr/bin/env bash
# Recreates bench/browse-task/data/ (ignored by git). Usage: scripts/setup-data.sh [wtb|om2w|wv|all]  (default: wtb)
#
#   wtb   WebTestBench (HF friedrichor/WebTestBench, public, no token): downloads WebTestBench.jsonl (gold checklists)
#         and 100 app zips, builds every app (`npm ci --ignore-scripts` + `vite build --mode development`, node_modules
#         deleted afterwards) into data/wtb/apps/<id>/dist, writes data/wtb/sample.json (stratified 20, seed wtb-1).
#         ~15 s per app, concurrency 4. WTB_IDS=0003,0007 builds only those apps (no sample.json).
#   om2w  Online-Mind2Web: published Browser Use / Operator results (public GitHub) + sample.json
#         (dataset is gated: needs HF_TOKEN).
#   wv    WebVoyager: task list + reference answers from MinorJerry/WebVoyager (public), sample 45, seed wv-1.
set -euo pipefail
cd "$(dirname "$0")/.."
what="${1:-wtb}"
[ -d node_modules ] || npm install --no-audit --no-fund

wtb() {
  if [ -n "${WTB_IDS:-}" ]; then
    npm run wtb:prepare -- --ids "$WTB_IDS" --concurrency "${WTB_CONCURRENCY:-3}"
  else
    npm run wtb:prepare -- --n 20 --seed wtb-1 --concurrency "${WTB_CONCURRENCY:-4}"
  fi
}

om2w() {
  mkdir -p data/om2w
  local base=https://raw.githubusercontent.com/OSU-NLP-Group/Online-Mind2Web/main/data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini
  for f in browser_use operator; do
    curl -fsSL "$base/${f}_results.json" -o "data/om2w/$f.jsonl"
    node -e '
      const fs = require("fs"); const f = process.argv[1];
      const rows = fs.readFileSync(`data/om2w/${f}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      fs.writeFileSync(`data/om2w/${f}.json`, JSON.stringify(rows.map((r) => ({ task_id: r.task_id, confirmed_task: r.confirmed_task, final_eval: r.final_eval, key_points: r.key_points }))));
      fs.rmSync(`data/om2w/${f}.jsonl`);
      console.log(f, rows.length);
    ' "$f"
  done
  if [ -n "${HF_TOKEN:-}" ]; then npm run om2w:prepare -- --n 30 --seed om2w-1
  else echo "HF_TOKEN not set: skipped data/om2w/sample.json (Online-Mind2Web is gated; see README of browse-task)"; fi
}

wv() { npm run wv:prepare -- --n 45 --seed wv-1 --fetch; }

case "$what" in
  wtb) wtb ;;
  om2w) om2w ;;
  wv) wv ;;
  all) wtb; om2w; wv ;;
  *) echo "usage: $0 [wtb|om2w|wv|all]" >&2; exit 2 ;;
esac
