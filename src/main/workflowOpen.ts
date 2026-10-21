import { isValidWorkflowId } from "./config";

/** What `workflow:open` needs from the window. Kept as a port so the rule is unit-tested without Electron. */
export interface WorkflowOpenDeps {
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** The id of the open workflow tab showing this workflow, or null. */
  findWorkflowTab(workflowId: string): number | null;
  activate(tabId: number, opts: { focus: boolean }): void;
  /** Opens (and shows, without keyboard focus) a workflow tab at `/workflow?id=<id>&chat=off`; returns its tab id. */
  newWorkflowTab(workflowId: string, opts: { focus: boolean }): number;
}

export type WorkflowOpenResult = { ok: true } | { ok: false; error: string };

/**
 * `workflow:open` (invoke, agent panel only). An existing tab for the workflow is activated;
 * otherwise a new workflow tab opens. Agent-initiated, so the tab never takes keyboard focus
 * from the panel. Never throws: the sender gets `{ok:false}`.
 */
export function openWorkflowTab(deps: WorkflowOpenDeps, sender: number, workflowId: unknown): WorkflowOpenResult {
  if (!deps.isPanel(sender)) return { ok: false, error: "workflow:open is only allowed from the agent panel" };
  if (!isValidWorkflowId(workflowId)) return { ok: false, error: "invalid workflow id" };
  try {
    const existing = deps.findWorkflowTab(workflowId);
    if (existing !== null) deps.activate(existing, { focus: false });
    else deps.newWorkflowTab(workflowId, { focus: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
