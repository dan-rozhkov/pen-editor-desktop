import { test, expect, chromium, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// The agent panel: a view loading /agent sits below the tab bar, left of the
// tab views; the tab bar itself stays full width.

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

test("the window has a left /agent panel; tabs still work", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app?q=1` },
  });

  const agentPage =
    app.windows().find((p) => p.url().startsWith(`${baseUrl}/agent`)) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(`${baseUrl}/agent`) }));
  await expect(agentPage.locator("#ready")).toHaveText("stub-agent");
  // The panel keeps the sandboxed preload bridge: canvas link + browser, nothing else.
  expect(await agentPage.evaluate(() => (window as never as { penAgentPanel?: { version: number } }).penAgentPanel)).toMatchObject({ version: 2 });
  // Canvas link + browser only (no MCP, no menu).
  expect(await agentPage.evaluate(() => Object.keys((window as never as { penAgentPanel: object }).penAgentPanel).sort())).toEqual(["auth", "browser", "canvas", "canvases", "docs", "settings", "traces", "version", "workflows"]);
  expect(await agentPage.evaluate(() => typeof (window as never as { penDesktop?: unknown }).penDesktop)).toBe("undefined");

  // Empty start: no canvas tab until one is opened (here: the tab bar's newTab, as the "+" menu does).
  const tabbarPage =
    app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
  await expect(tabbarPage.locator(".tab")).toHaveCount(0);
  expect(app.windows().some((p) => p.url().startsWith(`${baseUrl}/app`))).toBe(false);
  await tabbarPage.evaluate(() => (window as unknown as { penTabbar: { newTab(): void } }).penTabbar.newTab());

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
  // Glass + islands: panel and tab views sit below the bar, 8px gaps between them and to the left/right/bottom window edges.
  const winH = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds().height);
  expect(bounds.agent.y).toBe(bounds.tabbar.height);
  expect(bounds.editor.y).toBe(bounds.tabbar.height);
  expect(bounds.agent.x).toBe(8);
  expect(bounds.editor.x - (bounds.agent.x + bounds.agent.width)).toBe(8);
  expect(winW - (bounds.editor.x + bounds.editor.width)).toBe(8);
  expect(winH - (bounds.agent.y + bounds.agent.height)).toBe(8);
  expect(bounds.agent.height).toBe(bounds.editor.height);

  // The panel is not a tab: only the editor tab is in the strip.
  await expect(tabbarPage.locator(".tab")).toHaveCount(1);
  // The tab strip starts at the tab island's left edge (or later, past the macOS traffic lights).
  const panelRight = bounds.editor.x;
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
  // Every tab has a leading icon (paintbrush for editor tabs, drawn as an inline svg, no favicon image).
  await expect(tabbarPage.locator(".tab .tab-icon")).toHaveCount(2);
  await expect(tabbarPage.locator('.tab .tab-icon[data-icon="editor"]')).toHaveCount(2);
  await expect(tabbarPage.locator(".tab .tab-icon svg.glyph path")).toHaveCount(2);
  await expect(tabbarPage.locator(".tab .tab-icon img")).toHaveCount(0);
  // A browser tab (the agent is not driving it) renders the globe glyph, a different path, and no image.
  const brushPath = await tabbarPage.locator('.tab .tab-icon[data-icon="editor"] path').first().getAttribute("d");
  await app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) {
        if (it.label === "New Browser Tab" && it.click) return it;
        const hit = it.submenu ? find(it.submenu.items) : undefined;
        if (hit) return hit;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  await expect(tabbarPage.locator(".tab")).toHaveCount(3);
  const globe = tabbarPage.locator('.tab .tab-icon[data-icon="browser"]');
  await expect(globe).toHaveCount(1);
  await expect(globe.locator("svg.glyph path")).toHaveCount(1);
  expect(await globe.locator("path").getAttribute("d")).not.toBe(brushPath);
  await expect(tabbarPage.locator(".tab .tab-icon img")).toHaveCount(0);
  // The new tab is a canvas tab too.
  await expect
    .poll(() => app.windows().filter((p) => p.url().startsWith(`${baseUrl}/app`)).map((p) => new URL(p.url()).searchParams.get("chat")))
    .toEqual(["off", "off"]);

  await app.close();
});
