import { describe, expect, it, vi } from "vitest";
import {
  fillLogin,
  parseFillLoginArgs,
  pickFromSnapshot,
  type FillLoginDeps,
  type LoginController,
} from "../src/main/browser/fillLogin";
import { createCredentialStore } from "../src/main/browser/credentialStore";

const USERNAME = "alice@corp.test";
const PASSWORD = "Hunter2-very-secret";

function makeStore() {
  const files = new Map<string, string>();
  const store = createCredentialStore({
    filePath: "/db.json",
    cipher: {
      isAvailable: () => true,
      encrypt: (p) => Buffer.from(`x${p}`),
      decrypt: (b) => b.toString().slice(1),
    },
    fs: { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), rename: () => {} },
  });
  return store;
}

// Element shapes are what SNAPSHOT_JS in @sideform/browser-agent really emits
// (controller/pageScripts.js): an <input type=text> reports `value`; email/tel/
// number/date inputs report `hasValue` instead; a password reports
// `isPassword: true` with ops ["TYPE_TEXT"] and `hasValue`; no text field has an
// `inputType` (only checkbox/radio do), and there is no `autocomplete`.
type El = Record<string, unknown>;
const field = (index: number, extra: El = {}): El => ({
  index,
  tag: "input",
  label: "",
  ops: ["TYPE_TEXT", "CLICK"],
  value: "",
  ...extra,
});
/** <input type=email|tel|...>: `hasValue`, no `value`. */
const typedField = (index: number, extra: El = {}): El => {
  const { value: _drop, ...rest } = field(index, extra);
  void _drop;
  return { ...rest, hasValue: false };
};
const passwordField = (index: number, extra: El = {}): El => ({
  index,
  tag: "input",
  label: "Password",
  ops: ["TYPE_TEXT"],
  isPassword: true,
  hasValue: false,
  ...extra,
});
const button = (index: number, label = "Sign in"): El => ({ index, tag: "button", label, ops: ["CLICK"] });

function makeController(elements: El[], opts: { performError?: (call: number) => boolean; pressError?: boolean } = {}) {
  const performCalls: Record<string, unknown>[] = [];
  const actCalls: Record<string, unknown>[] = [];
  const controller: LoginController = {
    snapshot: vi.fn(async () => ({ snapshotId: "snap-1", url: "https://example.com/", elements })),
    perform: vi.fn(async (args) => {
      performCalls.push(args);
      // A hostile/leaky controller result: it must never reach the caller.
      if (opts.performError?.(performCalls.length)) return { error: `page said: ${PASSWORD}` };
      return { ok: true, changes: ["dom"], typed: args.text, text: PASSWORD };
    }),
    act: vi.fn(async (args) => {
      actCalls.push(args);
      return opts.pressError ? { error: "no cdp" } : { ok: true, url: "https://example.com/next" };
    }),
  };
  return { controller, performCalls, actCalls };
}

function setup(elements: El[], url: string | null = "https://www.example.com/login", opts: Parameters<typeof makeController>[1] = {}) {
  const store = makeStore();
  store.add({ site: "example.com", username: USERNAME, password: PASSWORD, label: "main" });
  const c = makeController(elements, opts);
  const deps: FillLoginDeps = { controller: c.controller, store, getUrl: () => url };
  return { store, deps, ...c };
}

const loginForm = (): El[] => [
  field(0, { label: "Search" }),
  typedField(1, { label: "Email address" }),
  passwordField(2),
  button(3),
];

const noSecret = (result: unknown) => {
  const json = JSON.stringify(result);
  expect(json).not.toContain(USERNAME);
  expect(json).not.toContain(PASSWORD);
};

describe("parseFillLoginArgs", () => {
  it("accepts nothing, {}, label and submit", () => {
    expect(parseFillLoginArgs(undefined)).toEqual({ submit: false });
    expect(parseFillLoginArgs({})).toEqual({ submit: false });
    expect(parseFillLoginArgs({ label: " admin ", submit: true })).toEqual({ label: "admin", submit: true });
  });
  it("rejects wrong types and ignores unknown keys", () => {
    expect(parseFillLoginArgs({ label: 5 })).toBeNull();
    expect(parseFillLoginArgs({ submit: "yes" })).toBeNull();
    expect(parseFillLoginArgs("x")).toBeNull();
    expect(parseFillLoginArgs({ label: "x".repeat(300) })).toBeNull();
    expect(parseFillLoginArgs({ password: "p" })).toEqual({ submit: false });
  });
});

describe("pickFromSnapshot (real snapshot element shapes)", () => {
  it("password field plus the nearest preceding text field", () => {
    expect(pickFromSnapshot({ elements: loginForm() })).toEqual({ password: 2, username: 1 });
  });

  it("skips elements inside iframes", () => {
    const els = [
      typedField(0, { label: "Email", frame: "Payment frame" }),
      passwordField(1, { frame: "Payment frame" }),
    ];
    expect(pickFromSnapshot({ elements: els })).toEqual({});
  });

  it("uses the top-document password when a frame also has one", () => {
    const els = [
      typedField(0, { label: "Email" }),
      passwordField(1, { frame: "ad" }),
      passwordField(2),
    ];
    expect(pickFromSnapshot({ elements: els })).toEqual({ password: 2, username: 0 });
  });

  it("two-step page: username only", () => {
    const els = [field(0, { label: "Search" }), typedField(1, { label: "Email or phone" }), button(2, "Next")];
    expect(pickFromSnapshot({ elements: els })).toEqual({ username: 1 });
  });

  it("two-step page: a text field without a login-looking label is not filled", () => {
    expect(pickFromSnapshot({ elements: [field(0, { label: "Your nickname" })] })).toEqual({});
  });

  it("a password-only page fills the password alone", () => {
    expect(pickFromSnapshot({ elements: [passwordField(0)] })).toEqual({
      password: 0,
    });
  });

  it("ignores disabled fields and password inputs that cannot be typed into", () => {
    const els = [typedField(0, { label: "Email", disabled: true }), passwordField(1, { ops: ["CLICK"] })];
    expect(pickFromSnapshot({ elements: els })).toEqual({});
  });

  it("never picks a search box, combobox, spinbutton, slider, popup field or select as the username", () => {
    const els = [
      field(0, { label: "Search" }),
      field(1, { label: "Email", role: "combobox", expanded: false }),
      field(2, { label: "Email", role: "searchbox" }),
      field(3, { label: "Email", role: "spinbutton" }),
      field(4, { label: "Email", expanded: false }),
      { index: 5, tag: "select", label: "Email", ops: ["SELECT"], options: ["a"] },
      field(6, { label: "Email", ops: ["TYPE_TEXT"] }), // range-like: no CLICK op
      field(7, { label: "Date of birth" }),
      field(8, { label: "Quantity" }),
      field(9, { label: "Remember me", checked: false, inputType: "checkbox", ops: ["CLICK"] }),
      passwordField(10),
    ];
    expect(pickFromSnapshot({ elements: els })).toEqual({ password: 10 });
  });

  it("two-step page: a search box or number field is never the username", () => {
    const els = [field(0, { label: "Search" }), typedField(1, { label: "Account number" }), field(2, { label: "Coupon code" })];
    expect(pickFromSnapshot({ elements: els })).toEqual({});
  });

  it("only a field before the password counts as its username", () => {
    const els = [
      passwordField(0),
      typedField(1, { label: "Email" }),
    ];
    expect(pickFromSnapshot({ elements: els })).toEqual({ password: 0 });
  });
});

describe("fillLogin", () => {
  it("types username then password with the snapshot id and returns no secret", async () => {
    const { deps, performCalls } = setup(loginForm());
    const result = await fillLogin({}, deps);
    expect(result).toEqual({ ok: true, origin: "https://example.com", label: "main", filled: ["username", "password"], submitted: false });
    expect(performCalls).toEqual([
      { operation: "TYPE_TEXT", index: 1, text: USERNAME, snapshotId: "snap-1" },
      { operation: "TYPE_TEXT", index: 2, text: PASSWORD, snapshotId: "snap-1" },
    ]);
    noSecret(result);
  });

  it("submit presses Enter in the last filled field", async () => {
    const { deps, actCalls } = setup(loginForm());
    const result = await fillLogin({ submit: true }, deps);
    expect(result).toMatchObject({ ok: true, submitted: true });
    expect(actCalls).toEqual([{ action: "press", key: "Enter", index: 2, snapshotId: "snap-1" }]);
    noSecret(result);
  });

  it("a failed Enter still reports the fill, with submitted false", async () => {
    const { deps } = setup(loginForm(), undefined, { pressError: true });
    const result = await fillLogin({ submit: true }, deps);
    expect(result).toEqual({ ok: true, origin: "https://example.com", label: "main", filled: ["username", "password"], submitted: false });
  });

  it("two-step page fills only the username", async () => {
    const { deps, performCalls } = setup([typedField(0, { label: "Email" }), button(1, "Next")]);
    const result = await fillLogin({}, deps);
    expect(result).toMatchObject({ ok: true, filled: ["username"] });
    expect(performCalls).toHaveLength(1);
    noSecret(result);
  });

  it("no saved login for the host: fixed error, nothing typed, no snapshot", async () => {
    const { deps, controller } = setup(loginForm(), "https://other.com/login");
    const result = await fillLogin({}, deps);
    expect(result).toEqual({ ok: false, error: "No saved login for https://other.com. The user can add one in the Passwords window." });
    expect(controller.snapshot).not.toHaveBeenCalled();
    expect(controller.perform).not.toHaveBeenCalled();
  });

  it("a look-alike host, another scheme or another port never matches", async () => {
    for (const url of [
      "https://example.com.evil.test/",
      "https://accounts.example.com/",
      "https://evilexample.com/",
      "http://example.com/login",
      "https://example.com:8443/login",
    ]) {
      const { deps, controller } = setup(loginForm(), url);
      const result = await fillLogin({}, deps);
      expect(result.ok).toBe(false);
      expect(controller.perform).not.toHaveBeenCalled();
    }
  });

  it("rejects non-http(s) pages and a missing tab", async () => {
    for (const url of ["about:blank", "file:///etc/hosts", "chrome://settings", "not a url"]) {
      const { deps, controller } = setup(loginForm(), url);
      expect(await fillLogin({}, deps)).toEqual({ ok: false, error: "The current tab is not an http(s) page." });
      expect(controller.perform).not.toHaveBeenCalled();
    }
    const { deps } = setup(loginForm(), null);
    expect(await fillLogin({}, deps)).toEqual({ ok: false, error: "No browser tab is open." });
  });

  it("an unknown label lists the saved labels", async () => {
    const { deps } = setup(loginForm());
    const result = await fillLogin({ label: "ghost" }, deps);
    expect(result).toEqual({ ok: false, error: "No saved login with that label for https://example.com. Saved labels: main." });
  });

  it("invalid arguments are a fixed error", async () => {
    const { deps } = setup(loginForm());
    expect((await fillLogin({ submit: "yes" }, deps)).ok).toBe(false);
  });

  it("never passes controller errors through, and never leaks the password in them", async () => {
    const { deps } = setup(loginForm(), undefined, { performError: (n) => n === 2 });
    const result = await fillLogin({}, deps);
    expect(result).toEqual({ ok: false, error: "Could not type into the sign-in form. Nothing was submitted." });
    noSecret(result);
  });

  it("a snapshot error or an empty page gives fixed errors", async () => {
    const store = makeStore();
    store.add({ site: "example.com", username: USERNAME, password: PASSWORD });
    const base = { store, getUrl: () => "https://example.com/" };
    const broken: LoginController = {
      snapshot: async () => ({ error: `boom ${PASSWORD}` }),
      perform: vi.fn(),
      act: vi.fn(),
    };
    const r1 = await fillLogin({}, { ...base, controller: broken });
    expect(r1).toEqual({ ok: false, error: "Could not read the page." });
    noSecret(r1);

    const throwing: LoginController = { ...broken, snapshot: async () => { throw new Error(PASSWORD); } };
    const r2 = await fillLogin({}, { ...base, controller: throwing });
    expect(r2).toEqual({ ok: false, error: "Could not read the page." });
    noSecret(r2);

    const empty = makeController([button(0)]);
    expect(await fillLogin({}, { ...base, controller: empty.controller })).toEqual({
      ok: false,
      error: "No sign-in fields found on this page.",
    });
  });

  it("stops typing when the tab navigates to another origin mid-fill", async () => {
    const store = makeStore();
    store.add({ site: "example.com", username: USERNAME, password: PASSWORD });
    const c = makeController(loginForm());
    const urls = ["https://example.com/login", "https://example.com/login", "http://example.com/"];
    let i = 0;
    const result = await fillLogin(
      {},
      { controller: c.controller, store, getUrl: () => urls[Math.min(i++, urls.length - 1)] },
    );
    expect(result.ok).toBe(false);
    expect(c.performCalls.map((call) => call.text)).not.toContain(PASSWORD);
    noSecret(result);
  });

  it("re-checks the origin AFTER each perform: a navigation during the call stops the fill, no submit", async () => {
    const store = makeStore();
    store.add({ site: "example.com", username: USERNAME, password: PASSWORD });
    const c = makeController(loginForm());
    let navigated = false;
    // The page changes origin while the username is being typed.
    (c.controller.perform as ReturnType<typeof vi.fn>).mockImplementationOnce(async (args: Record<string, unknown>) => {
      c.performCalls.push(args);
      navigated = true;
      return { ok: true };
    });
    const result = await fillLogin(
      { submit: true },
      { controller: c.controller, store, getUrl: () => (navigated ? "https://evil.test/" : "https://example.com/login") },
    );
    expect(result).toEqual({ ok: false, error: "Could not type into the sign-in form. Nothing was submitted." });
    expect(c.performCalls).toHaveLength(1);
    expect(c.performCalls.map((call) => call.text)).not.toContain(PASSWORD);
    expect(c.actCalls).toEqual([]);
    noSecret(result);
  });

  it("marks the entry used on success only", async () => {
    const ok = setup(loginForm());
    const spy = vi.spyOn(ok.store, "markUsed");
    await fillLogin({}, ok.deps);
    expect(spy).toHaveBeenCalledTimes(1);

    const bad = setup(loginForm(), undefined, { performError: () => true });
    const badSpy = vi.spyOn(bad.store, "markUsed");
    await fillLogin({}, bad.deps);
    expect(badSpy).not.toHaveBeenCalled();
  });
});
