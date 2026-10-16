// The Passwords window (File > Passwords...) end to end: add a login through
// the form, see it in the list and the detail pane, search, edit, delete, in
// both themes. The OS secret store is faked in the main process (only
// isEncryptionAvailable / encryptString / decryptString), and the userData
// dir is a throwaway one seeded with a few entries, so the real Keychain and
// the developer's saved logins are never touched.
// Screenshots (light and dark) are written only when PW_SHOTS_DIR is set.

import { test, expect, _electron as electron, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let server: http.Server;
let baseUrl: string;
let userData: string;

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title><h1 id="ready">stub-editor</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  userData = mkdtempSync(path.join(tmpdir(), "pen-desktop-pw-e2e-"));
  const now = Date.now();
  const seed = (id: string, origin: string, username: string, label: string, lastUsedAt?: number) => ({
    id,
    origin,
    username,
    label,
    password: Buffer.from("xseed-secret").toString("base64"),
    ...(lastUsedAt ? { lastUsedAt } : {}),
  });
  writeFileSync(
    path.join(userData, "browser-credentials.json"),
    JSON.stringify({
      version: 1,
      entries: [
        seed("s1", "https://github.com", "thomas@example.com", "", now - 3 * 3600_000),
        seed("s2", "https://figma.com", "design-team@example.com", "work", now - 2 * 86400_000),
        seed("s3", "http://localhost:3000", "admin", "dev", undefined),
        seed(
          "s4",
          "https://a-remarkably-long-subdomain.internal.example-corporation.com",
          "firstname.lastname.with.a.very.long.address@example-corporation.com",
          "staging",
          now - 40 * 86400_000,
        ),
      ],
      never: ["ads.example.net"],
    }),
  );
  // One cached site icon (an SVG, shown through <img>), so both tile variants are visible.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#24292f"/><circle cx="16" cy="16" r="6" fill="#ffffff"/></svg>`;
  writeFileSync(
    path.join(userData, "browser-favicons.json"),
    JSON.stringify({
      version: 2,
      icons: { "https://github.com": { src: "https://github.com/favicon.svg", data: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` } },
    }),
  );
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(userData, { recursive: true, force: true });
});

test("passwords window: add, list, detail, search, edit, delete; light and dark", async () => {
  mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl, PEN_DESKTOP_USER_DATA_DIR: userData },
  });
  const pageErrors: string[] = [];
  try {
    const editorPage = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(baseUrl) });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    await app.evaluate(({ safeStorage }) => {
      const s = safeStorage as unknown as Record<string, unknown>;
      s.isEncryptionAvailable = () => true;
      s.encryptString = (p: string) => Buffer.from(`x${p}`);
      s.decryptString = (b: Buffer) => b.toString().slice(1);
    });
    // File > Passwords...: found by its label in the application menu.
    await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) {
          if (it.label === "Passwords…") return it;
          const hit = it.submenu ? find(it.submenu.items) : undefined;
          if (hit) return hit;
        }
        return undefined;
      };
      find(Menu.getApplicationMenu()!.items)!.click();
    });
    const pw: Page = await (async () => {
      const found = app.windows().find((p) => p.url().endsWith("passwords.html"));
      return found ?? app.waitForEvent("window", { predicate: (p) => p.url().endsWith("passwords.html") });
    })();

    pw.on("pageerror", (err) => pageErrors.push(String(err)));

    // Seeded content: four logins, one never-saved host.
    await expect(pw.locator("#count-all")).toHaveText("4");
    await expect(pw.locator("#count-never")).toHaveText("1");
    await expect(pw.locator(".row")).toHaveCount(4);
    // Sorted by origin; the first one is selected by default and its detail is shown.
    await expect(pw.locator(".row[aria-selected=true] .row-title")).toHaveText("localhost:3000");

    // Add a login through the form.
    await pw.click("#add-btn");
    await expect(pw.locator(".hero-title")).toHaveText("New login");
    await pw.fill('input[aria-label="Website"]', "https://news.ycombinator.com/login");
    await pw.fill('input[aria-label="Username"]', "pg");
    await pw.fill('input[aria-label="Password"]', "e2e-Secret-Password-1");
    await pw.fill('input[aria-label="Label"]', "reader");
    await pw.press('input[aria-label="Label"]', "Enter");

    await expect(pw.locator("#count-all")).toHaveText("5");
    await expect(pw.locator(".row[aria-selected=true] .row-title")).toHaveText("news.ycombinator.com");
    await expect(pw.locator(".row[aria-selected=true] .chip")).toHaveText("reader");
    await expect(pw.locator(".hero-title")).toHaveText("news.ycombinator.com");
    await expect(pw.locator(".hero-sub")).toHaveText("reader");
    await expect(pw.locator(".dots")).toHaveText("•".repeat(12));
    await expect(pw.locator(".field-value", { hasText: "https://news.ycombinator.com" })).toBeVisible();
    // The password never shows up in the page.
    expect(await pw.content()).not.toContain("e2e-Secret-Password-1");
    expect(await pw.evaluate(() => document.body.innerText)).not.toContain("e2e-Secret-Password-1");

    // A failed add shows an inline error and keeps the form.
    await pw.click("#add-btn");
    await pw.fill('input[aria-label="Website"]', "bad host");
    await pw.fill('input[aria-label="Username"]', "u");
    await pw.fill('input[aria-label="Password"]', "p");
    await pw.press('input[aria-label="Password"]', "Enter");
    await expect(pw.locator(".form-error")).toHaveText("Enter a valid site address.");
    // Esc on a dirty form asks first; Esc again keeps editing; Discard cancels.
    await pw.press('input[aria-label="Password"]', "Escape");
    await expect(pw.locator(".discard-bar")).toBeVisible();
    await expect(pw.locator(".hero-title")).toHaveText("New login");
    await pw.keyboard.press("Escape");
    await expect(pw.locator(".discard-bar")).toHaveCount(0);
    await expect(pw.locator(".hero-title")).toHaveText("New login");
    await pw.press('input[aria-label="Password"]', "Escape");
    await pw.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(pw.locator(".hero-title")).not.toHaveText("New login");

    // The same site + username needs a second click: warning first, then Replace.
    await pw.click("#add-btn");
    await pw.fill('input[aria-label="Website"]', "news.ycombinator.com");
    await pw.fill('input[aria-label="Username"]', "pg");
    await pw.fill('input[aria-label="Password"]', "e2e-Secret-Password-2");
    await pw.press('input[aria-label="Password"]', "Enter");
    await expect(pw.locator(".form-warning")).toHaveText(
      "A login for pg on news.ycombinator.com exists. Saving replaces its password.",
    );
    await expect(pw.locator("button[type=submit]")).toHaveText("Replace");
    await expect(pw.locator(".hero-title")).toHaveText("New login");
    await expect(pw.locator("#count-all")).toHaveText("5");
    await pw.click("button[type=submit]");
    await expect(pw.locator(".hero-title")).toHaveText("news.ycombinator.com");
    await expect(pw.locator("#count-all")).toHaveText("5");
    expect(await pw.content()).not.toContain("e2e-Secret-Password-2");

    // Search by label, then clear.
    await pw.press("body", process.platform === "darwin" ? "Meta+f" : "Control+f");
    await expect(pw.locator("#search")).toBeFocused();
    await pw.fill("#search", "work");
    await expect(pw.locator(".row")).toHaveCount(1);
    await expect(pw.locator(".row-title")).toHaveText("figma.com");
    await pw.fill("#search", "zzz");
    await expect(pw.locator("#list-empty-title")).toHaveText("No results");
    await pw.fill("#search", "");
    await expect(pw.locator(".row")).toHaveCount(5);

    // Arrow keys move the selection.
    await pw.locator("#search").focus();
    const first = await pw.locator(".row[aria-selected=true] .row-title").innerText();
    await pw.keyboard.press("ArrowDown");
    expect(await pw.locator(".row[aria-selected=true] .row-title").innerText()).not.toBe(first);

    // Edit: label of the figma login.
    await pw.locator(".row", { hasText: "figma.com" }).click();
    await pw.click("text=Edit");
    await expect(pw.locator('input[aria-label="Website"]')).toBeDisabled();
    await pw.fill('input[aria-label="Label"]', "design");
    await pw.click("button[type=submit]");
    await expect(pw.locator(".hero-sub")).toHaveText("design");

    // Delete asks for confirmation inline; Esc backs out, the second try deletes.
    await pw.click("text=Delete");
    await expect(pw.locator(".confirm-text")).toHaveText("Delete this login?");
    await pw.keyboard.press("Escape");
    await expect(pw.locator(".confirm-text")).toHaveCount(0);
    await expect(pw.locator("#count-all")).toHaveText("5");
    await pw.click("text=Delete");
    await pw.locator(".btn-destructive").click();
    await expect(pw.locator("#count-all")).toHaveText("4");
    await expect(pw.locator(".row", { hasText: "figma.com" })).toHaveCount(0);

    // Never saved view.
    await pw.click("#nav-never");
    await expect(pw.locator(".row-title")).toHaveText("ads.example.net");
    await pw.click("#nav-all");
    await pw.locator(".row", { hasText: "github.com" }).click();
    // Tiles: the cached icon through <img>, a globe elsewhere; never the password.
    await expect(pw.locator(".row", { hasText: "github.com" }).locator("img.tile-img")).toHaveCount(1);
    await expect(pw.locator(".row", { hasText: "localhost" }).locator("img.tile-img")).toHaveCount(0);
    await expect(pw.locator(".row", { hasText: "localhost" }).locator("svg.icon")).toHaveCount(1);

    // Saving over an existing origin + username (after the Replace confirmation) reselects that entry by the id main returns, and clears a filter that hides it.
    await pw.fill("#search", "localhost");
    await expect(pw.locator(".row")).toHaveCount(1);
    await pw.click("#add-btn");
    await pw.fill('input[aria-label="Website"]', "github.com/login");
    await pw.fill('input[aria-label="Username"]', "thomas@example.com");
    await pw.fill('input[aria-label="Password"]', "again-Secret-1");
    await pw.press('input[aria-label="Password"]', "Enter");
    await expect(pw.locator(".form-warning")).toBeVisible();
    await pw.press('input[aria-label="Password"]', "Enter");
    await expect(pw.locator("#count-all")).toHaveText("4");
    await expect(pw.locator("#search")).toHaveValue("");
    await expect(pw.locator(".row[aria-selected=true] .row-title")).toHaveText("github.com");
    await expect(pw.locator(".hero-title")).toHaveText("github.com");

    // A dirty form is not discarded silently by a row click or an arrow key.
    await pw.getByRole("button", { name: "Edit", exact: true }).click();
    await pw.fill('input[aria-label="Label"]', "tmp");
    await pw.locator(".row", { hasText: "localhost" }).click();
    await expect(pw.locator(".discard-bar")).toBeVisible();
    await expect(pw.locator(".discard-bar .confirm-text")).toHaveText("Discard changes?");
    await pw.getByRole("button", { name: "Keep editing" }).click();
    await expect(pw.locator(".discard-bar")).toHaveCount(0);
    await expect(pw.locator(".hero-title")).toHaveText("Edit login");
    await expect(pw.locator('input[aria-label="Label"]')).toHaveValue("tmp");
    await pw.locator(".row", { hasText: "localhost" }).focus();
    await pw.keyboard.press("ArrowDown");
    await expect(pw.locator(".discard-bar")).toBeVisible();
    await pw.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(pw.locator(".discard-bar")).toHaveCount(0);
    await expect(pw.locator(".hero-title")).not.toHaveText("Edit login");
    // A clean form switches at once; Escape on a dirty one asks, then Discard cancels.
    await pw.locator(".row", { hasText: "github.com" }).click();
    await pw.getByRole("button", { name: "Edit", exact: true }).click();
    await pw.locator(".row", { hasText: "localhost" }).click();
    await expect(pw.locator(".discard-bar")).toHaveCount(0);
    await expect(pw.locator(".hero-title")).toHaveText("localhost:3000");
    await pw.getByRole("button", { name: "Edit", exact: true }).click();
    await pw.fill('input[aria-label="Label"]', "changed");
    await pw.press('input[aria-label="Label"]', "Escape");
    await expect(pw.locator(".discard-bar")).toBeVisible();
    await pw.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(pw.locator(".hero-title")).toHaveText("localhost:3000");
    await expect(pw.locator(".discard-bar")).toHaveCount(0);

    // Clean state for the captures: github.com selected, no banner.
    await pw.locator(".row", { hasText: "github.com" }).click();
    // Both themes, from main's theme push (the editor tab reports its theme from the root `dark` class, like the real editor).
    const shotsDir = process.env.PW_SHOTS_DIR;
    for (const theme of ["light", "dark"] as const) {
      await editorPage.evaluate((t) => document.documentElement.classList.toggle("dark", t === "dark"), theme);
      await expect(pw.locator("html")).toHaveAttribute("data-theme", theme);
      if (shotsDir) {
        await pw.waitForTimeout(400); // let the 150ms colour transitions settle
        mkdirSync(shotsDir, { recursive: true });
        await pw.screenshot({ path: path.join(shotsDir, `shot-${theme}.png`) });
      }
    }
    // The real window with the native traffic lights (macOS only; needs screen-capture permission).
    if (shotsDir && process.platform === "darwin") {
      await editorPage.evaluate(() => document.documentElement.classList.remove("dark"));
      await expect(pw.locator("html")).toHaveAttribute("data-theme", "light");
      const sourceId = await app.evaluate(({ BaseWindow, app }) => {
        const w = BaseWindow.getAllWindows().find((x) => x.getTitle() === "Passwords")!;
        app.focus({ steal: true });
        w.focus();
        return w.getMediaSourceId();
      });
      await pw.waitForTimeout(600);
      const id = sourceId.split(":")[1];
      try {
        execFileSync("screencapture", ["-l", id, "-o", path.join(shotsDir, "shot-native.png")]);
      } catch (err) {
        console.log("native capture failed:", String(err));
      }
    }
    // A failed delete shows the fixed error; an IPC rejection shows the generic one. Nothing is removed.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("passwords:remove");
      ipcMain.handle("passwords:remove", () => ({ ok: false, error: "That login no longer exists." }));
    });
    await pw.click("text=Delete");
    await pw.locator(".btn-destructive").click();
    await expect(pw.locator("#status")).toHaveText("That login no longer exists.");
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("passwords:remove");
      ipcMain.handle("passwords:remove", () => {
        throw new Error("boom");
      });
    });
    await pw.click("text=Delete");
    await pw.locator(".btn-destructive").click();
    await expect(pw.locator("#status")).toHaveText("Could not delete the login.");
    await expect(pw.locator("#count-all")).toHaveText("4");

    // Without encryption only a typed password is blocked: label-only edits still save.
    await app.evaluate(({ safeStorage }) => {
      (safeStorage as unknown as Record<string, unknown>).isEncryptionAvailable = () => false;
    });
    await pw.click("#nav-never"); // refresh through a successful call: removeNever
    await pw.getByRole("button", { name: /^Remove/ }).click();
    await expect(pw.locator("#count-never")).toHaveText("0");
    await expect(pw.locator("#unavailable")).toBeVisible();
    await pw.click("#nav-all");
    await pw.locator(".row", { hasText: "localhost" }).click();
    await pw.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(pw.locator("button[type=submit]")).toBeEnabled();
    await pw.fill('input[aria-label="Password"]', "x");
    await expect(pw.locator("button[type=submit]")).toBeDisabled();
    await pw.fill('input[aria-label="Password"]', "");
    await expect(pw.locator("button[type=submit]")).toBeEnabled();
    await pw.press('input[aria-label="Password"]', "Escape");
    await pw.click("#add-btn");
    await expect(pw.locator("button[type=submit]")).toBeDisabled();
    await pw.press('input[aria-label="Website"]', "Escape");
    await app.evaluate(({ safeStorage }) => {
      (safeStorage as unknown as Record<string, unknown>).isEncryptionAvailable = () => true;
    });
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
