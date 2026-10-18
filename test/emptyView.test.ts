import { describe, expect, it } from "vitest";
import { emptyViewVisible, isTabCreationSender, planEmptyViewUpdate, shouldPushInitialSnapshot } from "../src/main/emptyView";

describe("emptyView decisions", () => {
  it("is visible only while no tab is active", () => {
    expect(emptyViewVisible({ activeId: null })).toBe(true);
    expect(emptyViewVisible({ activeId: 4 })).toBe(false);
  });

  it("pushes the first snapshot only when the window opens with zero tabs", () => {
    expect(shouldPushInitialSnapshot(0)).toBe(true);
    expect(shouldPushInitialSnapshot(1)).toBe(false);
  });

  it("applies visibility and theme only on change, and focuses when the view appears", () => {
    const hidden = { visible: false, theme: "light" as const };
    expect(planEmptyViewUpdate(hidden, hidden)).toEqual({ focus: false });
    expect(planEmptyViewUpdate(hidden, { visible: true, theme: "light" })).toEqual({ focus: true, visible: true });
    expect(planEmptyViewUpdate({ visible: true, theme: "light" }, { visible: true, theme: "dark" })).toEqual({
      focus: false,
      theme: "dark",
    });
    expect(planEmptyViewUpdate({ visible: true, theme: "dark" }, { visible: false, theme: "dark" })).toEqual({
      focus: false,
      visible: false,
    });
  });

  it("accepts tab creation from the tab bar or the empty view only", () => {
    expect(isTabCreationSender(1, 1, 2)).toBe(true);
    expect(isTabCreationSender(2, 1, 2)).toBe(true);
    expect(isTabCreationSender(3, 1, 2)).toBe(false);
    expect(isTabCreationSender(3, 1, undefined)).toBe(false);
  });
});
