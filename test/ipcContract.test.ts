import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { BROWSER_COMMANDS, PAGE_DRIVING_COMMANDS } from "../src/main/browserCommands";

/**
 * IPC channel contract. Channel names are plain strings matched at runtime by
 * Electron: rename one side and nothing throws, the message is simply never
 * delivered. Both sides always live in this repo (the editor only ever sees
 * the preload API, never a channel name), so this test scans src/ and pins
 * every channel with its direction.
 *
 * It also guards the listener-leak invariant: every ipcMain.on channel must be
 * torn down by a matching removeListener (see the comment in window.ts — every
 * close/reopen cycle otherwise leaks a listener).
 *
 * Keep this table and the "IPC channels" section of CLAUDE.md in sync.
 */
const CHANNELS: { name: string; direction: "main->renderer" | "renderer->main" }[] = [
  { name: "menu:command", direction: "main->renderer" },
  { name: "editor:document-title", direction: "renderer->main" },
  { name: "editor:theme", direction: "renderer->main" },
  { name: "tabbar:state", direction: "main->renderer" },
  { name: "tabbar:theme", direction: "main->renderer" },
  { name: "tabbar:tail", direction: "main->renderer" },
  { name: "tabbar:strip-left", direction: "main->renderer" },
  { name: "tabbar:new", direction: "renderer->main" },
  { name: "tabbar:new-browser", direction: "renderer->main" },
  { name: "tabbar:new-doc", direction: "renderer->main" },
  { name: "tabbar:new-menu", direction: "renderer->main" },
  { name: "tabbar:tools-menu", direction: "renderer->main" },
  { name: "tabbar:activate", direction: "renderer->main" },
  { name: "tabbar:close", direction: "renderer->main" },
  { name: "tabbar:reorder", direction: "renderer->main" },
  { name: "tabbar:toggle-panel", direction: "renderer->main" },
  // Agent layout: the panel preload reports its theme (class `dark` on <html>); main checks sender + page.
  { name: "panel:theme", direction: "renderer->main" },
  { name: "tabbar:navigate", direction: "renderer->main" },
  { name: "browser:command", direction: "renderer->main" },
  { name: "mcp:register", direction: "renderer->main" },
  { name: "mcp:call", direction: "main->renderer" },
  { name: "mcp:result", direction: "renderer->main" },
  // Passwords window (invoke/handle, sender-checked): saved logins, see CLAUDE.md.
  { name: "passwords:list", direction: "renderer->main" },
  { name: "passwords:add", direction: "renderer->main" },
  { name: "passwords:update", direction: "renderer->main" },
  { name: "passwords:theme", direction: "main->renderer" },
  { name: "passwords:changed", direction: "main->renderer" },
  { name: "passwords:remove", direction: "renderer->main" },
  { name: "passwords:never-remove", direction: "renderer->main" },
  // Canvas link : panel <-> canvas tabs, see CLAUDE.md "Canvas link".
  // Panel-only: bring the agent's browser tab to the front.
  { name: "browser:reveal-agent-tab", direction: "renderer->main" },
  { name: "canvas:list", direction: "renderer->main" },
  { name: "canvas:open", direction: "renderer->main" },
  // Documents: the panel or a trace tab asks main to open/focus a markdown doc tab (`/doc`).
  { name: "doc:open", direction: "renderer->main" },
  // Document storage (invoke/handle): the frontend mirrors its localStorage docs to userData. See CLAUDE.md "Document storage".
  { name: "docs:list", direction: "renderer->main" },
  { name: "docs:save", direction: "renderer->main" },
  { name: "docs:delete", direction: "renderer->main" },
  // Browse-run traces (invoke/handle): save/read stored traces, open a trace tab. See CLAUDE.md "Trace tabs".
  { name: "traces:save", direction: "renderer->main" },
  { name: "traces:read", direction: "renderer->main" },
  { name: "traces:open", direction: "renderer->main" },
  { name: "traces:list-tabs", direction: "renderer->main" },
  { name: "canvas:activate", direction: "renderer->main" },
  { name: "canvas:to-tab", direction: "renderer->main" },
  { name: "canvas:from-tab", direction: "main->renderer" },
  { name: "canvas:tabs", direction: "main->renderer" },
  { name: "canvas:register", direction: "renderer->main" },
  { name: "canvas:unregister", direction: "renderer->main" },
  { name: "canvas:to-panel", direction: "renderer->main" },
  { name: "canvas:from-panel", direction: "main->renderer" },
  // Desktop sign-in (desktopAuth.ts): a view asks main to open the system browser; main hands the
  // deep-link token (+ PKCE verifier) to ONE view. Sender-checked, see CLAUDE.md "Desktop sign-in".
  { name: "auth:sign-in", direction: "renderer->main" },
  { name: "auth:token", direction: "main->renderer" },
  // A view tells main it has an auth.onToken subscriber (listener-aware delivery); sender-checked like auth:sign-in.
  { name: "auth:listen", direction: "renderer->main" },
  { name: "auth:unlisten", direction: "renderer->main" },
];

const SRC = resolve(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Drops `//` and block comments while keeping string / template literals
 * intact, so a channel named only in a doc comment can never satisfy a scan.
 */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === "/" && n === "/") {
      while (i < code.length && code[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const codeOf = (files: string[]) => files.map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
const allFiles = sourceFiles(SRC);
const source = codeOf(allFiles);
const mainSource = codeOf(allFiles.filter((f) => f.startsWith(join(SRC, "main"))));

/** Channel names passed to any of `object.method(` calls, e.g. ipcMain.on("x"). */
function channelsFor(object: string, methods: string[], from: string = source): Set<string> {
  const pattern = new RegExp(`${object}\\.(?:${methods.join("|")})\\(\\s*"([^"]+)"`, "g");
  return new Set([...from.matchAll(pattern)].map((match) => match[1]));
}

const mainReceives = channelsFor("ipcMain", ["on", "once", "handle"]);
const mainRemoves = channelsFor("ipcMain", ["removeListener", "removeAllListeners", "removeHandler"]);
// ANY `<receiver>.send("x"` / `<receiver>?.send("x"` in main code (aliases such as `wc`
// included), comments stripped. The test below makes sure no send hides behind a
// non-literal channel.
const mainSends = new Set(
  [...mainSource.matchAll(/\??\.send\(\s*"([^"]+)"/g)].map((m) => m[1]),
);
const rendererSends = channelsFor("ipcRenderer", ["send", "invoke"]);
const rendererReceives = channelsFor("ipcRenderer", ["on", "once"]);

const byDirection = (direction: string) =>
  CHANNELS.filter((c) => c.direction === direction).map((c) => c.name).sort();

describe("IPC channel contract", () => {
  it("src/ uses exactly the pinned channel set", () => {
    const found = new Set([
      ...mainReceives,
      ...mainRemoves,
      ...mainSends,
      ...rendererSends,
      ...rendererReceives,
    ]);
    expect([...found].sort()).toEqual(CHANNELS.map((c) => c.name).sort());
  });

  it("every property send( in main code names its channel with a string literal (the scan cannot be dodged)", () => {
    // `tab.send(callId, ...)` is the MCP dispatcher's own callback (mcp/dispatcher.ts), not an IPC send.
    const nonLiteral = [...mainSource.matchAll(/(\w+)\??\.send\(\s*(?!")/g)].filter((m) => m[1] !== "tab");
    expect(nonLiteral.map((m) => m[0])).toEqual([]);
  });

  it("a channel mentioned only in a comment does not count as sent", () => {
    expect(stripComments('// x.send("fake:chan")\n/* y.send("fake:two") */ const a = "k//z"; w?.send("real:one");')).toBe(
      '\n const a = "k//z"; w?.send("real:one");',
    );
  });

  it("every main->renderer channel is sent from main and listened for in a preload", () => {
    for (const name of byDirection("main->renderer")) {
      expect(mainSends.has(name), `${name} is never sent via webContents.send`).toBe(true);
      expect(rendererReceives.has(name), `${name} has no ipcRenderer.on listener`).toBe(true);
    }
  });

  it("every renderer->main channel is sent from a preload and received by ipcMain", () => {
    for (const name of byDirection("renderer->main")) {
      expect(rendererSends.has(name), `${name} is never sent via ipcRenderer.send`).toBe(true);
      expect(mainReceives.has(name), `${name} has no ipcMain listener`).toBe(true);
    }
  });

  it("channels do not flow in the direction they are not declared for", () => {
    for (const name of byDirection("main->renderer")) {
      expect(rendererSends.has(name), `${name} is declared main->renderer`).toBe(false);
      expect(mainReceives.has(name), `${name} is declared main->renderer`).toBe(false);
    }
    for (const name of byDirection("renderer->main")) {
      expect(mainSends.has(name), `${name} is declared renderer->main`).toBe(false);
      expect(rendererReceives.has(name), `${name} is declared renderer->main`).toBe(false);
    }
  });

  it("every ipcMain listener is torn down again (window close/reopen must not leak)", () => {
    const leaked = [...mainReceives].filter((name) => !mainRemoves.has(name));
    expect(leaked).toEqual([]);
  });
});

describe("browser:command commands", () => {
  // `browser:command` is one channel carrying many commands, so the channel scan
  // above cannot see a command added on one side only. One list
  // (src/main/browserCommands.ts) must agree with the dispatch switch in
  // window.ts, the preload, and the session planner.
  const windowSource = readFileSync(join(SRC, "main/window.ts"), "utf8");
  const handled = new Set([...windowSource.matchAll(/^\s*case "(\w+)":/gm)].map((m) => m[1]));
  const preload = readFileSync(join(SRC, "preload/tab.ts"), "utf8");
  const sentByPreload = new Set([...preload.matchAll(/command: "(\w+)"/g)].map((m) => m[1]));
  const list = [...BROWSER_COMMANDS].sort();

  it("window.ts dispatches exactly the commands in the list", () => {
    // releaseApp is routed by planAppCommand (plan "release"), not by a switch case.
    expect(windowSource).toContain('plan === "release"');
    const dispatched = list.filter((c) => c !== "releaseApp");
    expect([...handled].filter((c) => (list as string[]).includes(c) || c === "default").sort()).toEqual(dispatched);
    for (const c of handled) if (c !== "default") expect(list, `${c} is dispatched but not in BROWSER_COMMANDS`).toContain(c);
  });

  it("the preload sends exactly the list plus closeSession", () => {
    expect([...sentByPreload].sort()).toEqual([...list, "closeSession"].sort());
  });

  it("the agent panel preload carries its own browser bridge with the very same command set", () => {
    const panelPreload = readFileSync(join(SRC, "preload/agentPanel.ts"), "utf8");
    const sentByPanel = new Set([...panelPreload.matchAll(/command: "(\w+)"/g)].map((m) => m[1]));
    expect([...sentByPanel].sort()).toEqual([...sentByPreload].sort());
    expect(panelPreload).toContain("session: scope.session");
    expect(panelPreload).toContain("isolated: (sessionId: string) => makeBrowser");
  });

  it("assert (QA checks) is wired end to end: list, page-driving, dispatch, preload, shared and isolated", () => {
    expect(list).toContain("assert");
    expect(PAGE_DRIVING_COMMANDS.has("assert")).toBe(true);
    expect(windowSource).toMatch(/case "assert":\s+return await controller\.assert\(payload\.args\)/);
    expect(sentByPreload.has("assert")).toBe(true);
  });

  it("closeSession is handled in window.ts and the payload carries `session`", () => {
    expect(windowSource).toContain('payload.command === "closeSession"');
    expect(preload).toContain("session: scope.session");
  });

  it("both preloads expose launchApp (open with { app }) and releaseApp as the desktop-app capability", () => {
    const panelPreload = readFileSync(join(SRC, "preload/agentPanel.ts"), "utf8");
    for (const src of [preload, panelPreload]) {
      expect(src).toMatch(/launchApp: \(args: \{ app: string \}\)[^;]*\s+call\(\{ command: "open", args: \{ app: args\.app \} \}\)/);
      expect(src).toContain('releaseApp: (): Promise<unknown> => call({ command: "releaseApp" })');
    }
  });

  it("the page-driving commands are a subset of the list", () => {
    for (const c of PAGE_DRIVING_COMMANDS) expect(list).toContain(c);
  });
});

describe("requests is passive and wired through the run boundary", () => {
  const src = readFileSync(join(SRC, "main/window.ts"), "utf8");
  it("skips dialog sweep, in-flight bracket and run boundary, but a new run clears the request logs", () => {
    expect(src).toContain('const passive = payload.command === "requests"');
    expect(src).toMatch(/passive \? null : tabs\.currentBrowserTabId/);
    expect(src).toContain("if (!passive) commandsInFlight.inc(sessionId)");
    expect(src).toContain("if (!passive) commandsInFlight.dec(sessionId)");
    expect(src).toMatch(/!passive && runBoundary\.commandStart\(runScope\)\) \{\s+clearScopeDiagnostics\(sessionId\);\s+clearScopeRequestLogs\(sessionId\);/);
  });
  it("clearDiagnostics leaves the request log alone", () => {
    const m = src.match(/clearDiagnostics: \(\) => \{([\s\S]*?)\n        \},/);
    expect(m?.[1]).not.toContain("requestLog");
    expect(src).toContain("clearRequestLog: () => requestLog.clear()");
  });
  it("the target drains closed-tab requests, filled on destroy and on debugger detach", () => {
    expect(src).toContain("drainClosedRequests: () => closedRequestsOf(scope).drain()");
    expect(src.match(/closedRequestsOf\(sessionId\)\.add\(requestLog\.takeFinished\(\)\)/g)).toHaveLength(2);
  });
});
