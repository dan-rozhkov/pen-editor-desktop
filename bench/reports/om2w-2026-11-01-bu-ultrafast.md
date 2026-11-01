# Online-Mind2Web (`@om2w`): Browser Use Ultrafast vs our browse modes, 01.11.2026

Trigger: Browser Use post of 31.10.2026, "BU Ultrafast is live": median task 14.4 s, $0.126 for the 25 tasks of the video (~$0.005/task), no success rate given.

Sample: the same 30 tasks as `om2w-2026-10.md` (10 easy, 10 medium, 10 hard; `npm run om2w:prepare -- --n 30 --seed om2w-1`). 2 runs per task in every arm.
Judge: ours (`google/gemini-2.5-flash`, key points, state-only), the same for all three arms, so the arms compare with each other; NOT the official WebJudge.

| arm | ALL | easy | medium | hard | wall p50 | wall p90 | $ per task |
|---|---|---|---|---|---|---|---|
| Browser Use Cloud, `model: bu-ultrafast` (`npm run bu`) | 33% | 12/20 | 6/20 | 2/20 | 24 s | 44 s | 0.016 mean, 0.007 median |
| ours, manual deepseek-v4.1-flash (`--prompt manual`) | 60% | 18/20 | 11/20 | 7/20 | 41 s | 189 s | 0.017 |
| ours, browse_agent (`--prompt agent`) | 57% | 18/20 | 9/20 | 7/20 | 51 s | 222 s | 0.013 |

- Per task (mean over 2 runs) manual beats BU on 13 tasks, loses on 1.
- BU wall time is POST /runs to a terminal status, queue included; per pass p50 was 15 s and 25 s, so the 14.4 s of the post does not reproduce on OM2W. Their costliest tasks: $0.09-0.17.
- Our $ per task is `npm run cost` on the clean pass-2 dirs (pass 1 dirs hold empty runs, see below).
- vs October (manual 57%: 80/50/40): no regression; the difference is within noise.
- Published WebJudge results on these tasks for reference: Browser Use (old, 2025) 8/30, Operator 18/30.

How the BU arm reads the end state: the run gets `keepAlive`; after it ends the bench connects over CDP to the run's own cloud browser (`GET /browsers?agentSessionId=`) and reads the focused http(s) page's `innerText`, the same thing our arms give the judge.

## Incidents in this run (fixed or worked around)

1. OpenRouter credits ran out mid-run (~15:20 MSK). Chat requests got `402 requires more credits`; 41/60 manual and 44/57 agent runs ended empty in 1-2 s. Those runs were re-run after the top-up (`*-fill` dirs = missing pass-1 runs, `*-p2` = pass 2); the empty runs are not counted.
2. The judge also hit the 402. Its failed call used to become verdict `unknown` = a FAILED run, which looked like a medium-task regression (2/10). 12 runs were re-judged (7 became complete). Fixed in this commit: a failed judge call now sets `judgeError`, the run is left out of every success rate (`report.ts`, `om2wReport.ts`, `buCloud.ts`) and the CLI prints a re-judge warning.
3. `data/om2w/` (sample + published results) was missing and was rebuilt from the OSU repo (`data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini/{browser_use,operator}_results.json` saved as `browser_use.json` / `operator.json`). Those files are JSONL; `om2wPrepare.ts` reads JSONL now (it expected a JSON array). The rebuilt sample is byte-identical for seed `om2w-1`.

Raw outputs (ignored): `browse-task/results/om2w-bu-{1,2}`, `om2w-manual-1101{,-fill,-p2}`, `om2w-agent-1101{,-fill,-p2}`.
