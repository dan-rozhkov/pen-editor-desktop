import { test, expect, _electron as electron } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>
        window.__commands = [];
        if (window.penDesktop) {
          window.penDesktop.onMenuCommand((id) => window.__commands.push(id));
        }
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("launches, opens a tab with the editor, exposes the menu bridge", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  // Windows: the tab bar view and the first tab view each surface as a page.
  const editorPage = await app.waitForEvent("window", {
    predicate: (p) => p.url().startsWith(baseUrl),
  });
  await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

  // The preload bridge is present in the editor page.
  expect(await editorPage.evaluate(() => typeof (window as never as { penDesktop?: unknown }).penDesktop)).toBe(
    "object",
  );

  // Forward a menu command from the main process to the active tab and see it arrive.
  await app.evaluate(({ webContents }, url) => {
    const target = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(url));
    target?.send("menu:command", "file-open");
  }, baseUrl);
  await expect
    .poll(() => editorPage.evaluate(() => (window as never as { __commands: string[] }).__commands))
    .toContain("file-open");

  await app.close();
});
