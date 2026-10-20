import { isValidDocId } from "./config";

/** What `doc:open` needs from the window. Kept as a port so the rule is unit-tested without Electron. */
export interface DocOpenDeps {
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** True only for a trace tab that shows the trace viewer; editor, doc and browser tabs are not allowed. */
  isTraceTab(webContentsId: number): boolean;
  /** True when the sender is the active tab (a trace tab the user is looking at). */
  isActive(webContentsId: number): boolean;
  /** The id of the open doc tab showing this document, or null. */
  findDocTab(docId: string): number | null;
  activate(tabId: number, opts: { focus: boolean }): void;
  /** Opens (and shows, without keyboard focus) a doc tab at `/doc?id=<docId>&chat=off`; returns its tab id. */
  newDocTab(docId: string, opts: { focus: boolean }): number;
}

export type DocOpenResult = { ok: true } | { ok: false; error: string };

/**
 * `doc:open` (invoke, agent panel or a trace tab). An existing tab for the document is
 * activated; otherwise a new doc tab opens. Resolves once the tab exists: it
 * does not wait for the page to load. Never throws: the sender gets `{ok:false}`.
 */
export function openDocTab(deps: DocOpenDeps, sender: number, docId: unknown): DocOpenResult {
  const fromPanel = deps.isPanel(sender);
  if (!fromPanel && !deps.isTraceTab(sender)) {
    return { ok: false, error: "doc:open is only allowed from the agent panel or a trace tab" };
  }
  if (!isValidDocId(docId)) return { ok: false, error: "invalid document id" };
  try {
    const existing = deps.findDocTab(docId);
    // Panel (agent-initiated): show the document but leave keyboard focus in the panel composer.
    // Trace tab: a click in the active tab the user looks at takes focus; a call from a background trace tab does not.
    const focus = !fromPanel && deps.isActive(sender);
    if (existing !== null) deps.activate(existing, { focus });
    else deps.newDocTab(docId, { focus });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
