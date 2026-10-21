import { describe, expect, it, vi } from "vitest";
import { createPasswordsService, type PasswordsContents } from "../src/main/passwordsService";
import { createCredentialStore } from "../src/main/browser/credentialStore";

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;

function makeStore() {
  const files = new Map<string, string>();
  return createCredentialStore({
    filePath: "/db.json",
    cipher: { isAvailable: () => true, encrypt: (p) => Buffer.from(`x${p}`), decrypt: (b) => b.toString().slice(1) },
    fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
  });
}

function makeContents(id: number) {
  let loaded: (() => void) | undefined;
  let destroyed: (() => void) | undefined;
  let isDestroyed = false;
  const send = vi.fn();
  const sendTheme = (p: { theme: string }) => send("passwords:theme", p);
  const sendChanged = () => send("passwords:changed");
  const c: PasswordsContents = {
    id,
    isDestroyed: () => isDestroyed,
    sendTheme,
    sendChanged,
    onLoaded: (cb) => (loaded = cb),
    onDestroyed: (cb) => (destroyed = cb),
  };
  return {
    c,
    send,
    load: () => loaded?.(),
    destroy: () => {
      isDestroyed = true;
      destroyed?.();
    },
  };
}

function setup() {
  const handlers = new Map<string, Handler>();
  const handle = vi.fn((channel: string, listener: Handler) => {
    handlers.set(channel, listener);
  });
  const store = makeStore();
  const service = createPasswordsService(store, undefined, { ipcMain: { handle, removeHandler: (c) => void handlers.delete(c) } });
  return { service, handlers, handle, store };
}

describe("passwords service", () => {
  it("registers each channel exactly once, at creation", () => {
    const { handle, handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      ["passwords:add", "passwords:list", "passwords:never-remove", "passwords:remove", "passwords:update"],
    );
    expect(handle).toHaveBeenCalledTimes(5);
  });

  it("dispose removes every handler", () => {
    const { service, handlers } = setup();
    service.dispose();
    expect(handlers.size).toBe(0);
  });

  it("answers only attached webContents, and stops after they are destroyed", () => {
    const { service, handlers } = setup();
    const list = handlers.get("passwords:list")!;
    const a = makeContents(5);
    expect(list({ sender: { id: 5 } })).toEqual({ ok: false, error: "Not allowed." });
    service.attach(a.c, "w1", () => "light");
    expect(list({ sender: { id: 5 } })).not.toEqual({ ok: false, error: "Not allowed." });
    expect(list({ sender: { id: 6 } })).toEqual({ ok: false, error: "Not allowed." });
    for (const ch of ["passwords:add", "passwords:update", "passwords:remove", "passwords:never-remove"]) {
      expect(handlers.get(ch)!({ sender: { id: 6 } }, {})).toEqual({ ok: false, error: "Not allowed." });
    }
    a.destroy();
    expect(list({ sender: { id: 5 } })).toEqual({ ok: false, error: "Not allowed." });
  });

  it("serves Passwords tabs of several windows", () => {
    const { service, handlers } = setup();
    service.attach(makeContents(1).c, "w1", () => "light");
    service.attach(makeContents(2).c, "w2", () => "light");
    const add = handlers.get("passwords:add")!;
    expect(add({ sender: { id: 1 } }, { site: "https://a.com", username: "u", password: "p" })).toMatchObject({ ok: true });
    expect(add({ sender: { id: 2 } }, { site: "https://b.com", username: "u", password: "p" })).toMatchObject({ ok: true });
  });

  it("pushes the window's theme on load, then only on change, only to that window's tabs", () => {
    const { service } = setup();
    let theme: "light" | "dark" = "dark";
    const a = makeContents(1);
    const b = makeContents(2);
    service.attach(a.c, "w1", () => theme);
    service.attach(b.c, "w2", () => "light");
    a.load();
    expect(a.send).toHaveBeenCalledWith("passwords:theme", { theme: "dark" });
    service.setTheme("w1", "dark"); // unchanged since load: not re-sent
    expect(a.send).toHaveBeenCalledTimes(1);
    theme = "light";
    service.setTheme("w1", "light");
    expect(a.send).toHaveBeenLastCalledWith("passwords:theme", { theme: "light" });
    expect(b.send).not.toHaveBeenCalled();
    a.load(); // a reload resends the current theme
    expect(a.send).toHaveBeenCalledTimes(3);
  });

  it("notifyChanged reaches every live Passwords tab", () => {
    const { service } = setup();
    const a = makeContents(1);
    const b = makeContents(2);
    service.attach(a.c, "w1", () => "light");
    service.attach(b.c, "w2", () => "light");
    b.destroy();
    service.notifyChanged();
    expect(a.send).toHaveBeenCalledWith("passwords:changed");
    expect(b.send).not.toHaveBeenCalled();
  });

  it("a successful mutation notifies the other Passwords tabs, never the sender", () => {
    const { service, handlers, store } = setup();
    const a = makeContents(1);
    const b = makeContents(2);
    const c = makeContents(3);
    service.attach(a.c, "w1", () => "light");
    service.attach(b.c, "w2", () => "light");
    service.attach(c.c, "w3", () => "light");
    c.destroy();
    const sender = { sender: { id: 1 } };
    const added = handlers.get("passwords:add")!(sender, { site: "example.com", username: "u", password: "p" }) as { ok: boolean; id: string };
    expect(added.ok).toBe(true);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledWith("passwords:changed");
    expect(a.send).not.toHaveBeenCalled();
    expect(c.send).not.toHaveBeenCalled();
    expect(handlers.get("passwords:update")!(sender, { id: added.id, username: "u2" })).toMatchObject({ ok: true });
    expect(b.send).toHaveBeenCalledTimes(2);
    expect(handlers.get("passwords:remove")!(sender, added.id)).toMatchObject({ ok: true });
    expect(b.send).toHaveBeenCalledTimes(3);
    store.addNever("example.com");
    expect(handlers.get("passwords:never-remove")!(sender, "example.com")).toMatchObject({ ok: true });
    expect(b.send).toHaveBeenCalledTimes(4);
    expect(a.send).not.toHaveBeenCalled();
  });

  it("a failed or denied mutation notifies nobody", () => {
    const { service, handlers } = setup();
    const a = makeContents(1);
    const b = makeContents(2);
    service.attach(a.c, "w1", () => "light");
    service.attach(b.c, "w2", () => "light");
    expect(handlers.get("passwords:add")!({ sender: { id: 1 } }, { bad: true })).toMatchObject({ ok: false });
    expect(handlers.get("passwords:add")!({ sender: { id: 9 } }, { site: "example.com", username: "u", password: "p" })).toEqual({ ok: false, error: "Not allowed." });
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
  });

  it("setBackground follows every theme sent to the tab", () => {
    const { service } = setup();
    const a = makeContents(1);
    const setBackground = vi.fn();
    service.attach({ ...a.c, setBackground }, "w1", () => "dark");
    a.load();
    expect(setBackground).toHaveBeenLastCalledWith("dark");
    service.setTheme("w1", "light");
    expect(setBackground).toHaveBeenLastCalledWith("light");
    expect(setBackground).toHaveBeenCalledTimes(2);
  });
});
