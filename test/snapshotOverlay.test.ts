import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { ARGS_MARKER, SNAPSHOT_JS } from "../src/main/browser/pageScripts.js";

/**
 * SNAPSHOT_JS against a real (headless Chromium) layout: a non-aria-modal
 * full-viewport drawer must be reported as the snapshot's `modal`, while a
 * real aria-modal keeps its behaviour and a plain page reports none.
 */
let browser: Browser | null = null;
let page: Page;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  } catch (e) {
    browser = null;
    // Locally a missing Chromium skips; in CI it must be a hard failure so the
    // suite can never go green without running.
    if (process.env.CI) throw e;
  }
});
afterAll(async () => {
  await browser?.close();
});

async function snapshot(html: string): Promise<{ modal?: string; elements: { label: string }[] }> {
  await page.setContent(html);
  const code = SNAPSHOT_JS.replace(ARGS_MARKER, () => JSON.stringify({ snapshotId: "s1", maxElements: 50 }));
  return (await page.evaluate(code)) as { modal?: string; elements: { label: string }[] };
}

const HEADER = `<header><input type="search" aria-label="Search products"><a href="/cart">Cart</a><a href="/sale">Sale</a></header>`;
const drawer = (attrs: string, inner: string) =>
  `<div ${attrs} style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10">
     <aside style="position:absolute;right:0;top:0;bottom:0;width:100%;background:#fff;padding:16px">${inner}</aside>
   </div>`;

describe("SNAPSHOT_JS overlay detection", () => {
  it("reports a non-aria-modal wall as modal, named by its heading, keeping its own controls", async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await snapshot(
      HEADER + drawer("", `<h2>Your cart</h2><button>Close</button><a href="/cart">View your cart</a>`),
    );
    expect(r.modal).toBe("Your cart");
    const labels = r.elements.map((e) => e.label);
    expect(labels).toContain("Close");
    expect(labels).toContain("View your cart");
    expect(labels).not.toContain("Search products");
  });

  it("falls back to the aria-label, then to a generic name", async (ctx) => {
    if (!browser) return ctx.skip();
    const named = await snapshot(HEADER + drawer('aria-label="Mini cart"', `<button>Close</button>`));
    expect(named.modal).toBe("Mini cart");
    const bare = await snapshot(HEADER + drawer("", `<button>Close</button>`));
    expect(bare.modal).toBe("overlay");
  });

  it("keeps the real aria-modal behaviour unchanged", async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await snapshot(HEADER + drawer('role="dialog" aria-modal="true" aria-label="Sign in"', `<button>Dismiss</button>`));
    expect(r.modal).toBe("Sign in");
    expect(r.elements.map((e) => e.label)).toEqual(["Dismiss"]);
  });

  it("reports no modal when nothing is covered", async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await snapshot(HEADER + `<button>Buy</button>`);
    expect(r.modal).toBeUndefined();
    expect(r.elements.map((e) => e.label)).toContain("Search products");
  });

  it("does not treat a partial bar as an overlay", async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await snapshot(
      HEADER + `<div style="position:fixed;left:0;right:0;top:0;height:60px;background:#eee"><button>Accept</button></div>`,
    );
    expect(r.modal).toBeUndefined();
  });

  it("labels a sibling backdrop from the drawer panel that holds the listed controls", async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await snapshot(
      HEADER +
        `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10"></div>
         <aside style="position:fixed;right:0;top:0;bottom:0;width:400px;background:#fff;z-index:11">
           <h2>Your cart</h2><button>Close</button><a href="/checkout">Checkout</a>
         </aside>`,
    );
    expect(r.modal).toBe("Your cart");
    expect(r.elements.map((e) => e.label)).not.toContain("Search products");
  });

  it("does not report an empty wall (fewer than 3 covered, nothing on it)", async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await snapshot(
      `<button style="position:absolute;top:100px;left:100px">Covered</button><button style="position:absolute;top:300px;left:100px">Free</button>
       <div style="position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:auto;z-index:10"></div>`,
    );
    expect(r.modal).toBeUndefined();
  });
});
