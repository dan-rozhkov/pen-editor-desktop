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
 * Collects every `<img>` and every element with a CSS `background-image`,
 * resolves URLs against the document, dedupes by resolved URL, filters by
 * minimum rendered size, sorts by rendered area descending, and caps the
 * result at `limit`. Deliberately does not try to rewrite thumbnail URLs to
 * higher resolutions (site-specific, rots) — it returns what the page
 * actually shows.
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

  var seen = Object.create(null);
  var found = [];

  function consider(rawUrl, alt, width, height) {
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
    found.push({
      url: url,
      alt: (alt || "").trim().slice(0, 200),
      width: width,
      height: height,
    });
  }

  var imgs = document.images;
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    var rect = img.getBoundingClientRect();
    consider(img.currentSrc || img.src, img.alt, Math.round(rect.width), Math.round(rect.height));
  }

  var all = document.querySelectorAll("*");
  for (var j = 0; j < all.length; j++) {
    var el = all[j];
    var bg = getComputedStyle(el).backgroundImage;
    var bgUrl = extractBackgroundUrl(bg);
    if (!bgUrl) continue;
    var elRect = el.getBoundingClientRect();
    consider(bgUrl, el.getAttribute("aria-label") || el.getAttribute("title") || "", Math.round(elRect.width), Math.round(elRect.height));
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
 */
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
  el.scrollIntoView({ block: "center" });
  el.click();
  return { url: location.href, title: document.title, matched: target };
})()`;

/**
 * Locates a target the same way CLICK_JS does, then sets its value (input /
 * textarea) or text content (contenteditable), dispatching `input` and
 * `change` so framework-bound listeners see the change.
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

  // Text first, selector as fallback — see CLICK_JS's comment for why.
  var el = findByText(target) || findBySelector(target);
  if (!el) return { error: "No element matched: " + target };
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
  return { url: location.href, title: document.title, matched: target };
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

  function labelOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var text = (el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text) return text;
    var placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();
    var alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
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
 */
export const PERFORM_JS = `(() => {
  var args = ${ARGS_MARKER};
  var snapshotId = args.snapshotId;
  var index = args.index;
  var operation = args.operation;
  var text = args.text;

  if (operation === "SCROLL_UP" || operation === "SCROLL_DOWN") {
    var amount = operation === "SCROLL_UP" ? -1 : 1;
    window.scrollBy(0, window.innerHeight * amount);
    return { url: location.href, title: document.title };
  }

  var el = document.querySelector('[data-pen-snap="' + snapshotId + ":" + index + '"]');
  if (!el) {
    return { error: "No element at index " + index + " for this snapshot (stale or removed)." };
  }

  if (operation === "CLICK") {
    el.scrollIntoView({ block: "center" });
    el.click();
    return { url: location.href, title: document.title };
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
    return { url: location.href, title: document.title };
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
    return { url: location.href, title: document.title };
  }

  return { error: "Unsupported operation: " + operation };
})()`;
