# browse_task (Jev / Luna) vs plain deepseek by hand: 13.10.2026

Source: memory note `browse-manual-vs-browse-task-ab`. Raw results (`results/live10-v027-*`, fixture runs) were lost.

Main finding: plain DeepSeek driving the browser itself is faster than `browse_task` on the Decision models (Luna, Jev).
Quality is better on simple fixtures and a tie on live sites.

## Fixtures (`form2`, `form`, `lookup`, `booking`, `shop`; 3 runs each)

| arm | success | browse_task alone | wall p50 | decision p50 |
|---|---|---|---|---|
| main v0.2.6 + Luna | 80% | 80% | 35 s | 668 ms |
| code of 10.10 + Jev | 80% | 53% | 29 s | 343 ms |
| main + Jev | 80% | 53% | 37 s | 349 ms |
| deepseek by hand (`--prompt manual`) | 93% | - | 22 s | - |

## live10 on browser-agent v0.2.7, 3 runs per site

| arm | complete | p50 | p90 | chat input per run |
|---|---|---|---|---|
| Luna / browse_task (`live10-v027-luna-merged`) | 18/30 | 71 s | 154 s | 123k tok |
| deepseek by hand (`live10-v027-manual`) | 18/30 | 61 s | 109 s | 1.1M tok (about 9x) |

Luna better on github and opentable; deepseek better on stockanalysis and gmaps; both 0/3 on apple (configurator) and ebay (filters).

## Cost (13.10 evening, `npm run cost`)

| arm | chat input per run | cache read | total per run |
|---|---|---|---|
| deepseek by hand | 1.42M | 94.4% | $0.012 |
| Luna browse_task | 0.23-0.81M | 81-92% | $0.040 (70% = Luna step decisions, about 7.4k tokens per step) |

Prices: deepseek-v4.1-flash $0.0441/M in, $0.0054/M cache read, $0.63/M out; gpt-6-luna-decisions $0.10/M input, no output charge.

## Other models, partial run (13.10, stopped by the user because of token spend)

| arm | bench | tasks done | solved | $ per task | cache read |
|---|---|---|---|---|---|
| manual deepseek-v4.1-flash | OM2W easy | 9 | 7 | about 0.009 | 94% |
| manual claude-haiku-5.5 | OM2W easy | 9 | 7 | 0.109 | 0% (fixed afterwards, see `om2w-2026-10.md`) |
| manual gpt-6-luna | OM2W easy | 3 | 0 (invalid, strict-schema bug) | about 0.009 | 85% |
| browse_task Luna | WebVoyager | 7 | 5 | 0.027 | 72% |
| manual deepseek | WebVoyager | 12 (7 shared: 5) | 8 | 0.007 | 90% |

WebVoyager sample: `npm run wv:prepare -- --n 45 --seed wv-1` = 45 tasks, 3 per site; 85 of 643 excluded (past dates, login, purchase).
No per-task published results exist (only aggregates: 89.1% self-reported, 60.2% independent replication).

Shipped from this: manual became the product default (backend v0.40.0, `BROWSE_MODE=manual|task`), later replaced by `BROWSE_MODE=agent` (15.10).
