import { describe, expect, it } from "vitest";
import { createFailedRequestRecorder, FAILED_REQUEST_CAP, redactUrl } from "../src/main/failedRequests";

const sent = (id: string, url: string, method = "GET", type = "Fetch") =>
  ({ requestId: id, type, request: { url, method } });

describe("redactUrl", () => {
  it("keeps origin + pathname only", () => {
    expect(redactUrl("https://a.test:8080/x/y?token=s#frag")).toBe("https://a.test:8080/x/y");
  });
  it("rejects data:, blob: and junk", () => {
    expect(redactUrl("data:text/plain,hi")).toBeNull();
    expect(redactUrl("blob:https://a.test/1")).toBeNull();
    expect(redactUrl("not a url")).toBeNull();
  });
});

describe("failed request recorder", () => {
  it("records HTTP >= 400 with method and a redacted URL", () => {
    const r = createFailedRequestRecorder();
    r.onEvent("Network.requestWillBeSent", sent("1", "https://a.test/api/users?key=secret", "POST"));
    r.onEvent("Network.responseReceived", { requestId: "1", response: { status: 500, url: "https://a.test/api/users?key=secret" } });
    r.onEvent("Network.requestWillBeSent", sent("2", "https://a.test/ok"));
    r.onEvent("Network.responseReceived", { requestId: "2", response: { status: 200, url: "https://a.test/ok" } });
    r.onEvent("Network.requestWillBeSent", sent("3", "https://a.test/a.png#x"));
    r.onEvent("Network.responseReceived", { requestId: "3", response: { status: 404, url: "https://a.test/a.png#x" } });
    expect(r.drain()).toEqual(["POST 500 https://a.test/api/users", "GET 404 https://a.test/a.png"]);
  });

  it("drain clears", () => {
    const r = createFailedRequestRecorder();
    r.onEvent("Network.requestWillBeSent", sent("1", "https://a.test/x"));
    r.onEvent("Network.loadingFailed", { requestId: "1", errorText: "net::ERR_CONNECTION_REFUSED" });
    expect(r.drain()).toEqual(["GET net::ERR_CONNECTION_REFUSED https://a.test/x"]);
    expect(r.drain()).toEqual([]);
  });

  it("skips a request the page cancelled, but not an unflagged ERR_ABORTED", () => {
    const r = createFailedRequestRecorder();
    r.onEvent("Network.requestWillBeSent", sent("1", "https://a.test/a"));
    r.onEvent("Network.loadingFailed", { requestId: "1", errorText: "net::ERR_ABORTED", canceled: true });
    r.onEvent("Network.requestWillBeSent", sent("2", "https://a.test/b"));
    r.onEvent("Network.loadingFailed", { requestId: "2", errorText: "net::ERR_ABORTED" });
    expect(r.drain()).toEqual(["GET net::ERR_ABORTED https://a.test/b"]);
  });

  it("skips WebSocket, EventSource, Ping and data: URLs", () => {
    const r = createFailedRequestRecorder();
    for (const [i, type] of ["WebSocket", "EventSource", "Ping"].entries()) {
      r.onEvent("Network.requestWillBeSent", sent(`w${i}`, "https://a.test/s", "GET", type));
      r.onEvent("Network.responseReceived", { requestId: `w${i}`, type, response: { status: 500, url: "https://a.test/s" } });
      r.onEvent("Network.loadingFailed", { requestId: `w${i}`, errorText: "net::ERR_FAILED" });
    }
    r.onEvent("Network.requestWillBeSent", sent("d", "data:image/png;base64,AAAA", "GET", "Image"));
    r.onEvent("Network.loadingFailed", { requestId: "d", errorText: "net::ERR_FAILED" });
    expect(r.drain()).toEqual([]);
  });

  it("truncates an entry to 200 chars and keeps the newest 50", () => {
    const r = createFailedRequestRecorder();
    r.onEvent("Network.requestWillBeSent", sent("long", `https://a.test/${"p".repeat(400)}`));
    r.onEvent("Network.loadingFailed", { requestId: "long", errorText: "net::ERR_FAILED" });
    expect(r.drain()[0]).toHaveLength(200);
    for (let i = 0; i < FAILED_REQUEST_CAP + 10; i++) {
      r.onEvent("Network.requestWillBeSent", sent(`r${i}`, `https://a.test/${i}`));
      r.onEvent("Network.loadingFailed", { requestId: `r${i}`, errorText: "net::ERR_FAILED" });
    }
    const out = r.drain();
    expect(out).toHaveLength(FAILED_REQUEST_CAP);
    expect(out[0]).toBe("GET net::ERR_FAILED https://a.test/10");
  });

  it("ignores malformed events", () => {
    const r = createFailedRequestRecorder();
    r.onEvent("Network.responseReceived", undefined);
    r.onEvent("Network.loadingFailed", { requestId: 5 });
    r.onEvent("Page.loadEventFired", {});
    expect(r.drain()).toEqual([]);
  });
});
