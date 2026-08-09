import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A developer's real pen-editor-backend may currently be running and owns
// `~/.pen-editor/mcp.json` — this suite must never touch it. os.homedir() is
// redirected to a fresh temp dir per test; handshake.ts resolves homedir()
// lazily inside getHandshakeDir() (not at module load), so re-pointing
// `fakeHome` per test is enough. vitest hoists this vi.mock above the
// imports below it, so it is active before handshake.ts is ever evaluated.
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  generateAutoToken,
  getHandshakeDir,
  getHandshakePath,
  isLoopbackAddress,
  probeHandshakeOwner,
  removeHandshakeFile,
  removeHandshakeFileSync,
  writeHandshakeFile,
  type HandshakeFileEntry,
} from "../src/main/mcp/handshake";

const noopLog = { warn: () => {}, info: () => {} };

function makeEntry(overrides: Partial<HandshakeFileEntry> = {}): HandshakeFileEntry {
  return { url: "http://127.0.0.1:4321/api/mcp", token: generateAutoToken(), port: 4321, ...overrides };
}

describe("handshake file", () => {
  let createdHomeDir = "";

  beforeEach(async () => {
    createdHomeDir = await mkdtemp(join(tmpdir(), "pen-editor-desktop-home-"));
    fakeHome = createdHomeDir;
  });

  afterEach(async () => {
    await rm(createdHomeDir, { recursive: true, force: true });
  });

  it("resolves the dir and path under the (mocked) home directory", () => {
    expect(getHandshakeDir()).toBe(join(fakeHome, ".pen-editor"));
    expect(getHandshakePath()).toBe(join(fakeHome, ".pen-editor", "mcp.json"));
  });

  it("creates the dir at 0700 and the file at 0600", async () => {
    const entry = makeEntry();
    await writeHandshakeFile(entry, noopLog);

    const dirMode = (await stat(getHandshakeDir())).mode & 0o777;
    const fileMode = (await stat(getHandshakePath())).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("writes exactly the documented JSON shape", async () => {
    const entry = makeEntry({ url: "http://127.0.0.1:5555/api/mcp", port: 5555 });
    await writeHandshakeFile(entry, noopLog);

    const raw = await readFile(getHandshakePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toEqual({ url: entry.url, token: entry.token, port: entry.port });
    expect(Object.keys(parsed as object).sort()).toEqual(["port", "token", "url"]);
    expect(entry.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes atomically: no leftover .tmp file after a successful write", async () => {
    await writeHandshakeFile(makeEntry(), noopLog);
    const files = await readdir(getHandshakeDir());
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    expect(tmpFiles).toEqual([]);
    expect(files).toEqual(["mcp.json"]);
  });

  it("removeHandshakeFile is a no-op when the file holds a different token", async () => {
    const original = makeEntry();
    await writeHandshakeFile(original, noopLog);

    const foreign = makeEntry({ token: generateAutoToken() });
    await removeHandshakeFile(foreign, noopLog);

    const raw = await readFile(getHandshakePath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ url: original.url, token: original.token, port: original.port });
  });

  it("removeHandshakeFile is a no-op when the file holds a different port", async () => {
    const original = makeEntry({ port: 1111 });
    await writeHandshakeFile(original, noopLog);

    await removeHandshakeFile({ ...original, port: 2222 }, noopLog);

    const raw = await readFile(getHandshakePath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ url: original.url, token: original.token, port: original.port });
  });

  it("removeHandshakeFile removes the file when it still belongs to this entry", async () => {
    const entry = makeEntry();
    await writeHandshakeFile(entry, noopLog);
    await removeHandshakeFile(entry, noopLog);
    await expect(stat(getHandshakePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removeHandshakeFile does not throw when the file is already gone", async () => {
    await expect(removeHandshakeFile(makeEntry(), noopLog)).resolves.toBeUndefined();
  });

  it("removeHandshakeFileSync removes a file it owns", async () => {
    const entry = makeEntry();
    await writeHandshakeFile(entry, noopLog);
    removeHandshakeFileSync(entry, noopLog);
    await expect(stat(getHandshakePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removeHandshakeFileSync is a no-op for a foreign entry", async () => {
    const original = makeEntry();
    await writeHandshakeFile(original, noopLog);
    removeHandshakeFileSync(makeEntry({ token: generateAutoToken() }), noopLog);
    const raw = await readFile(getHandshakePath(), "utf8");
    expect(JSON.parse(raw).token).toBe(original.token);
  });

  it("removeHandshakeFileSync does not throw when the file never existed", () => {
    expect(() => removeHandshakeFileSync(makeEntry(), noopLog)).not.toThrow();
  });
});

describe("isLoopbackAddress", () => {
  it("recognizes loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.5.5")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback and garbage", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("127.0.0.1x")).toBe(false);
    expect(isLoopbackAddress("999.0.0.1")).toBe(false);
  });
});

describe("probeHandshakeOwner", () => {
  it("classifies a network error (connection refused / ENOTFOUND / timeout) as stale", async () => {
    const entry = makeEntry();
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(probeHandshakeOwner(entry, { fetchFn })).resolves.toBe("stale");
    expect(fetchFn).toHaveBeenCalledWith(
      entry.url,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${entry.token}` }),
      }),
    );
  });

  it("classifies an aborted/timed-out request as stale", async () => {
    const entry = makeEntry();
    const fetchFn = vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    await expect(probeHandshakeOwner(entry, { fetchFn, timeoutMs: 10 })).resolves.toBe("stale");
  });

  it.each([200, 401, 403, 503, 500])("classifies HTTP %d as live", async (status) => {
    const entry = makeEntry();
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status }));
    await expect(probeHandshakeOwner(entry, { fetchFn })).resolves.toBe("live");
  });

  it("classifies a real refused connection as stale (no fetchFn override)", async () => {
    // Bind a real server, grab its port, then close it — nothing left
    // listening there, so the real global fetch gets a genuine
    // connection-refused instead of a mocked one.
    const server: Server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const entry = makeEntry({ url: `http://127.0.0.1:${port}/api/mcp`, port });
    await expect(probeHandshakeOwner(entry, { timeoutMs: 1500 })).resolves.toBe("stale");
  });
});

// Guards the "never touch the real ~/.pen-editor" invariant end to end: even
// though every test above redirects homedir(), a mistake in that redirection
// (e.g. a call path that reads os.homedir() before the mock is installed)
// would silently write into the real directory. Compare content hashes.
describe("real home directory is untouched", () => {
  it("does not create or modify anything at the OS-reported home directory used outside the mock", async () => {
    // Deliberately import the *actual* os module to read the true home dir,
    // bypassing this file's vi.mock.
    const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
    const realPath = join(actualOs.homedir(), ".pen-editor", "mcp.json");
    const before = await readFile(realPath, "utf8").catch(() => null);

    // Exercise the module under test with the mock active (as every test in
    // this file already does), then re-check the real path is unchanged.
    fakeHome = await mkdtemp(join(tmpdir(), "pen-editor-desktop-home-"));
    try {
      await writeHandshakeFile(makeEntry(), noopLog);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }

    const after = await readFile(realPath, "utf8").catch(() => null);
    expect(after).toBe(before);
  });
});
