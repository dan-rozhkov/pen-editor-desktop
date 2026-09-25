import path from "node:path";
import { BaseWindow, View, WebContentsView, Menu, ipcMain, nativeTheme, shell } from "electron";
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
  shouldForwardNavigationEvent,
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

/** Wave 3 reliability, item 2: electron/electron#5183 — `executeJavaScript`
 * (main-frame or a child frame's own) only resolves once the frame stops
 * loading, so a frame that never finishes loading (a slow/broken ad iframe,
 * say) must not hang a whole `snapshot`/`read`/`findImages` call. Every
 * per-frame script call is raced against this short, frame-scoped timeout —
 * see `FRAME_SCRIPT_TIMEOUT_MS` in browser/controller.ts, which this mirrors
 * for the call sites that live in this file (frame discovery itself doesn't
 * run a script, but executeJavaScriptInFrame below does). */
function withFrameTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Frame script timed out after ${ms}ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
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
          // macOS glass tab bar (like the Codex desktop app), 2026-09-25:
          // a native frosted-glass blur of whatever is behind the window,
          // showing through the tab bar's translucent CSS background below.
          // "under-window" (not "sidebar" or "content") reads as a bar
          // sitting *above* the desktop/other windows rather than a
          // content-adjacent panel, which is the Codex look, and is the
          // material Electron recommends when the vibrant view sits at the
          // very top of the window rather than beside real window content.
          // `visualEffectState: "active"` keeps it glassy even when the
          // window loses focus — the default ("followWindow") would grey it
          // out, which is not what Codex does. A vibrant window is
          // non-opaque, so macOS edges it with a dark 1px line (it comes
          // with the shadow, which we keep); `windowRim` below paints a
          // light-grey rim just inside it, as Codex has. The tab
          // CONTENT views (editor/browser) are kept opaque so no glass ever
          // bleeds through page content.
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
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
  // macOS window rim (see the BaseWindow options above): a light-grey 1px
  // line just inside the window edge. Around the content area it is this
  // backing view showing through the 1px gap `tabs.layout(..., WINDOW_EDGE)`
  // leaves at the left/right/bottom; across the tab bar, tabbar.css draws
  // it (`--window-rim`). Added first so it sits below every other view.
  const WINDOW_EDGE = process.platform === "darwin" ? 1 : 0;
  const windowRim = WINDOW_EDGE ? new View() : null;
  if (windowRim) win.contentView.addChildView(windowRim);
  win.contentView.addChildView(tabbarView);
  attachLocalOnlyPolicy(tabbarView.webContents);
  if (process.platform === "darwin") {
    // Let the window's vibrancy material show through the tab bar's own
    // translucent CSS background (tabbar.css's `--bar-glass`/`--chrome-glass`
    // tokens) instead of painting over it with an opaque view background.
    tabbarView.setBackgroundColor("#00000000");
  }
  void tabbarView.webContents.loadFile(path.join(__dirname, "../tabbar/tabbar.html"));

  const systemTheme = (): UITheme => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  // Tab CONTENT views (editor/browser) must stay opaque no matter what the
  // glass tab bar above is doing — otherwise the desktop behind the window
  // would show through actual page content. A WebContentsView defaults to a
  // white background, which is a visible flash on a dark-theme tab before
  // its real content paints; this picks the theme-appropriate opaque color
  // instead, used both at view creation (best guess: system theme) and
  // whenever a more accurate theme becomes known (an editor tab's own
  // reported theme, or the resolved theme once a browser tab is active —
  // see setBackgroundColor usages below).
  const backgroundColorForTheme = (theme: UITheme): string => (theme === "dark" ? "#1a1a1a" : "#ffffff");
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
    const resolvedTheme = s.activeTheme ?? systemTheme();
    // Keep in sync with tabbar.css's --window-rim.
    windowRim?.setBackgroundColor(resolvedTheme === "dark" ? "#4d4d4d" : "#ececec");
    tabbarView.webContents.send("tabbar:theme", resolvedTheme);
    if (focusAddressBar) tabbarView.webContents.focus();
    // Keep a visible browser tab's own blank-canvas background matching the
    // theme the bar is now showing (glass tab bar work, 2026-09-25) — most
    // relevant right after tabs.newTab("browser") creates one (its initial
    // guess at creation time may be wrong) and whenever the editor theme
    // that drives resolveActiveTheme changes while a browser tab is active.
    // Editor tabs correct their own background directly off their own
    // onThemeChanged callback (see createView below) and don't need this.
    if (s.activeKind === "browser") {
      tabs.activeBrowserHandle()?.setBackgroundColor?.(backgroundColorForTheme(resolvedTheme));
    }
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
      // Opaque by default for both kinds — see backgroundColorForTheme's doc
      // comment above. Best guess (system theme) until something more
      // accurate is known: an editor tab corrects this itself the moment it
      // reports its own theme (onThemeChanged wiring below); a blank browser
      // tab is corrected by pushState once the resolved theme is known.
      view.setBackgroundColor(backgroundColorForTheme(systemTheme()));
      // A view's background colour is the base behind every page it shows,
      // not just a pre-paint placeholder — a site that sets no background of
      // its own relies on Chromium's default white, and would render its
      // default black text over #1a1a1a. So a browser tab is only themed
      // while blank: its first main-frame navigation drops it back to white
      // for good.
      let browserTabBlank = kind === "browser";
      if (kind === "browser") {
        view.webContents.on("did-start-navigation", (details) => {
          if (!browserTabBlank || !details.isMainFrame) return;
          browserTabBlank = false;
          view.setBackgroundColor("#ffffff");
        });
      }

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
      // Wave 1 speed (`2026-09-24-browse-speed-contract.md`): CDP
      // network-quiet settle. `Network.enable`d alongside `Page.enable`
      // below (browser tabs only) — `pendingNetworkRequests` tracks every
      // still-in-flight request by CDP `requestId`, and `networkGeneration`
      // increments once per *new* relevant request, so
      // `browser/controller.ts`'s `waitForNetworkQuiet` can tell "something
      // started since I last checked" without needing to keep dead history
      // around for completed requests (which are deleted from the map the
      // moment they finish — see the "message" listener below). WebSocket/
      // EventSource/Ping (Chromium's own type for both a `navigator.
      // sendBeacon()` call and a `<link rel=ping>`/ping-attribute request)
      // are never counted at all: none of them are the kind of
      // request-then-render a settle should wait on, and a WebSocket/
      // EventSource connection in particular never "finishes" while the page
      // is open, so counting it would make the page permanently non-quiet.
      //
      // Code review finding 2: each entry also carries the `networkGeneration`
      // value *at the moment that request started* — `networkStats`'s
      // optional `sinceGeneration` filters `pending` down to only requests
      // whose own generation is greater than it, so a request already in
      // flight before an action ran (a lazy-loading image grid still
      // fetching from an earlier scroll, say) doesn't make a no-network
      // action wait for it.
      const pendingNetworkRequests = new Map<string, { startedAt: number; generation: number }>();
      let networkGeneration = 0;
      const isIgnoredNetworkType = (type: string) => type === "WebSocket" || type === "EventSource" || type === "Ping";
      // Second-pass review finding 1: the dialog currently open on this tab,
      // if any — set by `Page.javascriptDialogOpening`, cleared by
      // `Page.javascriptDialogClosed` (which fires however the dialog ends
      // up closed: our own `Page.handleJavaScriptDialog` call below, or a
      // real DevTools window if one is attached instead). `applyDialogPolicy`
      // (exposed on the returned handle) is what `onBrowserCommand` calls,
      // for every browser tab, right before dispatching each new command.
      let openDialog: { type: string; message: string } | null = null;
      // Wave 3 reliability, item 3 (revised per code review finding 3): a
      // ring buffer of console errors observed on this tab since the last
      // drain. This used to be sourced from the CDP `Runtime` domain
      // (`Runtime.enable` + `Runtime.exceptionThrown`/`Runtime.
      // consoleAPICalled`) over the same debugger session `sendCdp`/
      // `drainDialogs` use — but `Runtime.enable` is a well-known automation
      // fingerprint (it's one of the first things anti-bot scripts check
      // for, since a real user's tab never has it on), and this is the
      // user's own real, logged-in browsing session, not a disposable
      // scraping target. It's sourced instead from Electron's own
      // `webContents.on("console-message", ...)` — no CDP `Runtime` domain
      // involved at all, undetectable the same way viewing DevTools console
      // output is. It fires for both an explicit `console.error(...)` call
      // and an uncaught JS exception (Chromium reports both to the same
      // console sink), with `details.level === "error"` covering either
      // case — confirmed in `e2e/browser-tab.spec.ts`. Capped at 50 (oldest
      // dropped first) so a page that spams errors between drains can't grow
      // this unboundedly; each entry is truncated to 200 chars at capture
      // time — "keep simple: truncate" per the design doc, rather than
      // trying to redact anything that looks like a token/email.
      // `drainConsoleErrors` (below) empties it, the same "drain on demand"
      // shape as `drainDialogs`.
      const CONSOLE_ERROR_BUFFER_CAP = 50;
      const consoleErrorBuffer: string[] = [];
      const pushConsoleError = (message: string) => {
        consoleErrorBuffer.push(message.slice(0, 200));
        if (consoleErrorBuffer.length > CONSOLE_ERROR_BUFFER_CAP) consoleErrorBuffer.shift();
      };
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
            if (method === "Page.javascriptDialogOpening") {
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
              if (isAgentCommandInFlight()) applyDialogPolicy();
              return;
            }
            // Wave 1 speed: network-quiet settle bookkeeping — see
            // pendingNetworkRequests's doc comment above.
            if (method === "Network.requestWillBeSent") {
              const p = params as { requestId?: string; type?: string };
              if (p.requestId && !isIgnoredNetworkType(p.type ?? "")) {
                networkGeneration += 1;
                pendingNetworkRequests.set(p.requestId, { startedAt: Date.now(), generation: networkGeneration });
              }
              return;
            }
            if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
              const p = params as { requestId?: string };
              if (p.requestId) pendingNetworkRequests.delete(p.requestId);
            }
          });
          view.webContents.debugger
            .sendCommand("Page.enable")
            .catch((err) => console.error("browser tab: Page.enable failed", err));
          view.webContents.debugger
            .sendCommand("Network.enable")
            .catch((err) => console.error("browser tab: Network.enable failed", err));
        } catch (err) {
          debuggerAttached = false;
          console.error("browser tab: debugger attach failed — press/hover/dialogs unavailable for this tab", err);
        }
        // Code review finding 3: console error capture no longer goes
        // through CDP's `Runtime` domain (see consoleErrorBuffer's doc
        // comment above) — wired unconditionally for a browser tab,
        // independent of whether the debugger attach above succeeded, since
        // it needs no debugger session at all.
        view.webContents.on("console-message", (details) => {
          if (details.level !== "error") return;
          pushConsoleError(details.message);
        });
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

      // Wave 1 speed: event-driven navigation detection
      // (`browser/controller.ts`'s `armNavigationWatcher`), replacing a
      // fixed-probe poll of `getURL()`/`isLoading()` with a subscription to
      // this tab's actual navigation lifecycle. All four events are wired to
      // the same broadcast — the caller only ever needs "did *something*
      // just start", never which event fired (`did-start-loading` is what
      // actually flips `isLoading()` true essentially synchronously with the
      // triggering click, same signal `waitForNavigationStart`'s polling
      // fallback already relies on; the other three cover same-document/
      // already-committed navigations that never toggle `isLoading()` at
      // all). Available for both tab kinds — cheap, and no reason to gate it
      // to "browser" the way the CDP-only features are.
      // Code review finding 1: `did-start-navigation`/`did-navigate-in-page`
      // fire for ANY frame, not just the main one (both carry `isMainFrame`
      // on their `details`/args) — an unfiltered forward meant a subframe
      // navigation (an ad/embed iframe reloading itself, say) during the
      // 80ms `NAV_START_GRACE_MS` grace window made an ordinary,
      // non-navigating click wait for the full `CLICK_LOAD_SETTLE_TIMEOUT_MS`
      // (8s) `isLoading()` settle — `isLoading()` reflects the whole tab,
      // including subframes, so it looked exactly like a real main-frame
      // navigation to `settleAfterClick`. `did-navigate` is always
      // main-frame-only per Electron's own doc ("Emitted when a main frame
      // navigation is done"), so it needs no filter. `did-start-loading`
      // carries no frame info at all and reflects the tab's overall loading
      // state (which *does* flip for a subframe load) — with nothing to
      // filter on, it's dropped from this broadcast entirely rather than
      // risk the same false-positive; `did-start-navigation` alone already
      // covers "a main-frame navigation is about to start" essentially
      // synchronously, and `did-navigate`/`did-navigate-in-page` cover
      // "one just finished/happened in-page".
      const navEventListeners = new Set<() => void>();
      const broadcastNavEvent = () => {
        for (const cb of navEventListeners) cb();
      };
      view.webContents.on("did-start-navigation", (details) => {
        if (shouldForwardNavigationEvent(details)) broadcastNavEvent();
      });
      view.webContents.on("did-navigate", broadcastNavEvent);
      view.webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
        if (shouldForwardNavigationEvent({ isMainFrame })) broadcastNavEvent();
      });

      return {
        loadURL: (url) => view.webContents.loadURL(url),
        setBounds: (b) => view.setBounds(b),
        setVisible: (v) => view.setVisible(v),
        destroy: () => {
          themeCallbacks.delete(viewId);
          titleCallbacks.delete(viewId);
          navEventListeners.clear();
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
        // Editor tabs only correct their own opaque background here, the
        // moment they report a real theme — see view.setBackgroundColor's
        // initial call above and backgroundColorForTheme's doc comment.
        onThemeChanged: (cb) =>
          themeCallbacks.set(viewId, (theme) => {
            view.setBackgroundColor(backgroundColorForTheme(theme));
            cb(theme);
          }),
        // A no-op on a browser tab that has navigated — see browserTabBlank.
        setBackgroundColor: (color) => {
          if (kind === "browser" && !browserTabBlank) return;
          view.setBackgroundColor(color);
        },
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
        // Wave 3 reliability, item 2: WebFrameMain-based iframe support.
        // `.frames` (not `.framesInSubtree`) is deliberately the DIRECT
        // children of the main frame only — one level deep. Same-origin AND
        // cross-origin/OOPIF child frames both show up here identically;
        // Electron's WebFrameMain abstracts over the process boundary, and
        // `executeJavaScript`/coordinates work the same way for either.
        // `frameTreeNodeId` (not the deprecated `routingId`) is the stable
        // per-frame id used as `frameId` throughout this bridge — fixed for
        // the frame's lifetime, browser-global.
        listFrames: () =>
          view.webContents.mainFrame.frames.map((f) => ({
            frameId: f.frameTreeNodeId,
            url: f.url,
            name: f.name,
          })),
        executeJavaScriptInFrame: async (frameId, code, timeoutMs) => {
          const frame = view.webContents.mainFrame.frames.find((f) => f.frameTreeNodeId === frameId);
          if (!frame || frame.isDestroyed()) {
            throw new Error("Frame no longer exists.");
          }
          return await withFrameTimeout(frame.executeJavaScript(code), timeoutMs);
        },
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
        // Code review finding 3: console-error capture is wired off the
        // `console-message` webContents event (see consoleErrorBuffer's doc
        // comment above), not the CDP debugger session — so this is gated on
        // `kind === "browser"` directly rather than `debuggerAttached`; it
        // stays available even on a browser tab whose debugger attach
        // failed (e.g. real DevTools already attached).
        drainConsoleErrors:
          kind === "browser" ? () => consoleErrorBuffer.splice(0, consoleErrorBuffer.length) : undefined,
        // Second-pass review finding 1: only meaningful for kind "browser"
        // (openDialog can only ever be set there) — harmless no-op call for
        // kind "editor" either way (`applyDialogPolicy` itself is a no-op
        // when `openDialog` is null, which it always is for an editor tab).
        applyDialogPolicy,
        // Wave 1 speed: see navEventListeners's doc comment above.
        onNavigationEvent: (cb: () => void) => {
          navEventListeners.add(cb);
          return () => navEventListeners.delete(cb);
        },
        // Only meaningful for kind "browser" (debuggerAttached is always
        // false for kind "editor", same gate as sendCdp above).
        networkStats: debuggerAttached
          ? (dropAfterMs: number, sinceGeneration?: number) => {
              const now = Date.now();
              let pending = 0;
              for (const [id, req] of pendingNetworkRequests) {
                if (now - req.startedAt > dropAfterMs) {
                  pendingNetworkRequests.delete(id);
                  continue;
                }
                // Code review finding 2: when scoped, only count requests
                // that started AFTER the caller's baseline generation — a
                // request already in flight before that baseline was
                // captured must not count as "pending" for it.
                if (sinceGeneration === undefined || req.generation > sinceGeneration) pending += 1;
              }
              return { pending, generation: networkGeneration };
            }
          : undefined,
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
    windowRim?.setBounds({ x: 0, y: tabbarHeight, width, height: Math.max(0, height - tabbarHeight) });
    tabs.layout({ width, height }, tabbarHeight, WINDOW_EDGE);
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
