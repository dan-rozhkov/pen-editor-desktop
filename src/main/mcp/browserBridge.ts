// The built-in browser as external MCP clients see it. Pure and Electron-free: window.ts supplies
// `run`, the shared-scope dispatch of `runBrowserCommand`; this file decides which commands may
// reach it and under which owner id.
import type { BrowserBridge } from "@sideform/browser-agent/loop";

/**
 * Pseudo-owner id of every MCP browser command. Real owners are webContents ids (always > 0), so -1
 * never matches an editor tab or the agent panel: it owns no fixture and no journal, and a
 * page-changing MCP command ends a journal a tab still runs (`journalOwners.beforeCommand`).
 */
export const MCP_BROWSER_OWNER = -1;

/**
 * The only `browser:command` commands an MCP client can reach, one per `BrowserBridge` method that
 * the seven browse tools use. Pinned by test: no `fillLogin` (a password must never reach a client),
 * no fixtures, journals, checkpoints, `capture`, `assert`, `requests` or `closeSession`.
 */
export const MCP_BROWSER_COMMANDS = ["open", "act", "findImages", "read", "snapshot", "perform", "screenshot", "tabs"] as const;

export type McpBrowserCommand = (typeof MCP_BROWSER_COMMANDS)[number];

export function isMcpBrowserCommand(command: string): command is McpBrowserCommand {
  return (MCP_BROWSER_COMMANDS as readonly string[]).includes(command);
}

/** Runs one command against the shared browser as `MCP_BROWSER_OWNER`. */
export type McpBrowserRunner = (command: McpBrowserCommand, args: unknown) => Promise<unknown>;

/**
 * A `BrowserBridge` over `run`. It has no `launchApp`, `capture`, `assert`, fixture or journal
 * method, so the executor cannot reach those even by a crafted tool input. A command outside
 * `MCP_BROWSER_COMMANDS` is refused here too (belt and braces: `run` may be wider).
 */
export function createMcpBrowserBridge(run: McpBrowserRunner): BrowserBridge {
  const call = async (command: McpBrowserCommand, args?: unknown): Promise<unknown> => {
    if (!isMcpBrowserCommand(command)) return { error: "This browser command is not available over MCP." };
    return await run(command, args);
  };
  return {
    open: (args) => call("open", args),
    act: (args) => call("act", args),
    findImages: (args) => call("findImages", args),
    read: (args) => call("read", args),
    snapshot: () => call("snapshot"),
    perform: (args) => call("perform", args),
    screenshot: (args) => call("screenshot", args),
    tabs: (args) => call("tabs", args),
  };
}
