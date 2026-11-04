import { describe, it, expect, vi } from "vitest";
import { createAppIconIpc } from "../src/main/appIconIpc";
import type { BrowserSettingsEvent } from "../src/main/browserSettingsIpc";

const SETTINGS = "https://app.test/settings?chat=off";
const STATE = { selected: "white", options: [] };
function setup() {
  const handlers = new Map<string, (e: BrowserSettingsEvent, ...a: unknown[]) => unknown>();
  const ipcMain = { handle: (c: string, l: never) => void handlers.set(c, l), removeHandler: vi.fn((c: string) => void handlers.delete(c)) };
  const service = { state: vi.fn(() => STATE as never), set: vi.fn((id: string) => ({ ...STATE, selected: id }) as never) };
  const ipc = createAppIconIpc({ ipcMain, service });
  const main = { url: "" };
  ipc.addWindow({ isSettingsViewer: (id, url) => id === 7 && url === SETTINGS });
  const ev = (id: number, url: string | undefined, top = true): BrowserSettingsEvent => ({
    sender: { id, mainFrame: main },
    senderFrame: top ? Object.assign(main, { url }) : { url },
  });
  return { handlers, ipc, service, ev };
}

describe("app-icon IPC", () => {
  it("registers exactly the two channels", () => {
    expect([...setup().handlers.keys()].sort()).toEqual(["app-icon:get", "app-icon:set"]);
  });
  it("answers the settings page top frame", () => {
    const s = setup();
    expect(s.handlers.get("app-icon:get")!(s.ev(7, SETTINGS))).toEqual(STATE);
    expect(s.handlers.get("app-icon:set")!(s.ev(7, SETTINGS), "black")).toEqual({ ...STATE, selected: "black" });
    expect(s.service.set).toHaveBeenCalledWith("black");
  });
  it("rejects an invalid id", () => {
    const s = setup();
    for (const v of ["red", 1, null, undefined, {}]) {
      expect(s.handlers.get("app-icon:set")!(s.ev(7, SETTINGS), v)).toEqual({ error: "Invalid icon." });
    }
    expect(s.service.set).not.toHaveBeenCalled();
  });
  it("passes a save error through", () => {
    const s = setup();
    s.service.set.mockReturnValueOnce({ error: "Could not save the setting." } as never);
    expect(s.handlers.get("app-icon:set")!(s.ev(7, SETTINGS), "black")).toEqual({ error: "Could not save the setting." });
  });
  it("never throws", () => {
    const s = setup();
    s.service.state.mockImplementationOnce(() => { throw new Error("x"); });
    s.service.set.mockImplementationOnce(() => { throw new Error("x"); });
    expect(s.handlers.get("app-icon:get")!(s.ev(7, SETTINGS))).toHaveProperty("error");
    expect(s.handlers.get("app-icon:set")!(s.ev(7, SETTINGS), "black")).toHaveProperty("error");
  });
  it("denies other senders, sub-frames and other pages", () => {
    const s = setup();
    for (const e of [s.ev(8, SETTINGS), s.ev(7, "https://app.test/app"), s.ev(7, SETTINGS, false), { sender: { id: 7 }, senderFrame: null }]) {
      expect(s.handlers.get("app-icon:get")!(e as never)).toEqual({ error: "Not allowed." });
      expect(s.handlers.get("app-icon:set")!(e as never, "black")).toEqual({ error: "Not allowed." });
    }
    expect(s.service.set).not.toHaveBeenCalled();
  });
  it("a withdrawn window no longer answers; dispose removes handlers", () => {
    const s = setup();
    const off = s.ipc.addWindow({ isSettingsViewer: () => true });
    expect(s.handlers.get("app-icon:get")!(s.ev(9, "x"))).toEqual(STATE);
    off();
    expect(s.handlers.get("app-icon:get")!(s.ev(9, "x"))).toEqual({ error: "Not allowed." });
    s.ipc.dispose();
    expect(s.handlers.size).toBe(0);
  });
});
