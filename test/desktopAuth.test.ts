import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SIGN_IN_TTL_MS,
  activeTabChanged,
  shouldRegisterProtocol,
  challengeFor,
  createDesktopAuth,
  isAuthSignInSender,
  parseDeepLinkArg,
  pickAuthReceiver,
  resolveProtocolRegistration,
  type AuthTokenPayload,
} from "../src/main/desktopAuth";

const ORIGIN = "https://app.sideform.pro";

function setup() {
  let clock = 1_000_000;
  let counter = 0;
  const opened: string[] = [];
  const logs: string[] = [];
  const delivered: AuthTokenPayload[] = [];
  const auth = createDesktopAuth({
    editorOrigin: ORIGIN,
    now: () => clock,
    // Distinct, deterministic 32-byte values per call.
    randomBytes: (n) => new Uint8Array(n).fill(++counter),
    openExternal: (u) => void opened.push(u),
    log: (m) => void logs.push(m),
  });
  auth.setReceiver((p) => (delivered.push(p), true));
  const params = () => new URL(opened.at(-1)!).searchParams;
  return { auth, opened, logs, delivered, params, advance: (ms: number) => void (clock += ms) };
}

describe("beginSignIn", () => {
  it("opens <origin>/auth/desktop with a 43-char state and the S256 challenge of a 43-char verifier", () => {
    const { auth, opened, params, logs } = setup();
    auth.beginSignIn();
    const url = new URL(opened[0]);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/auth/desktop`);
    expect(params().get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params().get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // verifier is the second random block (all 2s): challenge must be its S256.
    const verifier = Buffer.alloc(32, 2).toString("base64url");
    expect(verifier).toHaveLength(43);
    expect(params().get("challenge")).toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
    expect(params().get("state")).toBe(Buffer.alloc(32, 1).toString("base64url"));
    expect(logs.join("\n")).not.toContain(params().get("state")!);
  });

  it("challengeFor matches the RFC 7636 example", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("uses the editor origin it was given (a PEN_DESKTOP_URL dev origin)", () => {
    const opened: string[] = [];
    const a = createDesktopAuth({ editorOrigin: "http://localhost:5173", now: () => 0, randomBytes: (n) => new Uint8Array(n), openExternal: (u) => void opened.push(u), log: () => {} });
    a.beginSignIn();
    expect(opened[0].startsWith("http://localhost:5173/auth/desktop?")).toBe(true);
  });
});

describe("handleDeepLink", () => {
  const link = (state: string, token = "TOK") => `sideform://auth?token=${token}&state=${state}`;

  it("delivers {token, verifier} to the receiver for a matching state", () => {
    const { auth, params, delivered } = setup();
    auth.beginSignIn();
    const state = params().get("state")!;
    expect(auth.handleDeepLink(link(state))).toBe(true);
    expect(delivered).toEqual([{ token: "TOK", verifier: Buffer.alloc(32, 2).toString("base64url") }]);
  });

  it("keeps the attempt after delivery so the link can be replayed until it expires", () => {
    const { auth, params, delivered, advance } = setup();
    auth.beginSignIn();
    const state = params().get("state")!;
    expect(auth.handleDeepLink(link(state))).toBe(true);
    expect(auth.handleDeepLink(link(state, "TOK2"))).toBe(true);
    expect(delivered.map((d) => d.token)).toEqual(["TOK", "TOK2"]);
    advance(SIGN_IN_TTL_MS + 1);
    expect(auth.handleDeepLink(link(state))).toBe(false);
    expect(delivered).toHaveLength(2);
  });

  it("a wrong state after delivery still does nothing", () => {
    const { auth, params, delivered } = setup();
    auth.beginSignIn();
    const state = params().get("state")!;
    expect(auth.handleDeepLink(link(state))).toBe(true);
    expect(auth.handleDeepLink(link("y".repeat(43)))).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it("a new beginSignIn replaces the attempt, so the old state no longer works", () => {
    const { auth, params, delivered } = setup();
    auth.beginSignIn();
    const old = params().get("state")!;
    auth.beginSignIn();
    expect(auth.handleDeepLink(link(old))).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  it("ignores a link without a pending sign-in", () => {
    const { auth, delivered } = setup();
    expect(auth.handleDeepLink(link("x".repeat(43)))).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  it("a wrong state is ignored and does not cancel the real attempt", () => {
    const { auth, params, delivered } = setup();
    auth.beginSignIn();
    expect(auth.handleDeepLink(link("y".repeat(43)))).toBe(false);
    expect(auth.handleDeepLink(link(params().get("state")!))).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it("only the latest attempt is valid", () => {
    const { auth, opened, delivered } = setup();
    auth.beginSignIn();
    const first = new URL(opened[0]).searchParams.get("state")!;
    auth.beginSignIn();
    const second = new URL(opened[1]).searchParams.get("state")!;
    expect(auth.handleDeepLink(link(first))).toBe(false);
    expect(auth.handleDeepLink(link(second))).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it("expires after 10 minutes", () => {
    const { auth, params, advance, delivered } = setup();
    auth.beginSignIn();
    advance(SIGN_IN_TTL_MS + 1);
    expect(auth.handleDeepLink(link(params().get("state")!))).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  it("accepts a link just inside the TTL", () => {
    const { auth, params, advance } = setup();
    auth.beginSignIn();
    advance(SIGN_IN_TTL_MS - 1);
    expect(auth.handleDeepLink(link(params().get("state")!))).toBe(true);
  });

  it.each([
    ["wrong scheme", "https://auth?token=T&state=S"],
    ["wrong host", "sideform://evil?token=T&state=S"],
    ["no token", "sideform://auth?state=S"],
    ["no state", "sideform://auth?token=T"],
    ["garbage", "not a url"],
  ])("ignores %s and never logs the token", (_name, raw) => {
    const { auth, logs, delivered } = setup();
    auth.beginSignIn();
    expect(auth.handleDeepLink(raw)).toBe(false);
    expect(delivered).toHaveLength(0);
    expect(logs.join("\n")).not.toContain("token=T");
  });

  it("logs never contain the token, even when delivery fails", () => {
    const { auth, params, logs } = setup();
    auth.setReceiver(() => false);
    auth.beginSignIn();
    expect(auth.handleDeepLink(link(params().get("state")!, "SECRET-TOKEN"))).toBe(true); // held
    expect(logs.join("\n")).not.toContain("SECRET-TOKEN");
  });

  it("holds the token when no view listens and delivers it on notifyListening", () => {
    const { auth, params } = setup();
    let listening = false;
    const got = vi.fn(() => listening);
    auth.setReceiver(got);
    auth.beginSignIn();
    const state = params().get("state")!;
    expect(auth.handleDeepLink(link(state, "HELD"))).toBe(true);
    auth.notifyListening(); // still nobody
    expect(got).toHaveBeenCalledTimes(2);
    listening = true;
    auth.notifyListening();
    expect(got).toHaveBeenCalledTimes(3);
    expect(got).toHaveBeenLastCalledWith({ token: "HELD", verifier: Buffer.alloc(32, 2).toString("base64url") });
    auth.notifyListening(); // consumed: not delivered twice
    expect(got).toHaveBeenCalledTimes(3);
  });

  it("holds the token with no receiver at all (window closed) until a receiver and a listener exist", () => {
    const { auth, params } = setup();
    auth.setReceiver(null);
    auth.beginSignIn();
    expect(auth.handleDeepLink(link(params().get("state")!, "LATE"))).toBe(true);
    const got = vi.fn(() => true);
    auth.setReceiver(got);
    auth.notifyListening();
    expect(got).toHaveBeenCalledWith(expect.objectContaining({ token: "LATE" }));
  });

  it("a held token expires with its attempt and is dropped by a new attempt", () => {
    const { auth, params, advance } = setup();
    let listening = false;
    const got = vi.fn(() => listening);
    auth.setReceiver(got);
    auth.beginSignIn();
    auth.handleDeepLink(link(params().get("state")!, "OLD"));
    advance(SIGN_IN_TTL_MS + 1);
    listening = true;
    auth.notifyListening();
    expect(got).toHaveBeenCalledTimes(1); // only the failed first try
    auth.beginSignIn();
    listening = false;
    auth.handleDeepLink(link(params().get("state")!, "A"));
    auth.beginSignIn(); // newer attempt drops the held token
    listening = true;
    auth.notifyListening();
    expect(got).toHaveBeenCalledTimes(2);
  });

  it("clearReceiver only clears the receiver it was given", () => {
    const { auth, params } = setup();
    const mine = () => true;
    auth.setReceiver(mine);
    auth.clearReceiver(() => true); // a stale window's receiver
    auth.beginSignIn();
    expect(auth.handleDeepLink(link(params().get("state")!))).toBe(true);
    auth.clearReceiver(mine);
    auth.beginSignIn();
    expect(auth.handleDeepLink(link(params().get("state")!))).toBe(true); // receiver gone: held, not lost
  });
});

describe("wouldAccept and a late receiver", () => {
  it("accepts only a well-formed link whose state matches an unexpired attempt, without side effects", () => {
    const { auth, params, logs, advance } = setup();
    expect(auth.wouldAccept("sideform://auth?token=t&state=s")).toBe(false); // no attempt
    auth.beginSignIn();
    const state = params().get("state")!;
    expect(auth.wouldAccept(`sideform://auth?token=t&state=${state}`)).toBe(true);
    expect(auth.wouldAccept("sideform://auth?token=t&state=wrong")).toBe(false);
    expect(auth.wouldAccept(`sideform://other?token=t&state=${state}`)).toBe(false);
    expect(auth.wouldAccept(`sideform://auth?state=${state}`)).toBe(false);
    expect(auth.wouldAccept("not a url")).toBe(false);
    expect(logs).toEqual([]);
    expect(auth.wouldAccept(`sideform://auth?token=t&state=${state}`)).toBe(true); // wrong state did not cancel it
    advance(SIGN_IN_TTL_MS + 1);
    expect(auth.wouldAccept(`sideform://auth?token=t&state=${state}`)).toBe(false);
  });

  it("a held token stays held while the receiver refuses and goes out on the first retry that works", () => {
    const { auth, params } = setup();
    let ok = false;
    const got: AuthTokenPayload[] = [];
    auth.setReceiver((p) => (ok ? (got.push(p), true) : false));
    auth.beginSignIn();
    expect(auth.handleDeepLink(`sideform://auth?token=t&state=${params().get("state")}`)).toBe(true);
    auth.notifyListening(); // e.g. a tab switch, still no eligible view
    expect(got).toEqual([]);
    ok = true;
    auth.notifyListening(); // the active tab changed to a listening one
    expect(got).toHaveLength(1);
    auth.notifyListening();
    expect(got).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("parseDeepLinkArg finds the sideform:// argument", () => {
    expect(parseDeepLinkArg(["/app", "--flag", "sideform://auth?token=a&state=b"])).toBe("sideform://auth?token=a&state=b");
    expect(parseDeepLinkArg(["/app", "https://x"])).toBeUndefined();
  });

  it("dev registration passes the Electron binary and the resolved app path; a packaged build passes nothing", () => {
    const r = (p: string) => `/abs/${p}`;
    expect(resolveProtocolRegistration(true, "/e/electron", ".", r).args).toEqual(["/e/electron", ["/abs/."]]);
    expect(resolveProtocolRegistration(undefined, "/e/app", undefined, r).args).toBeNull();
    expect(resolveProtocolRegistration(true, "/e/electron", undefined, r).args).toBeNull();
  });

  it("isAuthSignInSender: editor tab or panel, top frame, editor origin", () => {
    const base = { senderId: 5, panelId: 9, isEditorTab: true, isMainFrame: true, frameUrl: `${ORIGIN}/app?chat=off`, editorOrigin: ORIGIN };
    expect(isAuthSignInSender(base)).toBe(true);
    expect(isAuthSignInSender({ ...base, isEditorTab: false, senderId: 9 })).toBe(true);
    expect(isAuthSignInSender({ ...base, isEditorTab: false })).toBe(false); // some other view
    expect(isAuthSignInSender({ ...base, isMainFrame: false })).toBe(false);
    expect(isAuthSignInSender({ ...base, frameUrl: "https://evil.example/app" })).toBe(false);
    expect(isAuthSignInSender({ ...base, frameUrl: undefined })).toBe(false);
    expect(isAuthSignInSender({ ...base, isEditorTab: false, panelId: null })).toBe(false);
  });

  it("dev registration needs PEN_DESKTOP_REGISTER_PROTOCOL=1, a packaged build always registers", () => {
    expect(shouldRegisterProtocol(undefined, {})).toBe(true);
    expect(shouldRegisterProtocol(false, {})).toBe(true);
    expect(shouldRegisterProtocol(true, {})).toBe(false);
    expect(shouldRegisterProtocol(true, { PEN_DESKTOP_REGISTER_PROTOCOL: "0" })).toBe(false);
    expect(shouldRegisterProtocol(true, { PEN_DESKTOP_REGISTER_PROTOCOL: "1" })).toBe(true);
  });

  it("activeTabChanged: a new active tab or kind may unblock a held token", () => {
    const a = { activeId: "t1", activeKind: "editor" };
    expect(activeTabChanged(null, a)).toBe(true);
    expect(activeTabChanged(a, { ...a })).toBe(false);
    expect(activeTabChanged(a, { ...a, activeId: "t2" })).toBe(true);
    expect(activeTabChanged(a, { ...a, activeKind: "browser" })).toBe(true);
  });

  it("pickAuthReceiver prefers the panel, then the active canvas tab", () => {
    expect(pickAuthReceiver({ panel: "p", activeEditorTab: "t" })).toBe("p");
    expect(pickAuthReceiver({ panel: null, activeEditorTab: "t" })).toBe("t");
    expect(pickAuthReceiver({ panel: null, activeEditorTab: null })).toBeNull();
    expect(pickAuthReceiver({ panel: null, activeEditorTab: null, otherEditorTab: "o" })).toBe("o");
    expect(pickAuthReceiver({ panel: null, activeEditorTab: "t", otherEditorTab: "o" })).toBe("t");
  });
});
