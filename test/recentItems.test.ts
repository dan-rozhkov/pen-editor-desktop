import { describe, expect, it } from "vitest";
import { changedRecentItems, loadRecentItems, mergeRecentItems } from "../src/main/recentItems";

const doc = (id: string, updatedAt: number, title = "D") => ({ id, title, markdown: "", updatedAt, rev: 1 });
const cv = (id: string, updatedAt: number, title = "C") => ({ id, title, updatedAt, rev: 1 });

describe("mergeRecentItems", () => {
  it("merges both stores, newest first, with the kind", () => {
    const items = mergeRecentItems({ docs: [doc("d1", 5), doc("d2", 30)], deleted: [] }, { canvases: [cv("c1", 20)] });
    expect(items).toEqual([
      { kind: "doc", id: "d2", title: "D", updatedAt: 30 },
      { kind: "canvas", id: "c1", title: "C", updatedAt: 20 },
      { kind: "doc", id: "d1", title: "D", updatedAt: 5 },
    ]);
  });

  it("an error or null from one store does not hide the other", () => {
    expect(mergeRecentItems({ error: "x" }, { canvases: [cv("c1", 1)] }).map((i) => i.id)).toEqual(["c1"]);
    expect(mergeRecentItems({ docs: [doc("d1", 1)], deleted: [] }, { error: "x" }).map((i) => i.id)).toEqual(["d1"]);
    expect(mergeRecentItems(null, null)).toEqual([]);
  });

  it("trims titles", () => {
    expect(mergeRecentItems({ docs: [doc("d1", 1, "  Spec \n")], deleted: [] }, null)[0].title).toBe("Spec");
    expect(mergeRecentItems({ docs: [doc("d1", 1, "   ")], deleted: [] }, null)[0].title).toBe("");
  });

  it("has no cap: every stored item is reachable", () => {
    const docs = Array.from({ length: 250 }, (_, i) => doc(`d${i}`, i));
    const items = mergeRecentItems({ docs, deleted: [] }, { canvases: [cv("c1", 1000)] });
    expect(items).toHaveLength(251);
    expect(items[0].id).toBe("c1");
    expect(items[250].id).toBe("d0");
  });
});

describe("loadRecentItems", () => {
  it("survives a store that rejects", async () => {
    const items = await loadRecentItems(
      { list: async () => { throw new Error("boom"); } },
      { list: async () => ({ canvases: [cv("c1", 1)] }) },
    );
    expect(items.map((i) => i.id)).toEqual(["c1"]);
  });
});

describe("changedRecentItems", () => {
  it("is true only for a successful, non-stale write", () => {
    expect(changedRecentItems({ ok: true, rev: 2 })).toBe(true);
    expect(changedRecentItems({ ok: true })).toBe(true);
    expect(changedRecentItems({ ok: true, stale: true, rev: 2 })).toBe(false);
    expect(changedRecentItems({ error: "nope" })).toBe(false);
    expect(changedRecentItems(null)).toBe(false);
    expect(changedRecentItems("ok")).toBe(false);
  });
});
