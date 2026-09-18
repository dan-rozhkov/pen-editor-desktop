# `browse_task`: a Jev-driven browsing loop

Status: design, 2026-09-18. Builds on
`2026-09-18-builtin-browser-design.md`, which shipped the browser tab and the
three manual tools.

## Problem

`browse_open` / `browse_act` / `browse_find_images` put the agent in the
browser, but every step costs a full chat turn: the whole conversation is
re-sent, the expensive design model decides one click, and the loop repeats.
Ten steps is ten turns. For anything past a clean search URL — a login wall,
a cookie banner, a facet filter — that is slow and expensive enough that the
agent will simply not bother.

`github.com/browser-use/jev-ultrafast` (MIT) solves the same problem with a
cheap decision model in the loop: per cycle, **one** request predicts the
operation and its target together, with a separate decision head per
operation, against a structured element table rather than a screenshot.

We can do this without building the hard part, because our System One client
already is that primitive.

## Why our Jev client already fits

`src/services/systemone.ts`'s `evaluate({ state, questions })` takes a
**record of questions against one shared `state`** and returns answers keyed
the same way. That is the fan-out:

```ts
questions: {
  op:            { type: "choice", criteria: { CLICK: …, TYPE_TEXT: …, … } },
  target_click:  { type: "choice", criteria: { "3": …, "7": …, … } },
  target_type:   { type: "choice", criteria: { "5": …, … } },
  target_select: { type: "choice", criteria: { "9": …, … } },
}
```

One round trip; read the target head that matches the chosen `op`.

We also get something their repo does not have: `choice` answers carry
`probabilities` and `confidence`. A step below the confidence threshold
stops the loop with `BLOCKED` instead of clicking blindly.

Note their headline number — browser-protocol calls 1092 → 101 — is a fight
with CDP that we do not have. `WebContentsView.executeJavaScript` returns a
whole snapshot in one in-process call.

## Where the loop runs

`TYPESAFE_API_KEY` must never ship inside a packaged Electron app, so Jev
stays behind the backend. The page is in the desktop shell, so the snapshot
stays there. The loop therefore lives in the **frontend tool handler**, which
already reaches both:

```
browse_task handler (pen-editor)
  ├─ penDesktop.browser.snapshot()      → element table from the page
  ├─ POST /api/browse/step              → Jev picks (operation, target)
  ├─ penDesktop.browser.perform({…})    → apply it
  └─ repeat until DONE / BLOCKED / budget
```

One chat tool call = a whole multi-step task. The design model is not in the
loop at all.

Per step: one backend round trip plus one in-process `executeJavaScript`.
The backend hop is the cost we pay for not shipping the key; their loop is
local.

## 1. Desktop: snapshot + indexed perform

Two new commands on the existing `browser:command` channel. **No new IPC
channel**, so `test/ipcContract.test.ts`'s table is unchanged.

### `snapshot`

New `SNAPSHOT_JS` in `src/main/browser/pageScripts.ts`, a port of the
concepts in jev-ultrafast's `snapshot.js` (MIT — credit it in the file
header). Walks the document once and returns:

```ts
{
  url: string;
  title: string;
  elements: Array<{
    index: number;        // stable within this snapshot only
    tag: string;          // "button" | "a" | "input" | "select" | …
    role?: string;
    label: string;        // accessible name: aria-label, text, placeholder, alt
    value?: string;       // current value for inputs
    ops: Array<"CLICK" | "TYPE_TEXT" | "SELECT">;  // what this element accepts
    options?: string[];   // native <select> option labels, for SELECT
  }>;
  scroll: { y: number; height: number; atBottom: boolean };
}
```

Rules that matter:

- Only **visible, interactive** elements get an index: non-zero size, not
  `display:none`/`visibility:hidden`/`opacity:0`, inside the viewport-ish
  region (include a margin — infinite-scroll grids matter).
- `label` is capped at 120 chars and trimmed. An element with no usable
  label is still included if it is clearly interactive, labelled by its tag
  and position, because unlabelled icon buttons are exactly what cookie
  banners are made of.
- Hard cap `MAX_SNAPSHOT_ELEMENTS = 120`, nearest-to-viewport first. The
  element table is the whole request payload; an uncapped one on a big page
  is both slow and expensive.
- Password inputs are reported with `ops: ["TYPE_TEXT"]` but their `value`
  is **never** returned, and their label is the only thing that leaves the
  page. See "Credentials" below.

### `perform`

```ts
{ index: number, operation: "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN", text?: string }
```

Acts by index against the **same** snapshot the indices came from. The
controller stamps each snapshot with a `snapshotId` and rejects a `perform`
carrying a stale one — a page that re-rendered between snapshot and act
would otherwise silently act on the wrong element. This is the one place the
indexed design can go quietly wrong, so it is a hard error, not a warning.

Reuses the existing click-settle logic from phase 1.

## 2. Backend: `POST /api/browse/step`

Stateless. One Jev call in, one decision out.

**Request**
```ts
{
  goal: string;
  url: string;
  title: string;
  elements: SnapshotElement[];   // as above, already capped by the client
  history: Array<{ operation: string; label: string; ok: boolean }>;  // last 10
}
```

**Response**
```ts
{ operation: "CLICK"|"TYPE_TEXT"|"SELECT"|"SCROLL_UP"|"SCROLL_DOWN"|"WAIT"|"DONE"|"BLOCKED",
  index?: number, text?: string, confidence: number, model: string }
```

- `503` when `TYPESAFE_API_KEY` is unset — the feature is simply off, the
  same shape as the other key-gated features.
- Request body is capped and validated with zod; `elements` is re-capped
  server-side at `MAX_SNAPSHOT_ELEMENTS` regardless of what the client sent.
- **PII:** `goal`, every `label`/`value`, `url` and `title` pass through
  `scrubPii` before they reach Jev, exactly as `skillRouting.ts` already
  does — Jev is a third-party vendor receiving user text, and here it also
  receives arbitrary page content.
- Per-request timeout `BROWSE_STEP_TIMEOUT_MS = 4_000`. This is not the
  1.5s TTFT budget of skill routing — nothing is streaming behind it — but
  it must stay far below the frontend's per-step budget.
- Only the target head matching the chosen operation is read. An answer
  whose `type` is not `"choice"` fails open to `BLOCKED`, mirroring
  `skillRouting.ts`'s defensive check.
- Below `MIN_STEP_CONFIDENCE = 0.55`, the operation is replaced with
  `BLOCKED` and the reason reported. Guessing on a logged-in page is worse
  than stopping.

**`TYPE_TEXT` text** comes from a second, small call to `STRUCTURED_MODEL`
(one short generation, only on `TYPE_TEXT` steps), given the goal and the
field's label. Jev picks the field; the small model writes the value. This
mirrors jev-ultrafast, which uses a small model for exactly this and nothing
else.

**Credentials:** the route refuses to generate text for a field whose
snapshot entry is a password input, returning `BLOCKED` with a reason. The
agent must never type into a password field — the user logs in themselves,
in the visible browser tab. This is a hard rule, not a heuristic threshold.

## 3. Frontend: the `browse_task` tool

```
browse_task({ goal: string, maxSteps?: number })
```

`maxSteps` default 12, hard cap 25. Also bounded by
`BROWSE_TASK_DEADLINE_MS = 90_000` overall, which must stay under the tool's
own call timeout.

The handler loops snapshot → step → perform, keeping a short history, and
returns a transcript:

```json
{ "status": "done" | "blocked" | "budget",
  "steps": [{ "operation": "CLICK", "label": "Accept all", "ok": true }],
  "url": "…", "title": "…", "reason": "…" }
```

It is registered in `UNSERIALIZED_TOOL_NAMES` alongside the other `browse_*`
tools — it holds its connection far longer than any of them, so serializing
it behind the scene-mutation queue would be the worst case of the head-of-
line stall phase 1 already fixed.

Backend schema: a fourth entry in `penTools`, client-executed, gated by the
same `clientCapabilities.desktopBrowser` flag as the other three. The
snapshot/perform commands stay off `penTools` entirely — they are loop
internals, reachable only through the preload, never offered to the model.

## 4. Testing

**Desktop** — `SNAPSHOT_JS` against real DOM in `e2e/browser-tab.spec.ts`:
visibility filtering, the element cap, labels from `aria-label`/text/
`placeholder`/`alt`, `ops` per element type, password `value` never
returned, and `perform` rejecting a stale `snapshotId`. Controller-level
unit tests for argument validation as in phase 1.

**Backend** — `evaluate` mocked: the fan-out question set is built
correctly, only the matching target head is read, a non-`choice` answer
fails open to `BLOCKED`, sub-threshold confidence becomes `BLOCKED`, a
password-input target is refused, `scrubPii` is applied to goal/labels/url,
and the route 503s without a key.

**Frontend** — the loop against a stubbed preload and a stubbed
`/api/browse/step`: terminates on `DONE`, on `BLOCKED`, on `maxSteps`, and
on the deadline; a failing step is recorded and does not abort the whole
task; the transcript shape is stable.

## 5. Merge order

Desktop → backend → frontend, as in phase 1, for the same reason: the
frontend closes the contract and its `contract` CI job checks out the
backend's `main` at run time.

## 6. Deliberately out of scope

- Typing into password fields, ever.
- Persisting a snapshot across steps as a "page model". Each cycle takes a
  fresh snapshot; that is what makes the indexed design safe.
- Screenshots in the loop. Jev consumes structured state; adding an image
  would give up the whole speed argument.
- Their `WAIT` tuning constants (200ms combobox / 50ms animation). We start
  with one settle strategy and only split it if a real site forces it.

---

## Addendum, 2026-09-18: contract corrections after review

Review of the first implementation found that three of the eight operations
could never reach the page, and that the element table shipped more than it
should. These supersede the corresponding text above.

### A. `perform` argument rules

`index` is required **only** for `CLICK`, `TYPE_TEXT` and `SELECT`.
`SCROLL_UP` and `SCROLL_DOWN` take no `index` and must be accepted without
one. Scrolling is the advertised mechanism for infinite-scroll grids; with
an index requirement it always failed at the bridge.

`WAIT` is never sent to `perform`. The loop handles it itself by sleeping
~400 ms and taking a fresh snapshot.

`SELECT` must carry `text`, and `text` must be one of that element's
`options`. The backend picks it with the small model constrained to those
options.

### B. Terminal vs transient outcomes

The step response gains an explicit `outcome`:

- `"act"` — apply `operation` (+ `index`/`text`).
- `"done"` — the goal is met. Terminal.
- `"blocked"` — a deliberate refusal: confidence below threshold, or a
  password field. Terminal.
- `"retry"` — transient: Jev timed out, answered malformed, or no candidate
  element supported the chosen operation. The loop records the step and
  continues.

Collapsing transient failures into `blocked` meant one 4-second Jev blip
killed an entire task, while a plain HTTP error did not — backwards.

### C. Confidence applies to both heads

`MIN_STEP_CONFIDENCE` is checked against the **operation** choice and the
**target** choice. An op at 0.92 whose target is 0.15 across 40 candidates
is a near-arbitrary click on a logged-in page, which is exactly what the
threshold exists to prevent.

### D. What a snapshot may report as `value`

Only for a non-password `input[type=text]`, `input[type=search]` or
`textarea`, truncated to 100 characters, and only when the element's
`autocomplete` is not one of the sensitive tokens (`cc-*`,
`one-time-code`, `current-password`, `new-password`). Every other element
reports `hasValue: true|false` instead of the content.

The previous rule guarded `type=password` alone, so an autofilled card
number in a `type=text` field, an email or a phone number left the page in
the element table. "Is this field already filled?" is the only signal the
model needs here; the contents are not.

`value` is truncated and `options` capped at 100 **in the page script**, so
the payload is valid by construction. The route truncates defensively
rather than rejecting — a country dropdown must not 400 the whole request.

### E. Element indices are validated, not coerced

The chosen target must be looked up as a member of the criteria keys the
question was built from. `Number("")` is `0`, so coercion silently mapped a
blank answer onto element 0.

### F. Load, not commit

The post-click settle waits for the document to finish loading, not merely
for the URL to change. Returning at navigation commit left the next
`browse_find_images` measuring an unlaid-out document, where every
`getBoundingClientRect()` is 0×0 and the size filter drops every image.

---

## Follow-ups from the first live run, 2026-09-18

Findings from driving the real shell against a live Pinterest search
(`?q=fintech onboarding ui`) through the real preload bridge — not a
fixture. Both are quality limits the hermetic suites cannot see, because
the fixtures are pages we wrote ourselves.

What did hold up: `browse_open`/`snapshot`/`findImages`/`scroll` all worked,
45 elements came back with a `snapshotId`, image URLs were all http(s), and
the credentials rule fired correctly on a real login wall — the password
input arrived as `isPassword: true, hasValue: false` with no `value`, while
the search combobox correctly reported `value: "fintech onboarding ui"`.

### BROWSE-01 — `find_images` returns 236px thumbnails

The live run's URLs were all `https://i.pinimg.com/236x/…`, rendered at
267×648 and smaller. That is a contact sheet, not a reference: dropped onto
the canvas as an `imageFill`, a 236px-wide asset is unusable for anything
but a thumbnail grid.

§6 of this design says "Deliberately out of scope: rewriting image URLs to
higher resolutions per site. Site-specific and rots." That reasoning still
holds in general, but it was written before anyone had looked at what the
tool actually returns, and the answer is "the smallest variant the page
happens to render". Worth reopening with the evidence now in hand.

Shape of a fix, in preference order:

1. Prefer what the page already declares: `srcset`/`currentSrc` carry the
   larger candidates for exactly this reason, and reading them is generic,
   not site-specific. `FIND_IMAGES_JS` currently reads `currentSrc || src`
   and ignores `srcset` entirely — the biggest win is also the most
   portable one.
2. Report the intrinsic size (`naturalWidth`/`naturalHeight`) alongside the
   rendered box, so a consumer can tell a small asset from a small
   *rendering* of a large one. Today both look identical.
3. Only if 1 and 2 fall short: a narrow, clearly-labelled per-host upgrade
   map. This is the part that rots, so it should be last and small.

### BROWSE-02 — half the snapshot's elements have no usable label

The same run returned a run of `div role="button"` entries labelled
`"div #3"`, `"div #8"`, `"div #10"` — the tag-and-position fallback. That
fallback exists so unlabelled icon buttons (cookie banners) stay
selectable, and that part is right. But `"div #8"` tells the decision model
nothing, so any step whose target is one of those is a coin flip, and
`MIN_STEP_CONFIDENCE` will (correctly) block it — which means those
controls are simply unreachable by `browse_task`.

`labelOf` currently reads `aria-label` → own text → `placeholder` → `alt`.
It should also consider, before falling back:

- `aria-labelledby` (resolve the referenced element's text)
- `title`
- an `aria-label`/`title`/`alt` on a **descendant** — an icon button is
  usually `<div role=button><svg aria-label="Save"></svg></div>`, and the
  label is one level down
- the nearest enclosing `<a>`/`<button>`'s accessible name
- for an image-only control, the descendant `<img alt>`

Only after all of those should the `tag #index` fallback apply.

Both were found by a throwaway Playwright script driving the packaged shell
against the live site; the cheapest way to check a fix is to re-run that
same shape against the same query and compare.
