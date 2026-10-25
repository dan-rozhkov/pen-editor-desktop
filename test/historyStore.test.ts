import { describe, expect, it } from "vitest";
import {
  HISTORY_FILE,
  MAX_HISTORY_ENTRIES,
  VISIT_BURST_MS,
  WRITE_DEBOUNCE_MS,
  createHistoryStore,
  historyKey,
  type HistoryFs,
  type HistoryTimers,
} from "../src/main/browser/historyStore";

const FILE = `/ud/${HISTORY_FILE}`;

function make(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(FILE, initial);
  const writes: string[] = [];
  const syncWrites: string[] = [];
  let readGate: Promise<void> | null = null;
  const fs: HistoryFs = {
    read: async (p) => {
      if (readGate) await readGate;
      return files.get(p) ?? null;
    },
    write: async (p, d) => {
      writes.push(d);
      files.set(p, d);
    },
    writeSync: (p, d) => {
      syncWrites.push(d);
      files.set(p, d);
    },
  };
  // A manual timer: nothing fires until `fire()`.
  let pending: (() => void) | null = null;
  let set = 0;
  const timers: HistoryTimers = {
    setTimeout: (cb, ms) => {
      expect(ms).toBe(WRITE_DEBOUNCE_MS);
      set++;
      pending = cb;
      return cb;
    },
    clearTimeout: (h) => {
      if (pending === h) pending = null;
    },
  };
  const build = () => createHistoryStore({ filePath: FILE, fs, timers });
  return { files, writes, syncWrites, gateRead: () => { let open!: () => void; readGate = new Promise<void>((r) => (open = r)); return open; }, store: build(), build, fire: () => {
      const cb = pending;
      pending = null;
      cb?.();
    }, isScheduled: () => pending !== null, timersSet: () => set };
}

describe("historyKey", () => {
  it("keeps http(s) URLs and strips the hash", () => {
    expect(historyKey("https://example.com/a?b=1#frag")).toBe("https://example.com/a?b=1");
    expect(historyKey("http://example.com")).toBe("http://example.com/");
  });
  it("refuses other schemes, garbage, credentials and long URLs", () => {
    expect(historyKey("file:///etc/passwd")).toBeNull();
    expect(historyKey("javascript:alert(1)")).toBeNull();
    expect(historyKey("about:blank")).toBeNull();
    expect(historyKey("not a url")).toBeNull();
    expect(historyKey("https://user:pw@example.com/")).toBeNull();
    expect(historyKey("https://user@example.com/")).toBeNull();
    expect(historyKey("https://example.com/" + "a".repeat(2048))).toBeNull();
    expect(historyKey(42)).toBeNull();
  });
});

describe("history store", () => {
  it("records a visit and counts a second one", () => {
    const { store } = make();
    expect(store.recordVisit("https://a.com/x#one", 1000)).toBe(true);
    store.recordVisit("https://a.com/x#two", 1000 + 60_000);
    expect(store.list()).toEqual([{ url: "https://a.com/x", title: "", visitCount: 2, lastVisitedAt: 61_000 }]);
  });

  it("does not record an unrecordable URL", () => {
    const { store } = make();
    expect(store.recordVisit("https://u:p@a.com/", 1)).toBe(false);
    expect(store.recordVisit("file:///x", 1)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("counts a burst of visits within 1 s once but moves the time", () => {
    const { store } = make();
    store.recordVisit("https://a.com/", 1000);
    store.recordVisit("https://a.com/", 1000 + VISIT_BURST_MS - 1);
    expect(store.list()[0]).toMatchObject({ visitCount: 1, lastVisitedAt: 1000 + VISIT_BURST_MS - 1 });
    store.recordVisit("https://a.com/", 1000 + VISIT_BURST_MS - 1 + VISIT_BURST_MS);
    expect(store.list()[0].visitCount).toBe(2);
  });

  it("sets a trimmed, capped title only for an existing entry", () => {
    const { store } = make();
    store.setTitle("https://a.com/", "ignored");
    expect(store.list()).toEqual([]);
    store.recordVisit("https://a.com/", 1);
    store.setTitle("https://a.com/#x", "  Hello  ");
    expect(store.list()[0].title).toBe("Hello");
    store.setTitle("https://a.com/", "x".repeat(500));
    expect(store.list()[0].title).toHaveLength(300);
  });

  it("lists newest first, as copies", () => {
    const { store } = make();
    store.recordVisit("https://old.com/", 1);
    store.recordVisit("https://new.com/", 9);
    const list = store.list();
    expect(list.map((e) => e.url)).toEqual(["https://new.com/", "https://old.com/"]);
    list[0].title = "mutated";
    expect(store.list()[0].title).toBe("");
  });

  it("removes one entry and clears all", () => {
    const { store } = make();
    store.recordVisit("https://a.com/", 1);
    store.recordVisit("https://b.com/", 2);
    expect(store.remove("https://a.com/#h")).toBe(true);
    expect(store.remove("https://a.com/")).toBe(false);
    expect(store.list().map((e) => e.url)).toEqual(["https://b.com/"]);
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it("drops the oldest entries over the cap", () => {
    const { store } = make();
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 3; i++) store.recordVisit(`https://h${i}.com/`, 10_000 + i);
    const list = store.list();
    expect(list).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(list.some((e) => e.url === "https://h0.com/" || e.url === "https://h2.com/")).toBe(false);
    expect(list[list.length - 1].url).toBe("https://h3.com/");
  });

  it("notifies listeners on a change until unsubscribed", () => {
    const { store } = make();
    let n = 0;
    const off = store.onChange(() => n++);
    store.recordVisit("https://a.com/", 1);
    store.setTitle("https://a.com/", "A");
    store.setTitle("https://a.com/", "A"); // unchanged: no event
    expect(n).toBe(2);
    off();
    store.clear();
    expect(n).toBe(2);
  });

  it("debounces writes: one write for a burst of changes", async () => {
    const { store, writes, fire, isScheduled, timersSet } = make();
    store.recordVisit("https://a.com/", 1);
    store.setTitle("https://a.com/", "A");
    store.recordVisit("https://b.com/", 2);
    expect(writes).toHaveLength(0);
    expect(timersSet()).toBe(1);
    fire();
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(isScheduled()).toBe(false);
    expect(JSON.parse(writes[0])).toMatchObject({ version: 1, entries: [{ url: "https://a.com/" }, { url: "https://b.com/" }] });
  });

  it("flush writes a pending change at once and cancels the timer", async () => {
    const { store, writes, isScheduled } = make();
    store.recordVisit("https://a.com/", 1);
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(isScheduled()).toBe(false);
    await store.flush(); // nothing pending
    expect(writes).toHaveLength(1);
  });

  it("round-trips through the file", async () => {
    const m = make();
    m.store.recordVisit("https://a.com/", 5);
    m.store.setTitle("https://a.com/", "A");
    await m.store.flush();
    const again = m.build();
    await again.load();
    expect(again.list()).toEqual([{ url: "https://a.com/", title: "A", visitCount: 1, lastVisitedAt: 5 }]);
  });

  it("loads a corrupt file as empty and leaves it alone until the next change", async () => {
    const m = make("{not json");
    await m.store.load();
    expect(m.store.list()).toEqual([]);
    await m.store.flush();
    expect(m.writes).toHaveLength(0);
    expect(m.files.get(FILE)).toBe("{not json");
    m.store.recordVisit("https://a.com/", 1);
    await m.store.flush();
    expect(m.writes).toHaveLength(1);
  });

  it("skips invalid entries of a valid file", async () => {
    const good = { url: "https://a.com/", title: "A", visitCount: 2, lastVisitedAt: 7 };
    const m = make(
      JSON.stringify({
        version: 1,
        entries: [good, { url: "file:///x", title: "", visitCount: 1, lastVisitedAt: 1 }, { url: "https://b.com/", title: 3 }, "junk", { ...good, url: "https://c.com/#h" }],
      }),
    );
    await m.store.load();
    expect(m.store.list()).toEqual([good]);
  });

  it("keeps a visit recorded before the load finished", async () => {
    const m = make(JSON.stringify({ version: 1, entries: [{ url: "https://a.com/", title: "old", visitCount: 4, lastVisitedAt: 1 }] }));
    m.store.recordVisit("https://b.com/", 50);
    await m.store.load();
    expect(m.store.list().map((e) => e.url)).toEqual(["https://b.com/", "https://a.com/"]);
  });

  const FILE_A = JSON.stringify({ version: 1, entries: [{ url: "https://a.com/", title: "old", visitCount: 4, lastVisitedAt: 1000 }] });

  it("a visit before load keeps the file's visitCount + 1 and title", async () => {
    const m = make(FILE_A);
    const done = m.store.load();
    m.store.recordVisit("https://a.com/", 999999);
    await done;
    expect(m.store.list()).toEqual([{ url: "https://a.com/", title: "old", visitCount: 5, lastVisitedAt: 999999 }]);
  });

  it("clear before load wins over the file", async () => {
    const m = make(FILE_A);
    const done = m.store.load();
    m.store.clear();
    await done;
    expect(m.store.list()).toEqual([]);
    await m.store.flush();
    expect(JSON.parse(m.files.get(FILE)!).entries).toEqual([]);
  });

  it("replays setTitle and remove in order, and schedules the write after the load", async () => {
    const m = make(FILE_A);
    const done = m.store.load();
    m.store.setTitle("https://a.com/", "new");
    m.store.recordVisit("https://b.com/", 5);
    m.store.remove("https://b.com/");
    expect(m.isScheduled()).toBe(false);
    await done;
    expect(m.store.list()).toEqual([{ url: "https://a.com/", title: "new", visitCount: 4, lastVisitedAt: 1000 }]);
    expect(m.isScheduled()).toBe(true);
  });

  it("a slow read never lets a write truncate the file", async () => {
    const m = make(FILE_A);
    const open = m.gateRead();
    const done = m.store.load();
    m.store.recordVisit("https://b.com/", 5);
    expect(m.isScheduled()).toBe(false);
    await m.store.flush();
    m.store.flushSync();
    expect(m.writes).toHaveLength(0);
    expect(m.syncWrites).toHaveLength(0);
    open();
    await done;
    await m.store.flush();
    expect(JSON.parse(m.files.get(FILE)!).entries.map((e: { url: string }) => e.url).sort()).toEqual(["https://a.com/", "https://b.com/"]);
  });

  it("flushSync writes a pending change at once, cancels the debounce, and is a no-op when clean", async () => {
    const m = make();
    await m.store.load();
    m.store.flushSync();
    expect(m.syncWrites).toHaveLength(0);
    m.store.recordVisit("https://a.com/", 1);
    expect(m.isScheduled()).toBe(true);
    m.store.flushSync();
    expect(m.isScheduled()).toBe(false);
    expect(m.syncWrites).toHaveLength(1);
    expect(JSON.parse(m.syncWrites[0]).entries[0].url).toBe("https://a.com/");
    m.store.flushSync();
    expect(m.syncWrites).toHaveLength(1);
  });

  it("treats a failing write as lost, not fatal", async () => {
    const store = createHistoryStore({
      filePath: FILE,
      fs: { read: async () => null, write: async () => { throw new Error("EACCES"); }, writeSync: () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
    });
    store.recordVisit("https://a.com/", 1);
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
