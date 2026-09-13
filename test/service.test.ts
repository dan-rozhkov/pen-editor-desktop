import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  McpService,
  createDefaultMcpServiceDeps,
  type McpServiceDeps,
  type TabHandle,
  type IpcListenerGateway,
} from "../src/main/mcp/service";
import type { HandshakeFileEntry } from "../src/main/mcp/handshake";
import type { HttpServerHandle } from "../src/main/mcp/httpServer";
import type { ToolManifestEntry } from "../src/main/mcp/jsonRpc";

// Only readFileSync is overridden (toolManifest.json loading) — everything
// else (readFile/promises, watch, etc.) passes through untouched so the
// rest of this file's real-fs-adjacent behavior (none of it, today; every
// other test injects its own deps) is unaffected.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import { readFileSync } from "node:fs";

const manifest: ToolManifestEntry[] = [
  { name: "get_editor_state", description: "desc", inputSchema: { type: "object" } },
];

function makeFakeServer(port = 4321): HttpServerHandle {
  return {
    server: {} as HttpServerHandle["server"],
    port,
    close: vi.fn(async () => {}),
  };
}

function makeDeps(overrides: Partial<McpServiceDeps> = {}): McpServiceDeps {
  return {
    startServer: vi.fn(async () => makeFakeServer()),
    readHandshakeEntry: vi.fn(async () => null),
    writeHandshakeEntry: vi.fn(async () => true),
    removeHandshakeEntrySync: vi.fn(),
    probeOwner: vi.fn(async () => "stale" as const),
    watchHandshakeFile: vi.fn(() => ({ close: vi.fn() })),
    generateToken: vi.fn(() => "a".repeat(64)),
    toolManifest: manifest,
    log: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

function makeTabHandle(): TabHandle & { sent: { callId: string; tool: string; args: Record<string, unknown> }[] } {
  const sent: { callId: string; tool: string; args: Record<string, unknown> }[] = [];
  let destroyed = false;
  return {
    sent,
    sendMcpCall: (callId, tool, args) => sent.push({ callId, tool, args }),
    isDestroyed: () => destroyed,
  };
}

describe("McpService", () => {
  let deps: McpServiceDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("publishes its own handshake entry when no owner is present", async () => {
    const service = new McpService(deps);
    await service.start();

    expect(deps.writeHandshakeEntry).toHaveBeenCalledTimes(1);
    const written = (deps.writeHandshakeEntry as ReturnType<typeof vi.fn>).mock.calls[0][0] as HandshakeFileEntry;
    expect(written.token).toBe("a".repeat(64));
    expect(written.port).toBe(4321);
    expect(written.url).toBe("http://127.0.0.1:4321/api/mcp");
    expect(service.getStatus()).toBe("listening");
    expect(service.getStatusDetail()).toBeUndefined();
  });

  it("publishes when the existing handshake owner is stale", async () => {
    const existing: HandshakeFileEntry = { url: "http://127.0.0.1:9999/api/mcp", token: "b".repeat(64), port: 9999 };
    deps = makeDeps({ readHandshakeEntry: vi.fn(async () => existing), probeOwner: vi.fn(async (): Promise<"live" | "stale"> => "stale") });
    const service = new McpService(deps);
    await service.start();

    expect(deps.probeOwner).toHaveBeenCalledWith(existing);
    expect(deps.writeHandshakeEntry).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toBe("listening");
  });

  it("does not publish when a live owner is found", async () => {
    const existing: HandshakeFileEntry = { url: "http://127.0.0.1:9999/api/mcp", token: "b".repeat(64), port: 9999 };
    deps = makeDeps({ readHandshakeEntry: vi.fn(async () => existing), probeOwner: vi.fn(async (): Promise<"live" | "stale"> => "live") });
    const service = new McpService(deps);
    await service.start();

    expect(deps.writeHandshakeEntry).not.toHaveBeenCalled();
    expect(service.getStatus()).toBe("not-published");
    expect(service.getStatusDetail()).toBe(
      "Another local MCP server is already running; this app is not publishing its own endpoint.",
    );
    // Never leaks the owning port/token into the detail string surfaced to any renderer.
    expect(service.getStatusDetail()).not.toMatch(/9999/);
  });

  it("force-publish overrides a live owner", async () => {
    const existing: HandshakeFileEntry = { url: "http://127.0.0.1:9999/api/mcp", token: "b".repeat(64), port: 9999 };
    deps = makeDeps({ readHandshakeEntry: vi.fn(async () => existing), probeOwner: vi.fn(async (): Promise<"live" | "stale"> => "live") });
    const service = new McpService(deps);
    await service.start();
    expect(service.getStatus()).toBe("not-published");

    await service.forcePublish();

    expect(service.getStatus()).toBe("listening");
    expect(deps.writeHandshakeEntry).toHaveBeenCalledTimes(1);
    const written = (deps.writeHandshakeEntry as ReturnType<typeof vi.fn>).mock.calls[0][0] as HandshakeFileEntry;
    expect(written.token).toBe("a".repeat(64)); // publishes *our* entry, not the stale owner's
  });

  it("notifies onStatusChanged listeners exactly on real transitions", async () => {
    const service = new McpService(deps);
    const seen: string[] = [];
    service.onStatusChanged(() => seen.push(service.getStatus()));
    await service.start();
    expect(seen).toEqual(["listening"]);
  });

  it("tab close drops the registration and rejects an in-flight call", async () => {
    // Capture the `callTool` function McpService.start() hands to the HTTP
    // server — this is the same entry point jsonRpc.ts's tools/call handler
    // uses in production, so driving a call through it (rather than through
    // McpService.getTab(id)!.send directly) exercises the real routing.
    let callTool!: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    deps = makeDeps({
      startServer: vi.fn(async (options) => {
        callTool = options.deps.callTool;
        return makeFakeServer();
      }),
    });
    const service = new McpService(deps);
    await service.start();

    const handle = makeTabHandle();
    service.registerTab(1, handle);
    service.handleRegister(1, { protocol: 1, tools: ["get_editor_state"] });
    service.setActiveTab(1);

    const resultPromise = callTool("get_editor_state", {});
    // The call is now in flight — Dispatcher has sent it to the tab (visible
    // in handle.sent) and is waiting on an `mcp:result` reply that will
    // never come because the tab is about to close.
    expect(handle.sent).toHaveLength(1);

    service.unregisterTab(1);

    const result = (await resultPromise) as { isError?: true; content: { type: string; text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("disconnected") });

    // The registration itself is gone too — routing to tab 1 now fails.
    expect(service.getTab(1)).toBeNull();
    const afterClose = (await callTool("get_editor_state", {})) as { isError?: true };
    expect(afterClose.isError).toBe(true);
  });

  it("registerAppLevelIpc is idempotent — a second call (modelling a second createMainWindow) does not double-register", async () => {
    const service = new McpService(deps);
    const onCalls: string[] = [];
    const gateway: IpcListenerGateway = {
      on: vi.fn((channel) => onCalls.push(channel)),
      removeListener: vi.fn(),
    };

    service.registerAppLevelIpc(gateway);
    service.registerAppLevelIpc(gateway); // second createMainWindow-equivalent call

    expect(onCalls.sort()).toEqual(["mcp:register", "mcp:result"]);
    expect(gateway.on).toHaveBeenCalledTimes(2);
  });

  it("teardownAppLevelIpc removes both listeners and is a no-op if never registered", () => {
    const service = new McpService(deps);
    const gateway: IpcListenerGateway = { on: vi.fn(), removeListener: vi.fn() };

    // No-op before registration.
    service.teardownAppLevelIpc();
    expect(gateway.removeListener).not.toHaveBeenCalled();

    service.registerAppLevelIpc(gateway);
    service.teardownAppLevelIpc();
    expect(gateway.removeListener).toHaveBeenCalledTimes(2);
  });

  it("handleRegister ignores a sender that was never registerTab()'d (no cross-tab registration)", async () => {
    const service = new McpService(deps);
    await service.start();
    service.handleRegister(999, { protocol: 1, tools: ["get_editor_state"] });
    expect(service.getTab(999)).toBeNull();
  });

  it("stop() removes the handshake entry only when we still hold it, and flips status off", async () => {
    const service = new McpService(deps);
    await service.start();
    expect(service.getStatus()).toBe("listening");

    service.stop();

    expect(deps.removeHandshakeEntrySync).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toBe("off");
  });

  it("stop() does not remove the handshake file when we never published (not-published)", async () => {
    const existing: HandshakeFileEntry = { url: "http://127.0.0.1:9999/api/mcp", token: "b".repeat(64), port: 9999 };
    deps = makeDeps({ readHandshakeEntry: vi.fn(async () => existing), probeOwner: vi.fn(async (): Promise<"live" | "stale"> => "live") });
    const service = new McpService(deps);
    await service.start();

    service.stop();

    expect(deps.removeHandshakeEntrySync).not.toHaveBeenCalled();
  });

  // Finding 2: explicit tabId routing must actually reach the dispatcher,
  // targeting the requested tab rather than whatever is focused — and the
  // routing key itself must not leak into the args the page's tool
  // handlers receive.
  it("routes an explicit tabId in tools/call arguments to that tab, not the active one, and strips tabId from the forwarded args", async () => {
    let callTool!: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    deps = makeDeps({
      startServer: vi.fn(async (options) => {
        callTool = options.deps.callTool;
        return makeFakeServer();
      }),
    });
    const service = new McpService(deps);
    await service.start();

    const active = makeTabHandle();
    const other = makeTabHandle();
    service.registerTab(1, active);
    service.registerTab(2, other);
    service.handleRegister(1, { protocol: 1, tools: ["get_editor_state"] });
    service.handleRegister(2, { protocol: 1, tools: ["get_editor_state"] });
    service.setActiveTab(1); // active tab is 1; the call below targets 2 explicitly

    void callTool("get_editor_state", { include_schema: true, tabId: 2 });

    expect(active.sent).toHaveLength(0);
    expect(other.sent).toHaveLength(1);
    expect(other.sent[0].args).toEqual({ include_schema: true }); // tabId stripped, not forwarded to the page
  });

  // Finding 3: list_editor_tabs must be answered entirely in main (no page
  // round-trip) and its ids must be exactly the ids tabId routing accepts —
  // this test drives every returned tabId back through routing and fails if
  // the two ever key off different id spaces (e.g. TabManager's sequential
  // ids vs. webContents ids).
  it("list_editor_tabs reports ids in the same space tabId routing accepts, with correct title/active/mcpReady", async () => {
    let callTool!: (name: string, args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }>;
    deps = makeDeps({
      startServer: vi.fn(async (options) => {
        callTool = options.deps.callTool as typeof callTool;
        return makeFakeServer();
      }),
    });
    const service = new McpService(deps);
    await service.start();

    const handleA = makeTabHandle();
    const handleB = makeTabHandle();
    service.registerTab(11, handleA);
    service.registerTab(42, handleB);
    service.setTabTitle(11, "Launch Deck");
    service.setTabTitle(42, "Icon Set");
    service.handleRegister(11, { protocol: 1, tools: ["get_editor_state"] });
    // 42 deliberately left unregistered -> mcpReady: false
    service.setActiveTab(42);

    const listResult = await callTool("list_editor_tabs", {});
    const parsed = JSON.parse(listResult.content[0].text ?? "{}") as {
      tabs: { tabId: number; title: string; active: boolean; mcpReady: boolean }[];
    };
    const byId = new Map(parsed.tabs.map((t) => [t.tabId, t]));
    expect(byId.get(11)).toEqual({ tabId: 11, title: "Launch Deck", active: false, mcpReady: true });
    expect(byId.get(42)).toEqual({ tabId: 42, title: "Icon Set", active: true, mcpReady: false });

    // Drive every reported tabId back through explicit routing — if
    // list_editor_tabs and tabId routing ever key off different id spaces,
    // this fails with "No editor tab with id <n>." for a tab that plainly
    // exists.
    //
    // Tab 11 is registered: the dispatcher sends and waits for a reply, so
    // settle it via handleResult (mirroring an `mcp:result` IPC message)
    // instead of awaiting a promise nothing would ever resolve.
    const aPromise = callTool("get_editor_state", { tabId: 11 });
    expect(handleA.sent).toHaveLength(1); // routed and sent synchronously
    const aCallId = handleA.sent[0].callId;
    service.handleResult(11, { callId: aCallId, type: "tool_result", result: "{}" });
    const aResult = await aPromise;
    expect(aResult.content[0]).toMatchObject({ type: "text" });

    // Tab 42 is unregistered, so the dispatcher short-circuits to the
    // upgrade error *before* ever calling send() — it never reaches the
    // page. What matters here is that the id *resolved to a real tab*
    // rather than failing routing outright ("No editor tab with id 42."),
    // checked next.
    const bResult = await callTool("get_editor_state", { tabId: 42 });
    expect(handleB.sent).toHaveLength(0);
    const bText = bResult.content[0].text ?? "";
    expect(bText).not.toContain("No editor tab with id");
  });

  it("list_editor_tabs answers entirely from main state, without dispatching into any tab", async () => {
    let callTool!: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    deps = makeDeps({
      startServer: vi.fn(async (options) => {
        callTool = options.deps.callTool;
        return makeFakeServer();
      }),
    });
    const service = new McpService(deps);
    await service.start();
    const handle = makeTabHandle();
    service.registerTab(1, handle);
    service.handleRegister(1, { protocol: 1, tools: ["get_editor_state"] });

    await callTool("list_editor_tabs", {});

    expect(handle.sent).toHaveLength(0); // no page round-trip
  });

  // Finding 5: forcePublish's writeHandshakeEntry (a rename() over the
  // watched file, per handshake.ts) unlinks the inode a pre-existing
  // watcher is bound to. Without re-creating the watcher, §5.4's "someone
  // clobbered our entry" detection goes dead after every force-publish.
  it("re-creates the watcher on every publish, so it does not die across a force-publish", async () => {
    const existing: HandshakeFileEntry = { url: "http://127.0.0.1:9999/api/mcp", token: "b".repeat(64), port: 9999 };
    const closes: number[] = [];
    let watcherCount = 0;
    deps = makeDeps({
      readHandshakeEntry: vi.fn(async () => existing),
      probeOwner: vi.fn(async (): Promise<"live" | "stale"> => "live"),
      watchHandshakeFile: vi.fn(() => {
        const id = ++watcherCount;
        return { close: () => closes.push(id) };
      }),
    });
    const service = new McpService(deps);
    await service.start(); // not-published: watches the (backend's) handshake file -> watcher #1
    expect(deps.watchHandshakeFile).toHaveBeenCalledTimes(1);
    expect(closes).toEqual([]);

    await service.forcePublish(); // publish() must close #1 and create #2, not no-op

    expect(closes).toEqual([1]);
    expect(deps.watchHandshakeFile).toHaveBeenCalledTimes(2);
  });

  // Finding 4 (module-scope half): a missing/corrupt toolManifest.json
  // (e.g. copy-static hasn't run) must degrade gracefully — never throw at
  // McpService construction time, which in index.ts happens at module
  // scope before app.whenReady() is even called.
  it("createDefaultMcpServiceDeps degrades to an empty tool manifest instead of throwing when toolManifest.json can't be read", () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file or directory, toolManifest.json");
    });

    let built!: McpServiceDeps;
    expect(() => {
      built = createDefaultMcpServiceDeps({ log });
    }).not.toThrow();

    expect(built.toolManifest).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("tool manifest"));
  });

  // --- Third-round findings ---

  // Finding 1: writeHandshakeEntry (handshake.ts's writeHandshakeFile)
  // swallows every fs error and only warns — publish() must not report
  // "listening" when the write it just awaited actually failed, since the
  // status surface is the only diagnostic a packaged user has.
  it("finding 1: does not report 'listening' when the handshake write fails, and surfaces why", async () => {
    deps = makeDeps({ writeHandshakeEntry: vi.fn(async () => false) });
    const service = new McpService(deps);
    await service.start();

    expect(service.getStatus()).not.toBe("listening");
    expect(service.getStatus()).toBe("error");
    expect(service.getStatusDetail()).toBeTruthy();
  });

  // Finding 2: quitting while start() is still in flight (e.g. during
  // probeHandshakeOwner's 1500ms probe, a window index.ts explicitly
  // documents) must not let start() go on to bind a socket nobody will ever
  // close, or write a handshake file pointing at a port that dies with the
  // process, after will-quit's cleanup already ran.
  it("finding 2: stop() during an in-flight start() leaves no listening socket and no handshake file", async () => {
    const server = makeFakeServer();
    let resolveRead!: (v: HandshakeFileEntry | null) => void;
    const readGate = new Promise<HandshakeFileEntry | null>((resolve) => {
      resolveRead = resolve;
    });
    deps = makeDeps({
      startServer: vi.fn(async () => server),
      readHandshakeEntry: vi.fn(() => readGate),
    });
    const service = new McpService(deps);

    const startPromise = service.start();
    // Let start() run past `await startServer(...)` so this.server is
    // assigned and it is now blocked on `await readHandshakeEntry()`.
    await Promise.resolve();
    await Promise.resolve();

    service.stop(); // quits mid-startup, before start() ever reached publish()
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toBe("off");

    resolveRead(null); // the read start() was awaiting finally settles
    await startPromise; // must not throw, and must not resurrect "listening"

    expect(deps.writeHandshakeEntry).not.toHaveBeenCalled();
    expect(service.getStatus()).toBe("off");
  });

  it("finding 2: stop() during publish()'s in-flight handshake write removes the file if the write lands anyway", async () => {
    let resolveWrite!: (ok: boolean) => void;
    const writeGate = new Promise<boolean>((resolve) => {
      resolveWrite = resolve;
    });
    deps = makeDeps({ writeHandshakeEntry: vi.fn(() => writeGate) });
    const service = new McpService(deps);

    const startPromise = service.start();
    // No existing handshake owner in this fixture, so start() proceeds
    // straight into publish(), which is now blocked on writeHandshakeEntry.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    service.stop();
    expect(service.getStatus()).toBe("off");

    resolveWrite(true); // the write lands *after* stop() already ran
    await startPromise;

    // The write succeeded, but stop() already happened — the now-orphaned
    // file must be removed, not left pointing at a port that's already closed.
    expect(deps.removeHandshakeEntrySync).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toBe("off");
  });

  // Finding 3: forcePublish() is the *only* remedy the UI offers. If start()
  // never got as far as binding a server (this.entry stays null), it must
  // not silently no-op — it must retry, and either recover or keep
  // reporting the failure.
  it("finding 3: forcePublish() after a failed start() (bind failure) retries and can recover", async () => {
    let attempts = 0;
    deps = makeDeps({
      startServer: vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new Error("EADDRINUSE: address already in use");
        return makeFakeServer();
      }),
    });
    const service = new McpService(deps);
    await service.start();
    expect(service.getStatus()).toBe("error");
    expect(service.getStatusDetail()).toBeTruthy();

    await service.forcePublish();

    expect(attempts).toBe(2);
    expect(service.getStatus()).toBe("listening");
  });

  it("finding 3: forcePublish() after a failed start() reports failure again if the retry also fails (never silently does nothing)", async () => {
    deps = makeDeps({
      startServer: vi.fn(async () => {
        throw new Error("EADDRINUSE: address already in use");
      }),
    });
    const service = new McpService(deps);
    await service.start();
    expect(service.getStatus()).toBe("error");
    const detailAfterFirstFailure = service.getStatusDetail();
    expect(detailAfterFirstFailure).toBeTruthy();

    await service.forcePublish();

    expect(service.getStatus()).toBe("error");
    expect(service.getStatusDetail()).toBe(detailAfterFirstFailure);
  });

  // Finding 5: the watcher set up by start()'s not-published branch must
  // actually be reachable and, when the competing owner's handshake entry
  // disappears (it exited and deleted mcp.json), recover automatically
  // instead of staying amber forever with nothing left owning the endpoint.
  it("finding 5: not-published recovers automatically once the competing owner's handshake entry disappears", async () => {
    const existing: HandshakeFileEntry = { url: "http://127.0.0.1:9999/api/mcp", token: "b".repeat(64), port: 9999 };
    let watcherCb!: () => void;
    let readCount = 0;
    deps = makeDeps({
      readHandshakeEntry: vi.fn(async () => {
        readCount++;
        return readCount === 1 ? existing : null; // start() sees the owner; the later watcher check sees it gone
      }),
      probeOwner: vi.fn(async (): Promise<"live" | "stale"> => "live"),
      watchHandshakeFile: vi.fn((cb: () => void) => {
        watcherCb = cb;
        return { close: vi.fn() };
      }),
    });
    const service = new McpService(deps);
    await service.start();
    expect(service.getStatus()).toBe("not-published");
    expect(deps.watchHandshakeFile).toHaveBeenCalledTimes(1);

    watcherCb(); // simulates fs.watch firing because the owner's file was deleted
    await vi.waitFor(() => expect(service.getStatus()).toBe("listening"));

    expect(deps.writeHandshakeEntry).toHaveBeenCalledTimes(1);
  });

  it("finding 5: not-published recovers once the competing owner's entry goes stale (still present, no longer live)", async () => {
    const existing: HandshakeFileEntry = { url: "http://127.0.0.1:9999/api/mcp", token: "b".repeat(64), port: 9999 };
    let watcherCb!: () => void;
    let probeCount = 0;
    deps = makeDeps({
      readHandshakeEntry: vi.fn(async () => existing),
      probeOwner: vi.fn(async () => {
        probeCount++;
        return probeCount === 1 ? "live" : "stale"; // start()'s probe sees it live; the watcher's re-probe sees it gone
      }),
      watchHandshakeFile: vi.fn((cb: () => void) => {
        watcherCb = cb;
        return { close: vi.fn() };
      }),
    });
    const service = new McpService(deps);
    await service.start();
    expect(service.getStatus()).toBe("not-published");

    watcherCb();
    await vi.waitFor(() => expect(service.getStatus()).toBe("listening"));
  });

  // Finding 4 (call-site half, complementing the module-scope test above):
  // a well-formed but wrong-shaped manifest file must degrade to an empty
  // tools/list rather than a `result: {}` a caller would fail iterating.
  it("finding 4: a wrong-shaped toolManifest.json (bare object, no 'tools' array) degrades to []", () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    vi.mocked(readFileSync).mockReturnValueOnce("{}" as unknown as ReturnType<typeof readFileSync>);

    const built = createDefaultMcpServiceDeps({ log });

    expect(built.toolManifest).toEqual([]);
  });

  it("finding 4: a wrong-shaped toolManifest.json (bare array) also degrades to []", () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    vi.mocked(readFileSync).mockReturnValueOnce("[]" as unknown as ReturnType<typeof readFileSync>);

    const built = createDefaultMcpServiceDeps({ log });

    expect(built.toolManifest).toEqual([]);
  });
});
