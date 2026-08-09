import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES, handleMessage, type JsonRpcDeps, type ToolManifestEntry } from "../src/main/mcp/jsonRpc";
import type { ToolCallResult } from "../src/main/mcp/dispatcher";

const manifest: ToolManifestEntry[] = [
  { name: "get_editor_state", description: "Get the current editor state.", inputSchema: { type: "object" } },
  { name: "list_editor_tabs", description: "List open editor tabs.", inputSchema: { type: "object" } },
];

function makeDeps(overrides: Partial<JsonRpcDeps> = {}): JsonRpcDeps {
  return {
    toolManifest: manifest,
    callTool: vi.fn(async (): Promise<ToolCallResult> => ({ content: [{ type: "text", text: "ok" }] })),
    ...overrides,
  };
}

describe("handleMessage", () => {
  it("initialize echoes the client's protocolVersion and advertises tools capability", async () => {
    const deps = makeDeps();
    const res = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      deps,
    );
    expect(res?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
    });
    expect(res?.id).toBe(1);
  });

  it("initialize falls back to a default protocolVersion when the client omits one", async () => {
    const deps = makeDeps();
    const res = await handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }), deps);
    expect(typeof (res?.result as { protocolVersion?: string })?.protocolVersion).toBe("string");
  });

  it("notifications/initialized returns null", async () => {
    const deps = makeDeps();
    const res = await handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), deps);
    expect(res).toBeNull();
  });

  it("tools/list returns the manifest", async () => {
    const deps = makeDeps();
    const res = await handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), deps);
    expect(res?.result).toEqual({ tools: manifest });
  });

  it("tools/call invokes the dispatcher and returns its result", async () => {
    const callTool = vi.fn(async (): Promise<ToolCallResult> => ({ content: [{ type: "text", text: "hi" }] }));
    const deps = makeDeps({ callTool });
    const res = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_editor_state", arguments: { tabId: 1 } } }),
      deps,
    );
    expect(callTool).toHaveBeenCalledWith("get_editor_state", { tabId: 1 });
    expect(res?.result).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("ping returns an empty result", async () => {
    const deps = makeDeps();
    const res = await handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }), deps);
    expect(res?.result).toEqual({});
  });

  it("unknown method returns -32601", async () => {
    const deps = makeDeps();
    const res = await handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "nope" }), deps);
    expect(res?.error?.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
  });

  it("malformed JSON returns -32700", async () => {
    const deps = makeDeps();
    const res = await handleMessage("{not json", deps);
    expect(res?.error?.code).toBe(ERROR_CODES.PARSE_ERROR);
    expect(res?.id).toBeNull();
  });

  it("an unknown notification (no id) yields no response even if the method is unrecognized", async () => {
    const deps = makeDeps();
    const res = await handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/whatever" }), deps);
    expect(res).toBeNull();
  });
});
