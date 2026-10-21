import { test, expect, _electron as electron, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Agent layout empty start: the window opens with only the agent panel and a
// quiet placeholder in the tab area; tabs come from the placeholder buttons or
// the panel (canvas:open), and closing the last one returns to the placeholder
// without closing the window.

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const isAgent = (req.url ?? "").startsWith("/agent");
    // The stub editor registers like the real chatless editor so canvas:open can resolve.
    res.end(
      isAgent
        ? `<!doctype html><title>Stub Agent</title><h1 id="ready">stub-agent</h1>`
        : `<!doctype html><title>Stub Editor</title><h1 id="ready">stub-editor</h1>
<script>const h = window.penDesktop && window.penDesktop.canvasHost; if (h) h.register();</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("agent layout opens with the panel only; the placeholder opens and returns from canvas tabs", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app` },
  });
  try {
    const find = async (pred: (u: string) => boolean): Promise<Page> =>
      app.windows().find((p) => pred(p.url())) ?? (await app.waitForEvent("window", { predicate: (p) => pred(p.url()) }));
    const panel = await find((u) => u.startsWith(`${baseUrl}/agent`));
    const tabbar = await find((u) => u.endsWith("/tabbar/tabbar.html"));
    const empty = await find((u) => u.endsWith("/tabbar/empty.html"));
    await expect(panel.locator("#ready")).toHaveText("stub-agent");

    // Zero tabs, placeholder visible with its text and the three cards (whole card = button, named by its CTA).
    await expect(tabbar.locator(".tab")).toHaveCount(0);
    expect(app.windows().some((p) => p.url().startsWith(`${baseUrl}/app`))).toBe(false);
    await expect(empty.getByRole("heading", { level: 1 })).toHaveText("Where shall we start?");
    await expect(empty.locator(".hint")).toHaveText("Canvas, browser, document and workflow tabs open here.");
    await expect(empty.locator("#new-canvas .cta-label")).toHaveText("New canvas tab");
    await expect(empty.locator("#new-browser .cta-label")).toHaveText("New browser tab");
    await expect(empty.locator("#new-doc .cta-label")).toHaveText("New document");
    await expect(empty.locator("#new-workflow .cta-label")).toHaveText("New workflow");
    await expect(empty.locator(".card .title")).toHaveText(["Canvas", "Browser", "Document", "Workflow"]);
    await expect(empty.getByRole("button", { name: "New canvas tab" })).toHaveAccessibleDescription(
      "Design screens with the agent on an open canvas.",
    );
    await expect(empty.locator("#sessions-note")).toBeHidden();
    const emptyVisible = () =>
      app.evaluate(({ BaseWindow }) => {
        const win = BaseWindow.getAllWindows()[0];
        for (const child of win.contentView.children) {
          const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents;
          if (wc?.getURL().endsWith("/tabbar/empty.html")) return (child as unknown as { getVisible(): boolean }).getVisible();
        }
        return null;
      });
    expect(await emptyVisible()).toBe(true);

    // Eyeball aid: the placeholder next to the panel.
    const outFile = process.env.EMPTY_START_SHOT;
    if (outFile) {
      const { chromium } = await import("@playwright/test");
      const shots = await app.evaluate(async ({ BaseWindow }) => {
        const win = BaseWindow.getAllWindows()[0];
        const views: { b: { x: number; y: number; width: number; height: number }; png: string }[] = [];
        for (const child of win.contentView.children) {
          const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents;
          if (!wc) continue;
          try {
            views.push({ b: child.getBounds(), png: (await wc.capturePage()).toPNG().toString("base64") });
          } catch {
            // hidden view: nothing to capture
          }
        }
        return { size: win.getContentBounds(), views };
      });
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: shots.size.width, height: shots.size.height } });
      await page.setContent(
        `<body style="margin:0;background:#ececec;position:relative">${shots.views
          .map((v) => `<img src="data:image/png;base64,${v.png}" style="position:absolute;left:${v.b.x}px;top:${v.b.y}px;width:${v.b.width}px;height:${v.b.height}px">`)
          .join("")}</body>`,
      );
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      await page.screenshot({ path: outFile });
      await browser.close();
    }

    // "New Canvas Tab" opens a chatless canvas tab and hides the placeholder.
    await empty.locator("#new-canvas").click();
    const editor = await find((u) => u.startsWith(`${baseUrl}/app`));
    expect(new URL(editor.url()).searchParams.get("chat")).toBe("off");
    await expect(tabbar.locator(".tab")).toHaveCount(1);
    await expect.poll(emptyVisible).toBe(false);

    // Closing the last tab returns to the placeholder; the window stays open.
    await tabbar.locator(".tab .close").evaluate((el) => (el as HTMLElement).click());
    await expect(tabbar.locator(".tab")).toHaveCount(0);
    await expect.poll(emptyVisible).toBe(true);
    expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);

    // "New Browser Tab" opens a browser tab (address row shown).
    await empty.locator("#new-browser").click();
    await expect(tabbar.locator(".tab")).toHaveCount(1);
    await expect(tabbar.locator("#chrome-row")).toBeVisible();
    await tabbar.locator(".tab .close").evaluate((el) => (el as HTMLElement).click());
    await expect(tabbar.locator(".tab")).toHaveCount(0);

    // The panel's canvas.openTab() works from zero tabs.
    const opened = await panel.evaluate(() =>
      (window as never as { penAgentPanel: { canvas: { openTab(o?: { activate?: boolean }): Promise<{ tabId: number }> } } }).penAgentPanel.canvas.openTab({ activate: true }),
    );
    expect(opened.tabId).toBeGreaterThan(0);
    await expect(tabbar.locator(".tab")).toHaveCount(1);
    await expect.poll(emptyVisible).toBe(false);
    await tabbar.locator(".tab .close").evaluate((el) => (el as HTMLElement).click());
    await expect(tabbar.locator(".tab")).toHaveCount(0);
    await expect.poll(emptyVisible).toBe(true);

    // A background open (no activate) from zero tabs still becomes the active tab.
    await panel.evaluate(() =>
      (window as never as { penAgentPanel: { canvas: { openTab(): Promise<unknown> } } }).penAgentPanel.canvas.openTab(),
    );
    await expect(tabbar.locator(".tab")).toHaveCount(1);
    await expect(tabbar.locator(".tab.active")).toHaveCount(1);
    await expect.poll(emptyVisible).toBe(false);
    await tabbar.locator(".tab .close").evaluate((el) => (el as HTMLElement).click());
    await expect.poll(emptyVisible).toBe(true);

    // Close Tab (Cmd/Ctrl+W) with zero tabs does nothing; Close Window (Cmd/Ctrl+Shift+W) closes the window.
    const clickMenu = (label: string) =>
      app.evaluate(({ Menu }, wanted) => {
        const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
          for (const it of items) {
            if (it.label === wanted) return it;
            const hit = it.submenu ? find(it.submenu.items) : undefined;
            if (hit) return hit;
          }
          return undefined;
        };
        find(Menu.getApplicationMenu()!.items)!.click();
      }, label);
    await clickMenu("Close Tab");
    await tabbar.waitForTimeout(500);
    expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
    await clickMenu("Close Window");
    await expect.poll(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(0);
  } finally {
    await app.close();
  }
});
