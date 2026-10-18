import { test, expect, chromium, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// PEN_DESKTOP_AGENT_LAYOUT=1: an extra view loading /agent sits below the tab
// bar, left of the tab views; the tab bar itself stays full width. The flag-off geometry is covered by smoke.spec.ts.

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const isAgent = (req.url ?? "").startsWith("/agent");
    res.end(`<!doctype html><title>${isAgent ? "Stub Agent" : "Stub Editor"}</title>
      <h1 id="ready">${isAgent ? "stub-agent" : "stub-editor"}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("agent layout flag adds a left /agent panel; tabs still work", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app?q=1`, PEN_DESKTOP_AGENT_LAYOUT: "1" },
  });

  const agentPage =
    app.windows().find((p) => p.url().startsWith(`${baseUrl}/agent`)) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(`${baseUrl}/agent`) }));
  await expect(agentPage.locator("#ready")).toHaveText("stub-agent");
  // The panel keeps the sandboxed preload bridge and nothing else.
  expect(await agentPage.evaluate(() => (window as never as { penAgentPanel?: { version: number } }).penAgentPanel)).toEqual({ version: 1 });
  expect(await agentPage.evaluate(() => typeof (window as never as { penDesktop?: unknown }).penDesktop)).toBe("undefined");

  const editorPage =
    app.windows().find((p) => p.url().startsWith(`${baseUrl}/app`)) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(`${baseUrl}/app`) }));
  await expect(editorPage.locator("#ready")).toHaveText("stub-editor");
  // Canvas tab: chatless editor, other params kept.
  expect(new URL(editorPage.url()).searchParams.get("chat")).toBe("off");
  expect(new URL(editorPage.url()).searchParams.get("q")).toBe("1");
  // Reload-proof chatless marker, set by main through the preload argv.
  expect(await editorPage.evaluate(() => (window as never as { penDesktop?: { agentLayout?: boolean } }).penDesktop?.agentLayout)).toBe(true);

  const bounds = await app.evaluate(({ BaseWindow }, base) => {
    const win = BaseWindow.getAllWindows()[0];
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const child of win.contentView.children) {
      const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents;
      if (!wc) continue;
      const url = wc.getURL();
      if (url.startsWith(`${base}/agent`)) out.agent = child.getBounds();
      else if (url.startsWith(`${base}/app`)) out.editor = child.getBounds();
      else if (url.endsWith("/tabbar/tabbar.html")) out.tabbar = child.getBounds();
    }
    return out;
  }, baseUrl);
  const winW = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds().width);
  // Tab bar spans the full window width at the top (traffic lights stay put).
  expect(bounds.tabbar).toMatchObject({ x: 0, y: 0, width: winW });
  // Panel and tab views sit below the bar; the panel is left of the tab views.
  expect(bounds.agent.y).toBe(bounds.tabbar.height);
  expect(bounds.editor.y).toBe(bounds.tabbar.height);
  expect(bounds.agent.x + bounds.agent.width).toBeLessThanOrEqual(bounds.editor.x);
  expect(bounds.agent.height).toBe(bounds.editor.height);

  // The panel is not a tab: only the editor tab is in the strip.
  const tabbarPage =
    app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
  await expect(tabbarPage.locator(".tab")).toHaveCount(1);
  // The tab strip starts at the panel's right edge (or later, past the macOS traffic lights).
  const panelRight = bounds.agent.x + bounds.agent.width;
  const rowPad = await tabbarPage.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".tab-row")!).paddingLeft));
  expect(rowPad).toBe(process.platform === "darwin" ? Math.max(88, panelRight) : panelRight);

  // Eyeball aid: composite the three views at their bounds (native traffic
  // lights are not part of a view capture) into a PNG.
  const shots = await app.evaluate(async ({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0];
    const out: { b: { x: number; y: number; width: number; height: number }; png: string }[] = [];
    for (const child of win.contentView.children) {
      const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents;
      if (!wc) continue;
      try {
        const img = await wc.capturePage();
        out.push({ b: child.getBounds(), png: img.toPNG().toString("base64") });
      } catch {
        // A hidden view cannot be captured; the picture is only an eyeball aid.
      }
    }
    return { size: win.getContentBounds(), views: out };
  });
  const outFile = process.env.AGENT_LAYOUT_SHOT;
  if (outFile) {
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

  // Tabs still work: open a second editor tab.
  await tabbarPage.evaluate(() => (window as unknown as { penTabbar: { newTab(): void } }).penTabbar.newTab());
  await expect(tabbarPage.locator(".tab")).toHaveCount(2);
  // The new tab is a canvas tab too.
  await expect
    .poll(() => app.windows().filter((p) => p.url().startsWith(`${baseUrl}/app`)).map((p) => new URL(p.url()).searchParams.get("chat")))
    .toEqual(["off", "off"]);

  await app.close();
});
