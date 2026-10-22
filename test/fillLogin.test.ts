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

function makeController(
  elements: El[],
  opts: { performError?: (call: number) => boolean; pressError?: boolean; clearAfter?: (call: number) => boolean; pageUrl?: string } = {},
) {
  const performCalls: Record<string, unknown>[] = [];
  const actCalls: Record<string, unknown>[] = [];
  // Like the real page: a field that was typed into reports a value from the
  // next snapshot on (`clearAfter` simulates the app wiping it again).
  const typed = new Set<number>();
  const controller: LoginController = {
    snapshot: vi.fn(async () => ({
      snapshotId: "snap-1",
      url: opts.pageUrl ?? "https://example.com/",
      elements: elements.map((e) =>
        typed.has(e.index as number) ? ("value" in e ? { ...e, value: "x" } : { ...e, hasValue: true }) : e,
      ),
    })),
    perform: vi.fn(async (args) => {
      performCalls.push(args);
      if (opts.clearAfter?.(performCalls.length)) typed.delete(args.index as number);
      else typed.add(args.index as number);
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
  const deps: FillLoginDeps = { controller: c.controller, store, getUrl: () => url, sleep: async () => {} };
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
  typedField(1, { label: "Email address", hasValue: true }),
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
    expect(result).toEqual({
      ok: true,
      origin: "https://example.com",
      label: "main",
      filled: ["username", "password"],
      submitted: false,
      url: "https://www.example.com/login",
    });
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
      url: "https://www.example.com/login",
      sessionEstablished: false,
      note: SESSION_NOT_ESTABLISHED_NOTE,
      stillOnSignInPage: true,
      retried: true,
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
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: filledForm() }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", elements: [button(0, "Log out")] }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: true });
      expect(s.actCalls).toHaveLength(1);
    });

    it("password field gone but the act reported no change (spinner hiding the form): not established, no click", async () => {
      const s = stuck();
      (s.controller.snapshot as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: loginForm() }))
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: filledForm() }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", elements: [button(0, "Loading")] }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, note: SESSION_NOT_ESTABLISHED_NOTE });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
    });

    it("two-step page (no password before submit): a missing password field is NOT proof", async () => {
      const s = stuck();
      (s.controller.snapshot as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: [typedField(0, { label: "Email" }), button(1, "Next")] }))
        .mockImplementationOnce(async () => ({ snapshotId: "snap-1", elements: [typedField(0, { label: "Email", hasValue: true }), button(1, "Next")] }))
        .mockImplementation(async () => ({ snapshotId: "snap-2", elements: [button(0, "Next")] }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, note: SESSION_NOT_ESTABLISHED_NOTE });
    });

    it("the act's own changed flag is not a reaction: the unchanged form is retried once", async () => {
      const s = stuck();
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: true, url: "https://example.com/login" };
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, note: SESSION_NOT_ESTABLISHED_NOTE, retried: true });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press", "click", "press"]);
    });

    it("password cleared with an unchanged fingerprint is a hydration reset: one retry that retypes both fields", async () => {
      const s = stuck();
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        snapshotId: "snap-2",
        url: "https://example.com/login",
        elements: loginForm(),
      }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, stillOnSignInPage: true, retried: true });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press", "click", "press"]);
      // The retry types the username AND the password again.
      expect(s.performCalls.slice(-2).map((c) => [c.index, c.text])).toEqual([
        [1, USERNAME],
        [2, PASSWORD],
      ]);
      noSecret(result);
    });

    it("the page cannot be read while waiting: no second submit", async () => {
      const s = stuck();
      let n = 0;
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (++n > 2) throw new Error("mid-navigation");
        return { snapshotId: "snap-2", url: "https://example.com/login", elements: filledForm() };
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, retried: false });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
    });

    it("the click is followed by a relabelled or disabled button: no retry", async () => {
      for (const changed of [{ label: "Signing in\u2026" }, { disabled: true }]) {
        const s = stuck();
        let n = 0;
        // 1 first read, 2 check, 3 re-read after the retype, 4..16 settle after Enter: unchanged; then the button reacts.
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
          snapshotId: "snap-2",
          url: "https://example.com/login",
          elements: ++n <= 16 ? filledForm() : [...filledForm().slice(0, 3), { ...button(3), ...changed }],
        }));
        const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
        expect(s.actCalls.map((c) => c.action)).toEqual(["press", "click"]);
        expect(result).toMatchObject({ sessionEstablished: false, retried: false });
      }
    });

    it("new visible page text (an error message) is a reaction: no retry", async () => {
      const s = stuck();
      let n = 0;
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        snapshotId: "snap-2",
        url: "https://example.com/login",
        elements: filledForm(),
        text: ++n <= 3 ? "Sign in" : "Sign in\nInvalid email or password",
      }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, retried: false });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
    });

    it("a new interactive element is a reaction: no retry", async () => {
      const s = stuck();
      let n = 0;
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        snapshotId: "snap-2",
        url: "https://example.com/login",
        elements: ++n <= 3 ? filledForm() : [...filledForm(), button(4, "Resend code")],
      }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ retried: false });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
    });

    it("fallback click with no reaction: one retry (press, click, press), never a third submit", async () => {
      const s = stuck();
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: a.action === "click", url: "https://example.com/login" };
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press", "click", "press"]);
      expect(result).toMatchObject({ sessionEstablished: false, stillOnSignInPage: true, retried: true });
    });

    it("a pending navigation (isLoading) counts as an effect: no fallback click", async () => {
      const s = stuck();
      let polls = 0;
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep, isLoading: () => ++polls === 5 });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
      expect(result).toMatchObject({ sessionEstablished: false, retried: false });
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
        url: "https://example.com/login",
        sessionEstablished: false,
        note: SESSION_NOT_ESTABLISHED_NOTE,
        stillOnSignInPage: true,
        retried: true,
      });
      // Enter, the fallback click, one retry (Enter): never a third submit.
      expect(s.actCalls.map((c) => c.action)).toEqual(["press", "click", "press"]);
      noSecret(result);
    });

    it("submit false: no verification, no extra fields", async () => {
      const s = stuck();
      const result = await fillLogin({ submit: false }, { ...s.deps, sleep });
      expect(result).toEqual({
        ok: true,
        origin: "https://example.com",
        label: "main",
        filled: ["username", "password"],
        submitted: false,
        url: "https://example.com/login",
      });
      expect(s.actCalls).toEqual([]);
      // The first read, the check that the typed fields still hold their text, and the re-read after a retype.
      expect(s.controller.snapshot).toHaveBeenCalledTimes(3);
    });
  });

  describe("late hydration", () => {
    const sleep = async () => {};
    /** A page that never leaves the sign-in form: Enter and the snapshot see no change. */
    const stuckPage = (opts: Parameters<typeof makeController>[1] = {}) => {
      // No submit button: there is no fallback click, so the retry is possible.
      const s = setup(loginForm().slice(0, 3), "https://example.com/login", { ...opts, pageUrl: "https://example.com/login" });
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: false, url: "https://example.com/login" };
      });
      return s;
    };

    it("does not wait before the first snapshot", async () => {
      const { deps, controller } = setup(loginForm());
      const waits: number[] = [];
      let before = -1;
      (controller.snapshot as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        before = waits.length;
        return { snapshotId: "snap-1", elements: loginForm() };
      });
      await fillLogin({}, { ...deps, sleep: async (ms) => void waits.push(ms) });
      expect(before).toBe(0);
    });

    it("a field cleared after typing is typed again once", async () => {
      // The first TYPE_TEXT of the password is wiped (the app hydrated and reset the form).
      const { deps, performCalls } = setup(loginForm(), undefined, { clearAfter: (call) => call === 2 });
      const result = await fillLogin({}, { ...deps, sleep });
      expect(result).toMatchObject({ ok: true, filled: ["username", "password"], submitted: false });
      expect(performCalls.map((c) => [c.index, c.text])).toEqual([
        [1, USERNAME],
        [2, PASSWORD],
        [2, PASSWORD],
      ]);
      noSecret(result);
    });

    it("a field cleared twice is not typed a third time", async () => {
      const { deps, performCalls } = setup(loginForm(), undefined, { clearAfter: (call) => call >= 2 });
      const result = await fillLogin({}, { ...deps, sleep });
      expect(result.ok).toBe(true);
      expect(performCalls).toHaveLength(3);
    });

    it("still on the sign-in page after Enter: one retry, then stillOnSignInPage", async () => {
      const s = stuckPage();
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      // The default fake page never leaves the form: Enter changed nothing.
      expect(result).toMatchObject({ ok: true, sessionEstablished: false, stillOnSignInPage: true, retried: true });
      expect(s.actCalls.filter((c) => c.action === "press")).toHaveLength(2);
      // username + password, then both again for the retry
      expect(s.performCalls).toHaveLength(4);
      noSecret(result);
    });

    it("the retry succeeds: established, retried, not on the sign-in page", async () => {
      const s = stuckPage();
      let url = "https://example.com/login";
      const deps = { ...s.deps, getUrl: () => url, sleep };
      let presses = 0;
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        if (a.action === "press" && ++presses === 2) url = "https://example.com/dashboard?welcome=1#x";
        return { ok: true, changed: false, url };
      });
      const result = await fillLogin({ submit: true }, deps);
      expect(result).toMatchObject({
        sessionEstablished: true,
        stillOnSignInPage: false,
        retried: true,
        url: "https://example.com/dashboard",
      });
      expect(result).not.toHaveProperty("note");
      noSecret(result);
    });

    it("a pending navigation (isLoading) blocks the retry", async () => {
      const s = stuckPage();
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep, isLoading: () => true });
      expect(result).toMatchObject({ sessionEstablished: false, retried: false });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
      expect(s.performCalls).toHaveLength(2);
    });

    it("a form without a password field (two-step) is never retried", async () => {
      const s = setup([typedField(0, { label: "Email address" })], "https://example.com/login", { pageUrl: "https://example.com/login" });
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: false, url: "https://example.com/login" };
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ filled: ["username"], submitted: true, sessionEstablished: false, retried: false });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press"]);
      expect(s.performCalls).toHaveLength(1);
    });

    it("a password cleared during the settle window with an unchanged fingerprint: retry", async () => {
      const s = stuckPage();
      let n = 0;
      // 1 first read, 2 check after typing; from the 3rd read on the app has wiped the password.
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        snapshotId: "snap-2",
        url: "https://example.com/login",
        elements: ++n <= 2 ? filledForm().slice(0, 3) : loginForm().slice(0, 3),
      }));
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, retried: true });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press", "press"]);
    });

    it("Enter navigates: no retry", async () => {
      const s = setup(loginForm(), "https://example.com/login");
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      // setup()'s act answers with a different URL
      expect(result).toMatchObject({ sessionEstablished: true, stillOnSignInPage: false, retried: false });
      expect(s.performCalls).toHaveLength(2);
    });

    it("Enter reported a change but the form is identical: one retry", async () => {
      const s = stuckPage();
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: true, url: "https://example.com/login" };
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ sessionEstablished: false, stillOnSignInPage: true, retried: true });
      expect(s.actCalls.map((c) => c.action)).toEqual(["press", "press"]);
    });

    it("the reported url never carries a query or a hash", async () => {
      const s = setup(loginForm(), "https://example.com/login?password=" + PASSWORD + "#frag");
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ ok: true, url: "https://example.com/login" });
      noSecret(result);
      const plain = await fillLogin({}, { ...s.deps, sleep });
      expect(plain).toMatchObject({ url: "https://example.com/login" });
      noSecret(plain);
    });

    it("the tab landing on another origin before the retry: no retry, nothing typed there", async () => {
      // No submit button, so there is no fallback click. Snapshot calls: 1 first read, 2 check after typing,
      // 3..15 the settle polls after Enter. The tab lands on another origin with the last poll.
      const form = [typedField(0, { label: "Email address" }), passwordField(1)];
      const s = setup(form, "https://example.com/login", { pageUrl: "https://example.com/login" });
      let url = "https://example.com/login";
      let snapshots = 0;
      const deps = { ...s.deps, getUrl: () => url, sleep };
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: false, url: "https://example.com/login" };
      });
      const typed = (s.controller.snapshot as ReturnType<typeof vi.fn>).getMockImplementation() as () => Promise<Record<string, unknown>>;
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (++snapshots === 15) url = "https://evil.test/login";
        return typed();
      });
      const result = await fillLogin({ submit: true }, deps);
      expect(s.actCalls).toHaveLength(1);
      expect(s.performCalls).toHaveLength(2);
      // The URL moved on with the last poll: that is a navigation (settle), so no retry.
      expect(result).toMatchObject({ ok: true, submitted: true, retried: false, url: "https://evil.test/login" });
      expect(result).toHaveProperty("stillOnSignInPage", false);
      noSecret(result);
    });

    it("a retry that cannot type reports the first submit, with no secret, and marks the entry used", async () => {
      const s = stuckPage({ performError: (call) => call > 2 });
      const spy = vi.spyOn(s.store, "markUsed");
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ ok: true, submitted: true, retried: true, sessionEstablished: false, stillOnSignInPage: true });
      expect(s.actCalls.filter((c) => c.action === "press")).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      noSecret(result);
    });

    describe("password revealed inline, query changes, baseline, throwing deps", () => {
      const revealForm = (): El[] => [typedField(0, { label: "Email address" }), button(1, "Next")];
      const revealed = (): El[] => [typedField(0, { label: "Email address", hasValue: true }), passwordField(1), button(2)];
      const twoReads = (s: ReturnType<typeof setup>, first: El[], rest: El[]) => {
        let n = 0;
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
          snapshotId: `snap-${++n}`,
          url: "https://example.com/login",
          elements: n === 1 ? first : rest,
        }));
      };

      it("a password field that appears after typing is typed once before Enter", async () => {
        const s = stuckPage();
        twoReads(s, revealForm(), revealed());
        const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
        expect(result).toMatchObject({ ok: true, filled: ["username", "password"], submitted: true });
        // (The fake email field always reads empty, so the username is typed again too.)
        expect(s.performCalls.map((c) => [c.index, c.text])).toContainEqual([1, PASSWORD]);
        expect(s.performCalls.map((c) => [c.index, c.text])).toContainEqual([0, USERNAME]);
        expect(s.actCalls[0]).toMatchObject({ action: "press", key: "Enter", index: 1 });
        noSecret(result);
      });

      it("typing that revealed password fails: Enter is not pressed", async () => {
        const s = stuckPage({ performError: (call) => call === 2 });
        twoReads(s, revealForm(), revealed());
        const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
        expect(result).toEqual({ ok: false, error: "Could not type into the sign-in form. Nothing was submitted." });
        expect(s.actCalls).toEqual([]);
      });

      it("a query change on the same path is neither a navigation nor a success", async () => {
        const s = stuckPage();
        const url = "https://example.com/login?error=1";
        (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
          s.actCalls.push(a);
          return { ok: true, changed: false, url };
        });
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
          snapshotId: "snap-1",
          url,
          elements: filledForm().slice(0, 3),
        }));
        const result = await fillLogin({ submit: true }, { ...s.deps, getUrl: () => url, sleep });
        expect(result).toMatchObject({ sessionEstablished: false, stillOnSignInPage: true, retried: true, url: "https://example.com/login" });
      });

      it("the retype itself is not a reaction: the baseline is the re-read after it", async () => {
        const s = setup(loginForm(), "https://example.com/login");
        (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
          s.actCalls.push(a);
          return { ok: true, url: "https://example.com/login" };
        });
        let n = 0;
        // 1 first read, 2 check (the fake email field always reads empty: it is typed again), 3 re-read after the retype
        // already shows an extra element; it stays the same from then on.
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
          snapshotId: "snap-2",
          url: "https://example.com/login",
          elements: ++n <= 2 ? filledForm() : [...filledForm(), button(4, "Hint")],
        }));
        const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
        expect(s.actCalls.map((c) => c.action)).toEqual(["press", "click", "press"]);
        expect(result).toMatchObject({ retried: true });
      });

      it("a throwing getUrl or isLoading never breaks the fixed results", async () => {
        const s = stuckPage();
        let calls = 0;
        const result = await fillLogin(
          { submit: true },
          {
            ...s.deps,
            sleep,
            getUrl: () => {
              if (++calls > 3) throw new Error("destroyed");
              return "https://example.com/login";
            },
            isLoading: () => {
              throw new Error("destroyed");
            },
          },
        );
        // A tab that vanishes mid-fill ends in a fixed result, never in a throw.
        expect(typeof result.ok).toBe("boolean");
        noSecret(result);
        const loadingOnly = stuckPage();
        const ok = await fillLogin(
          { submit: true },
          {
            ...loadingOnly.deps,
            sleep,
            isLoading: () => {
              throw new Error("destroyed");
            },
          },
        );
        expect(ok).toMatchObject({ ok: true, retried: true });
      });
    });

    describe("stale indices", () => {
      const sleepNoop = async () => {};
      // Both fields hold text (nothing to retype), at other indices than in snapshot 1.
      const shifted = (): El[] => [typedField(5, { label: "Email address", hasValue: true }), passwordField(6, { hasValue: true }), button(7)];

      it("a picked field is missing after typing: a fresh snapshot is picked and its id and indices are used together", async () => {
        const s = stuckPage();
        let n = 0;
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          n++;
          if (n === 1) return { snapshotId: "snap-1", url: "https://example.com/login", elements: loginForm() };
          if (n === 2) return { snapshotId: "snap-2", url: "https://example.com/login", elements: [button(0, "Loading")] };
          return {
            snapshotId: "snap-3",
            url: "https://example.com/login",
            elements: shifted(),
          };
        });
        await fillLogin({ submit: true }, { ...s.deps, sleep: sleepNoop });
        expect(s.actCalls[0]).toEqual({ action: "press", key: "Enter", index: 6, snapshotId: "snap-3" });
      });

      it("the re-read after typing fails: one fresh snapshot is taken and used", async () => {
        const s = stuckPage();
        let n = 0;
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          n++;
          if (n === 2) throw new Error("mid-navigation");
          return { snapshotId: `snap-${n}`, url: "https://example.com/login", elements: n === 1 ? loginForm() : shifted() };
        });
        await fillLogin({ submit: true }, { ...s.deps, sleep: sleepNoop });
        expect(s.actCalls[0]).toMatchObject({ action: "press", key: "Enter", index: 6 });
      });

      it("the re-read fails twice: Enter is not pressed, ok with submitted false", async () => {
        const s = stuckPage();
        let n = 0;
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          if (++n >= 2) throw new Error("gone");
          return { snapshotId: "snap-1", url: "https://example.com/login", elements: loginForm() };
        });
        const result = await fillLogin({ submit: true }, { ...s.deps, sleep: sleepNoop });
        expect(s.actCalls).toEqual([]);
        expect(result).toMatchObject({ ok: true, submitted: false });
        expect(result).not.toHaveProperty("sessionEstablished");
        noSecret(result);
      });

      it("still missing after the second look: Enter is not pressed, ok with submitted false", async () => {
        const s = stuckPage();
        let n = 0;
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          n++;
          return n === 1
            ? { snapshotId: "snap-1", url: "https://example.com/login", elements: loginForm() }
            : { snapshotId: `snap-${n}`, url: "https://example.com/login", elements: [button(0, "Loading")] };
        });
        const result = await fillLogin({ submit: true }, { ...s.deps, sleep: sleepNoop });
        expect(s.actCalls).toEqual([]);
        expect(result).toMatchObject({ ok: true, submitted: false });
        expect(result).not.toHaveProperty("sessionEstablished");
        expect(result).not.toHaveProperty("stillOnSignInPage");
        noSecret(result);
      });
    });

    describe("reported url", () => {
      const withUsername = (username: string, site = "example.com") => {
        const store = makeStore();
        store.add({ site, username, password: PASSWORD, label: "main" });
        return store;
      };
      const run = async (username: string, url: string, site?: string) => {
        const c = makeController(loginForm());
        const result = await fillLogin({}, { controller: c.controller, store: withUsername(username, site), getUrl: () => url, sleep });
        return result.ok ? result.url : undefined;
      };

      it("redacts the username, case-insensitively and URL-encoded, from the path", async () => {
        expect(await run(USERNAME, "https://example.com/u/Alice%40Corp.test/dashboard")).toBe("https://example.com/u/\u2026/dashboard");
        expect(await run(USERNAME, "https://example.com/u/ALICE/dashboard")).toBe("https://example.com/u/\u2026/dashboard");
        expect(await run(USERNAME, "https://example.com/u/alice@corp.test/x")).toBe("https://example.com/u/\u2026/x");
        expect(await run("jdoe", "https://example.com/u/J%64oe/home")).toBe("https://example.com/u/\u2026/home");
      });

      it("redacts the username from host labels too", async () => {
        expect(await run("jdoe", "https://jdoe.example-app.com/home", "jdoe.example-app.com")).toBe("https://\u2026.example-app.com/home");
        expect(await run(USERNAME, "https://Alice.example-app.com:8443/x", "https://alice.example-app.com:8443")).toBe("https://\u2026.example-app.com:8443/x");
        expect(await run("jdoe", "https://tenant.example-app.com/home", "tenant.example-app.com")).toBe("https://tenant.example-app.com/home");
      });

      it("keeps a decoded ? or # encoded in the redacted path", async () => {
        expect(await run("jdoe", "https://example.com/J%64oe%3Fx/y")).toBe("https://example.com/\u2026%3Fx/y");
        expect(await run("jdoe", "https://example.com/a/jdoe%23frag")).toBe("https://example.com/a/\u2026%23frag");
        const out = (await run("jdoe", "https://example.com/jdoe%3Fq%3D1%23h")) ?? "";
        expect(out).not.toMatch(/[?#]/);
      });

      it("catches a double-encoded username", async () => {
        expect(await run(USERNAME, "https://example.com/u/alice%2540corp.test/home")).toBe("https://example.com/u/\u2026/home");
        expect(await run("jdoe", "https://example.com/u/j%2564oe")).toBe("https://example.com/u/\u2026");
      });

      it("keeps a local part shorter than 3 characters", async () => {
        expect(await run("ab@corp.test", "https://example.com/ab/home")).toBe("https://example.com/ab/home");
        expect(await run("ab@corp.test", "https://example.com/u/ab%40corp.test")).toBe("https://example.com/u/\u2026");
      });

      it("omits the url when the tab is not on an http(s) page", async () => {
        const s = setup(loginForm(), "https://example.com/login");
        let blank = false;
        const real = (s.controller.snapshot as ReturnType<typeof vi.fn>).getMockImplementation() as () => Promise<Record<string, unknown>>;
        let n = 0;
        (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          if (++n === 2) blank = true; // the check after typing: no more typing follows
          return real();
        });
        const result = await fillLogin({}, { ...s.deps, getUrl: () => (blank ? "about:blank" : "https://example.com/login"), sleep });
        expect(result).toMatchObject({ ok: true });
        expect(result).not.toHaveProperty("url");
      });
    });

    it("stillOnSignInPage is omitted when the final page cannot be read", async () => {
      const s = stuckPage();
      (s.controller.act as ReturnType<typeof vi.fn>).mockImplementation(async (a: Record<string, unknown>) => {
        s.actCalls.push(a);
        return { ok: true, changed: true, url: "https://example.com/login" };
      });
      const real = (s.controller.snapshot as ReturnType<typeof vi.fn>).getMockImplementation() as () => Promise<Record<string, unknown>>;
      let n = 0;
      // 1 first read, 2 check, 3..15 settle: the last poll is the final look.
      (s.controller.snapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (++n === 15) throw new Error("gone");
        return real();
      });
      const result = await fillLogin({ submit: true }, { ...s.deps, sleep });
      expect(result).toMatchObject({ ok: true, sessionEstablished: false, retried: false });
      expect(result).not.toHaveProperty("stillOnSignInPage");
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
