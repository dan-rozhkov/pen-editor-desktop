// End-to-end proof of the product claim: a user installs the .app and the
// pen-editor-plugin, and their agent can drive the editor — no terminal, no
// tokens, no local backend. Everything here goes over real HTTP against the
// real loopback server this app's main process starts, exactly like a real
// MCP client would, plus (bonus) the real zero-dependency plugin proxy
// talking to it with zero configuration.
//
// HOME redirection is mandatory: a developer's pen-editor-backend may be
// running right now and owns the real ~/.pen-editor/mcp.json. This suite
// must never read or write it — every Electron launch below gets its own
// throwaway HOME so `os.homedir()` inside the app process can never resolve
// to this machine's real home directory.

import { test, expect, _electron as electron } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

let server: http.Server;
let baseUrl: string;

// The canned get_editor_state payload the stub page's registerMcpBridge
// handler answers with — a distinctive marker so the assertions below can
// prove a tools/call round-tripped through real HTTP -> main -> IPC ->
// this stub renderer -> IPC -> main -> HTTP, not something main fabricated
// itself.
const CANNED_MARKER = "stub-canned-payload-9f3a";
const CANNED_EDITOR_STATE = {
  pages: [{ id: "stub-page", name: "Page 1" }],
  activePageId: "stub-page",
  roots: [],
  selectedIds: [],
  selectedNodes: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  fileName: "Launch Deck.pen",
  marker: CANNED_MARKER,
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    // Findings 1 & 4 regression fixture: a page with no registerMcpBridge
    // call at all — stands in for a real cross-document navigation away
    // from the editor (which drops the bridge registration), as opposed to
    // pushState/replaceState (same-document, must NOT drop it).
    if (req.url && req.url.startsWith("/bare")) {
      res.end(`<!doctype html><title>Bare</title><h1 id="ready">stub-bare</h1>`);
      return;
    }
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>
        window.__commands = [];
        window.__mcpCalls = [];
        if (window.penDesktop) {
          window.penDesktop.onMenuCommand((id) => window.__commands.push(id));
          window.penDesktop.setDocumentTitle('Launch Deck');
          // Stands in for the deployed bundle's desktopMcpBridge.ts —
          // registers this tab as the desktop bridge's call target, exactly
          // like the real page does on window.penDesktop.registerMcpBridge.
          if (window.penDesktop.registerMcpBridge) {
            window.penDesktop.registerMcpBridge({
              protocol: 1,
              tools: ["get_editor_state"],
              onCall: async (name, args) => {
                window.__mcpCalls.push({ name, args });
                if (name === "get_editor_state") {
                  return JSON.stringify(${JSON.stringify(CANNED_EDITOR_STATE)});
                }
                // Matches the real page's executeToolCall contract: never
                // reject, resolve with a JSON {"error"} string instead.
                return JSON.stringify({ error: "Unknown tool: " + name });
              },
            });
          }
        }
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("desktop MCP bridge: install-the-.app-and-the-plugin claim, end to end", async ({}, testInfo) => {
  // Playwright-managed temp dir (cleaned up with the rest of the test's
  // output), never the real $HOME.
  const home = testInfo.outputPath("home");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl, HOME: home, USERPROFILE: home },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const handshakePath = path.join(home, ".pen-editor", "mcp.json");

    // The service publishes on app.whenReady(), before the first window is
    // even created — but poll rather than assume it has already landed by
    // the time the editor page finished loading.
    await expect.poll(() => existsSync(handshakePath), { timeout: 10_000 }).toBe(true);

    const dirMode = statSync(path.dirname(handshakePath)).mode & 0o777;
    const fileMode = statSync(handshakePath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    const entry = JSON.parse(readFileSync(handshakePath, "utf8")) as {
      url: string;
      token: string;
      port: number;
    };
    expect(entry.token).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.url).toBe(`http://127.0.0.1:${entry.port}/api/mcp`);

    // The url/port in the file must match the server actually listening —
    // proven by successfully completing real HTTP requests against it below,
    // not just by reading the file's own internal consistency.

    // --- unauthenticated request: 401, no token leaked as "close enough" ---
    const unauth = await fetch(entry.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    });
    expect(unauth.status).toBe(401);

    // --- a request carrying Origin (only a browser tab ever sends one) ---
    const originRejected = await fetch(entry.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${entry.token}`,
        Origin: "https://evil.test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    });
    expect(originRejected.status).toBe(403);

    // --- real initialize -> tools/list -> tools/call sequence ---
    const authedPost = (body: unknown) =>
      fetch(entry.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const initResult = (await authedPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1.0.0" } },
    })) as { result?: { serverInfo?: { name?: string } } };
    expect(initResult.result?.serverInfo?.name).toBe("pen-editor-desktop");

    const toolsListResult = (await authedPost({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result?: { tools?: { name: string }[] };
    };
    const toolNames = toolsListResult.result?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("get_editor_state");

    // registerMcpBridge's IPC message (sent by the stub page's inline
    // <script>) races the editor page's did-finish-load — retry the actual
    // tools/call (each attempt is a fresh, independent HTTP round trip)
    // until the tab has registered, rather than adding an artificial delay.
    type ToolCallResponse = { result?: { content?: { type: string; text?: string }[]; isError?: boolean } };
    let callResult: ToolCallResponse = {};
    await expect
      .poll(
        async () => {
          callResult = (await authedPost({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "get_editor_state", arguments: { include_schema: false } },
          })) as ToolCallResponse;
          return callResult.result?.isError ?? false;
        },
        { timeout: 10_000 },
      )
      .toBe(false);
    const text = callResult.result?.content?.[0]?.text ?? "";
    // Proves the call really reached the renderer and came back: the text
    // is the stub page's canned payload, not something main fabricated.
    expect(text).toContain(CANNED_MARKER);
    const parsedState = JSON.parse(text) as { fileName?: string };
    expect(parsedState.fileName).toBe("Launch Deck.pen");

    // Confirm it actually round-tripped through the renderer's onCall.
    await expect
      .poll(() => editorPage.evaluate(() => (window as never as { __mcpCalls: unknown[] }).__mcpCalls.length))
      .toBeGreaterThan(0);

    // --- shutdown: handshake file removed ---
    await app.close();
    expect(existsSync(handshakePath)).toBe(false);
  } finally {
    await app.close().catch(() => {});
  }
});

test("desktop MCP bridge: the real pen-editor-plugin proxy discovers the endpoint with zero configuration", async ({}, testInfo) => {
  const home = testInfo.outputPath("home-plugin");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl, HOME: home, USERPROFILE: home },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const handshakePath = path.join(home, ".pen-editor", "mcp.json");
    await expect.poll(() => existsSync(handshakePath), { timeout: 10_000 }).toBe(true);

    const pluginBin = path.resolve(__dirname, "../../pen-editor-plugin/bin/pen-editor-mcp.mjs");
    if (!existsSync(pluginBin)) {
      test.skip(true, `../pen-editor-plugin not found next to this repo at ${pluginBin} — skipping the real-plugin path.`);
      return;
    }

    // Zero configuration, deliberately: no PEN_EDITOR_MCP_URL,
    // PEN_EDITOR_MCP_TOKEN, or PEN_EDITOR_PLUGIN_DATA — exactly the literal
    // end-user path (install the .app, install the plugin, nothing else).
    // Only HOME is redirected, same as the Electron app above, so the
    // plugin's own os.homedir() lookup can never touch the real
    // ~/.pen-editor/mcp.json either.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.PEN_EDITOR_MCP_URL;
    delete env.PEN_EDITOR_MCP_TOKEN;
    delete env.PEN_EDITOR_PLUGIN_DATA;

    const child = spawn(process.execPath, [pluginBin], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stderrChunks: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

    let outBuffer = "";
    const lineQueue: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outBuffer += chunk;
      let idx: number;
      while ((idx = outBuffer.indexOf("\n")) !== -1) {
        const line = outBuffer.slice(0, idx);
        outBuffer = outBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lineQueue.push(line);
      }
    });

    const nextLine = (timeoutMs = 20_000): Promise<string> => {
      if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift() as string);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for proxy stdout. stderr so far:\n${stderrChunks.join("")}`)),
          timeoutMs,
        );
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    };
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      const initLine = JSON.parse(await nextLine()) as { result?: { serverInfo?: { name?: string } } };
      expect(initLine.result?.serverInfo?.name).toBe("pen-editor-desktop");

      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listLine = JSON.parse(await nextLine()) as { result?: { tools?: { name: string }[] } };
      expect(listLine.result?.tools?.map((t) => t.name)).toContain("get_editor_state");

      // Same registration race as the direct-HTTP test above — retry the
      // tools/call over the real proxy process until the stub tab has
      // registered with main.
      let text = "";
      let nextId = 3;
      await expect
        .poll(
          async () => {
            const id = nextId++;
            send({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: "get_editor_state", arguments: { include_schema: false } },
            });
            const callLine = JSON.parse(await nextLine()) as {
              result?: { content?: { text?: string }[]; isError?: boolean };
            };
            text = callLine.result?.content?.[0]?.text ?? "";
            return callLine.result?.isError ?? false;
          },
          { timeout: 10_000 },
        )
        .toBe(false);
      expect(text).toContain(CANNED_MARKER);
    } finally {
      child.kill("SIGKILL");
    }

    await app.close();
    expect(existsSync(handshakePath)).toBe(false);
  } finally {
    await app.close().catch(() => {});
  }
});

// Finding 1 regression: did-start-navigation used to be filtered on
// isMainFrame only, so pen-editor's react-router in-app navigation
// (pushState/replaceState/hash — same document, no reload) was
// indistinguishable from a real page reload and permanently killed the
// bridge (initDesktopMcpBridge()'s module-scoped `teardown` guard means it
// never re-registers without an actual reload). A real cross-document
// navigation must still drop it.
test("desktop MCP bridge: same-document (SPA) navigation keeps the bridge alive; a real navigation still drops it", async ({}, testInfo) => {
  const home = testInfo.outputPath("home-spa-nav");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl, HOME: home, USERPROFILE: home },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    const handshakePath = path.join(home, ".pen-editor", "mcp.json");
    await expect.poll(() => existsSync(handshakePath), { timeout: 10_000 }).toBe(true);
    const entry = JSON.parse(readFileSync(handshakePath, "utf8")) as { url: string; token: string };

    type ToolCallResponse = { result?: { content?: { type: string; text?: string }[]; isError?: boolean } };
    const callGetEditorState = (id: number): Promise<ToolCallResponse> =>
      fetch(entry.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "get_editor_state", arguments: { include_schema: false } },
        }),
      }).then((r) => r.json());

    // Registration race, same as the other tests in this suite.
    let nextId = 1;
    await expect
      .poll(async () => (await callGetEditorState(nextId++)).result?.isError ?? false, { timeout: 10_000 })
      .toBe(false);

    // --- same-document navigation (SPA pushState) must NOT drop it ---
    await editorPage.evaluate(() => window.history.pushState({}, "", "/pushed-in-app"));
    const afterPushState = await callGetEditorState(nextId++);
    expect(afterPushState.result?.isError).toBeFalsy();
    expect(afterPushState.result?.content?.[0]?.text).toContain(CANNED_MARKER);

    // --- a real cross-document navigation still drops it ---
    await editorPage.evaluate((url) => {
      window.location.href = url;
    }, `${baseUrl}/bare`);
    await expect(editorPage.locator("#ready")).toHaveText("stub-bare");
    const afterRealNav = await callGetEditorState(nextId++);
    expect(afterRealNav.result?.isError).toBe(true);
    expect(afterRealNav.result?.content?.[0]?.text).toContain("running an older build");

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});

// Finding 3 regression: list_editor_tabs must report ids in the same space
// tabId routing accepts, and an explicit tabId must actually reach the
// requested tab rather than silently falling back to whatever tab is
// focused (finding 2).
test("desktop MCP bridge: list_editor_tabs discovers ids that explicit tabId routing actually reaches", async ({}, testInfo) => {
  const home = testInfo.outputPath("home-list-tabs");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl, HOME: home, USERPROFILE: home },
  });

  try {
    const editorPage1 = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl),
    });
    await expect(editorPage1.locator("#ready")).toHaveText("stub-editor");

    const handshakePath = path.join(home, ".pen-editor", "mcp.json");
    await expect.poll(() => existsSync(handshakePath), { timeout: 10_000 }).toBe(true);
    const entry = JSON.parse(readFileSync(handshakePath, "utf8")) as { url: string; token: string };

    const authedPost = (body: unknown) =>
      fetch(entry.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    type CallResp = { result?: { content?: { text?: string }[]; isError?: boolean } };
    let nextId = 1;
    // Registration race for tab 1.
    await expect
      .poll(
        async () => {
          const r = (await authedPost({
            jsonrpc: "2.0",
            id: nextId++,
            method: "tools/call",
            params: { name: "get_editor_state", arguments: { include_schema: false } },
          })) as CallResp;
          return r.result?.isError ?? false;
        },
        { timeout: 10_000 },
      )
      .toBe(false);

    // Open a second tab through the tab bar's own IPC path.
    const tabbarPage =
      app.windows().find((page) => page.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (page) => page.url().endsWith("/tabbar/tabbar.html") }));
    // The "+" button pops a native menu Playwright can't click through; this
    // is the same `tabbar:new` IPC its "New Editor Tab" item ends up in.
    await tabbarPage.evaluate(() => (window as unknown as { penTabbar: { newTab(): void } }).penTabbar.newTab());
    const editorPage2 = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(baseUrl) && p !== editorPage1,
    });
    await expect(editorPage2.locator("#ready")).toHaveText("stub-editor");

    interface TabEntry {
      tabId: number;
      title: string;
      active: boolean;
      mcpReady: boolean;
    }
    let tabs: TabEntry[] = [];
    await expect
      .poll(
        async () => {
          const r = (await authedPost({
            jsonrpc: "2.0",
            id: nextId++,
            method: "tools/call",
            params: { name: "list_editor_tabs", arguments: {} },
          })) as CallResp;
          const text = r.result?.content?.[0]?.text ?? "{}";
          tabs = (JSON.parse(text) as { tabs: TabEntry[] }).tabs;
          return tabs.length === 2 && tabs.every((t) => t.mcpReady);
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const inactive = tabs.find((t) => !t.active);
    expect(inactive).toBeDefined();

    const countOf = (page: typeof editorPage1) =>
      page.evaluate(() => (window as never as { __mcpCalls: unknown[] }).__mcpCalls.length);

    const before1 = await countOf(editorPage1);
    const before2 = await countOf(editorPage2);

    // Call A: explicit tabId targeting the *inactive* tab.
    const callA = (await authedPost({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "get_editor_state", arguments: { include_schema: false, tabId: inactive!.tabId } },
    })) as CallResp;
    expect(callA.result?.isError).toBeFalsy();
    expect(callA.result?.content?.[0]?.text).not.toContain("No editor tab with id");

    const afterA1 = await countOf(editorPage1);
    const afterA2 = await countOf(editorPage2);
    const deltaA1 = afterA1 - before1;
    const deltaA2 = afterA2 - before2;
    // Exactly one page received call A.
    expect([deltaA1, deltaA2].sort()).toEqual([0, 1]);

    // Call B: no tabId -> always routes to whichever tab is active.
    await authedPost({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "get_editor_state", arguments: { include_schema: false } },
    });
    const afterB1 = await countOf(editorPage1);
    const deltaB1 = afterB1 - afterA1;

    // Call A (explicit tabId=inactive) and call B (implicit active tab)
    // must land on two *different* pages. If tabId routing were
    // unreachable (finding 2), both calls would silently land on the
    // active tab and this would fail.
    expect(deltaA1 > 0).not.toBe(deltaB1 > 0);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});
