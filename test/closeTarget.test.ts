import { describe, expect, it } from "vitest";
import {
  MENU_ACTION_SCOPE,
  decideCloseTarget,
  decideMenuAction,
  guardMenuActions,
  shouldReopenMainWindow,
} from "../src/main/closeTarget";
import type { MenuActions } from "../src/main/menu";

describe("decideCloseTarget (global Close Tab)", () => {
  it("closes the Passwords window when it is focused, never a main tab", () => {
    expect(decideCloseTarget({ passwordsFocused: true, activeTabId: 3, tabCount: 1 })).toEqual({ kind: "passwords" });
    expect(decideCloseTarget({ passwordsFocused: true, activeTabId: null, tabCount: 0 })).toEqual({ kind: "passwords" });
  });
  it("closes the active tab otherwise", () => {
    expect(decideCloseTarget({ passwordsFocused: false, activeTabId: 3, tabCount: 1 })).toEqual({ kind: "tab", id: 3 });
  });
  it("does nothing with no active tab but only background tabs", () => {
    // Background isolated-session tabs only: closing the window would kill running QA sessions.
    expect(decideCloseTarget({ passwordsFocused: false, activeTabId: null, tabCount: 2 })).toEqual({ kind: "none" });
  });
  it("closes the window when the window has zero tabs (like a browser)", () => {
    expect(decideCloseTarget({ passwordsFocused: false, activeTabId: null, tabCount: 0 })).toEqual({ kind: "window" });
  });
});

describe("menu actions while the Passwords window is focused", () => {
  const names = Object.keys(MENU_ACTION_SCOPE) as (keyof MenuActions)[];
  const recorder = () => {
    const calls: string[] = [];
    const actions = Object.fromEntries(names.map((n) => [n, (...a: unknown[]) => void calls.push([n, ...a].join(":"))])) as unknown as MenuActions;
    return { calls, actions };
  };

  it("every main-window action is ignored, Close Tab closes the Passwords window, app-level actions still run", () => {
    const { calls, actions } = recorder();
    let closed = 0;
    const guarded = guardMenuActions(actions, () => true, () => void closed++);
    guarded.newTab();
    guarded.newBrowserTab();
    guarded.nextTab();
    guarded.prevTab();
    guarded.forwardToActiveTab("file-open");
    guarded.closeTab();
    guarded.openPasswords();
    guarded.useThisAppForMcp();
    guarded.setCursorEnabled(true);
    expect(closed).toBe(1);
    expect(calls).toEqual(["openPasswords", "useThisAppForMcp", "setCursorEnabled:true"]);
  });

  it("with the main window focused everything runs, arguments intact, and Close Tab does not close Passwords", () => {
    const { calls, actions } = recorder();
    let closed = 0;
    const guarded = guardMenuActions(actions, () => false, () => void closed++);
    guarded.newTab();
    guarded.forwardToActiveTab("file-export-pen");
    guarded.closeTab();
    expect(calls).toEqual(["newTab", "forwardToActiveTab:file-export-pen", "closeTab"]);
    expect(closed).toBe(0);
  });

  it("focus is read at click time, not at wrap time", () => {
    const { calls, actions } = recorder();
    let focused = false;
    const guarded = guardMenuActions(actions, () => focused, () => {});
    guarded.newTab();
    focused = true;
    guarded.newTab();
    expect(calls).toEqual(["newTab"]);
  });

  it("decideMenuAction classifies every action", () => {
    for (const n of names) {
      expect(decideMenuAction(n, false)).toBe("run");
      const scope = MENU_ACTION_SCOPE[n];
      expect(decideMenuAction(n, true)).toBe(scope === "app" ? "run" : scope === "close" ? "close-passwords" : "ignore");
    }
  });
});

describe("shouldReopenMainWindow (macOS activate)", () => {
  const isPw = (w: string) => w === "pw";
  it("reopens when no window is left, or only the Passwords window is", () => {
    expect(shouldReopenMainWindow([], isPw)).toBe(true);
    expect(shouldReopenMainWindow(["pw"], isPw)).toBe(true);
  });
  it("does not reopen while a main window exists", () => {
    expect(shouldReopenMainWindow(["main"], isPw)).toBe(false);
    expect(shouldReopenMainWindow(["pw", "main"], isPw)).toBe(false);
  });
});
