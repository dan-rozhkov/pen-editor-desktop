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
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

type BrowserBridge = {
  open(args: { url: string }): Promise<unknown>;
  act(args: Record<string, unknown>): Promise<unknown>;
  findImages(args: Record<string, unknown>): Promise<unknown>;
};

function callBrowser<K extends keyof BrowserBridge>(
  page: Page,
  method: K,
  args: Parameters<BrowserBridge[K]>[0],
): Promise<unknown> {
  return page.evaluate(
    ({ method, args }) =>
      (window as unknown as { penDesktop: { browser: BrowserBridge } }).penDesktop.browser[
        method as keyof BrowserBridge
      ](args as never),
    { method, args },
  );
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
