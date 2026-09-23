# Full browser use for the design agent

Status: design, 2026-09-23. Builds on `2026-09-18-builtin-browser-design.md`
and `2026-09-18-browse-task-jev-loop-design.md` (with both addenda).

## Problem

The agent can open a page, click/type/scroll by selector-or-text, read text,
read images, and hand a whole goal to the Jev loop (`browse_task`). What a
"browser use" agent normally has and ours does not:

1. **It cannot see the page.** No pixels at all — a layout, a modal it
   can't find, a canvas-rendered widget are invisible.
2. **The main model cannot drive by index.** The indexed element table
   (`snapshot`/`perform`) exists but only Jev gets it; the main model guesses
   selectors or visible text.
3. **No keyboard, hover, select, reload, wait.** Enter-to-submit, Escape to
   close a modal, arrow keys in a combobox, hover menus, `<select>` — none
   reachable from the main model.
4. **One tab only.** Popups open a new tab, but the agent cannot list,
   switch or close tabs, and a click that opened a tab doesn't say so
   (upstream jev-ultrafast #61: the agent sticks to the old tab).
5. **A JS dialog hangs everything.** `alert()`/`confirm()` blocks the
   renderer, and every later `executeJavaScript` waits forever (until the
   command timeout), on every command.

## Contract

### Desktop bridge (`window.penDesktop.browser`, preload → `browser:command`)

Existing: `open`, `act`, `findImages`, `snapshot`, `perform`, `read`.
New commands on the **same** channel (no new IPC channel):

- `screenshot(args?: { annotate?: boolean })` →
  `{ imageData: "data:image/jpeg;base64,…", width, height, url, title,
     snapshotId?, elements? }` | `{ error }`.
  Viewport capture (`webContents.capturePage()`, default `stayHidden:false`
  so a hidden view still paints), downscaled to ≤1280 px wide, JPEG q≈70.
  `annotate: true` first takes a fresh snapshot (becoming the current
  `snapshotId` for `perform`/`act`), overlays a numbered label on every
  snapshot element (`data-pen-marks` container, removed in `finally`),
  captures, and returns `snapshotId` + `elements` alongside the image
  (set-of-marks). An empty capture is an error, not a blank image. The
  `data-pen-marks` overlay only ever exists for this single, synchronous
  capture and is always removed in `finally`, so it never coexists with a
  before/after evidence-of-effect signature capture — `SIGNATURE_JS`
  measures text via plain `document.body.innerText` rather than a
  mark-aware per-element walk (review finding 10; a prior pass had added
  such a walk to solve an overlap that can't actually occur, duplicating
  `browse_read`'s own text-collection logic in the process). Locating an
  element by `snapshotId`+`index` (`FOCUS_JS`/`HOVER_TARGET_JS`) compares
  the `data-pen-snap` attribute by string equality against every candidate
  rather than embedding the id into a `querySelector` string, so a
  `snapshotId` containing a selector metacharacter can't be interpreted as
  selector syntax (review finding 5).
- `tabs(args: { action: "list" | "switch" | "close" | "new", tabId?, url? })` →
  `{ tabs: [{ tabId, url, title, current }], current: tabId | null }` | `{ error }`.
  `switch` makes that tab the agent's current tab and activates it in the
  strip; `close` closes a *browser* tab only; `new` opens a browser tab and
  makes it current, then — when `url` is given — loads it via the same
  `open()` path (DOM-ready-plus-grace-period, not a full `did-finish-load`
  wait; review finding 9) rather than `newPage()` itself awaiting a full
  page load. On a load failure the tab still exists, so the error is
  reported alongside the fresh tab listing, not in place of it — the agent
  can see the new tab instead of retrying `new` into a duplicate.

`act` gains actions and index targeting:

| action | fields | implementation |
|---|---|---|
| click / type | `target` **or** `index`+`snapshotId` (+`text`) | index → existing `perform` CLICK/TYPE_TEXT path |
| select | `index`+`snapshotId`, `text` = option label/value | `perform` SELECT |
| press | `key` (`"Enter"`, `"Escape"`, `"Tab"`, `"ArrowDown"`, `"Meta+a"`…), optional `target`/`index` to focus first | CDP `Input.dispatchKeyEvent` (trusted; no window focus needed, unlike `sendInputEvent`) |
| hover | `target` or `index`+`snapshotId` | element centre via script → CDP `Input.dispatchMouseEvent` `mouseMoved` |
| reload | — | `reload()` + wait for load stop |
| wait | `text?`, `ms?` (default 3000, cap 15000) | poll `document.body.innerText` for `text`; without `text` just sleep. Returns `{ found }` |

An `index`+`snapshotId` given to `press` (to focus first) or `hover` goes
through the same staleness/cross-tab `snapshotId` check `perform` applies
(review finding 5) — a stale or wrong-tab snapshot is a clear error, not an
in-page "no element" lookup miss. A `press` given an explicit
`target`/`index` to focus that the page script doesn't find is also a hard
error — the key is never sent to whatever already has focus instead (review
finding 5). `key` parsing (`browser/keys.ts`) uses a real US-layout
punctuation table, not the character's own ASCII code point (review finding
1, which used to collide with unrelated real keys — `.`'s ASCII value is
Delete's own virtual-key code); `Shift`+letter/digit/punctuation resolves to
the actual shifted text a keyboard would produce, and a `Meta`/`Ctrl` combo
in a small fixed list (`a`/`c`/`x`/`v`/`z`/`Shift+z`/`y`) is dispatched with
CDP's `commands` field and no `text`, since Chromium doesn't run its native
editing-command table off a synthesized modified keydown the way it would a
genuine OS shortcut (review finding 2). `hover` locates (and scrolls to) its
target *before* capturing its before-signature, not after, so a target that
needed scrolling into view doesn't get misreported as "changed" by the
resulting `scrollY` shift (review finding 8).

Every click-type result (act click, perform CLICK, press) may carry
`openedTab: { tabId, url, title }` when a browser tab appeared during the
action — the agent's current tab has already followed it, but only when the
tab that opened it was the one the agent was already driving (review
finding 7 — see "Agent's current tab" below).

Every command result may carry `dialogs: [{ tabId, type, message }]` — JS
dialogs auto-handled, from any open browser tab, since the previous command
(review finding 6). Dialogs are only ever auto-handled while an agent
command is actually running (review finding 3 — see "Dialog policy" below).

### Dialog policy (desktop)

Each browser tab gets its `webContents.debugger` attached once at creation
(`Page.enable`). On `Page.javascriptDialogOpening`: `alert` → accept,
`confirm`/`prompt` → dismiss (never agree to something on the user's
behalf), `beforeunload` → accept — **but only while an agent browser
command is actually in flight** (review finding 3). `window.ts` keeps a
plain counter (`browserCommandsInFlight`) incremented/decremented around
every `browser:command` dispatch; outside that window, a dialog is left
alone entirely — not accepted/dismissed, not queued — for the user to see
and answer themselves, the same as in any other browser. Only a dialog the
agent actually auto-handled is queued (capped at 10 per tab, oldest
dropped), and draining happens across *every* open browser page, not just
the one a command happens to act on (review finding 6) — each drained
dialog is tagged `{ tabId, type, message }` so the agent knows which tab it
came from. The same debugger session carries `Input.*` for press/hover.
Attach failure (DevTools already attached) degrades: press/hover return an
error, dialogs are not handled — everything else works.

### Agent's current tab (desktop)

`TabManager` tracks `agentBrowserTabId`. `browserHandle()` prefers it while
it is a live browser tab, else falls back to today's rule. A popup opened
from the browser tab the agent is *currently* driving sets it to the new
tab (fixes #61); a popup from any other browser tab still opens (and still
becomes the active tab in the strip) but does not repoint the agent (review
finding 7 — a tab the user has open on the side must not be able to steal
the agent from whatever it's doing). `tabs switch/new` set it explicitly.
User-initiated activation of a browser tab (a tab-strip click) also sets it
— the agent follows the user's focus (review finding 4) — but a tab's own
*automatic* activation (a fresh tab, or a popup's own activation) does not,
which is what keeps finding 7's non-agent-popup case from repointing the
agent the moment it becomes visibly active in the strip.

### Backend (`pen-editor-backend`)

New `penTools` (no `execute`): `browse_snapshot`, `browse_screenshot`,
`browse_tabs`; `browse_act` schema widened to the table above. All three
join the `clientCapabilities.desktopBrowser` gate; `browse_screenshot` also
joins `get_screenshot`'s vision gate. `browse_screenshot` gets a
`toModelOutput` like `get_screenshot`'s (text part with the JSON minus
`imageData` + an `image-data` part); `vision-messages.ts`' two
`=== "get_screenshot"` checks become a `SCREENSHOT_TOOL_NAMES` set.
`src/skills/research.md` documents the loop: snapshot (or annotated
screenshot) → act by index → check `changed` / screenshot again.

### Frontend (`pen-editor`)

Thin forwarders `browseSnapshot`, `browseScreenshot`, `browseTabs` over
`callBrowserBridge`; `PenDesktopApi.browser` gets `screenshot`/`tabs`;
all seven name lists (registry, contract test, icons, display names,
`UNSERIALIZED_TOOL_NAMES`, timeout override where needed).

Merge order: backend → frontend. Desktop is independent: an old desktop
lacks `screenshot`/`tabs`, and the frontend's `callBrowserBridge` already
reports a missing bridge method as unavailable.

## Out of scope

File upload/download, drag-and-drop, iframes' inner DOM, a browser for the
web (non-desktop) build.

## Second-pass review findings

A follow-up review of the implementation above found ten more real defects.
Final behavior (see CLAUDE.md's "Full browser use" section, same heading,
for the fuller writeup):

- **Dialog policy**: a dialog that opens *between* commands (no agent
  command in flight at the moment it opens — a page's own `load`-handler
  `alert()`, a `setTimeout`-delayed one) is no longer left open forever.
  Each browser tab now tracks its own currently-open dialog
  (`TabViewHandle.applyDialogPolicy()`), and `window.ts`'s
  `onBrowserCommand` applies the policy to every browser tab's tracked-open
  dialog before dispatching each new command — so it gets resolved (and
  queued for reporting) the moment the agent's next command starts, instead
  of hanging that command's own `executeJavaScript` call. The "dialogs
  raised while the agent is idle are left for the user" policy itself is
  unchanged.
- **Agent-tab pinning**: `TabManager.currentBrowserTabId()` is now pinned
  into `agentBrowserTabId` by `ensurePage()` even when it hands back an
  *existing* tab (not only a freshly created one), and by the popup
  callback (for the agent's *pre-popup* tab) whenever the popup's opener
  isn't the tab the agent is driving — both close the gap where a `null`
  `agentBrowserTabId` let `browserHandle()`'s active-tab fallback silently
  follow an unrelated popup.
- User-driven `nextTab`/`prevTab` (Ctrl+Tab/Ctrl+Shift+Tab) and the menu's
  "New Browser Tab" now also repoint `agentBrowserTabId` when they land
  on/create a browser tab, same as `activate()` already did for a tab-strip
  click. Automatic activations are unaffected.
- `HOVER_TARGET_JS`/`FOCUS_JS` scroll with `behavior: "instant"` (via a new
  shared `LOCATE_TARGET_JS` helper) so a page with
  `html { scroll-behavior: smooth }` doesn't leave the very next
  `getBoundingClientRect()` read racing an in-progress animated scroll.
- `parseKeySpec` can now parse `"+"`/`"Ctrl++"` (a trailing `"+"` used to be
  lost to the naive `.split("+")` filtering), a `"Plus"` named alias, and a
  literal single-space spec (`" "`) resolving to `Space`.
- `tabs({action:"new", url})`'s nested `open()` call: the outer command's
  timeout budget now includes a margin over the inner `open()` call's own
  budget, so the inner (more informative) timeout always fires first; and
  `mergeDialogs` no longer overwrites dialogs the nested call already
  merged in.
- `screenshot({annotate:true})` checks `MARKS_JS`'s own result before
  capturing (an error there is now a reported failure, with marks cleaned
  up), and waits for an in-page double-`requestAnimationFrame` paint
  (bounded, best-effort) between marking and capturing.
- `BrowserController` commands are now serialized through a FIFO queue
  (`runExclusive`), so concurrent tool calls from the frontend can no
  longer interleave. Internal command-to-command calls (`act` → `perform`,
  `tabs` → `open`) go through unlocked implementations to avoid
  deadlocking on the queue.
- `act`'s `wait` with `text` now always polls at least once, even when `ms`
  is 0 or otherwise already past its deadline by the time the loop first
  checks.
- `BrowserTabInfo` is declared once (in `tabManager.ts`, re-exported from
  `controller.ts`); `PERFORM_JS` reuses the same `FIND_BY_SNAPSHOT_JS`
  lookup `FOCUS_JS`/`HOVER_TARGET_JS` use instead of an independent inline
  selector; `window.ts`'s `selectPage` no longer calls
  `setAgentBrowserTabId` redundantly right after `activate()`.

## Third-pass review findings

- The address row drives the *visible* browser tab
  (`TabManager.activeBrowserHandle()`), never the agent's pinned one.
- The pre-command dialog sweep (second-pass item 1) is limited to the
  agent's current tab — dialogs in tabs the user browses by hand are never
  answered on their behalf.
- A timed-out command's abandoned work holds the command queue until it
  settles, bounded by `OVERRUN_GRACE_MS` (10 s), so it can't land inside the
  next command's evidence captures.
