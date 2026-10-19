/**
 * The page's own background colour, sampled for the tab bar's address-row tail
 * (the strip under the page view's rounded top corners). Pure helpers; the
 * executeJavaScript call itself lives in window.ts.
 */
export const PAGE_BG_FALLBACK = "#ffffff";

/**
 * Script run in the page. Computed colours come back in their authored space
 * (oklch(), lab(), color(srgb ...), color-mix), so each candidate is painted onto a
 * 1x1 canvas and read back as sRGB numbers. The first non-transparent background of
 * <html>, then <body>, wins. When both are clear, the page shows Chromium's canvas:
 * rgb(18,18,18) when the used colour scheme is dark (:root color-scheme containing
 * "dark" under a dark OS appearance), else white. Translucent colours are composited
 * over that same base. Always returns an "rgba(r, g, b, 1)" string; "" on any failure.
 */
export const SAMPLE_PAGE_BG_SCRIPT = `(() => {
  try {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return "";
    ctx.canvas.width = 1;
    ctx.canvas.height = 1;
    const paint = (css) => {
      if (!css || css === "transparent") return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return d[3] === 0 ? null : [d[0], d[1], d[2], d[3] / 255];
    };
    const read = (el) => (el ? paint(getComputedStyle(el).backgroundColor) : null);
    // The meta tag sets the used scheme without touching the computed property.
    const meta = document.querySelector('meta[name="color-scheme"]');
    const cssScheme = (getComputedStyle(document.documentElement).colorScheme || "").toLowerCase();
    const scheme = cssScheme && cssScheme !== "normal" ? cssScheme : ((meta && meta.getAttribute("content")) || "").toLowerCase();
    const osDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const usedDark = scheme.includes("dark") && (osDark || !scheme.includes("light"));
    const base = usedDark ? [18, 18, 18] : [255, 255, 255];
    const c = read(document.documentElement) || read(document.body);
    if (!c) return "rgba(" + base.join(", ") + ", 1)";
    const out = [0, 1, 2].map((i) => Math.round(c[i] * c[3] + base[i] * (1 - c[3])));
    return "rgba(" + out.join(", ") + ", 1)";
  } catch (e) {
    return "";
  }
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
