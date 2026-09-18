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
- `browser:command` tab→main, **invoke/handle** (request-response, unlike every other channel above) — `{command: "open" | "act" | "findImages" | "snapshot" | "perform", args}`, sent only by an *editor* tab's preload and verified against the registered editor tabs before acting; see "Built-in browser tab" below

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
(`test/browserController.test.ts`). Its five commands (`open`, `act`,
`findImages`, `snapshot`, `perform`) are exposed to an *editor* tab's
preload as `window.penDesktop.browser.{open,act,findImages,snapshot,perform}`
(`src/preload/tab.ts`), each forwarding to the single `browser:command`
`ipcMain.handle` in `window.ts` — `snapshot`/`perform` are a second pair of
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

Only the desktop half of the design shipped from this repo. The backend
`penTools` schemas (`browse_open`/`browse_act`/`browse_find_images`,
client-executed, no `execute`) and the frontend `toolRegistry.ts` handlers
that call `window.penDesktop.browser` are a separate change in
`pen-editor-backend`/`pen-editor`, gated behind a `clientCapabilities.desktopBrowser`
flag the frontend derives from `Boolean(window.penDesktop?.browser)` — see
the design doc's §6–§8 for that half and its merge order.
