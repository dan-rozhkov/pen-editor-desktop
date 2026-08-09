import { randomUUID } from "node:crypto";

// Pure call-routing core for the desktop MCP bridge — no Electron import,
// so it is unit-testable without a renderer. Tabs are injected in the same
// style tabManager.ts uses elsewhere in this repo: a small handle plus a
// registry to look tabs up by id / find the active one. The concrete
// adapter wiring this to real WebContentsView/webContents.id lives in
// src/main/mcp/service.ts (Task 10, not part of this file).

export const CALL_TIMEOUT_MS = 30_000;

// Verbatim from the plan (§1) — a client-visible contract string, not
// prose to be reworded.
export const UPGRADE_ERROR_MESSAGE =
  "The Pen Editor tab is running an older build that does not support the desktop MCP bridge (needs bridge protocol >= 1, tab reported none). Restart the app to pick up the current deployed editor.";

/** A single editor tab as seen by the dispatcher. */
export interface DispatchTab {
  readonly id: number;
  /** False when the tab has not (yet, or no longer) called registerMcpBridge. */
  readonly isRegistered: boolean;
  /** Sends a tool call into the tab over IPC. May throw synchronously. */
  send(callId: string, tool: string, args: Record<string, unknown>): void;
}

/** How the dispatcher looks up tabs for routing (§3 of the plan). */
export interface TabRegistry {
  getActiveTab(): DispatchTab | null;
  getTab(id: number): DispatchTab | null;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type ToolContent = TextContent | ImageContent;

export interface ToolCallResult {
  content: ToolContent[];
  isError?: true;
}

// The wire shape a tab's reply arrives as over `mcp:result`. Mirrors
// pen-editor-backend/src/mcp/bridge.ts's WireMessage so the same failure
// modes (tool_result / tool_error / anything else) are handled identically
// on both transports.
export interface DispatchReply {
  type: string;
  result?: string;
  error?: string;
}

function textResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Copied verbatim (in behavior) from pen-editor-backend/src/mcp/server.ts:
// executeToolCall() in the page never rejects — a handler exception comes
// back as a *resolved* JSON string `{"error": "..."}`. Without this check
// that shape is reported to the MCP client as isError:false.
function bridgedErrorMessage(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof (parsed as { error: unknown }).error === "string"
  ) {
    return (parsed as { error: string }).error;
  }
  return undefined;
}

// Copied verbatim (in behavior) from server.ts's get_screenshot handler:
// the raw reply is `{ imageData: "data:<mime>;base64,<data>" } | { error }`,
// converted into MCP image content.
function screenshotResult(raw: string): ToolCallResult {
  let parsed: { imageData?: string; error?: string };
  try {
    parsed = JSON.parse(raw) as { imageData?: string; error?: string };
  } catch {
    return errorResult(`Malformed screenshot response: ${raw}`);
  }
  if (parsed.error || !parsed.imageData) {
    return errorResult(parsed.error ?? "No image returned.");
  }
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(parsed.imageData);
  if (!match) {
    return errorResult("Screenshot response was not a data URL.");
  }
  const [, mimeType, base64Data] = match;
  return { content: [{ type: "image", data: base64Data, mimeType }] };
}

// batch_design accepts several historical argument names for the same
// payload; the rest of validation already lives in the page. 5 lines, no
// zod, per §6 of the plan.
function normalizeBatchDesignArgs(args: Record<string, unknown>): Record<string, unknown> {
  const operations = args.operations ?? args.design ?? args.script ?? args.batch;
  return { ...args, operations };
}

function toResult(tool: string, reply: DispatchReply): ToolCallResult {
  if (reply.type === "tool_error") {
    return errorResult(reply.error ?? "Tool call failed");
  }
  if (reply.type !== "tool_result") {
    return errorResult(`Unexpected reply type: ${reply.type}`);
  }
  const raw = reply.result ?? "";
  if (tool === "get_screenshot") {
    return screenshotResult(raw);
  }
  const bridged = bridgedErrorMessage(raw);
  if (bridged !== undefined) return errorResult(bridged);
  return textResult(raw);
}

function pendingKey(tabId: number, callId: string): string {
  return `${tabId}:${callId}`;
}

interface QueueEntry {
  tool: string;
  args: Record<string, unknown>;
  resolve: (result: ToolCallResult) => void;
}

interface PendingCall {
  tabId: number;
  tool: string;
  timer: ReturnType<typeof setTimeout>;
  settle: (result: ToolCallResult) => void;
}

/**
 * Owns the pending-call map, the 30s timeout, and per-tab FIFO
 * serialisation for the desktop MCP bridge. Never rejects its public
 * promise — every failure mode (timeout, synchronous send() throw, tab
 * gone, unknown reply type, routing failure) resolves to an `isError`
 * ToolCallResult, matching pen-editor-backend/src/mcp/server.ts's
 * callBridged() wrapping.
 */
export class Dispatcher {
  private readonly pending = new Map<string, PendingCall>();
  private readonly queues = new Map<number, QueueEntry[]>();
  private readonly running = new Set<number>();

  constructor(private readonly registry: TabRegistry) {}

  callTool(
    tool: string,
    args: Record<string, unknown>,
    requestedTabId?: number,
  ): Promise<ToolCallResult> {
    const tab =
      requestedTabId === undefined ? this.registry.getActiveTab() : this.registry.getTab(requestedTabId);
    if (!tab) {
      const message =
        requestedTabId === undefined ? "No editor tab is open." : `No editor tab with id ${requestedTabId}.`;
      return Promise.resolve(errorResult(message));
    }
    if (!tab.isRegistered) {
      return Promise.resolve(errorResult(UPGRADE_ERROR_MESSAGE));
    }
    const normalizedArgs = tool === "batch_design" ? normalizeBatchDesignArgs(args) : args;
    return this.enqueue(tab, tool, normalizedArgs);
  }

  // Called when a tab replies over `mcp:result`. A reply whose tabId does
  // not match the tab the call was dispatched to (or whose callId is
  // unknown/stale) is dropped, not resolved — this is the security
  // property that stops tab B from answering tab A's call.
  handleReply(tabId: number, callId: string, reply: DispatchReply): void {
    const key = pendingKey(tabId, callId);
    const call = this.pending.get(key);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(key);
    call.settle(toResult(call.tool, reply));
  }

  // Called when a tab is destroyed/closed/navigated away. Rejects (as
  // isError results) the in-flight call and every call still queued behind
  // it for that tab.
  tabGone(tabId: number): void {
    for (const [key, call] of this.pending) {
      if (call.tabId !== tabId) continue;
      clearTimeout(call.timer);
      this.pending.delete(key);
      call.settle(errorResult("Editor tab disconnected mid-call."));
    }
    const queue = this.queues.get(tabId);
    if (queue) {
      this.queues.delete(tabId);
      // Index 0, if present, was the in-flight call already settled above
      // via the pending map. The rest were never sent.
      for (let i = 1; i < queue.length; i++) {
        queue[i].resolve(errorResult("Editor tab disconnected mid-call."));
      }
    }
    this.running.delete(tabId);
  }

  private enqueue(tab: DispatchTab, tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return new Promise((resolve) => {
      const entry: QueueEntry = { tool, args, resolve };
      let queue = this.queues.get(tab.id);
      if (!queue) {
        queue = [];
        this.queues.set(tab.id, queue);
      }
      queue.push(entry);
      if (!this.running.has(tab.id)) this.pump(tab);
    });
  }

  private pump(tab: DispatchTab): void {
    const queue = this.queues.get(tab.id);
    if (!queue || queue.length === 0) {
      this.running.delete(tab.id);
      return;
    }
    this.running.add(tab.id);
    const entry = queue[0];
    this.execute(tab, entry).finally(() => {
      const currentQueue = this.queues.get(tab.id);
      if (currentQueue) currentQueue.shift();
      this.pump(tab);
    });
  }

  private execute(tab: DispatchTab, entry: QueueEntry): Promise<void> {
    return new Promise<void>((done) => {
      const callId = randomUUID();
      const key = pendingKey(tab.id, callId);
      const settle = (result: ToolCallResult) => {
        this.pending.delete(key);
        entry.resolve(result);
        done();
      };
      const timer = setTimeout(() => {
        settle(errorResult(`Editor did not respond to "${entry.tool}" within ${CALL_TIMEOUT_MS}ms.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(key, { tabId: tab.id, tool: entry.tool, timer, settle });
      try {
        tab.send(callId, entry.tool, entry.args);
      } catch (err) {
        clearTimeout(timer);
        settle(errorResult(err instanceof Error ? err.message : String(err)));
      }
    });
  }
}
