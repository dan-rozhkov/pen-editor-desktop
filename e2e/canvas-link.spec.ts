import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Canvas link (docs/canvas-link.md) over real IPC: the agent panel lists and
// drives canvas tabs, the tab replies, openTab resolves after the new tab
// registers, a closed, reloaded or unregistered tab yields tab-gone; the panel's own
// penAgentPanel.browser drives the built-in browser. Stub pages only.

let server: http.Server;
let baseUrl: string;

// The stub canvas tab registers like the real chatless editor does and answers
// every `ping` with a `result` carrying the same callId.
const EDITOR_PAGE = `<!doctype html><title>Stub Editor</title><h1 id="ready">stub-editor</h1>
<script>
  window.__got = [];
  const host = window.penDesktop && window.penDesktop.canvasHost;
  if (host) {
    host.onMessage((env) => {
      window.__got.push(env);
      if (env.msg.kind === 'ping') host.post({ id: 'reply-' + env.id, sentAt: Date.now(), msg: { kind: 'result', callId: env.id, result: 'pong' } });
    });
    host.register();
  }
</script>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const url = req.url ?? "/";
    if (url.startsWith("/agent")) res.end(`<!doctype html><title>Stub Agent</title><h1 id="ready">stub-agent</h1>`);
    else if (url.startsWith("/site")) res.end(`<!doctype html><title>Site</title><p id="x">hello from the panel browser</p>`);
    else res.end(EDITOR_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

type Env = { id: string; sentAt: number; msg: { kind: string; [k: string]: unknown } };
type Panel = {
  canvas: {
    listTabs(): Promise<{ tabId: number; registrationId: number; title: string; active: boolean }[]>;
    openTab(o?: { activate?: boolean }): Promise<{ tabId: number; registrationId: number }>;
    activateTab(id: number): void;
    post(id: number, env: Env): void;
    onMessage(cb: (tabId: number, env: Env) => void): () => void;
    onTabsChanged(cb: (tabs: unknown[]) => void): () => void;
  };
  browser: Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>>;
};

async function launch(): Promise<{ app: ElectronApplication; panel: Page; editor: Page; tabbar: Page }> {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: `${baseUrl}/app`, PEN_DESKTOP_AGENT_LAYOUT: "1" },
  });
  const find = async (pred: (u: string) => boolean) =>
    app.windows().find((p) => pred(p.url())) ?? (await app.waitForEvent("window", { predicate: (p) => pred(p.url()) }));
  const panel = await find((u) => u.startsWith(`${baseUrl}/agent`));
  // Empty start: the window opens with the panel only. Open the canvas tab explicitly;
  // Promise.all makes an early openTab rejection fail the test with its own error.
  const [, editor, tabbar] = await Promise.all([
    panel.evaluate(() => (window as never as { penAgentPanel: Panel }).penAgentPanel.canvas.openTab({ activate: true })),
    find((u) => u.startsWith(`${baseUrl}/app`)),
    find((u) => u.endsWith("/tabbar/tabbar.html")),
  ]);
  await expect(panel.locator("#ready")).toHaveText("stub-agent");
  await expect(editor.locator("#ready")).toHaveText("stub-editor");
  // Collect everything the panel hears.
  await panel.evaluate(() => {
    const w = window as never as { penAgentPanel: Panel; __msgs: unknown[]; __tabs: unknown[] };
    w.__msgs = [];
    w.__tabs = [];
    w.penAgentPanel.canvas.onMessage((tabId, env) => w.__msgs.push({ tabId, env }));
    w.penAgentPanel.canvas.onTabsChanged((t) => w.__tabs.push(t));
  });
  return { app, panel, editor, tabbar };
}

const list = (panel: Page) => panel.evaluate(() => (window as never as { penAgentPanel: Panel }).penAgentPanel.canvas.listTabs());
const msgs = (panel: Page) => panel.evaluate(() => (window as never as { __msgs: { tabId: number; env: Env }[] }).__msgs);

test("panel lists the canvas tab, posts to it, gets the reply with the tabId; reload and close yield tab-gone", async () => {
  const { app, panel, editor, tabbar } = await launch();
  try {
    await expect.poll(async () => (await list(panel)).length).toBe(1);
    const [tab] = await list(panel);
    expect(tab.registrationId).toBe(1);
    expect(tab.active).toBe(true);

    // panel -> tab -> panel
    await panel.evaluate(
      (id) => (window as never as { penAgentPanel: Panel }).penAgentPanel.canvas.post(id, { id: "m1", sentAt: Date.now(), msg: { kind: "ping" } }),
      tab.tabId,
    );
    await expect.poll(() => editor.evaluate(() => (window as never as { __got: Env[] }).__got.map((e) => e.id))).toEqual(["m1"]);
    await expect.poll(async () => (await msgs(panel)).map((m) => [m.tabId, m.env.id, m.env.msg.kind])).toEqual([[tab.tabId, "reply-m1", "result"]]);

    // unknown tab -> error back to the panel
    await panel.evaluate(() => (window as never as { penAgentPanel: Panel }).penAgentPanel.canvas.post(424242, { id: "m2", sentAt: Date.now(), msg: { kind: "ping" } }));
    await expect.poll(async () => (await msgs(panel)).map((m) => m.env.msg.kind)).toEqual(["result", "error"]);
    expect((await msgs(panel))[1].env.msg.refId).toBe("m2");

    // openTab resolves once the new tab registered
    const opened = await panel.evaluate(() => (window as never as { penAgentPanel: Panel }).penAgentPanel.canvas.openTab({ activate: true }));
    expect(opened.registrationId).toBe(1);
    const tabs2 = await list(panel);
    expect(tabs2).toHaveLength(2);
    // canvas:tabs was pushed for the registration (listener attached before openTab)
    await expect.poll(() => panel.evaluate(() => (window as never as { __tabs: unknown[][] }).__tabs.at(-1)?.length)).toBe(2);
    expect(tabs2[0]).toMatchObject({ tabId: opened.tabId, active: true }); // most recently active first
    expect(tabs2[1].tabId).toBe(tab.tabId);

    // activateTab brings the first tab back to the front
    await panel.evaluate((id) => (window as never as { penAgentPanel: Panel }).penAgentPanel.canvas.activateTab(id), tab.tabId);
    await expect.poll(async () => (await list(panel))[0].tabId).toBe(tab.tabId);

    // Closing the new tab: tab-gone for its registration, list shrinks
    await expect(tabbar.locator(".tab")).toHaveCount(2);
    await tabbar.locator(".tab").nth(1).locator(".close").evaluate((el) => (el as HTMLElement).click());
    await expect
      .poll(async () => (await msgs(panel)).filter((m) => m.env.msg.kind === "tab-gone").map((m) => [m.tabId, m.env.msg.registrationId]))
      .toEqual([[opened.tabId, 1]]);
    await expect.poll(async () => (await list(panel)).map((t) => t.tabId)).toEqual([tab.tabId]);

    // Reloading the first tab: tab-gone for registration 1, then it registers again as 2
    await editor.reload();
    await expect.poll(async () => (await list(panel)).map((t) => [t.tabId, t.registrationId])).toEqual([[tab.tabId, 2]]);
    expect((await msgs(panel)).filter((m) => m.env.msg.kind === "tab-gone").map((m) => [m.tabId, m.env.msg.registrationId])).toContainEqual([tab.tabId, 1]);
  } finally {
    await app.close();
  }
});

test("openTab({activate:false}) keeps the current tab active", async () => {
  const { app, panel } = await launch();
  try {
    await expect.poll(async () => (await list(panel)).length).toBe(1);
    const [first] = await list(panel);
    const opened = await panel.evaluate(() => (window as never as { penAgentPanel: Panel }).penAgentPanel.canvas.openTab());
    const after = await list(panel);
    expect(after.find((t) => t.active)?.tabId).toBe(first.tabId);
    expect(after.map((t) => t.tabId)).toContain(opened.tabId);
  } finally {
    await app.close();
  }
});

test("the panel's penAgentPanel.browser opens a page and reads it, shared and isolated", async () => {
  const { app, panel } = await launch();
  try {
    const call = (session: string | null, method: string, ...args: unknown[]) =>
      panel.evaluate(
        ({ session, method, args }) => {
          const b = (window as never as { penAgentPanel: { browser: Record<string, any> } }).penAgentPanel.browser;
          return (session === null ? b : b.isolated(session))[method](...args);
        },
        { session, method, args },
      ) as Promise<{ error?: string; text?: string }>;
    const opened = await call(null, "open", { url: `${baseUrl}/site` });
    expect(opened.error).toBeUndefined();
    expect((await call(null, "read")).text).toContain("hello from the panel browser");

    const iso = await call("panel-iso", "open", { url: `${baseUrl}/site` });
    expect(iso.error).toBeUndefined();
    expect((await call("panel-iso", "read")).text).toContain("hello from the panel browser");
    expect(await panel.evaluate(() => (window as never as { penAgentPanel: { browser: { closeSession(id: string): Promise<unknown> } } }).penAgentPanel.browser.closeSession("panel-iso"))).toEqual({ ok: true });
  } finally {
    await app.close();
  }
});

test("canvasHost.unregister() yields tab-gone and drops the tab from the list; register() brings it back as the next registration", async () => {
  const { app, panel, editor } = await launch();
  try {
    await expect.poll(async () => (await list(panel)).length).toBe(1);
    const [tab] = await list(panel);
    await editor.evaluate(() => (window as never as { penDesktop: { canvasHost: { unregister(): void } } }).penDesktop.canvasHost.unregister());
    await expect
      .poll(async () => (await msgs(panel)).filter((m) => m.env.msg.kind === "tab-gone").map((m) => [m.tabId, m.env.msg.registrationId]))
      .toEqual([[tab.tabId, 1]]);
    await expect.poll(async () => (await list(panel)).length).toBe(0);
    await editor.evaluate(() => (window as never as { penDesktop: { canvasHost: { register(): void } } }).penDesktop.canvasHost.register());
    await expect.poll(async () => (await list(panel)).map((t) => [t.tabId, t.registrationId])).toEqual([[tab.tabId, 2]]);
  } finally {
    await app.close();
  }
});

test("a panel navigation the policy denies does not close the panel's isolated sessions", async () => {
  const { app, panel } = await launch();
  try {
    const iso = (method: string, ...args: unknown[]) =>
      panel.evaluate(
        ({ method, args }) =>
          (window as never as { penAgentPanel: { browser: { isolated(id: string): Record<string, (...a: unknown[]) => Promise<unknown>> } } }).penAgentPanel.browser.isolated("deny-iso")[method](...args),
        { method, args },
      ) as Promise<{ error?: string; text?: string }>;
    expect((await iso("open", { url: `${baseUrl}/site` })).error).toBeUndefined();
    // A scheme the policy denies: will-navigate is prevented, nothing commits.
    await panel.evaluate(() => {
      location.href = "data:text/html,denied";
    });
    await panel.waitForTimeout(800);
    await expect(panel.locator("#ready")).toHaveText("stub-agent");
    const after = await iso("read");
    expect(after.error).toBeUndefined();
    expect(after.text).toContain("hello from the panel browser");
  } finally {
    await app.close();
  }
});
