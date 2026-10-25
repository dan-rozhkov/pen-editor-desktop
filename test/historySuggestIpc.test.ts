import { describe, expect, it, vi } from "vitest";
import { MAX_SUGGEST_QUERY, registerHistorySuggest } from "../src/main/historySuggestIpc";

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;

function setup() {
  let handler: Handler | undefined;
  const removeHandler = vi.fn();
  const ipcMain = { handle: (_c: string, h: Handler) => (handler = h), removeHandler };
  const entries = [
    { url: "https://example.com/a", title: "Alpha page", visitCount: 2, lastVisitedAt: 1000 },
    { url: "https://other.org/", title: "Beta", visitCount: 1, lastVisitedAt: 2000 },
  ];
  const unregister = registerHistorySuggest({ ipcMain, store: { list: () => entries }, isTabbar: (id) => id === 7, now: () => 3000 });
  return { call: (id: number, payload: unknown) => handler!({ sender: { id } }, payload), unregister, removeHandler };
}

describe("history:suggest", () => {
  it("answers only a tab bar", () => {
    const { call } = setup();
    expect(call(8, { query: "" })).toEqual({ items: [], inline: null });
  });
  it("empty query gives the newest entries and no inline", () => {
    const r = setup().call(7, { query: "" }) as { items: { url: string }[]; inline: string | null };
    expect(r.items.map((i) => i.url)).toEqual(["https://other.org/", "https://example.com/a"]);
    expect(r.inline).toBeNull();
  });
  it("filters and completes inline", () => {
    const r = setup().call(7, { query: "exam" }) as { items: { url: string }[]; inline: string | null };
    expect(r.items).toHaveLength(1);
    expect(r.inline).toBe("example.com");
  });
  it("rejects a bad or oversized query", () => {
    const { call } = setup();
    expect(call(7, { query: 5 })).toEqual({ items: [], inline: null });
    expect(call(7, null)).toEqual({ items: [], inline: null });
    expect(call(7, { query: "a".repeat(MAX_SUGGEST_QUERY + 1) })).toEqual({ items: [], inline: null });
  });
  it("unregisters", () => {
    const { unregister, removeHandler } = setup();
    unregister();
    expect(removeHandler).toHaveBeenCalledWith("history:suggest");
  });
});
