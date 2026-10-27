# Jev vs `openai/gpt-6-luna-decisions` as the browse_task step model: 11.10.2026

Source: memory note `luna-decisions-vs-jev-experiment`, and the iteration log `luna-harness-2026-10-11.md` (recovered from the transcript, verbatim).
Raw results `results/jev-vs-luna-2026-10-11` and `results/luna-harness-2026-10-11` were lost.

Same contract as Jev (`POST /api/v1/systemone`, body `{state, model, questions}`), so the swap is `TYPESAFE_BASE_URL=https://openrouter.ai/api/v1`, `TYPESAFE_MODEL=openai/gpt-6-luna-decisions`.
Two incompatibilities Jev did not have: 400 on a `choice` with one option, and 502 "OpenAI refused" on about 10% of steps.

## Round 1 (with a temporary workaround), browse_task 4 fixtures x 3 runs, ultrafast

| arm | success | browse_task alone | wall | repeats per run |
|---|---|---|---|---|
| Jev | 83% | 67% | 22 s | 0.3 |
| Luna | 92% | 33% | 35 s | 4.7 (loops on booking) |

Decision price: Jev $0.042/M, Luna $0.10/M, output free; step Jev $0.00017, Luna $0.00035.
Taste-check recall: Jev 24/27 (misses `everything_centered`), Luna 27/27, both about 270 ms, Luna 3.5x more expensive.
Click by screenshot (`bench/click-vision`): tree Jev = Luna = 82.9%; screenshot + marks + tree (Luna) 97.6%; grid without marks 53.7%.

## Round 2: screenshot + tree in the real browse_task (24-36 runs per arm; branches not merged)

| arm | success | browse_task alone | wall | $ per step |
|---|---|---|---|---|
| Luna + screenshot | 88% | 25% | 30 s | 0.00042 |
| Luna tree | 75% | 21% | 31 s | 0.00032 |
| Jev tree | 75% | 59% | 22 s | 0.00017 |

Spread is huge: one Luna-tree arm gave 92%/33%, another 58%/8%. Do not compare with fewer than 6 runs per scenario.

## Round 3: the Luna lag was in the harness (merged to main)

The 20 `NEXT_ACTION_RULES` were written for Jev and confuse Luna; with a short instruction block accuracy on saved states went 1/7 -> 7/7.
Final, 6x4 runs: Luna tree 92% / browse_task alone 67% / 27 s / $0.000195 per step; Luna + screenshot 83% / 71% / 26 s / $0.000296; Jev 79% / 58% / 22 s / $0.000168.
Quality is a tie within the spread; Jev is faster and cheaper. (Prod was switched to Luna on 11.10 16:37 MSK; rollback = `TYPESAFE_MODEL=jev-latest`.)
Set-of-Marks labels, new placement: click-vision screenshot-only 0.829 -> 0.927, table rows 0/6 -> 6/6.
