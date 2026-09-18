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

  var el = findBySelector(target) || findByText(target);
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

  var el = findBySelector(target) || findByText(target);
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
