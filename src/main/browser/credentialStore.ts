import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Saved logins for the built-in browser (design:
 * docs/superpowers/specs/2026-10-16-browser-saved-logins-design.md).
 *
 * Pure and Electron-free on purpose: the cipher (`safeStorage` in the app) and
 * the file system are injected, so the store is unit-tested under plain Node.
 * Passwords live on disk only as base64 of the cipher output. Username and
 * label are plain text. `list()` never returns a password; only
 * `findForOrigin()` decrypts one, and only fillLogin.ts calls it.
 */

export const CREDENTIALS_FILE = "browser-credentials.json";

export interface CredentialCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export interface CredentialFs {
  /**
   * The file text, or null when the file does not exist (ENOENT, and only
   * that). Any other failure (EACCES, EISDIR, EIO...) THROWS: the file is
   * there but unreadable, and the store must not mistake it for "empty".
   */
  read(filePath: string): string | null;
  /** Throws when the write fails. */
  write(filePath: string, data: string): void;
  /** Moves a file (used to set an unreadable store aside). Throws on failure. */
  rename(from: string, to: string): void;
}

const isErrno = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;

/** Real fs: atomic replace (tmp + rename), owner-only permissions. */
export const nodeCredentialFs: CredentialFs = {
  read(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (isErrno(err, "ENOENT")) return null;
      throw err;
    }
  },
  write(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  },
  rename(from, to) {
    fs.renameSync(from, to);
  },
};

/** What leaves the store for display: never a password. */
export interface CredentialSummary {
  id: string;
  /** Normalized origin: `https://example.com`, `http://localhost:3000`. */
  origin: string;
  username: string;
  label: string;
  /** Epoch ms of the last fill; absent when never used. */
  lastUsedAt?: number;
}

/** A decrypted entry. Held only for the moment a login is typed. */
export interface CredentialSecret extends CredentialSummary {
  password: string;
}

export interface AddCredentialInput {
  /** A URL or a bare host (a bare host means https). Normalized like a page origin. */
  site: string;
  username: string;
  password: string;
  label?: string;
}

export type FindResult =
  | { ok: true; entry: CredentialSecret }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "label"; labels: string[] }
  | { ok: false; reason: "undecryptable" };

export type Classification = "new" | "update" | "identical";

interface StoredEntry {
  id: string;
  origin: string;
  username: string;
  label: string;
  password: string; // base64 of cipher output
  lastUsedAt?: number;
}

interface StoredFile {
  version: 1;
  entries: StoredEntry[];
  never: string[];
}

export const MAX_FIELD = 512;
/** Longest password add() accepts, in UTF-16 code units. */
export const MAX_PASSWORD = 1024;
/**
 * Sanity bound on one stored (base64) password when reading. Deliberately
 * generous: the real size depends on the cipher's overhead and on UTF-8
 * (a 1024-character password of 3-byte characters is already over 4 KB), so a
 * tight bound would silently drop entries add() produced.
 */
const MAX_STORED_PASSWORD = 64 * 1024;

/**
 * Hostname only (used for the "never" list): lowercase, a leading `www.` and a trailing dot removed, no
 * port, no path. Accepts a URL (http/https) or a bare host / host:port / host/path.
 * Returns null for anything that is not a usable host. No subdomain or eTLD+1
 * matching anywhere: `accounts.example.com` and `example.com` are different.
 */
export function normalizeHost(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("www.")) host = host.slice(4);
  return host === "" ? null : host;
}

/**
 * `scheme://host[:port]`, normalized: lowercase host, a leading `www.` and a
 * trailing dot removed, the scheme's default port dropped. A saved login is
 * matched on the whole origin: `http://example.com` and `https://example.com`
 * (or another port) are different sites. A bare host means https. Null for
 * anything that is not a usable http(s) origin.
 */
export function normalizeOrigin(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = normalizeHost(url.href);
  if (!host) return null;
  // URL#port is already "" for the scheme's default port.
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

function emptyFile(): StoredFile {
  return { version: 1, entries: [], never: [] };
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

interface ParsedFile {
  file: StoredFile;
  /**
   * True when the file on disk must be kept as a backup before the first write:
   * it is not a store of the known version, or ANY part of it failed
   * validation (so a write would silently destroy that part). The valid
   * entries are still returned in `file`.
   */
  unreadable: boolean;
}

/**
 * Missing file -> empty. Corrupt JSON or an unknown `version` -> empty but
 * flagged `unreadable`, so the first write sets the file aside instead of
 * overwriting it. Invalid entries (including any without a normalized
 * `origin`) are dropped one by one, but they also flag `unreadable`: the valid
 * entries stay usable in memory while the original file is backed up first.
 */
function parseFile(text: string | null): ParsedFile {
  const out = emptyFile();
  if (text === null) return { file: out, unreadable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { file: out, unreadable: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { file: out, unreadable: true };
  const rec = parsed as Record<string, unknown>;
  if (rec.version !== 1) return { file: out, unreadable: true };
  let lossy = false;
  if (Array.isArray(rec.entries)) {
    const seen = new Set<string>();
    for (const raw of rec.entries) {
      if (typeof raw !== "object" || raw === null) {
        lossy = true;
        continue;
      }
      const e = raw as Record<string, unknown>;
      if (
        !isNonEmptyString(e.id, 100) ||
        seen.has(e.id) ||
        !isNonEmptyString(e.origin, 300) ||
        normalizeOrigin(e.origin) !== e.origin ||
        !isNonEmptyString(e.username, MAX_FIELD) ||
        !isNonEmptyString(e.password, MAX_STORED_PASSWORD)
      ) {
        lossy = true;
        continue;
      }
      seen.add(e.id);
      out.entries.push({
        id: e.id,
        origin: e.origin,
        username: e.username,
        label: typeof e.label === "string" ? e.label.slice(0, MAX_FIELD) : "",
        password: e.password,
        ...(typeof e.lastUsedAt === "number" && Number.isFinite(e.lastUsedAt) ? { lastUsedAt: e.lastUsedAt } : {}),
      });
    }
  } else if (rec.entries !== undefined) {
    lossy = true;
  }
  if (Array.isArray(rec.never)) {
    const valid = rec.never.filter((h): h is string => isNonEmptyString(h, 253));
    if (valid.length !== rec.never.length) lossy = true;
    out.never = [...new Set(valid)];
  } else if (rec.never !== undefined) {
    lossy = true;
  }
  return { file: out, unreadable: lossy };
}

export interface CredentialStoreDeps {
  filePath: string;
  cipher: CredentialCipher;
  fs?: CredentialFs;
  now?: () => number;
  newId?: () => string;
}

export function createCredentialStore(deps: CredentialStoreDeps) {
  const io = deps.fs ?? nodeCredentialFs;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  let cache: StoredFile | null = null;
  let setAside = false;

  const load = (): StoredFile => {
    if (cache) return cache;
    let text: string | null;
    try {
      text = io.read(deps.filePath);
    } catch {
      // The file may exist but cannot be read (permissions, I/O): it is NOT
      // "empty". Nothing may overwrite it; the first write sets it aside.
      cache = emptyFile();
      setAside = true;
      return cache;
    }
    const parsed = parseFile(text);
    setAside = parsed.unreadable;
    cache = parsed.file;
    return cache;
  };
  const save = (file: StoredFile): void => {
    if (setAside) {
      // The file on disk is not (entirely) a store we understand: keep it,
      // never overwrite it.
      const name = `${deps.filePath}.bad-${now()}`;
      try {
        io.rename(deps.filePath, name);
      } catch (err) {
        // The file is already gone (ENOENT): there is nothing left to protect.
        if (!isErrno(err, "ENOENT")) throw new Error("Could not back up the unreadable passwords file.");
      }
      setAside = false;
      console.error(`saved logins: unreadable credentials file kept as ${path.basename(name)}`);
    }
    io.write(deps.filePath, JSON.stringify(file, null, 2));
    cache = file;
  };
  const decrypt = (entry: StoredEntry): string => deps.cipher.decrypt(Buffer.from(entry.password, "base64"));

  const summary = (e: StoredEntry): CredentialSummary => ({
    id: e.id,
    origin: e.origin,
    username: e.username,
    label: e.label,
    ...(e.lastUsedAt !== undefined ? { lastUsedAt: e.lastUsedAt } : {}),
  });

  return {
    isAvailable: (): boolean => {
      try {
        return deps.cipher.isAvailable();
      } catch {
        return false;
      }
    },

    /** Host, username, label. Never a password. */
    list: (): CredentialSummary[] =>
      load()
        .entries.map(summary)
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)),

    /**
     * Same origin + username replaces the password (and label, when one is
     * given). Throws a fixed-message Error when encryption is unavailable or
     * the input is unusable; the message never contains the input.
     */
    add: (input: AddCredentialInput): { id: string; origin: string; replaced: boolean } => {
      if (!deps.cipher.isAvailable()) throw new Error("Encryption is not available on this system.");
      const origin = normalizeOrigin(input.site);
      if (!origin) throw new Error("Enter a valid site address.");
      const username = input.username.trim();
      if (!isNonEmptyString(username, MAX_FIELD)) throw new Error("Enter a username.");
      if (!isNonEmptyString(input.password, MAX_PASSWORD)) throw new Error("Enter a password.");
      const label = (input.label ?? "").trim().slice(0, MAX_FIELD);
      const encrypted = deps.cipher.encrypt(input.password).toString("base64");

      const file = load();
      const entries = file.entries.map((e) => ({ ...e }));
      const existing = entries.find((e) => e.origin === origin && e.username === username);
      let id: string;
      if (existing) {
        existing.password = encrypted;
        if (input.label !== undefined) existing.label = label;
        id = existing.id;
      } else {
        id = newId();
        entries.push({ id, origin, username, label, password: encrypted });
      }
      // A saved login cancels a "never" on the same host.
      const host = normalizeHost(origin);
      save({ ...file, entries, never: file.never.filter((h) => h !== host) });
      return { id, origin, replaced: existing !== undefined };
    },

    /**
     * The id of the entry add() would replace for this site + username (same
     * normalization as add()), or null when none exists or the input is unusable.
     */
    findExisting: (site: string, username: string): string | null => {
      const origin = normalizeOrigin(site);
      if (!origin) return null;
      const name = username.trim();
      return load().entries.find((e) => e.origin === origin && e.username === name)?.id ?? null;
    },

    /**
     * Edits one entry in place (id and origin stay; `lastUsedAt` is kept).
     * `password` omitted or empty keeps the stored one. Throws a fixed-message
     * Error like add(); a username that another entry on the same origin
     * already uses is refused.
     */
    update: (
      id: string,
      patch: { username: string; password?: string; label?: string },
    ): void => {
      const file = load();
      const target = file.entries.find((e) => e.id === id);
      if (!target) throw new Error("That login no longer exists.");
      const username = patch.username.trim();
      if (!isNonEmptyString(username, MAX_FIELD)) throw new Error("Enter a username.");
      const next: StoredEntry = { ...target, username };
      if (patch.label !== undefined) next.label = patch.label.trim().slice(0, MAX_FIELD);
      if (patch.password !== undefined && patch.password !== "") {
        if (!deps.cipher.isAvailable()) throw new Error("Encryption is not available on this system.");
        if (!isNonEmptyString(patch.password, MAX_PASSWORD)) throw new Error("Enter a password.");
        next.password = deps.cipher.encrypt(patch.password).toString("base64");
      }
      if (file.entries.some((e) => e.id !== id && e.origin === target.origin && e.username === username)) {
        throw new Error("A login for that username already exists on this site.");
      }
      save({ ...file, entries: file.entries.map((e) => (e.id === id ? next : e)) });
    },

    remove: (id: string): boolean => {
      const file = load();
      const entries = file.entries.filter((e) => e.id !== id);
      if (entries.length === file.entries.length) return false;
      save({ ...file, entries });
      return true;
    },

    /**
     * The entry for a page origin (scheme, host and port must all equal).
     * With `label`: the entry on that origin whose label equals it
     * (case-insensitive), else the entry whose username equals it (trimmed,
     * case-insensitive), else `reason: "label"` with the labels (never
     * usernames) on that origin. Without: the only entry, else the most recently used one
     * (`lastUsedAt`; never-used entries rank last, then newest added).
     * `rawUrl` is normalized again here, so a raw page URL works.
     */
    findForOrigin: (rawUrl: string, label?: string): FindResult => {
      const origin = normalizeOrigin(rawUrl);
      const onHost = origin ? load().entries.filter((e) => e.origin === origin) : [];
      if (onHost.length === 0) return { ok: false, reason: "none" };
      let picked: StoredEntry | undefined;
      const wanted = label?.trim().toLowerCase();
      if (wanted) {
        picked =
          onHost.find((e) => e.label.toLowerCase() === wanted) ??
          onHost.find((e) => e.username.trim().toLowerCase() === wanted);
        if (!picked) {
          return { ok: false, reason: "label", labels: onHost.map((e) => e.label).filter((l) => l !== "") };
        }
      } else if (onHost.length === 1) {
        picked = onHost[0];
      } else {
        const order = (e: StoredEntry) => e.lastUsedAt ?? 0;
        // Array.prototype.sort is stable: ties keep insertion order, so the
        // newest-added of the never-used entries is last in `onHost`.
        picked = [...onHost].sort((a, b) => order(b) - order(a)).at(0);
        if (picked && order(picked) === 0) picked = onHost[onHost.length - 1];
      }
      if (!picked) return { ok: false, reason: "none" };
      try {
        return { ok: true, entry: { ...summary(picked), password: decrypt(picked) } };
      } catch {
        return { ok: false, reason: "undecryptable" };
      }
    },

    /** Sets `lastUsedAt` after a fill. Best effort: a failed write is ignored. */
    markUsed: (id: string): void => {
      const file = load();
      const entries = file.entries.map((e) => (e.id === id ? { ...e, lastUsedAt: now() } : e));
      try {
        save({ ...file, entries });
      } catch {
        // not worth failing a login over
      }
    },

    /**
     * How a captured login relates to what is saved, without exposing any
     * password: same origin+username+password -> identical; same
     * origin+username, another password -> update; otherwise new. The
     * username is trimmed, like add() does.
     */
    classify: (rawUrl: string, username: string, password: string): Classification => {
      const origin = normalizeOrigin(rawUrl);
      const name = username.trim();
      const existing = origin ? load().entries.find((e) => e.origin === origin && e.username === name) : undefined;
      if (!existing) return "new";
      try {
        return decrypt(existing) === password ? "identical" : "update";
      } catch {
        return "update";
      }
    },

    isNever: (rawHost: string): boolean => {
      const host = normalizeHost(rawHost);
      return host !== null && load().never.includes(host);
    },
    addNever: (rawHost: string): boolean => {
      const host = normalizeHost(rawHost);
      if (!host) return false;
      const file = load();
      if (!file.never.includes(host)) save({ ...file, never: [...file.never, host] });
      return true;
    },
    removeNever: (rawHost: string): boolean => {
      const host = normalizeHost(rawHost);
      if (!host) return false;
      const file = load();
      if (!file.never.includes(host)) return false;
      save({ ...file, never: file.never.filter((h) => h !== host) });
      return true;
    },
    listNever: (): string[] => [...load().never].sort(),
  };
}

export type CredentialStore = ReturnType<typeof createCredentialStore>;
