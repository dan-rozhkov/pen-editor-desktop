// End-to-end proof of the built-in browser tab (design doc
// `2026-09-18-builtin-browser-design.md`): the editor tab's preload calls
// window.penDesktop.browser.{open,act,findImages}, which go over real IPC
// into main's BrowserController driving a real WebContentsView against a
// real DOM served by this suite's own stub HTTP server — the same
// stub-server/Electron-launch machinery e2e/mcp.spec.ts and e2e/smoke.spec.ts
// use, reused here rather than reinvented.

import { test, expect, _electron as electron, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;
let baseUrl: string;
let galleryUrl: string;
let nextUrl: string;
let snapshotUrl: string;
let snapshotManyUrl: string;
let snapshotManyWithFrameUrl: string;
let clickTargetUrl: string;
let evidenceUrl: string;
let sideEffectUrl: string;
let tickerUrl: string;
let removalUrl: string;
let selfDisableUrl: string;
let readUrl: string;
let imagesMetaUrl: string;
let slowLoadUrl: string;
let interactUrl: string;
let autoAlertUrl: string;
let smoothScrollUrl: string;
let wave2Url: string;
let wave3Url: string;
let reachModalUrl: string;
let reachOverlayUrl: string;
let reachCheckboxUrl: string;
let reachBarUrl: string;
let reachPortalUrl: string;
let reachToastUrl: string;
let reachStaleUrl: string;
let remountUrl: string;
let remountDupUrl: string;
let reachBannerUrl: string;
let wave3FrameUrl: string;
let botCheckUrl: string;
let rangeSliderUrl: string;
let ariaSliderUrl: string;
let ariaCardsUrl: string;
let ariaHeaderUrl: string;
let longListUrl: string;
let ariaListboxUrl: string;
let ariaCalendarUrl: string;
let revealStripUrl: string;
let revealFoldUrl: string;
let focusOverlayUrl: string;
let autocompleteUrl: string;
let lateEffectUrl: string;
let shadowDialogUrl: string;
// Wave 3 reliability item 2: a SECOND http server on a different port,
// bound to "localhost" rather than "127.0.0.1" (the main server's own
// bind), so the two are genuinely different origins/sites — a real
// cross-origin/OOPIF child frame under Chromium's site isolation, not just
// a different port on the same host.
let crossOriginServer: http.Server;
let crossOriginBaseUrl: string;
let crossOriginFrameUrl: string;

// How long the /slow-resource route below holds its response open before
// finally answering — comfortably past OPEN_LOAD_GRACE_MS (1500ms, so
// `open` is proven to return at DOM-ready rather than waiting for this
// resource), but bounded, unlike a connection genuinely held open forever.
// A *truly* never-finishing subresource is a real possibility on a live
// page (see the "known limitation" note where this constant is used below),
// but it isn't used here: Electron's own `executeJavaScript` defers running
// until the page stops loading (a documented Electron behavior, not
// something this fix controls — electron/electron#5183), so a genuinely
// infinite subresource would also hang the follow-up snapshot/read calls
// this test needs to prove `open`'s early return actually leaves the tab
// usable. Resolving this resource after a bounded delay models the same
// "heavy page" defect (did-finish-load waiting on a slow ad/tracker) while
// keeping the follow-up commands honestly testable.
const SLOW_RESOURCE_DELAY_MS = 3_000;

// Real http(s) images, one per element — served by this suite's own stub
// server at /pixel.svg?color=… rather than embedded as data: URIs (finding
// 8: FIND_IMAGES_JS now filters out non-http(s) URLs, so data: fixtures
// would no longer show up in findImages results at all — see
// DATA_URI_IMAGE below, which exercises exactly that exclusion instead).
// findImages dedupes by resolved URL (design doc §3), so every element
// needs a genuinely different image or the dedup step (correctly) collapses
// them into one; the rendered box size below comes entirely from the
// inline CSS width/height, not from the image's own intrinsic size.
function pixelUrl(color: string): string {
  return `${baseUrl}/pixel.svg?color=${encodeURIComponent(color)}`;
}

// Like pixelUrl, but the served SVG's own width/height attributes are set
// to `w`/`h` — this is what gives the loaded <img> a genuine *intrinsic*
// (natural) size distinct from whatever CSS renders it at, letting
// BROWSE-01's naturalWidth/naturalHeight fields be exercised against a real
// asset rather than asserted against a guess.
function sizedPixelUrl(w: number, h: number, color: string): string {
  return `${baseUrl}/pixel-sized.svg?w=${w}&h=${h}&color=${encodeURIComponent(color)}`;
}

// A single inline data: URI image, deliberately larger (by rendered area)
// than every http(s) image on the page — if FIND_IMAGES_JS's http(s)-only
// filter (finding 8) ever regresses, this would sort to the very front of
// defaultImages.images instead of being excluded outright.
/** How long the /self-disable fixture's handler holds its button disabled —
 * inside BUSY_SETTLE_TIMEOUT_MS (3s), well outside the ~350ms a
 * non-navigating click settled in before addendum 3 §2. */
const SELF_DISABLE_HANDLER_MS = 1_200;

const DATA_URI_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="orange"/></svg>`,
)}`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/slow-resource")) {
      // The DOM-ready fixture's subresource: answers only after
      // SLOW_RESOURCE_DELAY_MS — long enough that `webContents.loadURL()`'s
      // promise (did-finish-load, which waits for every subresource) is
      // still pending well past the point `open` must have already returned
      // via DOM-ready. See SLOW_RESOURCE_DELAY_MS's doc comment for why this
      // is bounded rather than a connection held open forever.
      setTimeout(() => {
        res.setHeader("content-type", "image/svg+xml");
        res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="gray"/></svg>`);
      }, SLOW_RESOURCE_DELAY_MS);
      return;
    }
    if (req.url && req.url.startsWith("/pixel.svg")) {
      const color = new URL(req.url, "http://pixel.local").searchParams.get("color") || "black";
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${color}"/></svg>`);
      return;
    }
    if (req.url && req.url.startsWith("/pixel-sized.svg")) {
      const parsed = new URL(req.url, "http://pixel.local");
      const w = parsed.searchParams.get("w") || "10";
      const h = parsed.searchParams.get("h") || "10";
      const color = parsed.searchParams.get("color") || "black";
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${color}"/></svg>`);
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url && req.url.startsWith("/gallery/next")) {
      res.end(`<!doctype html><title>Gallery Next</title><h1 id="ready">gallery-next-ready</h1>`);
      return;
    }
    if (req.url && req.url.startsWith("/snapshot-many-with-frame")) {
      // Code review finding 7 fixture: the same 150-button cap-trigger as
      // /snapshot-many above, PLUS 15 visible scroll containers, PLUS a
      // same-origin iframe with its own interactive element
      // (/wave3-frame's #frame-btn). Before the fix, SNAPSHOT_JS appended
      // its (up to 10) scroll containers on top of the already-120-capped
      // interactive elements, so `elements.length` here would be 130 —
      // `controller.ts`'s `remaining = MAX_SNAPSHOT_ELEMENTS -
      // elements.length` went negative, and its `if (remaining > 0)` guard
      // then skipped the iframe merge outright, so the iframe's button
      // never showed up in the snapshot no matter how visible it was.
      const buttons = Array.from(
        { length: 150 },
        (_, i) => `<button style="position:absolute;top:${i * 4}px;left:0;width:20px;height:20px">Many ${i}</button>`,
      ).join("\n");
      const containers = Array.from(
        { length: 15 },
        (_, i) =>
          `<div style="position:absolute;top:${i * 40}px;left:700px;width:150px;height:30px;overflow:auto">` +
          `<div style="height:200px">container ${i} content</div></div>`,
      ).join("\n");
      res.end(
        `<!doctype html><title>Snapshot Many With Frame</title>` +
          `<h1 id="ready">snapshot-many-with-frame-ready</h1>${buttons}${containers}` +
          `<iframe src="${wave3FrameUrl}" style="position:absolute;top:610px;left:0;width:300px;height:100px"></iframe>`,
      );
      return;
    }
    if (req.url && req.url.startsWith("/snapshot-many")) {
      // Cap test (jev-loop design doc §1, MAX_SNAPSHOT_ELEMENTS = 120): 150
      // genuinely visible, interactive buttons, absolutely positioned 4px
      // apart (max top 596px) so every one of them sits well inside
      // SNAPSHOT_JS's viewport-ish margin regardless of the actual window
      // height — the cap must trigger because of the hard limit, not
      // because most of them scrolled out of range.
      const buttons = Array.from(
        { length: 150 },
        (_, i) => `<button style="position:absolute;top:${i * 4}px;left:0;width:20px;height:20px">Many ${i}</button>`,
      ).join("\n");
      res.end(`<!doctype html><title>Snapshot Many</title><h1 id="ready">snapshot-many-ready</h1>${buttons}`);
      return;
    }
    if (req.url && req.url.startsWith("/snapshot")) {
      // Exercises SNAPSHOT_JS's rules directly (jev-loop design doc §1 /
      // §4 / addendum D): visibility filtering, label sources (aria-label /
      // text / placeholder / alt / unlabeled fallback), ops per element
      // type, and the privacy rule for `value` — only a non-password
      // input[type=text]/[type=search]/textarea with no sensitive
      // autocomplete reports its live value; every other input/select
      // reports only `hasValue`.
      res.end(`<!doctype html>
<title>Snapshot</title>
<h1 id="ready">snapshot-ready</h1>
<button id="btn-aria" aria-label="Aria Label Button">Different Visible Text</button>
<a id="link-text" href="#anchor">Plain Link Text</a>
<input id="inp-placeholder" type="text" placeholder="Type here" />
<!-- Deliberately has no id at all (unlike every other fixture element
here) — BROWSE-02's labelOf now also falls back to an element's own
name/id attribute before the positional "tag #index" fallback, so an
element meant to exercise the *positional* fallback must have neither. -->
<button style="width:24px;height:24px"><svg width="16" height="16"></svg></button>
<input id="inp-password" type="password" value="supersecret" />
<select id="sel-color">
  <option>Red</option>
  <option selected>Green</option>
  <option>Blue</option>
</select>
<button id="btn-hidden" style="display:none">Hidden</button>
<button id="btn-invisible" style="visibility:hidden">Invisible</button>
<button id="btn-transparent" style="opacity:0">Transparent</button>
<button id="btn-zero-size" style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero Size</button>
<button id="btn-far" style="position:absolute;top:100000px">Far Away</button>
<!-- BROWSE-02 fixtures (jev-loop design doc "Addendum 2, 2026-09-19" §4):
an icon button with no own label at all, but a descendant carrying
aria-label — the common "<div role=button><svg aria-label=…>" shape — and a
non-link/button interactive element (role=button) that is itself unlabelled
but sits inside an <a aria-label="…">, exercising the "nearest enclosing
<a>/<button>" step. -->
<button id="btn-icon-labelled" style="width:24px;height:24px"><svg aria-label="Save" width="16" height="16"></svg></button>
<a id="link-enclosing" href="#cart" aria-label="View Cart"><span id="span-in-link" role="button" style="display:inline-block;width:20px;height:20px"></span></a>
<!-- Review finding 6: labelOf's descendant step used to inspect only the
FIRST element matching [aria-label],[title],[alt] and give up if its
attributes were blank — this button's FIRST match is an <img alt=""> (empty,
so it would previously yield nothing), and only the SECOND match, the
svg[aria-label], actually carries the label. This is a very common real
shape: <div role="button"><img alt=""><svg aria-label="…"></svg></div>. -->
<button id="btn-descendant-second-match" style="width:24px;height:24px"><img alt="" width="16" height="16"><svg aria-label="Bookmark" width="16" height="16"></svg></button>
<!-- Review finding 7: a machine-generated-looking id (React useId's own
":r3:" shape reproduced here without special characters that would break
this being a valid HTML id, plus Ember's/other frameworks' digit-suffixed
style) must be SKIPPED as a label source, falling through to the positional
"tag #index" fallback — unlike #inp-password/#inp-tel above, whose ids are
hand-authored and legitimate label sources. -->
<button id="ember1234" style="width:24px;height:24px"><svg width="16" height="16"></svg></button>
<!-- Addendum D fixtures: an autofilled type=tel and type=email (never
eligible for "value" at all — not text/search/textarea), a text input with a
sensitive autocomplete token (eligible type, but the token excludes it), and
a plain search box (eligible, must still report its value). -->
<input id="inp-tel" type="tel" value="+1 555-0100" />
<input id="inp-email" type="email" value="autofilled@example.com" />
<input id="inp-cc" type="text" autocomplete="cc-number" value="4111111111111111" />
<input id="inp-search" type="search" value="chairs" />
<!-- Second-pass review: a scroll container that is ALSO an interactive
element (a textarea with overflow:auto and content taller than its box) must
not get a second, duplicate element-table entry with its own data-pen-snap
stamp — that would overwrite the textarea's own interactive stamp, and the
model's earlier TYPE_TEXT index would then resolve to nothing ("No element
matched"). It should instead get exactly one entry, with ops: ["TYPE_TEXT"]
(its interactive identity) AND scrollable: true. -->
<textarea id="textarea-scrollable" style="height:40px;overflow-y:auto" placeholder="Notes">line one
line two
line three
line four
line five
line six
line seven
line eight
line nine
line ten</textarea>
<!-- A "Select…" placeholder is the unset state of a <select>, and a
checkbox's value is its submit token ("on"), never user input — neither may
read as filled. -->
<select id="sel-country"><option value="">Select…</option><option>Germany</option></select>
<label><input id="chk-terms" type="checkbox"> Accept the terms</label>
<div id="click-result"></div>
<script>
  document.getElementById('btn-aria').addEventListener('click', function () {
    document.getElementById('click-result').textContent = 'clicked-aria';
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/click-target")) {
      // Finding 2: "Details" is both the visible text of a real button and
      // a syntactically valid CSS type selector — it matches the <details>
      // element on this page. Under the old
      // findBySelector-before-findByText order, clicking "Details" would
      // silently land on the <details> element (a no-op) while still
      // reporting { matched: "Details" } as if it worked.
      res.end(`<!doctype html>
<title>Click Target</title>
<h1 id="ready">click-target-ready</h1>
<details id="wrapper-details"><summary>Not the button</summary></details>
<button id="btn-details">Details</button>
<div id="click-result"></div>
<script>
  document.getElementById('btn-details').addEventListener('click', function () {
    document.getElementById('click-result').textContent = 'clicked-details-button';
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/evidence")) {
      // "Addendum 2, 2026-09-19" §1: a no-op click (nothing listens on
      // #noop-btn at all) must report changed: false without erroring, and
      // a click that swaps only the largest visible <img>'s src must report
      // changed: true with "main-image" in `changes` — the design doc's own
      // motivating example ("the one thing that moves when a gallery
      // switches and nothing else does").
      res.end(`<!doctype html>
<title>Evidence</title>
<h1 id="ready">evidence-ready</h1>
<button id="noop-btn">No Op</button>
<img id="main-photo" src="${pixelUrl("red")}" alt="Main" style="display:block;width:400px;height:300px" />
<button id="swap-btn">Swap Photo</button>
<script>
  document.getElementById('swap-btn').addEventListener('click', function () {
    document.getElementById('main-photo').src = ${JSON.stringify(pixelUrl("blue"))};
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/side-effect-api")) {
      // The click handler's real fetch(), delayed enough that it's still
      // in flight when the click's own settle wait would otherwise resolve
      // — settleAfterClick's network-quiet wait is what actually catches
      // this in production (a real POST), not a bare timer.
      setTimeout(() => {
        res.end("ok");
      }, 80);
      return;
    }
    if (req.url && req.url.startsWith("/side-effect")) {
      // Browse-speed contract (2026-09-24): the bench-shop "Add to Cart"
      // shape — clicking a button POSTs, then updates a SEPARATE element's
      // text; the button itself never changes. diffSignatures's scoped
      // target signature correctly reports changed: false (the acted-on
      // element is unaffected), but pageChanged must be true and appeared
      // must surface the new status text — this is the case that used to
      // make browse_task's loop record "(no effect)" and re-click.
      res.end(`<!doctype html>
<title>Side Effect</title>
<h1 id="ready">side-effect-ready</h1>
<button id="add-to-cart-btn">Add to Cart</button>
<p id="cart-status"></p>
<script>
  document.getElementById('add-to-cart-btn').addEventListener('click', function () {
    fetch('/side-effect-api', { method: 'POST' }).then(function () {
      document.getElementById('cart-status').textContent = 'Added to cart (1 item)';
    });
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/ticker")) {
      // Browse-speed contract fix (2026-09-24, review finding 1): a live
      // clock that keeps ticking on its own, well within the action's own
      // settle window (100ms cadence vs. the ~350+ms a click typically
      // settles in) — a no-op button click must NOT pick up the clock's own
      // digit churn as evidence of an effect.
      res.end(`<!doctype html>
<title>Ticker</title>
<h1 id="ready">ticker-ready</h1>
<div id="clock">00:00:00</div>
<button id="noop-btn">No Op</button>
<script>
  var n = 0;
  setInterval(function () {
    n++;
    var s = String(n % 60).padStart(2, '0');
    document.getElementById('clock').textContent = '00:00:' + s;
  }, 100);
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/removal")) {
      // Browse-speed contract fix (2026-09-24, review finding 1): clicking
      // the button removes a real, visible, text-bearing element — removal
      // alone must never count as pageChanged evidence.
      res.end(`<!doctype html>
<title>Removal</title>
<h1 id="ready">removal-ready</h1>
<button id="remove-btn">Remove</button>
<p id="removable">Some real visible content</p>
<script>
  document.getElementById('remove-btn').addEventListener('click', function () {
    var el = document.getElementById('removable');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/self-disable")) {
      // Addendum 3 §2 (upstream PR #58): a submit button that disables
      // itself while its handler runs, then re-enables and reveals what
      // the agent is actually after. SELF_DISABLE_HANDLER_MS is well inside
      // the 3s busy bound but far outside the ~350ms a non-navigating click
      // used to settle in — so an observation taken right after `perform`
      // returns sees "Continue" only if the command waited.
      res.end(`<!doctype html>
<title>Self Disable</title>
<h1 id="ready">self-disable-ready</h1>
<button id="start-btn">Start</button>
<div id="after"></div>
<script>
  document.getElementById('start-btn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    setTimeout(function () {
      btn.disabled = false;
      document.getElementById('after').innerHTML = '<button id="continue-btn">Continue</button>';
    }, ${SELF_DISABLE_HANDLER_MS});
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/images-meta")) {
      // BROWSE-01 (jev-loop design doc "Addendum 2, 2026-09-19" §3):
      // img-natural is rendered small by CSS but its served SVG declares a
      // much larger intrinsic size, exercising naturalWidth/naturalHeight
      // as genuinely distinct from the rendered width/height. img-srcset
      // declares two candidates; FIND_IMAGES_JS must pick the larger one
      // (900w) rather than the currentSrc the browser happens to be
      // rendering.
      //
      // Review finding 1 (HIGH): img-comma's srcset candidate is a URL with
      // a comma embedded in it — the exact shape a Cloudinary/imgix
      // transform produces (`.../x/w_800,h_600/a.jpg`). The pre-fix
      // `srcset.split(",")` would tear this URL in two at that comma,
      // pick the descriptor-less fragment's *sibling* piece (the one with
      // the "800w" descriptor, which after the bad split is a relative URL
      // fragment rather than the real URL) and return it — a 404 on any
      // real CDN. `commaUrl` below reuses the /pixel.svg route (so the
      // fixture doesn't need its own handler) with a comma-bearing query
      // string appended, and is the *smaller*-descriptor* candidate in one
      // assertion and the winning (larger) one in another, so both the
      // split fix and the "doesn't silently pick the wrong candidate" case
      // are exercised.
      res.end(`<!doctype html>
<title>Images Meta</title>
<h1 id="ready">images-meta-ready</h1>
<img id="img-natural" src="${sizedPixelUrl(800, 600, "teal")}" alt="Natural" style="display:block;width:150px;height:100px" />
<img id="img-srcset" src="${pixelUrl("gray")}" srcset="${pixelUrl("gray")} 200w, ${sizedPixelUrl(900, 900, "magenta")} 900w" alt="Srcset" style="display:block;width:120px;height:120px" />
<img id="img-comma" src="${pixelUrl("gray")}" srcset="${pixelUrl("gray")}&x=w_100,h_100 200w, ${pixelUrl("teal")}&x=w_800,h_600 800w" alt="Comma" style="display:block;width:120px;height:120px" />`);
      return;
    }
    if (req.url && req.url.startsWith("/read")) {
      // browse_read (jev-loop design doc "Addendum 2, 2026-09-19" §2):
      // script/style/nav text must be stripped from `text`, headings and
      // links must be capped (40 / 60) and deduped/filtered (links:
      // http(s) only, deduped by href), and a `selector` narrows the whole
      // read to one subtree.
      res.end(`<!doctype html>
<title>Read Page</title>
<h1 id="ready">read-ready</h1>
<nav id="nav-chrome">Nav chrome should not appear in visible text<a href="/nav-link">Nav Link</a></nav>
<script>console.log('should not appear in text');</script>
<style>body{color:red}</style>
<a id="long-label-link" href="${baseUrl}/long-label">${"X".repeat(200)}</a>
<p>Some visible paragraph text that should be included in the digest, with   extra   whitespace   collapsed.</p>
<p style="display:none">Hidden paragraph should not appear.</p>
<div id="scope"><h2>Scoped Heading</h2><p>Scoped paragraph text only.</p><a href="${baseUrl}/scoped-link">Scoped Link</a></div>
<div id="headings-many"></div>
<div id="links-many"></div>
<script>
  var hc = document.getElementById('headings-many');
  for (var i = 0; i < 45; i++) {
    var h = document.createElement('h3');
    h.textContent = 'Heading ' + i;
    hc.appendChild(h);
  }
  var lc = document.getElementById('links-many');
  for (var i = 0; i < 65; i++) {
    var a = document.createElement('a');
    a.href = '/link-' + i;
    a.textContent = 'Link ' + i;
    lc.appendChild(a);
  }
  var dup = document.createElement('a');
  dup.href = '/link-0';
  dup.textContent = 'Duplicate of Link 0';
  lc.appendChild(dup);
  var mailLink = document.createElement('a');
  mailLink.href = 'mailto:test@example.com';
  mailLink.textContent = 'Email us';
  lc.appendChild(mailLink);
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/slow-load")) {
      // The DOM-ready fixture page itself: HTML is complete and the DOM is
      // immediately ready, but it references /slow-resource, which stalls
      // for SLOW_RESOURCE_DELAY_MS — did-finish-load (and therefore the old
      // `await page.loadURL()`) wouldn't resolve until then either.
      res.end(
        `<!doctype html><title>Slow Load</title><h1 id="ready">slow-load-ready</h1><img src="${baseUrl}/slow-resource" alt="loads slowly" />`,
      );
      return;
    }
    if (req.url && req.url.startsWith("/gallery")) {
      res.end(`<!doctype html>
<title>Gallery</title>
<h1 id="ready">gallery-ready</h1>
<img id="img-large" src="${pixelUrl("red")}" alt="Large photo" style="display:block;width:400px;height:300px" />
<img id="img-small" src="${pixelUrl("blue")}" alt="Thumb" style="display:block;width:100px;height:80px" />
<div id="bg-large" style="width:500px;height:350px;background-image:url('${pixelUrl("green")}')"></div>
<img id="img-datauri" src="${DATA_URI_IMAGE}" alt="Data URI" style="display:block;width:900px;height:900px" />
<input id="query" type="text" placeholder="Search" />
<div id="wrap-outer"><div id="wrap-inner"><button id="load-more">Load More</button></div></div>
<div style="height:2000px"></div>
<script>
  window.__typedValues = [];
  document.getElementById('query').addEventListener('input', function (e) {
    window.__typedValues.push(e.target.value);
  });
  document.getElementById('load-more').addEventListener('click', function () {
    var img = document.createElement('img');
    img.id = 'img-loaded';
    img.alt = 'Loaded photo';
    img.src = ${JSON.stringify(pixelUrl("purple"))};
    img.style.display = 'block';
    img.style.width = '600px';
    img.style.height = '600px';
    document.body.appendChild(img);
    document.title = 'Loaded';
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/interact")) {
      // Full browser use (design doc `2026-09-23-full-browser-use-design.md`):
      // one fixture covering press (Enter submits a form), hover (:hover +
      // mouseover), select, and a target=_blank popup link (openedTab).
      res.end(`<!doctype html>
<title>Interact</title>
<h1 id="ready">interact-ready</h1>
<form id="search-form" onsubmit="document.title = 'Submitted'; return false;">
  <input id="query" type="text" placeholder="Search" />
</form>
<button id="hover-target" style="width:80px;height:40px">Hover me</button>
<div id="hover-result">not-hovered</div>
<style>
  #hover-target:hover { background-color: rgb(255, 0, 0); }
</style>
<select id="sel-fruit">
  <option>Apple</option>
  <option>Banana</option>
  <option>Cherry</option>
</select>
<a id="popup-link" href="${baseUrl}/gallery/next" target="_blank">Open in new tab</a>
<button id="alert-btn">Trigger Alert</button>
<div id="after-alert">before-alert</div>
<script>
  document.getElementById('hover-target').addEventListener('mouseover', function () {
    document.getElementById('hover-result').textContent = 'hovered';
  });
  document.getElementById('alert-btn').addEventListener('click', function () {
    alert('Hello from the page');
    document.getElementById('after-alert').textContent = 'after-alert';
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/auto-alert")) {
      // Second-pass review finding 1: raises its own alert() well after
      // page load (2s — comfortably past OPEN_LOAD_GRACE_MS/1500ms, so the
      // `open` command that navigates here has already resolved and no
      // `browser:command` is in flight when the dialog actually opens),
      // proving a dialog raised *between* agent commands is still resolved
      // (and reported) rather than left open forever, hanging every later
      // command against this tab.
      res.end(`<!doctype html>
<title>Auto Alert</title>
<h1 id="ready">auto-alert-ready</h1>
<script>
  setTimeout(function () {
    alert('delayed alert, no command in flight');
  }, 2000);
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/wave2")) {
      // Wave 2 reliability e2e fixture, one page covering three cases the
      // hermetic unit suite can't prove against a fake page:
      // - #trusted-btn records event.isTrusted (real vs synthetic click).
      // - #menu-btn only opens #menu on a real "pointerdown" event (not
      //   "click") — a synthetic el.click() never fires pointerdown at all,
      //   so this only opens via a genuinely trusted CDP mouse dispatch.
      // - #react-input records whether a real "beforeinput" event fired —
      //   the CDP Input.insertText path fires one (like real typing); the
      //   legacy native-setter + synthetic Event("input") fallback does not.
      // - #outer-scroll / #inner-scroll: the document itself doesn't scroll
      //   (body height fits the viewport), but #inner-scroll is a real
      //   overflow:auto container taller than its box.
      res.end(`<!doctype html>
<title>Wave 2</title>
<style>/* pen-e2e-style-only-text should never be a click target */</style>
<h1 id="ready">wave2-ready</h1>
<button id="trusted-btn">Trusted Click</button>
<div id="trusted-result">not-clicked</div>
<button id="menu-btn">Menu</button>
<div id="menu" style="display:none">menu-open</div>
<label for="react-input">React-like Input</label>
<input id="react-input" type="text" value="old value" />
<div id="beforeinput-result">no-beforeinput</div>
<div id="outer-scroll" style="height:200px;overflow:hidden">
  <div id="inner-scroll" style="height:200px;overflow:auto">
    <div style="height:2000px">tall content</div>
  </div>
</div>
<!-- Code review finding 5 fixture: "Select" is both a bare-word text match
     (the hidden button below) AND a valid CSS type selector matching the
     real, visible <select> — the hidden text match must not short-circuit
     before the selector fallback gets a chance to run. -->
<select id="real-select"><option>Option A</option></select>
<button id="hidden-select-label" style="display:none">Select</button>
<script>
  document.getElementById('trusted-btn').addEventListener('click', function (e) {
    document.getElementById('trusted-result').textContent = e.isTrusted ? 'trusted-clicked' : 'synthetic-clicked';
  });
  document.getElementById('menu-btn').addEventListener('pointerdown', function () {
    document.getElementById('menu').style.display = 'block';
  });
  document.getElementById('react-input').addEventListener('beforeinput', function () {
    document.getElementById('beforeinput-result').textContent = 'beforeinput-fired';
  });
  // Code review finding 5 fixture: this literal string must never be
  // clickable as a text match — a target search for it should report "No
  // element matched", never falsely succeed against this <script> element.
  var penE2eScriptOnlyText = "pen-e2e-script-only-text";
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/smooth-scroll")) {
      // Second-pass review finding 4: html{scroll-behavior:smooth} makes a
      // plain scrollIntoView() call still animating at the moment the very
      // next line reads getBoundingClientRect() — a hover/focus target far
      // below the fold gives that animation real distance to still be
      // covering when read.
      res.end(`<!doctype html>
<title>Smooth Scroll</title>
<style>
  html { scroll-behavior: smooth; }
  body { margin: 0; }
  #spacer { height: 3000px; }
  #hover-target { width: 80px; height: 40px; }
  #hover-target:hover { background-color: rgb(255, 0, 0); }
</style>
<h1 id="ready">smooth-scroll-ready</h1>
<div id="spacer"></div>
<button id="hover-target">Hover me</button>
<div id="hover-result">not-hovered</div>
<script>
  document.getElementById('hover-target').addEventListener('mouseover', function () {
    document.getElementById('hover-result').textContent = 'hovered';
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/wave3-frame")) {
      // Wave 3 reliability item 2: the same-origin iframe's own content —
      // a button by itself, and enough text to prove browse_read's
      // "[frame: X]" append actually pulled from here.
      res.end(`<!doctype html>
<title>Same-Origin Frame</title>
<button id="frame-btn">Frame Button</button>
<div id="frame-result">not-clicked</div>
<p>same-origin frame text digest</p>
<script>
  document.getElementById('frame-btn').addEventListener('click', function () {
    document.getElementById('frame-result').textContent = 'frame-clicked';
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/wave3")) {
      // Wave 3 reliability e2e fixture: an open shadow root, a same-origin
      // iframe, a cross-origin/OOPIF iframe (served by the second http
      // server, a genuinely different origin/site — see
      // crossOriginFrameUrl's doc comment), and a button whose click handler
      // throws (proving the console-error ring buffer surfaces a real
      // Runtime.exceptionThrown).
      res.end(`<!doctype html>
<title>Wave 3</title>
<h1 id="ready">wave3-ready</h1>
<div id="shadow-host"></div>
<iframe id="same-origin-frame" src="${wave3FrameUrl}" style="width:300px;height:120px;border:1px solid #ccc"></iframe>
<iframe id="cross-origin-frame" src="${crossOriginFrameUrl}" style="width:300px;height:120px;border:1px solid #ccc"></iframe>
<button id="throw-btn">Throw</button>
<script>
  var shadowRoot = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
  shadowRoot.innerHTML =
    '<button id="shadow-btn">Shadow Button</button>' +
    '<div id="shadow-result">not-clicked</div>' +
    '<p>shadow root text digest</p>';
  shadowRoot.getElementById('shadow-btn').addEventListener('click', function () {
    shadowRoot.getElementById('shadow-result').textContent = 'shadow-clicked';
  });
  document.getElementById('throw-btn').addEventListener('click', function () {
    throw new Error('wave3 console error fixture');
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-modal")) {
      // Reachability (booking.com Genius-popup finding): an aria-modal dialog
      // over a full-viewport fixed backdrop. SNAPSHOT_JS must list only the
      // dialog's controls, report `modal`, and go back to the page's own
      // controls once the dialog is closed.
      res.end(`<!doctype html>
<title>Reach Modal</title>
<h1 id="ready">reach-modal-ready</h1>
<button id="page-a">Page Button A</button>
<button id="page-b">Page Button B</button>
<div id="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10">
  <div role="dialog" aria-modal="true" aria-label="Sign in offer" style="position:fixed;top:80px;left:80px;width:300px;height:160px;background:#fff;z-index:11">
    <p>Get discounts</p>
    <button id="dlg-close">Close</button>
  </div>
</div>
<script>
  document.getElementById('dlg-close').addEventListener('click', function () {
    document.getElementById('backdrop').remove();
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-overlay")) {
      // A fixed full-width overlay covering 90% of the viewport (a WALL: >= 85%) that is
      // NOT aria-modal covers one button; nothing can scroll it clear.
      res.end(`<!doctype html>
<title>Reach Overlay</title>
<h1 id="ready">reach-overlay-ready</h1>
<button id="covered-btn" style="position:absolute;top:10px;left:10px;width:120px;height:40px">Covered Button</button>
<button id="free-btn" style="position:absolute;top:92vh;left:10px;width:120px;height:30px">Free Button</button>
<div style="position:fixed;top:0;left:0;right:0;height:90vh;background:#eee;z-index:10"></div>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-bar")) {
      // A PARTIAL fixed bar (booking.com OneTrust cookie banner shape: fixed,
      // bottom, full width, ~30% of the viewport, not aria-modal) covers a
      // button near the bottom of the viewport. Not a wall: the button must
      // stay in the snapshot, and a click must scroll it clear and land as a
      // trusted (cdp) click.
      res.end(`<!doctype html>
<title>Reach Bar</title>
<h1 id="ready">reach-bar-ready</h1>
<button id="bar-btn" style="position:absolute;top:88vh;left:10px;width:140px;height:40px">Under Bar</button>
<div id="bar-result">not-clicked</div>
<div style="height:3000px"></div>
<div style="position:fixed;left:0;right:0;bottom:0;height:30vh;background:#ddd;z-index:10">cookie bar</div>
<script>
  document.getElementById('bar-btn').addEventListener('click', function (e) {
    document.getElementById('bar-result').textContent = e.isTrusted ? 'bar-clicked-trusted' : 'bar-clicked-synthetic';
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-portal")) {
      // A modal dialog whose datepicker-style popup is portalled to the end of
      // <body>, OUTSIDE the aria-modal element (many UI libraries do this),
      // above the backdrop. The popup's option must stay listed; a page
      // button under the backdrop must not.
      res.end(`<!doctype html>
<title>Reach Portal</title>
<h1 id="ready">reach-portal-ready</h1>
<button id="behind" style="position:absolute;top:20px;left:20px;width:140px;height:40px">Behind Button</button>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10">
  <div role="dialog" aria-modal="true" aria-label="Pick a date" style="position:fixed;top:80px;left:80px;width:300px;height:160px;background:#fff;z-index:11">
    <button id="open-picker">Open picker</button>
  </div>
</div>
<div id="portal" style="position:fixed;top:200px;left:420px;width:200px;height:120px;overflow-y:auto;background:#fff;z-index:20">
  <button id="opt-jan" style="width:180px;height:40px">Option Jan</button>
  <div style="height:400px">More options below</div>
</div>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-toast")) {
      // A toast container (sonner / react-hot-toast shape): fixed, viewport-
      // sized, pointer-events:none, holding a small pointer-events:auto toast
      // over a button. The container is not the occluder; the button stays.
      res.end(`<!doctype html>
<title>Reach Toast</title>
<h1 id="ready">reach-toast-ready</h1>
<button id="under-toast" style="position:absolute;top:110px;left:10px;width:120px;height:40px">Under Toast</button>
<div style="position:fixed;inset:0;pointer-events:none;z-index:10">
  <div style="position:absolute;top:100px;left:10px;width:200px;height:60px;background:#333;color:#fff;pointer-events:auto">Saved!</div>
</div>`);
      return;
    }
    if (req.url && req.url.startsWith("/remount")) {
      // Re-mount recovery fixture (booking.com finding): ~300ms after the
      // snapshot stamps the buttons, the page replaces them with FRESH nodes
      // (createElement, not cloneNode — a clone would carry data-pen-snap
      // over and defeat the point). `?dup=1` renders two buttons sharing a
      // label, so a fingerprint match is ambiguous.
      const dup = req.url.includes("dup=1");
      res.end(`<!doctype html>
<title>Remount</title>
<h1 id="ready">remount-ready</h1>
<div id="host"></div>
<div id="clicks">0</div>
<script>
  window.__clicks = 0;
  var params = new URLSearchParams(location.search);
  var labels = ${dup ? '["Find", "Find"]' : '["Other", "Find"]'};
  if (params.get("rm") === "1") labels = ["Remove", "Remove"];
  function mount() {
    var host = document.getElementById("host");
    host.textContent = "";
    labels.forEach(function (label) {
      var b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "display:block;margin:8px;padding:8px 16px";
      b.addEventListener("click", function () {
        window.__clicks++;
        document.getElementById("clicks").textContent = String(window.__clicks);
      });
      host.appendChild(b);
    });
  }
  mount();
  var seen = false;
  new MutationObserver(function () {
    if (seen || !document.querySelector("[data-pen-snap]")) return;
    seen = true;
    setTimeout(function () {
      // ?rm=1: the first "Remove" row is gone after the re-render.
      if (params.get("rm") === "1") labels = ["Remove"];
      // ?spa=1: an SPA route change — same window, new href — plus a re-render.
      if (params.get("spa") === "1") history.pushState({}, "", "/remount?spa=1#next");
      mount();
    }, 300);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-pen-snap"], subtree: true });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-stale")) {
      // A stale aria-modal left mounted inside an opacity:0; pointer-events:none
      // wrapper (exit-transition pattern) must not scope the table: nothing
      // hit-tests onto it, so page controls stay listed and no `modal` shows.
      res.end(`<!doctype html>
<title>Reach Stale</title>
<h1 id="ready">reach-stale-ready</h1>
<button id="live-btn">Live Page Button</button>
<div style="opacity:0;pointer-events:none;position:fixed;top:0;left:0;width:100%;height:100%">
  <div role="dialog" aria-modal="true" aria-label="Stale modal" style="position:absolute;top:200px;left:200px;width:300px;height:160px;background:#fff">
    <button id="stale-close">Stale Close</button>
  </div>
</div>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-checkbox")) {
      // A custom checkbox: the real <input> sits under a sibling styled span
      // (no <label>, nothing fixed). Reachable through its wrapper, so it
      // must NOT be dropped by the covered-by-overlay rule.
      res.end(`<!doctype html>
<title>Reach Checkbox</title>
<h1 id="ready">reach-checkbox-ready</h1>
<div style="position:relative;width:40px;height:40px"><input type="checkbox" id="c" aria-label="Custom check" style="position:absolute;inset:0;margin:0"><span style="position:absolute;inset:0;background:#ccc"></span></div>
<button id="other-btn">Other Button</button>`);
      return;
    }
    if (req.url && req.url.startsWith("/reach-banner")) {
      // A non-modal role=dialog cookie banner (no aria-modal, static) must
      // not scope the snapshot.
      res.end(`<!doctype html>
<title>Reach Banner</title>
<h1 id="ready">reach-banner-ready</h1>
<button id="main-btn">Main Page Button</button>
<div role="dialog" aria-label="Cookie banner"><button id="cookie-ok">Accept cookies</button></div>`);
      return;
    }
    if (req.url && req.url.startsWith("/range-slider")) {
      // A dual slider the way a real filter widget ships it: two NATIVE
      // range inputs (the accessible, value-carrying ones) visually hidden at
      // 1x1 / opacity:0 over custom-drawn thumb divs. SNAPSHOT_JS's
      // isVisible used to drop both, so the control never reached the
      // element table. The question they answer lives in a <legend> four
      // levels up, and "Max." alone says nothing about it.
      res.end(`<!doctype html>
<title>Range Slider</title>
<h1 id="ready">range-slider-ready</h1>
<fieldset>
  <legend>Your budget (per night)</legend>
  <div>
    <div id="range-caption">10 - 400+</div>
    <fieldset>
      <div role="group" style="position:relative;width:200px;height:32px">
        <input type="range" aria-label="Min." min="10" max="390" step="10" value="10"
          style="opacity:0;width:1px;height:1px;position:absolute;left:0;top:0">
        <input type="range" aria-label="Max." min="20" max="400" step="10" value="400"
          style="opacity:0;width:1px;height:1px;position:absolute;left:0;top:0">
        <div role="none" style="position:absolute;left:0;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
        <div role="none" style="position:absolute;right:0;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
      </div>
    </fieldset>
  </div>
</fieldset>
<div id="range-status">none</div>
<!-- A hidden range input whose only boxed ancestor is page-sized: the proxy
     would swallow any overlay drawn inside it, so it must stay unlisted. -->
<section style="height:400px">
  <div style="position:relative;height:0">
    <input type="range" aria-label="Orphan" min="0" max="10" value="5"
      style="opacity:0;width:1px;height:1px;position:absolute;left:0;top:0">
  </div>
</section>
<script>
  var inputs = document.querySelectorAll('input[type=range]');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('change', function (e) {
      document.getElementById('range-status').textContent = e.target.getAttribute('aria-label') + '=' + e.target.value;
    });
  }
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/aria-slider")) {
      // Non-native sliders (role=slider on a focusable div) that keep their
      // value in script state, the way custom widgets do: setting the
      // attribute does nothing, only a keydown moves them (step 25, Home/End,
      // clamped). "Minimum" reads e.key; "Maximum" reads ONLY e.keyCode, which
      // a constructed KeyboardEvent leaves at 0, so it proves the presses are
      // trusted CDP events. "Fine step" (step 1) makes the press cap bite,
      // "Stuck" ignores keys, "Locked" is aria-disabled and must be unlisted.
      res.end(`<!doctype html>
<title>ARIA Slider</title>
<h1 id="ready">aria-slider-ready</h1>
<fieldset>
  <legend>Price range</legend>
  <div class="track" style="position:relative;width:300px;height:32px">
    <div id="s-min" role="slider" tabindex="0" aria-label="Minimum" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="100"
      style="position:absolute;left:0;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
    <div id="s-max" role="slider" tabindex="0" aria-label="Maximum" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="900"
      style="position:absolute;left:40px;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
  </div>
</fieldset>
<div style="position:relative;height:60px">
  <div id="s-fine" role="slider" tabindex="0" aria-label="Fine step" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="0"
    style="position:absolute;left:0;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
  <div id="s-nopage" role="slider" tabindex="0" aria-label="No page keys" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="0"
    style="position:absolute;left:30px;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
  <div id="s-offgrid" role="slider" tabindex="0" aria-label="Off grid" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="137"
    style="position:absolute;left:60px;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
 <div id="s-free" role="slider" tabindex="0" aria-label="Free" aria-valuenow="500"
    style="position:absolute;left:150px;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
  <div id="s-arrows" role="slider" tabindex="0" aria-label="Arrows only" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="900"
    style="position:absolute;left:180px;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
  <div id="s-marks" role="slider" tabindex="0" aria-label="Marks" aria-valuemin="0" aria-valuemax="100" aria-valuenow="37"
    style="position:absolute;left:210px;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
  <div id="s-nonsnap" role="slider" tabindex="0" aria-label="Non snapping" aria-valuemin="0" aria-valuemax="100" aria-valuenow="37"
    style="position:absolute;left:240px;top:8px;width:16px;height:16px;border-radius:8px;background:#06c"></div>
  <div id="s-stuck" role="slider" tabindex="0" aria-label="Stuck" aria-valuemin="0" aria-valuemax="100000" aria-valuenow="500"
    aria-valuetext="five hundred euros" style="position:absolute;left:90px;top:8px;width:16px;height:16px;border-radius:8px;background:#c60"></div>
  <div id="s-locked" role="slider" tabindex="0" aria-disabled="true" aria-label="Locked" aria-valuemin="0" aria-valuemax="10" aria-valuenow="5"
    style="position:absolute;left:120px;top:8px;width:16px;height:16px;border-radius:8px;background:#999"></div>
</div>
<input id="r-disabled" type="range" aria-label="Disabled slider" min="0" max="100" value="30" disabled>
<fieldset disabled><input id="r-fs-disabled" type="range" aria-label="Fieldset disabled slider" min="0" max="100" value="40"></fieldset>
<!-- A text input that merely carries role=slider: the input branch's value
     privacy (cc-* autocomplete) must win over the slider rules. -->
 <div><span>Coarse control</span><input id="r-coarse" type="range" aria-label="Coarse" min="0" max="100" step="50" value="0"></div>
<input id="r-card" type="text" role="slider" autocomplete="cc-number" aria-label="Card slider" value="4111111111111111">
<div id="aria-status">none</div>
<div style="height:4000px"></div>
<script>
  window.__keydowns = 0;
  var byKey = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, Home: 'min', End: 'max' };
  var byCode = { 39: 1, 38: 1, 37: -1, 40: -1, 36: 'min', 35: 'max' };
  // pageStep: PageUp/PageDown move by that much (0 = widget has no page keys).
  // snap: arrows land on the step grid (off-grid start 137 -> 140, not 147).
  function bind(id, step, useKeyCode, pageStep, snap, arrowsOnly) {
    var el = document.getElementById(id);
    el.addEventListener('keydown', function (e) {
      window.__keydowns++;
      var act = useKeyCode ? byCode[e.keyCode] : byKey[e.key];
      if (arrowsOnly && typeof act === 'string') act = undefined;
      if (act === undefined && pageStep) act = { PageUp: pageStep, PageDown: -pageStep }[e.key];
      if (act === undefined) return;
      // A bound the widget does not declare is unbounded (Infinity).
      var min = el.hasAttribute('aria-valuemin') ? +el.getAttribute('aria-valuemin') : -Infinity;
      var max = el.hasAttribute('aria-valuemax') ? +el.getAttribute('aria-valuemax') : Infinity;
      var v = +el.getAttribute('aria-valuenow');
      var next = v + act * (Math.abs(act) === 1 ? step : 1);
      if (snap && Math.abs(act) === 1) next = act > 0 ? (Math.floor(v / step) + 1) * step : (Math.ceil(v / step) - 1) * step;
      v = act === 'min' ? min : act === 'max' ? max : Math.min(max, Math.max(min, next));
      el.setAttribute('aria-valuenow', String(v));
      document.getElementById('aria-status').textContent = el.getAttribute('aria-label') + '=' + v;
      e.preventDefault();
    });
  }
  bind('s-min', 25, false, 0, false);
  bind('s-max', 25, true, 0, false);
  bind('s-fine', 1, false, 100, false);
  bind('s-nopage', 1, false, 0, false);
  bind('s-offgrid', 10, false, 0, true);
  bind('s-nonsnap', 25, false, 0, false);
  bind('s-free', 10, false, 0, false, true);
  bind('s-arrows', 5, false, 0, false, true);
  // Marks only: arrows jump between the stops 0 / 26 / 37 / 100.
  (function () {
    var marks = [0, 26, 37, 100], el = document.getElementById('s-marks');
    el.addEventListener('keydown', function (e) {
      window.__keydowns++;
      var d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (d === undefined) return;
      var i = Math.max(0, Math.min(marks.length - 1, marks.indexOf(+el.getAttribute('aria-valuenow')) + d));
      el.setAttribute('aria-valuenow', String(marks[i]));
      e.preventDefault();
    });
  })();
  document.getElementById('s-stuck').addEventListener('keydown', function () { window.__keydowns++; });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/aria-cards")) {
      // Three bare ARIA sliders (no aria-label, no legend or labelled group),
      // each alone in a card. Title before the slider, title AFTER it (the
      // layout of a component gallery), and a third with tick labels only
      // ("0\u00b0C") that must not become context. No id/aria-label on the
      // sliders: a slider with a label of its own gets no nearby-text context.
      const slider = (id: string, now: number) =>
        `<div data-card="${id}" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${now}" style="width:200px;height:16px;border:1px solid #06c"></div>`;
      res.end(`<!doctype html>
<title>ARIA Cards</title>
<h1 id="ready">aria-cards-ready</h1>
<div class="card" style="margin:12px"><h3>Volume</h3>${slider("c1", 30)}<span>0\u00b0C</span> <span>37\u00b0C</span><p>Adjust the output level</p></div>
<div class="card" style="margin:12px">${slider("c2", 40)}<span>0\u00b0C</span> <span>37\u00b0C</span><section><b>Graduated slider</b><p>Marks description</p></section></div>
<div class="card" style="margin:12px"><div>${slider("c4", 20)}${slider("c5", 60)}</div><section><b>Range demo</b><p>Two handles</p></section></div>
<div class="card" style="margin:12px"><h3>Budget</h3>${slider("c6", 70)}<span>Up to \u20ac400</span></div>
<div class="card" style="margin:12px"><h3>Brightness</h3>${slider("c3", 50)}<span>0\u00b0C</span> <span>37\u00b0C</span><span>100</span></div>`);
      return;
    }
    if (req.url && req.url.startsWith("/aria-header")) {
      // One bare slider under a site header/nav: the header is page
      // furniture, never the slider's context.
      res.end(`<!doctype html>
<title>ARIA Header</title>
<h1 id="ready">aria-header-ready</h1>
<header><nav><a href="#">Acme Store Home</a> <a href="#">Pricing plans</a></nav></header>
<main><div role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="30" style="width:200px;height:16px;border:1px solid #06c"></div></main>`);
      return;
    }
    if (req.url && req.url.startsWith("/long-list")) {
      // Hacker News shape: 150 dense 20px rows of 6 links each, far more
      // than the 120 cap inside the viewport alone. The table used to keep
      // the 120 nearest the viewport CENTRE, which dropped the top rows —
      // the first thing a user sees — and listed them out of page order.
      const rows = Array.from(
        { length: 150 },
        (_, r) =>
          `<div style="height:20px;white-space:nowrap">` +
          Array.from({ length: 6 }, (_, c) => `<a href="#r${r}c${c}">Row ${r} link ${c}</a>`).join(" ") +
          `</div>`,
      ).join("\n");
      res.end(`<!doctype html><title>Long List</title><style>body{margin:0}h1{margin:0;height:20px;font-size:14px}</style>
<h1 id="ready">long-list-ready</h1>${rows}`);
      return;
    }
    if (req.url && req.url.startsWith("/reveal-strip")) {
      // Google Flights' calendar shape: a horizontal strip of month panels in
      // an overflow-x container. The first panel's buttons are already fully
      // visible; the site's own scroll handler snaps the strip back to 0
      // ~200ms after ANY scroll. A reveal that centres a visible button
      // would scroll the strip, so the trusted click (computed in between)
      // would land on the moved/snapped layout. #max-scroll records the
      // furthest scrollLeft ever seen.
      res.end(`<!doctype html>
<title>Reveal strip</title>
<style>
  body { margin: 0; }
  #strip { width: 500px; overflow-x: auto; white-space: nowrap; }
  .month { display: inline-block; width: 500px; vertical-align: top; }
  .month button { margin: 8px; padding: 8px 16px; }
</style>
<h1 id="ready">reveal-strip-ready</h1>
<div id="strip">
  <div class="month"><button id="d1">Day One</button><button id="d2">Day Two</button></div>
  <div class="month"><button id="d3">Day Three</button></div>
  <div class="month"><button id="d4">Day Four</button></div>
</div>
<div id="chosen">none</div>
<div id="max-scroll">0</div>
<script>
  var strip = document.getElementById("strip");
  var max = 0;
  strip.addEventListener("scroll", function () {
    if (strip.scrollLeft > max) max = strip.scrollLeft;
    document.getElementById("max-scroll").textContent = String(max);
    setTimeout(function () { strip.scrollLeft = 0; }, 200);
  });
  document.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function () { document.getElementById("chosen").textContent = b.id; });
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/reveal-fold")) {
      res.end(`<!doctype html>
<title>Reveal fold</title>
<h1 id="ready">reveal-fold-ready</h1>
<div style="height:3000px">spacer</div>
<button id="below">Below Fold</button>
<div id="chosen">none</div>
<script>
  document.getElementById("below").addEventListener("click", function () {
    document.getElementById("chosen").textContent = "below";
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/autocomplete")) {
      // Google Flights "Where to?" shape: a combobox whose role=option
      // suggestions arrive ~400ms AFTER the input event (a debounced fetch),
      // so a snapshot taken right after typing sees none unless the
      // controller waits for them. Like Google Flights, focusing the field
      // shows a "popular destinations" list at once; it stays (perfectly
      // stable) until the real suggestions replace it, so "the list stopped
      // changing" alone would end the wait on the stale list. #plain is an
      // ordinary input.
      res.end(`<!doctype html>
<title>Autocomplete</title>
<h1 id="ready">autocomplete-ready</h1>
<input id="to" role="combobox" aria-autocomplete="list" aria-controls="lb" aria-expanded="false" aria-label="Where to?">
<ul id="lb" role="listbox" aria-label="Suggestions" style="list-style:none;margin:0;padding:0"></ul>
<input id="plain" aria-label="Plain field">
<script>
  var timer = 0;
  document.getElementById("to").addEventListener("focus", function () {
    var lb = document.getElementById("lb");
    lb.innerHTML = "";
    ["Paris, France", "London, United Kingdom", "New York, United States"].forEach(function (label) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      li.style.padding = "6px";
      li.textContent = label;
      lb.appendChild(li);
    });
  });
  document.getElementById("to").addEventListener("input", function (e) {
    clearTimeout(timer);
    var value = e.target.value;
    timer = setTimeout(function () {
      var lb = document.getElementById("lb");
      lb.innerHTML = "";
      if (value.toLowerCase().indexOf("barc") !== 0) return;
      ["Barcelona, Spain", "Barcelona El Prat Airport"].forEach(function (label) {
        var li = document.createElement("li");
        li.setAttribute("role", "option");
        li.style.padding = "6px";
        li.textContent = label;
        lb.appendChild(li);
      });
      e.target.setAttribute("aria-expanded", "true");
    }, 400);
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/late-effect")) {
      // Google Flights' calendar shape: a modal dialog whose "Done" hides it
      // ~300ms AFTER the click (a CSS-transition-like setTimeout), with the
      // page's own controls (#search) behind it. #late is a plain button
      // outside any dialog whose effect also lands after 300ms; #day is a
      // dialog control that is not dismissing and changes the page at once.
      res.end(`<!doctype html>
<title>Late effect</title>
<h1 id="ready">late-effect-ready</h1>
<button id="search">Search flights</button>
<button id="late">Apply filter</button>
<div id="dlg" role="dialog" aria-modal="true" aria-label="Dates" style="position:fixed;inset:0;background:#fff;z-index:10">
  <button id="day">Pick day 12</button>
  <button id="closest" aria-label="Closest airports">Nearby</button>
  <button id="done">Done</button>
</div>
<script>
  document.getElementById("done").addEventListener("click", function () {
    setTimeout(function () { document.getElementById("dlg").style.display = "none"; }, 300);
  });
  document.getElementById("day").addEventListener("click", function () {
    document.getElementById("day").setAttribute("aria-selected", "true");
  });
  document.getElementById("closest").addEventListener("click", function () {
    document.getElementById("closest").setAttribute("aria-selected", "true");
  });
  document.getElementById("late").addEventListener("click", function () {
    setTimeout(function () {
      document.getElementById("late").setAttribute("aria-expanded", "true");
    }, 300);
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/shadow-dialog")) {
      // A role=dialog wrapper with display:contents (no box of its own) living
      // in an open shadow root; its panel's "Done" hides it ~300ms after the
      // click. The controller must find the dialog through the shadow root
      // and must not read the wrapper's zero rect as "already closed".
      res.end(`<!doctype html>
<title>Shadow dialog</title>
<h1 id="ready">shadow-dialog-ready</h1>
<button id="search">Search flights</button>
<div id="host"></div>
<script>
  var root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML =
    '<div role="dialog" aria-modal="true" aria-label="Dates" style="display:contents">' +
    '<div id="panel" style="position:fixed;inset:0;background:#fff;z-index:10">' +
    '<button id="done">Done</button></div></div>';
  root.getElementById("done").addEventListener("click", function () {
    setTimeout(function () { root.getElementById("panel").style.display = "none"; }, 300);
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/focus-overlay")) {
      // Google Flights' "Where from?" shape. ?mode=sync|async: clicking #from
      // opens a fixed overlay covering it and focuses a DIFFERENT input in
      // it (synchronously, or late — see the select listener). ?mode=none: a plain input. The
      // overlay input renders a suggestion on input, like a real combobox;
      // #from must stay empty. #a/#b: two plain fields for the "don't
      // retarget into the previously focused one" regression.
      res.end(`<!doctype html>
<title>Focus overlay</title>
<h1 id="ready">focus-overlay-ready</h1>
<input id="from" aria-label="Where from?" placeholder="Where from?">
<input id="a" aria-label="Field A"><input id="b" aria-label="Field B">
<div id="overlay" style="display:none;position:fixed;inset:0;background:#fff;z-index:10">
  <input id="overlay-input" aria-label="Where from search">
  <div id="suggest"></div>
</div>
<script>
  var mode = new URLSearchParams(location.search).get("mode") || "none";
  var overlayInput = document.getElementById("overlay-input");
  overlayInput.addEventListener("input", function () {
    document.getElementById("suggest").textContent =
      overlayInput.value.toLowerCase().indexOf("berl") === 0 ? "Berlin, Germany" : "";
  });
  document.getElementById("from").addEventListener("click", function () {
    if (mode === "none") return;
    document.getElementById("overlay").style.display = "block";
    if (mode === "sync") overlayInput.focus();
  });
  // async: the focus move lands late — synchronously inside the
  // controller's select-all step on #from (el.select() is wrapped), i.e.
  // between SELECT_ALL_CONTENT_JS and Input.insertText, like a high-latency
  // cloud browser. Deterministic, unlike a timer race. #from is prefilled so
  // "unchanged" is checkable.
  if (mode === "async") {
    var from = document.getElementById("from");
    from.value = "Munich";
    from.select = function () {
      HTMLInputElement.prototype.select.call(from);
      overlayInput.focus();
    };
  }
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/aria-calendar")) {
      // Google Flights' date picker shape: a scrolling list of months, each
      // day a role=gridcell (past days aria-hidden) wrapping a role=button
      // whose only text is the bare day number; the real name sits on a
      // grandchild's aria-label. Only November is scrolled into view.
      const months = [
        ["October", 31],
        ["November", 30],
        ["December", 31],
        ["January", 31],
        ["February", 28],
        ["March", 31],
        ["April", 30],
        ["May", 31],
        ["June", 30],
        ["July", 31],
        ["August", 31],
        ["September", 30],
      ] as const;
      const grid = months
        .map(
          ([m, n]) =>
            `<div role="rowgroup" style="height:120px;display:grid;grid-template-columns:repeat(8,28px)">` +
            Array.from({ length: n }, (_, i) => {
              const d = i + 1;
              const past = m === "October" && d < 20;
              return (
                `<div role="gridcell" aria-selected="false"${past ? ' aria-hidden="true"' : ""} data-day="${m} ${d}" style="height:14px">` +
                `<div role="button" tabindex="-1"><div aria-label="${m} ${d}, 2026">${d}</div></div></div>`
              );
            }).join("") +
            `</div>`,
        )
        .join("");
      res.end(`<!doctype html>
<title>ARIA Calendar</title>
<h1 id="ready">aria-calendar-ready</h1>
<input type="text" aria-label="Departure" placeholder="Departure">
<div id="scroller" role="grid" style="height:${req.url.includes("tall") ? 720 : 120}px;overflow-y:auto;width:260px;border:1px solid #999">${grid}</div>
<button id="done" onclick="this.textContent='Confirmed'">Done</button>
<p id="chosen-day">none</p>
<script>
  document.getElementById('scroller').scrollTop = 120;
  document.querySelectorAll('[role=gridcell]').forEach(function (c) {
    c.addEventListener('click', function () {
      document.getElementById('chosen-day').textContent = c.getAttribute('data-day');
    });
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/aria-listbox")) {
      // Google Flights shape: a custom combobox whose options are
      // role=option items (not a native <select>), plus a date grid of
      // role=gridcell days (past days aria-disabled) and a role=switch.
      res.end(`<!doctype html>
<title>ARIA Listbox</title>
<h1 id="ready">aria-listbox-ready</h1>
<div id="trip" role="combobox" tabindex="0" aria-expanded="false" aria-controls="trip-list" aria-label="Trip type"
  style="display:inline-block;padding:6px;border:1px solid #999">Round trip</div>
<ul id="trip-list" role="listbox" style="display:none;list-style:none;margin:0;padding:0;border:1px solid #999;width:160px">
  <li role="option" aria-selected="true" style="padding:6px">Round trip</li>
  <li role="option" aria-selected="false" style="padding:6px">One way</li>
  <li role="option" aria-selected="false" aria-disabled="true" style="padding:6px">Multi-city</li>
</ul>
<div role="switch" tabindex="0" aria-checked="true" aria-label="Nonstop only" style="width:40px;height:20px;border:1px solid #999"></div>
<div role="grid" aria-label="November 2026" style="display:grid;grid-template-columns:repeat(7,32px)">
  ${Array.from({ length: 14 }, (_, i) => {
    const d = i + 1;
    return `<div role="gridcell" tabindex="-1" aria-selected="false"${d < 10 ? ' aria-disabled="true"' : ""} aria-label="November ${d}, 2026" style="height:24px">${d}</div>`;
  }).join("")}
</div>
<p id="chosen-date">none</p>
<script>
  var trip = document.getElementById('trip');
  var list = document.getElementById('trip-list');
  trip.addEventListener('click', function () {
    var open = list.style.display === 'none';
    list.style.display = open ? 'block' : 'none';
    trip.setAttribute('aria-expanded', String(open));
  });
  list.querySelectorAll('[role=option]').forEach(function (o) {
    o.addEventListener('click', function () {
      if (o.getAttribute('aria-disabled') === 'true') return;
      list.querySelectorAll('[role=option]').forEach(function (x) { x.setAttribute('aria-selected', String(x === o)); });
      trip.textContent = o.textContent;
      list.style.display = 'none';
      trip.setAttribute('aria-expanded', 'false');
    });
  });
  document.querySelectorAll('[role=gridcell]').forEach(function (c) {
    c.addEventListener('click', function () {
      if (c.getAttribute('aria-disabled') === 'true') return;
      c.setAttribute('aria-selected', 'true');
      document.getElementById('chosen-date').textContent = c.getAttribute('aria-label');
    });
  });
</script>`);
      return;
    }
    if (req.url && req.url.startsWith("/botcheck")) {
      // Wave 3 reliability item 4: title + body text matching the botCheck
      // heuristic's regex.
      res.end(`<!doctype html>
<title>Just a moment...</title>
<h1 id="ready">botcheck-ready</h1>
<p>Checking if the site connection is secure. This may take a moment.</p>`);
      return;
    }
    // Default: stub editor page, same shape as e2e/smoke.spec.ts's.
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>
        if (window.penDesktop) {
          window.penDesktop.setDocumentTitle('Stub');
        }
      </script>`);
  });
  // Wave 3 reliability item 2: the cross-origin/OOPIF fixture server, on a
  // different port AND a different host ("localhost" vs the main server's
  // "127.0.0.1") — genuinely different origins, so a child frame pointing
  // at it is a real cross-origin (and, under Chromium's default site
  // isolation, out-of-process) frame, not just a different port.
  crossOriginServer = http.createServer((_req, res) => {
    res.end(`<!doctype html>
<title>Cross-Origin Frame</title>
<button id="cross-btn">Cross Button</button>
<div id="cross-result">not-clicked</div>
<p>cross-origin frame text digest</p>
<script>
  document.getElementById('cross-btn').addEventListener('click', function () {
    document.getElementById('cross-result').textContent = 'cross-clicked';
  });
</script>`);
  });
  await new Promise<void>((resolve) => crossOriginServer.listen(0, "localhost", resolve));
  crossOriginBaseUrl = `http://localhost:${(crossOriginServer.address() as AddressInfo).port}`;
  crossOriginFrameUrl = `${crossOriginBaseUrl}/wave3-cross-frame`;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  galleryUrl = `${baseUrl}/gallery`;
  nextUrl = `${baseUrl}/gallery/next`;
  snapshotUrl = `${baseUrl}/snapshot`;
  snapshotManyUrl = `${baseUrl}/snapshot-many`;
  snapshotManyWithFrameUrl = `${baseUrl}/snapshot-many-with-frame`;
  clickTargetUrl = `${baseUrl}/click-target`;
  evidenceUrl = `${baseUrl}/evidence`;
  sideEffectUrl = `${baseUrl}/side-effect`;
  tickerUrl = `${baseUrl}/ticker`;
  removalUrl = `${baseUrl}/removal`;
  selfDisableUrl = `${baseUrl}/self-disable`;
  readUrl = `${baseUrl}/read`;
  imagesMetaUrl = `${baseUrl}/images-meta`;
  slowLoadUrl = `${baseUrl}/slow-load`;
  interactUrl = `${baseUrl}/interact`;
  autoAlertUrl = `${baseUrl}/auto-alert`;
  smoothScrollUrl = `${baseUrl}/smooth-scroll`;
  wave2Url = `${baseUrl}/wave2`;
  wave3Url = `${baseUrl}/wave3`;
  reachModalUrl = `${baseUrl}/reach-modal`;
  reachOverlayUrl = `${baseUrl}/reach-overlay`;
  reachCheckboxUrl = `${baseUrl}/reach-checkbox`;
  reachBarUrl = `${baseUrl}/reach-bar`;
  reachPortalUrl = `${baseUrl}/reach-portal`;
  reachToastUrl = `${baseUrl}/reach-toast`;
  reachStaleUrl = `${baseUrl}/reach-stale`;
  remountUrl = `${baseUrl}/remount`;
  remountDupUrl = `${baseUrl}/remount?dup=1`;
  reachBannerUrl = `${baseUrl}/reach-banner`;
  wave3FrameUrl = `${baseUrl}/wave3-frame`;
  botCheckUrl = `${baseUrl}/botcheck`;
  rangeSliderUrl = `${baseUrl}/range-slider`;
  ariaSliderUrl = `${baseUrl}/aria-slider`;
  ariaCardsUrl = `${baseUrl}/aria-cards`;
  ariaHeaderUrl = `${baseUrl}/aria-header`;
  longListUrl = `${baseUrl}/long-list`;
  ariaListboxUrl = `${baseUrl}/aria-listbox`;
  ariaCalendarUrl = `${baseUrl}/aria-calendar`;
  revealStripUrl = `${baseUrl}/reveal-strip`;
  revealFoldUrl = `${baseUrl}/reveal-fold`;
  focusOverlayUrl = `${baseUrl}/focus-overlay`;
  autocompleteUrl = `${baseUrl}/autocomplete`;
  lateEffectUrl = `${baseUrl}/late-effect`;
  shadowDialogUrl = `${baseUrl}/shadow-dialog`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => crossOriginServer.close(() => r()));
});

type BrowserBridge = {
  open(args: { url: string }): Promise<unknown>;
  act(args: Record<string, unknown>): Promise<unknown>;
  findImages(args: Record<string, unknown>): Promise<unknown>;
  snapshot(): Promise<unknown>;
  perform(args: Record<string, unknown>): Promise<unknown>;
  read(args?: Record<string, unknown>): Promise<unknown>;
  screenshot(args?: Record<string, unknown>): Promise<unknown>;
  tabs(args: Record<string, unknown>): Promise<unknown>;
};

/** "Addendum 2, 2026-09-19" §1 — merged into act/perform results alongside
 * whatever they already returned. */
interface EffectEvidence {
  changed: boolean;
  changes: string[];
  /** Browse-speed contract (2026-09-24), report-only. */
  pageChanged?: boolean;
  appeared?: string[];
}

function callBrowser<K extends keyof BrowserBridge>(
  page: Page,
  method: K,
  args?: Parameters<BrowserBridge[K]>[0],
): Promise<unknown> {
  return page.evaluate(
    ({ method, args }) =>
      (window as unknown as { penDesktop: { browser: BrowserBridge } }).penDesktop.browser[
        method as keyof BrowserBridge
      ](args as never),
    { method, args },
  );
}

interface SnapshotElement {
  index: number;
  tag: string;
  role?: string;
  label: string;
  /** Addendum D: only present for a non-password input[type=text],
   * input[type=search], or textarea whose autocomplete isn't sensitive. */
  value?: string;
  /** Addendum D: present instead of `value` for every other input (and a
   * <select>, which also reports its chosen option as `value`). */
  hasValue?: boolean;
  /** A checkbox/radio's state — reported instead of `hasValue`. */
  checked?: boolean;
  ops: string[];
  options?: string[];
  /** Only ever present, and only ever true, for a password input. */
  isPassword?: boolean;
  /** Wave 2 reliability item 4/5: present and true only on an ADD entry for
   * a scrollable container (never on a real interactive element). */
  scrollable?: boolean;
  /** Wave 3 reliability item 2: present only on an element merged in from a
   * child frame — the frame's own title/name/host. */
  frame?: string;
}

interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  scroll: { y: number; height: number; atBottom: boolean };
  snapshotId: string;
  /** Present only when SNAPSHOT_JS scoped the table to a modal layer. */
  modal?: string;
  /** Visible viewport text, ≤6000 chars. */
  text?: string;
}

interface FoundImage {
  url: string;
  alt: string;
  width: number;
  height: number;
  /** BROWSE-01: intrinsic size, alongside the rendered width/height above.
   * Review finding 5: omitted (not just absent-but-zero) when the returned
   * URL is neither the loaded resource nor carries a declared "w" width. */
  naturalWidth?: number;
  naturalHeight?: number;
}

interface FindImagesResult {
  images: FoundImage[];
  count: number;
  pageUrl: string;
}

interface ReadResult {
  url: string;
  title: string;
  headings: string[];
  text: string;
  links: { label: string; href: string }[];
  /** Text-cap truncation only — see headingsTruncated/linksTruncated below
   * (review finding 8) for the two collection caps. */
  truncated: boolean;
  headingsTruncated?: boolean;
  linksTruncated?: boolean;
  error?: string;
}

test("built-in browser tab: open, findImages, act (click/type/scroll/back/forward) against a real DOM", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery") });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");
    const tabbarPage =
      app.windows().find((page) => page.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (page) => page.url().endsWith("/tabbar/tabbar.html") }));

    // --- open: creates the browser tab (no prior tab existed) and navigates it ---
    const [galleryPage, openResult] = await Promise.all([
      app.waitForEvent("window", {
        predicate: (p) => p !== editorPage && p !== tabbarPage && !p.url().endsWith("/tabbar/tabbar.html"),
      }),
      callBrowser(editorPage, "open", { url: galleryUrl }),
    ]);
    // The gallery fixture's only images are small same-origin SVGs, so the
    // full load settles comfortably inside the grace period — `loaded: true`
    // is what distinguishes it from a page like /slow-load below (dedicated
    // test) whose subresource never finishes.
    expect(openResult).toEqual({ url: galleryUrl, title: "Gallery", loaded: true });
    await expect(galleryPage.locator("#ready")).toHaveText("gallery-ready");

    // The browser tab has no preload at all — the security boundary design
    // doc §1 requires (a browser tab must never see penDesktop).
    expect(
      await galleryPage.evaluate(() => typeof (window as unknown as { penDesktop?: unknown }).penDesktop),
    ).toBe("undefined");

    // The address row reflects the real navigation (design doc §2/§5).
    await expect
      .poll(() => tabbarPage.locator("#url-input").inputValue())
      .toBe(galleryUrl);
    await expect(tabbarPage.locator("#chrome-row")).toBeVisible();

    // --- findImages: default 200x200 filter excludes the 100x80 thumbnail ---
    const defaultImages = (await callBrowser(editorPage, "findImages", {})) as {
      images: { url: string; alt: string; width: number; height: number }[];
      count: number;
      pageUrl: string;
    };
    expect(defaultImages.pageUrl).toBe(galleryUrl);
    // The page's largest image by far is the 900x900 data: URI — finding 8:
    // FIND_IMAGES_JS only returns http(s) URLs, so it must be excluded
    // outright (not merely sorted after the real images), leaving count 2
    // rather than 3 and nothing in the results larger than the 500x350
    // background image.
    expect(defaultImages.count).toBe(2);
    expect(defaultImages.images.some((i) => i.url.startsWith("data:"))).toBe(false);
    expect(defaultImages.images.some((i) => i.alt === "Data URI")).toBe(false);
    // Sorted by rendered area descending: the 500x350 background image (175000) before the 400x300 img (120000).
    expect(defaultImages.images[0]).toMatchObject({ width: 500, height: 350 });
    expect(defaultImages.images[1]).toMatchObject({ width: 400, height: 300, alt: "Large photo" });
    expect(defaultImages.images.every((i) => i.url.startsWith(baseUrl))).toBe(true);

    // --- findImages: a looser filter picks up the small thumbnail too ---
    const looseImages = (await callBrowser(editorPage, "findImages", { minWidth: 50, minHeight: 50 })) as {
      count: number;
    };
    expect(looseImages.count).toBe(3);

    // --- findImages: limit is respected ---
    const limited = (await callBrowser(editorPage, "findImages", { minWidth: 50, minHeight: 50, limit: 1 })) as {
      count: number;
      images: unknown[];
    };
    expect(limited.count).toBe(1);
    expect(limited.images).toHaveLength(1);

    // --- act click: locates "Load More" by visible text, clicks it, and the real page mutates ---
    // Finding 3: the button is nested two wrapper divs deep
    // (#wrap-outer > #wrap-inner > #load-more), and all three elements
    // share the exact same trimmed textContent ("Load More") — a
    // document-order first-match scan would pick #wrap-outer, whose
    // el.click() never reaches the button's own listener (a synthetic
    // click only bubbles up through ancestors, never down into
    // descendants), so the page would never mutate and this assertion
    // would fail under the old behavior even though the command itself
    // reported success.
    const clickResult = (await callBrowser(editorPage, "act", { action: "click", target: "Load More" })) as {
      matched: string;
    };
    expect(clickResult.matched).toBe("Load More");
    await expect(galleryPage).toHaveTitle("Loaded");
    const afterClickImages = (await callBrowser(editorPage, "findImages", { minWidth: 550, minHeight: 550 })) as {
      count: number;
      images: { width: number; height: number; alt: string }[];
    };
    expect(afterClickImages.count).toBe(1);
    expect(afterClickImages.images[0]).toMatchObject({ width: 600, height: 600, alt: "Loaded photo" });

    // --- act click: an unmatched target reports what was not found, without throwing ---
    const missResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "Definitely Not On This Page",
    })) as { error?: string };
    expect(missResult.error).toContain("Definitely Not On This Page");

    // --- act type: sets the input's value via a real DOM `input` event ---
    const typeResult = (await callBrowser(editorPage, "act", {
      action: "type",
      target: "#query",
      text: "sunset skyline",
    })) as { matched: string };
    expect(typeResult.matched).toBe("#query");
    await expect(galleryPage.locator("#query")).toHaveValue("sunset skyline");
    expect(await galleryPage.evaluate(() => (window as unknown as { __typedValues: string[] }).__typedValues)).toContain(
      "sunset skyline",
    );

    // --- act scroll: really scrolls the real page ---
    const beforeScroll = await galleryPage.evaluate(() => window.scrollY);
    await callBrowser(editorPage, "act", { action: "scroll", amount: 1 });
    await expect.poll(() => galleryPage.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll);

    // --- open again (same tab) to build navigation history, then act back/forward ---
    const secondOpen = (await callBrowser(editorPage, "open", { url: nextUrl })) as {
      url: string;
      title: string;
      loaded: boolean;
    };
    expect(secondOpen).toEqual({ url: nextUrl, title: "Gallery Next", loaded: true });
    await expect(galleryPage).toHaveURL(nextUrl);

    const backResult = (await callBrowser(editorPage, "act", { action: "back" })) as { url: string };
    expect(backResult.url).toBe(galleryUrl);
    await expect(galleryPage).toHaveURL(galleryUrl);

    const forwardResult = (await callBrowser(editorPage, "act", { action: "forward" })) as { url: string };
    expect(forwardResult.url).toBe(nextUrl);
    await expect(galleryPage).toHaveURL(nextUrl);

    // --- Finding 5, exercised against the real tabbar page: a query
    // containing both a dot and whitespace ("figma.com alternatives") used
    // to be treated as a bare hostname (only "no dot AND no colon" routed
    // to search) and become a malformed "https://figma.com alternatives",
    // which new URL() rejects — a dead control. normalizeTypedUrl is a
    // real global in the tabbar page's own DOM (urlNormalization.js, loaded
    // before renderer.js), so this calls the actual shipped script, not a
    // Node-side reimplementation.
    const normalizedQuery = await tabbarPage.evaluate(() =>
      (window as unknown as { normalizeTypedUrl: (input: string) => string }).normalizeTypedUrl(
        "figma.com alternatives",
      ),
    );
    expect(normalizedQuery).toBe(
      "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent("figma.com alternatives"),
    );

    // --- Finding 9: focusing the address bar suppresses live updates (so
    // typing isn't clobbered mid-edit) — but blurring it must resync to
    // the tab's actual current url instead of leaving a stale value
    // indefinitely, e.g. after an agent-driven browse_open lands while the
    // user happens to have the address bar focused. ---
    const urlInputLocator = tabbarPage.locator("#url-input");
    await urlInputLocator.focus();
    await urlInputLocator.fill("mid-typing, should not be clobbered");
    const reopened = (await callBrowser(editorPage, "open", { url: galleryUrl })) as { url: string };
    expect(reopened.url).toBe(galleryUrl);
    // Still focused: must not have been overwritten by the state push the
    // navigation above triggered.
    await expect(urlInputLocator).toHaveValue("mid-typing, should not be clobbered");
    // Blur: must resync to the tab's real (new) url, not stay stale.
    await urlInputLocator.blur();
    await expect(urlInputLocator).toHaveValue(galleryUrl);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// The human cursor overlay (CLAUDE.md's "The human cursor overlay",
// pageScripts.ts's CURSOR_JS, controller.ts's moveCursor): an injected page
// script is not unit-testable — executeJavaScript is stubbed in the unit
// suites — so this is the only place a regression in CURSOR_JS itself would
// ever be caught. Reuses the gallery fixture and callBrowser machinery from
// the flow test above rather than adding new fixtures.
test("human cursor overlay: real, non-blocking, and follows the acted-on element", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery") });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");
    const tabbarPage =
      app.windows().find((page) => page.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (page) => page.url().endsWith("/tabbar/tabbar.html") }));

    const [galleryPage] = await Promise.all([
      app.waitForEvent("window", {
        predicate: (p) => p !== editorPage && p !== tabbarPage && !p.url().endsWith("/tabbar/tabbar.html"),
      }),
      callBrowser(editorPage, "open", { url: galleryUrl }),
    ]);
    await expect(galleryPage.locator("#ready")).toHaveText("gallery-ready");

    // --- act click on "Load More": moveCursor always runs before the
    // click's own before-signature capture (controller.ts's ordering
    // invariant), so by the time this resolves the overlay must already
    // exist and be parked on the clicked element. Both moveCursor and
    // CLICK_JS itself call scrollIntoView({block:"center"}) on the target,
    // so the element's rect must be read *after* the action settles, not
    // before — the page is 900px+ tall above #load-more (the datauri
    // fixture image), so scrollIntoView moves it substantially. ---
    const clickResult = (await callBrowser(editorPage, "act", { action: "click", target: "Load More" })) as {
      matched: string;
    };
    expect(clickResult.matched).toBe("Load More");
    const loadMoreRectAfter = await galleryPage
      .locator("#load-more")
      .evaluate((el) => el.getBoundingClientRect().toJSON());
    // --- assertion 4: the action itself still really works with the cursor in play ---
    await expect(galleryPage).toHaveTitle("Loaded");

    // --- assertion 1: the overlay exists and is real ---
    const overlayInfo = await galleryPage.evaluate(() => {
      const overlays = document.querySelectorAll("[data-pen-cursor]");
      const overlay = overlays[0] as HTMLElement | undefined;
      return {
        count: overlays.length,
        insideDocumentElement: !!overlay && document.documentElement.contains(overlay),
        hasSvg: !!overlay && overlay.querySelector("svg") !== null,
      };
    });
    expect(overlayInfo.count).toBe(1);
    expect(overlayInfo.insideDocumentElement).toBe(true);
    expect(overlayInfo.hasSvg).toBe(true);

    // --- assertion 2: it does not intercept clicks ---
    const nonBlocking = await galleryPage.evaluate(() => {
      const overlay = document.querySelector("[data-pen-cursor]") as HTMLElement;
      const svg = overlay.querySelector("svg") as SVGElement;
      const overlayStyle = getComputedStyle(overlay);
      const svgStyle = getComputedStyle(svg);
      const state = (window as unknown as { __penCursor: { pos: { x: number; y: number } } }).__penCursor;
      const atCursor = state.pos ? document.elementFromPoint(state.pos.x, state.pos.y) : null;
      return {
        overlayPointerEvents: overlayStyle.pointerEvents,
        svgPointerEvents: svgStyle.pointerEvents,
        overlayPosition: overlayStyle.position,
        overlayZIndex: overlayStyle.zIndex,
        // elementFromPoint at the cursor's own reported position must land
        // on real page content, never on the (click-through) overlay itself.
        elementAtCursorIsOutsideOverlay: !!atCursor && !overlay.contains(atCursor),
      };
    });
    expect(nonBlocking.overlayPointerEvents).toBe("none");
    expect(nonBlocking.svgPointerEvents).toBe("none");
    expect(nonBlocking.overlayPosition).toBe("fixed");
    // The max signed 32-bit int — CURSOR_JS's own sentinel, so the overlay
    // always wins the stacking context against real page content.
    expect(nonBlocking.overlayZIndex).toBe("2147483647");
    expect(nonBlocking.elementAtCursorIsOutsideOverlay).toBe(true);

    // --- assertion 3a: it actually moved to the first clicked element ---
    const posAfterClick = await galleryPage.evaluate(
      () => (window as unknown as { __penCursor: { pos: { x: number; y: number } } }).__penCursor.pos,
    );
    const loadMoreCenter = {
      x: loadMoreRectAfter.x + loadMoreRectAfter.width / 2,
      y: loadMoreRectAfter.y + loadMoreRectAfter.height / 2,
    };
    expect(Math.abs(posAfterClick.x - loadMoreCenter.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(posAfterClick.y - loadMoreCenter.y)).toBeLessThanOrEqual(3);

    // --- assertion 3b: a second action, on a target far from the first,
    // moves the overlay again rather than leaving it parked. #query sits
    // near the top of the page, well away from #load-more further down —
    // its rect (like #load-more's above) is read after the action, once
    // scrollIntoView has settled on its own final position. ---
    const typeResult = (await callBrowser(editorPage, "act", {
      action: "type",
      target: "#query",
      text: "sunset skyline",
    })) as { matched: string };
    expect(typeResult.matched).toBe("#query");
    // --- assertion 4 again, different action: typing still really lands ---
    await expect(galleryPage.locator("#query")).toHaveValue("sunset skyline");
    const queryRectAfter = await galleryPage.locator("#query").evaluate((el) => el.getBoundingClientRect().toJSON());

    // moveCursor is awaited inside act() before the click/type itself runs,
    // so by the time callBrowser's promise resolves the position should
    // already have settled — expect.poll here is a defensive margin against
    // any remaining cross-process timing, per this repo's convention that
    // expect.poll's callback must return a value rather than assert inline.
    await expect
      .poll(() =>
        galleryPage.evaluate(
          () => (window as unknown as { __penCursor: { pos: { x: number; y: number } } }).__penCursor.pos.x,
        ),
      )
      .not.toBe(posAfterClick.x);

    const posAfterType = await galleryPage.evaluate(
      () => (window as unknown as { __penCursor: { pos: { x: number; y: number } } }).__penCursor.pos,
    );
    const queryCenter = {
      x: queryRectAfter.x + queryRectAfter.width / 2,
      y: queryRectAfter.y + queryRectAfter.height / 2,
    };
    expect(Math.abs(posAfterType.x - queryCenter.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(posAfterType.y - queryCenter.y)).toBeLessThanOrEqual(3);

    // --- assertion 5: SNAPSHOT_JS and FIND_IMAGES_JS both guard against the
    // overlay ever showing up as an actionable element or a found image ---
    await callBrowser(editorPage, "snapshot");
    const overlayStampedBySnapshot = await galleryPage.evaluate(
      () => document.querySelectorAll("[data-pen-cursor] [data-pen-snap]").length,
    );
    expect(overlayStampedBySnapshot).toBe(0);

    const images = (await callBrowser(editorPage, "findImages", { minWidth: 0, minHeight: 0 })) as {
      images: { width: number; height: number; url: string }[];
    };
    // The overlay's own arrow SVG is 22x26 — a permissive filter (min 0x0)
    // would otherwise happily include it if the [data-pen-cursor] guard in
    // FIND_IMAGES_JS ever regressed.
    expect(images.images.some((img) => img.width === 22 && img.height === 26)).toBe(false);

    // --- assertion 6 (code review finding 4): the assertion above cannot
    // actually fail if the `closest("[data-pen-cursor]")` guards in
    // FIND_IMAGES_JS are ever deleted — the overlay's own bare <svg>/
    // <polygon> children are in neither document.images nor a
    // background-image selector, so nothing about them would ever be
    // *found* in the first place, guard or no guard. Give the overlay root
    // a genuine CSS background-image (a real box, served over http(s) by
    // this suite's own stub server, exactly like every other fixture image
    // here) so there is something for FIND_IMAGES_JS to actually find, then
    // prove the guard is what excludes it — restored immediately after so
    // later assertions in this file see the overlay exactly as before. ---
    const overlayBgUrl = pixelUrl("overlay-bg-guard-check");
    await galleryPage.evaluate((bgUrl) => {
      const overlay = document.querySelector("[data-pen-cursor]") as HTMLElement;
      overlay.style.width = "300px";
      overlay.style.height = "300px";
      overlay.style.backgroundImage = `url(${bgUrl})`;
    }, overlayBgUrl);
    try {
      const permissiveImages = (await callBrowser(editorPage, "findImages", { minWidth: 0, minHeight: 0 })) as {
        images: { width: number; height: number; url: string }[];
      };
      expect(permissiveImages.images.some((img) => img.url === overlayBgUrl)).toBe(false);
    } finally {
      await galleryPage.evaluate(() => {
        const overlay = document.querySelector("[data-pen-cursor]") as HTMLElement;
        overlay.style.backgroundImage = "";
        // CURSOR_JS's own overlay is always 0x0 (position:fixed, the arrow
        // is drawn by its absolutely-positioned children) — restore that,
        // not an empty string, which would instead fall back to the
        // browser's default `auto` sizing for a fixed-position element.
        overlay.style.width = "0px";
        overlay.style.height = "0px";
      });
    }

    // --- assertion 7 (code review finding 5): SNAPSHOT_JS's guard is
    // likewise unexercised by anything above — none of the overlay's
    // div/svg/polygon match INTERACTIVE_SELECTOR at all, so the
    // [data-pen-cursor] check in SNAPSHOT_JS's isVisible() never actually
    // runs against it. Make the overlay root genuinely snapshot-eligible
    // (a real role, a real size, a real label) for the duration of this
    // check, then prove it's still excluded by label and by the absence of
    // any data-pen-snap stamp inside it — restored immediately after. ---
    const guardLabel = "pen-cursor-guard-check-label";
    await galleryPage.evaluate((label) => {
      const overlay = document.querySelector("[data-pen-cursor]") as HTMLElement;
      overlay.setAttribute("role", "button");
      overlay.setAttribute("aria-label", label);
      overlay.style.width = "40px";
      overlay.style.height = "40px";
    }, guardLabel);
    try {
      const guardSnap = (await callBrowser(editorPage, "snapshot")) as { elements: { label: string; tag: string }[] };
      expect(guardSnap.elements.some((el) => el.label === guardLabel)).toBe(false);
      const guardStamped = await galleryPage.evaluate(
        () => document.querySelectorAll("[data-pen-cursor] [data-pen-snap]").length,
      );
      expect(guardStamped).toBe(0);
      const overlaySelfStamped = await galleryPage.evaluate(
        () => document.querySelector("[data-pen-cursor]")?.hasAttribute("data-pen-snap") ?? false,
      );
      expect(overlaySelfStamped).toBe(false);
    } finally {
      await galleryPage.evaluate(() => {
        const overlay = document.querySelector("[data-pen-cursor]") as HTMLElement;
        overlay.removeAttribute("role");
        overlay.removeAttribute("aria-label");
        overlay.style.width = "0px";
        overlay.style.height = "0px";
      });
    }

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// The new-tab focus fix: before this, File ▸ New Browser Tab produced a
// tab titled "New Tab" with a visible, empty, *unfocused* address row and a
// blank content area — no cue at all where to type. Drives the real
// application menu (not a stand-in IPC call, like the fixture's own
// #new-tab button would be) so this proves the actual user-facing path:
// Menu.getApplicationMenu() from the main process, found by label, exactly
// as a user's menu click would fire it.
test("File ▸ New Browser Tab focuses the address bar, and typing+submitting navigates the tab", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");
    const tabbarPage =
      app.windows().find((page) => page.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (page) => page.url().endsWith("/tabbar/tabbar.html") }));

    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const fileMenu = menu?.items.find((item) => item.label === "File");
      const newBrowserTabItem = fileMenu?.submenu?.items.find((item) => item.label === "New Browser Tab");
      if (!newBrowserTabItem) throw new Error("File ▸ New Browser Tab menu item not found");
      newBrowserTabItem.click();
    });

    // The address row appears (design doc §2) and the caret lands in it —
    // both the OS-level view focus (window.ts focusing the tab-bar
    // WebContentsView) and the DOM-level focus (renderer.ts focusing
    // #url-input) have to have happened for this to hold.
    await expect(tabbarPage.locator("#chrome-row")).toBeVisible();
    await expect.poll(() => tabbarPage.evaluate(() => document.activeElement?.id)).toBe("url-input");
    // A fresh browser tab loads nothing on purpose — the input starts empty,
    // not carrying over a stale value from any previous browser tab.
    await expect(tabbarPage.locator("#url-input")).toHaveValue("");

    // Prove the whole path end to end: typing a real URL and submitting it
    // must actually navigate the new tab, not just move focus.
    const urlInputLocator = tabbarPage.locator("#url-input");
    const [galleryPage] = await Promise.all([
      app.waitForEvent("window", {
        predicate: (p) => p !== editorPage && p !== tabbarPage && !p.url().endsWith("/tabbar/tabbar.html"),
      }),
      (async () => {
        await urlInputLocator.fill(galleryUrl);
        await urlInputLocator.press("Enter");
      })(),
    ]);
    await expect(galleryPage.locator("#ready")).toHaveText("gallery-ready");
    await expect.poll(() => urlInputLocator.inputValue()).toBe(galleryUrl);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("built-in browser tab: browse_act back errors cleanly when there is no history yet", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery") });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    await callBrowser(editorPage, "open", { url: galleryUrl });
    const result = (await callBrowser(editorPage, "act", { action: "back" })) as { error?: string };
    expect(result.error).toBeTruthy();

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("built-in browser tab: browse_act reports an error when no browser tab has ever been opened", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery") });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const result = (await callBrowser(editorPage, "findImages", {})) as { error?: string };
    expect(result.error).toBeTruthy();

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: visibility filtering, labels, ops, and password values against a real DOM", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [snapshotPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === snapshotUrl }),
      callBrowser(editorPage, "open", { url: snapshotUrl }),
    ]);
    await expect(snapshotPage.locator("#ready")).toHaveText("snapshot-ready");

    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.url).toBe(snapshotUrl);
    expect(snap.title).toBe("Snapshot");
    expect(typeof snap.snapshotId).toBe("string");
    expect(snap.snapshotId.length).toBeGreaterThan(0);

    const byLabel = (label: string) => snap.elements.find((e) => e.label === label);

    // --- visibility filtering: display:none, visibility:hidden, opacity:0,
    // zero-size, and far-off-page elements are all excluded. ---
    expect(snap.elements.some((e) => e.label === "Hidden")).toBe(false);
    expect(snap.elements.some((e) => e.label === "Invisible")).toBe(false);
    expect(snap.elements.some((e) => e.label === "Transparent")).toBe(false);
    expect(snap.elements.some((e) => e.label === "Zero Size")).toBe(false);
    expect(snap.elements.some((e) => e.label === "Far Away")).toBe(false);

    // --- labels: aria-label wins over the element's own text, text is used
    // for a plain link, placeholder for an unlabeled input, and an element
    // with none of those still gets a fallback label rather than being
    // dropped (unlabeled icon buttons are what cookie banners are made
    // of). ---
    const ariaButton = byLabel("Aria Label Button");
    expect(ariaButton).toBeTruthy();
    expect(snap.elements.some((e) => e.label === "Different Visible Text")).toBe(false);
    expect(ariaButton?.tag).toBe("button");
    expect(ariaButton?.ops).toEqual(["CLICK"]);

    const link = byLabel("Plain Link Text");
    expect(link?.tag).toBe("a");
    expect(link?.ops).toEqual(["CLICK"]);

    const placeholderInput = byLabel("Type here");
    expect(placeholderInput?.tag).toBe("input");
    // A text field is also clickable (it may open a picker on click); a
    // password field below stays TYPE_TEXT only.
    expect(placeholderInput?.ops).toEqual(["TYPE_TEXT", "CLICK"]);

    // The icon button has no aria-label, no text, no placeholder, no alt —
    // it must still appear, labelled by tag and position, not be dropped.
    const iconButton = snap.elements.find((e) => e.tag === "button" && /^button #\d+$/.test(e.label));
    expect(iconButton).toBeTruthy();
    expect(iconButton?.ops).toEqual(["CLICK"]);

    // --- ops per element type + password handling: a password input is
    // reported with TYPE_TEXT ops, and its value must never leave the page
    // — not even under a different key. ---
    // Review finding 7: the password input has no aria-label/text/
    // placeholder/alt, but it *does* have a hand-authored id ("inp-password")
    // — that's still a legitimate label source (only ids that *look*
    // machine-generated, e.g. React's ":r3:" or Ember's "ember123", are
    // skipped), so it labels as "inp-password" rather than falling back to
    // the positional "input #<n>".
    // Found by the flag itself, not by a label heuristic: the backend's
    // refusal to generate text for a password field keys off `isPassword`
    // and nothing else, so the flag actually reaching the snapshot is the
    // thing under test. It was computed but dropped from the emitted
    // element once, which made that refusal unreachable end to end.
    const passwordEntry = snap.elements.find((e) => e.isPassword);
    expect(passwordEntry).toBeTruthy();
    expect(passwordEntry?.tag).toBe("input");
    expect(passwordEntry?.ops).toEqual(["TYPE_TEXT"]);
    expect(passwordEntry?.value).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain("supersecret");

    // The flag is set only where it belongs — a text input must not carry
    // it, or the backend would refuse to type into ordinary search boxes.
    const textInput = snap.elements.find((e) => e.label === "Type here");
    expect(textInput).toBeTruthy();
    expect(textInput?.isPassword).toBeUndefined();

    // --- select: SELECT ops, options list, and the CHOSEN option as
    // `value` — the option texts already leave the page in `options`, and
    // without the choice Jev re-selects a field it cannot see is set. A
    // "Select…" placeholder (empty option value) is unset, not filled. ---
    const select = snap.elements.find((e) => e.tag === "select" && e.options?.[0] === "Red");
    expect(select?.ops).toEqual(["SELECT"]);
    expect(select?.options).toEqual(["Red", "Green", "Blue"]);
    expect(select?.value).toBe("Green");
    expect(select?.hasValue).toBe(true);
    const placeholderSelect = snap.elements.find((e) => e.tag === "select" && e.options?.[1] === "Germany");
    expect(placeholderSelect?.value).toBeUndefined();
    expect(placeholderSelect?.hasValue).toBe(false);

    // --- a checkbox reports `checked`, never `hasValue` (its value is "on"). ---
    const terms = snap.elements.find((e) => e.label === "Accept the terms");
    expect(terms?.checked).toBe(false);
    expect(terms?.hasValue).toBeUndefined();

    // --- visible viewport text rides along for the step policy; hidden and
    // off-screen text does not. ---
    expect(snap.text).toContain("snapshot-ready");
    expect(snap.text).toContain("Different Visible Text");
    expect(snap.text).not.toContain("Far Away");
    expect(snap.text).not.toMatch(/\bHidden\b/);

    // --- Addendum D / finding 3: an autofilled type=tel or type=email
    // value must never leave the page under any key, not even in the raw
    // JSON — these types are never eligible for `value` at all. ---
    const rawSnapshot = JSON.stringify(snap);
    expect(rawSnapshot).not.toContain("555-0100");
    expect(rawSnapshot).not.toContain("autofilled@example.com");
    // Review finding 7: tel/email have no aria-label/text/placeholder/alt,
    // but like the password input above they *do* have a hand-authored id
    // ("inp-tel"/"inp-email"), so they label by id rather than falling back
    // to the positional "input #<n>" — see #btn-generated-id below for the
    // case that *does* still hit the positional fallback (a machine-looking
    // id must be skipped). Either way they must report hasValue rather than
    // value.
    const inputsWithoutValue = snap.elements.filter(
      (e) => e.tag === "input" && e.value === undefined && e.checked === undefined,
    );
    expect(inputsWithoutValue.length).toBeGreaterThanOrEqual(3); // password, tel, email at least
    expect(inputsWithoutValue.every((e) => typeof e.hasValue === "boolean")).toBe(true);

    // --- Addendum D / finding 3: a text input with a sensitive
    // autocomplete token (cc-number) reports only hasValue, never value. ---
    const ccInputIndexById = await snapshotPage.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-pen-snap]'));
      const cc = document.getElementById("inp-cc");
      const match = els.find((el) => el === cc);
      return match ? match.getAttribute("data-pen-snap") : null;
    });
    expect(ccInputIndexById).toBeTruthy();
    const ccIndex = Number(String(ccInputIndexById).split(":")[1]);
    const ccEntry = snap.elements.find((e) => e.index === ccIndex);
    expect(ccEntry?.value).toBeUndefined();
    expect(ccEntry?.hasValue).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("4111111111111111");

    // --- Addendum D / finding 3: a plain search box (no sensitive
    // autocomplete) still reports its live value. ---
    const searchIndexById = await snapshotPage.evaluate(() => {
      const el = document.getElementById("inp-search");
      return el ? el.getAttribute("data-pen-snap") : null;
    });
    expect(searchIndexById).toBeTruthy();
    const searchIndex = Number(String(searchIndexById).split(":")[1]);
    const searchEntry = snap.elements.find((e) => e.index === searchIndex);
    expect(searchEntry?.value).toBe("chairs");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser act click: a bare word matching both a real element tag and a button's visible text clicks the button, not the tag", async () => {
  // Finding 2: CLICK_JS/TYPE_JS used to try findBySelector before
  // findByText, and a bare word like "Details" is a syntactically valid CSS
  // *type* selector — document.querySelector("Details") matches the
  // <details> element case-insensitively. This page has both: a <details>
  // element and a button whose visible text is exactly "Details".
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [clickPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === clickTargetUrl }),
      callBrowser(editorPage, "open", { url: clickTargetUrl }),
    ]);
    await expect(clickPage.locator("#ready")).toHaveText("click-target-ready");

    const clickResult = (await callBrowser(editorPage, "act", { action: "click", target: "Details" })) as {
      matched?: string;
      error?: string;
    };
    expect(clickResult.error).toBeUndefined();
    expect(clickResult.matched).toBe("Details");
    // The button's own listener must have fired — the old behavior would
    // silently click the <details> element (a no-op) while still reporting
    // { matched: "Details" } as if it had worked.
    await expect(clickPage.locator("#click-result")).toHaveText("clicked-details-button");
    // And the <details> element must not have been toggled open.
    expect(await clickPage.locator("#wrapper-details").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
      false,
    );

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

async function openReachFixture(url: string, readyText: string) {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });
  const editorPage = await app.waitForEvent("window", {
    predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
  });
  await expect(editorPage.locator("#ready")).toHaveText("stub-editor");
  const [page] = await Promise.all([
    app.waitForEvent("window", { predicate: (p) => p.url() === url }),
    callBrowser(editorPage, "open", { url }),
  ]);
  await expect(page.locator("#ready")).toHaveText(readyText);
  return { app, editorPage, page };
}

test("browser snapshot: an aria-modal dialog scopes the table to its own controls, and lifts once closed", async () => {
  const { app, editorPage } = await openReachFixture(reachModalUrl, "reach-modal-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.modal).toBe("Sign in offer");
    expect(snap.elements.map((e) => e.label)).toEqual(["Close"]);
    // Indices stay contiguous from 0.
    expect(snap.elements.map((e) => e.index)).toEqual([0]);

    const closeIndex = snap.elements.find((e) => e.label === "Close")?.index;
    const clickResult = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: closeIndex,
      operation: "CLICK",
    })) as { error?: string };
    expect(clickResult.error).toBeUndefined();

    const after = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(after.modal).toBeUndefined();
    const labels = after.elements.map((e) => e.label);
    expect(labels).toContain("Page Button A");
    expect(labels).toContain("Page Button B");
    expect(labels).not.toContain("Close");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a control covered by a fixed non-ARIA overlay is dropped, an uncovered one stays", async () => {
  const { app, editorPage } = await openReachFixture(reachOverlayUrl, "reach-overlay-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.modal).toBeUndefined();
    const labels = snap.elements.map((e) => e.label);
    expect(labels).not.toContain("Covered Button");
    expect(labels).toContain("Free Button");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a control under a partial fixed bar stays listed, and a click scrolls it clear and lands via cdp", async () => {
  const { app, editorPage, page } = await openReachFixture(reachBarUrl, "reach-bar-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const idx = snap.elements.find((e) => e.label === "Under Bar")?.index;
    expect(idx).not.toBeUndefined();

    const performResult = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: idx,
      operation: "CLICK",
    })) as { error?: string; via?: string };
    expect(performResult.error).toBeUndefined();
    expect(performResult.via).toBe("cdp");
    await expect(page.locator("#bar-result")).toHaveText("bar-clicked-trusted");

    // Same through act-by-text, after resetting the page state.
    await page.evaluate(() => {
      document.getElementById("bar-result")!.textContent = "not-clicked";
      window.scrollTo(0, 0);
    });
    const actResult = (await callBrowser(editorPage, "act", { action: "click", target: "Under Bar" })) as {
      error?: string;
      via?: string;
    };
    expect(actResult.error).toBeUndefined();
    expect(actResult.via).toBe("cdp");
    await expect(page.locator("#bar-result")).toHaveText("bar-clicked-trusted");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: modal scope keeps a portalled popup that sits above the backdrop, and drops a page control under it", async () => {
  const { app, editorPage } = await openReachFixture(reachPortalUrl, "reach-portal-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.modal).toBe("Pick a date");
    const labels = snap.elements.map((e) => e.label);
    expect(labels).toContain("Open picker");
    expect(labels).toContain("Option Jan");
    expect(labels).not.toContain("Behind Button");
    // The portalled popup is also a scroll container OUTSIDE the modal: it is
    // kept, flagged scrollable, because a sample point lands on it.
    const portalScroll = snap.elements.find((e) => e.scrollable === true && e.label.includes("More options below"));
    expect(portalScroll).toBeTruthy();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a pointer-events:none fixed toast container is not the occluder, its control target stays listed", async () => {
  const { app, editorPage } = await openReachFixture(reachToastUrl, "reach-toast-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.elements.map((e) => e.label)).toContain("Under Toast");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser perform: a target re-mounted after the snapshot is re-found by its unique fingerprint", async () => {
  const { app, editorPage, page } = await openReachFixture(remountUrl, "remount-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const findIndex = snap.elements.find((e) => e.label === "Find")?.index;
    expect(findIndex).not.toBeUndefined();
    // The page re-mounts its buttons ~300ms after they were stamped.
    await page.waitForTimeout(600);
    expect(await page.locator("[data-pen-snap]").count()).toBe(0);

    const result = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: findIndex,
      operation: "CLICK",
    })) as { error?: string; relocated?: boolean };
    expect(result.error).toBeUndefined();
    expect(result.relocated).toBe(true);
    await expect(page.locator("#clicks")).toHaveText("1");
    expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser perform: a re-mounted target whose label is shared by another button is NOT relocated", async () => {
  const { app, editorPage, page } = await openReachFixture(remountDupUrl, "remount-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const findIndex = snap.elements.find((e) => e.label === "Find")?.index;
    expect(findIndex).not.toBeUndefined();
    await page.waitForTimeout(600);

    const result = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: findIndex,
      operation: "CLICK",
    })) as { error?: string; relocated?: boolean };
    expect(result.error).toMatch(/No element matched/);
    expect(result.relocated).toBeUndefined();
    await expect(page.locator("#clicks")).toHaveText("0");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser perform: relocation never crosses documents (SPA route change or hard navigation)", async () => {
  const { app, editorPage, page } = await openReachFixture(`${remountUrl}?spa=1`, "remount-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const findIndex = snap.elements.find((e) => e.label === "Find")?.index;
    expect(findIndex).not.toBeUndefined();
    await page.waitForTimeout(600);
    expect(page.url()).toContain("#next");
    const spa = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: findIndex,
      operation: "CLICK",
    })) as { error?: string; relocated?: boolean };
    expect(spa.error).toMatch(/No element/);
    await expect(page.locator("#clicks")).toHaveText("0");

    // Hard navigation in the same tab: the new document has no snapshot token.
    const snap2 = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const idx2 = snap2.elements.find((e) => e.label === "Find")?.index;
    await page.waitForTimeout(100);
    await page.evaluate((u) => location.assign(u), remountUrl);
    await expect(page.locator("#ready")).toHaveText("remount-ready");
    const hard = (await callBrowser(editorPage, "perform", {
      snapshotId: snap2.snapshotId,
      index: idx2,
      operation: "CLICK",
    })) as { error?: string };
    expect(hard.error).toBeTruthy();
    await expect(page.locator("#clicks")).toHaveText("0");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser perform: a removed duplicate-label button's index never relocates onto its sibling", async () => {
  const { app, editorPage, page } = await openReachFixture(`${remountUrl}?rm=1`, "remount-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const removeIdx = snap.elements.filter((e) => e.label === "Remove").map((e) => e.index);
    expect(removeIdx.length).toBe(2);
    await page.waitForTimeout(600);
    const result = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: removeIdx[0],
      operation: "CLICK",
    })) as { error?: string };
    expect(result.error).toMatch(/No element/);
    await expect(page.locator("#clicks")).toHaveText("0");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a stale aria-modal inside an opacity:0 pointer-events:none wrapper does not scope the table", async () => {
  const { app, editorPage } = await openReachFixture(reachStaleUrl, "reach-stale-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.modal).toBeUndefined();
    expect(snap.elements.map((e) => e.label)).toContain("Live Page Button");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a custom checkbox under a sibling styled span (nothing fixed) is not treated as covered", async () => {
  const { app, editorPage } = await openReachFixture(reachCheckboxUrl, "reach-checkbox-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const labels = snap.elements.map((e) => e.label);
    expect(labels).toContain("Custom check");
    expect(labels).toContain("Other Button");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a non-modal role=dialog banner does not scope the table", async () => {
  const { app, editorPage } = await openReachFixture(reachBannerUrl, "reach-banner-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.modal).toBeUndefined();
    const labels = snap.elements.map((e) => e.label);
    expect(labels).toContain("Main Page Button");
    expect(labels).toContain("Accept cookies");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: hard-caps at 120 elements even when more are visible", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === snapshotManyUrl }),
      callBrowser(editorPage, "open", { url: snapshotManyUrl }),
    ]);

    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.elements.length).toBe(120);
    // Indices are dense and start at 0 regardless of the cap.
    expect(snap.elements.map((e) => e.index)).toEqual(Array.from({ length: 120 }, (_, i) => i));

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("code review finding 7: scroll containers never push the top document's element count over the hard cap", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === snapshotManyWithFrameUrl }),
      callBrowser(editorPage, "open", { url: snapshotManyWithFrameUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("snapshot-many-with-frame-ready");

    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult & {
      elements: { index: number; frame?: string; scrollable?: boolean }[];
    };
    // Never more than the hard cap, even with 150 buttons (which alone
    // already saturate it) AND 15 scroll containers on top. Before this
    // fix, SNAPSHOT_JS appended up to 10 scroll containers UNCONDITIONALLY
    // on top of the already-120-capped interactive elements — 130 total —
    // which made `controller.ts`'s `remaining = MAX_SNAPSHOT_ELEMENTS -
    // elements.length` go negative.
    expect(snap.elements.length).toBeLessThanOrEqual(120);
    expect(snap.elements.length).toBe(120);
    // With 150 interactive elements alone already at the cap, the shared
    // budget correctly leaves NO room for a scroll container here — this is
    // the page legitimately being full, not a bug (a negative `remaining`
    // and a zero `remaining` both skip the same downstream merges; the
    // observable, testable difference this fix makes is the element COUNT
    // itself never lying about being within the documented cap).
    expect(snap.elements.some((e) => e.scrollable === true)).toBe(false);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser perform: acts by index, and rejects a snapshotId superseded by a newer snapshot", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [snapshotPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === snapshotUrl }),
      callBrowser(editorPage, "open", { url: snapshotUrl }),
    ]);
    await expect(snapshotPage.locator("#ready")).toHaveText("snapshot-ready");

    const firstSnapshot = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const ariaIndex = firstSnapshot.elements.find((e) => e.label === "Aria Label Button")?.index;
    expect(ariaIndex).not.toBeUndefined();

    // --- a fresh snapshot supersedes the first one's snapshotId. ---
    const secondSnapshot = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(secondSnapshot.snapshotId).not.toBe(firstSnapshot.snapshotId);

    // --- perform with the now-stale first snapshotId must hard-error,
    // never silently act against the current DOM (jev-loop design doc §1:
    // "the one way the indexed design can go quietly wrong"). ---
    const staleResult = (await callBrowser(editorPage, "perform", {
      snapshotId: firstSnapshot.snapshotId,
      index: ariaIndex,
      operation: "CLICK",
    })) as { error?: string };
    expect(staleResult.error).toBeTruthy();
    await expect(snapshotPage.locator("#click-result")).toHaveText("");

    // --- perform with the current snapshotId actually clicks the element,
    // reusing phase 1's click-settle logic. ---
    const clickResult = (await callBrowser(editorPage, "perform", {
      snapshotId: secondSnapshot.snapshotId,
      index: ariaIndex,
      operation: "CLICK",
    })) as { url?: string; title?: string; error?: string };
    expect(clickResult.error).toBeUndefined();
    await expect(snapshotPage.locator("#click-result")).toHaveText("clicked-aria");

    // --- TYPE_TEXT by index against a fresh snapshot. ---
    const typeSnapshot = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const inputIndex = typeSnapshot.elements.find((e) => e.label === "Type here")?.index;
    expect(inputIndex).not.toBeUndefined();
    const typeResult = (await callBrowser(editorPage, "perform", {
      snapshotId: typeSnapshot.snapshotId,
      index: inputIndex,
      operation: "TYPE_TEXT",
      text: "hello snapshot",
    })) as { error?: string };
    expect(typeResult.error).toBeUndefined();
    await expect(snapshotPage.locator("#inp-placeholder")).toHaveValue("hello snapshot");

    // --- SELECT by index against a fresh snapshot. ---
    const selectSnapshot = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const selectIndex = selectSnapshot.elements.find((e) => e.tag === "select" && e.options?.includes("Blue"))?.index;
    expect(selectIndex).not.toBeUndefined();
    const selectResult = (await callBrowser(editorPage, "perform", {
      snapshotId: selectSnapshot.snapshotId,
      index: selectIndex,
      operation: "SELECT",
      text: "Blue",
    })) as { error?: string };
    expect(selectResult.error).toBeUndefined();
    await expect(snapshotPage.locator("#sel-color")).toHaveValue("Blue");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("second-pass review: a scroll container that is ALSO an interactive element (scrollable textarea) gets one entry, not two, and TYPE_TEXT by its interactive index still works", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [snapshotPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === snapshotUrl }),
      callBrowser(editorPage, "open", { url: snapshotUrl }),
    ]);
    await expect(snapshotPage.locator("#ready")).toHaveText("snapshot-ready");

    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;

    // Exactly one element-table entry for the textarea — the scroll-
    // container pass must not append a second entry for something already
    // stamped as an interactive element in this same snapshot.
    const textareaEntries = snap.elements.filter((e) => e.tag === "textarea");
    expect(textareaEntries.length).toBe(1);

    // That single entry keeps its interactive identity (TYPE_TEXT) AND
    // picks up scrollable: true — not one or the other.
    const textareaEntry = textareaEntries[0];
    expect(textareaEntry.ops).toEqual(["TYPE_TEXT"]);
    expect(textareaEntry.scrollable).toBe(true);

    // The DOM stamp must resolve back to the textarea itself, not to some
    // other node whose index got overwritten.
    const stampedTag = await snapshotPage.evaluate((idx) => {
      const el = document.querySelector(`[data-pen-snap$=":${idx}"]`);
      return el ? el.tagName.toLowerCase() : null;
    }, textareaEntry.index);
    expect(stampedTag).toBe("textarea");

    // TYPE_TEXT by that interactive index must still resolve the element
    // (the bug: the container-stamping pass overwrote the textarea's own
    // data-pen-snap with a container index, so this used to fail with
    // "No element matched").
    const typeResult = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: textareaEntry.index,
      operation: "TYPE_TEXT",
      text: "hello textarea",
    })) as { error?: string };
    expect(typeResult.error).toBeUndefined();
    await expect(snapshotPage.locator("#textarea-scrollable")).toHaveValue("hello textarea");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("evidence of effect ('Addendum 2, 2026-09-19' §1): a no-op click reports changed: false, a main-image swap reports changed: true", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [evidencePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === evidenceUrl }),
      callBrowser(editorPage, "open", { url: evidenceUrl }),
    ]);
    await expect(evidencePage.locator("#ready")).toHaveText("evidence-ready");

    // --- a click that lands but does nothing must report changed: false,
    // and it must not be an error — "the click may have been a no-op the
    // goal didn't need". ---
    const noopResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "No Op",
    })) as { error?: string } & EffectEvidence;
    expect(noopResult.error).toBeUndefined();
    expect(noopResult.changed).toBe(false);
    expect(noopResult.changes).toEqual([]);

    // --- a click that swaps only the largest visible <img>'s src must
    // report changed: true with "main-image" among `changes` — the design
    // doc's own motivating example. ---
    const swapResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "Swap Photo",
    })) as { error?: string } & EffectEvidence;
    expect(swapResult.error).toBeUndefined();
    expect(swapResult.changed).toBe(true);
    expect(swapResult.changes).toContain("main-image");
    // Nothing else about the page changed (no navigation, no text change),
    // so "main-image" should be the only category reported.
    expect(swapResult.changes).toEqual(["main-image"]);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browse-speed contract (2026-09-24): a click that updates a separate status element reports changed: false but pageChanged: true with the new text in appeared", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [sideEffectPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === sideEffectUrl }),
      callBrowser(editorPage, "open", { url: sideEffectUrl }),
    ]);
    await expect(sideEffectPage.locator("#ready")).toHaveText("side-effect-ready");

    const result = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "Add to Cart",
    })) as { error?: string } & EffectEvidence;
    expect(result.error).toBeUndefined();
    // The acted-on element (the button) is itself unaffected — a click
    // handler that only mutates a different element correctly reports no
    // scoped/target change.
    expect(result.changed).toBe(false);
    // But a real, visible mutation did happen elsewhere on the page, and
    // pageChanged/appeared must surface it.
    expect(result.pageChanged).toBe(true);
    expect(result.appeared).toContain("Added to cart (1 item)");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browse-speed contract fix (2026-09-24): a no-op click on a page with a live ticking clock reports pageChanged: false", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [tickerPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === tickerUrl }),
      callBrowser(editorPage, "open", { url: tickerUrl }),
    ]);
    await expect(tickerPage.locator("#ready")).toHaveText("ticker-ready");

    const result = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "No Op",
    })) as { error?: string } & EffectEvidence;
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(false);
    // The clock kept ticking underneath the click (digits-only text
    // churning every 100ms) — that must never look like evidence the click
    // did something.
    expect(result.pageChanged).toBe(false);
    expect(result.appeared).toEqual([]);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browse-speed contract fix (2026-09-24): removing an element reports pageChanged: false", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [removalPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === removalUrl }),
      callBrowser(editorPage, "open", { url: removalUrl }),
    ]);
    await expect(removalPage.locator("#ready")).toHaveText("removal-ready");

    const result = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "Remove",
    })) as { error?: string } & EffectEvidence;
    expect(result.error).toBeUndefined();
    // A real, visible, text-bearing element left the page — but removals
    // are never counted as evidence (only additions/text changes are).
    expect(result.pageChanged).toBe(false);
    expect(result.appeared).toEqual([]);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("evidence of effect: perform CLICK by index also carries changed evidence", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === evidenceUrl }),
      callBrowser(editorPage, "open", { url: evidenceUrl }),
    ]);

    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const swapIndex = snap.elements.find((e) => e.label === "Swap Photo")?.index;
    expect(swapIndex).not.toBeUndefined();

    const result = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: swapIndex,
      operation: "CLICK",
    })) as { error?: string } & EffectEvidence;
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.changes).toContain("main-image");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browse_read: headings/text/links against a real DOM, with caps applied and an error on an unmatched selector", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [readPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === readUrl }),
      callBrowser(editorPage, "open", { url: readUrl }),
    ]);
    await expect(readPage.locator("#ready")).toHaveText("read-ready");

    // --- whole-page read: nav/script/style text excluded, headings and
    // links capped (40/60), labels capped at 120 chars. ---
    const whole = (await callBrowser(editorPage, "read", {})) as ReadResult;
    expect(whole.error).toBeUndefined();
    expect(whole.url).toBe(readUrl);
    expect(whole.title).toBe("Read Page");

    expect(whole.text).toContain("Some visible paragraph text that should be included in the digest, with extra whitespace collapsed.");
    expect(whole.text).not.toContain("should not appear in text");
    expect(whole.text).not.toContain("color:red");
    expect(whole.text).not.toContain("Nav chrome should not appear");

    // 47 total headings (h1 #ready + "Scoped Heading" + 45 generated h3s),
    // capped at 40.
    expect(whole.headings.length).toBe(40);
    expect(whole.headings[0]).toBe("read-ready");
    expect(whole.headings).toContain("Scoped Heading");
    expect(whole.headings).not.toContain("Heading 44");
    // Review finding 8: 47 qualifying headings > the 40 cap — this must be
    // visible in its own flag, not just inferable from `truncated` (which
    // reflects only the text cap and was false here before this fix even
    // though headings/links were silently cut).
    expect(whole.headingsTruncated).toBe(true);

    // 68 unique http(s) link candidates (nav link, long-label link, scoped
    // link, 65 generated — one of which duplicates an href, and one mailto:
    // is excluded), capped at 60.
    expect(whole.links.length).toBe(60);
    expect(whole.links.every((l) => l.href.startsWith("http:") || l.href.startsWith("https:"))).toBe(true);
    expect(whole.links.some((l) => l.href.includes("mailto"))).toBe(false);
    const longLabelLink = whole.links.find((l) => l.href === `${baseUrl}/long-label`);
    expect(longLabelLink).toBeTruthy();
    expect(longLabelLink!.label.length).toBe(120);
    expect(longLabelLink!.label).toBe("X".repeat(120));
    // Review finding 8: 68 qualifying links > the 60 cap.
    expect(whole.linksTruncated).toBe(true);
    // The overall (text-cap-only) `truncated` field is unrelated and stays
    // false here — this page's paragraph text alone is well under the
    // default 6000-char maxChars.
    expect(whole.truncated).toBe(false);

    // --- maxChars: default is generous enough not to truncate this page's
    // paragraph text alone, but an explicit small maxChars must truncate
    // and report it. ---
    const truncatedRead = (await callBrowser(editorPage, "read", { maxChars: 50 })) as ReadResult;
    expect(truncatedRead.truncated).toBe(true);
    expect(truncatedRead.text.length).toBe(50);

    // --- selector: narrows to one subtree — headings/text/links outside it
    // must not appear. ---
    const scoped = (await callBrowser(editorPage, "read", { selector: "#scope" })) as ReadResult;
    expect(scoped.error).toBeUndefined();
    expect(scoped.headings).toEqual(["Scoped Heading"]);
    expect(scoped.text).toContain("Scoped paragraph text only.");
    expect(scoped.text).not.toContain("Some visible paragraph");
    expect(scoped.links).toEqual([{ label: "Scoped Link", href: `${baseUrl}/scoped-link` }]);
    // Review finding 8: well within both caps, so neither collection flag
    // should be set.
    expect(scoped.headingsTruncated).toBe(false);
    expect(scoped.linksTruncated).toBe(false);

    // --- Review finding 9: `text` already included the root element's own
    // text when `selector` targets it directly (collectText walks the
    // root's own children), but `headings`/`links` used
    // `root.querySelectorAll(...)`, which only matches *descendants* — so a
    // selector that matches a heading itself used to come back with that
    // heading's text in `text` but an empty `headings` array. Root inclusion
    // must be consistent across all three. ---
    const selectorIsHeadingItself = (await callBrowser(editorPage, "read", { selector: "#ready" })) as ReadResult;
    expect(selectorIsHeadingItself.error).toBeUndefined();
    expect(selectorIsHeadingItself.text).toBe("read-ready");
    expect(selectorIsHeadingItself.headings).toEqual(["read-ready"]);

    const selectorIsLinkItself = (await callBrowser(editorPage, "read", { selector: "#long-label-link" })) as ReadResult;
    expect(selectorIsLinkItself.error).toBeUndefined();
    expect(selectorIsLinkItself.links).toEqual([{ label: "X".repeat(120), href: `${baseUrl}/long-label` }]);

    // --- an unmatched selector is an error, not a silent whole-page read. ---
    const missed = (await callBrowser(editorPage, "read", { selector: "#does-not-exist" })) as ReadResult;
    expect(missed.error).toBeTruthy();
    expect(missed.headings).toBeUndefined();

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("BROWSE-01: an <img srcset> yields the largest declared candidate, and naturalWidth/naturalHeight are reported alongside rendered size", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [metaPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === imagesMetaUrl }),
      callBrowser(editorPage, "open", { url: imagesMetaUrl }),
    ]);
    await expect(metaPage.locator("#ready")).toHaveText("images-meta-ready");

    const result = (await callBrowser(editorPage, "findImages", { minWidth: 50, minHeight: 50 })) as FindImagesResult;
    expect(result.count).toBe(3);

    // img-natural: rendered small by CSS (150x100), but its served SVG's
    // own width/height attributes declare a genuinely larger intrinsic
    // size (800x600) — width/height must still mean *rendered* size (the
    // e2e suite pins that), while naturalWidth/naturalHeight report the
    // real intrinsic size.
    const natural = result.images.find((i) => i.alt === "Natural");
    expect(natural).toBeTruthy();
    expect(natural).toMatchObject({ width: 150, height: 100, naturalWidth: 800, naturalHeight: 600 });

    // img-srcset: FIND_IMAGES_JS must prefer the larger declared candidate
    // (900w) over currentSrc/src (the 200w one), regardless of which the
    // browser itself actually renders. Review finding 5: since the returned
    // URL (900w) is NOT the one the browser actually loaded (currentSrc, the
    // 200w candidate — a 1x1 SVG), naturalWidth must come from the
    // descriptor's own declared width (900), not from the loaded resource's
    // real 1x1 size — asserted as concrete values, not merely `typeof
    // === "number"` (which the pre-fix code would also have satisfied,
    // just with the wrong, misleadingly-tiny number).
    const srcset = result.images.find((i) => i.alt === "Srcset");
    expect(srcset).toBeTruthy();
    expect(srcset!.url).toBe(sizedPixelUrl(900, 900, "magenta"));
    expect(srcset).toMatchObject({ naturalWidth: 900, naturalHeight: 900 });

    // Review finding 1 (HIGH): img-comma's winning srcset candidate (800w)
    // is itself a comma-bearing URL — the fix must neither mis-split it
    // apart nor let the comma prevent it from being recognized as the
    // higher-scoring candidate. naturalWidth is the declared 800 (same
    // "not the loaded resource" reasoning as img-srcset above).
    const comma = result.images.find((i) => i.alt === "Comma");
    expect(comma).toBeTruthy();
    expect(comma!.url).toBe(`${pixelUrl("teal")}&x=w_800,h_600`);
    expect(comma).toMatchObject({ naturalWidth: 800, naturalHeight: 800 });

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("BROWSE-02: labels resolve through a descendant's aria-label and through an enclosing <a>/<button>, with the positional fallback still last", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [snapshotPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === snapshotUrl }),
      callBrowser(editorPage, "open", { url: snapshotUrl }),
    ]);
    await expect(snapshotPage.locator("#ready")).toHaveText("snapshot-ready");

    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;

    // --- an icon button labelled only by a descendant svg[aria-label]. ---
    const iconLabelled = snap.elements.find((e) => e.tag === "button" && e.label === "Save");
    expect(iconLabelled).toBeTruthy();
    expect(iconLabelled?.ops).toEqual(["CLICK"]);

    // --- an element with no label of its own, resolved through the
    // accessible name of the nearest enclosing <a aria-label="…">. ---
    const enclosed = snap.elements.find((e) => e.tag === "span" && e.label === "View Cart");
    expect(enclosed).toBeTruthy();
    expect(enclosed?.role).toBe("button");
    // The enclosing <a> itself is also a separate, independently labelled
    // element (its own aria-label) — the two must not be confused.
    const enclosingLink = snap.elements.find((e) => e.tag === "a" && e.label === "View Cart");
    expect(enclosingLink).toBeTruthy();
    expect(enclosingLink?.index).not.toBe(enclosed?.index);

    // --- an element with nothing at all (the pre-existing #btn-icon
    // fixture: no aria-label, no text, no placeholder, no alt, no title, no
    // labelled descendant, no enclosing <a>/<button>, no name/id) must still
    // get the positional "tag #index" fallback rather than being dropped —
    // this must keep working after every new label source above it. ---
    const positional = snap.elements.find((e) => e.tag === "button" && /^button #\d+$/.test(e.label));
    expect(positional).toBeTruthy();
    expect(positional?.ops).toEqual(["CLICK"]);

    // --- Review finding 6: the FIRST element matching
    // [aria-label],[title],[alt] is an empty-alt <img>; the descendant step
    // must keep iterating to the SECOND match (svg[aria-label="Bookmark"])
    // instead of yielding nothing. ---
    const descendantSecondMatch = await snapshotPage.evaluate(() => {
      const el = document.getElementById("btn-descendant-second-match");
      return el ? el.getAttribute("data-pen-snap") : null;
    });
    expect(descendantSecondMatch).toBeTruthy();
    const descendantIndex = Number(String(descendantSecondMatch).split(":")[1]);
    const descendantEntry = snap.elements.find((e) => e.index === descendantIndex);
    expect(descendantEntry?.label).toBe("Bookmark");

    // --- Review finding 7: a machine-generated-looking id ("ember1234")
    // must not surface as a label — it should fall through to the same
    // positional fallback as a genuinely id-less element, not read as a
    // plausible-but-meaningless label. ---
    const generatedIdIndexById = await snapshotPage.evaluate(() => {
      const el = document.getElementById("ember1234");
      return el ? el.getAttribute("data-pen-snap") : null;
    });
    expect(generatedIdIndexById).toBeTruthy();
    const generatedIdIndex = Number(String(generatedIdIndexById).split(":")[1]);
    const generatedIdEntry = snap.elements.find((e) => e.index === generatedIdIndex);
    expect(generatedIdEntry?.label).not.toBe("ember1234");
    expect(generatedIdEntry?.label).toMatch(/^button #\d+$/);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browse_open: DOM-ready fix — returns well within the command timeout with loaded: false while a subresource is still stalled, and the page is usable once it catches up", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const start = Date.now();
    const [slowPage, openResult] = (await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === slowLoadUrl }),
      callBrowser(editorPage, "open", { url: slowLoadUrl }),
    ])) as [Page, { url: string; title: string; loaded: boolean }];
    const elapsedMs = Date.now() - start;

    // The whole point of the fix: this HTML is complete (its DOM is ready
    // almost immediately) even though its <img> is still stalled on
    // /slow-resource — `webContents.loadURL()`'s own promise (did-finish-load)
    // doesn't resolve until that resource finally answers, well past this
    // point, so the old `await page.loadURL()` implementation would have sat
    // here for the whole SLOW_RESOURCE_DELAY_MS (and, on a page that never
    // answers at all, up to BROWSER_COMMAND_TIMEOUT_MS — see
    // SLOW_RESOURCE_DELAY_MS's doc comment for why that harsher case isn't
    // used directly in this test). This assertion proves `open` returned at
    // DOM-ready plus its own short, bounded grace period instead.
    expect(elapsedMs).toBeLessThan(SLOW_RESOURCE_DELAY_MS - 500);

    expect(openResult.url).toBe(slowLoadUrl);
    expect(openResult.title).toBe("Slow Load");
    // Honest reporting: the full load hadn't settled yet when the command
    // returned.
    expect(openResult.loaded).toBe(false);
    await expect(slowPage.locator("#ready")).toHaveText("slow-load-ready");

    // A following snapshot/read must work against this page. Electron itself
    // defers `executeJavaScript` until the page stops loading (documented
    // behavior, not something this fix changes or could — see
    // electron/electron#5183), so these calls block until /slow-resource
    // finally answers at SLOW_RESOURCE_DELAY_MS — but they must then succeed
    // cleanly, proving `open`'s early, honest `loaded: false` return didn't
    // leave the tab or the controller in some broken state.
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.url).toBe(slowLoadUrl);
    expect(snap.title).toBe("Slow Load");

    const read = (await callBrowser(editorPage, "read", {})) as ReadResult;
    expect(read.error).toBeUndefined();
    expect(read.url).toBe(slowLoadUrl);
    expect(read.headings).toEqual(["slow-load-ready"]);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("addendum 3 §2 (upstream PR #58): a click on a control that disables itself is observed only after the handler finishes", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === selfDisableUrl }),
      callBrowser(editorPage, "open", { url: selfDisableUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("self-disable-ready");

    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const startIndex = snap.elements.find((e) => e.label === "Start")?.index;
    expect(startIndex).not.toBeUndefined();

    const started = Date.now();
    const result = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: startIndex,
      operation: "CLICK",
    })) as { error?: string; __targetSelfDisabled?: unknown };
    expect(result.error).toBeUndefined();
    // The internal flag is stripped before the result leaves the controller.
    expect(result.__targetSelfDisabled).toBeUndefined();
    // The command waited for the handler rather than returning on the
    // ~350ms non-navigating click settle.
    expect(Date.now() - started).toBeGreaterThanOrEqual(SELF_DISABLE_HANDLER_MS);

    // The very next observation — the one the loop would feed to Jev — sees
    // both the re-enabled control and what the handler revealed. Before the
    // fix it saw neither, and the model answered BLOCKED.
    const after = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(after.elements.map((e) => e.label)).toContain("Continue");
    expect(after.elements.map((e) => e.label)).toContain("Start");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// --- Full browser use (design doc `2026-09-23-full-browser-use-design.md`) ---

test("browse_screenshot: returns a non-empty image, and annotate marks never leak into a later snapshot", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    // The /snapshot fixture (not /gallery — its interactive elements are
    // all above the fold) is reused here since it's already known to have
    // several always-visible, near-top interactive elements.
    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === snapshotUrl }),
      callBrowser(editorPage, "open", { url: snapshotUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("snapshot-ready");

    const plain = (await callBrowser(editorPage, "screenshot")) as {
      imageData: string;
      width: number;
      height: number;
      url: string;
    };
    expect(plain.imageData).toMatch(/^data:image\/jpeg;base64,/);
    expect(plain.width).toBeGreaterThan(0);
    expect(plain.height).toBeGreaterThan(0);
    expect(plain.url).toBe(snapshotUrl);

    const annotated = (await callBrowser(editorPage, "screenshot", { annotate: true })) as {
      imageData: string;
      snapshotId: string;
      elements: { index: number; label: string }[];
    };
    expect(annotated.imageData).toMatch(/^data:image\/jpeg;base64,/);
    expect(typeof annotated.snapshotId).toBe("string");
    expect(annotated.elements.length).toBeGreaterThan(0);

    // The marks overlay must be gone from the real page once the command
    // resolves — not just cosmetically invisible, but actually removed, so
    // it can never show up as a "found" element in a later snapshot/findImages.
    expect(await fixturePage.evaluate(() => document.querySelectorAll("[data-pen-marks]").length)).toBe(0);

    const laterSnapshot = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    // None of the marks overlay's own label/box elements (plain <div>s, not
    // in SNAPSHOT_JS's interactive selector anyway) show up, and — the
    // sharper check — the annotated screenshot's own snapshotId must not
    // collide with this fresh one.
    expect(laterSnapshot.snapshotId).not.toBe(annotated.snapshotId);
    expect(
      await fixturePage.evaluate((id) => document.querySelectorAll('[data-pen-snap^="' + id + ':"]').length, annotated.snapshotId),
    ).toBe(0);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browse_act: press Enter submits a form, hover triggers :hover/mouseover, and select changes a real <select>", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === interactUrl }),
      callBrowser(editorPage, "open", { url: interactUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("interact-ready");

    // --- press: Enter inside the search input submits the form ---
    const pressResult = (await callBrowser(editorPage, "act", {
      action: "press",
      key: "Enter",
      target: "#query",
    })) as { error?: string };
    expect(pressResult.error).toBeUndefined();
    await expect(fixturePage).toHaveTitle("Submitted");

    // --- hover: a real CDP mouse move triggers both :hover CSS and the
    // page's own mouseover listener — neither is reachable from a
    // page-script dispatchEvent, which is why this needs CDP at all. ---
    const hoverResult = (await callBrowser(editorPage, "act", { action: "hover", target: "Hover me" })) as {
      error?: string;
    };
    expect(hoverResult.error).toBeUndefined();
    await expect(fixturePage.locator("#hover-result")).toHaveText("hovered");
    await expect
      .poll(() =>
        fixturePage.locator("#hover-target").evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe("rgb(255, 0, 0)");

    // --- select: routes to perform SELECT, still through act's own surface ---
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const fruitIndex = snap.elements.find((e) => e.tag === "select")?.index;
    expect(fruitIndex).not.toBeUndefined();
    const selectResult = (await callBrowser(editorPage, "act", {
      action: "select",
      index: fruitIndex,
      snapshotId: snap.snapshotId,
      text: "Banana",
    })) as { error?: string; changed?: boolean };
    expect(selectResult.error).toBeUndefined();
    expect(selectResult.changed).toBe(true);
    await expect(fixturePage.locator("#sel-fruit")).toHaveValue("Banana");

    // --- wait: text present immediately (found: true), and a genuinely
    // absent string reports found: false rather than erroring ---
    const waitFound = (await callBrowser(editorPage, "act", { action: "wait", text: "Hover me", ms: 2000 })) as {
      found: boolean;
    };
    expect(waitFound.found).toBe(true);
    const waitMissing = (await callBrowser(editorPage, "act", {
      action: "wait",
      text: "Definitely not on this page",
      ms: 300,
    })) as { found: boolean };
    expect(waitMissing.found).toBe(false);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browse_tabs: list/switch/close, and a target=_blank popup reports openedTab", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === interactUrl }),
      callBrowser(editorPage, "open", { url: interactUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("interact-ready");

    // --- a click that opens a target=_blank popup reports openedTab
    // (fixes upstream jev-ultrafast #61 — the agent's current tab follows
    // the popup automatically via agentBrowserTabId). ---
    const [popupPage, clickResult] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === nextUrl }),
      callBrowser(editorPage, "act", { action: "click", target: "Open in new tab" }) as Promise<{
        openedTab?: { tabId: number; url: string; title: string };
      }>,
    ]);
    await expect(popupPage.locator("#ready")).toHaveText("gallery-next-ready");
    expect(clickResult.openedTab).toBeTruthy();
    expect(clickResult.openedTab?.url).toBe(nextUrl);
    const popupTabId = clickResult.openedTab!.tabId;

    // --- list: both browser tabs show up, and the popup (agentBrowserTabId)
    // is reported current ---
    const listed = (await callBrowser(editorPage, "tabs", { action: "list" })) as {
      tabs: { tabId: number; url: string; current: boolean }[];
      current: number | null;
    };
    expect(listed.tabs).toHaveLength(2);
    expect(listed.current).toBe(popupTabId);
    const firstTabId = listed.tabs.find((t) => t.tabId !== popupTabId)!.tabId;

    // --- switch: back to the original interact tab ---
    const switched = (await callBrowser(editorPage, "tabs", { action: "switch", tabId: firstTabId })) as {
      current: number;
    };
    expect(switched.current).toBe(firstTabId);
    // A command against the "current" tab now really is against the
    // switched-to page.
    const readAfterSwitch = (await callBrowser(editorPage, "read", {})) as { url: string };
    expect(readAfterSwitch.url).toBe(interactUrl);

    // --- close: closes a browser tab; closing the popup leaves just one ---
    const closed = (await callBrowser(editorPage, "tabs", { action: "close", tabId: popupTabId })) as {
      tabs: unknown[];
    };
    expect(closed.tabs).toHaveLength(1);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("dialogs: alert() is auto-accepted and reported, without hanging the next command", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === interactUrl }),
      callBrowser(editorPage, "open", { url: interactUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("interact-ready");

    // Playwright itself auto-dismisses JS dialogs on any page it instruments
    // (including this browser tab's own WebContentsView, which it discovers
    // as a "window" the same way it discovers editorPage/fixturePage) unless
    // a `dialog` listener is registered — racing with this app's own CDP
    // session (window.ts's dialog policy) for who gets to call
    // `Page.handleJavaScriptDialog` first. A no-op listener here just opts
    // this page out of Playwright's own handling, so the app's own policy is
    // the only thing that resolves the dialog — matching what a real
    // (non-Playwright-instrumented) run of this app would do.
    fixturePage.on("dialog", () => {});

    const clickResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "Trigger Alert",
    })) as { dialogs?: { tabId?: number; type: string; message: string }[]; error?: string };
    expect(clickResult.error).toBeUndefined();
    // Review finding 6: each dialog is now tagged with the tabId it came
    // from (dialogs are drained from every open browser page, not just
    // whichever one happens to be current) — matched loosely here since
    // this test only cares that the one dialog is reported, not its exact
    // (real, Electron-assigned) tabId.
    expect(clickResult.dialogs).toMatchObject([{ type: "alert", message: "Hello from the page" }]);
    expect(clickResult.dialogs?.[0]).toHaveProperty("tabId");
    // The alert didn't block the page forever — its handler's own follow-up
    // line ran once the dialog was auto-accepted.
    await expect(fixturePage.locator("#after-alert")).toHaveText("after-alert");

    // The very next command must not hang — proof the auto-accept actually
    // unblocked the renderer rather than just being reported after a stall.
    const read = (await callBrowser(editorPage, "read", {})) as { url: string };
    expect(read.url).toBe(interactUrl);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// Review finding 3: dialogs are now auto-handled only while an agent
// browser command is actually running against that tab — this is only
// observable against a real Chromium dialog (a fake/mocked debugger session
// can't prove Chromium itself left a real modal open), so it belongs here,
// not in a unit test.
test("dialogs (finding 3): an alert() the page raises on its own, outside any agent command, is left for the user — not auto-handled", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === interactUrl }),
      callBrowser(editorPage, "open", { url: interactUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("interact-ready");

    // Registering a listener here just opts this page out of Playwright's
    // *own* automatic dialog dismissal (see the previous test's comment) —
    // it does not itself answer the dialog. Capturing the Dialog object lets
    // this test resolve the dialog itself, at a time of its choosing, rather
    // than reading anything (like document.title) off a page whose JS
    // execution is synchronously blocked by the open alert() — a plain
    // page.evaluate()/toHaveTitle() poll would itself hang until *something*
    // answers the dialog, which is exactly the ambiguity this approach
    // avoids.
    const dialogPromise = fixturePage.waitForEvent("dialog");

    // Triggered directly on the page, not through an act/click command —
    // no `browser:command` IPC call is in flight while this runs.
    void fixturePage.evaluate(() => {
      // eslint-disable-next-line no-alert
      window.alert("user-triggered, no agent command in flight");
    });

    const dialog = await dialogPromise;
    expect(dialog.message()).toBe("user-triggered, no agent command in flight");

    // Give the app's own CDP session a window to (wrongly) auto-handle this
    // the way finding 3 says it must not, outside any agent command.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // If the app HAD already resolved the dialog via
    // Page.handleJavaScriptDialog, Chromium would no longer consider one
    // open, and this call — Playwright's own attempt to resolve the *same*
    // dialog — would reject instead of succeeding. It resolving cleanly is
    // the proof the dialog was still genuinely open, left untouched by the
    // app, half a second after it was raised.
    await dialog.dismiss();

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// Review finding 2: on macOS Chromium, a CDP-synthesized Meta/Ctrl-modified
// `Input.dispatchKeyEvent` doesn't run the browser's native editing-command
// table the way a genuine OS-level shortcut would — only a real Chromium
// instance can prove the `commands` field (Puppeteer's own fix) actually
// makes Cmd/Ctrl+A select the field's whole contents; a fake CDP session in
// a unit test can only prove the *parameters* sent, not that Chromium acts
// on them.
test("browse_act: press Ctrl+A selects a field's whole contents via CDP's native editing command (finding 2)", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === interactUrl }),
      callBrowser(editorPage, "open", { url: interactUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("interact-ready");

    const typeResult = (await callBrowser(editorPage, "act", {
      action: "type",
      target: "#query",
      text: "select me",
    })) as { matched?: string };
    expect(typeResult.matched).toBe("#query");
    await expect(fixturePage.locator("#query")).toHaveValue("select me");

    // Ctrl+A works cross-platform here regardless of the host OS — CDP's
    // `commands` field is interpreted the same way by Chromium either way,
    // which is exactly what makes it a fix for the (Mac-specific) native
    // accelerator gap: it never depended on which modifier key was used.
    const selectAllResult = (await callBrowser(editorPage, "act", {
      action: "press",
      key: "Ctrl+a",
      target: "#query",
    })) as { error?: string };
    expect(selectAllResult.error).toBeUndefined();

    const pressResult = (await callBrowser(editorPage, "act", {
      action: "press",
      key: "Backspace",
    })) as { error?: string };
    expect(pressResult.error).toBeUndefined();

    // A single Backspace after Ctrl+A cleared the *whole* field — proof
    // selectAll genuinely ran (a single Backspace with no prior selection
    // would only remove the last character, leaving "select m").
    await expect(fixturePage.locator("#query")).toHaveValue("");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// Second-pass review finding 1: a dialog that opens *between* agent
// commands (a `setTimeout`-delayed alert here — a page's own `load`-handler
// alert would have the same effect) used to sit open indefinitely, since
// dialogs were only auto-handled while a command was actually in flight —
// every later `executeJavaScript` against that tab then hangs on the open
// modal, so every subsequent command silently ran out the full command
// timeout. Only a real Chromium dialog left genuinely open (nothing
// resolves it) proves this — a unit test's fake CDP session can't.
test("dialogs (finding 1): a dialog raised between commands is resolved and reported by the next command, without hanging it", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === autoAlertUrl }),
      callBrowser(editorPage, "open", { url: autoAlertUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("auto-alert-ready");

    // Opts this page out of Playwright's own automatic dialog dismissal
    // (see the finding-3 dialog test's comment above) without itself
    // answering the dialog — capturing the Dialog object lets this test
    // confirm the dialog is genuinely still open before the next command.
    const dialogPromise = fixturePage.waitForEvent("dialog");
    const dialog = await dialogPromise;
    expect(dialog.message()).toBe("delayed alert, no command in flight");

    // The `open` command above has long since resolved by now (the alert
    // fires 2s after load, well past OPEN_LOAD_GRACE_MS) — no
    // `browser:command` is in flight while the dialog sits open here.
    const start = Date.now();
    const snapshotResult = (await callBrowser(editorPage, "snapshot")) as {
      dialogs?: { type: string; message: string }[];
      error?: string;
    };
    const elapsedMs = Date.now() - start;

    expect(snapshotResult.error).toBeUndefined();
    // Resolved and reported by the very next command's pre-dispatch sweep,
    // not left for this test to answer.
    expect(snapshotResult.dialogs).toMatchObject([
      { type: "alert", message: "delayed alert, no command in flight" },
    ]);
    // Well under BROWSER_COMMAND_TIMEOUT_MS (20s) — the command actually ran
    // against an unblocked page, rather than hanging until the dialog
    // resolved some other way.
    expect(elapsedMs).toBeLessThan(5_000);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// Second-pass review finding 4: HOVER_TARGET_JS's scrollIntoView() call used
// to use the page's default scroll behavior — on a page that sets
// html{scroll-behavior:smooth}, the very next line's getBoundingClientRect()
// read the target's position mid-animation, before the smooth scroll had
// actually finished, so the reported hover coordinates missed the real
// element. Only a real smooth-scrolling Chromium page proves this — a unit
// test's fake page has no actual scroll animation to race against.
test("browse_act hover: on a smooth-scroll page, the reported coordinates land on the real (post-scroll) element (finding 4)", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === smoothScrollUrl }),
      callBrowser(editorPage, "open", { url: smoothScrollUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("smooth-scroll-ready");

    const hoverResult = (await callBrowser(editorPage, "act", {
      action: "hover",
      target: "#hover-target",
    })) as { error?: string };
    expect(hoverResult.error).toBeUndefined();

    // :hover only actually triggers (and the mouseover listener only fires)
    // if CDP's Input.dispatchMouseEvent landed on the real element's real,
    // post-scroll coordinates — an instant scroll makes that true even
    // though the page itself asked for a smooth one.
    await expect(fixturePage.locator("#hover-result")).toHaveText("hovered");
    await expect
      .poll(() => fixturePage.locator("#hover-target").evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(255, 0, 0)");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// Wave 2 reliability (docs/superpowers/specs/2026-09-24-browse-speed-contract.md):
// only a real Electron/Chromium page can prove a click is genuinely trusted
// (event.isTrusted), that a synthetic click can't fire pointerdown at all,
// or that Input.insertText fires a real beforeinput event — none of that is
// observable against the hermetic unit suite's fake page.
test("Wave 2 reliability: trusted click fires event.isTrusted and a pointerdown-only menu opens", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave2Url }),
      callBrowser(editorPage, "open", { url: wave2Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave2-ready");

    const clickResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "Trusted Click",
    })) as { via?: string; error?: string };
    expect(clickResult.error).toBeUndefined();
    // The debugger session is attached for every real browser tab, so the
    // hit-test should pass on this simple, unobstructed button and the
    // trusted CDP path should be the one actually taken.
    expect(clickResult.via).toBe("cdp");
    await expect(fixturePage.locator("#trusted-result")).toHaveText("trusted-clicked");

    // A synthetic el.click() (the DOM fallback) never fires "pointerdown" at
    // all — this menu only opens for a real, OS-level mouse press, which is
    // exactly what dispatchClick's CDP path sends.
    const menuClick = (await callBrowser(editorPage, "act", { action: "click", target: "Menu" })) as {
      via?: string;
      error?: string;
    };
    expect(menuClick.error).toBeUndefined();
    expect(menuClick.via).toBe("cdp");
    await expect(fixturePage.locator("#menu")).toBeVisible();

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("Wave 2 reliability: trusted typing selects existing content, fires beforeinput (React-compatible), and reports via: \"cdp\"", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave2Url }),
      callBrowser(editorPage, "open", { url: wave2Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave2-ready");

    // Targeted by CSS selector, not the <label>'s visible text: findByText
    // (used first for a text target) matches the <label for="react-input">
    // element itself — a pre-existing, out-of-scope-for-this-wave quirk in
    // how a bare <label> resolves — which is not editable, so a text target
    // here would hit TYPE_JS's "not editable" error for the wrong reason.
    const typeResult = (await callBrowser(editorPage, "act", {
      action: "type",
      target: "#react-input",
      text: "new value",
    })) as { via?: string; error?: string };
    expect(typeResult.error).toBeUndefined();
    expect(typeResult.via).toBe("cdp");

    // Existing content was selected first, so the new text *replaced* it
    // rather than being appended after "old value".
    await expect(fixturePage.locator("#react-input")).toHaveValue("new value");
    // Input.insertText fires a real beforeinput (like genuine typing/paste)
    // — the legacy native-setter + synthetic Event("input") fallback this
    // path is meant to avoid does not.
    await expect(fixturePage.locator("#beforeinput-result")).toHaveText("beforeinput-fired");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("Wave 2 reliability: act scroll / perform SCROLL scroll an inner container the window itself can't move", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave2Url }),
      callBrowser(editorPage, "open", { url: wave2Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave2-ready");

    // --- act scroll with an explicit CSS-selector target ---
    const beforeScrollTop = await fixturePage.locator("#inner-scroll").evaluate((el) => el.scrollTop);
    expect(beforeScrollTop).toBe(0);
    const windowScrollBefore = await fixturePage.evaluate(() => window.scrollY);

    const scrollResult = (await callBrowser(editorPage, "act", {
      action: "scroll",
      target: "#inner-scroll",
      amount: 1,
    })) as { error?: string };
    expect(scrollResult.error).toBeUndefined();

    await expect
      .poll(() => fixturePage.locator("#inner-scroll").evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    // The window itself never moved — this container is inside a
    // height:200px/overflow:hidden wrapper, so the document has nothing to
    // scroll; only the inner container's own scrollTop changed.
    expect(await fixturePage.evaluate(() => window.scrollY)).toBe(windowScrollBefore);

    // --- snapshot marks the container, and perform SCROLL_DOWN by its index scrolls it further ---
    const snapshotResult = (await callBrowser(editorPage, "snapshot")) as {
      snapshotId: string;
      elements: SnapshotElement[];
    };
    const containerEntry = snapshotResult.elements.find((e) => e.scrollable === true);
    expect(containerEntry).toBeTruthy();
    expect(containerEntry!.ops).toEqual([]);

    const scrollTopAfterFirst = await fixturePage.locator("#inner-scroll").evaluate((el) => el.scrollTop);
    const performResult = (await callBrowser(editorPage, "perform", {
      snapshotId: snapshotResult.snapshotId,
      index: containerEntry!.index,
      operation: "SCROLL_DOWN",
    })) as { error?: string };
    expect(performResult.error).toBeUndefined();
    await expect
      .poll(() => fixturePage.locator("#inner-scroll").evaluate((el) => el.scrollTop))
      .toBeGreaterThan(scrollTopAfterFirst);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("code review finding 5: a hidden text match no longer short-circuits the selector fallback, and <style>/<script> text is never a click target", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave2Url }),
      callBrowser(editorPage, "open", { url: wave2Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave2-ready");

    // "Select" text-matches only the hidden #hidden-select-label button, but
    // is also a valid CSS type selector for the real, visible <select> —
    // the click must land on the <select>, not refuse with the hidden-
    // element error.
    const clickResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "Select",
    })) as { error?: string };
    expect(clickResult.error).toBeUndefined();

    // Text that exists ONLY inside a <style>/<script> element's own source
    // must never resolve to a click target at all.
    const styleOnlyResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "pen-e2e-style-only-text",
    })) as { error?: string };
    expect(styleOnlyResult.error).toMatch(/No element matched/);

    const scriptOnlyResult = (await callBrowser(editorPage, "act", {
      action: "click",
      target: "pen-e2e-script-only-text",
    })) as { error?: string };
    expect(scriptOnlyResult.error).toMatch(/No element matched/);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// Wave 3 reliability (2026-09-24): open shadow roots, iframes (same-origin
// AND cross-origin/OOPIF), a console-error ring buffer, and the botCheck
// heuristic — none of these are provable against the hermetic unit suite's
// fake page (deepQueryAll's shadow-piercing, a real WebFrameMain subtree, a
// real CDP Runtime.exceptionThrown, a real cross-origin renderer process).
test("Wave 3 reliability: open shadow root — click a shadow button by index and read includes shadow text", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave3Url }),
      callBrowser(editorPage, "open", { url: wave3Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave3-ready");

    const snapshotResult = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const shadowEntry = snapshotResult.elements.find((e) => e.label === "Shadow Button");
    expect(shadowEntry).toBeTruthy();

    const clickResult = (await callBrowser(editorPage, "perform", {
      snapshotId: snapshotResult.snapshotId,
      index: shadowEntry!.index,
      operation: "CLICK",
    })) as { error?: string };
    expect(clickResult.error).toBeUndefined();
    await expect(fixturePage.locator("#shadow-host").locator("#shadow-result")).toHaveText("shadow-clicked");

    const readResult = (await callBrowser(editorPage, "read", {})) as ReadResult;
    expect(readResult.error).toBeUndefined();
    expect(readResult.text).toContain("shadow root text digest");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("Wave 3 reliability: same-origin iframe — click a frame button by index", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave3Url }),
      callBrowser(editorPage, "open", { url: wave3Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave3-ready");

    const snapshotResult = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const frameEntry = snapshotResult.elements.find((e) => e.label === "Frame Button");
    expect(frameEntry).toBeTruthy();
    expect(frameEntry!.frame).toBeTruthy();

    const clickResult = (await callBrowser(editorPage, "perform", {
      snapshotId: snapshotResult.snapshotId,
      index: frameEntry!.index,
      operation: "CLICK",
    })) as { error?: string };
    expect(clickResult.error).toBeUndefined();

    const frame = fixturePage.frameLocator("#same-origin-frame");
    await expect(frame.locator("#frame-result")).toHaveText("frame-clicked");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("Wave 3 reliability: cross-origin (OOPIF) iframe — click a frame button by index and read includes its text", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave3Url }),
      callBrowser(editorPage, "open", { url: wave3Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave3-ready");

    const snapshotResult = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const crossEntry = snapshotResult.elements.find((e) => e.label === "Cross Button");
    expect(crossEntry).toBeTruthy();

    const clickResult = (await callBrowser(editorPage, "perform", {
      snapshotId: snapshotResult.snapshotId,
      index: crossEntry!.index,
      operation: "CLICK",
    })) as { error?: string };
    expect(clickResult.error).toBeUndefined();

    const frame = fixturePage.frameLocator("#cross-origin-frame");
    await expect(frame.locator("#cross-result")).toHaveText("cross-clicked");

    const readResult = (await callBrowser(editorPage, "read", {})) as ReadResult;
    expect(readResult.error).toBeUndefined();
    expect(readResult.text).toContain("cross-origin frame text digest");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("Wave 3 reliability: a console error from a throwing click handler is surfaced on a command result", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === wave3Url }),
      callBrowser(editorPage, "open", { url: wave3Url }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("wave3-ready");

    // The click itself still succeeds (a page throwing in its own handler is
    // not a bridge failure) — the exception surfaces as a *console* error,
    // not a command error.
    const clickResult = (await callBrowser(editorPage, "act", { action: "click", target: "Throw" })) as {
      error?: string;
      consoleErrors?: string[];
    };
    expect(clickResult.error).toBeUndefined();

    // "New since the previous command" (the ring buffer is drained on every
    // act/perform call): the exception is thrown synchronously as part of
    // the click's own dispatch and settle, comfortably inside the click
    // command's own round trip — so it typically lands on the CLICK result
    // itself, not a later one. Accumulate across this command and a
    // follow-up poll so the assertion holds either way, without assuming
    // which exact command's drain window it fell into.
    const seen = new Set<string>();
    for (const e of clickResult.consoleErrors ?? []) seen.add(e);

    await expect
      .poll(async () => {
        const waitResult = (await callBrowser(editorPage, "act", { action: "wait", ms: 100 })) as {
          consoleErrors?: string[];
        };
        for (const e of waitResult.consoleErrors ?? []) seen.add(e);
        return [...seen].some((e) => e.includes("wave3 console error fixture"));
      })
      .toBe(true);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("Wave 3 reliability: botCheck is true on a page that looks like a challenge wall", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && !p.url().includes("/gallery"),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const [fixturePage, openResult] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url() === botCheckUrl }),
      callBrowser(editorPage, "open", { url: botCheckUrl }),
    ]);
    await expect(fixturePage.locator("#ready")).toHaveText("botcheck-ready");
    expect(openResult).toMatchObject({ botCheck: true });

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot/perform: a visually hidden native range input is listed with its group context and can be set by typing a number", async () => {
  const { app, editorPage, page } = await openReachFixture(rangeSliderUrl, "range-slider-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const sliders = snap.elements.filter((e) => e.label.includes("slider"));
    expect(sliders).toHaveLength(2);
    expect(snap.elements.some((e) => e.label.includes("Orphan"))).toBe(false);
    const max = snap.elements.find((e) => e.label.includes("Max."));
    expect(max).toBeTruthy();
    expect(max?.label).toBe("Your budget (per night): Max. (slider 20\u2013400, step 10)");
    expect(max?.tag).toBe("input");
    expect(max?.ops).toEqual(["TYPE_TEXT"]);
    expect(max?.value).toBe("400");
    const min = snap.elements.find((e) => e.label.includes("Min."));
    expect(min?.label).toBe("Your budget (per night): Min. (slider 10\u2013390, step 10)");
    expect(min?.value).toBe("10");

    const type = async (text: string) =>
      (await callBrowser(editorPage, "perform", {
        snapshotId: snap.snapshotId,
        index: max!.index,
        operation: "TYPE_TEXT",
        text,
      })) as { error?: string };
    const maxValue = () => page.evaluate(() => (document.querySelectorAll("input[type=range]")[1] as HTMLInputElement).value);

    expect((await type("150 EUR")).error).toBeUndefined();
    expect(await maxValue()).toBe("150");
    await expect(page.locator("#range-status")).toHaveText("Max.=150");

    expect((await type("137")).error).toBeUndefined();
    expect(await maxValue()).toBe("140");
    await expect(page.locator("#range-status")).toHaveText("Max.=140");

    // Clamping is reported, not silently accepted: the value is set to the
    // bound and the error says so (read back from the input).
    expect((await type("9999")).error).toBe("slider can't go above 400 (target 9999) \u2014 it is now at 400");
    expect(await maxValue()).toBe("400");

    expect((await type("\u20ac1,500")).error).toBe("slider can't go above 400 (target 1500) \u2014 it is now at 400");
    expect(await maxValue()).toBe("400");

    const bad = await type("cheap");
    expect(bad.error).toContain("is a slider (20\u2013400); type a number.");
    expect(await maxValue()).toBe("400");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot/perform: ARIA sliders are listed with their group context and set by typing a number via trusted arrow keys", async () => {
  const { app, editorPage, page } = await openReachFixture(ariaSliderUrl, "aria-slider-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.elements.some((e) => e.label.includes("Locked"))).toBe(false);
    const min = snap.elements.find((e) => e.label.includes("Minimum"));
    const max = snap.elements.find((e) => e.label.includes("Maximum"));
    expect(min?.label).toBe("Price range: Minimum (slider 0\u20131000)");
    expect(max?.label).toBe("Price range: Maximum (slider 0\u20131000)");
    expect(max?.ops).toEqual(["TYPE_TEXT"]);
    expect(max?.value).toBe("900");
    expect(min?.value).toBe("100");
    const fine = snap.elements.find((e) => e.label.includes("Fine step"));
    const noPage = snap.elements.find((e) => e.label.includes("No page keys"));
    const offGrid = snap.elements.find((e) => e.label.includes("Off grid"));
    const stuck = snap.elements.find((e) => e.label.includes("Stuck"));
    expect(fine?.label).toBe("Fine step (slider 0\u20131000)");
    expect(stuck).toBeTruthy();
    // Value privacy: only the numeric aria-valuenow, never aria-valuetext.
    expect(stuck?.value).toBe("500");
    // Disabled native ranges (own attribute / disabled fieldset) are not offered.
    expect(snap.elements.some((e) => e.label.includes("Disabled slider"))).toBe(false);
    expect(snap.elements.some((e) => e.label.includes("Fieldset disabled"))).toBe(false);
    // A text input with role=slider keeps the input branch's privacy rules.
    const card = snap.elements.find((e) => e.label.includes("Card slider"));
    expect(card).toBeTruthy();
    expect(card?.value).toBeUndefined();

    const type = async (el: { index: number } | undefined, text: string) =>
      (await callBrowser(editorPage, "perform", {
        snapshotId: snap.snapshotId,
        index: el!.index,
        operation: "TYPE_TEXT",
        text,
      })) as { error?: string; changed?: boolean; sliderValue?: number };
    const now = (id: string) => page.evaluate((i) => Number(document.getElementById(i)!.getAttribute("aria-valuenow")), id);

    // e.key variant, moving up.
    const r1 = await type(min, "300");
    expect(r1.error).toBeUndefined();
    expect(await now("s-min")).toBe(300);
    expect(r1.sliderValue).toBe(300);
    expect(r1.changed).toBe(true);
    await expect(page.locator("#aria-status")).toHaveText("Minimum=300");

    // keyCode-only variant, moving down: constructed events would not work.
    const r2 = await type(max, "300");
    expect(r2.error).toBeUndefined();
    expect(await now("s-max")).toBe(300);

    // A formatted number equal to the max goes through End.
    expect((await type(max, "\u20ac 1,000")).error).toBeUndefined();
    expect(await now("s-max")).toBe(1000);

    // Not on the 25 grid: lands on the nearest reachable value.
    expect((await type(max, "310")).error).toBeUndefined();
    expect(Math.abs((await now("s-max")) - 310)).toBeLessThanOrEqual(12.5);

    // Beyond the range is an honest error too, with the value at the bound.
    const over = await type(max, "9999");
    expect(over.error).toBe("slider can't go above 1000 (target 9999) \u2014 it is now at 1000");
    expect(over.changed).toBe(true);
    expect(await now("s-max")).toBe(1000);

    const bad = await type(max, "cheap");
    expect(bad.error).toContain("is a slider (0\u20131000); type a number.");

    // Off-grid start (137, step 10): 137 -> 140 is a partial first step.
    const off = await type(offGrid, "300");
    expect(off.error).toBeUndefined();
    expect(await now("s-offgrid")).toBe(300);

    // A target exactly between two grid points (300 -> 305, step 10) is as
    // close as it gets: success, not a swing back and forth.
    const half = await type(offGrid, "305");
    expect(half.error).toBeUndefined();
    expect(Math.abs((await now("s-offgrid")) - 305)).toBeLessThanOrEqual(5);

    // No aria-valuemin/max: nothing is clamped to the 0/100 spec defaults.
    const free = snap.elements.find((e) => e.label.includes("Free"));
    expect(free?.label).toBe("Free (slider)");
    expect((await type(free, "700")).error).toBeUndefined();
    expect(await now("s-free")).toBe(700);

    // A widget that handles only arrows: the probes of Home/End/PageUp/
    // PageDown it ignores must not leave the page scrolled.
    const arrows = snap.elements.find((e) => e.label.includes("Arrows only"));
    expect((await type(arrows, "400")).error).toBeUndefined();
    expect(await now("s-arrows")).toBe(400);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // Off-grid start on a widget that does not snap (37, step 25): the
    // arrows alone can only reach 12/37/62/87; one Home realignment lands 50.
    const nonSnap = snap.elements.find((e) => e.label.includes("Non snapping"));
    const rn = await type(nonSnap, "50");
    expect(rn.error).toBeUndefined();
    expect(await now("s-nonsnap")).toBe(50);

    // Marks-only slider (stops 0/26/37/100), target 75: the nearest stop is
    // 100, 25 away on a 0-100 range. That is not a success, and the message
    // must say where it is now; the value did move (evidence attached).
    const marks = snap.elements.find((e) => e.label.includes("Marks"));
    const rm = await type(marks, "75");
    expect(rm.error).toContain("can't be set to exactly 75");
    expect(rm.error).toContain("nearest reachable value is 100");
    expect(rm.error).toContain("now at 100");
    expect(rm.changed).toBe(true);
    expect(await now("s-marks")).toBe(100);

    // Same honesty for a coarse native range: step 50, asked for 30.
    const coarse = snap.elements.find((e) => e.label.includes("Coarse"));
    const rc = await type(coarse, "30");
    expect(rc.error).toContain("nearest reachable value is 50");
    expect(await page.evaluate(() => (document.getElementById("r-coarse") as HTMLInputElement).value)).toBe("50");

    // Step 1 over 900 succeeds through PageUp/PageDown (+-100) plus arrows.
    await page.evaluate(() => ((window as unknown as { __keydowns: number }).__keydowns = 0));
    const paged = await type(fine, "900");
    expect(paged.error).toBeUndefined();
    expect(await now("s-fine")).toBe(900);
    expect(await page.evaluate(() => (window as unknown as { __keydowns: number }).__keydowns)).toBeLessThan(300);

    // The press cap still holds (and errors) when the widget has no page keys
    // -- and the error still reports that the value moved.
    await page.evaluate(() => ((window as unknown as { __keydowns: number }).__keydowns = 0));
    const capped = await type(noPage, "500");
    expect(capped.error).toMatch(/^slider stopped at \d+ \(target 500\) after the press limit/);
    expect(capped.changed).toBe(true);
    const presses = await page.evaluate(() => (window as unknown as { __keydowns: number }).__keydowns);
    expect(presses).toBeLessThanOrEqual(300);
    expect(presses).toBeGreaterThan(0);

    // A native range disabled by its own attribute cannot be typed into.
    const disabledType = (await callBrowser(editorPage, "act", {
      action: "type",
      target: "#r-disabled",
      text: "80",
    })) as { error?: string };
    expect(disabledType.error).toContain("a disabled slider.");
    expect(await page.evaluate(() => (document.getElementById("r-disabled") as HTMLInputElement).value)).toBe("30");

    // A slider that ignores keys is reported, not looped on.
    await page.evaluate(() => ((window as unknown as { __keydowns: number }).__keydowns = 0));
    const dead = await type(stuck, "700");
    expect(dead.error).toBe("slider stopped at 500 (target 700)");
    expect(await page.evaluate(() => (window as unknown as { __keydowns: number }).__keydowns)).toBeLessThanOrEqual(4);
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser perform: an ARIA slider is still driven while the agent's browser tab is hidden (user is in the editor tab)", async () => {
  const { app, editorPage, page } = await openReachFixture(ariaSliderUrl, "aria-slider-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const min = snap.elements.find((e) => e.label.includes("Minimum"));
    // What TabManager.setActive does to a tab the user switched away from.
    // (This shell keeps a hidden tab's document reporting focus, so an
    // unfocused window itself can't be simulated here; the top-level path
    // must not depend on document.hasFocus() either way.)
    const hidden = await app.evaluate(({ BaseWindow }) => {
      let n = 0;
      for (const w of BaseWindow.getAllWindows()) {
        for (const c of w.contentView.children) {
          const wc = (c as unknown as { webContents?: Electron.WebContents }).webContents;
          if (wc && wc.getURL().includes("aria-slider")) {
            (c as unknown as { setVisible(v: boolean): void }).setVisible(false);
            n++;
          }
        }
      }
      return n;
    });
    expect(hidden).toBe(1);
    const res = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: min!.index,
      operation: "TYPE_TEXT",
      text: "300",
    })) as { error?: string };
    expect(res.error).toBeUndefined();
    expect(await page.evaluate(() => Number(document.getElementById("s-min")!.getAttribute("aria-valuenow")))).toBe(300);
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: bare ARIA sliders get their own card's text as context, without tick labels", async () => {
  const { app, editorPage } = await openReachFixture(ariaCardsUrl, "aria-cards-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const sliders = snap.elements.filter((e) => e.label.includes("slider"));
    expect(sliders).toHaveLength(6);
    const labels = sliders.map((e) => e.label);
    // Two sliders share one demo (the Ant shape: title in a sibling block
    // AFTER them): both carry that title and, being bare, are identical.
    expect(labels.filter((l) => l.includes("Range demo"))).toHaveLength(2);
    expect(new Set(labels).size).toBe(5);
    // A live readout ("Up to \u20ac400") changes as the slider moves and
    // would break relocation: it never becomes context.
    const budget = labels.find((l) => l.includes("Budget"));
    expect(budget).toBeTruthy();
    expect(budget).not.toContain("400");
    expect(labels.find((l) => l.includes("Volume"))).toContain("Adjust the output level");
    expect(labels.find((l) => l.includes("Graduated slider"))).toBeTruthy();
    expect(labels.find((l) => l.includes("Brightness"))).toBeTruthy();
    for (const l of labels) {
      expect(l).not.toContain("\u00b0C");
      expect(l).toMatch(/\(slider 0\u2013100\)$/);
    }
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a lone bare ARIA slider under a site header/nav does not get the header text as context", async () => {
  const { app, editorPage } = await openReachFixture(ariaHeaderUrl, "aria-header-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const sliders = snap.elements.filter((e) => e.label.includes("slider"));
    expect(sliders).toHaveLength(1);
    expect(sliders[0].label).not.toMatch(/Acme|Pricing|Home/);
    expect(sliders[0].label).toBe("slider 0\u2013100");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a page denser than the cap keeps the top of the viewport and lists it in reading order", async () => {
  const { app, editorPage } = await openReachFixture(longListUrl, "long-list-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.elements.length).toBe(120);
    const pos = snap.elements.map((e) => {
      const m = /^Row (\d+) link (\d+)$/.exec(e.label);
      expect(m, e.label).not.toBeNull();
      return Number(m![1]) * 10 + Number(m![2]);
    });
    // The first row on the page is the first thing in the table...
    expect(pos[0]).toBe(0);
    // ...and the table follows the page: row by row, left to right.
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: custom listbox options, switches and date-grid days are listed with their state and clickable", async () => {
  const { app, editorPage, page } = await openReachFixture(ariaListboxUrl, "aria-listbox-ready");
  try {
    const closed = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const combo = closed.elements.find((e) => e.role === "combobox");
    expect(combo).toBeTruthy();
    // Options of a closed list are hidden and never offered.
    expect(closed.elements.filter((e) => e.role === "option")).toHaveLength(0);
    const sw = closed.elements.find((e) => e.role === "switch");
    expect(sw?.checked).toBe(true);
    // Only the selectable days: past (aria-disabled) days are not offered.
    const days = closed.elements.filter((e) => e.role === "gridcell");
    expect(days.map((d) => d.label)).toEqual(
      Array.from({ length: 5 }, (_, i) => `November ${i + 10}, 2026`),
    );
    expect(days.every((d) => d.checked === false && d.ops.includes("CLICK"))).toBe(true);

    const opened = (await callBrowser(editorPage, "perform", {
      snapshotId: closed.snapshotId,
      index: combo!.index,
      operation: "CLICK",
    })) as { error?: string };
    expect(opened.error).toBeUndefined();

    const open = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const options = open.elements.filter((e) => e.role === "option");
    expect(options.map((o) => [o.label, o.checked])).toEqual([
      ["Round trip", true],
      ["One way", false],
    ]);
    const oneWay = options.find((o) => o.label === "One way")!;
    expect(oneWay.ops).toEqual(["CLICK"]);
    const picked = (await callBrowser(editorPage, "perform", {
      snapshotId: open.snapshotId,
      index: oneWay.index,
      operation: "CLICK",
    })) as { error?: string };
    expect(picked.error).toBeUndefined();
    await expect(page.locator("#trip")).toHaveText("One way");

    const day = days.find((d) => d.label === "November 14, 2026")!;
    const again = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const day14 = again.elements.find((e) => e.label === day.label)!;
    const clicked = (await callBrowser(editorPage, "perform", {
      snapshotId: again.snapshotId,
      index: day14.index,
      operation: "CLICK",
    })) as { error?: string };
    expect(clicked.error).toBeUndefined();
    await expect(page.locator("#chosen-date")).toHaveText("November 14, 2026");
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a scrolling date picker lists only the shown month's selectable days, once each, by their full name", async () => {
  const { app, editorPage, page } = await openReachFixture(ariaCalendarUrl, "aria-calendar-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const days = snap.elements.filter((e) => e.role === "gridcell");
    // Named by the child's aria-label, never the bare "14" every month shares.
    for (const d of days) expect(d.label).toMatch(/^[A-Z][a-z]+ \d+, 2026$/);
    // A year of days is far over the cap: the month shown in the panel
    // survives whole, the months scrolled far out of it do not.
    expect(days.filter((d) => d.label.startsWith("November"))).toHaveLength(30);
    expect(days.some((d) => /^(June|July|August|September) /.test(d.label))).toBe(false);
    // The cell's inner role=button is not a second entry for the same day.
    expect(snap.elements.filter((e) => e.role === "button")).toHaveLength(0);

    const day14 = days.find((d) => d.label === "November 14, 2026");
    expect(day14).toBeTruthy();
    const res = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: day14!.index,
      operation: "CLICK",
    })) as { error?: string };
    expect(res.error).toBeUndefined();
    await expect(page.locator("#chosen-day")).toHaveText("November 14");

    // Scroll back to October: its past (aria-hidden) days are never offered.
    await page.evaluate(() => (document.getElementById("scroller")!.scrollTop = 0));
    const oct = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const octDays = oct.elements.filter((e) => e.role === "gridcell" && e.label.startsWith("October"));
    expect(octDays.length).toBeGreaterThan(0);
    for (const d of octDays) expect(Number(/October (\d+)/.exec(d.label)![1])).toBeGreaterThanOrEqual(20);
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: a custom combobox reports its shown choice as value and whether its list is open", async () => {
  const { app, editorPage } = await openReachFixture(ariaListboxUrl, "aria-listbox-ready");
  try {
    const closed = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const combo = closed.elements.find((e) => e.role === "combobox") as SnapshotElement & { expanded?: boolean };
    expect(combo.value).toBe("Round trip");
    expect(combo.expanded).toBe(false);
    await callBrowser(editorPage, "perform", { snapshotId: closed.snapshotId, index: combo.index, operation: "CLICK" });
    const open = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const openCombo = open.elements.find((e) => e.role === "combobox") as SnapshotElement & { expanded?: boolean };
    expect(openCombo.expanded).toBe(true);
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser snapshot: an open calendar's many visible days never crowd out its confirm button; text fields are clickable", async () => {
  const { app, editorPage } = await openReachFixture(`${ariaCalendarUrl}?tall=1`, "aria-calendar-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    expect(snap.elements.filter((e) => e.role === "gridcell").length).toBeGreaterThan(100);
    expect(snap.elements.some((e) => e.label === "Done")).toBe(true);
    // A date field that opens its picker on click has no attribute saying so.
    expect(snap.elements.find((e) => e.label === "Departure")?.ops).toEqual(["TYPE_TEXT", "CLICK"]);
  } finally {
    await app.close().catch(() => {});
  }
});

// "Scroll only if needed" (Google Flights calendar): a reveal must never move
// a target that is already fully visible. The strip's own scroll handler
// snaps it back after ~200ms, so any scroll here would move the click target
// between the coordinates being computed and the click landing.
test("reveal: an already-visible target in a horizontal strip is clicked without scrolling the strip", async () => {
  const { app, editorPage, page } = await openReachFixture(revealStripUrl, "reveal-strip-ready");
  try {
    const res = (await callBrowser(editorPage, "act", { action: "click", target: "Day Two" })) as {
      error?: string;
      via?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.via).toBe("cdp");
    await expect(page.locator("#chosen")).toHaveText("d2");
    // Let any (wrongly) triggered snap-back handler fire, then check nothing ever scrolled.
    await page.waitForTimeout(400);
    await expect(page.locator("#max-scroll")).toHaveText("0");
    expect(await page.evaluate(() => document.getElementById("strip")!.scrollLeft)).toBe(0);
  } finally {
    await app.close().catch(() => {});
  }
});

test("reveal: a target below the fold is still scrolled into view and clicked", async () => {
  const { app, editorPage, page } = await openReachFixture(revealFoldUrl, "reveal-fold-ready");
  try {
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const res = (await callBrowser(editorPage, "act", { action: "click", target: "Below Fold" })) as {
      error?: string;
      via?: string;
    };
    expect(res.error).toBeUndefined();
    await expect(page.locator("#chosen")).toHaveText("below");
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  } finally {
    await app.close().catch(() => {});
  }
});

// "Typing follows the focus the click moved" (Google Flights "Where from?"):
// the click opens an overlay and focuses a different input; the text must end
// up there, not in the covered original.
for (const mode of ["sync", "async"] as const) {
  test(`type: a click that opens an overlay and focuses another input (${mode}) types into the overlay input`, async () => {
    const { app, editorPage, page } = await openReachFixture(`${focusOverlayUrl}?mode=${mode}`, "focus-overlay-ready");
    try {
      const res = (await callBrowser(editorPage, "act", {
        action: "type",
        target: "#from",
        text: "Berlin",
      })) as { error?: string; via?: string; retargeted?: boolean; changed?: boolean };
      expect(res.error).toBeUndefined();
      expect(res.via).toBe("cdp");
      expect(res.retargeted).toBe(true);
      expect(res.changed).toBe(true);
      await expect(page.locator("#overlay-input")).toHaveValue("Berlin");
      await expect(page.locator("#suggest")).toHaveText("Berlin, Germany");
      // The covered original is left exactly as it was.
      await expect(page.locator("#from")).toHaveValue(mode === "async" ? "Munich" : "");
    } finally {
      await app.close().catch(() => {});
    }
  });
}

test("type: perform TYPE_TEXT by snapshot index also follows the focus an overlay-opening click moved", async () => {
  const { app, editorPage, page } = await openReachFixture(`${focusOverlayUrl}?mode=sync`, "focus-overlay-ready");
  try {
    const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
    const from = snap.elements.find((e) => e.label === "Where from?");
    expect(from).toBeTruthy();
    const res = (await callBrowser(editorPage, "perform", {
      snapshotId: snap.snapshotId,
      index: from!.index,
      operation: "TYPE_TEXT",
      text: "Berlin",
    })) as { error?: string; via?: string; retargeted?: boolean };
    expect(res.error).toBeUndefined();
    expect(res.via).toBe("cdp");
    expect(res.retargeted).toBe(true);
    await expect(page.locator("#overlay-input")).toHaveValue("Berlin");
    await expect(page.locator("#suggest")).toHaveText("Berlin, Germany");
    await expect(page.locator("#from")).toHaveValue("");
  } finally {
    await app.close().catch(() => {});
  }
});

test("type: a plain input still types normally (no retarget), and typing into B does not retarget into the previously focused A", async () => {
  const { app, editorPage, page } = await openReachFixture(`${focusOverlayUrl}?mode=none`, "focus-overlay-ready");
  try {
    const plain = (await callBrowser(editorPage, "act", { action: "type", target: "#from", text: "Paris" })) as {
      error?: string;
      via?: string;
      retargeted?: boolean;
    };
    expect(plain.error).toBeUndefined();
    expect(plain.via).toBe("cdp");
    expect(plain.retargeted).toBeUndefined();
    await expect(page.locator("#from")).toHaveValue("Paris");

    await page.evaluate(() => document.getElementById("a")!.focus());
    const b = (await callBrowser(editorPage, "act", { action: "type", target: "#b", text: "Bee" })) as {
      error?: string;
      retargeted?: boolean;
    };
    expect(b.error).toBeUndefined();
    expect(b.retargeted).toBeUndefined();
    await expect(page.locator("#b")).toHaveValue("Bee");
    await expect(page.locator("#a")).toHaveValue("");
  } finally {
    await app.close().catch(() => {});
  }
});

// Autocomplete settle: suggestions are fetched behind a debounce, so an
// immediate snapshot after typing used to miss the option the agent must pick.
for (const via of ["act", "perform"] as const) {
  test(`type (${via}): returns only once the autocomplete suggestions exist, so the very next snapshot offers them`, async () => {
    const { app, editorPage } = await openReachFixture(autocompleteUrl, "autocomplete-ready");
    try {
      let res: { error?: string };
      if (via === "act") {
        res = (await callBrowser(editorPage, "act", { action: "type", target: "#to", text: "Barcelona" })) as { error?: string };
      } else {
        const first = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
        const to = first.elements.find((e) => e.label === "Where to?");
        expect(to).toBeTruthy();
        res = (await callBrowser(editorPage, "perform", {
          snapshotId: first.snapshotId,
          index: to!.index,
          operation: "TYPE_TEXT",
          text: "Barcelona",
        })) as { error?: string };
      }
      expect(res.error).toBeUndefined();
      const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
      expect(snap.elements.some((e) => e.label === "Barcelona, Spain")).toBe(true);
      // The focus-time "popular" list must be gone, not mistaken for the result.
      expect(snap.elements.some((e) => e.label === "Paris, France")).toBe(false);
    } finally {
      await app.close().catch(() => {});
    }
  });
}

test("type: a plain input on the autocomplete page types normally and reports no autocomplete field", async () => {
  const { app, editorPage, page } = await openReachFixture(autocompleteUrl, "autocomplete-ready");
  try {
    const res = (await callBrowser(editorPage, "act", { action: "type", target: "#plain", text: "hello" })) as {
      error?: string;
      via?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.via).toBe("cdp");
    expect(res).not.toHaveProperty("autocomplete");
    await expect(page.locator("#plain")).toHaveValue("hello");
  } finally {
    await app.close().catch(() => {});
  }
});

// Late click effects: the site closes a dialog (or renders a result) ~300ms
// AFTER the click, past the controller's settle. The click must still report
// the effect, and the very next snapshot must no longer be scoped to the
// closing dialog.
for (const via of ["act", "perform"] as const) {
  test(`click (${via}): a dialog's Done that hides it after 300ms reports changed and leaves no stale modal`, async () => {
    const { app, editorPage } = await openReachFixture(lateEffectUrl, "late-effect-ready");
    try {
      let res: { error?: string; changed?: boolean };
      if (via === "act") {
        res = (await callBrowser(editorPage, "act", { action: "click", target: "#done" })) as typeof res;
      } else {
        const first = (await callBrowser(editorPage, "snapshot")) as SnapshotResult;
        const done = first.elements.find((e) => e.label === "Done");
        expect(done).toBeTruthy();
        res = (await callBrowser(editorPage, "perform", {
          snapshotId: first.snapshotId,
          index: done!.index,
          operation: "CLICK",
        })) as typeof res;
      }
      expect(res.error).toBeUndefined();
      expect(res.changed).toBe(true);
      const snap = (await callBrowser(editorPage, "snapshot")) as SnapshotResult & { modal?: string };
      expect(snap.modal).toBeUndefined();
      expect(snap.elements.some((e) => e.label === "Search flights")).toBe(true);
    } finally {
      await app.close().catch(() => {});
    }
  });
}

test("click: a button outside any dialog whose effect lands after 300ms reports changed", async () => {
  const { app, editorPage } = await openReachFixture(lateEffectUrl, "late-effect-ready");
  try {
    // Dismiss the dialog first so #late is reachable; its own 300ms close is
    // already covered above, and the next click below starts on a quiet page.
    await callBrowser(editorPage, "act", { action: "click", target: "#done" });
    const res = (await callBrowser(editorPage, "act", { action: "click", target: "#late" })) as {
      error?: string;
      changed?: boolean;
    };
    expect(res.error).toBeUndefined();
    expect(res.changed).toBe(true);
  } finally {
    await app.close().catch(() => {});
  }
});

test("click: a non-dismissing control inside a dialog reports its immediate effect without waiting for the dialog", async () => {
  const { app, editorPage } = await openReachFixture(lateEffectUrl, "late-effect-ready");
  try {
    const started = Date.now();
    const res = (await callBrowser(editorPage, "act", { action: "click", target: "#day" })) as {
      error?: string;
      changed?: boolean;
    };
    expect(res.error).toBeUndefined();
    expect(res.changed).toBe(true);
    // The dialog stays open (it never closes): a dialog wait would cost its 1s cap.
    expect(Date.now() - started).toBeLessThan(900);
  } finally {
    await app.close().catch(() => {});
  }
});

test("click: Done in a shadow-root dialog (display:contents wrapper) waits for the dialog to really close", async () => {
  const { app, editorPage, page } = await openReachFixture(shadowDialogUrl, "shadow-dialog-ready");
  try {
    const res = (await callBrowser(editorPage, "act", { action: "click", target: "Done" })) as {
      error?: string;
      changed?: boolean;
    };
    expect(res.error).toBeUndefined();
    expect(res.changed).toBe(true);
    // Reported only after the panel is gone: a zero-rect wrapper (or a dialog
    // the probe cannot reach in the shadow root) used to read as closed at once.
    const panelDisplay = await page.evaluate(() => {
      const host = document.getElementById("host")!;
      return getComputedStyle(host.shadowRoot!.getElementById("panel")!).display;
    });
    expect(panelDisplay).toBe("none");
  } finally {
    await app.close().catch(() => {});
  }
});

test("click: a control named 'Closest airports' inside a dialog is not treated as dismissing (no dialog wait)", async () => {
  const { app, editorPage } = await openReachFixture(lateEffectUrl, "late-effect-ready");
  try {
    const started = Date.now();
    const res = (await callBrowser(editorPage, "act", { action: "click", target: "#closest" })) as {
      error?: string;
      changed?: boolean;
    };
    expect(res.error).toBeUndefined();
    expect(res.changed).toBe(true);
    expect(Date.now() - started).toBeLessThan(900);
  } finally {
    await app.close().catch(() => {});
  }
});

test("click: the signature MutationObserver a final keep-peek leaves behind disconnects itself", async () => {
  test.setTimeout(60_000);
  const { app, editorPage, page } = await openReachFixture(lateEffectUrl, "late-effect-ready");
  try {
    const res = (await callBrowser(editorPage, "act", { action: "click", target: "#day" })) as { changed?: boolean };
    expect(res.changed).toBe(true);
    // The change was found on a keep-peek, so nothing tore the observer down;
    // its own timer must (and the state is unusable to any other capture id).
    await page.waitForFunction(
      () => !(window as unknown as { __penSigObserver?: unknown }).__penSigObserver,
      null,
      { timeout: 15_000 },
    );
  } finally {
    await app.close().catch(() => {});
  }
});
