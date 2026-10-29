import { isValidCanvasId, isValidDocId } from "./config";

/** What `empty:open` needs from the window. A port, so the rule is unit-tested without Electron. */
export interface EmptyOpenDeps {
  /** True only for this window's empty-state view webContents. */
  isEmptyView(webContentsId: number): boolean;
  findCanvasTab(canvasId: string): number | null;
  findDocTab(docId: string): number | null;
  activate(tabId: number, opts: { focus: boolean }): void;
  newCanvasTab(canvasId: string, opts: { focus: boolean }): number;
  newDocTab(docId: string, opts: { focus: boolean }): number;
}

export type RecentTarget = { ok: true; kind: "canvas" | "doc"; id: string } | { ok: false; error: string };

/** One `{kind, id}` entry of a Recent-list payload, validated. The error strings are part of the IPC contract. */
export function parseRecentTarget(entry: unknown): RecentTarget {
  const p = typeof entry === "object" && entry !== null ? (entry as { kind?: unknown; id?: unknown }) : {};
  const { kind, id } = p;
  if (kind !== "canvas" && kind !== "doc") return { ok: false, error: "invalid kind" };
  if (kind === "canvas" ? !isValidCanvasId(id) : !isValidDocId(id)) return { ok: false, error: "invalid id" };
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
    const existing = kind === "canvas" ? deps.findCanvasTab(id) : deps.findDocTab(id);
    if (existing !== null) deps.activate(existing, { focus: true });
    else if (kind === "canvas") deps.newCanvasTab(id, { focus: true });
    else deps.newDocTab(id, { focus: true });
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
