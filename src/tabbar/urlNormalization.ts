// Pure normalization of the address row's typed input into a navigable URL
// (design doc `2026-09-18-builtin-browser-design.md` §2/§5, finding 5).
//
// This is its own file, loaded as a second plain global `<script src>`
// before renderer.js in tabbar.html — same global-scope, no-module-system
// world as renderer.ts itself (CLAUDE.md: "no exports/require in the
// output — it runs in a CSP'd <script src>"). It contains no top-level
// `import`/`export`, so tsc emits it as a plain script, not an ES module,
// and it behaves in the browser exactly like a second <script> tag sharing
// renderer.ts's global scope always has. The guarded assignment at the
// bottom exists purely so vitest (running under Node/CommonJS) can import
// `normalizeTypedUrl` directly for unit tests; `typeof module` evaluates to
// "undefined" (not a ReferenceError) in the browser, so that branch is dead
// there and never touches anything module-shaped.
//
// Original bug: routing to a Pinterest search only triggered when the input
// had neither a "." nor a ":" — so an ordinary query like
// "figma.com alternatives" or "app design: dark mode" fell through to
// `https://` + the raw (space-containing) string, which `new URL()` then
// rejects, silently denying the navigation. Fixed by keying off whitespace
// first (a query never looks like a bare hostname) and otherwise validating
// via `new URL()` itself rather than ad hoc "." / ":" checks.
function normalizeTypedUrl(input: string): string {
  var trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (/\s/.test(trimmed)) return pinterestSearchUrl(trimmed);

  var hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  var candidate = hasScheme ? trimmed : "https://" + trimmed;
  try {
    var url = new URL(candidate);
    if (!hasScheme && url.hostname.indexOf(".") === -1) return pinterestSearchUrl(trimmed);
    return candidate;
  } catch {
    return pinterestSearchUrl(trimmed);
  }
}

function pinterestSearchUrl(query: string): string {
  return "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent(query);
}

/** True for exactly the URLs the built-in browser tab is allowed to
 * navigate to (mirrors main's `decideBrowserNavigation` in navigation.ts —
 * duplicated here rather than imported, for the same plain-script reason
 * `normalizeTypedUrl` above can't import anything either). Used by
 * renderer.ts to flag a submission as invalid instead of sending it and
 * silently doing nothing (finding 5's "denial visibility" half). */
function isNavigableUrl(value: string): boolean {
  try {
    var protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.normalizeTypedUrl = normalizeTypedUrl;
  module.exports.isNavigableUrl = isNavigableUrl;
}
