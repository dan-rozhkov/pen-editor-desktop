import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMenuTemplate, type MenuActions } from "../src/main/menu";
import type { MenuItemConstructorOptions } from "electron";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...flatten((i.submenu as MenuItemConstructorOptions[]) ?? [])]);
}

describe("buildMenuTemplate", () => {
  let actions: MenuActions;

  beforeEach(() => {
    actions = {
      newTab: vi.fn(),
      newBrowserTab: vi.fn(),
      closeTab: vi.fn(),
      nextTab: vi.fn(),
      prevTab: vi.fn(),
      forwardToActiveTab: vi.fn(),
      useThisAppForMcp: vi.fn(),
    };
  });

  function item(
    label: string,
    mcpStatus: "listening" | "not-published" | "off" | "error" = "off",
  ): MenuItemConstructorOptions {
    const found = flatten(buildMenuTemplate(actions, { isMac: true }, mcpStatus)).find((i) => i.label === label);
    if (!found) throw new Error(`menu item not found: ${label}`);
    return found;
  }

  it("has the app menu first on mac only", () => {
    expect(buildMenuTemplate(actions, { isMac: true })[0].role).toBe("appMenu");
    expect(buildMenuTemplate(actions, { isMac: false })[0].label).toBe("File");
  });

  it("New Tab triggers newTab with CmdOrCtrl+T", () => {
    const i = item("New Tab");
    expect(i.accelerator).toBe("CmdOrCtrl+T");
    (i.click as () => void)();
    expect(actions.newTab).toHaveBeenCalled();
  });

  it("New Browser Tab triggers newBrowserTab", () => {
    const i = item("New Browser Tab");
    (i.click as () => void)();
    expect(actions.newBrowserTab).toHaveBeenCalled();
  });

  it("Close Tab triggers closeTab with CmdOrCtrl+W", () => {
    const i = item("Close Tab");
    expect(i.accelerator).toBe("CmdOrCtrl+W");
    (i.click as () => void)();
    expect(actions.closeTab).toHaveBeenCalled();
  });

  it.each([
    ["Open…", "CmdOrCtrl+O", "file-open"],
    ["Save as .pen", "CmdOrCtrl+S", "file-export-pen"],
    ["Export as .json", "Shift+CmdOrCtrl+S", "file-export-json"],
    ["Export Design Tokens…", undefined, "file-export-tokens"],
    ["Import Design Tokens…", undefined, "file-import-tokens"],
  ])("%s forwards %s", (label, accelerator, commandId) => {
    const i = item(label as string);
    expect(i.accelerator).toBe(accelerator);
    (i.click as () => void)();
    expect(actions.forwardToActiveTab).toHaveBeenCalledWith(commandId);
  });

  it("tab cycling shortcuts exist", () => {
    expect(item("Next Tab").accelerator).toBe("Ctrl+Tab");
    expect(item("Previous Tab").accelerator).toBe("Ctrl+Shift+Tab");
  });

  it("Edit menu uses native roles (undo/redo/cut/copy/paste/selectAll)", () => {
    const roles = flatten(buildMenuTemplate(actions, { isMac: true })).map((i) => i.role);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(roles).toContain(role);
    }
  });

  it("View menu has zoom, fullscreen and devtools roles", () => {
    const roles = flatten(buildMenuTemplate(actions, { isMac: true })).map((i) => i.role);
    for (const role of ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "toggleDevTools", "reload"]) {
      expect(roles).toContain(role);
    }
  });

  it.each([
    ["listening" as const, "MCP: Listening"],
    ["not-published" as const, "MCP: Not published (another server is running)"],
    ["off" as const, "MCP: Off"],
    ["error" as const, "MCP: Failed to start (see \"Use this app for MCP\")"],
  ])("MCP status item reflects status %s and is disabled/informational", (status, label) => {
    const i = item(label, status);
    expect(i.enabled).toBe(false);
    expect(i.click).toBeUndefined();
  });

  it("MCP status label never includes a port number", () => {
    for (const status of ["listening", "not-published", "off", "error"] as const) {
      const i = item(mcpStatusLabelFor(status), status);
      expect(String(i.label)).not.toMatch(/\d/);
    }
  });

  it("Use this app for MCP triggers useThisAppForMcp", () => {
    const i = item("Use this app for MCP");
    (i.click as () => void)();
    expect(actions.useThisAppForMcp).toHaveBeenCalled();
  });

  it("error status renders a visible, non-empty label distinct from off/not-published/listening", () => {
    const i = item(mcpStatusLabelFor("error"), "error");
    expect(i.enabled).toBe(false);
    expect(String(i.label).length).toBeGreaterThan(0);
    expect(i.label).not.toBe(mcpStatusLabelFor("off"));
  });

  // Finding 7: the tooltip (tabbar/renderer.ts) and README both point users
  // at "the app menu" for the MCP status line and "Use this app for MCP" —
  // but buildMenuTemplate appends both to the **File** submenu, not to the
  // real macOS app menu (the `{ role: "appMenu" }` this file unshifts
  // separately, above). This test pins the *actual* location so the two can
  // never silently drift apart again: if a future change moves these items
  // out of File (e.g. into the real app menu), this test fails and forces
  // the tooltip/README wording to be revisited in the same change.
  it("the MCP status line and 'Use this app for MCP' live in the File submenu, not the app menu", () => {
    const template = buildMenuTemplate(actions, { isMac: true }, "listening");
    const appMenu = template.find((i) => i.role === "appMenu");
    const fileMenu = template.find((i) => i.label === "File");
    expect(fileMenu).toBeTruthy();
    const fileSubmenu = fileMenu!.submenu as MenuItemConstructorOptions[];
    expect(fileSubmenu.some((i) => i.label === "MCP: Listening")).toBe(true);
    expect(fileSubmenu.some((i) => i.label === "Use this app for MCP")).toBe(true);
    // The real app menu's submenu is left as Electron's own default (no
    // `submenu` provided here at all) — confirms these items were never
    // routed there.
    expect(appMenu?.submenu).toBeUndefined();
  });
});

function mcpStatusLabelFor(status: "listening" | "not-published" | "off" | "error"): string {
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
