import { describe, expect, it, vi } from "vitest";
import * as fsNode from "node:fs";
import * as os from "node:os";
import * as pathNode from "node:path";
import {
  createCredentialStore,
  nodeCredentialFs,
  normalizeHost,
  normalizeOrigin,
  type CredentialCipher,
  type CredentialFs,
} from "../src/main/browser/credentialStore";

/** A reversible fake cipher: output is not the plaintext, so a leak shows. */
function fakeCipher(available = true): CredentialCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`enc:${[...plain].reverse().join("")}`, "utf8"),
    decrypt: (buf) => {
      const text = buf.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("bad cipher text");
      return [...text.slice(4)].reverse().join("");
    },
  };
}

function memoryFs(initial: string | null = null) {
  const files = new Map<string, string>();
  if (initial !== null) files.set("/db.json", initial);
  const fs: CredentialFs = {
    read: (p) => files.get(p) ?? null,
    write: (p, d) => void files.set(p, d),
    rename: (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.delete(from);
      files.set(to, text);
    },
  };
  return { fs, files };
}

function makeStore(opts: { available?: boolean; initial?: string | null; now?: () => number } = {}) {
  const mem = memoryFs(opts.initial ?? null);
  let n = 0;
  const store = createCredentialStore({
    filePath: "/db.json",
    cipher: fakeCipher(opts.available ?? true),
    fs: mem.fs,
    now: opts.now,
    newId: () => `id${++n}`,
  });
  return { store, mem };
}

describe("normalizeHost", () => {
  it.each([
    ["https://WWW.Example.com/login?x=1#y", "example.com"],
    ["http://example.com:8080/a", "example.com"],
    ["example.com/path", "example.com"],
    ["www.example.com", "example.com"],
    ["Example.COM.", "example.com"],
    ["localhost:3000", "localhost"],
    ["https://accounts.example.com", "accounts.example.com"],
    ["https://www.www.example.com", "www.example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each(["", "   ", "not a host", "ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://"])(
    "rejects %j",
    (input) => {
      expect(normalizeHost(input)).toBeNull();
    },
  );
});

describe("credentialStore", () => {
  it("round-trips a password through the cipher and stores only ciphertext on disk", () => {
    const { store, mem } = makeStore();
    store.add({ site: "https://www.Example.com/login", username: "alice", password: "s3cret-pw", label: "main" });
    const disk = mem.files.get("/db.json")!;
    expect(disk).not.toContain("s3cret-pw");
    expect(JSON.parse(disk).entries[0]).toMatchObject({ origin: "https://example.com", username: "alice", label: "main" });

    const found = store.findForOrigin("example.com");
    expect(found).toMatchObject({ ok: true, entry: { username: "alice", password: "s3cret-pw", label: "main" } });
  });

  it("list() never returns a password", () => {
    const { store } = makeStore();
    store.add({ site: "b.com", username: "u", password: "pw-one" });
    store.add({ site: "a.com", username: "u", password: "pw-two" });
    const listed = store.list();
    expect(listed.map((e) => e.origin)).toEqual(["https://a.com", "https://b.com"]);
    expect(JSON.stringify(listed)).not.toMatch(/pw-one|pw-two|password/);
  });

  it("same origin + username replaces the password in place", () => {
    const { store } = makeStore();
    const first = store.add({ site: "example.com", username: "alice", password: "old" });
    const second = store.add({ site: "https://example.com/x", username: "alice", password: "new" });
    expect(second).toMatchObject({ id: first.id, replaced: true });
    expect(store.list()).toHaveLength(1);
    expect(store.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { password: "new" } });
  });

  it("a different username on the same host is a second entry", () => {
    const { store } = makeStore();
    store.add({ site: "example.com", username: "alice", password: "a" });
    store.add({ site: "example.com", username: "bob", password: "b" });
    expect(store.list()).toHaveLength(2);
  });

  it("add throws a fixed message when encryption is unavailable, and writes nothing", () => {
    const { store, mem } = makeStore({ available: false });
    expect(() => store.add({ site: "example.com", username: "alice", password: "topsecret" })).toThrow(
      "Encryption is not available on this system.",
    );
    expect(mem.files.size).toBe(0);
    expect(store.isAvailable()).toBe(false);
  });

  it("add rejects unusable input without echoing it", () => {
    const { store } = makeStore();
    expect(() => store.add({ site: "not a host", username: "u", password: "p" })).toThrow("Enter a valid site address.");
    expect(() => store.add({ site: "a.com", username: "  ", password: "p" })).toThrow("Enter a username.");
    expect(() => store.add({ site: "a.com", username: "u", password: "" })).toThrow("Enter a password.");
  });

  it("matches the host strictly: no subdomain or parent-domain matching", () => {
    const { store } = makeStore();
    store.add({ site: "example.com", username: "u", password: "p" });
    expect(store.findForOrigin("www.example.com")).toMatchObject({ ok: true });
    expect(store.findForOrigin("https://accounts.example.com")).toEqual({ ok: false, reason: "none" });
    expect(store.findForOrigin("example.com.evil.com")).toEqual({ ok: false, reason: "none" });
    expect(store.findForOrigin("evilexample.com")).toEqual({ ok: false, reason: "none" });
  });

  it("with a label: picks it case-insensitively, else lists the labels on the host", () => {
    const { store } = makeStore();
    store.add({ site: "example.com", username: "admin", password: "pa", label: "Admin" });
    store.add({ site: "example.com", username: "guest", password: "pg", label: "Guest" });
    expect(store.findForOrigin("example.com", "guest")).toMatchObject({ ok: true, entry: { username: "guest" } });
    expect(store.findForOrigin("example.com", "nobody")).toEqual({
      ok: false,
      reason: "label",
      labels: ["Admin", "Guest"],
    });
  });

  it("a label that is no label falls back to the username; label wins; labels list holds no usernames", () => {
    const { store } = makeStore();
    store.add({ site: "example.com", username: "alice", password: "pa", label: "Admin" });
    store.add({ site: "example.com", username: "bob", password: "pb", label: "alice" });
    store.add({ site: "example.com", username: "carol", password: "pc" });
    expect(store.findForOrigin("example.com", " CAROL ")).toMatchObject({ ok: true, entry: { username: "carol" } });
    expect(store.findForOrigin("example.com", "alice")).toMatchObject({ ok: true, entry: { username: "bob" } });
    expect(store.findForOrigin("example.com", "nobody")).toEqual({ ok: false, reason: "label", labels: ["Admin", "alice"] });
  });

  it("without a label: the only entry, else the most recently used", () => {
    let t = 1000;
    const { store } = makeStore({ now: () => t });
    const a = store.add({ site: "example.com", username: "a", password: "pa" });
    expect(store.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { username: "a" } });
    const b = store.add({ site: "example.com", username: "b", password: "pb" });
    // Never used: the newest added wins.
    expect(store.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { username: "b" } });
    t = 2000;
    store.markUsed(a.id);
    expect(store.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { username: "a" } });
    t = 3000;
    store.markUsed(b.id);
    expect(store.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { username: "b" } });
  });

  it("reports an entry that cannot be decrypted instead of throwing", () => {
    const seed = makeStore();
    seed.store.add({ site: "example.com", username: "u", password: "p" });
    const disk = JSON.parse(seed.mem.files.get("/db.json")!);
    disk.entries[0].password = Buffer.from("garbage").toString("base64");
    const { store } = makeStore({ initial: JSON.stringify(disk) });
    expect(store.findForOrigin("example.com")).toEqual({ ok: false, reason: "undecryptable" });
  });

  it("remove deletes by id", () => {
    const { store } = makeStore();
    const { id } = store.add({ site: "example.com", username: "u", password: "p" });
    expect(store.remove("nope")).toBe(false);
    expect(store.remove(id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("never list: add, check, remove, normalize; a saved login lifts the never", () => {
    const { store } = makeStore();
    expect(store.addNever("https://WWW.Example.com/x")).toBe(true);
    expect(store.isNever("example.com")).toBe(true);
    expect(store.listNever()).toEqual(["example.com"]);
    store.add({ site: "example.com", username: "u", password: "p" });
    expect(store.isNever("example.com")).toBe(false);
    store.addNever("other.com");
    expect(store.removeNever("other.com")).toBe(true);
    expect(store.removeNever("other.com")).toBe(false);
    expect(store.addNever("not a host")).toBe(false);
  });

  it("classify: new / update / identical", () => {
    const { store } = makeStore();
    expect(store.classify("example.com", "alice", "pw")).toBe("new");
    store.add({ site: "example.com", username: "alice", password: "pw" });
    expect(store.classify("example.com", "alice", "pw")).toBe("identical");
    expect(store.classify("example.com", "alice", "other")).toBe("update");
    expect(store.classify("example.com", "bob", "pw")).toBe("new");
  });

  it("persists across instances and drops corrupt entries one by one", () => {
    const first = makeStore();
    first.store.add({ site: "example.com", username: "u", password: "p" });
    const disk = JSON.parse(first.mem.files.get("/db.json")!);
    disk.entries.push({ id: "bad" }, "junk", null);
    const { store } = makeStore({ initial: JSON.stringify(disk) });
    expect(store.list()).toHaveLength(1);
    expect(store.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { password: "p" } });
  });

  it.each([
    ["{ not json"],
    [""],
    ["[]"],
    ["null"],
    ['{"entries": 5, "never": "x"}'],
    ['{"version": 2, "entries": [], "never": []}'],
  ])("an unreadable file (%j) reads as empty but is set aside before the first write", (text) => {
    const { store, mem } = makeStore({ initial: text, now: () => 4242 });
    expect(store.list()).toEqual([]);
    expect(store.listNever()).toEqual([]);
    // reading alone changes nothing
    expect(mem.files.get("/db.json")).toBe(text);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    store.add({ site: "example.com", username: "u", password: "secret-pw" });
    expect(mem.files.get("/db.json.bad-4242")).toBe(text);
    expect(JSON.parse(mem.files.get("/db.json")!).entries).toHaveLength(1);
    // one line, no content
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-pw");
    expect(JSON.stringify(log.mock.calls)).not.toContain(text === "" ? "\u0000" : text);
    // a second write does not set anything else aside
    store.add({ site: "other.com", username: "u", password: "p" });
    expect([...mem.files.keys()].sort()).toEqual(["/db.json", "/db.json.bad-4242"]);
    log.mockRestore();
  });

  it("when the bad file cannot be set aside, the write is refused and nothing is overwritten", () => {
    const { store, mem } = makeStore({ initial: "{ not json" });
    mem.fs.rename = () => {
      throw new Error("EPERM");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => store.add({ site: "example.com", username: "u", password: "p" })).toThrow(
      "Could not back up the unreadable passwords file.",
    );
    expect(mem.files.get("/db.json")).toBe("{ not json");
    vi.restoreAllMocks();
  });

  it("nodeCredentialFs.read: only ENOENT means 'no file'; any other error throws", () => {
    const dir = fsNode.mkdtempSync(pathNode.join(os.tmpdir(), "cred-fs-"));
    try {
      expect(nodeCredentialFs.read(pathNode.join(dir, "missing.json"))).toBeNull();
      // a directory where the file should be: EISDIR, not "empty"
      expect(() => nodeCredentialFs.read(dir)).toThrow();
    } finally {
      fsNode.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a read error other than ENOENT: reads as empty, but the file is set aside before any write", () => {
    const { store, mem } = makeStore({ initial: "KEEP-ME", now: () => 7 });
    mem.fs.read = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.list()).toEqual([]);
    store.add({ site: "example.com", username: "u", password: "p" });
    expect(mem.files.get("/db.json.bad-7")).toBe("KEEP-ME");
    vi.restoreAllMocks();
  });

  it("a read error other than ENOENT and a failing set-aside: writes are refused, the file is untouched", () => {
    const { store, mem } = makeStore({ initial: "KEEP-ME" });
    mem.fs.read = () => {
      throw Object.assign(new Error("denied"), { code: "EIO" });
    };
    mem.fs.rename = () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => store.add({ site: "example.com", username: "u", password: "p" })).toThrow(
      "Could not back up the unreadable passwords file.",
    );
    expect(() => store.addNever("example.com")).toThrow("Could not back up the unreadable passwords file.");
    expect(mem.files.get("/db.json")).toBe("KEEP-ME");
    vi.restoreAllMocks();
  });

  it("a file with ANY invalid entry keeps its valid entries but is backed up before the first write", () => {
    const seed = makeStore();
    seed.store.add({ site: "example.com", username: "u", password: "p" });
    const disk = JSON.parse(seed.mem.files.get("/db.json")!);
    disk.entries.push({ id: "bad" });
    const text = JSON.stringify(disk);
    const { store, mem } = makeStore({ initial: text, now: () => 99 });
    expect(store.list()).toHaveLength(1);
    expect(mem.files.get("/db.json")).toBe(text); // reading changes nothing
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.add({ site: "other.com", username: "u", password: "p" });
    expect(mem.files.get("/db.json.bad-99")).toBe(text);
    expect(JSON.parse(mem.files.get("/db.json")!).entries).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it.each([
    ["a junk 'never' item", { never: ["ok.com", 5] }],
    ["a non-array 'entries'", { entries: 5 }],
  ])("%s also triggers the backup", (_name, patch) => {
    const text = JSON.stringify({ version: 1, entries: [], never: [], ...patch });
    const { store, mem } = makeStore({ initial: text, now: () => 5 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.addNever("x.com");
    expect(mem.files.get("/db.json.bad-5")).toBe(text);
    vi.restoreAllMocks();
  });

  it("when the file is already gone at set-aside time (ENOENT), the backup counts as done and the write goes through", () => {
    const { store, mem } = makeStore({ initial: "{ not json" });
    mem.fs.rename = () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.add({ site: "example.com", username: "u", password: "p" });
    expect(JSON.parse(mem.files.get("/db.json")!).entries).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("a readable file is never set aside", () => {
    const seed = makeStore();
    seed.store.add({ site: "example.com", username: "u", password: "p" });
    const { store, mem } = makeStore({ initial: seed.mem.files.get("/db.json")! });
    store.add({ site: "other.com", username: "u", password: "p" });
    expect([...mem.files.keys()]).toEqual(["/db.json"]);
  });

  it("matches on the whole origin: scheme and port must equal", () => {
    const { store } = makeStore();
    store.add({ site: "https://example.com", username: "u", password: "p" });
    store.add({ site: "http://localhost:3000", username: "u", password: "dev" });
    expect(store.list().map((e) => e.origin)).toEqual(["http://localhost:3000", "https://example.com"]);
    expect(store.findForOrigin("https://www.example.com:443/x")).toMatchObject({ ok: true });
    expect(store.findForOrigin("http://example.com")).toEqual({ ok: false, reason: "none" });
    expect(store.findForOrigin("https://example.com:8443")).toEqual({ ok: false, reason: "none" });
    expect(store.findForOrigin("http://localhost:3000/a")).toMatchObject({ ok: true, entry: { password: "dev" } });
    expect(store.findForOrigin("http://localhost:3001")).toEqual({ ok: false, reason: "none" });
    expect(store.findForOrigin("http://localhost")).toEqual({ ok: false, reason: "none" });
    expect(store.classify("http://example.com", "u", "p")).toBe("new");
  });

  it("a file in the old host-only shape is not accepted", () => {
    const old = JSON.stringify({
      version: 1,
      entries: [{ id: "a", host: "example.com", username: "u", label: "", password: Buffer.from("enc:p").toString("base64") }],
      never: [],
    });
    expect(makeStore({ initial: old }).store.list()).toEqual([]);
    const notNormalized = JSON.stringify({
      version: 1,
      entries: [{ id: "a", origin: "https://WWW.example.com", username: "u", label: "", password: "eHg=" }],
      never: [],
    });
    expect(makeStore({ initial: notNormalized }).store.list()).toEqual([]);
  });

  it("classify trims the username like add() does", () => {
    const { store } = makeStore();
    store.add({ site: "example.com", username: "  alice  ", password: "pw" });
    expect(store.classify("example.com", "alice", "pw")).toBe("identical");
    expect(store.classify("example.com", " alice ", "pw")).toBe("identical");
    expect(store.classify("example.com", " alice", "other")).toBe("update");
  });

  it("round-trips a maximum-length password of 3-byte UTF-8 characters", () => {
    const { store, mem } = makeStore();
    const password = "€".repeat(1024);
    store.add({ site: "example.com", username: "u", password });
    // the base64 ciphertext is longer than 4 * 1024
    expect(JSON.parse(mem.files.get("/db.json")!).entries[0].password.length).toBeGreaterThan(4096);
    const { store: reopened } = makeStore({ initial: mem.files.get("/db.json")! });
    expect(reopened.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { password } });
    expect(() => store.add({ site: "example.com", username: "u2", password: "€".repeat(1025) })).toThrow(
      "Enter a password.",
    );
  });

  it("a missing file reads as empty", () => {
    const { store } = makeStore();
    expect(store.list()).toEqual([]);
  });
});

describe("normalizeOrigin", () => {
  it.each([
    ["https://WWW.Example.com/login?x=1#y", "https://example.com"],
    ["example.com/path", "https://example.com"],
    ["http://example.com:80/a", "http://example.com"],
    ["https://example.com:443", "https://example.com"],
    ["http://example.com:8080/a", "http://example.com:8080"],
    ["localhost:3000", "https://localhost:3000"],
    ["Example.COM.", "https://example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });
  it.each(["", "not a host", "ftp://example.com", "javascript:alert(1)", "https://"])("rejects %j", (input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });
});
