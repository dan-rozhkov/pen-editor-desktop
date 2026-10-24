// Pure relative-time label of the empty page's Recent list ("just now", "5 min ago", "3 h ago",
// "yesterday", "12 Oct", "12 Oct 2025"). Its own plain script, loaded before emptyRenderer.js, like
// urlNormalization.ts: no top-level import/export, so tsc emits a plain global script. The guarded
// assignment at the bottom only lets vitest (Node/CommonJS) import the function.
var RELATIVE_TIME_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `then` and `now` are epoch ms. Calendar days are the viewer's local days. A future `then` (clock skew) reads as "just now". */
function formatRelativeTime(then: number, now: number): string {
  var diff = now - then;
  if (!isFinite(diff) || diff < 60 * 1000) return "just now";
  // Under 12 h the elapsed time wins over the calendar: 23:58 -> 00:01 is "3 min ago", not "yesterday".
  var minutes = Math.floor(diff / 60000);
  if (minutes < 60) return minutes + " min ago";
  var hours = Math.floor(minutes / 60);
  if (hours < 12) return hours + " h ago";
  var a = new Date(then);
  var b = new Date(now);
  var dayStart = function (d: Date): number {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  var days = Math.round((dayStart(b) - dayStart(a)) / 86400000);
  if (days <= 0) return hours + " h ago";
  if (days === 1) return "yesterday";
  var label = a.getDate() + " " + RELATIVE_TIME_MONTHS[a.getMonth()];
  return a.getFullYear() === b.getFullYear() ? label : label + " " + a.getFullYear();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.formatRelativeTime = formatRelativeTime;
}
