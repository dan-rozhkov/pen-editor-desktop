import { describe, expect, it } from "vitest";
import { isBrowserOwner, isOrphaningEvent } from "../src/main/orphanRelease";

describe("isOrphaningEvent", () => {
  it("renderer death always orphans", () => {
    expect(isOrphaningEvent({ type: "render-process-gone" })).toBe(true);
  });
  it("a committed main-frame navigation orphans", () => {
    expect(isOrphaningEvent({ type: "did-navigate", isMainFrame: true, isSameDocument: false })).toBe(true);
  });
  it("a subframe or same-document navigation does not", () => {
    expect(isOrphaningEvent({ type: "did-navigate", isMainFrame: false, isSameDocument: false })).toBe(false);
    expect(isOrphaningEvent({ type: "did-navigate", isMainFrame: true, isSameDocument: true })).toBe(false);
  });
});

describe("isBrowserOwner", () => {
  it("editor tabs and the live panel own; a null panel never matches", () => {
    const tab = (id: number) => id === 5;
    expect(isBrowserOwner(5, tab, null)).toBe(true);
    expect(isBrowserOwner(7, tab, 7)).toBe(true);
    expect(isBrowserOwner(7, tab, null)).toBe(false);
  });
});
