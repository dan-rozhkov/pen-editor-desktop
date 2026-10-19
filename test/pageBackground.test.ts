import { describe, expect, it } from "vitest";
import { normalizePageColor, PAGE_BG_FALLBACK, SAMPLE_PAGE_BG_SCRIPT } from "../src/main/pageBackground";

describe("normalizePageColor", () => {
  it("falls back to white for transparent, empty and non-string input", () => {
    for (const v of ["", "transparent", "rgba(0, 0, 0, 0)", "rgba(10,20,30,0.0)", undefined, null, 5, "garbage", "rgb(300, 0, 0)"]) {
      expect(normalizePageColor(v)).toBe(PAGE_BG_FALLBACK);
    }
  });
  it("keeps opaque colours", () => {
    expect(normalizePageColor("rgb(18, 18, 18)")).toBe("rgb(18, 18, 18)");
    expect(normalizePageColor("rgba(18, 18, 18, 1)")).toBe("rgb(18, 18, 18)");
    expect(normalizePageColor("#1A1A1A")).toBe("#1a1a1a");
  });
  it("composites a translucent colour over white", () => {
    expect(normalizePageColor("rgba(0, 0, 0, 0.5)")).toBe("rgb(128, 128, 128)");
  });
});

describe("normalizePageColor on script output", () => {
  it("accepts the canvas-converted rgba(r, g, b, 1) string", () => {
    expect(normalizePageColor("rgba(18, 18, 18, 1)")).toBe("rgb(18, 18, 18)");
  });
  it("falls back to white for the empty failure result", () => {
    expect(normalizePageColor("")).toBe(PAGE_BG_FALLBACK);
  });
  it("does not pass authored-space colours through (conversion happens in the page)", () => {
    expect(normalizePageColor("oklch(0.2 0 0)")).toBe(PAGE_BG_FALLBACK);
  });
});

describe("SAMPLE_PAGE_BG_SCRIPT", () => {
  it("is syntactically valid and returns a string even without canvas support", () => {
    expect(typeof (0, eval)(SAMPLE_PAGE_BG_SCRIPT.replace(/document\.createElement\("canvas"\)/, "({ getContext: () => null })"))).toBe("string");
  });
  it("converts via canvas, honours dark color-scheme and is guarded by try/catch", () => {
    expect(SAMPLE_PAGE_BG_SCRIPT).toContain("getImageData");
    expect(SAMPLE_PAGE_BG_SCRIPT).toContain("colorScheme");
    expect(SAMPLE_PAGE_BG_SCRIPT).toContain("prefers-color-scheme: dark");
    expect(SAMPLE_PAGE_BG_SCRIPT).toContain("18, 18, 18");
    expect(SAMPLE_PAGE_BG_SCRIPT).toContain("catch");
  });
});
