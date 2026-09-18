# Built-in browser tab + agent browsing tools

Status: design, 2026-09-18.

## Problem

The design agent's only source of visual references is Mobbin, reached as an
MCP server on the backend behind a per-user OAuth token
(`X-Mobbin-Token`). Refero is already gone. That leaves reference search
limited to one curated catalogue, gated on a per-user credential that most
sessions do not carry — `src/skills/research.md` already says the Mobbin
tools "only exist in this turn's tool set when the user has connected their
own Mobbin account".

The desktop shell is the one place that can do better: it is a real browser.
Giving it a browser tab the agent can drive turns the whole open web —
Pinterest in particular — into the reference source, using the user's own
logged-in session.

## Shape of the solution

A new kind of tab in the Electron shell, plus three client-executed agent
tools that drive it. The data path reuses the split-execution architecture
already in place, with one extra hop:

```
chat agent
  → backend penTools schema (no `execute`)
  → browser: toolHandlers[...] in pen-editor
  → window.penDesktop.browser.* (preload)
  → ipcRenderer.invoke("browser:command")
  → main: BrowserController
  → browser WebContentsView (executeJavaScript)
  → JSON back up the same chain
```

Nothing new is added to the desktop's own MCP surface
(`src/main/mcp/toolManifest.json`). That manifest is cross-checked against
the backend's `src/mcp/toolNames.ts` — a different list from `penTools` —
and its "exactly one desktop-only name" invariant stays untouched.

## 1. Tab kinds (pen-editor-desktop)

`TabManager` currently assumes every tab is an editor tab: it loads
`editorUrl`, registers the view into `McpService`, and wires title/theme
callbacks. All of that becomes conditional on the tab's kind.

```ts
export type TabKind = "editor" | "browser";

export interface TabState {
  id: number;
  title: string;
  kind: TabKind;
  /** Browser tabs only: the current page URL, for the address bar. */
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}
```

- `newTab(kind: TabKind = "editor"): number`.
- `createView` becomes `createView(kind: TabKind): TabViewHandle`.
- `TabsSnapshot.tabs` carries `kind`; `TabsSnapshot` gains
  `activeKind: TabKind | null` so the tab bar knows whether to show the
  address row.
- `closeTab`'s "never leave zero tabs" rule respawns an **editor** tab, as
  today.
- `browserHandle(): BrowserTabHandle | null` returns the active browser tab
  if there is one, else the most recently created browser tab, else null.
  This is what the controller drives (see §4 on target selection).

### Browser view construction (window.ts)

```ts
new WebContentsView({
  webPreferences: {
    partition: "persist:penbrowser",
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // deliberately NO preload: a browser tab must never see penDesktop
  },
});
```

The dedicated session partition is the security boundary. The editor's
cookies are not in it, and whatever the user logs into inside the browser
tab is what the agent can reach — nothing else.

A browser tab is never passed to `mcpService.registerTab()`, never gets the
`editor:*` IPC callbacks, and is skipped by
`shouldDropMcpRegistration` wiring.

### Navigation policy

Editor tabs keep `attachNavigationPolicy` exactly as-is. Browser tabs get a
new policy in `navigation.ts`:

```ts
/** Browser tabs: any http(s) navigation is allowed in place; anything else
 *  (file:, custom schemes) is denied. Popups open as a new browser tab
 *  rather than escaping to the system browser. */
export function attachBrowserTabPolicy(
  contents: WebContents,
  openInNewBrowserTab: (url: string) => void,
): void;
```

`decideBrowserNavigation(targetUrl): "allow" | "deny"` is the pure half,
unit-tested like `decideNavigation`.

## 2. Address bar (pen-editor-desktop)

Rendered as a second row **inside the existing tab-bar view** — no new
`WebContentsView`, no new preload.

- `TABBAR_HEIGHT = 38` stays; `CHROME_HEIGHT = 32` is new.
- `window.ts`'s `layout()` sizes the tab-bar view to
  `TABBAR_HEIGHT + (activeKind === "browser" ? CHROME_HEIGHT : 0)` and
  passes that same total as `tabs.layout(..., tabbarHeight)`, so content
  views sit below it. `layout()` is re-run from `pushState` because the
  active tab's kind can change without a window resize.
- `src/tabbar/renderer.ts` renders the row from the existing `tabbar:state`
  snapshot: back, forward, reload, and a URL input. Submitting the input
  sends `tabbar:navigate`.
- Typed input is normalized in the renderer: a string with no scheme and no
  dot becomes a Pinterest search URL; otherwise `https://` is prepended.
  (Keeps the common case — typing a query — one keystroke cheap.)

New IPC channels (both must be added to `test/ipcContract.test.ts`'s
`CHANNELS` table and to CLAUDE.md's IPC section):

- `tabbar:navigate` renderer→main — `{ action: "url" | "back" | "forward" | "reload", url?: string }`
- `browser:command` renderer→main (**invoke/handle**, request-response)

`browser:command` is sent by the *editor* tab preload, not the tab bar.
`ipcMain.handle` must be torn down with `removeHandler` on window close, and
the handler must verify `event.sender.id` belongs to a registered editor tab
before doing anything — the same identity check pattern as
`fromOurTabbar` and `McpService.handleRegister`.

## 3. BrowserController (pen-editor-desktop)

`src/main/browser/controller.ts`. Electron-free, in the style of
`mcp/dispatcher.ts`: the page is injected.

```ts
export interface BrowserPageHandle {
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
}

export interface BrowserTarget {
  /** Resolves the tab to drive, creating one if none exists. */
  ensurePage(): Promise<BrowserPageHandle>;
  /** Null when no browser tab is open — read-only commands fail cleanly. */
  currentPage(): BrowserPageHandle | null;
}

export class BrowserController {
  constructor(target: BrowserTarget, opts?: { timeoutMs?: number });
  open(args: unknown): Promise<BrowserCommandResult>;
  act(args: unknown): Promise<BrowserCommandResult>;
  findImages(args: unknown): Promise<BrowserCommandResult>;
}
```

Every method takes `unknown` and validates it — these arguments come from an
LLM through a renderer, so neither the shape nor the types can be trusted.
Every method resolves; failures come back as `{ error: string }`, never a
rejection, matching how `toolHandlers` behave everywhere else in this
project.

`BROWSER_COMMAND_TIMEOUT_MS = 20_000`, below the frontend's per-tool
timeout so the agent gets a real message rather than a generic timeout.

### Page scripts

`src/main/browser/pageScripts.ts` exports the injected scripts as plain
string constants (`FIND_IMAGES_JS`, `CLICK_JS`, `TYPE_JS`, `SCROLL_JS`).
Each is an IIFE returning a JSON-serializable value. They are executed with
`executeJavaScript(code)`; arguments are passed by JSON-embedding them into
the script source via `JSON.stringify`, never by string concatenation of raw
values.

`FIND_IMAGES_JS` collects, for every `<img>` and every element with a
`background-image`:

- `url` — absolute, resolved against the document
- `alt` — trimmed, capped at 200 chars
- `width` / `height` — rendered size

then filters by `minWidth`/`minHeight`, de-duplicates by URL, sorts by area
descending, and caps at `limit`. Pinterest serves grid thumbnails at a
predictable path; the script does **not** try to rewrite URLs to higher
resolutions — that is a site-specific heuristic that would rot. It returns
what the page actually shows.

## 4. The three agent tools

Compact on purpose — three tools rather than one per verb, matching how
`batch_design` groups operations.

### `browse_open`

```
{ url: string }
```
Opens the built-in browser tab (creating it if needed), navigates, waits for
load, returns `{ url, title }` — the *final* URL after redirects.

### `browse_act`

```
{ action: "click" | "type" | "scroll" | "back" | "forward",
  target?: string,   // visible text or CSS selector, for click/type
  text?: string,     // for type
  amount?: number }  // for scroll, in viewport heights, default 1
```
`target` is matched first as a CSS selector, then as visible text
(case-insensitive, trimmed, first match in document order). Returns
`{ url, title, matched: string }` or `{ error }` naming what was not found.

Scrolling is what makes Pinterest usable — its grid is infinite-scroll, so
the agent scrolls, then calls `browse_find_images` again.

### `browse_find_images`

```
{ minWidth?: number,   // default 200
  minHeight?: number,  // default 200
  limit?: number }     // default 30, hard cap 100
```
Returns `{ images: [{ url, alt, width, height }], count, pageUrl }`.

The returned URLs go straight onto the canvas: `imageFill.url` already
accepts remote http(s) URLs and falls back to `/api/image-proxy` when direct
loading trips CORS. No new image plumbing is needed.

## 5. Preload surface (pen-editor-desktop)

`src/preload/tab.ts` gains, alongside `registerMcpBridge`:

```ts
browser: {
  open(args: { url: string }): Promise<unknown>;
  act(args: Record<string, unknown>): Promise<unknown>;
  findImages(args: Record<string, unknown>): Promise<unknown>;
}
```

Each is `ipcRenderer.invoke("browser:command", { command, args })`. The
preload does no validation of its own — main is the trust boundary and
validates everything.

## 6. Frontend (pen-editor)

Three handlers in `src/lib/tools/browser/`, registered in
`src/lib/toolRegistry.ts`'s `toolHandlers` under `browse_open`,
`browse_act`, `browse_find_images`.

Each handler:

1. reads `window.penDesktop?.browser`; if absent, returns
   `JSON.stringify({ error: "The built-in browser is only available in the Pineapple Editor desktop app." })`
2. otherwise forwards the args and returns `JSON.stringify(result)`.

`PenDesktopApi` in `src/lib/desktopBridge.ts` gains the optional `browser`
member.

**Not** added to `src/lib/mcpToolNames.ts`: these are chat-path tools, not
part of the external MCP/WebMCP surface. Keeping them out is what leaves the
desktop's `toolManifest.json` and its contract test untouched.

### Capability signal

`useDesignChat.ts` sends a new body field on every chat request:

```ts
clientCapabilities: { desktopBrowser: Boolean(window.penDesktop?.browser) }
```

It is derived once at module scope, so it is constant for a session and
cannot vary mid-conversation — a request-to-request change would alter the
tool set, and the tool set is part of the cached request prefix.

## 7. Backend (pen-editor-backend)

- Three entries added to `penTools` in `src/ai/tools.ts`, **without**
  `execute` (client-executed), with zod schemas matching §4 exactly.
- `chatBodySchema` in `src/routes/chat.ts` gains
  `clientCapabilities: z.object({ desktopBrowser: z.boolean().optional() }).optional()`,
  threaded into `prepareChatTurn`'s input.
- `prepareChatTurn` gates them right beside the existing `get_screenshot` /
  `analyze_image` / `attach_local_repo` gates:

  ```ts
  if (!input.clientCapabilities?.desktopBrowser) {
    delete tools.browse_open;
    delete tools.browse_act;
    delete tools.browse_find_images;
  }
  ```

- `src/mcp/toolNames.ts` is **not** touched.
- `test/tools-contract.test.ts`'s pinned name list and its
  client-executed list both gain the three names.
- `src/skills/research.md` gains a section telling the agent that when
  `browse_*` tools are present it has a real browser and should prefer it
  for open-web references, with Pinterest search named as the worked
  example, while keeping Mobbin as the curated-catalogue path when its
  tools are present.

## 8. Merge order

Desktop → backend → frontend.

The desktop change is self-contained: `penDesktop.browser` sitting unused
breaks nothing. The backend schemas land next. The frontend lands last and
is what closes the contract — pen-editor's `contract` CI job checks out the
backend's `main` at run time, so landing the frontend handler before the
backend schema would fail that job on every push until the backend caught
up.

## 9. Testing

**Desktop**
- `test/browserController.test.ts` — every command against a fake
  `BrowserPageHandle`: happy paths, malformed LLM arguments (wrong types,
  missing fields, non-http URLs), no-browser-tab-open, page script throwing,
  timeout.
- `test/navigation.test.ts` — `decideBrowserNavigation` cases.
- `test/tabManager.test.ts` — browser tabs are not MCP-registered, closing
  the last tab respawns an editor tab, `activeKind` tracks the active tab.
- `test/ipcContract.test.ts` — the two new channels, including
  `removeHandler` teardown for `browser:command`.
- `e2e/browser-tab.spec.ts` — the real thing: the stub HTTP server serves a
  fixture page with images of known sizes; the spec opens a browser tab,
  drives `browse_find_images` and `browse_act` through the preload from the
  stub editor page, and asserts the extracted URLs/sizes. This is where the
  injected page scripts are exercised against a real DOM, so no new test
  dependency is needed.

**Frontend**
- Handler tests with a stubbed `window.penDesktop.browser`, plus the
  not-desktop branch returning the documented error string.

**Backend**
- Updated pinned lists in `test/tools-contract.test.ts`.
- A `prepareChatTurn` test asserting the three tools are absent without the
  capability flag and present with it.

## 10. Deliberately out of scope

- Rewriting image URLs to higher resolutions per site. Site-specific and
  rots.
- Reading page text / raw HTML. Only image discovery was asked for; the
  controller's shape leaves room for a `browse_read` later.
- Downloading images into the document. `imageFill.url` already renders
  remote URLs through the existing proxy.
- Any allowlist of navigable sites. Full page control was an explicit
  decision; the session partition is the boundary instead.
