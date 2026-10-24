import { describe, expect, it, vi } from "vitest";
import { handleCanvasDelete, handleCanvasList, handleCanvasRead, handleCanvasSave, type CanvasIpcDeps } from "../src/main/canvasIpc";

function deps(role: "panel" | "editor" | "doc" | "trace" | "browser" | "empty") {
  return {
    store: {
      list: vi.fn(async () => ({ canvases: [] })),
      read: vi.fn(async () => ({ canvas: null })),
      save: vi.fn(async () => ({ ok: true as const, rev: 1 })),
      remove: vi.fn(async () => ({ ok: true as const })),
    },
    isPanel: () => role === "panel",
    isCanvasWriter: () => role === "editor",
  } satisfies CanvasIpcDeps;
}

describe("canvases:* sender rules", () => {
  it("allows an editor tab everything", async () => {
    const d = deps("editor");
    expect(await handleCanvasList(d, 1)).toEqual({ canvases: [] });
    expect(await handleCanvasRead(d, 1, "a")).toEqual({ canvas: null });
    expect(await handleCanvasSave(d, 1, { id: "a" })).toEqual({ ok: true, rev: 1 });
    expect(await handleCanvasDelete(d, 1, "a")).toEqual({ ok: true });
    expect(d.store.read).toHaveBeenCalledWith("a");
    expect(d.store.save).toHaveBeenCalledWith({ id: "a" });
    expect(d.store.remove).toHaveBeenCalledWith("a");
  });

  it("the panel may only list", async () => {
    const d = deps("panel");
    expect(await handleCanvasList(d, 1)).toEqual({ canvases: [] });
    expect(await handleCanvasRead(d, 1, "a")).toEqual({ error: "canvases:read is not allowed from this sender" });
    expect(await handleCanvasSave(d, 1, {})).toEqual({ error: "canvases:save is not allowed from this sender" });
    expect(await handleCanvasDelete(d, 1, "a")).toEqual({ error: "canvases:delete is not allowed from this sender" });
    expect(d.store.read).not.toHaveBeenCalled();
    expect(d.store.save).not.toHaveBeenCalled();
    expect(d.store.remove).not.toHaveBeenCalled();
  });

  for (const role of ["doc", "trace", "browser", "empty"] as const) {
    it(`refuses ${role} without touching the store`, async () => {
      const d = deps(role);
      expect(await handleCanvasList(d, 1)).toEqual({ error: "canvases:list is not allowed from this sender" });
      expect(await handleCanvasRead(d, 1, "a")).toEqual({ error: "canvases:read is not allowed from this sender" });
      expect(await handleCanvasSave(d, 1, {})).toEqual({ error: "canvases:save is not allowed from this sender" });
      expect(await handleCanvasDelete(d, 1, "a")).toEqual({ error: "canvases:delete is not allowed from this sender" });
      for (const fn of Object.values(d.store)) expect(fn).not.toHaveBeenCalled();
    });
  }

  it("turns a throwing store into an error value", async () => {
    const d = deps("editor");
    d.store.list.mockRejectedValue(new Error("boom"));
    d.store.read.mockRejectedValue(new Error("boom"));
    d.store.save.mockRejectedValue(new Error("boom"));
    d.store.remove.mockRejectedValue("boom");
    expect(await handleCanvasList(d, 1)).toEqual({ error: "boom" });
    expect(await handleCanvasRead(d, 1, "a")).toEqual({ error: "boom" });
    expect(await handleCanvasSave(d, 1, {})).toEqual({ error: "boom" });
    expect(await handleCanvasDelete(d, 1, "a")).toEqual({ error: "boom" });
  });
});
