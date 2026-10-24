import type { CanvasListResult, CanvasReadResult, CanvasRemoveResult, CanvasSaveResult, CanvasStore } from "./canvasStore";

/** Sender rules of `canvases:list|read|save|delete`, kept out of window.ts so they are unit-tested. */
export interface CanvasIpcDeps {
  store: Pick<CanvasStore, "list" | "read" | "save" | "remove">;
  /** True for any agent panel webContents of the process. The panel may only list. */
  isPanel(webContentsId: number): boolean;
  /**
   * True for a canvas (editor) tab webContents of the process, including one that is closing or just
   * closed (canvasWriters.ts): its final save must still be accepted.
   */
  isCanvasWriter(webContentsId: number): boolean;
}

/** Panel: list only (its preload exposes nothing else). Editor tabs: everything. */
const allowedList = (deps: CanvasIpcDeps, sender: number): boolean => deps.isPanel(sender) || deps.isCanvasWriter(sender);
const allowed = (deps: CanvasIpcDeps, sender: number): boolean => deps.isCanvasWriter(sender);

const errorOf = (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) });

/** `canvases:list` (invoke). Never throws. */
export async function handleCanvasList(deps: CanvasIpcDeps, sender: number): Promise<CanvasListResult> {
  if (!allowedList(deps, sender)) return { error: "canvases:list is not allowed from this sender" };
  try {
    return await deps.store.list();
  } catch (err) {
    return errorOf(err);
  }
}

/** `canvases:read` (invoke). Never throws. */
export async function handleCanvasRead(deps: CanvasIpcDeps, sender: number, id: unknown): Promise<CanvasReadResult> {
  if (!allowed(deps, sender)) return { error: "canvases:read is not allowed from this sender" };
  try {
    return await deps.store.read(id);
  } catch (err) {
    return errorOf(err);
  }
}

/** `canvases:save` (invoke). Never throws. */
export async function handleCanvasSave(deps: CanvasIpcDeps, sender: number, canvas: unknown): Promise<CanvasSaveResult> {
  if (!allowed(deps, sender)) return { error: "canvases:save is not allowed from this sender" };
  try {
    return await deps.store.save(canvas);
  } catch (err) {
    return errorOf(err);
  }
}

/** `canvases:delete` (invoke). Never throws. */
export async function handleCanvasDelete(deps: CanvasIpcDeps, sender: number, id: unknown): Promise<CanvasRemoveResult> {
  if (!allowed(deps, sender)) return { error: "canvases:delete is not allowed from this sender" };
  try {
    return await deps.store.remove(id);
  } catch (err) {
    return errorOf(err);
  }
}
