# CLAUDE.md — pen-editor-desktop

Thin Electron shell for pen-editor. The editor itself is NOT here — each tab
is a `WebContentsView` loading the deployed frontend
(`https://app.sideform.pro/app`, override with `PEN_DESKTOP_URL`;
`npm run dev` points it at a local Vite dev server on :5173). The frontend
serves its showcase gallery at `/` and the editor at `/app`, so both the
default URL and any override must include the `/app` path — an override is
used verbatim. The AI backend stays remote. Design spec: `docs/superpowers/specs/2026-07-18-electron-shell-design.md`.

## Commands

```bash
npm run build     # tsc + copy static files → dist/
npm start         # build + launch Electron
npm run dev       # same, against http://localhost:5173 (agent layout, like every launch)
npm test          # Vitest unit tests (test/)
npm run test:e2e  # build + Playwright _electron smoke (stub HTTP server, no network)
npm run test:e2e:live  # opt-in: same shell against the DEPLOYED frontend/backend (network)
npm run lint      # tsc --noEmit (src) + tsc -p tsconfig.e2e.json (e2e/ + configs)
npm run dist      # electron-builder → release/ (mac dmg+zip, unsigned)
```

Releases: release-please (`.github/workflows/release.yml`). Every push to `main`
updates a release PR from Conventional Commits (`feat:` → minor while on 0.x,
`fix:` → patch, `feat!:` → minor). Merging it bumps `package.json`, writes
`CHANGELOG.md`, tags `vX.Y.Z` and makes the GitHub release. Do not run
`npm version` by hand. The app build (`npm run dist`) stays manual.

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

## Agent layout (the only layout)

The desktop window is a chat agent docked beside the tabs. There is ONE layout:
the former classic layout (single editor tab, rim, no panel) and its flag
`PEN_DESKTOP_AGENT_LAYOUT` were removed; nothing reads that variable any more.
The main window has a left panel, a separate `WebContentsView` loading the frontend's
`/agent` page (`resolveAgentPanelUrl`: the LAST path segment `app` becomes
`agent`, base path prefix kept, `/app/` -> `/agent`; a path not ending in
`app` gets `agent` beside its last segment; the editor's query and hash are
dropped).

Geometry is the pure `src/main/layout.ts` (`computeWindowLayout`, always in islands mode).
The tab bar view spans the FULL window width, so the traffic lights stay where they are. The panel
sits BELOW the tab bar on the left; tab views get `tabArea`, to the right of the panel.
`TabManager.layout(rect)` just applies that rect; it computes nothing. Panel width is a
parameter (`clampAgentPanelWidth`: min 300, max 50% of the window; default 380); drag-resize
is not built; collapse is the sidebar toggle below.

Inside the tab bar the strip starts at the panel's right edge: `window.ts`
adds `tabStripLeft` to the existing `tabbar:state` snapshot (during the panel slide a per-frame `tabbar:strip-left` also carries it);
`renderer.ts` writes it to the CSS var `--tab-strip-left`; the tab row's left
padding is `max(--controls-end, --tab-strip-left)`, where `--controls-end` is the sidebar toggle's right edge (after the macOS traffic lights); the address
row margin uses `--tab-strip-left`. The row stays a window drag region, so the part of
the bar above the panel is an empty draggable title area. Popup anchors (new
tab, browser tools) are tab-bar CSS px = window coords (tab bar at x=0): no
offset.

**Glass + islands.** `computeWindowLayout` gets
`islands: { gap: ISLAND_GAP (8), radius: ISLAND_RADIUS (12) }` (`layout.ts`, unit-tested):
the tab bar full width at the top (it
also holds the traffic lights); below it two rounded islands, the panel at `x = gap`, then
`gap`, then the tab area (active tab view + empty-state view), then `gap` to the right
edge and `gap` to the bottom edge. The panel island starts at the tab ROW height (38,
`tabRowHeight`) whatever the address row does; only the tab area starts below the address
row. Default 1440x900: panel `{x:8, y:38, w:380}`, tab area `{x:396, w:1036}` (y 38, or 79
with an address row). `tabStripLeft` = the tab area's left edge. Radius: `ISLAND_RADIUS`
(12) is set ONCE per view with `WebContentsView.setBorderRadius` (Electron 43) at creation
(panel, empty view, every tab view); `layout()` only places views. There is no window rim
view and no 1px edge (`WINDOW_EDGE` and `WindowLayout.rim` are gone).

*Glass.* macOS `vibrancy: "under-window"` + `visualEffectState: "active"` on the BaseWindow;
the tab bar view is `#00000000` and `tabbar.css` makes body/rows
transparent. Non-macOS: no vibrancy, `win.setBackgroundColor(GLASS_SOLID[theme])`. `tabbar.css` has plain selectors (one layout): a transparent body, tabs on the glass, the address row as the island top.

*Controls (match the frontend ghost IconButton).* Nav buttons and the URL field (the island row) share tokens in `tokens.css`: `--btn-radius` = `calc(0.45rem - 2px)` (the frontend's `rounded-md`, 5.2px), `--btn-hover` = the frontend `--secondary` in light and `--color-surface-hover` (#4a4a4a) in dark, disabled opacity 0.5. The sidebar toggle and "+" sit on the glass like the tabs, so they keep the tab radius (8px) and `--glass-tab-hover`. Focus ring everywhere (tabs, close "x", "+", nav buttons, URL field, sidebar toggle, empty-start cards): `outline: none; box-shadow: 0 0 0 2px var(--focus-ring)`, where `--focus-ring` = the frontend `--ring` = the accent `#0d99ff` in both themes (a grey ring failed the 3:1 contrast rule). pen-editor's `desktopTokensContract.test.ts` pins these values to the frontend's. Header icons are Phosphor LIGHT (back, forward, reload, sidebar toggle, "+"); the Browser tools "⋮" is BOLD DotsThreeVertical, as in the frontend. All 16px inline SVGs. Tooltips stay native `title` and the menus stay native (an HTML popup would be clipped to the tab bar view's height).

*Font.* The tab bar and the empty start use the system UI font, like the frontend (its body is `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`; on macOS both are SF). No font file is bundled. Sizes: tab labels 12px, URL field 14px, empty start 13px.

*Colours: one place each.* TS: `windowTheme.ts` (`ISLAND_BG` light `#ffffff` / dark
`#2a2a2a` = the frontend's `--color-surface-panel`, `GLASS_SOLID`, `contentBackground`,
`FALLBACK_THEME`, `glassTint`). CSS: `tokens.css` (`--island-bg`, same values, pinned equal by
`test/windowTheme.test.ts`). Islands (panel, tab views,
empty view, address row) use the island colour, so in dark the chat and the tab island match.
The active
tab pill keeps its own translucent `--glass-tab-active` (unchanged).

*Address row.* Painted in the island colour as the top of the tab island: inset to the tab
area's x-range, rounded top corners, and it mirrors the agent chat header row of the frontend
(pen-editor `ChatPanel` `OpenChatHeader`: `px-2 py-1.5 gap-1 border-b border-border-default`, 28px
icon buttons, title `text-sm text-text-primary` (regular weight)): height `ADDRESS_ROW_HEIGHT` = 41
(28 + 2*6 + 1px border; `layout.ts`, sent as `addressRowHeight` -> CSS `--address-row-height`),
padding 0 8px, gap 4px, `border-bottom: 1px solid var(--border)` (#e0e0e0 / #404040), URL text 14px/400, left-aligned right after the reload button (a normal flex item, `flex: 1`; the Browser tools button sits at the far end), in a field shaped like the nav buttons (28px high, `--btn-radius`, `--btn-hover` fill on hover/focus)
in `--text-active`. Panel header and address row both start at the tab row height (38), so their
bottom borders share one line (y = 78). Gap and radius are NOT hardcoded in CSS: `layout.ts`
returns them (`gap`, `radius`), `window.ts` sends them on `tabbar:state` (`islandGap`,
`islandRadius`) and `renderer.ts` writes `--island-gap` / `--island-radius` (pinned by
`layout.test.ts`). The tab VIEW starts exactly below the row (`tabArea`): no page content is
hidden. A parent View's radius does not clip child WebContentsViews in Electron 43, so browser pages keep all-corner rounding; the page's rounded top corners show small wedges against the tail (which starts 1px below the row, `top: calc(100% + 1px)`, so it does not cover the border). The tail is painted in the ACTIVE browser page's own background, not `--island-bg` (dark wedges on a white page in dark theme): main runs a sampling script in the page after `dom-ready`/`did-finish-load`/`did-navigate-in-page` (NOT `did-navigate`: the new document is still empty and would flash white; the old colour is kept until dom-ready). The script reads `getComputedStyle` of `<html>`/`<body>` and converts the colour through a 1x1 canvas, because Chromium returns oklch()/lab()/color() in their authored space; both transparent -> Chromium's canvas (`rgb(18,18,18)` when `color-scheme` (CSS, else the `<meta name="color-scheme">` tag) is dark under a dark OS appearance, else white); failure -> `#ffffff` (`pageBackground.ts`) and sends it on `tabbar:tail`; the renderer sets `--tail-bg`. Blank and canvas tabs send null -> `--island-bg`.

*Theme and tint.* The app/OS appearance is NEVER changed (it is
app-wide and would flip `prefers-color-scheme` for browser tabs, isolated sessions and QA
runs). The vibrancy follows the OS; a plain `View` (`glassTintView`, bottom-most, macOS only,
no page/IPC) paints `glassTint(theme, osDark)` over it: `rgba(244,245,248,a)` light /
`rgba(28,28,30,a)` dark, `a = 0.35` when the editor theme matches the OS appearance and `0.85`
when it differs; re-applied on each `pushState` and on `nativeTheme` `updated`. The frontend
ignores the OS (stored `ui-theme`, default light): fallback "light" (`FALLBACK_THEME`). The panel page paints its
theme as the class `dark` on `<html>`; its preload (`preload/agentPanel.ts`) reads it on
DOMContentLoaded and observes the class with a MutationObserver, sending `panel:theme`
("light" | "dark") on change (no polling). Main (`onPanelTheme`) accepts it only from the panel's
own webContents AND its own page (`isPanelDocument` on the sender frame: not the offline
fallback), and `adoptPanelTheme` applies the rule: the panel's theme wins until an editor tab
reported, and again whenever there are ZERO editor tabs; an editor's own report wins while an
editor tab exists. Vibrancy material stays `under-window` (`sidebar` renders
identically; `menu` ~3 levels darker; `header` near opaque); `screencapture -l` does not include
the blurred wallpaper, so that effect needs a real-screen check.

**Sidebar toggle.** A button right after the traffic lights (before the tab
strip) hides/shows the agent panel; also View > "Show/Hide Agent Panel" with
`CmdOrCtrl+Alt+B` (free in the editor: Cmd+\ is "hide UI", Cmd+Alt+S is boolean subtract).
State: `panelCollapsed` in `window.ts`, persisted in `agent-panel-settings.json` in userData
(`agentPanelSettings.ts`, like cursor-settings.json). Geometry: `agentPanelWidthFor(collapsed)`
-> 0; `computeWindowLayout` with `panelWidth: 0` in islands mode gives `panelVisible: false`,
`tabArea.x = gap` (left gap 8) and the panel view is `setVisible(false)` (hidden, not
destroyed: the chat keeps running and keeps its state). The strip then starts right after the
button (CSS `--controls-end`). `pushState` computes the layout BEFORE it builds the snapshot, so
`tabStripLeft` (and the island numbers) the tab bar gets always match what is applied; a resize
that moves the offset re-pushes (e2e checks the row padding / address row margin after toggling).
The toggle is animated (240ms, easeOutCubic). `src/main/panelAnimation.ts` is pure and tested: the
motion decision (`shellMotionEnabled(env PEN_DESKTOP_NO_ANIMATIONS, reducedMotion)`), the maths
(`panelAnimationFrame`) and the state machine (`createPanelAnimator`: start / retarget from the CURRENT
progress / stop / `tick(now)` -> frame or done). `window.ts` only owns the `setInterval`
(`startPanelAnimation`) and applies the results. The panel keeps its full width and slides off to the left
while the tab area's left edge interpolates (right edge fixed); the panel is `setVisible(false)` only when
the collapse finishes (a frame's own `panelVisible`), and made visible at the start of an expand. The
expanded and collapsed layouts are computed ONCE per animation (again only if the active tab's kind
changes mid-flight), and each frame moves only the ACTIVE tab view (`TabManager.layoutActive`); one full
`tabs.layout` (all views) plus one `pushState` run when the slide finishes. `applyLayout` applies the
interpolated frame while the animator runs, so a mid-flight `pushState` never snaps it; a second toggle
retargets from the current progress; a window `resize` finishes it at once. ONE clock for views and strip:
on every frame main also sends the interpolated tab-area x over `tabbar:strip-left` and the renderer writes
`--tab-strip-left` from it (there are no CSS transitions on the strip padding / margin); a `tabbar:state`
push mid-slide carries the current interpolated `tabStripLeft`, the final value comes with the push at the
end. Opt-outs: OS reduced motion (`systemPreferences.getAnimationSettings().prefersReducedMotion`) and env
`PEN_DESKTOP_NO_ANIMATIONS=1` both give the instant jump AND turn off the tab strip motion: `tabbar:state`
carries `motion: boolean` (the same decision) and `renderer.ts` skips its tab enter/exit/progress animations
when it is false. e2e polls until bounds settle (and polls the panel's visibility together with the bounds:
the last frames already round to the final x). Focus never goes to the hidden panel: `emptyView.ts` `resolveFocusTarget` sends it to the
placeholder or the active tab, and collapsing while the panel has focus hands it over
(`focusAfterCollapse`). IPC: `tabbar:toggle-panel` tabbar->main (sender-checked,
`fromOurTabbar`), state back on `tabbar:state` as `panelCollapsed`; the menu action
`toggleAgentPanel` is a local action (no `menu:command` id). A canvas tab opened by the agent
or a launch never auto-expands a collapsed panel: only the user's toggle changes it.
Tests: `layout.test.ts`, `agentPanelSettings.test.ts`, `menu.test.ts`, `e2e/agent-panel-toggle.spec.ts`.

**Tab icons.** Every tab has a leading glyph keyed by `TabState.kind` in
`tabbar/renderer.ts` (one mapping): editor (canvas) tabs a Phosphor "PaintBrush", doc tabs a Phosphor "FileText", trace tabs a Phosphor "Pulse", the Settings tab a Phosphor "GearSix", the Passwords tab a Phosphor "Key", browser tabs a
Phosphor "Globe" ALWAYS (all LIGHT weight), never the site favicon. Phosphor is MIT: the notice lives in
`THIRD_PARTY_NOTICES.md` (shipped via the electron-builder `files` list; keep it there). Just the glyph,
monochrome `currentColor` (tab text color), no background square. The tab bar CSP has no `img-src`:
the tab bar draws no images. The agent's
cursor arrow replaces the icon while the agent drives a browser tab. Compact paddings, no
separators, the close "x" only on the active tab and on hover; it reserves no room in the row (absolutely positioned over the end of the title, which fades out under it with a mask).
Tab strip motion (`tabbar/renderer.ts`, `tabbar.css`): tabs are rendered keyed by id (elements are reused,
never rebuilt per `tabbar:state`). `TabState.loading` (from the view's `did-start-loading`/`did-stop-loading`
via `TabViewHandle.onLoadingChanged`, pushed on change only) drives `span.tab-progress`: a fake-progress fill
behind the content, 0->80% over ~7s, then 100% in 180ms and a 220ms fade (Web Animations API). New tabs
animate in; a closed tab becomes a `.tab-ghost` (NOT `.tab`, so e2e `.tab` counts ignore it; aria-hidden,
inert) that collapses and is removed; ghost rules in `tabbar.css` use `:is(.tab, .tab-ghost)` so a closing
tab keeps its look. The first render never animates. The hidden `about:blank` placeholder of browser tabs never
shows the loading fill (`placeholderActive` is set BEFORE its `loadURL`, because `did-start-loading` fires
inside it). The strip follows the panel slide through `tabbar:strip-left` (see "Sidebar toggle"). All tab motion is off when
`tabbar:state` `motion` is false (env `PEN_DESKTOP_NO_ANIMATIONS=1` or OS reduced motion) or under
`prefers-reduced-motion: reduce` in the tab bar page (the loading fill becomes a static full-width fill). The empty
view's fade is CSS-only (`empty.css`, `prefers-reduced-motion`) and ignores the env opt-out. The agent cursor stays static.
Reordering: a `.tab` can be dragged along X (pointer events + pointer capture in `renderer.ts`). A drag starts only after >= 4px of horizontal movement (and a quiet strip: no ghost or entering tab, else it stays armed and starts on a later move), so a click still activates on mousedown as before; `.close` and ghosts never start one, and a move with the button up ends a stale gesture. The dragged tab follows the pointer (translateX, clamped to the strip, `.dragging`), the others shift via transforms (150ms ease-out, none when motion is off). `pointercancel` or lost pointer capture cancel and send nothing. There is NO Escape or window-blur cancel on purpose: mousedown activates the tab and main then focuses the tab's page, so the tab bar has no keyboard focus and blurs right after pointerdown. A drop at another slot applies the DOM order at once and sends `tabbar:reorder` `{id, beforeId}` (`penTabbar.reorderTab`); `TabManager.moveTab` reorders the list (the snapshot order, background session tabs included) without touching activation, pins or the canvas-link order. The optimistic order is kept until a `tabbar:state` confirms it (or the id set changes; 3s safety timeout). A `tabbar:state` mid-drag updates titles/active state but defers DOM reordering until the drag ends. Ctrl+Tab cycles the list, so it follows the new order.

Screenshots: opt-in `npm run test:e2e:shots` (`e2e/bench-agent-layout-screens.spec.ts`, gated
by `AGENT_SHOTS=1` so the default bench run skips it; needs a local frontend on :5194 and writes
`AGENT_SHOTS_DIR`; `AGENT_STUB_BG` sets the stub page background). The window is found by
its tab bar view, not by title.

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
byte-for-byte; path and hash kept), so the tab is `/app?chat=off`. It is
called ONCE in `window.ts` (`tabEditorUrl`, handed to `TabManager`), so every path
that creates an editor tab ("+" menu, Cmd+T, the panel-navigation
fallback, macOS reopen) gets it. The
panel URL is still derived from the plain `editorUrl`. The "+" menu item and File
"New Tab" (Cmd+T) both read "New Canvas Tab"; no command id changes. The frontend router may drop
`?chat=off` on a reload, so editor tabs also get `window.penDesktop.agentLayout
= true` and `canvasHost` from `preload/tab.ts` (the preload is loaded by editor tabs
only; browser tabs have no preload). e2e: `agent-layout.spec.ts` / `smoke.spec.ts`. The canvas-link channels (`docs/canvas-link.md`) are described in "Canvas link" below.

**Workflow tabs (`TabKind` `"workflow"`).** The frontend's `/workflow` page (a titled list of text steps) is its own tab kind, sibling of the doc tab: same preload, default session (its localStorage is the agent panel's), title/theme callbacks, editor-tab navigation policy and counting (`editorTabCount`, theme lookup), NOT a canvas tab, and File-palette commands skip it (`menuTarget.ts`). URL `/workflow?id=<id>&chat=off`, or `?new=1&chat=off` for an empty one (`resolveWorkflowTabUrl`); ids are `wf_` + alphanumerics (`isValidWorkflowId`). **Storage is the frontend's localStorage only: no disk store, no `workflows:*` IPC** (unlike docs). Entry points: "+" menu "New Workflow" (not the placeholder: the empty state has no workflow card), File > "New Workflow Tab" (no shortcut). **`workflow:open`** (invoke, `workflowId` -> `{ok, error?}`, `src/main/workflowOpen.ts`): agent panel only; opens or activates the tab for that id WITHOUT taking keyboard focus. Preload: `penAgentPanel.workflows = { open }` (key list pinned in `preloadCanvasLink.test.ts` and `e2e/agent-layout.spec.ts`). Tests: `workflowOpen.test.ts`, `config.test.ts`, `tabManager.test.ts` ("workflow tabs"), `menu.test.ts`, `ipcContract.test.ts`.

**Document tabs (`TabKind` `"doc"`).** A third tab kind: the frontend's markdown
editor at `/doc?new=1&chat=off` for a NEW document (the page creates it and rewrites the URL to `?id=<newId>&chat=off`; `resolveDocTabUrl(editorUrl, docId?)` in `config.ts`: the last
`app` path segment becomes `doc`, `id=<docId>` goes before `chat=off`, other params kept).
Entry points: the placeholder button and the "+" menu item "New Document" (the "+" menu calls `tabs.newTab("doc")` directly), File > "New
Document Tab" (`CmdOrCtrl+Shift+D`, action `newDocTab`). A doc
tab is **NOT a canvas tab**: it is absent from `editorTabsInfo()` / the canvas link,
`isEditorTab`, `lastEditorWebContentsId`, the MCP active tab and `canvas:open`, and gets no
MCP/fixture/orphan wiring. **Shared session requirement:** doc tabs use the DEFAULT session
(no `partition`), exactly like editor tabs and the `/agent` panel view, because documents
live in `localStorage` and the panel's tools write them; never give doc tabs their own
partition. Preload: the same `preload/tab.ts` (harmless: the page never calls
`canvasHost.register`); it also publishes `editor:theme`, so doc tabs take part in theme
sync (`editorTabCount`, `resolveActiveTheme`). The tab title follows `document.title`
(main listens to `page-title-updated`; the preload's `setDocumentTitle` is not used). Same
origin clamp, offline fallback and window-open policy as editor tabs (external links go to the system browser; the browser-tab popup policy applies to `kind === "browser"` only). File-menu palette commands (`forwardToActiveTab`) reach editor tabs only (`menuTarget.ts`); with a doc tab active they are a no-op. **`doc:open`** (invoke, `docId` -> `{ok, error?}`, logic in `src/main/docOpen.ts`), two senders:
  - the agent panel: `window.penAgentPanel.docs.open(docId)`;
  - a trace tab that still shows `/trace/<id>` (`tabs.isTraceViewer`): `window.penDesktop.docs.open(docId)`, which `preload/tab.ts` exposes only when the page is at `/trace/`. Editor, doc and browser tabs are refused.

  Behaviour:
`docId` must match `/^[A-Za-z0-9_-]{1,64}$/`; an open doc tab whose URL has `id=<docId>`
(`TabManager.findDocTab`; a `new=1` tab never matches) is activated, else a new doc tab opens at `/doc?id=<docId>&chat=off`
and is shown as the active tab; it resolves once the tab exists, not when the page has loaded. **Focus rule:** `doc:open` is agent-initiated, so the doc tab becomes the visible active tab but does NOT take keyboard focus (`activate(id, {focus:false})` / `newTab("doc", undefined, {docId, focus:false})`); typing stays in the panel composer. A trace tab's open is a user click: when that trace tab is the ACTIVE tab, the doc tab is activated WITH focus (`{focus:true}`); from a background trace tab it opens without focus. User-driven activation (click, menu, empty-start button) keeps focusing. Glyph:
Phosphor "FileText" (light). Tests: `docOpen.test.ts`, `tabManager.test.ts` ("doc tabs"),
`config.test.ts`, `menu.test.ts`, `preloadCanvasLink.test.ts`, `ipcContract.test.ts`.

**Settings tab (`TabKind` `"settings"`).** A fifth tab kind: the frontend's `/settings` page, a SINGLETON. URL
`resolveSettingsTabUrl(editorUrl, section?)` (`config.ts`) = `/settings?chat=off[&section=<id>]` (the last `app` segment becomes `settings`;
other params kept, `chat`/`section` replaced; `section` must be one of `SETTINGS_SECTIONS` = account, appearance, canvas, agent, browser,
integrations, shortcuts, else it is dropped). Handled like a doc tab: default session (no `partition`, so its localStorage is the
editor's and the panel's), `preload/tab.ts`, same origin clamp and offline fallback, title follows `document.title` (fallback "Settings"),
takes part in theme sync, not a canvas tab. `TabManager.openSettingsTab(section?, {focus})` opens it or activates the existing one (a valid
`section` is sent to the existing tab over **`settings:section`** (main->renderer, payload = the section id; page side `window.penDesktop.settings.onSection(cb)` returns an unsubscribe) - the tab is never reloaded, so in-page state survives). **`settings:open`** (invoke, `section?` -> `{ok: boolean}`, logic in `src/main/settingsOpen.ts`): from the agent
panel (`window.penAgentPanel.settings.open(section?)`) or any editor/doc/trace/Settings tab (`window.penDesktop.settings.open(section?)`, `tabs.isPageTab`);
browser tabs and other senders get `{ok:false}`; an invalid section is ignored (the tab still opens). It takes keyboard focus (a person asked for the page).
Menu: macOS app menu is an explicit submenu (Electron's default `appMenu` roles + "Settings…" `CmdOrCtrl+,`); elsewhere "Settings…" is in File. Action
`openSettings`. No empty-start card. Tests: `settingsOpen.test.ts`, `tabManager.test.ts` ("settings tab"), `config.test.ts`, `menu.test.ts`,
`preloadTab.test.ts`, `preloadCanvasLink.test.ts`, `ipcContract.test.ts`. The `penAgentPanel.version` stays 2 (an added optional key).

**Document storage.** Markdown documents are also kept on disk: `<userData>/documents/<id>.json` (`<userData>/documents-dev/` while `PEN_DESKTOP_URL` is set, via `docDirFor`: a dev frontend never sees production documents), compact JSON of exactly
`{id, title, markdown, updatedAt, rev}` (id = `isValidDocId`, title <= 10 000 chars, markdown <= 5 MB UTF-8, `rev` a positive safe integer; other fields are stripped),
written tmp (`<file>.<pid>.<random>.tmp`, unique per write) + rename with mode 0o600. The store is created once per PROCESS (`getDocStore()` in window.ts), not per window, so a reopened window shares the rev cache and chains of the closed one. Store `src/main/docStore.ts` (pure, fs port, async), sender rules `src/main/docIpc.ts`. **Newer rev wins:** `docs:save`
writes only when the incoming `rev` is above the stored one, else it returns `{ok:true, stale:true, rev:<stored>}` and writes nothing; the read-compare-write of one id runs
on a per-id promise chain inside the store (`docs:delete` shares it); the store keeps an in-memory `Map<id, rev>` of stored revs (filled by `list`, `save` and the first read of an id, cleared by `remove`; this process is the only writer), so a repeat save never re-reads the file. Documents are user data and are NEVER pruned. `docs:list` skips (and logs) unreadable, invalid and
id-mismatched files and ignores temp files; it also sweeps temp files older than 1 hour (best effort, logged). Senders: the agent panel, editor tabs, doc tabs and trace tabs; browser tabs get `{error: "docs:<op> is not allowed from this sender"}`.
The frontend's `localStorage` stays the working copy; it mirrors every write here and reconciles on startup. Preloads: `penAgentPanel.docs = { open, list, save, remove }`, `penDesktop.docs = { list, save, remove }` on every tab (+ `open` only at `/trace/`). Tests: `docStore.test.ts`, `docIpc.test.ts`, `tabManager.test.ts` (`isDocTab`), `preloadTab.test.ts`, `preloadCanvasLink.test.ts`, `ipcContract.test.ts`.

**Canvas storage.** Canvases are kept on disk like documents, so closing a canvas tab no longer loses the design: `<userData>/canvases/` (`<userData>/canvases-dev/` while `PEN_DESKTOP_URL` is set, via `canvasDirFor`). Two files per canvas, each written tmp + rename with mode 0o600: `<id>.meta.json` = `{id, title, updatedAt, rev}` and `<id>.pen.json` = `{id, rev, document}`, where `document` is the serialized `.pen` JSON string. Limits: id = `isValidCanvasId` (same regex as a doc id), title <= 10 000 chars, document <= 64 MB UTF-8, `rev` a positive safe integer. `list` reads ONLY the meta files (it never parses a body) and sweeps temp files older than 1 hour. `read(id)` returns `{canvas}` (meta + document), or `{canvas: null}` when the meta or body is missing, unreadable, or the body `rev` is below the meta `rev`. `save` writes the body FIRST, then the meta, so a meta never points at a body that is not there; a crash in between leaves the old meta, which the body still satisfies. **Newer rev wins** exactly as in `docStore`: a save whose `rev` is not above the stored meta `rev` writes nothing and returns `{ok:true, stale:true, rev}`; per-id promise chain, in-memory rev cache, never pruned. The store (`src/main/canvasStore.ts`, pure, fs port shared with `docStore`) is created once per PROCESS (`getCanvasStore()` in `window.ts`). IPC (invoke, errors come back as `{error}`): `canvases:list` -> `{canvases: CanvasMeta[]}`, `canvases:read(id)` -> `{canvas: StoredCanvas | null}`, `canvases:save(StoredCanvas)` -> `{ok, rev, stale?}`, `canvases:delete(id)` -> `{ok}`. Senders (`src/main/canvasIpc.ts`): editor (canvas) tabs may do everything; the agent panel may only `canvases:list` (its preload exposes nothing else); doc, trace, browser tabs and everything else get `{error: "canvases:<op> is not allowed from this sender"}`. **The four handlers are registered ONCE per process** (`ensureCanvasIpc()` in `window.ts`, removed on `will-quit`, NOT in a window's `closed` handler) and check a process-level registry (`src/main/canvasWriters.ts`: `canvasSenders`): an editor tab's webContents id is added when its view is created and stays valid for 10 s after its `destroyed` event, so the last save of a closing tab is accepted (tab close, window close, quit). **Flush handshake (close and quit):** in real Electron the page's own `pagehide`/`unload` did NOT get a `canvases:save` through when `view.destroy()` ran (e2e-verified), so main asks the page. **The editor page must define `window.penCanvasFlush: () => Promise<void>`**: it resolves after its pending canvas save got its `canvases:save` reply (at once when nothing is pending) and never rejects. Main runs `typeof window.penCanvasFlush === 'function' ? window.penCanvasFlush() : undefined` with `executeJavaScript` (`FLUSH_SCRIPT`, `canvasWriters.ts`), which awaits the returned promise; since the page awaits the invoke reply, the save is on disk (or failed) when it resolves, with no assumption about the order of the script reply and the ipc dispatch. Every bounded wait uses the shared `withTimeout` (3 s per page flush, timer `unref()`ed). `destroy()` of an editor tab calls `flushThenClose` (flush this tab only, then `webContents.close()`; it never waits for other tabs' saves; the flows are listed in `pendingCloseFlushes()`). **Quit:** the pure `src/main/quitFlush.ts` (`createQuitFlush`, wired in `index.ts`) decides in `before-quit`: `quitting = true` first; on the first pass of a quit cycle, if a canvas tab exists in any window (or a tab close is still flushing), `preventDefault()`, flush ALL canvas tabs of all windows in parallel (`TabManager.flushCanvasTabs`, overall cap 3 s), then `app.quit()` again; the second pass does not hold (and consumes the flag, so a later quit after a cancelled one holds again); a quit pressed during the flush stays held without a second flush. `appRegistry.killAllSync()` runs once per quit cycle, on its first pass. The `canvases:*` handlers are removed on `will-quit`, i.e. only after the flush. A stored change (`docs:save|delete`, `canvases:save|delete`, not stale, not an error) sends `empty:recent-changed` to every window's empty view. Shared helpers of docStore and canvasStore: `src/main/storeUtils.ts`. Preloads: `penDesktop.canvases = { list, read, save, remove }` on every tab preload (main is the trust boundary); `penAgentPanel.canvases = { list }` only (version stays 2). **Canvas identity:** a canvas tab URL carries `canvas=<id>` (`resolveCanvasTabUrl(editorUrl, canvasId?)` puts it before `chat=off`; `TabManager.newTab("editor", undefined, { canvasId })` loads it). The frontend adds `canvas=<id>` to a new canvas tab with `history.replaceState`, so `TabManager.findCanvasTab(canvasId)` lets the LIVE URL win (like `findDocTab`), and falls back to the id the tab was opened with when the live URL has no `canvas` param. Tests: `canvasStore.test.ts`, `canvasIpc.test.ts`, `canvasWriters.test.ts`, `quitFlush.test.ts`, `config.test.ts`, `tabManager.test.ts` ("canvas tabs by id"), `preloadTab.test.ts`, `preloadCanvasLink.test.ts`, `ipcContract.test.ts`.

**Trace tabs (`TabKind` `"trace"`).** A fourth tab kind: the frontend's viewer for a recorded browse run
(design: browser-agent `docs/specs/2026-10-20-browse-run-trace-design.md`, Part 3). URL
`resolveTraceTabUrl(editorUrl, id)` (`config.ts`) = `/trace/<id>?src=local&chat=off` (the last `app` segment
becomes `trace/<id>`; other params kept, `chat` and `src` replaced). It is handled like a doc tab: **not a canvas
tab** (absent from `editorTabsInfo()`, the canvas link, MCP), default session, same preload (`preload/tab.ts`, so it
takes part in theme sync and gets `penDesktop.traces.read`), same origin clamp / offline fallback, title from
`page-title-updated` (fallback "Trace"). Opens ONLY from a run (`traces:open`; `TabManager.newTab("trace")` throws without a valid trace id): there is no "+" menu item, menu entry
or placeholder card. Glyph: Phosphor "Pulse" (light).
- **Store** — `src/main/traceStore.ts` (pure, fs port, tests in `traceStore.test.ts`): `<userData>/browse-traces/<id>/trace.json` + `frames/<n>.<ext>`.
  `save({manifest, assets:[{path, dataUrl}]})` validates with `parseBrowseTrace` from `@sideform/browser-agent/agent/session` (the
  package is ESM-only; the CommonJS main process `require()`s it, types via `typesVersions`), the id and asset-path regexes
  (the package's `BROWSE_TRACE_ID` / `BROWSE_TRACE_ASSET_PATH`: no path leaves the traces dir), at most 160 assets of at most 3 MB each, a manifest of at most 4 MB,
  every frame `src` backed by an asset and every asset referenced. Write-once: saving an id that exists returns `{error: "trace exists"}` (no overwrite, so an editor tab cannot replace a panel trace). All I/O is async (`fs.promises`). A save builds in a sibling `.tmp-<id>-<rand>` directory (frames first, `trace.json` last, each file tmp + rename) and renames it into place at the end, so a reader never sees a half trace; a failed save removes only its own temp dir, stale temp dirs (> 1 h) are swept. Payload checks run before any regex/decoding: data-URL length per asset, total payload <= 48 MB. MIME is case-insensitive. Keeps the newest 100 traces
  (by directory mtime, the new one is never pruned). `read(id, {frames?})` returns `{trace}` with every frame `src` turned into a data URL (with `{frames: false}` no frame file is read and `src` stays the asset path), or `{error}`. Neither throws.
- **IPC** (all invoke/handle, errors come back as values): `traces:save` (sender: the agent panel or an editor tab) -> `{id}` | `{error}`;
  `traces:read` (sender: a trace tab, the panel or an editor tab; optional 2nd arg `{frames: false}`, only a plain object with a boolean `frames` counts, else default) -> `{trace}` | `{error}`; `traces:list-tabs` (sender: the panel only; no args -> `{tabs: [{traceId, title, active}]}` for open trace tabs in strip order, id resolved like `findTraceTab`) so the panel agent can see open trace tabs; `traces:open` (sender: the panel only; `id` -> `{ok, error?}`;
  logic in `src/main/traceOpen.ts`, like `doc:open`: an open tab for the id is activated, else a new one opens, both WITHOUT keyboard focus). Sender rules of save/read are
  in `src/main/traceIpc.ts`. Preloads: `penAgentPanel.traces = { save, open, listTabs, read }`, `penDesktop.traces = { save, read }`. Trace tabs may open Markdown documents in a Document tab via `penDesktop.docs.open(docId)` (`doc:open`, see "Document tabs"); the frontend writes the doc to `localStorage` first.
- Tests: `traceStore.test.ts`, `traceOpen.test.ts` (open + sender rules), `tabManager.test.ts` ("trace tabs"), `config.test.ts`,
  `preloadCanvasLink.test.ts`, `preloadTab.test.ts`, `ipcContract.test.ts`.

**Empty start (zero tabs).** The window opens with ONLY the agent
panel: no initial canvas tab (`INITIAL_TABS` is `[]` in `config.ts`). Closing the last tab (or the
active tab when only background session tabs remain) leaves zero tabs and the window open;
`TabManager` never respawns a tab. A tab
opens when the panel calls `canvas:open` or the user opens one ("+" menu,
Cmd+T, placeholder). Zero-tab safety: snapshot has `tabs: []`, `activeId` and
`activeKind` null, `mcpActiveWebContentsId` null (the MCP dispatcher answers its
existing "No editor tab is open."), `editorTabsInfo()` empty (the router's
`syncTabs` clears the list), `nextTab`/`prevTab`/`closeTab`/`activate` no-op. Menu
commands that target the active editor tab (`forwardToActiveTab`: File Open,
Export..., Import/Export Design Tokens) are a **no-op** with no tab (they do NOT
open a canvas tab: the editor must be loaded before it can handle a command);
Close Tab (Cmd/Ctrl+W, `decideCloseTarget`) closes the active tab and does NOTHING with no active tab (zero tabs, or only background session tabs): it never closes the window (macOS convention). File > "Close Window" (Cmd/Ctrl+Shift+W, local action `closeWindow`, no `menu:command` id) closes the main window. A new non-session tab becomes active when none is active, even if requested in the background (`activate:false`). macOS dock `activate` reopens a window
the same way (panel only). **Placeholder:** while `activeId === null`, a local view (`src/tabbar/empty.html` + `empty.css` + `emptyRenderer.ts`,
same CSP as the tab bar, light/dark tokens shared via `tokens.css`, no remote content) covers the tab
area with the hint "Canvas, browser and document tabs open here." and three cards (`#new-canvas`,
`#new-browser`, `#new-doc`; the whole card is the button: preview, title, description, "New canvas tab" /
"New browser tab" / "New document" label). Previews are CSS plus one inline SVG (the canvas card's agent cursor on hover/focus); no images (the CSP has no `img-src`). It has its OWN minimal preload (`src/preload/empty.ts`: `newCanvasTab`,
`newBrowserTab`, `newDocTab`, `onTheme`); its buttons send `tabbar:new` / `tabbar:new-doc` / `tabbar:new-browser`
(the same actions as the "+" menu; main accepts them from the tab bar or this
view via `isTabCreationSender`). Visibility, theme and focus decisions are pure
(`emptyView.ts`, applied on change only); bounds (`tabArea`) follow `layout`.
**Recent list.** Below the three cards the page shows a "Recent" section: the canvases and documents the user or the agent made, newest first (hidden when there are none). Compact rows, 36 px: Phosphor light icon (PaintBrush = canvas, FileText = document, same glyphs as the tab bar), title (ellipsis, "Untitled" fallback), a muted kind label, and a right-aligned relative time in tabular figures (`formatRelativeTime` in `src/tabbar/relativeTime.ts`, its own plain script loaded before `emptyRenderer.js`; under 12 h it counts elapsed time even across midnight, then calendar days: "just now", "5 min ago", "3 h ago", "yesterday", "12 Oct", "12 Oct 2025"). Rows are `<button>`s; ArrowUp/ArrowDown move focus; hover `--btn-hover`, focus ring `--focus-ring`. At most 8 rows, then "Show all (N)" expands the list (the page scrolls); there is no cap on N. The Phosphor glyph paths shared with the tab bar live in `src/tabbar/glyphs.ts` (plain script loaded first by both pages). DOM is built with `createElement`/`textContent`, never innerHTML. The page fetches on load, on every `visibilitychange` to visible, and (debounced 250 ms, only while visible) on `empty:recent-changed`; a sequence guard drops a late older answer. Data: `empty:recent` (invoke, answered ONLY to this window's empty view, else `{items: []}`) -> `{items: RecentItem[]}`; `src/main/recentItems.ts` merges `docs.list()` and `canvases.list()` into `{kind, id, title, updatedAt}`, trims titles (no cap), and an error from one store does not hide the other. `empty:open` (send, ONLY from the empty view; `{kind: "canvas" | "doc", id}`, decision in `src/main/emptyOpen.ts`): validates the id, activates an open tab for it (`findCanvasTab` / `findDocTab`) else opens a new one (`newTab("editor", undefined, {canvasId})` / `newTab("doc", undefined, {docId})`), WITH keyboard focus (a user action). Preload `penEmpty.listRecent()` / `penEmpty.openItem(kind, id)`. Tests: `recentItems.test.ts`, `emptyOpen.test.ts`, `relativeTime.test.ts`, `e2e/empty-start.spec.ts`.
e2e: `e2e/empty-start.spec.ts` (`EMPTY_START_SHOT=<png>` saves a composite screenshot; `EMPTY_START_RECENT_SHOT=<png>` saves the empty page with a seeded Recent list).

## Canvas link

Protocol, roles and message rules: `docs/canvas-link.md` (a copy; the source is pen-editor `docs/canvas-link.md` and `src/lib/canvasLink/protocol.ts`). The router and the `canvas:*` channels exist in every window.

- **Router** — `src/main/canvasLink.ts` (`CanvasLinkRouter`, pure; Electron injected like `tabManager.ts`; one per window, created in `window.ts`). The tab id on the wire is the tab's **webContents id** (like MCP `tabId`). Registry: per tab a `registrationId` (counter kept per tab, +1 on every `canvas:register`, so a reload gets a new one; a second register without a gone first sends `tab-gone` for the old one), the title and the activation order. `listTabs()` is ordered most recently active canvas tab first (never-activated tabs: latest registered first); `active` marks the tab active in the strip. `window.ts` feeds `syncTabs()` from `pushState` (`TabManager.editorTabsInfo()`; the router ignores a call that changed no tab, title or activation), and `canvas:tabs` is pushed only when the serialized list changed (register, gone, title, activation).
- **Routing** — panel→tab `canvas:to-tab {tabId, env}` only to registered tabs, else `{kind:"error", refId: env.id}` comes back to the panel (as `canvas:from-tab`); tab→panel `canvas:to-panel env` is forwarded as `canvas:from-tab {tabId, env}` (main adds the sender). Payloads are never interpreted: only the envelope is checked (object, string `id`, finite number `sentAt`, object `msg` with string `kind`); malformed envelopes and the main-only kinds `error` / `tab-gone` coming from a renderer are dropped. Order is kept, nothing is batched. `tab-gone {registrationId}` goes to the panel when a registered tab is destroyed, navigates its main frame (a COMMITTED non-same-document `did-navigate`; not `did-start-navigation`, which also fires for denied navigations, 204s and downloads), sends `canvas:unregister`, or its renderer dies. A registered id that `syncTabs` no longer sees as an editor tab (a closing tab) is dropped the same way, so `canvas:tabs` never lists it as "Untitled". Main-made kinds: `error`, `tab-gone` (to the panel) and `panel-gone` (to every registered tab, `docs/canvas-link.md`).
- **Open** — `canvas:open {activate?}` calls `TabManager.newTab("editor", undefined, { activate })` (editor tabs are canvas tabs in this layout; `activate !== true` creates the tab hidden in the background: no activation, no agent pin change, no strip flash) and resolves `{tabId, registrationId}` (the registration that resolved it) when THAT tab calls `canvas:register`; it rejects after 20 s (`OPEN_TIMEOUT_MS`, timer injectable) or when the tab is destroyed or its renderer dies first. A navigation of the new tab (its first load) does not reject it.
- **Sender checks** — `canvas:register` / `canvas:unregister` / `canvas:to-panel`: this window's editor tabs only (`TabManager.isEditorTab`; `unregister` and `to-panel` only when registered); `canvas:list|open|activate|to-tab`: this window's agent panel webContents only (others get `[]`, a rejection or silence). Listeners are added per window and removed in the window's `closed` handler.
- **Preloads** — editor tab: `window.penDesktop.canvasHost = { register, unregister, post, onMessage }`, exposed on every editor tab (next to `agentLayout: true`). Panel: `window.penAgentPanel = { version: 2, canvas: { listTabs, openTab, activateTab, post, onMessage, onTabsChanged }, browser, docs: { open, list, save, remove }, traces: { save, open, listTabs, read } }` (`docs.open` -> `doc:open`, see "Document tabs"; `traces`, see "Trace tabs").
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

## Origin move and sign-in (app.sideform.pro, `sideform://`)

Design: `pen-editor-backend/docs/superpowers/specs/2026-10-20-desktop-sign-in-design.md`. Two things changed on 2026-10-20.

**The origin moved.** `DEFAULT_EDITOR_URL` is `https://app.sideform.pro/app` (was `pen-editor.onrender.com`; it is the same Render static site, the old host stays live). The frontend turns accounts on only when the page origin equals the backend's `APP_ORIGIN`, so the old origin kept the desktop anonymous. `LEGACY_EDITOR_ORIGIN` (`config.ts`) exists only for the migration below. localStorage and IndexedDB are per origin, so the move would strand the user's data (`pen.docs.*`, `pen.userId`, share edit tokens, plugins, custom fonts). `.pen` documents are never stored in the browser and are unaffected.

**One-time storage migration** (`originMigration.ts` pure + tested; `originMigrationRunner.ts` is the thin Electron glue). `index.ts` awaits it once, after `ready` and before the main window exists (a `quitting` flag set in `before-quit` makes it skip the window and the MCP start if the user quit meanwhile) (deliberately the simple await, not an early window with gated views: the import must land before the editor on the new origin can mint its own `pen.userId`, and the budget is short). Its `activate` handler is registered BEFORE the await and does nothing until the main window exists. `migrationGuard.ts` (a pure flag, `startup.active` until `end()` after `createMainWindow`) makes `window-all-closed` ignore the event while the hidden window is the only window; without it destroying that window quits the app on Windows/Linux. It runs only when `PEN_DESKTOP_URL` is unset/empty (an override may point at a dev origin that must never receive production data) and `<userData>/origin-migration.json` is not `done` for the exact `from -> to` pair. A hidden `BrowserWindow({show:false})` on the default session (the one the tabs use, with the shared secure webPreferences, no preload) loads `<old>/__sideform_migrate__`, exports through `executeJavaScript` all localStorage and all records of IndexedDB `pen-editor-plugins`/`plugins` (keyPath `id`) and `pen-editor-custom-fonts`/`fonts` (keyPath `family`), then loads `<new>/__sideform_migrate__` and imports. **The migration is network-free**: only while it runs, `originMigrationRunner.ts` registers `session.defaultSession.protocol.handle("https", …)` that answers exactly those two URLs (derived from the from/to origins) with a tiny local `text/html` page and passes every other request to `net.fetch(request, { bypassCustomProtocolHandlers: true })`; it is `unhandle`d in a `finally` before the main window is created and only registered when a migration really runs. So the page genuinely has the origin's per-origin storage, but nothing can redirect, go offline or hit a CDN. ArrayBuffer values travel as `{ "__ab": base64 }` (`PAGE_CODEC`, one string evaluated in the page; `loadCodec()` evaluates the same string for tests). Merge is fill-only (`planMerge`) with two exceptions: `pen.userId` from the OLD origin overwrites a different one on the new origin (a value there can only have been minted by this desktop on a launch whose migration failed, and the old id owns the user's server records), and `pen.docs.index` present on both is merged (union by doc id over the `{id,title,updatedAt}[]` array of `docStore.ts`, the new origin's entry wins a duplicate id; the doc bodies `pen.docs.doc.<id>` stay fill-only). Those keys are listed in `plan.overwrite`, which `applyScript` honours; every other localStorage key is written only if absent, an IndexedDB record is `add`ed (never `put`) only if its key is absent; the databases are opened with `indexedDB.open(name, 1)` and the store is created in `onupgradeneeded`, exactly like the frontend's `indexedDbStore.ts` (keep both in step if that layout changes). The export never creates a database (it checks `indexedDB.databases()` first). Old data is never deleted. After every load the window's real URL origin is compared with the expected one (`MigrationPort.currentUrl`): with the local handler a mismatch is a BUG (the handler is not in effect), so it is a failure with no done flag, never "done with zero counts". Before the first load the port clears ONLY service workers and Cache Storage of both origins (`clearStorageData({origin, storages:["serviceworkers","cachestorage"]})`, `MigrationPort.clearServiceWorkers`, best effort): the editor once shipped a workbox PWA and a legacy worker on the old origin could answer the hidden window's navigation before the protocol handler. localStorage/IndexedDB are never cleared. Overall budget 5 s; a failed load or the timeout destroys the window, logs `[migration] ...` and startup continues. A failure writes `{from,to,done:false,attempts,lastError}` (the counter is per from/to pair), so the next launch retries; the 3rd failure (`MAX_MIGRATION_ATTEMPTS`) writes the terminal `{done:true,failed:true,attempts,lastError}` and retrying stops for good. Success writes `{from, to, done:true, doneAt, counts}`. Not covered by a unit test: the real window and real IndexedDB. Verified once against real Chromium (2026-10-20) with a throwaway electron main script: seed localStorage and an IndexedDB ArrayBuffer record on the old origin through the same kind of handler, run `runOriginMigrationOnStartup` from `dist/`, read both back on the new origin (≈130 ms, handler removed afterwards). The `net.fetch` pass-through branch was not exercised there.

**Sign-in goes through the system browser** (`desktopAuth.ts`, Electron-free, injected clock/random/`openExternal`). `beginSignIn()` (File > Sign In…, or `auth.signIn()` from a view) makes `state` and `verifier` (32 random bytes, base64url, 43 chars each), `challenge = base64url(sha256(verifier))`, keeps only the latest `{state, verifier, expiresAt: +10 min}` in memory, and opens `<editorOrigin>/auth/desktop?state=&challenge=`. The backend/page hand control back with `sideform://auth?token=&state=`. `handleDeepLink` accepts only that shape, needs a pending unexpired attempt with the same state (a wrong state does not cancel the real attempt), and sends `auth:token {token, verifier}` to one LISTENING view, then raises the window. **Delivery is listener-aware**: `auth.onToken(cb)` in the preload sends `auth:listen` (and `auth:unlisten` when the last subscriber leaves); `window.ts` keeps the ids of listening views (both channels share one `isAuthSender(event)` check; dropped on destroy and on a COMMITTED main-frame cross-document navigation, `did-frame-navigate`, never `did-start-navigation`, which also fires for denied navigations, 204s and downloads). The receiver is the panel if it listens, else the active listening canvas tab, else any other listening canvas tab (`pickAuthReceiver`). With no listening view (the panel's `SessionBridge` never mounted, or no window at all) the token is HELD in `desktopAuth` until its attempt expires and `notifyListening()` hands it to the first view that starts listening; `window.ts` also retries it (`notifyListening`) when the active tab changes (`activeTabChanged`) and when a listening view finishes an in-page navigation; `handleDeepLink` then returns true (accepted). A deep link is validated BEFORE anything else (`wouldAccept`: well-formed `sideform://auth` with token and state, state equal to the pending unexpired attempt); anything else is ignored without opening a window. A valid one with no main window (macOS, window closed, app alive) opens one through the same `openMainWindowIfNone()` as dock `activate`; `second-instance` never shows the hidden migration window while `startup.active`. The attempt is NOT consumed by delivery: only expiry or a newer `beginSignIn` ends it, so the user can press the browser button again without restarting sign-in. A replayed link is harmless because the backend token is single-use. A wrong state never does anything. Everything else is ignored and logged WITHOUT the token. PKCE matters because the scheme is not owned by us: the verifier never leaves this process until it reaches our own view. Since state lives in memory, a link on a cold start (no attempt) is ignored by design. Channel names stay string literals in `window.ts` and the preloads (the `ipcContract` scan only sees literals, and sandboxed preloads cannot import from main).

Wiring: `package.json` `build.protocols` (`Sideform` / `sideform`) makes electron-builder write the scheme into `Info.plist`; `index.ts` calls `app.setAsDefaultProtocolClient("sideform")` at startup. An unpackaged run (`process.defaultApp`: `npm run dev`, Playwright e2e) does NOT register unless `PEN_DESKTOP_REGISTER_PROTOCOL=1` is set (it would steal the scheme from the installed app); with it, it registers with `process.execPath` and the resolved app path. `open-url` (macOS) is registered at module level, before `ready`, and queues links until the main window exists; `second-instance` argv and the initial `process.argv` are parsed with `parseDeepLinkArg`. `window.ts` registers the receiver with `desktopAuth.setReceiver` and removes it on close.

Testing locally: the OS routes `sideform://` only to a registered app. On macOS that is a packaged build (`npm run dist`, open it once) or a dev run with `PEN_DESKTOP_REGISTER_PROTOCOL=1`, which re-registers Electron itself and steals the scheme from an installed app (quit the installed one first; without the variable dev never touches the registration). Without registration you can still drive the whole flow: `PEN_DESKTOP_URL=http://localhost:5173/app npm start` (sign-in then opens `http://localhost:5173/auth/desktop`; it works only if the local backend's `APP_ORIGIN` equals that origin; the migration is skipped), start Sign In…, finish in the browser, and when the browser cannot open the app run `open "sideform://auth?token=<T>&state=<S>"` by hand with the state from the opened URL. Never log a real token.

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
CI of its own. `Close Window` is a local action like Passwords (no forwarded id), and so is `Sign In…` (no forwarded id; its recording actions need a `signIn` entry too); pen-editor's contract test must tolerate a click on it (its recording actions need a `closeWindow` entry if they are an explicit list). Adding or renaming a forwarded id means touching four places:
`menu.ts`, that test's pinned list, and both CLAUDE.md files.

## IPC channels

- `menu:command` main→tab (commandId string)
- `editor:document-title` tab→main (document display name, normalized to `Untitled`)
- `editor:theme` tab→main (`light` | `dark`, observed from the editor's root class)
- `tabbar:state` main→tabbar (`TabsSnapshot`, now including `mcpStatus`), re-sent on tabbar `did-finish-load`
- `tabbar:theme` main→tabbar (`light` | `dark`, active editor theme or system fallback)
- `tabbar:tail` main→tabbar (`string | null`: the active browser page's background as `#rrggbb`/`rgb(r, g, b)`, sampled in main; null = blank/canvas tab, keep `--island-bg`)
- `tabbar:strip-left` main→tabbar (`number`, px: the interpolated tab-area left edge, sent on every frame of the panel slide; the renderer writes `--tab-strip-left`; the final value also comes on `tabbar:state`)
- `tabbar:new` / `tabbar:activate` / `tabbar:close` tabbar→main (sender-checked)
- `tabbar:reorder` tabbar→main (sender-checked; `{id, beforeId}`, integer `id`, `beforeId` an integer tab id or `null` = move to the end; parsed by `parseReorderPayload`) — drag-to-reorder in the tab strip, handled by `TabManager.moveTab`, anchored on ids so tabs opened/closed meanwhile cannot misplace it
- `panel:theme` agent panel preload→main (`light` | `dark`; accepted only from the panel's webContents and page) — the theme the panel paints, see "Theme and tint"
- `tabbar:toggle-panel` tabbar→main (sender-checked) — the sidebar button: show/hide the agent panel (see "Sidebar toggle"); the new state returns as `panelCollapsed` on `tabbar:state`
- `tabbar:new-browser` tabbar/empty-state→main (sender-checked) — a user-driven browser tab (`newUserBrowserTab`); sent by the empty-state placeholder only (`preload/empty.ts`)
- `tabbar:new-doc` tabbar/empty-state→main (sender-checked) — a new document tab (`/doc?new=1&chat=off`); sent by the empty-state Document card (`#new-doc`) only (the "+" menu item calls `tabs.newTab("doc")` directly); File > New Document Tab (`CmdOrCtrl+Shift+D`) runs the same action locally
- `settings:section` main→Settings page (send; section id string) — switch section on an open Settings tab without reload
- `settings:open` agent panel or any frontend tab→main (invoke; optional `section` -> `{ok}`) — opens or activates the Settings tab; see "Settings tab"
- `doc:open` agent panel or trace tab→main (invoke, panel or trace-tab sender; `docId` → `{ok, error?}`) — activates the doc tab showing that document or opens `/doc?id=<docId>&chat=off`; see "Document tabs"
- `docs:list` / `docs:save` / `docs:delete` renderer→main (invoke, sender-checked: panel, editor, doc or trace tab; `docs:save` takes a `StoredDoc` -> `{ok, rev, stale?}`, `docs:delete` an id -> `{ok}`; errors return `{error}`) — document storage on disk, see "Document storage"
- `canvases:list` / `canvases:read` / `canvases:save` / `canvases:delete` renderer→main (invoke, sender-checked: editor tab, the panel only for `list`; process-level handlers; `canvases:save` takes a `StoredCanvas` -> `{ok, rev, stale?}`, `canvases:read` an id -> `{canvas}`, `canvases:delete` an id -> `{ok}`; errors return `{error}`) — canvas storage on disk, see "Canvas storage"
- `empty:recent-changed` main→empty-state view (send, no payload; after a stored change, see "Canvas storage") and `empty:recent` empty-state view→main (invoke, empty view only, `recentFor` in `emptyOpen.ts`; no args -> `{items: {kind, id, title, updatedAt}[]}`) and `empty:open` empty-state view→main (send, empty view only; `{kind: "canvas" | "doc", id}`) — the Recent list on the empty start, see "Empty start"
- `traces:save` / `traces:read` renderer→main (invoke, sender-checked: save = panel or editor tab, read = trace tab, panel or editor tab; payload errors return `{error}`) and `traces:open` panel→main (invoke, panel-only; `id` → `{ok, error?}`) and `traces:list-tabs` panel→main (invoke, panel-only) — browse-run traces, see "Trace tabs"
- `tabbar:new-menu` tabbar→main (sender-checked; `{x, y}` window coords) — the "+" button: main pops a native menu (New Canvas Tab / New Browser Tab / New Document), since an HTML popup would be clipped to the tab bar view's height. `tabbar:new` is sent by the empty-state placeholder's Canvas card (`#new-canvas`); e2e also drives it through `penTabbar.newTab()`, which a native menu can't be clicked through
- `tabbar:tools-menu` tabbar→main (sender-checked; `{x, y}` window coords) — the browser chrome row's gear button: native menu (Viewport emulation via CDP, Open/Close Developer Tools, Zoom) for the active browser tab; builder in `src/main/browserToolsMenu.ts`
- `tabbar:navigate` tabbar→main (sender-checked; `{action: "url" | "back" | "forward" | "reload", url?}`) — the address row driving the active browser tab, see "Built-in browser tab" below
- `mcp:register` tab→main (`{protocol, tools} | null`; `null` unregisters) — desktop MCP bridge, see below
- `mcp:call` main→tab only (`{callId, tool, args}`)
- `mcp:result` tab→main (`{callId, type: "tool_result" | "tool_error", result?, error?}`)
- `browser:command` tab→main, **invoke/handle** (request-response, unlike every other channel above) — `{command: "open" | "act" | "findImages" | "snapshot" | "perform" | "read" | "screenshot" | "tabs" | "capture" | "applyFixture" | "releaseFixture" | "clearActEmulation" | "fillLogin" | "startJournal" | "stopJournal" | "captureCheckpoint" | "assert" | "closeSession", args, session?}`, sent only by an *editor* tab's preload (or the agent panel's: `window.penAgentPanel.browser`) and verified against the registered editor tabs / the panel's webContents before acting; `session` (optional) routes to an isolated session, `closeSession` ends one (no new channel); see "Built-in browser tab" and "Isolated sessions" below
- Canvas link (section "Canvas link"): `canvas:list` / `canvas:open` panel→main, **invoke/handle**; `canvas:activate` / `canvas:to-tab` panel→main (sender: the panel); `canvas:register` / `canvas:unregister` / `canvas:to-panel` tab→main (sender: an editor tab; `unregister` and `to-panel` only when registered); `canvas:from-tab` main→panel (`{tabId, env}`), `canvas:tabs` main→panel (`CanvasTabInfo[]`), `canvas:from-panel` main→tab (`env`; also the main-made `panel-gone` message)
- `auth:sign-in` tab or agent panel→main (`send`, no payload; `window.penDesktop.auth.signIn()` / `window.penAgentPanel.auth.signIn()`) — starts the browser sign-in. Accepted only from an editor tab or the panel, top frame, whose `senderFrame.url` origin equals the editor origin (`isAuthSignInSender`); anything else is dropped silently. See "Origin move and sign-in"
- `auth:listen` / `auth:unlisten` tab or agent panel→main (`send`, no payload; sent by `auth.onToken(cb)` on subscribe / when the last subscriber leaves) — marks the view as able to take a token; `auth:listen` is validated exactly like `auth:sign-in` and delivers a held token
- `auth:token` main→panel or tab (`{token, verifier}`; `auth.onToken(cb)` returns an unsubscribe) — sent to exactly ONE LISTENING view: the agent panel, else the active canvas tab, else another listening canvas tab (`pickAuthReceiver`); with none it is held in main. The page exchanges it with the backend and tells the other views itself
- `docs:export-pdf` doc page→main, **invoke/handle** (per window, next to `docs:*`; removed on close): `fileName` -> `{ok:true, path}` | `{canceled:true}` | `{error}`. Same sender rule as `logins:*` (TOP frame of a doc tab still on the doc page, `TabManager.isDocViewer`), else `{error:"Not allowed."}`. Flow in `docPdfExport.ts` (pure, `test/docPdfExport.test.ts`): sanitize the name (separators, `\/:*?"<>|` and control chars stripped, 100 chars, fallback `Untitled`, `.pdf` forced), `sender.printToPDF({printBackground, preferCSSPageSize, pageSize:"A4"})`, native save dialog on the window (default dir Downloads), write file; never throws. Exposed as `penDesktop.docs.exportPdf(fileName)` on every tab preload (main is the trust boundary)
- `passwords:list` / `passwords:add` / `passwords:update` / `passwords:remove` / `passwords:never-remove` Passwords tab→main, **invoke/handle**, registered ONCE per process by `createPasswordsService` (`passwordsService.ts`, created in `index.ts`, removed by `dispose()` on `will-quit`); each answers only webContents attached as a Passwords tab of any main window (`attach`, dropped on `destroyed`), everything else gets `{ok:false}`. No reply ever holds a password — see "Saved logins" below
- `logins:list` / `logins:add` doc page→main, **invoke/handle**, registered ONCE per process next to the `passwords:*` handlers (`passwordsService.ts`; each window lends a `DocWindowPort` via `addDocWindow`: its `isDocViewer` check and its confirm dialog, withdrawn on close); rules in `loginsIpc.ts`. Answered only for the TOP frame (`senderFrame === sender.mainFrame`) of a doc tab that still shows the doc page (`TabManager.isDocViewer(id, frameUrl)`: kind `doc` AND both the view's URL and the sender frame's own `senderFrame.url` are the doc page ON the editor origin, `isDocPageOn`: last path segment `doc`); the owning window port is resolved once per call and re-checked after the dialog (a tab that left `/doc` meanwhile gets Not allowed and nothing is stored); everything else gets `{ok:false, error:"Not allowed."}`. `list` -> `{entries: {id, origin, username, label, icon?}[], encryptionAvailable}` (`api.listSummaries`: no password, no `never`, no `lastUsedAt`, no icon fetch); `add` takes `{site, username, password, label?}` (nothing else is forwarded, `replace` is dropped) -> `{ok:true, id}`. The order in `add`: validation and the existing-login check first (`api.precheckAdd`; an existing site + username answers `{ok:false, exists:true, id}` with NO dialog), then a native `dialog.showMessageBox` on the owning window (`addLoginCopy`: message `Save a login for <host>?` with the host ALONE, the page-controlled username only in `detail`; Save / Cancel, Cancel default; Cancel -> `{ok:false, error:"Cancelled."}`; one open dialog per window, a second add answers `{ok:false, error:"Another save is waiting for confirmation."}`). `precheckAdd` mirrors every store limit (username <= 512, password <= 1024, label <= 512) and refuses control characters in username and label, so no dialog opens for a payload that cannot be saved, then the store write and `passwords:changed` to every Passwords tab. Exposed as `window.penDesktop.logins` on every tab preload (main is the trust boundary)
- `passwords:theme` main→Passwords tab, payload `{ theme: "light" | "dark" }`: the theme the tab bar of THAT tab's window shows (`lastResolvedForTint`, the same value as `tabbar:theme`). Sent on every page load and whenever that window's resolved theme changes (`pushState` -> `service.setTheme(themeKey, theme)`; an unchanged value is not re-sent); the same step repaints the tab view's own background (`contentBackground(theme)`: #ffffff / #2a2a2a, the page's `--surface-panel`) through the `setBackground` port. There is no vibrancy in a tab, so there is no `vibrancyMatches`
- `passwords:changed` main→Passwords tabs, no payload. Sent to every tab when a site icon was stored (favicon fetched) and after a successful `logins:add` from a doc page (the sender is not a Passwords tab), and to every OTHER tab (never the sender) after a successful add / update / remove / never-remove. The renderer re-reads `passwords:list` and refreshes the never-saved link, rows and, in view mode only, the detail pane; an open Add/Edit form is never rebuilt

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

**Awake agent tabs.** A `WebContentsView` with `setVisible(false)` gets
`document.visibilityState = "hidden"`: `requestAnimationFrame` never fires,
timers run at 1/s and `capturePage` returns an empty image. Sites that hydrate
on rAF then hang and agent screenshots fail. So `TabManager` gives each tab a
view mode (`resolveViewMode`): `shown` (the active tab), `awake` (a browser tab
the agent drove, not active) or `hidden`. An awake view stays visible but sits at
the BOTTOM of the window's view z-order (`setViewMode` in `window.ts`'s handle,
`addChildView(view, 0)`), under the active tab with the same bounds and radius,
so it is fully covered and never shows. It renders at full speed. Going back to
`shown` re-adds it on top. A tab that was never awake is never reordered.
`layoutActive` moves awake tabs too. A second `createTabAgentActivity` in
`window.ts` (`AGENT_AWAKE_HOLD_MS` = 60 s, called in the same places as the icon
tracker) feeds `TabManager.setAgentTabAwake`; the 60 s hold covers the LLM
thinking between steps. Awake is not tab-bar state: no snapshot is emitted.
`index.ts` also sets the Chromium switch `disable-backgrounding-occluded-windows`
(before ready), so a window covered by another app's window keeps rendering. Cost:
the editor canvas also renders while covered; it renders on demand, so the idle
cost is small. A MINIMIZED window cannot be fixed: Chromium always hides it. On
`minimize`, if a tab is awake, the main window shows one Notification ("The
agent's browser tab is paused") telling the person to open the window. Awake
also lasts through the 60 s hold after the agent finished, so the text never
claims the agent is running. A handle without `setViewMode` (test fakes) cannot
go under the active tab, so there an awake tab stays hidden.

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
drift, so it was deleted) — OR the agent panel's
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
while the user had the address bar focused. When the active tab's url goes from empty to non-empty and the user has not typed
(`userEditingUrl` false), `renderer.ts` also blurs the input (`shouldBlurAddressBar`, `urlNormalization.ts`, unit-tested), so a tab
that was auto-focused and then navigated by the agent does not stay focused and grey.

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

## Saved logins (Passwords tab, save prompt, `fillLogin`)

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
  default port dropped; a bare host typed in the Passwords tab means
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
  together with the save-prompt state and the Passwords service
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
  insert. The result is ONLY `{ ok, origin, label, filled, submitted, url?, retried?,
  sessionEstablished?, note?, stillOnSignInPage? }` or `{ ok:false, error }`
  with fixed messages; controller results/errors are never passed through.
  There is no wait before the first snapshot. After typing, a second snapshot
  checks that the fields still hold text (a field the app cleared on late
  hydration is typed again once; if the re-read fails or a picked field is
  missing, one fresh snapshot is taken, and if that fails too Enter is NOT
  pressed: `ok`, `submitted:false`). After Enter the page is watched for 3 s;
  a fallback click on the submit button follows only if nothing changed.
  At most TWO submits per call: the first (Enter, maybe the click) and ONE
  retry (retype BOTH fields + Enter only, `retried:true`). The retry runs when
  the form had a password field, the pre-submit ids were confirmed, and the
  watch saw NO reaction: no URL change, no pending load (`isLoading` dep), the
  same form fingerprint at every poll (snapshot elements' tag/label/role/
  disabled/ops plus the snapshot's visible `text`; values, focus and `hasValue`
  are excluded, so a disabled or relabelled button, a new element or a new
  error text counts as a reaction; the act's own `changed` flag does not, it also
  fires for focus moves), the page stayed readable. A cleared password with an unchanged fingerprint is a hydration
  reset, not a reaction. Accepted risks: a wrong password can be submitted twice
  per call, and an XHR response that changes nothing visible within the window
  can cause a second submit; an error message the snapshot text cannot see (shadow
  DOM, out of the viewport, past 6000 chars) is not detected as a reaction. A
  password field that appears after typing (identifier-first form) is typed once
  before Enter; a form whose password was not typed is never retried. Navigation
  and success compare origin + path only (a query or hash change is neither). `url` is origin + path only, with the
  saved username (and an email's local part of 3+ chars) redacted to "…"
  from the path AND the host labels; common names are over-redacted on purpose.
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
- **Doc pages and logins** — the `@` mention picker of the Markdown pages uses `logins:list` / `logins:add` (see "IPC channels"; rule 4 below states the exception). They are separate from `passwords:*`, which stay Passwords-tab only. Code: `loginsIpc.ts` (pure, `test/loginsIpc.test.ts`), `passwordsApi.listSummaries` / `precheckAdd`, `TabManager.isDocViewer`, wiring in `passwordsService.ts` and `window.ts`.
- **Passwords tab** — `TabKind` `"passwords"`, a SINGLETON per window opened by File ▸ Passwords… (a local action: it forwards no `menu:command` id, so pen-editor's pinned id list is unchanged; `TabManager.openPasswordsTab({focus:true})`, like the Settings tab). The tab loads the LOCAL page `dist/passwords/passwords.html` (`loadFile` in `window.ts` `createView`; `TabManager` never calls `loadURL` for it) with `preload/passwords.js` only (NOT `preload/tab.ts`, never the frontend URL), `contextIsolation`/`sandbox`, `attachLocalOnlyPolicy`. Title fixed "Passwords", tab icon Phosphor "Key" (light weight, like every tab icon), no address row. It is not a page tab (`isPageTab` is false: `settings:open` refuses it), not a canvas tab, not an editor theme source (`editorTabCount`, `resolveActiveTheme` ignore it; it shows the window's resolved theme), and gets no MCP, browser or auth wiring. Tabs are not persisted, so there is no restore path. Service `src/main/passwordsService.ts` (pure, Electron ports injected, `test/passwordsService.test.ts`), `src/passwords/` (plain-script renderer like the tab bar; CSP `default-src 'none'`), `src/preload/passwords.ts`,
  request handling in `browser/passwordsApi.ts`. Site icons are neutral (a
  globe, or the site's icon through `<img>`; CSP adds `img-src data:` only).
  Icons never come from the Passwords tab: `window.ts` listens to
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
  `page-favicon-updated` while the tab is open) sends `passwords:changed`,
  so the row icons update without a manual refresh. The data-URL pattern for icons
  is a single copy, `isIconDataUrl` in `src/passwords/helpers.ts` (main
  `require`s it; the renderer, a plain script, uses it as a global).
  `passwords:add` answers `{ ok:false, exists:true, id }` when a login for the
  same normalized origin + username exists, and replaces its password only
  when the payload carries `replace: true` (the New login form shows an inline
  warning and a "Replace" button first). A save reply that arrives after its
  form was discarded or replaced only refreshes the list data. Copy on encryption is platform-specific (`api.isMac`). 
  In `window.ts`'s debugger `message` handler the login binding
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
   from any page (no preload on browser tabs). **One exception, narrow:** the
   frontend's own doc page (`/doc`, top frame of a doc tab that has not navigated
   away: `isDocViewer`) may `logins:list` (id, origin, username, label, icon; no
   secret, no `never`, no `lastUsedAt`) and `logins:add`. `add` only stores after
   the user confirmed in a native dialog, never replaces an existing login (it
   answers `exists` without asking) and never returns a password. A doc tab that
   navigated to `/` or `/app`, any sub-frame, and every other tab kind get
   `{ok:false, error:"Not allowed."}`.
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
  tab never auto-activates a session tab: with only session tabs left no editor tab
  is respawned: the window stays at zero active tabs.
- **Background tabs.** A session tab never becomes active and gets no address-bar
  focus; the editor keeps focus. It opens `setVisible(false)`. While the agent
  drives it, it is awake: visible but under the active tab (see "Awake agent tabs"),
  so it renders and screenshots. After the 60 s hold it hides again. The user clicks
  it to watch. Shared tabs behave as before.
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

**e2e launch helper.** The window starts with zero tabs, so specs that need an editor page launch with `launchShell` (`e2e/launch.ts`: waits for the tab bar, then sends `tabbar:new` like the "+" button). Specs about the empty start use `electron.launch` directly. `e2e/bench-browse.spec.ts` (opt-in, network + tokens) drives the chat in the agent panel (`/agent` view). Verified live 2026-10-19 (`BENCH_MODE=nojev`, 1 run: order placed, 33 s, 21 chat requests).

**Do not run main-process code (`app.evaluate`) while main may be creating views.** Node's inspector runs an evaluate as a V8 interrupt, in the middle of synchronous main code. If it lands while main constructs a `WebContentsView` (the shell views at launch, or a tab just requested), Electron 43 dies with SIGSEGV, and Playwright reports only "Target page, context or browser has been closed" at the next call. That was the "random test fails at launch" CI flake (2026-10-20, Linux container under load: 10 SIGSEGV in 270 browser-tab tests, every one inside the tab bar's `new WebContentsView`; 0 in 540 after the fix, and 3 full suites green). Rules:
  - After `electron.launch`, call `waitForShellViews(app)` (`e2e/launch.ts`) before any `app.evaluate`. It waits on Playwright's page list and "window" events (CDP, no main-process code) for the tab bar and the empty start, returns the tab bar page, and rejects at once if the app exits. `launchShell` does this.
  - Drive the UI from the renderer where you can (`tabbar.evaluate(() => penTabbar.newTab())`, as `launchShell` now does), and wait for the new page's "window" event before the next `app.evaluate`.
  - `reportCrashes(app)` prints `Electron pid=… crashed with SIGSEGV`; `launchShell` and the benches call it.
  - Reproduce Linux-only issues in `mcr.microsoft.com/playwright:v1.64.1-noble` with `xvfb-run -a` (run three containers at once: the load makes timing flakes show up).

## External desktop apps (`open({ app })` / `releaseApp`)

The chat agent can launch and drive another Electron app (e.g. Orca). Same
`browser:command` IPC as the browser; the model's text is ONLY an `.app` path.
Every decision is pure in `src/main/appTargets.ts`; `appTargetsService.ts` is
the app-global wiring (registry, confirm memory, real launcher); `window.ts`'s
`runAppCommand` adapts it. The launcher is `launchElectronApp` from
`@sideform/browser-agent/adapters/electron` (v0.2.25+), loaded lazily through
`require(esm)`.

- **Routing.** `planAppCommand(command, args, state)` (state: none / pending /
  running / gone) and one table `APP_ROUTES` (`routeAppCommand`) map commands to
  controller methods; `openApp` is the whole open (reserve, validate, confirm,
  launch, shape the result). `open` with a non-empty `args.app` launches (a present
  but malformed `app` is refused, never a URL open); on a running app
  `open/act/snapshot/read/screenshot/tabs/findImages/perform/assert` go to its
  controller (navigation is locked by the adapter); `capture`, `applyFixture`,
  `fillLogin`, `startJournal`, `captureCheckpoint` are refused; cleanup commands
  pass through. App commands skip tab activity, dialog sweeps and the run boundary.
  The decision runs right after `parseSessionId`, before `planSessionCommand`.
- **Sticky binding.** Once a key launched an app it stays bound until `releaseApp`
  or a session/owner release. If the app quits, the key keeps a tombstone
  (`gone`): routed commands answer "The desktop app is no longer running..."
  instead of falling through to the built-in browser. Commands while an open is
  pending answer a "still starting" error.
- **Key** `${senderId}:${sessionId ?? ""}`, reserved (`registry.begin`) BEFORE
  validate/confirm: a parallel open on the key gets BUSY, and so does a new open on
  a key whose cancelled open still shows its dialog (the flight entry stays until
  it finishes). Cap 2 counts every spawned app not yet fully closed plus flights
  not spawned yet, except the key's own app on a relaunch. A relaunch starts the
  new app first and closes the old one only on success; cancellation is
  re-checked after every await, so a release never yields `ok`, and `openApp`
  reports success only if the key is still bound to that handle. A quit before
  binding is a tombstone. Every release point cancels pending opens too;
  `releaseApp` answers `{ok:true, pending:true}` when it cancelled one. `releaseApp`
  (cleanup, NOT page-driving) is in both preloads and `BROWSER_COMMANDS`.
- **Guards** (`validateAppPath`, on the realpath): ends with `.app`, inside
  `/Applications` or `~/Applications` (symlinks out are refused), contains
  `Contents/Frameworks/Electron Framework.framework`, is not our own bundle.
  Then the bundle id (`CFBundleIdentifier`, read by the injected `readBundleId` through
  `/usr/bin/plutil`, 3 s, path as argv; null = unreadable = high risk, not blocked) is matched
  case-insensitively: password managers (`BLOCKED_BUNDLE_IDS`) are refused with
  `ERR_APP_BLOCKED`; messengers, mail and crypto wallets (`HIGH_RISK_BUNDLE_IDS`) give
  `risk: "high"`; an unreadable id is also high. Lists hold Electron apps only and are best effort.
  Extra roots via `PEN_DESKTOP_APP_ROOTS` (colon separated) only when
  `!app.isPackaged` (e2e). Never pass model text as args, env or `userDataDir`:
  the adapter makes a fresh temp profile and keeps the navigation lock.
- **Confirm.** Native `dialog.showMessageBox` (bundle name + full path + a plain
  warning that the app runs with the user's rights: files, commands, keychain):
  "Allow once" / "Allow until Sideform quits" / "Don't allow" (default and cancel).
  "Until quits" is remembered in memory per realpath AND per owner sender (a new
  chat or reloaded panel asks again), never persisted. A `risk: "high"` app adds a
  warning paragraph and offers only "Allow once" / "Don't allow" (default and cancel);
  it never reads or writes the "until quits" memory, so every launch asks. The restart
  confirm keeps its buttons and adds the same warning to the detail.
- **App already open.** `openApp` asks `findRunning(realPath)`. The service takes `findRunningElectronApp`,
  keeps only default-profile instances (`userDataDir === null`, via `filterUserPids`), drops the pids in
  `appRegistry.livePids()` (Sideform's own temp-profile instances, a user's second-profile instance) and
  intersects the rest with the pids of NSWorkspace running applications whose bundle path equals the realpath
  (one `osascript -l JavaScript -e <WORKSPACE_PIDS_JXA> <realPath>`, 5 s timeout, path as argv never in the
  script; pure parse/intersect `intersectWorkspacePids`; if osascript fails the ps list alone decides), so
  helper or daemon processes that share the bundle path are not "the user's app". If the user has it open, a different confirm is shown every time ("Restart and allow" / "Don't
  allow"; the "until quits" memory neither skips it nor gets fed by it). Then each pid is quit with
  `quitElectronApp` (graceful, 15 s; never SIGKILL first; a stuck save dialog gives `errAppDidNotQuit`),
  and the app launches with `{ userProfile: true }` (`useAppProfile`: the user's real profile, no temp
  dir, `profileDir` null) and the result carries `profile: "user"` plus a note. A cancel after the quit or
  a failed launch reopens the app (`open -g`). Release (`close()`) relies on the package's `close()`
  (disconnect, then a graceful quit; it never signals). The desktop decides the reopen on the process
  alone: it reopens only if the process ran when the release began and is gone afterwards; if a save
  dialog keeps it alive, it keeps running and nothing is done. In the gap between quitting the user's app
  and the relaunched handle going live, the flight carries `markUserAppQuit(realPath, pid)`, set BEFORE
  the first `quit(pid)` (the terminate may already be in flight when Sideform quits); `killAllSync`
  spawns the detached helper for that pid (quit JXA again, harmless) instead of a bare `open -g`, so the
  reopen waits until the original app is really gone. When `quit(pid)` times out the waiter owns the reopen,
  so `openApp` clears that pid's mark (`unmarkUserAppQuit`): `killAllSync` then sends no second terminate
  and spawns no second helper. The running pids are read again after the restart
  confirm (the dialog can stay open), under the lock below; an empty fresh list still launches with the user profile.
  The helper script (`QUIT_REOPEN_SCRIPT`) skips `osascript` when `SIDEFORM_QUIT_JXA` is empty, so the
  same helper is a pure "wait until the pid is gone (60 s), then `open -g`" waiter. It is used when
  `quit(pid)` times out (a save dialog: the terminate was sent, the user may still answer) via
  `reopenWhenGone(realPath, pid)`, and in the service release when the process is still alive after
  `close()` (the same call); the app then reopens normally once the user answers. The service has ONE
  helper spawn (`spawnHelper(realPath, pid, sendQuit)`: the quit JXA is derived with `macQuitScript(pid)` from
  the cached adapter module, not stored per handle) and tracks every helper it spawns per real path (removed on
  `exit`). Before a restart quits the user's pids, `openApp` calls `cancelWaiters(realPath)`, which SIGTERMs those
  `/bin/sh` helpers (our own shells, never the user's app), so a stale waiter cannot `open -g` the app in the
  middle of the next restart. Helpers stay detached and `unref()`ed so they outlive Sideform when spawned in `killAllSync`.
  Release decision (`ranAtRelease`, pure, tested): if the CDP link was already down when the release
  starts, the process gets 3 s to exit; if it does, the user quit it (Cmd+Q drops CDP before the process
  exits) and nothing is reopened. Still alive after 3 s counts as running (graceful quit + reopen).
  Two chats, one app: the registry owns a per-realpath user-profile LOCK (realpath -> owner key, reference
  counted). `openApp` takes it (`ticket.lockUserProfile`) in the same synchronous step that finds the user's pids,
  BEFORE the restart confirm; if another key holds it (restarting, or running the app with the user profile) that
  instance is Sideform's, not the user's: no `findRunning`, no restart confirm, no quit, and the open takes the
  normal temp-profile path. It is released when the confirm is denied, the open fails or is cancelled (the flight
  ends), or, on success, when the user-profile handle's `close()` has fully finished (including the reopen).
  The same key can re-enter (a relaunch overlaps the old handle's close). A user-profile `launch` without the
  lock takes it or fails with `ERR_APP_PROFILE_BUSY`. `killAllSync` spawns no helper for a live user-profile
  handle whose CDP link already dropped (`handle.disconnected`, decided in the pure `killHandleSync`): the
  user quit it, so it is not reopened.
  Known limits: if Sideform quits while the user-profile relaunch still waits for its first window (up to
  30 s), that instance keeps running with the debug port. An app that refuses to quit on release (save
  dialog) also stays running with its debug port until it quits; then the waiter reopens it normally.
- **Release points.** `closeSession` (releases that session's key; `closeSessionById`
  itself is unchanged), `closeSessionsOwnedBy` (releases everything of the owner and `forgetSender`s its
  "until quits" answers;
  covers the editor-tab orphan points, `releasePanelOrphans` and the window
  `closed` path via `tabs.destroyAll`), and `before-quit` in `index.ts`: it calls
  `killAllSync()` (synchronous and non-blocking, no `preventDefault`, no delay: temp-profile apps
  get SIGKILL + profile removal; user-profile apps get ONE detached `/bin/sh` helper that runs the
  JXA quit script (env `SIDEFORM_QUIT_JXA`, path and pid are positional args, never in the script
  text), polls `kill -0` for up to 60 s and runs `open -g` only if the process is gone. Nothing blocks,
  nothing of the user's is killed). Async `close()` is not enough there: it unhooks the
  launcher's exit handler first and the process exits before the kill.
  `closeSession` awaits the app release (capped at 5 s) after `sessions.close`.
- **Profile dir.** The service creates it for temp-profile apps (`mkdtempSync`, `sideform-app-*` under the OS
  temp dir) and passes it as `userDataDir`, so it can be removed on release, on a
  failed launch and in `killAllSync`. Apps restarted with the user's profile have no profile dir
  (`profileDir` is null).
- **`playwright-core` is a runtime dependency** (pinned 1.64.1): the adapter has it as
  a peer, and electron-builder drops dev deps, so the packaged app would fail at
  the first launch otherwise.
- Tests: `test/appTargets.test.ts`; the command list in `test/ipcContract.test.ts`.
