import type { TabKind } from "./tabManager";

/**
 * Leading icon of a tab in the agent layout's strip. Canvas (editor) tabs get a
 * canvas glyph; browser tabs the page's favicon (a data URL fetched by main) or,
 * until one arrives, a globe.
 */
export type TabIcon = { kind: "canvas" } | { kind: "favicon"; src: string } | { kind: "globe" };

/** Only data: image URLs ever reach the tab bar (its CSP allows `img-src data:` only). */
export function isTabFaviconSrc(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

export function tabIcon(kind: TabKind, favicon: string | undefined): TabIcon {
  if (kind === "editor") return { kind: "canvas" };
  return favicon !== undefined && isTabFaviconSrc(favicon) ? { kind: "favicon", src: favicon } : { kind: "globe" };
}

/** First usable favicon URL of a `page-favicon-updated` list (http/https/data), or null. */
export function pickFaviconUrl(favicons: readonly string[]): string | null {
  for (const f of favicons) {
    try {
      const p = new URL(f).protocol;
      if (p === "http:" || p === "https:") return f;
    } catch {
      // skip
    }
  }
  return null;
}
