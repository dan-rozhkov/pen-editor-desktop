import type { CredentialFs } from "./credentialStore";

/**
 * Site icons for the Passwords window, cached per origin in a small file in
 * userData. Pure and Electron-free: the file system and the fetch are
 * injected. The icon of a page comes from the browser tab's own
 * `page-favicon-updated` event and is downloaded through the browser tab's
 * session (window.ts); the Passwords window itself never fetches anything.
 * An icon is only downloaded for an origin that has a saved login (an icon
 * seen earlier is kept as a URL and fetched once a login is saved). The cache
 * file stores each icon with the favicon URL it came from, so a page that
 * reports another URL later gets a refetch; icons of origins without a login
 * are dropped on load and when the last login of an origin is removed.
 */

export const FAVICONS_FILE = "browser-favicons.json";
export const MAX_ICON_BYTES = 64 * 1024;
const MAX_ENTRIES = 200;
const MAX_PENDING = 100;

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** A failed fetch of the same favicon URL is retried after this long. */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

// The icon data-URL pattern is shared with the Passwords renderer (a plain
// script): one copy, in src/passwords/helpers.ts. `require` because that file
// has no exports (it is loaded by <script>); the extension follows how this
// file itself is loaded (compiled .js in dist, .ts under vitest).
const iconHelpers = require(`../../passwords/helpers${__filename.endsWith(".ts") ? ".ts" : ".js"}`) as { isIconDataUrl(value: unknown): value is string };

/** True for a data: URL of an allowed image type (the only shape that ever leaves main). */
export function isSafeIconDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= Math.ceil((MAX_ICON_BYTES * 4) / 3) + 64 && iconHelpers.isIconDataUrl(value);
}

/** Bytes + content type -> data URL, or null for a wrong type, an empty body or a body over 64 KB. */
export function toIconDataUrl(contentType: string, bytes: Uint8Array): string | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) return null;
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface FetchedIcon {
  contentType: string;
  bytes: Uint8Array;
}

/**
 * A fetcher over an injected `fetch` (the browser session's). http(s) only,
 * 3 s timeout, image/* only, body capped at 64 KB while reading.
 */
export function createIconFetcher(fetchFn: (url: string, init: { signal: AbortSignal }) => Promise<Response>) {
  return async (url: string): Promise<FetchedIcon | null> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    try {
      const res = await fetchFn(parsed.href, { signal: AbortSignal.timeout(3000) });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !contentType.toLowerCase().startsWith("image/") || !res.body) return null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_ICON_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      return { contentType, bytes: Buffer.concat(chunks) };
    } catch {
      return null;
    }
  };
}

export interface FaviconCacheDeps {
  filePath: string;
  fs: Pick<CredentialFs, "read" | "write">;
  fetchIcon: (url: string) => Promise<FetchedIcon | null>;
  /** True when a login is saved for this origin. */
  isWanted: (origin: string) => boolean;
  /** Called after an icon was stored or replaced (the Passwords window refreshes its tiles). */
  onChange?: () => void;
  /** Clock for the retry backoff; defaults to Date.now. */
  now?: () => number;
}

interface CachedIcon {
  /** The favicon URL the data came from. */
  src: string;
  data: string;
}

export function createFaviconCache(deps: FaviconCacheDeps) {
  const now = deps.now ?? Date.now;
  let cache: Map<string, CachedIcon> | null = null;
  const pending = new Map<string, string>(); // origin -> first favicon URL seen, not yet fetched
  const failed = new Map<string, { src: string; at: number }>(); // origin -> last failed fetch
  const inFlight = new Set<string>();

  const load = (): Map<string, CachedIcon> => {
    if (cache) return cache;
    cache = new Map();
    try {
      const text = deps.fs.read(deps.filePath);
      const parsed: unknown = text === null ? null : JSON.parse(text);
      const icons = typeof parsed === "object" && parsed !== null ? (parsed as { icons?: unknown }).icons : null;
      if (typeof icons === "object" && icons !== null && !Array.isArray(icons)) {
        for (const [origin, value] of Object.entries(icons)) {
          if (typeof value !== "object" || value === null) continue;
          const { src, data } = value as { src?: unknown; data?: unknown };
          // Only origins that still have a login keep an icon.
          if (typeof src === "string" && isSafeIconDataUrl(data) && deps.isWanted(origin)) cache.set(origin, { src, data });
        }
      }
    } catch {
      // unreadable: start empty; the next write replaces it
    }
    return cache;
  };

  const persist = (): void => {
    const icons = load();
    while (icons.size > MAX_ENTRIES) icons.delete(icons.keys().next().value as string);
    try {
      deps.fs.write(deps.filePath, JSON.stringify({ version: 2, icons: Object.fromEntries(icons) }));
    } catch {
      // a cache: losing a write is fine
    }
  };

  /** True while a fetch of this URL failed recently enough not to try again. */
  const backingOff = (origin: string, url: string): boolean => {
    const f = failed.get(origin);
    return f !== undefined && f.src === url && now() - f.at < RETRY_AFTER_MS;
  };

  async function fetchInto(origin: string, url: string): Promise<void> {
    if (inFlight.has(origin)) return;
    inFlight.add(origin);
    try {
      const got = await deps.fetchIcon(url);
      const dataUrl = got ? toIconDataUrl(got.contentType, got.bytes) : null;
      if (!dataUrl) {
        failed.set(origin, { src: url, at: now() });
        return;
      }
      failed.delete(origin);
      if (!deps.isWanted(origin)) return; // the last login went away while the fetch ran
      const icons = load();
      icons.delete(origin);
      icons.set(origin, { src: url, data: dataUrl });
      persist();
      deps.onChange?.();
    } finally {
      inFlight.delete(origin);
    }
  }

  return {
    get(origin: string): string | undefined {
      return load().get(origin)?.data;
    },
    /** A tab at `origin` reported its favicon URLs. Only the first is used. */
    async seen(origin: string, urls: string[]): Promise<void> {
      const url = urls[0];
      if (!url || load().get(origin)?.src === url || backingOff(origin, url)) return;
      if (!deps.isWanted(origin)) {
        pending.delete(origin);
        pending.set(origin, url);
        while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
        return;
      }
      await fetchInto(origin, url);
    },
    /** Fetches icons seen earlier for origins that have a login now. */
    async flushPending(): Promise<void> {
      for (const [origin, url] of [...pending]) {
        if (load().get(origin)?.src === url) {
          pending.delete(origin);
        } else if (backingOff(origin, url)) {
          // keep it: a later flush retries once the backoff is over
        } else if (deps.isWanted(origin)) {
          await fetchInto(origin, url);
          // Kept after a failed fetch: a later flush retries once the backoff is over.
          if (load().get(origin)?.src === url) pending.delete(origin);
        }
      }
    },
    /** The last login of `origin` was removed: its icon and any queued fetch go too. */
    forget(origin: string): void {
      pending.delete(origin);
      failed.delete(origin);
      if (load().delete(origin)) persist();
    },
  };
}

export type FaviconCache = ReturnType<typeof createFaviconCache>;
