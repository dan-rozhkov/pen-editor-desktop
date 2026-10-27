# Reports

One markdown file per measurement. Raw outputs (`../browse-task/results/`) are ignored by git; the runner writes the summary of every run to
`wtb-ab-<arm>-<date>.md`-style files here (`npm run bench` copies `summary.md` to `reports/<run-dir-name>.md`, set `BENCH_NO_REPORT=1` to skip).

**Provenance.** On 27.10.2026 about 19:06 MSK almost all of `bench/` (not in git) was deleted. Everything here was recovered from Claude Code
transcripts, session scratchpads and the project memory notes. Numbers are copied, not recomputed; where a source was a memory note the
report says so. Raw JSON of old runs does not exist any more, so none of these tables can be regenerated.

| report | what | date |
|---|---|---|
| [wtb-ab-2026-10-27.md](wtb-ab-2026-10-27.md) | A/B of the prompt part of ba084e5 on WebTestBench (partial, aborted by the deletion) | 27.10 |
| [wtb-2026-10-24.md](wtb-2026-10-24.md) | WebTestBench oracle track, 10 apps, F1 52.6 vs paper 49.2 (original file, recovered) | 24.10 |
| [wtb-2026-10-24-rerun.md](wtb-2026-10-24-rerun.md) | rerun of 2 apps after QA agent changes | 24.10 |
| [om2w-2026-10.md](om2w-2026-10.md) | Online-Mind2Web: manual / browse_task / subagent / models / OpenCode Go | 13-19.10 |
| [live10-2026-10.md](live10-2026-10.md) | live suite, 10 real sites, runs and failure classes | 12-13.10 |
| [browse-manual-vs-task-2026-10-13.md](browse-manual-vs-task-2026-10-13.md) | deepseek by hand vs browse_task: quality and cost | 13.10 |
| [jev-vs-luna-2026-10-11.md](jev-vs-luna-2026-10-11.md) | Jev vs Luna as step model | 11.10 |
| [luna-harness-2026-10-11.md](luna-harness-2026-10-11.md) | iteration log of the Luna harness (original `LOG.md`) | 11.10 |
| [skroutz-runs.md](skroutz-runs.md), [skroutz-runs.csv](skroutz-runs.csv) | Skroutz hiking-cart runs 1-13 (original files, recovered) | 11-12.10 |

The nightly improvement log is `../browse-task/NIGHTLY.md`.
