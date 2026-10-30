import type { WorkflowListResult, WorkflowRemoveResult, WorkflowSaveResult, WorkflowStore } from "./workflowStore";

/** Sender rules of `workflows:list`, `workflows:save` and `workflows:delete`, kept out of window.ts so they are unit-tested. */
export interface WorkflowIpcDeps {
  store: Pick<WorkflowStore, "list" | "save" | "remove">;
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** True for this window's workflow tabs. */
  isWorkflowTab(webContentsId: number): boolean;
}

const allowed = (deps: WorkflowIpcDeps, sender: number): boolean =>
  deps.isPanel(sender) || deps.isWorkflowTab(sender);

const errorOf = (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) });

/** `workflows:list` (invoke). Never throws. */
export async function handleWorkflowList(deps: WorkflowIpcDeps, sender: number): Promise<WorkflowListResult> {
  if (!allowed(deps, sender)) return { error: "workflows:list is not allowed from this sender" };
  try {
    return await deps.store.list();
  } catch (err) {
    return errorOf(err);
  }
}

/** `workflows:save` (invoke). Never throws. */
export async function handleWorkflowSave(deps: WorkflowIpcDeps, sender: number, workflow: unknown): Promise<WorkflowSaveResult> {
  if (!allowed(deps, sender)) return { error: "workflows:save is not allowed from this sender" };
  try {
    return await deps.store.save(workflow);
  } catch (err) {
    return errorOf(err);
  }
}

/** `workflows:delete` (invoke). Never throws. */
export async function handleWorkflowDelete(deps: WorkflowIpcDeps, sender: number, id: unknown): Promise<WorkflowRemoveResult> {
  if (!allowed(deps, sender)) return { error: "workflows:delete is not allowed from this sender" };
  try {
    return await deps.store.remove(id);
  } catch (err) {
    return errorOf(err);
  }
}
