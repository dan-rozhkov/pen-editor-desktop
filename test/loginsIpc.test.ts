import { describe, expect, it, vi } from "vitest";
import { addLoginCopy, handleLoginsAdd, handleLoginsList, type LoginsIpcDeps, type LoginsPort } from "../src/main/loginsIpc";
import { createPasswordsApi } from "../src/main/browser/passwordsApi";
import { createCredentialStore } from "../src/main/browser/credentialStore";

function makeApi(available = true) {
  const files = new Map<string, string>();
  const store = createCredentialStore({
    filePath: "/db.json",
    cipher: { isAvailable: () => available, encrypt: (p) => Buffer.from(`x${p}`), decrypt: (b) => b.toString().slice(1) },
    fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
  });
  const flushPending = vi.fn(async () => {});
  const icons = { get: (o: string) => (o === "https://example.com" ? "data:image/png;base64,AA" : undefined), flushPending, forget: vi.fn() };
  return { api: createPasswordsApi(store, icons), store, flushPending };
}

const DOC_URL = "https://app.example/doc?id=a";
const top = { senderId: 1, topFrame: true, frameUrl: DOC_URL };

function deps(role: "doc" | "other", opts: { available?: boolean; confirm?: boolean | (() => Promise<boolean>) } = {}) {
  const { api, store, flushPending } = makeApi(opts.available ?? true);
  const notifyChanged = vi.fn();
  const answer: () => Promise<boolean> = typeof opts.confirm === "function" ? opts.confirm : async () => (opts.confirm as boolean | undefined) ?? true;
  const confirmAdd = vi.fn(answer);
  const state = { viewer: role === "doc" };
  const port: LoginsPort = { isDocViewer: () => state.viewer, confirmAdd };
  const d: LoginsIpcDeps = { api, resolvePort: () => (port.isDocViewer(1, DOC_URL) ? port : null), notifyChanged };
  return { d, store, notifyChanged, confirmAdd, flushPending, state };
}

const login = { site: "https://example.com/signin", username: " ann ", password: "secret-pw", label: "Work" };
const DENIED = { ok: false, error: "Not allowed." };

describe("logins:* sender rules", () => {
  it("refuses a sender that is not a doc viewer (editor, browser, panel, or a doc tab that left the doc page)", async () => {
    const { d, store, notifyChanged, confirmAdd } = deps("other");
    expect(handleLoginsList(d, top)).toEqual(DENIED);
    expect(await handleLoginsAdd(d, top, login)).toEqual(DENIED);
    expect(store.list()).toEqual([]);
    expect(confirmAdd).not.toHaveBeenCalled();
    expect(notifyChanged).not.toHaveBeenCalled();
  });

  it("refuses a sub-frame even in a doc viewer", async () => {
    const { d, store, confirmAdd } = deps("doc");
    const sub = { ...top, topFrame: false };
    expect(handleLoginsList(d, sub)).toEqual(DENIED);
    expect(await handleLoginsAdd(d, sub, login)).toEqual(DENIED);
    expect(store.list()).toEqual([]);
    expect(confirmAdd).not.toHaveBeenCalled();
  });

  it("passes the sender frame's own URL to the port", async () => {
    const resolvePort = vi.fn(() => null);
    const d: LoginsIpcDeps = { api: makeApi().api, resolvePort, notifyChanged: vi.fn() };
    handleLoginsList(d, { senderId: 4, topFrame: true, frameUrl: "https://evil/doc" });
    expect(resolvePort).toHaveBeenCalledWith(4, "https://evil/doc");
  });

  it("re-checks the sender after the dialog: a tab that left /doc meanwhile stores nothing", async () => {
    const h = deps("doc", { confirm: async () => { h.state.viewer = false; return true; } });
    expect(await handleLoginsAdd(h.d, top, login)).toEqual(DENIED);
    expect(h.store.list()).toEqual([]);
    expect(h.notifyChanged).not.toHaveBeenCalled();
  });
});

describe("logins:add", () => {
  it("asks first (host + trimmed username), then stores and notifies", async () => {
    const { d, store, notifyChanged, confirmAdd } = deps("doc");
    const added = await handleLoginsAdd(d, top, login);
    expect(confirmAdd).toHaveBeenCalledWith({ host: "example.com", username: "ann" });
    expect(added).toMatchObject({ ok: true, id: expect.any(String) });
    expect(store.list()).toHaveLength(1);
    expect(notifyChanged).toHaveBeenCalledTimes(1);
  });

  it("Cancel stores nothing and does not notify", async () => {
    const { d, store, notifyChanged } = deps("doc", { confirm: false });
    expect(await handleLoginsAdd(d, top, login)).toEqual({ ok: false, error: "Cancelled." });
    expect(store.list()).toEqual([]);
    expect(notifyChanged).not.toHaveBeenCalled();
  });

  it("answers exists + id for a duplicate without asking, and ignores `replace`", async () => {
    const { d, store, notifyChanged, confirmAdd } = deps("doc");
    const first = (await handleLoginsAdd(d, top, login)) as { id: string };
    confirmAdd.mockClear();
    notifyChanged.mockClear();
    const again = await handleLoginsAdd(d, top, { ...login, password: "other", replace: true });
    expect(again).toMatchObject({ ok: false, exists: true, id: first.id });
    expect(confirmAdd).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(1);
    expect(notifyChanged).not.toHaveBeenCalled();
  });

  it("refuses a second add while a confirmation is open, without a second dialog", async () => {
    let release: (v: boolean) => void = () => {};
    const { d, store, confirmAdd } = deps("doc", { confirm: () => new Promise<boolean>((r) => (release = r)) });
    const first = handleLoginsAdd(d, top, login);
    const second = await handleLoginsAdd(d, top, { ...login, username: "bob" });
    expect(second).toEqual({ ok: false, error: "Another save is waiting for confirmation." });
    expect(confirmAdd).toHaveBeenCalledTimes(1);
    release(true);
    expect(await first).toMatchObject({ ok: true });
    expect(store.list()).toHaveLength(1);
    // free again afterwards
    release = () => {};
    const third = handleLoginsAdd(d, top, { ...login, username: "bob" });
    release(true);
    expect(await third).toMatchObject({ ok: true });
  });

  it("forwards only site, username, password and label to the api", async () => {
    const add = vi.fn(() => ({ ok: true as const, id: "i" }));
    const precheckAdd = vi.fn(() => ({ ok: true as const, host: "example.com", username: "ann" }));
    const port: LoginsPort = { isDocViewer: () => true, confirmAdd: async () => true };
    const d: LoginsIpcDeps = { api: { listSummaries: vi.fn(), precheckAdd, add } as never, resolvePort: () => port, notifyChanged: vi.fn() };
    await handleLoginsAdd(d, top, { ...login, replace: true, extra: 1 });
    const expected = { site: login.site, username: login.username, password: login.password, label: "Work" };
    expect(precheckAdd).toHaveBeenCalledWith(expected);
    expect(add).toHaveBeenCalledWith(expected);
  });

  it("rejects payloads that cannot be saved, without asking", async () => {
    const { d, store, notifyChanged, confirmAdd } = deps("doc");
    const bad: unknown[] = [
      null, "x", [], {}, { ...login, password: 1 }, { ...login, label: 2 }, { ...login, site: "ftp://x" },
      { ...login, username: "   " },
      { ...login, username: "a".repeat(513) },
      { ...login, password: "" },
      { ...login, password: "p".repeat(1025) },
      { ...login, label: "l".repeat(513) },
      { ...login, username: "ann\u0000" },
      { ...login, username: "ann\nSave a login for bank.com?" },
      { ...login, label: "x\u007fy" },
    ];
    for (const b of bad) expect(await handleLoginsAdd(d, top, b)).toMatchObject({ ok: false });
    expect(store.list()).toEqual([]);
    expect(confirmAdd).not.toHaveBeenCalled();
    expect(notifyChanged).not.toHaveBeenCalled();
  });

  it("returns an error value, without asking, when encryption is unavailable", async () => {
    const { d, notifyChanged, confirmAdd } = deps("doc", { available: false });
    expect(handleLoginsList(d, top)).toMatchObject({ encryptionAvailable: false });
    expect(await handleLoginsAdd(d, top, login)).toMatchObject({ ok: false, error: expect.any(String) });
    expect(confirmAdd).not.toHaveBeenCalled();
    expect(notifyChanged).not.toHaveBeenCalled();
  });

  it("never returns a password", async () => {
    const { d } = deps("doc");
    expect(JSON.stringify(await handleLoginsAdd(d, top, login))).not.toContain("secret-pw");
    expect(JSON.stringify(handleLoginsList(d, top))).not.toContain("secret-pw");
  });
});

describe("addLoginCopy", () => {
  it("puts the host alone in the message and the username in the detail; Cancel is the default", () => {
    const c = addLoginCopy({ host: "example.com", username: "ann" });
    expect(c.message).toBe("Save a login for example.com?");
    expect(c.message).not.toContain("ann");
    expect(c.detail).toContain("ann");
    expect(c.buttons).toEqual(["Save", "Cancel"]);
    expect(c.defaultId).toBe(1);
    expect(c.cancelId).toBe(1);
  });
});

describe("logins:list", () => {
  it("gives id, origin, username, label and icon only (no never, lastUsedAt, password) and starts no icon fetch", async () => {
    const { d, store, flushPending } = deps("doc");
    await handleLoginsAdd(d, top, login);
    store.markUsed(store.list()[0]!.id);
    expect(store.list()[0]).toHaveProperty("lastUsedAt");
    const listed = handleLoginsList(d, top) as { entries: Record<string, unknown>[] };
    expect(Object.keys(listed).sort()).toEqual(["encryptionAvailable", "entries"]);
    expect(Object.keys(listed.entries[0]!).sort()).toEqual(["icon", "id", "label", "origin", "username"]);
    expect(flushPending).not.toHaveBeenCalled();
  });
});
