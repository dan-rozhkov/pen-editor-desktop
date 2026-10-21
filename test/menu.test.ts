import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMenuTemplate, buildNewTabMenuTemplate, type MenuActions } from "../src/main/menu";
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
      newDocTab: vi.fn(),
      openSettings: vi.fn(),
      openPasswords: vi.fn(),
      signIn: vi.fn(),
      closeTab: vi.fn(), closeWindow: vi.fn(),
      nextTab: vi.fn(),
      prevTab: vi.fn(),
      forwardToActiveTab: vi.fn(),
      useThisAppForMcp: vi.fn(),
      setCursorEnabled: vi.fn(),
      toggleAgentPanel: vi.fn(),
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
    expect(buildMenuTemplate(actions, { isMac: true, appName: "Sideform" })[0].label).toBe("Sideform");
    expect(buildMenuTemplate(actions, { isMac: false })[0].label).toBe("File");
  });

  it("mac app menu keeps the default roles and adds Settings… (CmdOrCtrl+,) after About", () => {
    const appMenu = buildMenuTemplate(actions, { isMac: true })[0];
    const sub = appMenu.submenu as MenuItemConstructorOptions[];
    expect(sub.map((i) => i.role ?? i.type ?? i.label)).toEqual([
      "about", "separator", "Settings…", "separator", "services", "separator", "hide", "hideOthers", "unhide", "separator", "quit",
    ]);
    const settings = sub.find((i) => i.label === "Settings…")!;
    expect(settings.accelerator).toBe("CmdOrCtrl+,");
    (settings.click as () => void)();
    expect(actions.openSettings).toHaveBeenCalledOnce();
    // Not duplicated in File on mac.
    const file = buildMenuTemplate(actions, { isMac: true }).find((i) => i.label === "File")!;
    expect((file.submenu as MenuItemConstructorOptions[]).some((i) => i.label === "Settings…")).toBe(false);
  });

  it("off mac, Settings… (CmdOrCtrl+,) is in the File menu", () => {
    const file = buildMenuTemplate(actions, { isMac: false }).find((i) => i.label === "File")!;
    const settings = (file.submenu as MenuItemConstructorOptions[]).find((i) => i.label === "Settings…")!;
    expect(settings.accelerator).toBe("CmdOrCtrl+,");
    (settings.click as () => void)();
    expect(actions.openSettings).toHaveBeenCalledOnce();
  });

  it("reads New Canvas Tab, same action and accelerator", () => {
    const t = buildMenuTemplate(actions, { isMac: false });
    const i = flatten(t).find((x) => x.label === "New Canvas Tab")!;
    expect(i.accelerator).toBe("CmdOrCtrl+T");
    (i.click as () => void)();
    expect(actions.newTab).toHaveBeenCalled();
    expect(flatten(t).some((x) => x.label === "New Tab")).toBe(false);
  });

  it("New Browser Tab triggers newBrowserTab", () => {
    const i = item("New Browser Tab");
    (i.click as () => void)();
    expect(actions.newBrowserTab).toHaveBeenCalled();
  });

  it("New Document Tab triggers newDocTab with CmdOrCtrl+Shift+D", () => {
    const i = item("New Document Tab");
    expect(i.accelerator).toBe("CmdOrCtrl+Shift+D");
    (i.click as () => void)();
    expect(actions.newDocTab).toHaveBeenCalledOnce();
  });

  it("Passwords… opens the Passwords tab and forwards no menu command", () => {
    const i = item("Passwords…");
    (i.click as () => void)();
    expect(actions.openPasswords).toHaveBeenCalledTimes(1);
    expect(actions.forwardToActiveTab).not.toHaveBeenCalled();
  });

  it("Sign In… sits in the File menu and starts the browser sign-in without forwarding a menu command", () => {
    const file = buildMenuTemplate(actions, { isMac: true }).find((m) => m.label === "File")!;
    const labels = (file.submenu as MenuItemConstructorOptions[]).map((i) => i.label);
    expect(labels).toContain("Sign In…");
    const i = item("Sign In…");
    (i.click as () => void)();
    expect(actions.signIn).toHaveBeenCalledTimes(1);
    expect(actions.forwardToActiveTab).not.toHaveBeenCalled();
  });

  it("Close Window triggers closeWindow with CmdOrCtrl+Shift+W", () => {
    const i = item("Close Window");
    expect(i.accelerator).toBe("CmdOrCtrl+Shift+W");
    (i.click as () => void)();
    expect(actions.closeWindow).toHaveBeenCalled();
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

  describe("View > Show Agent Cursor", () => {
    const state = { enabled: true, enabledLocked: false };
    const cursorItem = (cursor = state) => {
      const view = buildMenuTemplate(actions, { isMac: true }, "off", cursor).find((m) => m.label === "View")!;
      const found = (view.submenu as MenuItemConstructorOptions[]).find((i) => i.label === "Show Agent Cursor");
      if (!found) throw new Error("Show Agent Cursor item missing");
      return found;
    };

    it("is a checkbox directly in the View menu; the motion submenu is gone", () => {
      expect(cursorItem().type).toBe("checkbox");
      const view = buildMenuTemplate(actions, { isMac: true }).find((m) => m.label === "View")!;
      expect((view.submenu as MenuItemConstructorOptions[]).some((i) => i.label === "Agent Cursor Motion")).toBe(false);
    });

    it("reflects the current enabled flag", () => {
      expect(cursorItem().checked).toBe(true);
      expect(cursorItem({ ...state, enabled: false }).checked).toBe(false);
    });

    it("clicking forwards the new checkbox state", () => {
      (cursorItem().click as (i: { checked: boolean }) => void)({ checked: false });
      expect(actions.setCursorEnabled).toHaveBeenCalledWith(false);
    });

    it("is disabled when an env var locks the value", () => {
      expect(cursorItem({ ...state, enabledLocked: true }).enabled).toBe(false);
      expect(cursorItem().enabled).toBe(true);
    });
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
    const appMenu = template[0];
    const fileMenu = template.find((i) => i.label === "File");
    expect(fileMenu).toBeTruthy();
    const fileSubmenu = fileMenu!.submenu as MenuItemConstructorOptions[];
    expect(fileSubmenu.some((i) => i.label === "MCP: Listening")).toBe(true);
    expect(fileSubmenu.some((i) => i.label === "Use this app for MCP")).toBe(true);
    // The app menu (explicit now: Electron's default roles plus Settings…) never got them.
    const appLabels = (appMenu.submenu as MenuItemConstructorOptions[]).map((i) => i.label);
    expect(appLabels).not.toContain("MCP: Listening");
    expect(appLabels).not.toContain("Use this app for MCP");
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

describe("buildNewTabMenuTemplate", () => {
  it("offers an editor tab and a browser tab, each wired to its action", () => {
    const actions = { newTab: vi.fn(), newBrowserTab: vi.fn(), newDocTab: vi.fn() };
    const [editor, browser, doc] = buildNewTabMenuTemplate(actions);

    expect(editor.label).toBe("New Canvas Tab");
    // Display-only: the application menu already owns ⌘T.
    expect(editor.accelerator).toBe("CmdOrCtrl+T");
    expect(editor.registerAccelerator).toBe(false);
    (editor.click as () => void)();
    expect(actions.newTab).toHaveBeenCalledOnce();

    expect(browser.label).toBe("New Browser Tab");
    (browser.click as () => void)();
    expect(actions.newBrowserTab).toHaveBeenCalledOnce();

    expect(doc.label).toBe("New Document");
    (doc.click as () => void)();
    expect(actions.newDocTab).toHaveBeenCalledOnce();
  });
});

describe("View > Agent Panel", () => {
  const actions = {
    newTab: vi.fn(), newBrowserTab: vi.fn(), newDocTab: vi.fn(), openSettings: vi.fn(), openPasswords: vi.fn(), signIn: vi.fn(), closeTab: vi.fn(), closeWindow: vi.fn(), nextTab: vi.fn(), prevTab: vi.fn(),
    forwardToActiveTab: vi.fn(), useThisAppForMcp: vi.fn(), setCursorEnabled: vi.fn(), toggleAgentPanel: vi.fn(),
  } as MenuActions;
  it("View menu has a Show/Hide Agent Panel item (Cmd/Ctrl+Alt+B) only with the agent layout", () => {
    const labels = (opts: Parameters<typeof buildMenuTemplate>[1]) => {
      const view = buildMenuTemplate(actions, opts).find((m) => m.label === "View");
      return (view?.submenu as MenuItemConstructorOptions[]).map((m) => m.label);
    };
    expect(labels({ isMac: true })).not.toContain("Hide Agent Panel");
    expect(labels({ isMac: true, agentPanel: { collapsed: false } })).toContain("Hide Agent Panel");
    expect(labels({ isMac: true, agentPanel: { collapsed: true } })).toContain("Show Agent Panel");
    const view = buildMenuTemplate(actions, { isMac: false, agentPanel: { collapsed: false } }).find((m) => m.label === "View");
    const it = (view?.submenu as MenuItemConstructorOptions[]).find((m) => m.label === "Hide Agent Panel")!;
    expect(it.accelerator).toBe("CmdOrCtrl+Alt+B");
    (it.click as () => void)();
    expect(actions.toggleAgentPanel).toHaveBeenCalledTimes(1);
  });
});
