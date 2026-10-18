// Regression: Emulation.* CDP on a browser tab that has not committed a
// document crashed the Electron MAIN process (SIGSEGV, EXC_BAD_ACCESS at 0x0 on
// CrBrowserMain, Electron 43.8). Two ways to get there: `applyFixture({ emulate })`
// as the FIRST browser command of a scope (shared or isolated: the fixture's
// newTab hook creates an empty tab, then emulates it before loading), and the
// Browser tools menu viewport on a brand-new empty browser tab. window.ts's
// the commit gate (commitGate.ts) holds Emulation.* back until the tab has a document.
// Hermetic: local servers only, no backend, no LLM.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

let editorServer: http.Server;
let siteServer: http.Server;
let editorBaseUrl: string;
let site: string;
const seenUserAgents: string[] = [];

test.beforeAll(async () => {
  editorServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title><h1 id="ready">stub-editor</h1>`);
  });
  await new Promise<void>((r) => editorServer.listen(0, "127.0.0.1", r));
  editorBaseUrl = `http://127.0.0.1:${(editorServer.address() as AddressInfo).port}`;

  siteServer = http.createServer((req, res) => {
    if (req.url === "/opener") {
      res.setHeader("content-type", "text/html");
      return void res.end(`<!doctype html><title>opener</title><a id="p" href="/popup-target" target="_blank">open</a>`);
    }
    if (req.url === "/popup-target") {
      res.setHeader("content-type", "text/html");
      return void res.end(`<!doctype html><title>popup</title><pre id="who">popup=real</pre>`);
    }
    if (req.url === "/nocontent") return void res.writeHead(204).end();
    if (req.url === "/api/hello") return void res.writeHead(200, { "content-type": "application/json" }).end('{"msg":"real"}');
    if (req.url === "/mock") {
      res.setHeader("content-type", "text/html");
      return void res.end(`<!doctype html><title>mock</title><pre id="out"></pre><script>fetch('/api/hello').then(r => r.json()).then(j => { document.getElementById('out').textContent = 'api=' + j.msg; });</script>`);
    }
    seenUserAgents.push(String(req.headers["user-agent"] ?? ""));
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>info</title><pre id="info"></pre>
      <script>document.getElementById('info').textContent = JSON.stringify({ w: innerWidth, ua: navigator.userAgent, lang: navigator.language });</script>`);
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  site = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => editorServer.close(() => r()));
  siteServer.closeAllConnections();
  await new Promise<void>((r) => siteServer.close(() => r()));
});

interface Env { app: ElectronApplication; editor: Page; exits: string[] }

async function launch(): Promise<Env> {
  const app = await electron.launch({ args: ["."], env: { ...process.env, PEN_DESKTOP_URL: editorBaseUrl } });
  const exits: string[] = [];
  app.process().on("exit", (code, signal) => exits.push(`${code} ${signal}`));
  const editor = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(editorBaseUrl) });
  await expect(editor.locator("#ready")).toHaveText("stub-editor");
  return { app, editor, exits };
}

/** Runs the command on the shared browser, or on isolated session `session`. */
function cmd(editor: Page, session: string | null, method: string, ...args: unknown[]): Promise<Record<string, any>> {
  return editor.evaluate(
    async ({ session, method, args }) => {
      const b = (window as any).penDesktop.browser;
      const t = session === null ? b : b.isolated(session);
      return await t[method](...args);
    },
    { session, method, args },
  );
}

async function readInfo(editor: Page, session: string | null) {
  const r = await cmd(editor, session, "read", {});
  const m = /\{"w":\d+,"ua":"[^"]*","lang":"[^"]*"\}/.exec(JSON.stringify(r).replace(/\\"/g, '"'));
  if (!m) throw new Error("no info in " + JSON.stringify(r).slice(0, 300));
  return JSON.parse(m[0]) as { w: number; ua: string; lang: string };
}

for (const session of [null, "emu-first"] as const) {
  const scope = session === null ? "shared browser" : "isolated session";

  test(`applyFixture with emulate device as the first command (${scope})`, async () => {
    const env = await launch();
    try {
      seenUserAgents.length = 0;
      const res = await cmd(env.editor, session, "applyFixture", { version: 1, url: `${site}/`, emulate: { device: "iphone-15" } });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(env.exits).toEqual([]);
      const info = await readInfo(env.editor, session);
      expect(info.w).toBe(393);
      expect(info.ua).toContain("iPhone");
      expect(seenUserAgents.at(-1)).toContain("iPhone");
      expect(env.exits).toEqual([]);
    } finally {
      if (session !== null) await cmd(env.editor, null, "closeSession", session).catch(() => undefined);
      await env.app.close().catch(() => undefined);
    }
  });

  test(`applyFixture with emulate locale (init script path) as the first command (${scope})`, async () => {
    const env = await launch();
    try {
      const res = await cmd(env.editor, session, "applyFixture", { version: 1, url: `${site}/`, emulate: { locale: "de-DE", colorScheme: "dark" } });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const info = await readInfo(env.editor, session);
      expect(info.lang).toBe("de-DE");
      expect(env.exits).toEqual([]);
    } finally {
      if (session !== null) await cmd(env.editor, null, "closeSession", session).catch(() => undefined);
      await env.app.close().catch(() => undefined);
    }
  });
}

test("applyFixture with fresh + network (no emulate) as the first command on a blank tab", async () => {
  const env = await launch();
  try {
    const res = await cmd(env.editor, null, "applyFixture", {
      version: 1,
      fresh: true,
      network: [{ url: `${site}/api/hello`, body: { msg: "mocked" } }],
      url: `${site}/mock`,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    await expect.poll(async () => JSON.stringify(await cmd(env.editor, null, "read", {}))).toContain("api=mocked");
    expect(env.exits).toEqual([]);
  } finally {
    await env.app.close().catch(() => undefined);
  }
});

test("the placeholder leaves no Back entry and no URL behind the first real page", async () => {
  const env = await launch();
  try {
    const res = await cmd(env.editor, null, "applyFixture", { version: 1, url: `${site}/`, emulate: { device: "iphone-15" } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    await expect
      .poll(() =>
        env.app.evaluate(({ webContents }, prefix) => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(prefix));
          return wc ? { entries: wc.navigationHistory.length(), canGoBack: wc.navigationHistory.canGoBack() } : null;
        }, site),
      )
      .toEqual({ entries: 1, canGoBack: false });
  } finally {
    await env.app.close().catch(() => undefined);
  }
});

// A first navigation that commits nothing (HTTP 204 / download / superseded) leaves the tab without a
// document; the gate loads the placeholder itself. A refused connection commits an error page instead
// (did-fail-load + dom-ready, no did-navigate).
for (const first of ["aborted (HTTP 204)", "refused connection"] as const) {
  test(`emulate after a first navigation that was ${first}`, async () => {
    const env = await launch();
    try {
      let url = `${site}/nocontent`;
      if (first === "refused connection") {
        const probe = http.createServer();
        await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
        url = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/`;
        await new Promise<void>((r) => probe.close(() => r()));
      }
      await cmd(env.editor, null, "open", { url }); // result irrelevant: it may report an error
      const res = await cmd(env.editor, null, "applyFixture", { version: 1, emulate: { device: "iphone-15" } });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(env.exits).toEqual([]);
      const open = await cmd(env.editor, null, "open", { url: `${site}/` });
      expect(open.error).toBeUndefined();
      await expect.poll(async () => (await readInfo(env.editor, null)).ua).toContain("iPhone");
      expect(env.exits).toEqual([]);
    } finally {
      await env.app.close().catch(() => undefined);
    }
  });
}

test("Browser tools viewport menu on a brand-new empty browser tab", async () => {
  const env = await launch();
  try {
    const tabbar =
      env.app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
      (await env.app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
    // Record the Viewport menu, never show it.
    await env.app.evaluate(({ Menu }) => {
      const g = globalThis as any;
      g.__menus = [];
      const orig = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (tpl: any) => {
        const m = orig(tpl);
        if (tpl[0]?.label === "Viewport") {
          g.__menus.push(m);
          m.popup = () => {};
        }
        return m;
      };
    });
    // File > New Browser Tab: an empty tab, nothing loaded.
    await env.app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
      file?.submenu?.items.find((i) => i.label === "New Browser Tab")?.click();
    });
    await expect(tabbar.locator("#chrome-row")).toBeVisible();
    await expect(tabbar.locator("#url-input")).toHaveValue("");
    await tabbar.evaluate(() => (window as any).penTabbar.openToolsMenu({ x: 10, y: 10 }));
    await expect.poll(() => env.app.evaluate(() => (globalThis as any).__menus.length as number)).toBe(1);
    // Click Viewport > iPhone 15: this sent Emulation.* to the uncommitted tab.
    await env.app.evaluate(() => {
      const m = (globalThis as any).__menus.at(-1);
      const vp = m.items.find((x: any) => x.label === "Viewport");
      vp.submenu.items.find((x: any) => x.label.startsWith("iPhone 15")).click();
    });
    // The menu applies the preset asynchronously, on the still-empty tab: the radio moves
    // only once every Emulation.* command was answered (no navigation by the agent yet).
    await expect
      .poll(async () => {
        const before = await env.app.evaluate(() => (globalThis as any).__menus.length as number);
        await tabbar.evaluate(() => (window as any).penTabbar.openToolsMenu({ x: 10, y: 10 }));
        await expect.poll(() => env.app.evaluate(() => (globalThis as any).__menus.length as number)).toBe(before + 1);
        return env.app.evaluate(() => {
          const vp = (globalThis as any).__menus.at(-1).items.find((x: any) => x.label === "Viewport");
          return vp.submenu.items.filter((x: any) => x.checked).map((x: any) => x.label as string);
        });
      }, { timeout: 15_000 })
      .toEqual(["iPhone 15 — 393×852"]);
    expect(env.exits).toEqual([]);
    // The placeholder document does not leak into the UI: the tab still reads as new.
    await expect(tabbar.locator("#url-input")).toHaveValue("");
    // The tab is still usable: the agent navigates it and sees the emulated phone.
    const res = await cmd(env.editor, null, "open", { url: `${site}/` });
    expect(res.error).toBeUndefined();
    await expect.poll(async () => (await readInfo(env.editor, null)).ua).toContain("iPhone");
    expect(env.exits).toEqual([]);
  } finally {
    await env.app.close().catch(() => undefined);
  }
});

test("about:blank opened on purpose is reported as about:blank, not hidden as the placeholder", async () => {
  const env = await launch();
  try {
    const open = await cmd(env.editor, null, "open", { url: `${site}/` });
    expect(open.error).toBeUndefined();
    // The agent refuses about:blank, so load it on purpose from the main process.
    await expect
      .poll(() =>
        env.app.evaluate(({ webContents }, prefix) => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(prefix));
          void wc?.loadURL("about:blank");
          return Boolean(wc);
        }, site),
      )
      .toBe(true);
    await expect
      .poll(async () => ((await cmd(env.editor, null, "tabs", { action: "list" })).tabs ?? []).map((t: { url: string }) => t.url))
      .toEqual(["about:blank"]);
  } finally {
    await env.app.close().catch(() => undefined);
  }
});

test("a popup opened while routing is active is mocked on its very first request", async () => {
  const env = await launch();
  try {
    const res = await cmd(env.editor, null, "applyFixture", {
      version: 1,
      network: [{ url: `${site}/popup-target`, headers: { "content-type": "text/html" }, body: '<!doctype html><pre id="who">popup=mocked</pre>' }],
      url: `${site}/opener`,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const act = await cmd(env.editor, null, "act", { action: "click", target: "#p" });
    expect(act.error).toBeUndefined();
    await expect.poll(async () => ((await cmd(env.editor, null, "tabs", { action: "list" })).tabs ?? []).length).toBe(2);
    await expect.poll(async () => JSON.stringify(await cmd(env.editor, null, "read", {}))).toContain("popup=mocked");
    expect(env.exits).toEqual([]);
  } finally {
    await env.app.close().catch(() => undefined);
  }
});

test("a URL typed into a new tab right after the tools menu opened is not cancelled", async () => {
  const env = await launch();
  try {
    const tabbar =
      env.app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
      (await env.app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
    await env.app.evaluate(({ Menu }) => {
      const g = globalThis as any;
      g.__menus = [];
      const orig = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (tpl: any) => {
        const m = orig(tpl);
        if (tpl[0]?.label === "Viewport") {
          g.__menus.push(m);
          m.popup = () => {};
        }
        return m;
      };
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
      file?.submenu?.items.find((i) => i.label === "New Browser Tab")?.click();
    });
    await expect(tabbar.locator("#chrome-row")).toBeVisible();
    await tabbar.evaluate(() => (window as any).penTabbar.openToolsMenu({ x: 10, y: 10 }));
    await expect.poll(() => env.app.evaluate(() => (globalThis as any).__menus.length as number)).toBe(1);
    await env.app.evaluate(() => {
      const vp = (globalThis as any).__menus.at(-1).items.find((x: any) => x.label === "Viewport");
      vp.submenu.items.find((x: any) => x.label.startsWith("iPhone 15")).click();
    });
    await tabbar.evaluate((u) => (window as any).penTabbar.navigate("url", u), `${site}/`);
    await expect(tabbar.locator("#url-input")).toHaveValue(`${site}/`, { timeout: 15_000 });
    await expect.poll(async () => (await readInfo(env.editor, null)).ua, { timeout: 15_000 }).toContain("iPhone");
    expect(env.exits).toEqual([]);
  } finally {
    await env.app.close().catch(() => undefined);
  }
});
