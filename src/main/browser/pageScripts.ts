// Scripts injected into a browser tab's real page via
// `WebContents#executeJavaScript` (see controller.ts). Each is a plain
// string constant — a self-invoking function expression that returns a
// JSON-serializable value — with a single ARGS_MARKER placeholder standing
// in for its arguments. controller.ts fills that placeholder in with
// `JSON.stringify(args)` (a JSON literal is always valid JS), never by
// concatenating raw values into the source: an untrusted string value (a
// click target, typed text, a URL) can never break out of the script by
// containing backticks, quotes, or `</script>`-like sequences, since it is
// never written into the template as anything other than the output of
// JSON.stringify.

/** The placeholder every script below embeds its JSON-stringified args at. */
export const ARGS_MARKER = "/*PEN_BROWSER_ARGS*/";

/**
 * Shared `findByText` body, interpolated into both CLICK_JS and TYPE_JS
 * (kept as one TypeScript-side string so the two copies can't drift, even
 * though each is inlined into its own independent IIFE at runtime — there
 * is no module system inside the injected page script).
 *
 * Fix for the "outermost wrapper wins" bug: `document.querySelectorAll("body
 * *")` walks in document order (ancestors before descendants), so a plain
 * first-match scan picks the outermost element whose *trimmed textContent*
 * happens to equal/contain the needle — typically a wrapper `<div>` around
 * the real interactive element, since wrapper text often equals its single
 * child's text. Clicking that div does nothing (click() on an element only
 * bubbles up through ancestors, never down into descendants), so the
 * command falsely reports success. Fixed by (1) searching genuinely
 * clickable elements first, falling back to any element only if none
 * matches, and (2) within each candidate set, preferring the innermost
 * match (the one that contains none of the other candidates) over any
 * ancestor that merely encloses it.
 */
const FIND_BY_TEXT_JS = `
  function findByText(needle) {
    var wanted = needle.trim().toLowerCase();
    if (!wanted) return null;
    var clickableSelector = "a, button, [role='button'], input, select, textarea, [onclick]";

    function textOf(el) {
      return (el.textContent || "").trim().toLowerCase();
    }

    function innermost(elements) {
      for (var i = 0; i < elements.length; i++) {
        var candidate = elements[i];
        var isAncestorOfAnother = false;
        for (var j = 0; j < elements.length; j++) {
          if (i !== j && candidate.contains(elements[j])) {
            isAncestorOfAnother = true;
            break;
          }
        }
        if (!isAncestorOfAnother) return candidate;
      }
      return null;
    }

    function search(selector, matchFn) {
      var all = document.querySelectorAll(selector);
      var matches = [];
      for (var i = 0; i < all.length; i++) {
        var text = textOf(all[i]);
        if (text && matchFn(text)) matches.push(all[i]);
      }
      return innermost(matches);
    }

    function exact(text) {
      return text === wanted;
    }
    function partial(text) {
      return text.indexOf(wanted) !== -1;
    }

    return (
      search(clickableSelector, exact) ||
      search(clickableSelector, partial) ||
      search("body *", exact) ||
      search("body *", partial)
    );
  }
`;

/**
 * Shared `scopedSignatureOf` body, interpolated into CLICK_JS, TYPE_JS,
 * PERFORM_JS and SIGNATURE_JS — a cheap signature of a *single element's own
 * subtree*, not the whole document.
 *
 * Review finding 4 (jev-loop design doc "Addendum 2, 2026-09-19" §1, further
 * scoped by the follow-up review): a whole-document signature (node count,
 * full innerText hash, largest visible `<img>`) is noisy on exactly the
 * pages this design exists for — a rotating carousel, a lazy-loading image,
 * a live price, an injected ad all move it between two captures
 * milliseconds apart, so a click that did nothing gets `changed: true`
 * anyway, handing the agent the same false confirmation "Addendum 2" was
 * written to stop. `scopedSignatureOf` is called on the *specific* element a
 * click/type/select acted on (CLICK_JS/TYPE_JS/PERFORM_JS stamp it with
 * `data-pen-sig-target` and compute this signature inline, before mutating
 * anything, so the "before" half is captured at the true start of the
 * action rather than via a second round trip); the "after" half is computed
 * by SIGNATURE_JS re-finding the same stamped element. Its own subtree node
 * count / text hash / src / value length / aria-expanded / aria-selected /
 * checked are the properties that actually move when *that* element reacts
 * — not whatever else happens to be moving elsewhere on the page.
 */
const SCOPED_SIGNATURE_JS = `
  function scopedSignatureOf(el) {
    var nodeCount = el.querySelectorAll("*").length + 1;
    var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return {
      nodeCount: nodeCount,
      textHash: hash,
      src: el.getAttribute("src") || "",
      // A length, not the content — the raw value never needs to leave the
      // page for a diff, and this element can be a form field (see the
      // credentials rule elsewhere in this file for why raw field content
      // is treated as sensitive by default).
      valueLength: "value" in el ? String(el.value || "").length : 0,
      ariaExpanded: el.getAttribute("aria-expanded") || "",
      ariaSelected: el.getAttribute("aria-selected") || "",
      checked: "checked" in el ? !!el.checked : false,
    };
  }
`;

/**
 * Collects every `<img>` and every element with a CSS `background-image`,
 * resolves URLs against the document, dedupes by resolved URL, filters by
 * minimum rendered size, sorts by rendered area descending, and caps the
 * result at `limit`. Deliberately does not try to rewrite thumbnail URLs to
 * higher resolutions (site-specific, rots) — it returns what the page
 * actually shows.
 *
 * BROWSE-01 (jev-loop design doc, "Addendum 2, 2026-09-19"): a live
 * Pinterest run showed this returning only the page's rendered `/236x/`
 * thumbnails, which the agent then took to guessing at higher-resolution
 * URLs itself (a confident 404 waiting to happen on any other host). Fixed
 * generically, not per-host: an `<img>`'s `srcset` is parsed and the
 * largest *declared* candidate (by `w` width descriptor, or by `x` density
 * descriptor as a proxy when only density descriptors are present) is
 * preferred over `currentSrc`/`src`, which the page may only be rendering
 * at a smaller size. `naturalWidth`/`naturalHeight` are reported alongside
 * the existing rendered `width`/`height` (which still means rendered size —
 * the e2e suite pins that) so a consumer can tell a small asset from a
 * small *rendering* of a large one. Still no per-host URL rewriting — that
 * is the part that rots.
 *
 * Review finding 1 (HIGH): the original `srcset.split(",")` broke on the
 * comma-bearing URLs real CDNs routinely serve (Cloudinary/imgix transforms
 * like `https://cdn/x/w_800,h_600/a.jpg 800w`) — the URL itself split into
 * two pieces, the descriptor-less fragment ("…w_800") was skipped, and the
 * remainder ("h_600/a.jpg 800w") won on score and got returned as a
 * relative URL fragment, silently 404ing every image `browse_find_images`
 * returned on such a host — worse than the bug this fix originally set out
 * to solve. Splitting on `,\\s+` (comma *followed by whitespace*, which is
 * how the srcset grammar actually separates candidates — a raw comma
 * embedded in a URL is essentially never followed by whitespace) fixes the
 * real-world case; `pickLargestSrcsetCandidate` additionally verifies the
 * winning candidate resolves as a URL at all before returning it, falling
 * back to `currentSrc || src` rather than ever handing back something that
 * isn't a URL.
 *
 * Review finding 5: `naturalWidth`/`naturalHeight` used to always come from
 * the `<img>` element's *loaded* resource, even once this fix started
 * preferring a *different*, larger URL from `srcset` that the browser may
 * never have fetched — reporting a real thumbnail's tiny naturalWidth next
 * to a much larger returned URL defeats the documented "tell a small asset
 * from a small rendering" use of these fields. Whenever the returned URL
 * came from a `w`-descriptor `srcset` candidate at all, the descriptor's own
 * declared width is reported instead of `img.naturalWidth`/`naturalHeight` —
 * *even when that candidate happens to be the one the browser actually
 * fetched*: per the HTML spec, a `w`-descriptor selection makes the browser
 * report a *density-corrected* `naturalWidth`/`naturalHeight` (the resource's
 * real pixel size divided by an implied pixel density computed from the
 * descriptor and the "sizes"-resolved target width, which defaults to the
 * viewport width) rather than the resource's true pixel dimensions — so
 * trusting `img.naturalWidth` even in the "matches what's loaded" case
 * quietly reports a viewport-width-dependent number instead of the image's
 * real size. Height is estimated from the loaded image's own aspect ratio
 * (density correction scales both dimensions by the same factor, so the
 * *ratio* stays meaningful even though the absolute numbers don't) or the
 * rendered box's, if even that isn't known. With no `srcset` involved at
 * all, `img.naturalWidth`/`naturalHeight` are reported as-is (no density
 * correction applies without `srcset`). With no declared width to fall back
 * on (an `x`-density-only srcset), natural size is omitted entirely rather
 * than reporting a number that describes the wrong image.
 */
export const FIND_IMAGES_JS = `(() => {
  var args = ${ARGS_MARKER};
  var minWidth = args.minWidth;
  var minHeight = args.minHeight;
  var limit = args.limit;

  function resolve(url) {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch (err) {
      return null;
    }
  }

  function extractBackgroundUrl(bg) {
    if (!bg || bg === "none") return null;
    var start = bg.indexOf("url(");
    if (start === -1) return null;
    var rest = bg.slice(start + 4);
    var end = rest.indexOf(")");
    if (end === -1) return null;
    var raw = rest.slice(0, end).trim();
    if (raw.length >= 2) {
      var first = raw[0];
      var last = raw[raw.length - 1];
      if ((first === '"' || first === "'") && first === last) raw = raw.slice(1, -1);
    }
    return raw;
  }

  // Picks the largest declared candidate out of an <img srcset> — by "w"
  // width descriptor when present, else by "x" density descriptor as a
  // relative-size proxy (a 1000x multiplier keeps it comparable against a
  // "w" descriptor without ever mattering in practice, since a page mixing
  // both descriptor kinds in one srcset is not something the spec allows).
  // Returns null (falls back to currentSrc||src) when there is no srcset,
  // nothing in it parses, or the winning candidate doesn't even resolve as
  // a URL (finding 1's defence-in-depth, on top of the split fix above).
  // Returns { url, declaredWidth } — declaredWidth is the "w" descriptor's
  // pixel value when the winner came from one, else null (finding 5).
  function pickLargestSrcsetCandidate(srcset) {
    if (!srcset) return null;
    // Finding 1: split on a comma *followed by whitespace* — that's how the
    // srcset grammar actually separates candidates, and it's what a raw
    // comma embedded in a URL (a CDN transform parameter, say) essentially
    // never looks like. A plain split(",") tore exactly such a URL in two.
    var entries = srcset.split(/,\\s+/);
    var best = null;
    var bestScore = -1;
    var bestDeclaredWidth = null;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i].trim();
      if (!entry) continue;
      var parts = entry.split(/\\s+/);
      var url = parts[0];
      var descriptor = parts[1] || "";
      var score = -1;
      var declaredWidth = null;
      if (descriptor.slice(-1) === "w") {
        var w = parseInt(descriptor.slice(0, -1), 10);
        if (!isNaN(w)) {
          score = w;
          declaredWidth = w;
        }
      } else if (descriptor.slice(-1) === "x") {
        var x = parseFloat(descriptor.slice(0, -1));
        if (!isNaN(x)) score = x * 1000;
      }
      if (url && score > bestScore) {
        bestScore = score;
        best = url;
        bestDeclaredWidth = declaredWidth;
      }
    }
    if (!best) return null;
    // Finding 1: validate the winner actually resolves as a URL before
    // handing it back — a malformed/mis-split fragment should fall back to
    // currentSrc||src rather than being returned as-is.
    try {
      new URL(best, document.baseURI);
    } catch (err) {
      return null;
    }
    return { url: best, declaredWidth: bestDeclaredWidth };
  }

  var seen = Object.create(null);
  var found = [];

  function consider(rawUrl, alt, width, height, naturalWidth, naturalHeight) {
    var url = resolve(rawUrl);
    if (!url) return;
    // Only http(s) — an inline data:/blob: URL (background images and
    // <img src> both allow them) can be arbitrarily large, has no size cap,
    // and this repo has already been bitten twice by base64 image payloads
    // flooding the model's chat history (see CLAUDE.md's memory notes).
    // Pinterest and friends serve real images over http(s); a page that
    // only offers inline data URIs is not a useful reference source anyway.
    if (url.indexOf("http:") !== 0 && url.indexOf("https:") !== 0) return;
    if (width < minWidth || height < minHeight) return;
    if (seen[url]) return;
    seen[url] = true;
    var entry = {
      url: url,
      alt: (alt || "").trim().slice(0, 200),
      width: width,
      height: height,
    };
    // Finding 5: omit rather than report a natural size known to describe
    // the wrong image.
    if (naturalWidth !== undefined && naturalWidth !== null) entry.naturalWidth = naturalWidth;
    if (naturalHeight !== undefined && naturalHeight !== null) entry.naturalHeight = naturalHeight;
    found.push(entry);
  }

  var imgs = document.images;
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    // Skip the cursor overlay (pageScripts.ts's CURSOR_JS) — it's not page
    // content, just pointer-events:none chrome this bridge draws itself.
    if (img.closest && img.closest("[data-pen-cursor]")) continue;
    var rect = img.getBoundingClientRect();
    var srcsetPick = pickLargestSrcsetCandidate(img.getAttribute("srcset"));
    var chosenUrl = (srcsetPick && srcsetPick.url) || img.currentSrc || img.src;
    var naturalWidth, naturalHeight;
    if (!srcsetPick || !srcsetPick.url) {
      // No srcset candidate was used at all — no "w"-descriptor density
      // correction applies, so img.naturalWidth/naturalHeight are the
      // resource's real pixel size and are trustworthy as-is.
      naturalWidth = img.naturalWidth || Math.round(rect.width);
      naturalHeight = img.naturalHeight || Math.round(rect.height);
    } else if (srcsetPick.declaredWidth) {
      // Finding 5: a "w"-descriptor srcset candidate was used — report its
      // own declared width rather than img.naturalWidth, which (per the
      // HTML spec) is density-corrected against the "sizes"-resolved target
      // width for a "w" descriptor and so does NOT reflect the resource's
      // real pixel size, even when this candidate is the one actually
      // loaded. Height isn't declared by a "w" descriptor, so it's
      // estimated from whatever aspect ratio is available — the loaded
      // image's own (density correction scales both dimensions equally, so
      // the ratio itself stays meaningful), or failing that the rendered
      // box's.
      var aspect =
        img.naturalWidth && img.naturalHeight
          ? img.naturalHeight / img.naturalWidth
          : rect.width
            ? rect.height / rect.width
            : 1;
      naturalWidth = srcsetPick.declaredWidth;
      naturalHeight = Math.round(srcsetPick.declaredWidth * aspect);
    } else {
      // Only an "x" density descriptor was available (no pixel width to
      // report) — natural size can't be known without fetching the
      // candidate ourselves, so it's omitted rather than guessed.
      naturalWidth = undefined;
      naturalHeight = undefined;
    }
    consider(chosenUrl, img.alt, Math.round(rect.width), Math.round(rect.height), naturalWidth, naturalHeight);
  }

  var all = document.querySelectorAll("*");
  for (var j = 0; j < all.length; j++) {
    var el = all[j];
    if (el.closest && el.closest("[data-pen-cursor]")) continue;
    var bg = getComputedStyle(el).backgroundImage;
    var bgUrl = extractBackgroundUrl(bg);
    if (!bgUrl) continue;
    var elRect = el.getBoundingClientRect();
    // A CSS background image has no "natural size" concept reachable
    // synchronously without decoding it ourselves — rendered size is the
    // best available proxy, same as before this addendum.
    consider(
      bgUrl,
      el.getAttribute("aria-label") || el.getAttribute("title") || "",
      Math.round(elRect.width),
      Math.round(elRect.height),
      Math.round(elRect.width),
      Math.round(elRect.height)
    );
  }

  found.sort(function (a, b) {
    return b.width * b.height - a.width * a.height;
  });
  var images = found.slice(0, limit);

  return { images: images, count: images.length, pageUrl: location.href };
})()`;

/**
 * Locates a target first as a CSS selector, then as visible text (see
 * FIND_BY_TEXT_JS above: clickable elements preferred over any element,
 * innermost match preferred over an enclosing wrapper, exact match
 * preferred over a substring match), scrolls it into view, and clicks it.
 *
 * Review finding 4: before mutating anything, the located element is
 * stamped `data-pen-sig-target` and its own scoped signature is captured
 * (see SCOPED_SIGNATURE_JS above) — returned as `__scopedBefore`, an
 * internal field controller.ts reads and strips before the result ever
 * reaches a caller.
 */
/**
 * Shared "is this control mid-flight?" predicate — a control that disables
 * itself while its own handler runs (a submit button during a slow request,
 * a filter that greys out while it refetches). Upstream jev-ultrafast's PR
 * #58 describes the failure it causes: the input lands, the handler starts,
 * and the next observation ~50ms later sees the acted control `:disabled`
 * (so SNAPSHOT_JS skips it) while the controls the handler will enable are
 * not actionable yet — the model is offered neither what it just used nor
 * what it is waiting for, and answers BLOCKED. WAIT cannot rescue it: one
 * WAIT is 400ms, so sitting out a 3s handler costs ~8 paid decision round
 * trips.
 *
 * `aria-busy` is checked on ancestors too (`closest`), because the common
 * React pattern marks the *form* or a wrapper busy rather than the button.
 * A native `disabled` is only checked on the element itself: a disabled
 * <fieldset> already disables its controls, which shows up as `el.disabled`.
 */
const TARGET_BUSY_HELPER_JS = `
  function penTargetIsBusy(el) {
    if (!el) return false;
    if (el.disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.getAttribute("aria-busy") === "true") return true;
    return !!(el.closest && el.closest('[aria-busy="true"]'));
  }
`;

/**
 * Re-reads the busy state of the element the last action stamped
 * `data-pen-sig-target` (CLICK_JS/TYPE_JS/PERFORM_JS all stamp it). Polled
 * by controller.ts's settleWhileTargetBusy *only* when the acting script
 * reported `__targetSelfDisabled: true`, i.e. the action itself is what
 * made the control busy. `present: false` (the element is gone — the page
 * re-rendered or navigated) ends the wait just like `busy: false` does.
 */
export const TARGET_BUSY_JS = `(() => {
  ${TARGET_BUSY_HELPER_JS}
  var el = document.querySelector("[data-pen-sig-target]");
  if (!el) return { present: false, busy: false };
  return { present: true, busy: penTargetIsBusy(el) };
})()`;

export const CLICK_JS = `(() => {
  var args = ${ARGS_MARKER};
  var target = args.target;

  function findBySelector(sel) {
    try {
      return document.querySelector(sel);
    } catch (err) {
      return null;
    }
  }

  ${FIND_BY_TEXT_JS}
  ${SCOPED_SIGNATURE_JS}
  ${TARGET_BUSY_HELPER_JS}

  // Text first, selector as fallback (not the reverse): a bare word like
  // "Search", "Map", "Details", "Select", "Menu", "Address" or "Video" is
  // also a syntactically valid CSS *type* selector — it matches the
  // <search>/<map>/<details>/<select>/<menu>/<address>/<video> element on
  // the page (if present) rather than the button labelled "Details" the
  // caller meant, and el.click() on that wrapper still returns { matched }
  // as if it worked. Trying the visible label first avoids needing a
  // selector-shaped heuristic, and a real CSS selector essentially never
  // equals some element's trimmed textContent, so the fallback still fires
  // for genuine selectors.
  var el = findByText(target) || findBySelector(target);
  if (!el) return { error: "No element matched: " + target };

  var staleTargets = document.querySelectorAll("[data-pen-sig-target]");
  for (var st = 0; st < staleTargets.length; st++) staleTargets[st].removeAttribute("data-pen-sig-target");
  el.setAttribute("data-pen-sig-target", "1");
  var scopedBefore = scopedSignatureOf(el);
  var busyBefore = penTargetIsBusy(el);

  el.scrollIntoView({ block: "center" });
  el.click();
  return {
    url: location.href,
    title: document.title,
    matched: target,
    __scopedBefore: scopedBefore,
    __targetSelfDisabled: !busyBefore && penTargetIsBusy(el),
  };
})()`;

/**
 * Locates a target the same way CLICK_JS does, then sets its value (input /
 * textarea) or text content (contenteditable), dispatching `input` and
 * `change` so framework-bound listeners see the change. Also stamps and
 * scoped-signatures the target element before mutating it — see CLICK_JS's
 * doc comment, finding 4.
 */
export const TYPE_JS = `(() => {
  var args = ${ARGS_MARKER};
  var target = args.target;
  var text = args.text;

  function findBySelector(sel) {
    try {
      return document.querySelector(sel);
    } catch (err) {
      return null;
    }
  }

  ${FIND_BY_TEXT_JS}
  ${SCOPED_SIGNATURE_JS}
  ${TARGET_BUSY_HELPER_JS}

  // Text first, selector as fallback — see CLICK_JS's comment for why.
  var el = findByText(target) || findBySelector(target);
  if (!el) return { error: "No element matched: " + target };

  var staleTargets = document.querySelectorAll("[data-pen-sig-target]");
  for (var st = 0; st < staleTargets.length; st++) staleTargets[st].removeAttribute("data-pen-sig-target");
  el.setAttribute("data-pen-sig-target", "1");
  var scopedBefore = scopedSignatureOf(el);
  var busyBefore = penTargetIsBusy(el);

  el.scrollIntoView({ block: "center" });
  el.focus();
  var tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") {
    var proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, text);
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else {
    return { error: "Element is not editable: " + target };
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    url: location.href,
    title: document.title,
    matched: target,
    __scopedBefore: scopedBefore,
    __targetSelfDisabled: !busyBefore && penTargetIsBusy(el),
  };
})()`;

/** Scrolls the page vertically by `amount` viewport heights (default 1). */
export const SCROLL_JS = `(() => {
  var args = ${ARGS_MARKER};
  var amount = args.amount;
  window.scrollBy(0, window.innerHeight * amount);
  return { url: location.href, title: document.title };
})()`;

/**
 * Walks the document once and returns an indexed table of visible,
 * interactive elements — a port of the concepts in jev-ultrafast's
 * `snapshot.js` (https://github.com/browser-use/jev-ultrafast, MIT license):
 * a cheap structured element table in place of a screenshot, so a fast
 * decision model (`POST /api/browse/step`, see the jev-loop design doc) can
 * pick an operation and target in one round trip instead of reasoning over
 * pixels.
 *
 * Each surviving element is stamped with a `data-pen-snap="<snapshotId>:
 * <index>"` attribute (`snapshotId` supplied by the controller via
 * ARGS_MARKER, see controller.ts's `snapshot()`). PERFORM_JS below looks
 * elements up by that exact attribute rather than by recomputing the
 * candidate list — if the page re-renders (React replaces the node) or
 * navigates between snapshot and perform, the marked node is simply gone
 * and the lookup fails closed, instead of `perform` silently landing on
 * whatever now happens to occupy the same array position.
 */
export const SNAPSHOT_JS = `(() => {
  var args = ${ARGS_MARKER};
  var snapshotId = args.snapshotId;
  var maxElements = args.maxElements;

  var INTERACTIVE_SELECTOR =
    "a[href], button, input, select, textarea, [role='button'], [role='link'], " +
    "[role='checkbox'], [role='radio'], [role='tab'], [role='menuitem'], " +
    "[role='combobox'], [onclick], [contenteditable='true']";

  function isVisible(el) {
    // The cursor overlay (pageScripts.ts's CURSOR_JS) is pointer-events:none
    // and never a real interactive control — skip anything inside it so it
    // can never show up as a snapshot element to act on.
    if (el.closest && el.closest("[data-pen-cursor]")) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    // Viewport-ish region with a generous margin — infinite-scroll grids
    // just outside the fold still matter to a browsing task.
    var margin = Math.max(window.innerHeight, 600);
    if (rect.bottom < -margin || rect.top > window.innerHeight + margin) return false;
    return true;
  }

  function tagOf(el) {
    return (el.tagName || "").toLowerCase();
  }

  // Review finding 7: a machine-generated id (React useId's ":r3:", Ember's
  // "ember123", Amazon's "a-autoid-1-announce") makes a worse label than the
  // honest positional fallback — it reads as plausible to a decision model,
  // which both defeats MIN_STEP_CONFIDENCE's ability to refuse a bad guess
  // and actively invites a wrong one. A real, hand-authored id ("inp-search",
  // "btn-checkout") is still a legitimate label source and is left alone;
  // only ids that *look* generated are skipped, falling through to whatever
  // label source comes next (and ultimately to the positional fallback).
  function looksGenerated(id) {
    var trimmed = (id || "").trim();
    if (!trimmed) return true;
    if (/^\\d+$/.test(trimmed)) return true; // digits-only, e.g. "123"
    if (/^:.*:$/.test(trimmed)) return true; // React useId, e.g. ":r3:"
    if (/^(react-select|radix-|headlessui-|mui-|chakra-|css-)/i.test(trimmed)) return true; // known framework prefixes
    if (/\\d{2,}$/.test(trimmed)) return true; // digit-suffixed, e.g. "ember123"
    if (/-\\d+(-|$)/.test(trimmed)) return true; // hyphen-digit segment, e.g. "a-autoid-1-announce"
    return false;
  }

  // BROWSE-02 (jev-loop design doc, "Addendum 2, 2026-09-19"): a live
  // Amazon run degraded to a run of unlabelled "div #6"/"input #7" entries
  // whenever the real accessible name lived one level away from the
  // element itself — a descendant icon ("<div role=button><svg
  // aria-label=Save>"), an aria-labelledby reference, or an enclosing
  // <a>/<button> wrapping a plain element. Every step below is tried, in
  // order, before the positional "tag #index" fallback in the caller —
  // which stays last on purpose: dropping an unlabelled element entirely is
  // worse, since cookie banners are made of exactly these.
  function accessibleNameOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var text = (el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text) return text;
    var title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  }

  function labelOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var ids = labelledBy.split(/\\s+/);
      var combined = [];
      for (var i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        var ref = document.getElementById(ids[i]);
        if (!ref) continue;
        var refText = (ref.textContent || "").trim().replace(/\\s+/g, " ");
        if (refText) combined.push(refText);
      }
      var joined = combined.join(" ").trim();
      if (joined) return joined;
    }

    var text = (el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text) return text;

    var placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();

    var alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();

    var title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    // Review finding 6: a descendant's aria-label/title/alt — the common
    // icon-button shape, e.g. <div role="button"><img alt=""><svg
    // aria-label="Save"></svg></div>. The *first* element matching
    // [aria-label],[title],[alt] is not necessarily the labelled one (an
    // empty-alt <img> placed before the real svg[aria-label] used to make
    // this whole step yield nothing) — every match is tried, in document
    // order, until one actually has a non-empty value.
    var descendants = el.querySelectorAll("[aria-label], [title], [alt]");
    for (var di = 0; di < descendants.length; di++) {
      var d = descendants[di];
      var dAria = d.getAttribute("aria-label");
      if (dAria && dAria.trim()) return dAria.trim();
      var dTitle = d.getAttribute("title");
      if (dTitle && dTitle.trim()) return dTitle.trim();
      var dAlt = d.getAttribute("alt");
      if (dAlt && dAlt.trim()) return dAlt.trim();
    }

    // The accessible name of the nearest enclosing <a>/<button> — for an
    // element that is itself unlabelled but sits inside a labelled control
    // (a plain <input> wrapped by an <a aria-label="…">, say). Guarded
    // against matching el itself, which every earlier step already
    // covered.
    var enclosing = el.closest("a, button");
    if (enclosing && enclosing !== el) {
      var enclosingName = accessibleNameOf(enclosing);
      if (enclosingName) return enclosingName;
    }

    var name = el.getAttribute("name");
    if (name && name.trim()) return name.trim();

    var id = el.id;
    if (id && id.trim() && !looksGenerated(id)) return id.trim();

    return "";
  }

  function opsFor(el, tag) {
    if (tag === "select") return ["SELECT"];
    if (tag === "textarea") return ["TYPE_TEXT"];
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (
        type === "checkbox" ||
        type === "radio" ||
        type === "submit" ||
        type === "button" ||
        type === "reset" ||
        type === "file" ||
        type === "image"
      ) {
        return ["CLICK"];
      }
      return ["TYPE_TEXT"];
    }
    if (el.isContentEditable) return ["TYPE_TEXT"];
    return ["CLICK"];
  }

  var candidates = document.querySelectorAll(INTERACTIVE_SELECTOR);
  var found = [];
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    if (!isVisible(el)) continue;
    var tag = tagOf(el);
    var isPassword = tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "password";
    var ops = opsFor(el, tag);
    var rect = el.getBoundingClientRect();
    var distance = Math.abs((rect.top + rect.bottom) / 2 - window.innerHeight / 2);
    var entry = {
      el: el,
      tag: tag,
      role: el.getAttribute("role") || undefined,
      label: labelOf(el),
      ops: ops,
      isPassword: isPassword,
      distance: distance,
    };
    if (tag === "select") {
      // Addendum D: options capped at 100 entries, each truncated, in the
      // page script itself — the payload must be valid by construction, not
      // rely on the backend to reject an oversized country dropdown.
      var options = [];
      for (var o = 0; o < el.options.length && options.length < 100; o++) {
        options.push(String(el.options[o].text || "").slice(0, 120));
      }
      entry.options = options;
      var selectedOpt = el.options[el.selectedIndex];
      entry.hasValue = !!(selectedOpt && selectedOpt.text);
    } else if (tag === "input" || tag === "textarea") {
      // Addendum D: only a non-password input[type=text], input[type=search]
      // or textarea reports its live "value" — and only when "autocomplete"
      // isn't one of the sensitive tokens (cc-*, one-time-code,
      // current-password, new-password). The old rule guarded only
      // type=password, so an autofilled card number in a type=text field,
      // an email, or a phone number left the page in the element table.
      // Every other input/textarea instead reports "hasValue" — whether the
      // model needs to know a field is already filled, never its content.
      var inputType = tag === "textarea" ? "textarea" : (el.getAttribute("type") || "text").toLowerCase();
      var autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase().trim();
      var sensitiveAutocomplete =
        autocomplete.indexOf("cc-") === 0 ||
        autocomplete === "one-time-code" ||
        autocomplete === "current-password" ||
        autocomplete === "new-password";
      var valueEligible =
        !isPassword && (inputType === "text" || inputType === "search" || inputType === "textarea") && !sensitiveAutocomplete;
      var rawValue = el.value || "";
      if (valueEligible) {
        entry.value = String(rawValue).slice(0, 100);
      } else {
        entry.hasValue = rawValue.length > 0;
      }
    }
    found.push(entry);
  }

  // Nearest-to-viewport first, then capped — the element table is the whole
  // request payload for /api/browse/step, so an uncapped one on a big page
  // is both slow and expensive.
  found.sort(function (a, b) {
    return a.distance - b.distance;
  });
  var capped = found.slice(0, maxElements);

  var elements = [];
  for (var idx = 0; idx < capped.length; idx++) {
    var item = capped[idx];
    // Unlabelled icon buttons are exactly what cookie banners are made of —
    // still include the element, labelled by its tag and position, rather
    // than dropping it.
    var label = item.label ? item.label.slice(0, 120) : item.tag + " #" + idx;
    item.el.setAttribute("data-pen-snap", snapshotId + ":" + idx);
    var out = { index: idx, tag: item.tag, label: label, ops: item.ops };
    if (item.role) out.role = item.role;
    if (item.options) out.options = item.options;
    if (item.value !== undefined) out.value = item.value;
    if (item.hasValue !== undefined) out.hasValue = item.hasValue;
    // Load-bearing, not informational: /api/browse/step refuses outright to
    // generate text for a password field, and this flag is the only way it
    // can tell. Omitting it made that refusal unreachable end to end — the
    // rule is absolute, so the signal carrying it has to leave the page.
    if (item.isPassword) out.isPassword = true;
    elements.push(out);
  }

  return {
    url: location.href,
    title: document.title,
    elements: elements,
    scroll: {
      y: window.scrollY,
      height: document.documentElement.scrollHeight,
      atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2,
    },
  };
})()`;

/**
 * Acts on the element previously stamped by SNAPSHOT_JS at `args.index`
 * under `args.snapshotId`, looked up by the exact `data-pen-snap` attribute
 * (see SNAPSHOT_JS's doc comment for why this is a lookup, not a
 * recomputed candidate list). `SCROLL_UP`/`SCROLL_DOWN` act on the page
 * itself and never need an element.
 *
 * Review finding 4: for CLICK/TYPE_TEXT/SELECT, the located element is
 * additionally stamped `data-pen-sig-target` and scoped-signatured before
 * being mutated — same as CLICK_JS/TYPE_JS, see their doc comments.
 */
export const PERFORM_JS = `(() => {
  var args = ${ARGS_MARKER};
  var snapshotId = args.snapshotId;
  var index = args.index;
  var operation = args.operation;
  var text = args.text;

  ${SCOPED_SIGNATURE_JS}
  ${TARGET_BUSY_HELPER_JS}

  if (operation === "SCROLL_UP" || operation === "SCROLL_DOWN") {
    var amount = operation === "SCROLL_UP" ? -1 : 1;
    window.scrollBy(0, window.innerHeight * amount);
    return { url: location.href, title: document.title };
  }

  var el = document.querySelector('[data-pen-snap="' + snapshotId + ":" + index + '"]');
  if (!el) {
    return { error: "No element at index " + index + " for this snapshot (stale or removed)." };
  }

  var staleTargets = document.querySelectorAll("[data-pen-sig-target]");
  for (var st = 0; st < staleTargets.length; st++) staleTargets[st].removeAttribute("data-pen-sig-target");
  el.setAttribute("data-pen-sig-target", "1");
  var scopedBefore = scopedSignatureOf(el);
  var busyBefore = penTargetIsBusy(el);
  function penResult() {
    return {
      url: location.href,
      title: document.title,
      __scopedBefore: scopedBefore,
      __targetSelfDisabled: !busyBefore && penTargetIsBusy(el),
    };
  }

  if (operation === "CLICK") {
    el.scrollIntoView({ block: "center" });
    el.click();
    return penResult();
  }

  if (operation === "TYPE_TEXT") {
    el.scrollIntoView({ block: "center" });
    el.focus();
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") {
      var proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
    } else if (el.isContentEditable) {
      el.textContent = text;
    } else {
      return { error: "Element at index " + index + " is not editable." };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return penResult();
  }

  if (operation === "SELECT") {
    var tagName = (el.tagName || "").toLowerCase();
    if (tagName !== "select") {
      return { error: "Element at index " + index + " is not a <select>." };
    }
    var matched = false;
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].text === text) {
        el.selectedIndex = i;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { error: "No option matching " + JSON.stringify(text) + " in element at index " + index + "." };
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return penResult();
  }

  return { error: "Unsupported operation: " + operation };
})()`;

/**
 * A cheap, deterministic page signature — jev-loop design doc "Addendum 2,
 * 2026-09-19" §1 ("Act results must carry evidence of effect"). Run once
 * before an action and once after its settle, then diffed by
 * controller.ts's `diffSignatures`.
 *
 * Review findings 2/3/4 reshaped this considerably from the original
 * addendum:
 *
 * - It now takes `args.phase` ("before" | "after") — no longer argument-free
 *   — because it needs to coordinate element-identity markers across the two
 *   calls (see below), which a stateless single-shot script can't do.
 * - `scrollY` and a `focusedValueLength` (the currently-focused input's
 *   value length, never its content) join the signature (finding 3): the
 *   old signature had nothing that moved for a successful scroll or a
 *   successful type into a field, making them indistinguishable from typing
 *   into/scrolling a dead one.
 * - `mainImageSrc` is now identity-guarded (finding 4's "guard against the
 *   largest visible img becoming a different element when an ad loads"): on
 *   `phase: "before"`, the element currently largest-by-visible-area is
 *   found and stamped `data-pen-sig-mainimg`; on `phase: "after"`, the
 *   *same* stamped element (if it still exists) is re-read, rather than
 *   recomputing "largest visible img" from scratch, which could now pick a
 *   newly-loaded ad instead of the element that actually changed.
 * - On `phase: "after"`, if the acting script (CLICK_JS/TYPE_JS/PERFORM_JS)
 *   stamped an element `data-pen-sig-target`, its scoped signature is
 *   re-computed and returned as `scopedAfter` (see SCOPED_SIGNATURE_JS).
 * - `phase: "before"` also sweeps away any `data-pen-sig-mainimg` /
 *   `data-pen-sig-target` markers left over from a *previous* action, so
 *   each action's identity tracking starts clean.
 *
 * `nodeCount`/`textLength`/`textHash` (the whole-document numbers) are
 * still computed and returned — controller.ts still reports them in
 * `changes` as useful context — but per finding 4 they no longer gate
 * `changed` on their own; see diffSignatures's doc comment.
 */
export const SIGNATURE_JS = `(() => {
  var args = ${ARGS_MARKER};
  var phase = args.phase;

  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  ${SCOPED_SIGNATURE_JS}

  if (phase === "before") {
    var staleMain = document.querySelectorAll("[data-pen-sig-mainimg]");
    for (var sm = 0; sm < staleMain.length; sm++) staleMain[sm].removeAttribute("data-pen-sig-mainimg");
    var staleTarget = document.querySelectorAll("[data-pen-sig-target]");
    for (var stg = 0; stg < staleTarget.length; stg++) staleTarget[stg].removeAttribute("data-pen-sig-target");
  }

  var rawText = (document.body ? document.body.innerText : "") || "";
  var collapsed = rawText.replace(/\\s+/g, " ").trim();
  var textLength = collapsed.length;

  // A small, fast, non-cryptographic hash (djb2-ish) — good enough to
  // detect "the visible text changed", not meant to be collision-proof.
  var hash = 0;
  for (var i = 0; i < collapsed.length; i++) {
    hash = (hash * 31 + collapsed.charCodeAt(i)) | 0;
  }

  var mainImageSrc = "";
  if (phase === "before") {
    var bestArea = 0;
    var bestEl = null;
    var imgs = document.images;
    for (var j = 0; j < imgs.length; j++) {
      var img = imgs[j];
      if (!isVisible(img)) continue;
      var rect = img.getBoundingClientRect();
      var area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        bestEl = img;
      }
    }
    if (bestEl) {
      bestEl.setAttribute("data-pen-sig-mainimg", "1");
      mainImageSrc = bestEl.currentSrc || bestEl.src || "";
    }
  } else {
    var marked = document.querySelector("[data-pen-sig-mainimg]");
    mainImageSrc = marked ? marked.currentSrc || marked.src || "" : "";
  }

  var activeEl = document.activeElement;
  var focusedValueLength = 0;
  if (activeEl) {
    var activeTag = (activeEl.tagName || "").toLowerCase();
    if (activeTag === "input" || activeTag === "textarea") {
      focusedValueLength = String(activeEl.value || "").length;
    } else if (activeEl.isContentEditable) {
      focusedValueLength = (activeEl.textContent || "").length;
    }
  }

  var result = {
    url: location.href,
    title: document.title,
    nodeCount: document.querySelectorAll("*").length,
    textLength: textLength,
    textHash: hash,
    mainImageSrc: mainImageSrc,
    scrollY: window.scrollY,
    focusedValueLength: focusedValueLength,
  };

  if (phase === "after") {
    var targetEl = document.querySelector("[data-pen-sig-target]");
    result.scopedAfter = targetEl ? scopedSignatureOf(targetEl) : null;
  }

  return result;
})()`;

/**
 * A readable digest of the current page (jev-loop design doc "Addendum 2,
 * 2026-09-19" §2, `browse_read`): visible text with script/style/noscript/
 * nav chrome stripped and whitespace collapsed, h1-h3 headings in document
 * order, and deduped http(s) links — each capped per the design doc so the
 * payload is bounded by construction, not by trusting the caller.
 * `args.selector`, when given, narrows the whole read to one subtree; when
 * it matches nothing this returns `{ error }` rather than silently reading
 * the whole page.
 *
 * Review finding 9: with a `selector`, `text` already included the root
 * element itself (collectText walks the root's own child nodes), but
 * `headings`/`links` used `root.querySelectorAll(...)`, which only matches
 * *descendants* — so `read({ selector: "h1" })` returned that heading's own
 * text in `text` but an empty `headings` array. `queryIncludingSelf` below
 * makes the two consistent: the root itself is checked against the selector
 * too, not just its descendants.
 *
 * Review finding 8: `truncated` used to reflect only the text cap — the
 * 40-heading and 60-link caps were applied silently, so a page with (say)
 * 500 links reported 60 of them with `truncated: false`, and a consumer had
 * no way to know anything was cut. `headingsTruncated`/`linksTruncated` now
 * report each collection's own truncation alongside the existing
 * (text-only) `truncated` field.
 */
/**
 * Drives the visible, human-like cursor overlay for the built-in browser tab
 * (design: a human-watched agent that clicks/types instantly and invisibly
 * looks broken even when it's working correctly). Unlike every other script
 * in this file, its value is a **Promise** — Electron's `executeJavaScript`
 * awaits whatever the injected expression evaluates to, and the whole point
 * here is an animation that spans several `requestAnimationFrame` ticks, not
 * a synchronous computation.
 *
 * `controller.ts`'s `moveCursor` runs this **before** the before-action
 * `captureSignature` call in every call site that acts on the page (click,
 * type, scroll, perform's CLICK/TYPE_TEXT/SELECT/SCROLL_UP/SCROLL_DOWN) —
 * deliberately, not incidentally: the overlay's own DOM insertion and the
 * `scrollIntoView` this script performs while locating the target are both
 * observable page mutations, and "Addendum 2"'s evidence-of-effect feature
 * (SIGNATURE_JS, `diffSignatures`) exists specifically to tell the agent
 * whether *its* action changed the page. Running the cursor between the two
 * signature captures would fold the cursor's own DOM/scroll footprint into
 * that diff and manufacture false "changed: true" evidence for actions that
 * didn't actually do anything. Running it before "before" keeps it invisible
 * to that mechanism.
 *
 * `pointer-events:none` on the overlay root — and every element inside it —
 * is a hard invariant, not a style choice: this overlay sits on top of the
 * real page content at `z-index:2147483647`, and if it ever became
 * click-through-blocking it would silently break every subsequent
 * click/type this bridge performs (its own and the user's, since a browser
 * tab has no preload to route around it).
 *
 * Never throws and always settles quickly: every code path is wrapped so a
 * failure resolves `{ error }` rather than rejecting, and a `finish()` guard
 * plus a hard backstop timer (~1.15s, comfortably under this repo's other
 * short page-script budgets) mean the promise always settles even if
 * `requestAnimationFrame` never fires again — which upstream findings in
 * this same repo (see get_screenshot's rAF-in-a-background-tab gotcha) show
 * does happen. The backstop is disarmed *only* inside `finish()` itself,
 * never by a caller ahead of time — including on the final "arrived, ripple
 * playing" leg, whose own settle is an unguarded `setTimeout` that a
 * throttled/hidden renderer can stretch past 1s — so the backstop stays live
 * and able to win that race for every settle path, not just the early-return
 * ones. `moveCursor` on the controller side wraps this in its own,
 * slightly longer timeout and swallows every failure besides — the cursor
 * must never turn a working browser command into an error or a timeout.
 */
export const CURSOR_JS = `(() => {
  var args = ${ARGS_MARKER};
  var CURSOR_VERSION = "3";

  ${FIND_BY_TEXT_JS}

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Idempotent install, guarded by a version string so a reload of this
  // script (a code change while the tab stays open) replaces a stale
  // overlay instead of leaving two stacked on top of each other.
  function ensureOverlay() {
    var existing = window.__penCursor;
    if (existing && existing.version === CURSOR_VERSION && existing.root && existing.root.isConnected) {
      return existing;
    }
    var priorPos = existing && existing.pos ? existing.pos : null;
    if (existing && existing.root && existing.root.parentNode) {
      existing.root.parentNode.removeChild(existing.root);
    }

    var root = document.createElement("div");
    root.setAttribute("data-pen-cursor", "1");
    root.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;" +
      "pointer-events:none;will-change:transform;";

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "26");
    svg.setAttribute("viewBox", "0 0 22 26");
    svg.setAttribute("data-pen-cursor-arrow", "1");
    svg.style.cssText =
      "position:absolute;left:0;top:0;overflow:visible;pointer-events:none;" +
      "transform-origin:0 0;transition:transform 140ms ease-out;" +
      "filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));";
    // The visual reference is NOT the thin-tailed macOS pointer: it is a
    // wide, heavily rounded arrow — tip up-left, a long edge out to the
    // right, and a concave notch pulling back in before the bottom point.
    // Four points describe it (tip, right, notch, bottom) and the rounding
    // comes entirely from stroking each polygon in its own fill colour with
    // stroke-linejoin:round, which fattens the silhouette outward and
    // rounds every corner — a plain fill would give hard corners.
    //
    // Two stacked copies: a wider white one underneath is the rim that
    // keeps the cursor readable on dark pages, the accent-blue one on top
    // is the arrow itself. The colour is pen-editor's own UI accent
    // (--color-accent-primary in its src/index.css) written out as a
    // literal —
    // the overlay lives in an arbitrary third-party page, which has no
    // access to the editor's custom properties.
    //
    // The stroke widths below are also what sets how round the corners
    // read, so the points are pulled in from the reference's own geometry
    // to keep the silhouette the same size as the stroke fattens it, and
    // offset from (0,0) by half the stroke along the tip's bisector — the
    // rounded tip bulges outward past the corner it rounds, so an
    // unoffset polygon would land its visible point a few px beyond the
    // target rather than on it.
    var ARROW_POINTS = "2.2,1.6 17.6,8.5 10.8,12.4 6.2,17.7";
    function arrowPolygon(colour, strokeWidth) {
      var poly = document.createElementNS(svgNS, "polygon");
      poly.setAttribute("points", ARROW_POINTS);
      poly.setAttribute("fill", colour);
      poly.setAttribute("stroke", colour);
      poly.setAttribute("stroke-width", String(strokeWidth));
      poly.setAttribute("stroke-linejoin", "round");
      poly.setAttribute("stroke-linecap", "round");
      poly.style.pointerEvents = "none";
      return poly;
    }
    svg.appendChild(arrowPolygon("#fff", 7.8));
    svg.appendChild(arrowPolygon("#0d99ff", 5.4));
    root.appendChild(svg);

    var ring = document.createElement("div");
    ring.setAttribute("data-pen-cursor-ring", "1");
    ring.style.cssText =
      "position:absolute;left:0;top:0;width:24px;height:24px;margin-left:-12px;margin-top:-12px;" +
      "border-radius:50%;border:2px solid rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.35);" +
      "pointer-events:none;opacity:0;transform:scale(0.4);";
    root.appendChild(ring);

    (document.documentElement || document.body).appendChild(root);

    var state = { version: CURSOR_VERSION, root: root, svg: svg, ring: ring, pos: priorPos, hideTimer: null };
    window.__penCursor = state;
    return state;
  }

  // Idle auto-hide: every call re-shows the overlay and (re)arms an 8s
  // fade-out, so it reads as "visible while the agent is working" rather
  // than a permanent fixture.
  function show(state) {
    state.root.style.transition = "opacity 400ms";
    state.root.style.opacity = "1";
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(function () {
      state.root.style.opacity = "0";
    }, 8000);
  }

  function place(state, x, y) {
    state.root.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    state.pos = { x: x, y: y };
  }

  function resolveTarget() {
    if (args.snapshotId !== undefined && args.snapshotId !== null && args.index !== undefined && args.index !== null) {
      return document.querySelector('[data-pen-snap="' + args.snapshotId + ":" + args.index + '"]');
    }
    if (typeof args.target === "string" && args.target.trim() !== "") {
      function findBySelector(sel) {
        try {
          return document.querySelector(sel);
        } catch (err) {
          return null;
        }
      }
      return findByText(args.target) || findBySelector(args.target);
    }
    return null;
  }

  return new Promise(function (resolve) {
    var settled = false;
    // finish() is the ONLY place the backstop is cleared (idempotent via
    // \`settled\`) — every settle path, including the final unguarded
    // setTimeout in arrive() below, must go through here rather than
    // clearing the backstop itself ahead of time. An earlier version
    // cleared it inside arrive() before scheduling that last 120ms timer,
    // leaving that final leg unbounded: a hidden/throttled renderer clamps
    // background timers to a ≥1s floor, so that "120ms" step could actually
    // take well over a second with nothing left to catch it, breaking the
    // "always settles within ~1.15s" invariant this script promises (and
    // that moveCursor's own outer timeout then had to silently absorb
    // instead). Routing every settle path through finish() keeps the
    // backstop armed — and therefore able to win the race — right up until
    // something has genuinely settled.
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      resolve(value);
    }
    // Hard backstop: requestAnimationFrame can simply stop firing (a
    // backgrounded tab, per this repo's get_screenshot rAF findings), and
    // this script must settle regardless — "at most ~1.2s" from the design,
    // kept a little under that so moveCursor's own (longer) timeout on the
    // controller side is never the thing that actually fires.
    var backstop = setTimeout(function () {
      var state = window.__penCursor;
      var pos = state && state.pos ? state.pos : { x: 0, y: 0 };
      finish({ moved: false, x: pos.x, y: pos.y });
    }, 1150);

    try {
      var state = ensureOverlay();
      show(state);

      var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

      var startX, startY;
      if (state.pos) {
        startX = state.pos.x;
        startY = state.pos.y;
      } else if (args.from && typeof args.from.x === "number" && typeof args.from.y === "number") {
        startX = args.from.x;
        startY = args.from.y;
      } else {
        startX = window.innerWidth * 0.12;
        startY = window.innerHeight * 0.85;
      }
      place(state, startX, startY);

      if (args.action === "scroll") {
        finish({ moved: false, x: startX, y: startY });
        return;
      }

      var el = resolveTarget();
      if (!el) {
        finish({ moved: false, x: startX, y: startY });
        return;
      }

      function clickFeedback() {
        if (args.action === "click" || args.action === "select") {
          state.svg.style.transform = "scale(0.85)";
          setTimeout(function () {
            state.svg.style.transform = "scale(1)";
          }, 140);
          state.ring.style.transition = "none";
          state.ring.style.opacity = "0.9";
          state.ring.style.transform = "scale(0.4)";
          void state.ring.offsetWidth; // force reflow so the transition below actually animates
          state.ring.style.transition = "transform 380ms ease-out, opacity 380ms ease-out";
          state.ring.style.transform = "scale(1.6)";
          state.ring.style.opacity = "0";
        } else if (args.action === "type") {
          state.svg.style.transform = "scale(0.92)";
          setTimeout(function () {
            state.svg.style.transform = "scale(1)";
          }, 100);
        }
      }

      function arrive(targetX, targetY) {
        place(state, targetX, targetY);
        clickFeedback();
        // Not awaited on purpose — the ripple/press feedback keeps
        // animating after this resolves, so the real action follows
        // promptly instead of waiting out the full 380ms ripple.
        setTimeout(function () {
          finish({ moved: true, x: targetX, y: targetY });
        }, 120);
      }

      function animateTo(targetX, targetY) {
        if (reduceMotion) {
          arrive(targetX, targetY);
          return;
        }
        var dx = targetX - startX;
        var dy = targetY - startY;
        var distance = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        var duration = args.durationMs || Math.min(900, Math.max(260, 90 + distance * 0.7));
        // Alternate the perpendicular bow's sign per call so consecutive
        // moves don't all curve the same way.
        window.__penCursorBowSign = -(window.__penCursorBowSign || -1);
        var bow = distance * (0.08 + Math.random() * 0.04) * window.__penCursorBowSign;
        var midX = (startX + targetX) / 2 - (dy / distance) * bow;
        var midY = (startY + targetY) / 2 + (dx / distance) * bow;
        var overshoot = Math.min(6, distance * 0.03);

        var startTime = null;
        function step(ts) {
          if (startTime === null) startTime = ts;
          var t = Math.min(1, (ts - startTime) / duration);
          var e = easeInOutCubic(t);
          var m = 1 - e;
          var x = m * m * startX + 2 * m * e * midX + e * e * targetX;
          var y = m * m * startY + 2 * m * e * midY + e * e * targetY;
          if (t >= 1) {
            // Small settle: a tiny overshoot past the target, corrected on
            // the next frame, so the stop doesn't read as dead-on-arrival.
            place(state, targetX + (dx / distance) * overshoot, targetY + (dy / distance) * overshoot);
            requestAnimationFrame(function () {
              arrive(targetX, targetY);
            });
            return;
          }
          place(state, x, y);
          requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      }

      try {
        el.scrollIntoView({ block: "center" });
      } catch (err) {
        // ignore — animate to wherever the element already is
      }
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var rect = el.getBoundingClientRect();
          var targetX = clamp(rect.left + rect.width / 2, 0, window.innerWidth);
          var targetY = clamp(rect.top + rect.height / 2, 0, window.innerHeight);
          animateTo(targetX, targetY);
        });
      });
    } catch (err) {
      finish({ error: String((err && err.message) || err) });
    }
  });
})()`;

export const READ_JS = `(() => {
  var args = ${ARGS_MARKER};
  var selector = args.selector;
  var maxChars = args.maxChars;

  var root = document;
  if (selector) {
    try {
      root = document.querySelector(selector);
    } catch (err) {
      root = null;
    }
    if (!root) {
      return { error: "browse_read: no element matched selector " + JSON.stringify(selector) };
    }
  }

  function isChrome(el) {
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "nav") return true;
    var role = el.getAttribute ? el.getAttribute("role") : null;
    if (role === "navigation") return true;
    return false;
  }

  function isVisible(el) {
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  // Finding 9: root.querySelectorAll only matches descendants — when root
  // itself (not document) matches the selector, it must be included too,
  // the same way collectText already includes the root's own text.
  function queryIncludingSelf(scopeRoot, sel) {
    var results = [];
    if (scopeRoot !== document && scopeRoot.matches && scopeRoot.matches(sel)) results.push(scopeRoot);
    var descendants = scopeRoot.querySelectorAll(sel);
    for (var i = 0; i < descendants.length; i++) results.push(descendants[i]);
    return results;
  }

  function collectText(node) {
    var parts = [];
    function walk(n) {
      if (n.nodeType === 3) {
        if (n.nodeValue) parts.push(n.nodeValue);
        return;
      }
      if (n.nodeType !== 1) return;
      if (isChrome(n)) return;
      if (!isVisible(n)) return;
      var children = n.childNodes;
      for (var i = 0; i < children.length; i++) walk(children[i]);
    }
    walk(node);
    return parts.join(" ");
  }

  var textRoot = root === document ? document.body : root;
  var rawText = textRoot ? collectText(textRoot) : "";
  var collapsed = rawText.replace(/\\s+/g, " ").trim();
  var truncated = collapsed.length > maxChars;
  var text = truncated ? collapsed.slice(0, maxChars) : collapsed;

  var scopeForQuery = root === document ? document : root;

  var headingEls = queryIncludingSelf(scopeForQuery, "h1, h2, h3");
  var allHeadings = [];
  for (var h = 0; h < headingEls.length; h++) {
    var hEl = headingEls[h];
    if (isChrome(hEl) || !isVisible(hEl)) continue;
    var hText = (hEl.textContent || "").replace(/\\s+/g, " ").trim();
    if (hText) allHeadings.push(hText);
  }
  var headingsTruncated = allHeadings.length > 40;
  var headings = allHeadings.slice(0, 40);

  var linkEls = queryIncludingSelf(scopeForQuery, "a[href]");
  var allLinks = [];
  var seenHrefs = Object.create(null);
  for (var l = 0; l < linkEls.length; l++) {
    var a = linkEls[l];
    var hrefAttr = a.getAttribute("href");
    var href;
    try {
      href = new URL(hrefAttr, document.baseURI).href;
    } catch (err) {
      continue;
    }
    if (href.indexOf("http:") !== 0 && href.indexOf("https:") !== 0) continue;
    if (seenHrefs[href]) continue;
    seenHrefs[href] = true;
    var label = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    allLinks.push({ label: label, href: href });
  }
  var linksTruncated = allLinks.length > 60;
  var links = allLinks.slice(0, 60);

  return {
    url: location.href,
    title: document.title,
    headings: headings,
    text: text,
    links: links,
    truncated: truncated,
    headingsTruncated: headingsTruncated,
    linksTruncated: linksTruncated,
  };
})()`;
