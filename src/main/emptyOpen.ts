import { isValidCanvasId, isValidDocId, isValidWorkflowId } from "./config";
import { RECENT_MODIFIED_RANGES, type RecentModified } from "./menu";

/** What `empty:open` needs from the window. A port, so the rule is unit-tested without Electron. */
export interface EmptyOpenDeps {
  /** True only for this window's empty-state view webContents. */
  isEmptyView(webContentsId: number): boolean;
  findCanvasTab(canvasId: string): number | null;
  findDocTab(docId: string): number | null;
  findWorkflowTab(workflowId: string): number | null;
  activate(tabId: number, opts: { focus: boolean }): void;
  newCanvasTab(canvasId: string, opts: { focus: boolean }): number;
  newDocTab(docId: string, opts: { focus: boolean }): number;
  newWorkflowTab(workflowId: string, opts: { focus: boolean }): number;
}

export type RecentTarget = { ok: true; kind: "canvas" | "doc" | "workflow"; id: string } | { ok: false; error: string };

/** One `{kind, id}` entry of a Recent-list payload, validated. The error strings are part of the IPC contract. */
export function parseRecentTarget(entry: unknown): RecentTarget {
  const p = typeof entry === "object" && entry !== null ? (entry as { kind?: unknown; id?: unknown }) : {};
  const { kind, id } = p;
  if (kind !== "canvas" && kind !== "doc" && kind !== "workflow") return { ok: false, error: "invalid kind" };
  if (!(kind === "canvas" ? isValidCanvasId(id) : kind === "doc" ? isValidDocId(id) : isValidWorkflowId(id))) return { ok: false, error: "invalid id" };
  return { ok: true, kind, id: id as string };
}

export type EmptyOpenResult = { ok: true } | { ok: false; error: string };

/**
 * `empty:open` (send, from the empty view only): a click on a Recent row. An open tab for the id is
 * activated, otherwise a new tab opens. It is a user action, so the tab takes keyboard focus.
 * Never throws.
 */
export function openRecentItem(deps: EmptyOpenDeps, sender: number, payload: unknown): EmptyOpenResult {
  if (!deps.isEmptyView(sender)) return { ok: false, error: "empty:open is only allowed from the empty view" };
  const target = parseRecentTarget(payload);
  if (!target.ok) return target;
  const { kind, id } = target;
  try {
    const existing = kind === "canvas" ? deps.findCanvasTab(id) : kind === "doc" ? deps.findDocTab(id) : deps.findWorkflowTab(id);
    if (existing !== null) deps.activate(existing, { focus: true });
    else if (kind === "canvas") deps.newCanvasTab(id, { focus: true });
    else if (kind === "doc") deps.newDocTab(id, { focus: true });
    else deps.newWorkflowTab(id, { focus: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type RecentMenuTarget = RecentTarget;

/**
 * `empty:recent-menu` (send, from the empty view only): a right-click on a Recent row. Checks the sender
 * and validates kind and id; the caller pops the native menu for the returned target. Never throws.
 */
export function parseRecentMenuRequest(deps: Pick<EmptyOpenDeps, "isEmptyView">, sender: number, payload: unknown): RecentMenuTarget {
  if (!deps.isEmptyView(sender)) return { ok: false, error: "empty:recent-menu is only allowed from the empty view" };
  return parseRecentTarget(payload);
}

export type RecentFilterMenuRequest =
  | { ok: true; x: number; y: number; kinds: { canvas: boolean; doc: boolean; workflow: boolean }; modified: RecentModified }
  | { ok: false; error: string };

/**
 * `empty:filter-menu` (invoke, from the empty view only): the filter button asks for its native menu.
 * `x`/`y` are the button's bottom-left in empty-view CSS px; `kinds` and `modified` are the page's current
 * filter, so the menu shows the right checks. The caller adds the view's bounds and pops the menu. Never throws.
 */
export function parseRecentFilterMenuRequest(deps: Pick<EmptyOpenDeps, "isEmptyView">, sender: number, payload: unknown): RecentFilterMenuRequest {
  if (!deps.isEmptyView(sender)) return { ok: false, error: "empty:filter-menu is only allowed from the empty view" };
  const p = typeof payload === "object" && payload !== null ? (payload as { x?: unknown; y?: unknown; kinds?: unknown; modified?: unknown }) : {};
  const { x, y, modified } = p;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return { ok: false, error: "invalid position" };
  const k = typeof p.kinds === "object" && p.kinds !== null ? (p.kinds as { canvas?: unknown; doc?: unknown; workflow?: unknown }) : {};
  if (typeof k.canvas !== "boolean" || typeof k.doc !== "boolean" || typeof k.workflow !== "boolean") return { ok: false, error: "invalid kinds" };
  if (!RECENT_MODIFIED_RANGES.some((r) => r === modified)) return { ok: false, error: "invalid modified" };
  return { ok: true, x, y, kinds: { canvas: k.canvas, doc: k.doc, workflow: k.workflow }, modified: modified as RecentModified };
}

/** What `empty:recent` needs from the window. */
export interface EmptyRecentDeps<T> {
  isEmptyView(webContentsId: number): boolean;
  load(): Promise<T[]>;
}

/** `empty:recent` (invoke): the list for the empty view only; any other sender gets an empty list. Never throws. */
export async function recentFor<T>(deps: EmptyRecentDeps<T>, sender: number): Promise<{ items: T[] }> {
  if (!deps.isEmptyView(sender)) return { items: [] };
  try {
    return { items: await deps.load() };
  } catch (err) {
    console.error(`empty:recent failed: ${err instanceof Error ? err.message : String(err)}`);
    return { items: [] };
  }
}

/** Tells every (live) empty view that the Recent list may have changed (`empty:recent-changed`, no payload). Never throws. */
export function notifyRecentChanged(views: Iterable<{ isDestroyed(): boolean; send(channel: string): void }>): void {
  for (const wc of views) {
    try {
      if (!wc.isDestroyed()) wc.send("empty:recent-changed");
    } catch {
      // a view that is going away is not worth a failure
    }
  }
}
