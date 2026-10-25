import { test, expect, _electron as electron, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { revealMenuLabel } from "../src/main/revealMenuLabel";

// Reveal in Finder in a real Electron window: the File item follows the active tab (also after the
// frontend names a new canvas with history.replaceState), the click reveals the stored file, and a
// right-click on a tab does not activate it. Native popups cannot be clicked from Playwright, so the
// tab and Recent context menus themselves are covered by unit tests only.
let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const isAgent = (req.url ?? "").startsWith("/agent");
    res.end(
      isAgent
        ? `<!doctype html><title>Agent</title><h1 id="ready">stub-agent</h1>`
        : `<!doctype html><title>My Canvas</title><h1 id="ready">stub-editor</h1>
<script>const h = window.penDesktop && window.penDesktop.canvasHost; if (h) h.register();
// Like the real editor: name a new canvas later with history.replaceState.
setTimeout(() => { const u = new URL(location.href); if (!u.searchParams.get("canvas")) { u.searchParams.set("canvas", "cv_reveal"); history.replaceState(null, "", u); } }, 800);</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("reveal item: disabled without a file tab, enabled after replaceState, click reveals the stored file", async () => {
  const app = await electron.launch({ args: ["."], env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app` } });
  try {
    const find = async (pred: (u: string) => boolean): Promise<Page> =>
      app.windows().find((p) => pred(p.url())) ?? (await app.waitForEvent("window", { predicate: (p) => pred(p.url()) }));
    const tabbar = await find((u) => u.endsWith("/tabbar/tabbar.html"));
    const empty = await find((u) => u.endsWith("/tabbar/empty.html"));
    const itemState = () =>
      app.evaluate(({ Menu }) => {
        const i = Menu.getApplicationMenu()?.getMenuItemById("reveal-active-tab");
        return i ? { label: i.label, enabled: i.enabled } : null;
      });
    // The label is per platform: CI runs on Linux ("Show in Folder").
    expect(await itemState()).toEqual({ label: revealMenuLabel(process.platform), enabled: false });

    // Record shell calls instead of opening Finder.
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { revealed: string[] };
      g.revealed = [];
      (shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = (p) => void g.revealed.push("show:" + p);
      (shell as unknown as { openPath: (p: string) => Promise<string> }).openPath = async (p) => (g.revealed.push("open:" + p), "");
    });

    await empty.locator("#new-canvas").click();
    const canvas = await find((u) => u.startsWith(`${baseUrl}/app`) && u.includes("chat=off"));
    await expect(canvas.locator("#ready")).toHaveText("stub-editor");
    await expect.poll(() => canvas.url()).toContain("canvas=cv_reveal");
    await expect.poll(async () => (await itemState())?.enabled).toBe(true);

    // Save first so the file exists (a missing file falls back to the folder; unit-tested).
    const saved = await canvas.evaluate(() =>
      (window as unknown as { penDesktop: { canvases: { save(c: unknown): Promise<unknown> } } }).penDesktop.canvases.save({
        id: "cv_reveal", title: "My Canvas", updatedAt: Date.now(), rev: 1, document: "{}",
      }),
    );
    expect(saved).toMatchObject({ ok: true });
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("reveal-active-tab")!.click());
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed))
      .toEqual([expect.stringMatching(/^show:.*canvases-dev[\\/]cv_reveal\.pen\.json$/)]);

    // A browser tab has no file: the item turns off; a right-click on the canvas tab does not activate it.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find((m) => m.label === "File")!.submenu!.items.find((i) => i.label === "New Browser Tab")!.click());
    await expect(tabbar.locator(".tab")).toHaveCount(2);
    await expect.poll(async () => (await itemState())?.enabled).toBe(false);
    await tabbar.locator(".tab").first().dispatchEvent("mousedown", { button: 2 });
    await tabbar.waitForTimeout(300);
    await expect(tabbar.locator(".tab").nth(1)).toHaveClass(/active/);
    expect((await itemState())?.enabled).toBe(false);

  } finally {
    await app.close();
  }
});
