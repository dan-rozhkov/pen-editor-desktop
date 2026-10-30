import { describe, expect, it } from "vitest";
import { changedRecentItems, loadRecentItems, mergeRecentItems } from "../src/main/recentItems";

const doc = (id: string, updatedAt: number, title = "D") => ({ id, title, markdown: "", updatedAt, rev: 1 });
const cv = (id: string, updatedAt: number, title = "C") => ({ id, title, updatedAt, rev: 1 });

describe("mergeRecentItems", () => {
  it("merges both stores, newest first, with the kind", () => {
    const items = mergeRecentItems({ docs: [doc("d1", 5), doc("d2", 30)], deleted: [] }, { canvases: [cv("c1", 20)] }, null);
    expect(items).toEqual([
      { kind: "doc", id: "d2", title: "D", updatedAt: 30 },
      { kind: "canvas", id: "c1", title: "C", updatedAt: 20 },
      { kind: "doc", id: "d1", title: "D", updatedAt: 5 },
    ]);
  });

  it("includes workflows; equal times order docs, canvases, workflows", () => {
    const wf = (id: string, updatedAt: number) => ({ id, title: "W", steps: [], updatedAt, rev: 1 });
    const items = mergeRecentItems({ docs: [doc("d1", 5)], deleted: [] }, { canvases: [cv("c1", 5)] }, { workflows: [wf("wf_1", 5), wf("wf_2", 9)], deleted: [] });
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(["workflow:wf_2", "doc:d1", "canvas:c1", "workflow:wf_1"]);
    expect(mergeRecentItems(null, null, { error: "x" })).toEqual([]);
  });

  it("an error or null from one store does not hide the other", () => {
    expect(mergeRecentItems({ error: "x" }, { canvases: [cv("c1", 1)] }, null).map((i) => i.id)).toEqual(["c1"]);
    expect(mergeRecentItems({ docs: [doc("d1", 1)], deleted: [] }, { error: "x" }, null).map((i) => i.id)).toEqual(["d1"]);
    expect(mergeRecentItems(null, null, null)).toEqual([]);
  });

  it("trims titles", () => {
    expect(mergeRecentItems({ docs: [doc("d1", 1, "  Spec \n")], deleted: [] }, null, null)[0].title).toBe("Spec");
    expect(mergeRecentItems({ docs: [doc("d1", 1, "   ")], deleted: [] }, null, null)[0].title).toBe("");
  });

  it("has no cap: every stored item is reachable", () => {
    const docs = Array.from({ length: 250 }, (_, i) => doc(`d${i}`, i));
    const items = mergeRecentItems({ docs, deleted: [] }, { canvases: [cv("c1", 1000)] }, null);
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
      { list: async () => ({ workflows: [{ id: "wf_1", title: " W ", steps: [], updatedAt: 2, rev: 1 }], deleted: [] }) },
    );
    expect(items.map((i) => i.id)).toEqual(["wf_1", "c1"]);
    expect(items[0]).toEqual({ kind: "workflow", id: "wf_1", title: "W", updatedAt: 2 });
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
