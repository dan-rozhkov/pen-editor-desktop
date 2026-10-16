import { describe, expect, it } from "vitest";
import { createPasswordsApi } from "../src/main/browser/passwordsApi";
import { createCredentialStore } from "../src/main/browser/credentialStore";

function make(available = true) {
  const files = new Map<string, string>();
  const store = createCredentialStore({
    filePath: "/db.json",
    cipher: { isAvailable: () => available, encrypt: (p) => Buffer.from(`x${p}`), decrypt: (b) => b.toString().slice(1) },
    fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
  });
  return { store, api: createPasswordsApi(store) };
}

describe("passwords window API", () => {
  it("add then list: the list has origin, username and label, never a password", () => {
    const { api } = make();
    const added = api.add({ site: "https://example.com/login", username: "alice", password: "pw-123456", label: "main" });
    const listed = api.list();
    expect(added).toEqual({ ok: true, id: listed.entries[0].id });
    expect(listed.entries).toMatchObject([{ origin: "https://example.com", username: "alice", label: "main" }]);
    expect(listed.encryptionAvailable).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("pw-123456");
  });

  it("reports unavailable encryption and refuses to save", () => {
    const { api } = make(false);
    expect(api.list().encryptionAvailable).toBe(false);
    expect(api.add({ site: "example.com", username: "u", password: "p" })).toEqual({
      ok: false,
      error: "Encryption is not available on this system.",
    });
  });

  it("validates payload shapes and never echoes input in errors", () => {
    const { api } = make();
    for (const bad of [null, "x", [], { site: 1, username: "u", password: "p" }, { site: "a.com", username: "u", password: "p", label: 3 }]) {
      expect(api.add(bad)).toEqual({ ok: false, error: "Malformed request." });
    }
    const r = api.add({ site: "bad host", username: "u", password: "secret-pw" });
    expect(r).toEqual({ ok: false, error: "Enter a valid site address." });
    expect(JSON.stringify(r)).not.toContain("secret-pw");
  });

  it("add on an existing origin and username is refused with exists until replace: true is sent", () => {
    const { api, store } = make();
    const first = api.add({ site: "example.com", username: "alice", password: "p1" });
    if (!first.ok) throw new Error("setup");
    // Same normalization as the store: other path, www., case, padded username.
    const again = api.add({ site: "https://www.EXAMPLE.com/other", username: " alice ", password: "p2" });
    expect(again).toEqual({
      ok: false,
      error: "A login for that username already exists on this site.",
      exists: true,
      id: first.id,
    });
    expect(store.findForOrigin("https://example.com", "")).toMatchObject({ entry: { password: "p1" } });
    expect(api.add({ site: "example.com", username: "alice", password: "p2", replace: true })).toEqual(first);
    expect(store.findForOrigin("https://example.com", "")).toMatchObject({ entry: { password: "p2" } });
    expect(api.list().entries).toHaveLength(1);
    // A different username or origin is not a clash.
    expect(api.add({ site: "example.com", username: "bob", password: "p" }).ok).toBe(true);
    expect(api.add({ site: "http://example.com", username: "alice", password: "p" }).ok).toBe(true);
    expect(api.add({ site: "example.com", username: "x", password: "p", replace: "yes" })).toEqual({ ok: false, error: "Malformed request." });
  });

  it("remove drops the icon only when the last login of that origin goes", () => {
    const files = new Map<string, string>();
    const store = createCredentialStore({
      filePath: "/db.json",
      cipher: { isAvailable: () => true, encrypt: (p) => Buffer.from(`x${p}`), decrypt: (b) => b.toString().slice(1) },
      fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
    });
    const forgotten: string[] = [];
    const api = createPasswordsApi(store, { get: () => undefined, flushPending: async () => {}, forget: (o) => void forgotten.push(o) });
    api.add({ site: "a.com", username: "u1", password: "p" });
    api.add({ site: "a.com", username: "u2", password: "p" });
    const [first, second] = api.list().entries;
    expect(api.remove(first.id)).toEqual({ ok: true });
    expect(forgotten).toEqual([]);
    expect(api.remove(second.id)).toEqual({ ok: true });
    expect(forgotten).toEqual(["https://a.com"]);
    expect(api.remove("nope").ok).toBe(false);
    expect(forgotten).toHaveLength(1);
  });

  it("list carries an icon only when the cache has one for that origin", () => {
    const files = new Map<string, string>();
    const store = createCredentialStore({
      filePath: "/db.json",
      cipher: { isAvailable: () => true, encrypt: (p) => Buffer.from(`x${p}`), decrypt: (b) => b.toString().slice(1) },
      fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
    });
    let flushed = 0;
    const icon = "data:image/png;base64,AAAA";
    const api = createPasswordsApi(store, {
      get: (origin) => (origin === "https://a.com" ? icon : undefined),
      flushPending: async () => void flushed++,
      forget: () => {},
    });
    api.add({ site: "a.com", username: "u", password: "p" });
    api.add({ site: "b.com", username: "u", password: "p" });
    const entries = api.list().entries;
    expect(entries.find((e) => e.origin === "https://a.com")?.icon).toBe(icon);
    expect(entries.find((e) => e.origin === "https://b.com")).not.toHaveProperty("icon");
    expect(flushed).toBe(1);
  });

  it("remove and never-remove", () => {
    const { api, store } = make();
    api.add({ site: "example.com", username: "u", password: "p" });
    const id = api.list().entries[0].id;
    expect(api.remove(5)).toEqual({ ok: false, error: "Malformed request." });
    expect(api.remove("nope").ok).toBe(false);
    expect(api.remove(id)).toEqual({ ok: true });
    store.addNever("blocked.com");
    expect(api.list().never).toEqual(["blocked.com"]);
    expect(api.removeNever("blocked.com")).toEqual({ ok: true });
    expect(api.removeNever("blocked.com").ok).toBe(false);
    expect(api.removeNever(null)).toEqual({ ok: false, error: "Malformed request." });
  });

  it("update: label, username and password change in place; the list never holds a password", () => {
    const { api, store } = make();
    api.add({ site: "example.com", username: "alice", password: "old-pw-1", label: "a" });
    api.add({ site: "example.com", username: "bob", password: "bob-pw-1" });
    const id = api.list().entries.find((e) => e.username === "alice")!.id;
    expect(api.update({ id, username: "alice", label: "work" })).toEqual({ ok: true, id });
    expect(store.findForOrigin("https://example.com", "work")).toMatchObject({ ok: true, entry: { password: "old-pw-1" } });
    expect(api.update({ id, username: "alice2", password: "new-pw-2" })).toEqual({ ok: true, id });
    const found = store.findForOrigin("https://example.com", "work");
    expect(found).toMatchObject({ ok: true, entry: { id, username: "alice2", password: "new-pw-2" } });
    expect(JSON.stringify(api.list())).not.toContain("new-pw-2");
    // An empty password keeps the stored one.
    expect(api.update({ id, username: "alice2", password: "" })).toEqual({ ok: true, id });
    expect(store.findForOrigin("https://example.com", "work")).toMatchObject({ entry: { password: "new-pw-2" } });
  });

  it("update refuses a clash, a missing entry, an empty username and bad shapes", () => {
    const { api } = make();
    api.add({ site: "example.com", username: "alice", password: "p1" });
    api.add({ site: "example.com", username: "bob", password: "p2" });
    const id = api.list().entries[0].id;
    expect(api.update({ id, username: "bob" })).toEqual({
      ok: false,
      error: "A login for that username already exists on this site.",
    });
    expect(api.update({ id: "nope", username: "x" })).toEqual({ ok: false, error: "That login no longer exists." });
    expect(api.update({ id, username: "  " })).toEqual({ ok: false, error: "Enter a username." });
    for (const bad of [null, [], { id: 1, username: "x" }, { id, username: "x", password: 3 }, { id, username: "x", label: 1 }]) {
      expect(api.update(bad)).toEqual({ ok: false, error: "Malformed request." });
    }
  });

  it("update with a new password needs encryption; a label-only edit does not", () => {
    const files = new Map<string, string>();
    let available = true;
    const store = createCredentialStore({
      filePath: "/db.json",
      cipher: { isAvailable: () => available, encrypt: (p) => Buffer.from(`x${p}`), decrypt: (b) => b.toString().slice(1) },
      fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
    });
    const api = createPasswordsApi(store);
    api.add({ site: "example.com", username: "alice", password: "p1" });
    const id = api.list().entries[0].id;
    available = false;
    expect(api.update({ id, username: "alice", password: "p2" })).toEqual({
      ok: false,
      error: "Encryption is not available on this system.",
    });
    expect(api.update({ id, username: "alice", label: "x" })).toEqual({ ok: true, id });
  });

  it("list carries lastUsedAt once a login was filled", () => {
    const { api, store } = make();
    api.add({ site: "example.com", username: "alice", password: "p1" });
    const id = api.list().entries[0].id;
    expect(api.list().entries[0].lastUsedAt).toBeUndefined();
    store.markUsed(id);
    expect(typeof api.list().entries[0].lastUsedAt).toBe("number");
  });
});
