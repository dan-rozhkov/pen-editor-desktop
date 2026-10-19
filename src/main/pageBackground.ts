/**
 * The page's own background colour, sampled for the tab bar's address-row tail
 * (the strip under the page view's rounded top corners). Pure helpers; the
 * executeJavaScript call itself lives in window.ts.
 */
export const PAGE_BG_FALLBACK = "#ffffff";

/**
 * Script run in the page: the first non-transparent background of <html>, then <body>.
 * Returns a CSS colour string ("" when both are transparent).
 */
export const SAMPLE_PAGE_BG_SCRIPT = `(() => {
  const read = (el) => (el ? getComputedStyle(el).backgroundColor : "");
  const isClear = (c) => !c || c === "transparent" || /^rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0(\\.0+)?\\s*\\)$/.test(c);
  const a = read(document.documentElement);
  if (!isClear(a)) return a;
  const b = read(document.body);
  return isClear(b) ? "" : b;
})()`;

/** A sampled colour is usable only as an opaque rgb()/rgba() with alpha > 0 or a #hex; anything else falls back to white. */
export function normalizePageColor(raw: unknown): string {
  if (typeof raw !== "string") return PAGE_BG_FALLBACK;
  const c = raw.trim().toLowerCase();
  if (c === "" || c === "transparent") return PAGE_BG_FALLBACK;
  const m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(c);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (!(alpha > 0)) return PAGE_BG_FALLBACK;
    const ch = [m[1], m[2], m[3]].map(Number);
    if (ch.some((n) => n > 255)) return PAGE_BG_FALLBACK;
    // A translucent page background is painted over white by Chromium.
    const over = (n: number) => Math.round(n * Math.min(alpha, 1) + 255 * (1 - Math.min(alpha, 1)));
    return `rgb(${over(ch[0])}, ${over(ch[1])}, ${over(ch[2])})`;
  }
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  return PAGE_BG_FALLBACK;
}
