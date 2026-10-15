import { describe, expect, it } from "vitest";
import { FetchRouter, type RoutedTab, type FetchMockHandler } from "../src/main/fetchRouting";

class FakeTab implements RoutedTab {
  calls: { method: string; params?: Record<string, unknown> }[] = [];
  listeners = new Set<(m: string, p: unknown) => void>();
  failAll = false;
  sendCommand(method: string, params?: Record<string, unknown>) {
    this.calls.push({ method, params });
    return this.failAll ? Promise.reject(new Error("gone")) : Promise.resolve({});
  }
  onEvent(cb: (m: string, p: unknown) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  pause(requestId: string, url: string, method = "GET") {
    for (const l of [...this.listeners]) l("Fetch.requestPaused", { requestId, request: { url, method } });
  }
  named(m: string) {
    return this.calls.filter((c) => c.method === m);
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(handler: FetchMockHandler) {
  const router = new FetchRouter();
  const tab = new FakeTab();
  router.registerTab(tab);
  const remove = await router.routeRequests(handler);
  return { router, tab, remove };
}

describe("FetchRouter", () => {
  it("enables Fetch with a Request-stage wildcard pattern", async () => {
    const { tab } = await setup(() => undefined);
    expect(tab.named("Fetch.enable")[0].params).toEqual({ patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  });

  it("fulfills with status, headers and a base64 JSON body", async () => {
    const { tab } = await setup((r) =>
      r.url.endsWith("/api") ? { status: 201, headers: { "content-type": "application/json" }, body: '{"a":1}' } : undefined,
    );
    tab.pause("1", "http://localhost:3000/api", "POST");
    await tick();
    const f = tab.named("Fetch.fulfillRequest")[0].params!;
    expect(f.requestId).toBe("1");
    expect(f.responseCode).toBe(201);
    expect(f.responseHeaders).toEqual([{ name: "content-type", value: "application/json" }]);
    expect(Buffer.from(f.body as string, "base64").toString()).toBe('{"a":1}');
  });

  it("passes unmatched requests through", async () => {
    const { tab } = await setup(() => undefined);
    tab.pause("2", "http://x/y");
    await tick();
    expect(tab.named("Fetch.continueRequest")[0].params).toEqual({ requestId: "2" });
  });

  it("aborts with failRequest", async () => {
    const { tab } = await setup(() => ({ status: 0, headers: {}, body: "", abort: true }));
    tab.pause("3", "http://x/y");
    await tick();
    expect(tab.named("Fetch.failRequest")[0].params).toEqual({ requestId: "3", errorReason: "Failed" });
  });

  it("delays the answer", async () => {
    const { tab } = await setup(() => ({ status: 200, headers: {}, body: "x", delayMs: 40 }));
    tab.pause("4", "http://x/y");
    await tick();
    expect(tab.named("Fetch.fulfillRequest")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 70));
    expect(tab.named("Fetch.fulfillRequest")).toHaveLength(1);
  });

  it("remove continues a delayed request, disables Fetch, and is idempotent", async () => {
    const { tab, remove } = await setup(() => ({ status: 200, headers: {}, body: "x", delayMs: 10_000 }));
    tab.pause("5", "http://x/y");
    await tick();
    await remove();
    await remove();
    await tick();
    expect(tab.named("Fetch.continueRequest")[0].params).toEqual({ requestId: "5" });
    expect(tab.named("Fetch.fulfillRequest")).toHaveLength(0);
    expect(tab.named("Fetch.disable")).toHaveLength(1);
  });

  it("enables a tab registered while routing is active, and not after removal", async () => {
    const { router, remove } = await setup(() => undefined);
    const late = new FakeTab();
    router.registerTab(late);
    await tick();
    expect(late.named("Fetch.enable")).toHaveLength(1);
    await remove();
    expect(late.named("Fetch.disable")).toHaveLength(1);
    const later = new FakeTab();
    router.registerTab(later);
    expect(later.calls).toHaveLength(0);
  });

  it("never touches a tab that was not registered (editor tabs)", async () => {
    const editor = new FakeTab();
    const { remove } = await setup(() => undefined);
    await remove();
    expect(editor.calls).toHaveLength(0);
  });

  it("falls back to continue when fulfill fails, and to fail as a last resort", async () => {
    const { tab } = await setup(() => ({ status: 200, headers: {}, body: "x" }));
    const orig = tab.sendCommand.bind(tab);
    tab.sendCommand = (m, p) => (m === "Fetch.fulfillRequest" ? Promise.reject(new Error("bad")) : orig(m, p));
    tab.pause("6", "http://x/y");
    await tick();
    expect(tab.named("Fetch.continueRequest")).toHaveLength(1);
  });

  it("ignores a closed tab and works with no tab registered", async () => {
    const router = new FetchRouter();
    const remove = await router.routeRequests(() => undefined);
    await remove();
    const { tab, remove: rm } = await setup(() => ({ status: 200, headers: {}, body: "x" }));
    tab.failAll = true;
    tab.pause("7", "http://x/y");
    await tick();
    await expect(rm()).resolves.toBeUndefined();
  });

  it("unregistered tab stops receiving events", async () => {
    const router = new FetchRouter();
    const tab = new FakeTab();
    const unregister = router.registerTab(tab);
    unregister();
    expect(tab.listeners.size).toBe(0);
  });

  it("resolves only after Fetch.enable is acknowledged", async () => {
    const router = new FetchRouter();
    const tab = new FakeTab();
    let ack!: () => void;
    tab.sendCommand = (m, p) => {
      tab.calls.push({ method: m, params: p });
      return m === "Fetch.enable" ? new Promise((r) => (ack = () => r({}))) : Promise.resolve({});
    };
    router.registerTab(tab);
    let done = false;
    const pending = router.routeRequests(() => undefined).then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    ack();
    await pending;
    expect(done).toBe(true);
  });

  it("throws and leaves nothing enabled when enable fails on any tab", async () => {
    const router = new FetchRouter();
    const good = new FakeTab();
    const bad = new FakeTab();
    bad.failAll = true;
    router.registerTab(good);
    router.registerTab(bad);
    await expect(router.routeRequests(() => undefined)).rejects.toThrow(/could not enable request interception/);
    expect(good.named("Fetch.disable")).toHaveLength(1);
    expect(bad.named("Fetch.disable")).toHaveLength(0);
    const late = new FakeTab();
    router.registerTab(late);
    expect(late.calls).toHaveLength(0); // route removed
  });

  it("a route started while an earlier remove is in flight keeps Fetch enabled", async () => {
    const router = new FetchRouter();
    const tab = new FakeTab();
    let release!: () => void;
    const origSend = tab.sendCommand.bind(tab);
    tab.sendCommand = (method, params) => {
      if (method === "Fetch.disable") {
        tab.calls.push({ method, params });
        return new Promise((r) => (release = () => r({})));
      }
      return origSend(method, params);
    };
    router.registerTab(tab);
    const removeA = await router.routeRequests(() => undefined);
    const removing = removeA();
    await tick();
    const routingB = router.routeRequests(() => undefined);
    await tick();
    release?.();
    await removing;
    await routingB;
    // Order of the commands on the wire: the last one must be an enable.
    const last = tab.calls.filter((c) => c.method === "Fetch.enable" || c.method === "Fetch.disable").at(-1);
    expect(last?.method).toBe("Fetch.enable");
  });

  it("ignores a Fetch.enable failure on a tab unregistered meanwhile", async () => {
    const router = new FetchRouter();
    const tab = new FakeTab();
    const unregister = router.registerTab(tab);
    tab.failAll = true;
    const p = router.routeRequests(() => undefined);
    unregister();
    await expect(p).resolves.toBeTypeOf("function");
  });

  it("still fails when a registered tab cannot enable", async () => {
    const router = new FetchRouter();
    const tab = new FakeTab();
    tab.failAll = true;
    router.registerTab(tab);
    await expect(router.routeRequests(() => undefined)).rejects.toThrow(/could not enable/);
  });

  it("assertCurrentTabInterceptable refuses an unregistered current tab", () => {
    const router = new FetchRouter();
    router.registerTab(new FakeTab(), 7);
    expect(() => router.assertCurrentTabInterceptable(7)).not.toThrow();
    expect(() => router.assertCurrentTabInterceptable(null)).not.toThrow();
    expect(() => router.assertCurrentTabInterceptable(8)).toThrow(/not available in this browser tab/);
  });

  it("a tab unregistered after routing started fails the interceptable check", async () => {
    const router = new FetchRouter();
    const unregister = router.registerTab(new FakeTab(), 7);
    await router.routeRequests(() => undefined);
    unregister();
    expect(() => router.assertCurrentTabInterceptable(7)).toThrow(/not available in this browser tab/);
  });
});
