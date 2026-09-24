import path from "node:path";
import { BaseWindow, WebContentsView, Menu, ipcMain, nativeTheme, shell } from "electron";
import {
  TabManager,
  shouldFocusAddressBar,
  type TabKind,
  type TabViewHandle,
  type TabsSnapshot,
  type UITheme,
} from "./tabManager";
import { buildMenuTemplate, buildNewTabMenuTemplate } from "./menu";
import {
  attachNavigationPolicy,
  attachOfflineFallback,
  attachLocalOnlyPolicy,
  attachBrowserTabPolicy,
  decideBrowserNavigation,
  shouldDropMcpRegistration,
} from "./navigation";
import { BrowserController, type BrowserTarget, type BrowserPageHandle } from "./browser/controller";
import { resolveBrowserCursorEnabled } from "./config";
import type { McpService, IpcListenerGateway } from "./mcp/service";

export const TABBAR_HEIGHT = 38;
// The address row (design doc `2026-09-18-builtin-browser-design.md` §2) —
// rendered as a second row inside the existing tab-bar view, shown only
// when the active tab is a browser tab.
export const CHROME_HEIGHT = 32;

// Real ipcMain wiring for McpService.registerAppLevelIpc — kept here (not in
// service.ts, which stays Electron-free for testability, see its header
// comment) with the channel names written as literals so
// test/ipcContract.test.ts's mechanical source scan can find them, exactly
// like the existing tabbar ipcMain.on("tabbar:new", ...) calls below.
function createMcpIpcGateway(): IpcListenerGateway {
  const wrapped = new Map<(senderId: number, payload: unknown) => void, (event: Electron.IpcMainEvent, payload: unknown) => void>();
  return {
    on(channel, listener) {
      const w = (event: Electron.IpcMainEvent, payload: unknown) => listener(event.sender.id, payload);
      wrapped.set(listener, w);
      if (channel === "mcp:register") ipcMain.on("mcp:register", w);
      else ipcMain.on("mcp:result", w);
    },
    removeListener(channel, listener) {
      const w = wrapped.get(listener);
      if (!w) return;
      wrapped.delete(listener);
      if (channel === "mcp:register") ipcMain.removeListener("mcp:register", w);
      else ipcMain.removeListener("mcp:result", w);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One app window: a tab-bar WebContentsView on top, one WebContentsView per
 * editor tab below. All policy/tab logic lives in tabManager/menu/navigation;
 * this file only wires Electron objects together.
 *
 * `mcpService` is app-scoped (see mcp/service.ts's header) — created once in
 * index.ts and passed in here, not created per window, since a macOS window
 * close/reopen must not tear down or duplicate the MCP HTTP server or its
 * ipcMain listeners. This function only *reports* tab create/destroy/active
 * and the app-level MCP menu status into it.
 */
export function createMainWindow(editorUrl: string, mcpService: McpService): BaseWindow {
  // Idempotent — see registerAppLevelIpc's own doc comment. Safe to call on
  // every window (re)creation, including the macOS dock "activate" reopen.
  mcpService.registerAppLevelIpc(createMcpIpcGateway());
  const editorOrigin = new URL(editorUrl).origin;
  const offlineFile = path.join(__dirname, "../assets/offline.html");

  const win = new BaseWindow({
    width: 1440,
    height: 900,
    title: "Pineapple Editor",
    // Put the tab strip in the native title-bar row on macOS while keeping
    // the standard traffic-light controls. Other platforms retain their
    // normal system frame.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {}),
  });

  // --- tab bar view ---
  const tabbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/tabbar.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(tabbarView);
  attachLocalOnlyPolicy(tabbarView.webContents);
  void tabbarView.webContents.loadFile(path.join(__dirname, "../tabbar/tabbar.html"));

  const systemTheme = (): UITheme => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  // The last snapshot actually pushed — kept only so shouldFocusAddressBar
  // (tabManager.ts) has a "previous" to compare against. window.ts owns
  // this bit of bookkeeping so the pure predicate itself stays stateless;
  // it does not make the focus decision, only feeds and acts on it.
  let previousSnapshot: TabsSnapshot | null = null;
  const pushState = (s: TabsSnapshot) => {
    // s.mcpActiveWebContentsId is computed by TabManager itself (see
    // TabsSnapshot's doc comment / finding 1) — window.ts just forwards it,
    // rather than tracking "last editor tab" locally, since only TabManager
    // sees a tab's destruction in time to repoint away from a dying editor
    // tab before this snapshot goes out.
    mcpService.setActiveTab(s.mcpActiveWebContentsId);
    // A fresh, empty-URL browser tab (File ▸ New Browser Tab, or switching
    // to one that was never navigated) becoming active must put the caret
    // in the address bar, the way every real browser does on a new tab —
    // otherwise the tab is a void with no cue where to type (its content
    // area loads nothing on purpose; the input's placeholder is the only
    // explanation, and it only helps once focused). Two halves, both
    // required: focusing `tabbarView`'s own WebContentsView here (OS-level
    // — the tab bar is its own view, so focusing an input inside its DOM
    // from the renderer alone would not move where keystrokes actually go),
    // and the renderer itself focusing/selecting `#url-input` once it sees
    // `focusAddressBar` on the pushed snapshot (src/tabbar/renderer.ts).
    // shouldFocusAddressBar is deliberately keyed off "the active tab
    // changed since the previous push" so this never fires on the title/
    // navigation-state/MCP-status/resize-driven pushes that also flow
    // through here — those must never yank focus away from whatever the
    // user is doing.
    const focusAddressBar = shouldFocusAddressBar(previousSnapshot, s);
    previousSnapshot = s;
    tabbarView.webContents.send("tabbar:state", { ...s, focusAddressBar });
    tabbarView.webContents.send("tabbar:theme", s.activeTheme ?? systemTheme());
    if (focusAddressBar) tabbarView.webContents.focus();
    // The active tab's kind can change (activating a browser tab, or an
    // editor tab) without a window resize — re-run layout every time the
    // snapshot changes so the address row's height tracks activeKind
    // (design doc §2). `layout` is defined below `tabs`, but this closure is
    // never invoked until TabManager itself calls onStateChanged, which
    // happens no earlier than the first tabs.newTab() call at the bottom of
    // this function — by then `layout` is already assigned.
    layout();
  };
  // tabs.setMcpStatus() (below) folds the current MCP status into every
  // TabsSnapshot pushState already sends — the tab strip's indicator reuses
  // the existing tabbar:state channel rather than adding a fourth one (see
  // CLAUDE.md's IPC section and mcp/service.ts's McpService.getStatus()).

  // Review finding 3: JS dialogs (`alert`/`confirm`/`prompt`/`beforeunload`)
  // are auto-handled (see createView's debugger "message" listener below)
  // only while an agent browser command is actually running against that
  // tab — never on a dialog the user's own browsing raised. Before this, any
  // dialog on a browser tab's CDP session was auto-handled unconditionally,
  // so a dialog the *user* triggered themselves (typing a URL, clicking a
  // link) got silently accepted/dismissed on their behalf, with no way to
  // ever see or answer it — the opposite of the point of a JS dialog.
  // `browserCommandsInFlight` is a plain counter (not per-tab) incremented
  // and decremented around every `browser:command` dispatch in
  // `onBrowserCommand` below; a command against tab A leaves auto-handling
  // enabled for the whole window for its duration, which is deliberately
  // coarse — the agent only ever drives one tab at a time in practice, and a
  // per-tab flag would need to be threaded through every command's target
  // resolution for no real benefit.
  //
  // Second-pass review finding 1: gating on `isAgentCommandInFlight()` alone
  // left a real gap — a dialog that opens *between* commands (a page's
  // `load` handler `alert()`, or a `setTimeout`-delayed one) was never
  // handled at all, since nothing was in flight at the moment it opened, and
  // it then sat open indefinitely: every subsequent `executeJavaScript`
  // against that tab hangs until the dialog is dismissed, so every later
  // command on it silently ran out the full 20s command timeout with no
  // indication why. The policy ("the user answers dialogs raised while the
  // agent is idle") is unchanged — a dialog opening with no command in
  // flight is still left alone in the moment — but each tab's *currently
  // open* dialog (if any) is now tracked (`Page.javascriptDialogOpening`
  // sets it, `Page.javascriptDialogClosed` clears it — see createView
  // below), and `onBrowserCommand` sweeps every browser tab's tracked-open
  // dialog and applies the policy to it before dispatching the next command
  // at all — so a dialog that opened while the agent was idle gets resolved
  // (and queued for reporting) the moment the agent's next command starts,
  // rather than hanging that command's own `executeJavaScript` call.
  let browserCommandsInFlight = 0;
  const isAgentCommandInFlight = () => browserCommandsInFlight > 0;
  // Review finding 3: each tab's own dialog queue is capped — an agent loop
  // that never drains it (a crashed/stuck agent, or a page that spams
  // dialogs) must not grow this without bound; the oldest entries are
  // dropped first since the newest ones are the most likely to still be
  // relevant to whatever the agent is doing next.
  const DIALOG_QUEUE_CAP = 10;

  const themeCallbacks = new Map<number, (theme: UITheme) => void>();
  const titleCallbacks = new Map<number, (title: string) => void>();
  const onEditorTheme = (event: Electron.IpcMainEvent, theme: unknown) => {
    if (theme !== "light" && theme !== "dark") return;
    themeCallbacks.get(event.sender.id)?.(theme);
  };
  ipcMain.on("editor:theme", onEditorTheme);
  const onEditorDocumentTitle = (event: Electron.IpcMainEvent, title: unknown) => {
    if (typeof title !== "string") return;
    const normalized = title.trim().slice(0, 200) || "Untitled";
    titleCallbacks.get(event.sender.id)?.(normalized);
    // Feeds list_editor_tabs (mcp/service.ts) — keyed by the same
    // webContents id as everything else in the MCP tab registry, so it
    // never needs a separate id-translation step the way pushState above
    // does for TabManager's own sequential ids.
    mcpService.setTabTitle(event.sender.id, normalized);
  };
  ipcMain.on("editor:document-title", onEditorDocumentTitle);

  // --- tabs ---
  const tabs = new TabManager({
    editorUrl,
    onStateChanged: pushState,
    createView: (kind: TabKind): TabViewHandle => {
      const view = new WebContentsView(
        kind === "browser"
          ? {
              webPreferences: {
                // Dedicated session partition — the security boundary for
                // the built-in browser (design doc §1): the editor's
                // cookies are never in it, and whatever the user logs into
                // here is all the agent can ever reach. Deliberately no
                // preload: a browser tab must never see `penDesktop`.
                partition: "persist:penbrowser",
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            }
          : {
              webPreferences: {
                preload: path.join(__dirname, "../preload/tab.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            },
      );
      win.contentView.addChildView(view);
      const viewId = view.webContents.id;

      // Full browser use (design doc `2026-09-23-full-browser-use-design.md`):
      // a CDP session attached once per browser tab, backing `act`'s
      // press/hover (trusted Input.* events a page script can't produce) and
      // the JS-dialog auto-handle policy (CLAUDE.md's "Dialog policy").
      // Attach failure (e.g. real DevTools already attached to this tab)
      // degrades gracefully: `sendCdp`/`drainDialogs` below are left
      // undefined, so browser/controller.ts's own `if (!page.sendCdp)`
      // checks report a clear error for press/hover, and dialogs simply
      // aren't auto-handled — nothing else in this bridge depends on it.
      let debuggerAttached = false;
      const dialogQueue: { type: string; message: string }[] = [];
      // Second-pass review finding 1: the dialog currently open on this tab,
      // if any — set by `Page.javascriptDialogOpening`, cleared by
      // `Page.javascriptDialogClosed` (which fires however the dialog ends
      // up closed: our own `Page.handleJavaScriptDialog` call below, or a
      // real DevTools window if one is attached instead). `applyDialogPolicy`
      // (exposed on the returned handle) is what `onBrowserCommand` calls,
      // for every browser tab, right before dispatching each new command.
      let openDialog: { type: string; message: string } | null = null;
      const applyDialogPolicy = () => {
        if (!openDialog) return;
        const { type, message } = openDialog;
        openDialog = null;
        // Never agree to something on the user's behalf: alert/
        // beforeunload have no meaningful "no", so they're accepted;
        // confirm/prompt are dismissed.
        const accept = type === "alert" || type === "beforeunload";
        // Only a dialog the agent actually auto-handled is queued — never
        // one left for the user, since nothing here handled it.
        dialogQueue.push({ type, message });
        if (dialogQueue.length > DIALOG_QUEUE_CAP) dialogQueue.shift();
        view.webContents.debugger
          .sendCommand("Page.handleJavaScriptDialog", { accept, promptText: "" })
          .catch((err) => console.error("browser tab: failed to auto-handle JS dialog", err));
      };
      if (kind === "browser") {
        try {
          view.webContents.debugger.attach("1.3");
          debuggerAttached = true;
          view.webContents.debugger.on("message", (_event, method, params) => {
            if (method === "Page.javascriptDialogClosed") {
              openDialog = null;
              return;
            }
            if (method !== "Page.javascriptDialogOpening") return;
            const p = params as { type?: string; message?: string };
            openDialog = { type: p.type ?? "alert", message: (p.message ?? "").slice(0, 200) };
            // Review finding 3: only auto-handle immediately while an agent
            // command is actually in flight — outside of one, the dialog is
            // left open (but tracked in `openDialog`) for the user to see
            // and answer themselves, the same as in any other browser.
            // Second-pass review finding 1: if it's still open by the time
            // the agent's *next* command starts, `onBrowserCommand`'s
            // pre-dispatch sweep (via `applyDialogPolicy`) resolves it then
            // instead — see this tab's own `applyDialogPolicy` above.
            if (!isAgentCommandInFlight()) return;
            applyDialogPolicy();
          });
          view.webContents.debugger
            .sendCommand("Page.enable")
            .catch((err) => console.error("browser tab: Page.enable failed", err));
        } catch (err) {
          debuggerAttached = false;
          console.error("browser tab: debugger attach failed — press/hover/dialogs unavailable for this tab", err);
        }
      }

      if (kind === "editor") {
        attachNavigationPolicy(view.webContents, editorOrigin, (url) => void shell.openExternal(url));
        attachOfflineFallback(view.webContents, offlineFile);
        mcpService.registerTab(viewId, {
          sendMcpCall: (callId, tool, args) => view.webContents.send("mcp:call", { callId, tool, args }),
          isDestroyed: () => view.webContents.isDestroyed(),
        });
        // A tab's page reload drops whatever registerMcpBridge() call the
        // previous page made — the new page has to re-register (design doc
        // §2/§3). Only the main frame counts: an iframe navigating inside the
        // editor page is not the editor tab itself going away. `isSameDocument`
        // must also be excluded: Electron fires did-start-navigation for
        // pushState/replaceState/hash navigation too (same-document, main
        // frame), and pen-editor is a react-router SPA — an in-app link click
        // would otherwise be treated as a full page reload, dropping the
        // registration even though registerMcpBridge() was never re-run (its
        // module-scoped `teardown` guard makes initDesktopMcpBridge() a no-op
        // on the next call), permanently killing the bridge until a manual
        // reload.
        view.webContents.on("did-start-navigation", (details) => {
          if (shouldDropMcpRegistration(details)) mcpService.handleTabNavigated(viewId);
        });
      } else {
        // Browser tabs: never registered with the MCP bridge, never get the
        // editor:* IPC callbacks (there is no preload to send them from
        // anyway). Popups open as a new browser tab instead of escaping to
        // the system browser.
        attachBrowserTabPolicy(view.webContents, (url) => {
          // Review finding 7: only repoint the agent when *this* tab (the
          // one whose popup policy just fired) is the tab the agent is
          // currently driving. Before this check, a popup from *any* browser
          // tab repointed the agent — so a tab the user had open on the side,
          // unrelated to whatever the agent was doing, could silently steal
          // it. `browserHandle()` already embodies "agentBrowserTabId, or
          // today's fallback rule if unset", so comparing against it (rather
          // than agentBrowserTabId directly) covers both cases the same way
          // the rest of this bridge does.
          const openedByAgentTab = tabs.browserHandle()?.getWebContentsId() === viewId;
          if (!openedByAgentTab) {
            // Second-pass review finding 2: pin the agent's CURRENT tab id
            // before `newTab` below runs its own `setActive` — which would
            // otherwise make the popup the *active* tab in the strip.
            // `agentBrowserTabId` was commonly left `null` up to this point
            // (see finding 2's other half, in `ensurePage` below), which let
            // `browserHandle()`'s "active tab if it's a browser tab" fallback
            // silently follow this popup even though its opener has nothing
            // to do with the agent at all.
            const currentAgentTabId = tabs.currentBrowserTabId();
            if (currentAgentTabId !== null) tabs.setAgentBrowserTabId(currentAgentTabId);
          }
          const popupId = tabs.newTab("browser");
          if (openedByAgentTab) {
            // Fixes upstream jev-ultrafast #61: a popup opened from the tab
            // the agent is driving becomes the agent's new current tab, so
            // the very next browser command targets it instead of the tab
            // that spawned it.
            tabs.setAgentBrowserTabId(popupId);
          }
          // The popup still becomes the *active* tab in the strip either
          // way (newTab's own setActive call) — only whether the agent
          // follows it is conditional. newTab's internal setActive (not the
          // public activate()) deliberately does not itself touch
          // agentBrowserTabId — see activate()'s doc comment (finding 4) —
          // so a non-agent popup opens without stealing the agent even
          // though it's now the visibly active tab.
          tabs
            .activeHandle()
            ?.loadURL(url)
            .catch((err) => console.error("browser tab: popup navigation failed", err));
        });
      }

      let navListener: ((s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void) | null =
        null;
      const reportNavState = () => {
        if (!navListener) return;
        navListener({
          url: view.webContents.getURL(),
          title: view.webContents.getTitle(),
          canGoBack: view.webContents.navigationHistory.canGoBack(),
          canGoForward: view.webContents.navigationHistory.canGoForward(),
        });
      };
      view.webContents.on("did-navigate", reportNavState);
      view.webContents.on("did-navigate-in-page", reportNavState);
      view.webContents.on("page-title-updated", reportNavState);

      return {
        loadURL: (url) => view.webContents.loadURL(url),
        setBounds: (b) => view.setBounds(b),
        setVisible: (v) => view.setVisible(v),
        destroy: () => {
          themeCallbacks.delete(viewId);
          titleCallbacks.delete(viewId);
          if (kind === "editor") mcpService.unregisterTab(viewId);
          if (debuggerAttached) {
            try {
              view.webContents.debugger.detach();
            } catch (err) {
              // Already detached (e.g. Electron itself detaches on
              // webContents destruction in some paths) — not an error.
              console.error("browser tab: debugger detach failed", err);
            }
          }
          win.contentView.removeChildView(view);
          view.webContents.close();
        },
        sendMenuCommand: (id) => view.webContents.send("menu:command", id),
        focus: () => view.webContents.focus(),
        onDocumentTitleChanged: (cb) => titleCallbacks.set(viewId, cb),
        onThemeChanged: (cb) => themeCallbacks.set(viewId, cb),
        getWebContentsId: () => viewId,
        onNavigationStateChanged: (cb) => {
          navListener = cb;
        },
        getURL: () => view.webContents.getURL(),
        getTitle: () => view.webContents.getTitle(),
        goBack: () => view.webContents.navigationHistory.goBack(),
        goForward: () => view.webContents.navigationHistory.goForward(),
        reload: () => view.webContents.reload(),
        canGoBack: () => view.webContents.navigationHistory.canGoBack(),
        canGoForward: () => view.webContents.navigationHistory.canGoForward(),
        executeJavaScript: (code) => view.webContents.executeJavaScript(code),
        isLoading: () => view.webContents.isLoading(),
        // View#getVisible() — "whether the view should be drawn", per
        // Electron's own doc comment for it (electron.d.ts) — is a real,
        // shipped API on the WebContentsView/View base class in this repo's
        // pinned Electron version (43.1.1), tracking exactly what
        // TabManager.setActive's `view.setVisible(...)` calls above set, so
        // this needs no separate visibility bookkeeping of its own.
        isVisible: () => view.getVisible(),
        onceDomReady: () =>
          new Promise<void>((resolve) => {
            view.webContents.once("dom-ready", () => resolve());
          }),
        // Full browser use's `screenshot` command (browser/controller.ts).
        // Shared by both tab kinds — capturePage() needs no preload and
        // works regardless — even though only a browser tab is ever
        // screenshotted through this bridge (the editor tab has its own
        // separate `get_screenshot` tool).
        capture: async () => {
          try {
            const image = await view.webContents.capturePage();
            if (image.isEmpty()) return null;
            const size = image.getSize();
            const SCREENSHOT_MAX_WIDTH = 1280;
            const resized =
              size.width > SCREENSHOT_MAX_WIDTH
                ? image.resize({
                    width: SCREENSHOT_MAX_WIDTH,
                    height: Math.round(size.height * (SCREENSHOT_MAX_WIDTH / size.width)),
                  })
                : image;
            const outSize = resized.getSize();
            const jpeg = resized.toJPEG(70);
            return {
              imageData: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
              width: outSize.width,
              height: outSize.height,
            };
          } catch (err) {
            console.error("browser tab: screenshot capture failed", err);
            return null;
          }
        },
        // Only meaningful for kind "browser" (debuggerAttached is always
        // false for kind "editor", since the attach attempt above is
        // itself gated on kind === "browser") — see this method's own doc
        // comment above for the attach-failure degrade path.
        sendCdp: debuggerAttached
          ? (method, params) => view.webContents.debugger.sendCommand(method, params)
          : undefined,
        drainDialogs: () => dialogQueue.splice(0, dialogQueue.length),
        // Second-pass review finding 1: only meaningful for kind "browser"
        // (openDialog can only ever be set there) — harmless no-op call for
        // kind "editor" either way (`applyDialogPolicy` itself is a no-op
        // when `openDialog` is null, which it always is for an editor tab).
        applyDialogPolicy,
      };
    },
  });

  // --- built-in browser (design doc §3/§4, full browser use §"tabs") ---
  const browserTarget: BrowserTarget = {
    ensurePage: async (): Promise<BrowserPageHandle> => {
      // Second-pass review finding 2: pin agentBrowserTabId even when
      // returning an *existing* tab, not only when creating one — before
      // this, agentBrowserTabId stayed null in the common case of a second
      // (or later) call to ensurePage() against an already-open browser
      // tab, and a null agentBrowserTabId is exactly what let a non-agent
      // popup's fallback-tab rule silently steal the agent (see the popup
      // callback above).
      const existingId = tabs.currentBrowserTabId();
      if (existingId !== null) {
        tabs.setAgentBrowserTabId(existingId);
        const existing = tabs.browserHandle();
        if (existing) return existing;
      }
      const id = tabs.newTab("browser");
      // A freshly created tab becomes the agent's tab outright — there is
      // no other candidate for browserHandle()'s fallback rule to prefer
      // anyway, but this keeps agentBrowserTabId meaningful from the start
      // rather than only ever being set by a popup or an explicit
      // tabs({action:"switch"|"new"}) call.
      tabs.setAgentBrowserTabId(id);
      const created = tabs.browserHandle();
      if (!created) throw new Error("Failed to create a browser tab.");
      return created;
    },
    currentPage: (): BrowserPageHandle | null => tabs.browserHandle(),
    listPages: async () => tabs.listBrowserTabs(),
    selectPage: async (tabId: number) => {
      const found = tabs.listBrowserTabs().some((t) => t.tabId === tabId);
      if (!found) return false;
      // Second-pass review finding 10: `activate()` already sets
      // agentBrowserTabId for a browser tab (see its own doc comment) — the
      // explicit `setAgentBrowserTabId` call that used to follow it here was
      // redundant (tabId is already confirmed to be a browser tab's id, via
      // the `found` check above).
      tabs.activate(tabId);
      return true;
    },
    closePage: async (tabId: number) => {
      // "close only closes browser tabs" — an editor tab id, or any id not
      // currently open, is rejected rather than silently closing the wrong
      // kind of tab.
      const found = tabs.listBrowserTabs().some((t) => t.tabId === tabId);
      if (!found) return false;
      tabs.closeTab(tabId);
      return true;
    },
    // Review finding 9: no longer loads a url itself — `browser/controller.ts`'s
    // `tabs({action:"new", url})` now does that through `open()` (the same
    // DOM-ready-plus-grace-period wait every other navigation gets), so this
    // only ever has to create the tab and make it current. The `url`
    // parameter stays on the `BrowserTarget` interface for shape parity with
    // the other three tab-management methods, but is unused here now.
    newPage: async () => {
      const id = tabs.newTab("browser");
      tabs.setAgentBrowserTabId(id);
      const created = tabs.listBrowserTabs().find((t) => t.tabId === id);
      return created ?? { tabId: id, url: "", title: "New Tab", current: true };
    },
    // Review finding 6: every open browser tab's own handle, tagged with
    // its id — lets BrowserController.mergeDialogs drain dialogs from every
    // tab, not just whichever one browserHandle() currently prefers.
    pageHandles: async () => {
      const entries: { tabId: number; page: BrowserPageHandle }[] = [];
      for (const t of tabs.listBrowserTabs()) {
        const page = tabs.browserTabHandleById(t.tabId);
        if (page) entries.push({ tabId: t.tabId, page });
      }
      return entries;
    },
  };
  const browserController = new BrowserController(browserTarget, {
    cursor: resolveBrowserCursorEnabled(process.env),
  });

  const onBrowserCommand = async (event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    // Single source of truth for "which webContents id is an editor tab" —
    // TabManager.isEditorTab (finding 10). Deliberately not a second,
    // window.ts-local registry: two independent lists of the same fact can
    // drift, and TabManager's is already kept correct by newTab/destroy.
    if (!tabs.isEditorTab(event.sender.id)) return { error: "Not allowed." };
    if (!isRecord(payload) || typeof payload.command !== "string") {
      return { error: "Malformed browser command." };
    }
    // Second-pass review finding 1: resolve every browser tab's currently
    // open dialog (if any) before dispatching this command — see
    // `applyDialogPolicy`'s doc comment (tabManager.ts) for why this can't
    // just be "handled unconditionally while a command is in flight" (a
    // dialog that opened *between* commands would otherwise sit open
    // forever, hanging every later `executeJavaScript` call against that
    // tab). Only the agent's current browser tab is swept — never the
    // user's own tabs: a "Leave site?" or confirm() the user is still reading
    // in a tab the agent isn't driving is theirs to answer, and auto-
    // accepting it would lose their form input (third-pass review). A
    // dialog left open on a tab the agent later switches back to is swept
    // then, by that command.
    const agentTabId = tabs.currentBrowserTabId();
    if (agentTabId !== null) tabs.browserTabHandleById(agentTabId)?.applyDialogPolicy?.();
    // Review finding 3: brackets the whole dispatch, not just the
    // BrowserController call, so a dialog raised anywhere during this
    // command's async work (including its own settle waits) is auto-handled
    // — decremented in `finally` so a rejected/throwing command never leaves
    // this counter stuck above zero.
    browserCommandsInFlight++;
    try {
      switch (payload.command) {
        case "open":
          return await browserController.open(payload.args);
        case "act":
          return await browserController.act(payload.args);
        case "findImages":
          return await browserController.findImages(payload.args);
        case "snapshot":
          return await browserController.snapshot();
        case "perform":
          return await browserController.perform(payload.args);
        case "read":
          return await browserController.read(payload.args);
        case "screenshot":
          return await browserController.screenshot(payload.args);
        case "tabs":
          return await browserController.tabs(payload.args);
        default:
          return { error: `Unknown browser command: ${payload.command}` };
      }
    } finally {
      browserCommandsInFlight--;
    }
  };
  ipcMain.handle("browser:command", onBrowserCommand);

  // --- layout ---
  const layout = () => {
    const { width, height } = win.getContentBounds();
    const activeKind = tabs.getSnapshot().activeKind;
    const tabbarHeight = TABBAR_HEIGHT + (activeKind === "browser" ? CHROME_HEIGHT : 0);
    tabbarView.setBounds({ x: 0, y: 0, width, height: tabbarHeight });
    tabs.layout({ width, height }, tabbarHeight);
  };
  win.on("resize", layout);
  layout();

  // --- tab bar IPC (scoped to this window's tabbar webContents) ---
  const tabbarId = tabbarView.webContents.id;
  const fromOurTabbar = (event: Electron.IpcMainEvent) => event.sender.id === tabbarId;
  const onTabbarNew = (e: Electron.IpcMainEvent) => fromOurTabbar(e) && tabs.newTab("editor");
  // Second-pass review finding 3: a user-driven "New Browser Tab" pins the
  // agent to it, the same as any other explicit user action that lands on a
  // browser tab (activate()'s tab-strip click, nextTab/prevTab's cycle) —
  // plain `tabs.newTab("browser")` alone (used elsewhere for a *popup's*
  // automatic tab creation, which must NOT repoint the agent) leaves
  // agentBrowserTabId untouched.
  const newUserBrowserTab = () => tabs.setAgentBrowserTabId(tabs.newTab("browser"));
  // The "+" button's popup. `anchor` is the button's bottom-left corner in
  // tabbar CSS px, which is window content coordinates too: the tabbar view
  // sits at (0, 0) at zoom 1.
  const onTabbarNewMenu = (e: Electron.IpcMainEvent, anchor: unknown) => {
    if (!fromOurTabbar(e)) return;
    const at = isRecord(anchor) && typeof anchor.x === "number" && typeof anchor.y === "number"
      ? { x: Math.round(anchor.x), y: Math.round(anchor.y) }
      : {};
    Menu.buildFromTemplate(
      buildNewTabMenuTemplate({ newTab: () => tabs.newTab("editor"), newBrowserTab: newUserBrowserTab }),
    ).popup({ window: win, ...at });
  };
  const onTabbarActivate = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && tabs.activate(id);
  const onTabbarClose = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && tabs.closeTab(id);
  const onTabbarNavigate = (e: Electron.IpcMainEvent, payload: unknown) => {
    if (!fromOurTabbar(e)) return;
    if (!isRecord(payload)) return;
    const action = payload.action;
    const handle = tabs.activeBrowserHandle();
    if (!handle) return;
    if (action === "back") handle.goBack();
    else if (action === "forward") handle.goForward();
    else if (action === "reload") handle.reload();
    else if (action === "url" && typeof payload.url === "string") {
      if (decideBrowserNavigation(payload.url) !== "allow") return;
      void handle.loadURL(payload.url).catch(() => {});
    }
  };
  ipcMain.on("tabbar:new", onTabbarNew);
  ipcMain.on("tabbar:new-menu", onTabbarNewMenu);
  ipcMain.on("tabbar:activate", onTabbarActivate);
  ipcMain.on("tabbar:close", onTabbarClose);
  ipcMain.on("tabbar:navigate", onTabbarNavigate);
  // Re-send current state when the tab bar (re)loads — it may have missed
  // snapshots emitted before its DOM was ready.
  tabbarView.webContents.on("did-finish-load", () => pushState(tabs.getSnapshot()));
  const onSystemThemeChanged = () => {
    if (tabs.getSnapshot().activeTheme === null) pushState(tabs.getSnapshot());
  };
  nativeTheme.on("updated", onSystemThemeChanged);

  // --- teardown ---
  // BaseWindow instances (and everything they capture — TabManager, the tab
  // views, the tabbar view) outlive a window close on macOS, since index.ts
  // recreates a window on dock "activate" without quitting the app. Without
  // this, every close/reopen cycle leaks the ipcMain listeners above plus
  // every tab's WebContentsView (renderer process stays alive).
  win.on("closed", () => {
    ipcMain.removeListener("tabbar:new", onTabbarNew);
    ipcMain.removeListener("tabbar:new-menu", onTabbarNewMenu);
    ipcMain.removeListener("tabbar:activate", onTabbarActivate);
    ipcMain.removeListener("tabbar:close", onTabbarClose);
    ipcMain.removeListener("tabbar:navigate", onTabbarNavigate);
    ipcMain.removeListener("editor:theme", onEditorTheme);
    ipcMain.removeListener("editor:document-title", onEditorDocumentTitle);
    ipcMain.removeHandler("browser:command");
    nativeTheme.removeListener("updated", onSystemThemeChanged);
    unsubscribeMcpStatus();
    tabs.destroyAll();
    tabbarView.webContents.close();
  });

  // --- menu ---
  // Rebuilt (not just mutated) whenever MCP status changes: a native menu
  // template has no live-binding mechanism, and Menu.setApplicationMenu is
  // process-global (the wart CLAUDE.md already documents for this menu) —
  // fine for the current single-window app, revisit if multi-window support
  // is ever added.
  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate(
      buildMenuTemplate(
        {
          newTab: () => tabs.newTab("editor"),
          newBrowserTab: newUserBrowserTab,
          closeTab: () => {
            const active = tabs.getSnapshot().activeId;
            if (active !== null) tabs.closeTab(active);
          },
          nextTab: () => tabs.nextTab(),
          prevTab: () => tabs.prevTab(),
          forwardToActiveTab: (commandId) => tabs.activeHandle()?.sendMenuCommand(commandId),
          useThisAppForMcp: () => void mcpService.forcePublish(),
        },
        { isMac: process.platform === "darwin" },
        mcpService.getStatus(),
      ),
    );
    Menu.setApplicationMenu(menu);
  };
  rebuildMenu();
  tabs.setMcpStatus(mcpService.getStatus());
  const unsubscribeMcpStatus = mcpService.onStatusChanged(() => {
    tabs.setMcpStatus(mcpService.getStatus());
    rebuildMenu();
  });

  tabs.newTab("editor");
  return win;
}
