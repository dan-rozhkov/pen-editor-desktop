import { isSafeIconDataUrl } from "./browser/faviconCache";
import type { TabKind } from "./tabManager";

/**
 * Leading icon of a tab in the agent layout's strip. Canvas (editor) tabs get a
 * canvas glyph; browser tabs the page's favicon (a data URL) or, until one
 * arrives, a globe.
 */
export type TabIcon = { kind: "canvas" } | { kind: "favicon"; src: string } | { kind: "globe" };

/**
 * Validates a favicon ONCE, when it is stored on a tab (the single data-URL
 * validator of the shell, `isSafeIconDataUrl`; the tab bar CSP allows `img-src data:` only).
 * Returns the value when safe, else undefined.
 */
export function acceptFavicon(value: unknown): string | undefined {
  return isSafeIconDataUrl(value) ? value : undefined;
}

/** `favicon` must come from `acceptFavicon` (validated at store time, not per snapshot). */
export function tabIcon(kind: TabKind, favicon: string | undefined): TabIcon {
  if (kind === "editor") return { kind: "canvas" };
  return favicon !== undefined ? { kind: "favicon", src: favicon } : { kind: "globe" };
}

export type FaviconChoice = { type: "data"; dataUrl: string } | { type: "url"; url: string };

/**
 * First usable entry of a `page-favicon-updated` list: a valid data: icon (used
 * as is, no fetch) or an http(s) URL (to fetch). Everything else is skipped.
 */
export function pickFavicon(favicons: readonly string[]): FaviconChoice | null {
  for (const f of favicons) {
    if (f.startsWith("data:")) {
      const ok = acceptFavicon(f);
      if (ok) return { type: "data", dataUrl: ok };
      continue;
    }
    try {
      const p = new URL(f).protocol;
      if (p === "http:" || p === "https:") return { type: "url", url: f };
    } catch {
      // skip
    }
  }
  return null;
}

/** Per-tab navigation generation: a fetch started under one generation is dropped once a new document began. */
export function createGeneration() {
  let current = 0;
  return {
    /** Starts a new generation (a new document, or the tab is gone). */
    bump: (): number => ++current,
    get: (): number => current,
    isCurrent: (g: number): boolean => g === current,
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a navigation to `navigatedUrl` must clear the shown favicon: yes when the
 * origin changed (the old icon belongs to another site), no on a same-site navigation
 * (Chromium does not re-announce an unchanged icon, so clearing would leave a globe).
 */
export function shouldClearFavicon(iconPageUrl: string | null, navigatedUrl: string): boolean {
  if (iconPageUrl === null) return false;
  return originOf(iconPageUrl) !== originOf(navigatedUrl);
}

/** Small bounded memo of fetched icons by favicon URL (same-site navigations do not refetch). */
export function createFaviconMemo(max = 100) {
  const map = new Map<string, string>();
  return {
    get: (url: string): string | undefined => map.get(url),
    set: (url: string, dataUrl: string): void => {
      if (map.size >= max) map.delete(map.keys().next().value as string);
      map.set(url, dataUrl);
    },
  };
}
