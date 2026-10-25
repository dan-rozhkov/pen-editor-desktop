import type { SuggestItem } from "./browser/historySuggest";

/** The most suggestion rows the popover shows (the tab bar asks `history:suggest` for 8). */
export const MAX_OMNIBOX_ITEMS = 8;
const MAX_URL = 2048;
const MAX_TITLE = 1000;
const MAX_QUERY = 2048;

export interface OmniboxShowRequest {
  items: SuggestItem[];
  selected: number;
  query: string;
  rect: { x: number; y: number; width: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validates the tab bar's `tabbar:omnibox-show` payload; null = reject (the caller hides the popover). Items are rebuilt, never passed through. */
export function parseOmniboxShow(payload: unknown): OmniboxShowRequest | null {
  if (!isRecord(payload)) return null;
  const { items, selected, query, rect } = payload;
  if (!Array.isArray(items) || items.length > MAX_OMNIBOX_ITEMS) return null;
  if (typeof selected !== "number" || !Number.isInteger(selected) || selected < -1 || selected >= Math.max(items.length, 1)) return null;
  if (typeof query !== "string" || query.length > MAX_QUERY) return null;
  if (!isRecord(rect) || !finite(rect.x) || !finite(rect.y) || !finite(rect.width)) return null;
  const clean: SuggestItem[] = [];
  for (const it of items) {
    if (!isRecord(it)) return null;
    if (typeof it.url !== "string" || it.url.length > MAX_URL) return null;
    if (typeof it.title !== "string" || it.title.length > MAX_TITLE) return null;
    if (!finite(it.lastVisitedAt)) return null;
    clean.push({ url: it.url, title: it.title, lastVisitedAt: it.lastVisitedAt });
  }
  return { items: clean, selected, query, rect: { x: rect.x, y: rect.y, width: rect.width } };
}

/** The `url` of a `{url}` payload, or null. */
export function parseUrlPayload(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.url !== "string" || payload.url.length > MAX_URL) return null;
  return payload.url;
}

/** A pick is accepted only for a url the popover was last told to show. */
export function isShownUrl(items: readonly SuggestItem[], url: string): boolean {
  return items.some((i) => i.url === url);
}
