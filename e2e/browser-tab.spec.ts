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
let clickTargetUrl: string;
let evidenceUrl: string;
let selfDisableUrl: string;
let readUrl: string;
let imagesMetaUrl: string;
let slowLoadUrl: string;

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
    // Default: stub editor page, same shape as e2e/smoke.spec.ts's.
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>
        if (window.penDesktop) {
          window.penDesktop.setDocumentTitle('Stub');
        }
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  galleryUrl = `${baseUrl}/gallery`;
  nextUrl = `${baseUrl}/gallery/next`;
  snapshotUrl = `${baseUrl}/snapshot`;
  snapshotManyUrl = `${baseUrl}/snapshot-many`;
  clickTargetUrl = `${baseUrl}/click-target`;
  evidenceUrl = `${baseUrl}/evidence`;
  selfDisableUrl = `${baseUrl}/self-disable`;
  readUrl = `${baseUrl}/read`;
  imagesMetaUrl = `${baseUrl}/images-meta`;
  slowLoadUrl = `${baseUrl}/slow-load`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

type BrowserBridge = {
  open(args: { url: string }): Promise<unknown>;
  act(args: Record<string, unknown>): Promise<unknown>;
  findImages(args: Record<string, unknown>): Promise<unknown>;
  snapshot(): Promise<unknown>;
  perform(args: Record<string, unknown>): Promise<unknown>;
  read(args?: Record<string, unknown>): Promise<unknown>;
};

/** "Addendum 2, 2026-09-19" §1 — merged into act/perform results alongside
 * whatever they already returned. */
interface EffectEvidence {
  changed: boolean;
  changes: string[];
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
  /** Addendum D: present instead of `value` for every other input/select. */
  hasValue?: boolean;
  ops: string[];
  options?: string[];
  /** Only ever present, and only ever true, for a password input. */
  isPassword?: boolean;
}

interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  scroll: { y: number; height: number; atBottom: boolean };
  snapshotId: string;
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
    expect(placeholderInput?.ops).toEqual(["TYPE_TEXT"]);

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

    // --- select: SELECT ops and options list. A <select> is never eligible
    // for `value` (addendum D lists only input[type=text],
    // input[type=search], and textarea) — it reports `hasValue` instead. ---
    const select = snap.elements.find((e) => e.tag === "select");
    expect(select?.ops).toEqual(["SELECT"]);
    expect(select?.options).toEqual(["Red", "Green", "Blue"]);
    expect(select?.value).toBeUndefined();
    expect(select?.hasValue).toBe(true);

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
    const inputsWithoutValue = snap.elements.filter((e) => e.tag === "input" && e.value === undefined);
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
    const selectIndex = selectSnapshot.elements.find((e) => e.tag === "select")?.index;
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
