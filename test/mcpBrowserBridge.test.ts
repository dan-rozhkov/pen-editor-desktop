import { describe, expect, it, vi } from "vitest";
import {
  MCP_BROWSER_COMMANDS,
  MCP_BROWSER_OWNER,
  createMcpBrowserBridge,
  isMcpBrowserCommand,
} from "../src/main/mcp/browserBridge";

describe("MCP browser commands", () => {
  it("lists exactly the commands of the seven browse tools", () => {
    expect([...MCP_BROWSER_COMMANDS].sort()).toEqual(
      ["act", "findImages", "open", "perform", "read", "screenshot", "snapshot", "tabs"].sort(),
    );
  });

  it("holds no command that handles a secret, a fixture, a journal or a session", () => {
    for (const forbidden of [
      "fillLogin",
      "applyFixture",
      "releaseFixture",
      "clearActEmulation",
      "startJournal",
      "stopJournal",
      "captureCheckpoint",
      "capture",
      "assert",
      "requests",
      "closeSession",
    ]) {
      expect(MCP_BROWSER_COMMANDS as readonly string[]).not.toContain(forbidden);
      expect(isMcpBrowserCommand(forbidden)).toBe(false);
    }
  });

  it("uses a pseudo-owner that no webContents id can equal", () => {
    expect(MCP_BROWSER_OWNER).toBeLessThan(0);
  });
});

describe("createMcpBrowserBridge", () => {
  it("maps each bridge method to its command with the arguments", async () => {
    const run = vi.fn(async (command: string, _args?: unknown) => ({ ran: command }));
    const bridge = createMcpBrowserBridge(run);
    await bridge.open({ url: "http://x" });
    await bridge.act({ action: "click" });
    await bridge.findImages?.({ limit: 3 });
    await bridge.read({ maxChars: 10 });
    await bridge.snapshot();
    await bridge.perform({ snapshotId: "s", operation: "click" });
    await bridge.screenshot?.({ annotate: true });
    await bridge.tabs?.({ action: "list" });
    expect(run.mock.calls.map((c) => c[0])).toEqual(["open", "act", "findImages", "read", "snapshot", "perform", "screenshot", "tabs"]);
    expect(run.mock.calls[0][1]).toEqual({ url: "http://x" });
    expect(run.mock.calls[6][1]).toEqual({ annotate: true });
  });

  it("has no method for app launch, capture, assert, fixtures or journals", () => {
    const bridge = createMcpBrowserBridge(async () => ({}));
    for (const name of ["launchApp", "capture", "assert", "applyFixture", "captureFixture", "releaseFixture", "startJournal", "stopJournal", "captureCheckpoint", "requests", "clearActEmulation"]) {
      expect((bridge as unknown as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
