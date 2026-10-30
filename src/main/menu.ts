import { agentPanelMenuLabel } from "./agentPanelSettings";
import type { MenuItemConstructorOptions } from "electron";
import type { McpStatus } from "./tabManager";
import { defaultCursorSettings } from "./cursorSettings";
import { revealMenuLabel } from "./revealMenuLabel";

/** Id of File > Reveal: window.ts toggles its `enabled` in place when the active tab changes (no menu rebuild). */
export const REVEAL_MENU_ITEM_ID = "reveal-active-tab";

/** What the View > Show Agent Cursor item shows. `enabledLocked` = an env var
 * decides the value, so the item renders disabled. */
export interface CursorMenuState {
  enabled: boolean;
  enabledLocked: boolean;
}

export interface MenuActions {
  newTab(): void;
  /** Opens a new built-in browser tab (design doc `2026-09-18-builtin-browser-design.md`). */
  newBrowserTab(): void;
  /** Opens a new document tab (the frontend's markdown editor at `/doc`). */
  newDocTab(): void;
  /** Opens a new workflow tab (the frontend's workflow editor at `/workflow`). */
  newWorkflowTab(): void;
  /** Opens (or activates) the Settings tab. */
  openSettings(): void;
  /** Opens (or focuses) the Passwords tab. A local action: it forwards no `menu:command` id. */
  openPasswords(): void;
  /** Opens (or focuses) the History tab. A local action: it forwards no `menu:command` id. */
  openHistory(): void;
  /** Starts the sign-in in the system browser (desktopAuth.ts). A local action: no `menu:command` id. */
  signIn(): void;
  /** Closes the active tab; does nothing with no tab (never the window). */
  closeTab(): void;
  /** Closes the focused window (File > Close Window, Cmd/Ctrl+Shift+W). */
  closeWindow(): void;
  nextTab(): void;
  prevTab(): void;
  forwardToActiveTab(commandId: string): void;
  /** "Use this app for MCP" — force-publishes over a live owner (see mcp/service.ts's forcePublish, design doc §5.3). */
  useThisAppForMcp(): void;
  /** Saves + applies the agent cursor's on/off switch (View menu). */
  setCursorEnabled(enabled: boolean): void;
  /** Show/hide the agent chat panel (View menu, same as the tab bar's sidebar button). A local action: no `menu:command` id. */
  toggleAgentPanel(): void;
  /** File > Reveal in Finder: shows the active tab's stored file in the OS file manager. A local action: no `menu:command` id; a no-op with no revealable tab. */
  revealActiveTab(): void;
}

/** What the File > Reveal item shows: the platform label, and whether the active tab has a file. */
export interface RevealMenuState {
  label: string;
  enabled: boolean;
}

// No terminal in a packaged app, so this label plus the tab-strip indicator
// are the only diagnostic. Deliberately generic — no port number, matching
// the rule that only a status string (never the token or port) may cross
// into anything the app renders; "Use this app for MCP" is the only remedy
// offered, so naming the specific port is not actionable here anyway.
function mcpStatusLabel(status: McpStatus): string {
  switch (status) {
    case "listening":
      return "MCP: Listening";
    case "not-published":
      return "MCP: Not published (another server is running)";
    case "off":
      return "MCP: Off";
    case "error":
      return "MCP: Failed to start (see \"Use this app for MCP\")";
  }
}

/**
 * The tab strip's "+" popup: pick the kind of tab to open. A native menu, not
 * an HTML one — the tab bar is its own WebContentsView only as tall as the
 * strip, so anything drawn inside it would be clipped at its bottom edge.
 * The accelerator is display-only; the application menu owns ⌘T.
 */
export function buildNewTabMenuTemplate(
  actions: Pick<MenuActions, "newTab" | "newBrowserTab" | "newDocTab" | "newWorkflowTab">,
): MenuItemConstructorOptions[] {
  return [
    {
      label: "New Canvas Tab",
      accelerator: "CmdOrCtrl+T",
      registerAccelerator: false,
      click: () => actions.newTab(),
    },
    { label: "New Browser Tab", click: () => actions.newBrowserTab() },
    { label: "New Document", click: () => actions.newDocTab() },
    { label: "New Workflow", click: () => actions.newWorkflowTab() },
  ];
}

/**
 * Right-click menu of a tab: reveal its file (disabled when the tab has none), then close.
 * Native, like the "+" popup: the tab bar view is only as tall as the strip.
 */
export function buildTabContextMenuTemplate(
  reveal: RevealMenuState,
  actions: { reveal(): void; closeTab(): void },
): MenuItemConstructorOptions[] {
  return [
    { label: reveal.label, enabled: reveal.enabled, click: () => actions.reveal() },
    { type: "separator" },
    { label: "Close Tab", click: () => actions.closeTab() },
  ];
}

/** Right-click menu of a Recent row on the empty start page: open it, or reveal its file. */
export function buildRecentContextMenuTemplate(
  revealLabel: string,
  actions: { open(): void; reveal(): void },
): MenuItemConstructorOptions[] {
  return [
    { label: "Open", click: () => actions.open() },
    { label: revealLabel, click: () => actions.reveal() },
  ];
}

/** Same ids as `RecentModifiedRange` in src/tabbar/recentFilter.ts (that file is a plain script and exports nothing). */
export const RECENT_MODIFIED_RANGES = ["any", "today", "7d", "30d"] as const;
export type RecentModified = (typeof RECENT_MODIFIED_RANGES)[number];

/** What the Recent filter menu on the empty start page reports: a kind toggled, a range picked, or a reset. */
export type RecentFilterChoice =
  | { action: "kind"; kind: "canvas" | "doc" | "workflow"; checked: boolean }
  | { action: "modified"; modified: RecentModified }
  | { action: "reset" };

export interface RecentFilterMenuState {
  kinds: { canvas: boolean; doc: boolean; workflow: boolean };
  modified: RecentModified;
}

/**
 * Filter menu of the Recent list: Type checkboxes, Modified radios, Reset filters. Section titles are
 * `header` items where the OS has them (macOS 14+, `useHeaders`) and disabled labels elsewhere. A pick only reports the choice; the page owns the state.
 */
export function buildRecentFilterMenuTemplate(
  state: RecentFilterMenuState,
  useHeaders: boolean,
  pick: (choice: RecentFilterChoice) => void,
): MenuItemConstructorOptions[] {
  const heading = (label: string): MenuItemConstructorOptions => (useHeaders ? { type: "header", label } : { label, enabled: false });
  const kind = (label: string, k: "canvas" | "doc" | "workflow"): MenuItemConstructorOptions => ({
    label,
    type: "checkbox",
    checked: state.kinds[k],
    // Electron flips `checked` before the click runs, so the item already holds the new value.
    click: (item) => pick({ action: "kind", kind: k, checked: item.checked }),
  });
  const range = (label: string, modified: RecentModified): MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: state.modified === modified,
    click: () => pick({ action: "modified", modified }),
  });
  const isDefault = state.kinds.canvas && state.kinds.doc && state.kinds.workflow && state.modified === "any";
  return [
    heading("Type"),
    kind("Canvases", "canvas"),
    kind("Documents", "doc"),
    kind("Workflows", "workflow"),
    { type: "separator" },
    heading("Modified"),
    range("Any time", "any"),
    range("Today", "today"),
    range("Past 7 days", "7d"),
    range("Past 30 days", "30d"),
    { type: "separator" },
    { label: "Reset filters", enabled: !isDefault, click: () => pick({ action: "reset" }) },
  ];
}

/**
 * Application menu. File actions forward pen-editor command-palette ids over
 * IPC (the cross-repo contract — see CLAUDE.md); Edit/View use native roles
 * so text fields and zoom behave like any mac app. `mcpStatus` is read once
 * at build time — window.ts rebuilds the template (and calls
 * Menu.setApplicationMenu again) whenever the status changes, since a native
 * menu template has no live-binding mechanism of its own.
 */
export function buildMenuTemplate(
  actions: MenuActions,
  opts: { isMac: boolean; appName?: string; agentPanel?: { collapsed: boolean }; reveal?: RevealMenuState },
  mcpStatus: McpStatus = "off",
  cursor: CursorMenuState = { ...defaultCursorSettings(), enabledLocked: false },
): MenuItemConstructorOptions[] {
  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => actions.openSettings(),
  };
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "New Canvas Tab", accelerator: "CmdOrCtrl+T", click: () => actions.newTab() },
      { label: "New Browser Tab", click: () => actions.newBrowserTab() },
      { label: "New Document Tab", accelerator: "CmdOrCtrl+Shift+D", click: () => actions.newDocTab() },
      { label: "New Workflow Tab", click: () => actions.newWorkflowTab() },
      { label: "Passwords…", click: () => actions.openPasswords() },
      // Cmd+Y on macOS; on Windows/Linux Ctrl+Y is the Edit menu's Redo, so History uses Chrome's Ctrl+H there.
      { label: "History…", accelerator: opts.isMac ? "Cmd+Y" : "Ctrl+H", click: () => actions.openHistory() },
      // On macOS Settings… lives in the app menu (below), as in every mac app.
      ...(opts.isMac ? [] : [settingsItem]),
      { label: "Sign In…", click: () => actions.signIn() },
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => actions.forwardToActiveTab("file-open"),
      },
      // No accelerator. Without `opts.reveal` the item shows the platform label, disabled.
      {
        id: REVEAL_MENU_ITEM_ID,
        label: opts.reveal?.label ?? revealMenuLabel(opts.isMac ? "darwin" : process.platform),
        enabled: opts.reveal?.enabled ?? false,
        click: () => actions.revealActiveTab(),
      },
      { type: "separator" },
      {
        label: "Save as .pen",
        accelerator: "CmdOrCtrl+S",
        click: () => actions.forwardToActiveTab("file-export-pen"),
      },
      {
        label: "Export as .json",
        accelerator: "Shift+CmdOrCtrl+S",
        click: () => actions.forwardToActiveTab("file-export-json"),
      },
      { label: "Export Design Tokens…", click: () => actions.forwardToActiveTab("file-export-tokens") },
      { label: "Import Design Tokens…", click: () => actions.forwardToActiveTab("file-import-tokens") },
      { type: "separator" },
      { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => actions.closeTab() },
      { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", click: () => actions.closeWindow() },
      { type: "separator" },
      { label: mcpStatusLabel(mcpStatus), enabled: false },
      { label: "Use this app for MCP", click: () => actions.useThisAppForMcp() },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      { role: "toggleDevTools" },
      { type: "separator" },
      // Cmd/Ctrl+Alt+B: free in the editor (Cmd+\ is "hide UI", Cmd+Alt+S is boolean subtract).
      ...(opts.agentPanel
        ? [
            { label: agentPanelMenuLabel(opts.agentPanel.collapsed), accelerator: "CmdOrCtrl+Alt+B", click: () => actions.toggleAgentPanel() },
            { type: "separator" } as MenuItemConstructorOptions,
          ]
        : []),
      {
        label: "Show Agent Cursor",
        type: "checkbox",
        checked: cursor.enabled,
        enabled: !cursor.enabledLocked,
        // `item` may be absent: pen-editor's contract test clicks every
        // menu item bare, and that must not throw.
        click: (item) => actions.setCursorEnabled(item?.checked ?? !cursor.enabled),
      },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { label: "Next Tab", accelerator: "Ctrl+Tab", click: () => actions.nextTab() },
      { label: "Previous Tab", accelerator: "Ctrl+Shift+Tab", click: () => actions.prevTab() },
    ],
  };

  const template: MenuItemConstructorOptions[] = [fileMenu, editMenu, viewMenu, windowMenu];
  // macOS: an explicit app menu = Electron's default `appMenu` role plus Settings… (the first menu's
  // title is always the app name on macOS; `label` only matters for tests).
  if (opts.isMac) {
    template.unshift({
      label: opts.appName ?? "App",
      submenu: [
        { role: "about" },
        { type: "separator" },
        settingsItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  return template;
}
