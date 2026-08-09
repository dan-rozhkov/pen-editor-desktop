import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALL_TIMEOUT_MS,
  Dispatcher,
  UPGRADE_ERROR_MESSAGE,
  type DispatchTab,
  type TabRegistry,
} from "../src/main/mcp/dispatcher";

interface Call {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

class FakeTab implements DispatchTab {
  isRegistered = true;
  sent: Call[] = [];
  sendImpl: ((callId: string, tool: string, args: Record<string, unknown>) => void) | null = null;

  constructor(public readonly id: number) {}

  send(callId: string, tool: string, args: Record<string, unknown>): void {
    this.sent.push({ callId, tool, args });
    this.sendImpl?.(callId, tool, args);
  }

  lastCall(): Call {
    return this.sent[this.sent.length - 1];
  }
}

class FakeRegistry implements TabRegistry {
  tabs = new Map<number, FakeTab>();
  activeId: number | null = null;

  add(tab: FakeTab): void {
    this.tabs.set(tab.id, tab);
    if (this.activeId === null) this.activeId = tab.id;
  }

  getActiveTab(): DispatchTab | null {
    return this.activeId === null ? null : (this.tabs.get(this.activeId) ?? null);
  }

  getTab(id: number): DispatchTab | null {
    return this.tabs.get(id) ?? null;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Dispatcher", () => {
  let registry: FakeRegistry;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    registry = new FakeRegistry();
    dispatcher = new Dispatcher(registry);
  });

  it("routes a call to the active tab and resolves on tool_result", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const promise = dispatcher.callTool("get_editor_state", {});
    const call = tab.lastCall();
    expect(call.tool).toBe("get_editor_state");

    dispatcher.handleReply(tab.id, call.callId, { type: "tool_result", result: "{}" });

    await expect(promise).resolves.toEqual({ content: [{ type: "text", text: "{}" }] });
  });

  it("unwraps a resolved tool_result carrying a bridged {error} shape into isError", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const promise = dispatcher.callTool("batch_design", { operations: 'D("x")' });
    const call = tab.lastCall();
    dispatcher.handleReply(tab.id, call.callId, {
      type: "tool_result",
      result: JSON.stringify({ error: "node not found" }),
    });

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "node not found" });
  });

  it("turns a tool_error reply into an isError result", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const promise = dispatcher.callTool("get_editor_state", {});
    const call = tab.lastCall();
    dispatcher.handleReply(tab.id, call.callId, { type: "tool_error", error: "boom" });

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "boom" });
  });

  it("converts get_screenshot's data-URL result into MCP image content", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const promise = dispatcher.callTool("get_screenshot", {});
    const call = tab.lastCall();
    dispatcher.handleReply(tab.id, call.callId, {
      type: "tool_result",
      result: JSON.stringify({ imageData: "data:image/png;base64,QUJD" }),
    });

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
  });

  it("reports a screenshot error result as isError", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const promise = dispatcher.callTool("get_screenshot", {});
    const call = tab.lastCall();
    dispatcher.handleReply(tab.id, call.callId, {
      type: "tool_result",
      result: JSON.stringify({ error: "no selection" }),
    });

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "no selection" });
  });

  it("normalizes batch_design argument aliases before sending", () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    void dispatcher.callTool("batch_design", { design: 'D("x")' });
    const call = tab.lastCall();
    expect(call.args.operations).toBe('D("x")');
  });

  it("rejects (as isError, not a throw) a reply with matching callId but unrecognized type", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const promise = dispatcher.callTool("get_editor_state", {});
    const call = tab.lastCall();
    dispatcher.handleReply(tab.id, call.callId, { type: "unknown_type" });

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Unexpected reply type: unknown_type" });
  });

  it("drops (does not resolve) a reply with the right callId but the wrong tabId", async () => {
    const tabA = new FakeTab(1);
    const tabB = new FakeTab(2);
    registry.add(tabA);
    registry.add(tabB);

    const promise = dispatcher.callTool("get_editor_state", {}, tabA.id);
    const call = tabA.lastCall();

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // Tab B tries to answer tab A's call.
    dispatcher.handleReply(tabB.id, call.callId, { type: "tool_result", result: "forged" });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // The real tab settles it normally.
    dispatcher.handleReply(tabA.id, call.callId, { type: "tool_result", result: "real" });
    const result = await promise;
    expect(result.content[0]).toEqual({ type: "text", text: "real" });
  });

  it("times out after 30s with no reply, settling exactly once", async () => {
    vi.useFakeTimers();
    const tab = new FakeTab(1);
    registry.add(tab);

    const promise = dispatcher.callTool("get_editor_state", {});
    vi.advanceTimersByTime(CALL_TIMEOUT_MS);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: 'Editor did not respond to "get_editor_state" within 30000ms.',
    });

    // A late reply after timeout must not resolve/settle anything again —
    // there is nothing pending for this callId any more, so this is only
    // reachable if the map entry leaked.
    const call = tab.lastCall();
    expect(() => dispatcher.handleReply(tab.id, call.callId, { type: "tool_result", result: "late" })).not.toThrow();
  });

  it("clears the timer when send() throws synchronously", async () => {
    vi.useFakeTimers();
    const tab = new FakeTab(1);
    tab.sendImpl = () => {
      throw new Error("webContents destroyed");
    };
    registry.add(tab);

    const promise = dispatcher.callTool("get_editor_state", {});
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "webContents destroyed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects in-flight and queued calls as isError when a tab goes away", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const first = dispatcher.callTool("get_editor_state", {});
    const second = dispatcher.callTool("batch_get", {});

    dispatcher.tabGone(tab.id);

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.isError).toBe(true);
    expect(r1.content[0]).toEqual({ type: "text", text: "Editor tab disconnected mid-call." });
    expect(r2.isError).toBe(true);
    expect(r2.content[0]).toEqual({ type: "text", text: "Editor tab disconnected mid-call." });
    // The second call was queued behind the first and never sent.
    expect(tab.sent).toHaveLength(1);
  });

  it("returns the upgrade error verbatim for an unregistered tab", async () => {
    const tab = new FakeTab(1);
    tab.isRegistered = false;
    registry.add(tab);

    const result = await dispatcher.callTool("get_editor_state", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: UPGRADE_ERROR_MESSAGE });
    expect(tab.sent).toHaveLength(0);
  });

  it("returns 'No editor tab is open.' when there is no active tab", async () => {
    const result = await dispatcher.callTool("get_editor_state", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "No editor tab is open." });
  });

  it("routes an explicit tabId to that tab, or errors if it does not exist", async () => {
    const tabA = new FakeTab(1);
    const tabB = new FakeTab(2);
    registry.add(tabA);
    registry.add(tabB);

    const promise = dispatcher.callTool("get_editor_state", {}, tabB.id);
    expect(tabB.sent).toHaveLength(1);
    expect(tabA.sent).toHaveLength(0);
    dispatcher.handleReply(tabB.id, tabB.lastCall().callId, { type: "tool_result", result: "b" });
    await expect(promise).resolves.toEqual({ content: [{ type: "text", text: "b" }] });

    const missing = await dispatcher.callTool("get_editor_state", {}, 999);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toEqual({ type: "text", text: "No editor tab with id 999." });
  });

  it("serializes two queued calls FIFO on the same tab", async () => {
    const tab = new FakeTab(1);
    registry.add(tab);

    const first = dispatcher.callTool("get_editor_state", {});
    const second = dispatcher.callTool("batch_get", {});

    // Only the first call has been sent so far.
    expect(tab.sent).toHaveLength(1);
    expect(tab.sent[0].tool).toBe("get_editor_state");

    dispatcher.handleReply(tab.id, tab.sent[0].callId, { type: "tool_result", result: "first" });
    await first;
    // Let the pump's queue-advance microtask (chained via .finally on the
    // internal execute() promise) run before checking what got sent next.
    await Promise.resolve();

    // Now the second call goes out.
    expect(tab.sent).toHaveLength(2);
    expect(tab.sent[1].tool).toBe("batch_get");

    dispatcher.handleReply(tab.id, tab.sent[1].callId, { type: "tool_result", result: "second" });
    const result = await second;
    expect(result.content[0]).toEqual({ type: "text", text: "second" });
  });
});
