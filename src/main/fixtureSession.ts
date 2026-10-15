// Cookies and `fresh` for PageFixture on the desktop browser.
//
// Everything here runs against the dedicated browser partition
// (`persist:penbrowser`) only — never the editor session, never the default
// session. `resetSession` clears ONLY the fixture's own origins, so the user's
// logins on other sites in the built-in browser survive. Site data is never
// cleared without an `origin`.

export interface FixtureCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** The subset of Electron.Cookie we read. */
export interface ElectronCookieLike {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface SessionLike {
  cookies: {
    get(filter: { url?: string; domain?: string }): Promise<ElectronCookieLike[]>;
    set(details: CookieSetDetails): Promise<void>;
    remove(url: string, name: string): Promise<void>;
  };
  clearStorageData(options: { origin: string; storages: SiteStorage[] }): Promise<void>;
}

export interface TabOps {
  /** Ids of BROWSER tabs only (never editor tabs). */
  listBrowserTabIds(): number[];
  closeTab(id: number): Promise<unknown>;
  /** Opens one new blank browser tab and makes it the agent's tab. */
  openBlankTab(): Promise<unknown>;
}

export type SiteStorage = "indexdb" | "localstorage" | "filesystem" | "serviceworkers" | "cachestorage";

export const SITE_STORAGES: SiteStorage[] = ["localstorage", "indexdb", "cachestorage", "serviceworkers", "filesystem"];

const SAME_SITE_OUT = { no_restriction: "None", lax: "Lax", strict: "Strict" } as const;
const SAME_SITE_IN = { None: "no_restriction", Lax: "lax", Strict: "strict" } as const;

export function toFixtureCookie(c: ElectronCookieLike): FixtureCookie {
  const out: FixtureCookie = { name: c.name, value: c.value };
  if (c.hostOnly && c.domain !== undefined) {
    // Host-only: no `domain`, so it round-trips as host-only (and `__Host-` stays valid).
    out.url = cookieUrl({ domain: c.domain, path: c.path, secure: c.secure });
  } else if (c.domain !== undefined) out.domain = c.domain;
  if (c.path !== undefined) out.path = c.path;
  if (c.expirationDate !== undefined) out.expires = c.expirationDate;
  if (c.httpOnly !== undefined) out.httpOnly = c.httpOnly;
  if (c.secure !== undefined) out.secure = c.secure;
  const same = c.sameSite && c.sameSite !== "unspecified" ? SAME_SITE_OUT[c.sameSite] : undefined;
  if (same) out.sameSite = same;
  return out;
}

/** The URL that matches a cookie: its own `url`, or built from domain + path. */
export function cookieUrl(c: { url?: string; domain?: string; path?: string; secure?: boolean }): string {
  if (c.url) return c.url;
  const host = (c.domain ?? "").replace(/^\./, "");
  return `${c.secure ? "https" : "http"}://${host}${c.path ?? "/"}`;
}

export function toElectronCookie(c: FixtureCookie): CookieSetDetails {
  const out: CookieSetDetails = { url: cookieUrl(c), name: c.name, value: c.value };
  // `__Host-` cookies must be host-only: Chromium rejects them with a Domain.
  if (c.domain !== undefined && !c.name.startsWith("__Host-")) out.domain = c.domain;
  if (c.path !== undefined) out.path = c.path;
  if (c.expires !== undefined) out.expirationDate = c.expires;
  if (c.httpOnly !== undefined) out.httpOnly = c.httpOnly;
  if (c.secure !== undefined) out.secure = c.secure;
  if (c.sameSite) out.sameSite = SAME_SITE_IN[c.sameSite];
  return out;
}

export async function getCookies(ses: SessionLike, urls?: string[]): Promise<FixtureCookie[]> {
  const lists = urls && urls.length > 0 ? await Promise.all(urls.map((url) => ses.cookies.get({ url }))) : [await ses.cookies.get({})];
  const seen = new Set<string>();
  const out: FixtureCookie[] = [];
  for (const c of lists.flat()) {
    const key = `${c.domain}|${c.path}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toFixtureCookie(c));
  }
  return out;
}

export async function setCookies(ses: SessionLike, cookies: FixtureCookie[]): Promise<void> {
  for (const c of cookies) await ses.cookies.set(toElectronCookie(c));
}

/** True for host-only cookies of `host`, or Domain=host / Domain=.host. */
function ownsCookie(host: string, domain: string | undefined): boolean {
  if (domain === undefined || domain === "") return true;
  return domain === host || domain === `.${host}`;
}

/**
 * `fresh`: close every browser tab, open one blank one, then clear cookies and
 * site data for EACH given origin only. No origins: only the tabs are reset.
 * sessionStorage and history die with the closed tabs.
 */
export async function resetSession(ses: SessionLike, tabs: TabOps, origins: string[] = []): Promise<void> {
  // Validate everything first: an invalid origin must change nothing.
  const targets = origins.map((origin) => {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new Error(`fresh: invalid origin "${origin}"`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`fresh: origin must be http or https: "${origin}"`);
    return { origin: u.origin, host: u.hostname };
  });
  for (const id of tabs.listBrowserTabIds()) await tabs.closeTab(id);
  await tabs.openBlankTab();
  for (const { origin, host } of targets) {
    // cookies.get({domain}) also returns path-scoped and Secure cookies.
    // Keep parent-domain cookies (Domain=.example.com) shared with sibling
    // subdomains: remove only the origin host's own. Cookies ignore ports, so
    // `http://localhost:3000` clears the localhost cookies of every localhost
    // port (a browser limitation).
    const cookies = (await ses.cookies.get({ domain: host })).filter((c) => ownsCookie(host, c.domain));
    for (const c of cookies) await ses.cookies.remove(cookieUrl({ domain: c.domain ?? host, path: c.path, secure: c.secure }), c.name);
    await ses.clearStorageData({ origin, storages: SITE_STORAGES });
  }
}
