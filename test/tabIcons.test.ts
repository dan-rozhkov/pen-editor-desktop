import { describe, expect, it } from "vitest";
import { isTabFaviconSrc, pickFaviconUrl, tabIcon } from "../src/main/tabIcons";

describe("tabIcon", () => {
  it("canvas glyph for editor tabs, whatever favicon", () => {
    expect(tabIcon("editor", undefined)).toEqual({ kind: "canvas" });
    expect(tabIcon("editor", "data:image/png;base64,AAAA")).toEqual({ kind: "canvas" });
  });
  it("favicon for a browser tab that has one, globe fallback otherwise", () => {
    expect(tabIcon("browser", "data:image/png;base64,AAAA")).toEqual({ kind: "favicon", src: "data:image/png;base64,AAAA" });
    expect(tabIcon("browser", undefined)).toEqual({ kind: "globe" });
  });
  it("falls back to the globe for an unsafe favicon value", () => {
    expect(tabIcon("browser", "https://evil.test/x.png")).toEqual({ kind: "globe" });
    expect(tabIcon("browser", "data:text/html;base64,AAAA")).toEqual({ kind: "globe" });
  });
});

describe("isTabFaviconSrc / pickFaviconUrl", () => {
  it("accepts only base64 image data URLs", () => {
    expect(isTabFaviconSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBe(true);
    expect(isTabFaviconSrc("data:image/png,raw")).toBe(false);
    expect(isTabFaviconSrc(42)).toBe(false);
  });
  it("picks the first http(s) favicon", () => {
    expect(pickFaviconUrl(["chrome://x", "https://a.test/f.ico", "https://b.test/g.png"])).toBe("https://a.test/f.ico");
    expect(pickFaviconUrl(["nonsense"])).toBeNull();
    expect(pickFaviconUrl([])).toBeNull();
  });
});
