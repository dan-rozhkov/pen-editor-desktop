# CLAUDE.md — pen-editor-desktop

Thin Electron shell for pen-editor. The editor itself is NOT here — each tab
is a `WebContentsView` loading the deployed frontend
(`https://pen-editor.onrender.com/app`, override with `PEN_DESKTOP_URL`;
`npm run dev` points it at a local Vite dev server on :5173). The frontend
serves its showcase gallery at `/` and the editor at `/app`, so both the
default URL and any override must include the `/app` path — an override is
used verbatim. The AI backend stays remote. Design spec: `docs/superpowers/specs/2026-07-18-electron-shell-design.md`.

## Commands

```bash
npm run build     # tsc + copy static files → dist/
npm start         # build + launch Electron
npm run dev       # same, against http://localhost:5173
npm test          # Vitest unit tests (test/)
npm run test:e2e  # build + Playwright _electron smoke (stub HTTP server, no network)
npm run test:e2e:live  # opt-in: same shell against the DEPLOYED frontend/backend (network)
npm run lint      # tsc --noEmit (src) + tsc -p tsconfig.e2e.json (e2e/ + configs)
npm run dist      # electron-builder → release/ (mac dmg+zip, unsigned)
```

## Architecture

`src/main/window.ts` wires one `BaseWindow`: a tab-bar `WebContentsView`
(local HTML, `src/tabbar/`) on top and one `WebContentsView` per tab below.
All logic lives in pure, unit-tested modules — `tabManager.ts` (tab
lifecycle; Electron views injected as `TabViewHandle`), `menu.ts` (template),
`navigation.ts` (origin clamp → `shell.openExternal`, offline fallback),
`config.ts` (URL resolution). Keep `window.ts` and `index.ts` free of
decisions; put logic in the pure modules and test it.

All editor views run `contextIsolation: true, sandbox: true, nodeIntegration:
false`; the only bridge is `src/preload/tab.ts`. The whole package compiles
as CommonJS (sandboxed preloads can't be ESM) — no `.js` import-extension
rule here. `src/tabbar/renderer.ts` must compile to a plain script (no
`exports`/`require` in the output — it runs in a CSP'd `<script src>`).

## The live gate (what the stub suites cannot see)

Every other suite here runs against a local stub page, which is what makes
them hermetic — and also what makes them blind to the one failure that
actually breaks users: the shell staying correct while the **deployed** bundle
stops holding up its end. A bundle that no longer calls `registerMcpBridge`,
a renamed command-palette id, a chat endpoint that 4xxs from the app's
origin — none of that is visible to `npm test`, `npm run test:e2e`, or even
pen-editor's cross-repo contract tests, which check that repo's *working
tree*, never what is serving at `pen-editor.onrender.com`.

`e2e/live-prod.spec.ts` closes that gap: it launches the real shell against
the production editor URL and asserts the deployed bundle answers all three
contracts — MCP (`initialize` → `tools/list` → a real `batch_design` mutation
read back out of the live scene graph, plus two-tab `tabId` routing), the
forwarded menu ids (each export command must produce its download), and the
backend (`/api/models` plus a real streaming `/api/chat` turn from the app's
origin). It is excluded from the default run by `playwright.config.ts`'s
`testIgnore` and gets its own `playwright.live.config.ts`; run it with
`npm run test:e2e:live` after a frontend/backend deploy and before cutting a
release. It needs network and spends real tokens on one short chat turn.
`PEN_LIVE_URL` points it at a staging deploy; `PEN_LIVE_BACKEND`, when set,
additionally asserts which backend the bundle is built against.

`tsconfig.json` compiles only `src/` into `dist/`, so `e2e/` and the config
files are type-checked by `tsconfig.e2e.json` — Playwright transpiles without
checking types, and without that second pass nothing checks them at all.

Only the export half of the menu contract is exercised: `file-open` and
`file-import-tokens` open a native file dialog, which would block the run
forever. Downloads are cancelled in a `will-download` handler for the same
reason.

## Cross-repo contract (menu command ids)

Native menu items send pen-editor **command-palette ids** over IPC
`menu:command`; the editor's `src/lib/desktopBridge.ts` dispatches them via
`getCommands()`. Currently used: `file-open`, `file-export-pen`,
`file-export-json`, `file-export-tokens`, `file-import-tokens`. Adding a
menu item = pick an existing `PaletteCommand.id` in
`pen-editor/src/lib/commands/` (or add one there first). Both CLAUDE.md
files list this id set — keep them in sync.

The contract is enforced from the **pen-editor** side:
`pen-editor/src/lib/__tests__/desktopMenuContract.test.ts` imports this repo's
`src/main/menu.ts` (loadable without `npm ci` — the electron import is
type-only), clicks every item with recording actions, and asserts the
forwarded ids both match its pinned list and resolve through `getCommands()`.
pen-editor's `contract` CI job checks out this repo's `main` at run time, so a
menu id typed only here is caught there, not in this repo — this repo has no
CI of its own. Adding or renaming a forwarded id means touching four places:
`menu.ts`, that test's pinned list, and both CLAUDE.md files.

## IPC channels

- `menu:command` main→tab (commandId string)
- `editor:document-title` tab→main (document display name, normalized to `Untitled`)
- `editor:theme` tab→main (`light` | `dark`, observed from the editor's root class)
- `tabbar:state` main→tabbar (`TabsSnapshot`, now including `mcpStatus`), re-sent on tabbar `did-finish-load`
- `tabbar:theme` main→tabbar (`light` | `dark`, active editor theme or system fallback)
- `tabbar:new` / `tabbar:activate` / `tabbar:close` tabbar→main (sender-checked)
- `tabbar:navigate` tabbar→main (sender-checked; `{action: "url" | "back" | "forward" | "reload", url?}`) — the address row driving the active browser tab, see "Built-in browser tab" below
- `mcp:register` tab→main (`{protocol, tools} | null`; `null` unregisters) — desktop MCP bridge, see below
- `mcp:call` main→tab only (`{callId, tool, args}`)
- `mcp:result` tab→main (`{callId, type: "tool_result" | "tool_error", result?, error?}`)
- `browser:command` tab→main, **invoke/handle** (request-response, unlike every other channel above) — `{command: "open" | "act" | "findImages" | "snapshot" | "perform" | "read", args}`, sent only by an *editor* tab's preload and verified against the registered editor tabs before acting; see "Built-in browser tab" below

Both ends of every channel live in this repo — the editor only ever touches
the preload API, never a channel name. `test/ipcContract.test.ts` scans `src/`
for the literals and pins this table: each channel must be sent and received in
its declared direction and nowhere else, the set must match exactly (a new
channel fails until it is listed here too), and every `ipcMain.on` must have a
matching `removeListener` — that last one is the window close/reopen listener
leak `window.ts` guards against. Renaming a channel on one side only is
otherwise silent: Electron matches these strings at runtime and just stops
delivering.

## Desktop MCP bridge

`src/main/mcp/` implements a loopback MCP endpoint (`httpServer.ts` +
`jsonRpc.ts`) that routes `tools/call` into whichever editor tab is active
(`dispatcher.ts`) via `preload/tab.ts`'s `registerMcpBridge` and the three
`mcp:*` channels above, and publishes `~/.pen-editor/mcp.json` for
`pen-editor-plugin` to discover (`handshake.ts`). `mcp/service.ts` owns all
of this — the HTTP server, the token, handshake-ownership state, and the
tab registry — as a single instance created once in `index.ts` and passed
into every `createMainWindow` call. This is deliberate: on macOS closing the
last window does not quit the app (`index.ts` reopens one on `activate`), so
anything window-scoped would die and never come back — the same shape as
the `Menu.setApplicationMenu` wart noted above. `window.ts` only *reports*
tab create/destroy/active into the service; it never owns MCP state itself.

Identity on `mcp:register`/`mcp:result` comes from `event.sender.id` checked
against tabs the service itself created via `registerTab()` — the same
pattern as `window.ts`'s `fromOurTabbar` check — so a page cannot register
or answer on behalf of another tab. `service.ts` is deliberately
Electron-free (no `import ... from "electron"`) so it stays unit-testable
under plain Node/vitest, where requiring the `electron` package returns a
path string rather than the API; `window.ts`/`index.ts` adapt real
`ipcMain`/`webContents` objects to its small injected interfaces
(`TabHandle`, `IpcListenerGateway`).

Only the MCP status string (`"listening" | "not-published" | "off" | "error"`)
ever crosses into anything rendered — never the token or the port number. The
tab strip's indicator and the File menu's "MCP: …"/"Use this app for MCP"
items (see `menu.ts`) are the only diagnostics available, since a packaged app
has no terminal.

## Built-in browser tab

A second `TabKind` (`tabManager.ts`'s `"editor" | "browser"`) — a real
browser tab the design agent can drive to pull visual references from the
open web (Pinterest in particular). Design spec:
`docs/superpowers/specs/2026-09-18-builtin-browser-design.md`.

A browser tab's `WebContentsView` is constructed with
`partition: "persist:penbrowser"` — its own session, separate from the
editor tabs' — and **no preload at all**: `contextIsolation`/`sandbox` are
on as usual, but there is nothing exposing `window.penDesktop` to it. That
dedicated partition is the whole security boundary: the editor's cookies are
never in it, and whatever the user logs into inside the browser tab (a
Pinterest account, say) is exactly what the agent can reach, nothing more.
The partition also has no chrome to ever reveal or revoke a granted
permission, so `index.ts` calls `denyAllPermissions` (`browser/permissions.ts`)
on it exactly once, at startup, after `app.whenReady()` — deny-by-default
`setPermissionRequestHandler`/`setPermissionCheckHandler`, since Electron
grants permission requests by default and would otherwise silently hand any
browsed page geolocation, notifications, clipboard-read, or media devices.
Consequently a browser tab is never passed to `mcpService.registerTab()`,
never gets the `editor:*` title/theme IPC (there is no preload to send them
from), and its title/url/back-forward state instead comes from real
navigation events (`did-navigate`, `did-navigate-in-page`,
`page-title-updated`) that `window.ts` wires into
`TabViewHandle.onNavigationStateChanged` — wired by `TabManager.newTab()`
only for `kind: "browser"`, the same way title/theme callbacks are wired
only for `kind: "editor"`.

Because a browser tab is never MCP-registered, `window.ts`'s `pushState`
must not blindly forward the active tab's webContents id to
`mcpService.setActiveTab()` — activating a browser tab would otherwise point
the MCP dispatcher at an id it never registered, breaking every
un-targeted `tools/call` ("No editor tab is open") even while an editor tab
is still open elsewhere in the strip. `tabManager.ts`'s pure
`resolveMcpActiveTab(activeKind, activeWebContentsId, lastEditorWebContentsId)`
reports the active id only while an editor tab is active, and otherwise
keeps pointing at whichever editor tab was last active (never nulled out).
`TabManager` owns `lastEditorWebContentsId` itself (updated in `setActive`
whenever an editor tab becomes active) and folds `resolveMcpActiveTab`'s
result into every `TabsSnapshot` as `mcpActiveWebContentsId` — `window.ts`
just forwards that field to `mcpService.setActiveTab()`, keeping the
decision itself out of `window.ts`. This used to be a `let` tracked
directly in `window.ts`'s `pushState`, updated only when an editor tab
became active — which meant closing the *active* editor tab while its
neighbor was a browser tab left it pointing at that closed tab's
webContents id (nothing had refreshed it, since the newly active tab was a
browser tab), and the closed tab's own `view.destroy()` → `unregisterTab()`
would then null out `McpService`'s active tab entirely, even with another
editor tab still open elsewhere in the strip. `TabManager.closeTab()` now
repoints `lastEditorWebContentsId` to another surviving editor tab (or
`null`) the moment the tab it was pointing at closes, before that tab's
view is ever destroyed and before the closing snapshot goes out — see the
`mcpActiveWebContentsId (finding 1)` tests in `test/tabManager.test.ts`.

The `browser:command` `ipcMain.handle` in `window.ts` checks the sender
against `TabManager.isEditorTab()` — the single source of truth for "which
webContents id is an editor tab" (there used to be a second, ad hoc `Set`
kept in `window.ts` alongside it; the two could drift, so it was deleted).

Popups (`target="_blank"`, `window.open`) inside a browser tab open as a new
browser tab (`navigation.ts`'s `attachBrowserTabPolicy` /
`decideBrowserNavigation` — any http(s) URL is allowed, anything else is
denied) rather than escaping to the system browser via `shell.openExternal`,
unlike editor tabs' `attachNavigationPolicy`.

`src/main/browser/controller.ts` (`BrowserController`) is the command
surface, in the same Electron-free, injected-handle style as
`mcp/dispatcher.ts` — a `BrowserTarget`/`BrowserPageHandle` pair stands in
for the real tab, so it is unit-tested under plain Node/vitest
(`test/browserController.test.ts`). Its six commands (`open`, `act`,
`findImages`, `snapshot`, `perform`, `read`) are exposed to an *editor* tab's
preload as `window.penDesktop.browser.{open,act,findImages,snapshot,perform,read}`
(`src/preload/tab.ts`), each forwarding to the single `browser:command`
`ipcMain.handle` in `window.ts` — `snapshot`/`perform`/`read` are additional
commands on that *same* channel, not a new IPC channel, so
`test/ipcContract.test.ts`'s table is unaffected by them. That handler is the trust boundary — every
argument ultimately comes from an LLM tool call, so `BrowserController`
validates shape and type itself rather than trusting the caller, and every
command resolves (never rejects), coming back as `{ error: string }` on any
failure, matching how `dispatcher.ts`'s calls and pen-editor's own
`toolHandlers` behave. `act`'s `click`/`type`/`scroll` commands run small
injected page scripts (`src/main/browser/pageScripts.ts`) via
`executeJavaScript`, with arguments always embedded as a `JSON.stringify`d
literal via a **function** replacer (`.replace(ARGS_MARKER, () =>
JSON.stringify(args))`) — the string form of `replace` treats `$&`, `` $` ``,
`$'` and `$$` in the replacement as special patterns, which would otherwise
let a click target or typed text containing one of those sequences mangle
the script or (for `` $' ``) splice page source into the JSON literal,
defeating the "never break out of the script" invariant. `back`/`forward`
are guarded by `canGoBack()`/`canGoForward()` before calling
`goBack()`/`goForward()` — an ungoverned `goForward()` with no forward
history is a silent no-op that used to report false success after burning
the full settle wait. `click`'s page script reads
`location.href`/`document.title` synchronously, so if the click itself
starts a navigation it can report the page just left rather than the one
landed on. `BrowserController.settleAfterClick` (used by both `act`'s click
and `perform`'s `CLICK`) settles in two phases — a short (300ms,
`CLICK_SETTLE_TIMEOUT_MS`) bounded wait for *any* sign a navigation started
at all (`getURL()` moving, or `TabViewHandle.isLoading()` going true —
checking `isLoading()` too is what keeps the short bound viable, since real
Electron flips it true essentially as soon as a navigation is requested,
well before a slow network response would actually move `getURL()`), then,
only if a navigation was observed, a longer (8s, `CLICK_LOAD_SETTLE_TIMEOUT_MS`)
bounded wait for `isLoading()` to go back to `false` before trusting the
result's url/title. This two-phase shape (addendum F, "Load, not commit",
in `docs/superpowers/specs/2026-09-18-browse-task-jev-loop-design.md`)
replaced settling at navigation *commit* alone: a following
`browse_find_images` would otherwise measure an unlaid-out document at
commit, where every `getBoundingClientRect()` is 0×0, so the size filter
dropped every image and the tool reported `count: 0` even on an image-rich
page. `back`/`forward` still use the plain `waitForUrlChange` poll with
their longer (2s) bound — addendum F's fix is scoped to the click path.

**`open` resolves at DOM-ready, not at full load.** `webContents.loadURL()`'s
own promise only resolves at `did-finish-load` — every subresource,
including ads/trackers/video on a heavy commercial page, which routinely
exceeds `BROWSER_COMMAND_TIMEOUT_MS` (20s) even though the page has been
usable for most of that wait. `BrowserPageHandle.onceDomReady()`
(`TabViewHandle.onceDomReady()` in `window.ts`, a one-shot listener on
`webContents`'s `dom-ready` event) is armed **before** `loadURL()` is
called — arming it after risks missing an event that can fire while
`loadURL()` is still synchronously setting up the navigation — and raced
against the `loadURL()` promise. If the full load settles first (a fast
page, or a genuine navigation error before the DOM ever became ready), that
result is trusted outright, a rejection surfacing as `{ error }` exactly as
before this fix. If DOM-ready wins, the page gets a short, bounded grace
period (`OPEN_LOAD_GRACE_MS`, 1500ms — well under the command timeout) to
finish the full load too, so the common fast page still reports
`loaded: true`; if the grace period expires first, the command returns with
`loaded: false` instead. The result's new `loaded: boolean` field is the
only way a caller can tell which case happened — `get_screenshot` or
`browse_find_images` immediately after a `loaded: false` open should expect
a page that's still filling in. `loadURL()`'s own promise is *always*
awaited internally (via a `.then` that converts a rejection into a resolved
value) regardless of which branch is taken, so a load failure or success
that settles after `open` has already returned can never surface as an
unhandled rejection — it's simply too late to change the `loaded` value
already reported.

One real limitation this fix does **not** paper over: Electron's own
`webContents.executeJavaScript` defers running until the page *stops*
loading (documented Electron behavior, not something under this repo's
control — see electron/electron#5183) — so `snapshot`/`read`/`act`/`perform`
against a `loaded: false` page will themselves block until whatever
subresource is still pending finally settles (or the tab's own
`BROWSER_COMMAND_TIMEOUT_MS` is hit, if it never does). `open`'s early
return only means the *navigation* command itself doesn't block on that —
it does not make the tab's DOM scriptable ahead of Electron's own gate.

`pageScripts.ts`'s `findByText` (used by `click`/`type`, tried *before* a
CSS-selector lookup — see below) searches genuinely clickable elements
(`a, button, [role="button"], input, select, textarea, [onclick]`) before
falling back to any element, and within each candidate set prefers the
innermost match over an enclosing wrapper — a plain document-order scan
picks the outermost element whose trimmed `textContent` matches, typically
a wrapper `<div>` around the real control, and `el.click()` on that wrapper
never reaches a descendant's listener. `CLICK_JS`/`TYPE_JS` try `target` as
visible text (`findByText`) *before* trying it as a CSS selector
(`findBySelector`) — the reverse order used to be the default, and a bare
word like "Search", "Map", "Details", "Select", "Menu", "Address" or
"Video" is also a syntactically valid CSS *type* selector, matching the
real `<search>`/`<map>`/`<details>`/`<select>`/`<menu>`/`<address>`/`<video>`
element on the page (when present) instead of the button carrying that
label — while still reporting `{ matched: target }` as if the click had
landed correctly. A real CSS selector essentially never equals some
element's trimmed `textContent`, so the fallback to `findBySelector` still
fires for genuine selectors. `FIND_IMAGES_JS`'s `consider()` only
accepts `http:`/`https:` resolved URLs — an inline `data:`/`blob:` image has
no size cap and would otherwise flood chat history with base64 (this repo's
been bitten by that twice before).

`snapshot`/`perform` (design doc `2026-09-18-browse-task-jev-loop-design.md`
§1, corrections in its "Addendum, 2026-09-18" section) exist to drive a
cheap per-step decision model (Jev) instead of a full chat turn per click —
see that doc's §2–§3 for the backend/frontend halves, which are a separate
change in `pen-editor-backend`/`pen-editor`. `snapshot` runs `SNAPSHOT_JS`
(a port of jev-ultrafast's `snapshot.js` concepts, credited in
`pageScripts.ts`'s header) and returns an indexed table of visible,
interactive elements (tag, role, label, ops, options, capped at
`MAX_SNAPSHOT_ELEMENTS = 120`, nearest-to-viewport first) plus a freshly
minted `snapshotId`. Addendum D governs what an element may report as
`value`: only a non-password `input[type=text]`, `input[type=search]`, or
`textarea` — truncated to 100 chars, and only when `autocomplete` isn't one
of `cc-*`, `one-time-code`, `current-password`, `new-password` — reports its
live `value` at all; every other element (a password input included)
reports `hasValue: true|false` instead, never the content. The original
rule guarded only `type=password`, so an autofilled card number in a
`type=text` field, an email, or a phone number left the page in the element
table under `value`. `options` on a `<select>` is capped at 100 entries,
each truncated to 120 chars, in the page script itself — the payload must
be valid by construction, not rely on the backend to reject an oversized
country dropdown. `SNAPSHOT_JS` also stamps each surviving element with a
`data-pen-snap="<snapshotId>:<index>"` attribute. **Invariant:** `perform`
only ever acts against the *same* snapshot its index came from, taken
against the *same* browser tab. `BrowserController` keeps `{ id, page }` for
the most recent `snapshot()` call — both the id and the exact
`BrowserPageHandle` object it ran against — and `perform` hard-errors
(before running anything) unless the caller's `snapshotId` matches *and*
`target.currentPage()` is reference-equal to that same page, rather than
falling back to the page's `data-pen-snap` lookup (which would itself fail
closed if the marked node were gone, but the controller-level check makes
the failure an explicit, immediate error instead of a "no element"
surprise). The page-identity half exists because File ▸ New Browser Tab and
popups both mean more than one browser tab can exist, and
`TabManager.browserHandle()` picks active-if-browser else last-created —
without it, a snapshot taken on one tab followed by a `perform` after the
user (or a popup) switched to a different tab would pass the id check
(nothing else took a new snapshot) and only then fail in-page against the
wrong tab's DOM with a misleading "no element at index N" message, instead
of an accurate cross-tab error. This is deliberate either way: a page that
re-rendered — or a browser tab that changed — between `snapshot` and
`perform` must never be acted on silently — that would be the one way the
indexed design goes quietly wrong. `perform`'s argument shape (addendum A):
`index` is required only for `CLICK`/`TYPE_TEXT`/`SELECT` — `SCROLL_UP` and
`SCROLL_DOWN` act on the page itself and are accepted with no `index` at
all (an unconditional requirement used to make scrolling always fail at the
bridge); `WAIT` is not a member of `PerformOperation` at all and is never
sent to `perform` — the frontend loop handles it locally by sleeping and
taking a fresh snapshot. `perform`'s `CLICK` operation reuses the same
two-phase post-click settle wait as `act`'s click (`settleAfterClick`, see
above); `SCROLL_UP`/`SCROLL_DOWN` need no element lookup. `snapshot`/`perform`
are loop internals only — they are never exposed as their own `penTools`
entries, reachable solely through this preload.

### Evidence of effect, `browse_read`, and better images/labels (Addendum 2, 2026-09-19)

A live Amazon run exposed a gap the hermetic suites can't see on their own:
navigation and clicks landed correctly, but the agent *narrated* effects that
never happened (claiming an image gallery had switched when it was
pixel-identical, claiming a filter it never applied) because `act`/`perform`
gave it nothing to check itself against. Four fixes, all in this repo (design
doc's "Addendum 2, 2026-09-19"):

1. **Evidence of effect.** `act` and `perform` now merge an
   `{ changed: boolean, changes: string[] }` pair into every successful
   result (an `{ error }` result is unaffected — no evidence is attached to a
   failure). `BrowserController.captureSignature` runs a new page script,
   `SIGNATURE_JS`, once before the action and once after the existing settle
   wait, and `diffSignatures` compares the two. `changed: false` is a normal,
   reportable answer — a click that landed on a wrapper and did nothing is
   still a successful command, never an error. `captureSignature` swallows
   its own failures (a throwing/rejecting `executeJavaScript`) and returns
   `null`. Applied to every `act` action (`click`/`type`/`scroll`/`back`/
   `forward`) and every `perform` operation (`CLICK`/`TYPE_TEXT`/`SELECT`/
   `SCROLL_UP`/`SCROLL_DOWN`); `open`, `findImages`, `snapshot`, and `read`
   are read-only or one-shot and carry no evidence field.

   **A high-effort review of this design found the first cut too coarse and
   too fragile, in four ways that reshaped it further (all still in this
   repo — `pageScripts.ts`/`controller.ts`/`test/browserController.test.ts`/
   `e2e/browser-tab.spec.ts`):**

   - **`changed` no longer gates on whole-document `dom`/`text` deltas.**
     The original signature was `{ url, title, nodeCount, textLength,
     textHash, mainImageSrc }`, and *any* difference — including node count
     or visible-text-hash — set `changed: true`. On a live page (a rotating
     carousel, a lazy-loading image, a live price, an injected ad) that
     moves between two captures milliseconds apart regardless of what the
     agent did, handing back exactly the false "it worked" confirmation this
     whole feature exists to prevent. `dom`/`text` are still *reported* in
     `changes` as useful context, but only `"url"`, `"title"`, `"main-image"`
     (see below), `"scroll"`, `"value"` and `"target"` (see below) gate the
     boolean.
   - **The acted-on element gets its own scoped signature.** `CLICK_JS`/
     `TYPE_JS`/`PERFORM_JS` (for `CLICK`/`TYPE_TEXT`/`SELECT`) stamp the
     element they actually found with `data-pen-sig-target` and compute its
     own signature (subtree node count, text hash, `src`, a **value
     length** — never the raw value — `aria-expanded`, `aria-selected`,
     `checked`) *before* mutating it, inline in the action script itself
     (returned as an internal `__scopedBefore` field the controller strips
     before the result reaches a caller — see `extractScopedBefore`).
     `SIGNATURE_JS`'s `"after"` phase re-finds the same marked element and
     reports its current signature as `scopedAfter`. A change here reports
     `"target"` in `changes` and gates `changed` — this is the real evidence
     on a page whose document-wide numbers are noise, and it's also what
     makes a successful `type`/`select` (which moves a form field's value,
     not the visible text) distinguishable from a dead one.
   - **`main-image` is now identity-guarded.** The original signature just
     recomputed "the largest visible `<img>`" independently before and
     after — so a newly-loaded ad becoming larger than the real photo, with
     the photo itself completely unchanged, still reported `"main-image"`
     changed. `SIGNATURE_JS`'s `"before"` phase picks that element once and
     stamps it `data-pen-sig-mainimg`; the `"after"` phase re-reads the
     *same* stamped element (or reports an empty src if it's gone) rather
     than recomputing "largest" from scratch, so `"main-image"` only fires
     when that specific element's own `src` actually changed.
   - **`scrollY` and a focused element's value length joined the
     document-wide signature**, and `type`/`scroll` (both `act`'s and
     `perform`'s) now get a short (`NON_CLICK_SETTLE_MS`, 50ms) settle before
     the "after" capture. The original signature had nothing that moved for
     a successful scroll at all, and `type`/`scroll` captured "after"
     immediately with no settle — a successful action and a dead one (typed
     into a field that dropped the keystrokes, scrolled a page that didn't
     move) were indistinguishable. Unlike `dom`/`text`, `scrollY` and the
     focused value's length don't drift on their own between two captures of
     the same page, so — like the scoped-target signature — they gate
     `changed` rather than being noise.
   - **A missing capture no longer silently means "no change".** The
     original `diffSignatures` returned `{ changed: false, changes: [] }`
     whenever either the before or after capture was `null` — but a `null`
     *after* capture is most likely to happen exactly when the page *did*
     change: `executeJavaScript` rejecting mid a cross-origin navigation's
     frame swap. `runClick`/`perform`'s `CLICK` branch/`back`/`forward`
     already track `previousUrl`/`currentUrl`; `diffSignatures` now falls
     back to comparing those (reporting `"url"` only — there's no equivalent
     fallback for `title`) instead of guessing "unchanged".

   `SIGNATURE_JS` now takes `args.phase` (`"before" | "after"`, via the same
   `ARGS_MARKER` substitution every other script uses) so it can coordinate
   the `data-pen-sig-mainimg`/`data-pen-sig-target` markers across the two
   calls — it is no longer argument-free.

2. **`read` / `browse_read`.** A sixth command, `read`, runs a new page
   script, `READ_JS`, and returns
   `{ url, title, headings, text, links, truncated }` — the first thing in
   this bridge that gives the agent a text digest of a page rather than only
   an element table or an image list. `text` is visible text with
   `script`/`style`/`noscript`/`nav` (and anything `role="navigation"`)
   stripped and whitespace collapsed, capped at `maxChars` (default 6000,
   hard cap 20000 — `BrowserController.validateReadArgs` clamps a caller's
   request to the hard cap rather than rejecting it, the same "payload valid
   by construction" posture as `SNAPSHOT_JS`'s option/value caps). `headings`
   are `h1`-`h3` in document order, capped at 40; `links` are `a[href]`
   resolved to absolute URLs, http(s) only, deduped by resolved href, capped
   at 60, with each label trimmed to 120 chars. An optional `selector`
   narrows the whole read to one subtree; when it matches nothing, `READ_JS`
   itself returns `{ error }` — the controller surfaces that verbatim rather
   than silently widening back out to a whole-page read, the same principle
   `perform`'s stale-snapshot check already enforces elsewhere in this file.
   Read-only, so unlike `act`/`perform` it carries no `{ changed, changes }`.

   Review fixes: `truncated` only ever reflected the *text* cap — the
   40-heading/60-link caps were applied silently, so a page with hundreds of
   links reported 60 of them with `truncated: false` and a consumer had no
   way to know anything was cut. `headingsTruncated`/`linksTruncated` now
   report each collection's own truncation alongside the unchanged
   (text-only) `truncated` field. Separately, with a `selector`, `text`
   already included the root element's own text (`collectText` walks the
   root's own children), but `headings`/`links` used
   `root.querySelectorAll(...)`, which only matches *descendants* — so
   `read({ selector: "h1" })` returned that heading's text in `text` but an
   empty `headings` array. `queryIncludingSelf` makes root inclusion
   consistent: the root itself is checked against the selector too, not just
   its descendants.

3. **BROWSE-01 (better images).** `FIND_IMAGES_JS` now parses an `<img>`'s
   `srcset` and picks the largest declared candidate — by `w` width
   descriptor when present, else by `x` density descriptor as a relative-size
   proxy — falling back to `currentSrc || src` only when there is no usable
   srcset. This is deliberately generic (no per-host URL rewriting, which is
   the part that rots): a live Pinterest run had the agent guessing at
   higher-resolution URLs itself after `find_images` only ever returned
   236px thumbnails, and the fix is to read what the page already declares
   instead. Every found image also now reports `naturalWidth`/
   `naturalHeight` alongside the existing `width`/`height` — which still
   means *rendered* size, the e2e suite pins that — so a consumer can tell a
   genuinely small asset from a small CSS rendering of a large one. A
   background-image element has no natural-size concept reachable
   synchronously without decoding it, so its `naturalWidth`/`naturalHeight`
   fall back to its rendered size, same as before this addendum.

   **Review fixes (HIGH):** the original `srcset.split(",")` broke on the
   comma-bearing URLs real CDNs routinely serve
   (`https://cdn/x/w_800,h_600/a.jpg 800w` — a Cloudinary/imgix transform) —
   the URL itself split at the internal comma, the descriptor-less fragment
   was skipped, and the *other* fragment (missing its own scheme/host) won on
   score and was returned as-is, silently 404ing every image `find_images`
   returned on such a host — worse than the bug this fix originally set out
   to solve. `pickLargestSrcsetCandidate` now splits on `,\s+` (comma
   *followed by whitespace*, which is how the srcset grammar actually
   separates candidates, and something a comma embedded in a URL essentially
   never looks like), and additionally verifies the winning candidate
   resolves as a URL at all before returning it. Separately, `naturalWidth`/
   `naturalHeight` used to always come from `img.naturalWidth`/
   `naturalHeight` even once this fix started preferring a different,
   possibly-unfetched `srcset` candidate — worse, per the HTML spec a `w`
   descriptor selection makes the browser report *density-corrected* natural
   size (divided by an implied pixel density computed from the descriptor
   and the viewport-width-dependent "sizes" target), so even the "candidate
   the browser did fetch" case doesn't reliably reflect the resource's real
   pixel size. Whenever the returned URL came from a `w`-descriptor `srcset`
   candidate at all, the descriptor's own declared width is reported
   instead, with height estimated from the loaded image's aspect ratio
   (density correction scales both dimensions equally, so the ratio itself
   stays meaningful) — or omitted entirely when there's no declared width to
   fall back on (an `x`-density-only srcset).

4. **BROWSE-02 (better labels).** `SNAPSHOT_JS`'s `labelOf` gained several
   steps, all tried before the positional `tag #index` fallback, which stays
   last on purpose (dropping an unlabelled element outright is worse — cookie
   banners are made of exactly these): `aria-label` → `aria-labelledby`
   (resolved through the referenced element's own text) → own text →
   `placeholder` → `alt` → `title` → a **descendant's** `aria-label`/`title`/
   `alt` (the common icon-button shape,
   `<div role="button"><svg aria-label="Save"></svg></div>`, where the real
   label sits one level below the interactive element itself) → the
   accessible name of the **nearest enclosing** `<a>`/`<button>` (guarded
   against matching the element itself, which every earlier step already
   covers) → `name`/`id` attribute → the positional fallback. A live Amazon
   run degraded to a run of `div #6`/`input #7` entries that
   `MIN_STEP_CONFIDENCE` then (correctly) refused to act on, making those
   controls unreachable by `browse_task`; the new steps recover a real label
   in exactly the shapes that run exposed. One consequence worth knowing for
   test fixtures: since `id` is now a legitimate label source, any element
   that should exercise the *positional* fallback in a test must have no
   `id` either, not just no `aria-label`/text/etc.

   **Review fixes:** the descendant step used to inspect only the *first*
   element matching `[aria-label], [title], [alt]` and give up if its
   attributes were blank — `<div role="button"><img alt=""><svg
   aria-label="Save"></svg></div>` (a very common shape) matches the `<img>`
   first, which yields nothing, so the label was lost. Every match is now
   tried, in document order, until one actually has a non-empty value.
   Separately, falling back to `el.id` turns a machine-generated id (React
   useId's `":r3:"`, Ember's `"ember123"`, Amazon's `"a-autoid-1-announce"`)
   into a label — worse than the honest positional fallback, since it reads
   as plausible to the Jev decision model and both defeats
   `MIN_STEP_CONFIDENCE`'s ability to refuse a bad guess and invites a wrong
   pick. `looksGenerated` skips ids that are digits-only, digit-suffixed,
   React-useId-shaped (leading/trailing `:`), or start with a known
   framework prefix, falling through to whatever label source comes next (or
   ultimately the positional fallback) — a genuinely hand-authored id
   (`"inp-search"`, `"btn-checkout"`) is still a legitimate label source and
   is left alone.

The address row (a second, 32px-tall row inside the *existing* tab-bar
`WebContentsView` — no new view, no new preload) is shown only while the
active tab is a browser tab; `window.ts`'s `layout()` re-runs on every
`tabbar:state` push (not just on window resize) since the active tab's kind
can change without one. Its back/forward/reload/url controls send
`tabbar:navigate` (sender-checked against the tab-bar view, like
`tabbar:new`/`tabbar:activate`/`tabbar:close`). Typed input is normalized by
`normalizeTypedUrl` in `src/tabbar/urlNormalization.ts` — its own file
(loaded as a second plain `<script src>` before `renderer.js`, same
no-import/export global-script constraint as `renderer.ts`, so its
functions are testable in isolation) — into a navigable URL: whitespace in
the input always means a search query (routed to a Pinterest search),
otherwise it is parsed as a URL (`https://` prepended if there's no
scheme) and falls back to search if that fails or the parsed host has no
dot. A submission that still can't be normalized into an `http(s)` URL
(`isNavigableUrl`, also in that file) leaves the input showing its prior
value with a `.invalid` CSS class instead of silently doing nothing. The
input also resyncs to the tab's latest known url on blur — while focused,
incoming `tabbar:state` pushes don't overwrite it (so as not to clobber
mid-typing), but nothing used to catch it up afterwards, leaving it stale
indefinitely if a state change (e.g. an agent-driven `browse_open`) landed
while the user had the address bar focused.

**A fresh, empty-URL browser tab becoming active auto-focuses the address
bar**, the way every real browser does on a new tab — File ▸ New Browser Tab
used to produce a tab titled "New Tab" with a visible but unfocused,
completely empty address row and a blank content area, with nothing at all
inviting input (the placeholder "Search or enter address" only helps once
the field is actually focused). The decision lives in `tabManager.ts`'s pure,
exported, unit-tested `shouldFocusAddressBar(previous, next)` — true only
when the *newly* active tab is a browser tab with an empty url (keyed off
"the active tab id changed since the previous push", not just "kind browser,
url empty", so the frequent non-activation pushes — title changes,
navigation-state changes, MCP status changes, resizes — never steal focus
from whatever the user is doing). `window.ts`'s `pushState` tracks the prior
snapshot itself, calls the predicate, and folds the result into the existing
`tabbar:state` snapshot as `focusAddressBar` rather than adding a new IPC
channel. Two halves, both required, since the tab bar is its own
`WebContentsView`: `window.ts` focuses `tabbarView.webContents` itself
(OS-level — without this, focusing an input inside the tab bar's own DOM
does nothing for where keystrokes actually go), and `renderer.ts` focuses
and selects `#url-input` when it sees `focusAddressBar` on the pushed state.

This auto-focus interacts with the blur-resync anti-clobber guard above in a
way worth knowing: being merely *focused* is no longer by itself enough to
suppress `onState`'s writes into `#url-input` — only an actual `input` event
(`userEditingUrl` in `renderer.ts`) does. The auto-focus on a brand-new blank
tab fires with no keystroke at all, and if focus alone suppressed syncing, a
subsequent agent-driven `browse_open` navigating that same tab would never
un-suppress it (nothing ever blurs the field in that flow), permanently
wedging the address bar on `""` even once the tab had actually navigated.

Only the desktop half of the design shipped from this repo. The backend
`penTools` schemas (`browse_open`/`browse_act`/`browse_find_images`,
client-executed, no `execute`) and the frontend `toolRegistry.ts` handlers
that call `window.penDesktop.browser` are a separate change in
`pen-editor-backend`/`pen-editor`, gated behind a `clientCapabilities.desktopBrowser`
flag the frontend derives from `Boolean(window.penDesktop?.browser)` — see
the design doc's §6–§8 for that half and its merge order.

### The human cursor overlay

While the agent drives a browser tab, clicks/typing used to land instantly
and invisibly — nothing on screen showed the user what the agent was doing.
`BrowserController.moveCursor` (`controller.ts`) runs a new page script,
`CURSOR_JS` (`pageScripts.ts`), before every action that touches the page:
`act`'s `click`/`type`/`scroll` and `perform`'s `CLICK`/`TYPE_TEXT`/`SELECT`/
`SCROLL_UP`/`SCROLL_DOWN`. It installs (idempotently, under
`window.__penCursor`) a fixed-position SVG arrow overlay, animates it along a
bowed, eased path to the resolved target's center, and gives it a small
press/ripple pulse on arrival before resolving.

**Ordering invariant: `moveCursor` always runs *before* the action's
before-signature capture (`captureSignature(page, "before")`), never
between the two captures.** The overlay's own DOM insertion and the
`scrollIntoView` it performs while locating the target are both real page
mutations, and "Addendum 2"'s evidence-of-effect diff (`SIGNATURE_JS`,
`diffSignatures`) exists specifically to tell the agent whether *its* action
changed the page — running the cursor between the two captures would fold
the cursor's own footprint into that diff and manufacture false
`changed: true` evidence for actions that didn't actually do anything.

**`pointer-events:none` and `z-index:2147483647` on the overlay root — and
every element inside it — is a hard invariant.** The overlay sits on top of
real page content in a browser tab with no preload to route around it; if it
ever became click-through-blocking, it would silently break every
subsequent click/type this bridge performs. `SNAPSHOT_JS`/`FIND_IMAGES_JS`
both skip any node inside `[data-pen-cursor]` for the same reason: the
overlay must never itself show up as an actionable element or a "found
image".

`CURSOR_JS`'s own value is a Promise, unlike every other script in this
file — `executeJavaScript` awaits it, and the animation spans several
`requestAnimationFrame` ticks. It never throws (every path resolves,
including a `{ error }` shape) and always settles within ~1.15s via its own
internal backstop timer, since `requestAnimationFrame` can simply stop
firing in a backgrounded tab. Every settle path — `finish()` — is what
clears the backstop, never a caller of `finish()`: an earlier version
cleared it in `arrive()` *before* scheduling the final `setTimeout(finish,
120)`, which meant that last, unguarded 120ms timer had nothing bounding it
if a throttled/hidden renderer delayed it past 1s (Chromium clamps
backgrounded timers to a ≥1s floor) — the backstop is now only ever
disarmed once something has actually settled, so it genuinely bounds every
path, including that one. `moveCursor` wraps the call in its own timeout
(`CURSOR_TIMEOUT_MS`, bounded further by the controller's own `timeoutMs`)
and swallows every failure — a rejecting/throwing/timed-out cursor call must
never turn a working browser command into an error or a timeout of its own.
The controller tracks the overlay's last known position
(`this.cursorPosition`) and feeds it back as `from` on the next call, so
consecutive moves chain from wherever the cursor actually is.

**The cursor step's own budget is added to, not carved out of, the command's
timeout.** `moveCursor` runs *inside* the same closure `withCommandTimeout`
bounds for every action that does a cursor step (`act`'s click/type/scroll,
`perform`) — early versions passed the controller's plain `timeoutMs` as that
closure's budget, so the cursor's up-to-`CURSOR_TIMEOUT_MS` (1.5s) came out of
the same 20s the action itself needs, and a slow-but-successful click already
close to that budget could time out purely because of a cosmetic overlay.
Those four call sites now pass `this.timeoutMs + this.cursorBudgetMs` instead
(`cursorBudgetMs` is `Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS)` when the
cursor is enabled, `0` when it isn't) — `open`, `findImages`, `read`,
`snapshot`, and `back`/`forward` never run a cursor step, so they keep the
plain `timeoutMs` budget.

**`moveCursor` also skips itself entirely when the driven tab isn't
visible.** `TabManager.browserHandle()` (and therefore
`BrowserController.currentPage()`) can return a browser tab that isn't the
*active* one, and a hidden `WebContentsView` never fires
`requestAnimationFrame` — so the animation would only ever settle via its own
backstop, paying the full ~1.15s per click/type/select for an overlay nobody
can see (the same rAF-in-a-hidden-tab failure this repo already hit with
`get_screenshot`). `BrowserPageHandle` (`controller.ts`) and `TabViewHandle`
(`tabManager.ts`) both carry an **optional** `isVisible?(): boolean`; the real
implementation in `window.ts` is `view.getVisible()` (Electron's own
`View#getVisible()`, shipped on `WebContentsView` in this repo's pinned
Electron version), which already tracks exactly what
`TabManager.setActive`'s `view.setVisible(...)` calls set — no separate
visibility bookkeeping needed. `moveCursor` returns immediately when
`page.isVisible?.() === false`; a handle that doesn't implement the method
(every fake page in the unit suite) behaves as before — the cursor always
runs.

Disabled with `PEN_DESKTOP_BROWSER_CURSOR=off` (also `0`/`false`,
case-insensitive — `config.ts`'s `resolveBrowserCursorEnabled`), wired into
`window.ts`'s `new BrowserController(...)` call as the `cursor` option
(default on).
