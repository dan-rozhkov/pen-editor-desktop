import { describe, expect, it, vi } from "vitest";
import { openDocTab, type DocOpenDeps } from "../src/main/docOpen";

function deps(over: Partial<DocOpenDeps> = {}): DocOpenDeps {
  return {
    isPanel: (id) => id === 1,
    isTraceTab: (id) => id === 3,
    isActive: (id) => id === 3,
    findDocTab: vi.fn(() => null),
    activate: vi.fn(),
    newDocTab: vi.fn(() => 5),
    ...over,
  };
}

describe("doc:open", () => {
  it("opens a new doc tab when none shows the document", () => {
    const d = deps();
    expect(openDocTab(d, 1, "abc_1")).toEqual({ ok: true });
    expect(d.newDocTab).toHaveBeenCalledWith("abc_1", { focus: false });
    expect(d.activate).not.toHaveBeenCalled();
  });

  it("activates the existing tab instead of opening a second one", () => {
    const d = deps({ findDocTab: vi.fn(() => 9) });
    expect(openDocTab(d, 1, "abc")).toEqual({ ok: true });
    expect(d.activate).toHaveBeenCalledWith(9, { focus: false });
    expect(d.newDocTab).not.toHaveBeenCalled();
  });

  it("refuses any sender but the agent panel", () => {
    const d = deps();
    expect(openDocTab(d, 2, "abc")).toMatchObject({ ok: false });
    expect(d.newDocTab).not.toHaveBeenCalled();
  });

  it("lets a trace tab open a doc tab and focuses it", () => {
    const d = deps();
    expect(openDocTab(d, 3, "abc_1")).toEqual({ ok: true });
    expect(d.newDocTab).toHaveBeenCalledWith("abc_1", { focus: true });
  });

  it("activates an existing doc tab with focus for a trace tab sender", () => {
    const d = deps({ findDocTab: vi.fn(() => 9) });
    expect(openDocTab(d, 3, "abc")).toEqual({ ok: true });
    expect(d.activate).toHaveBeenCalledWith(9, { focus: true });
    expect(d.newDocTab).not.toHaveBeenCalled();
  });

  it("refuses a sender that is neither the panel nor a trace viewer tab", () => {
    const d = deps();
    for (const sender of [2, 4, 99]) expect(openDocTab(d, sender, "abc")).toMatchObject({ ok: false });
    expect(d.newDocTab).not.toHaveBeenCalled();
    expect(d.activate).not.toHaveBeenCalled();
  });

  it("a background trace tab opens the doc tab without taking focus", () => {
    const d = deps({ isActive: () => false });
    expect(openDocTab(d, 3, "abc_1")).toEqual({ ok: true });
    expect(d.newDocTab).toHaveBeenCalledWith("abc_1", { focus: false });
  });

  it("validates ids for a trace tab sender too", () => {
    const d = deps();
    expect(openDocTab(d, 3, "../x")).toEqual({ ok: false, error: "invalid document id" });
  });

  it("rejects invalid ids without touching tabs", () => {
    const d = deps();
    for (const bad of ["", "a b", "../x", "x".repeat(65), 7, undefined, null]) {
      expect(openDocTab(d, 1, bad)).toEqual({ ok: false, error: "invalid document id" });
    }
    expect(d.findDocTab).not.toHaveBeenCalled();
    expect(d.newDocTab).not.toHaveBeenCalled();
  });

  it("turns a thrown error into {ok:false,error}", () => {
    const d = deps({ newDocTab: () => { throw new Error("boom"); } });
    expect(openDocTab(d, 1, "abc")).toEqual({ ok: false, error: "boom" });
  });
});
