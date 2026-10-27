# browse_task on skroutz.gr: run log for idea generation

Last update: 2026-10-12. Machine-readable table: `skroutz-runs.csv` (same folder).
Older handoff (Russian): `../../browse-task-skroutz-handoff.md`.

## 1. The task

A design agent (chat model `deepseek/deepseek-v4.1-flash` on the bench) gets this
user message (Russian) and must delegate the whole job to the `browse_task` tool:

> Open https://www.skroutz.gr and build a cart with everything one person needs for a
> 2-day mountain hike with a tent night in Troodos, Cyprus. Decide the items yourself,
> find each one on skroutz and add it to the cart. At the end list the cart with prices
> and the total.

Success, as the user sees it: a complete, relevant cart (≈12–15 items), each item
once, no unrelated items, one or very few `browse_task` calls, a correct list with
prices and total.

## 2. Hard constraints from the user (do not propose these)

- **No site-specific rules.** Every fix must be universal (no Greek strings, no "skroutz").
- **The chat agent must not split the task** into one `browse_task` per item.
- **Do not put the overall goal into each sub-goal text** (it confused the step model).
- Workflow: backend schema first, then frontend; lint + test + build green before push.
- The user worries we are over-engineering. Prefer removing or simplifying over
  adding heuristics. A fix must be backed by run data.

## 3. How the system works

```
chat model ──browse_task(goal)──▶ frontend loop (pen-editor/src/lib/tools/browser/browseTask.ts)
   │                                 │ 1. POST /api/browse/plan → ordered sub-goals (backend src/ai/browsePlan.ts)
   │                                 │ 2. per sub-goal, repeat:
   │                                 │      snapshot (desktop pageScripts.ts SNAPSHOT_JS: ≤120 elements, modal, scroll)
   │                                 │      POST /api/browse/step  (backend src/ai/browseStepUltrafast.ts)
   │                                 │         step model: TYPESAFE_MODEL=openai/gpt-6-luna-decisions (Luna,
   │                                 │         "System One" decisions API, ≤255 choices per question) + screenshot
   │                                 │         TYPE_TEXT value written by writeFieldText (gemini-2.5-flash)
   │                                 │      act in the Electron browser tab (desktop controller.ts)
   │                                 │ 3. result: status, subgoals[], stepsTotal, transcript
   ◀──────── tool result ───────────┘
```

Limits: 25 steps per sub-goal, 150 steps and 12 min per `browse_task` call.
History sent to the step model: last 10 entries `{operation, label, ok, index}`.

History label contract (frontend → backend), added in run 8:
`<element label> → effect: "<old>" became "<new>"; counter a→b; appeared: "<text>"`,
optional suffixes ` (page updated: "…")`, ` (no effect)`, ` (earlier sub-goal)`.

## 4. Run history

| Run | What changed before the run | Wall | Calls | Manual acts | Sub-goals done | Cart | Main failure |
|---|---|---|---|---|---|---|---|
| 3 | Chat agent splits per item | 571 s | 16 | 11 | — | 8 items | Many small calls; chat turn cap |
| 4 | Whole goal in ONE call, no planner | 1110 s | 2 | 46 | — | — | Stalled after the tent; then manual acts |
| 5 | + planner (12 sub-goals) | 899 s | 2 | 44 | 4/12 | — | Click on a filled search field ×10; add-to-cart dialog hid the page |
| 6 | + modal sent to step; refocus-type | 846 s | 2 | 47 | 1/12 | — | Model never said DONE; 429s; sub-goal started at page bottom |
| 7 | + sub-goal text without overall goal; 429 retry; scroll to top | 638 s | 7 | 10 | ≈18 | 13 items, 903.95 € | Stalls after 2–3 sub-goals; System One 400; 3 duplicate adds; 2 unwanted items |
| 8 | + see §5 | 365 s | 2 | 0 | 15/21 | 6 items, 197.83 € | Click/Escape loop; items of call 1 missing from the cart; false DONE |
| 9 | + see §6 | 491 s | 7 | 5 | 13/16 (call 1: "12/12", 2 of them false) | 14 items, 1539.18 € on the cart page | Endless hunt for a gas canister; wrong product; premium picks |
| 11 | + see §6c | 222 s | 2 | 0 | 8/18 (call 1: 7/11, 2 false) | 5 items, 371.52 €; **judge: partial, 3/14** | Click/Escape loop on recent-searches dropdown; used-goods search scope; false DONE |
| 10 | + see §6b | 355 s | 3 | 0 | 14/26 (call 1: 3/12) | 12 items, 472.50 €; **judge: partial, 10/14 required** | Planner sub-goals stall; false DONE persists (backpack, bottle, first aid); duplicate rain jacket |
| 12a | + see §6d | 430 s | 3 | 5 | 19/23 (call 1: 10/12, 3 false) | 11 items, 504.44 €; **judge: partial, 9/14** (required 8/10) | 5 false DONE (tent, poles, lantern, jacket, poles); size-modal loop on the jacket; pot never planned |
| 12b | + see §6d | 340 s | 3 | 4 | 9/23 (call 1: 6/12) | 6 items, 830.11 €; **judge: partial, 6/14** (required 6/10) | TYPE_TEXT / PRESS_ESCAPE loop on 10 sub-goals (no reset fired); 3 false DONE |
| 12c | + see §6d | 490 s | 3 | 4 | 19/27 (call 1: 12/12, 5 false) | 12 items, 662.35 €; **judge: partial, 9/14** (required 8/10) | 6 false DONE (first aid twice); call 3 stuck on /cart; pot never planned |
| 13a | + see §6e | 393 s | 3 | 12 | 12/16 | 8 items, 406.36 €; **judge: partial, 8/14** (required 8/10) | pot and jacket never planned; 5 false DONE repaired by repeat calls + manual acts; call 3: garbled planner phrases |
| 13b | + see §6e | 350 s | 3 | 2 | 17/25 | 11 items, 815.30 €; **judge: partial, 7/14** (required 6/10) | 6 false DONE (mat, pot, jacket listed as "already added"); bottle scroll loop in 3 calls; 5 invented extras |
| 13c | + see §6e | 424 s | 3 | 7 | 15/19 | 12 items, 678.49 €; **judge: partial, 11/14** (required 10/10) | poles and sunscreen false DONE; reply listed the poles as a cart row |

Single runs on a live site. Variance between runs is large; treat one run as a hint.

## 5. Findings and fixes after run 7 (shipped before run 8)

| Problem in run 7 | Root cause (evidence) | Fix | Result in run 8 |
|---|---|---|---|
| Sub-goal stalls after 2–3 done | After "Add to cart" a non-aria full-viewport drawer opens. The snapshot's cover test (`penIsCovered`) silently drops the header (search field, cart link). `modal` stayed empty, so the model scrolled with no effect. 8 of 18 sub-goal starts had no text field. | Desktop: such a wall is reported as `modal`. Frontend: a search sub-goal that starts behind a modal without a text field presses Escape, then reopens the site. Stall → reopen once and retry. | Header problem gone, but the overlay detector also caught the search **autocomplete** → see run 8 failure 1. |
| System One HTTP 400 | Luna rejects a question with > 255 choices. 3 large `<select>`s gave 304–310 SELECT options. Reproduced: 255 OK, 256 → 400. | Cap each question at 254 + NONE; goal-matching options first. | 0 errors. **Clear win.** |
| Duplicate "Add to cart" | After the add, the button text became "Add to cart 1". The model saw only the bare label in history; a new sub-goal started with empty history. | Effect notes in history; last 2 entries carried into the next sub-goal; backend turns a repeat click on the observed "became" label into DONE (current sub-goal) or hides it (carried). | 0 duplicates. **Clear win.** |
| Unwanted items (lamp, magnesium) | Search text copied from page text ("Ενδεικτικά Είδη" from the cart page), then the first result was clicked. | writeFieldText prompt: search text comes from the goal only. | 0 unwanted items. |
| Hypothesis: `executeJavaScript` hangs until load | Experiment: it waits for `did-finish-load`, but only 1–5.5 s on skroutz. | none | Refuted as the cause. |
| Hypothesis: scroll to top fails | Experiment: `window.scrollTo` works; the window is the scroller. | none | Refuted. |

## 6. Run 8 failures and what was done (shipped before run 9)

1. **Click → Escape loop (biggest loss).** Typing into the header search opens an
   autocomplete panel that covers the page. The new overlay detector reported it
   as `modal`; the backend offers PRESS_ESCAPE for a modal; Escape cleared the text;
   repeat. 4 sub-goals hit the 25-step budget, the 150-step cap was spent.
   Fix: the overlay is skipped only when the focused element is a real text input
   outside the overlay and the overlay is tied to it (aria-controls/owns/list, or it
   holds listbox/option). (desktop `6dfac76`)
2. **Items of call 1 missing from the final cart.** Call 1 reported 6 sub-goals done;
   none of those items were in the cart at the end. Investigation:
   - The site reopen navigates the same tab, same persistent partition. A standalone
     Electron experiment (add, reload, new view, same partition) kept the cart
     (cookie `ecommerce_guest_cart_id`, httpOnly).
   - The header cart badge renders late; frames are not reliable evidence.
   - Two call-1 DONEs were false (no add click / unrelated `appeared` effect).
   - Root cause still unknown. Run 9 logs cart cookies every 3 s (`cookies.log`).
3. **False DONE.** Model said DONE on a product page without clicking add.
   A hard backend gate was tried and **removed** after review (endless demotion,
   history window only 10). Kept: prompt rule "DONE only after a visible add/submit".
4. **"X or Y" in a sub-goal** → BLOCKED "the goal gives no value for the field".
   Kept: prompt line "if the goal offers alternatives, type the first one".
   (A deterministic fallback was tried and removed.)
5. **Relevance** (not addressed): a motorcycle rain jacket (75 €), a 1 cm foam mat.
   The planner writes "add the cheapest reasonable option"; the step model clicks
   early results.
6. **Chat agent stops early** (not addressed): in run 8 it made 2 calls and reported
   an incomplete cart instead of calling again for the missing items.

## 6a. Run 9 results

- **Call 1 finished 12/12 sub-goals in 83 steps** (first time a whole plan passed in one call).
  No click/Escape loop, no System One 400, no duplicate adds.
- **Cart never reset.** `cookies.log`: the guest-cart id inside `ecommerce_guest_cart_id`
  (a signed Rails cookie; the value changes, the decoded id does not) was `117902093`
  for the whole run. The run-8 "lost items" stays unexplained; the most likely reading is
  that those call-1 DONEs were false (no real add), plus a late-rendering badge.
- **Then the chat agent spent 6 more calls (≈4 min) on one item**: a gas canister that
  the site does not sell. 4 calls ended `budget`. An extra stove got added on the way.
- **Wrong product**: "backpack 50–60L" sub-goal added a 60L backpack *rain cover*; the
  chat agent then added a real backpack in a follow-up call.
- **Relevance / price**: premium picks (sleeping bag 369 €, pad 259 €, 4-person pot set
  208 €). The planner wrote "open a suitable product listing", no budget.
- Chat model answered in English to a Russian request.

## 6b. Run 10 (first run with a real oracle)

Shipped before run 10 (backend `ea901e8`): planner sub-goals end with
"Done when: … / Does not count: …"; the step model may not answer DONE right after
one no-effect action (runner-up ≥ 0.15 that does not redo it); chat agent sends ONE
repeat call with all unfinished sub-goals, at most 2, and reports "not completed after
K attempts" without inventing reasons. Bench: `BENCH_LIVE_END_URL` +
`BENCH_LIVE_END_CHECK` → hidden window in the agent's partition reads the page at the
end (`end-state.txt/png`), an LLM judge writes `judge.json`. Re-score offline:
`npm run judge -- --dir results/<run>`.

Result: judge **partial, 10/14**. Missing: backpack, water bottle, first aid kit,
trekking poles. Duplicate rain jacket. Knife and wipes were chosen by the chat agent.
Reply total matched the cart (472.50 €).
Call 1 (planner, sub-goals in Russian this time): 3/12 done. Call 2 (sub-goals
written by the chat agent as explicit step lists): 11/12 "done", but 3 of those items
are not in the cart.

Analysis of run 10 (step indices = global `steps`):
- **Search text in the wrong language.** The planner wrote sub-goals in Russian (the
  user's language). TYPE_TEXT typed Russian ("походный рюкзак 40-50 л") into a Greek
  site; results empty. Only sub-goals whose text had the Greek word in parentheses
  worked. Then TYPE_TEXT of the same string repeated with "(no effect)" until stall.
- **Wrong search scope.** After one DONE on a used-goods sub-section page, the page's
  search field searched only that section; every later sub-goal searched there.
  Recovery at sub-goal start fires only when no text field exists.
- **"No value for the field" is terminal BLOCKED** (steps 64, 85, 94) after 3 steps.
- **False DONE persists**: backpack (176→177), water bottle (150→151), first aid
  (160→161), poles (156 add click with no effect note → 157 DONE), gas (134→135).
  DONE accepted at peak ≥ 0.5 on a product page with no cart change, although the
  sub-goal says "Done when: the item appears in the cart".
- **Successful add, then stall**: mat sub-goal had counter 0→1 at step 27, model never
  said DONE, the 3-step no-progress rule marked it stalled.
- **Duplicate jacket**: a sub-goal added a jacket, did not say DONE, ended `budget`;
  the chat agent's repeat call re-ran it and added a second jacket.
- `done-after-no-effect` fired once (step 146) and helped; too narrow to matter.

Runs 3–9 have no judge; their "success" is the old reply regex and means nothing.

## 6c. Run 11

Shipped before: backend `5022f86` (search phrase in the site language, quoted; no-value
TYPE_TEXT → runner-up), frontend `424d97f8` (commit effect on the clicked control
auto-finishes a sub-goal). Judge: **partial, 3/14**. Analysis says neither commit caused
the drop: auto-confirm fired once, correctly; `no-text-runner-up` fired 0 times; Greek
search phrases were typed correctly; call 1 rose to 7/11 "done" (from 3/12).
Causes, all pre-existing:
- **Click/Escape loop** in call 2: clicking an EMPTY search field opens a
  recent-searches dropdown; the model answers it with Escape; repeat (74 CLICK + 67
  ESCAPE of 150 steps). The click counts as "page updated" and Escape as `ok:false`, so
  the 3-step no-progress rule never trips. Call-2 sub-goals were written by the chat
  agent as "click the field, type …".
- **False DONE**: sleeping bag (opened product → DONE 0.85, no add), stove (6 scrolls →
  DONE at 0.2).
- **Search scope**: after one sub-goal ended in a used-goods sub-section, its search box
  searched only that section for all later sub-goals.
- **Wrong picks**: baby sleeping bag, a vest instead of a jacket.
- "No value" BLOCKED once, while suggestions were open after the phrase was typed
  (PRESS_ENTER was the right move).

## 6d. Runs 12a–12c (cycle stop, click→type, Luna DONE peak, search reset)

Shipped before: (1) two-step cycle detector (last 6 steps A,B,A,B,A,B with identical
op+label+url → sub-goal `stalled`, reason `cycle — …`); (2) backend gate
`click-empty-field-typed` (CLICK on an empty text field → TYPE_TEXT when the goal
quotes a phrase and the written text equals it); (3) Luna DONE needs peak ≥ 0.3;
(4) between two consecutive sub-goals that both "search for" a quoted phrase, the second
starts with `OPEN <site url> (sub-goal start: new search)`. Same chat model, same site,
same oracle. Data: `results/skroutz-hiking-12a|12b|12c`. Three single runs: a hint, not a
statistic. The chat agent wrote a different item list each run (12 items each).

| | 12a | 12b | 12c | run 10 | run 11 |
|---|---|---|---|---|---|
| Judge | partial | partial | partial | partial | partial |
| Required (first 10) ok | 8/10 | 6/10 | 8/10 | n/a (10/14 total) | n/a (3/14 total) |
| Nice-to-have (4) ok | 1/4 | 0/4 | 1/4 | | |
| Total ok / 14 | 9 | 6 | 9 | 10 | 3 |
| Extras / duplicates | 2 / 0 | 0 / 0 | 3 / 0 | 2 / 1 | 1 / 0 |
| Cart items / total | 11 / 504.44 € | 6 / 830.11 € | 12 / 662.35 € | 12 / 472.50 € | 5 / 371.52 € |
| Wall (browse / chat) | 430 s (305 / 120) | 340 s (270 / 65) | 490 s (364 / 121) | 355 s | 222 s |
| Step requests | 187 | 185 | 236 | | 150+ |
| browse_task calls | 3 | 3 | 3 | 3 | 2 |
| Sub-goals done | 19/23 | 9/23 | 19/27 | 14/26 | 8/18 |
| Cycle stops | 3 | 13 | 6 | n/a | n/a |
| Resets fired | 15 | 0 | 18 | n/a | n/a |
| click-empty-field-typed | 3 | 0 | 0 | n/a | 0 |
| DONE with peak < 0.3 | 0 | 0 | 0 | | 1 (0.2) |
| False DONE (no add effect) | 5 | 3 | 6 | 5 | 2 |
| Requests in sub-goals that went nowhere (est.) | ~62 (33 %) | ~116 (63 %) | ~121 (51 %) | | 141 in one loop |

Judge oracle: the first 10 requirements are required (tent, sleeping bag, mat, backpack,
headlamp, stove, pot, water bottle, rain jacket, first aid), the last 4 nice-to-have
(fuel, poles, repellent, sunscreen). Boots are NOT in the oracle, so a boots add counts as an
extra. The judge accepted a motorcycle rain jacket and a dry-sack as "backpack".
"False DONE" = DONE (or sub-goal `done`) for an add-to-cart sub-goal with no effect
annotation (`became`/`counter`/toast) in its steps. In 14 of 14 cases the add button was
visible or not even tried; in one extra case (12a boots) a real add had no effect label.

### Change 1: cycle stop — fired 22 times, no false positive, but it treats the symptom

Cycles: 13 × TYPE_TEXT "<phrase>" / PRESS_ESCAPE (12b ×10, 12c ×3), 5 × cart overview click /
same click "(no effect)" (the "report the cart" sub-goal, 12a ×1, 12b ×2, 12c ×2),
2 × SCROLL_UP / SCROLL_DOWN on a listing (12a water bottle, 12b tent), 1 × CLICK search field /
PRESS_ESCAPE (12c rain jacket, product page; this is the run-11 loop), 1 × "Επίλεξε μέγεθος" /
"Close modal" (12a rain jacket).
- **Budget: helpful.** Every loop ended after 5–7 requests. Run 11 spent 141 of 150 steps
  in one loop; here the worst single loop is 7. Upper bound of the saving: 22 loops × (25 − 6).
- **Outcome: neutral.** A cycle ends the sub-goal on the same dead page, so the next
  sub-goal starts in the same state and loops again. 12b: 5 consecutive sub-goals in call 1
  (37 requests), 3 more in call 2, 2 more in call 3 (79 of 185 requests in TYPE/ESC). The stop
  never lost a productive pattern (checked all 22). It did not catch irregular
  scroll loops: 12a cart-verify sub-goal 25 scrolls, 12b tent 17 scrolls before the
  alternating tail, 12c lighter 23 scrolls on a product page, 12c cart removal 25 steps.

### Change 2: click-empty-field → TYPE_TEXT — fired 3 times (all 12a), helpful 3/3

All three firings were right after a reset (step model clicked the empty field on the
fresh home page, 3 of 15 resets). The next step was PRESS_ENTER with results, and
the tent, lantern and water-bottle sub-goals went on. It did not fire in the one place the
run-11 loop re-appeared (12c step 114: CLICK on the search field on a product page, field
not empty, recent-searches dropdown) — the cycle stop ended that loop, not the gate.

### Change 3: Luna DONE peak ≥ 0.3 — fired 0 times, no effect

Lowest accepted DONE peak: 0.45; lowest DONE pick seen at all: 0.37 (demoted by the old
margin rule). Demotions: 12a 2, 12b 1, 12c 1 (all ≥ 0.37). The 14 false DONEs had peaks
0.45–0.96 (median ≈ 0.78); true DONEs 0.85–0.98. Peak does not separate true from
false DONE, so this gate cannot help. Step diag shows the add button visible on the page
for the 12c cases (e.g. steps 21, 39, 52, 65, 98: DONE 0.80–0.95 with "Προσθήκη στο καλάθι" in the list).

### Change 4: search reset — fired 33 times (12a 15, 12c 18; 12b 0), helpful where it fired

After a reset TYPE_TEXT → PRESS_ENTER worked every time (33 of 33 searches reached results;
one TYPE → ESC → TYPE → ENTER in 12c). Without a reset on a non-root page: 27 of ~40 TYPE_TEXT
were followed by PRESS_ESCAPE and 2 by Enter. No wrong-scope search (the run-9/10/11
used-goods trap) and no lost state. No harm seen (cart persists across OPEN). Confounded: the reset
only fires for plans that say "Search for", and 12b's planner wrote "Find a suitable
"x"", so the runs with and without reset also differ in wording. Holes:
(a) `isQuotedSearch` needs the verb "search" in both sub-goals → 0 resets in 12b;
(b) skipped when `lastUrl == siteUrl` (a cycle on the root page keeps the state);
(c) never for sub-goal 1 of a repeat call, which starts on whatever page is open
(12b calls 2–3: a product page; 12c call 3: `/cart`, and the "site url" it would reset
to is `/cart` itself); (d) the older "no text field" recovery reopened the LAST LISTING url
(`…/mpotakia.html?keyphrase=hiking+boots`), not the site root.

### Why each required item is missing

- **Cooking pot (all 3)**: 12a, 12c: never planned (chat list had "stove with gas canister" and
  no pot; 12c had a power bank instead). 12b: planned (#10 "cookware set / camping pot"),
  typed three times ("cookware set" in call 1; "σετ κατσαρολικό camping" in calls 2 and 3), never
  pressed Enter: TYPE/ESC cycle each time, then the chat agent stopped.
- **Rain jacket 12a**: searched, listing reached; product page size modal: "Επίλεξε μέγεθος" /
  "Close modal" cycle (call 1); retry in call 2: clicked sizes, closed the modal, DONE at 0.58
  with no add (false DONE); the chat agent's cart check said "only water missing" and never retried.
- **Rain jacket 12b**: planned; TYPE/ESC cycle in all 3 calls (never reached results).
- **First aid 12b**: planned; TYPE/ESC cycle in all 3 calls.
- **First aid 12c**: call 1 false DONE on a car first-aid kit (add button visible, DONE 0.95);
  call 2: same product, DONE 0.86 again; call 3 started on `/cart`, TYPE/ESC cycle, 0/5.
  Here the chat agent read the cart after call 1 and listed the gaps correctly.
- **Sleeping mat 12b**: false DONE after opening a product (0.75). Call 2 prompt said
  "already in cart: … sleeping mat …" (statuses trusted, cart not read); never retried.
- Nice-to-have: poles lost to false DONE in 12a (twice) and 12b; fuel canister 12b
  (stove sub-goal covered the stove only), 12c (call 3 TYPE/ESC cycle); repellent and sunscreen were
  never planned in any run.

### Ranking of remaining losses (items lost across the 3 runs, 30 oracle slots)

1. **Never planned by the chat agent: 8 items** (pot 2, repellent 3, sunscreen 3; 2 required).
   Not a browse-loop problem; the list differs run to run.
2. **False DONE never recovered: 5 items** (required: 12a jacket, 12b mat, 12c first aid;
   nice: poles 12a, poles 12b). 14 false DONEs in total, 9 of them recovered later at the price of
   a repeat call.
3. **TYPE_TEXT / PRESS_ESCAPE cascade (no reset): 4 items** (12b pot, first aid, jacket;
   12c fuel canister) and 79 + 28 wasted requests.
4. Size-selector modal: 1 item (12a jacket, with 2).

### Recommendations (universal, removal first)

1. **DONE needs evidence of effect.** When the sub-goal's "Done when" states a state change
   (added, submitted, appears in), refuse DONE (take the runner-up) unless a step in this
   sub-goal carries an effect annotation; the frontend already computes these for the
   auto-confirm. 14/14 false DONEs would be refused; 1 of 15 true adds (12a boots) had no label, and
   the cost is one more click. Also fixes the retry trust problem: "done" would then mean
   "effect seen".
2. **Reset unconditionally and simply.** Open the site ORIGIN root at the start of every sub-goal
   that needs text entry, including sub-goal 1 of a repeat call. Drop the three conditions
   (`isQuotedSearch` on both sub-goals, `lastUrl != siteUrl`, "a quoted phrase") and the
   scroll-to-top / "no text field" recovery that it makes redundant. Would have removed the
   12b cascade and the 12c call-3 dead start.
3. **Delete the Luna DONE ≥ 0.3 rule** (and the margin/peak machinery around DONE) once 1
   lands: 0 firings, peak does not discriminate. Keep the cycle stop and the click→type gate.

Not recommended now: a consecutive-scroll cap (would save ~90 requests but recovered no
required item in these runs); item-list completeness belongs to the chat agent, so measure it
separately in the bench ("planned-but-failed" vs "never planned") before changing any prompt.

## 6e. Runs 13a–13c (reset simplified, Luna peak removed)

Shipped before: (a) the Luna DONE peak ≥ 0.3 gate is gone (it fired 0 times in 12a–12c);
(b) the sub-goal-start reset is simpler: any same-site sub-goal with index > 0 that is a
quoted search (search / look up / поиск / ищи / искать with double or word-edge single quotes,
or find / найди / найти with double quotes) reopens the site url if the page is elsewhere. It no
longer needs the previous sub-goal to be a search. Label: `OPEN … (sub-goal start: new search)`.
Kept: cycle stop (`cycle — `), click-empty-field-typed gate. Same chat model, same site, same
oracle. Data: `results/skroutz-hiking-13a|13b|13c`. Three single runs: a hint, not a statistic.
The chat agent planned 8 items in 13a, 12 in 13b, 12 + 2 in 13c.

| | 13a | 13b | 13c | 13 avg | 12 avg (12a/b/c) |
|---|---|---|---|---|---|
| Judge | partial | partial | partial | | partial x3 |
| Required (first 10) ok | 8/10 | 6/10 | 10/10 | 8.0 | 7.3 (8/6/8) |
| Nice-to-have (4) ok | 0/4 | 1/4 | 1/4 | 0.67 | 0.67 |
| Total ok / 14 | 8 | 7 | 11 | 8.7 | 8.0 (9/6/9) |
| Extras / duplicates | 0 / 0 | 4 / 0 | 1 / 0 | 1.7 / 0 | 1.7 / 0 |
| Cart items / total | 8 / 406.36 € | 11 / 815.30 € | 12 / 678.49 € | | |
| Wall (browse / chat) | 393 s (240 / 141) | 350 s (298 / 52) | 424 s (291 / 119) | 389 s | 420 s |
| Step requests | 157 | 190 | 176 | 174 | 203 |
| browse_task calls / manual acts | 3 / 12 | 3 / 2 | 3 / 7 | | 3 / 4 |
| Chat requests | 21 | 7 | 14 | 14 | 12 |
| Sub-goals done | 12/16 | 17/25 | 15/19 | 44/60 = 73 % | 47/73 = 64 % |
| Cycle stops | 1 | 4 | 2 | 2.3 | 7.3 (3/13/6) |
| "No progress" stops (3 no-effect steps) | 2 | 3 | 0 | 1.7 | not counted |
| Budget stops (25 requests) | 1 | 1 | 2 | | |
| Resets fired | 11 | 19 | 14 | 14.7 | 11 (15/0/18) |
| click-empty-field-typed / refocus-type | 1 / 0 | 6 / 4 | 0 / 1 | | 1 / n.a. |
| DONE with peak < 0.3 | 0 | 0 | 0 | | 0 |
| False DONE (no add effect label) | 5 | 6 | 5 (3 genuine) | 5.3 (4.7) | 4.7 (5/3/6) |
| Add-type DONE total | 11 | 17 | 14 | | |
| Requests in stalled / budget / cycle sub-goals | 56 (36 %) | 90 (47 %) | 72 (41 %) | 42 % | n.a. |
| Same + false-DONE sub-goals ("went nowhere", est.) | 91 (58 %) | 122 (64 %) | 89 (51 %) | 58 % | ~49 % (62/116/121 by the 6d count) |

"False DONE" = DONE (or sub-goal `done`) in an add-to-cart sub-goal with no `effect:` / `became`
label on any step of the sub-goal. 13c has two more such cases that were real adds without a label
(boots, jacket: a size-modal then plain "Προσθήκη"), so 5 strict, 3 genuine (bag, poles,
sunscreen). The "went nowhere" row is my count (sub-goals that ended stalled, budget, cycle,
or false DONE) and may differ slightly from the 6d estimate method. 12 of the 16 false DONEs in 13 happened in a sub-goal with no add click at all (DONE on a product or listing page).

### Result: better on items, not on waste

- Items: required 8.0 vs 7.3, total 8.7 vs 8.0, and 13c is the first run with 10/10 required.
  Spread is wide (13b 6/10), so do not read this as a trend.
- Cycles dropped from 22 to 7. The 12b TYPE_TEXT / PRESS_ESCAPE cascade is gone: in 13b all 19
  resets led to TYPE_TEXT and 19 searches reached results. That is the effect of change (b):
  12b had 0 resets, because its planner wrote "Find a suitable …".
- Waste did not drop: ~58 % of requests sit in sub-goals that went nowhere (6d: ~49 %). The loops
  changed shape: scroll-only runs on a category page, a click on a listing tile that does nothing,
  and cart-read sub-goals.
- False DONE is unchanged (5.3 strict per run vs 4.7). It is still the largest single cause.

### Did the reset ever hurt? No (0 of 44)

Every reset (13a 11, 13b 19, 13c 14) was followed on the home page or `/cart` by TYPE_TEXT
(or by click-empty-field-typed, which then typed). No sub-goal needed the page that the reset
removed: each reset sub-goal begins with its own search phrase, and the cart persisted across OPEN.
13 resets went to `/cart` (the "site url" of a repeat-call goal, hole (c) of 6d); all 13 typed fine.
Not fixed, still open: sub-goal 1 of a repeat call has no reset (`i > 0`). Seen 2 times:
13a call 2 SG1 (BLOCKED + 5 scrolls on `/cart`, 7 requests before the first TYPE_TEXT; still
succeeded) and 13b call 2 SG1 (3 × PRESS_ESCAPE on a product page, stalled, water bottle lost one
attempt). Unquoted "Search for freeze-dried …" (13b SG12) got no reset and still worked, from a
product page.

### Change checks

- Luna peak removed: no effect. Lowest DONE peak 0.50 (13a first aid: false). False DONE peaks 0.50–0.98;
  true 0.52–1.00. Peak does not separate them, as predicted in 6d.
- click-empty-field-typed: 7 firings (13a 1, 13b 6), 7/7 next step TYPE_TEXT, 5 reached results by Enter and 2 by
  the "Αναζήτηση" button. refocus-type fired 5 times (13b 4 inside a loop, 13c 1).
- Cycle stop: 7 stops, no false positive. Cart-read sub-goals produced 4 of 7 (13a call 2, 13b
  calls 2 and 3, 13c call 2). New: 5 "no progress" stops (3 no-effect steps), 3 of them on a
  product tile that does nothing when clicked (13a mat, 13b first aid, 13b sunscreen).
- New failure: 13a call 3. The planner wrote the sub-goal search phrases as runs of combining
  marks (U+0313…U+0339, ascending code points, degenerate output). The step model typed them
  verbatim: 32 requests, 27 TYPE_TEXT of garbage, 0/2 done. The call-3 goal itself was correct Greek.

### Why each required item is missing

- **13a pot, rain jacket**: never planned (the chat agent chose 8 items, including both a stove and a
  first aid kit but no cookware and no jacket). The 4 nice-to-have items were also never planned.
  The 5 false DONEs (bag, stove, first aid in call 1; mat, first aid in call 2) were all repaired,
  at the price of 2 repeat calls and 8 manual acts (141 s of chat time).
- **13b sleeping mat**: false DONE (Intex double mattress, DONE on the product page, no add click). The call-2
  prompt listed "camping mattress" as already added. Never retried. The final reply does not mention the mat.
- **13b cooking pot**: false DONE (SK21 set, DONE with no add click). Call 2 prompt: "cookset" already added.
  The final reply admits it ("add did not commit").
- **13b rain jacket**: add button clicked once (no effect label, probably a size is required), DONE.
  Call 2 prompt: "rain jacket" already added. Final reply: "unverified".
- **13b water bottle**: three calls. Call 1: after the search it clicked the category chip "Παγούρια (2.759)" and scrolled
  16 times without a click (stalled); call 2: 3 × PRESS_ESCAPE on the previous product page (no reset
  for sub-goal 1); call 3: the same category page, 16 more scrolls. The chat agent gave up
  after "second and final retry".
- **13c** has no required item missing. Missing nice-to-have: fuel canister (search results contain only stoves
  and lamps; scroll cycle in call 2, after a 25-request budget in call 1), poles (false DONE: add
  clicked, no effect label, not in the cart), sunscreen (false DONE: DONE on the product page, no click).
- Other nice-to-have: 13b poles (false DONE), 13b sunscreen (call 2: tile click did nothing x3; call 3: false DONE),
  13b fuel (never planned: stove only), 13a all four (never planned).

### 13c: the reply does not match the cart

The cart (end-state text, header "12"): tent 31.90, bag 84.00, mat 14.40, backpack 40.00, headlamp
18.18, boots 59.90, jacket 271.40, stove 47.00, pot 9.40, bottle 49.95, first aid 15.00, repellent 7.36
= 648.49 € of goods, + 30.00 delivery = 678.49 €. Poles are not in it: the 31.50 € item sits in the
"recently viewed" block.

- The reply table has 12 numbered rows + 1 unnumbered repellent row = 13 rows. Row 6 is the trekking
  poles (Escape Trailblaze, 31.50 €). The rows sum to 679.99 €; the reply states "12 позиций",
  648.49 € and 678.49 € (the page totals). So the title count and the totals are the cart's, the table is not.
- The reply contradicts itself: a note under the table says the poles show up only in "recently viewed" and may
  be missing, and it asks the user to add them again.
- Every other name and price in the table matches the cart line for line (names translated and shortened; first aid
  15.00 € is correct). The reply is right that sunscreen and the gas canister are missing.
- Cause: the chat agent copied the planned list (poles had status `done`) and then patched the table with the
  cart text instead of rebuilding the table from the cart text. The judge flagged it
  (`reply_matches_end_state: false`); its own note also wrongly says "sunscreen is not in the end state either" as if
  that was a contradiction.

### Ranking of remaining losses (16 oracle slots lost in 3 runs, 42 slots)

1. **False DONE never recovered: 7 items** (3 required: 13b mat, pot, jacket; nice: 13b poles, 13b sunscreen, 13c poles,
   13c sunscreen). In 13b the chat agent trusted `done` and wrote the false-DONE items into the
   "already added" list of the next call.
2. **Never planned: 7 items** (2 required: 13a pot, jacket; nice: 13a ×4, 13b fuel).
3. **Search loop (no click, or tile that does nothing): 2 items** (1 required: 13b bottle; nice: 13c fuel).
   Smaller: garbled planner phrases (13a) cost 32 requests and 0 items, because the manual acts had already
   repaired the cart.

Waste sinks: cart-read sub-goals (38 requests in 4 stalled sub-goals + 12 in one done), 13b water-tablet
extra (25 requests, a non-required item the chat agent invented), scroll-only runs (13b bottle 2 × 16, 13c bottle 11 +
canister 14).

### Recommendations (universal, removal first)

1. **Make `done` mean "effect seen" without blocking DONE.** When the sub-goal asks for an add / submit / save
   and no step of that sub-goal carries an effect label, finish it with status `unverified` (or `done?`), not
   `done`. The chat agent then lists these sub-goals as still to do and retries them. No demotion, so
   the 6c failure (DONE demoted forever because the history window is 10 entries) cannot return: nothing is
   re-decided, only the reported status changes. If a hard gate is wanted anyway, bound it with a counter
   in the sub-goal state (not in history): demote the first 2 no-effect DONEs of a sub-goal, accept the third.
   Would have turned all 14 genuine false DONEs into a retry signal and prevented the 13b "already added" list.
2. **Delete the report / read-the-cart sub-goals from the plan** (planner rule: never plan a read or
   report step; the chat agent already reads the cart with `browse_read`). 4 of 7 cycle stops and ~50 requests (9 %)
   came from them.
3. **Drop `i > 0` from the reset condition** (any quoted-search sub-goal reopens the site url when the page is
   elsewhere, including sub-goal 1 of a repeat call). Removes a condition, fixes 13b call 2 SG1 and the 13a
   call 2 SG1 delay. Not recommended now: a scroll-run cap (13b bottle: the tiles did nothing after the cap
   either; no item saved) and a planner-garble guard (one event; watch for a repeat).

## 6f. Runs 13jev-a–c: same code as 13a–c, step model Jev (`jev-1.13.0`)

Set with `BENCH_TYPESAFE_MODEL=jev-latest` (bench `src/stack.ts` passes it as `TYPESAFE_MODEL`). Everything else as in §6e.

| Run | Required ok /10 | Total /14 | Wall | Step requests | Calls | Sub-goals done | Cycles | Resets |
|---|---|---|---|---|---|---|---|---|
| 13jev-a | 5 | 6 | 228 s | 57 | 2 | 11/12 | 0 | 11 |
| 13jev-b | 1 | 1 | 208 s | 98 | 2 | 13/14 | 0 | 11 |
| 13jev-c | 6 | 6 | 220 s | 94 | 2 | 12/15 | 0 | 12 |
| **Jev avg** | **4.0** | **4.3** | 219 s | 83 | 2 | | | |
| Luna avg (13a–c) | 8.0 | 8.7 | 389 s | 174 | 3 | | | |

- Jev is about 2x faster but loses about half the items.
- Jev reports `done` on almost every sub-goal (36 of 41) while the cart gets few items (13jev-b: 13 "done", 1 item in the cart). The chat agent trusts the statuses and makes only 2 calls instead of 3, so false DONEs are never retried.
- Jev never picked PRESS_ENTER and scrolled little; no cycle stops.
- Conclusion: the main gap between the models is false DONE, the same top cause as for Luna (§6e), only larger.

## 7. Open questions for idea generation

- When should the chat agent give up on an item the site does not have?
  (Run 9: 6 calls on a gas canister.) A per-item retry cap? A "not found" sub-goal status?
  Update (12b, 12c): the opposite case also exists. Three retries of the same sub-goal in the
  same dead state (TYPE/ESC) change nothing; a retry needs a changed starting state (§6d, reset).
- Why did items from call 1 disappear in run 8? (Run 9 shows no cart reset.)
- How to verify "item really in cart" cheaply and universally, without site rules?
  (E.g. read the cart page once at the end and diff against the plan?)
  Partly answered (§6d): the effect annotation on the clicked control separates true from
  false DONE in 14 of 14 false cases and 14 of 15 true adds, much better than the DONE
  peak (0.45–0.96 for false DONE). Not yet used to gate DONE.
  Update (§6e): 16 more false DONE (13a–13c); the label misses 2 real adds (13c boots, jacket: size modal
  then plain "Προσθήκη") and 12 of the 16 false cases have no add click at all. Proposal: report
  such sub-goals as `unverified` instead of blocking DONE (no history-window problem).
- How to choose a *relevant* product, not the first or cheapest result, without
  slowing the loop? (Planner gives criteria? A one-shot rank of the result list?)
- Should the chat agent re-call `browse_task` only for missing items, based on
  `subgoals[]` and a final cart read?
  Evidence (§6d): trusting `subgoals[]` fails (12b listed a false-DONE mat and poles as "already in
  cart"); a cart read helps only if read correctly (12c yes, 12a misread: "only water missing").
  Update (§6e): same again in 13b (mat, pot, jacket, poles in the "already added" list of call 2, never
  retried: 3 required items lost); and the reverse in 13c (right cart read, but the reply table kept a
  row for the poles that were only in "recently viewed"). Rebuilding the reply table from the cart text,
  not from the plan, is the open point.
- Is the planner + per-sub-goal loop the right shape, or would a simpler single loop
  with a running checklist work better?
- Which of the run-8 mechanisms add risk without proven value? Candidates to remove:
  start-of-sub-goal recovery (Escape/reopen), stall retry.
  Update (§6d): the "no text field" recovery pressed Escape and reopened the last listing
  url (not the root) in 12b; a plain root reset (33 uses, 33 working searches) is the
  better mechanism, so the older recovery is a removal candidate. Also a removal candidate:
  Luna DONE peak ≥ 0.3 (0 firings).
  Update (§6e): the Luna peak gate was removed (13a–13c: no effect, none of the 27 Jev DONE decisions was below 0.50);
  the reset was simplified and fired 44 times with 0 harm. New removal candidate: the planner's
  "report the cart" sub-goals (4 of 7 cycle stops, ~50 requests; the chat agent has `browse_read`).

## 8. Data

All under `bench/browse-task/results/skroutz-hiking-<N>/` (local, not in git):

- `run-ultrafast-livegoal-1.json` — `chats`, `steps` (per step request: `elementList`,
  `chosen`, `operation`, `reason`), `transcripts` (with `subgoals`), `finalText`.
  Text is mojibake; fix in Python: `s.encode('cp1252', errors='ignore').decode('utf8', errors='ignore')`.
- `backend-ultrafast.log` — `browse step decided` (tier, gate, op, latency),
  `browse plan produced` / `fell back`.
- `task-goals.txt` — full `browse_task` goals.
- `frames/` + `frames/frames.json` (`file`, `t` ms) — video frames.
- `summary.md` / `summary.json` — bench metrics.
- `cookies.log` (run 9+) — cart cookies and tab URLs, logged on change.
- Video of the latest run: `~/Movies/skroutz-agent/skroutz-hiking-cart.mp4`.

Commits (all on `main`):
- before run 8: backend `258cb0d`, frontend `72263399`, desktop `c2c7203`.
- before run 9: backend `3b6f003`, desktop `6dfac76`.
- run 9 video: `results/skroutz-hiking-9/skroutz-hiking-cart.mp4` (also copied to `~/Movies/skroutz-agent/`).
