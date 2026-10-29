import { describe, expect, it, vi } from "vitest";
import { notifyRecentChanged, openRecentItem, parseRecentTarget, parseRecentMenuRequest, recentFor, type EmptyOpenDeps } from "../src/main/emptyOpen";

function deps(over: Partial<EmptyOpenDeps> = {}) {
  return {
    isEmptyView: (id: number) => id === 7,
    findCanvasTab: vi.fn((): number | null => null),
    findDocTab: vi.fn((): number | null => null),
    activate: vi.fn(),
    newCanvasTab: vi.fn(() => 1),
    newDocTab: vi.fn(() => 2),
    ...over,
  };
}

describe("openRecentItem", () => {
  it("opens a new canvas tab with focus when none is open", () => {
    const d = deps();
    expect(openRecentItem(d, 7, { kind: "canvas", id: "cv_1" })).toEqual({ ok: true });
    expect(d.newCanvasTab).toHaveBeenCalledWith("cv_1", { focus: true });
    expect(d.activate).not.toHaveBeenCalled();
  });

  it("opens a new doc tab with focus when none is open", () => {
    const d = deps();
    expect(openRecentItem(d, 7, { kind: "doc", id: "abc" })).toEqual({ ok: true });
    expect(d.newDocTab).toHaveBeenCalledWith("abc", { focus: true });
  });

  it("activates an open tab for that id, with focus", () => {
    const d = deps({ findCanvasTab: vi.fn(() => 5), findDocTab: vi.fn(() => 6) });
    openRecentItem(d, 7, { kind: "canvas", id: "cv_1" });
    expect(d.activate).toHaveBeenLastCalledWith(5, { focus: true });
    openRecentItem(d, 7, { kind: "doc", id: "abc" });
    expect(d.activate).toHaveBeenLastCalledWith(6, { focus: true });
    expect(d.newCanvasTab).not.toHaveBeenCalled();
    expect(d.newDocTab).not.toHaveBeenCalled();
  });

  it("refuses every sender but the empty view", () => {
    const d = deps();
    expect(openRecentItem(d, 8, { kind: "doc", id: "abc" })).toEqual({ ok: false, error: "empty:open is only allowed from the empty view" });
    expect(d.newDocTab).not.toHaveBeenCalled();
  });

  it("refuses a bad kind, id or payload", () => {
    const d = deps();
    for (const payload of [null, "x", {}, { kind: "browser", id: "a" }, { kind: "doc", id: "a/b" }, { kind: "canvas", id: "" }, { kind: "doc" }]) {
      expect(openRecentItem(d, 7, payload).ok).toBe(false);
    }
    expect(d.newDocTab).not.toHaveBeenCalled();
    expect(d.newCanvasTab).not.toHaveBeenCalled();
  });

  it("turns a throwing window into an error value", () => {
    const d = deps({ newDocTab: () => { throw new Error("boom"); } });
    expect(openRecentItem(d, 7, { kind: "doc", id: "abc" })).toEqual({ ok: false, error: "boom" });
  });
});

describe("recentFor", () => {
  it("returns the list for the empty view only", async () => {
    const load = vi.fn(async () => [1, 2]);
    expect(await recentFor({ isEmptyView: (id) => id === 7, load }, 7)).toEqual({ items: [1, 2] });
    expect(await recentFor({ isEmptyView: (id) => id === 7, load }, 8)).toEqual({ items: [] });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("a failing load gives an empty list", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recentFor({ isEmptyView: () => true, load: async () => { throw new Error("x"); } }, 1)).toEqual({ items: [] });
    spy.mockRestore();
  });
});

describe("notifyRecentChanged", () => {
  it("sends the event to live views only and survives a throwing one", () => {
    const live = { isDestroyed: () => false, send: vi.fn() };
    const dead = { isDestroyed: () => true, send: vi.fn() };
    const broken = { isDestroyed: () => false, send: vi.fn(() => { throw new Error("gone"); }) };
    notifyRecentChanged(new Set([broken, dead, live]));
    expect(live.send).toHaveBeenCalledWith("empty:recent-changed");
    expect(dead.send).not.toHaveBeenCalled();
  });
});

describe("parseRecentMenuRequest", () => {
  const d = { isEmptyView: (id: number) => id === 7 };
  it("accepts a valid canvas or doc row from the empty view", () => {
    expect(parseRecentMenuRequest(d, 7, { kind: "canvas", id: "cv_1" })).toEqual({ ok: true, kind: "canvas", id: "cv_1" });
    expect(parseRecentMenuRequest(d, 7, { kind: "doc", id: "abc" })).toEqual({ ok: true, kind: "doc", id: "abc" });
  });
  it("refuses another sender, a bad kind and a bad id", () => {
    expect(parseRecentMenuRequest(d, 8, { kind: "doc", id: "abc" }).ok).toBe(false);
    expect(parseRecentMenuRequest(d, 7, { kind: "trace", id: "abc" }).ok).toBe(false);
    expect(parseRecentMenuRequest(d, 7, { kind: "doc", id: "../x" }).ok).toBe(false);
    expect(parseRecentMenuRequest(d, 7, null).ok).toBe(false);
  });
});

describe("parseRecentTarget", () => {
  it("accepts a valid canvas or doc entry", () => {
    expect(parseRecentTarget({ kind: "canvas", id: "cv_1" })).toEqual({ ok: true, kind: "canvas", id: "cv_1" });
    expect(parseRecentTarget({ kind: "doc", id: "doc_1", extra: 1 })).toEqual({ ok: true, kind: "doc", id: "doc_1" });
  });
  it("names the invalid part", () => {
    expect(parseRecentTarget(null)).toEqual({ ok: false, error: "invalid kind" });
    expect(parseRecentTarget({ kind: "note", id: "a" })).toEqual({ ok: false, error: "invalid kind" });
    expect(parseRecentTarget({ kind: "doc", id: "../x" })).toEqual({ ok: false, error: "invalid id" });
  });
});
