// Handshake file contract with pen-editor-backend (src/mcp/autoToken.ts) and
// pen-editor-plugin (lib/proxy.mjs resolveConfig, step 3). Both already read
// `<os.homedir()>/.pen-editor/mcp.json`; this file must produce byte-identical
// behavior, not a "close enough" variant. Everything below except
// `removeHandshakeFileSync` and `probeHandshakeOwner` is copied verbatim from
// pen-editor-backend/src/mcp/autoToken.ts (the `Config`/`resolveMcpAuth` half
// — server-only token *policy*, not the file contract — is dropped; this repo
// only ever mints its own token, see §5 of the design doc).
//
// Keep in sync with pen-editor-backend/src/mcp/autoToken.ts — guarded by
// test/handshakeContract.test.ts.

import { randomBytes } from "node:crypto";
import { readFileSync as nodeReadFileSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Minimal logger shape so callers can pass a real logger without a hard
// dependency on its full type.
export interface WarnLogger {
  warn: (msg: string) => void;
  info?: (msg: string) => void;
}

export function generateAutoToken(): string {
  return randomBytes(32).toString("hex");
}

// True for 127.0.0.0/8, ::1, and IPv4-mapped ::ffff:127.x.x.x. Deliberately
// narrow — this backs a security boundary, so anything not recognizably
// loopback is treated as remote.
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const parts = v4.split(".");
  if (parts.length !== 4) return false;
  // Every octet must be a plain base-10 integer 0-255 (no signs, no
  // whitespace, no trailing garbage like "1x") for this to count as a real
  // dotted-quad address at all.
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return Number(parts[0]) === 127;
}

export interface HandshakeFileEntry {
  url: string;
  token: string;
  port: number;
}

// Not memoized: reads homedir() fresh each call so tests can point it at a
// temp directory via `vi.mock("node:os", ...)` without needing a restart.
export function getHandshakeDir(): string {
  return join(homedir(), ".pen-editor");
}

export function getHandshakePath(): string {
  return join(getHandshakeDir(), "mcp.json");
}

// Writes the shared handshake file pen-editor-backend and pen-editor-plugin
// read to discover a local MCP endpoint without any manual token wiring.
// Contract (do not deviate): `{ url: "http://127.0.0.1:<port>/api/mcp",
// token: "<64 lowercase hex>", port }` at `~/.pen-editor/mcp.json`, dir mode
// 0700, file mode 0600.
//
// Atomic: written to a temp file in the same directory, then renamed, so a
// concurrent reader never observes a partial write. Never throws — a
// read-only filesystem or missing homedir must not crash app startup;
// callers get a warning on the logger instead. Returns whether the write
// actually landed: callers (mcp/service.ts's publish()) must not report
// "listening" on a swallowed failure — a root-owned `~/.pen-editor` from an
// old `sudo` run, or a read-only `$HOME`, must surface as a visibly failed
// status, not a green dot over a file that was never written (finding 1).
export async function writeHandshakeFile(entry: HandshakeFileEntry, log: WarnLogger): Promise<boolean> {
  const dir = getHandshakeDir();
  const target = getHandshakePath();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's `mode` only applies when it creates the directory; chmod
    // explicitly so a pre-existing directory with looser permissions (or a
    // restrictive umask on creation) doesn't leave the token world-readable.
    await chmod(dir, 0o700);

    const tmpPath = join(dir, `.mcp.json.${process.pid}.${Date.now()}.tmp`);
    // Set mode explicitly rather than relying on umask.
    await writeFile(tmpPath, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, target);
    log.info?.(`[mcp] wrote local handshake file to ${target}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[mcp] failed to write handshake file at ${target}: ${message}`);
    return false;
  }
}

// Best-effort cleanup on graceful shutdown. Only removes the file when it
// still holds the token/port this process itself wrote — otherwise a
// second, short-lived instance (a test run, a second checkout) would delete
// the handshake file belonging to a still-running owner (this app or a
// backend), and the editor/plugin would lose discovery. A stale file
// surviving a crash (this process's own, never overwritten by anyone else)
// is not otherwise a problem: it just points a reader at a token/port that
// no longer accepts connections, which surfaces as an ordinary connection
// error — not a security issue, since the loopback restriction and
// per-process token still apply to whatever (if anything) is actually
// listening.
export async function removeHandshakeFile(entry: HandshakeFileEntry, log: WarnLogger): Promise<void> {
  const target = getHandshakePath();
  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<HandshakeFileEntry>;
    if (parsed.token !== entry.token || parsed.port !== entry.port) {
      log.info?.(`[mcp] handshake file at ${target} no longer belongs to this process — leaving it in place.`);
      return;
    }
    await rm(target, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // already gone
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[mcp] failed to remove handshake file at ${target}: ${message}`);
  }
}

// Synchronous twin of removeHandshakeFile, added for this repo only (the
// backend has no equivalent — Fastify's shutdown hooks can await a promise,
// Electron's cannot). `app.on("will-quit")` does not reliably await a
// returned promise before the process exits, so the async version would
// silently not run and leave a stale (but harmless, per the comment on
// removeHandshakeFile) file behind. Same ownership check, same
// swallow-and-log-on-failure behavior, just using the `*Sync` fs API so it
// completes before `will-quit` returns.
export function removeHandshakeFileSync(entry: HandshakeFileEntry, log: WarnLogger): void {
  const target = getHandshakePath();
  try {
    const raw = nodeReadFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<HandshakeFileEntry>;
    if (parsed.token !== entry.token || parsed.port !== entry.port) {
      log.info?.(`[mcp] handshake file at ${target} no longer belongs to this process — leaving it in place.`);
      return;
    }
    rmSync(target, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // already gone
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[mcp] failed to remove handshake file at ${target}: ${message}`);
  }
}

export type HandshakeOwnerStatus = "live" | "stale";

// §5 of the design doc: two writers (this app, a local pen-editor-backend),
// one file. Before publishing our own handshake entry over an existing one,
// probe whether its owner is still actually listening — a minimal
// `initialize` POST to the entry's own url with the entry's own token
// (never a token of our own: a live backend must not log a spurious 401
// just because we came by to check).
//
// Classification is deliberately coarse: connection refused / DNS failure /
// timeout means nothing is listening at that address at all → "stale", safe
// to clobber. Any HTTP response at all — including 401/403/503 — means some
// process is bound to that port and answering HTTP → "live", never clobber
// it. A 401/403 could mean our probe token is wrong (e.g. the backend
// rotated it), but that still proves a live owner is there; guessing harder
// at "is it really the same owner" is not worth the complexity for a
// coexistence heuristic that always has a manual escape hatch (§5's "Use
// this app for MCP" menu item).
export async function probeHandshakeOwner(
  entry: HandshakeFileEntry,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<HandshakeOwnerStatus> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchFn(entry.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "pen-editor-desktop-probe", version: "1.0.0" },
        },
      }),
      signal: controller.signal,
    });
    // Any HTTP status (including 4xx/5xx) means something is listening.
    return "live";
  } catch {
    // Connection refused, ENOTFOUND, abort/timeout, or any other fetch
    // failure — nothing reachable at that address.
    return "stale";
  } finally {
    clearTimeout(timer);
  }
}
