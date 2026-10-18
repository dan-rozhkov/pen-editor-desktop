import { describe, expect, it } from "vitest";
import { acceptFavicon, createFaviconMemo, createGeneration, pickFavicon, shouldClearFavicon, tabIcon } from "../src/main/tabIcons";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("tabIcon / acceptFavicon", () => {
  it("canvas glyph for editor tabs", () => {
    expect(tabIcon("editor", undefined)).toEqual({ kind: "canvas" });
    expect(tabIcon("editor", PNG)).toEqual({ kind: "canvas" });
  });
  it("favicon for a browser tab that has one, globe otherwise", () => {
    expect(tabIcon("browser", PNG)).toEqual({ kind: "favicon", src: PNG });
    expect(tabIcon("browser", undefined)).toEqual({ kind: "globe" });
  });
  it("acceptFavicon is the single icon validator (shared with the Passwords window)", () => {
    expect(acceptFavicon(PNG)).toBe(PNG);
    expect(acceptFavicon("https://evil.test/x.png")).toBeUndefined();
    expect(acceptFavicon("data:text/html;base64,AAAA")).toBeUndefined();
    expect(acceptFavicon(42)).toBeUndefined();
  });
});

describe("pickFavicon", () => {
  it("takes a valid data: icon without fetching, skipping unsafe data URLs", () => {
    expect(pickFavicon(["data:text/html;base64,AAAA", PNG, "https://a.test/f.ico"])).toEqual({ type: "data", dataUrl: PNG });
  });
  it("takes the first http(s) URL to fetch, skipping other schemes", () => {
    expect(pickFavicon(["chrome://x", "https://a.test/f.ico", "https://b.test/g.png"])).toEqual({ type: "url", url: "https://a.test/f.ico" });
  });
  it("returns null when nothing is usable", () => {
    expect(pickFavicon(["nonsense", "data:image/png,raw"])).toBeNull();
    expect(pickFavicon([])).toBeNull();
  });
});

describe("favicon race guards", () => {
  it("drops a fetch result that arrives after a new document began", () => {
    const gen = createGeneration();
    const started = gen.bump();
    expect(gen.isCurrent(started)).toBe(true);
    gen.bump(); // did-navigate to another document / tab destroyed
    expect(gen.isCurrent(started)).toBe(false);
  });
  it("clears the icon only when the origin changed", () => {
    expect(shouldClearFavicon("https://a.test/x", "https://a.test/y")).toBe(false);
    expect(shouldClearFavicon("https://a.test/x", "https://b.test/")).toBe(true);
    expect(shouldClearFavicon(null, "https://b.test/")).toBe(false);
  });
  it("memoizes by favicon URL with a bound", () => {
    const m = createFaviconMemo(2);
    m.set("u1", "d1"); m.set("u2", "d2"); m.set("u3", "d3");
    expect(m.get("u1")).toBeUndefined();
    expect(m.get("u3")).toBe("d3");
  });
});
