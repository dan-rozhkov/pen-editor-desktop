import { describe, expect, it } from "vitest";
import { decideEmptyFocus, isTabCreationSender, planEmptyViewUpdate } from "../src/main/emptyView";

describe("emptyView decisions", () => {
  it("applies visibility, theme and session count only on change", () => {
    const hidden = { visible: false, theme: "light" as const, sessionTabs: 0 };
    expect(planEmptyViewUpdate(hidden, hidden, false)).toEqual({ focus: "none" });
    expect(planEmptyViewUpdate(hidden, { ...hidden, visible: true }, false)).toEqual({ focus: "panel", visible: true });
    expect(planEmptyViewUpdate({ ...hidden, visible: true }, { visible: true, theme: "dark", sessionTabs: 0 }, true)).toEqual({
      focus: "none",
      theme: "dark",
    });
    expect(planEmptyViewUpdate({ ...hidden, visible: true }, { ...hidden, visible: false }, false)).toEqual({
      focus: "none",
      visible: false,
    });
    expect(planEmptyViewUpdate({ ...hidden, visible: true }, { ...hidden, visible: true, sessionTabs: 2 }, false)).toEqual({
      focus: "none",
      sessionTabs: 2,
    });
  });

  it("focuses the placeholder only when the user closed the last tab", () => {
    expect(decideEmptyFocus(true, true)).toBe("empty");
    // Agent closes, fixture resets and the window's startup push go to the panel.
    expect(decideEmptyFocus(true, false)).toBe("panel");
    expect(decideEmptyFocus(false, true)).toBe("none");
    expect(decideEmptyFocus(false, false)).toBe("none");
  });

  it("accepts tab creation from the tab bar or the empty view only", () => {
    expect(isTabCreationSender(1, 1, 2)).toBe(true);
    expect(isTabCreationSender(2, 1, 2)).toBe(true);
    expect(isTabCreationSender(3, 1, 2)).toBe(false);
    expect(isTabCreationSender(3, 1, undefined)).toBe(false);
  });
});

import { focusAfterCollapse, resolveFocusTarget } from "../src/main/emptyView";

describe("focus with a collapsed agent panel", () => {
  it("never focuses the hidden panel", () => {
    expect(resolveFocusTarget("panel", true, true)).toBe("empty");
    expect(resolveFocusTarget("panel", true, false)).toBe("tab");
    expect(resolveFocusTarget("panel", false, true)).toBe("panel");
  });
  it("leaves other targets alone", () => {
    expect(resolveFocusTarget("empty", true, true)).toBe("empty");
    expect(resolveFocusTarget("none", true, true)).toBe("none");
  });
  it("collapsing while the panel has focus moves it to the placeholder or the active tab", () => {
    expect(focusAfterCollapse(true)).toBe("empty");
    expect(focusAfterCollapse(false)).toBe("tab");
  });
});
