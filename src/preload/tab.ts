import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type UITheme = "light" | "dark";

let lastTheme: UITheme | undefined;

function publishTheme(): void {
  const theme: UITheme = document.documentElement?.classList.contains("dark") ? "dark" : "light";
  if (theme === lastTheme) return;
  lastTheme = theme;
  ipcRenderer.send("editor:theme", theme);
}

// Desktop MCP bridge (see ../main/mcp/) — the page side already shipped and
// is live in production as ../../../pen-editor/src/lib/desktopMcpBridge.ts,
// which calls window.penDesktop.registerMcpBridge({protocol, tools, onCall})
// and expects the return value to be a callable teardown function. `onCall`
// there never rejects (a handler failure resolves to a JSON `{"error"}`
// string), but this bridge tolerates a throwing/rejecting `onCall` anyway
// and reports it as a tool_error reply rather than dropping the call.
interface McpRegisterPayload {
  protocol: number;
  tools: string[];
}

interface McpCallPayload {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

interface McpResultPayload {
  callId: string;
  type: "tool_result" | "tool_error";
  result?: string;
  error?: string;
}

interface McpBridgeHandler {
  protocol: number;
  tools: string[];
  onCall(name: string, args: Record<string, unknown>): Promise<string>;
}

// Tracks the teardown of whatever registerMcpBridge() call is currently
// live, at module scope (not per-call) — the API boundary's own guard
// against a double registration (finding 6), so it holds no matter what the
// caller does. The page's own module-scoped `teardown` guard in
// desktopMcpBridge.ts already prevents a *well-behaved* caller from calling
// this twice, but the preload is the API boundary and must not depend on
// its caller: React StrictMode double-invoking an effect in dev, or HMR,
// can still land two calls here. Without this, both listeners would fire
// per `mcp:call` (a `batch_design` mutating the document twice) and two
// `mcp:result`s would go out for one `callId` (main resolves the first,
// silently drops the second) — and tearing down only one of them would drop
// main's registration for the whole tab (a bare `mcp:register` null) while
// the other listener is still live, breaking every later call with the
// "older build" upgrade error.
let activeTeardown: (() => void) | null = null;

function registerMcpBridge(handler: McpBridgeHandler): () => void {
  // Auto-teardown any still-live prior registration before installing the
  // new one, so at most one "mcp:call" listener and one active
  // "mcp:register" are ever in effect regardless of how many times this is
  // called.
  activeTeardown?.();

  const registerPayload: McpRegisterPayload = { protocol: handler.protocol, tools: handler.tools };
  ipcRenderer.send("mcp:register", registerPayload);

  const listener = (_e: IpcRendererEvent, msg: McpCallPayload) => {
    void handler
      .onCall(msg.tool, msg.args)
      .then((result) => {
        const reply: McpResultPayload = { callId: msg.callId, type: "tool_result", result };
        ipcRenderer.send("mcp:result", reply);
      })
      .catch((err: unknown) => {
        const reply: McpResultPayload = {
          callId: msg.callId,
          type: "tool_error",
          error: err instanceof Error ? err.message : String(err),
        };
        ipcRenderer.send("mcp:result", reply);
      });
  };
  ipcRenderer.on("mcp:call", listener);

  let torndown = false;
  const teardown = () => {
    if (torndown) return;
    torndown = true;
    ipcRenderer.removeListener("mcp:call", listener);
    // A `null` register payload tells main this tab is no longer bridging —
    // main's registry is keyed by webContents.id and drops/rejects any
    // in-flight calls for it (see mcp/service.ts). Reuses mcp:register
    // rather than adding a fourth channel.
    ipcRenderer.send("mcp:register", null);
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}

// Built-in browser bridge (design doc `2026-09-18-builtin-browser-design.md`
// §5) — each call is a plain request/response over "browser:command". No
// validation here: main (src/main/window.ts's "browser:command" handler,
// BrowserController) is the trust boundary and validates everything, since
// these arguments ultimately come from an LLM tool call.
// `session` undefined = the shared browser (payload identical to what it always
// was); a string = one isolated session (docs/superpowers/specs/
// 2026-10-17-isolated-parallel-browse-design.md). Main validates the id.
// `isolated(undefined)` must NOT fall back to the shared browser: the scope is a
// wrapper, so a missing/invalid id still travels as `session` and main rejects it.
const makeBrowser = (scope?: { session: unknown }) => {
  const call = (payload: { command: string; args?: unknown }): Promise<unknown> =>
    ipcRenderer.invoke("browser:command", scope === undefined ? payload : { ...payload, session: scope.session });
  return {
    open: (args: { url: string }): Promise<unknown> =>
      call({ command: "open", args }),
    act: (args: Record<string, unknown>): Promise<unknown> =>
      call({ command: "act", args }),
    findImages: (args: Record<string, unknown>): Promise<unknown> =>
      call({ command: "findImages", args }),
    // jev-loop design doc `2026-09-18-browse-task-jev-loop-design.md` §1 —
    // same "no validation here, main is the trust boundary" shape as the
    // three commands above; snapshot/perform stay loop internals reached only
    // through this preload, never offered to the model as their own penTools.
    snapshot: (): Promise<unknown> => call({ command: "snapshot" }),
    perform: (args: Record<string, unknown>): Promise<unknown> =>
      call({ command: "perform", args }),
    // QA assertions (browser-agent docs/specs/2026-10-18-qa-diagnostics-design.md
    // section 2): { checks, snapshotId? }. Read-only; same "no validation
    // here, main is the trust boundary" shape.
    assert: (args: Record<string, unknown>): Promise<unknown> =>
      call({ command: "assert", args }),
    // jev-loop design doc "Addendum 2, 2026-09-19" §2 — a readable digest of
    // the current page. Same "no validation here" shape as every other
    // command; main is the trust boundary.
    read: (args?: Record<string, unknown>): Promise<unknown> =>
      call({ command: "read", args }),
    // Full browser use (design doc `2026-09-23-full-browser-use-design.md`) —
    // same "no validation here, main is the trust boundary" shape as every
    // command above.
    screenshot: (args?: Record<string, unknown>): Promise<unknown> =>
      call({ command: "screenshot", args }),
    tabs: (args: Record<string, unknown>): Promise<unknown> =>
      call({ command: "tabs", args }),
    // browse_capture (pen-editor-backend docs/specs/2026-10-15-browse-capture-design.md):
    // the page as self-contained HTML for a canvas embed. Same "no validation
    // here" shape as every command above.
    capture: (args?: Record<string, unknown>): Promise<unknown> =>
      call({ command: "capture", args }),
    // PageFixture. `opts` (an AbortSignal) cannot cross IPC and is dropped;
    // main gates the fixture and passes allowNetworkMocks: true (desktop
    // allows mocks, scoped to browser tabs through CDP Fetch).
    applyFixture: (fixture: unknown, _opts?: unknown): Promise<unknown> =>
      call({ command: "applyFixture", args: { fixture } }),
    releaseFixture: (token?: string): Promise<unknown> =>
      call({ command: "releaseFixture", args: { token } }),
    // Ends the emulation the agent's `viewport` action set (the run end). No args.
    clearActEmulation: (): Promise<unknown> => call({ command: "clearActEmulation" }),
    // Saved logins (docs/superpowers/specs/2026-10-16-browser-saved-logins-design.md):
    // main types the stored login into the current tab's sign-in form. Only
    // { label?, submit? } leaves this preload; the result never holds a secret.
    // Only these two keys are forwarded; main validates their types.
    fillLogin: (args?: { label?: unknown; submit?: unknown }): Promise<unknown> =>
      call({
        command: "fillLogin",
        args: { label: args?.label, submit: args?.submit },
      }),
    // Checkpoint journal. startJournal resolves to the owner token (string);
    // the checkpoint holds secrets (cookies/storage), so it goes back to this
    // editor tab only.
    startJournal: (opts?: { origins?: string[] }): Promise<unknown> =>
      call({ command: "startJournal", args: opts }),
    stopJournal: (token?: string): Promise<unknown> =>
      call({ command: "stopJournal", args: { token } }),
    captureCheckpoint: (token?: string): Promise<unknown> =>
      call({ command: "captureCheckpoint", args: { token } }),
  };
};

const browser = {
  ...makeBrowser(),
  // A private browser: own cookies, tabs, fixture, journal. Same methods as
  // `browser`; every call carries the session id. Created lazily by its first
  // page command in main. Close it with `closeSession` (idempotent).
  isolated: (sessionId: string) => makeBrowser({ session: sessionId }),
  closeSession: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke("browser:command", { command: "closeSession", session: sessionId }),
};

// Canvas link (agent layout only; docs/canvas-link.md): this tab as a canvas the
// agent panel may drive. Absent without the flag, so a flag-off tab is unchanged.
const canvasHost = {
  register(): void {
    ipcRenderer.send("canvas:register");
  },
  /** Tell main this page's canvas link is gone without a navigation (it then sends `tab-gone`). */
  unregister(): void {
    ipcRenderer.send("canvas:unregister");
  },
  post(env: unknown): void {
    ipcRenderer.send("canvas:to-panel", env);
  },
  onMessage(cb: (env: unknown) => void): () => void {
    const listener = (_e: IpcRendererEvent, env: unknown) => cb(env);
    ipcRenderer.on("canvas:from-panel", listener);
    return () => ipcRenderer.removeListener("canvas:from-panel", listener);
  },
};

const api = {
  setDocumentTitle(title: string | null): void {
    ipcRenderer.send("editor:document-title", title);
  },
  onMenuCommand(cb: (commandId: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, commandId: string) => cb(commandId);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  },
  registerMcpBridge,
  browser,
  // Agent layout (main adds this argv marker to editor tabs only; the literal
  // repeats config.ts AGENT_LAYOUT_ARG, a sandboxed preload cannot import it).
  // Absent otherwise: the page cannot set argv, so this survives URL changes.
  ...(process.argv.includes("--pen-agent-layout") ? { agentLayout: true as const, canvasHost } : {}),
};

contextBridge.exposeInMainWorld("penDesktop", api);

function startThemeObserver(): void {
  const root = document.documentElement;
  if (!root) return;
  publishTheme();
  new MutationObserver(publishTheme).observe(root, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

// The editor applies its UI theme by toggling `.dark` on <html>. Observing it
// here keeps the desktop chrome in sync without coupling the web app to
// Electron-specific APIs. Preloads may run before <html> exists, so defer the
// observer while exposing the public bridge immediately.
if (document.documentElement) {
  startThemeObserver();
} else {
  window.addEventListener("DOMContentLoaded", startThemeObserver, { once: true });
}
