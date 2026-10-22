import { describe, expect, it, vi } from "vitest";
import {
  fillLogin,
  parseFillLoginArgs,
  pickFromSnapshot,
  pickSubmitButton,
  type FillLoginDeps,
  type LoginController,
  SESSION_NOT_ESTABLISHED_NOTE,
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

/** The form as a fresh snapshot shows it after a no-op submit: the password still holds its value. */
const filledForm = (): El[] => [
  field(0, { label: "Search" }),
  typedField(1, { label: "Email address" }),
  passwordField(2, { hasValue: true }),
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

describe("pickSubmitButton", () => {
  const el = (index: number, extra: Record<string, unknown> = {}) =>
    pickSubmitButton(
      ([passwordField(0), { index, tag: "button", label: "Sign in", ops: ["CLICK"], ...extra }] as El[]).map((e) => ({
        index: e.index as number,
        tag: String(e.tag),
        label: String(e.label),
        role: typeof e.role === "string" ? e.role : "",
        ops: e.ops as string[],
        isPassword: e.isPassword === true,
        hasValue: undefined,
        disabled: false,
        frame: false,
        widget: e.checked !== undefined || e.inputType !== undefined || e.expanded !== undefined,
      })),
    );
  it("picks a sign-in button", () => expect(el(1)).toBe(1));
  it("never picks a checkbox, radio or switch", () => {
    expect(el(1, { label: "Keep me signed in", checked: false, inputType: "checkbox" })).toBeNull();
    expect(el(1, { label: "Sign in automatically", role: "switch" })).toBeNull();
    expect(el(1, { label: "Log in as admin", role: "radio" })).toBeNull();
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
    expect(result).toMatchObject({ ok: true, submitted: true, sessionEstablished: true });
    expect(result).not.toHaveProperty("note");
    expect(actCalls).toEqual([{ action: "press", key: "Enter", index: 2, snapshotId: "snap-1" }]);
    noSecret(result);
  });

  it("a failed Enter still reports the fill, with submitted false", async () => {
    const { deps, controller } = setup(loginForm(), undefined, { pressError: true });
    (controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      snapshotId: "snap-1",
      url: "https://www.example.com/login",
      elements: filledForm(),
    }));
    const result = await fillLogin({ submit: true }, { ...deps, sleep: async () => {} });
    expect(result).toEqual({
      ok: true,
      origin: "https://example.com",
      label: "main",
      filled: ["username", "password"],
      submitted: false,
      sessionEstablished: false,
      note: SESSION_NOT_ESTABLISHED_NOTE,
    });
  });

  describe("submit verification", () => {
    const sleep = async () => {};
    const stuck = () => {
      const s = setup(loginForm(), "https://example.com/login");
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, url: "https://example.com/login" };
      });
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        snapshotId: "snap-2",
        url: "https://example.com/login",
        elements: filledForm(),
      }));
      return s;
    };

    it("Enter navigates: established, no click", async () => {
      const { deps, actCalls } = setup(loginForm());
      const result = await fillLogin({ submit: true }, { ...deps, sleep });
      expect(result).toMatchObject({ submitted: true, sessionEstablished: true });
      expect(actCalls).toHaveLength(1);
    });

    it("Enter does nothing but the fallback click navigates: established", async () => {
      const s = stuck();
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return a.action === "click" ? { ok: true, url: "https://example.com/home" } : { ok: true, url: "https://example.com/login" };
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ ok: true, submitted: true, sessionEstablished: true });
      expect(result).not.toHaveProperty("note");
      expect(s.actCalls[1]).toEqual({ action: "click", index: 3, snapshotId: "snap-2" });
      noSecret(result);
    });

    it("password field disappears and the act reported a change: established", async () => {
      const s = stuck();
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: true, url: "https://example.com/login" };
      });
      (s.controller.snapshot as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: loginForm() }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", elements: [button(0, "Log out")] }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: true });
      expect(s.actCalls).toHaveLength(1);
    });

    it("password field gone but the act reported no change (spinner hiding the form): not established, no click", async () => {
      const s = stuck();
      (s.controller.snapshot as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: loginForm() }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", elements: [button(0, "Loading")] }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, note: SESSION_NOT_ESTABLISHED_NOTE });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
    });

    it("two-step page (no password before submit): a missing password field is NOT proof", async () => {
      const s = stuck();
      (s.controller.snapshot as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: [typedField(0, { label: "Email" }), button(1, "Next")] }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", elements: [button(0, "Next")] }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, note: SESSION_NOT_ESTABLISHED_NOTE });
    });

    it("Enter changed the page but the form is still there (slow server): no second submit", async () => {
      const s = stuck();
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: true, url: "https://example.com/login" };
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, note: SESSION_NOT_ESTABLISHED_NOTE });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
    });

    it("the form was re-rendered with an empty password: no second submit", async () => {
      const s = stuck();
      (s.controller.snapshot as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: loginForm() }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", elements: loginForm() }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
    });

    it("waits the full window before the fallback", async () => {
      const s = stuck();
      let slept = 0;
      await fillLogin({ submit: true }, { ...s.deps, sleep: async (ms) => void (slept += ms) });
      expect(slept).toBeGreaterThanOrEqual(3000);
    });

    it("neither Enter nor the click helps: not established, fixed note", async () => {
      const s = stuck();
      (s.controller.snapshot as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: loginForm() }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", url: "https://example.com/login", elements: filledForm() }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toEqual({
        ok: true,
        origin: "https://example.com",
        label: "main",
        filled: ["username", "password"],
        submitted: true,
        sessionEstablished: false,
        note: SESSION_NOT_ESTABLISHED_NOTE,
      });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press", "click"]);
      noSecret(result);
    });

    it("submit false: no verification, no extra fields", async () => {
      const s = stuck();
      const result = await fillLogin({ submit: false }, { ...s.deps, sleep });
      expect(result).toEqual({ ok: true, origin: "https://example.com", label: "main", filled: ["username", "password"], submitted: false });
      expect(s.actCalls).toEqual([]);
      expect(s.controller.snapshot).toHaveBeenCalledTimes(1);
    });
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
