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
const browser = {
  open: (args: { url: string }): Promise<unknown> =>
    ipcRenderer.invoke("browser:command", { command: "open", args }),
  act: (args: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke("browser:command", { command: "act", args }),
  findImages: (args: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke("browser:command", { command: "findImages", args }),
  // jev-loop design doc `2026-09-18-browse-task-jev-loop-design.md` §1 —
  // same "no validation here, main is the trust boundary" shape as the
  // three commands above; snapshot/perform stay loop internals reached only
  // through this preload, never offered to the model as their own penTools.
  snapshot: (): Promise<unknown> => ipcRenderer.invoke("browser:command", { command: "snapshot" }),
  perform: (args: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke("browser:command", { command: "perform", args }),
  // jev-loop design doc "Addendum 2, 2026-09-19" §2 — a readable digest of
  // the current page. Same "no validation here" shape as every other
  // command; main is the trust boundary.
  read: (args?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke("browser:command", { command: "read", args }),
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
