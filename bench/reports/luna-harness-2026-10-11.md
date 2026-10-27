# Luna harness experiment, 2026-10-11 (branch exp/luna-harness)

Metrics from `lhstat.py` (summary.json + inputTokens in backend-ultrafast.log). Luna $0.10/M input, Jev $0.042/M, output free.
success = whole turn OK; alone = OK without any page-changing browse_* besides browse_task. Scenarios lookup,form,booking,shop, equal weight.
3 runs/scenario (12 runs) are direction checks only; variance is large.

| iter | change | arm dir | n | success | alone | repeats/run | wall p50 (mean of scen) | retry | tok/step | $/step |
|---|---|---|---|---|---|---|---|---|---|---|
| base | old harness, Luna tree+shot | ../jev-vs-luna-2026-10-11/luna-vision-v3 | 12 | 83% | 17% | 2.33 | 30.8 s | 7% | 4480 | 0.000188 |
| base | old harness, Jev tree | ../jev-vs-luna-2026-10-11/jev-v3 | 12 | 83% | 67% | 0.50 | 22.1 s | 0% | 4055 | 0.000170 |
| it1 | Luna profile: short instruction block (replaces 20 rules), none option on target heads, refusal retry up to 4 rounds, noise ops (HOVER/WAIT/SCROLL/ESC/ENTER) offered only when justified, DONE margin 0.15 over runner-up (BLOCKED keeps 0.5), history index + "same action repeated Nx", click on just-typed field => PRESS_ENTER | it1-prompt | 12 | 67% | 58% | 0.58 | 22.4 s | 0% | 3122 | 0.000312 |
| it2 | + MARKS_JS label placement rewrite (desktop), calendar hint when a Next/Previous month control is on the page, screenshot note text | it2-labels-calendar | 12 | 92% | 83% | 0.75 | 23.3 s | 0% | 3054 | 0.000305 |
| tried | + "before the final submit every value must be set" sentence | (replay only) | - | - | - | - | - | - | - | - | REVERTED: broke lookup wrong-edition -> Back (3/3 -> 0/3) |
| final | Luna+vision, final code | final-luna-vision | 24 | 83% | 71% | 1.33 | 26.2 s | 1% | 2964 | 0.000296 |
| final | Luna tree-only, final code | final-luna-tree | 24 | 92% | 67% | 1.00 | 27.0 s | 2% | 1954 | 0.000195 |
| final | Jev tree, final code | final-jev | 24 | 79% | 58% | 0.46 | 21.8 s | 0% | 4005 | 0.000168 |

Remaining Luna failures (6 of 24 each arm): form "address" (text-helper LLM, same for Jev), booking guests/checkin, shop rightProduct.
click-vision (bench/click-vision, 82 calls/arm): arm C (Luna+marks only) 0.829 -> 0.927 (table-row 0.00 -> 1.00); arm D (marks+tree) 0.976 -> 0.976-1.000 (only twin-continue, a disabled-twin item, misses).
