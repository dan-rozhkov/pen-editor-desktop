import type { MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  newTab(): void;
  closeTab(): void;
  nextTab(): void;
  prevTab(): void;
  forwardToActiveTab(commandId: string): void;
}

/**
 * Application menu. File actions forward pen-editor command-palette ids over
 * IPC (the cross-repo contract — see CLAUDE.md); Edit/View use native roles
 * so text fields and zoom behave like any mac app.
 */
export function buildMenuTemplate(
  actions: MenuActions,
  opts: { isMac: boolean },
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
