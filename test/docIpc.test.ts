import { describe, expect, it, vi } from "vitest";
import { handleDocDelete, handleDocList, handleDocSave, type DocIpcDeps } from "../src/main/docIpc";

function deps(role: "panel" | "editor" | "doc" | "trace" | "browser"): DocIpcDeps & { store: { list: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } } {
  return {
    store: { list: vi.fn(async () => ({ docs: [] })), save: vi.fn(async () => ({ ok: true as const, rev: 1 })), remove: vi.fn(async () => ({ ok: true as const })) },
    isPanel: () => role === "panel",
    isEditorTab: () => role === "editor",
    isDocTab: () => role === "doc",
    isTraceTab: () => role === "trace",
  };
}

describe("docs:* sender rules", () => {
  for (const role of ["panel", "editor", "doc", "trace"] as const) {
    it(`allows ${role}`, async () => {
      const d = deps(role);
      expect(await handleDocList(d, 1)).toEqual({ docs: [] });
      expect(await handleDocSave(d, 1, { id: "a" })).toEqual({ ok: true, rev: 1 });
      expect(await handleDocDelete(d, 1, "a")).toEqual({ ok: true });
      expect(d.store.save).toHaveBeenCalledWith({ id: "a" });
      expect(d.store.remove).toHaveBeenCalledWith("a");
    });
  }

  it("refuses browser tabs and unknown senders without touching the store", async () => {
    const d = deps("browser");
    expect(await handleDocList(d, 1)).toEqual({ error: "docs:list is not allowed from this sender" });
    expect(await handleDocSave(d, 1, {})).toEqual({ error: "docs:save is not allowed from this sender" });
    expect(await handleDocDelete(d, 1, "a")).toEqual({ error: "docs:delete is not allowed from this sender" });
    expect(d.store.list).not.toHaveBeenCalled();
    expect(d.store.save).not.toHaveBeenCalled();
    expect(d.store.remove).not.toHaveBeenCalled();
  });

  it("turns a throwing store into an error value", async () => {
    const d = deps("panel");
    d.store.list.mockRejectedValue(new Error("boom"));
    d.store.save.mockRejectedValue(new Error("boom"));
    d.store.remove.mockRejectedValue("boom");
    expect(await handleDocList(d, 1)).toEqual({ error: "boom" });
    expect(await handleDocSave(d, 1, {})).toEqual({ error: "boom" });
    expect(await handleDocDelete(d, 1, "a")).toEqual({ error: "boom" });
  });
});
