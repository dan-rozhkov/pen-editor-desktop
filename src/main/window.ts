import { shouldForwardMenuCommand } from "./menuTarget";
import { normalizePageColor, PAGE_BG_FALLBACK, SAMPLE_PAGE_BG_SCRIPT } from "./pageBackground";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { app, BaseWindow, View, WebContentsView, Menu, dialog, ipcMain, nativeTheme, session, shell, systemPreferences, webContents } from "electron";
import {
  TabManager,
  shouldFocusAddressBar,
  parseReorderPayload,
  type TabKind,
  type TabViewHandle,
  type TabsSnapshot,
  type UITheme,
} from "./tabManager";
import { buildMenuTemplate, buildNewTabMenuTemplate } from "./menu";
import {
  buildBrowserToolsMenuTemplate,
  planClearCommands,
  planViewportCommands,
  viewportNeedsReload,
  type ViewportPresetId,
} from "./browserToolsMenu";
import {
  PANEL_ANIMATION_FRAME_MS,
  createPanelAnimator,
  panelAnimationFrame,
  shellMotionEnabled,
  type PanelFrame,
} from "./panelAnimation";
import { createFailedRequestRecorder } from "./failedRequests";
import { createClosedRequestBuffer, createRequestLog, type ClosedRequestBuffer } from "./requestLog";
import { createAgentEmulationTracker } from "./agentEmulation";
import { createRunBoundary } from "./runBoundary";
import {
  attachNavigationPolicy,
  attachPanelNavigationPolicy,
  attachOfflineFallback,
  attachLocalOnlyPolicy,
  attachBrowserTabPolicy,
  shouldDropMcpRegistration,
  shouldForwardNavigationEvent,
} from "./navigation";
import {
  BrowserController,
  decideBrowserNavigation,
  type BrowserTarget,
  type BrowserPageHandle,
  isFetchableStylesheetUrl,
} from "@sideform/browser-agent/controller";
import { resolveAgentPanelUrl, resolveCanvasTabUrl, INITIAL_TABS, isEnvValueSet } from "./config";
import { nativeAppsArguments, secureWebPreferences } from "./webPreferences";
import { ADDRESS_ROW_HEIGHT, ISLAND_GAP, ISLAND_RADIUS, TAB_ROW_HEIGHT, agentPanelWidthFor, computeWindowLayout, type WindowLayout } from "./layout";
import { activeTabChanged, isAuthSignInSender, pickAuthReceiver, type AuthTokenPayload, type DesktopAuth } from "./desktopAuth";
import { AGENT_PANEL_SETTINGS_FILE, readAgentPanelSettings, writeAgentPanelSettings } from "./agentPanelSettings";
import { isRecord, parseJournalOrigins, parseToken, rawToken } from "./checkpointArgs";
import { JournalOwners } from "./journalOwners";
import { FixtureOwners } from "./fixtureOwners";
import { isBrowserOwner as isBrowserOwnerId, isOrphaningEvent } from "./orphanRelease";
import { CanvasLinkRouter } from "./canvasLink";
import { openDocTab } from "./docOpen";
import { openWorkflowTab } from "./workflowOpen";
import { addLoginCopy } from "./loginsIpc";
import { handleDocExportPdf } from "./docPdfExport";
import { handleDocDelete, handleDocList, handleDocSave, type DocIpcDeps } from "./docIpc";
import { createDocStore, docDirFor, nodeDocFs, type DocStore } from "./docStore";
import { openTraceTab } from "./traceOpen";
import { openSettings } from "./settingsOpen";
import { handleTraceListTabs, handleTraceRead, handleTraceSave, type TraceIpcDeps } from "./traceIpc";
import { createTraceStore, nodeTraceFs, TRACE_DIR } from "./traceStore";
import { FetchRouter } from "./fetchRouting";
import { BLANK_DOCUMENT_URL, createCommitGate } from "./commitGate";
import * as fixtureSession from "./fixtureSession";
import { computerUseDeps } from "./computerUse/service";
import { computerUseAvailable, setNativeCursorEnabled } from "./computerUse/helper";
import { CURSOR_SETTINGS_FILE, type CursorSettings, readCursorSettings, resolveCursorSettings, writeCursorSettings } from "./cursorSettings";
import type { McpService, IpcListenerGateway } from "./mcp/service";
import { fillLogin } from "./browser/fillLogin";
import { releaseAnswer } from "./releaseAnswer";
import { isLoginBindingCall, promptChoiceFromButton, savePromptCopy, type LoginCapture } from "./browser/loginCapture";
import { normalizeOrigin, type CredentialStore } from "./browser/credentialStore";
import type { FaviconCache } from "./browser/faviconCache";
import type { PasswordsService } from "./passwordsService";
import { appKey, errorForPlan, openApp, ownedBySender, ownedBySession, planAppCommand, routeAppCommand } from "./appTargets";
import { appConfirm, appRegistry, cancelWaiters, findUserRunningPids, quitUserApp, reopenApp, reopenWhenGone, validateRequestedApp } from "./appTargetsService";
import { createTabAgentActivity, isAgentPageCommand } from "./agentActivity";
import { decideCloseTarget } from "./closeTarget";
import { focusAfterCollapse, isTabCreationSender, planEmptyViewUpdate, resolveFocusTarget, type EmptyViewState } from "./emptyView";
import { GLASS_SOLID, adoptPanelTheme, contentBackground, FALLBACK_THEME, glassTint, isPanelDocument, resolveWindowTheme, } from "./windowTheme";
import { denyAllPermissions } from "./browser/permissions";
import {
  BrowserSessions,
  ERR_INVALID_SESSION_ID,
  ERR_SESSION_CLOSED,
  ERR_SESSION_NOT_OWNED,
  PartitionPool,
  SlotUnusableError,
  ScopeCounter,
  planSessionCommand,
  parseSessionId,
} from "./browserSessions";

/**
 * App-wide, shared by every window: the partitions `qa-0`..`qa-5` that isolated
 * sessions take turns in. The wait for a free slot is tunable for tests.
 */
// One document store per PROCESS: its rev cache and per-id chains must outlive any window,
// or a reopened window (macOS dock) could race the closed window's pending writes.
let processDocStore: DocStore | null = null;
function getDocStore(): DocStore {
  processDocStore ??= createDocStore({
    rootDir: path.join(app.getPath("userData"), docDirFor(isEnvValueSet(process.env.PEN_DESKTOP_URL))),
    fs: nodeDocFs,
  });
  return processDocStore;
}

const partitionPool = new PartitionPool(undefined, Number(process.env.PEN_DESKTOP_SESSION_SLOT_WAIT_MS) || undefined);

/** Per-session state of an isolated browser session (see browserSessions.ts). */
interface SessionCtx {
  ses: Electron.Session;
  router: FetchRouter;
  controller: BrowserController;
  journal: JournalOwners;
  /** Set when the drain timed out and the tabs were closed early. */
  tabsClosed?: Promise<boolean>;
}

/** App-scoped saved-logins services (created once in index.ts, like mcpService). */
export interface LoginServices {
  credentialStore: CredentialStore;
  faviconCache: FaviconCache;
  loginCapture: LoginCapture;
  passwords: PasswordsService;
}

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

/** Isolated JS world id for executeJavaScriptIsolated (arbitrary, fixed). */
const ISOLATED_WORLD_ID = 1999;

/** Wave 3 reliability, item 2: electron/electron#5183 — `executeJavaScript`
 * (main-frame or a child frame's own) only resolves once the frame stops
 * loading, so a frame that never finishes loading (a slow/broken ad iframe,
 * say) must not hang a whole `snapshot`/`read`/`findImages` call. Every
 * per-frame script call is raced against this short, frame-scoped timeout —
 * see `FRAME_SCRIPT_TIMEOUT_MS` in @sideform/browser-agent/controller, which this mirrors
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
export function createMainWindow(
  editorUrl: string,
  mcpService: McpService,
  loginServices: LoginServices,
  desktopAuth: DesktopAuth,
): BaseWindow {
  // Idempotent — see registerAppLevelIpc's own doc comment. Safe to call on
  // every window (re)creation, including the macOS dock "activate" reopen.
  mcpService.registerAppLevelIpc(createMcpIpcGateway());
  const editorOrigin = new URL(editorUrl).origin;
  // THE one place the URL of a new editor tab is decided: the chat is in the
  // left panel, so tabs are canvas tabs (`?chat=off`). Every editor-tab creation
  // path goes through TabManager, which gets only this.
  const tabEditorUrl = resolveCanvasTabUrl(editorUrl);
  const offlineFile = path.join(__dirname, "../assets/offline.html");

  const win = new BaseWindow({
    width: 1440,
    height: 900,
    title: "Sideform Desktop",
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
          // with the shadow, which we keep); the tab
          // CONTENT views (editor/browser) are kept opaque so no glass ever
          // bleeds through page content.
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : {}),
  });

  const themeKey = Symbol("main-window-theme");
  // The OS appearance (vibrancy) is never changed; the glass is tinted
  // instead (`glassTintView`, windowTheme.ts `glassTint`). Fallback theme and colours: windowTheme.ts.

  // --- tab bar view ---
  const tabbarView = new WebContentsView({
    webPreferences: secureWebPreferences(path.join(__dirname, "../preload/tabbar.js")),
  });
  // Glass + islands (layout.ts): no rim, the window glass shows between the
  // islands. On macOS a plain View at the very bottom paints the glass tint
  // (translucent editor-theme colour) over the vibrancy; no page, no IPC.
  const glassTintView = process.platform === "darwin" ? new View() : null;
  if (glassTintView) win.contentView.addChildView(glassTintView);
  win.contentView.addChildView(tabbarView);
  attachLocalOnlyPolicy(tabbarView.webContents);

  // Tab bar sits directly on the glass.
  tabbarView.setBackgroundColor("#00000000");
  // Not macOS: no vibrancy, so a solid neutral reads as the "glass" colour
  // (updated per theme in pushState).
  if (process.platform !== "darwin") win.setBackgroundColor(GLASS_SOLID[FALLBACK_THEME]);
  void tabbarView.webContents.loadFile(path.join(__dirname, "../tabbar/tabbar.html"));

  // Tab CONTENT views (editor/browser) must stay opaque no matter what the
  // glass tab bar above is doing — otherwise the desktop behind the window
  // would show through actual page content. A WebContentsView defaults to a
  // white background, which is a visible flash on a dark-theme tab before
  // its real content paints; this picks the theme-appropriate opaque color
  // instead, used both at view creation (best guess: system theme) and
  // whenever a more accurate theme becomes known (an editor tab's own
  // reported theme, or the resolved theme once a browser tab is active —
  // see setBackgroundColor usages below).
  const backgroundColorForTheme = (theme: UITheme): string => contentBackground(theme);

  // --- agent panel ---
  // Not a tab: never given to TabManager or mcpService (no mcp access). Its
  // preload exposes the browser bridge (browser:command, owner-checked by
  // isBrowserOwner below) and the canvas link (canvas:*). It sits below the
  // tab bar (see layout.ts); an opaque, theme-matched background like the tab
  // content views, updated in pushState.
  const panelUrl = resolveAgentPanelUrl(editorUrl);
  const agentPanelView = new WebContentsView({
    webPreferences: secureWebPreferences(path.join(__dirname, "../preload/agentPanel.js"), { additionalArguments: nativeAppsArguments(computerUseAvailable()) }),
  });
  win.contentView.addChildView(agentPanelView);
  agentPanelView.setBackgroundColor(backgroundColorForTheme(FALLBACK_THEME));
  agentPanelView.setBorderRadius(ISLAND_RADIUS);
  // Anything but the panel's own page is not for the panel: other editor
  // origin pages open as an editor tab (the canvas-tab URL), foreign origins go to
  // the system browser.
  attachPanelNavigationPolicy(
    agentPanelView.webContents,
    panelUrl,
    (url) => void shell.openExternal(url),
    () => void tabs.newTab("editor"),
  );
  attachOfflineFallback(agentPanelView.webContents, offlineFile);
  void agentPanelView.webContents.loadURL(panelUrl);
  // The panel page paints the stored editor theme (`ui-theme`, `.dark` on <html>); its preload
  // observes that class and sends `panel:theme` (handler `onPanelTheme`, below). adoptPanelTheme
  // (windowTheme.ts) decides whether main follows it.
  // --- empty state: shown in the tab area while the window has no tab ---
  // The window starts with zero tabs (config.ts INITIAL_TABS) and returns to
  // zero when the last tab closes. A local page (no remote content) with its
  // OWN minimal preload (preload/empty.ts): its two buttons send the same events
  // as the "+" menu. Added after the panel, hidden until pushState sees no active tab.
  let emptyState: EmptyViewState = { visible: false, theme: FALLBACK_THEME, sessionTabs: 0 };
  // The placeholder's one state message: it carries the theme and the count of
  // background session tabs (the page shows a note when the count is above 0).
  const sendEmptyState = (wc: Electron.WebContents) =>
    wc.send("tabbar:theme", { theme: emptyState.theme, sessionTabs: emptyState.sessionTabs });
  // True only while a tab the PERSON closed (close button, Cmd/Ctrl+W, menu)
  // is being closed: it decides where focus goes when the placeholder appears.
  let userClosingTab = false;
  const closeTabByUser = (id: number) => {
    userClosingTab = true;
    try {
      tabs.closeTab(id);
    } finally {
      userClosingTab = false;
    }
  };
  // The last editor theme any tab reported: keeps the chrome stable at zero tabs.
  let rememberedEditorTheme: UITheme | null = null;
  // True while `rememberedEditorTheme` came from the agent panel page, not from an editor tab (an editor's own report always wins).
  let rememberedFromPanel = false;
  // Doc, trace and Settings tabs report the editor theme like canvas tabs do (same preload), so they count here.
  const editorTabCount = (s: TabsSnapshot) => s.tabs.filter((t) => t.kind === "editor" || t.kind === "doc" || t.kind === "workflow" || t.kind === "trace" || t.kind === "settings").length;
  let lastResolvedForTint: UITheme = FALLBACK_THEME;
  const emptyView = new WebContentsView({
    webPreferences: secureWebPreferences(path.join(__dirname, "../preload/empty.js")),
  });
  win.contentView.addChildView(emptyView);
  attachLocalOnlyPolicy(emptyView.webContents);
  emptyView.setBackgroundColor(backgroundColorForTheme(FALLBACK_THEME));
  emptyView.setBorderRadius(ISLAND_RADIUS);
  emptyView.setVisible(false);
  void emptyView.webContents.loadFile(path.join(__dirname, "../tabbar/empty.html"));
  // The page may finish loading after the first pushState: hand it the latest theme.
  emptyView.webContents.on("did-finish-load", () => sendEmptyState(emptyView.webContents));
  // A crashed placeholder renderer would leave the tab area blank: reload the local page.
  emptyView.webContents.on("render-process-gone", () => {
    if (!emptyView.webContents.isDestroyed()) void emptyView.webContents.loadFile(path.join(__dirname, "../tabbar/empty.html"));
  });
  // --- canvas link: panel <-> canvas tabs, see canvasLink.ts ---
  // Pure router; this adapts Electron (sender checks, sends, tab actions). The
  // sends sit here, with literal channel names, for test/ipcContract.test.ts.
  const panelWc = () => (!agentPanelView.webContents.isDestroyed() ? agentPanelView.webContents : null);
  const canvasLink = new CanvasLinkRouter({
      isEditorTab: (id) => tabs.isEditorTab(id),
      isPanel: (id) => panelWc()?.id === id,
      sendFromTab: (msg) => {
        const wc = panelWc();
        wc?.send("canvas:from-tab", msg);
      },
      sendTabs: (list) => {
        const wc = panelWc();
        wc?.send("canvas:tabs", list);
      },
      sendFromPanel: (id, env) => {
        const wc = webContents.fromId(id);
        if (wc && !wc.isDestroyed()) wc.send("canvas:from-panel", env);
      },
      openEditorTab: (activate) => {
        const id = tabs.newTab("editor", undefined, { activate });
        return tabs.webContentsIdOf(id) as number;
      },
      activateTab: (id) => tabs.activateEditorByWebContentsId(id),
      now: () => performance.timeOrigin + performance.now(),
    });
  // The last snapshot actually pushed — kept only so shouldFocusAddressBar
  // (tabManager.ts) has a "previous" to compare against. window.ts owns
  // this bit of bookkeeping so the pure predicate itself stays stateless;
  // it does not make the focus decision, only feeds and acts on it.
  let previousSnapshot: TabsSnapshot | null = null;
  // Tab strip's left offset inside the tab bar (= panel's right edge); set by `layout`.
  let tabStripLeft = 0;
  // Agent panel collapsed (persisted in userData). Only the user's toggle changes it: a canvas
  // tab opened by the agent or a launch never auto-expands it.
  const agentPanelSettingsPath = path.join(app.getPath("userData"), AGENT_PANEL_SETTINGS_FILE);
  let panelCollapsed = readAgentPanelSettings(agentPanelSettingsPath).collapsed;
  // Panel slide animation (panelAnimation.ts owns the state and the maths; this only owns the timer
  // and applies what it returns). While `panelAnimator.running`, applyLayout follows the interpolated
  // frame whatever the target layout is, so a mid-flight pushState never snaps it.
  const panelAnimator = createPanelAnimator(panelCollapsed);
  let panelTimer: ReturnType<typeof setInterval> | null = null;
  // Expanded/collapsed layouts, computed once per animation (and again only if the active tab's kind
  // changes mid-flight: the address row appears or goes away).
  let animLayouts: { kind: TabsSnapshot["activeKind"]; expanded: WindowLayout; collapsed: WindowLayout } | null = null;
  const shellMotion = (): boolean => {
    let reduced = false;
    try {
      const getSettings = (systemPreferences as { getAnimationSettings?: () => { prefersReducedMotion?: boolean } })
        .getAnimationSettings;
      if (typeof getSettings === "function") reduced = getSettings.call(systemPreferences)?.prefersReducedMotion === true;
    } catch {
      /* unsupported platform: animate */
    }
    return shellMotionEnabled(process.env.PEN_DESKTOP_NO_ANIMATIONS, reduced);
  };
  const currentActiveKind = (): TabsSnapshot["activeKind"] =>
    previousSnapshot ? previousSnapshot.activeKind : tabs.getSnapshot().activeKind;
  /** The interpolated frame while a slide runs, else null. */
  const animationFrame = (): PanelFrame | null => {
    if (!panelAnimator.running) return null;
    const kind = currentActiveKind();
    if (!animLayouts || animLayouts.kind !== kind) {
      animLayouts = { kind, expanded: computeLayout(kind, false), collapsed: computeLayout(kind, true) };
    }
    return panelAnimationFrame(animLayouts.expanded, animLayouts.collapsed, panelAnimator.progress);
  };
  const sendStripLeft = (x: number) => {
    try {
      if (!tabbarView.webContents.isDestroyed()) tabbarView.webContents.send("tabbar:strip-left", x);
    } catch {
      // cosmetic
    }
  };
  const stopPanelTimer = () => {
    if (panelTimer) clearInterval(panelTimer);
    panelTimer = null;
    animLayouts = null;
  };
  /** Jump to the rest state of `panelCollapsed`. The caller applies the plain layout. */
  const finishPanelAnimation = () => {
    stopPanelTimer();
    panelAnimator.stop(panelCollapsed);
  };
  const startPanelAnimation = (collapsed: boolean) => {
    panelAnimator.start(performance.now(), collapsed); // retargets from the CURRENT progress
    if (panelTimer) return;
    panelTimer = setInterval(() => {
      if (win.isDestroyed()) return stopPanelTimer();
      const tick = panelAnimator.tick(performance.now());
      if (!tick.done) {
        const frame = animationFrame();
        if (frame && animLayouts) applyLayout(animLayouts.expanded, frame); // tab bar rect: same in both
        return;
      }
      // Finished: the animator is at rest, so pushState applies the plain layout (every tab view,
      // once) and carries the final strip offset on tabbar:state.
      stopPanelTimer();
      pushState(tabs.getSnapshot());
    }, PANEL_ANIMATION_FRAME_MS);
  };
  const setPanelCollapsed = (collapsed: boolean) => {
    if (collapsed === panelCollapsed) return;
    const panelHadFocus = !agentPanelView.webContents.isDestroyed() && agentPanelView.webContents.isFocused();
    panelCollapsed = collapsed;
    writeAgentPanelSettings(agentPanelSettingsPath, { collapsed });
    // Animate the slide (main-process timer, see panelAnimation.ts) or jump when motion is off.
    if (shellMotion()) startPanelAnimation(collapsed);
    else finishPanelAnimation();
    pushState(tabs.getSnapshot());
    rebuildMenu();
    // A collapsed panel cannot hold the keyboard: hand it to the placeholder or the active tab.
    if (collapsed && panelHadFocus) {
      if (focusAfterCollapse(emptyState.visible) === "empty") emptyView.webContents.focus();
      else tabs.activeHandle()?.focus?.();
    }
  };
  // Page background per browser tab (webContents id) for the address-row tail; absent = blank tab.
  const tailColors = new Map<number, string>();
  const pushTail = () => {
    try {
      if (tabbarView.webContents.isDestroyed()) return;
      const h = tabs.activeHandle();
      const color = h && tabs.getSnapshot().activeKind === "browser" ? (tailColors.get(h.getWebContentsId()) ?? null) : null;
      tabbarView.webContents.send("tabbar:tail", color);
    } catch {
      // Never let a cosmetic colour break a state push.
    }
  };
  const pushState = (s: TabsSnapshot) => {
    // s.mcpActiveWebContentsId is computed by TabManager itself (see
    // TabsSnapshot's doc comment / finding 1) — window.ts just forwards it,
    // rather than tracking "last editor tab" locally, since only TabManager
    // sees a tab's destruction in time to repoint away from a dying editor
    // tab before this snapshot goes out.
    mcpService.setActiveTab(s.mcpActiveWebContentsId);
    const info = tabs.editorTabsInfo();
    canvasLink.syncTabs(info.tabs, info.activeWebContentsId);
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
    const tabSwitched = activeTabChanged(previousSnapshot, s);
    previousSnapshot = s;
    // A held sign-in token may now have an eligible receiver (the newly active tab can be the listening one).
    if (tabSwitched) desktopAuth.notifyListening();
    const geometry = computeLayout(s.activeKind);
    // Mid-slide the tab bar gets the CURRENT strip offset (tabbar:strip-left then moves it every frame).
    tabStripLeft = animationFrame()?.tabArea.x ?? geometry.tabStripLeft;
    tabbarView.webContents.send("tabbar:state", {
      ...s,
      focusAddressBar,
      tabStripLeft,
      panelCollapsed,
      motion: shellMotion(),
      // Island numbers from layout.ts (CSS --island-gap / --island-radius).
      islandGap: geometry.gap,
      islandRadius: geometry.radius,
      addressRowHeight: geometry.addressRowHeight,
      tabRowHeight: TAB_ROW_HEIGHT,
    });
    const themed = resolveWindowTheme({ activeTheme: s.activeTheme, remembered: rememberedEditorTheme, system: FALLBACK_THEME });
    rememberedEditorTheme = themed.remembered;
    if (s.activeTheme !== null) rememberedFromPanel = false;
    const resolvedTheme = themed.theme;
    if (process.platform !== "darwin") win.setBackgroundColor(GLASS_SOLID[resolvedTheme]);
    lastResolvedForTint = resolvedTheme;
    glassTintView?.setBackgroundColor(glassTint(resolvedTheme, nativeTheme.shouldUseDarkColors).color);
    tabbarView.webContents.send("tabbar:theme", resolvedTheme);
    pushTail();
    agentPanelView.setBackgroundColor(backgroundColorForTheme(resolvedTheme));
    if (!emptyView.webContents.isDestroyed()) {
      // No active tab: every tab left is a background session tab (never auto-activated).
      const noActiveTab = s.activeId === null;
      const nextEmpty: EmptyViewState = { visible: noActiveTab, theme: resolvedTheme, sessionTabs: noActiveTab ? s.tabs.length : 0 };
      const plan = planEmptyViewUpdate(emptyState, nextEmpty, userClosingTab);
      emptyState = nextEmpty;
      if (plan.theme) emptyView.setBackgroundColor(backgroundColorForTheme(plan.theme));
      if (plan.theme || plan.sessionTabs !== undefined) sendEmptyState(emptyView.webContents);
      if (plan.visible !== undefined) emptyView.setVisible(plan.visible);
      // The user closed the last tab: the keyboard reaches the placeholder's
      // buttons. Otherwise (agent close, window startup) the chat keeps it.
      // Never focus the hidden (collapsed) panel (emptyView.ts resolveFocusTarget).
      const focusTarget = resolveFocusTarget(plan.focus, panelCollapsed, nextEmpty.visible);
      if (focusTarget === "empty") emptyView.webContents.focus();
      else if (focusTarget === "panel" && !agentPanelView.webContents.isDestroyed()) agentPanelView.webContents.focus();
    }
    loginServices.passwords.setTheme(themeKey, resolvedTheme);
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
    applyLayout(geometry);
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
  // Per scope (shared browser / one session): a dialog is auto-handled only
  // while a command of ITS OWN scope runs, so a session command never answers
  // a dialog in a tab the user is browsing.
  const commandsInFlight = new ScopeCounter();
  // Finished request entries of tabs that closed or lost their debugger, per scope ("" = shared),
  // until the controller drains them (BrowserTarget.drainClosedRequests).
  const closedRequests = new Map<string, ClosedRequestBuffer>();
  const closedRequestsOf = (scope: string | undefined): ClosedRequestBuffer => {
    let b = closedRequests.get(scope ?? "");
    if (!b) closedRequests.set(scope ?? "", (b = createClosedRequestBuffer()));
    return b;
  };
  // Drives the tab strip's agent-cursor icons, one tracker per tab; the
  // hold/flicker rules live in agentActivity.ts.
  const agentActivity = createTabAgentActivity({ onChange: (tabId, working) => tabs.setAgentTabWorking(tabId, working) });
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
  const fetchRouter = new FetchRouter();
  const sessions = new BrowserSessions<SessionCtx>(partitionPool, undefined, (what, err) => console.error(`browser sessions: ${what}`, err));
  // A session tab is created only for a live session: a late command or popup
  // of a closing one must not open a tab nobody will close.
  const requireLiveSession = (id: string) => {
    const s = sessions.peek(id);
    if (!s || !sessions.isLive(id)) throw new Error(ERR_SESSION_CLOSED);
    return s;
  };
  // Assigned once the session helpers exist; createView's handlers call it.
  let closeSessionsOwnedBy: (owner: number, gone?: boolean) => void = () => {};
  const tabs = new TabManager({
    editorUrl: tabEditorUrl,
        onStateChanged: pushState,
    createView: (kind: TabKind, sessionId?: string): TabViewHandle => {
      // An isolated session's tab: its own in-memory partition, its own router.
      const sessionCtx = sessionId ? sessions.peek(sessionId)?.ctx : undefined;
      const view = new WebContentsView(
        kind === "browser"
          ? {
              webPreferences: secureWebPreferences(undefined, {
                // Dedicated session partition — the security boundary for
                // the built-in browser (design doc §1): the editor's
                // cookies are never in it, and whatever the user logs into
                // here is all the agent can ever reach. Deliberately no
                // preload: a browser tab must never see `penDesktop`.
                // An isolated session gets a pool slot `qa-0`..`qa-5` (no `persist:`): memory only.
                partition: sessionId ? requireLiveSession(sessionId).partition : "persist:penbrowser",
              }),
            }
          : kind === "passwords"
            ? // The Passwords tab is a local page with its own preload (never the tab preload, never the frontend).
              { webPreferences: secureWebPreferences(path.join(__dirname, "../preload/passwords.js")) }
            : {
                webPreferences: secureWebPreferences(path.join(__dirname, "../preload/tab.js"), { additionalArguments: nativeAppsArguments(computerUseAvailable()) }),
              },
      );
      win.contentView.addChildView(view);
      // The tab content is an island with rounded corners (radius set once, here).
      view.setBorderRadius(ISLAND_RADIUS);
      const viewId = view.webContents.id;
      // Opaque by default for both kinds — see backgroundColorForTheme's doc
      // comment above. Best guess (system theme) until something more
      // accurate is known: an editor tab corrects this itself the moment it
      // reports its own theme (onThemeChanged wiring below); a blank browser
      // tab is corrected by pushState once the resolved theme is known.
      view.setBackgroundColor(backgroundColorForTheme(FALLBACK_THEME));
      // A view's background colour is the base behind every page it shows,
      // not just a pre-paint placeholder — a site that sets no background of
      // its own relies on Chromium's default white, and would render its
      // default black text over #1a1a1a. So a browser tab is only themed
      // while blank: its first main-frame navigation drops it back to white
      // for good.
      let browserTabBlank = kind === "browser";
      if (kind === "browser") {
        view.webContents.on("did-start-navigation", (details) => {
          // The placeholder document (ensureDocument below) keeps the tab blank.
          if (!browserTabBlank || !details.isMainFrame || details.url === BLANK_DOCUMENT_URL) return;
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
      // undefined, so @sideform/browser-agent/controller's own `if (!page.sendCdp)`
      // checks report a clear error for press/hover, and dialogs simply
      // aren't auto-handled — nothing else in this bridge depends on it.
      let debuggerAttached = false;
      // Commit gate (commitGate.ts): `Emulation.*` CDP on a browser tab that has
      // not committed a document crashes the Electron 43 main process (SIGSEGV;
      // found with `applyFixture({ emulate })` as a scope's first command and
      // with the Browser tools menu on a new empty tab), and most other CDP
      // commands are only answered after the first commit. `sendGated` waits for
      // a navigation EVENT first (never for a CDP reply: that would deadlock).
      // It ONLY WAITS: the hidden about:blank placeholder is loaded here at tab
      // creation (a blank tab, shortly after, not awaited) and by the gate when the first
      // navigation was aborted with no commit, never on demand.
      // Gated: the agent's `sendCdp`, the menu's `sendCdpDirect`, getUaBrands
      // and FetchRouter's awaited enable on an existing tab. NOT gated:
      // Page.enable / Network.enable at attach, the router's fire-and-forget
      // enable for a new tab (a popup's first request must still be mocked),
      // the dialog handler and the login capture (both imply a document).
      const commitGate = createCommitGate({
        isDestroyed: () => view.webContents.isDestroyed(),
        isLoading: () => view.webContents.isLoading(),
        loadPlaceholder: () => {
          // Kept so handle.loadURL can wait it out: Electron resolves a loadURL() issued while
          // about:blank is still loading at the PLACEHOLDER's finish-load, so `open` would come
          // back "loaded" on about:blank with the real page still to come.
          // The flag goes up BEFORE loadURL: did-start-loading fires synchronously inside it, and the
          // tab-strip loading fill must not show for this hidden document.
          placeholderActive = true;
          const p = view.webContents.loadURL(BLANK_DOCUMENT_URL);
          const settled = p.then(() => undefined, () => undefined);
          placeholderLoad = settled;
          void settled.then(() => {
            if (placeholderLoad === settled) {
              placeholderLoad = null;
              placeholderActive = false;
            }
          });
          return p;
        },
      });
      let placeholderLoad: Promise<void> | null = null;
      let placeholderActive = false;
      const ensureDocument = (timeoutMs?: number): Promise<void> =>
        kind === "browser" ? commitGate.ensure(timeoutMs === undefined ? undefined : { timeoutMs }) : Promise.resolve();
      const sendGated = async (method: string, params?: Record<string, unknown>, gateTimeoutMs?: number): Promise<unknown> => {
        await ensureDocument(gateTimeoutMs);
        return view.webContents.debugger.sendCommand(method, params);
      };
      // The Browser tools menu runs in the tab's serial queue: an uncommitted tab must
      // fail fast there, not wedge the queue for the gate's full 10 s.
      const MENU_GATE_TIMEOUT_MS = 2_000;
      // Exact: the gate knows whether the document on screen is its own placeholder.
      const isPlaceholderShown = () => kind === "browser" && commitGate.isPlaceholderShown();
      if (kind === "browser") {
        const wc = view.webContents;
        // The placeholder history entry must not become a Back target behind the first real page.
        const dropPlaceholderEntry = () => {
          if (!commitGate.hasStalePlaceholderEntry()) return;
          const history = wc.navigationHistory;
          if (history.getEntryAtIndex(0)?.url === BLANK_DOCUMENT_URL) {
            // The new entry is not active yet: try again on the next navigation event.
            if (history.getActiveIndex() <= 0) return;
            try {
              history.removeEntryAtIndex(0);
            } catch (err) {
              console.error("browser tab: could not remove the placeholder history entry", err);
              return; // flag kept: retried on the next navigation event
            }
          }
          commitGate.placeholderEntryRemoved();
          reportNavState(); // canGoBack is stale until now
        };
        wc.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument) commitGate.onStartNavigation(details.url);
        });
        wc.on("did-redirect-navigation", (details) => {
          if (details.isMainFrame) commitGate.onProgress();
        });
        wc.on("did-start-loading", () => commitGate.onProgress());
        wc.on("did-navigate", (_e, url) => {
          commitGate.onNavigated(url);
          dropPlaceholderEntry();
        });
        wc.on("dom-ready", () => {
          commitGate.onDomReady();
          dropPlaceholderEntry();
        });
        wc.on("did-stop-loading", () => commitGate.onStopLoading());
        wc.on("render-process-gone", () => commitGate.onRendererGone());
        wc.once("destroyed", () => commitGate.onDestroyed());
        // A blank tab gets a document of its own, so CDP never meets a document-less tab. A
        // moment after creation, not in this tick: `open` creates a tab and loads its URL
        // straight away (the placeholder would only race it), and a committed about:blank
        // makes Playwright report the page before its real URL is known.
        const placeholderTimer = setTimeout(() => commitGate.startPlaceholderIfIdle(), 100);
        wc.once("destroyed", () => clearTimeout(placeholderTimer));
      }
      // Subscribers to this tab's CDP events (FetchRouter) — one listener on
      // the debugger, fanned out here, so applies never leak listeners.
      const cdpEventListeners = new Set<(method: string, params: unknown) => void>();
      let unregisterFromFetchRouter: (() => void) | null = null;
      const dialogQueue: { type: string; message: string }[] = [];
      // Wave 1 speed (`2026-09-24-browse-speed-contract.md`): CDP
      // network-quiet settle. `Network.enable`d alongside `Page.enable`
      // below (browser tabs only) — `pendingNetworkRequests` tracks every
      // still-in-flight request by CDP `requestId`, and `networkGeneration`
      // increments once per *new* relevant request, so
      // `@sideform/browser-agent/controller`'s `waitForNetworkQuiet` can tell "something
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
      // QA diagnostics: failed requests (HTTP >= 400, network errors) fed from
      // the same debugger `message` listener as the settle bookkeeping below.
      // See failedRequests.ts; only drained when the debugger is attached.
      const failedRequests = createFailedRequestRecorder();
      // Full request log (drainRequests); fed from the same listener. See requestLog.ts.
      const requestLog = createRequestLog();
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
        // Raw, not gated: a dialog implies a document, and waiting here could deadlock.
        view.webContents.debugger
          .sendCommand("Page.handleJavaScriptDialog", { accept, promptText: "" })
          .catch((err) => console.error("browser tab: failed to auto-handle JS dialog", err));
      };
      // Per-tab save-password state (isolated-world context id, held capture).
      const tabLoginCapture = loginServices.loginCapture.forTab();
      if (kind === "browser") {
        if (!sessionId) view.webContents.on("page-favicon-updated", (_e, favicons) => {
          const origin = normalizeOrigin(view.webContents.getURL());
          if (origin) void loginServices.faviconCache.seen(origin, favicons).catch(() => undefined);
        });
        try {
          view.webContents.debugger.attach("1.3");
          debuggerAttached = true;
          // A detached tab (DevTools took over, target closed) can no longer be
          // mocked: leave the router, so it never reports mocks it cannot deliver.
          view.webContents.debugger.on("detach", () => {
            unregisterFromFetchRouter?.();
            unregisterFromFetchRouter = null;
            debuggerAttached = false;
            // The log can no longer be drained through the handle: hand its entries (no bodies) over.
            closedRequestsOf(sessionId).add(requestLog.takeFinished());
          });
          view.webContents.once("destroyed", () => closedRequestsOf(sessionId).add(requestLog.takeFinished()));
          view.webContents.debugger.on("message", (_event, method, params) => {
            // Save-password prompt (browser/loginCapture.ts). `params` holds the
            // captured password: it goes straight into the handler and nowhere
            // else. The site comes from the payload's own `location.origin`.
            // Off in an isolated session: the store holds the user's real logins.
            const captureLogin = () =>
              sessionId ? undefined : void tabLoginCapture
                .handleCdpEvent(method, params, {
                  send: (m, p) => view.webContents.debugger.sendCommand(m, p),
                  ask: async (req) => {
                    const copy = savePromptCopy(req);
                    const { response } = await dialog.showMessageBox(win, {
                      type: "question",
                      message: copy.message,
                      detail: copy.detail,
                      buttons: copy.buttons,
                      defaultId: copy.defaultId,
                      cancelId: copy.cancelId,
                      noLink: true,
                    });
                    return promptChoiceFromButton(response);
                  },
                })
                .catch(() => console.error("browser tab: save-password handling failed"));
            // The login binding carries the password. It is consumed FIRST and
            // returns: it must never reach the cdpEventListeners fan-out (the
            // fetch router and any future listener) or the branches below.
            // test/loginBindingRouting.test.ts pins this order.
            if (isLoginBindingCall(method, params)) {
              captureLogin();
              return;
            }
            for (const l of [...cdpEventListeners]) l(method, params);
            if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument") {
              captureLogin();
              return;
            }
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
              if (commandsInFlight.active(sessionId)) applyDialogPolicy();
              return;
            }
            if (method.startsWith("Network.")) {
              failedRequests.onEvent(method, params);
              requestLog.onEvent(method, params);
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
          // No Runtime.enable (an automation fingerprint): see loginCapture.ts.
          // A failure here only turns the save prompt off for this tab.
          // Not awaited by anyone: on a tab that has not navigated yet, CDP
          // commands are only answered once the first navigation commits, so
          // waiting for them before loadURL() would deadlock. install() covers
          // that first document; Page.frameNavigated covers every later one.
          if (!sessionId) {
            tabLoginCapture
              .install((method, params) => view.webContents.debugger.sendCommand(method, params))
              .catch(() => console.error("browser tab: save-password capture unavailable for this tab"));
          }
        } catch (err) {
          debuggerAttached = false;
          console.error("browser tab: debugger attach failed — press/hover/dialogs unavailable for this tab", err);
        }
        // Code review finding 3: console error capture no longer goes
        // through CDP's `Runtime` domain (see consoleErrorBuffer's doc
        // comment above) — wired unconditionally for a browser tab,
        // independent of whether the debugger attach above succeeded, since
        // it needs no debugger session at all.
        // Network mocks (PageFixture `network`): a browser tab with a debugger
        // joins the router, which enables Fetch on it while routing is active.
        // Editor tabs never get here.
        const router = sessionId ? sessionCtx?.router : fetchRouter;
        if (debuggerAttached && router) {
          unregisterFromFetchRouter = router.registerTab(
            {
              // Raw: the router's fire-and-forget enable on a new tab/popup must not wait for a
              // commit (the popup's first request has to be mocked). `whenReady` gates only
              // the awaited enable of `routeRequests` on an existing tab.
              sendCommand: (method, params) => view.webContents.debugger.sendCommand(method, params),
              whenReady: (boundMs) => ensureDocument(boundMs),
              onEvent: (cb) => {
                cdpEventListeners.add(cb);
                return () => cdpEventListeners.delete(cb);
              },
            },
            viewId,
          );
        }
        view.webContents.on("console-message", (details) => {
          if (details.level !== "error") return;
          pushConsoleError(details.message);
        });
      }

      if (kind === "doc" || kind === "workflow" || kind === "trace" || kind === "settings") {
        // A trace tab is the same kind of plain frontend page (`/trace/<id>`) as a document tab;
        // so is the Settings tab (`/settings`, default session: its localStorage is the editor's).
        // A document tab is a plain frontend page (`/doc`): same origin clamp and offline
        // fallback as a canvas tab, but NOT a canvas tab: no MCP registration, no fixtures,
        // no canvas link. Its title follows the page title (the page sets document.title and
        // does not call the preload's setDocumentTitle), so main listens to the event.
        attachNavigationPolicy(view.webContents, editorOrigin, (url) => void shell.openExternal(url));
        attachOfflineFallback(view.webContents, offlineFile);
        view.webContents.on("page-title-updated", (_e, title) => {
          titleCallbacks.get(viewId)?.(title.trim().slice(0, 200) || (kind === "trace" ? "Trace" : kind === "settings" ? "Settings" : kind === "workflow" ? "Workflow" : "Document"));
        });
      }

      if (kind === "passwords") {
        // A local page: no origin clamp to the frontend, every navigation and popup is denied.
        attachLocalOnlyPolicy(view.webContents);
        const contents = view.webContents;
        loginServices.passwords.attach(
          {
            id: contents.id,
            isDestroyed: () => contents.isDestroyed(),
            sendTheme: (payload) => contents.send("passwords:theme", payload),
            setBackground: (theme) => view.setBackgroundColor(backgroundColorForTheme(theme)),
            sendChanged: () => contents.send("passwords:changed"),
            onLoaded: (cb) => contents.on("did-finish-load", cb),
            onDestroyed: (cb) => contents.once("destroyed", cb),
          },
          themeKey,
          () => lastResolvedForTint,
        );
        // The window's current theme, not the fallback (a dark window must not flash white).
        view.setBackgroundColor(backgroundColorForTheme(lastResolvedForTint));
        void contents.loadFile(path.join(__dirname, "../passwords/passwords.html"));
      }

      if (kind === "editor") {
        // Mocks are owned by main; the editor tab that drives the agent releases
        // them in its renderer `finally`, which never runs on reload/crash/close.
        const releaseOrphanedFixture = () => {
          releaseOwnedFixture(viewId);
          journalOwners.stopOwnedBy(viewId);
          closeSessionsOwnedBy(viewId);
        };
        view.webContents.on("render-process-gone", () => {
          releaseOrphanedFixture();
          canvasLink.rendererGone(viewId);
        });
        // Orphaned (and, for a registered canvas tab, gone for the panel) once a
        // reload COMMITS, not at did-start-navigation, which also fires for
        // navigations that never commit (denied by the policy, 204, downloads).
        view.webContents.on("did-frame-navigate", (_e, _url, _code, _text, isMainFrame) => {
          if (isOrphaningEvent({ type: "did-navigate", isMainFrame, isSameDocument: false })) {
            releaseOrphanedFixture();
            canvasLink.tabGone(viewId);
          }
        });
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
      } else if (kind === "browser") {
        // Browser tabs: never registered with the MCP bridge, never get the
        // editor:* IPC callbacks (there is no preload to send them from
        // anyway). Popups open as a new browser tab instead of escaping to
        // the system browser.
        attachBrowserTabPolicy(view.webContents, (url) => {
          // A popup of a session that is closing is dropped.
          if (sessionId && !sessions.isLive(sessionId)) return;
          // Review finding 7: only repoint the agent when *this* tab (the
          // one whose popup policy just fired) is the tab the agent is
          // currently driving. Before this check, a popup from *any* browser
          // tab repointed the agent — so a tab the user had open on the side,
          // unrelated to whatever the agent was doing, could silently steal
          // it. `browserHandle()` already embodies "agentBrowserTabId, or
          // today's fallback rule if unset", so comparing against it (rather
          // than agentBrowserTabId directly) covers both cases the same way
          // the rest of this bridge does.
          const openedByAgentTab = tabs.browserHandle(sessionId)?.getWebContentsId() === viewId;
          if (!openedByAgentTab) {
            // Second-pass review finding 2: pin the agent's CURRENT tab id
            // before `newTab` below runs its own `setActive` — which would
            // otherwise make the popup the *active* tab in the strip.
            // `agentBrowserTabId` was commonly left `null` up to this point
            // (see finding 2's other half, in `ensurePage` below), which let
            // `browserHandle()`'s "active tab if it's a browser tab" fallback
            // silently follow this popup even though its opener has nothing
            // to do with the agent at all.
            const currentAgentTabId = tabs.currentBrowserTabId(sessionId);
            if (currentAgentTabId !== null) tabs.setAgentBrowserTabId(currentAgentTabId, sessionId);
          }
          // A popup of a session tab stays in that session (same partition).
          const popupId = tabs.newTab("browser", sessionId);
          if (openedByAgentTab) {
            // Fixes upstream jev-ultrafast #61: a popup opened from the tab
            // the agent is driving becomes the agent's new current tab, so
            // the very next browser command targets it instead of the tab
            // that spawned it.
            tabs.setAgentBrowserTabId(popupId, sessionId);
          }
          // The popup still becomes the *active* tab in the strip either
          // way (newTab's own setActive call) — only whether the agent
          // follows it is conditional. newTab's internal setActive (not the
          // public activate()) deliberately does not itself touch
          // agentBrowserTabId — see activate()'s doc comment (finding 4) —
          // so a non-agent popup opens without stealing the agent even
          // though it's now the visibly active tab.
          // Load through the popup's OWN handle: a session popup opens in the
          // background, so the active tab is the editor or the user's browser.
          tabs
            .browserTabHandleById(popupId, sessionId)
            ?.loadURL(url)
            .catch((err) => console.error("browser tab: popup navigation failed", err));
        });
      }

      let navListener: ((s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void) | null =
        null;
      const reportNavState = () => {
        if (!navListener) return;
        // The placeholder document is not something the user navigated to: the tab still reads as new.
        const blank = isPlaceholderShown();
        navListener({
          url: blank ? "" : view.webContents.getURL(),
          title: blank ? "" : view.webContents.getTitle(),
          canGoBack: view.webContents.navigationHistory.canGoBack(),
          canGoForward: view.webContents.navigationHistory.canGoForward(),
        });
      };
      view.webContents.on("did-navigate", reportNavState);
      view.webContents.on("did-navigate-in-page", reportNavState);
      if (kind === "browser") {
        // Tail colour under the page's rounded top corners (pageBackground.ts): sample the page background.
        const wc = view.webContents;
        const sampleTail = async () => {
          try {
            if (wc.isDestroyed() || browserTabBlank || isPlaceholderShown()) return;
            const raw: unknown = await wc.executeJavaScript(SAMPLE_PAGE_BG_SCRIPT);
            if (wc.isDestroyed()) return;
            tailColors.set(viewId, normalizePageColor(raw));
          } catch {
            // Navigation race or destroyed contents: the page is painted white by Chromium.
            if (!wc.isDestroyed() && !browserTabBlank) tailColors.set(viewId, PAGE_BG_FALLBACK);
          }
          pushTail();
        };
        wc.on("dom-ready", () => void sampleTail());
        // No sample on did-navigate: it fires with the still-empty new document, so the old colour stays until dom-ready.
        wc.on("did-finish-load", () => void sampleTail());
        wc.on("did-navigate-in-page", () => void sampleTail());
        wc.once("destroyed", () => tailColors.delete(viewId));
      }
      view.webContents.on("page-title-updated", reportNavState);

      // Wave 1 speed: event-driven navigation detection
      // (`@sideform/browser-agent/controller`'s `armNavigationWatcher`), replacing a
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

      // The URL policy for browse_capture's stylesheet fetches: public
      // http(s), plus the page's own origin even when it is local (a dev
      // server on localhost), which is no more than the page already reads.
      const stylesheetFetchAllowed = (u: string): boolean => {
        try {
          const pageOrigin = new URL(view.webContents.getURL()).origin;
          if (pageOrigin !== "null" && new URL(u).origin === pageOrigin) return true;
        } catch {
          // fall through to the strict check
        }
        return isFetchableStylesheetUrl(u);
      };
      return {
        loadURL: (url) => {
          // Electron resolves a loadURL() issued while about:blank is still loading at the
          // PLACEHOLDER's finish-load, so `open` would come back "loaded" on about:blank with
          // the real page still to come. Stop the in-flight placeholder first (the gate is told,
          // so the stop is not mistaken for an aborted first navigation) and load the real URL.
          if (placeholderLoad && kind === "browser") {
            commitGate.cancelPlaceholder();
            placeholderLoad = null;
            placeholderActive = false;
            view.webContents.stop();
          }
          return view.webContents.loadURL(url);
        },
        setBounds: (b) => view.setBounds(b),
        setVisible: (v) => view.setVisible(v),
        destroy: () => {
          themeCallbacks.delete(viewId);
          titleCallbacks.delete(viewId);
          viewportByTab.forget(viewId);
          navEventListeners.clear();
          unregisterFromFetchRouter?.();
          cdpEventListeners.clear();
          if (kind === "editor") {
            mcpService.unregisterTab(viewId);
            releaseOwnedFixture(viewId);
            journalOwners.stopOwnedBy(viewId);
            closeSessionsOwnedBy(viewId, true);
            canvasLink.tabGone(viewId, true);
          }
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
        sendSettingsSection: (section) => view.webContents.send("settings:section", section),
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
        // Tab-strip loading fill. The hidden about:blank placeholder (browser tabs) is not
        // something the person waits for.
        onLoadingChanged: (cb) => {
          view.webContents.on("did-start-loading", () => {
            if (placeholderActive) return;
            cb(true);
          });
          // A real page replacing an in-flight placeholder by another path than handle.loadURL
          // (page/CDP navigation, history): the placeholder is over, the real load shows.
          view.webContents.on("did-start-navigation", (details) => {
            if (!placeholderActive || !details.isMainFrame || details.isSameDocument || details.url === BLANK_DOCUMENT_URL) return;
            placeholderActive = false;
            if (view.webContents.isLoading()) cb(true);
          });
          // A stopped load that a newer one superseded (the placeholder) reports its stop late:
          // only an idle view is done loading.
          view.webContents.on("did-stop-loading", () => {
            if (!view.webContents.isLoading()) cb(false);
          });
          // A crash mid-load may never send did-stop-loading.
          view.webContents.on("render-process-gone", () => cb(false));
        },
        onNavigationStateChanged: (cb) => {
          navListener = cb;
        },
        // The placeholder document is not something the user or agent navigated to: it reads as empty.
        getURL: () => (isPlaceholderShown() ? "" : view.webContents.getURL()),
        getTitle: () => (isPlaceholderShown() ? "" : view.webContents.getTitle()),
        goBack: () => view.webContents.navigationHistory.goBack(),
        goForward: () => view.webContents.navigationHistory.goForward(),
        reload: () => view.webContents.reload(),
        canGoBack: () => view.webContents.navigationHistory.canGoBack(),
        canGoForward: () => view.webContents.navigationHistory.canGoForward(),
        executeJavaScript: (code) => view.webContents.executeJavaScript(code),
        // Own JS world (fixed id): the page's scripts cannot patch its globals
        // or read the cross-origin pixels it decodes. Used by mark compose.
        executeJavaScriptIsolated: (code) =>
          view.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }]),
        // browse_capture v2: the controller reads cross-origin stylesheets
        // itself (the page's CORS blocks a script from reading them). Goes
        // through this tab's own session, so the browser partition's cookies
        // apply and the editor's never do.
        isFetchAllowed: (u) => stylesheetFetchAllowed(u),
        // Redirects are followed by hand so every hop passes the same policy;
        // the referer is the page origin only, as a browser sends it cross-origin.
        fetchText: async (url, opts) => {
          const signal = opts.signal
            ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
            : AbortSignal.timeout(opts.timeoutMs);
          let referer = "";
          try {
            const origin = new URL(view.webContents.getURL()).origin;
            if (origin !== "null") referer = `${origin}/`;
          } catch {
            referer = "";
          }
          const allowed = stylesheetFetchAllowed;
          let target = url;
          let res: Response | undefined;
          for (let hop = 0; hop <= 3; hop++) {
            if (!allowed(target)) throw new Error("blocked stylesheet URL");
            res = await view.webContents.session.fetch(target, {
              signal,
              redirect: "manual",
              headers: referer ? { referer } : {},
            });
            const location = res.headers.get("location");
            if (res.status < 300 || res.status >= 400 || !location) break;
            if (hop === 3) throw new Error("too many redirects");
            target = new URL(location, target).toString();
          }
          if (!res) throw new Error("no response");
          const declared = Number(res.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > opts.maxBytes) throw new Error("response too large");
          const body = Buffer.from(await res.arrayBuffer());
          if (body.length > opts.maxBytes) throw new Error("response too large");
          return {
            status: res.status,
            text: body.toString("utf8"),
            contentType: res.headers.get("content-type") ?? undefined,
          };
        },
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
        // Skips the placeholder's own dom-ready (commitGate.lastDomReadyWasPlaceholder):
        // the placeholder loads at tab creation, and `open` arms this right before loadURL.
        onceDomReady: () =>
          new Promise<void>((resolve) => {
            const onReady = () => {
              if (kind === "browser" && commitGate.lastDomReadyWasPlaceholder()) return;
              view.webContents.removeListener("dom-ready", onReady);
              resolve();
            };
            view.webContents.on("dom-ready", onReady);
          }),
        // Full browser use's `screenshot` command (@sideform/browser-agent/controller).
        // Shared by both tab kinds — capturePage() needs no preload and
        // works regardless — even though only a browser tab is ever
        // screenshotted through this bridge (the editor tab has its own
        // separate `get_screenshot` tool).
        capture: async () => {
          try {
            // A never-shown view (an isolated-session tab) captures fine on
            // macOS; on Linux it returns an empty image (stayHidden does not
            // help), which the controller reports as an { error }.
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
        // The agent's path. In the shared scope it reports the viewport-owning
        // Emulation.* calls to the tracker (agentEmulation.ts); the Browser tools
        // menu uses `sendCdpDirect` so a user's own viewport is never mistaken
        // for a fixture's.
        sendCdp: debuggerAttached
          ? (method, params) => {
              if (!sessionId) agentEmulation.note(viewId, method, params);
              return sendGated(method, params);
            }
          : undefined,
        sendCdpDirect: debuggerAttached
          ? (method, params) => sendGated(method, params, MENU_GATE_TIMEOUT_MS)
          : undefined,
        drainDialogs: () => dialogQueue.splice(0, dialogQueue.length),
        // Browser tools menu. DevTools vs the automation debugger: Electron
        // lets DevTools open next to an attached debugger session. If a given
        // Electron build evicts the session instead, the "detach" listener
        // above fires and the tab degrades exactly like a failed attach
        // (mocks unregistered, viewport emulation no-ops) — nothing throws.
        // hasDebugger is evaluated per call: `debuggerAttached` flips to false
        // on a later detach, while `sendCdp` above is fixed at creation.
        hasDebugger: () => debuggerAttached,
        hasDocument: () => kind !== "browser" || commitGate.hasDocument(),
        getViewSize: () => {
          const b = view.getBounds();
          return { width: b.width, height: b.height };
        },
        getUaBrands: async () => {
          try {
            // executeJavaScript on a tab with no document never answers until
            // the tab's first load: commit the placeholder first (new empty tab).
            await ensureDocument(MENU_GATE_TIMEOUT_MS);
            const r: unknown = await view.webContents.executeJavaScript(
              "navigator.userAgentData ? navigator.userAgentData.brands.map(b => ({ brand: b.brand, version: b.version })) : null",
            );
            return Array.isArray(r) ? (r as { brand: string; version: string }[]) : null;
          } catch {
            return null;
          }
        },
        getChromeVersion: () => process.versions.chrome,
        isDevToolsOpened: () => view.webContents.isDevToolsOpened(),
        toggleDevTools: () => {
          if (view.webContents.isDevToolsOpened()) view.webContents.closeDevTools();
          else view.webContents.openDevTools({ mode: "detach" });
        },
        getZoomFactor: () => view.webContents.getZoomFactor(),
        setZoomFactor: (f) => view.webContents.setZoomFactor(f),
        getZoomLevel: () => view.webContents.getZoomLevel(),
        setZoomLevel: (l) => view.webContents.setZoomLevel(l),
        // Code review finding 3: console-error capture is wired off the
        // `console-message` webContents event (see consoleErrorBuffer's doc
        // comment above), not the CDP debugger session — so this is gated on
        // `kind === "browser"` directly rather than `debuggerAttached`; it
        // stays available even on a browser tab whose debugger attach
        // failed (e.g. real DevTools already attached).
        drainConsoleErrors:
          kind === "browser" ? () => consoleErrorBuffer.splice(0, consoleErrorBuffer.length) : undefined,
        // QA diagnostics: only available while the debugger is attached (the
        // events come from it). A getter, because the controller reads
        // `page.drainFailedRequests` on every drain (`drainDiagnostics`) and
        // skips the list when it is absent: after a detach the method
        // disappears, so the controller reports nothing instead of a false
        // "no failed requests" (which would make a no_failed_requests assert pass).
        get drainFailedRequests() {
          return debuggerAttached ? () => failedRequests.drain() : undefined;
        },
        // Same gate as drainFailedRequests. Bodies are fetched lazily in requestLog.ts
        // (per-body and whole-phase time limits live there).
        get drainRequests() {
          if (!debuggerAttached) return undefined;
          return () =>
            requestLog.drain(async (requestId) => {
              const res = (await view.webContents.debugger.sendCommand("Network.getResponseBody", { requestId })) as
                | { body?: string; base64Encoded?: boolean }
                | undefined;
              if (!res || typeof res.body !== "string") return undefined;
              return { body: res.body, base64Encoded: res.base64Encoded === true };
            });
        },
        get droppedRequests() {
          return debuggerAttached ? () => requestLog.droppedRequests() : undefined;
        },
        // Forgets what happened before an agent run starts (see runBoundary.ts).
        clearDiagnostics: () => {
          consoleErrorBuffer.length = 0;
          failedRequests.drain();
        },
        // A run starts (the run boundary, not every applyFixture): pre-run browsing never lands in a trace.
        clearRequestLog: () => requestLog.clear(),
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
  // One target per scope: the shared browser (`scope` undefined, partition
  // persist:penbrowser) or one isolated session (a pool slot partition `qa-0`..`qa-5`). A target
  // sees only the tabs of its own scope (TabManager's `scope` argument), its
  // own cookie jar and its own network-mock router.
  const makeBrowserTarget = (scope: string | undefined, ses: Electron.Session, router: FetchRouter): BrowserTarget => ({
    ensurePage: async (): Promise<BrowserPageHandle> => {
      // Second-pass review finding 2: pin agentBrowserTabId even when
      // returning an *existing* tab, not only when creating one — before
      // this, agentBrowserTabId stayed null in the common case of a second
      // (or later) call to ensurePage() against an already-open browser
      // tab, and a null agentBrowserTabId is exactly what let a non-agent
      // popup's fallback-tab rule silently steal the agent (see the popup
      // callback above).
      const existingId = tabs.currentBrowserTabId(scope);
      if (existingId !== null) {
        tabs.setAgentBrowserTabId(existingId, scope);
        const existing = tabs.browserHandle(scope);
        if (existing) return existing;
      }
      if (scope !== undefined) requireLiveSession(scope);
      const id = tabs.newTab("browser", scope);
      // A freshly created tab becomes the agent's tab outright — there is
      // no other candidate for browserHandle()'s fallback rule to prefer
      // anyway, but this keeps agentBrowserTabId meaningful from the start
      // rather than only ever being set by a popup or an explicit
      // tabs({action:"switch"|"new"}) call.
      tabs.setAgentBrowserTabId(id, scope);
      const created = tabs.browserHandle(scope);
      if (!created) throw new Error("Failed to create a browser tab.");
      return created;
    },
    currentPage: (): BrowserPageHandle | null => tabs.browserHandle(scope),
    listPages: async () => tabs.listBrowserTabs(scope),
    selectPage: async (tabId: number) => {
      const found = tabs.listBrowserTabs(scope).some((t) => t.tabId === tabId);
      if (!found) return false;
      // Second-pass review finding 10: `activate()` already sets
      // agentBrowserTabId for a browser tab (see its own doc comment) — the
      // explicit `setAgentBrowserTabId` call that used to follow it here was
      // redundant (tabId is already confirmed to be a browser tab's id, via
      // the `found` check above).
      // A session only repoints its own agent tab: never activate or focus
      // (the editor keeps the foreground). The shared browser follows the user's focus.
      if (scope !== undefined) tabs.setAgentBrowserTabId(tabId, scope);
      else tabs.activate(tabId);
      return true;
    },
    closePage: async (tabId: number) => {
      // "close only closes browser tabs" — an editor tab id, a tab of another
      // scope, or any id not currently open, is rejected rather than silently
      // closing the wrong tab.
      const found = tabs.listBrowserTabs(scope).some((t) => t.tabId === tabId);
      if (!found) return false;
      tabs.closeTab(tabId);
      return true;
    },
    // Review finding 9: no longer loads a url itself — `@sideform/browser-agent/controller`'s
    // `tabs({action:"new", url})` now does that through `open()` (the same
    // DOM-ready-plus-grace-period wait every other navigation gets), so this
    // only ever has to create the tab and make it current. The `url`
    // parameter stays on the `BrowserTarget` interface for shape parity with
    // the other three tab-management methods, but is unused here now.
    newPage: async () => {
      if (scope !== undefined) requireLiveSession(scope);
      const id = tabs.newTab("browser", scope);
      tabs.setAgentBrowserTabId(id, scope);
      const created = tabs.listBrowserTabs(scope).find((t) => t.tabId === id);
      return created ?? { tabId: id, url: "", title: "New Tab", current: true };
    },
    // PageFixture `network`: CDP Fetch on this scope's browser tabs only (see fetchRouting.ts).
    // With no browser tab yet it still returns a remover; tabs opened while
    // routing is active are enabled on creation.
    routeRequests: (handler) => {
      // A tab whose debugger attach failed is never registered: refuse rather
      // than report mocks active that this tab would ignore.
      router.assertCurrentTabInterceptable(tabs.browserHandle(scope)?.getWebContentsId() ?? null);
      return router.routeRequests(handler, tabs.browserHandle(scope)?.getWebContentsId() ?? null);
    },
    // PageFixture cookies / `fresh`: this scope's partition only — never the
    // editor session or the default session (see fixtureSession.ts).
    getCookies: (urls) => fixtureSession.getCookies(ses, urls),
    setCookies: (cookies) => fixtureSession.setCookies(ses, cookies),
    resetSession: (origins) =>
      fixtureSession.resetSession(
        ses,
        {
          listBrowserTabIds: () => tabs.listBrowserTabs(scope).map((t) => t.tabId),
          closeTab: async (id) => {
            tabs.closeTab(id);
          },
          openBlankTab: async () => {
            if (scope !== undefined) requireLiveSession(scope);
            tabs.setAgentBrowserTabId(tabs.newTab("browser", scope), scope);
          },
        },
        origins,
      ),
    // Review finding 6: every open browser tab's own handle, tagged with
    // its id — lets BrowserController.mergeDialogs drain dialogs from every
    // tab, not just whichever one browserHandle() currently prefers.
    drainClosedRequests: () => closedRequestsOf(scope).drain(),
    pageHandles: async () => {
      const entries: { tabId: number; page: BrowserPageHandle }[] = [];
      for (const t of tabs.listBrowserTabs(scope)) {
        const page = tabs.browserTabHandleById(t.tabId, scope);
        if (page) entries.push({ tabId: t.tabId, page });
      }
      return entries;
    },
  });
  const browserTarget = makeBrowserTarget(undefined, session.fromPartition("persist:penbrowser"), fetchRouter);
  // Agent cursor on/off: the View menu's saved choice, with the env var
  // PEN_DESKTOP_BROWSER_CURSOR winning when set. The controller reads the
  // getter once per command, so a menu change applies from the next command
  // with no restart.
  const cursorSettingsPath = path.join(app.getPath("userData"), CURSOR_SETTINGS_FILE);
  let cursorSettings = readCursorSettings(cursorSettingsPath);
  const effectiveCursor = () => resolveCursorSettings(process.env, cursorSettings);
  setNativeCursorEnabled(() => effectiveCursor().enabled);
  const updateCursorSettings = (patch: Partial<CursorSettings>) => {
    cursorSettings = { ...cursorSettings, ...patch };
    writeCursorSettings(cursorSettingsPath, cursorSettings);
    rebuildMenu();
  };
  // One options factory for the shared controller and every session's.
  const makeController = (target: BrowserTarget) =>
    new BrowserController(target, {
      cursor: () => effectiveCursor().enabled,
    });
  const browserController = makeController(browserTarget);

  const journalOwners = new JournalOwners(browserController);

  // Browser tools menu honesty. A fixture's `emulate` and the user's Viewport
  // menu both drive Emulation.* on the same tab; releasing the fixture clears
  // those overrides, including a viewport the user picked, so the menu forgets
  // its record for exactly the tabs the agent's fixture overrode (metrics / UA
  // only), and only when that very fixture was released. See agentEmulation.ts.
  // The SHARED controller only: isolated sessions drive their own partition's
  // tabs, which are closed on teardown.
  const agentEmulation = createAgentEmulationTracker();
  const resetViewportRecords = (tabIds: number[]) => {
    for (const id of tabIds) viewportByTab.forget(id);
  };
  // Releases the shared controller's fixture (token = that fixture only; none =
  // whatever is active), then forgets the menu records of the tabs it overrode.
  // Who applied the shared fixture: an orphaned owner releases only its own.
  const fixtureOwners = new FixtureOwners();
  const releaseOwnedFixture = (owner: number) => {
    const owned = fixtureOwners.takeOwnedBy(owner);
    if (owned) void releaseSharedFixture(owned.token);
  };
  // releaseFixture is typed Promise<void> in the installed browser-agent; newer
  // versions resolve to { mockHits }. Read it as unknown so this compiles on both.
  const releaseSharedFixture = (token?: string): Promise<unknown> =>
    (browserController.releaseFixture(token) as Promise<unknown>)
      .catch((err) => {
        console.error("shared browser: releaseFixture failed", err);
        return undefined;
      })
      .then((released) => {
        resetViewportRecords(agentEmulation.release(token));
        return released;
      });

  // Agent run start (runBoundary.ts): empties every tab's diagnostics buffers in
  // the scope so earlier failures are not reported inside the new run.
  const runBoundary = createRunBoundary();
  const clearScopeDiagnostics = (scope: string | undefined) => {
    for (const t of tabs.listBrowserTabs(scope)) tabs.browserTabHandleById(t.tabId, scope)?.clearDiagnostics?.();
  };
  // A new run: also forget the request logs (live tabs and closed-tab leftovers).
  const clearScopeRequestLogs = (scope: string | undefined) => {
    for (const t of tabs.listBrowserTabs(scope)) tabs.browserTabHandleById(t.tabId, scope)?.clearRequestLog?.();
    closedRequests.get(scope ?? "")?.clear();
  };

  // --- isolated sessions (browserSessions.ts holds the decisions) ---
  const createSessionCtx = (id: string, partition: string): SessionCtx => {
    const ses = session.fromPartition(partition);
    // Once per pool slot, app-wide (the Session object is a singleton per name).
    // Marked only after it worked: a slot is never used without deny-all.
    if (!partitionPool.isPrepared(partition)) {
      try {
        denyAllPermissions(ses);
      } catch (err) {
        throw new SlotUnusableError(`deny-all permissions failed on ${partition}: ${String(err)}`);
      }
      partitionPool.markPrepared(partition);
    }
    const router = new FetchRouter();
    const controller = makeController(makeBrowserTarget(id, ses, router));
    return { ses, router, controller, journal: new JournalOwners(controller) };
  };
  // Closes a session's tabs and resolves true once every webContents is really
  // destroyed (a wipe must not race a live page still writing storage).
  const waitDestroyed = (wcId: number): Promise<boolean> =>
    new Promise((resolve) => {
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return resolve(true);
      const timer = setTimeout(() => resolve(false), 5000);
      wc.once("destroyed", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  const closeTabsAndWait = async (id: string): Promise<boolean> => {
    const ids = tabs.sessionWebContentsIds(id);
    tabs.closeSessionTabs(id);
    return (await Promise.all(ids.map(waitDestroyed))).every(Boolean);
  };
  // Wipes everything a session left in its partition. True only when every
  // step worked and the partition is verifiably empty; otherwise the registry
  // keeps the slot out of the pool.
  const teardownSession = async (id: string, s: { owner: number; ctx: SessionCtx }): Promise<boolean> => {
    const { controller, journal, ses } = s.ctx;
    await controller.releaseFixture().catch((err) => console.error("browser session: releaseFixture failed", err));
    journal.stopOwnedBy(s.owner);
    runBoundary.forget(id);
    let clean = await (s.ctx.tabsClosed ?? closeTabsAndWait(id));
    closedRequests.delete(id);
    if (!clean) console.error("browser session: tabs were not destroyed in time");
    const steps: [string, () => Promise<unknown>][] = [
      ["closeAllConnections", () => ses.closeAllConnections()],
      ["clearStorageData", () => ses.clearStorageData()],
      ["clearCache", () => ses.clearCache()],
      ["clearAuthCache", () => ses.clearAuthCache()],
      ["clearHostResolverCache", () => ses.clearHostResolverCache()],
    ];
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (err) {
        clean = false;
        console.error(`browser session: ${name} failed`, err);
      }
    }
    try {
      if ((await ses.cookies.get({})).length > 0) {
        clean = false;
        console.error("browser session: cookies left after the wipe");
      }
    } catch (err) {
      clean = false;
      console.error("browser session: cookie check failed", err);
    }
    return clean;
  };
  // Idempotent (see BrowserSessions.close for the order and the quarantine rules).
  const closeSessionById = (id: string, owner: number): Promise<void> =>
    sessions.close(id, owner, {
      // Drain timed out: closing the tabs unblocks the stuck commands.
      abort: (s) => {
        s.ctx.tabsClosed = closeTabsAndWait(id);
      },
      teardown: (s) => teardownSession(id, s),
    });
  // Orphans: the owner editor tab reloaded, crashed or closed (`gone`: destroyed for good).
  closeSessionsOwnedBy = (owner: number, gone = false) => {
    for (const id of sessions.idsOwnedBy(owner)) void closeSessionById(id, owner);
    // Covers every session key of this owner too (and the shared one).
    void appRegistry.releaseWhere(ownedBySender(owner));
    // A reloaded or crashed owner is a new chat: its "allow until quit" answers are void.
    appConfirm.forgetSender(owner);
    if (gone) sessions.forgetOwner(owner);
  };

  // Who may send `browser:command`, and whose fixtures/journals/sessions are
  // released when it goes away: this window's editor tabs and its agent panel.
  const panelId = agentPanelView.webContents.id;
  const isBrowserOwner = (id: number): boolean =>
    isBrowserOwnerId(id, (x) => tabs.isEditorTab(x), panelWc()?.id ?? null);
  // The panel is never destroyed on its own but reloads and can crash: like an
  // editor tab, that skips its renderer cleanup, so main releases what it owned.
  const releasePanelOrphans = (gone = false) => {
    if (panelId === null) return;
    releaseOwnedFixture(panelId);
    journalOwners.stopOwnedBy(panelId);
    closeSessionsOwnedBy(panelId, gone);
  };
  agentPanelView.webContents.on("render-process-gone", () => {
    if (isOrphaningEvent({ type: "render-process-gone" })) {
      releasePanelOrphans();
      canvasLink.panelGone();
    }
  });
  agentPanelView.webContents.on("did-frame-navigate", (_e, _url, _code, _text, isMainFrame) => {
    if (isOrphaningEvent({ type: "did-navigate", isMainFrame, isSameDocument: false })) {
      releasePanelOrphans();
      canvasLink.panelGone();
    }
  });
  // The reloaded panel has no list: push it once the page is up.
  agentPanelView.webContents.on("did-finish-load", () => canvasLink.repush());

  // Commands for an external desktop app (src/main/appTargets.ts). They skip the
  // built-in browser's tab activity, dialog sweeps and run boundary entirely.
  const runAppCommand = async (
    plan: Exclude<ReturnType<typeof planAppCommand>, "passthrough">,
    payload: Record<string, unknown> & { command: string },
    sender: number,
    sessionId: string | undefined,
  ): Promise<unknown> => {
    const key = appKey(sender, sessionId);
    if (plan === "release") {
      const { pending } = await appRegistry.release(key);
      return pending ? { ok: true, pending: true } : { ok: true };
    }
    if (plan === "refuse" || plan === "pending" || plan === "gone") return errorForPlan(plan, payload.command, payload.args);
    if (plan === "launch") {
      const requested = isRecord(payload.args) ? payload.args.app : undefined;
      return await openApp(key, requested, {
        registry: appRegistry,
        validate: validateRequestedApp,
        confirm: (target) => appConfirm.confirm(win, target, sender),
        findRunning: findUserRunningPids,
        confirmRestart: (target) => appConfirm.confirmRestart(win, target),
        quit: quitUserApp,
        reopen: reopenApp,
        reopenWhenGone,
        cancelWaiters,
        computerUse: computerUseDeps(win, sender),
      });
    }
    const running = appRegistry.get(key);
    if (!running) return errorForPlan("gone", payload.command, payload.args);
    return await routeAppCommand(running.controller, payload.command, payload.args);
  };

  const onBrowserCommand = async (event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    // Single source of truth for "which webContents id is an editor tab" —
    // TabManager.isEditorTab (finding 10). Deliberately not a second,
    // window.ts-local registry: two independent lists of the same fact can
    // drift, and TabManager's is already kept correct by newTab/destroy.
    // The agent panel (flag) is a legitimate owner too: its browser tools run there
    // (its preload bridge is the same one the editor tabs have).
    if (!isBrowserOwner(event.sender.id)) return { error: "Not allowed." };
    if (!isRecord(payload) || typeof payload.command !== "string") {
      return { error: "Malformed browser command." };
    }
    const sender = event.sender.id;
    const parsedSession = parseSessionId(payload);
    if (!parsedSession.ok) return { error: parsedSession.error };
    const sessionId = parsedSession.id;
    const appPlan = planAppCommand(payload.command, payload.args, appRegistry.state(appKey(sender, sessionId)));
    if (appPlan !== "passthrough") return await runAppCommand(appPlan, payload as Record<string, unknown> & { command: string }, sender, sessionId);
    if (payload.command === "closeSession") {
      if (sessionId === undefined) return { error: ERR_INVALID_SESSION_ID };
      const owner = sessions.ownerOf(sessionId);
      if (owner !== undefined && owner !== sender) return { error: ERR_SESSION_NOT_OWNED };
      const closing = closeSessionById(sessionId, sender);
      const appsGone = appRegistry.releaseWhere(ownedBySession(sender, sessionId));
      await closing;
      // Bounded: a new open on this id must not overlap the old app, but a stuck close must not hang the reply.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([appsGone, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
      clearTimeout(timer);
      return { ok: true };
    }
    // The controller, journal and tab scope this command runs against: one
    // isolated session's, or the shared browser's.
    let controller = browserController;
    let journal = journalOwners;
    let exitSession: (() => void) | null = null;
    if (sessionId !== undefined) {
      const plan = planSessionCommand(payload.command, payload.args, sessions.stateOf(sessionId, sender));
      if (plan.action === "reply") return plan.value;
      const entered = await sessions.acquire(sessionId, sender, plan.create, (partition) => createSessionCtx(sessionId, partition));
      if (!entered.ok) return { error: entered.error };
      exitSession = entered.exit;
      controller = entered.session.ctx.controller;
      journal = entered.session.ctx.journal;
    }
    try {
      return await runBrowserCommand(payload as Record<string, unknown> & { command: string }, sender, sessionId, controller, journal);
    } finally {
      exitSession?.();
    }
  };

  const runBrowserCommand = async (
    payload: Record<string, unknown> & { command: string },
    sender: number,
    sessionId: string | undefined,
    controller: BrowserController,
    journal: JournalOwners,
  ) => {
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
    // `requests` is a passive read of the request log: no sweep, no in-flight bracket, no run boundary.
    const passive = payload.command === "requests";
    const agentTabId = passive ? null : tabs.currentBrowserTabId(sessionId);
    if (agentTabId !== null) tabs.browserTabHandleById(agentTabId, sessionId)?.applyDialogPolicy?.();
    // Review finding 3: brackets the whole dispatch, not just the
    // BrowserController call, so a dialog raised anywhere during this
    // command's async work (including its own settle waits) is auto-handled
    // — decremented in `finally` so a rejected/throwing command never leaves
    // this counter stuck above zero.
    if (!passive) commandsInFlight.inc(sessionId);
    const runScope = sessionId ?? "";
    if (!passive && runBoundary.commandStart(runScope)) {
      clearScopeDiagnostics(sessionId);
      clearScopeRequestLogs(sessionId);
    }
    const drivesPage = isAgentPageCommand(payload.command, payload.args);
    // The tab this command starts on (null for a session that has no tab yet).
    const startTab = drivesPage ? tabs.currentBrowserTabId(sessionId) : null;
    if (startTab !== null) agentActivity.begin(startTab);
    try {
      // A page-changing command from a tab that does not own the running
      // journal would be recorded into it: end that journal first. (A session
      // has one owner and its own journal: nothing to end.)
      if (sessionId === undefined) {
        journal.beforeCommand(sender, payload.command, payload.args, isBrowserOwner);
      }
      switch (payload.command) {
        case "open":
          return await controller.open(payload.args);
        case "act":
          return await controller.act(payload.args);
        case "findImages":
          return await controller.findImages(payload.args);
        case "snapshot":
          return await controller.snapshot();
        case "perform":
          return await controller.perform(payload.args);
        case "assert":
          return await controller.assert(payload.args);
        case "read":
          return await controller.read(payload.args);
        case "screenshot":
          return await controller.screenshot(payload.args);
        case "tabs":
          return await controller.tabs(payload.args);
        // Read-only drain of the request log. Not page-driving, and it must not start a run
        // boundary (that would clear the very log it reads).
        case "requests":
          return await controller.requests();
        case "capture":
          return await controller.capture(payload.args);
        case "fillLogin": {
          // The model gets only { ok, origin, label, filled, submitted, sessionEstablished?, note? } or a
          // fixed error — never a password, a username or controller text.
          return await fillLogin(payload.args, {
            controller,
            store: loginServices.credentialStore,
            getUrl: () => tabs.browserHandle(sessionId)?.getURL() ?? null,
          });
        }
        case "applyFixture": {
          // The page's AbortSignal cannot cross IPC, so `opts` is dropped.
          // A non-object fixture is rejected by the controller (stage "validate").
          const fixture = isRecord(payload.args) ? payload.args.fixture : undefined;
          // The fixture's own page loads are part of the run: flush BEFORE it.
          clearScopeDiagnostics(sessionId);
          const shared = sessionId === undefined;
          let ticket = 0;
          if (shared) {
            resetViewportRecords(agentEmulation.beginApply());
            ticket = fixtureOwners.beginApply(sender);
          }
          let result: unknown;
          try {
            result = await controller.applyFixture(fixture as Parameters<BrowserController["applyFixture"]>[0], { allowNetworkMocks: true });
          } finally {
            if (shared) {
              resetViewportRecords(agentEmulation.finishApply(result));
              // A sender that went away (or reloaded) mid-apply must not keep the fixture.
              const orphaned = fixtureOwners.finishApply(ticket, sender, result, isBrowserOwner(sender));
              if (orphaned) void releaseSharedFixture(orphaned.token);
            }
          }
          return result;
        }
        case "clearActEmulation": {
          // Shared scope only. Forgetting the menu's record of EVERY tab the agent's viewport
          // action touched is deliberate: the controller sweeps those tabs' overrides too, so a
          // record of a user's own pick on such a tab would be stale anyway.
          await controller.clearActEmulation().catch((err) => console.error("browser: clearActEmulation failed", err));
          if (sessionId === undefined) resetViewportRecords(agentEmulation.clearAct());
          return { ok: true };
        }
        case "releaseFixture": {
          if (sessionId === undefined) {
            const released = await releaseSharedFixture(rawToken(payload.args));
            fixtureOwners.released(rawToken(payload.args));
            return releaseAnswer(released);
          }
          // Isolated QA session: the real release happens here too, so it reports hits too.
          return releaseAnswer(await (controller.releaseFixture(rawToken(payload.args)) as Promise<unknown>));
        }
        // Checkpoint journal. Args are untrusted: malformed ones are ignored.
        // The CheckpointResult (cookies/storage) goes back to the calling
        // editor tab only.
        // Ownership (which editor tab may stop/read the journal) is decided
        // in journalOwners.ts; the shared controller is used by all editor tabs.
        case "startJournal": {
          const parsed = parseJournalOrigins(payload.args);
          if (!parsed.ok) return { error: "invalid origins" };
          return journal.start(sender, isBrowserOwner, parsed.origins);
        }
        case "stopJournal":
          return journal.stop(sender, parseToken(payload.args));
        case "captureCheckpoint":
          return await journal.capture(sender, parseToken(payload.args));
        default:
          return { error: `Unknown browser command: ${payload.command}` };
      }
    } finally {
      if (!passive) commandsInFlight.dec(sessionId);
      if (!passive) runBoundary.commandEnd(runScope);
      // A command can settle after the window closed: never push state then.
      if (!win.isDestroyed()) {
        if (startTab !== null) agentActivity.end(startTab);
        // `tabs new`/`switch` and popups repoint the agent mid-command: the tab
        // it landed on gets the icon too (and holds it for the idle period).
        const endTab = tabs.currentBrowserTabId(sessionId);
        if (drivesPage && endTab !== null && endTab !== startTab) agentActivity.pulse(endTab);
      }
    }
  };
  ipcMain.handle("browser:command", onBrowserCommand);
  // Panel only: bring the agent's browser tab to the front (a click on a tool chip).
  // Never creates a session or a tab, so it does not go through `browser:command`.
  ipcMain.handle("browser:reveal-agent-tab", (event, payload: unknown): boolean => {
    if (panelWc()?.id !== event.sender.id) return false;
    if (!isRecord(payload)) return false;
    if (payload.session === undefined) return tabs.revealAgentBrowserTab();
    const parsed = parseSessionId({ session: payload.session });
    if (!parsed.ok) return false;
    return tabs.revealAgentBrowserTab(parsed.id);
  });

  // --- desktop sign-in (desktopAuth.ts) ---
  // `auth:sign-in`: only an editor tab or the agent panel, top frame, on the editor origin.
  // Who may use the auth channels: an editor tab or the agent panel, top frame, on the editor origin.
  const isAuthSender = (event: Electron.IpcMainEvent): boolean =>
    isAuthSignInSender({
      senderId: event.sender.id,
      panelId: panelWc()?.id ?? null,
      isEditorTab: tabs.isEditorTab(event.sender.id),
      isMainFrame: event.senderFrame != null && event.senderFrame === event.sender.mainFrame,
      frameUrl: event.senderFrame?.url,
      editorOrigin,
    });
  const onAuthSignIn = (event: Electron.IpcMainEvent) => {
    if (isAuthSender(event)) desktopAuth.beginSignIn();
  };
  ipcMain.on("auth:sign-in", onAuthSignIn);
  // `auth:listen` / `auth:unlisten`: a view tells main it has an `auth.onToken` subscriber. A token
  // is only ever sent to a listening view; with none, desktopAuth holds it and `notifyListening`
  // delivers it to the first view that starts listening. Ids are dropped on destroy and on a
  // COMMITTED main-frame cross-document navigation (the new page must call onToken again;
  // did-start-navigation would also fire for denied navigations, 204s and downloads).
  const authListeners = new Map<number, () => void>();
  const dropAuthListener = (id: number) => {
    authListeners.get(id)?.();
    authListeners.delete(id);
  };
  const onAuthListen = (event: Electron.IpcMainEvent) => {
    if (!isAuthSender(event)) return;
    const wc = event.sender;
    const id = wc.id;
    if (!authListeners.has(id)) {
      const onNav = (_e: Electron.Event, _url: string, _code: number, _text: string, isMainFrame: boolean) => {
        if (isMainFrame) dropAuthListener(id);
      };
      // A still-listening view that reaches an eligible document by an in-page navigation (the panel
      // document check in sendAuthToken) can now take a held token.
      const onInPage = (_e: Electron.Event, _url: string, isMainFrame: boolean) => {
        if (isMainFrame) desktopAuth.notifyListening();
      };
      const onDestroyed = () => dropAuthListener(id);
      wc.on("did-frame-navigate", onNav);
      wc.on("did-navigate-in-page", onInPage);
      wc.once("destroyed", onDestroyed);
      authListeners.set(id, () => {
        if (!wc.isDestroyed()) {
          wc.removeListener("did-frame-navigate", onNav);
          wc.removeListener("did-navigate-in-page", onInPage);
        }
        wc.removeListener("destroyed", onDestroyed);
      });
    }
    desktopAuth.notifyListening();
  };
  const onAuthUnlisten = (event: Electron.IpcMainEvent) => dropAuthListener(event.sender.id);
  ipcMain.on("auth:listen", onAuthListen);
  ipcMain.on("auth:unlisten", onAuthUnlisten);
  // `auth:token`: ONE receiver among LISTENING views. The agent panel if it listens (it is always
  // mounted, collapsed or not), else the active canvas tab, else any other listening canvas tab.
  // Every other view learns of the new session from the receiver (the page broadcasts it).
  const listeningWc = (id: number | null): Electron.WebContents | null => {
    if (id === null || !authListeners.has(id)) return null;
    const wc = webContents.fromId(id);
    return wc && !wc.isDestroyed() ? wc : null;
  };
  const sendAuthToken = (payload: AuthTokenPayload): boolean => {
    const panel = panelWc();
    const snap = tabs.getSnapshot();
    const activeWcId = snap.activeKind === "editor" && snap.activeId !== null ? tabs.webContentsIdOf(snap.activeId) : null;
    let other: Electron.WebContents | null = null;
    for (const id of authListeners.keys()) {
      if (id !== panel?.id && tabs.isEditorTab(id) && (other = listeningWc(id))) break;
    }
    const target = pickAuthReceiver<Electron.WebContents>({
      panel: panel && isPanelDocument(panel.getURL(), panelUrl) ? listeningWc(panel.id) : null,
      activeEditorTab: listeningWc(activeWcId),
      otherEditorTab: other,
    });
    if (!target) return false;
    target.send("auth:token", payload);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  };
  desktopAuth.setReceiver(sendAuthToken);

  // --- canvas link IPC ---
  const onCanvasRegister = (event: Electron.IpcMainEvent) => canvasLink.register(event.sender.id);
  const onCanvasUnregister = (event: Electron.IpcMainEvent) => canvasLink.unregister(event.sender.id);
  const onCanvasToPanel = (event: Electron.IpcMainEvent, env: unknown) => canvasLink.toPanel(event.sender.id, env);
  const onCanvasToTab = (event: Electron.IpcMainEvent, payload: unknown) => canvasLink.toTab(event.sender.id, payload);
  const onCanvasActivate = (event: Electron.IpcMainEvent, tabId: unknown) => canvasLink.activate(event.sender.id, tabId);
  ipcMain.on("canvas:register", onCanvasRegister);
  ipcMain.on("canvas:unregister", onCanvasUnregister);
  ipcMain.on("canvas:to-panel", onCanvasToPanel);
  ipcMain.on("canvas:to-tab", onCanvasToTab);
  ipcMain.on("canvas:activate", onCanvasActivate);
  ipcMain.handle("canvas:list", (event) => canvasLink.list(event.sender.id));
  ipcMain.handle("canvas:open", (event, opts: unknown) => canvasLink.open(event.sender.id, opts));
  // Documents: the agent panel or a trace tab asks to open one; logic in docOpen.ts.
  ipcMain.handle("doc:open", (event, docId: unknown) =>
    openDocTab(
      {
        isPanel: (id) => panelWc()?.id === id,
        isTraceTab: (id) => tabs.isTraceViewer(id),
        isActive: (id) => tabs.isActiveTabWebContents(id),
        findDocTab: (id) => tabs.findDocTab(id),
        activate: (tabId, opts) => tabs.activate(tabId, opts),
        newDocTab: (id, opts) => tabs.newTab("doc", undefined, { docId: id, focus: opts.focus }),
      },
      event.sender.id,
      docId,
    ),
  );

  // Workflows (the frontend's `/workflow`): the agent panel asks to open one; logic in workflowOpen.ts.
  ipcMain.handle("workflow:open", (event, workflowId: unknown) =>
    openWorkflowTab(
      {
        isPanel: (id) => panelWc()?.id === id,
        findWorkflowTab: (id) => tabs.findWorkflowTab(id),
        activate: (tabId, opts) => tabs.activate(tabId, opts),
        newWorkflowTab: (id, opts) => tabs.newTab("workflow", undefined, { workflowId: id, focus: opts.focus }),
      },
      event.sender.id,
      workflowId,
    ),
  );

  // Settings: the agent panel or any frontend tab asks for the Settings tab (singleton); logic in settingsOpen.ts.
  ipcMain.handle("settings:open", (event, section?: unknown) =>
    openSettings(
      {
        isPanel: (id) => panelWc()?.id === id,
        isPageTab: (id) => tabs.isPageTab(id),
        openSettingsTab: (s) => void tabs.openSettingsTab(s, { focus: true }),
      },
      event.sender.id,
      section,
    ),
  );

  // Document storage: the frontend mirrors its localStorage documents to userData; sender rules in docIpc.ts.
  const docIpc: DocIpcDeps = {
    store: getDocStore(),
    isPanel: (id) => panelWc()?.id === id,
    isEditorTab: (id) => tabs.isEditorTab(id),
    isDocTab: (id) => tabs.isDocTab(id),
    isTraceTab: (id) => tabs.isTraceTab(id),
  };
  ipcMain.handle("docs:list", (event) => handleDocList(docIpc, event.sender.id));
  ipcMain.handle("docs:save", (event, doc: unknown) => handleDocSave(docIpc, event.sender.id, doc));
  ipcMain.handle("docs:delete", (event, id: unknown) => handleDocDelete(docIpc, event.sender.id, id));
  // `docs:export-pdf`: the doc page saves itself as a PDF; rules and flow in docPdfExport.ts.
  ipcMain.handle("docs:export-pdf", (event, fileName: unknown) =>
    handleDocExportPdf(
      {
        port: { isDocViewer: (id, frameUrl) => tabs.isDocViewer(id, frameUrl) },
        printToPDF: () => event.sender.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: "A4" }),
        showSaveDialog: async (name) => {
          const r = await dialog.showSaveDialog(win, {
            defaultPath: path.join(app.getPath("downloads"), name),
            filters: [{ name: "PDF", extensions: ["pdf"] }],
          });
          return r.canceled || !r.filePath ? undefined : r.filePath;
        },
        writeFile: (p, data) => writeFile(p, data),
      },
      { senderId: event.sender.id, topFrame: event.senderFrame != null && event.senderFrame === event.sender.mainFrame, frameUrl: event.senderFrame?.url },
      fileName,
    ),
  );
  // `logins:*` (the doc tabs' @ mention picker) is registered once per process in the passwords service; this window only
  // lends it this window's doc viewers and its confirm dialog, withdrawn when the window closes (the handlers must not be registered twice).
  const withdrawDocTabLogins = loginServices.passwords.addDocWindow({
    isDocViewer: (id, frameUrl) => tabs.isDocViewer(id, frameUrl),
    confirmAdd: async (info) => {
      if (win.isDestroyed()) return false;
      try {
        const { response } = await dialog.showMessageBox(win, { type: "question", noLink: true, ...addLoginCopy(info) });
        return response === 0;
      } catch {
        return false;
      }
    },
  });

  // Browse-run traces: stored under userData; sender rules in traceIpc.ts, opening in traceOpen.ts.
  const traceIpc: TraceIpcDeps = {
    store: createTraceStore({ rootDir: path.join(app.getPath("userData"), TRACE_DIR), fs: nodeTraceFs }),
    isPanel: (id) => panelWc()?.id === id,
    isEditorTab: (id) => tabs.isEditorTab(id),
    isTraceTab: (id) => tabs.isTraceTab(id),
  };
  ipcMain.handle("traces:save", (event, payload: unknown) => handleTraceSave(traceIpc, event.sender.id, payload));
  ipcMain.handle("traces:read", (event, id: unknown, opts?: unknown) => handleTraceRead(traceIpc, event.sender.id, id, opts));
  ipcMain.handle("traces:list-tabs", (event) =>
    handleTraceListTabs({ isPanel: (id) => panelWc()?.id === id, listTraceTabs: () => tabs.listTraceTabs() }, event.sender.id),
  );
  ipcMain.handle("traces:open", (event, id: unknown) =>
    openTraceTab(
      {
        isPanel: (wcId) => panelWc()?.id === wcId,
        findTraceTab: (traceId) => tabs.findTraceTab(traceId),
        activate: (tabId, opts) => tabs.activate(tabId, opts),
        newTraceTab: (traceId, opts) => tabs.newTab("trace", undefined, { traceId, focus: opts.focus }),
      },
      event.sender.id,
      id,
    ),
  );

  // --- layout ---
  // computeLayout is pure geometry (layout.ts); pushState calls it BEFORE it builds the tab bar
  // snapshot, so the strip offset and island numbers the tab bar receives are always the ones
  // applied below (a panel toggle or an address row changes them).
  const computeLayout = (activeKind: TabsSnapshot["activeKind"], collapsed = panelCollapsed) => {
    const { width, height } = win.getContentBounds();
    const tabbarHeight = TAB_ROW_HEIGHT + (activeKind === "browser" ? ADDRESS_ROW_HEIGHT : 0);
    return computeWindowLayout({
      width,
      height,
      tabbarHeight,
      panelWidth: agentPanelWidthFor(collapsed),
      tabRowHeight: TAB_ROW_HEIGHT,
      islands: { gap: ISLAND_GAP, radius: ISLAND_RADIUS },
    });
  };
  const applyLayout = (l: ReturnType<typeof computeLayout>, frame: PanelFrame | null = animationFrame()) => {
    const { width, height } = win.getContentBounds();
    const panelRect = frame ? frame.panel : l.panel;
    const panelVisible = frame ? frame.panelVisible : l.panelVisible;
    const tabArea = frame ? frame.tabArea : l.tabArea;
    agentPanelView.setBounds(panelRect);
    // Collapsed: hidden, not destroyed (the chat keeps running and its state survives).
    agentPanelView.setVisible(panelVisible);
    tabbarView.setBounds(l.tabbar);
    glassTintView?.setBounds({ x: 0, y: 0, width, height });
    emptyView.setBounds(tabArea);
    if (frame) {
      // Per frame: only the visible tab moves; the hidden ones follow in the full layout at the end.
      tabs.layoutActive(tabArea);
      sendStripLeft(tabArea.x);
    } else {
      tabs.layout(tabArea);
    }
  };
  const layout = () => {
    finishPanelAnimation(); // a resize ends a running slide at once
    const l = computeLayout(tabs.getSnapshot().activeKind);
    applyLayout(l);
    // A resize can move the strip offset: the tab bar must hear about it (pushState sets it first, so no loop).
    if (l.tabStripLeft !== tabStripLeft) pushState(tabs.getSnapshot());
  };
  win.on("resize", layout);
  layout();

  // --- tab bar IPC (scoped to this window's tabbar webContents) ---
  const tabbarId = tabbarView.webContents.id;
  const fromOurTabbar = (event: Electron.IpcMainEvent) => event.sender.id === tabbarId;
  // The empty-state view (own preload) may only create tabs.
  const emptyId = emptyView.webContents.id;
  const fromTabbarOrEmpty = (event: Electron.IpcMainEvent) => isTabCreationSender(event.sender.id, tabbarId, emptyId);
  const onTabbarNew = (e: Electron.IpcMainEvent) => fromTabbarOrEmpty(e) && tabs.newTab("editor");
  const onTabbarNewDoc = (e: Electron.IpcMainEvent) => fromTabbarOrEmpty(e) && tabs.newTab("doc");
  // Second-pass review finding 3: a user-driven "New Browser Tab" pins the
  // agent to it, the same as any other explicit user action that lands on a
  // browser tab (activate()'s tab-strip click, nextTab/prevTab's cycle) —
  // plain `tabs.newTab("browser")` alone (used elsewhere for a *popup's*
  // automatic tab creation, which must NOT repoint the agent) leaves
  // agentBrowserTabId untouched.
  const newUserBrowserTab = () => tabs.setAgentBrowserTabId(tabs.newTab("browser"));
  const onTabbarNewBrowser = (e: Electron.IpcMainEvent) => fromTabbarOrEmpty(e) && newUserBrowserTab();
  // The "+" button's popup. `anchor` is the button's bottom-left corner in
  // tabbar CSS px, which is window content coordinates too: the tabbar view
  // sits at (0, 0) at zoom 1.
  const onTabbarNewMenu = (e: Electron.IpcMainEvent, anchor: unknown) => {
    if (!fromOurTabbar(e)) return;
    const at = isRecord(anchor) && typeof anchor.x === "number" && typeof anchor.y === "number"
      ? { x: Math.round(anchor.x), y: Math.round(anchor.y) }
      : {};
    Menu.buildFromTemplate(
      buildNewTabMenuTemplate({
        newTab: () => tabs.newTab("editor"),
        newBrowserTab: newUserBrowserTab,
        newDocTab: () => void tabs.newTab("doc"),
        newWorkflowTab: () => void tabs.newTab("workflow"),
      }),
    ).popup({ window: win, ...at });
  };
  // The chrome row's "Browser tools" popup. Viewport choice is kept per tab
  // handle (weakly, so it is forgotten when the tab closes); CDP overrides
  // persist across navigations, so it is deliberately NOT reset on navigate.
  // Keyed by webContents id (the agent emulation tracker names tabs that way);
  // a closing tab removes its entry in its handle's destroy().
  const viewportRecordByTab = new Map<number, ViewportPresetId>();
  const viewportByTab = {
    get: (h: { getWebContentsId(): number }): ViewportPresetId | undefined => viewportRecordByTab.get(h.getWebContentsId()),
    set: (h: { getWebContentsId(): number }, id: ViewportPresetId) => void viewportRecordByTab.set(h.getWebContentsId(), id),
    forget: (viewId: number) => void viewportRecordByTab.delete(viewId),
  };
  // Viewport changes are serialized per tab (one CDP sequence at a time).
  const viewportQueueByTab = new WeakMap<object, Promise<void>>();
  const onTabbarToolsMenu = (e: Electron.IpcMainEvent, anchor: unknown) => {
    if (!fromOurTabbar(e)) return;
    const handle = tabs.activeBrowserHandle();
    if (!handle) return;
    const at = isRecord(anchor) && typeof anchor.x === "number" && typeof anchor.y === "number"
      ? { x: Math.round(anchor.x), y: Math.round(anchor.y) }
      : {};
    Menu.buildFromTemplate(
      buildBrowserToolsMenuTemplate(
        {
          hasDebugger: handle.hasDebugger?.() ?? false,
          hasDocument: handle.hasDocument?.() ?? true,
          viewport: viewportByTab.get(handle) ?? "responsive",
          devToolsOpen: handle.isDevToolsOpened?.() ?? false,
          zoomFactor: handle.getZoomFactor?.() ?? 1,
          zoomLevel: handle.getZoomLevel?.() ?? 0,
        },
        {
          setViewport: (id) => {
            const run = async () => {
              const send = handle.sendCdpDirect;
              if (!send || !handle.hasDebugger?.()) return;
              // No early return on a missing document: a new tab commits its placeholder within
              // ~100 ms, and the sends below wait at most MENU_GATE_TIMEOUT_MS for it.
              const prev = viewportByTab.get(handle) ?? "responsive";
              const commands = planViewportCommands(id, {
                view: handle.getViewSize?.() ?? { width: 1e6, height: 1e6 },
                brands: (await handle.getUaBrands?.()) ?? null,
                chromeVersion: handle.getChromeVersion?.(),
              });
              try {
                for (const c of commands) await send(c.method, c.params);
              } catch (err) {
                console.error("browser tools: viewport emulation failed", err);
                // Roll back to a known state: no overrides, recorded as responsive.
                // Fail fast: when the first clear is rejected (e.g. no document), the rest would be too.
                for (const c of planClearCommands()) {
                  try {
                    await send(c.method, c.params);
                  } catch {
                    break;
                  }
                }
                viewportByTab.set(handle, "responsive");
                return;
              }
              viewportByTab.set(handle, id);
              // UA/platform are read by servers and first-load scripts, so a
              // changed identity only takes effect after a fresh load.
              if (viewportNeedsReload(prev, id)) handle.reload();
            };
            const next = (viewportQueueByTab.get(handle) ?? Promise.resolve())
              .then(run)
              .catch((err) => console.error("browser tools: viewport change failed", err));
            viewportQueueByTab.set(handle, next);
          },
          toggleDevTools: () => handle.toggleDevTools?.(),
          setZoomFactor: (f) => handle.setZoomFactor?.(f),
          setZoomLevel: (l) => handle.setZoomLevel?.(l),
        },
      ),
    ).popup({ window: win, ...at });
  };
  const onTabbarActivate = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && tabs.activate(id);
  // Agent layout: the panel's preload reports the theme it paints (class `dark` on <html>) on
  // load and on every change. Accepted only from the panel's own webContents AND its own page
  // (not the offline fallback); the adoption rule is windowTheme.ts adoptPanelTheme.
  const onPanelTheme = (e: Electron.IpcMainEvent, theme: unknown) => {
    if (e.sender.id !== agentPanelView.webContents.id) return;
    if (!isPanelDocument(e.senderFrame?.url ?? "", panelUrl)) return;
    if (theme !== "light" && theme !== "dark") return;
    const next = adoptPanelTheme({ remembered: rememberedEditorTheme, fromPanel: rememberedFromPanel }, theme, editorTabCount(tabs.getSnapshot()));
    rememberedEditorTheme = next.remembered;
    rememberedFromPanel = next.fromPanel;
    if (next.changed) pushState(tabs.getSnapshot());
  };
  const onTabbarTogglePanel = (e: Electron.IpcMainEvent) => {
    if (fromOurTabbar(e)) setPanelCollapsed(!panelCollapsed);
  };
  const onTabbarClose = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && closeTabByUser(id);
  // Drag-to-reorder: `{id, beforeId | null}`; parsing is parseReorderPayload (pure, tested).
  const onTabbarReorder = (e: Electron.IpcMainEvent, payload: unknown) => {
    if (!fromOurTabbar(e)) return;
    const move = parseReorderPayload(payload);
    if (move) tabs.moveTab(move.id, move.beforeId);
  };
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
  ipcMain.on("tabbar:new-browser", onTabbarNewBrowser);
  ipcMain.on("tabbar:new-doc", onTabbarNewDoc);
  ipcMain.on("tabbar:new-menu", onTabbarNewMenu);
  ipcMain.on("tabbar:tools-menu", onTabbarToolsMenu);
  ipcMain.on("tabbar:activate", onTabbarActivate);
  ipcMain.on("tabbar:close", onTabbarClose);
  ipcMain.on("tabbar:reorder", onTabbarReorder);
  ipcMain.on("tabbar:toggle-panel", onTabbarTogglePanel);
  ipcMain.on("panel:theme", onPanelTheme);
  ipcMain.on("tabbar:navigate", onTabbarNavigate);
  // Re-send current state when the tab bar (re)loads — it may have missed
  // snapshots emitted before its DOM was ready.
  tabbarView.webContents.on("did-finish-load", () => pushState(tabs.getSnapshot()));
  const onSystemThemeChanged = () => {
    // The OS appearance only decides how strong the glass tint is (the frontend ignores the OS).
    glassTintView?.setBackgroundColor(glassTint(lastResolvedForTint, nativeTheme.shouldUseDarkColors).color);
  };
  nativeTheme.on("updated", onSystemThemeChanged);

  // --- teardown ---
  // BaseWindow instances (and everything they capture — TabManager, the tab
  // views, the tabbar view) outlive a window close on macOS, since index.ts
  // recreates a window on dock "activate" without quitting the app. Without
  // this, every close/reopen cycle leaks the ipcMain listeners above plus
  // every tab's WebContentsView (renderer process stays alive).
  win.on("closed", () => {
    stopPanelTimer();
    ipcMain.removeListener("tabbar:new", onTabbarNew);
    ipcMain.removeListener("tabbar:new-browser", onTabbarNewBrowser);
    ipcMain.removeListener("tabbar:new-doc", onTabbarNewDoc);
    ipcMain.removeListener("tabbar:new-menu", onTabbarNewMenu);
    ipcMain.removeListener("tabbar:tools-menu", onTabbarToolsMenu);
    ipcMain.removeListener("tabbar:activate", onTabbarActivate);
    ipcMain.removeListener("tabbar:close", onTabbarClose);
    ipcMain.removeListener("tabbar:reorder", onTabbarReorder);
    ipcMain.removeListener("tabbar:toggle-panel", onTabbarTogglePanel);
    ipcMain.removeListener("panel:theme", onPanelTheme);
    ipcMain.removeListener("tabbar:navigate", onTabbarNavigate);
    ipcMain.removeListener("editor:theme", onEditorTheme);
    withdrawDocTabLogins();
    ipcMain.removeListener("editor:document-title", onEditorDocumentTitle);
    ipcMain.removeHandler("browser:command");
    ipcMain.removeHandler("browser:reveal-agent-tab");
    ipcMain.removeListener("auth:sign-in", onAuthSignIn);
    ipcMain.removeListener("auth:listen", onAuthListen);
    ipcMain.removeListener("auth:unlisten", onAuthUnlisten);
    for (const id of [...authListeners.keys()]) dropAuthListener(id);
    desktopAuth.clearReceiver(sendAuthToken);
    ipcMain.removeListener("canvas:register", onCanvasRegister);
    ipcMain.removeListener("canvas:unregister", onCanvasUnregister);
    ipcMain.removeListener("canvas:to-panel", onCanvasToPanel);
    ipcMain.removeListener("canvas:to-tab", onCanvasToTab);
    ipcMain.removeListener("canvas:activate", onCanvasActivate);
    ipcMain.removeHandler("canvas:list");
    ipcMain.removeHandler("canvas:open");
    ipcMain.removeHandler("doc:open");
    ipcMain.removeHandler("workflow:open");
    ipcMain.removeHandler("docs:list");
    ipcMain.removeHandler("docs:save");
    ipcMain.removeHandler("docs:delete");
    ipcMain.removeHandler("docs:export-pdf");
    ipcMain.removeHandler("settings:open");
    ipcMain.removeHandler("traces:save");
    ipcMain.removeHandler("traces:read");
    ipcMain.removeHandler("traces:open");
    ipcMain.removeHandler("traces:list-tabs");
    canvasLink.dispose();
    // The panel's fixture, checkpoint journals and browser sessions die with the window.
    releasePanelOrphans(true);
    nativeTheme.removeListener("updated", onSystemThemeChanged);
    unsubscribeMcpStatus();
    mcpService.setOnDemandTabOpener(null);
    agentActivity.dispose();
    tabs.destroyAll();
    tabbarView.webContents.close();
    agentPanelView.webContents.close();
    emptyView.webContents.close();
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
        newDocTab: () => void tabs.newTab("doc"),
        newWorkflowTab: () => void tabs.newTab("workflow"),
        openSettings: () => void tabs.openSettingsTab(undefined, { focus: true }),
        openPasswords: () => void tabs.openPasswordsTab({ focus: true }),
        signIn: () => desktopAuth.beginSignIn(),
        closeTab: () => {
          const target = decideCloseTarget({
            activeTabId: tabs.getSnapshot().activeId,
          });
          if (target.kind === "tab") closeTabByUser(target.id);
        },
        closeWindow: () => win.close(),
        nextTab: () => tabs.nextTab(),
        prevTab: () => tabs.prevTab(),
        forwardToActiveTab: (commandId) => {
          // Palette commands are editor-only: a doc or browser tab gets nothing.
          if (!shouldForwardMenuCommand(tabs.getSnapshot().activeKind)) return;
          tabs.activeHandle()?.sendMenuCommand(commandId);
        },
        useThisAppForMcp: () => void mcpService.forcePublish(),
        toggleAgentPanel: () => setPanelCollapsed(!panelCollapsed),
        setCursorEnabled: (enabled) => {
          updateCursorSettings({ enabled });
          // Unticked: hide the overlay on the current page right away
          // (best effort). Re-enabling needs nothing: the next move's
          // show() makes it visible again.
          if (!enabled) void browserController.hideCursorOverlay();
        },
        },
        { isMac: process.platform === "darwin", appName: app.name, agentPanel: { collapsed: panelCollapsed } },
        mcpService.getStatus(),
        effectiveCursor(),
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

  // An MCP call that finds no editor tab opens a canvas tab in the
  // background (becomes active from zero tabs without taking focus), then waits for it.
  mcpService.setOnDemandTabOpener(() => void tabs.newTab("editor", undefined, { activate: false }));
  for (const kind of INITIAL_TABS) tabs.newTab(kind);
  // Zero initial tabs emit nothing: push the first snapshot so the empty state
  // shows (and the panel takes focus). With initial tabs this repeats the last push; pushState diffs.
  pushState(tabs.getSnapshot());
  return win;
}
