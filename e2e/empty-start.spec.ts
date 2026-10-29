import { test, expect, _electron as electron, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
<script>const h = window.penDesktop && window.penDesktop.canvasHost; if (h) h.register();
// A canvas tab keeps a pending autosave and defines window.penCanvasFlush like the real editor:
// it saves and resolves after the canvases:save reply; it never rejects.
const canvasId = new URLSearchParams(location.search).get("canvas");
if (canvasId) window.penCanvasFlush = async () => {
  try {
    await window.penDesktop.canvases.save({ id: canvasId, title: "Flushed on close", updatedAt: Date.now(), rev: 2, document: "{}" });
  } catch (e) {}
};</script>`,
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
    await expect(empty.locator(".hint")).toHaveText("Canvas, browser and document tabs open here.");
    await expect(empty.locator("#new-canvas .cta-label")).toHaveText("New canvas tab");
    await expect(empty.locator("#new-browser .cta-label")).toHaveText("New browser tab");
    await expect(empty.locator("#new-doc .cta-label")).toHaveText("New document");
    await expect(empty.locator(".card .title")).toHaveText(["Canvas", "Browser", "Document"]);
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

test("the empty start lists stored canvases and documents; a click opens or activates a tab for the id", async () => {
  // Own userData dir. PEN_DESKTOP_URL is set, so the stores use the `-dev` directories.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pen-desktop-recent-"));
  const now = Date.now();
  const docDir = path.join(userData, "documents-dev");
  const canvasDir = path.join(userData, "canvases-dev");
  fs.mkdirSync(docDir, { recursive: true });
  fs.mkdirSync(canvasDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, "doc_e2e.json"), JSON.stringify({ id: "doc_e2e", title: "E2E brief", markdown: "# hi", updatedAt: now - 2 * 3_600_000, rev: 1 }));
  fs.writeFileSync(path.join(canvasDir, "cv_e2e.meta.json"), JSON.stringify({ id: "cv_e2e", title: "E2E landing", updatedAt: now - 60_000, rev: 1 }));
  fs.writeFileSync(path.join(canvasDir, "cv_e2e.pen.json"), JSON.stringify({ id: "cv_e2e", rev: 1, document: "{}" }));
  for (let i = 0; i < 9; i++) {
    fs.writeFileSync(path.join(docDir, `old_${i}.json`), JSON.stringify({ id: `old_${i}`, title: `Old ${i}`, markdown: "", updatedAt: now - (10 + i) * 86_400_000, rev: 1 }));
  }
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app`, PEN_DESKTOP_USER_DATA_DIR: userData },
  });
  try {
    const find = async (pred: (u: string) => boolean): Promise<Page> =>
      app.windows().find((p) => pred(p.url())) ?? (await app.waitForEvent("window", { predicate: (p) => pred(p.url()) }));
    const tabbar = await find((u) => u.endsWith("/tabbar/tabbar.html"));
    const empty = await find((u) => u.endsWith("/tabbar/empty.html"));

    // Newest first: canvas (1 min), doc (2 h), then the old ones. Eight rows, then "Show all (11)".
    const rows = empty.locator(".recent-row");
    await expect(rows).toHaveCount(8);
    await expect(rows.nth(0).locator(".recent-title")).toHaveText("E2E landing");
    await expect(rows.nth(0).locator(".recent-kind")).toHaveText("Canvas");
    await expect(rows.nth(0).locator(".recent-time")).toHaveText("1 min ago");
    await expect(rows.nth(1).locator(".recent-title")).toHaveText("E2E brief");
    await expect(rows.nth(1).locator(".recent-kind")).toHaveText("Document");
    await expect(rows.nth(1).locator(".recent-time")).toHaveText("2 h ago");
    await expect(empty.locator("#recent-more")).toHaveText("Show all (11)");

    const outFile = process.env.EMPTY_START_RECENT_SHOT;
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      await empty.screenshot({ path: outFile });
    }

    // ArrowDown moves focus to the next row.
    await rows.nth(0).focus();
    await empty.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();

    await empty.locator("#recent-more").click();
    await expect(rows).toHaveCount(11);
    await expect(empty.locator("#recent-more")).toBeHidden();

    // A click on the canvas row opens a canvas tab whose URL carries canvas=<id>.
    await rows.nth(0).click();
    const editor = await find((u) => u.startsWith(`${baseUrl}/app`) && u.includes("canvas=cv_e2e"));
    expect(new URL(editor.url()).searchParams.get("canvas")).toBe("cv_e2e");
    await expect(tabbar.locator(".tab")).toHaveCount(1);

    // A click on the doc row opens a doc tab with id=<docId>.
    await tabbar.locator(".tab .close").evaluate((el) => (el as HTMLElement).click());
    await expect(tabbar.locator(".tab")).toHaveCount(0);
    // The closing tab's last save (window.penCanvasFlush) lands and is accepted although the tab is already gone from the strip.
    await expect
      .poll(() => JSON.parse(fs.readFileSync(path.join(canvasDir, "cv_e2e.meta.json"), "utf8")).title)
      .toBe("Flushed on close");
    // ... and the Recent list refreshes by itself (empty:recent-changed).
    await expect(rows.nth(0).locator(".recent-title")).toHaveText("Flushed on close");
    await rows.nth(1).click();
    const doc = await find((u) => u.startsWith(`${baseUrl}/doc`) && u.includes("id=doc_e2e"));
    expect(new URL(doc.url()).searchParams.get("id")).toBe("doc_e2e");
    await expect(tabbar.locator(".tab")).toHaveCount(1);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("the Recent list searches, filters, selects with checkboxes and bulk deletes after a native confirm", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pen-desktop-bulk-"));
  const now = Date.now();
  const docDir = path.join(userData, "documents-dev");
  const canvasDir = path.join(userData, "canvases-dev");
  fs.mkdirSync(docDir, { recursive: true });
  fs.mkdirSync(canvasDir, { recursive: true });
  const writeDoc = (id: string, title: string, age: number) =>
    fs.writeFileSync(path.join(docDir, `${id}.json`), JSON.stringify({ id, title, markdown: "", updatedAt: now - age, rev: 1 }));
  writeDoc("doc_alpha", "Alpha plan", 60_000);
  writeDoc("doc_beta", "Beta notes", 2 * 3_600_000);
  fs.writeFileSync(path.join(canvasDir, "cv_gamma.meta.json"), JSON.stringify({ id: "cv_gamma", title: "Gamma board", updatedAt: now - 3 * 3_600_000, rev: 1 }));
  fs.writeFileSync(path.join(canvasDir, "cv_gamma.pen.json"), JSON.stringify({ id: "cv_gamma", rev: 1, document: "{}" }));
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app`, PEN_DESKTOP_USER_DATA_DIR: userData },
  });
  try {
    const empty =
      app.windows().find((p) => p.url().endsWith("/tabbar/empty.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/empty.html") }));
    const cspErrors: string[] = [];
    empty.on("console", (m) => {
      if (/content security policy/i.test(m.text())) cspErrors.push(m.text());
    });
    const rows = empty.locator(".recent-row");
    await expect(rows).toHaveCount(3);
    const listHeight = async () => (await empty.locator("#recent-body").boundingBox())!.height;
    const defaultHeight = await listHeight();

    // Search: the field opens focused, filters by title, Esc clears the text and then closes it.
    await empty.locator("#recent-search-toggle").click();
    await expect(empty.locator("#recent-search")).toBeFocused();
    await empty.locator("#recent-search").fill("beta");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(".recent-title")).toHaveText("Beta notes");
    // The list block keeps its default-view height while searching, so the centred page does not jump.
    expect(await listHeight()).toBeGreaterThanOrEqual(defaultHeight - 1);
    await expect(empty.locator("#recent-search-clear")).toBeVisible();
    await empty.locator("#recent-search-clear").click();
    await expect(empty.locator("#recent-search")).toHaveValue("");
    await expect(empty.locator("#recent-search-clear")).toBeHidden();
    await expect(rows).toHaveCount(3);
    await empty.locator("#recent-search").fill("beta");
    await expect(rows).toHaveCount(1);
    await empty.locator("#recent-search").fill("nothing like this");
    await expect(empty.locator(".recent-empty-text")).toHaveText("No matching files");
    // The "no matches" line sits right under the header, not below the reserved height.
    expect((await empty.locator(".recent-empty-text").boundingBox())!.y - (await empty.locator("#recent-body").boundingBox())!.y).toBeLessThan(20);
    await empty.getByRole("button", { name: "Clear search and filters" }).click();
    await expect(rows).toHaveCount(3);
    await expect(empty.locator("#recent-search")).toBeHidden();

    // Filter: Type toggles; the toggle button gets the active dot class; Esc closes the popover.
    await empty.locator("#recent-filter-toggle").click();
    await expect(empty.locator("#recent-filter-popover")).toBeVisible();
    await empty.getByRole("menuitemcheckbox", { name: "Canvases" }).click();
    await expect(rows).toHaveCount(2);
    await expect(empty.locator("#recent-filter-toggle")).toHaveClass(/is-active/);
    await empty.getByRole("button", { name: "Reset filters" }).click();
    await expect(rows).toHaveCount(3);
    await empty.keyboard.press("Escape");
    await expect(empty.locator("#recent-filter-popover")).toBeHidden();
    await expect(empty.locator("#recent-filter-toggle")).not.toHaveClass(/is-active/);

    // The checkbox shows on hover; selecting swaps the header for "N selected" and a plain row click then toggles.
    const checks = empty.locator(".recent-check");
    await expect(checks.first()).toHaveCSS("opacity", "0");
    await rows.first().hover();
    await expect(checks.first()).toHaveCSS("opacity", "1");
    await checks.nth(0).click();
    await expect(empty.locator("#recent-count")).toHaveText("1 selected");
    await expect(empty.locator("#recent-search-toggle")).toBeHidden();
    await rows.nth(1).click();
    await expect(empty.locator("#recent-count")).toHaveText("2 selected");
    await expect(empty.locator(".recent-item.selected")).toHaveCount(2);

    // Esc clears; "Select all" picks every match.
    await empty.keyboard.press("Escape");
    await expect(empty.locator("#recent-selbar")).toBeHidden();
    await checks.nth(0).click();
    await empty.getByRole("button", { name: "Select all" }).click();
    await expect(empty.locator("#recent-count")).toHaveText("3 selected");
    await expect(empty.getByRole("button", { name: "Select all" })).toBeHidden();

    // A cancelled confirm keeps everything; an accepted one removes the files and empties the list.
    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await empty.locator("#recent-delete").click();
    await expect(empty.locator("#recent-delete")).toBeEnabled();
    await expect(empty.locator("#recent-count")).toHaveText("3 selected");
    expect(fs.existsSync(path.join(docDir, "doc_alpha.json"))).toBe(true);
    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    // A partial failure (the documents directory is read-only, so both documents fail): the canvas goes, the two
    // failed items stay selected and the bar says so. The note clears on the next selection change.
    fs.chmodSync(docDir, 0o500);
    try {
      await empty.locator("#recent-delete").click();
      await expect(empty.locator("#recent-note")).toHaveText("Couldn't delete 2 items.");
    } finally {
      fs.chmodSync(docDir, 0o700);
    }
    await expect(rows).toHaveCount(2);
    await expect(empty.locator("#recent-count")).toHaveText("2 selected");
    expect(fs.existsSync(path.join(canvasDir, "cv_gamma.meta.json"))).toBe(false);
    expect(fs.existsSync(path.join(docDir, "doc_alpha.json"))).toBe(true);
    await empty.locator(".recent-check").nth(0).click();
    await expect(empty.locator("#recent-note")).toHaveText("");
    await empty.locator(".recent-check").nth(0).click();
    await expect(empty.locator("#recent-count")).toHaveText("2 selected");
    await empty.locator("#recent-delete").click();
    await expect(empty.locator("#recent")).toBeHidden();
    await expect(rows).toHaveCount(0);
    expect(fs.existsSync(path.join(docDir, "doc_alpha.json"))).toBe(false);
    expect(fs.existsSync(path.join(docDir, "doc_beta.json"))).toBe(false);
    expect(fs.existsSync(path.join(canvasDir, "cv_gamma.meta.json"))).toBe(false);
    // Deleted documents leave tombstones, which are not documents.
    expect(JSON.parse(fs.readFileSync(path.join(docDir, ".deleted.json"), "utf8")).map((t: { id: string }) => t.id).sort()).toEqual(["doc_alpha", "doc_beta"]);
    expect(cspErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
