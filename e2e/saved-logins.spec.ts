// Saved logins (docs/superpowers/specs/2026-10-16-browser-saved-logins-design.md),
// end to end through real IPC and a real browser tab:
//  - fillLogin from an editor tab answers with a fixed error when nothing is saved;
//  - signing in by hand in a browser tab reaches main's save prompt through the
//    CDP runtime binding of the isolated world (installed WITHOUT Runtime.enable),
//    and the prompt names the tab's origin and username, never the password.
//    A wrong password (a real POST that reloads the login form) asks nothing.
// The native dialog is replaced with a recorder, so the run never blocks and
// never touches the Keychain (the answer is "Not Now").

import { test, expect, _electron as electron } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  const loginForm = `<!doctype html><title>Login</title>
        <form id="f" method="post" action="/login">
          <input id="user" type="text" name="user" aria-label="Email">
          <input id="pw" type="password" name="pw" aria-label="Password">
          <button id="go" type="submit">Sign in</button>
        </form>`;
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/login")) {
      if (req.method === "POST") {
        // A real POST: a wrong password re-renders the login form (a reload of
        // the same page); the right one redirects to a page without one.
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          if (new URLSearchParams(body).get("pw")?.startsWith("e2e")) {
            res.statusCode = 303;
            res.setHeader("location", "/home");
            res.end();
          } else {
            res.end(loginForm);
          }
        });
        return;
      }
      res.end(loginForm);
      return;
    }
    if (req.url?.startsWith("/home")) {
      res.end(`<!doctype html><title>Home</title><h1>Signed in</h1>`);
      return;
    }
    res.end(`<!doctype html><title>Stub Editor</title><h1 id="ready">stub-editor</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("saved logins: fillLogin error path and the save prompt via the isolated-world binding", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(baseUrl) });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    // Record (and answer "Not Now" to) every native dialog.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dialogs: unknown[] };
      g.__dialogs = [];
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...args: unknown[]) => {
        g.__dialogs.push(args[args.length - 1]);
        return { response: 2, checkboxChecked: false };
      };
    });

    const bridge = (page: typeof editorPage) =>
      page.evaluate(async (url) => {
        const b = (window as unknown as { penDesktop: { browser: Record<string, (a?: unknown) => Promise<unknown>> } })
          .penDesktop.browser;
        const opened = await b.open({ url });
        const filled = await b.fillLogin({ submit: true });
        return { opened, filled };
      }, `${baseUrl}/login`);

    const { filled } = (await bridge(editorPage)) as { filled: unknown };
    expect(filled).toEqual({
      ok: false,
      error: `No saved login for ${baseUrl}. The user can add one in the Passwords window.`,
    });

    // The user signs in by hand in the browser tab.
    const loginPage =
      app.windows().find((p) => p.url().startsWith(`${baseUrl}/login`)) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(`${baseUrl}/login`) }));
    await loginPage.fill("#user", "alice@example.test");
    // First a failed attempt: a real POST that re-renders the login form.
    // The page navigates, but the sign-in form is still showing, so nothing is asked.
    await loginPage.fill("#pw", "typo-password");
    await Promise.all([loginPage.waitForNavigation(), loginPage.click("#go")]);
    await expect(loginPage.locator("#pw")).toHaveValue("");
    await loginPage.waitForTimeout(1500);
    expect(await app.evaluate(() => (globalThis as unknown as { __dialogs: unknown[] }).__dialogs.length)).toBe(0);
    // Then the real one: the POST redirects to /home, which has no password field.
    await loginPage.fill("#user", "alice@example.test");
    await loginPage.fill("#pw", "e2e-Secret-Password-1");
    await loginPage.click("#go");

    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __dialogs: unknown[] }).__dialogs.length))
      .toBe(1);
    const dialogs = await app.evaluate(() => (globalThis as unknown as { __dialogs: unknown[] }).__dialogs);
    expect(dialogs[0]).toMatchObject({
      message: `Save password for ${baseUrl}?`,
      detail: "alice@example.test",
      buttons: ["Save", "Never for This Site", "Not Now"],
    });
    expect(JSON.stringify(dialogs)).not.toContain("e2e-Secret-Password-1");
    expect(JSON.stringify(dialogs)).not.toContain("typo-password");
  } finally {
    await app.close();
  }
});
