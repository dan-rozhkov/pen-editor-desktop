import { describe, expect, it } from "vitest";
import { decideCloseTarget, shouldReopenMainWindow } from "../src/main/closeTarget";

describe("decideCloseTarget (global Close Tab)", () => {
  it("closes the active tab", () => {
    expect(decideCloseTarget({ activeTabId: 3 })).toEqual({ kind: "tab", id: 3 });
  });
  it("does nothing with no active tab: it never closes the window", () => {
    expect(decideCloseTarget({ activeTabId: null })).toEqual({ kind: "none" });
  });
});

describe("shouldReopenMainWindow (macOS activate)", () => {
  const isOverlay = (w: string) => w === "overlay";
  it("reopens when no window is left, or only non-main windows are", () => {
    expect(shouldReopenMainWindow([], isOverlay)).toBe(true);
    expect(shouldReopenMainWindow(["overlay"], isOverlay)).toBe(true);
  });
  it("does not reopen while a main window exists", () => {
    expect(shouldReopenMainWindow(["main"], isOverlay)).toBe(false);
    expect(shouldReopenMainWindow(["overlay", "main"], isOverlay)).toBe(false);
  });
});
