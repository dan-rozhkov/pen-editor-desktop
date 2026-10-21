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

  /**
   * Displayed hosts that two or more logins share (case-insensitive). The list
   * shows a username suffix only on those rows, so they stay distinguishable.
   */
  function duplicateHosts(origins: string[]): string[] {
    var counts = new Map<string, number>();
    var out: string[] = [];
    for (var i = 0; i < origins.length; i++) {
      var host = displayHost(origins[i]).toLowerCase();
      var n = (counts.get(host) || 0) + 1;
      counts.set(host, n);
      if (n === 2) out.push(host);
    }
    return out;
  }

  /**
   * The grey suffix shown after the site name, per entry id ("" = none). Only
   * rows whose displayed host is shared by another login get one: the username.
   * When two logins share host AND username (http vs https, or ports the
   * display drops), the username gets a second part: the label if it differs
   * from the other clashing rows', else the full origin.
   */
  function rowSuffixes(entries: (HelperEntry & { id: string })[]): Map<string, string> {
    var shared = new Set(duplicateHosts(entries.map(function (e) { return e.origin; })));
    var groups = new Map<string, (HelperEntry & { id: string })[]>();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var host = displayHost(e.origin).toLowerCase();
      if (!shared.has(host)) continue;
      var key = host + "\n" + e.username.toLowerCase();
      var g = groups.get(key);
      if (g) g.push(e); else groups.set(key, [e]);
    }
    var out = new Map<string, string>();
    groups.forEach(function (group) {
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];
        var parts: string[] = [];
        if (entry.username) parts.push(entry.username);
        if (group.length > 1) {
          var label = entry.label.trim();
          var labelUnique = label !== "" && group.every(function (o) { return o === entry || o.label.trim().toLowerCase() !== label.toLowerCase(); });
          parts.push(labelUnique ? label : entry.origin);
        }
        if (parts.length > 0) out.set(entry.id, parts.join(" · "));
      }
    });
    return out;
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

  return { displayHost: displayHost, duplicateHosts: duplicateHosts, rowSuffixes: rowSuffixes, matchesQuery: matchesQuery, formatLastUsed: formatLastUsed, isIconDataUrl: isIconDataUrl };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = penPasswordsHelpers;
}
