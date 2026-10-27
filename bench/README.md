# bench

Local benchmarks for the browser-use / QA agent. It lives in `pen-editor-desktop/bench/` (see "Repository"); raw outputs and datasets are ignored.

| folder | content |
|---|---|
| `browse-task/` | the harness: runs the real desktop agent (Electron) against fixtures, live sites, Online-Mind2Web, WebVoyager and WebTestBench. Own `README.md` (Russian, detailed) |
| `reports/` | tracked summaries with final numbers, one file per run or experiment, see `reports/README.md` |
| `nightly/` | the three prompts and the launchd script of the nightly agent session (13.10) |
| `click-vision/`, `cloud-browser/` | older side experiments (click by screenshot; Steel/Daytona cloud browser spike). Partial, see "Recovery status" |

## Setup

```bash
cd bench/browse-task
npm install                       # playwright (library only), tsx, typescript
cp .env.opencode.example .env.opencode   # fill in BENCH_OPENCODE_KEY (never commit it)
scripts/setup-data.sh wtb         # WebTestBench: download + build 100 apps (~10 min), sample.json (20 apps, seed wtb-1)
# optional: scripts/setup-data.sh om2w (needs HF_TOKEN for the gated dataset), scripts/setup-data.sh wv
npm run check                     # type-check + LLM-free fixture self-check (no key needed)
```

The harness needs the three repos `pen-editor/`, `pen-editor-backend/`, `pen-editor-desktop/` (built: `pen-editor-desktop/dist`)
side by side in one folder (by default the parent of `pen-editor-desktop/`), `npm ci` done in each, and `infisical` logged in (the local backend runs under `infisical run --env=dev`;
set `BENCH_NO_INFISICAL=1` to use plain env). `BENCH_WORKSPACE=<dir>` points the harness at another set of the three repos.

## Run one arm

```bash
cd bench/browse-task
set -a; . ./.env.opencode; set +a
BENCH_NO_OPENROUTER=1 BENCH_AGENT_MODEL=opencode-go/deepseek-v4.1-flash BENCH_TURN_CAP_MS=1800000 \
npm run bench -- --scenarios wtb-0003,wtb-0007 --prompt agent --runs 1 --no-build \
  --chat-model opencode-go/deepseek-v4.1-flash --out results/my-run
# or the whole sample:  --scenarios @wtb      (fixtures: default;  live sites: @live;  @om2w, @webvoyager, @wtb-e2e)
```

Rules: WebTestBench runs only on the OpenCode Go subscription (`BENCH_NO_OPENROUTER=1` makes a leftover OpenRouter call fail with 401).
Two arms in parallel need different `--backend-port` / `--vite-port` and different `--out`. Check free disk first: `df -h /`.

Or use the script: `scripts/run-arm.sh <name> <workspace> <backendPort> <vitePort> [apps]`.

## Run an A/B

```bash
cd bench/browse-task
scripts/ab-workspace.sh /tmp/wsA --backend-patch /path/to/revert.patch      # arm A: main + patch
scripts/ab-workspace.sh /tmp/wsB                                             # arm B: origin/main
STOP_AFTER=wtb-0013 scripts/ab.sh /tmp/wsA /tmp/wsB                          # both arms in parallel
npm run wtb:report -- results/wtb-ab-A-<date> results/wtb-ab-B-<date>        # P/R/F1 per app
```

Write the decision rule down BEFORE the start and do not stop early (`reports/wtb-ab-2026-10-27.md` has the rule that was used).

## Where results go

- `browse-task/results/<run>/` (ignored): per-run Electron homes (deleted after a run unless `BENCH_KEEP_HOMES=1`), backend/vite logs, `run-*.json`, traces, screenshots, `summary.md/json`.
- `reports/<run>.md` (tracked): `npm run bench` copies `summary.md` there after every finished run (`BENCH_NO_REPORT=1` disables it).
  Add a short analysis file by hand for important runs and list it in `reports/README.md`.
- `browse-task/data/` (ignored): datasets, recreated by `scripts/setup-data.sh`.

## Repository

`bench/` lives in `pen-editor-desktop` because it runs the desktop app and uses its e2e fixtures. It is outside the app build (`tsc` compiles only `src/`, electron-builder packs only `dist/`, vitest runs only `test/`), and Renovate and release-please ignore it. Commit bench changes as `chore(bench): ...` so they do not cut a release.

`bench/` imports nothing from a package; it drives the three product repos through `BENCH_WORKSPACE` (paths `pen-editor-desktop/dist`, `pen-editor/node_modules/.bin/vite`,
`pen-editor-backend/src/index.ts`, `sharp` from the backend's `node_modules`) and, for the `shop` fixture, imports `pen-editor-desktop/e2e/fixtures/bench-shop/server.ts`.
The `@sideform/browser-agent` package is not imported at all.

## Recovery status (27.10.2026)

The original folder was deleted and was not in git. See `RECOVERY.md` for what is verbatim, rewritten or lost.
