import { describe, it, expect, vi } from "vitest";
import { createBrowserSettingsIpc, isSettingsSender, type BrowserSettingsEvent } from "../src/main/browserSettingsIpc";

const SETTINGS = "https://app.test/settings?chat=off";
function setup() {
  const handlers = new Map<string, (e: BrowserSettingsEvent, ...a: unknown[]) => unknown>();
  const ipcMain = { handle: (c: string, l: never) => void handlers.set(c, l), removeHandler: vi.fn((c: string) => void handlers.delete(c)) };
  const state = { adBlock: true, mcpBrowser: true };
  const store = { get: () => ({ ...state }), set: vi.fn((p: Partial<typeof state>) => Object.assign(state, p) && { ...state }) };
  const ipc = createBrowserSettingsIpc({ ipcMain, store });
  const main = { url: "" };
  const port = { isSettingsViewer: (id: number, url: string | undefined) => id === 7 && url === SETTINGS };
  ipc.addWindow(port);
  const ev = (id: number, url: string | undefined, top = true): BrowserSettingsEvent => ({
    sender: { id, mainFrame: main },
    senderFrame: top ? Object.assign(main, { url }) : { url },
  });
  return { handlers, ipc, store, ev, ipcMain, port };
}

describe("browser-settings IPC", () => {
  it("registers exactly the two channels", () => {
    expect([...setup().handlers.keys()].sort()).toEqual(["browser-settings:get", "browser-settings:set"]);
  });
  it("answers the settings page top frame", () => {
    const s = setup();
    expect(s.handlers.get("browser-settings:get")!(s.ev(7, SETTINGS))).toEqual({ adBlock: true, mcpBrowser: true });
    expect(s.handlers.get("browser-settings:set")!(s.ev(7, SETTINGS), { adBlock: false })).toEqual({ adBlock: false, mcpBrowser: true });
  });
  it("rejects a bad patch with an error and stores nothing", () => {
    const s = setup();
    const r = s.handlers.get("browser-settings:set")!(s.ev(7, SETTINGS), { adBlock: "x" }) as { error: string };
    expect(r.error).toBeTruthy();
    expect(s.store.set).not.toHaveBeenCalled();
  });
  it("answers a failed save with an error", () => {
    const s = setup();
    s.store.set.mockReturnValueOnce(null as never);
    expect(s.handlers.get("browser-settings:set")!(s.ev(7, SETTINGS), { adBlock: false })).toEqual({ error: "Could not save the setting." });
  });
  it("denies other senders, sub-frames and other pages", () => {
    const s = setup();
    for (const e of [s.ev(8, SETTINGS), s.ev(7, "https://app.test/app"), s.ev(7, SETTINGS, false), { sender: { id: 7 }, senderFrame: null }]) {
      expect(s.handlers.get("browser-settings:get")!(e as never)).toEqual({ error: "Not allowed." });
      expect(s.handlers.get("browser-settings:set")!(e as never, { adBlock: false })).toEqual({ error: "Not allowed." });
    }
    expect(s.store.set).not.toHaveBeenCalled();
  });
  it("a withdrawn window no longer answers; dispose removes handlers", () => {
    const s = setup();
    const off = s.ipc.addWindow({ isSettingsViewer: () => true });
    expect(isSettingsSender([{ isSettingsViewer: () => true }], s.ev(1, "x"))).toBe(true);
    off();
    expect(s.handlers.get("browser-settings:get")!(s.ev(9, SETTINGS))).toEqual({ error: "Not allowed." });
    s.ipc.dispose();
    expect(s.handlers.size).toBe(0);
  });
});
