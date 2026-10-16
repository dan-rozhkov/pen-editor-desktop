import { normalizeHost, normalizeOrigin, type CredentialStore } from "./credentialStore";

/**
 * "Save password?" prompt for the built-in browser (design:
 * docs/superpowers/specs/2026-10-16-browser-saved-logins-design.md).
 *
 * A script runs in an ISOLATED world of each browser tab's top frame (so page
 * scripts cannot see it, patch it or call its binding). When the user submits
 * a form that has a filled password field (and only ONE password field: a
 * change-password or sign-up form with a confirm field is never captured), the
 * script calls a CDP runtime binding with `{ username, password, origin }`,
 * where `origin` is `location.origin` read at submit time. Main accepts the
 * event only from the isolated-world context it created for the tab's current
 * document (`executionContextId`), so a page cannot forge it, and files the
 * login under the payload origin, not under whatever the tab shows later.
 *
 * Nothing is asked right away: a typo'd sign-in is also "submitted". The
 * capture is held in memory and the prompt appears only if the tab navigates
 * (main frame or same-document) within HOLD_MS; otherwise it is dropped.
 * Like Chrome, a navigation alone is not success either: a wrong password
 * POSTs and reloads the login page. Once the new document is ready (bounded by
 * SETTLE_MS) the isolated world is asked whether a visible password field is
 * still there; if so the capture is dropped, no prompt.
 *
 * How it gets into each page (found by experiment, Electron 43): a binding
 * added by NAME (`executionContextName`) and a script registered with
 * `Page.addScriptToEvaluateOnNewDocument` do NOT give the world a working
 * binding unless `Runtime.enable` is on, and `Runtime.enable` is a known
 * automation fingerprint a page can detect. A binding added for an explicit
 * `executionContextId` works without it, and `Page.createIsolatedWorld`
 * returns that id. So on every main-frame `Page.frameNavigated` this module
 * creates the isolated world, adds the binding to it and runs the script.
 *
 * Electron-free: CDP and the dialog are injected. The captured password lives
 * only in local variables until the user answers; it is never logged.
 */

export const LOGIN_CAPTURE_BINDING = "__penSaveLogin";
export const LOGIN_CAPTURE_WORLD = "penLoginCapture";

/** Script source, injected with `Page.addScriptToEvaluateOnNewDocument`. */
export const LOGIN_CAPTURE_SCRIPT = `(function () {
  if (window.top !== window) return;
  // Idempotent: install() may run this again on a document that already has it.
  if (window.__penLoginCaptureOn) return;
  window.__penLoginCaptureOn = true;
  var BINDING = ${JSON.stringify(LOGIN_CAPTURE_BINDING)};
  var DEDUPE_MS = 2000;
  var lastKey = "";
  var lastAt = 0;

  function textLike(input) {
    var t = (input.getAttribute("type") || "text").toLowerCase();
    return (t === "text" || t === "email" || t === "tel") && !input.disabled && !input.readOnly;
  }

  function capture(form) {
    if (!form || !form.querySelectorAll) return;
    var inputs = form.querySelectorAll("input");
    var password = null;
    var passwordFields = 0;
    var username = "";
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "password") {
        passwordFields++;
        if (el.value && password === null) password = el.value;
      } else if (passwordFields === 0 && textLike(el) && el.value) {
        username = el.value;
      }
    }
    // Two or more password fields: change-password / sign-up with a confirm.
    if (passwordFields !== 1 || !password || !username) return;
    var key = username + "\\u0000" + password;
    var now = Date.now();
    if (key === lastKey && now - lastAt < DEDUPE_MS) return;
    lastKey = key;
    lastAt = now;
    try {
      var send = window[BINDING];
      if (typeof send === "function") send(JSON.stringify({ username: username, password: password, origin: String(location.origin) }));
    } catch (e) {}
  }

  function userActive() {
    return !!(navigator.userActivation && navigator.userActivation.isActive);
  }

  document.addEventListener("submit", function (e) {
    // requestSubmit() from a page script has no user activation behind it.
    if (userActive()) capture(e.target);
  }, true);

  document.addEventListener("click", function (e) {
    if (!e.isTrusted || !e.target || !e.target.closest) return;
    var btn = e.target.closest("button, input[type=submit], input[type=image]");
    if (btn && btn.form && (btn.type === "submit" || btn.type === "image")) capture(btn.form);
  }, true);

  document.addEventListener("keydown", function (e) {
    if (!e.isTrusted || e.key !== "Enter" || e.isComposing) return;
    var t = e.target;
    if (t && t.form && t.tagName === "INPUT") capture(t.form);
  }, true);
})();`;

const MAX_USERNAME = 512;
const MAX_PASSWORD = 1024;
const MAX_ORIGIN = 300;

export interface CapturedLogin {
  username: string;
  password: string;
  /** Normalized origin of the page the form was submitted on. */
  origin: string;
}

/** Payload from the isolated-world script. Anything unexpected -> null. */
export function parseCapturedLogin(payload: unknown): CapturedLogin | null {
  if (typeof payload !== "string" || payload.length > 4 * (MAX_USERNAME + MAX_PASSWORD + MAX_ORIGIN)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { username, password, origin: rawOrigin } = parsed as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string" || typeof rawOrigin !== "string") return null;
  if (username === "" || password === "") return null;
  if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD || rawOrigin.length > MAX_ORIGIN) return null;
  // The username is trimmed like the store trims it.
  const name = username.trim();
  // `location.origin` always has a scheme; an opaque "null" must not become a host.
  const origin = /^https?:\/\//i.test(rawOrigin) ? normalizeOrigin(rawOrigin) : null;
  if (name === "" || !origin) return null;
  return { username: name, password, origin };
}

export type SaveDecision =
  | { action: "skip"; reason: "bad-payload" | "never" | "identical" | "unavailable" | "busy" }
  | { action: "prompt"; origin: string; username: string; update: boolean };

export interface DecideInput {
  login: CapturedLogin | null;
  store: Pick<CredentialStore, "isAvailable" | "isNever" | "classify">;
  promptOpen: boolean;
}

/** Whether to ask, and how. Pure; no secret leaves the function. */
export function decideSavePrompt(input: DecideInput): SaveDecision {
  const { login } = input;
  if (!login) return { action: "skip", reason: "bad-payload" };
  if (input.promptOpen) return { action: "skip", reason: "busy" };
  if (!input.store.isAvailable()) return { action: "skip", reason: "unavailable" };
  if (input.store.isNever(login.origin)) return { action: "skip", reason: "never" };
  const relation = input.store.classify(login.origin, login.username, login.password);
  if (relation === "identical") return { action: "skip", reason: "identical" };
  return { action: "prompt", origin: login.origin, username: login.username, update: relation === "update" };
}

/** How long a captured submit waits for a navigation before it is dropped. */
export const HOLD_MS = 5000;

/** Longest wait for the new document to be ready before the sign-in check runs anyway. */
export const SETTLE_MS = 3000;

/**
 * Runs in the isolated world: is a visible `input[type=password]` in the top
 * document? Synchronous form (used after a timeout and for same-document
 * navigations).
 */
const PASSWORD_VISIBLE_BODY = `var els = document.querySelectorAll("input[type=password]");
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      var cs = window.getComputedStyle(els[i]);
      if (r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none") return true;
    }
    return false;`;
export const PASSWORD_VISIBLE_SCRIPT = `(function () {
    ${PASSWORD_VISIBLE_BODY}
})()`;
/** Same check, but resolves only once the document is no longer loading. */
export const PASSWORD_VISIBLE_WHEN_READY_SCRIPT = `new Promise(function (resolve) {
  function check() {
    ${PASSWORD_VISIBLE_BODY}
  }
  function done() { resolve(check()); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", done, { once: true });
  else done();
})`;

/**
 * Whether the held login is offered after a navigation. `passwordVisible` is
 * the check's answer: true = the sign-in form is still showing (the attempt
 * failed: drop); false or null (the check could not run) = the page moved on.
 */
export function decideAfterNavigation(passwordVisible: boolean | null): "prompt" | "drop" {
  return passwordVisible === true ? "drop" : "prompt";
}

export type PromptChoice = "save" | "never" | "later";

export interface PromptRequest {
  origin: string;
  username: string;
  update: boolean;
}

/** `https://example.com` -> `example.com`; anything else keeps its scheme/port. */
const displaySite = (origin: string): string => origin.replace(/^https:\/\//, "");

/**
 * Native dialog copy. The password is never part of it. An update replaces a
 * working password, so there "Not Now" is the default and the cancel choice;
 * a new login defaults to "Save".
 */
export function savePromptCopy(req: PromptRequest): {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
} {
  const site = displaySite(req.origin);
  return {
    message: req.update ? `Update password for ${site}?` : `Save password for ${site}?`,
    detail: req.username,
    buttons: ["Save", "Never for This Site", "Not Now"],
    defaultId: req.update ? 2 : 0,
    cancelId: 2,
  };
}

/** Button index of `savePromptCopy` -> choice. Closing the dialog is "later". */
export function promptChoiceFromButton(index: number): PromptChoice {
  return index === 0 ? "save" : index === 1 ? "never" : "later";
}

export interface CdpSend {
  (method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface CaptureContext {
  /** This tab's CDP session. */
  send: CdpSend;
  ask(req: PromptRequest): Promise<PromptChoice>;
}

/** Pure CDP-event predicate: the login binding, which must never reach any other listener. */
export function isLoginBindingCall(method: string, params: unknown): boolean {
  return method === "Runtime.bindingCalled" && isRecord(params) && params.name === LOGIN_CAPTURE_BINDING;
}

export interface CaptureTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * App-level (one per app, like the store): the single "a prompt is already
 * open" flag is shared by every tab and window. `forTab()` makes the
 * per-tab part: the isolated-world context id and the held capture.
 */
export function createLoginCapture(store: CredentialStore, timers: CaptureTimers = { set: setTimeout, clear: clearTimeout as (h: unknown) => void }) {
  let promptOpen = false;

  async function prompt(login: CapturedLogin, ask: CaptureContext["ask"]): Promise<void> {
    const decision = decideSavePrompt({ login, store, promptOpen });
    if (decision.action === "skip") return;
    promptOpen = true;
    let choice: PromptChoice = "later";
    try {
      choice = await ask({ origin: decision.origin, username: decision.username, update: decision.update });
    } catch {
      choice = "later";
    } finally {
      promptOpen = false;
    }
    try {
      if (choice === "save") {
        store.add({ site: login.origin, username: login.username, password: login.password });
      } else if (choice === "never") {
        store.addNever(normalizeHost(login.origin) ?? login.origin);
      }
    } catch (err) {
      // Fixed text only: the error message of add() never holds the input,
      // but nothing here may log the captured values.
      console.error("saved logins: could not store the login", err instanceof Error ? err.message : "unknown error");
    }
  }

  return {
    forTab() {
      /** The isolated-world context of the tab's CURRENT document, or null. */
      let contextId: number | null = null;
      /** The tab's top frame, once known (a same-document navigation only counts for it). */
      let topFrameId: string | null = null;
      /**
       * Bumped whenever a new document starts being set up. A late CDP result
       * for an older document sees a different number and is discarded, so it
       * can never overwrite `contextId`.
       */
      let generation = 0;
      let held: { login: CapturedLogin; timer: unknown } | null = null;

      const drop = () => {
        if (held) timers.clear(held.timer);
        held = null;
      };
      const release = (): CapturedLogin | null => {
        const login = held?.login ?? null;
        drop();
        return login;
      };

      /**
       * Isolated world + binding + script for one document. Never throws.
       * Resolves to the context id, or null when it failed or became stale
       * (a newer document started meanwhile).
       */
      async function injectInto(send: CdpSend, frameId: string, gen: number): Promise<number | null> {
        try {
          const world = (await send("Page.createIsolatedWorld", { frameId, worldName: LOGIN_CAPTURE_WORLD })) as {
            executionContextId?: number;
          };
          const id = world.executionContextId;
          if (typeof id !== "number" || gen !== generation) return null;
          // Already present when the world was reused: fine, the script is idempotent.
          await send("Runtime.addBinding", { name: LOGIN_CAPTURE_BINDING, executionContextId: id }).catch(() => {});
          await send("Runtime.evaluate", { expression: LOGIN_CAPTURE_SCRIPT, contextId: id });
          if (gen !== generation) return null;
          contextId = id;
          return id;
        } catch {
          // That one document is not covered; nothing else depends on it.
          return null;
        }
      }

      /**
       * Is a sign-in form still showing in this context? Waits for the document
       * to be ready, but never longer than SETTLE_MS (then asks right away).
       * null = could not tell.
       */
      async function passwordStillVisible(send: CdpSend, id: number): Promise<boolean | null> {
        const evaluate = async (expression: string, awaitPromise: boolean): Promise<boolean | null> => {
          try {
            const res = (await send("Runtime.evaluate", { expression, contextId: id, awaitPromise, returnByValue: true })) as {
              result?: { value?: unknown };
              exceptionDetails?: unknown;
            };
            const value = res.result?.value;
            return res.exceptionDetails === undefined && typeof value === "boolean" ? value : null;
          } catch {
            return null;
          }
        };
        let timer: unknown;
        const settled = new Promise<"timeout">((resolve) => {
          timer = timers.set(() => resolve("timeout"), SETTLE_MS);
        });
        try {
          const first = await Promise.race([evaluate(PASSWORD_VISIBLE_WHEN_READY_SCRIPT, true), settled]);
          return first === "timeout" ? await evaluate(PASSWORD_VISIBLE_SCRIPT, false) : first;
        } finally {
          timers.clear(timer);
        }
      }

      /** Offers a released capture, unless the sign-in form is still on screen. */
      async function offer(login: CapturedLogin, send: CdpSend, id: number | null, ask: CaptureContext["ask"]): Promise<void> {
        const visible = id === null ? null : await passwordStillVisible(send, id);
        if (decideAfterNavigation(visible) === "prompt") await prompt(login, ask);
      }

      return {
        /**
         * Covers the document the tab holds when the session is set up (usually
         * none yet: on a tab that has not navigated, CDP commands are only
         * answered once its first navigation commits). Later documents are
         * covered by `handleCdpEvent`'s `Page.frameNavigated`.
         */
        async install(send: CdpSend): Promise<void> {
          const gen = ++generation;
          try {
            const tree = (await send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string; url?: string } } };
            const frame = tree.frameTree?.frame;
            // A navigation event may have started a newer document while this waited.
            if (gen !== generation) return;
            if (frame?.id) topFrameId = frame.id;
            if (frame?.id && frame.url && /^https?:/i.test(frame.url)) await injectInto(send, frame.id, gen);
          } catch {
            // see above
          }
        },

        /** Handles one CDP event. Returns true when it was this feature's event. */
        async handleCdpEvent(method: string, params: unknown, ctx: CaptureContext): Promise<boolean> {
          const p = isRecord(params) ? params : {};

          if (method === "Page.navigatedWithinDocument") {
            // Main frame only: an iframe's pushState is not the sign-in succeeding.
            if (topFrameId === null || p.frameId !== topFrameId) return true;
            // Same document: the context stays valid; a held submit now counts as
            // accepted, unless the sign-in form is still showing.
            const login = release();
            if (login) await offer(login, ctx.send, contextId, ctx.ask);
            return true;
          }

          if (method === "Page.frameNavigated") {
            const frame = isRecord(p.frame) ? p.frame : null;
            // Main frame only (subframes have a parentId).
            if (!frame || typeof frame.id !== "string" || frame.parentId !== undefined) return true;
            // A new document: the old context is gone, and no event from it counts.
            const gen = ++generation;
            topFrameId = frame.id;
            contextId = null;
            const login = release();
            const id = typeof frame.url === "string" && /^https?:/i.test(frame.url) ? await injectInto(ctx.send, frame.id, gen) : null;
            if (login) await offer(login, ctx.send, id, ctx.ask);
            return true;
          }

          if (method !== "Runtime.bindingCalled") return false;
          if (p.name !== LOGIN_CAPTURE_BINDING) return false;

          // Only the world this module created for the tab's current document.
          if (contextId === null || p.executionContextId !== contextId) return true;
          const login = parseCapturedLogin(p.payload);
          if (!login) return true;
          // Hold, do not ask: a wrong password is "submitted" too.
          drop();
          held = {
            login,
            timer: timers.set(() => {
              held = null;
            }, HOLD_MS),
          };
          return true;
        },
      };
    },
  };
}

export type LoginCapture = ReturnType<typeof createLoginCapture>;
export type TabLoginCapture = ReturnType<LoginCapture["forTab"]>;
