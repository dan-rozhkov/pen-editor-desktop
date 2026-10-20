import type { TraceReadResult, TraceSaveResult, TraceStore } from "./traceStore";

/** Sender rules of `traces:save` and `traces:read`, kept out of window.ts so they are unit-tested. */
export interface TraceIpcDeps {
  store: Pick<TraceStore, "save" | "read">; // async: all trace I/O is off the main thread's sync path
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** True for this window's canvas (editor) tabs. */
  isEditorTab(webContentsId: number): boolean;
  /** True for this window's trace tabs. */
  isTraceTab(webContentsId: number): boolean;
}

/** `traces:save` (invoke): the agent panel or an editor tab, which run the browse agent. */
export async function handleTraceSave(deps: TraceIpcDeps, sender: number, payload: unknown): Promise<TraceSaveResult> {
  if (!deps.isPanel(sender) && !deps.isEditorTab(sender)) {
    return { error: "traces:save is only allowed from the agent panel or an editor tab" };
  }
  try {
    return await deps.store.save(payload);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** `traces:read` (invoke): a trace tab, the agent panel or an editor tab. */
export async function handleTraceRead(deps: TraceIpcDeps, sender: number, id: unknown): Promise<TraceReadResult> {
  if (!deps.isPanel(sender) && !deps.isEditorTab(sender) && !deps.isTraceTab(sender)) {
    return { error: "traces:read is not allowed from this sender" };
  }
  try {
    return await deps.store.read(id);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
