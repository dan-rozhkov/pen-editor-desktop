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
      closeTab: vi.fn(),
      nextTab: vi.fn(),
      prevTab: vi.fn(),
      forwardToActiveTab: vi.fn(),
    };
  });

  function item(label: string): MenuItemConstructorOptions {
    const found = flatten(buildMenuTemplate(actions, { isMac: true })).find((i) => i.label === label);
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
});
