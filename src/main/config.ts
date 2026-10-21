// The frontend serves the showcase gallery at "/" and the editor itself at
// "/app" — the shell must open the editor, never the gallery. An explicit
// PEN_DESKTOP_URL override is used verbatim, so it has to carry "/app" too
// (see the `dev` script in package.json).
export const DEFAULT_EDITOR_URL = "https://app.sideform.pro/app";

/** The origin the desktop loaded before 2026-10-20 (it is the same static site, now
 * also served on app.sideform.pro). Only the one-time storage migration reads it
 * (originMigration.ts); nothing loads it as the editor any more. */
export const LEGACY_EDITOR_ORIGIN = "https://pen-editor.onrender.com";

/** Editor URL: PEN_DESKTOP_URL override (http/https only), else production. */
export function resolveEditorUrl(env: NodeJS.ProcessEnv): string {
  const override = env.PEN_DESKTOP_URL;
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "http:" || url.protocol === "https:") return override;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_EDITOR_URL;
}

/** The built-in browser's human-like cursor overlay (see BrowserController's
 * `moveCursor`) is on by default — it's what makes the agent driving the
 * browser tab visible to the user watching it. `PEN_DESKTOP_BROWSER_CURSOR`
 * is the kill switch, matched case-insensitively against "off"/"0"/"false";
 * anything else (including unset) leaves it on. */
export function resolveBrowserCursorEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PEN_DESKTOP_BROWSER_CURSOR;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "off" && normalized !== "0" && normalized !== "false";
}

/** True when an env var carries a real value. Empty and whitespace-only
 * count as UNSET (so they neither lock a menu item nor override a saved
 * choice) — both cursor vars use this same rule. */
export function isEnvValueSet(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "";
}

/** `PEN_DESKTOP_USER_DATA_DIR` overrides Electron's userData directory (read
 * in index.ts before `app.ready`). Used by e2e so every run gets a fresh dir
 * and a developer's saved cursor settings never leak in. Empty = unset. */
export function resolveUserDataDir(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PEN_DESKTOP_USER_DATA_DIR;
  return isEnvValueSet(raw) ? (raw as string).trim() : undefined;
}

/** The product name shown to the user. Applied with `app.setName` AFTER ready. */
export const DISPLAY_APP_NAME = "Sideform Desktop";
/** The name the app had before the rename. Its userData directory
 * (`<appData>/Pineapple Editor`) and its Keychain item
 * (`Pineapple Editor Safe Storage`) hold the user's cookies, settings and
 * saved logins, so both stay in use for an existing install. */
export const LEGACY_APP_NAME = "Pineapple Editor";

export const STORAGE_IDENTITY_FILE = "storage-identity.json";

export interface StorageIdentity {
  /** Directory for `app.setPath("userData", ...)`. */
  userDataDir: string;
  /** Name to give `app.setName` BEFORE ready: Chromium derives the safeStorage
   * Keychain item ("<name> Safe Storage") from the name at that moment, and
   * ignores any later `setName`. */
  storageName: string;
}

/** Injected file-system reads (sync: runs before `app.ready`). */
export interface IdentityFs {
  exists(p: string): boolean;
  isDirectory(p: string): boolean;
  /** File text, or null when missing/unreadable. */
  read(p: string): string | null;
}

/**
 * Decides, once and before `app.ready`, which on-disk identity this launch uses.
 * Directory: env override; else the NEW dir if it exists; else the legacy
 * `<appData>/Pineapple Editor` dir if it exists AS A DIRECTORY; else the new dir.
 * Name (the Keychain item): sticky, tied to the directory actually used:
 * `storage-identity.json` in that dir wins; else the legacy name when the dir is
 * the legacy dir; else the new name.
 */
export function resolveStorageIdentity(
  env: NodeJS.ProcessEnv,
  appDataDir: string,
  fs: IdentityFs,
  join: (...parts: string[]) => string,
): StorageIdentity {
  const legacyDir = join(appDataDir, LEGACY_APP_NAME);
  const newDir = join(appDataDir, DISPLAY_APP_NAME);
  const userDataDir =
    resolveUserDataDir(env) ?? (fs.exists(newDir) ? newDir : fs.isDirectory(legacyDir) ? legacyDir : newDir);
  let stored: string | undefined;
  try {
    const text = fs.read(join(userDataDir, STORAGE_IDENTITY_FILE));
    const name = text === null ? undefined : (JSON.parse(text) as { storageName?: unknown }).storageName;
    if (name === LEGACY_APP_NAME || name === DISPLAY_APP_NAME) stored = name;
  } catch {
    stored = undefined;
  }
  return { userDataDir, storageName: stored ?? (userDataDir === legacyDir ? LEGACY_APP_NAME : DISPLAY_APP_NAME) };
}

/** The identity file text to persist; written once so the name sticks. */
export const storageIdentityFileText = (id: StorageIdentity): string => JSON.stringify({ storageName: id.storageName });

/** The agent panel page, derived from the editor URL (same origin):
 * - the LAST path segment `app` becomes `agent`, keeping any base path prefix
 *   (`https://host/pen/app` -> `https://host/pen/agent`); a trailing slash is
 *   ignored (`/app/` -> `/agent`);
 * - a path that does not end in an `app` segment gets `agent` as a sibling of
 *   its last segment, i.e. `agent` resolved relative to the URL (`/` and
 *   `/other` -> `/agent`, `/pen/x` -> `/pen/agent`, `/pen/` -> `/pen/agent`);
 * - the editor's query string and hash are dropped: they are editor-only
 *   params and must not leak into the panel. */
export function resolveAgentPanelUrl(editorUrl: string): string {
  const url = new URL(editorUrl);
  url.search = "";
  url.hash = "";
  const segments = url.pathname.split("/");
  // Ignore one trailing slash only when it follows an `app` segment.
  if (segments.length > 2 && segments[segments.length - 1] === "" && segments[segments.length - 2] === "app") {
    segments.pop();
  }
  segments[segments.length - 1] = "agent";
  url.pathname = segments.join("/");
  return url.toString();
}

/** The URL editor tabs load in the agent layout: the chat lives in the left
 * panel, so tabs are canvas tabs, i.e. the editor in chatless mode
 * (`chat=off`). Other query params, the path and the hash are kept; an
 * existing `chat` param (any number of them) is replaced, never duplicated. */
export function resolveCanvasTabUrl(editorUrl: string): string {
  const url = new URL(editorUrl);
  // Edit the RAW query string: URLSearchParams would re-serialize every other
  // param (`%20` -> `+`, `~` -> `%7E`, `flag` -> `flag=`).
  const kept = url.search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "" && decodeURIComponent_safe(pair.split("=")[0]) !== "chat");
  kept.push("chat=off");
  url.search = kept.join("&");
  return url.toString();
}

/**
 * Shared URL shape of the frontend's non-editor pages: the LAST `app` path segment becomes
 * `segment` (prefix kept, `/app/` -> `/<segment>`), `extraSegments` follow it, the editor URL's
 * query is kept except the `drop` keys, `append` pairs are added after it, hash is dropped.
 */
function frontendTabUrl(
  editorUrl: string,
  segment: string,
  opts: { extraSegments?: string[]; drop: string[]; append: string[] },
): string {
  const url = new URL(editorUrl);
  url.hash = "";
  const segments = url.pathname.split("/");
  if (segments.length > 2 && segments[segments.length - 1] === "" && segments[segments.length - 2] === "app") {
    segments.pop();
  }
  segments[segments.length - 1] = segment;
  segments.push(...(opts.extraSegments ?? []));
  url.pathname = segments.join("/");
  const kept = url.search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "" && !opts.drop.includes(decodeURIComponent_safe(pair.split("=")[0])));
  kept.push(...opts.append);
  url.search = kept.join("&");
  return url.toString();
}

/** The URL a document tab loads (the frontend's markdown editor at `/doc`).
 * Same shape rule as `resolveAgentPanelUrl` for the path (the LAST path segment
 * `app` becomes `doc`, prefix kept, `/app/` -> `/doc`; a path not ending in
 * `app` gets `doc` beside its last segment). Query and hash of the editor URL
 * are kept, `chat` is forced to `off` (the chat is in the panel), and an
 * `docId` becomes `id=<docId>` placed before `chat=off`; without it `new=1` is used
 * (open a NEW document). Any `id`, `new` or `chat` param of the editor URL is replaced, never duplicated. The docId is
 * validated by the caller (`isValidDocId`); it is still encoded here. */
export function resolveDocTabUrl(editorUrl: string, docId?: string): string {
  // No docId = a NEW document: the page creates it and rewrites the URL to `?id=<newId>`.
  return frontendTabUrl(editorUrl, "doc", {
    drop: ["chat", "id", "new"],
    append: [docId !== undefined ? `id=${encodeURIComponent(docId)}` : "new=1", "chat=off"],
  });
}

/** The section ids of the frontend's `/settings` page (`?section=<id>`). */
export const SETTINGS_SECTIONS = ["account", "appearance", "canvas", "agent", "browser", "integrations", "shortcuts"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** True for one of the settings section ids; anything else (also non-strings) is not. */
export function isValidSettingsSection(section: unknown): section is SettingsSection {
  return typeof section === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(section);
}

/**
 * The URL of the Settings tab: same shape rule as `resolveDocTabUrl` for the path (the LAST
 * `app` segment becomes `settings`, prefix kept, `/app/` -> `/settings`). Query of the editor URL
 * is kept except `chat` and `section`; `chat=off` is appended, then `section=<id>` when the
 * section is valid (an invalid one is dropped). Hash is dropped.
 */
export function resolveSettingsTabUrl(editorUrl: string, section?: unknown): string {
  return frontendTabUrl(editorUrl, "settings", {
    drop: ["chat", "section"],
    append: ["chat=off", ...(isValidSettingsSection(section) ? [`section=${section}`] : [])],
  });
}

/** A document id the agent panel may ask to open: 1-64 of `A-Za-z0-9_-`. */
export function isValidDocId(docId: unknown): docId is string {
  return typeof docId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(docId);
}

/** True when the URL is the frontend's doc page: the last path segment is `doc` (`/doc`, `/prefix/doc`, trailing slash allowed). */
export function isDocPageUrl(rawUrl: string): boolean {
  try {
    const segments = new URL(rawUrl).pathname.replace(/\/+$/, "").split("/");
    return segments[segments.length - 1] === "doc";
  } catch {
    return false;
  }
}

/** True when the URL is the doc page ON the editor's origin (a same-path page on another origin is not). */
export function isDocPageOn(rawUrl: string | undefined, editorOrigin: string): boolean {
  if (rawUrl === undefined) return false;
  try {
    return new URL(rawUrl).origin === editorOrigin && isDocPageUrl(rawUrl);
  } catch {
    return false;
  }
}

/** The `id` query param of a document tab URL, or null (not a URL, no `id`). */
export function docIdOfUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get("id");
  } catch {
    return null;
  }
}

/**
 * The URL of a browse-trace tab: the last `app` path segment becomes `trace/<id>`
 * (a path not ending in `app` gets `trace/<id>` beside its last segment). Query of the
 * editor URL is kept except `chat` and `src`; `src=local&chat=off` are appended. The id is
 * validated by the caller (`isValidTraceId`); it is still encoded here.
 */
export function resolveTraceTabUrl(editorUrl: string, traceId: string): string {
  return frontendTabUrl(editorUrl, "trace", {
    extraSegments: [encodeURIComponent(traceId)],
    drop: ["chat", "src"],
    append: ["src=local", "chat=off"],
  });
}

/** A trace id the agent panel may ask to open: 1-64 of `A-Za-z0-9_-` (the browse-trace id format). */
export function isValidTraceId(traceId: unknown): traceId is string {
  return typeof traceId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(traceId);
}

/** The trace id in the path of a trace tab URL (`/trace/<id>`), or null. */
export function traceIdOfUrl(rawUrl: string): string | null {
  try {
    const segments = new URL(rawUrl).pathname.split("/");
    const id = decodeURIComponent_safe(segments[segments.length - 1] ?? "");
    return segments[segments.length - 2] === "trace" && isValidTraceId(id) ? id : null;
  } catch {
    return null;
  }
}

function decodeURIComponent_safe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Tabs a new main window opens: none. The window starts EMPTY (only the agent
 * panel); a canvas tab opens when the agent or the user asks for one. */
export const INITIAL_TABS: readonly ("editor" | "browser" | "doc")[] = [];
