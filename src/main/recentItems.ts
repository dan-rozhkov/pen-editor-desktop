import type { CanvasListResult } from "./canvasStore";
import type { DocListResult } from "./docStore";

export type RecentKind = "canvas" | "doc";

/** One row of the empty start's "Recent" list. */
export interface RecentItem {
  kind: RecentKind;
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * Merges the document and canvas lists, newest first. A store that answered with an error (or threw
 * before this was called) contributes nothing and does not hide the other store's items.
 */
export function mergeRecentItems(docs: DocListResult | null, canvases: CanvasListResult | null): RecentItem[] {
  const items: RecentItem[] = [];
  if (docs && "docs" in docs) {
    for (const d of docs.docs) items.push({ kind: "doc", id: d.id, title: d.title.trim(), updatedAt: d.updatedAt });
  }
  if (canvases && "canvases" in canvases) {
    for (const c of canvases.canvases) items.push({ kind: "canvas", id: c.id, title: c.title.trim(), updatedAt: c.updatedAt });
  }
  // Stable for equal times: docs before canvases, then store order.
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/** Loads both stores (a rejected one counts as an error) and merges them. Never throws. */
export async function loadRecentItems(
  docs: { list(): Promise<DocListResult> },
  canvases: { list(): Promise<CanvasListResult> },
): Promise<RecentItem[]> {
  const [d, c] = await Promise.allSettled([docs.list(), canvases.list()]);
  return mergeRecentItems(d.status === "fulfilled" ? d.value : null, c.status === "fulfilled" ? c.value : null);
}

/**
 * True when a `docs:save|delete` / `canvases:save|delete` result changed what is stored, i.e. the
 * Recent list may be out of date. A refused call, an error and a stale save change nothing.
 */
export function changedRecentItems(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as { ok?: unknown; stale?: unknown; error?: unknown };
  return r.ok === true && r.stale !== true && r.error === undefined;
}
