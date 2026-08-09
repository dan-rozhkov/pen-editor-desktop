// App-scoped owner of the desktop MCP bridge: the HTTP server, the token,
// handshake-file ownership state, and the tab registry the dispatcher routes
// calls through. Deliberately Electron-free (no `import ... from "electron"`)
// so it is unit-testable under plain Node/vitest — requiring the "electron"
// package outside the Electron runtime returns a path string, not the API
// (see test/service.test.ts), so any real ipcMain/webContents wiring has to
// live in src/main/index.ts and src/main/window.ts instead, adapted through
// the small interfaces below. This mirrors dispatcher.ts's own tabs-injected
// style.
//
// "App-scoped, not window-scoped" (see design doc §Task 10): on macOS,
// closing the last window does not quit the app (index.ts reopens one on
// "activate"), so a server owned by a window would die and never come back.
// A single McpService instance is created once in index.ts and outlives any
// number of window open/close cycles; window.ts only *reports* tab
// create/destroy/activate into it via registerTab/unregisterTab/setActiveTab.

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { watch } from "node:fs";
import { join } from "node:path";
import type { McpStatus } from "../tabManager";
import {
  generateAutoToken,
  getHandshakePath,
  probeHandshakeOwner,
  removeHandshakeFileSync,
  writeHandshakeFile,
  type HandshakeFileEntry,
  type WarnLogger,
} from "./handshake";
import { startHttpServer, type HttpServerHandle, type HttpServerOptions } from "./httpServer";
import {
  Dispatcher,
  type DispatchTab,
  type TabRegistry,
  type DispatchReply,
  type ToolCallResult,
} from "./dispatcher";
import type { ToolManifestEntry } from "./jsonRpc";

export type { McpStatus };

/** How service.ts sends a call into a tab and learns whether its view is gone — window.ts adapts a real WebContentsView's webContents to this shape. Kept minimal and Electron-free on purpose. */
export interface TabHandle {
  sendMcpCall(callId: string, tool: string, args: Record<string, unknown>): void;
  isDestroyed(): boolean;
}

/**
 * How index.ts/window.ts wire the two app-scoped `mcp:*` ipcMain listeners
 * in — kept as an injected interface (rather than McpService importing
 * "electron" directly) for the same reason as TabHandle above: requiring
 * "electron" outside the Electron runtime doesn't yield the API, so this
 * boundary is what keeps registerAppLevelIpc/teardownAppLevelIpc unit
 * testable. The real implementation (see window.ts) wraps literal
 * `ipcMain.on("mcp:register", ...)` / `ipcMain.on("mcp:result", ...)` calls
 * — kept literal there, not templated by channel name, so
 * test/ipcContract.test.ts's mechanical source scan (which only recognizes
 * `object.method("literal-string"`) can see them.
 */
export interface IpcListenerGateway {
  on(channel: "mcp:register" | "mcp:result", listener: (senderId: number, payload: unknown) => void): void;
  removeListener(channel: "mcp:register" | "mcp:result", listener: (senderId: number, payload: unknown) => void): void;
}

/** Loose runtime shape-check for the `mcp:register` IPC payload (renderer input — never trust the shape). */
function isRegisterPayload(payload: unknown): payload is { protocol: number; tools: string[] } {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { protocol?: unknown; tools?: unknown };
  return typeof p.protocol === "number" && Array.isArray(p.tools) && p.tools.every((t) => typeof t === "string");
}

/** Loose runtime shape-check for the `mcp:result` IPC payload. */
function isResultPayload(
  payload: unknown,
): payload is { callId: string; type: string; result?: string; error?: string } {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { callId?: unknown; type?: unknown; result?: unknown; error?: unknown };
  if (typeof p.callId !== "string" || typeof p.type !== "string") return false;
  if (p.result !== undefined && typeof p.result !== "string") return false;
  if (p.error !== undefined && typeof p.error !== "string") return false;
  return true;
}

interface TabRecord {
  handle: TabHandle;
  isRegistered: boolean;
  title: string;
}

export interface McpServiceDeps {
  startServer(options: Pick<HttpServerOptions, "token" | "deps" | "port" | "host">): Promise<HttpServerHandle>;
  /** Reads and parses the handshake file; null for missing/corrupt (never throws). */
  readHandshakeEntry(): Promise<HandshakeFileEntry | null>;
  /** Returns whether the write actually landed — see writeHandshakeFile's own doc comment (finding 1). */
  writeHandshakeEntry(entry: HandshakeFileEntry): Promise<boolean>;
  removeHandshakeEntrySync(entry: HandshakeFileEntry): void;
  probeOwner(entry: HandshakeFileEntry): Promise<"live" | "stale">;
  /** Returns null if the watch could not be established (e.g. unsupported FS); best-effort only. */
  watchHandshakeFile(onChange: () => void): { close(): void } | null;
  generateToken(): string;
  toolManifest: ToolManifestEntry[];
  log: WarnLogger;
}

function defaultLogger(): WarnLogger {
  return {
    warn: (msg) => console.warn(msg),
    info: (msg) => console.log(msg),
  };
}

async function readHandshakeEntryFromDisk(): Promise<HandshakeFileEntry | null> {
  try {
    const raw = await readFile(getHandshakePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<HandshakeFileEntry>;
    if (typeof parsed.url === "string" && typeof parsed.token === "string" && typeof parsed.port === "number") {
      return { url: parsed.url, token: parsed.token, port: parsed.port };
    }
    return null; // well-formed JSON, wrong shape — treated as corrupt (§5: publish ours)
  } catch {
    return null; // ENOENT, permission error, or invalid JSON — all "missing/corrupt" per §5
  }
}

// toolManifest.json is copied to dist/main/mcp/ alongside the compiled
// service.js by the `copy-static` script (see package.json) — read via
// readFileSync + JSON.parse against __dirname rather than a TS `import ...
// json`, since this repo's tsconfig does not set resolveJsonModule and the
// runtime file only exists post-build anyway (mirrors how toolManifest.json
// reaches dist/ at all).
// Never throws: this runs at McpService construction time, which in
// index.ts happens at module scope, before app.whenReady() is even called.
// MCP is a background convenience — a missing/corrupt manifest (e.g.
// copy-static hasn't run yet, or a bad packaged build) must degrade to an
// empty tools/list, not prevent the app from opening a window at all (see
// index.ts's own comment on the same failure mode).
function loadToolManifest(log: WarnLogger): ToolManifestEntry[] {
  try {
    const raw = readFileSync(join(__dirname, "toolManifest.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    // JSON.parse succeeding is not enough — a well-formed but wrong-shaped
    // file (a bare `{}`, or a bare array instead of `{tools: [...]}`) must
    // still degrade to an empty list (finding 4), not silently produce
    // `parsed.tools === undefined` (which `tools/list` would then answer as
    // `result: {}`, and any consumer iterating it would throw).
    const tools = (parsed as { tools?: unknown } | null)?.tools;
    return Array.isArray(tools) ? (tools as ToolManifestEntry[]) : [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[mcp] failed to load tool manifest — MCP tools/list will report no tools: ${message}`);
    return [];
  }
}

export function createDefaultMcpServiceDeps(overrides: Partial<McpServiceDeps> = {}): McpServiceDeps {
  const log = overrides.log ?? defaultLogger();
  return {
    startServer: (options) => startHttpServer(options),
    readHandshakeEntry: readHandshakeEntryFromDisk,
    writeHandshakeEntry: (entry) => writeHandshakeFile(entry, log),
    removeHandshakeEntrySync: (entry) => removeHandshakeFileSync(entry, log),
    probeOwner: (entry) => probeHandshakeOwner(entry),
    watchHandshakeFile: (onChange) => {
      try {
        return watch(getHandshakePath(), { persistent: false }, () => onChange());
      } catch {
        return null;
      }
    },
    generateToken: generateAutoToken,
    toolManifest: loadToolManifest(log),
    log,
    ...overrides,
  };
}

const NOT_PUBLISHED_DETAIL =
  "Another local MCP server is already running; this app is not publishing its own endpoint.";

// Deliberately generic — same rule as NOT_PUBLISHED_DETAIL: never echo the
// raw OS error (which could in principle contain a path or port) into
// anything the tabbar/menu render. The real message still reaches the
// (developer-only) log via deps.log.warn at the point of failure.
const BIND_FAILED_DETAIL =
  "Failed to start the local MCP server. Try \"Use this app for MCP\" from the menu to retry, or restart the app.";
const WRITE_FAILED_DETAIL =
  "Could not write the local handshake file, so the plugin will not discover this app. Check that ~/.pen-editor is writable, then try \"Use this app for MCP\" from the menu to retry.";

/**
 * Owns the loopback MCP server, the handshake-ownership state machine (§5 of
 * the design doc), and the tab registry the dispatcher routes calls through.
 * One instance per app lifetime — see the file header.
 */
export class McpService implements TabRegistry {
  private readonly tabs = new Map<number, TabRecord>();
  private activeTabId: number | null = null;
  private readonly dispatcher = new Dispatcher(this);
  private server: HttpServerHandle | null = null;
  private entry: HandshakeFileEntry | null = null; // our own {url, token, port} once minted
  private status: McpStatus = "off";
  private statusDetail: string | undefined;
  // Set true by stop(), false at the top of start(). start()/publish() check
  // it at every await boundary so a stop() that lands mid-startup (quitting
  // while probeHandshakeOwner's 1500ms probe is in flight, per index.ts's own
  // comment on that window) tears down whatever start() goes on to bind or
  // write instead of leaving an orphaned socket/handshake file behind
  // (finding 2).
  private stopped = false;
  private watcher: { close(): void } | null = null;
  private readonly statusListeners = new Set<() => void>();
  private ipcGateway: IpcListenerGateway | null = null;
  private readonly onRegisterListener = (senderId: number, payload: unknown) => this.handleRegister(senderId, payload);
  private readonly onResultListener = (senderId: number, payload: unknown) => this.handleResult(senderId, payload);

  constructor(private readonly deps: McpServiceDeps) {}

  /**
   * Registers the two app-scoped `mcp:*` ipcMain listeners exactly once for
   * this service's lifetime, no matter how many times it's called — the
   * repo's listener-leak invariant (see CLAUDE.md's IPC section) requires
   * these live at app level, not per window, since macOS window close/reopen
   * (index.ts) must not re-register them. Idempotent so callers (window.ts,
   * on every createMainWindow) don't need their own bookkeeping to avoid a
   * second window re-attaching the same listeners.
   */
  registerAppLevelIpc(gateway: IpcListenerGateway): void {
    if (this.ipcGateway) return;
    this.ipcGateway = gateway;
    gateway.on("mcp:register", this.onRegisterListener);
    gateway.on("mcp:result", this.onResultListener);
  }

  /** app.on("will-quit"): undo registerAppLevelIpc. No-op if never registered. */
  teardownAppLevelIpc(): void {
    if (!this.ipcGateway) return;
    this.ipcGateway.removeListener("mcp:register", this.onRegisterListener);
    this.ipcGateway.removeListener("mcp:result", this.onResultListener);
    this.ipcGateway = null;
  }

  // --- TabRegistry (consumed by Dispatcher) ---

  getActiveTab(): DispatchTab | null {
    return this.activeTabId === null ? null : this.getTab(this.activeTabId);
  }

  getTab(id: number): DispatchTab | null {
    const rec = this.tabs.get(id);
    if (!rec) return null;
    return {
      id,
      isRegistered: rec.isRegistered,
      send: (callId, tool, args) => {
        if (rec.handle.isDestroyed()) throw new Error("Editor tab is gone.");
        rec.handle.sendMcpCall(callId, tool, args);
      },
    };
  }

  // --- reported by window.ts as tabs come and go ---

  registerTab(id: number, handle: TabHandle): void {
    this.tabs.set(id, { handle, isRegistered: false, title: "Untitled" });
  }

  /** window.ts forwards editor:document-title here, keyed by the same webContents id list_editor_tabs reports. */
  setTabTitle(id: number, title: string): void {
    const rec = this.tabs.get(id);
    if (rec) rec.title = title;
  }

  /** Tab closed/destroyed: drop the registration and reject in-flight/queued calls for it. */
  unregisterTab(id: number): void {
    if (!this.tabs.delete(id)) return;
    if (this.activeTabId === id) this.activeTabId = null;
    this.dispatcher.tabGone(id);
  }

  /** Main-frame navigation reloads the page, so any prior registerMcpBridge() is gone until the new page re-registers. */
  handleTabNavigated(id: number): void {
    const rec = this.tabs.get(id);
    if (!rec || !rec.isRegistered) return;
    rec.isRegistered = false;
    this.dispatcher.tabGone(id);
  }

  setActiveTab(id: number | null): void {
    this.activeTabId = id;
  }

  // --- IPC payload handlers (index.ts wires real ipcMain.on(...) listeners into these) ---

  handleRegister(senderId: number, payload: unknown): void {
    const rec = this.tabs.get(senderId);
    // Identity: only a webContents id this service itself registered via
    // registerTab() (i.e. an editor tab window.ts actually created) is
    // accepted — mirrors window.ts's `fromOurTabbar` check for the tabbar
    // channels. An unknown sender (e.g. the tabbar view, or a stale id) is
    // silently ignored, so a page cannot register "on behalf of" another tab.
    if (!rec) return;
    if (payload === null) {
      // Bridge teardown from the page side (see preload/tab.ts) — same
      // effect as a navigation: registration drops, in-flight calls reject.
      rec.isRegistered = false;
      this.dispatcher.tabGone(senderId);
      return;
    }
    if (!isRegisterPayload(payload)) return;
    rec.isRegistered = true;
  }

  handleResult(senderId: number, payload: unknown): void {
    if (!this.tabs.has(senderId)) return;
    if (!isResultPayload(payload)) return;
    const reply: DispatchReply = { type: payload.type, result: payload.result, error: payload.error };
    // Dispatcher.handleReply is keyed by (tabId, callId) together, so a
    // reply whose senderId doesn't match the tab the call was dispatched to
    // is dropped rather than resolved — this is what stops tab B from
    // answering tab A's call (see dispatcher.ts's handleReply comment).
    this.dispatcher.handleReply(senderId, payload.callId, reply);
  }

  // --- MCP tool dispatch (the function handed to startHttpServer as JsonRpcDeps.callTool) ---

  /**
   * Entry point for every `tools/call`. Handles `list_editor_tabs` itself
   * (main already has every title via editor:document-title — no page
   * round-trip, per §3 of the design doc) and otherwise strips the routing
   * `tabId` out of the arguments before handing the rest to the dispatcher,
   * so it never reaches the page as a bogus tool argument.
   *
   * **Id space:** the `tabId` values here are exactly this.tabs's keys —
   * webContents ids, the same space Dispatcher/getTab/registerTab all use.
   * TabManager's own sequential tab ids (TabsSnapshot.activeId) never enter
   * this class at all, so list_editor_tabs and tabId routing cannot
   * diverge into two different id spaces by construction.
   */
  private callTool(tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (tool === "list_editor_tabs") {
      return Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ tabs: this.listTabs() }) }] });
    }
    const { tabId, ...rest } = args;
    const requestedTabId = typeof tabId === "number" ? tabId : undefined;
    return this.dispatcher.callTool(tool, rest, requestedTabId);
  }

  private listTabs(): { tabId: number; title: string; active: boolean; mcpReady: boolean }[] {
    return [...this.tabs.entries()].map(([tabId, rec]) => ({
      tabId,
      title: rec.title,
      active: tabId === this.activeTabId,
      mcpReady: rec.isRegistered,
    }));
  }

  // --- status ---

  getStatus(): McpStatus {
    return this.status;
  }

  /** Human tooltip/detail text for the current status (undefined for "listening"/"off"). Deliberately contains no port/token, ever — see CLAUDE.md's IPC section on what may cross to the tabbar renderer. */
  getStatusDetail(): string | undefined {
    return this.statusDetail;
  }

  onStatusChanged(cb: () => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /** `detail` is stored unconditionally (even when `status` itself doesn't change) so a same-status transition with a different reason — e.g. re-probing after a write failure — still updates what getStatusDetail() reports. Listeners are only renotified on an actual status change. */
  private setStatus(status: McpStatus, detail?: string): void {
    const changed = status !== this.status;
    this.status = status;
    this.statusDetail = detail;
    if (changed) {
      for (const cb of this.statusListeners) cb();
    }
  }

  // --- lifecycle ---

  /** app.whenReady(): bind → probe → publish or not (§5). Also the retry path forcePublish() uses when the previous start() never got as far as binding a server (finding 3) — safe to call again since it fully re-derives token/entry/status from scratch. */
  async start(): Promise<void> {
    this.stopped = false;
    const token = this.deps.generateToken();
    let server: HttpServerHandle;
    try {
      server = await this.deps.startServer({
        token,
        deps: { toolManifest: this.deps.toolManifest, callTool: (name, args) => this.callTool(name, args) },
      });
    } catch (err) {
      if (this.stopped) return; // nothing bound — nothing to clean up
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn(`[mcp] failed to bind the local MCP server: ${message}`);
      // Visible on purpose (never "off", which the tabbar hides entirely
      // via .mcp-status--off{display:none}) — this is the one failure mode
      // "Use this app for MCP" previously did nothing about at all, per
      // finding 3: this.entry stays null, so forcePublish() below retries
      // start() itself rather than silently no-op'ing.
      this.setStatus("error", BIND_FAILED_DETAIL);
      return;
    }
    if (this.stopped) {
      // stop() ran while startServer() was still pending — it saw
      // this.server still null and had nothing to close itself.
      void server.close();
      return;
    }
    this.server = server;
    this.entry = { url: `http://127.0.0.1:${server.port}/api/mcp`, token, port: server.port };

    const existing = await this.deps.readHandshakeEntry();
    if (this.stopped) return; // stop() already saw this.server set and closed it itself
    if (!existing) {
      await this.publish(this.entry);
      return;
    }
    const owner = await this.deps.probeOwner(existing);
    if (this.stopped) return;
    if (owner === "stale") {
      await this.publish(this.entry);
      return;
    }
    this.deps.log.warn(`[mcp] not publishing: another MCP server is already live on port ${existing.port}.`);
    this.setStatus("not-published", NOT_PUBLISHED_DETAIL);
    this.startWatcher();
  }

  /**
   * "Use this app for MCP" menu action (§5.3) — the *only* remedy the UI
   * offers (finding 3). Two cases:
   *  - We have our own entry (a live not-published state, or a prior
   *    successful bind whose handshake write failed): force-publish it.
   *  - We never got that far at all (start() rejected — bind failure): retry
   *    start() from scratch instead of silently doing nothing.
   */
  async forcePublish(): Promise<void> {
    if (!this.entry) {
      await this.start();
      return;
    }
    await this.publish(this.entry);
  }

  /** app.on("will-quit"): remove the handshake file (only if we still own it) and stop the server. Synchronous, per removeHandshakeFileSync's own contract — will-quit does not reliably await a promise. */
  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.status === "listening" && this.entry) {
      this.deps.removeHandshakeEntrySync(this.entry);
    }
    this.setStatus("off");
    this.entry = null;
    const server = this.server;
    this.server = null;
    if (server) void server.close();
  }

  private async publish(entry: HandshakeFileEntry): Promise<boolean> {
    const wrote = await this.deps.writeHandshakeEntry(entry);
    if (this.stopped) {
      // stop() ran while the write was in flight. Status was still "off"
      // or "not-published" at that point (setStatus("listening") below
      // hadn't run yet), so stop()'s own `status === "listening"` guard
      // didn't remove anything — if the write landed anyway, undo it here
      // so no handshake file survives pointing at a port that's already
      // closed (finding 2). The server itself was already closed by stop()
      // (this.server was set before publish() is ever called).
      if (wrote) this.deps.removeHandshakeEntrySync(entry);
      return false;
    }
    if (!wrote) {
      // Finding 1: a swallowed write failure must never report "listening"
      // — the plugin has nothing to discover, and the indicator is the only
      // way a packaged user would ever learn that.
      this.setStatus("error", WRITE_FAILED_DETAIL);
      return false;
    }
    this.setStatus("listening");
    // Not startWatcher(): writeHandshakeEntry (handshake.ts's
    // writeHandshakeFile) publishes via rename() over the target, which
    // unlinks whatever inode a pre-existing watcher (e.g. one created by
    // start()'s not-published path, watching the *backend's* file) is bound
    // to. startWatcher()'s "already have one" guard would otherwise leave
    // that now-dead watcher in place and §5.4's clobber detection would
    // never fire again after a force-publish.
    this.restartWatcher();
    return true;
  }

  private startWatcher(): void {
    if (this.watcher) return;
    this.watcher = this.deps.watchHandshakeFile(() => void this.onHandshakeFileChanged());
  }

  private restartWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.startWatcher();
  }

  private async onHandshakeFileChanged(): Promise<void> {
    if (this.status === "listening") {
      // If a backend clobbers our entry, notice and flip to not-published
      // rather than fighting a write war (§5.4).
      if (!this.entry) return;
      const current = await this.deps.readHandshakeEntry();
      if (!current || current.token !== this.entry.token || current.port !== this.entry.port) {
        this.deps.log.warn("[mcp] handshake file was overwritten by another process; no longer publishing.");
        this.setStatus("not-published", NOT_PUBLISHED_DETAIL);
      }
      return;
    }
    if (this.status === "not-published") {
      // Finding 5: the watcher set up by start()'s not-published branch was
      // previously dead code — this is the only place it could ever fire
      // from, and until now this branch didn't exist, so losing a
      // competing owner (it exits and deletes mcp.json, or stops
      // responding) left this app stuck amber forever even though nothing
      // owns the endpoint any more. Re-check and reclaim automatically,
      // the same liveness test start() itself uses.
      if (!this.entry) return; // never bound our own server — nothing to publish
      const current = await this.deps.readHandshakeEntry();
      if (!current) {
        await this.publish(this.entry);
        return;
      }
      const owner = await this.deps.probeOwner(current);
      if (owner === "stale") {
        await this.publish(this.entry);
      }
    }
  }
}

export function createMcpService(overrides: Partial<McpServiceDeps> = {}): McpService {
  return new McpService(createDefaultMcpServiceDeps(overrides));
}
