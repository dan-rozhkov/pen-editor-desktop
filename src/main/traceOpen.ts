import { isValidTraceId } from "./config";

/** What `traces:open` needs from the window. Kept as a port so the rule is unit-tested without Electron. */
export interface TraceOpenDeps {
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** The doc viewer check of this window (the same port `logins:*` and `docs:export-pdf` use). */
  isDocViewer(webContentsId: number, frameUrl: string | undefined): boolean;
  /** The id of the open trace tab showing this trace, or null. */
  findTraceTab(traceId: string): number | null;
  activate(tabId: number, opts: { focus: boolean }): void;
  /** Opens (and shows, with keyboard focus only when `focus`) a trace tab at `/trace/<id>?src=local&chat=off`; returns its tab id. */
  newTraceTab(traceId: string, opts: { focus: boolean }): number;
}

/** Who invoked `traces:open`: the sender id, whether the frame is the top frame, and that frame's own URL. */
export interface TraceOpenCaller {
  senderId: number;
  topFrame: boolean;
  frameUrl: string | undefined;
}

export type TraceOpenResult = { ok: true } | { ok: false; error: string };

/**
 * `traces:open` (invoke). Two senders:
 * - the agent panel: agent-initiated, so the tab is shown without taking keyboard focus;
 * - the TOP frame of a doc tab that still shows the doc page (same rule as `docs:export-pdf`): a click on a
 *   `/trace/<id>` link in a document, so the tab is shown WITH focus.
 * An open tab for the trace is activated; otherwise a new trace tab opens. Never throws.
 */
export function openTraceTab(deps: TraceOpenDeps, caller: TraceOpenCaller, traceId: unknown): TraceOpenResult {
  const fromPanel = deps.isPanel(caller.senderId);
  const fromDoc = !fromPanel && caller.topFrame && deps.isDocViewer(caller.senderId, caller.frameUrl);
  if (!fromPanel && !fromDoc) return { ok: false, error: "traces:open is only allowed from the agent panel or a document tab" };
  if (!isValidTraceId(traceId)) return { ok: false, error: "invalid trace id" };
  const focus = fromDoc;
  try {
    const existing = deps.findTraceTab(traceId);
    if (existing !== null) deps.activate(existing, { focus });
    else deps.newTraceTab(traceId, { focus });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
