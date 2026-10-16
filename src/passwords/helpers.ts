// Pure helpers of the Passwords window. A plain global script (no import or
// export), loaded before renderer.js — the same shape as
// src/tabbar/urlNormalization.ts. The guarded assignment at the bottom is only
// there so vitest (Node/CommonJS) can `require` it; in the browser
// `typeof module` is "undefined" and that branch never runs.
// Everything hangs off one global, `penPasswordsHelpers`, so no helper name
// can collide with another script's globals.
var penPasswordsHelpers = (function () {
  interface HelperEntry {
    origin: string;
    username: string;
    label: string;
  }

  /** `https://example.com` -> `example.com`; `http://localhost:3000` -> `localhost:3000`. */
  function displayHost(origin: string): string {
    return origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  }

  /** Case-insensitive match on host, username and label. An empty query matches everything. */
  function matchesQuery(entry: HelperEntry, query: string): boolean {
    var q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      displayHost(entry.origin).toLowerCase().indexOf(q) !== -1 ||
      entry.username.toLowerCase().indexOf(q) !== -1 ||
      entry.label.toLowerCase().indexOf(q) !== -1
    );
  }

  var ICON_DATA_URL = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

  /**
   * True for a base64 data: URL of an allowed image type. The single pattern
   * for both ends: main's favicon cache (browser/faviconCache.ts) checks every
   * icon it stores or reads with it, and the renderer checks again before
   * putting one into an <img>.
   */
  function isIconDataUrl(value: unknown): value is string {
    return typeof value === "string" && ICON_DATA_URL.test(value);
  }

  /** `Never` when absent, a relative phrase for the last week, else a date. */
  function formatLastUsed(ts: number | undefined, now: number): string {
    if (ts === undefined) return "Never";
    var diff = now - ts;
    if (diff < 60000) return "Just now";
    var minutes = Math.floor(diff / 60000);
    if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return days + " days ago";
    return new Date(ts).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  return { displayHost: displayHost, matchesQuery: matchesQuery, formatLastUsed: formatLastUsed, isIconDataUrl: isIconDataUrl };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = penPasswordsHelpers;
}
