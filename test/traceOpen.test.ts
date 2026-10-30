import { describe, expect, it, vi } from "vitest";
import { openTraceTab, type TraceOpenDeps } from "../src/main/traceOpen";
import { handleTraceList, handleTraceListTabs, handleTraceRead, handleTraceSave, type TraceIpcDeps } from "../src/main/traceIpc";

function deps(over: Partial<TraceOpenDeps> = {}): TraceOpenDeps {
  return {
    isPanel: (id) => id === 1,
    isDocViewer: vi.fn((id: number, url: string | undefined) => id === 6 && url === "https://ed.example/doc"),
    findTraceTab: vi.fn(() => null),
    activate: vi.fn(),
    newTraceTab: vi.fn(() => 5),
    ...over,
  };
}

const panel = { senderId: 1, topFrame: true, frameUrl: undefined };
const other = { senderId: 2, topFrame: true, frameUrl: "https://ed.example/doc" };
const docTab = { senderId: 6, topFrame: true, frameUrl: "https://ed.example/doc" };

describe("traces:open", () => {
  it("opens a new trace tab, without keyboard focus, when none shows the trace", () => {
    const d = deps();
    expect(openTraceTab(d, panel, "run_1")).toEqual({ ok: true });
    expect(d.newTraceTab).toHaveBeenCalledWith("run_1", { focus: false });
    expect(d.activate).not.toHaveBeenCalled();
  });

  it("focuses the existing tab instead of opening a second one", () => {
    const d = deps({ findTraceTab: vi.fn(() => 9) });
    expect(openTraceTab(d, panel, "run_1")).toEqual({ ok: true });
    expect(d.activate).toHaveBeenCalledWith(9, { focus: false });
    expect(d.newTraceTab).not.toHaveBeenCalled();
  });

  it("refuses any sender but the agent panel and a doc tab", () => {
    const d = deps();
    expect(openTraceTab(d, other, "run_1")).toMatchObject({ ok: false });
    expect(d.newTraceTab).not.toHaveBeenCalled();
    expect(d.activate).not.toHaveBeenCalled();
  });

  it("a doc tab on the doc page opens a new trace tab WITH focus", () => {
    const d = deps();
    expect(openTraceTab(d, docTab, "run_1")).toEqual({ ok: true });
    expect(d.newTraceTab).toHaveBeenCalledWith("run_1", { focus: true });
  });

  it("a doc tab focuses an existing trace tab", () => {
    const d = deps({ findTraceTab: vi.fn(() => 9) });
    expect(openTraceTab(d, docTab, "run_1")).toEqual({ ok: true });
    expect(d.activate).toHaveBeenCalledWith(9, { focus: true });
    expect(d.newTraceTab).not.toHaveBeenCalled();
  });

  it("a doc tab call from a subframe, or off the doc page, is refused", () => {
    const d = deps();
    expect(openTraceTab(d, { ...docTab, topFrame: false }, "run_1")).toMatchObject({ ok: false });
    expect(openTraceTab(d, { ...docTab, frameUrl: "https://ed.example/app" }, "run_1")).toMatchObject({ ok: false });
    expect(openTraceTab(d, { ...docTab, frameUrl: undefined }, "run_1")).toMatchObject({ ok: false });
    expect(d.newTraceTab).not.toHaveBeenCalled();
  });

  it("rejects invalid ids without touching tabs", () => {
    const d = deps();
    for (const bad of ["", "a b", "../x", "a/b", "x".repeat(65), 7, undefined, null]) {
      expect(openTraceTab(d, panel, bad)).toEqual({ ok: false, error: "invalid trace id" });
    }
    expect(d.findTraceTab).not.toHaveBeenCalled();
    expect(d.newTraceTab).not.toHaveBeenCalled();
  });

  it("turns a thrown error into {ok:false,error}", () => {
    const d = deps({ newTraceTab: () => { throw new Error("boom"); } });
    expect(openTraceTab(d, panel, "abc")).toEqual({ ok: false, error: "boom" });
  });
});

describe("traces:save / traces:read sender rules", () => {
  // webContents ids: 1 panel, 2 editor tab, 3 trace tab, 4 browser tab / anything else
  function ipcDeps(): TraceIpcDeps & { store: { save: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } } {
    return {
      store: { save: vi.fn(async () => ({ id: "t1" })), read: vi.fn(async () => ({ error: "trace not found" })), list: vi.fn(async () => ({ traces: [] })) },
      isPanel: (id) => id === 1,
      isEditorTab: (id) => id === 2,
      isTraceTab: (id) => id === 3,
    };
  }

  it("save: the panel and editor tabs only", async () => {
    const d = ipcDeps();
    expect(await handleTraceSave(d, 1, {})).toEqual({ id: "t1" });
    expect(await handleTraceSave(d, 2, {})).toEqual({ id: "t1" });
    expect(await handleTraceSave(d, 3, {})).toHaveProperty("error");
    expect(await handleTraceSave(d, 4, {})).toHaveProperty("error");
    expect(d.store.save).toHaveBeenCalledTimes(2);
  });

  it("read: trace tabs, the panel and editor tabs; nobody else", async () => {
    const d = ipcDeps();
    for (const sender of [1, 2, 3]) expect(await handleTraceRead(d, sender, "t1")).toEqual({ error: "trace not found" });
    expect(d.store.read).toHaveBeenCalledTimes(3);
    expect(await handleTraceRead(d, 4, "t1")).toHaveProperty("error");
    expect(d.store.read).toHaveBeenCalledTimes(3);
  });

  it("read: forwards only a plain { frames: boolean } option", async () => {
    const d = ipcDeps();
    await handleTraceRead(d, 1, "t1", { frames: false });
    expect(d.store.read).toHaveBeenLastCalledWith("t1", { frames: false });
    await handleTraceRead(d, 1, "t1", { frames: true, extra: 1 });
    expect(d.store.read).toHaveBeenLastCalledWith("t1", { frames: true });
    await handleTraceRead(d, 1, "t1", { frames: true, frameIds: [2, 5] });
    expect(d.store.read).toHaveBeenLastCalledWith("t1", { frames: true, frameIds: [2, 5] });
    await handleTraceRead(d, 1, "t1", { frames: true, frameIds: [1, "x"] });
    expect(d.store.read).toHaveBeenLastCalledWith("t1", { frames: true });
    for (const bad of [undefined, null, "x", 5, [], [false], { frames: "no" }, { frames: 0 }, {}, new Map(), Object.create({ frames: false })]) {
      await handleTraceRead(d, 1, "t1", bad);
      expect(d.store.read, String(bad)).toHaveBeenLastCalledWith("t1");
    }
  });

  it("a throwing store becomes {error}", async () => {
    const d = ipcDeps();
    d.store.save.mockImplementation(async () => { throw new Error("disk"); });
    d.store.read.mockImplementation(async () => { throw new Error("disk"); });
    expect(await handleTraceSave(d, 1, {})).toEqual({ error: "disk" });
    expect(await handleTraceRead(d, 1, "t1")).toEqual({ error: "disk" });
  });
});

describe("traces:list sender rules", () => {
  const mk = (list = vi.fn(async () => ({ traces: [] }))): TraceIpcDeps => ({
    store: { save: vi.fn(), read: vi.fn(), list } as unknown as TraceIpcDeps["store"],
    isPanel: (id) => id === 1,
    isEditorTab: (id) => id === 2,
    isTraceTab: (id) => id === 3,
  });

  it("same senders as traces:read: panel, editor tab, trace tab", async () => {
    const list = vi.fn(async () => ({ traces: [] }));
    const d = mk(list);
    expect(await handleTraceList(d, 1)).toEqual({ traces: [] });
    expect(await handleTraceList(d, 2)).toEqual({ traces: [] });
    expect(await handleTraceList(d, 3)).toEqual({ traces: [] });
    expect(await handleTraceList(d, 4)).toEqual({ error: "traces:list is not allowed from this sender" });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("a rejecting store comes back as an error value", async () => {
    expect(await handleTraceList(mk(vi.fn(async () => Promise.reject(new Error("disk")))), 1)).toEqual({ error: "disk" });
  });
});

describe("traces:list-tabs", () => {
  const tabs = [{ traceId: "a", title: "A", active: false }, { traceId: "b", title: "B", active: true }];
  it("returns the tabs to the panel", () => {
    expect(handleTraceListTabs({ isPanel: (id) => id === 1, listTraceTabs: () => tabs }, 1)).toEqual({ tabs });
  });
  it("rejects other senders without listing", () => {
    const listTraceTabs = vi.fn(() => tabs);
    expect(handleTraceListTabs({ isPanel: (id) => id === 1, listTraceTabs }, 2)).toEqual({
      error: "traces:list-tabs is only allowed from the agent panel",
    });
    expect(listTraceTabs).not.toHaveBeenCalled();
  });
  it("never throws", () => {
    const r = handleTraceListTabs({ isPanel: () => true, listTraceTabs: () => { throw new Error("boom"); } }, 1);
    expect(r).toEqual({ error: "boom" });
  });
});
