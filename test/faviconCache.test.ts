import { describe, expect, it } from "vitest";
import { createFaviconCache, isSafeIconDataUrl, toIconDataUrl, MAX_ICON_BYTES, RETRY_AFTER_MS } from "../src/main/browser/faviconCache";

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

function make(wanted: string[] = ["https://a.com"], icon: { contentType: string; bytes: Uint8Array } | null = { contentType: "image/png", bytes: PNG }) {
  const files = new Map<string, string>();
  const fetched: string[] = [];
  const build = () =>
    createFaviconCache({
      filePath: "/f.json",
      fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d) },
      fetchIcon: async (url) => {
        fetched.push(url);
        return icon;
      },
      isWanted: (o) => wanted.includes(o),
    });
  return { files, fetched, cache: build(), build, wanted };
}

describe("toIconDataUrl / isSafeIconDataUrl", () => {
  it("accepts allowed image types, normalizes the content type", () => {
    expect(toIconDataUrl("image/png; charset=x", PNG)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(toIconDataUrl("image/svg+xml", PNG)).toMatch(/^data:image\/svg\+xml;base64,/);
  });
  it("refuses other types, empty and oversized bodies", () => {
    expect(toIconDataUrl("text/html", PNG)).toBeNull();
    expect(toIconDataUrl("image/tiff", PNG)).toBeNull();
    expect(toIconDataUrl("image/png", new Uint8Array(0))).toBeNull();
    expect(toIconDataUrl("image/png", new Uint8Array(MAX_ICON_BYTES + 1))).toBeNull();
  });
  it("validates stored values", () => {
    expect(isSafeIconDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeIconDataUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(isSafeIconDataUrl("https://x.com/a.png")).toBe(false);
    expect(isSafeIconDataUrl("data:image/png;base64,AA<script>")).toBe(false);
    expect(isSafeIconDataUrl(5)).toBe(false);
  });
});

describe("favicon cache", () => {
  it("fetches the first icon for an origin with a login and persists it", async () => {
    const { cache, fetched, files, build } = make();
    await cache.seen("https://a.com", ["https://a.com/1.png", "https://a.com/2.png"]);
    expect(fetched).toEqual(["https://a.com/1.png"]);
    expect(cache.get("https://a.com")).toMatch(/^data:image\/png;base64,/);
    expect(JSON.parse(files.get("/f.json")!).icons["https://a.com"]).toBeTruthy();
    expect(build().get("https://a.com")).toBe(cache.get("https://a.com")); // survives a restart
    await cache.seen("https://a.com", ["https://a.com/1.png"]);
    expect(fetched).toHaveLength(1); // cached: no second fetch
  });

  it("does not fetch for an origin without a login; fetches once one is saved", async () => {
    const { cache, fetched, wanted } = make([]);
    await cache.seen("https://b.com", ["https://b.com/i.png"]);
    expect(fetched).toEqual([]);
    wanted.push("https://b.com");
    await cache.flushPending();
    expect(fetched).toEqual(["https://b.com/i.png"]);
    expect(cache.get("https://b.com")).toBeDefined();
  });

  it("drops a bad fetch result and does not retry it in a loop", async () => {
    const { cache, fetched } = make(["https://a.com"], { contentType: "text/html", bytes: PNG });
    await cache.seen("https://a.com", ["https://a.com/i"]);
    await cache.seen("https://a.com", ["https://a.com/i"]);
    expect(cache.get("https://a.com")).toBeUndefined();
    expect(fetched).toHaveLength(1);
  });

  it("ignores unsafe values in the file and icons of origins without a login", async () => {
    const { files, build, wanted } = make(["https://y.com", "https://x.com"]);
    const good = "data:image/png;base64,AAAA";
    files.set(
      "/f.json",
      JSON.stringify({
        version: 2,
        icons: {
          "https://x.com": { src: "https://x.com/i", data: "javascript:alert(1)" },
          "https://y.com": { src: "https://y.com/i", data: good },
          "https://gone.com": { src: "https://gone.com/i", data: good },
          "https://legacy.com": good,
        },
      }),
    );
    wanted.push("https://legacy.com");
    const c = build();
    expect(c.get("https://x.com")).toBeUndefined();
    expect(c.get("https://y.com")).toBe(good);
    expect(c.get("https://gone.com")).toBeUndefined();
    expect(c.get("https://legacy.com")).toBeUndefined();
  });

  it("forget drops the icon, persists, and lets a later fetch start fresh", async () => {
    const { cache, files, fetched } = make();
    await cache.seen("https://a.com", ["https://a.com/1.png"]);
    cache.forget("https://a.com");
    expect(cache.get("https://a.com")).toBeUndefined();
    expect(JSON.parse(files.get("/f.json")!).icons).toEqual({});
    await cache.seen("https://a.com", ["https://a.com/1.png"]);
    expect(fetched).toHaveLength(2);
  });

  it("refetches when the page reports another favicon URL, not for the same one", async () => {
    const { cache, fetched, build } = make();
    await cache.seen("https://a.com", ["https://a.com/1.png"]);
    await cache.seen("https://a.com", ["https://a.com/1.png"]);
    expect(fetched).toEqual(["https://a.com/1.png"]);
    await cache.seen("https://a.com", ["https://a.com/2.png"]);
    expect(fetched).toEqual(["https://a.com/1.png", "https://a.com/2.png"]);
    // The source URL survives a restart.
    await build().seen("https://a.com", ["https://a.com/2.png"]);
    expect(fetched).toHaveLength(2);
  });

  it("a failed fetch is retried only after the backoff, a new URL at once", async () => {
    let clock = 1_000;
    let ok = false;
    const fetched: string[] = [];
    const cache = createFaviconCache({
      filePath: "/f.json",
      fs: { read: () => null, write: () => {} },
      fetchIcon: async (url) => {
        fetched.push(url);
        return ok ? { contentType: "image/png", bytes: PNG } : null;
      },
      isWanted: () => true,
      now: () => clock,
    });
    await cache.seen("https://a.com", ["https://a.com/i.png"]);
    clock += RETRY_AFTER_MS - 1;
    await cache.seen("https://a.com", ["https://a.com/i.png"]);
    expect(fetched).toHaveLength(1);
    await cache.seen("https://a.com", ["https://a.com/other.png"]);
    expect(fetched).toHaveLength(2);
    clock += RETRY_AFTER_MS;
    ok = true;
    await cache.seen("https://a.com", ["https://a.com/other.png"]);
    expect(fetched).toHaveLength(3);
    expect(cache.get("https://a.com")).toMatch(/^data:image\/png/);
  });

  it("a failed refetch keeps the older icon", async () => {
    let ok = true;
    const cache = createFaviconCache({
      filePath: "/f.json",
      fs: { read: () => null, write: () => {} },
      fetchIcon: async () => (ok ? { contentType: "image/png", bytes: PNG } : null),
      isWanted: () => true,
    });
    await cache.seen("https://a.com", ["https://a.com/1.png"]);
    const before = cache.get("https://a.com");
    ok = false;
    await cache.seen("https://a.com", ["https://a.com/2.png"]);
    expect(cache.get("https://a.com")).toBe(before);
  });

  it("flushPending waits out the backoff and reports changes through onChange", async () => {
    let clock = 0;
    let ok = false;
    let changes = 0;
    const wanted: string[] = [];
    const cache = createFaviconCache({
      filePath: "/f.json",
      fs: { read: () => null, write: () => {} },
      fetchIcon: async () => (ok ? { contentType: "image/png", bytes: PNG } : null),
      isWanted: (o) => wanted.includes(o),
      onChange: () => void changes++,
      now: () => clock,
    });
    await cache.seen("https://b.com", ["https://b.com/i.png"]);
    wanted.push("https://b.com");
    await cache.flushPending(); // fails
    expect(changes).toBe(0);
    ok = true;
    await cache.flushPending(); // still backing off
    expect(cache.get("https://b.com")).toBeUndefined();
    clock += RETRY_AFTER_MS;
    await cache.flushPending();
    expect(cache.get("https://b.com")).toBeDefined();
    expect(changes).toBe(1);
  });

  it("onChange fires when a tab's icon is stored", async () => {
    let changes = 0;
    const { files } = make();
    void files;
    const cache = createFaviconCache({
      filePath: "/f.json",
      fs: { read: () => null, write: () => {} },
      fetchIcon: async () => ({ contentType: "image/png", bytes: PNG }),
      isWanted: () => true,
      onChange: () => void changes++,
    });
    await cache.seen("https://a.com", ["https://a.com/i.png"]);
    expect(changes).toBe(1);
  });
});
