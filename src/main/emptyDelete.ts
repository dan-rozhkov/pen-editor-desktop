import { parseRecentTarget } from "./emptyOpen";

/** Upper bound of one bulk delete; a larger payload is refused whole. The stores handle far more; this only bounds a hostile payload. */
export const MAX_DELETE_ITEMS = 10_000;

/** Native confirm copy. Cancel is the default and the Esc answer: Enter must never delete. Same shape as `addLoginCopy` (loginsIpc.ts). */
export function deleteConfirmCopy(count: number) {
  return {
    type: "warning" as const,
    message: count === 1 ? "Delete 1 item?" : `Delete ${count} items?`,
    detail: "They will be removed from this computer. This can't be undone.",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
}

/** What `empty:delete` needs from the window. A port, so the rule is unit-tested without Electron. */
export interface EmptyDeleteDeps {
  /** True only for this window's empty-state view webContents. */
  isEmptyView(webContentsId: number): boolean;
  /** Native confirmation; resolves true when the user accepts. */
  confirm(count: number): Promise<boolean>;
  /** Removing a missing file is a success (the stores' contract). */
  removeCanvas(id: string): Promise<{ ok: true } | { error: string }>;
  removeDoc(id: string): Promise<{ ok: true } | { error: string }>;
  /** Tells the agent panel which documents are gone, so its localStorage mirror cannot re-upload them. */
  notifyDocsRemoved(ids: string[]): void;
}

export type EmptyDeleteResult =
  | { ok: false; error: string }
  | { ok: true; deleted: number; failed?: DeleteTarget[]; cancelled?: true };

export type DeleteTarget = { kind: "canvas" | "doc"; id: string };

/** Validates the payload: only valid kinds and ids, duplicates dropped. Anything malformed refuses the whole request. */
export function parseDeleteItems(payload: unknown): { ok: true; items: DeleteTarget[] } | { ok: false; error: string } {
  const list = typeof payload === "object" && payload !== null ? (payload as { items?: unknown }).items : undefined;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "no items" };
  if (list.length > MAX_DELETE_ITEMS) return { ok: false, error: `too many items (max ${MAX_DELETE_ITEMS})` };
  const seen = new Set<string>();
  const items: DeleteTarget[] = [];
  for (const entry of list) {
    const t = parseRecentTarget(entry);
    if (!t.ok) return t;
    const key = `${t.kind}:${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: t.kind, id: t.id });
  }
  return { ok: true, items };
}

/**
 * `empty:delete` (invoke, from the empty view only): confirm, then remove the chosen canvases and documents.
 * A cancelled confirm deletes nothing. Each removal is independent: failures are returned (`failed`), the rest still go.
 * Removed documents are announced once (`notifyDocsRemoved`). Never throws.
 */
export async function deleteRecentItems(deps: EmptyDeleteDeps, sender: number, payload: unknown): Promise<EmptyDeleteResult> {
  if (!deps.isEmptyView(sender)) return { ok: false, error: "empty:delete is only allowed from the empty view" };
  const parsed = parseDeleteItems(payload);
  if (!parsed.ok) return parsed;
  try {
    if (!(await deps.confirm(parsed.items.length))) return { ok: true, deleted: 0, cancelled: true };
    const settled = await Promise.all(
      parsed.items.map(async (item) => {
        try {
          const r = item.kind === "canvas" ? await deps.removeCanvas(item.id) : await deps.removeDoc(item.id);
          return "ok" in r;
        } catch {
          return false;
        }
      }),
    );
    const removedDocs = parsed.items.filter((item, i) => item.kind === "doc" && settled[i]).map((item) => item.id);
    if (removedDocs.length > 0) {
      try {
        deps.notifyDocsRemoved(removedDocs);
      } catch {
        // a panel that is going away is not worth a failure
      }
    }
    const failed = parsed.items.filter((_, i) => !settled[i]);
    const deleted = settled.length - failed.length;
    return failed.length > 0 ? { ok: true, deleted, failed } : { ok: true, deleted };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
