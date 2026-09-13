// Live gate: the desktop shell against the DEPLOYED frontend and backend.
//
// Everything else in e2e/ runs against a local stub page, which is what makes
// those suites hermetic — and also what makes them blind to the failure this
// file exists for: the shell can be perfectly correct while the deployed
// bundle stops holding up its end (no `registerMcpBridge` call, a renamed
// command-palette id, a frontend built against the wrong backend). Nothing in
// this repo's unit tests or pen-editor's cross-repo contract tests can see
// that — they check source and working trees, never what is actually serving
// at https://pen-editor.onrender.com.
//
// Therefore: NOT part of `npm run test:e2e` (playwright.config.ts ignores
// `live-*.spec.ts`). Run it deliberately with `npm run test:e2e:live`, after
// a frontend/backend deploy or before cutting a desktop release. It needs
// network, and it spends real tokens on one short /api/chat turn.
//
// HOME is redirected per launch so the app can never touch the developer's
// real ~/.pen-editor/mcp.json (same rule as mcp.spec.ts).

import { test, expect, _electron as electron, type Page } from "@playwright/test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const PROD_EDITOR = process.env.PEN_LIVE_URL ?? "https://pen-editor.onrender.com/app";
const editorOrigin = new URL(PROD_EDITOR).origin;
const editorPathname = new URL(PROD_EDITOR).pathname;

// Menu ids the shell forwards (CLAUDE.md "Cross-repo contract"). Only the
// export half is exercised: `file-open` and `file-import-tokens` open a
// native file dialog, which would block the run forever. The filenames the
// bundle picks depend on the open document's name, so assert on the
// extension each command must produce, not on a fixed basename.
// `.tokens.json` also ends in `.json`, so a plain "contains .json" check
// would let a broken file-export-json pass on the tokens file alone.
const EXPORT_COMMANDS = [
  { id: "file-export-json", produces: (f: string) => f.endsWith(".json") && !f.endsWith(".tokens.json") },
  { id: "file-export-pen", produces: (f: string) => f.endsWith(".pen") },
  { id: "file-export-tokens", produces: (f: string) => f.endsWith(".tokens.json") },
] as const;

test.setTimeout(300_000);

test("live: the deployed bundle answers the shell's menu, MCP and backend contracts", async ({}, testInfo) => {
  const home = testInfo.outputPath("home");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: PROD_EDITOR, HOME: home, USERPROFILE: home },
  });

  // Attach to every window the moment it exists, before anything is awaited:
  // an exception thrown while the deployed bundle's modules evaluate fires
  // long before a later `waitForEvent` could observe it, and that crash is
  // exactly what this gate is for. Same reason the request log starts here —
  // it is what tells us which backend the bundle is really built against.
  const pageErrors: string[] = [];
  const requestedUrls: string[] = [];
  const allPages: Page[] = [];
  const attach = (page: Page) => {
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("request", (r) => requestedUrls.push(r.url()));
    allPages.push(page);
  };
  app.windows().forEach(attach);
  app.on("window", attach);
  // A window can surface before its URL is set (about:blank), so classify by
  // the URL each page reports *now*, never by the one it had at creation.
  // `app.windows()` can only be read after the first await; a window created
  // in between is picked up by the listener above, never missed.
  const editorPages = () => allPages.filter((p) => p.url().startsWith(editorOrigin));
  const nextEditorPage = async (seen: number) => {
    await expect.poll(() => editorPages().length, { timeout: 60_000 }).toBeGreaterThan(seen);
    return editorPages()[seen];
  };

  try {
    // A real export triggers a download; left alone Electron opens a native
    // save dialog and the run hangs. Record the filename and cancel.
    await app.evaluate(({ session }) => {
      (globalThis as { __downloads?: string[] }).__downloads = [];
      session.defaultSession.on("will-download", (event, item) => {
        (globalThis as { __downloads?: string[] }).__downloads?.push(item.getFilename());
        event.preventDefault();
      });
    });

    const editorPage = await nextEditorPage(0);
    const tabbarPage =
      app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
      (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));

    // The real editor is up — not the showcase gallery, not an error page.
    await editorPage.waitForSelector("canvas", { timeout: 60_000 });
    const loaded = new URL(editorPage.url());
    expect(loaded.origin).toBe(editorOrigin);
    expect(loaded.pathname.replace(/\/$/, "")).toBe(editorPathname.replace(/\/$/, ""));
    expect(
      await editorPage.evaluate(() => typeof (window as { penDesktop?: unknown }).penDesktop),
    ).toBe("object");

    // ---- MCP: real HTTP -> main -> IPC -> deployed bundle -> back ----
    const handshakePath = path.join(home, ".pen-editor", "mcp.json");
    await expect.poll(() => existsSync(handshakePath), { timeout: 15_000 }).toBe(true);
    const entry = JSON.parse(readFileSync(handshakePath, "utf8")) as { url: string; token: string };

    type RpcResponse = {
      result?: { isError?: boolean; content?: { text?: string }[]; tools?: { name: string }[]; serverInfo?: { name?: string } };
      error?: { code?: number; message?: string };
    };
    const post = async (body: unknown): Promise<RpcResponse> => {
      const res = await fetch(entry.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
        body: JSON.stringify(body),
      });
      // A JSON-RPC or HTTP-level failure must never read as a passing call:
      // 401/403 return no JSON-RPC envelope at all, and protocol errors
      // return `error` with no `result`.
      if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as RpcResponse;
    };
    // Returns a discriminated outcome so a poll can retry on "not registered
    // yet" while a protocol error still surfaces its own message.
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const res = await post({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: args } });
      if (res.error) return { ok: false as const, detail: `JSON-RPC error ${res.error.code}: ${res.error.message}` };
      if (!res.result) return { ok: false as const, detail: `no result in response: ${JSON.stringify(res).slice(0, 200)}` };
      const text = String(res.result.content?.[0]?.text ?? "");
      if (res.result.isError) return { ok: false as const, detail: `tool error: ${text.slice(0, 300)}` };
      return { ok: true as const, text };
    };
    const expectTool = async (name: string, args: Record<string, unknown>) => {
      const res = await callTool(name, args);
      expect(res.ok, `${name} failed — ${res.ok ? "" : res.detail}`).toBe(true);
      return res.ok ? res.text : "";
    };

    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live", version: "1" } },
    });
    expect(init.error, `initialize failed: ${JSON.stringify(init.error)}`).toBeUndefined();
    expect(init.result?.serverInfo?.name).toBe("pen-editor-desktop");

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const toolNames = (list.result?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("get_editor_state");
    expect(toolNames).toContain("batch_design");

    // The bundle registers its bridge some time after did-finish-load; retry
    // the call itself rather than sleeping a guessed amount. `lastDetail`
    // keeps the real reason for the failure message when it never registers.
    // `expect.poll`'s own failure message cannot carry the reason (it takes a
    // string, not a callback), and the reason is the whole point here: "no tab
    // registered" and "the tool is gone from the bundle" must not look alike.
    let lastDetail = "never attempted";
    let registered = false;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
      const res = await callTool("get_editor_state", { include_schema: false });
      if (res.ok) {
        registered = true;
        break;
      }
      lastDetail = res.detail;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(registered, `the deployed bundle never answered get_editor_state — ${lastDetail}`).toBe(true);

    // A real mutation, read back from the live scene graph — proves the whole
    // chain executes, not just that a request reaches the renderer.
    await expectTool("batch_design", {
      operations: 'f=I(document, {type: "frame", name: "LiveCheck", x: 0, y: 0, width: 320, height: 200})',
    });
    const afterMutation = await expectTool("get_editor_state", { include_schema: false });
    const rootNames = ((JSON.parse(afterMutation).roots ?? []) as { name: string }[]).map((n) => n.name);
    expect(rootNames).toContain("LiveCheck");

    // ---- tabs: a second tab registers too, and tabId routing separates them ----
    type TabEntry = { tabId: number; mcpReady: boolean };
    const readyTabIds = async () => {
      const res = await callTool("list_editor_tabs", {});
      if (!res.ok) return null;
      return ((JSON.parse(res.text).tabs ?? []) as TabEntry[]).filter((t) => t.mcpReady).map((t) => t.tabId);
    };
    // Pin the tab that owns the mutation *before* opening another one, so the
    // two are told apart by identity rather than by position in a list whose
    // order and length are not guaranteed. `tabId` is the webContents id.
    const mutatedTabIds = await readyTabIds();
    expect(mutatedTabIds, "the first tab never registered its MCP bridge").toHaveLength(1);
    const mutatedTabId = (mutatedTabIds as number[])[0];

    await tabbarPage.click("#new-tab");
    const secondPage = await nextEditorPage(1);
    await secondPage.waitForSelector("canvas", { timeout: 60_000 });

    // `callTool`, not `expectTool`: a callback that throws is NOT retried by
    // expect.poll (the call sits outside its try/catch), so a transient
    // failure while the tab comes up would abort instead of polling.
    let ready: number[] = [];
    await expect
      .poll(
        async () => {
          ready = (await readyTabIds()) ?? [];
          return ready.length;
        },
        { timeout: 30_000 },
      )
      .toBe(2);
    const otherTabId = ready.find((id) => id !== mutatedTabId);
    expect(otherTabId, `the new tab never registered (ready: ${JSON.stringify(ready)})`).toBeDefined();

    const rootsOf = async (tabId: number) => {
      const state = await expectTool("get_editor_state", { include_schema: false, tabId });
      return ((JSON.parse(state).roots ?? []) as { name: string }[]).map((n) => n.name);
    };
    // The frame was created in the pinned tab only: explicit routing must not
    // silently answer from whichever tab happens to be focused. Asserted per
    // tab so an unrelated extra root cannot masquerade as a routing failure.
    expect(await rootsOf(mutatedTabId)).toContain("LiveCheck");
    expect(await rootsOf(otherTabId as number)).not.toContain("LiveCheck");

    // ---- menu ids the shell forwards still resolve in the deployed bundle ----
    // menu.ts sends to whichever tab is active; addressing the pinned tab by
    // its own webContents id (what `list_editor_tabs` reports) keeps this an
    // assertion about the bundle's handler rather than about focus — and
    // unlike `getAllWebContents().find(...)`, it cannot quietly resolve to the
    // other tab, whose order Electron does not guarantee.
    for (const { id } of EXPORT_COMMANDS) {
      await app.evaluate(({ webContents }, { wcId, commandId }) => {
        webContents.fromId(wcId)?.send("menu:command", commandId);
      }, { wcId: mutatedTabId, commandId: id });
    }
    let downloads: string[] = [];
    await expect
      .poll(
        async () => {
          downloads = await app.evaluate(() => (globalThis as { __downloads?: string[] }).__downloads ?? []);
          return EXPORT_COMMANDS.every(({ produces }) => downloads.some(produces));
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    for (const { id, produces } of EXPORT_COMMANDS) {
      expect(
        downloads.some(produces),
        `${id} produced no matching download (got ${JSON.stringify(downloads)}) — the deployed bundle may have renamed or dropped the command`,
      ).toBe(true);
    }

    // ---- the backend the deployed bundle is ACTUALLY built against ----
    // Taken from the bundle's own traffic (it calls /api/models, /api/skills
    // on startup), not from a constant here — a deploy pointed at the wrong
    // backend is one of the breakages this gate exists to catch, and a
    // hardcoded URL would happily probe a backend the app never uses.
    // Match the bundle's OWN endpoints by pathname: posthog-js also issues
    // cross-origin `/api/...` calls (surveys, early access features), and
    // whichever landed first would otherwise be mistaken for the backend.
    const BACKEND_PATHS = ["/api/models", "/api/skills", "/api/user-skills", "/api/chat"];
    let backendOrigin = "";
    await expect
      .poll(
        () => {
          const apiCall = requestedUrls.find((u) => {
            if (u.startsWith(editorOrigin)) return false;
            const { pathname } = new URL(u);
            return BACKEND_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
          });
          backendOrigin = apiCall ? new URL(apiCall).origin : "";
          return backendOrigin;
        },
        { timeout: 30_000, message: "the deployed bundle never called a backend API — check its build-time backend URL" },
      )
      .not.toBe("");
    if (process.env.PEN_LIVE_BACKEND) {
      expect(backendOrigin).toBe(new URL(process.env.PEN_LIVE_BACKEND).origin);
    }

    const net = await editorPage.evaluate(async (backend) => {
      const models = await fetch(`${backend}/api/models`);
      const modelsBody = (await models.json()) as { models?: unknown[] };
      const chat = await fetch(`${backend}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "ping" }] }] }),
      });
      const reader = chat.body?.getReader();
      const first = await reader?.read();
      const firstChunk = new TextDecoder().decode(first?.value ?? new Uint8Array());
      await reader?.cancel();
      return { modelsStatus: models.status, modelCount: modelsBody.models?.length ?? 0, chatStatus: chat.status, firstChunk };
    }, backendOrigin);

    expect(net.modelsStatus).toBe(200);
    expect(net.modelCount).toBeGreaterThan(0);
    expect(net.chatStatus).toBe(200);
    // An SSE stream, not an error page — the shape useDesignChat consumes.
    expect(net.firstChunk).toContain("data: ");

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});
