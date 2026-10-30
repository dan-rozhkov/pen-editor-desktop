// Pure filter of the empty page's Recent list (search text, type, modified range). Its own plain script, loaded
// before emptyRenderer.js, like relativeTime.ts: no top-level import/export, so tsc emits a plain global script.
// The guarded assignment at the bottom only lets vitest (Node/CommonJS) import the function.
type RecentModifiedRange = "any" | "today" | "7d" | "30d";

interface RecentFilterState {
  /** Case-insensitive substring of the title (an empty title is shown, and matched, as "Untitled"). */
  query: string;
  kinds: { canvas: boolean; doc: boolean; workflow: boolean };
  modified: RecentModifiedRange;
}

/** `now` is epoch ms. "today" = since the viewer's local midnight; "7d" / "30d" = the last 7 / 30 x 24 h. Both kinds off = nothing. */
function filterRecentItems<T extends { kind: "canvas" | "doc" | "workflow"; title: string; updatedAt: number }>(
  items: T[],
  filter: RecentFilterState,
  now: number,
): T[] {
  var query = filter.query.trim().toLowerCase();
  var since = -Infinity;
  if (filter.modified === "today") {
    var d = new Date(now);
    since = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  } else if (filter.modified === "7d") since = now - 7 * 86400000;
  else if (filter.modified === "30d") since = now - 30 * 86400000;
  return items.filter(function (item) {
    if (!filter.kinds[item.kind]) return false;
    if (item.updatedAt < since) return false;
    return query === "" || (item.title || "Untitled").toLowerCase().indexOf(query) !== -1;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.filterRecentItems = filterRecentItems;
}
