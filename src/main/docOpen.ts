import { isValidDocId } from "./config";

/** What `doc:open` needs from the window. Kept as a port so the rule is unit-tested without Electron. */
export interface DocOpenDeps {
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** The id of the open doc tab showing this document, or null. */
  findDocTab(docId: string): number | null;
  activate(tabId: number, opts: { focus: boolean }): void;
  /** Opens (and shows, without keyboard focus) a doc tab at `/doc?id=<docId>&chat=off`; returns its tab id. */
  newDocTab(docId: string, opts: { focus: boolean }): number;
}

export type DocOpenResult = { ok: true } | { ok: false; error: string };

/**
 * `doc:open` (invoke, panel only). An existing tab for the document is
 * activated; otherwise a new doc tab opens. Resolves once the tab exists: it
 * does not wait for the page to load. Never throws: the panel gets `{ok:false}`.
 */
export function openDocTab(deps: DocOpenDeps, sender: number, docId: unknown): DocOpenResult {
  if (!deps.isPanel(sender)) return { ok: false, error: "doc:open is only allowed from the agent panel" };
  if (!isValidDocId(docId)) return { ok: false, error: "invalid document id" };
  try {
    const existing = deps.findDocTab(docId);
    // Agent-initiated: show the document but leave keyboard focus in the panel composer.
    if (existing !== null) deps.activate(existing, { focus: false });
    else deps.newDocTab(docId, { focus: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
