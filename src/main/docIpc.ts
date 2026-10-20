import type { DocListResult, DocRemoveResult, DocSaveResult, DocStore } from "./docStore";

/** Sender rules of `docs:list`, `docs:save` and `docs:delete`, kept out of window.ts so they are unit-tested. */
export interface DocIpcDeps {
  store: Pick<DocStore, "list" | "save" | "remove">;
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** True for this window's canvas (editor) tabs. */
  isEditorTab(webContentsId: number): boolean;
  /** True for this window's doc tabs. */
  isDocTab(webContentsId: number): boolean;
  /** True for this window's trace tabs. */
  isTraceTab(webContentsId: number): boolean;
}

const allowed = (deps: DocIpcDeps, sender: number): boolean =>
  deps.isPanel(sender) || deps.isEditorTab(sender) || deps.isDocTab(sender) || deps.isTraceTab(sender);

const errorOf = (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) });

/** `docs:list` (invoke). Never throws. */
export async function handleDocList(deps: DocIpcDeps, sender: number): Promise<DocListResult> {
  if (!allowed(deps, sender)) return { error: "docs:list is not allowed from this sender" };
  try {
    return await deps.store.list();
  } catch (err) {
    return errorOf(err);
  }
}

/** `docs:save` (invoke). Never throws. */
export async function handleDocSave(deps: DocIpcDeps, sender: number, doc: unknown): Promise<DocSaveResult> {
  if (!allowed(deps, sender)) return { error: "docs:save is not allowed from this sender" };
  try {
    return await deps.store.save(doc);
  } catch (err) {
    return errorOf(err);
  }
}

/** `docs:delete` (invoke). Never throws. */
export async function handleDocDelete(deps: DocIpcDeps, sender: number, id: unknown): Promise<DocRemoveResult> {
  if (!allowed(deps, sender)) return { error: "docs:delete is not allowed from this sender" };
  try {
    return await deps.store.remove(id);
  } catch (err) {
    return errorOf(err);
  }
}
