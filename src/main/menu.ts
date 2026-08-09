import type { MenuItemConstructorOptions } from "electron";
import type { McpStatus } from "./tabManager";

export interface MenuActions {
  newTab(): void;
  closeTab(): void;
  nextTab(): void;
  prevTab(): void;
  forwardToActiveTab(commandId: string): void;
  /** "Use this app for MCP" — force-publishes over a live owner (see mcp/service.ts's forcePublish, design doc §5.3). */
  useThisAppForMcp(): void;
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
 * Application menu. File actions forward pen-editor command-palette ids over
 * IPC (the cross-repo contract — see CLAUDE.md); Edit/View use native roles
 * so text fields and zoom behave like any mac app. `mcpStatus` is read once
 * at build time — window.ts rebuilds the template (and calls
 * Menu.setApplicationMenu again) whenever the status changes, since a native
 * menu template has no live-binding mechanism of its own.
 */
export function buildMenuTemplate(
  actions: MenuActions,
  opts: { isMac: boolean },
  mcpStatus: McpStatus = "off",
): MenuItemConstructorOptions[] {
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => actions.newTab() },
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => actions.forwardToActiveTab("file-open"),
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
  if (opts.isMac) template.unshift({ role: "appMenu" });
  return template;
}
