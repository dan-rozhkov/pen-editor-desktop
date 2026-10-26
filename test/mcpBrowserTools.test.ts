import { describe, expect, it, vi } from "vitest";
import type { BrowserBridge } from "@sideform/browser-agent/loop";
import { BROWSE_AGENT_TOOL_NAMES } from "@sideform/browser-agent/agent/session";
import {
  BROWSE_MCP_TOOL_NAMES,
  browseResultToToolResult,
  isBrowseMcpTool,
  runBrowseMcpTool,
  sanitizeBrowseArgs,
} from "../src/main/mcp/browserTools";

const JPEG_URL = "data:image/jpeg;base64,QUJDRA==";

describe("browse tool names", () => {
  it("equal the package's seven browse tools", () => {
    expect([...BROWSE_MCP_TOOL_NAMES]).toEqual([...BROWSE_AGENT_TOOL_NAMES]);
  });

  it("never include the login tool", () => {
    expect(isBrowseMcpTool("browse_fill_login")).toBe(false);
    expect(isBrowseMcpTool("browse_capture")).toBe(false);
    expect(isBrowseMcpTool("get_editor_state")).toBe(false);
    expect(isBrowseMcpTool("browse_open")).toBe(true);
  });
});

describe("sanitizeBrowseArgs", () => {
  it("keeps only the properties the tool's schema declares", () => {
    expect(sanitizeBrowseArgs("browse_open", { url: "http://x", app: "Notes", repro: true, tabId: 5 })).toEqual({ url: "http://x" });
    expect(sanitizeBrowseArgs("browse_tabs", { action: "switch", tabId: 5, url: "http://x", repro: true })).toEqual({ action: "switch", tabId: 5, url: "http://x" });
    expect(sanitizeBrowseArgs("browse_act", { action: "click", index: 1, repro: true })).toEqual({ action: "click", index: 1 });
  });
  it("keeps `element` for browse_act only (the executor refuses it) and never `files`", () => {
    expect(sanitizeBrowseArgs("browse_act", { action: "click", element: "Buy", files: [{ name: "a" }] })).toEqual({ action: "click", element: "Buy" });
    expect(sanitizeBrowseArgs("browse_read", { element: "Buy" })).toEqual({});
  });
  it("filters the entries of a batch the same way", () => {
    expect(
      sanitizeBrowseArgs("browse_act", { actions: [{ action: "click", index: 1, files: [], repro: true, actions: [] }, "x"] }),
    ).toEqual({ actions: [{ action: "click", index: 1 }, "x"] });
  });
  it("keeps nothing for an unknown tool", () => {
    expect(sanitizeBrowseArgs("browse_fill_login", { url: "x" })).toEqual({});
  });
});

describe("browseResultToToolResult", () => {
  it("turns { error } into an error result", () => {
    expect(browseResultToToolResult("browse_open", JSON.stringify({ error: "Blocked." }))).toEqual({
      content: [{ type: "text", text: "Blocked." }],
      isError: true,
    });
  });

  it("passes other results through as text", () => {
    const raw = JSON.stringify({ snapshotId: "s1", elements: [] });
    expect(browseResultToToolResult("browse_snapshot", raw)).toEqual({ content: [{ type: "text", text: raw }] });
  });

  it("splits a screenshot into an image item and the other fields, without the base64", () => {
    const raw = JSON.stringify({ imageData: JPEG_URL, width: 10, height: 20, snapshotId: "s2", elements: [{ index: 0 }] });
    const result = browseResultToToolResult("browse_screenshot", raw);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: "image", data: "QUJDRA==", mimeType: "image/jpeg" });
    const text = result.content[1];
    expect(text.type).toBe("text");
    const body = (text as { text: string }).text;
    expect(body).not.toContain("QUJDRA");
    expect(body).not.toContain("imageData");
    expect(JSON.parse(body)).toEqual({ width: 10, height: 20, snapshotId: "s2", elements: [{ index: 0 }] });
  });

  it("gives only the image when a screenshot has no other field", () => {
    const result = browseResultToToolResult("browse_screenshot", JSON.stringify({ imageData: JPEG_URL }));
    expect(result.content).toHaveLength(1);
  });

  it("refuses a screenshot without a usable image", () => {
    expect(browseResultToToolResult("browse_screenshot", JSON.stringify({ width: 1 })).isError).toBe(true);
    expect(browseResultToToolResult("browse_screenshot", JSON.stringify({ imageData: "nope" })).isError).toBe(true);
    expect(browseResultToToolResult("browse_screenshot", "not json").isError).toBe(true);
  });
});

function fakeBridge(overrides: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    open: vi.fn(async () => ({ url: "http://x/", title: "X" })),
    act: vi.fn(async () => ({ ok: true })),
    findImages: vi.fn(async () => ({ images: [] })),
    read: vi.fn(async () => ({ text: "hi" })),
    snapshot: vi.fn(async () => ({ url: "http://x/", title: "X", snapshotId: "s1", elements: [] })),
    perform: vi.fn(async () => ({ ok: true })),
    screenshot: vi.fn(async () => ({ imageData: JPEG_URL, snapshotId: "s1" })),
    tabs: vi.fn(async () => ({ tabs: [] })),
    ...overrides,
  };
}

describe("runBrowseMcpTool", () => {
  it("browse_open opens the page and returns a snapshot", async () => {
    const bridge = fakeBridge();
    const result = await runBrowseMcpTool(bridge, "browse_open", { url: "http://x/" });
    expect(bridge.open).toHaveBeenCalledWith({ url: "http://x/" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.snapshot).toMatchObject({ snapshotId: "s1" });
  });

  it("browse_open ignores `app`: nothing launches", async () => {
    const bridge = fakeBridge();
    await runBrowseMcpTool(bridge, "browse_open", { url: "http://x/", app: "Notes" });
    expect(bridge.open).toHaveBeenCalledWith({ url: "http://x/" });
  });

  it.each([
    ["element only", { element: "Buy", action: "click" }],
    ["element with index null", { element: "Buy", index: null, action: "click" }],
    ["element with empty target", { element: "Buy", target: "", action: "click" }],
    ["element in a batch entry", { actions: [{ action: "click", element: "Buy", index: null }] }],
  ])("browse_act refuses %s without reaching the bridge", async (_label, args) => {
    const bridge = fakeBridge();
    const result = await runBrowseMcpTool(bridge, "browse_act", args);
    expect(result.isError).toBe(true);
    expect(bridge.act).not.toHaveBeenCalled();
    expect(bridge.perform).not.toHaveBeenCalled();
  });

  it("browse_act refuses the upload action, top level or in a batch, before the bridge", async () => {
    for (const args of [
      { action: "upload", index: 1, snapshotId: "s1", files: [{ name: "a.txt", text: "x" }] },
      { action: " Upload ", index: 1 },
      { actions: [{ action: "click", index: 0 }, { action: "upload", index: 1 }] },
    ]) {
      const bridge = fakeBridge();
      const result = await runBrowseMcpTool(bridge, "browse_act", args);
      expect(result).toEqual({ content: [{ type: "text", text: "File upload is not available over MCP." }], isError: true });
      expect(bridge.act).not.toHaveBeenCalled();
      expect(bridge.snapshot).not.toHaveBeenCalled();
    }
  });

  it("browse_act drops `files` from an allowed call", async () => {
    const bridge = fakeBridge();
    await runBrowseMcpTool(bridge, "browse_act", { action: "click", index: 1, snapshotId: "s1", files: [{ name: "a" }] });
    const sent = (bridge.act as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(sent.files).toBeUndefined();
  });

  it("browse_screenshot returns an image item", async () => {
    const result = await runBrowseMcpTool(fakeBridge(), "browse_screenshot", { annotate: true });
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });

  it("browse_tabs passes tabId to the browser", async () => {
    const bridge = fakeBridge();
    await runBrowseMcpTool(bridge, "browse_tabs", { action: "switch", tabId: 4 });
    expect(bridge.tabs).toHaveBeenCalledWith({ action: "switch", tabId: 4 });
  });

  it("turns a throwing bridge into an error result", async () => {
    const bridge = fakeBridge({ snapshot: vi.fn(async () => { throw new Error("boom"); }) });
    const result = await runBrowseMcpTool(bridge, "browse_snapshot", {});
    expect(result.isError).toBe(true);
  });
});
