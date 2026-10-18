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
  { name: "tabbar:new", direction: "renderer->main" },
  { name: "tabbar:new-menu", direction: "renderer->main" },
  { name: "tabbar:tools-menu", direction: "renderer->main" },
  { name: "tabbar:activate", direction: "renderer->main" },
  { name: "tabbar:close", direction: "renderer->main" },
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
];

const SRC = resolve(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const source = sourceFiles(SRC)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

/** Channel names passed to any of `object.method(` calls, e.g. ipcMain.on("x"). */
function channelsFor(object: string, methods: string[]): Set<string> {
  const pattern = new RegExp(`${object}\\.(?:${methods.join("|")})\\(\\s*"([^"]+)"`, "g");
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

const mainReceives = channelsFor("ipcMain", ["on", "once", "handle"]);
const mainRemoves = channelsFor("ipcMain", ["removeListener", "removeAllListeners", "removeHandler"]);
const mainSends = channelsFor("webContents", ["send"]);
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
    expect([...handled].filter((c) => (list as string[]).includes(c) || c === "default").sort()).toEqual(list);
    for (const c of handled) if (c !== "default") expect(list, `${c} is dispatched but not in BROWSER_COMMANDS`).toContain(c);
  });

  it("the preload sends exactly the list plus closeSession", () => {
    expect([...sentByPreload].sort()).toEqual([...list, "closeSession"].sort());
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

  it("the page-driving commands are a subset of the list", () => {
    for (const c of PAGE_DRIVING_COMMANDS) expect(list).toContain(c);
  });
});
