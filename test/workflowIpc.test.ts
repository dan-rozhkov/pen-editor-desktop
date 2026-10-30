import { describe, expect, it, vi } from "vitest";
import { handleWorkflowDelete, handleWorkflowList, handleWorkflowSave, type WorkflowIpcDeps } from "../src/main/workflowIpc";

function deps(role: "panel" | "workflow" | "editor" | "browser"): WorkflowIpcDeps & { store: { list: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } } {
  return {
    store: { list: vi.fn(async () => ({ workflows: [], deleted: [] })), save: vi.fn(async () => ({ ok: true as const, rev: 1 })), remove: vi.fn(async () => ({ ok: true as const })) },
    isPanel: () => role === "panel",
    isWorkflowTab: () => role === "workflow",
  };
}

describe("workflows:* sender rules", () => {
  for (const role of ["panel", "workflow"] as const) {
    it(`allows ${role}`, async () => {
      const d = deps(role);
      expect(await handleWorkflowList(d, 1)).toEqual({ workflows: [], deleted: [] });
      expect(await handleWorkflowSave(d, 1, { id: "a" })).toEqual({ ok: true, rev: 1 });
      expect(await handleWorkflowDelete(d, 1, "a")).toEqual({ ok: true });
      expect(d.store.save).toHaveBeenCalledWith({ id: "a" });
      expect(d.store.remove).toHaveBeenCalledWith("a");
    });
  }

  it("refuses editor tabs, browser tabs and unknown senders without touching the store", async () => {
    for (const role of ["browser", "editor"] as const) {
      const d = deps(role);
    expect(await handleWorkflowList(d, 1)).toEqual({ error: "workflows:list is not allowed from this sender" });
    expect(await handleWorkflowSave(d, 1, {})).toEqual({ error: "workflows:save is not allowed from this sender" });
    expect(await handleWorkflowDelete(d, 1, "a")).toEqual({ error: "workflows:delete is not allowed from this sender" });
    expect(d.store.list).not.toHaveBeenCalled();
    expect(d.store.save).not.toHaveBeenCalled();
    expect(d.store.remove).not.toHaveBeenCalled();
    }
  });

  it("turns a throwing store into an error value", async () => {
    const d = deps("panel");
    d.store.list.mockRejectedValue(new Error("boom"));
    d.store.save.mockRejectedValue(new Error("boom"));
    d.store.remove.mockRejectedValue("boom");
    expect(await handleWorkflowList(d, 1)).toEqual({ error: "boom" });
    expect(await handleWorkflowSave(d, 1, {})).toEqual({ error: "boom" });
    expect(await handleWorkflowDelete(d, 1, "a")).toEqual({ error: "boom" });
  });
});
