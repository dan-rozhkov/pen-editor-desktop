# Spike report: canvas tool streaming over Electron IPC

Branch `spike/ipc-streaming` in both worktrees. Contract: `docs/spike-ipc-streaming-contract.md`.
Everything below was measured with `e2e/bench-spike-ipc-streaming.spec.ts`; raw per-run data is in
`bench-results/spike-ipc-streaming-latest.json` (wt-spike-desk). Nothing here is estimated unless marked "(est.)".

## Setup

| Item | Value |
|---|---|
| Machine | Apple M4, 10 cores, 16 GB, macOS 26.6.2 |
| Node / Electron / Playwright | v26.10.0 / 43.8.0 / 1.64.1 |
| Frontend | pen-editor 0.82.0, **Vite dev server** (not a production build) on :5198, `VITE_AI_API_URL=http://127.0.0.1:5199/api/chat` |
| AI backend | stub HTTP server run by the spec on :5199 (AI SDK v6 UI-message SSE: `tool-input-start`, `tool-input-delta`, `tool-input-available`, then a text-only turn for the auto-continuation). `/api/models` stubbed. `/api/auth-config`, `/api/skills`, `/api/user-skills` return 404 (the only console errors in every run, identical in tab A and B, also in the no-role baseline) |
| Workload | one `batch_design` call: 24 statements (the per-call cap is 25), each a frame with N small `rect` children. 25 KB = 288 nodes; 200 KB = 2 376 nodes; 1 MB = 11 688 nodes |
| Pacing | one delta every 15 ms (about 4 KB/s for the 25 KB case, faster than a real model) |
| Launch | fresh Electron process per run (fresh userData and HOME); tab A = chat, tab B = canvas, opened through `penTabbar.newTab()`; roles set via `window.__spike.setRole` |
| Timing clock | `performance.timeOrigin + performance.now()` in every renderer and in the Node stub (same machine clock). Resolution is about 0.1 ms and processes can disagree by about 0.1-0.2 ms, so a few values are slightly negative |
| Runs | 5 per scenario for 25 KB, 3 for 200 KB, 2 for 1 MB. Medians / p95 are over runs (with n = 5, p95 is nearly the max) |
| Canvas tab visible? | S1/S2: the canvas tab B was hidden (tab A active). S1v/S2v: B made active right after sending |

"Node timing" is read from a `sceneStore.subscribe` hook in the tab that applies the nodes (A for S0, B for remote): first and last moment
`nodesById` grew. `lastDelta→lastNode` is how long after the final delta left the stub the last node existed.
Per-hop latency stats come from `__spike.stats()` in the **receiving** tab (receivedAt - sentAt, and relayedAt - sentAt for the main hop).

## Results

### S0 baseline (no roles, local apply, 25 KB, 400 deltas), and S1 / S2 remote

All values median / p95 over 5 runs, ms unless stated.

| Metric | S0 local | S1 append (B hidden) | S1v append (B visible) | S2 full (B hidden) | S2v full (B visible) |
|---|---|---|---|---|---|
| first delta → first node | 294.7 / 298.1 | 291.3 / 293.4 | 289.0 / 291.4 | 284.8 / 291.8 | 284.9 / 288.2 |
| first delta → last node | 5 990.3 / 5 991.3 | 5 992.4 / 5 993.7 | 5 992.0 / 5 999.0 | 5 995.1 / 5 998.2 | 5 989.7 / 5 992.9 |
| last delta → last node | 3.5 / 5.3 | 4.1 / 8.5 | 6.0 / 12.7 | 8.1 / 11.6 | 4.0 / 5.6 |
| first delta → next chat request (total) | 6 033.0 / 6 033.5 | 6 033.9 / 6 039.9 | 6 041.4 / 6 044.5 | 6 036.4 / 6 081.0 | 6 033.8 / 6 043.5 |
| stream msgs to canvas | - | 118 / 118 | 117 / 118 | 118 / 118 | 117 / 117 |
| stream bytes over IPC | - | 48 149 / 48 254 | 47 921 / 48 172 | 1 530 436 / 1 534 320 | 1 510 250 / 1 510 647 |
| stream latency p50 / p95 / max (per hop, ms) | - | 0.3 / 0.4 / 0.6 | 0.3 / 0.5 / 0.7 | 0.3 / 0.5 / 0.8 | 0.2 / 0.4 / 0.6 |
| main hop p50 / p95 | - | 0.15 / 0.25 | 0.20 / 0.35 | 0.17 / 0.30 | 0.13 / 0.23 |
| `call` message bytes | - | 25 714 | 25 714 | 25 717 | 25 717 |
| `call` latency (max) / `result` latency (max) | - | 0.2 / 0.5 | 0.4 / 0.5 | 0.2 / 0.7 | 0.2 / 0.7 |
| seq gaps / out-of-order / resyncs / ignored frames | - | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| long tasks (>50 ms) in the node-applying tab | 0 (one run had 1 x 86 ms) | 0 | 0 | 0 | 0 |
| CPU-s, chat tab / canvas tab / main (cumulative-CPU delta, whole turn) | 1.90 / - / 0.07 | 1.59 / 0.70 / 0.10 | 1.70 / 0.75 / 0.10 | 1.50 / 0.66 / 0.11 | 1.50 / 0.68 / 0.10 |

Reading: 400 deltas reach the chat tab as about 118 partial inputs (roughly 20 per second; the chat hook coalesces deltas, so frames are
not deltas). Remote application is indistinguishable from local application: the first node appears about 290 ms after the first delta in all
variants (the first statement needs about 17 deltas), the last node appears at the stream end plus 4-8 ms, and the continuation request leaves
about 40 ms after the last delta in all variants. The IPC hop is 0.3 ms p50 and 0.5 ms p95 end to end (about 0.2 ms of it is main). Making
the canvas tab visible changed nothing measurable.

### S3 large (200 KB, 800 deltas, 2 376 nodes, 3 runs) and S3x stress (1 MB, 2 000 deltas, 11 688 nodes, 2 runs)

| Metric | S3 local | S3 append | S3 full | S3x append | S3x full |
|---|---|---|---|---|---|
| first delta → first node | 536.7 / 540.2 | 531.8 / 534.9 | 540.4 / 547.8 | 1 306.5 / 1 307.2 | 1 312.6 / 1 318.6 |
| first delta → last node | 12 007 / 12 012 | 12 009 / 12 012 | 11 991 / 12 005 | 29 980 / 30 079 | 29 984 / 30 043 |
| last delta → last node | 20.5 / 27.1 | 23.6 / 25.9 | 4.1 / 18.2 | -8.0 / 92.2 | 20.7 / 58.7 |
| stream msgs to canvas | - | 234 / 235 | 235 / 235 | 580 / 581 | 581 / 582 |
| stream bytes over IPC | - | 259 204 | 25 232 353 | 1 181 385 | 309 152 979 |
| stream latency p50 / p95 / max | - | 0.2 / 0.4 / 1.3 | 0.5 / 0.7 / 0.9 | 0.2 / 0.3 / 4.7 | 1.1 / 1.6 / 7.2 |
| `call` message bytes / `call` latency (max) | - | 213 994 / 0.6 | 213 994 / 9.9 | 1 068 730 / 1.6 | 1 068 730 / 36.0 |
| `result` latency (max) | - | 1.7 | 1.2 | 4.0 | -1.4 (clock skew) |
| seq gaps / out-of-order / resyncs | - | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| long tasks, canvas tab (count / total ms) | 0 (1 x 60 ms in one run) | 0 / 0 | 0 / 0 | 1 / 104 | 1 / 95 |
| long tasks, chat tab | same tab as above | 0 (1 x 60 ms in one run) | 0 | 1 / 62 | 1 / 50 |
| CPU-s chat tab / canvas tab / main | 5.06 / - / 0.20 | 3.49 / 1.77 / 0.21 | 3.12 / 1.56 / 0.21 | 13.36 / 9.17 / 0.56 | 12.42 / 8.42 / 0.52 |

Full vs append, total stream bytes to the canvas: 25 KB: 1.53 MB vs 48 KB (32x); 200 KB: 25.2 MB vs 0.26 MB (97x); 1 MB: 309 MB vs 1.18 MB
(262x). Full grows quadratically in the payload (frames x average size), append linearly (payload plus about 100 bytes of envelope per frame).
Full did **not** break anywhere I could drive it: the p95 transit latency stayed at 1.6 ms at 1 MB (309 MB moved), and node timing matched
append. The extra cost shows only in transit latency (about 1 ms vs 0.2 ms) and the `call` latency (36 ms vs 1.6 ms at 1 MB, because the
final call is a 1 MB structured clone either way but queues behind the full frames). CPU differences between append and full are inside the
noise of 2-3 runs. Most CPU (13 CPU-s at 1 MB in the chat tab) is the chat tab's own partial-JSON handling, which exists with or without IPC.

I did not find the point where full breaks; it would need a faster or larger stream than 1 MB at 20 frames/s (not measured).

### S4 context round trips (100 back-to-back `__spike.requestContext()` calls from the chat tab per phase)

`requestContext` is a small dev-only helper I added to `window.__spike` (see "Spike fixes"). Mutations were made in tab B through the
real `executeToolCall("batch_design", ...)`.

| Phase | Scene nodes | Round trip p50 / p95 / max (ms) | Fallbacks | Null responses | Distinct responses | `contextStable` | Response size |
|---|---|---|---|---|---|---|---|
| empty, unchanged | 0 | 0.1 / 0.2 / 1.5 | 0 | 0 | 1 | true (99 repeats) | 218 B |
| after 1 mutation, unchanged | 1 | 0.1 / 0.2 / 0.5 | 0 | 0 | 1 | true (99 repeats) | 272 B |
| mutate before each request | 101 | 0.2 / 0.5 / 1.4 | 0 | 0 | n/a (all differ by design) | n/a | 3.2 KB avg |
| large scene (288 added), unchanged | 389 | 0.1 / 0.2 / 0.4 | 0 | 0 | 1 | true (99 repeats) | 7.4 KB |
| large scene, mutate before each request | 489 | 0.4 / 0.6 / 11.6 | 0 | 0 | n/a | n/a | 10.4 KB avg |

The canvas answers an unchanged scene with byte-identical strings (checked two ways: hash per scene-version inside tab B, and distinct
response count in tab A). One S4 sample (n = 100 per phase) per phase; not repeated across launches.

### S5 canvas tab closed mid-stream (25 KB, append, tab B closed through the tab bar's close button at delta 200 of 400; 5 runs)

| Metric | Result |
|---|---|
| Tool output seen by the model (continuation request body) | `{"error":"no canvas tab"}` in 5 of 5 runs |
| Close → chat-side tool call resolved with error (= continuation request at the stub) | median 3 027 ms, p95 3 029 ms (min 3 020) |
| Last delta → continuation request | median 32.0 ms, p95 32.6 ms |
| Chat turn finished cleanly | yes, 5 of 5: the follow-up text turn was shown, no error banner |
| Nodes already on the canvas when B closed | 132 of 288 (these die with the tab) |
| `peer-gone` received by chat tab | 1 per run |
| `error` envelopes received by chat tab (one per frame forwarded after the close) | 61-62 per run (about 60 KB sent for nothing) |
| Console errors beyond the three baseline 404s, tab A and tab B | none |

So the error does not appear when the tab closes. The 3.0 s is exactly the remaining stream time: the tool call is only forwarded
(and so only fails) when the model finishes the tool call, 32 ms after the last delta. Until then the chat tab keeps forwarding frames into the
void and main answers each with an `error` envelope.

## Observations

- Ordering: 0 sequence gaps, 0 out-of-order, 0 resyncs and 0 ignored frames in every run of every scenario. The resync path never fired,
  so it was **not** exercised end to end here (only by the unit tests).
- Per-message cost is dominated by clock resolution. Transit is 0.2-0.5 ms p50 for a 400 B message and 1.1 ms for a 530 KB message.
- Frame cadence is about 20 per second whatever the delta rate or payload size (118 frames for 400 deltas, 235 for 800, 580 for 2 000 in
  30 s). Append's saving is therefore in bytes per frame, not in frame count.
- Jank: the PerformanceObserver (`longtask`, >50 ms) saw no long task in either tab up to 200 KB (rare single 54-86 ms tasks appeared in
  both the local and the remote runs, so they are not caused by IPC). At 1 MB (11 688 nodes) the canvas tab had one 95-105 ms task and the
  chat tab one 50-60 ms task per run. This is not frame-level jank measurement.
- CPU (`app.getAppMetrics`, cumulative CPU-s over the turn): at 25 KB the chat tab uses 1.5-1.7 s and the canvas tab 0.7 s, against 1.9 s for the
  single tab in S0. The main process adds 0.03 s. Splitting the work moved CPU to a second renderer; it did not add much total CPU.
  My own stats code runs `JSON.stringify` on every envelope to count bytes, which inflates CPU for the full format most. Treat full's CPU as an
  upper bound.
- Canvas visible vs hidden: no difference in node timing, latency or CPU.

## Failure behavior

- Canvas tab closed mid-stream: the model gets a JSON error and the turn finishes cleanly, but late (see S5) and with a message that
  names no cause the model can act on beyond "no canvas tab".
- Not tested: closing the canvas tab while the final `call` is executing, reloading the canvas tab mid-stream, replacing the canvas role mid-stream,
  chat tab closing while the canvas tab streams (the canvas side's `abandonAll` path), and a forced append offset mismatch.

## Recommendation

1. **Wire format: use `append`.** In latency and node timing the two formats are equal at every size I tested, so this is a cost decision. Append
   sends 32x (25 KB) to 262x (1 MB) fewer bytes, with linear instead of quadratic growth, and its transit latency stays flat at 0.2-0.3 ms. Full needs
   no resync logic, but at real model sizes (up to a few hundred KB) it moves tens of MB per call for no benefit. Keep the `full` fallback only as the
   resync answer (it is already that). The sender should keep `rest` omitted when unchanged (it is).
2. **IPC streaming is viable for the feature.** The relay added at most 0.5 ms p95 per message, with no measurable change in when nodes appear
   (first node about 290 ms, last node at stream end + 4-8 ms, identical to the single-tab case), and `canvasContext` round trips take 0.1-0.4 ms at
   p50 (11.6 ms worst seen) with byte-identical answers while the scene is unchanged. The measured pace (15 ms per delta, about 20 frames per
   second) is faster than a real model, so real use has more margin. Transport is not the risk.
3. The risks are lifecycle, not speed. See open problems.

## Open problems

1. **Dead-peer handling is late and noisy.** After `peer-gone`, `ChatSide.failEverything` clears `streams`, but `forwardFrame` then opens a new stream
   for the next frame because `ended` does not contain the id, so about 60 frames still go out and come back as `error` envelopes. The pending call
   is also only failed when the model completes the call. Proposed fix (not applied): latch a `peerGone` flag in `ChatSide` that makes `forwardFrame` a no-op and
   makes `call()` resolve at once with an error; and on `peer-gone`, tell the user (or abort the turn) instead of letting the model keep generating a
   design that cannot be applied.
2. Loss of work: the nodes already applied (132 of 288) vanish with the tab, and the model is told only `no canvas tab`. The real feature needs a policy
   (re-open a canvas tab and replay, or fail the whole turn).
3. Resync, role replacement, canvas reload, chat-tab-close-while-streaming are untested end to end (see Failure behavior).
4. Single-window, single-chat/single-canvas by design; no ordering or identity story for several chats or windows.
5. The chat tab still does the partial-JSON parse of the tool input at about 20 Hz, so the chat tab's CPU grows superlinearly (13 CPU-s for a
   1 MB call), unrelated to IPC. Moving that parse next to the data would be a separate change.
6. `canvasContext` is a synchronous-looking value in the request body today; the spike makes it an awaited round trip with a 2 s timeout and local
   fallback. No fallback ever fired here, but a canvas tab stuck in a long task (more than 2 s) would silently send the chat tab's stale local context.
7. Limits of this measurement: Vite dev build, stub backend, M4 laptop, synthetic frames/rects (no embeds, images or text layout), 2-5 runs per
   scenario, no frame-time (rAF) jank measurement, clock resolution 0.1 ms, and the hidden-tab case was only checked for one pair of formats.

## Spike fixes

Only one change to the spike code: a dev helper `requestContext()` on `window.__spike` (`wt-spike-fe/src/lib/surfaceSpike/runtime.ts`, marked
`// SPIKE(ipc-streaming)`), used by S4. Nothing in the spike was broken enough to need a repair.
Checks after the change: frontend `npm run lint` 0 errors (16 warnings), `npm test` 624 files / 7 128 tests passed, `npm run build` OK;
desktop `npm run lint` OK, `npm test` 42 files / 774 tests passed, `npm run build` OK.

## How to rerun

```bash
# 1. frontend (wt-spike-fe), port 5198, chat URL pointing at the spec's stub
cd wt-spike-fe
VITE_AI_API_URL=http://127.0.0.1:5199/api/chat NODE_OPTIONS=--no-experimental-webstorage npm run dev -- --port 5198 --strictPort
# 2. in wt-spike-desk (builds the shell, then runs the opt-in bench config)
cd wt-spike-desk
SPIKE_OUT_DIR=$PWD/bench-results npm run test:e2e:bench -- e2e/bench-spike-ipc-streaming.spec.ts
# knobs: SPIKE_SCENARIOS=S0,S1,S1v,S2,S3,S4,S5 (S3x is opt-in), SPIKE_RUNS=5, SPIKE_PACE_MS=15, PEN_DESKTOP_URL (must include /app)
```
Use a `SPIKE_OUT_DIR` outside `test-results/`: Playwright empties `test-results/` at the start of every invocation.
