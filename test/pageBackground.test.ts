import { describe, expect, it } from "vitest";
import { normalizePageColor, PAGE_BG_FALLBACK } from "../src/main/pageBackground";

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
