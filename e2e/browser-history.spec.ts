// Browser history end to end: two pages visited in a user browser tab are recorded, the address field
// suggests them in its popover view (its own page, omnibox.html), typing filters, ArrowDown + Enter
// navigates, and the History tab (File > History...) lists them and removes a row.
// userData is a throwaway dir, so the developer's real history is never touched.

import { test, expect, type Page } from "@playwright/test";
import { launchShell } from "./launch";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let server: http.Server;
let baseUrl: string;
let userData: string;

const page = (title: string) => `<!doctype html><title>${title}</title><h1 id="ready">${title}</h1>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/alpha") res.end(page("Alpha Gazette"));
    else if (req.url === "/bravo") res.end(page("Bravo Journal"));
    else res.end(page("Stub Editor"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userData = mkdtempSync(path.join(tmpdir(), "pen-desktop-history-e2e-"));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(userData, { recursive: true, force: true });
});

test("browser history: omnibox suggestions, filter, pick, History tab list and remove", async () => {
  const app = await launchShell({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl, PEN_DESKTOP_USER_DATA_DIR: userData },
  });
  const pageErrors: string[] = [];
  try {
    await expect(app.canvasPage.locator("#ready")).toHaveText("Stub Editor");
    const tabbar =
      app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
    const omnibox =
      app.windows().find((p) => p.url().endsWith("/omnibox/omnibox.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/omnibox/omnibox.html") }));
    omnibox.on("pageerror", (err) => pageErrors.push(String(err)));

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
        const item = find(Menu.getApplicationMenu()!.items);
        if (!item) throw new Error(`menu item ${wanted} not found`);
        item.click();
      }, label);

    // A user browser tab, then two navigations through the address row.
    await clickMenu("New Browser Tab");
    const input = tabbar.locator("#url-input");
    await expect(tabbar.locator("#chrome-row")).toBeVisible();
    await expect.poll(() => tabbar.evaluate(() => document.activeElement?.id)).toBe("url-input");
    const activeTab = tabbar.locator(".tab.active");

    await input.fill(`${baseUrl}/alpha`);
    await input.press("Enter");
    await expect(activeTab).toContainText("Alpha Gazette");
    await input.fill(`${baseUrl}/bravo`);
    await input.press("Enter");
    await expect(activeTab).toContainText("Bravo Journal");

    // Focus the field: both pages are suggested (newest first), as the "Recent" list.
    await input.blur();
    await input.focus();
    const rows = omnibox.locator(".rows .row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Bravo Journal");

    // Typing part of a title filters to one row.
    await input.press("ControlOrMeta+A");
    await input.pressSequentially("alpha");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Alpha Gazette");

    // ArrowDown selects the row, Enter opens it in the active tab.
    await input.press("ArrowDown");
    await expect(omnibox.locator(".rows .row.selected")).toHaveCount(1);
    await input.press("Enter");
    await expect(activeTab).toContainText("Alpha Gazette");

    // History tab: both pages listed, newest first; removing one drops its row.
    await clickMenu("History…");
    const history: Page =
      app.windows().find((p) => p.url().endsWith("history.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("history.html") }));
    history.on("pageerror", (err) => pageErrors.push(String(err)));
    await expect(tabbar.locator(".tab.active")).toContainText("History");
    const list = history.locator(".row");
    await expect(list).toHaveCount(2);
    await expect(list.first()).toContainText("Alpha Gazette");
    await expect(list.nth(1)).toContainText("Bravo Journal");

    await list.filter({ hasText: "Bravo Journal" }).locator(".row-remove").click({ force: true });
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText("Alpha Gazette");

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});

test("browser history: removing a row with the popover x keeps the popover open with the typed text", async () => {
  const app = await launchShell({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl, PEN_DESKTOP_USER_DATA_DIR: mkdtempSync(path.join(tmpdir(), "pen-desktop-history-e2e-x-")) },
  });
  try {
    await expect(app.canvasPage.locator("#ready")).toHaveText("Stub Editor");
    const tabbar =
      app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
    const omnibox =
      app.windows().find((p) => p.url().endsWith("/omnibox/omnibox.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/omnibox/omnibox.html") }));
    await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) {
          if (it.label === "New Browser Tab") return it;
          const hit = it.submenu ? find(it.submenu.items) : undefined;
          if (hit) return hit;
        }
        return undefined;
      };
      find(Menu.getApplicationMenu()!.items)!.click();
    });
    const input = tabbar.locator("#url-input");
    await expect.poll(() => tabbar.evaluate(() => document.activeElement?.id)).toBe("url-input");
    const activeTab = tabbar.locator(".tab.active");
    await input.fill(`${baseUrl}/alpha`);
    await input.press("Enter");
    await expect(activeTab).toContainText("Alpha Gazette");
    await input.fill(`${baseUrl}/alpha2`);
    await input.press("Enter");
    await input.fill(`${baseUrl}/bravo`);
    await input.press("Enter");
    await expect(activeTab).toContainText("Bravo Journal");

    await input.blur();
    await input.focus();
    await input.press("ControlOrMeta+A");
    const typed = `${baseUrl.replace("http://", "")}/`;
    await input.pressSequentially(typed);
    const rows = omnibox.locator(".rows .row");
    await expect(rows).toHaveCount(3);

    // The real click on the popover's x blurs the tab bar field first; reproduce that, then click.
    await tabbar.evaluate(() => (document.getElementById("url-input") as HTMLInputElement).blur());
    await rows.filter({ hasText: "Bravo Journal" }).hover();
    await rows.filter({ hasText: "Bravo Journal" }).locator(".remove").dispatchEvent("mousedown", { button: 0 });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Bravo Journal" })).toHaveCount(0);
    await expect(input).toHaveValue(typed);
    await expect.poll(() => tabbar.evaluate(() => document.activeElement?.id)).toBe("url-input");
    // Wait past the close timer: the popover must still be open.
    await tabbar.waitForTimeout(400);
    await expect(rows).toHaveCount(2);
    await expect(input).toHaveValue(typed);
  } finally {
    await app.close().catch(() => {});
  }
});
