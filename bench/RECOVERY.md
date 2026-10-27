# Recovery notes (27.10.2026)

`bench/` was deleted at about 19:06 MSK on 27.10.2026 (not in git; no trash, no snapshots). This tree was rebuilt from
Claude Code transcripts (`~/.claude/projects/-Users-daniilrozhkov-prj-pen-editor-app/**/*.jsonl`), session scratchpads and the memory notes.

## Method

All Write / Edit calls, `cat > file <<EOF` heredocs, `python3 - <<EOF` edit scripts (replayed with a real Python), `sed -i` and `cp` commands
that touched `bench/` were replayed in time order on top of the newest full snapshot of each file
(`cat src/a.ts src/b.ts` dumps of 11-13.10 and `*.bak` copies of 24.10 in a scratchpad). Duplicated tool calls (the same call is logged twice) were removed.
About 80 `sed -n A,Bp file` outputs from later sessions were compared with the replayed files: all matched.
`cli.ts` and `judge.ts` match a full dump of 13.10 byte for byte. `npm run check` (type-check + fixture self-check) passes.

## Verbatim (replayed, validated)

`browse-task/src/`: `cli.ts` (+ report copy, see below), `runOnce.ts`, `stack.ts`, `scenarios.ts`, `report.ts`, `endState.ts`, `judge.ts`, `judgeCli.ts`, `judgeWorker.ts`,
`liveSuite.ts`, `verdict.ts`, `compare.ts`, `cost.ts`, `om2w*.ts`, `webvoyager*.ts`, `wtb*.ts`, `paths.ts` (+1 line), `recorder.ts`, `fixtures/{form,form2,lookup,selfcheck}.ts`;
`browse-task/{README.md,NIGHTLY.md,package.json,tsconfig.json}`; `nightly/*`; `reports/wtb-2026-10-24.md`, `reports/luna-harness-2026-10-11.md`; `reports/skroutz-runs.{md,csv}` come from the Claude Code file-history (version before the last edit; later edits are missing).

## Rewritten or changed by hand

- `browse-task/src/fixtures/booking.ts`: **rewritten**. The original (216 lines) was never printed in a transcript. The new one keeps the contract used by
  `scenarios.ts` and `selfcheck.ts` (`startBookingFixture`, `BOOKING_EXPECTED`, `/api/cities`, `/api/progress`, `POST /book` -> 303, `bookings()`, `progress()`) and the documented widgets.
  Results of the `booking` scenario from before the loss are not comparable.
- `browse-task/src/fixtures/http.ts`: lines 1-40 verbatim, the rest (`json`, `redirect`, `readBody`, `readForm`, `esc`, `page`) rebuilt from the export list; CSS of `page()` is a guess.
- `browse-task/src/cli.ts`: added `summarize()` (copies `summary.md` to `bench/reports/<run>.md`; `BENCH_NO_REPORT=1` disables) and `paths.ts` got `REPORTS_DIR`.
- `browse-task/scripts/*`, `.env.opencode.example`, `.gitignore`, `README.md`, `reports/*.md` except those listed as verbatim: written new.
  `scripts/run-arm.sh` is the 11-line scratch script of 27.10 with env knobs; `ab.sh` and `ab-workspace.sh` generalise `chain.sh`/`stop.sh` and the worktree commands of that day.
- Two small edits could not be replayed from the shell history and were applied by hand from the transcript: the OpenCode BYOK patch of 14.10 (`stack.ts`, `runOnce.ts`, applied by `patch -p1` from a scratch file) and the final wording of `reports/wtb-2026-10-24.md`.
- `click-vision/` and `cloud-browser/src/`: recovered from heredocs only, **not verified**. `click-vision/data/`, `cloud-browser/vendor/` and the Steel/Daytona SDK copies are lost. `skroutz-research/` (3 markdown files) is lost.

## Lost

- All raw results (`browse-task/results/**`), traces, videos (`results/video-*`), per-run homes.
- `.env.opencode` (the key; create a new one from `.env.opencode.example`).
- `browse-task/.gitignore` (content unknown; `bench/.gitignore` replaces it), `package-lock.json` (new one from `npm install`), `make-video.mjs` (demo video script of 15.10).
- Datasets: `data/wtb` (recreated by `scripts/setup-data.sh wtb`), `data/om2w` (needs `HF_TOKEN`, the gated dataset; the published results come from public GitHub), `data/webvoyager` (`--fetch`).
- Past numbers: only what the memory notes and transcripts printed. Per-task details of om2w/live10 runs and the F1 of the 27.10 A/B are gone.
- Edits made to the files that happened only through tools I could not replay (an interactive editor, a command whose output was not shown) would be missing silently.
  The tail of the history is covered by the validation above, but small differences against the lost original cannot be excluded.

## Move into pen-editor-desktop (27.10)

`bench/` now lives in `pen-editor-desktop/bench/`. The default workspace in `src/paths.ts` is `BENCH_DIR/../../..` (the parent of `pen-editor-desktop/`), and the `root=` line of `scripts/ab-workspace.sh` climbs one level more. `BENCH_WORKSPACE` still overrides it.
