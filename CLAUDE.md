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

## Agent layout (flag)

One step of the agent-layout feature (a chat agent docked beside the tabs).
`PEN_DESKTOP_AGENT_LAYOUT=1` (`config.ts` `resolveAgentLayoutEnabled`; also
`true`/`on`) adds a left panel to the main window. The flag is resolved once in
`index.ts` (like `editorUrl`) and passed to `createMainWindow`; `window.ts`
reads no env. The panel is a separate `WebContentsView` loading the frontend's
`/agent` page (`resolveAgentPanelUrl`: the LAST path segment `app` becomes
`agent`, base path prefix kept, `/app/` -> `/agent`; a path not ending in
`app` gets `agent` beside its last segment; the editor's query and hash are
dropped). Flag off: no panel and the geometry is byte-for-byte the old one.

Geometry is the pure `src/main/layout.ts` (`computeWindowLayout`). The tab bar
view and the macOS rim span the FULL window width as before, so the traffic
lights stay where they are. The panel sits BELOW the tab bar on the left (top =
tab-bar height incl. the browser address row, inset by the 1px rim left and
bottom like tab views); tab views get `tabArea`, to the right of the panel
(one rim-width gap between them). `TabManager.layout(rect)` just applies that
rect; it computes nothing. Panel width is a parameter (`clampAgentPanelWidth`:
min 300, max 50% of the window; default 380); drag-resize and collapse are not
built yet.

Inside the tab bar the strip starts at the panel's right edge: `window.ts`
adds `tabStripLeft` to the existing `tabbar:state` snapshot (no new channel);
`renderer.ts` writes it to the CSS var `--tab-strip-left`; the tab row's left
padding is `max(88px traffic lights on mac, --tab-strip-left)` (the address
row uses the same offset). The row stays a window drag region, so the part of
the bar above the panel is an empty draggable title area. Popup anchors (new
tab, browser tools) are tab-bar CSS px = window coords (tab bar at x=0): no
offset.

**Glass + islands (agent layout look).** With the flag, `computeWindowLayout`
gets `islands: { gap: ISLAND_GAP (8), radius: ISLAND_RADIUS (12) }` (`layout.ts`,
unit-tested) and the geometry above is replaced by: tab bar full width at the
top (it also holds the traffic lights); below it two rounded islands, the panel
at `x = gap`, then `gap`, then the tab area (active tab view + empty-state view),
then `gap` to the right edge, and `gap` to the bottom edge. Default window
1440x900: panel `{x:8, w:380}`, tab area `{x:396, w:1036}`, both `y = tab-bar
height`. `tabStripLeft` = the tab area's left edge (396), so the strip lines up
with the tab island. `radius` is returned by the layout; `window.ts` applies it
with `WebContentsView.setBorderRadius` (Electron 43) to the panel and empty view
in `layout()` and to every tab view at creation (`ISLAND_RADIUS`). `rim` is
`null` in this mode: no `windowRim` view and `WINDOW_EDGE = 0` (the 1px rim stays
for flag off). Glass: the existing macOS `vibrancy: "under-window"` +
`visualEffectState: "active"` on the BaseWindow; the tab bar view background is
`#00000000` and `[data-layout="agent"]` in `tabbar.css` makes body/rows
transparent, so the vibrancy shows through the bar and the gaps. Non-macOS: no
vibrancy, `win.setBackgroundColor` (`glassColorForTheme`: `#e4e6ea` light,
`#2b2b2e` dark, updated in `pushState`) stands in for the glass. Islands are
opaque, theme-matched (`backgroundColorForTheme`: white / `#1a1a1a`). The
snapshot carries `layout: "agent"` (`tabbarLayoutKind`), `renderer.ts` writes it
to `data-layout` on `<html>`; flag-specific tab styling (transparent inactive
tabs, translucent active fill `--glass-tab-active`, hover `--glass-tab-hover`,
8px radius, no hairlines, glass "+" and address row) lives only under that
selector, tokens in `tokens.css`. Address row and "+" (agent layout): the "+" button sits at the right edge of the tab bar (8px in). The panel island always starts at the tab ROW height (38, `tabRowHeight` in `layout.ts`); only the tab area starts below the address row (70). The address row is painted in the island colour (`--island-bg`, = the frontend's `--color-surface-panel`: `#fff` / dark `#2a2a2a`, also `backgroundColorForTheme` dark and the empty view) as the top of the tab island: it is inset to the tab area's x-range with 12px rounded top corners, and the tab bar view is `radius` px taller than the row (layout `tabbar.height` = 70 + 12) with a `::after` tail in island colour under the tab view's rounded top corners (tab views are above the tab bar in z-order), so no glass notch shows. Known cosmetic: the page's own rounded top corners show against the white tail.

Theme and tint (agent layout only): the app/OS appearance is NEVER changed
(no `nativeTheme.themeSource`: it is app-wide and would flip `prefers-color-scheme`
for browser tabs, isolated sessions and QA runs). The vibrancy keeps following the
OS; a plain `View` (`glassTintView`, bottom-most child, macOS only, no page/IPC) paints
a translucent editor-theme colour over it: `glassTint(theme, osDark)` in
`windowTheme.ts` (pure, tested) gives `rgba(244,245,248,a)` for light and
`rgba(28,28,30,a)` for dark with `a = 0.35` when the editor theme matches the OS
appearance (wallpaper stays visible) and `0.85` when it differs (a light editor on
a dark OS still reads light glass, and vice versa). `window.ts` re-applies it on
each `pushState` and on `nativeTheme` `updated` (OS change). Non-macOS keeps the
solid `win.setBackgroundColor`. The frontend ignores the OS (stored `ui-theme`,
default light), so the system fallback here is "light"; with no editor theme
reported yet, main reads the panel page's `html.dark` (`readPanelTheme`) and
`adoptPanelTheme` (windowTheme.ts) adopts it. The panel has no channel, so it is
re-read on its own document load (`isPanelDocument`: not the offline fallback), on
window focus and, throttled to 1/s, on every push while no editor tab reported a
theme; an editor's own report always wins. Island radius comes from the layout
only (`islandRadius`, applied to the panel, empty view and all tab views when it
changes). Vibrancy material stays `under-window` (`sidebar` renders identically;
`menu` is ~3 levels darker; `header` is near opaque); `screencapture -l` does not
include the blurred wallpaper, so that effect needs a real-screen check. Screenshots: opt-in
`e2e/bench-agent-layout-screens.spec.ts` (`00-empty.png` is the placeholder).

The panel is NOT a tab: not in `TabManager`, not in the tab bar, never passed
to `mcpService.registerTab`, so it has no MCP access (it does get `browser:command`, owner-checked, see "Canvas link"). Its
`webPreferences` come from `secureWebPreferences` (`webPreferences.ts`, shared
with the tab bar and editor/browser views); its preload `src/preload/agentPanel.ts`
exposes only `window.penAgentPanel = { version: 2, canvas, browser }` (see "Canvas link"). Navigation
(`decidePanelNavigation`, `attachPanelNavigationPolicy` in `navigation.ts`):
same origin AND the panel path or a subpath stays; any other same-origin URL
(`/app`, `/`) is denied in the panel and opens a new editor tab (the canvas
tab URL below; `TabManager.newTab` takes no URL); other origins go to the
system browser. The offline fallback applies. Its background is theme-matched
like tab views (system theme at creation, tab-bar theme in `pushState`). It is
closed in the window's `closed` handler next to the tab bar view. Test:
`e2e/agent-layout.spec.ts` (set `AGENT_LAYOUT_SHOT=<png>` to save a composite
screenshot of the views).

**Canvas tabs.** With the chat in the left panel, editor tabs load the editor
chatless: `resolveCanvasTabUrl(editorUrl)` (`config.ts`) adds `chat=off` to the
RAW query string (existing `chat` params removed, every other param kept
byte-for-byte; path and hash kept), so the tab is `/app?chat=off`. The
decision is `resolveTabEditorUrl(editorUrl, agentLayout)` (`config.ts`),
called ONCE in `window.ts` (`tabEditorUrl`, handed to `TabManager`), so every path
that creates an editor tab (initial, "+" menu, Cmd+T, the panel-navigation
fallback, macOS reopen) gets it; flag off passes the plain editor URL. The
panel URL is still derived from the plain `editorUrl`. The "+" menu item reads
"New Canvas Tab" with the flag on ("New Editor Tab" off), and so does File
"New Tab" (Cmd+T); no command id changes. The frontend router may drop
`?chat=off` on a reload, so editor tabs also get `window.penDesktop.agentLayout
= true` from `preload/tab.ts`: main passes `--pen-agent-layout`
(`editorPreloadArguments`, `webPreferences.additionalArguments`, editor tabs
only) and the sandboxed preload reads it from `process.argv`. Flag off: the
property is absent. e2e: `agent-layout.spec.ts` / `smoke.spec.ts`. The canvas-link channels (`docs/canvas-link.md`) are described in "Canvas link" below.

**Empty start (zero tabs).** With the flag the window opens with ONLY the agent
panel: no initial canvas tab. Decisions are pure functions in `config.ts`:
`initialTabs(agentLayout)` (`[]` with the flag, `["editor"]` off) and
`onLastTabClosed(agentLayout)` (`"stay-empty"` with the flag, `"respawn-editor"`
off, the historical behavior); `window.ts` feeds the latter to `TabManager`'s
`onLastTabClosed` option, so closing the last tab (or the active tab when only
background session tabs remain) leaves zero tabs and the window open. A tab
opens when the panel calls `canvas:open` or the user opens one ("+" menu,
Cmd+T, placeholder). Zero-tab safety: snapshot has `tabs: []`, `activeId` and
`activeKind` null, `mcpActiveWebContentsId` null (the MCP dispatcher answers its
existing "No editor tab is open."), `editorTabsInfo()` empty (the router's
`syncTabs` clears the list), `nextTab`/`prevTab`/`closeTab`/`activate` no-op. Menu
commands that target the active editor tab (`forwardToActiveTab`: File Open,
Export..., Import/Export Design Tokens) are a **no-op** with no tab (they do NOT
open a canvas tab: the editor must be loaded before it can handle a command);
Close Tab is `decideCloseTarget` "window" with zero tabs (closes the window, like a browser; "none" when only background session tabs remain). A new non-session tab becomes active when none is active, even if requested in the background (`activate:false`). macOS dock `activate` reopens a window
the same way (panel only). **Placeholder:** while `activeId === null` with the
flag, a local view (`src/tabbar/empty.html` + `empty.css` + `emptyRenderer.ts`,
same CSP as the tab bar, light/dark tokens shared via `tokens.css`, no remote content) covers the tab
area with "Canvas and browser tabs open here." and two buttons, "New Canvas Tab"
and "New Browser Tab". It has its OWN minimal preload (`src/preload/empty.ts`: `newCanvasTab`,
`newBrowserTab`, `onTheme`); its buttons send `tabbar:new` / `tabbar:new-browser`
(the same actions as the "+" menu; main accepts them from the tab bar or this
view via `isTabCreationSender`). Visibility, theme and focus decisions are pure
(`emptyView.ts`, applied on change only); bounds (`tabArea`) follow `layout`.
e2e: `e2e/empty-start.spec.ts` (`EMPTY_START_SHOT=<png>` saves a composite screenshot).

## Canvas link (agent layout flag)

Protocol, roles and message rules: `docs/canvas-link.md` (a copy; the source is pen-editor `docs/canvas-link.md` and `src/lib/canvasLink/protocol.ts`). Everything here exists only with `PEN_DESKTOP_AGENT_LAYOUT=1`; flag off creates no router, registers none of the `canvas:*` channels and the preloads expose nothing new on editor tabs.

- **Router** — `src/main/canvasLink.ts` (`CanvasLinkRouter`, pure; Electron injected like `tabManager.ts`; one per window, created in `window.ts`). The tab id on the wire is the tab's **webContents id** (like MCP `tabId`). Registry: per tab a `registrationId` (counter kept per tab, +1 on every `canvas:register`, so a reload gets a new one; a second register without a gone first sends `tab-gone` for the old one), the title and the activation order. `listTabs()` is ordered most recently active canvas tab first (never-activated tabs: latest registered first); `active` marks the tab active in the strip. `window.ts` feeds `syncTabs()` from `pushState` (`TabManager.editorTabsInfo()`; the router ignores a call that changed no tab, title or activation), and `canvas:tabs` is pushed only when the serialized list changed (register, gone, title, activation).
- **Routing** — panel→tab `canvas:to-tab {tabId, env}` only to registered tabs, else `{kind:"error", refId: env.id}` comes back to the panel (as `canvas:from-tab`); tab→panel `canvas:to-panel env` is forwarded as `canvas:from-tab {tabId, env}` (main adds the sender). Payloads are never interpreted: only the envelope is checked (object, string `id`, finite number `sentAt`, object `msg` with string `kind`); malformed envelopes and the main-only kinds `error` / `tab-gone` coming from a renderer are dropped. Order is kept, nothing is batched. `tab-gone {registrationId}` goes to the panel when a registered tab is destroyed, navigates its main frame (a COMMITTED non-same-document `did-navigate`; not `did-start-navigation`, which also fires for denied navigations, 204s and downloads), sends `canvas:unregister`, or its renderer dies. A registered id that `syncTabs` no longer sees as an editor tab (a closing tab) is dropped the same way, so `canvas:tabs` never lists it as "Untitled". Main-made kinds: `error`, `tab-gone` (to the panel) and `panel-gone` (to every registered tab, `docs/canvas-link.md`).
- **Open** — `canvas:open {activate?}` calls `TabManager.newTab("editor", undefined, { activate })` (editor tabs are canvas tabs in this layout; `activate !== true` creates the tab hidden in the background: no activation, no agent pin change, no strip flash) and resolves `{tabId, registrationId}` (the registration that resolved it) when THAT tab calls `canvas:register`; it rejects after 20 s (`OPEN_TIMEOUT_MS`, timer injectable) or when the tab is destroyed or its renderer dies first. A navigation of the new tab (its first load) does not reject it.
- **Sender checks** — `canvas:register` / `canvas:unregister` / `canvas:to-panel`: this window's editor tabs only (`TabManager.isEditorTab`; `unregister` and `to-panel` only when registered); `canvas:list|open|activate|to-tab`: this window's agent panel webContents only (others get `[]`, a rejection or silence). Listeners are added per window and removed in the window's `closed` handler.
- **Preloads** — editor tab: `window.penDesktop.canvasHost = { register, unregister, post, onMessage }`, exposed only when the `--pen-agent-layout` argument is present (same mechanism as `agentLayout`). Panel: `window.penAgentPanel = { version: 2, canvas: { listTabs, openTab, activateTab, post, onMessage, onTabsChanged }, browser }`.
- **Panel browser access** — the panel's browser tools run in the panel, with or without a canvas tab. `penAgentPanel.browser` has the same shape as `penDesktop.browser` (incl. `isolated(id)` and `closeSession(id)`) over the same `browser:command` invoke. A sandboxed preload cannot import `tab.ts`, so the code is a copy; `test/ipcContract.test.ts` pins both to the same command set. Main accepts the sender if it is an editor tab OR the panel (`isBrowserOwner` in `window.ts`). The panel's identity is its **webContents id**, used exactly like an editor tab's: it owns isolated sessions (`BrowserSessions` owner), checkpoint journals (`JournalOwners`, `isBrowserOwner` as the liveness check) and the shared fixture. When the panel reloads (a COMMITTED main-frame navigation: `did-frame-navigate` with `isMainFrame`; never `did-start-navigation`, which also fires for denied navigations, 204s and downloads) or its renderer dies, main releases the shared fixture, stops its journals and closes its sessions (`closeSessionsOwnedBy`), tells every registered canvas tab `{kind:"panel-gone"}` (main-made, on `canvas:from-panel`; the tab cancels in-flight work and abandons open streams) and resets the router's `canvas:tabs` dedupe (the reloaded panel gets a fresh push at `did-finish-load` and on `canvas:list`); on window close its sessions are closed and forgotten. Nothing else widens: no MCP for the panel (`mcpService.registerTab` is never called for it), and a browser/panel id is never a canvas tab.
- Tests: `test/canvasLink.test.ts` (router), `test/preloadCanvasLink.test.ts`, the channel table and command-set checks in `test/ipcContract.test.ts`, `e2e/canvas-link.spec.ts` (list, both directions, openTab, tab-gone on close/reload, panel browser) and `e2e/agent-layout.spec.ts`.

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
- `tabbar:new-browser` tabbar/empty-state→main (sender-checked) — a user-driven browser tab (`newUserBrowserTab`); sent by the empty-state placeholder only (agent layout, `preload/empty.ts`)
- `tabbar:new-menu` tabbar→main (sender-checked; `{x, y}` window coords) — the "+" button: main pops a native menu (New Editor Tab / New Browser Tab; "New Canvas Tab" instead of "New Editor Tab" with the agent-layout flag), since an HTML popup would be clipped to the tab bar view's height. `tabbar:new` is sent by the empty-state placeholder's "New Canvas Tab" button (agent layout); e2e also drives it through `penTabbar.newTab()`, which a native menu can't be clicked through
- `tabbar:tools-menu` tabbar→main (sender-checked; `{x, y}` window coords) — the browser chrome row's gear button: native menu (Viewport emulation via CDP, Open/Close Developer Tools, Zoom) for the active browser tab; builder in `src/main/browserToolsMenu.ts`
- `tabbar:navigate` tabbar→main (sender-checked; `{action: "url" | "back" | "forward" | "reload", url?}`) — the address row driving the active browser tab, see "Built-in browser tab" below
- `mcp:register` tab→main (`{protocol, tools} | null`; `null` unregisters) — desktop MCP bridge, see below
- `mcp:call` main→tab only (`{callId, tool, args}`)
- `mcp:result` tab→main (`{callId, type: "tool_result" | "tool_error", result?, error?}`)
- `browser:command` tab→main, **invoke/handle** (request-response, unlike every other channel above) — `{command: "open" | "act" | "findImages" | "snapshot" | "perform" | "read" | "screenshot" | "tabs" | "capture" | "applyFixture" | "releaseFixture" | "clearActEmulation" | "fillLogin" | "startJournal" | "stopJournal" | "captureCheckpoint" | "assert" | "closeSession", args, session?}`, sent only by an *editor* tab's preload (or, with the agent layout flag, the agent panel's: `window.penAgentPanel.browser`) and verified against the registered editor tabs / the panel's webContents before acting; `session` (optional) routes to an isolated session, `closeSession` ends one (no new channel); see "Built-in browser tab" and "Isolated sessions" below
- Canvas link (agent layout flag only; section "Canvas link"): `canvas:list` / `canvas:open` panel→main, **invoke/handle**; `canvas:activate` / `canvas:to-tab` panel→main (sender: the panel); `canvas:register` / `canvas:unregister` / `canvas:to-panel` tab→main (sender: an editor tab; `unregister` and `to-panel` only when registered); `canvas:from-tab` main→panel (`{tabId, env}`), `canvas:tabs` main→panel (`CanvasTabInfo[]`), `canvas:from-panel` main→tab (`env`; also the main-made `panel-gone` message)
- `passwords:list` / `passwords:add` / `passwords:update` / `passwords:remove` / `passwords:never-remove` Passwords window→main, **invoke/handle**, each sender-checked against that window's own webContents; handlers are registered when the window opens and removed when it closes. No reply ever holds a password — see "Saved logins" below
- `passwords:theme` main→Passwords window, payload `{ theme: "light" | "dark", vibrancyMatches: boolean }`. `theme` is the tab-bar theme (`tabbar:theme`) of the main window the user focused last (BaseWindow `focus`; each window's push is kept under its own key in `themeSource.ts`). If that window is closed or none was focused yet, the latest push of any open main window applies; with none left it follows `nativeTheme` again. `vibrancyMatches` is false when `theme` differs from the OS appearance: macOS sidebar vibrancy follows the OS, so the renderer then paints the sidebar opaque (`data-opaque-sidebar`). Pushed on window load and whenever the effective `{theme, vibrancyMatches}` changes (an unchanged value is not re-sent)
- `passwords:changed` main→Passwords window, no payload. Sent when a site icon was stored (favicon fetched). The renderer re-reads `passwords:list` and refreshes the sidebar, rows and, in view mode only, the detail pane; an open Add/Edit form is never rebuilt

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

`tools/list` serves the static `src/main/mcp/toolManifest.json` (30 tools: the
26 backend `BRIDGED_TOOL_NAMES`, the 3 static guideline tools, and desktop-only
`list_editor_tabs`; every tool except `list_editor_tabs` also gets an optional
`tabId`). Do not edit the JSON: it is written by `npx tsx
scripts/gen-tool-manifest.ts` from the hand-maintained `TOOLS` array and
`TOOL_META` table (title + annotations, mirroring the backend's
`src/mcp/toolAnnotations.ts`; `destructiveHint` must match). The script then
greps the sibling backend for drift (set `PEN_BACKEND_DIR` to point it at a
backend worktree). `test/toolManifest.test.ts` pins the names against the
backend's `toolNames.ts` (same `PEN_BACKEND_DIR` override).

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
File menu's "MCP: …"/"Use this app for MCP" items (see `menu.ts`) are the only
diagnostics available, since a packaged app has no terminal. (The tab strip
used to show a status dot too; it was removed 2026-09-24. `mcpStatus` is still
in the tab snapshot but the tab bar no longer renders it.)

## Built-in browser tab

> **Controller moved to a package.** `BrowserController`, the injected page
> scripts, key parsing, `decideBrowserNavigation` and `BrowserTabInfo` come from
> `@sideform/browser-agent/controller` (runtime dependency
> `github:dan-rozhkov/browser-agent#v0.2.1`). Renovate (`renovate.json`) opens bump PRs for `@sideform/browser-agent` only. Patch bumps automerge on green CI. Minor bumps are breaking in 0.x and need a human. Their design notes and fix history
> are in the package: `browser-agent/docs/controller-notes.md` (path mapping in
> its header). This repo keeps the Electron side, described below: `window.ts`
> (`BrowserTarget`/`BrowserPageHandle` over `WebContentsView`), `navigation.ts`,
> `browser/permissions.ts`, `tabManager.ts`, IPC and e2e. The package is
> ESM-only; the CommonJS main process loads it with `require()` (Electron 43 /
> Node 24), types via its `typesVersions`.

A second `TabKind` (`tabManager.ts`'s `"editor" | "browser"`) — a real
browser tab the design agent can drive to pull visual references from the
open web (Pinterest in particular). Design spec:
`docs/superpowers/specs/2026-09-18-builtin-browser-design.md`.

**Agent-activity icon.** While the agent drives a browser tab, the tab strip
shows the agent's cursor arrow before that tab's title (blue on the active
tab, pale grey on an inactive one, no animation; editor tabs never). Only
page-driving `browser:command`s count (`isAgentPageCommand` in
`src/main/agentActivity.ts`: not journal/checkpoint/`releaseFixture`, not
`tabs` `list`, not unknown commands). `window.ts` calls `begin(tabId)`/`end(tabId)` on the
pure per-tab tracker (`createTabAgentActivity`) with the tab the command
started on, and `pulse(tabId)` on the tab it landed on if that differs
(`tabs new`/`switch`, popups). Each tab has its own in-flight count and holds
"working" for `AGENT_ACTIVITY_IDLE_MS` (4s) so the icon does not flicker while
the LLM thinks between steps, so parallel isolated sessions light their own
tabs and one finishing never clears another's; a session with no tab yet marks
nothing. `TabManager.setAgentTabWorking` turns this into
`TabsSnapshot.agentTabIds`: the marked tabs that are still live browser tabs.
There is no fallback: closing a tab clears its icon, and user tab switches
do not move it until the next agent command. It rides on `tabbar:state` (no
extra IPC channel). The renderer draws the same arrow geometry as the in-page
cursor from `@sideform/browser-agent`, plus a visually hidden "Agent is
working" label.

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
against `isBrowserOwner` (`orphanRelease.ts`): `TabManager.isEditorTab()` — the
single source of truth for "which webContents id is an editor tab" (there used
to be a second, ad hoc `Set` kept in `window.ts` alongside it; the two could
drift, so it was deleted) — OR, with the agent layout flag, the agent panel's
webContents id (its preload carries a copy of the same bridge; the copy is
pinned identical by `test/preloadBrowserBridge.test.ts`).

Ownership of the SHARED browser's fixture is per sender, like the journal:
`src/main/fixtureOwners.ts` records which webContents (editor tab or panel)
applied it and its token. The owner is recorded when `applyFixture` STARTS (pending): a sender that reloads, crashes or closes mid-apply marks the in-flight fixture, and `finishApply` hands back the release (also when the sender is no longer a live browser owner). An editor tab's committed reload/close releases only a
fixture it owns, and the panel's reload/crash/window close only the panel's.
The panel's orphans (fixture, journals, isolated sessions) are released on
`render-process-gone` and on a COMMITTED main-frame navigation (`did-frame-navigate`, `isMainFrame` passed to `isOrphaningEvent`),
never on `did-start-navigation`, which also fires for navigations the panel policy
denies, 204s and downloads (`isOrphaningEvent`, `orphanRelease.ts`).

Popups (`target="_blank"`, `window.open`) inside a browser tab open as a new
browser tab (`navigation.ts`'s `attachBrowserTabPolicy` /
`decideBrowserNavigation` — any http(s) URL is allowed, anything else is
denied) rather than escaping to the system browser via `shell.openExternal`,
unlike editor tabs' `attachNavigationPolicy`.
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
**`PEN_DESKTOP_USER_DATA_DIR`** overrides Electron's `userData` directory
(`config.ts`'s `resolveUserDataDir`, applied in `index.ts` via
`app.setPath("userData", …)` before `app.ready`; empty = unset).
`e2e/userDataIsolation.ts` (called from all three Playwright configs) sets it to
a temp dir that is fresh per Playwright RUN and shared by that run's launches
(every spec spreads `process.env` into its `electron.launch` env) — enough to
keep a developer's saved cursor settings out of e2e. `e2e/globalTeardown.ts`
deletes the dir afterwards (only one the helper created; an explicitly set
`PEN_DESKTOP_USER_DATA_DIR` is left alone).
**Rename "Pineapple Editor" -> "Sideform Desktop" (2026-10-18) and data
continuity.** The visible name is `DISPLAY_APP_NAME` (`config.ts`), applied with
`app.setName` AFTER ready (app menu labels) plus `app.setAboutPanelOptions({ applicationName })` for the About box. The `appId`
(`com.peneditor.desktop`), `PEN_DESKTOP_*` env vars and `~/.pen-editor` stay.
Two things derive from the app name and hold user data, so
`resolveStorageIdentity` (`config.ts`, pure, injected fs, tested) picks them once
BEFORE ready: (1) `userData`: env `PEN_DESKTOP_USER_DATA_DIR`, else the new
`<appData>/Sideform Desktop` dir if it exists, else the legacy
`<appData>/Pineapple Editor` if it exists as a directory, else the new dir;
(2) the safeStorage Keychain item `"<name> Safe Storage"`, sticky and tied to
the directory in use: `storage-identity.json` (`{ storageName }`) in userData
wins; else the legacy name when the dir is the legacy dir; else the new name.
`index.ts` writes that file once (best effort) after resolving.
Verified by experiment on Electron 43.8: the Keychain name is fixed at ready
from a `setName` called before ready (it beats the bundle's CFBundleName;
without one it is the package.json `name`); a `setName` after ready does NOT
change it. So `index.ts` calls `app.setName(storageName)` first and the display
name only after ready. Never call `setName` with a different value BEFORE ready
on an existing install. If the key ever does not match, the credentials file
is kept untouched: `list()` still shows the entries, `findForOrigin` returns
`undecryptable`, and re-saving a login re-encrypts just that entry.
`index.ts` also takes `app.requestSingleInstanceLock()` (a second launch quits
and focuses the existing window); the old "Pineapple Editor.app" does not take
this lock, so the two builds can run side by side. `UPGRADE_ERROR_MESSAGE`
(dispatcher.ts) is a contract string and keeps the "Pen Editor" wording.
**`tabs({ action, tabId?, url? })`.** `list` returns every open browser tab
(`{ tabId, url, title, current }[]`) plus which one is current; `switch`
makes a given tab the agent's current tab (and activates it in the strip);
`close` closes a *browser* tab only — an editor tab id, or an id that isn't
currently open, is a clean error, never a wrong-kind-of-tab close; `new`
opens a fresh browser tab, optionally loading a URL with `open`'s http(s)-only
semantics. Backed by four **optional** `BrowserTarget` methods
(`listPages`/`selectPage`/`closePage`/`newPage`) — `tabs()` reports "not
supported" up front if any is missing (window.ts always implements all four
together, over `TabManager.listBrowserTabs()`/`activate()`/`closeTab()`/
`newTab()`), rather than failing action-by-action.

**`TabManager.agentBrowserTabId`.** Which browser tab (by `TabManager`'s own
sequential id) the agent is currently driving. `browserHandle()` prefers this
tab while it's still a live browser tab, falling back to the pre-existing
"active if browser, else most-recently-created browser tab" rule otherwise.
Fixes upstream jev-ultrafast #61 ("the agent sticks to the old tab"): a popup
opened from a browser tab (`window.ts`'s `attachBrowserTabPolicy` callback)
sets this to the new tab, so the very next browser command targets it even
before the user has looked at the strip; `tabs({action:"switch"|"new"})`
also set it. Cleared (not repointed, unlike `lastEditorWebContentsId`) when
the tab it points at closes — `browserHandle()`'s own fallback rule already
covers "no explicit agent tab."

Review finding 4: `TabManager.activate(id)` — the path a user-initiated
tab-strip click goes through (`window.ts`'s `tabbar:activate` IPC handler) —
now also repoints `agentBrowserTabId` to `id` when the newly-activated tab is
a browser tab: **the agent follows the user's focus.** Before this,
`browserHandle()` kept preferring a stale `agentBrowserTabId` even after the
user had switched the tab strip to a different browser tab, so the next
browser command silently acted on the tab the user had left, not the one
they were looking at. Deliberately *not* folded into the private `setActive`
helper every *automatic* activation already routes through (a fresh tab, the
active tab closing, a popup's own activation via `newTab`) — see finding 7
immediately below, which needs a popup's activation to *not* by itself
repoint the agent.

Review finding 7: a popup's target now matters. `window.ts`'s
`attachBrowserTabPolicy` callback fires per browser tab (one closure per
`createView` call), so before this fix *any* browser tab's popup — even one
the agent wasn't driving — repointed `agentBrowserTabId` to the new tab,
letting a tab the user had open on the side steal the agent from whatever it
was doing. The callback now compares `tabs.browserHandle()?.getWebContentsId()`
against its own tab's id first: only a popup opened by the tab the agent is
*currently* driving sets `agentBrowserTabId` to the new tab (fixing #61, as
before); a popup from any other browser tab still opens (and, unchanged,
still becomes the *active* tab in the strip via `newTab`'s own `setActive`
call) but the agent does not follow it. This is what makes finding 4's
`activate()` change safe to add: a popup's automatic activation goes through
the private `setActive` path, not the public `activate()`, so it never
triggers "the agent follows the user's focus" on its own — only an explicit,
genuinely user-driven tab-strip click does.
**CDP session per browser tab.** `window.ts` attaches
`webContents.debugger` (protocol version `"1.3"`) once, at tab creation, only
for `kind === "browser"` — never for editor tabs, which have no reason to
need trusted input events or dialog interception. `Page.enable` is sent
immediately after a successful attach. Attach failure (most commonly: real
DevTools already attached to this tab) degrades gracefully and locally:
`sendCdp`/`drainDialogs` are left `undefined` on that tab's handle, so
`press`/`hover` report a clear `{ error: "…requires a CDP session…" }` and
dialogs on that tab simply aren't auto-handled — nothing else in this bridge
depends on the session existing. `sendCdp`/`drainDialogs` (and `capture`) are
**optional** members of both `BrowserPageHandle` (`controller.ts`, the
Electron-free interface `BrowserController` is tested against) and
`TabViewHandle` (`tabManager.ts`) — structurally identical on both sides, the
same pattern `isVisible?`/`onceDomReady` already established. The debugger is
detached in the tab's own `destroy()`, guarded by whether attach actually
succeeded.

`press`'s `Input.dispatchKeyEvent` and `hover`'s `Input.dispatchMouseEvent`
are **trusted, OS-level input events** — unlike a page-script
`el.dispatchEvent(...)`, which a real app's `keydown` handler can (and
routinely does) ignore via `event.isTrusted`, and which never triggers the
browser's own `:hover` CSS pseudo-class at all. This is the whole reason
`press`/`hover` exist as CDP-backed actions instead of two more page scripts
like `CLICK_JS`/`TYPE_JS`.

**Dialog policy.** `Page.javascriptDialogOpening` (received via the same
`webContents.debugger.on("message", …)` listener) is auto-handled per the
design doc's policy — `alert`/`beforeunload` → `Page.handleJavaScriptDialog`
with `accept: true` (there is no meaningful "no" to either), `confirm`/
`prompt` → `accept: false` (never agree to something on the user's behalf).
Every **auto-handled** dialog is pushed onto a per-tab queue (`{ type,
message }`, message trimmed to 200 chars, capped at `DIALOG_QUEUE_CAP` (10)
— oldest dropped first, so a crashed/stuck agent loop that never drains it
can't grow this unboundedly) that `drainDialogs()` empties.

Review finding 3: auto-handling only ever applies **while an agent browser
command is actually in flight.** `window.ts` keeps a window-scoped `ScopeCounter`
(`commandsInFlight`, per scope: the shared browser or one isolated session),
incremented/decremented around the whole command dispatch (`try`/
`finally` so a throwing command can't leave it stuck above zero);
`Page.javascriptDialogOpening`'s handler checks `commandsInFlight.active(<the
tab's own scope>)` — a session command never auto-answers a dialog in a tab the
user browses — and, outside a command, returns without calling
`Page.handleJavaScriptDialog` or queuing anything at all — the user sees and
answers that dialog themselves, the same as in any other browser. Before
this fix, *any* JS dialog on a browser tab — including one the user
triggered themselves by typing a URL or clicking a link with no agent
command running — was silently accepted/dismissed on their behalf, with no
way to ever see or answer it.
**Third-pass review findings.** (a) The address row's back/forward/reload/
URL entry drives `TabManager.activeBrowserHandle()` — the tab it is showing —
never `browserHandle()`, which prefers the agent's pinned (possibly hidden)
tab. (b) The pre-command dialog sweep touches only the agent's current tab
(`currentBrowserTabId()`); a dialog in a tab the user is browsing by hand is
theirs to answer, and auto-accepting a "Leave site?" would lose their input.
This refines second-pass item 1 below. (c) A command that TIMES OUT keeps
running (a promise can't be cancelled), so `BrowserController` records it as
`overrun` and the next queued command waits for that work to settle, bounded
by `OVERRUN_GRACE_MS` (10 s) — otherwise a late click or a late
`REMOVE_MARKS_JS` lands inside the next command's before/after captures.
**Unit vs. e2e split.** The unit suite (`test/browserController.test.ts`)
stubs `executeJavaScript` and a fake `sendCdp` that records every `Input.*`
call, covering the trusted/fallback branch selection, the hidden-target
error, and scroll-container argument plumbing — it cannot prove a click is
*genuinely* trusted, that a synthetic click never fires `pointerdown`, or
that `Input.insertText` fires a real `beforeinput` (React's own signal that
a change came from a real input event, not a scripted one). Those three —
plus a real inner-scroll container — are e2e-only, against a real DOM served
by `e2e/browser-tab.spec.ts`'s own stub HTTP server (`/wave2` fixture).
`electron/electron#5183` (`executeJavaScript` defers until the page stops
loading) means a child frame that never finishes loading must not hang a
whole `snapshot`/`read`/`findImages` call — every per-frame script call
(`executeScriptInFrame`) is raced against `FRAME_SCRIPT_TIMEOUT_MS` (1.5s,
enforced both in `window.ts`'s own `executeJavaScriptInFrame` and again in
`controller.ts`'s wrapper), and a timed-out or rejecting frame is simply
skipped — the command still succeeds with whatever it already had. This bit
concretely with `checkBotWall` below (a *top-document* script, not a frame
one) before it got its own short, independent timeout — see that section.

## PageFixture (`applyFixture` / `releaseFixture`)

`window.penDesktop.browser.applyFixture(fixture)` / `releaseFixture(token?)` go
through `browser:command`. Every fixture field is allowed
(`allowNetworkMocks: true`); a non-object fixture is rejected by the
controller itself (stage `validate`). Everything is scoped to the browser
partition `persist:penbrowser` and to browser tabs — the editor session and the
default session are never touched:

- `network`: `src/main/fetchRouting.ts` implements `BrowserTarget.routeRequests`
  with CDP `Fetch` (Request stage) on each browser tab's debugger session.
  Never `session.webRequest` (profile-wide). Tabs opened while routing is
  active are enabled on creation; the remover (`releaseFixture`) disables
  Fetch and lets paused requests through. `routeRequests` awaits every tab's
  `Fetch.enable` ack and throws (after undoing) if any still-registered tab
  fails (a tab closing mid-call is ignored). Enable/disable are serialized per
  tab (a late disable of a removed route can no longer switch off a newer
  route). If the agent's current browser tab has no debugger (attach failed,
  so it is not registered), `routeRequests` throws "request interception is
  not available in this browser tab" instead of reporting mocks it cannot
  deliver.
  Limits: (a) mocks apply to EVERY tab of the built-in browser
  (`persist:penbrowser`), including tabs the user browses manually, and never
  to editor tabs; rules match only the fixture's URLs, other requests pass
  through. (b) CDP Fetch is per page target: requests from out-of-process
  (cross-site) iframes and from service workers are NOT intercepted, unlike
  the cloud (Playwright context route).
- Orphaned mocks: main owns them, but the renderer's `finally` never runs when
  the editor tab that drives the agent reloads, crashes or closes. `window.ts`
  releases the editor tab's own fixture on its `render-process-gone`, a COMMITTED
  main-frame navigation (`did-frame-navigate`; a denied navigation or a 204 keeps it), and destroy. Never for browser tabs.
- Debugger `detach` on a browser tab unregisters it from the router (it clears
  that tab's `enabled` state) and sets `debuggerAttached = false`.
- `storage.cookies`: `getCookies` / `setCookies` in `src/main/fixtureSession.ts`
  against `persist:penbrowser`. Host-only cookies (`hostOnly`) map to a `url`
without `domain`, and `__Host-` cookies are set without `domain`.
- `fresh`: `resetSession(origins)` closes every browser tab, opens one blank
  browser tab, then clears cookies and site data (`clearStorageData` with an
  `origin`) ONLY for the fixture's own origins (all origins are validated, http/https only,
  BEFORE any tab is closed; cookies are found with `cookies.get({domain})` so
  path-scoped and Secure ones go too). Other sites' logins survive.
  Parent-domain cookies (`.example.com` for origin `https://app.example.com`)
  are kept: only the origin host's own cookies go. Cookies ignore ports, so
  `http://localhost:3000` clears localhost cookies shared by every localhost
  port (a browser limitation).
  No origins means only tabs are reset. Never call `clearStorageData` /
  `clearCache` without an origin.

## QA diagnostics (`assert`, failed requests, emulation bookkeeping)

- `browser:command` `assert` calls `BrowserController.assert(args)` (read-only
  checks; `@sideform/browser-agent` v0.2.22). It is page-driving, so isolated
  sessions get it through `BROWSER_COMMANDS`.
- Failed requests: `src/main/failedRequests.ts` (pure) records
  `Network.responseReceived` status >= 400 and `Network.loadingFailed` (not
  canceled) from the tab's debugger messages as `<METHOD> <status|error>
  <origin><pathname>` (no query/hash, ring of 50). The handle's
  `drainFailedRequests` is a getter that is `undefined` while the debugger is
  detached, so a check never passes on a tab that cannot see the network.
- `clearDiagnostics()` empties the console-error and failed-request buffers at
  `applyFixture` and at a run boundary (`src/main/runBoundary.ts`: the first
  command of a scope, or the first after 5 minutes idle), so failures from
  before a run do not count in it.
- `src/main/agentEmulation.ts` (pure) tracks which tabs an agent fixture
  emulated (device metrics or UA, seen through the agent's `sendCdp` during
  apply) per `fixtureToken`. A matching release resets the Browser tools
  Viewport radio of those tabs only. The menu itself sends through
  `sendCdpDirect`, so the user's own viewport is never taken for a fixture's.
- **`Emulation.*` before the first commit crashes Electron 43** (main process
  SIGSEGV, EXC_BAD_ACCESS at 0x0). A browser tab that never committed a
  document must not receive it. `src/main/commitGate.ts` (pure, unit-tested)
  plus `sendGated` in `window.ts`. Rules, each learned from a race:
  - `ensure()` ONLY WAITS (for a navigation EVENT, never a CDP reply:
    deadlock). It never loads anything; loading on demand cancelled a
    navigation its caller had just started. The hidden `about:blank`
    placeholder is loaded in two places only: at creation of a browser tab
    (`startPlaceholderIfIdle`, ~100 ms after creation and only if the tab has not started a navigation by then: an immediate load raced `open`'s loadURL, and a committed about:blank makes Playwright report the page early; not awaited; `handle.loadURL` waits out an in-flight placeholder because Electron resolves a superseding `loadURL` at the placeholder's finish-load) and by the gate itself when the first
    navigation was aborted with no commit (204/download: only
    `did-stop-loading`, nothing loading, capped at 3).
  - A commit is `did-navigate` OR `dom-ready` (a refused connection commits an
    error page with no `did-navigate`). The placeholder also waits for its own
    `dom-ready`, so a late one cannot satisfy a following `open`'s
    `onceDomReady`. The 10 s timeout is quiet-time: start/redirect/loading
    events re-arm it (hard cap 60 s while still loading). `render-process-gone`
    resets the commit.
  - Gated: the agent's `sendCdp`, the menu's `sendCdpDirect`, `getUaBrands`,
    and FetchRouter's awaited enable in `routeRequests` on an EXISTING tab
    (`RoutedTab.whenReady`). NOT gated: Page.enable/Network.enable at attach,
    `registerTab`'s fire-and-forget Fetch.enable (a popup's first request must
    still be mocked), the dialog handler and the login capture (both imply a
    document; gating could deadlock).
  - `getURL/getTitle/reportNavState` mask the placeholder through the gate's
    exact `isPlaceholderShown()` flag, not a URL compare: an `about:blank`
    opened on purpose is reported as such. The placeholder's history entry is
    removed once a real page commits (also on the dom-ready-only error path),
    then `reportNavState` refreshes `canGoBack`; a failed removal keeps the flag
    and retries on the next navigation event.
  Regression: `e2e/browser-emulate-first-command.spec.ts`.
- DevTools opened from the Browser tools menu coexist with the automation
  debugger on Electron 43 (verified by `e2e/browser-qa-tools.spec.ts`): the
  debugger stays attached and `press`/`hover`/`screenshot`/`assert` keep working.

## Saved logins (Passwords window, save prompt, `fillLogin`)

The browsing subagent can sign in to a site with a login the user saved in
the built-in browser, without the password ever reaching the model. Design
spec: `docs/superpowers/specs/2026-10-16-browser-saved-logins-design.md`
(backend tool `browse_fill_login` and the frontend handler are separate
changes; merge order there: backend, frontend, then this repo).

- **Store** — `src/main/browser/credentialStore.ts`, pure and Electron-free
  (cipher and fs injected, like `cursorSettings.ts`). File
  `browser-credentials.json` in `userData`:
  `{ version: 1, entries: [{ id, origin, username, label, password, lastUsedAt? }], never: [host] }`,
  `password` = base64 of `safeStorage.encryptString`. `origin` is normalized
  `scheme://host[:port]` (http/https, lowercase host, no leading `www.`,
  default port dropped; a bare host typed in the Passwords window means
  https) and matched strictly on scheme + host + port: no subdomain or
  eTLD+1 matching. The `never` list stays hostname-only. The parser accepts
  only this shape (entries without a normalized `origin` are dropped; no
  migration, unreleased). A file that is not valid JSON or has another
  `version` reads as empty and is renamed to
  `browser-credentials.json.bad-<timestamp>` before the first write (kept;
  one log line without content; if the rename fails the write is refused with
  a fixed error). The same set-aside happens when the file has ANY invalid
  entry (or a malformed `never`/`entries` field): the valid entries stay
  usable in memory, the original is kept as `.bad-<ts>` before the first
  write. Only ENOENT on read means "no file"; any other read error (EACCES,
  EIO...) counts as unreadable too (nothing overwrites it). A set-aside rename
  that fails with ENOENT (the file vanished) counts as done and the write
  proceeds. ONE instance, created in `index.ts` (app
  level, like `mcpService`) and passed into every `createMainWindow`
  together with the save-prompt state and the Passwords window manager
  (`LoginServices` in `window.ts`).
- **`browser:command` → `fillLogin`** — `src/main/browser/fillLogin.ts` (pure;
  controller `snapshot`/`perform`/`act`, store and current-URL reader
  injected). Reads the agent tab's URL (http/https only), finds the entry for
  that exact origin (scheme, host, port), takes a fresh snapshot, types into
  the top document's fields only (elements with a `frame` are skipped, so a
  login is never typed into an iframe), then optionally presses Enter via
  `act({action:"press"})`. Field picking uses only what a snapshot element
  really carries (the snapshot has no input `type` for text fields and no
  `autocomplete`; `inputType` exists for checkbox/radio only): `tag`, `ops`
  (a username field offers both `TYPE_TEXT` and `CLICK`), `role`, `options`/
  `expanded`/`checked` (not a plain field), `label`. The origin is re-checked
  before AND after every `perform`, so a mid-fill navigation to another origin
  stops the fill (no further typing, no submit; the fixed error is returned).
  **Known limit:** a cross-origin navigation that lands during the cursor
  animation inside `perform`, before its `insertText`, cannot be fully
  prevented from this layer: the keystrokes of that one call go to whatever
  page is focused then. The re-checks shrink the window to one call; closing
  it needs a check inside the controller, between the animation and the
  insert. The result is ONLY `{ ok, origin, label, filled, submitted }` or `{ ok:false, error }`
  with fixed messages; controller results/errors are never passed through.
- **Save prompt** — `src/main/browser/loginCapture.ts`. On each main-frame
  `Page.frameNavigated` of a browser tab's existing CDP session, main creates
  an isolated world (`Page.createIsolatedWorld`, name `penLoginCapture`), adds
  the binding to THAT context id (`Runtime.addBinding` with
  `executionContextId`) and runs the script there (a per-tab generation counter
  makes a late result for an older document, from `install()` or an earlier
  `frameNavigated`, discard itself, so it can never overwrite the current
  context id); page scripts cannot see
  the world, the script or the binding. NO `Runtime.enable` (a known
  automation fingerprint; the console-error capture avoids CDP `Runtime` for
  the same reason). Verified on Electron 43: a binding added BY NAME
  (`executionContextName`) plus `addScriptToEvaluateOnNewDocument` yields no
  working binding without `Runtime.enable`, while an explicit-context binding
  does, and `Runtime.bindingCalled` is delivered anyway. CDP commands on a
  tab that has not navigated yet are only answered after its first commit, so
  never `await` them before `loadURL()` (deadlock); `install()` covers the
  first document, `frameNavigated` every later one. The script runs in the
  top frame only, reacts to trusted clicks/Enter and to `submit` with a user
  activation, de-duplicates within 2 s, never captures a form with two or
  more password fields (change-password / sign-up), and is idempotent per
  world. It sends `{ username, password, origin: location.origin }` read at
  submit time. Per tab (`loginCapture.forTab()`), main accepts a binding event
  only if its `executionContextId` equals the isolated-world context it
  created for the tab's current document (the id is cleared on every
  main-frame navigation), and files the login under the payload origin, not
  the tab's later URL. It does not ask at once (a typo is "submitted" too):
  the capture is held in memory and the prompt appears only if a main-frame
  (`Page.frameNavigated`) or same-document (`Page.navigatedWithinDocument`,
  counted for the TOP frame only: its `frameId` must equal the tracked top
  frame id) navigation follows within `HOLD_MS` (5 s); otherwise it is dropped.
  A navigation alone is not success (a wrong password POSTs and reloads the
  login page): once the new document is ready (the check waits for
  `DOMContentLoaded`, bounded by `SETTLE_MS` = 3 s, then asks anyway) the
  isolated world is asked for a visible `input[type=password]` in the top
  document; if one is visible the capture is dropped with no prompt
  (`decideAfterNavigation`, pure); an unanswerable check prompts. For an
  existing entry with another password ("Update password?") the default and
  cancel button is "Not Now". `decideSavePrompt` (pure) skips on never-list,
  identical entry, no encryption, or a prompt already open (one flag for the
  whole app). If the debugger attach
  failed, the feature is off for that tab. `e2e/saved-logins.spec.ts` drives
  it end to end with the native dialog stubbed.
- **Passwords window** — `src/main/passwordsWindow.ts` (single instance,
  File ▸ Passwords…, a local action: it forwards no `menu:command` id, so
  pen-editor's pinned id list is unchanged), `src/passwords/` (plain-script
  renderer like the tab bar; CSP `default-src 'none'`), `src/preload/passwords.ts`,
  request handling in `browser/passwordsApi.ts`. Site tiles are neutral (a
  globe, or the site's icon through `<img>`; CSP adds `img-src data:` only).
  Icons never come from the Passwords window: `window.ts` listens to
  `page-favicon-updated` on browser tabs and `browser/faviconCache.ts` (pure,
  fs and fetch injected) downloads the FIRST favicon through the
  `persist:penbrowser` session (http/https, image types only, 64 KB, 3 s) for
  origins that have a saved login, keeping data URLs per origin in
  `browser-favicons.json` (200 entries). Each icon is stored with the favicon URL it came from: a page that later
  reports another URL is refetched, a failed fetch of a URL is retried after
  10 minutes (not for the whole run). The icon of an origin goes when its last
  login is removed (`passwordsApi.remove`) and icons of origins without a login
  are filtered out on load. `passwords:list` adds an optional `icon` per entry;
  an icon seen before the login was saved is fetched in the background on the
  next `list`, and every stored icon (that one or one from
  `page-favicon-updated` while the window is open) sends `passwords:changed`,
  so the tiles update without a manual refresh. The data-URL pattern for icons
  is a single copy, `isIconDataUrl` in `src/passwords/helpers.ts` (main
  `require`s it; the renderer, a plain script, uses it as a global).
  `passwords:add` answers `{ ok:false, exists:true, id }` when a login for the
  same normalized origin + username exists, and replaces its password only
  when the payload carries `replace: true` (the New login form shows an inline
  warning and a "Replace" button first). A save reply that arrives after its
  form was discarded or replaced only refreshes the list data. Copy on encryption is platform-specific (`api.isMac`). The
  application menu is
  app-global, so while this window is focused EVERY main-window menu action
  (new tab, open, export, tab switching...) is ignored and File ▸ Close Tab
  (Cmd/Ctrl+W) closes this window (`closeTarget.ts`: `MENU_ACTION_SCOPE`,
  `decideMenuAction`, `guardMenuActions`, pure; a new `MenuActions` key will not
  compile until it has a scope). The guard is wired in `window.ts`; `menu.ts`
  still forwards every click untouched, which pen-editor's
  `desktopMenuContract` relies on. App-level items (Passwords…, MCP publish,
  cursor prefs) still run. macOS `activate` counts main windows only
  (`shouldReopenMainWindow`), so a lone Passwords window does not suppress the
  reopen. In `window.ts`'s debugger `message` handler the login binding
  (`isLoginBindingCall`) is consumed FIRST and returns, before the
  `cdpEventListeners` fan-out: the password-bearing payload reaches nothing
  else (`test/loginBindingRouting.test.ts` pins the order).

Security rules (breaking one is a bug even when the feature works):
1. A password exists as plaintext only in the main process and inside the
   `text` of one `perform` call. Never in a tool result, error, log line,
   IPC reply, window title, dialog text or analytics event. Captured
   passwords live in memory until the user answers the prompt.
2. `passwords:list` returns origin, username, label — never a password. The
   renderer sends a password in (`passwords:add` and `passwords:update`) and never gets it back; both answer `{ ok: true, id }` with the saved entry id only.
3. Fill only into a page whose normalized origin (scheme, host, port)
   equals the entry's, top frame only.
4. A page must not trigger the save flow by itself or read the store: the
   binding exists in the isolated world only, and the script needs trusted
   input or a user activation. The renderer-side store is not reachable
   from any page (no preload on browser tabs).
5. `fillLogin` returns fixed error strings; do not forward controller text.

## Checkpoint journal (`startJournal` / `stopJournal` / `captureCheckpoint`)

`window.penDesktop.browser.startJournal(opts?)` / `stopJournal(token?)` /
`captureCheckpoint(token?)` go through `browser:command` and call the
`BrowserController` methods of the same name (`@sideform/browser-agent`
v0.2.16). `startJournal({origins?})` resolves to the owner token (a string), or
`{error}` when another editor tab is recording; `stopJournal({token})` resolves
to a boolean; `captureCheckpoint({token})` resolves to `CheckpointResult`
(`{ok:true, fixture, complete, gap?, summary}` or `{ok:false, error}`). The
journal lives in the main-process controller (one per window, shared by all its
editor tabs) and records the agent's state-changing steps after the last new
document. Args are untrusted: `src/main/checkpointArgs.ts` accepts `origins`
only as an array of at most 20 strings of at most 512 chars (`[]` is valid,
absent means defaults). Malformed `origins` make `startJournal` return
`{error: "invalid origins"}`. Journal `token` args are a string of at most 512
chars, else ignored; `releaseFixture` passes its token as is.

The checkpoint holds secrets (cookies, storage of the listed origins; default is
the base page's origin only). It is returned to the calling editor tab (or the agent panel) only,
and the editor keeps it in memory; main never stores or logs it.

Ownership: because the controller is shared, `src/main/journalOwners.ts`
(pure, tested) maps token -> owner webContents id. A start from tab B while a
live tab A owns a journal is refused without touching the controller; the owner
may restart its own. `stopJournal` and `captureCheckpoint` require a token owned
by the sender, else `false` / `{ok:false, error}`; no tokenless call ever
reaches the controller.

Isolation: a page-changing `browser:command` (all but `snapshot`, `read`,
`screenshot`, `findImages`, `capture`, `captureCheckpoint`, `stopJournal`,
`startJournal`, and `tabs` with action `list`) from a tab that does not own the
running journal first stops that journal. The owner then gets no checkpoint
(its capture fails) instead of one with another tab's steps. An owner mapping
older than 20 minutes may be taken over by another tab's start; this frees a
lock left by a missed stop.

Orphan stop: an editor tab that reload/crash/close skips its renderer cleanup,
and a running journal costs marker reads on every page-changing command. So
`window.ts` calls `journalOwners.stopOwnedBy(viewId)` in the same three places
as `releaseFixture()`: `render-process-gone`, a committed main-frame navigation
(`did-frame-navigate`; also fires on a tab's first load; harmless, the tab owns
nothing yet), and destroy of an editor tab. It stops only the journals that tab
owns, with their tokens. Never for browser tabs.

## Isolated sessions (`browser.isolated(id)` / `browser.closeSession(id)`)

Design: `docs/superpowers/specs/2026-10-17-isolated-parallel-browse-design.md`
("Desktop contract"). A private browser per QA run so several run at once
without sharing cookies, tabs, fixtures or mocks. The shared browser
(`browser.*` without `isolated`) is unchanged.

- **API** (`src/preload/tab.ts`): `browser.isolated(id)` returns the same methods
  as `browser`, each call adding `session: id` to the `browser:command` payload
  (contextBridge proxies the returned object, e2e-verified). `isolated(undefined)`
  still sends the key, so main rejects it: a lost id never falls back to the
  shared browser. `browser.closeSession(id)` sends `{command: "closeSession", session}`.
- **Every decision is pure** in `src/main/browserSessions.ts` (`window.ts` only
  adapts Electron): id pattern `^[A-Za-z0-9_-]{1,64}$` (key present with a bad
  value is an error, key absent is shared); `planSessionCommand` (what a command
  gets given the session's state: unknown command, foreign, missing, closed,
  live); `PartitionPool`; `BrowserSessions` (ownership, in-flight tracking,
  tombstones, orphan lookup); `ScopeCounter`.
- **Which commands create.** Only `open`, `tabs` with `action: "new"`,
  `applyFixture`, `startJournal`. Any other command on a missing session →
  `{error: "no such browser session"}`; `releaseFixture`/`clearActEmulation`/`stopJournal`/
  `captureCheckpoint` answer naturally (`{ok:true}`, `{ok:true}`, `false`, `{ok:false,error}`
  with the shared `ERR_NO_JOURNAL`). Unknown commands never create. Validation
  happens before any partition is taken.
- **Tombstones.** `closeSession` (also for an id that never existed or is still
  waiting for a slot) remembers the id (tombstones are keyed by (owner editor tab, id), so one
  tab's close never blocks another tab's id, and are dropped when the owner is
  destroyed, not on reload; cap 10 000, oldest evicted;
  a creation still waiting for a slot is cancelled by the close): every later command →
  `{error: "browser session closed"}` (cleanup commands keep their natural
  answers). A closed id is never recreated; run ids are unique per run.
- **Partition pool (app-global, all windows).** 6 slots `qa-0`..`qa-5`, memory
  only (no `persist:`); `denyAllPermissions` once per slot. A session takes a free
  slot; on close the partition is wiped (`clearStorageData` + `clearCache`) and
  only then the slot returns. Cap = pool size. With no free slot the creating
  command waits FIFO up to 60 s (`PEN_DESKTOP_SESSION_SLOT_WAIT_MS` overrides, for
  tests), then `{error: "too many parallel browser sessions"}`.
- **Per-session state:** its own `BrowserController` (built by the same
  `makeController` factory as the shared one), `BrowserTarget`, `FetchRouter`
  (a mock never touches another session or the shared tabs) and `JournalOwners`
  (the shared journal guard is skipped). `fresh` clears only that partition.
- **Pending creation counts as existing.** A command arriving while the session is
  still being created waits for it (`stateOf` → `pending`). A throwing create
  releases the slot and gives the creator and every waiter `{error: "could not
  create browser session"}`.
- **One command list.** `src/main/browserCommands.ts` (`BROWSER_COMMANDS`,
  `PAGE_DRIVING_COMMANDS`) feeds the session planner and the agent-activity icon;
  `test/ipcContract.test.ts` pins the `window.ts` dispatch switch and the preload
  to it.
- **Tab scoping.** `TabEntry.session` + a `scope` argument on every browser-tab
  lookup in `TabManager` (undefined = shared). A scope never sees another
  scope's tabs and the agent pin is per scope, so the shared agent cannot drive a
  session tab and vice versa. A popup of a session tab opens in the same session and is loaded through ITS OWN
  handle (it is a background tab, so the active tab is the editor or the user's
  browser). `tabs switch` in a session only repoints that session's agent tab (no
  activate/focus). A user click or tab-cycle on a session tab does not repoint the
  session's agent tab (only shared tabs follow the user's focus). Closing the active
  tab never auto-activates a session tab: with only session tabs left an editor tab
  is respawned (agent layout flag: the window stays at zero active tabs instead).
- **Background tabs.** A session tab never becomes active and gets no address-bar
  focus (`setVisible(false)`); the editor keeps focus. The user clicks it to
  watch. A hidden session tab still screenshots. Shared tabs behave as before.
  Limit: on Linux a never-shown view MAY not paint, so `screenshot` of a
  session tab may answer `Screenshot capture failed (empty image).` (`capturePage`
  `stayHidden` does not help). It depends on the Chromium build / compositor, so
  e2e accepts either that exact error or a JPEG on Linux (it flipped on CI on
  2026-10-18 with no change in the screenshot path). macOS always captures it
  and e2e requires the image there.
- **Saved logins work (fill only):** `fillLogin` runs in a session against that
  session's agent tab (`tabs.browserHandle(sessionId)`), so parallel runs can sign
  in under different saved accounts of one site: `label` picks the account by
  label, else by username (case-insensitive; the "unknown label" reply lists
  labels only, never usernames). Save-password capture and the favicon cache are
  still not installed on session tabs. (Changed 2026-10-17; it used to answer
  `saved logins are not available in an isolated session`.)
- **Ownership:** a session belongs to the editor tab that created it; any other
  editor tab gets `{error}`.
- **Close** (idempotent; a second `closeSession` returns the SAME promise, resolved
  when teardown finished; `BrowserSessions.close`): the owner is checked first (a
  non-owner closes and tombstones nothing), then tombstone → wait for in-flight
  commands (30 s) → if still running, close the session's tabs FIRST (unblocks stuck
  commands) and wait once more (30 s) → release fixture, stop journal, close tabs and
  wait until every session webContents is really destroyed → `closeAllConnections`,
  `clearStorageData`, `clearCache`, `clearAuthCache`, `clearHostResolverCache`, then
  verify `ses.cookies.get({})` is empty → return the slot. Commands still stuck after
  the second wait, a failed wipe step, a leftover cookie or a failed destroy
  **quarantine the slot** for the rest of the app run (logged); the session itself is
  dropped from the registry (controller and router freed) and does not count in `size`.
  A slot whose deny-all permission policy threw (`SlotUnusableError`) is quarantined
  too: the policy is marked only after it worked. Once closing, a command or popup can
  no longer open a tab for the session (`requireLiveSession`). Orphans (owner
  committed main-frame navigation, `render-process-gone`, destroy) close all the owner's
  sessions, including ones still waiting for a slot (the waiter leaves the pool queue
  and the creating command gets `browser session closed`), next to `releaseFixture`.
- Tests: `test/browserSessions.test.ts`, the scope/background blocks in
  `test/tabManager.test.ts`, `createTabAgentActivity` in `test/agentActivity.test.ts`,
  the `isolated` block in `test/preloadTab.test.ts`, the command check in
  `test/ipcContract.test.ts`, and `e2e/browser-sessions.spec.ts`.
