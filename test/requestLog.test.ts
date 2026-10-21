import { describe, expect, it, vi } from "vitest";
import { BODY_FETCH_MS, BODY_PHASE_MS, createClosedRequestBuffer, createRequestLog, MAX_BODY_CHARS, MAX_BODY_FETCHES, REQUEST_PENDING_CAP, REQUEST_RING_CAP } from "../src/main/requestLog";

const sent = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
  requestId: id,
  type: "Fetch",
  timestamp: 10,
  wallTime: 1000,
  request: { url, method: "GET", headers: { accept: "*/*" } },
  ...extra,
});
const got = (id: string, status = 200, mimeType = "application/json") => ({
  requestId: id,
  type: "Fetch",
  response: { status, mimeType, headers: { "content-type": mimeType } },
});
const fin = (id: string, timestamp = 10.25, encodedDataLength = 42) => ({ requestId: id, timestamp, encodedDataLength });
const noBody = async () => undefined;

describe("request log", () => {
  it("records a finished request with timing, size, headers and wall-clock start", async () => {
    const l = createRequestLog();
    l.onEvent("Network.requestWillBeSent", sent("1", "https://a.test/api?x=1"));
    l.onEvent("Network.responseReceived", got("1"));
    l.onEvent("Network.loadingFinished", fin("1"));
    expect(await l.drain(noBody)).toEqual([
      {
        at: 1_000_000,
        method: "GET",
        url: "https://a.test/api?x=1",
        type: "fetch",
        status: 200,
        mimeType: "application/json",
        size: 42,
        durationMs: 250,
        requestHeaders: { accept: "*/*" },
        responseHeaders: { "content-type": "application/json" },
      },
    ]);
    expect(await l.drain(noBody)).toEqual([]);
  });

  it("records failures with the error text and no body fetch", async () => {
    const l = createRequestLog();
    l.onEvent("Network.requestWillBeSent", sent("1", "https://a.test/x"));
    l.onEvent("Network.loadingFailed", { requestId: "1", timestamp: 10.1, errorText: "net::ERR_FAILED" });
    let fetched = 0;
    const out = await l.drain(async () => { fetched++; return undefined; });
    expect(out[0]).toMatchObject({ error: "net::ERR_FAILED", durationMs: 100 });
    expect(fetched).toBe(0);
  });

  it("skips WebSocket, EventSource, Ping and data: URLs", async () => {
    const l = createRequestLog();
    for (const type of ["WebSocket", "EventSource", "Ping"]) {
      l.onEvent("Network.requestWillBeSent", sent(type, "https://a.test/s", { type }));
      l.onEvent("Network.loadingFinished", fin(type));
    }
    l.onEvent("Network.requestWillBeSent", sent("d", "data:text/plain,hi"));
    l.onEvent("Network.loadingFinished", fin("d"));
    expect(await l.drain(noBody)).toEqual([]);
  });

  it("splits a redirect into hops that share a requestId", async () => {
    const l = createRequestLog();
    l.onEvent("Network.requestWillBeSent", sent("1", "https://a.test/old"));
    l.onEvent(
      "Network.requestWillBeSent",
      sent("1", "https://a.test/new", { timestamp: 10.1, redirectResponse: { status: 302, headers: { location: "/new" } } }),
    );
    l.onEvent("Network.responseReceived", got("1"));
    l.onEvent("Network.loadingFinished", fin("1", 10.3));
    const out = await l.drain(noBody);
    expect(out.map((e) => [e.url, e.status])).toEqual([
      ["https://a.test/old", 302],
      ["https://a.test/new", 200],
    ]);
    expect(out[0].durationMs).toBe(100);
  });

  it("fetches bodies only for text-like fetch/xhr, skips base64, truncates", async () => {
    const l = createRequestLog();
    l.onEvent("Network.requestWillBeSent", sent("j", "https://a.test/j"));
    l.onEvent("Network.responseReceived", got("j"));
    l.onEvent("Network.loadingFinished", fin("j"));
    l.onEvent("Network.requestWillBeSent", sent("img", "https://a.test/i.png", { type: "Image" }));
    l.onEvent("Network.responseReceived", { ...got("img", 200, "image/png"), type: "Image" });
    l.onEvent("Network.loadingFinished", fin("img"));
    l.onEvent("Network.requestWillBeSent", sent("b", "https://a.test/b"));
    l.onEvent("Network.responseReceived", got("b"));
    l.onEvent("Network.loadingFinished", fin("b"));
    const asked: string[] = [];
    const out = await l.drain(async (id) => {
      asked.push(id);
      return id === "j"
        ? { body: "x".repeat(MAX_BODY_CHARS + 5), base64Encoded: false }
        : { body: "AAAA", base64Encoded: true };
    });
    expect(asked.sort()).toEqual(["b", "j"]);
    expect(out[0].body).toHaveLength(MAX_BODY_CHARS);
    expect(out[0].bodyTruncated).toBe(true);
    expect(out[1].body).toBeUndefined();
    expect(out[2].body).toBeUndefined();
  });

  it("ignores getBody failures and caps body fetches per drain", async () => {
    const l = createRequestLog();
    for (let i = 0; i < MAX_BODY_FETCHES + 5; i++) {
      l.onEvent("Network.requestWillBeSent", sent(`r${i}`, `https://a.test/${i}`));
      l.onEvent("Network.responseReceived", got(`r${i}`));
      l.onEvent("Network.loadingFinished", fin(`r${i}`));
    }
    let calls = 0;
    const out = await l.drain(async () => { calls++; throw new Error("gone"); });
    expect(calls).toBe(MAX_BODY_FETCHES);
    expect(out).toHaveLength(MAX_BODY_FETCHES + 5);
  });

  it("bounds the finished ring and the in-flight map", async () => {
    const l = createRequestLog();
    for (let i = 0; i < REQUEST_RING_CAP + 10; i++) {
      l.onEvent("Network.requestWillBeSent", sent(`r${i}`, `https://a.test/${i}`, { type: "Image" }));
      l.onEvent("Network.loadingFinished", fin(`r${i}`));
    }
    const out = await l.drain(noBody);
    expect(out).toHaveLength(REQUEST_RING_CAP);
    expect(out[0].url).toBe("https://a.test/10");

    for (let i = 0; i < REQUEST_PENDING_CAP + 1; i++) l.onEvent("Network.requestWillBeSent", sent(`p${i}`, `https://a.test/p${i}`));
    l.onEvent("Network.loadingFinished", fin("p0")); // evicted: ignored
    l.onEvent("Network.loadingFinished", fin("p1"));
    expect((await l.drain(noBody)).map((e) => e.url)).toEqual(["https://a.test/p1"]);
  });

  it("counts ring overflow and pending evictions, drain-and-reset", async () => {
    const l = createRequestLog();
    expect(l.droppedRequests()).toBe(0);
    for (let i = 0; i < REQUEST_RING_CAP + 4; i++) {
      l.onEvent("Network.requestWillBeSent", sent(`r${i}`, `https://a.test/${i}`, { type: "Image" }));
      l.onEvent("Network.loadingFinished", fin(`r${i}`));
    }
    expect(l.droppedRequests()).toBe(4);
    expect(l.droppedRequests()).toBe(0);
    for (let i = 0; i < REQUEST_PENDING_CAP + 3; i++) l.onEvent("Network.requestWillBeSent", sent(`p${i}`, `https://a.test/p${i}`));
    expect(l.droppedRequests()).toBe(3);
    l.onEvent("Network.requestWillBeSent", sent("q", "https://a.test/q"));
    l.clear();
    expect(l.droppedRequests()).toBe(0);
  });

  it("clear forgets finished and in-flight requests", async () => {
    const l = createRequestLog();
    l.onEvent("Network.requestWillBeSent", sent("1", "https://a.test/1"));
    l.onEvent("Network.requestWillBeSent", sent("2", "https://a.test/2"));
    l.onEvent("Network.loadingFinished", fin("1"));
    l.clear();
    l.onEvent("Network.loadingFinished", fin("2"));
    expect(await l.drain(noBody)).toEqual([]);
  });

  it("ignores junk events", async () => {
    const l = createRequestLog();
    l.onEvent("Network.requestWillBeSent", undefined);
    l.onEvent("Network.requestWillBeSent", { requestId: "1" });
    l.onEvent("Page.loadEventFired", { requestId: "1" });
    expect(await l.drain(noBody)).toEqual([]);
  });

  it("never fetches a body for a redirect hop, even with a text mimeType", async () => {
    const l = createRequestLog();
    l.onEvent("Network.requestWillBeSent", sent("r", "https://a.test/old"));
    l.onEvent("Network.responseReceived", got("r", 302, "application/json"));
    l.onEvent("Network.requestWillBeSent", sent("r", "https://a.test/new", { redirectResponse: { status: 302, mimeType: "application/json", headers: {} } }));
    l.onEvent("Network.responseReceived", got("r"));
    l.onEvent("Network.loadingFinished", fin("r"));
    const getBody = vi.fn(async () => ({ body: "{}", base64Encoded: false }));
    const out = await l.drain(getBody);
    expect(out.map((e) => [e.url, e.status, e.body])).toEqual([
      ["https://a.test/old", 302, undefined],
      ["https://a.test/new", 200, "{}"],
    ]);
    expect(getBody).toHaveBeenCalledTimes(1);
  });

  it("takeFinished hands over entries without bodies and the drop count, resetting both", async () => {
    const l = createRequestLog();
    for (let i = 0; i < REQUEST_RING_CAP + 2; i++) {
      l.onEvent("Network.requestWillBeSent", sent(`r${i}`, `https://a.test/${i}`));
      l.onEvent("Network.responseReceived", got(`r${i}`));
      l.onEvent("Network.loadingFinished", fin(`r${i}`));
    }
    const taken = l.takeFinished();
    expect(taken.requests).toHaveLength(REQUEST_RING_CAP);
    expect(taken.dropped).toBe(2);
    expect(taken.requests.every((e) => e.body === undefined)).toBe(true);
    expect(l.takeFinished()).toEqual({ requests: [], dropped: 0 });
    expect(await l.drain(noBody)).toEqual([]);
  });

  describe("body time limits", () => {
    const finished = (l: ReturnType<typeof createRequestLog>, n: number) => {
      for (let i = 0; i < n; i++) {
        l.onEvent("Network.requestWillBeSent", sent(`r${i}`, `https://a.test/${i}`));
        l.onEvent("Network.responseReceived", got(`r${i}`));
        l.onEvent("Network.loadingFinished", fin(`r${i}`));
      }
    };
    it("gives up on one body after the per-body limit", async () => {
      vi.useFakeTimers();
      try {
        const l = createRequestLog();
        finished(l, 1);
        const p = l.drain(() => new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(BODY_FETCH_MS);
        const out = await p;
        expect(out).toHaveLength(1);
        expect(out[0].body).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
    it("caps the whole phase and never writes a late body", async () => {
      vi.useFakeTimers();
      try {
        const l = createRequestLog();
        finished(l, 1);
        let resolveBody: (v: { body: string; base64Encoded: boolean }) => void = () => {};
        const p = l.drain(() => new Promise((r) => { resolveBody = r; }));
        await vi.advanceTimersByTimeAsync(BODY_PHASE_MS);
        const out = await p;
        resolveBody({ body: "late", base64Encoded: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(out[0].body).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("closed request buffer", () => {
  const e = (n: number) => ({ at: n, method: "GET", url: `https://a.test/${n}` });
  it("accumulates, drains and resets", () => {
    const b = createClosedRequestBuffer(5);
    expect(b.drain()).toEqual({ requests: [] });
    b.add({ requests: [e(1), e(2)], dropped: 1 });
    b.add({ requests: [e(3)] });
    expect(b.drain()).toEqual({ requests: [e(1), e(2), e(3)], dropped: 1 });
    expect(b.drain()).toEqual({ requests: [] });
  });
  it("keeps the newest entries over the cap and counts the overflow", () => {
    const b = createClosedRequestBuffer(3);
    b.add({ requests: [e(1), e(2), e(3), e(4)], dropped: 2 });
    b.add({ requests: [e(5)] });
    expect(b.drain()).toEqual({ requests: [e(3), e(4), e(5)], dropped: 4 });
  });
  it("clear forgets entries and the count", () => {
    const b = createClosedRequestBuffer(3);
    b.add({ requests: [e(1)], dropped: 5 });
    b.clear();
    expect(b.drain()).toEqual({ requests: [] });
  });
});
