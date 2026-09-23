// Deterministic, LLM-free sanity check of e2e/fixtures/bench-shop (used by the
// opt-in e2e/bench-browse.spec.ts benchmark). Lives in the *default* e2e suite
// on purpose — CI runs this every push, so a change to the fixture that breaks
// the flow the bench prompt depends on is caught here, not only when someone
// remembers to run the (expensive, opt-in) bench itself.
//
// Drives the flow exactly the way e2e/browser-tab.spec.ts does: a stub editor
// page (its own tiny local server, distinct from the shop) loaded as
// PEN_DESKTOP_URL, then window.penDesktop.browser.{open,act,snapshot,read}
// over real IPC into a real WebContentsView pointed at the shop server — no
// LLM, no chat, no network beyond localhost.

import { test, expect, _electron as electron, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startBenchShopServer, type BenchShopServer } from "./fixtures/bench-shop/server";

let editorServer: http.Server;
let editorBaseUrl: string;
let shop: BenchShopServer;

test.beforeAll(async () => {
  editorServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>
        if (window.penDesktop) { window.penDesktop.setDocumentTitle('Stub'); }
      </script>`);
  });
  await new Promise<void>((resolve) => editorServer.listen(0, "127.0.0.1", resolve));
  editorBaseUrl = `http://127.0.0.1:${(editorServer.address() as AddressInfo).port}`;
  shop = await startBenchShopServer();
});

test.afterAll(async () => {
  await new Promise<void>((r) => editorServer.close(() => r()));
  await shop.close();
});

interface BrowserBridge {
  open(args: { url: string }): Promise<{ url: string; title: string; loaded: boolean; error?: string }>;
  act(args: Record<string, unknown>): Promise<Record<string, unknown> & { error?: string }>;
  snapshot(): Promise<{ elements: { index: number; tag: string; label: string; ops: string[]; checked?: boolean }[]; snapshotId: string }>;
  read(args?: Record<string, unknown>): Promise<{ url: string; title: string; text: string; error?: string }>;
}

function callBrowser<K extends keyof BrowserBridge>(
  page: Page,
  method: K,
  args?: Parameters<BrowserBridge[K]>[0],
): Promise<Awaited<ReturnType<BrowserBridge[K]>>> {
  return page.evaluate(
    ({ method, args }) =>
      (window as unknown as { penDesktop: { browser: BrowserBridge } }).penDesktop.browser[
        method as keyof BrowserBridge
      ](args as never),
    { method, args },
  ) as Promise<Awaited<ReturnType<BrowserBridge[K]>>>;
}

test("bench-shop fixture: consent gate, search, hover menu, filters, checkout validation, and order recording", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: editorBaseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(editorBaseUrl),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    // --- open: lands on the home page with the consent banner still up ---
    const [shopPage] = await Promise.all([
      app.waitForEvent("window", { predicate: (p) => p.url().startsWith(shop.url) }),
      callBrowser(editorPage, "open", { url: shop.url }),
    ]);
    await expect(shopPage.locator("#home-heading")).toBeVisible();
    await expect(shopPage.locator("#cookie-overlay")).toBeVisible();

    // --- blocked: submitting the search form (Enter) while the banner is up
    // must not navigate away from "/" ---
    const typeBlocked = await callBrowser(editorPage, "act", { action: "type", target: "#search-input", text: "headphones" });
    expect(typeBlocked.error).toBeUndefined();
    const pressBlocked = await callBrowser(editorPage, "act", { action: "press", key: "Enter", target: "#search-input" });
    expect(pressBlocked.error).toBeUndefined();
    // The guarded-form submit handler calls preventDefault while the banner
    // exists — no navigation should have occurred.
    await expect.poll(() => shopPage.url()).toBe(`${shop.url}/`);
    await expect(shopPage.locator("#cookie-overlay")).toBeVisible();

    // --- accept cookies: the overlay must actually go away ---
    const acceptResult = await callBrowser(editorPage, "act", { action: "click", target: "#accept-cookies" });
    expect(acceptResult.error).toBeUndefined();
    await expect(shopPage.locator("#cookie-overlay")).toHaveCount(0);

    // --- Enter now really submits the search: header input has no submit
    // button at all, only the lone-input form's default Enter-submit ---
    await expect(shopPage.locator('#search-form button[type="submit"]')).toHaveCount(0);
    const typeAgain = await callBrowser(editorPage, "act", { action: "type", target: "#search-input", text: "headphones" });
    expect(typeAgain.error).toBeUndefined();
    const pressAgain = await callBrowser(editorPage, "act", { action: "press", key: "Enter", target: "#search-input" });
    expect(pressAgain.error).toBeUndefined();
    await expect.poll(() => shopPage.url()).toBe(`${shop.url}/search?q=headphones`);
    await expect(shopPage.locator("#results-heading")).toContainText("headphones");
    // All 10 headphone fixtures match the "headphones" search term.
    await expect(shopPage.locator(".result-item")).toHaveCount(10);

    // --- hover menu: the Categories dropdown is closed by default (real
    // CSS display:none, no inline style hack) and opens on a real CDP hover ---
    const dropdownBeforeHover = await shopPage.locator("#main-nav .dropdown").evaluate((el) => getComputedStyle(el).display);
    expect(dropdownBeforeHover).toBe("none");
    const hoverResult = await callBrowser(editorPage, "act", { action: "hover", target: "Categories" });
    expect(hoverResult.error).toBeUndefined();
    await expect
      .poll(() => shopPage.locator("#main-nav .dropdown").evaluate((el) => getComputedStyle(el).display))
      .toBe("block");
    // A snapshot taken while hovered can see the now-visible category links —
    // proof the dropdown is genuinely interactive, not just visually present.
    const hoverSnapshot = await callBrowser(editorPage, "snapshot");
    expect(hoverSnapshot.elements.some((e) => e.label.toLowerCase() === "headphones")).toBe(true);

    // --- filters: brand + price + wireless + sort must actually change the
    // rendered list (client-side, against the embedded JSON), not just the
    // controls' own values ---
    const beforeFilterCount = await shopPage.locator(".result-item").count();
    expect(beforeFilterCount).toBe(10);

    const brandSnapshot = await callBrowser(editorPage, "snapshot");
    const audioNovaCheckboxIndex = brandSnapshot.elements.find((e) => e.tag === "input" && e.label === "AudioNova")?.index;
    expect(audioNovaCheckboxIndex).not.toBeUndefined();
    const brandClick = await callBrowser(editorPage, "act", {
      action: "click",
      index: audioNovaCheckboxIndex,
      snapshotId: brandSnapshot.snapshotId,
    });
    expect(brandClick.error).toBeUndefined();
    // 6 AudioNova headphones (hp-01..hp-04, hp-09, hp-10) in the catalog.
    await expect.poll(() => shopPage.locator(".result-item").count()).toBe(6);

    const wirelessResult = await callBrowser(editorPage, "act", { action: "click", target: "#filter-wireless" });
    expect(wirelessResult.error).toBeUndefined();
    // AudioNova + wireless: hp-01, hp-02, hp-04, hp-09, hp-10 (hp-03 is wired).
    await expect.poll(() => shopPage.locator(".result-item").count()).toBe(5);

    const priceResult = await callBrowser(editorPage, "act", { action: "type", target: "#filter-price-max", text: "100" });
    expect(priceResult.error).toBeUndefined();
    // AudioNova + wireless + <=$100: hp-01 (49.99), hp-02 (89.99), hp-09 (25),
    // hp-10 (69.99) — hp-04 (129.99) is excluded by price.
    await expect.poll(() => shopPage.locator(".result-item").count()).toBe(4);

    const sortSnapshot = await callBrowser(editorPage, "snapshot");
    const sortIndex = sortSnapshot.elements.find((e) => e.tag === "select")?.index;
    expect(sortIndex).not.toBeUndefined();
    const sortResult = await callBrowser(editorPage, "act", {
      action: "select",
      index: sortIndex,
      snapshotId: sortSnapshot.snapshotId,
      text: "Rating",
    });
    expect(sortResult.error).toBeUndefined();
    // Sorted by rating desc, the top card must be the one the fixture's own
    // comment documents as the unambiguous top pick: AudioNova Studio Wireless.
    await expect
      .poll(() => shopPage.locator(".result-item").first().locator(".result-link").innerText())
      .toBe("AudioNova Studio Wireless");

    // --- open the top result, add to cart, and check out ---
    const productClick = await callBrowser(editorPage, "act", { action: "click", target: "AudioNova Studio Wireless" });
    expect(productClick.error).toBeUndefined();
    await expect.poll(() => shopPage.url()).toBe(`${shop.url}/product/hp-02`);

    const addToCart = await callBrowser(editorPage, "act", { action: "click", target: "#add-to-cart" });
    expect(addToCart.error).toBeUndefined();
    await expect(shopPage.locator("#cart-status")).toHaveText("Added to cart (1 item)");
    await expect(shopPage.locator("#go-to-cart")).toBeVisible();

    const goToCart = await callBrowser(editorPage, "act", { action: "click", target: "#go-to-cart" });
    expect(goToCart.error).toBeUndefined();
    await expect.poll(() => shopPage.url()).toBe(`${shop.url}/cart`);
    await expect(shopPage.locator("#cart-list li")).toHaveCount(1);
    await expect(shopPage.locator("#cart-total")).toHaveText("Total: $89.99");

    const goToCheckout = await callBrowser(editorPage, "act", { action: "click", target: "#checkout-link" });
    expect(goToCheckout.error).toBeUndefined();
    await expect.poll(() => shopPage.url()).toBe(`${shop.url}/checkout`);

    // --- validation: submitting with everything missing must re-render the
    // form with inline errors, not silently fail or place an order ---
    const badSubmit = await callBrowser(editorPage, "act", { action: "click", target: "#checkout-submit" });
    expect(badSubmit.error).toBeUndefined();
    await expect(shopPage.locator("#checkout-errors li")).toHaveCount(5);
    expect(shop.getOrders()).toHaveLength(0);

    // --- fill it in correctly and submit ---
    const nameFill = await callBrowser(editorPage, "act", { action: "type", target: "#checkout-name", text: "Test User" });
    expect(nameFill.error).toBeUndefined();
    const emailFill = await callBrowser(editorPage, "act", { action: "type", target: "#checkout-email", text: "test@example.com" });
    expect(emailFill.error).toBeUndefined();
    const countrySnapshot = await callBrowser(editorPage, "snapshot");
    const countryIndex = countrySnapshot.elements.find((e) => e.tag === "select")?.index;
    expect(countryIndex).not.toBeUndefined();
    const countrySelect = await callBrowser(editorPage, "act", {
      action: "select",
      index: countryIndex,
      snapshotId: countrySnapshot.snapshotId,
      text: "Germany",
    });
    expect(countrySelect.error).toBeUndefined();
    // The element table must tell the two shipping radios apart by their
    // <label> text and report their checked state — before labelOf read
    // el.labels, both fell back to name="shipping" and a model acting by
    // index picked express when asked for standard (bench, 2 runs of 3).
    const radiosBefore = countrySnapshot.elements.filter((e) => /shipping \(/i.test(e.label));
    expect(radiosBefore.map((e) => e.label).sort()).toEqual([
      "Express Shipping (1-2 days)",
      "Standard Shipping (5-7 days)",
    ]);
    expect(radiosBefore.every((e) => e.checked === false)).toBe(true);
    const standardIndex = radiosBefore.find((e) => e.label.startsWith("Standard"))!.index;
    const shippingClick = await callBrowser(editorPage, "act", {
      action: "click",
      index: standardIndex,
      snapshotId: countrySnapshot.snapshotId,
    });
    expect(shippingClick.error).toBeUndefined();
    const afterShipping = await callBrowser(editorPage, "snapshot");
    expect(afterShipping.elements.find((e) => e.label.startsWith("Standard Shipping"))?.checked).toBe(true);
    expect(afterShipping.elements.find((e) => e.label.startsWith("Express Shipping"))?.checked).toBe(false);
    const termsClick = await callBrowser(editorPage, "act", { action: "click", target: "#checkout-terms" });
    expect(termsClick.error).toBeUndefined();

    const goodSubmit = await callBrowser(editorPage, "act", { action: "click", target: "#checkout-submit" });
    expect(goodSubmit.error).toBeUndefined();
    await expect.poll(() => shopPage.url()).toMatch(/\/confirm\?order=ORD-\d+/);
    const orderNumberText = await shopPage.locator("#order-number").innerText();
    expect(orderNumberText).toMatch(/^Order Number: ORD-\d+$/);

    // --- the order the server actually recorded matches what was submitted ---
    const orders = shop.getOrders();
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order.fullName).toBe("Test User");
    expect(order.email).toBe("test@example.com");
    expect(order.country).toBe("Germany");
    expect(order.shipping).toBe("standard");
    expect(order.termsAccepted).toBe(true);
    expect(order.items).toEqual([{ productId: "hp-02", name: "AudioNova Studio Wireless", price: 89.99, qty: 1 }]);
    expect(`Order Number: ${order.orderNumber}`).toBe(orderNumberText);

    // --- browse_read sees the confirmation text too (what the bench's
    // success grading in nojev mode falls back to when it can't rely on the
    // agent's own final chat message alone) ---
    const readResult = await callBrowser(editorPage, "read", {});
    expect(readResult.error).toBeUndefined();
    expect(readResult.text).toContain(order.orderNumber);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});
