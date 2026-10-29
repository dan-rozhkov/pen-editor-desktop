import { describe, expect, it } from "vitest";

// recentFilter.ts is a plain global script (see its header); it is loaded with require like relativeTime.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { filterRecentItems } = require("../src/tabbar/recentFilter.ts") as {
  filterRecentItems(
    items: { kind: "canvas" | "doc"; title: string; updatedAt: number }[],
    filter: { query: string; kinds: { canvas: boolean; doc: boolean }; modified: "any" | "today" | "7d" | "30d" },
    now: number,
  ): { kind: "canvas" | "doc"; title: string; updatedAt: number }[];
};

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 24, 15, 0);
const DAY = 86_400_000;
const items = [
  { kind: "canvas" as const, title: "Landing page", updatedAt: NOW - 60_000 },
  { kind: "doc" as const, title: "Launch BRIEF", updatedAt: at(2026, 10, 24, 0, 0) },
  { kind: "doc" as const, title: "", updatedAt: NOW - 3 * DAY },
  { kind: "canvas" as const, title: "Old dashboard", updatedAt: NOW - 20 * DAY },
  { kind: "doc" as const, title: "Archive", updatedAt: NOW - 40 * DAY },
];
const base = { query: "", kinds: { canvas: true, doc: true }, modified: "any" as const };
const titles = (list: { title: string }[]) => list.map((i) => i.title);

describe("filterRecentItems", () => {
  it("the default filter keeps everything in order", () => {
    expect(filterRecentItems(items, base, NOW)).toEqual(items);
  });
  it("query is a case-insensitive substring of the title; blanks are trimmed", () => {
    expect(titles(filterRecentItems(items, { ...base, query: "la" }, NOW))).toEqual(["Landing page", "Launch BRIEF"]);
    expect(titles(filterRecentItems(items, { ...base, query: "  brief " }, NOW))).toEqual(["Launch BRIEF"]);
    expect(filterRecentItems(items, { ...base, query: "zzz" }, NOW)).toEqual([]);
  });
  it("an empty title matches as Untitled", () => {
    expect(filterRecentItems(items, { ...base, query: "untitled" }, NOW)).toEqual([items[2]]);
  });
  it("kinds are independent toggles; both off shows nothing", () => {
    expect(titles(filterRecentItems(items, { ...base, kinds: { canvas: true, doc: false } }, NOW))).toEqual(["Landing page", "Old dashboard"]);
    expect(filterRecentItems(items, { ...base, kinds: { canvas: false, doc: true } }, NOW).every((i) => i.kind === "doc")).toBe(true);
    expect(filterRecentItems(items, { ...base, kinds: { canvas: false, doc: false } }, NOW)).toEqual([]);
  });
  it("today means since local midnight", () => {
    expect(titles(filterRecentItems(items, { ...base, modified: "today" }, NOW))).toEqual(["Landing page", "Launch BRIEF"]);
    expect(filterRecentItems([{ kind: "doc", title: "x", updatedAt: at(2026, 10, 23, 23, 59) }], { ...base, modified: "today" }, NOW)).toEqual([]);
  });
  it("past 7 and 30 days are rolling windows, inclusive at the edge", () => {
    expect(titles(filterRecentItems(items, { ...base, modified: "7d" }, NOW))).toEqual(["Landing page", "Launch BRIEF", ""]);
    expect(titles(filterRecentItems(items, { ...base, modified: "30d" }, NOW))).toEqual(["Landing page", "Launch BRIEF", "", "Old dashboard"]);
    const edge = [{ kind: "doc" as const, title: "e", updatedAt: NOW - 7 * DAY }];
    expect(filterRecentItems(edge, { ...base, modified: "7d" }, NOW)).toEqual(edge);
    expect(filterRecentItems([{ ...edge[0], updatedAt: NOW - 7 * DAY - 1 }], { ...base, modified: "7d" }, NOW)).toEqual([]);
  });
  it("the three parts combine", () => {
    expect(titles(filterRecentItems(items, { query: "a", kinds: { canvas: true, doc: false }, modified: "30d" }, NOW))).toEqual(["Landing page", "Old dashboard"]);
  });
});
