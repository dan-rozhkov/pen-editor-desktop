import { describe, expect, it, vi } from "vitest";
import type { BrowserBridge } from "@sideform/browser-agent/loop";
import { McpService, type McpServiceDeps } from "../src/main/mcp/service";
import type { HttpServerHandle } from "../src/main/mcp/httpServer";
import type { ToolCallResult } from "../src/main/mcp/dispatcher";
import { BROWSER_OFF_MESSAGE, NO_WINDOW_MESSAGE } from "../src/main/mcp/browserTools";

type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

async function start(overrides: Partial<McpServiceDeps> = {}) {
  let callTool!: CallTool;
  const deps: McpServiceDeps = {
    startServer: vi.fn(async (options) => {
      callTool = options.deps.callTool as CallTool;
      return { server: {} as HttpServerHandle["server"], port: 4321, close: vi.fn(async () => {}) };
    }),
    readHandshakeEntry: vi.fn(async () => null),
    writeHandshakeEntry: vi.fn(async () => true),
    removeHandshakeEntrySync: vi.fn(),
    probeOwner: vi.fn(async () => "stale" as const),
    watchHandshakeFile: vi.fn(() => ({ close: vi.fn() })),
    generateToken: vi.fn(() => "a".repeat(64)),
    toolManifest: [],
    log: { warn: vi.fn(), info: vi.fn() },
    isBrowserAllowed: () => true,
    ...overrides,
  };
  const service = new McpService(deps);
  await service.start();
  return { service, call: callTool };
}

function bridge(label: string): BrowserBridge & { snapshot: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(async () => ({ url: "http://x/", title: label })),
    act: vi.fn(async () => ({})),
    read: vi.fn(async () => ({})),
    snapshot: vi.fn(async () => ({ snapshotId: label, elements: [] })),
    perform: vi.fn(async () => ({})),
  } as BrowserBridge & { snapshot: ReturnType<typeof vi.fn> };
}

const text = (r: ToolCallResult): string => (r.content[0] as { text: string }).text;

describe("McpService browse tools", () => {
  it("routes a browse tool to the registered host", async () => {
    const { service, call } = await start();
    const host = bridge("A");
    service.registerBrowserHost(1, host);
    const result = await call("browse_snapshot", {});
    expect(host.snapshot).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text(result)).snapshotId).toBe("A");
  });

  it("answers with an error when no window is open", async () => {
    const { call } = await start();
    const result = await call("browse_snapshot", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(NO_WINDOW_MESSAGE);
  });

  it("answers with an error after the last host unregisters", async () => {
    const { service, call } = await start();
    const off = service.registerBrowserHost(1, bridge("A"));
    off();
    expect(text(await call("browse_snapshot", {}))).toBe(NO_WINDOW_MESSAGE);
  });

  it("is turned off by the mcpBrowser setting, and the host is not touched", async () => {
    let allowed = false;
    const { service, call } = await start({ isBrowserAllowed: () => allowed });
    const host = bridge("A");
    service.registerBrowserHost(1, host);
    const result = await call("browse_snapshot", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(BROWSER_OFF_MESSAGE);
    expect(host.snapshot).not.toHaveBeenCalled();
    allowed = true; // read at each call
    expect((await call("browse_snapshot", {})).isError).toBeUndefined();
  });

  it("is closed when no setting reader is injected", async () => {
    const { service, call } = await start({ isBrowserAllowed: undefined });
    service.registerBrowserHost(1, bridge("A"));
    expect(text(await call("browse_snapshot", {}))).toBe(BROWSER_OFF_MESSAGE);
  });

  it("goes to the most recently active host", async () => {
    const { service, call } = await start();
    const a = bridge("A");
    const b = bridge("B");
    service.registerBrowserHost("a", a);
    service.registerBrowserHost("b", b);
    expect(JSON.parse(text(await call("browse_snapshot", {}))).snapshotId).toBe("B");
    service.markBrowserHostActive("a");
    expect(JSON.parse(text(await call("browse_snapshot", {}))).snapshotId).toBe("A");
  });

  it("needs no editor tab", async () => {
    const { service, call } = await start();
    service.registerBrowserHost(1, bridge("A"));
    // No registerTab: an editor tool fails, a browse tool does not.
    expect((await call("get_editor_state", {})).isError).toBe(true);
    expect((await call("browse_snapshot", {})).isError).toBeUndefined();
  });
});
