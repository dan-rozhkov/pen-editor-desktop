import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOLD_MS,
  LOGIN_CAPTURE_BINDING,
  LOGIN_CAPTURE_SCRIPT,
  LOGIN_CAPTURE_WORLD,
  PASSWORD_VISIBLE_SCRIPT,
  PASSWORD_VISIBLE_WHEN_READY_SCRIPT,
  SETTLE_MS,
  createLoginCapture,
  decideAfterNavigation,
  decideSavePrompt,
  parseCapturedLogin,
  promptChoiceFromButton,
  savePromptCopy,
  type PromptChoice,
} from "../src/main/browser/loginCapture";
import { createCredentialStore } from "../src/main/browser/credentialStore";

const PASSWORD = "Tr0ub4dor&3-captured";

function makeStore(available = true) {
  const files = new Map<string, string>();
  return createCredentialStore({
    filePath: "/db.json",
    cipher: {
      isAvailable: () => available,
      encrypt: (p) => Buffer.from(`x${p}`),
      decrypt: (b) => b.toString().slice(1),
    },
    fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
  });
}

const login = { username: "alice", password: PASSWORD, origin: "https://example.com" };
const payload = JSON.stringify({ ...login, origin: "https://www.example.com" });

describe("parseCapturedLogin", () => {
  it("accepts a username/password/origin triple and normalizes origin and username", () => {
    expect(parseCapturedLogin(payload)).toEqual(login);
    expect(parseCapturedLogin(JSON.stringify({ username: " bob ", password: "p", origin: "http://Localhost:3000" }))).toEqual({
      username: "bob",
      password: "p",
      origin: "http://localhost:3000",
    });
  });
  it.each([
    [undefined],
    [42],
    ["not json"],
    ["[]"],
    ['{"username":"a","password":"x"}'],
    ['{"username":"a","origin":"https://a.com"}'],
    ['{"username":"","password":"x","origin":"https://a.com"}'],
    ['{"username":"  ","password":"x","origin":"https://a.com"}'],
    ['{"username":"a","password":"","origin":"https://a.com"}'],
    ['{"username":1,"password":"x","origin":"https://a.com"}'],
    ['{"username":"a","password":"x","origin":"null"}'],
    ['{"username":"a","password":"x","origin":"file://"}'],
    ['{"username":"a","password":"x","origin":5}'],
    [JSON.stringify({ username: "a", password: "x".repeat(2000), origin: "https://a.com" })],
  ])("rejects %j", (value) => {
    expect(parseCapturedLogin(value)).toBeNull();
  });
});

describe("decideSavePrompt", () => {
  const base = () => ({ login, store: makeStore(), promptOpen: false });

  it("asks for a new login; the origin comes from the captured login", () => {
    expect(decideSavePrompt(base())).toEqual({ action: "prompt", origin: "https://example.com", username: "alice", update: false });
  });

  it("asks to update when the username is saved with another password", () => {
    const input = base();
    input.store.add({ site: "example.com", username: "alice", password: "old" });
    expect(decideSavePrompt(input)).toEqual({ action: "prompt", origin: "https://example.com", username: "alice", update: true });
  });

  it("an http login on the same host is a different site", () => {
    const input = base();
    input.store.add({ site: "http://example.com", username: "alice", password: PASSWORD });
    expect(decideSavePrompt(input)).toMatchObject({ action: "prompt", update: false });
  });

  it("skips an identical entry", () => {
    const input = base();
    input.store.add({ site: "example.com", username: "alice", password: PASSWORD });
    expect(decideSavePrompt(input)).toEqual({ action: "skip", reason: "identical" });
  });

  it("skips a never-list host", () => {
    const input = base();
    input.store.addNever("example.com");
    expect(decideSavePrompt(input)).toEqual({ action: "skip", reason: "never" });
  });

  it("skips when encryption is unavailable", () => {
    expect(decideSavePrompt({ ...base(), store: makeStore(false) })).toEqual({ action: "skip", reason: "unavailable" });
  });

  it("skips while another prompt is open", () => {
    expect(decideSavePrompt({ ...base(), promptOpen: true })).toEqual({ action: "skip", reason: "busy" });
  });

  it("skips a bad payload", () => {
    expect(decideSavePrompt({ ...base(), login: null })).toEqual({ action: "skip", reason: "bad-payload" });
  });

  it("the decision never contains the password", () => {
    expect(JSON.stringify(decideSavePrompt(base()))).not.toContain(PASSWORD);
  });
});

describe("prompt copy", () => {
  it("names the site, shows the username, has the three buttons; a new login defaults to Save", () => {
    const copy = savePromptCopy({ origin: "https://example.com", username: "alice", update: false });
    expect(copy).toEqual({
      message: "Save password for example.com?",
      detail: "alice",
      buttons: ["Save", "Never for This Site", "Not Now"],
      defaultId: 0,
      cancelId: 2,
    });
  });
  it("an update defaults to, and cancels as, Not Now", () => {
    const copy = savePromptCopy({ origin: "https://example.com", username: "alice", update: true });
    expect(copy.message).toBe("Update password for example.com?");
    expect(copy.buttons[copy.defaultId]).toBe("Not Now");
    expect(copy.buttons[copy.cancelId]).toBe("Not Now");
  });
  it("shows a non-https scheme and a port", () => {
    expect(savePromptCopy({ origin: "http://localhost:3000", username: "u", update: false }).message).toBe(
      "Save password for http://localhost:3000?",
    );
  });
  it("maps buttons to choices; anything else is 'later'", () => {
    expect([0, 1, 2, 9].map(promptChoiceFromButton)).toEqual(["save", "never", "later", "later"]);
  });
});

describe("createLoginCapture", () => {
  const CTX = 77;
  const event = (over: Record<string, unknown> = {}) => ({
    name: LOGIN_CAPTURE_BINDING,
    payload,
    executionContextId: CTX,
    ...over,
  });
  const nav = { frame: { id: "F1", url: "https://example.com/home" } };

  const frameTree = (url: string) => ({ frameTree: { frame: { id: "F1", url } } });
  const cdp = (tree: unknown, contextId = CTX) =>
    vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Page.getFrameTree") return tree;
      if (method === "Page.createIsolatedWorld") return { executionContextId: contextId };
      return {};
    });

  /** A tab session whose current document has the isolated world CTX. */
  async function readyTab(store = makeStore(), choice: PromptChoice = "save") {
    const capture = createLoginCapture(store);
    const tab = capture.forTab();
    const ask = vi.fn(async (): Promise<PromptChoice> => choice);
    const ctx = { send: cdp(frameTree("")), ask };
    await tab.install(cdp(frameTree("https://example.com/login")));
    return { capture, tab, ask, ctx, store };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects into a document by creating the isolated world, adding the binding to THAT context, and running the script", async () => {
    const send = cdp(frameTree("https://example.com/login"), 77);
    await createLoginCapture(makeStore()).forTab().install(send);
    expect(send.mock.calls).toEqual([
      ["Page.getFrameTree"],
      ["Page.createIsolatedWorld", { frameId: "F1", worldName: LOGIN_CAPTURE_WORLD }],
      ["Runtime.addBinding", { name: LOGIN_CAPTURE_BINDING, executionContextId: 77 }],
      ["Runtime.evaluate", { expression: LOGIN_CAPTURE_SCRIPT, contextId: 77 }],
    ]);
    // never the fingerprinting Runtime.enable, never a by-name binding
    expect(send.mock.calls.map((c) => c[0])).not.toContain("Runtime.enable");
    expect(JSON.stringify(send.mock.calls)).not.toContain("executionContextName");
  });

  it("install does nothing on a tab with no web page yet", async () => {
    for (const url of ["", "about:blank"]) {
      const send = cdp(frameTree(url));
      await createLoginCapture(makeStore()).forTab().install(send);
      expect(send.mock.calls.map((c) => c[0])).toEqual(["Page.getFrameTree"]);
    }
  });

  it("install survives CDP failures", async () => {
    const failing = vi.fn(async (_m: string, _p?: Record<string, unknown>): Promise<unknown> => {
      throw new Error("no frame");
    });
    await expect(createLoginCapture(makeStore()).forTab().install(failing)).resolves.toBeUndefined();
    const half = cdp(frameTree("https://example.com/"));
    half.mockImplementation(async (m: string) => {
      if (m === "Page.getFrameTree") return frameTree("https://example.com/");
      if (m === "Page.createIsolatedWorld") return { executionContextId: 5 };
      if (m === "Runtime.addBinding") throw new Error("exists");
      return {};
    });
    await createLoginCapture(makeStore()).forTab().install(half);
    expect(half).toHaveBeenLastCalledWith("Runtime.evaluate", { expression: LOGIN_CAPTURE_SCRIPT, contextId: 5 });
  });

  it("a main-frame Page.frameNavigated injects into the new document; subframes and non-web pages do not", async () => {
    const tab = createLoginCapture(makeStore()).forTab();
    const ask = vi.fn(async (): Promise<PromptChoice> => "later");
    const run = async (frame: Record<string, unknown>) => {
      const send = cdp(frameTree(""));
      await tab.handleCdpEvent("Page.frameNavigated", { frame }, { send, ask });
      return send.mock.calls.map((c) => c[0]);
    };
    expect(await run({ id: "M", url: "https://example.com/" })).toEqual([
      "Page.createIsolatedWorld",
      "Runtime.addBinding",
      "Runtime.evaluate",
    ]);
    expect(await run({ id: "S", parentId: "M", url: "https://ads.example/" })).toEqual([]);
    expect(await run({ id: "M", url: "about:blank" })).toEqual([]);
    expect(await run({ id: "M", url: "chrome-error://chromewebdata/" })).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("ignores other events and other bindings", async () => {
    const { tab, ask, ctx } = await readyTab();
    expect(await tab.handleCdpEvent("Page.loadEventFired", {}, ctx)).toBe(false);
    expect(await tab.handleCdpEvent("Runtime.bindingCalled", event({ name: "somethingElse" }), ctx)).toBe(false);
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask when the submit arrives: it waits for a navigation", async () => {
    const { tab, ask, ctx } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(ask).not.toHaveBeenCalled();
  });

  it("a main-frame navigation within the window asks, and Save stores under the PAYLOAD origin", async () => {
    const { tab, ask, ctx, store } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    // the tab has meanwhile navigated elsewhere: the filing site is still the one submitted on
    await tab.handleCdpEvent("Page.frameNavigated", { frame: { id: "F1", url: "https://other.test/dashboard" } }, ctx);
    expect(ask).toHaveBeenCalledWith({ origin: "https://example.com", username: "alice", update: false });
    expect(JSON.stringify(ask.mock.calls)).not.toContain(PASSWORD);
    expect(store.findForOrigin("https://example.com")).toMatchObject({ ok: true, entry: { username: "alice", password: PASSWORD } });
    expect(store.list().map((e) => e.origin)).toEqual(["https://example.com"]);
  });

  it("a same-document navigation within the window asks too", async () => {
    const { tab, ask, ctx } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1", url: "https://example.com/#/home" }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("no navigation within the window: the capture is dropped, a later navigation asks nothing", async () => {
    const { tab, ask, ctx } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
    await vi.advanceTimersByTimeAsync(HOLD_MS + 1);
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).not.toHaveBeenCalled();
  });

  it("a held capture asks only once", async () => {
    const { tab, ask, ctx } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a newer submit replaces the held one", async () => {
    const { tab, ask, ctx } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event({ payload: JSON.stringify({ ...login, password: "typo" }) }), ctx);
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("drops an event from any context other than the one created for the current document", async () => {
    const { tab, ask, ctx } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event({ executionContextId: 5 }), ctx);
    await tab.handleCdpEvent("Runtime.bindingCalled", event({ executionContextId: undefined }), ctx);
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    expect(ask).not.toHaveBeenCalled();
  });

  it("drops an event from the previous document's context after a navigation", async () => {
    const { tab, ask, ctx } = await readyTab();
    // the new document gets context 88; the old 77 is stale
    const send = cdp(frameTree(""), 88);
    await tab.handleCdpEvent("Page.frameNavigated", { frame: { id: "F1", url: "https://example.com/next" } }, { send, ask });
    await tab.handleCdpEvent("Runtime.bindingCalled", event({ executionContextId: 77 }), ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).not.toHaveBeenCalled();
    await tab.handleCdpEvent("Runtime.bindingCalled", event({ executionContextId: 88 }), ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("contexts are per tab: another tab's context id is not accepted", async () => {
    const capture = createLoginCapture(makeStore());
    const a = capture.forTab();
    const b = capture.forTab();
    await a.install(cdp(frameTree("https://example.com/"), 10));
    await b.install(cdp(frameTree("https://example.com/"), 20));
    const ask = vi.fn(async (): Promise<PromptChoice> => "later");
    const ctx = { send: cdp(frameTree("")), ask };
    await a.handleCdpEvent("Runtime.bindingCalled", event({ executionContextId: 20 }), ctx);
    await a.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).not.toHaveBeenCalled();
  });

  it("a payload without an origin, or with a forged host field, cannot choose a site", async () => {
    const { tab, ask, ctx, store } = await readyTab();
    await tab.handleCdpEvent("Runtime.bindingCalled", event({ payload: JSON.stringify({ username: "a", password: "p" }) }), ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).not.toHaveBeenCalled();
    const evil = JSON.stringify({ ...login, host: "bank.com", url: "https://bank.com" });
    await tab.handleCdpEvent("Runtime.bindingCalled", event({ payload: evil }), ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(store.list().map((e) => e.origin)).toEqual(["https://example.com"]);
  });

  it("Never adds the host to the never list; Not Now stores nothing", async () => {
    const never = await readyTab(makeStore(), "never");
    await never.tab.handleCdpEvent("Runtime.bindingCalled", event(), never.ctx);
    await never.tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, never.ctx);
    expect(never.store.isNever("example.com")).toBe(true);
    expect(never.store.list()).toEqual([]);

    const later = await readyTab(makeStore(), "later");
    await later.tab.handleCdpEvent("Runtime.bindingCalled", event(), later.ctx);
    await later.tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, later.ctx);
    expect(later.store.list()).toEqual([]);
    expect(later.store.listNever()).toEqual([]);
  });

  it("an update prompt does not overwrite the saved password on Not Now", async () => {
    const store = makeStore();
    store.add({ site: "example.com", username: "alice", password: "good-password" });
    const { tab, ask, ctx } = await readyTab(store, "later");
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).toHaveBeenCalledWith({ origin: "https://example.com", username: "alice", update: true });
    expect(store.findForOrigin("example.com")).toMatchObject({ ok: true, entry: { password: "good-password" } });
  });

  it("skips (no dialog) for never-list, identical, and unavailable encryption", async () => {
    const never = makeStore();
    never.addNever("example.com");
    const same = makeStore();
    same.add({ site: "example.com", username: "alice", password: PASSWORD });
    for (const store of [never, same, makeStore(false)]) {
      const { tab, ask, ctx } = await readyTab(store);
      await tab.handleCdpEvent("Runtime.bindingCalled", event(), ctx);
      await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
      expect(ask).not.toHaveBeenCalled();
    }
  });

  it("only one prompt at a time, shared across tabs", async () => {
    const capture = createLoginCapture(makeStore());
    const a = capture.forTab();
    const b = capture.forTab();
    await a.install(cdp(frameTree("https://a.example/"), CTX));
    await b.install(cdp(frameTree("https://b.example/"), CTX));
    let release: (c: PromptChoice) => void = () => {};
    const send = cdp(frameTree(""));
    await a.handleCdpEvent("Runtime.bindingCalled", event(), { send, ask: () => new Promise<PromptChoice>((r) => (release = r)) });
    const first = a.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, { send, ask: () => new Promise<PromptChoice>((r) => (release = r)) });
    const secondAsk = vi.fn(async (): Promise<PromptChoice> => "save");
    await b.handleCdpEvent("Runtime.bindingCalled", event(), { send, ask: secondAsk });
    await b.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, { send, ask: secondAsk });
    expect(secondAsk).not.toHaveBeenCalled();
    release("later");
    await first;
    await b.handleCdpEvent("Runtime.bindingCalled", event(), { send, ask: secondAsk });
    await b.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, { send, ask: secondAsk });
    expect(secondAsk).toHaveBeenCalledTimes(1);
  });

  it("a dialog that throws counts as Not Now and frees the gate", async () => {
    const { tab, ctx, store } = await readyTab();
    const throwing = {
      ...ctx,
      ask: async (): Promise<PromptChoice> => {
        throw new Error("window closed");
      },
    };
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), throwing);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, throwing);
    expect(store.list()).toEqual([]);
    const ask = vi.fn(async (): Promise<PromptChoice> => "later");
    await tab.handleCdpEvent("Runtime.bindingCalled", event(), { ...ctx, ask });
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, { ...ctx, ask });
    expect(ask).toHaveBeenCalled();
  });
});

describe("sign-in success check after a navigation", () => {
  const CTX = 77;
  const evt = { name: LOGIN_CAPTURE_BINDING, payload, executionContextId: CTX };
  const nav = { frame: { id: "F1", url: "https://example.com/login" } };

  /** CDP fake: the visibility check answers `visible`; everything else is empty. */
  function session(visible: boolean | "throw" | "hang") {
    return vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1", url: "https://example.com/login" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: CTX };
      if (method === "Runtime.evaluate" && params?.returnByValue) {
        if (visible === "throw") throw new Error("context destroyed");
        if (visible === "hang" && params.awaitPromise) return new Promise(() => {});
        return { result: { value: visible === "hang" ? false : visible } };
      }
      return {};
    });
  }

  async function held(visible: boolean | "throw" | "hang") {
    const tab = createLoginCapture(makeStore()).forTab();
    const send = session(visible);
    const ask = vi.fn(async (): Promise<PromptChoice> => "later");
    await tab.install(send);
    await tab.handleCdpEvent("Runtime.bindingCalled", evt, { send, ask });
    return { tab, send, ask, ctx: { send, ask } };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("decideAfterNavigation: only a visible password field drops", () => {
    expect(decideAfterNavigation(true)).toBe("drop");
    expect(decideAfterNavigation(false)).toBe("prompt");
    expect(decideAfterNavigation(null)).toBe("prompt");
  });

  it("a main-frame navigation that lands on the sign-in form again (wrong password) asks nothing", async () => {
    const { tab, ask, ctx } = await held(true);
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    expect(ask).not.toHaveBeenCalled();
  });

  it("a same-document navigation that still shows the sign-in form asks nothing", async () => {
    const { tab, ask, ctx } = await held(true);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).not.toHaveBeenCalled();
  });

  it("the check runs in the isolated world of the NEW document and waits for readiness", async () => {
    const { tab, send, ctx } = await held(false);
    send.mockClear();
    await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    expect(send).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: PASSWORD_VISIBLE_WHEN_READY_SCRIPT,
      contextId: CTX,
      awaitPromise: true,
      returnByValue: true,
    });
  });

  it("a page without a password field after the navigation asks; an unanswerable check asks too", async () => {
    for (const v of [false, "throw"] as const) {
      const { tab, ask, ctx } = await held(v);
      await tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
      expect(ask).toHaveBeenCalledTimes(1);
    }
  });

  it("a document that never becomes ready is checked anyway after SETTLE_MS (not longer)", async () => {
    const { tab, send, ask, ctx } = await held("hang");
    const done = tab.handleCdpEvent("Page.frameNavigated", nav, ctx);
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(send).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: PASSWORD_VISIBLE_SCRIPT,
      contextId: CTX,
      awaitPromise: false,
      returnByValue: true,
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a same-document navigation of a subframe does not count", async () => {
    const { tab, ask, ctx } = await held(false);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "SUB" }, ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", {}, ctx);
    expect(ask).not.toHaveBeenCalled();
    // ...and the capture is still held for the real one
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a late result for an older document cannot overwrite the current context (out-of-order navigations)", async () => {
    const tab = createLoginCapture(makeStore()).forTab();
    const ask = vi.fn(async (): Promise<PromptChoice> => "later");
    const resolvers = new Map<string, (v: unknown) => void>();
    const slow = (name: string, id: number) =>
      vi.fn(async (method: string): Promise<unknown> => {
        if (method === "Page.createIsolatedWorld") return new Promise((r) => resolvers.set(name, () => r({ executionContextId: id })));
        return {};
      });
    const a = slow("a", 1);
    const b = slow("b", 2);
    const first = tab.handleCdpEvent("Page.frameNavigated", { frame: { id: "F1", url: "https://example.com/a" } }, { send: a, ask });
    const second = tab.handleCdpEvent("Page.frameNavigated", { frame: { id: "F1", url: "https://example.com/b" } }, { send: b, ask });
    // the newer document answers first, the older one afterwards
    resolvers.get("b")!(undefined);
    await second;
    resolvers.get("a")!(undefined);
    await first;
    const ctx = { send: b, ask };
    await tab.handleCdpEvent("Runtime.bindingCalled", { ...evt, executionContextId: 1 }, ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).not.toHaveBeenCalled();
    await tab.handleCdpEvent("Runtime.bindingCalled", { ...evt, executionContextId: 2 }, ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a slow install() result cannot overwrite the context of a newer document", async () => {
    const tab = createLoginCapture(makeStore()).forTab();
    const ask = vi.fn(async (): Promise<PromptChoice> => "later");
    let release: (v: unknown) => void = () => {};
    const slowTree = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "Page.getFrameTree") return new Promise((r) => (release = r));
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      return {};
    });
    const installing = tab.install(slowTree);
    const fresh = vi.fn(async (method: string): Promise<unknown> => (method === "Page.createIsolatedWorld" ? { executionContextId: 2 } : {}));
    await tab.handleCdpEvent("Page.frameNavigated", { frame: { id: "F1", url: "https://example.com/" } }, { send: fresh, ask });
    release({ frameTree: { frame: { id: "F1", url: "https://example.com/" } } });
    await installing;
    const ctx = { send: fresh, ask };
    await tab.handleCdpEvent("Runtime.bindingCalled", { ...evt, executionContextId: 1 }, ctx);
    await tab.handleCdpEvent("Page.navigatedWithinDocument", { frameId: "F1" }, ctx);
    expect(ask).not.toHaveBeenCalled();
    expect(slowTree.mock.calls.map((c) => c[0])).not.toContain("Runtime.addBinding");
  });
});

describe("PASSWORD_VISIBLE_SCRIPT", () => {
  const field = (rect: { width: number; height: number }, style: { visibility?: string; display?: string } = {}) => ({
    getBoundingClientRect: () => rect,
    style,
  });
  const run = (fields: ReturnType<typeof field>[]) =>
    vm.runInNewContext(PASSWORD_VISIBLE_SCRIPT, {
      document: { querySelectorAll: () => fields },
      window: { getComputedStyle: (el: { style: Record<string, string> }) => ({ visibility: "visible", display: "block", ...el.style }) },
    });

  it("true for a laid-out password field", () => {
    expect(run([field({ width: 200, height: 30 })])).toBe(true);
  });
  it("false for none, zero-size, display:none or visibility:hidden fields", () => {
    expect(run([])).toBe(false);
    expect(run([field({ width: 0, height: 0 }), field({ width: 9, height: 9 }, { display: "none" }), field({ width: 9, height: 9 }, { visibility: "hidden" })])).toBe(false);
  });
});

// The injected script itself, run against a minimal fake DOM.
describe("LOGIN_CAPTURE_SCRIPT", () => {
  type Handler = (e: Record<string, unknown>) => void;

  function input(type: string, value: string, extra: Record<string, unknown> = {}) {
    return { value, disabled: false, readOnly: false, tagName: "INPUT", getAttribute: (n: string) => (n === "type" ? type : null), ...extra };
  }

  function run(opts: { top?: boolean; active?: boolean } = {}) {
    const handlers = new Map<string, Handler>();
    const calls: string[] = [];
    const win: Record<string, unknown> = {};
    win.top = opts.top === false ? {} : win;
    win[LOGIN_CAPTURE_BINDING] = (p: string) => calls.push(p);
    const ctx = vm.createContext({
      window: win,
      document: { addEventListener: (name: string, h: Handler) => handlers.set(name, h) },
      navigator: { userActivation: { isActive: opts.active ?? true } },
      location: { origin: "https://example.com" },
      Date,
      JSON,
    });
    vm.runInContext(LOGIN_CAPTURE_SCRIPT, ctx);
    const form = (inputs: ReturnType<typeof input>[]) => ({ querySelectorAll: () => inputs });
    return { handlers, calls, form };
  }

  it("running the script twice in one world installs one set of handlers", () => {
    const handlers = new Map<string, Handler>();
    const win: Record<string, unknown> = {};
    win.top = win;
    const added: string[] = [];
    const ctx = vm.createContext({
      window: win,
      document: { addEventListener: (name: string, h: Handler) => (added.push(name), handlers.set(name, h)) },
      navigator: { userActivation: { isActive: true } },
      location: { origin: "https://example.com" },
      Date,
      JSON,
    });
    vm.runInContext(LOGIN_CAPTURE_SCRIPT, ctx);
    vm.runInContext(LOGIN_CAPTURE_SCRIPT, ctx);
    expect(added).toEqual(["submit", "click", "keydown"]);
  });

  it("does nothing in a child frame", () => {
    const { handlers } = run({ top: false });
    expect(handlers.size).toBe(0);
  });

  it("submit with a user gesture sends username and password by DOM order", () => {
    const { handlers, calls, form } = run();
    handlers.get("submit")!({ target: form([input("hidden", "csrf"), input("email", "alice"), input("password", PASSWORD)]) });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0])).toEqual({ username: "alice", password: PASSWORD, origin: "https://example.com" });
  });

  it("sends nothing from a form with two or more password fields (change-password, sign-up with confirm)", () => {
    const { handlers, calls, form } = run();
    handlers.get("submit")!({ target: form([input("text", "alice"), input("password", "old-pw"), input("password", "new-pw")]) });
    handlers.get("submit")!({ target: form([input("text", "alice"), input("password", PASSWORD), input("password", "")]) });
    handlers.get("submit")!({ target: form([input("text", "alice"), input("password", ""), input("password", PASSWORD)]) });
    expect(calls).toEqual([]);
  });

  it("a submit with no user activation (page script requestSubmit) sends nothing", () => {
    const { handlers, calls, form } = run({ active: false });
    handlers.get("submit")!({ target: form([input("text", "alice"), input("password", PASSWORD)]) });
    expect(calls).toEqual([]);
  });

  it("does not send without both a username and a password", () => {
    const { handlers, calls, form } = run();
    handlers.get("submit")!({ target: form([input("text", "alice"), input("password", "")]) });
    handlers.get("submit")!({ target: form([input("text", ""), input("password", PASSWORD)]) });
    expect(calls).toEqual([]);
  });

  it("click on a submit button and Enter in a field both capture, but only when trusted", () => {
    const { handlers, calls, form } = run();
    const f = form([input("text", "alice"), input("password", PASSWORD)]);
    const btn = { form: f, type: "submit" };
    handlers.get("click")!({ isTrusted: false, target: { closest: () => btn } });
    handlers.get("keydown")!({ isTrusted: false, key: "Enter", target: { form: f, tagName: "INPUT" } });
    expect(calls).toEqual([]);
    handlers.get("click")!({ isTrusted: true, target: { closest: () => btn } });
    expect(calls).toHaveLength(1);
  });

  it("Enter in a form field captures; other keys and non-form targets do not", () => {
    const { handlers, calls, form } = run();
    const f = form([input("text", "alice"), input("password", PASSWORD)]);
    handlers.get("keydown")!({ isTrusted: true, key: "a", target: { form: f, tagName: "INPUT" } });
    handlers.get("keydown")!({ isTrusted: true, key: "Enter", target: { tagName: "DIV" } });
    expect(calls).toEqual([]);
    handlers.get("keydown")!({ isTrusted: true, key: "Enter", target: { form: f, tagName: "INPUT" } });
    expect(calls).toHaveLength(1);
  });

  it("de-duplicates the click + submit pair of one sign-in", () => {
    const { handlers, calls, form } = run();
    const f = form([input("text", "alice"), input("password", PASSWORD)]);
    handlers.get("click")!({ isTrusted: true, target: { closest: () => ({ form: f, type: "submit" }) } });
    handlers.get("submit")!({ target: f });
    handlers.get("keydown")!({ isTrusted: true, key: "Enter", target: { form: f, tagName: "INPUT" } });
    expect(calls).toHaveLength(1);
  });
});
