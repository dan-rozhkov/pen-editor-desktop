import { describe, expect, it, vi } from "vitest";
import { openWorkflowTab, type WorkflowOpenDeps } from "../src/main/workflowOpen";

function deps(over: Partial<WorkflowOpenDeps> = {}): WorkflowOpenDeps {
  return {
    isPanel: (id) => id === 1,
    findWorkflowTab: vi.fn(() => null),
    activate: vi.fn(),
    newWorkflowTab: vi.fn(() => 5),
    ...over,
  };
}

describe("workflow:open", () => {
  it("opens a new workflow tab without taking focus", () => {
    const d = deps();
    expect(openWorkflowTab(d, 1, "wf_0123456789ab")).toEqual({ ok: true });
    expect(d.newWorkflowTab).toHaveBeenCalledWith("wf_0123456789ab", { focus: false });
    expect(d.activate).not.toHaveBeenCalled();
  });

  it("activates the existing tab without taking focus", () => {
    const d = deps({ findWorkflowTab: vi.fn(() => 7) });
    expect(openWorkflowTab(d, 1, "wf_0123456789ab")).toEqual({ ok: true });
    expect(d.activate).toHaveBeenCalledWith(7, { focus: false });
    expect(d.newWorkflowTab).not.toHaveBeenCalled();
  });

  it("rejects any sender but the agent panel", () => {
    const d = deps();
    for (const sender of [2, 3, 99]) {
      expect(openWorkflowTab(d, sender, "wf_0123456789ab")).toEqual({ ok: false, error: "workflow:open is only allowed from the agent panel" });
    }
    expect(d.newWorkflowTab).not.toHaveBeenCalled();
    expect(d.activate).not.toHaveBeenCalled();
  });

  it("rejects an invalid id", () => {
    const d = deps();
    for (const bad of ["", "abc", "wf_", "wf_a/b", "wf_a&id=b", "wf_" + "a".repeat(65), 5, null, undefined]) {
      expect(openWorkflowTab(d, 1, bad)).toEqual({ ok: false, error: "invalid workflow id" });
    }
    expect(d.newWorkflowTab).not.toHaveBeenCalled();
  });

  it("returns {ok:false} instead of throwing", () => {
    const d = deps({ newWorkflowTab: () => { throw new Error("boom"); } });
    expect(openWorkflowTab(d, 1, "wf_0123456789ab")).toEqual({ ok: false, error: "boom" });
  });
});
