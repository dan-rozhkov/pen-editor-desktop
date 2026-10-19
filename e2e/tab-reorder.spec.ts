import { test, expect, _electron as electron, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Drag-to-reorder in the tab strip: pointer drag moves a tab, a tiny move is a click, Escape cancels.

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const isAgent = (req.url ?? "").startsWith("/agent");
    res.end(`<!doctype html><title>${isAgent ? "Stub Agent" : "Stub Editor"}</title><h1 id="ready">stub</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("tabs can be dragged to a new position; a tiny move is a click; an inactive tab can be dragged", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app`, PEN_DESKTOP_NO_ANIMATIONS: "1" },
  });
  try {
    const tabbar: Page =
      app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));

    const tabs = tabbar.locator(".tab");
    for (let i = 1; i <= 3; i++) {
      await tabbar.evaluate(() => (window as unknown as { penTabbar: { newTab(): void } }).penTabbar.newTab());
      await expect(tabs).toHaveCount(i);
      // Tab elements are reused across state pushes, so a data attribute survives and names the tab.
      await tabbar.evaluate((n) => {
        const els = document.querySelectorAll<HTMLElement>(".tab");
        els[els.length - 1].dataset.name = `t${n}`;
      }, i);
    }
    const order = () => tabbar.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".tab")).map((e) => e.dataset.name));
    const activeName = () => tabbar.evaluate(() => document.querySelector<HTMLElement>(".tab.active")?.dataset.name);
    const box = async (name: string) => (await tabbar.locator(`.tab[data-name="${name}"]`).boundingBox())!;
    expect(await order()).toEqual(["t1", "t2", "t3"]);
    expect(await activeName()).toBe("t3");

    // A tiny move (< 4px) is a click: the tab activates, nothing reorders.
    const b1 = await box("t1");
    const y = b1.y + b1.height / 2;
    await tabbar.mouse.move(b1.x + 20, y);
    await tabbar.mouse.down();
    await tabbar.mouse.move(b1.x + 22, y);
    await tabbar.mouse.up();
    await expect.poll(activeName).toBe("t1");
    expect(await order()).toEqual(["t1", "t2", "t3"]);
    expect(await tabbar.locator(".tab.dragging").count()).toBe(0);

    // Drag the first tab past the last one. t1 is already active here (from the click above).
    const s1 = await box("t1");
    const s3 = await box("t3");
    await tabbar.mouse.move(s1.x + 20, y);
    await tabbar.mouse.down();
    await tabbar.mouse.move(s3.x + s3.width - 4, y, { steps: 12 });
    await expect(tabbar.locator(".tab.dragging")).toHaveCount(1);
    await tabbar.mouse.up();
    await expect.poll(order).toEqual(["t2", "t3", "t1"]);

    // Let the optimistic order be confirmed, then force a fresh snapshot from main (activate another
    // tab): the order must stay, proving main reordered its own list.
    await tabbar.waitForTimeout(800);
    await tabbar.locator('.tab[data-name="t2"]').click();
    await expect.poll(activeName).toBe("t2");
    await tabbar.waitForTimeout(300);
    expect(await order()).toEqual(["t2", "t3", "t1"]);
    // Clicking still activates after a reorder.
    await tabbar.locator('.tab[data-name="t1"]').click();
    await expect.poll(activeName).toBe("t1");
    expect(await order()).toEqual(["t2", "t3", "t1"]);

    // The real-user path: press on an INACTIVE tab (mousedown activates it and main focuses the
    // tab's page, so the tab bar blurs), move past another tab, release.
    await tabbar.locator('.tab[data-name="t3"]').click(); // t3 active; t2 is inactive
    await expect.poll(activeName).toBe("t3");
    const i2 = await box("t2");
    const i3 = await box("t3");
    await tabbar.mouse.move(i2.x + 20, y);
    await tabbar.mouse.down();
    await tabbar.mouse.move(i3.x + i3.width - 4, y, { steps: 12 });
    await expect(tabbar.locator(".tab.dragging")).toHaveCount(1);
    await tabbar.mouse.up();
    await expect.poll(order).toEqual(["t3", "t2", "t1"]);
    await expect.poll(activeName).toBe("t2"); // the pressed tab became active
    await tabbar.waitForTimeout(800);
    await tabbar.locator('.tab[data-name="t1"]').click();
    await expect.poll(activeName).toBe("t1");
    expect(await order()).toEqual(["t3", "t2", "t1"]);
  } finally {
    await app.close();
  }
});
