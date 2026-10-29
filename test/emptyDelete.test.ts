import { describe, expect, it, vi } from "vitest";
import { deleteConfirmCopy, deleteRecentItems, MAX_DELETE_ITEMS, parseDeleteItems, type EmptyDeleteDeps } from "../src/main/emptyDelete";

const EMPTY = 7;
function deps(over: Partial<EmptyDeleteDeps> = {}): EmptyDeleteDeps {
  return {
    isEmptyView: (id) => id === EMPTY,
    confirm: vi.fn(async () => true),
    removeCanvas: vi.fn(async () => ({ ok: true as const })),
    removeDoc: vi.fn(async () => ({ ok: true as const })),
    notifyDocsRemoved: vi.fn(),
    ...over,
  };
}
const payload = { items: [{ kind: "canvas", id: "cv_1" }, { kind: "doc", id: "doc_1" }, { kind: "doc", id: "doc_2" }] };

describe("parseDeleteItems", () => {
  it("accepts valid items and drops duplicates", () => {
    expect(parseDeleteItems({ items: [...payload.items, { kind: "doc", id: "doc_1" }] })).toEqual({ ok: true, items: payload.items });
  });
  it("refuses empty, non-array, malformed and oversized payloads", () => {
    for (const bad of [null, {}, { items: [] }, { items: "x" }, { items: [null] }, { items: [{ kind: "note", id: "a" }] }, { items: [{ kind: "doc", id: "../x" }] }, { items: [{ kind: "canvas" }] }]) {
      expect(parseDeleteItems(bad).ok).toBe(false);
    }
    const many = Array.from({ length: MAX_DELETE_ITEMS + 1 }, (_, i) => ({ kind: "doc", id: `d${i}` }));
    expect(parseDeleteItems({ items: many }).ok).toBe(false);
    expect(parseDeleteItems({ items: many.slice(0, MAX_DELETE_ITEMS) }).ok).toBe(true);
  });
});

describe("deleteConfirmCopy", () => {
  it("makes Cancel the default and the Esc answer, with singular and plural copy", () => {
    const c = deleteConfirmCopy(3);
    expect(c.buttons).toEqual(["Delete", "Cancel"]);
    expect(c.defaultId).toBe(1);
    expect(c.cancelId).toBe(1);
    expect(c.type).toBe("warning");
    expect(c.message).toBe("Delete 3 items?");
    expect(deleteConfirmCopy(1).message).toBe("Delete 1 item?");
    expect(c.detail).toContain("can't be undone");
  });
});

describe("deleteRecentItems", () => {
  it("refuses any sender but the empty view, before asking or deleting", async () => {
    const d = deps();
    expect(await deleteRecentItems(d, 1, payload)).toMatchObject({ ok: false });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.removeDoc).not.toHaveBeenCalled();
  });
  it("an invalid id refuses the whole request without confirming", async () => {
    const d = deps();
    const r = await deleteRecentItems(d, EMPTY, { items: [{ kind: "doc", id: "ok" }, { kind: "doc", id: "bad/id" }] });
    expect(r).toEqual({ ok: false, error: "invalid id" });
    expect(d.confirm).not.toHaveBeenCalled();
  });
  it("a cancelled confirm deletes nothing", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    expect(await deleteRecentItems(d, EMPTY, payload)).toEqual({ ok: true, deleted: 0, cancelled: true });
    expect(d.removeCanvas).not.toHaveBeenCalled();
    expect(d.removeDoc).not.toHaveBeenCalled();
    expect(d.notifyDocsRemoved).not.toHaveBeenCalled();
  });
  it("confirms with the count, removes each item and announces the documents once", async () => {
    const d = deps();
    expect(await deleteRecentItems(d, EMPTY, payload)).toEqual({ ok: true, deleted: 3 });
    expect(d.confirm).toHaveBeenCalledWith(3);
    expect(d.removeCanvas).toHaveBeenCalledWith("cv_1");
    expect(d.removeDoc).toHaveBeenCalledTimes(2);
    expect(d.notifyDocsRemoved).toHaveBeenCalledTimes(1);
    expect(d.notifyDocsRemoved).toHaveBeenCalledWith(["doc_1", "doc_2"]);
  });
  it("a canvas-only delete announces no documents", async () => {
    const d = deps();
    await deleteRecentItems(d, EMPTY, { items: [{ kind: "canvas", id: "cv_1" }] });
    expect(d.notifyDocsRemoved).not.toHaveBeenCalled();
  });
  it("partial failure (error result or throw) is returned item by item; only removed docs are announced", async () => {
    const d = deps({
      removeCanvas: vi.fn(async () => ({ error: "disk" })),
      removeDoc: vi.fn(async (id: string) => {
        if (id === "doc_2") throw new Error("boom");
        return { ok: true as const };
      }),
    });
    expect(await deleteRecentItems(d, EMPTY, payload)).toEqual({ ok: true, deleted: 1, failed: [{ kind: "canvas", id: "cv_1" }, { kind: "doc", id: "doc_2" }] });
    expect(d.notifyDocsRemoved).toHaveBeenCalledWith(["doc_1"]);
  });
  it("never throws: a failing confirm or notify is contained", async () => {
    const bad = deps({ confirm: vi.fn(async () => { throw new Error("dialog"); }) });
    expect(await deleteRecentItems(bad, EMPTY, payload)).toEqual({ ok: false, error: "dialog" });
    const d = deps({ notifyDocsRemoved: vi.fn(() => { throw new Error("gone"); }) });
    expect(await deleteRecentItems(d, EMPTY, payload)).toEqual({ ok: true, deleted: 3 });
  });
});
