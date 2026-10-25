import { describe, expect, it } from "vitest";
import { isShownUrl, parseOmniboxShow, parseUrlPayload } from "../src/main/omniboxIpc";

const item = { url: "https://a.test/", title: "A", lastVisitedAt: 5 };
const ok = { items: [item], selected: 0, query: "a", rect: { x: 1, y: 2, width: 300 } };

describe("parseOmniboxShow", () => {
  it("accepts a valid payload and rebuilds the items", () => {
    const r = parseOmniboxShow({ ...ok, items: [{ ...item, extra: 1 }] });
    expect(r).toEqual(ok);
  });
  it("accepts selected -1 and an empty list", () => {
    expect(parseOmniboxShow({ ...ok, selected: -1 })).not.toBeNull();
    expect(parseOmniboxShow({ ...ok, items: [], selected: -1 })?.items).toEqual([]);
  });
  it.each([
    ["null", null],
    ["too many items", { ...ok, items: Array.from({ length: 9 }, () => item) }],
    ["non-integer selected", { ...ok, selected: 0.5 }],
    ["selected past the end", { ...ok, selected: 1 }],
    ["bad query", { ...ok, query: 3 }],
    ["rect NaN", { ...ok, rect: { x: NaN, y: 0, width: 1 } }],
    ["item url too long", { ...ok, items: [{ ...item, url: "h".repeat(2049) }] }],
    ["item title number", { ...ok, items: [{ ...item, title: 1 }] }],
    ["item time infinite", { ...ok, items: [{ ...item, lastVisitedAt: Infinity }] }],
  ])("rejects %s", (_n, payload) => {
    expect(parseOmniboxShow(payload)).toBeNull();
  });
});

describe("url helpers", () => {
  it("parseUrlPayload", () => {
    expect(parseUrlPayload({ url: "https://a.test/" })).toBe("https://a.test/");
    expect(parseUrlPayload({ url: 1 })).toBeNull();
    expect(parseUrlPayload(undefined)).toBeNull();
  });
  it("isShownUrl", () => {
    expect(isShownUrl([item], "https://a.test/")).toBe(true);
    expect(isShownUrl([item], "https://b.test/")).toBe(false);
  });
});
