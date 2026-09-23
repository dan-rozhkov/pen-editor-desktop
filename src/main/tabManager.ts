export type UITheme = "light" | "dark";

// Mirrors src/main/mcp/service.ts's McpStatus — defined here (rather than
// imported from mcp/service.ts) so this module stays free of any dependency
// on the MCP bridge; service.ts is the one that imports this type. "off"
// means no local MCP server is running at all (should not normally happen
// once the app has started); "not-published" means our server is up but a
// different local process already owns the handshake file; "listening"
// means our server is the one a plugin/agent will discover; "error" means
// something that should have worked (binding the loopback server, writing
// the handshake file) failed outright — this must render as visibly as
// "not-published" (never as hidden "off"), since the status surface is the
// only diagnostic a packaged user has (finding 1/3).
export type McpStatus = "listening" | "not-published" | "off" | "error";

/**
 * Two kinds of tab. "editor" is the original (and default) kind — a
 * WebContentsView loading the deployed pen-editor frontend, with the
 * `preload/tab.js` bridge, MCP registration, and title/theme IPC callbacks
 * wired the way they always have been. "browser" is the built-in browser tab
 * (design doc `2026-09-18-builtin-browser-design.md`) — a plain web page with
 * no preload at all, never registered with the MCP bridge, whose title/url
 * are learned from real navigation events instead of the editor's own IPC
 * channels.
 */
export type TabKind = "editor" | "browser";

/** The navigation state a browser tab reports back into its TabState. */
export interface BrowserNavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TabViewHandle {
  loadURL(url: string): Promise<void>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(visible: boolean): void;
  destroy(): void;
  sendMenuCommand(commandId: string): void;
  focus(): void;
  /** Editor tabs only — wired by TabManager only for kind "editor". */
  onDocumentTitleChanged(cb: (title: string) => void): void;
  /** Editor tabs only — wired by TabManager only for kind "editor". */
  onThemeChanged(cb: (theme: UITheme) => void): void;
  /**
   * The webContents id backing this tab — a different id space from
   * TabManager's own sequential `id` (TabsSnapshot.activeId etc). Needed by
   * window.ts to translate "the currently active tab" into the id
   * mcp/service.ts's tab registry is actually keyed by (see
   * McpService.registerTab/setActiveTab, both keyed by webContents.id).
   */
  getWebContentsId(): number;

  // --- Browser tabs only below. Every real WebContentsView-backed
  // implementation trivially supports these (they are all thin wrappers
  // around webContents), so window.ts implements them uniformly for both
  // kinds — but TabManager only *wires* onNavigationStateChanged, and only
  // for kind "browser" (see newTab's doc comment). This is also the surface
  // window.ts adapts into browser/controller.ts's Electron-free
  // BrowserPageHandle for the BrowserController.

  /** Browser tabs only — wired by TabManager only for kind "browser". */
  onNavigationStateChanged(cb: (s: BrowserNavState) => void): void;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  /**
   * True while the tab's webContents is mid-navigation
   * (`webContents.isLoading()`). Feeds `BrowserController`'s post-click
   * settle wait (addendum F, "Load, not commit" — see browser/controller.ts)
   * so it waits for the document to actually finish loading rather than
   * merely for `getURL()` to change at navigation commit.
   */
  isLoading(): boolean;
  /**
   * Resolves once this navigation's DOM is ready (`webContents`'s
   * `dom-ready` event) — the new document exists and its script/DOM APIs
   * are usable, well before every subresource (images, ads, trackers) has
   * finished loading. `BrowserController.open` races this against the full
   * `loadURL()` promise (which only resolves at `did-finish-load`) so a
   * heavy commercial page doesn't have to fully settle before the command
   * returns — see browser/controller.ts's doc comment on `open`. Each call
   * arms a *fresh* one-shot listener for the *next* `dom-ready` event; it is
   * not a cached "has this page's DOM ever been ready" flag.
   */
  onceDomReady(): Promise<void>;
  /**
   * Optional: true while this tab's view is actually being drawn
   * (`View#getVisible()`). Fed to `browser/controller.ts`'s `BrowserPageHandle`
   * so `moveCursor` can skip the cursor overlay step entirely on a hidden
   * browser tab, where `requestAnimationFrame` never fires and the overlay
   * animation would only ever settle via its own backstop timer — see
   * `BrowserPageHandle.isVisible`'s doc comment for the full rationale.
   */
  isVisible?(): boolean;
  /**
   * Optional: full browser use (design doc `2026-09-23-full-browser-use-design.md`).
   * Structurally identical to browser/controller.ts's `BrowserPageHandle.capture`
   * — see its doc comment. Present on every tab kind in window.ts's
   * implementation (capturePage() works regardless of preload), even though
   * only a browser tab is ever screenshotted through this bridge.
   */
  capture?(): Promise<{ imageData: string; width: number; height: number } | null>;
  /**
   * Optional: structurally identical to `BrowserPageHandle.sendCdp` — see
   * its doc comment. Wired only for kind "browser" (window.ts attaches
   * `webContents.debugger` only there).
   */
  sendCdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Optional: structurally identical to `BrowserPageHandle.drainDialogs` —
   * see its doc comment.
   */
  drainDialogs?(): { type: string; message: string }[];
  /**
   * Second-pass review finding 1: applies the dialog policy to whatever JS
   * dialog is *currently open* on this tab, if any — a no-op when nothing is
   * open. window.ts's `onBrowserCommand` calls this for every browser tab
   * right before dispatching each new `browser:command`, so a dialog that
   * opened while no command was in flight (a page's `load`-handler `alert`,
   * a `setTimeout`-delayed one) gets resolved before the next command's own
   * `executeJavaScript` call would otherwise hang on it. Wired only for kind
   * "browser" (window.ts's `openDialog` tracking only exists there).
   */
  applyDialogPolicy?(): void;
}

/** What TabManager.browserHandle() hands to the browser controller (see window.ts). */
export type BrowserTabHandle = TabViewHandle;

/** A single open browser tab, as `TabManager`'s owner (window.ts) reports it
 * to `browser/controller.ts`'s `tabs()` command — structurally identical to
 * `BrowserTarget`'s own `BrowserTabInfo` there. */
export interface BrowserTabInfo {
  tabId: number;
  url: string;
  title: string;
  current: boolean;
}

/**
 * Which webContents id `McpService.setActiveTab` should be told about, given
 * the currently active tab's kind (finding 1). Browser tabs are deliberately
 * never `registerTab()`'d with the MCP bridge (design doc §1) — so if this
 * just forwarded the active tab's webContents id unconditionally, activating
 * a browser tab would point `McpService` at an id it never registered,
 * `getActiveTab()` would return null, and every un-targeted `tools/call`
 * would answer "No editor tab is open" even while an editor tab is still
 * open in another tab strip slot. The fix: report the active webContents id
 * only while an *editor* tab is active, and keep pointing at whichever
 * editor tab was last active otherwise — never null it out, which would
 * regress un-targeted calls made while the user is simply reading a browser
 * tab.
 */
export function resolveMcpActiveTab(
  activeKind: TabKind | null,
  activeWebContentsId: number | null,
  lastEditorTabId: number | null,
): number | null {
  if (activeKind === "editor") return activeWebContentsId;
  return lastEditorTabId;
}

/**
 * True exactly when `next` is the push that should move OS/DOM focus into
 * the tab bar's address input — the moment a browser tab with no URL yet
 * (a fresh File ▸ New Browser Tab, or switching to one that was already
 * open and never navigated) becomes the active tab, mirroring what every
 * real browser does with a blank new tab. The address input already carries
 * the placeholder "Search or enter address", so focusing it is the entire
 * cue a user gets that the blank tab wants input at all.
 *
 * Pure and only reads `activeId`/`activeKind`/the active tab's `url` off
 * both snapshots, so window.ts can call it on every `pushState` without
 * owning the decision itself (see window.ts's `pushState`) — and so it's
 * unit-testable with plain object fixtures, no Electron involved.
 *
 * Deliberately keyed off "the active tab id changed since the previous
 * push", not just "activeKind is browser and the active tab's url is
 * empty" — `pushState` also fires on title changes, navigation-state
 * changes, MCP status changes and window resizes, none of which may steal
 * focus from whatever the user is doing (typing in the editor, mid-word in
 * the address bar itself). A repeated push for the *same* active tab —
 * whatever else about it changed — must never re-focus.
 */
export function shouldFocusAddressBar(
  previous: TabsSnapshot | null,
  next: TabsSnapshot,
): boolean {
  if (next.activeKind !== "browser") return false;
  if (previous !== null && previous.activeId === next.activeId) return false;
  const active = next.tabs.find((t) => t.id === next.activeId);
  return (active?.url ?? "") === "";
}

export interface TabState {
  id: number;
  title: string;
  kind: TabKind;
  /** Browser tabs only: the current page URL, for the address bar. */
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface TabsSnapshot {
  tabs: TabState[];
  activeId: number | null;
  /** null when there are no tabs at all (never happens in steady state — see newTab's "never leave zero tabs" rule). */
  activeKind: TabKind | null;
  activeTheme: UITheme | null;
  mcpStatus: McpStatus;
  /**
   * The webContents id `McpService.setActiveTab` should be told about —
   * `resolveMcpActiveTab` applied to this manager's own up-to-date state
   * (see that function's doc comment). Computed here, not in window.ts,
   * because only TabManager sees a tab's destruction (closeTab calls
   * `view.destroy()` itself) in time to repoint away from a dying editor
   * tab before this snapshot goes out — window.ts just forwards the value
   * (finding 1: `lastEditorWebContentsId` used to live in window.ts as a
   * `let`, updated only from pushState, so closing the active editor tab
   * next to a browser tab left it pointing at a webContents id that was
   * about to be destroyed; `unregisterTab` would then null out
   * `McpService`'s active tab even though another editor tab was still
   * open elsewhere in the strip).
   */
  mcpActiveWebContentsId: number | null;
  /**
   * True exactly when this specific push should move OS/DOM focus into the
   * tab bar's address input. Never set by TabManager itself — `getSnapshot()`
   * leaves it `undefined` — because the decision (`shouldFocusAddressBar`
   * below) needs the *previous* pushed snapshot, which only window.ts
   * tracks (see its `pushState`). window.ts fills this field in right
   * before sending `tabbar:state`, folding the decision into the existing
   * channel instead of adding a new one.
   */
  focusAddressBar?: boolean;
}

interface TabEntry {
  id: number;
  title: string;
  kind: TabKind;
  view: TabViewHandle;
  theme: UITheme | null;
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

/**
 * Owns the ordered list of tabs — editor tabs (the original kind) and
 * browser tabs (see design doc `2026-09-18-builtin-browser-design.md`). Pure
 * logic — Electron's WebContentsView is injected via `createView` so this is
 * unit-testable.
 */
export class TabManager {
  private tabs: TabEntry[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private mcpStatus: McpStatus = "off";
  /**
   * The webContents id of the last *editor* tab that was active — feeds
   * `mcpActiveWebContentsId` in the snapshot via `resolveMcpActiveTab`.
   * Updated whenever an editor tab becomes active (`setActive`), and
   * repointed at another surviving editor tab (or nulled) the moment the
   * tab it points at is closed (`closeTab`), before that closed tab's view
   * is ever destroyed — see the doc comment on `TabsSnapshot.mcpActiveWebContentsId`.
   */
  private lastEditorWebContentsId: number | null = null;
  private lastLayout: { content: { width: number; height: number }; tabbarHeight: number } | null =
    null;
  /**
   * Full browser use (design doc `2026-09-23-full-browser-use-design.md`):
   * which browser tab (by TabManager's own sequential id, not a webContents
   * id) the agent is currently driving. `browserHandle()` prefers this tab
   * while it's still a live browser tab, falling back to the pre-existing
   * "active if browser, else most-recently-created browser tab" rule
   * otherwise — this fixes upstream jev-ultrafast #61 ("the agent sticks to
   * the old tab"): a popup opened from a browser tab (window.ts's
   * `attachBrowserTabPolicy` callback) sets this to the new tab, so the very
   * next browser command targets it even if the *active* tab in the strip
   * hasn't visibly changed yet. `tabs({action:"switch"|"new"})` also set
   * this. Cleared (not repointed, unlike `lastEditorWebContentsId`) when the
   * tab it points at closes — there is no equivalent of "another editor tab
   * is still open" fallback need here, since `browserHandle()`'s own
   * fallback rule already covers "no explicit agent tab".
   */
  private agentBrowserTabId: number | null = null;

  constructor(
    private readonly opts: {
      createView: (kind: TabKind) => TabViewHandle;
      editorUrl: string;
      onStateChanged: (s: TabsSnapshot) => void;
    },
  ) {}

  newTab(kind: TabKind = "editor"): number {
    const id = this.nextId++;
    const view = this.opts.createView(kind);
    const entry: TabEntry = {
      id,
      title: kind === "browser" ? "New Tab" : "Untitled",
      kind,
      view,
      theme: null,
      url: kind === "browser" ? "" : undefined,
      canGoBack: kind === "browser" ? false : undefined,
      canGoForward: kind === "browser" ? false : undefined,
    };
    if (kind === "editor") {
      view.onDocumentTitleChanged((title) => {
        entry.title = title;
        this.emit();
      });
      view.onThemeChanged((theme) => {
        if (entry.theme === theme) return;
        entry.theme = theme;
        this.emit();
      });
      view.loadURL(this.opts.editorUrl).catch((err) => {
        console.error("TabManager: editor tab failed to load", err);
      });
    } else {
      // Browser tabs get their own url/title updates (design doc §1) — no
      // document-title/theme IPC callbacks, since there is no preload to
      // send them. A fresh browser tab loads nothing until
      // BrowserController navigates it (browse_open).
      view.onNavigationStateChanged((s) => {
        entry.title = s.title.trim() || "New Tab";
        entry.url = s.url;
        entry.canGoBack = s.canGoBack;
        entry.canGoForward = s.canGoForward;
        this.emit();
      });
    }
    this.tabs.push(entry);
    if (this.lastLayout) this.applyLayout(entry);
    this.setActive(id);
    return id;
  }

  closeTab(id: number): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [closed] = this.tabs.splice(idx, 1);
    if (closed.kind === "editor" && this.lastEditorWebContentsId === closed.view.getWebContentsId()) {
      // The tab lastEditorWebContentsId was pointing at is the one being
      // destroyed — repoint to another surviving editor tab, or null if
      // none remain. Must happen before setActive/emit below and before
      // closed.view.destroy() at the bottom of this method, so the
      // snapshot (and McpService, via window.ts's pushState) never see a
      // dead webContents id (finding 1).
      const other = this.tabs.find((t) => t.kind === "editor");
      this.lastEditorWebContentsId = other ? other.view.getWebContentsId() : null;
    }
    if (this.agentBrowserTabId === id) this.agentBrowserTabId = null;
    if (this.tabs.length === 0) {
      this.activeId = null;
      this.newTab("editor"); // newTab emits — closing the last tab always respawns an editor tab.
    } else if (this.activeId === id) {
      const neighbor = this.tabs[Math.max(0, idx - 1)];
      this.setActive(neighbor.id); // setActive emits
    } else {
      this.emit();
    }
    try {
      closed.view.destroy();
    } catch (err) {
      console.error("TabManager: closed tab view failed to destroy", err);
    }
  }

  /**
   * User-initiated activation (a tab-strip click, or anything else that
   * means "the person looked at this tab") — as opposed to `setActive`, the
   * private helper every automatic activation (a fresh tab, closing the
   * active tab, a popup's own activation) already routes through.
   *
   * Review finding 4: activating a *browser* tab this way also makes it the
   * agent's tab (`agentBrowserTabId`) — the agent follows the user's focus.
   * Before this, `browserHandle()` kept preferring a stale
   * `agentBrowserTabId` even after the user had switched the strip to a
   * different browser tab, so the next browser command would silently act on
   * the tab the user had left, not the one they were looking at. Deliberately
   * *not* folded into `setActive` itself: a popup's own automatic activation
   * (`newTab`'s internal `setActive` call) must not repoint the agent on its
   * own — see window.ts's popup handler / review finding 7, which decides
   * that repoint explicitly instead.
   */
  activate(id: number): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.setActive(id);
    if (tab.kind === "browser") this.agentBrowserTabId = id;
  }

  nextTab(): void {
    this.cycle(1);
  }

  prevTab(): void {
    this.cycle(-1);
  }

  activeHandle(): TabViewHandle | null {
    return this.tabs.find((t) => t.id === this.activeId)?.view ?? null;
  }

  /** The browser tab the user is LOOKING at, or null when the active tab is
   * an editor tab. Not `browserHandle()`: that one prefers the agent's pinned
   * tab, which can be a hidden tab (a popup from a non-agent tab becomes the
   * active one without repointing the agent) — the address row's back/
   * forward/reload/URL entry must drive what the row is showing, never a
   * hidden page the agent is working in. */
  activeBrowserHandle(): BrowserTabHandle | null {
    const active = this.tabs.find((t) => t.id === this.activeId);
    return active?.kind === "browser" ? active.view : null;
  }

  /**
   * The browser tab the BrowserController should drive: the active tab if
   * it is a browser tab, else the most recently created browser tab, else
   * null when no browser tab is open (design doc §1/§3 — read-only browser
   * commands fail cleanly in that last case, and `ensurePage()` creates one).
   */
  browserHandle(): BrowserTabHandle | null {
    const id = this.resolveBrowserTabId();
    return id === null ? null : (this.tabs.find((t) => t.id === id)?.view ?? null);
  }

  /** Second-pass review finding 2: the TabManager id of whichever browser
   * tab `browserHandle()` would currently return — window.ts's `ensurePage`
   * uses this to pin `agentBrowserTabId` even when handing back an
   * *existing* tab (not just when creating a new one), and the popup
   * callback uses it to pin the agent's current tab before a non-agent
   * popup's own `newTab` call would otherwise make itself the active tab.
   * `browserHandle()` only ever needed the *view*, not the id, until those
   * two callers needed the id specifically — factored out here rather than
   * duplicated so the two can never drift from `browserHandle()`'s own
   * resolution rule. */
  currentBrowserTabId(): number | null {
    return this.resolveBrowserTabId();
  }

  private resolveBrowserTabId(): number | null {
    if (this.agentBrowserTabId !== null) {
      const agent = this.tabs.find((t) => t.id === this.agentBrowserTabId && t.kind === "browser");
      if (agent) return agent.id;
    }
    const active = this.tabs.find((t) => t.id === this.activeId);
    if (active?.kind === "browser") return active.id;
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      if (this.tabs[i].kind === "browser") return this.tabs[i].id;
    }
    return null;
  }

  /** Sets which browser tab (by TabManager id) the agent is driving — see
   * `agentBrowserTabId`'s doc comment. `null` clears it back to the default
   * fallback rule. Passing an id that isn't a live browser tab is silently
   * accepted (mirrors `activate`'s own leniency) — `browserHandle()` simply
   * won't find it and falls through to its existing rule. */
  setAgentBrowserTabId(id: number | null): void {
    this.agentBrowserTabId = id;
  }

  /** Full browser use's `tabs` command (browser/controller.ts): every
   * currently open browser tab, in creation order, plus which one is the
   * agent's *effective* current tab (`browserHandle()`'s own rule, not
   * necessarily the tab strip's `activeId`) — window.ts maps this straight
   * into `BrowserTarget.listPages()`. */
  listBrowserTabs(): BrowserTabInfo[] {
    const current = this.browserHandle();
    return this.tabs
      .filter((t) => t.kind === "browser")
      .map((t) => ({
        tabId: t.id,
        url: t.url ?? "",
        title: t.title,
        current: t.view === current,
      }));
  }

  /** Review finding 6: the view for one specific browser tab, by TabManager
   * id — `null` if that id isn't currently a browser tab. `browserHandle()`
   * only ever returns *one* tab's handle (the agent's current one); dialog
   * draining needs every open browser tab's own handle, tagged with its id,
   * which this (paired with `listBrowserTabs()`) provides. */
  browserTabHandleById(id: number): BrowserTabHandle | null {
    const tab = this.tabs.find((t) => t.id === id && t.kind === "browser");
    return tab ? tab.view : null;
  }

  isEditorTab(webContentsId: number): boolean {
    return this.tabs.some((t) => t.kind === "editor" && t.view.getWebContentsId() === webContentsId);
  }

  getSnapshot(): TabsSnapshot {
    const active = this.tabs.find((t) => t.id === this.activeId);
    const activeWebContentsId = active?.view.getWebContentsId() ?? null;
    return {
      tabs: this.tabs.map(({ id, title, kind, url, canGoBack, canGoForward }) => ({
        id,
        title,
        kind,
        url,
        canGoBack,
        canGoForward,
      })),
      activeId: this.activeId,
      activeKind: active?.kind ?? null,
      activeTheme: active?.theme ?? null,
      mcpStatus: this.mcpStatus,
      mcpActiveWebContentsId: resolveMcpActiveTab(active?.kind ?? null, activeWebContentsId, this.lastEditorWebContentsId),
    };
  }

  /**
   * Reports the desktop MCP bridge's publish status (see mcp/service.ts)
   * into the snapshot the tab bar renders — the tab strip's only diagnostic,
   * since a packaged app has no terminal. TabManager does not know anything
   * about MCP itself; window.ts is the one wiring service status changes
   * here, the same way it wires editor theme/title callbacks above.
   */
  setMcpStatus(status: McpStatus): void {
    if (status === this.mcpStatus) return;
    this.mcpStatus = status;
    this.emit();
  }

  layout(content: { width: number; height: number }, tabbarHeight: number): void {
    this.lastLayout = { content, tabbarHeight };
    for (const tab of this.tabs) this.applyLayout(tab);
  }

  count(): number {
    return this.tabs.length;
  }

  /**
   * Destroys every tab view without respawning a replacement — unlike
   * closeTab(), which always keeps at least one tab open. Intended for
   * window teardown (win.on("closed", ...)).
   */
  destroyAll(): void {
    const closing = this.tabs;
    this.tabs = [];
    this.activeId = null;
    for (const tab of closing) {
      try {
        tab.view.destroy();
      } catch (err) {
        console.error("TabManager: tab view failed to destroy", err);
      }
    }
  }

  private applyLayout(tab: TabEntry): void {
    if (!this.lastLayout) return;
    const { content, tabbarHeight } = this.lastLayout;
    tab.view.setBounds({
      x: 0,
      y: tabbarHeight,
      width: content.width,
      height: Math.max(0, content.height - tabbarHeight),
    });
  }

  /** Second-pass review finding 3: a user-driven tab cycle (Ctrl+Tab/
   * Ctrl+Shift+Tab, via `nextTab`/`prevTab`) landing on a browser tab
   * repoints the agent to it, the same as clicking it in the strip
   * (`activate` — finding 4 above). Before this, cycling to a browser tab
   * left `agentBrowserTabId` wherever it was, so the very next browser
   * command could silently act on a tab the user wasn't even looking at
   * anymore. Deliberately *not* folded into `setActive` itself, for the
   * same reason `activate` isn't either — `setActive` also backs every
   * *automatic* activation (a popup's own `newTab`, `closeTab`'s neighbor
   * pick), which must never repoint the agent on their own. */
  private cycle(delta: number): void {
    if (this.tabs.length === 0 || this.activeId === null) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(idx + delta + this.tabs.length) % this.tabs.length];
    this.setActive(next.id);
    if (next.kind === "browser") this.agentBrowserTabId = next.id;
  }

  private setActive(id: number): void {
    this.activeId = id;
    for (const tab of this.tabs) tab.view.setVisible(tab.id === id);
    const active = this.tabs.find((t) => t.id === id);
    active?.view.focus();
    if (active?.kind === "editor") this.lastEditorWebContentsId = active.view.getWebContentsId();
    this.emit();
  }

  private emit(): void {
    this.opts.onStateChanged(this.getSnapshot());
  }
}
