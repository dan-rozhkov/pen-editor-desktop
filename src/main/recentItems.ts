import type { CanvasListResult } from "./canvasStore";
import type { DocListResult } from "./docStore";
import type { WorkflowListResult } from "./workflowStore";

export type RecentKind = "canvas" | "doc" | "workflow";

/** One row of the empty start's "Recent" list. */
export interface RecentItem {
  kind: RecentKind;
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * Merges the document, canvas and workflow lists, newest first. A store that answered with an error (or threw
 * before this was called) contributes nothing and does not hide the other store's items.
 */
export function mergeRecentItems(docs: DocListResult | null, canvases: CanvasListResult | null, workflows: WorkflowListResult | null): RecentItem[] {
  const items: RecentItem[] = [];
  if (docs && "docs" in docs) {
    for (const d of docs.docs) items.push({ kind: "doc", id: d.id, title: d.title.trim(), updatedAt: d.updatedAt });
  }
  if (canvases && "canvases" in canvases) {
    for (const c of canvases.canvases) items.push({ kind: "canvas", id: c.id, title: c.title.trim(), updatedAt: c.updatedAt });
  }
  if (workflows && "workflows" in workflows) {
    for (const w of workflows.workflows) items.push({ kind: "workflow", id: w.id, title: w.title.trim(), updatedAt: w.updatedAt });
  }
  // Stable for equal times: docs, canvases, workflows, then store order.
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/** Loads all three stores (a rejected one counts as an error) and merges them. Never throws. */
export async function loadRecentItems(
  docs: { list(): Promise<DocListResult> },
  canvases: { list(): Promise<CanvasListResult> },
  workflows: { list(): Promise<WorkflowListResult> },
): Promise<RecentItem[]> {
  const [d, c, w] = await Promise.allSettled([docs.list(), canvases.list(), workflows.list()]);
  return mergeRecentItems(
    d.status === "fulfilled" ? d.value : null,
    c.status === "fulfilled" ? c.value : null,
    w.status === "fulfilled" ? w.value : null,
  );
}

/**
 * True when a `docs:` / `canvases:` / `workflows:` `save|delete` result changed what is stored, i.e. the
 * Recent list may be out of date. A refused call, an error and a stale save change nothing.
 */
export function changedRecentItems(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as { ok?: unknown; stale?: unknown; error?: unknown };
  return r.ok === true && r.stale !== true && r.error === undefined;
}
