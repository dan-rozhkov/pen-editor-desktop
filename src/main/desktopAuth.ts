import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

/**
 * Desktop sign-in through the system browser (pen-editor-backend
 * docs/superpowers/specs/2026-10-20-desktop-sign-in-design.md, "Flow" and
 * "Contract"). Electron-free on purpose: the window-bound parts (which view
 * receives the token, focusing the window) are injected by window.ts through
 * `setReceiver`, so everything here is unit-tested with an injected clock,
 * random source and `openExternal`.
 *
 * PKCE: `sideform://` is not owned by us, so another local app can read the
 * `token` and `state` of a link. The `verifier` never leaves this process until
 * it is handed to our own view together with the token, so a stolen link is
 * useless on its own.
 */

export const DEEP_LINK_SCHEME = "sideform";
/** How long a started sign-in stays valid. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** Upper bound for a token read from a deep link (the real one is 43 chars). */
const MAX_TOKEN_LENGTH = 512;

export interface AuthTokenPayload {
  token: string;
  verifier: string;
}

export interface DesktopAuthDeps {
  /** Origin of the editor the sign-in page lives on (`new URL(editorUrl).origin`). */
  editorOrigin: string;
  now(): number;
  randomBytes(size: number): Uint8Array;
  openExternal(url: string): void | Promise<void>;
  /** Diagnostics only. Never receives a token, a verifier or a challenge. */
  log(message: string): void;
}

export interface DesktopAuth {
  beginSignIn(): void;
  /** True when the link was accepted: handed to a listening view, or HELD in main until one listens. */
  handleDeepLink(url: string): boolean;
  /** Pure check, no side effects, no log: a well-formed `sideform://auth?token=&state=` whose state
   * matches the pending, unexpired attempt. Callers use it to decide whether a link may open a window. */
  wouldAccept(url: string): boolean;
  /** A view started listening for the token (`auth:listen`): delivers a held, unexpired token. */
  notifyListening(): void;
  /** The view side. `fn` returns false when no view could take the payload. */
  setReceiver(fn: ((payload: AuthTokenPayload) => boolean) | null): void;
  /** Removes `fn` only while it is still the registered receiver. */
  clearReceiver(fn: (payload: AuthTokenPayload) => boolean): void;
}

export const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** base64url (no padding) of SHA-256 over the ASCII verifier. */
export const challengeFor = (verifier: string): string => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** The `sideform://` argument in an argv (second-instance, initial launch), or undefined. */
export function parseDeepLinkArg(argv: readonly string[]): string | undefined {
  return argv.find((a) => typeof a === "string" && a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`));
}

/** Registering `sideform://` from an unpackaged run (`process.defaultApp`: npm run dev, Playwright e2e)
 * steals the scheme from the installed app, so dev registers only when PEN_DESKTOP_REGISTER_PROTOCOL=1. */
export function shouldRegisterProtocol(defaultApp: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return !defaultApp || env.PEN_DESKTOP_REGISTER_PROTOCOL === "1";
}

/** A held token may become deliverable when a DIFFERENT tab becomes active (it may be the one that listens). */
export function activeTabChanged(
  prev: { activeId: string | number | null; activeKind: string | null } | null,
  next: { activeId: string | number | null; activeKind: string | null },
): boolean {
  return !prev || prev.activeId !== next.activeId || prev.activeKind !== next.activeKind;
}

export interface ProtocolRegistration {
  /** Extra arguments for `app.setAsDefaultProtocolClient`; empty = call it with the scheme only. */
  args: [exePath: string, args: string[]] | null;
}

/** Dev (`electron .`, process.defaultApp) must register the Electron binary WITH the app path;
 * a packaged build registers itself. */
export function resolveProtocolRegistration(
  defaultApp: boolean | undefined,
  execPath: string,
  argv1: string | undefined,
  resolvePath: (p: string) => string,
): ProtocolRegistration {
  if (defaultApp && argv1) return { args: [execPath, [resolvePath(argv1)]] };
  return { args: null };
}

/** Who may start a sign-in over `auth:sign-in`: an editor tab or the agent panel,
 * top frame, on the editor origin. */
export function isAuthSignInSender(input: {
  senderId: number;
  panelId: number | null;
  isEditorTab: boolean;
  isMainFrame: boolean;
  frameUrl: string | undefined;
  editorOrigin: string;
}): boolean {
  if (!input.isMainFrame) return false;
  if (!(input.isEditorTab || (input.panelId !== null && input.senderId === input.panelId))) return false;
  try {
    return new URL(input.frameUrl ?? "").origin === input.editorOrigin;
  } catch {
    return false;
  }
}

/** Which LISTENING view receives the token: the agent panel, else the active canvas tab, else any
 * other listening canvas tab, else nobody (the token is then held). Callers pass only views that
 * called `auth.onToken`. */
export function pickAuthReceiver<T>(candidates: { panel: T | null; activeEditorTab: T | null; otherEditorTab?: T | null }): T | null {
  return candidates.panel ?? candidates.activeEditorTab ?? candidates.otherEditorTab ?? null;
}

export function createDesktopAuth(deps: DesktopAuthDeps): DesktopAuth {
  let pending: { state: string; verifier: string; expiresAt: number } | null = null;
  let receiver: ((payload: AuthTokenPayload) => boolean) | null = null;
  // A token no view could take yet. Lives as long as its attempt; replaced by a newer link or attempt.
  let held: { payload: AuthTokenPayload; expiresAt: number } | null = null;

  // Shape and state check shared by wouldAccept and handleDeepLink. A wrong state must not cancel the real attempt.
  const inspect = (raw: string): { ok: true; token: string; attempt: { state: string; verifier: string; expiresAt: number } } | { ok: false; reason: string } => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "deep link ignored: not a URL" };
    }
    if (url.protocol !== `${DEEP_LINK_SCHEME}:` || url.hostname !== "auth") return { ok: false, reason: "deep link ignored: not sideform://auth" };
    const token = url.searchParams.get("token");
    const state = url.searchParams.get("state");
    if (!token || token.length > MAX_TOKEN_LENGTH || !state) return { ok: false, reason: "deep link ignored: token or state missing" };
    if (!pending) return { ok: false, reason: "deep link ignored: no sign-in in progress" };
    if (state !== pending.state) return { ok: false, reason: "deep link ignored: state mismatch" };
    return { ok: true, token, attempt: pending };
  };

  return {
    beginSignIn() {
      const state = base64url(deps.randomBytes(32));
      const verifier = base64url(deps.randomBytes(32));
      // Only the latest attempt is valid.
      pending = { state, verifier, expiresAt: deps.now() + SIGN_IN_TTL_MS };
      held = null;
      const url = new URL("/auth/desktop", deps.editorOrigin);
      url.searchParams.set("state", state);
      url.searchParams.set("challenge", challengeFor(verifier));
      void Promise.resolve(deps.openExternal(url.toString())).catch((err: unknown) =>
        deps.log(`sign-in: could not open the system browser: ${err instanceof Error ? err.message : String(err)}`),
      );
    },

    wouldAccept(raw) {
      const r = inspect(raw);
      return r.ok && deps.now() <= r.attempt.expiresAt;
    },

    handleDeepLink(raw) {
      const r = inspect(raw);
      if (!r.ok) {
        deps.log(r.reason);
        return false;
      }
      const { token, attempt } = r;
      if (deps.now() > attempt.expiresAt) {
        pending = null;
        deps.log("deep link ignored: sign-in expired");
        return false;
      }
      // The attempt stays valid after delivery (only expiry or a new beginSignIn ends it): `receiver`
      // returning true means a view that called `auth.onToken` was sent the message. The token is
      // single-use on the backend, so a replayed link is harmless, and the user can retry with the
      // browser button without restarting sign-in.
      const payload = { token, verifier: attempt.verifier };
      if (receiver?.(payload)) {
        held = null;
        return true;
      }
      // No view listens yet (panel bridge not mounted, window closed on macOS): keep it in main
      // until one does, but never past the attempt's expiry.
      held = { payload, expiresAt: attempt.expiresAt };
      deps.log("deep link accepted: no view is listening yet, holding the token until one does");
      return true;
    },

    notifyListening() {
      if (!held) return;
      if (deps.now() > held.expiresAt) {
        held = null;
        return;
      }
      if (receiver?.(held.payload)) held = null;
    },

    setReceiver(fn) {
      receiver = fn;
    },
    clearReceiver(fn) {
      if (receiver === fn) receiver = null;
    },
  };
}

/** The production wiring of the injected parts (everything but `openExternal`). */
export const systemDeps = {
  now: (): number => Date.now(),
  randomBytes: (size: number): Uint8Array => nodeRandomBytes(size),
};
