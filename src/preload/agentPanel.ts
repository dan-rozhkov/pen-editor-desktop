import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// The agent panel's bridge (docs/canvas-link.md). The panel is not an editor
// tab: it gets the canvas link (list/open/activate/post/onMessage) and its OWN
// copy of the browser bridge, because its browser tools run here, with or
// without any canvas tab. Same `browser:command` channel; main accepts the
// panel's webContents as a browser owner. No MCP, no menu, nothing else.
//
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
    // the checkpoint holds secrets (cookies/storage), so it goes back to the
    // caller only (here: the agent panel).
    startJournal: (opts?: { origins?: string[] }): Promise<unknown> =>
      call({ command: "startJournal", args: opts }),
    stopJournal: (token?: string): Promise<unknown> =>
      call({ command: "stopJournal", args: { token } }),
    captureCheckpoint: (token?: string): Promise<unknown> =>
      call({ command: "captureCheckpoint", args: { token } }),
    // Read-only: the tab network request log since the last call ({ requests, dropped? }).
    requests: (): Promise<unknown> => call({ command: "requests", args: {} }),
    // Launches an external Electron app (an .app path) and drives it with the commands
    // above until `releaseApp`. Same `open` command as a URL open, with `app` instead of `url`.
    launchApp: (args: { app: string }): Promise<unknown> =>
      call({ command: "open", args: { app: args.app } }),
    // Quits the external desktop app this chat launched with `open({ app })` (no-op without one).
    releaseApp: (): Promise<unknown> => call({ command: "releaseApp" }),
    // macOS computer use: a running app can be controlled without a restart. Main sets the argument only when the
    // helper binary exists (computerUseAvailable); a sandboxed preload cannot import the constant, so it is a literal.
    nativeApps: process.argv.includes("--sideform-native-apps=1"),
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
  // Bring the agent's browser tab to the front (a click on a tool chip). No id = the
  // shared browser. Resolves false when there is no such tab; never creates one.
  revealAgentTab: (sessionId?: string): Promise<unknown> =>
    ipcRenderer.invoke("browser:reveal-agent-tab", { session: sessionId }),
};


// A sandboxed preload cannot import ../preload/tab.ts, so the browser bridge
// above is a copy of tab.ts's (comments aside); test/preloadBrowserBridge.test.ts
// fails if the two `makeBrowser` bodies differ, so edit both together.

const canvas = {
  listTabs: (): Promise<unknown> => ipcRenderer.invoke("canvas:list"),
  // Resolves `{ tabId, registrationId }`: the registration that resolved it.
  openTab: (opts?: { activate?: boolean }): Promise<unknown> => ipcRenderer.invoke("canvas:open", opts),
  activateTab(tabId: number): void {
    ipcRenderer.send("canvas:activate", tabId);
  },
  post(tabId: number, env: unknown): void {
    ipcRenderer.send("canvas:to-tab", { tabId, env });
  },
  onMessage(cb: (tabId: number, env: unknown) => void): () => void {
    const listener = (_e: IpcRendererEvent, msg: { tabId: number; env: unknown }) => cb(msg.tabId, msg.env);
    ipcRenderer.on("canvas:from-tab", listener);
    return () => ipcRenderer.removeListener("canvas:from-tab", listener);
  },
  onTabsChanged(cb: (tabs: unknown) => void): () => void {
    const listener = (_e: IpcRendererEvent, tabs: unknown) => cb(tabs);
    ipcRenderer.on("canvas:tabs", listener);
    return () => ipcRenderer.removeListener("canvas:tabs", listener);
  },
};

// Documents (markdown tabs at `/doc`): ask main to open or focus one. Main checks the sender.
const docs = {
  open: (docId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("doc:open", docId),
  list: (): Promise<{ docs: unknown[] } | { error: string }> => ipcRenderer.invoke("docs:list"),
  save: (doc: unknown): Promise<{ ok: true; rev: number; stale?: true } | { error: string }> => ipcRenderer.invoke("docs:save", doc),
  remove: (id: string): Promise<{ ok: true } | { error: string }> => ipcRenderer.invoke("docs:delete", id),
};

// Workflows (tabs at `/workflow`; stored in the frontend's localStorage only): ask main to open or focus one. Main checks the sender.
const workflows = {
  open: (workflowId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("workflow:open", workflowId),
};

// Browse-run traces: store a finished trace locally, open its viewer tab. Main checks the sender.
const traces = {
  save: (payload: { manifest: unknown; assets: { path: string; dataUrl: string }[] }): Promise<{ id: string } | { error: string }> =>
    ipcRenderer.invoke("traces:save", payload),
  open: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("traces:open", id),
  listTabs: (): Promise<{ tabs: { traceId: string; title: string; active: boolean }[] } | { error: string }> =>
    ipcRenderer.invoke("traces:list-tabs"),
  // `opts.frames === false` skips the frame files (no base64 over IPC). Main validates `opts`.
  read: (id: string, opts?: { frames?: boolean }): Promise<{ trace: unknown } | { error: string }> =>
    opts === undefined ? ipcRenderer.invoke("traces:read", id) : ipcRenderer.invoke("traces:read", id, opts),
};

// Desktop sign-in (src/main/desktopAuth.ts): same shape as `penDesktop.auth` in tab.ts.
// The token goes to this panel first (main picks one receiver), the panel then
// completes the exchange and tells the other views. Main checks the sender.
let listeners = 0;
const auth = {
  signIn(): void {
    ipcRenderer.send("auth:sign-in");
  },
  onToken(cb: (payload: { token: string; verifier: string }) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: { token: string; verifier: string }) => cb(payload);
    ipcRenderer.on("auth:token", listener);
    // Tells main this view can take a token (a held one is delivered now). Re-sent per subscriber;
    // main keeps a set, so the unsubscribe of the LAST one is what matters.
    listeners++;
    ipcRenderer.send("auth:listen");
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener("auth:token", listener);
      if (--listeners === 0) ipcRenderer.send("auth:unlisten");
    };
  },
};

// Settings tab (`settings:open`): `section` is one of account|appearance|canvas|agent|integrations|shortcuts; main ignores any other value.
const settings = {
  open: (section?: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("settings:open", section),
};

contextBridge.exposeInMainWorld("penAgentPanel", { version: 2, canvas, browser, docs, workflows, traces, auth, settings });

// Theme report for main (channel `panel:theme`): the page paints the stored editor theme as the
// class `dark` on <html>. Initial read on DOMContentLoaded, then a MutationObserver on that class.
// Main accepts it only from this webContents and only from the panel's own page.
if (window === window.top) {
  let lastTheme: "light" | "dark" | null = null;
  const report = () => {
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    if (theme === lastTheme) return;
    lastTheme = theme;
    ipcRenderer.send("panel:theme", theme);
  };
  document.addEventListener("DOMContentLoaded", () => {
    report();
    new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  });
}
