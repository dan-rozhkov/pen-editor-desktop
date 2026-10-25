// Live check of the Browser tools menu and the QA diagnostics path in the REAL
// Electron app: viewport emulation, DevTools next to the automation debugger,
// zoom, failedRequests + assert, fixture emulate, upload, and the tab bar
// "Browser tools" button. Local servers only, no backend, no LLM.
//
// A native menu cannot be clicked by Playwright (and Menu.popup would block a
// run). The tests therefore wrap Menu.buildFromTemplate in the main process:
// the menu the app really builds is recorded, its popup is a no-op, and the
// test clicks the recorded MenuItem (the same `click` the user would reach).

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchShell } from "./launch";
import http from "node:http";
import type { AddressInfo } from "node:net";

let editorServer: http.Server;
let siteServer: http.Server;
let editorBaseUrl: string;
let site: string;

const INFO_SCRIPT = `
  const i = document.getElementById('info');
  const ud = navigator.userAgentData;
  i.textContent = JSON.stringify({ w: innerWidth, h: innerHeight, ua: navigator.userAgent, mobile: ud ? ud.mobile : null, brands: ud ? ud.brands.map(b => b.brand) : null });
`;

test.beforeAll(async () => {
  editorServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title><h1 id="ready">stub-editor</h1>
      <script>if (window.penDesktop) { window.penDesktop.setDocumentTitle('Stub'); }</script>`);
  });
  await new Promise<void>((r) => editorServer.listen(0, "127.0.0.1", r));
  editorBaseUrl = `http://127.0.0.1:${(editorServer.address() as AddressInfo).port}`;

  const loadsByKey = new Map<string, number>();
  siteServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/e500") { res.statusCode = 500; res.end("boom"); return; }
    if (url.pathname === "/e404") { res.statusCode = 404; res.end("gone"); return; }
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/info") {
      const key = url.searchParams.get("k") ?? "";
      const loads = (loadsByKey.get(key) ?? 0) + 1;
      loadsByKey.set(key, loads);
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>info</title><pre id="info"></pre><p id="loads">loads=${loads}</p><script>${INFO_SCRIPT}</script>`);
      return;
    }
    if (url.pathname === "/early") {
      res.end(`<!doctype html><title>early</title><p>early page</p><script>fetch('/e500');</script>`);
      return;
    }
    if (url.pathname === "/clean") {
      res.end(`<!doctype html><title>clean</title><p>clean page</p>`);
      return;
    }
    if (url.pathname === "/fail") {
      res.end(`<!doctype html><title>fail</title>
        <button id="go" onclick="Promise.all([fetch('/e500'), fetch('/e404')]).then(() => { document.getElementById('out').textContent = 'requests done'; })">Go</button>
        <p id="out"></p>`);
      return;
    }
    if (url.pathname === "/upload") {
      res.end(`<!doctype html><title>upload</title><input type="file" id="f" aria-label="Attachment"><p id="seen"></p>
        <script>document.getElementById('f').addEventListener('change', async (e) => {
          const f = e.target.files[0];
          document.getElementById('seen').textContent = 'seen:' + f.name + ':' + f.size + ':' + (await f.text());
        });</script>`);
      return;
    }
    res.end(`<!doctype html><title>home</title><p>home</p>`);
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  site = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => editorServer.close(() => r()));
  siteServer.closeAllConnections();
  await new Promise<void>((r) => siteServer.close(() => r()));
});

type Res = Record<string, any> & { error?: string };

function cmd(editor: Page, method: string, ...args: unknown[]): Promise<Res> {
  return editor.evaluate(
    ({ method, args }) =>
      ((window as any).penDesktop.browser[method] as (...a: unknown[]) => Promise<unknown>)(...args),
    { method, args },
  ) as Promise<Res>;
}

interface Env { app: ElectronApplication; editor: Page; tabbar: Page; site: Page }

async function launch(): Promise<Env> {
  const app = await launchShell({ args: ["."], env: { ...process.env, PEN_DESKTOP_URL: editorBaseUrl } });
  const editor = app.canvasPage;
  await expect(editor.locator("#ready")).toHaveText("stub-editor");
  const tabbar =
    app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
  // Record menus, never show them.
  await app.evaluate(({ Menu }) => {
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
  const [sitePage] = await Promise.all([
    app.waitForEvent("window", { predicate: (p) => p.url().startsWith(site) }),
    cmd(editor, "open", { url: `${site}/info?k=${Math.random().toString(36).slice(2)}` }),
  ]);
  return { app, editor, tabbar, site: sitePage };
}

/** Opens the tools menu through the tab bar's real IPC and returns it as plain data. */
async function openToolsMenu(env: Env) {
  const before = await env.app.evaluate(() => (globalThis as any).__menus.length as number);
  await env.tabbar.evaluate(() => (window as any).penTabbar.openToolsMenu({ x: 10, y: 10 }));
  await expect.poll(() => env.app.evaluate(() => (globalThis as any).__menus.length as number)).toBe(before + 1);
}

type Row = { label: string; checked: boolean; enabled: boolean; sub?: Row[] };
async function menuState(env: Env): Promise<Row[]> {
  return env.app.evaluate(() => {
    const m = (globalThis as any).__menus.at(-1);
    const row = (i: any): any => ({
      label: i.label, checked: i.checked, enabled: i.enabled,
      sub: i.submenu ? i.submenu.items.map(row) : undefined,
    });
    return m.items.map(row);
  });
}

/** Opens a fresh tools menu and clicks the item at `path` (labels, matched by prefix). */
async function clickMenu(env: Env, ...path: string[]) {
  await openToolsMenu(env);
  await env.app.evaluate((_e, path) => {
    let items = (globalThis as any).__menus.at(-1).items;
    for (let i = 0; i < path.length; i++) {
      const it = items.find((x: any) => x.label.startsWith(path[i]));
      if (!it) throw new Error(`menu item not found: ${path.slice(0, i + 1).join(" > ")}`);
      if (i === path.length - 1) { it.click(); return; }
      items = it.submenu.items;
    }
  }, path);
}

const viewportRadio = async (env: Env) => {
  const rows = await menuState(env);
  return rows.find((r) => r.label === "Viewport")!.sub!.filter((r) => r.checked).map((r) => r.label);
};

// A reload can destroy the context mid-evaluate: retry until a page answers.
const readInfo = async (p: Page) => {
  for (let i = 0; ; i++) {
    try {
      return await p.evaluate(() => JSON.parse(document.getElementById("info")!.textContent!));
    } catch (err) {
      if (i >= 20) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
};

test("Browser tools button exists right of the URL field and sends tabbar:tools-menu", async () => {
  const env = await launch();
  try {
    const order = await env.tabbar.evaluate(() => {
      const url = document.getElementById("url-input")!.getBoundingClientRect();
      const btn = document.getElementById("browser-tools")!.getBoundingClientRect();
      const row = document.getElementById("chrome-row")!.getBoundingClientRect();
      return { urlRight: url.right, btnLeft: btn.left, btnTop: btn.top, rowTop: row.top, rowBottom: row.bottom, btnBottom: btn.bottom, w: btn.width };
    });
    expect(order.btnLeft).toBeGreaterThanOrEqual(order.urlRight - 0.5);
    expect(order.btnTop).toBeGreaterThanOrEqual(order.rowTop);
    expect(order.btnBottom).toBeLessThanOrEqual(order.rowBottom + 0.5);
    expect(order.w).toBeGreaterThan(0);
    await expect(env.tabbar.locator("#browser-tools")).toBeVisible();

    // Spy on the IPC channel in main, then click the real button.
    await env.app.evaluate(({ ipcMain }) => {
      const g = globalThis as any;
      g.__toolsMenuMsgs = [];
      ipcMain.on("tabbar:tools-menu", (_e: unknown, a: unknown) => g.__toolsMenuMsgs.push(a));
    });
    const before = await env.app.evaluate(() => (globalThis as any).__menus.length as number);
    await env.tabbar.locator("#browser-tools").click();
    await expect.poll(() => env.app.evaluate(() => (globalThis as any).__toolsMenuMsgs.length as number)).toBe(1);
    const anchor = await env.app.evaluate(() => (globalThis as any).__toolsMenuMsgs[0]);
    expect(typeof anchor.x).toBe("number");
    await expect.poll(() => env.app.evaluate(() => (globalThis as any).__menus.length as number)).toBe(before + 1);
    const rows = await menuState(env);
    expect(rows.map((r) => r.label)).toEqual(["Viewport", "Open Developer Tools", "Zoom", "", "Show History"]);
  } finally {
    await env.app.close();
  }
});

test("Viewport menu: iphone-15 then responsive", async () => {
  const env = await launch();
  try {
    const baseline = await readInfo(env.site);
    expect(baseline.ua).not.toContain("iPhone");
    expect(baseline.brands).not.toBeNull();
    expect(baseline.brands.length).toBeGreaterThan(0);
    const viewWidth = baseline.w;
    expect(await viewportRadio(env).catch(() => null) ?? (await openToolsMenu(env), await viewportRadio(env))).toEqual(["Responsive (window size)"]);

    await clickMenu(env, "Viewport", "iPhone 15");
    // fitScale shrinks a preset that does not fit the view; innerWidth is the preset width regardless.
    await expect.poll(async () => (await readInfo(env.site)).ua).toContain("iPhone");
    const phone = await readInfo(env.site);
    expect(phone.w).toBe(393);
    expect(phone.mobile).toBe(true);
    // Reloaded: the server counted a second load of /info.
    expect(await env.site.locator("#loads").textContent()).toBe("loads=2");
    await openToolsMenu(env);
    expect(await viewportRadio(env)).toEqual(["iPhone 15 — 393×852"]);

    await clickMenu(env, "Viewport", "Responsive");
    await expect.poll(async () => (await readInfo(env.site)).ua).not.toContain("iPhone");
    const back = await readInfo(env.site);
    expect(back.w).toBe(viewWidth);
    expect(back.brands && back.brands.length).toBeGreaterThan(0);
    expect(back.mobile).toBe(false);
    expect(await env.site.locator("#loads").textContent()).toBe("loads=3");
    await openToolsMenu(env);
    expect(await viewportRadio(env)).toEqual(["Responsive (window size)"]);
  } finally {
    await env.app.close();
  }
});

test("DevTools next to the automation debugger: CDP commands keep working, and after closing", async () => {
  const env = await launch();
  const log: string[] = [];
  try {
    await cmd(env.editor, "open", { url: `${site}/fail` });
    const state = () =>
      env.app.evaluate(({ webContents }, siteUrl) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(siteUrl))!;
        return { devtools: wc.isDevToolsOpened(), dbg: wc.debugger.isAttached() };
      }, site);
    log.push(`before: ${JSON.stringify(await state())}`);
    expect((await state()).dbg).toBe(true);

    await clickMenu(env, "Open Developer Tools");
    await expect.poll(async () => (await state()).devtools).toBe(true);
    log.push(`devtools open: ${JSON.stringify(await state())}`);
    // The menu label flips.
    await openToolsMenu(env);
    expect((await menuState(env)).map((r) => r.label)).toContain("Close Developer Tools");

    const snap = await cmd(env.editor, "snapshot");
    expect(snap.error).toBeUndefined();
    const hover = await cmd(env.editor, "act", { action: "hover", target: "#go" });
    log.push(`hover: ${JSON.stringify(hover).slice(0, 200)}`);
    expect(hover.error).toBeUndefined();
    const press = await cmd(env.editor, "act", { action: "press", key: "Tab" });
    log.push(`press: ${JSON.stringify(press).slice(0, 200)}`);
    expect(press.error).toBeUndefined();
    const shot = await cmd(env.editor, "screenshot");
    expect(String(shot.imageData)).toMatch(/^data:image\//);
    const click = await cmd(env.editor, "act", { action: "click", target: "#go" });
    expect(click.error).toBeUndefined();
    // failedRequests diagnostics survive DevTools: the act result reports the 500/404.
    log.push(`click while devtools open: ${JSON.stringify(click.failedRequests)}`);
    expect(JSON.stringify(click.failedRequests ?? null)).toContain("/e500");
    // act drained them, so assert only sees what happens after: fire a failure from the page.
    await env.site.evaluate(() => { void fetch("/e500"); });
    await new Promise((r) => setTimeout(r, 300));
    const a = await cmd(env.editor, "assert", { checks: [{ type: "text", text: "requests done" }, { type: "no_failed_requests" }] });
    log.push(`assert while devtools open: ${JSON.stringify(a).slice(0, 400)}`);
    expect(a.error).toBeUndefined();
    expect(a.results[0].passed).toBe(true);
    expect(a.results[1].passed).toBe(false);
    expect(a.passed).toBe(false);

    await clickMenu(env, "Close Developer Tools");
    await expect.poll(async () => (await state()).devtools).toBe(false);
    log.push(`devtools closed: ${JSON.stringify(await state())}`);
    expect((await state()).dbg).toBe(true);

    const hover2 = await cmd(env.editor, "act", { action: "hover", target: "#go" });
    expect(hover2.error).toBeUndefined();
    const shot2 = await cmd(env.editor, "screenshot");
    expect(String(shot2.imageData)).toMatch(/^data:image\//);
    // drainFailedRequests getter is still there: a new failure is reported.
    const act2 = await cmd(env.editor, "act", { action: "click", target: "#go" });
    expect(act2.failedRequests?.length ?? 0).toBeGreaterThan(0);
    // Viewport items stay enabled (hasDebugger still true).
    await openToolsMenu(env);
    const vp = (await menuState(env)).find((r) => r.label === "Viewport")!.sub!;
    expect(vp.every((r) => r.enabled)).toBe(true);
  } finally {
    console.log("DEVTOOLS LOG\n" + log.join("\n"));
    await env.app.close();
  }
});

test("Zoom menu actions drive webContents.getZoomFactor", async () => {
  const env = await launch();
  try {
    const factor = () =>
      env.app.evaluate(({ webContents }, siteUrl) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(siteUrl))!.getZoomFactor(), site);
    expect(await factor()).toBeCloseTo(1, 5);
    await clickMenu(env, "Zoom", "Zoom In");
    expect(await factor()).toBeCloseTo(Math.pow(1.2, 0.5), 3);
    await clickMenu(env, "Zoom", "Zoom In");
    expect(await factor()).toBeCloseTo(1.2, 3);
    await clickMenu(env, "Zoom", "Zoom Out");
    await clickMenu(env, "Zoom", "Zoom Out");
    await clickMenu(env, "Zoom", "Zoom Out");
    expect(await factor()).toBeCloseTo(Math.pow(1.2, -0.5), 3);
    await clickMenu(env, "Zoom", "Actual Size");
    expect(await factor()).toBeCloseTo(1, 5);
    await clickMenu(env, "Zoom", "150%");
    expect(await factor()).toBeCloseTo(1.5, 3);
    await openToolsMenu(env);
    const zoom = (await menuState(env)).find((r) => r.label.startsWith("Zoom"))!.sub!;
    expect(zoom.filter((r) => r.checked).map((r) => r.label)).toEqual(["150%"]);
    await clickMenu(env, "Zoom", "Actual Size");
    expect(await factor()).toBeCloseTo(1, 5);
  } finally {
    await env.app.close();
  }
});

test("failedRequests and assert via the controller IPC; pre-run requests do not leak", async () => {
  const env = await launch();
  try {
    // A failure BEFORE the run: the early page fires a 500 on load.
    await cmd(env.editor, "open", { url: `${site}/early` });
    await expect(env.site.locator("p")).toHaveText("early page");
    await new Promise((r) => setTimeout(r, 500)); // let the 500 land in the buffer

    // applyFixture starts a run: it flushes the buffers first.
    const applied = await cmd(env.editor, "applyFixture", { version: 1, url: `${site}/fail` });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    const clean = await cmd(env.editor, "assert", { checks: [{ type: "no_failed_requests" }] });
    expect(clean.error).toBeUndefined();
    expect(clean.passed, JSON.stringify(clean)).toBe(true);
    expect(JSON.stringify(clean)).not.toContain("e500");

    const act = await cmd(env.editor, "act", { action: "click", target: "#go" });
    expect(act.error).toBeUndefined();
    const failed = JSON.stringify(act.failedRequests ?? null);
    expect(failed).toContain("/e500");
    expect(failed).toContain("/e404");

    // The click's result drained the buffer; a fresh failure after it is what assert reports.
    await env.site.evaluate(() => { void fetch("/e404"); });
    await new Promise((r) => setTimeout(r, 300));
    const a = await cmd(env.editor, "assert", { checks: [{ type: "text", text: "requests done" }, { type: "no_failed_requests" }] });
    expect(a.error).toBeUndefined();
    expect(a.passed).toBe(false);
    expect(a.results[0].passed).toBe(true);
    expect(a.results[1].passed).toBe(false);
    expect(JSON.stringify(a)).toContain("/e404");

    // ignore filters work through the same path.
    const ign = await cmd(env.editor, "assert", { checks: [{ type: "no_failed_requests", ignore: ["/e500", "/e404"] }] });
    expect(ign.error).toBeUndefined();
    await cmd(env.editor, "releaseFixture");
  } finally {
    await env.app.close();
  }
});

test("fixture emulate iphone-15: width, screenshot aspect, release clears and resets the menu record only when set by the fixture", async () => {
  const env = await launch();
  try {
    const baseW = (await readInfo(env.site)).w;
    // User picks Pixel 8 first, then a fixture emulates iPhone: the record resets on release.
    await clickMenu(env, "Viewport", "Pixel 8");
    await expect.poll(async () => (await readInfo(env.site)).w).toBe(412);

    const applied = await cmd(env.editor, "applyFixture", { version: 1, url: `${site}/info`, emulate: { device: "iphone-15" } });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    await expect.poll(async () => (await readInfo(env.site)).w).toBe(393);
    const info = await readInfo(env.site);
    expect(info.ua).toContain("iPhone");
    // iOS presets send no UA Client Hints metadata (real Safari has none), so
    // navigator.userAgentData reports no brands here. Android presets carry full metadata.

    const shot = await cmd(env.editor, "screenshot");
    // An emulated screenshot is a data URL, like the plain capture (browser-agent 0.2.22).
    const raw = String(shot.imageData);
    expect(raw.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(shot.width / shot.height).toBeCloseTo(393 / 852, 2);
    const dims = await env.editor.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    }, raw);
    expect(Math.abs(dims.w / dims.h - 393 / 852)).toBeLessThan(0.02);

    // By design the record is reset on RELEASE (agentEmulation.release), not on apply: while the
    // fixture is active the radio still shows the user's earlier pick, although the page is the iPhone.
    await openToolsMenu(env);
    expect(await viewportRadio(env)).toEqual(["Pixel 8 — 412×915"]);

    await cmd(env.editor, "releaseFixture");
    await openToolsMenu(env);
    expect(await viewportRadio(env)).toEqual(["Responsive (window size)"]);
    await cmd(env.editor, "open", { url: `${site}/info` });
    await expect.poll(async () => (await readInfo(env.site)).ua).not.toContain("iPhone");
    expect((await readInfo(env.site)).w).toBe(baseW);

    // A colour-scheme-only fixture never touches the menu's record.
    await clickMenu(env, "Viewport", "Desktop — 1440");
    // The 1440 preset is wider than the tab area (the agent panel takes the left side), so it is scaled to fit.
    // Observed: the scale is visual only, innerWidth stays at the tab area's width (within a few px of the base width).
    await expect.poll(async () => Math.abs((await readInfo(env.site)).w - baseW)).toBeLessThanOrEqual(3);
    const applied2 = await cmd(env.editor, "applyFixture", { version: 1, url: `${site}/info`, emulate: { colorScheme: "dark" } });
    expect(applied2.ok, JSON.stringify(applied2)).toBe(true);
    await cmd(env.editor, "releaseFixture");
    await openToolsMenu(env);
    expect(await viewportRadio(env)).toEqual(["Desktop — 1440×900"]);
    expect(Math.abs((await readInfo(env.site)).w - 1440)).toBeLessThanOrEqual(3);
  } finally {
    await env.app.close();
  }
});

test("act viewport: iphone-15, custom, clearActEmulation restores width and UA; the menu record resets", async () => {
  const env = await launch();
  try {
    const base = await readInfo(env.site);
    // The user picks Pixel 8 first; the agent then changes the device itself.
    await clickMenu(env, "Viewport", "Pixel 8");
    await expect.poll(async () => (await readInfo(env.site)).w).toBe(412);

    const iphone = await cmd(env.editor, "act", { action: "viewport", device: "iphone-15" });
    expect(iphone.error, JSON.stringify(iphone)).toBeUndefined();
    await expect.poll(async () => (await readInfo(env.site)).w).toBe(393);
    expect((await readInfo(env.site)).ua).toContain("iPhone");

    const custom = await cmd(env.editor, "act", { action: "viewport", device: "custom", width: 800, height: 600 });
    expect(custom.error, JSON.stringify(custom)).toBeUndefined();
    await expect.poll(async () => (await readInfo(env.site)).w).toBe(800);

    // Until the clear, the radio still shows the user's earlier pick (reset on clear, like a fixture).
    await openToolsMenu(env);
    expect(await viewportRadio(env)).toEqual(["Pixel 8 — 412×915"]);

    expect(await cmd(env.editor, "clearActEmulation")).toEqual({ ok: true });
    await openToolsMenu(env);
    expect(await viewportRadio(env)).toEqual(["Responsive (window size)"]);
    await cmd(env.editor, "open", { url: `${site}/info` });
    await expect.poll(async () => (await readInfo(env.site)).ua).not.toContain("iPhone");
    expect((await readInfo(env.site)).w).toBe(base.w);
    expect((await readInfo(env.site)).ua).toBe(base.ua);

    // A second clear is a no-op.
    expect(await cmd(env.editor, "clearActEmulation")).toEqual({ ok: true });
  } finally {
    await env.app.close();
  }
});

test("act viewport in an isolated session: emulate, clearActEmulation, and a missing session answers {ok:true}", async () => {
  const env = await launch();
  try {
    const iso = (method: string, ...args: unknown[]) =>
      env.editor.evaluate(
        ({ method, args }) =>
          (((window as any).penDesktop.browser.isolated("qa-act") as Record<string, (...a: unknown[]) => Promise<unknown>>)[method])(...args),
        { method, args },
      ) as Promise<Res>;
    const info = async () => {
      const r = await iso("read");
      const m = /\{"w":[^\n]*\}/.exec(String(r.text ?? ""));
      return JSON.parse(m![0]) as { w: number; ua: string };
    };
    expect(await iso("clearActEmulation")).toEqual({ ok: true }); // no session yet
    const opened = await iso("open", { url: `${site}/info?k=iso` });
    expect(opened.error, JSON.stringify(opened)).toBeUndefined();
    const base = await info();
    const r = await iso("act", { action: "viewport", device: "iphone-15" });
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    await iso("open", { url: `${site}/info?k=iso2` });
    await expect.poll(async () => (await info()).w).toBe(393);
    expect(await iso("clearActEmulation")).toEqual({ ok: true });
    await iso("open", { url: `${site}/info?k=iso3` });
    await expect.poll(async () => (await info()).ua).toBe(base.ua);
    expect((await info()).w).toBe(base.w);
    await env.editor.evaluate(() => (window as any).penDesktop.browser.closeSession("qa-act"));
  } finally {
    await env.app.close();
  }
});

test("act upload sets the file on a file input", async () => {
  const env = await launch();
  try {
    await cmd(env.editor, "open", { url: `${site}/upload` });
    const r = await cmd(env.editor, "act", { action: "upload", target: "#f", files: [{ name: "hello.txt", text: "hi there" }] });
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    expect(r.uploaded).toBeTruthy();
    await expect(env.site.locator("#seen")).toHaveText("seen:hello.txt:8:hi there");
  } finally {
    await env.app.close();
  }
});
