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
    expect(api.add({ site: "https://example.com/login", username: "alice", password: "pw-123456", label: "main" })).toEqual({ ok: true });
    const listed = api.list();
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
});
