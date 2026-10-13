import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { ARGS_MARKER, SNAPSHOT_JS } from "../src/main/browser/pageScripts.js";

/**
 * SNAPSHOT_JS, real headless Chromium layout: an unanswered radio group far
 * above a natively disabled button is listed together with that button.
 * Without it the agent saw the disabled goal button but never the choice that
 * unlocks it. Viewport 1000x700, so the margin is 700px beyond the fold.
 */
let browser: Browser | null = null;
let page: Page;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  } catch (e) {
    browser = null;
    if (process.env.CI) throw e;
  }
});
afterAll(async () => {
  await browser?.close();
});

interface El {
  index: number;
  label: string;
  tag: string;
  checked?: boolean;
  disabled?: boolean;
}

async function snapshot(html: string, scrollToEnd = true): Promise<El[]> {
  await page.setContent(html);
  if (scrollToEnd) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const code = SNAPSHOT_JS.replace(ARGS_MARKER, () => JSON.stringify({ snapshotId: "s1", maxElements: 50 }));
  return ((await page.evaluate(code)) as { elements: El[] }).elements;
}

const SPACER = `<div style="height:3000px"></div>`;
const group1 = (checked: string) => `
  <fieldset><legend>Extras</legend>
    <label><input type="radio" name="extras" value="no" ${checked}> No extras</label>
    <label><input type="radio" name="extras" value="yes"> Add extras</label>
  </fieldset>`;
const group2 = `
  <fieldset><legend>Plan</legend>
    <label><input type="radio" name="plan" value="a" disabled> Monthly</label>
    <label><input type="radio" name="plan" value="b" disabled> Yearly</label>
  </fieldset>`;
const page1 = (checked: string, button: string) =>
  `<body style="margin:0"><form>${group1(checked)}${SPACER}${group2}${button}</form></body>`;

describe("SNAPSHOT_JS unanswered choice above a disabled button", () => {
  it("lists the far, unchecked radio group next to the disabled submit button", async (ctx) => {
    if (!browser) return ctx.skip();
    const els = await snapshot(page1("", `<button type="submit" disabled>Continue</button>`));
    const byLabel = (needle: string) => els.find((e) => e.label.includes(needle));
    const no = byLabel("No extras");
    const add = byLabel("Add extras");
    expect(no).toBeDefined();
    expect(add).toBeDefined();
    expect(no?.checked).toBe(false);
    expect(add?.checked).toBe(false);
    expect(no?.disabled).toBeUndefined();
    // The goal button and the near disabled group are still reported, disabled.
    expect(byLabel("Continue")?.disabled).toBe(true);
    expect(byLabel("Monthly")?.disabled).toBe(true);
    // Indexes stay unique and dense.
    expect(els.map((e) => e.index)).toEqual(els.map((_, i) => i));
    // The listed option really is a target: stamped with its snapshot index.
    const stamped = await page.evaluate(
      (idx) => document.querySelector(`[data-pen-snap="s1:${idx}"]`)?.tagName ?? null,
      no!.index,
    );
    expect(stamped).not.toBeNull();
  });

  it("adds nothing when the group already has a checked option", async (ctx) => {
    if (!browser) return ctx.skip();
    const els = await snapshot(page1("checked", `<button type="submit" disabled>Continue</button>`));
    const labels = els.map((e) => e.label);
    expect(labels.some((l) => l.includes("No extras"))).toBe(false);
    expect(labels.some((l) => l.includes("Add extras"))).toBe(false);
  });

  it("adds nothing when no disabled button is listed", async (ctx) => {
    if (!browser) return ctx.skip();
    const els = await snapshot(page1("", `<button type="submit">Continue</button>`));
    const labels = els.map((e) => e.label);
    expect(labels.some((l) => l.includes("No extras"))).toBe(false);
    expect(labels.some((l) => l.includes("Add extras"))).toBe(false);
  });

  it("keeps only the 2 nearest unanswered groups and 6 options each", async (ctx) => {
    if (!browser) return ctx.skip();
    const grp = (n: string, k: number) =>
      `<div>${Array.from({ length: k }, (_, i) => `<label><input type="radio" name="${n}"> ${n}-opt${i}</label>`).join("")}</div><div style="height:3000px"></div>`;
    const els = await snapshot(
      `<body style="margin:0">${grp("g1", 3)}${grp("g2", 3)}${grp("g3", 8)}<button disabled>Go</button></body>`,
    );
    const labels = els.map((e) => e.label).join("|");
    expect(labels).not.toContain("g1-opt");
    expect(labels).toContain("g2-opt0");
    expect(labels).toContain("g3-opt5");
    expect(labels).not.toContain("g3-opt6");
  });

  it("anchors on the LAST disabled button, not on disabled gallery controls above the group", async (ctx) => {
    if (!browser) return ctx.skip();
    const gallery = `<div style="position:fixed;top:0;left:0"><button disabled>Previous image</button><button>Next image</button>
      <button role="tab" disabled>Gallery Image 1</button><button role="tab" disabled>Gallery Image 2</button></div>`;
    const els = await snapshot(
      `<body style="margin:0">${gallery}${SPACER}${group1("")}${SPACER}<button type="submit" disabled>Continue</button></body>`,
    );
    const labels = els.map((e) => e.label);
    expect(labels.some((l) => l.includes("No extras"))).toBe(true);
    expect(labels.some((l) => l.includes("Add extras"))).toBe(true);
  });

  it("never exceeds maxElements: forced options and the anchor evict far ordinary entries", async (ctx) => {
    if (!browser) return ctx.skip();
    const links = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `<a href="/p${from + i}">Link ${from + i}</a>`).join(" ");
    const near = `${links(0, 5)}<button type="submit" disabled>Continue</button><div style="height:800px"></div>${links(5, 15)}`;
    await page.setContent(
      `<body style="margin:0"><form>${group1("")}${SPACER}${near}</form></body>`,
    );
    await page.evaluate(() => window.scrollTo(0, document.querySelector("a")!.getBoundingClientRect().top + window.scrollY - 10));
    const code = SNAPSHOT_JS.replace(ARGS_MARKER, () => JSON.stringify({ snapshotId: "s1", maxElements: 8 }));
    const els = ((await page.evaluate(code)) as { elements: El[] }).elements;
    expect(els.length).toBeLessThanOrEqual(8);
    const labels = els.map((e) => e.label);
    expect(labels.some((l) => l.includes("No extras"))).toBe(true);
    expect(labels.some((l) => l.includes("Add extras"))).toBe(true);
    expect(els.some((e) => e.label.includes("Continue") && e.disabled)).toBe(true);
  });

  it("does not list an unanswered group clipped away by an overflow:hidden ancestor", async (ctx) => {
    if (!browser) return ctx.skip();
    const els = await snapshot(
      `<body style="margin:0"><form><div style="max-height:0;overflow:hidden">${group1("")}</div>${SPACER}<button type="submit" disabled>Continue</button></form></body>`,
    );
    const labels = els.map((e) => e.label);
    expect(labels.some((l) => l.includes("No extras"))).toBe(false);
    expect(labels.some((l) => l.includes("Continue"))).toBe(true);
  });

  it("prefers the anchor's own form when it holds a qualifying group", async (ctx) => {
    if (!browser) return ctx.skip();
    const other = `<form><label><input type="radio" name="other"> Other form choice</label></form>`;
    const els = await snapshot(
      `<body style="margin:0">${other}${SPACER}<form>${group1("")}${SPACER}<button type="submit" disabled>Continue</button></form></body>`,
    );
    const labels = els.map((e) => e.label);
    expect(labels.some((l) => l.includes("No extras"))).toBe(true);
    expect(labels.some((l) => l.includes("Other form choice"))).toBe(false);
  });
});
