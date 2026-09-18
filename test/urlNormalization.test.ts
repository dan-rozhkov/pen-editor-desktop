import { describe, it, expect } from "vitest";

// urlNormalization.ts is a plain global script (no import/export — see its
// header comment), not an ES module — tsc/TypeScript module resolution
// therefore refuses a static `import` of it ("File is not a module"), so it
// is loaded with `require(...)` instead, the same way it exposes itself to
// Node/CommonJS via its own `module.exports` guard. Vite/esbuild's
// CommonJS interop is what lets Vitest's `require` resolve and load a
// plain .ts script this way (the explicit ".ts" extension is required —
// Vitest's require shim does not add it automatically).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const urlNorm = require("../src/tabbar/urlNormalization.ts") as {
  normalizeTypedUrl: (input: string) => string;
  isNavigableUrl: (value: string) => boolean;
};

const { normalizeTypedUrl, isNavigableUrl } = urlNorm;

// Finding 5: the address row's typed-input normalizer only routed to a
// Pinterest search when the input had neither a "." nor a ":", so an
// ordinary multi-word query containing either character (most of them)
// fell through to `https://` + the raw string — which `new URL()` then
// rejects — silently denying the navigation with no feedback.
describe("normalizeTypedUrl", () => {
  it("routes ordinary multi-word queries to a Pinterest search, even when they contain a dot or colon", () => {
    expect(normalizeTypedUrl("figma.com alternatives")).toBe(
      "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent("figma.com alternatives"),
    );
    expect(normalizeTypedUrl("ui design 2.0")).toBe(
      "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent("ui design 2.0"),
    );
    expect(normalizeTypedUrl("app design: dark mode")).toBe(
      "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent("app design: dark mode"),
    );
  });

  it("routes a single bare word (no dot) to a Pinterest search", () => {
    expect(normalizeTypedUrl("pinterest")).toBe(
      "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent("pinterest"),
    );
  });

  it("prepends https:// to a bare hostname", () => {
    expect(normalizeTypedUrl("figma.com")).toBe("https://figma.com");
    expect(normalizeTypedUrl("www.example.com/path?x=1")).toBe("https://www.example.com/path?x=1");
  });

  it("leaves an already-schemed URL alone", () => {
    expect(normalizeTypedUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(normalizeTypedUrl("http://localhost:1234")).toBe("http://localhost:1234");
  });

  it("returns an empty string for empty/whitespace-only input", () => {
    expect(normalizeTypedUrl("")).toBe("");
    expect(normalizeTypedUrl("   ")).toBe("");
  });

  it("falls back to a search when the candidate URL fails to parse", () => {
    expect(normalizeTypedUrl("http://")).toBe(
      "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent("http://"),
    );
  });
});

describe("isNavigableUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(isNavigableUrl("https://example.com")).toBe(true);
    expect(isNavigableUrl("http://example.com")).toBe(true);
  });

  it("rejects non-http(s) schemes and unparsable strings", () => {
    expect(isNavigableUrl("file:///etc/passwd")).toBe(false);
    expect(isNavigableUrl("javascript:alert(1)")).toBe(false);
    expect(isNavigableUrl("not a url")).toBe(false);
    expect(isNavigableUrl("")).toBe(false);
  });

  it("every normalizeTypedUrl output (for non-empty input) is navigable", () => {
    for (const input of ["figma.com alternatives", "pinterest", "figma.com", "https://example.com/x"]) {
      expect(isNavigableUrl(normalizeTypedUrl(input))).toBe(true);
    }
  });
});
