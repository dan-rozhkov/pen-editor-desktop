import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

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
  { name: "tabbar:activate", direction: "renderer->main" },
  { name: "tabbar:close", direction: "renderer->main" },
  { name: "mcp:register", direction: "renderer->main" },
  { name: "mcp:call", direction: "main->renderer" },
  { name: "mcp:result", direction: "renderer->main" },
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
