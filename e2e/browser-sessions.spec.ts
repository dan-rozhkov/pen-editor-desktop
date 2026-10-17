// Isolated browser sessions (docs/superpowers/specs/2026-10-17-isolated-parallel-browse-design.md),
// end to end over real IPC: window.penDesktop.browser.isolated(id) -> main ->
// a private partition + its own BrowserController. Stub servers on localhost
// only, no backend, no LLM.

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

let editorServer: http.Server;
let siteServer: http.Server;
let editorBaseUrl: string;
let site: string;

test.beforeAll(async () => {
  editorServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>if (window.penDesktop) { window.penDesktop.setDocumentTitle('Stub'); }</script>`);
  });
  await new Promise<void>((resolve) => editorServer.listen(0, "127.0.0.1", resolve));
  editorBaseUrl = `http://127.0.0.1:${(editorServer.address() as AddressInfo).port}`;

  siteServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/hello") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ msg: "real" }));
      return;
    }
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/set") {
      res.setHeader("set-cookie", `who=${url.searchParams.get("v") ?? ""}; Path=/`);
      res.end("<!doctype html><title>set</title><p>cookie set</p>");
      return;
    }
    if (url.pathname === "/pop") {
      res.end(`<!doctype html><title>pop</title><a id="p" target="_blank" href="/me">pop</a>`);
      return;
    }
    // /me: the cookie header as the server saw it, and the API answer the page fetched.
    res.end(`<!doctype html><title>me</title>
      <p id="cookie">cookie=[${req.headers.cookie ?? ""}]</p><p id="api">api=pending</p>
      <script>fetch('/api/hello').then(r => r.json()).then(j => { document.getElementById('api').textContent = 'api=' + j.msg; });</script>`);
  });
  await new Promise<void>((resolve) => siteServer.listen(0, "127.0.0.1", resolve));
  site = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => editorServer.close(() => r()));
  siteServer.closeAllConnections();
  await new Promise<void>((r) => siteServer.close(() => r()));
});

type Res = Record<string, unknown> & { error?: string; ok?: boolean; text?: string; tabs?: { tabId: number; url: string }[] };

/** Runs `penDesktop.browser[.isolated(session)].method(...args)` in the editor page. */
function call(page: Page, session: string | null, method: string, ...args: unknown[]): Promise<Res> {
  return page.evaluate(
    ({ session, method, args }) => {
      const b = (window as unknown as { penDesktop: { browser: Record<string, unknown> & { isolated(id: string): Record<string, unknown> } } })
        .penDesktop.browser;
      const target = session === null ? b : b.isolated(session);
      return (target[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    { session, method, args },
  ) as Promise<Res>;
}

const closeSession = (page: Page, id: string): Promise<Res> =>
  page.evaluate((id) => (window as unknown as { penDesktop: { browser: { closeSession(id: string): Promise<unknown> } } }).penDesktop.browser.closeSession(id), id) as Promise<Res>;

const livePages = (app: ElectronApplication) => app.windows().filter((p) => !p.isClosed());
const pagesAt = (app: ElectronApplication, prefix: string) => livePages(app).filter((p) => p.url().startsWith(prefix));

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; editor: Page }> {
  const app = await electron.launch({ args: ["."], env: { ...process.env, PEN_DESKTOP_URL: editorBaseUrl, ...env } });
  const editor = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(editorBaseUrl) });
  await expect(editor.locator("#ready")).toHaveText("stub-editor");
  return { app, editor };
}

test("two parallel isolated sessions keep separate cookies, network mocks and tabs; the shared browser sees neither", async () => {
  const { app, editor } = await launch();
  try {
    // --- parallel start: both sessions set a different cookie on the SAME origin ---
    const [setA, setB] = await Promise.all([
      call(editor, "A", "open", { url: `${site}/set?v=alpha` }),
      call(editor, "B", "open", { url: `${site}/set?v=beta` }),
    ]);
    expect(setA.error).toBeUndefined();
    expect(setB.error).toBeUndefined();

    // --- session tabs open in the background: the editor stays the visible view ---
    const views = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()
        .flatMap((w) => w.contentView.children)
        .flatMap((v) => ("webContents" in v ? [{ url: (v as unknown as { webContents: { getURL(): string } }).webContents.getURL(), visible: v.getVisible() }] : [])),
    );
    expect(views.filter((v) => v.url.startsWith(`${site}/set`)).map((v) => v.visible)).toEqual([false, false]);
    expect(views.find((v) => v.url.startsWith(editorBaseUrl))?.visible).toBe(true);

    const [meA, meB] = await Promise.all([
      call(editor, "A", "open", { url: `${site}/me` }),
      call(editor, "B", "open", { url: `${site}/me` }),
    ]);
    expect(meA.error).toBeUndefined();
    expect(meB.error).toBeUndefined();
    const [textA, textB] = await Promise.all([call(editor, "A", "read"), call(editor, "B", "read")]);
    expect(textA.text).toContain("cookie=[who=alpha]");
    expect(textB.text).toContain("cookie=[who=beta]");

    // --- the shared browser has no tab and no cookie from them ---
    const sharedList = await call(editor, null, "tabs", { action: "list" });
    expect(JSON.stringify(sharedList)).not.toContain(site);
    const sharedOpen = await call(editor, null, "open", { url: `${site}/me` });
    expect(sharedOpen.error).toBeUndefined();
    const sharedText = await call(editor, null, "read");
    expect(sharedText.text).toContain("cookie=[]");

    // --- a session lists only its own tabs ---
    const listA = await call(editor, "A", "tabs", { action: "list" });
    const listB = await call(editor, "B", "tabs", { action: "list" });
    const sharedList2 = await call(editor, null, "tabs", { action: "list" });
    expect(listA.tabs).toHaveLength(1);
    expect(listB.tabs).toHaveLength(1);
    expect(sharedList2.tabs).toHaveLength(1);
    const idA = listA.tabs![0].tabId;
    const idB = listB.tabs![0].tabId;
    const idShared = sharedList2.tabs![0].tabId;
    expect(new Set([idA, idB, idShared]).size).toBe(3);

    // --- no cross-driving: the shared bridge and the sessions cannot switch to / close each other's tabs ---
    for (const [session, foreign] of [[null, idA], ["A", idB], ["B", idShared], ["A", idShared]] as const) {
      const sw = await call(editor, session, "tabs", { action: "switch", tabId: foreign });
      expect(JSON.stringify(sw), `${session} switch to ${foreign}`).toMatch(/error|not found|no tab|unknown/i);
      const cl = await call(editor, session, "tabs", { action: "close", tabId: foreign });
      expect(JSON.stringify(cl), `${session} close ${foreign}`).toMatch(/error|not found|no tab|unknown/i);
    }
    // Still alive afterwards.
    expect(pagesAt(app, `${site}/me`).length).toBe(3);

    // --- a network mock in A does not touch B (same URL, same origin) ---
    const fixture = { version: 1, network: [{ url: `${site}/api/hello`, body: { msg: "mocked" } }] };
    const applied = await call(editor, "A", "applyFixture", fixture);
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    await Promise.all([call(editor, "A", "open", { url: `${site}/me` }), call(editor, "B", "open", { url: `${site}/me` })]);
    await expect.poll(async () => (await call(editor, "A", "read")).text ?? "").toContain("api=mocked");
    await expect.poll(async () => (await call(editor, "B", "read")).text ?? "").toContain("api=real");
    // The shared browser is not mocked either.
    await call(editor, null, "open", { url: `${site}/me` });
    await expect.poll(async () => (await call(editor, null, "read")).text ?? "").toContain("api=real");
    // Releasing A's mocks lets A through again.
    await call(editor, "A", "releaseFixture");
    await call(editor, "A", "open", { url: `${site}/me` });
    await expect.poll(async () => (await call(editor, "A", "read")).text ?? "").toContain("api=real");

    // --- a screenshot of a session tab works while another tab is the visible one ---
    const shotA = await call(editor, "A", "screenshot");
    if (process.platform === "linux") {
      // Linux (xvfb CI) does not paint a never-shown view: the screenshot
      // degrades to the controller's error instead of an image. The app
      // ships for macOS, where the capture works (asserted below).
      expect(shotA.error).toBe("Screenshot capture failed (empty image).");
    } else {
      expect(String(shotA.imageData)).toMatch(/^data:image\/jpeg;base64,/);
    }

    // --- saved logins are not available in a session ---
    const login = await call(editor, "A", "fillLogin", {});
    expect(login).toEqual({ ok: false, error: "saved logins are not available in an isolated session" });

    // --- closeSession closes that session's tabs and wipes its cookies ---
    const before = pagesAt(app, `${site}/me`).length;
    expect(await closeSession(editor, "A")).toEqual({ ok: true });
    await expect.poll(() => pagesAt(app, `${site}/me`).length).toBe(before - 1);
    expect(await closeSession(editor, "A")).toEqual({ ok: true }); // idempotent
    // B and the shared browser are untouched.
    expect((await call(editor, "B", "read")).text).toContain("cookie=[who=beta]");
    // A closed id is never recreated: every later command is refused.
    expect(await call(editor, "A", "open", { url: `${site}/me` })).toEqual({ error: "browser session closed" });
    expect(await call(editor, "A", "snapshot")).toEqual({ error: "browser session closed" });
    expect(await call(editor, "A", "releaseFixture")).toEqual({ ok: true });
    // A session that was never created answers with a fixed error, and only
    // page-creating commands create one.
    expect(await call(editor, "never", "snapshot")).toEqual({ error: "no such browser session" });
    expect(await call(editor, "never", "tabs", { action: "list" })).toEqual({ error: "no such browser session" });
    expect(await call(editor, "never", "act", { action: "click", target: "#x" })).toEqual({ error: "no such browser session" });
    expect((await call(editor, "never", "tabs", { action: "new", url: `${site}/me` })).error).toBeUndefined();
    expect(((await call(editor, "never", "tabs", { action: "list" })).tabs ?? []).length).toBe(1);
  } finally {
    await app.close();
  }
});

test("a popup of a session tab stays in that session", async () => {
  const { app, editor } = await launch();
  try {
    await call(editor, "P", "open", { url: `${site}/pop` });
    await call(editor, null, "open", { url: `${site}/pop` });
    const act = await call(editor, "P", "act", { action: "click", target: "#p" });
    expect(act.error).toBeUndefined();
    await expect.poll(async () => ((await call(editor, "P", "tabs", { action: "list" })).tabs ?? []).length).toBe(2);
    expect(((await call(editor, null, "tabs", { action: "list" })).tabs ?? []).length).toBe(1);
    // The popup LOADED in its own tab: the editor and the shared tab are untouched.
    await expect.poll(() => pagesAt(app, `${site}/me`).length).toBe(1);
    expect(editor.url().startsWith(editorBaseUrl)).toBe(true);
    expect(pagesAt(app, `${site}/pop`).length).toBe(2);
    const sharedUrls = ((await call(editor, null, "tabs", { action: "list" })).tabs ?? []).map((t) => t.url);
    expect(sharedUrls).toEqual([`${site}/pop`]);

    // `tabs switch` in a session repoints only its agent tab: nothing is activated.
    const list = (await call(editor, "P", "tabs", { action: "list" })).tabs as { tabId: number; url: string; current?: boolean }[];
    const other = list.find((t) => !t.current)!;
    expect((await call(editor, "P", "tabs", { action: "switch", tabId: other.tabId })).error).toBeUndefined();
    const views = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()
        .flatMap((w) => w.contentView.children)
        .flatMap((v) => ("webContents" in v ? [{ url: (v as unknown as { webContents: { getURL(): string } }).webContents.getURL(), visible: v.getVisible() }] : [])),
    );
    // Only the shared tab (it activated when opened) is visible: the editor lost
    // the foreground to it, never to a session tab.
    expect(views.filter((v) => v.url.startsWith(site)).filter((v) => v.visible)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("invalid session ids are rejected; the pool has 6 slots: a 7th command waits, then errors or takes a freed, wiped slot", async () => {
  const { app, editor } = await launch({ PEN_DESKTOP_SESSION_SLOT_WAIT_MS: "800" });
  try {
    for (const bad of ["", "a b", "../x", "x".repeat(65)]) {
      expect(await call(editor, bad, "snapshot"), JSON.stringify(bad)).toEqual({ error: "invalid session id" });
    }
    expect(await closeSession(editor, "a.b")).toEqual({ error: "invalid session id" });
    // An absent id must not fall back to the shared browser.
    const undef = await editor.evaluate(() =>
      (window as unknown as { penDesktop: { browser: { isolated(id: unknown): { snapshot(): Promise<unknown> } } } }).penDesktop.browser.isolated(undefined).snapshot(),
    );
    expect(undef).toEqual({ error: "invalid session id" });

    // s0 leaves a cookie behind in its partition.
    expect((await call(editor, "s0", "open", { url: `${site}/set?v=leftover` })).error).toBeUndefined();
    for (let i = 1; i < 6; i++) {
      const r = await call(editor, `s${i}`, "open", { url: `${site}/me` });
      expect(r.error, `session s${i}`).toBeUndefined();
    }
    // No free slot: the 7th waits for the whole wait, then errors.
    const t0 = Date.now();
    expect(await call(editor, "s6", "open", { url: `${site}/me` })).toEqual({ error: "too many parallel browser sessions" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    // An existing session still works at the cap.
    expect((await call(editor, "s1", "read")).error).toBeUndefined();

    // A waiting command takes the slot the moment a session closes, and the slot is wiped.
    const waiting = call(editor, "s7", "open", { url: `${site}/me` });
    await new Promise((r) => setTimeout(r, 200));
    expect(await closeSession(editor, "s0")).toEqual({ ok: true });
    expect((await waiting).error).toBeUndefined();
    expect((await call(editor, "s7", "read")).text).toContain("cookie=[]");
    for (let i = 1; i <= 7; i++) await closeSession(editor, `s${i}`);
    await expect.poll(() => pagesAt(app, `${site}/me`).length).toBe(0);
  } finally {
    await app.close();
  }
});

test("reloading the owner editor tab closes its sessions (orphans)", async () => {
  const { app, editor } = await launch();
  try {
    for (const id of ["o1", "o2"]) await call(editor, id, "open", { url: `${site}/set?v=${id}` });
    expect(pagesAt(app, `${site}/set`).length).toBe(2);

    await editor.reload();
    await expect(editor.locator("#ready")).toHaveText("stub-editor");
    await expect.poll(() => pagesAt(app, `${site}/set`).length).toBe(0);

    // Slots are free again and the old cookie is gone: all six sessions open, and a reused id is empty.
    for (let i = 0; i < 6; i++) {
      const r = await call(editor, `n${i}`, "open", { url: `${site}/me` });
      expect(r.error, `session ${i}`).toBeUndefined();
    }
    for (let i = 0; i < 6; i++) expect((await call(editor, `n${i}`, "read")).text).toContain("cookie=[]");
    // The orphaned ids are closed for good.
    expect(await call(editor, "o1", "snapshot")).toEqual({ error: "browser session closed" });
  } finally {
    await app.close();
  }
});
