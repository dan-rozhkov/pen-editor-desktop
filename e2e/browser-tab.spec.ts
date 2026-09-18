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

// A single inline data: URI image, deliberately larger (by rendered area)
// than every http(s) image on the page — if FIND_IMAGES_JS's http(s)-only
// filter (finding 8) ever regresses, this would sort to the very front of
// defaultImages.images instead of being excluded outright.
const DATA_URI_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="orange"/></svg>`,
)}`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/pixel.svg")) {
      const color = new URL(req.url, "http://pixel.local").searchParams.get("color") || "black";
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${color}"/></svg>`);
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
<button id="btn-icon" style="width:24px;height:24px"><svg width="16" height="16"></svg></button>
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
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

type BrowserBridge = {
  open(args: { url: string }): Promise<unknown>;
  act(args: Record<string, unknown>): Promise<unknown>;
  findImages(args: Record<string, unknown>): Promise<unknown>;
  snapshot(): Promise<unknown>;
  perform(args: Record<string, unknown>): Promise<unknown>;
};

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
    expect(openResult).toEqual({ url: galleryUrl, title: "Gallery" });
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
    const secondOpen = (await callBrowser(editorPage, "open", { url: nextUrl })) as { url: string; title: string };
    expect(secondOpen).toEqual({ url: nextUrl, title: "Gallery Next" });
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
    // The password input has no aria-label/text/placeholder/alt either, so
    // it too gets a fallback label like "input #<n>" rather than being
    // dropped or leaking a blank label.
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
    // tel/email have no aria-label/text/placeholder/alt, so (like the
    // password/icon-button fixtures above) they fall back to "input #<n>"
    // and must report hasValue rather than value.
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
