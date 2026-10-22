import type { TraceReadOptions, TraceReadResult, TraceSaveResult, TraceStore } from "./traceStore";

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

export interface TraceListDeps {
  isPanel(webContentsId: number): boolean;
  listTraceTabs(): { traceId: string; title: string; active: boolean }[];
}

/** `traces:list-tabs` (invoke): the agent panel only; open trace tabs in strip order. Never throws. */
export function handleTraceListTabs(
  deps: TraceListDeps,
  sender: number,
): { tabs: { traceId: string; title: string; active: boolean }[] } | { error: string } {
  if (!deps.isPanel(sender)) return { error: "traces:list-tabs is only allowed from the agent panel" };
  try {
    return { tabs: deps.listTraceTabs() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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

/** Only a plain object with a boolean `frames` counts; anything else means the default (frames loaded). */
export function parseTraceReadOptions(raw: unknown): TraceReadOptions | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const frames = (raw as { frames?: unknown }).frames;
  const rawIds = (raw as { frameIds?: unknown }).frameIds;
  const frameIds =
    Array.isArray(rawIds) && rawIds.length <= 10_000 && rawIds.every((n) => Number.isInteger(n))
      ? (rawIds as number[])
      : undefined;
  if (typeof frames !== "boolean") return undefined;
  return { frames, ...(frameIds ? { frameIds } : {}) };
}

/** `traces:read` (invoke): a trace tab, the agent panel or an editor tab. `opts` is optional (`{ frames: false }` or `{ frames: true, frameIds }`). */
export async function handleTraceRead(deps: TraceIpcDeps, sender: number, id: unknown, opts?: unknown): Promise<TraceReadResult> {
  if (!deps.isPanel(sender) && !deps.isEditorTab(sender) && !deps.isTraceTab(sender)) {
    return { error: "traces:read is not allowed from this sender" };
  }
  try {
    const parsed = parseTraceReadOptions(opts);
    return parsed ? await deps.store.read(id, parsed) : await deps.store.read(id);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
