import { normalizeOrigin, type CredentialStore } from "./credentialStore";

/**
 * `browser:command` -> `fillLogin`. Types a saved login into the sign-in form
 * of the agent's current browser tab (design:
 * docs/superpowers/specs/2026-10-16-browser-saved-logins-design.md).
 *
 * The model asks "fill the login here" and gets back only
 * `{ ok, origin, label, filled, submitted, url?, retried?, sessionEstablished?, note?, stillOnSignInPage? }` or `{ ok: false, error }`. Two
 * rules hold everywhere in this file:
 *  - The username and the password go into exactly one place: the `text` of a
 *    controller `perform` call. They are never put in a result, an error or a
 *    log line.
 *  - Nothing the controller returns is passed through (its results can carry
 *    page text and `changes`). Every error here is a fixed message.
 *
 * A submit is attempted at most twice per call: Enter (plus a fallback click when Enter did
 * nothing), then ONE retry (retype both fields, Enter) if the page showed no sign that the app
 * reacted (no navigation, no pending load, same form fingerprint). Accepted risk: a wrong
 * password can be submitted twice per call, and an error message the snapshot text cannot see
 * (shadow DOM, out of the viewport, past 6000 characters) is not detected as a reaction.
 *
 * Pure and Electron-free: the controller, the store and the current-URL reader
 * are injected.
 */

export interface LoginController {
  snapshot(): Promise<Record<string, unknown>>;
  perform(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  act(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface FillLoginDeps {
  controller: LoginController;
  store: Pick<CredentialStore, "findForOrigin" | "markUsed">;
  /** URL of the agent's current browser tab, or null when there is none. */
  getUrl(): string | null;
  /**
   * True while the agent tab is mid-navigation (`webContents.isLoadingMainFrame()`: subframe and ad loads do not count). A pending
   * navigation counts as an effect of the submit: no fallback click, no retry.
   */
  isLoading?(): boolean;
  /** Test seam: waits between submit checks. Default is a real timer. */
  sleep?(ms: number): Promise<void>;
}

export interface FillLoginArgs {
  /** Picks the account: a saved label, else a saved username (case-insensitive). Usernames are never echoed back. */
  label?: string;
  submit: boolean;
}

export type FillLoginResult =
  | {
      ok: true;
      origin: string;
      label: string;
      filled: ("username" | "password")[];
      submitted: boolean;
      /**
       * The tab's URL at the end: origin + pathname ONLY (a native GET submit can put the password in the query),
       * the username redacted from the path ("…"). Omitted when the tab is not on an http(s) page.
       */
      url?: string;
      /** Only when a submit was attempted: the URL changed or the password field is gone. */
      sessionEstablished?: boolean;
      /** Only when `sessionEstablished` is false. Fixed text. */
      note?: string;
      /** Only when a submit was attempted and the final page could be read: the sign-in fields are still there and the URL did not change. */
      stillOnSignInPage?: boolean;
      /** Only when a submit was attempted: the type + Enter cycle ran a second time. */
      retried?: boolean;
    }
  | { ok: false; error: string };

/**
 * The only element fields this module reads from a snapshot. They are the
 * fields the browser-agent controller really puts on an element (SNAPSHOT_JS
 * in @sideform/browser-agent controller/pageScripts.js, plus `frame` stamped
 * on by takeSnapshot for iframe content): `index`, `tag`, `label`, `ops`,
 * and, only when present, `role` (the explicit ARIA role attribute),
 * `options` (select), `value` (live text of a non-password, non-sensitive
 * text/search/textarea/range field), `hasValue` (every other input/textarea:
 * email, tel, url, number, date...), `isPassword`, `checked`, `inputType`
 * (checkbox/radio ONLY), `expanded` (field with a suggestion popup), `disabled`.
 * There is no input `type` and no `autocomplete` for a text field.
 */
export interface SnapshotElement {
  index: number;
  tag: string;
  label: string;
  role: string;
  ops: string[];
  isPassword: boolean;
  /** `hasValue` as the snapshot reports it for a password field; undefined when absent. */
  hasValue: boolean | undefined;
  disabled: boolean;
  frame: boolean;
  /** Whether the field holds any text now (`value` non-empty, else `hasValue`); undefined when the snapshot does not say. Never the text itself. */
  holdsText?: boolean | undefined;
  /** Carries a select's `options`, an `expanded` flag or a `checked` state: not a plain text field. */
  widget: boolean;
}

const MAX_LABEL = 200;

const LOGIN_LABEL = /user|e-?mail|login|log in|sign in|account|phone|mobile|логин|почт|телефон|имя пользователя|\bid\b/i;
// Search boxes, and the number / date / code fields the snapshot cannot tell
// from a text field by type (it reports no input type for them).
const NOT_LOGIN_LABEL =
  /search|поиск|найти|query|coupon|promo|промокод|date|birth|day|month|year|number|quantity|qty|amount|zip|postal|\bcode\b|otp|captcha|дата|рожд|количество|индекс|код/i;
// Explicit ARIA roles of a non-text widget. A plain input has no role.
const WIDGET_ROLES = new Set(["combobox", "searchbox", "spinbutton", "slider", "listbox", "switch", "checkbox", "radio"]);

function fail(error: string): FillLoginResult {
  return { ok: false, error };
}

/** Only `{ label?, submit? }` is accepted; anything else is an error. */
export function parseFillLoginArgs(args: unknown): FillLoginArgs | null {
  if (args === undefined || args === null) return { submit: false };
  if (typeof args !== "object" || Array.isArray(args)) return null;
  const rec = args as Record<string, unknown>;
  let label: string | undefined;
  if (rec.label !== undefined) {
    if (typeof rec.label !== "string") return null;
    const trimmed = rec.label.trim();
    if (trimmed.length > MAX_LABEL) return null;
    if (trimmed !== "") label = trimmed;
  }
  if (rec.submit !== undefined && typeof rec.submit !== "boolean") return null;
  return { ...(label !== undefined ? { label } : {}), submit: rec.submit === true };
}

function readElements(snapshot: Record<string, unknown>): SnapshotElement[] | null {
  if (!Array.isArray(snapshot.elements)) return null;
  const out: SnapshotElement[] = [];
  for (const raw of snapshot.elements) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.index !== "number" || !Number.isInteger(e.index) || e.index < 0) continue;
    out.push({
      index: e.index,
      tag: typeof e.tag === "string" ? e.tag.toLowerCase() : "",
      label: typeof e.label === "string" ? e.label : "",
      role: typeof e.role === "string" ? e.role.toLowerCase() : "",
      ops: Array.isArray(e.ops) ? e.ops.filter((o): o is string => typeof o === "string") : [],
      isPassword: e.isPassword === true,
      hasValue: typeof e.hasValue === "boolean" ? e.hasValue : undefined,
      disabled: e.disabled === true,
      holdsText:
        typeof e.value === "string" ? e.value !== "" : typeof e.hasValue === "boolean" ? e.hasValue : undefined,
      // Any value means the element lives in a child iframe: never touched.
      frame: e.frame !== undefined && e.frame !== null && e.frame !== false,
      widget: e.options !== undefined || e.expanded !== undefined || e.checked !== undefined || e.inputType !== undefined,
    });
  }
  return out;
}

const isTypable = (e: SnapshotElement): boolean => !e.frame && !e.disabled && e.ops.includes("TYPE_TEXT");

/**
 * A plain single-line text field that is not a search box or a combobox.
 * Only fields the snapshot really has: `input` tag; both TYPE_TEXT and CLICK
 * ops (a range, a password and a non-input editor offer only TYPE_TEXT); no
 * widget role, options, popup state or checked state; and a label that is
 * not a search/number/date one. (The snapshot has no input type, so a search
 * or number field without such a label cannot be told from a text field.)
 */
function isTextField(e: SnapshotElement): boolean {
  if (!isTypable(e) || e.isPassword || e.tag !== "input") return false;
  if (!e.ops.includes("CLICK") || e.widget || WIDGET_ROLES.has(e.role)) return false;
  return !NOT_LOGIN_LABEL.test(e.label);
}

const looksLikeLogin = (e: SnapshotElement): boolean => LOGIN_LABEL.test(e.label);

export interface PickedFields {
  username?: number;
  password?: number;
}

/**
 * Top document only (`frame` elements are skipped). Password field: the first
 * typable `isPassword` element. Username field: with a password field, the
 * nearest text field BEFORE it by index; without one (a two-step sign-in's
 * first page), the first text field that looks like a login field.
 * Index order is the snapshot's reading order for what is on screen.
 */
export function pickLoginFields(elements: SnapshotElement[]): PickedFields {
  const password = elements.find((e) => isTypable(e) && e.isPassword);
  if (password) {
    let username: SnapshotElement | undefined;
    for (const e of elements) {
      if (e.index < password.index && isTextField(e) && (!username || e.index > username.index)) username = e;
    }
    return { password: password.index, ...(username ? { username: username.index } : {}) };
  }
  const first = elements.find((e) => isTextField(e) && looksLikeLogin(e));
  return first ? { username: first.index } : {};
}

/** The unit-test seam for `pickLoginFields`: raw snapshot elements in. */
export function pickFromSnapshot(snapshot: Record<string, unknown>): PickedFields | null {
  const elements = readElements(snapshot);
  return elements ? pickLoginFields(elements) : null;
}

export const SESSION_NOT_ESTABLISHED_NOTE =
  "The form was submitted but the page still shows the login form. The session is not established. Take a snapshot; check for an error message or a captcha before you continue.";

const SETTLE_MS = 3000;
/** Wait between typing and the check that the fields still hold their text. */
const AFTER_TYPE_SETTLE_MS = 300;
const POLL_MS = 250;
const SUBMIT_LABEL = /sign\s*in|log\s*in|login|submit|continue|войти|вход|продолжить|далее|отправить/i;
const NOT_SUBMIT_LABEL =
  /sign\s*up|register|create|forgot|reset|google|apple|facebook|github|microsoft|sso|регистр|создать|забыл|сброс/i;

/**
 * The button that submits the sign-in form: a non-frame, enabled, clickable
 * button (or input / role=button) whose label looks like a sign-in action.
 * The nearest one AFTER the password field wins, else the first match.
 */
export function pickSubmitButton(elements: SnapshotElement[]): number | null {
  const password = elements.find((e) => isTypable(e) && e.isPassword);
  const candidates = elements.filter(
    (e) =>
      !e.frame &&
      !e.disabled &&
      e.ops.includes("CLICK") &&
      !e.ops.includes("TYPE_TEXT") &&
      !e.widget && // checkbox / radio / switch / popup triggers: "Keep me signed in" is not a submit
      !WIDGET_ROLES.has(e.role) &&
      (e.tag === "button" || e.tag === "input" || e.role === "button") &&
      SUBMIT_LABEL.test(e.label) &&
      !NOT_SUBMIT_LABEL.test(e.label),
  );
  if (candidates.length === 0) return null;
  const after = password ? candidates.find((e) => e.index > password.index) : undefined;
  return (after ?? candidates[0]).index;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What must not appear in the reported path or host: the username, and for an email its local part
 * and the full address. A local part under 3 characters is NOT redacted (it would shred ordinary
 * paths); the full username always is, so a very short username without "@" can garble the host.
 * Over-redaction of a common username (e.g. "admin" in a path) is accepted: safety over usefulness.
 */
function redactionNeedles(username: string): string[] {
  const out = new Set<string>();
  const u = username.trim();
  if (u !== "") out.add(u);
  const at = u.lastIndexOf("@");
  if (at > 0) {
    const local = u.slice(0, at);
    if (local.length >= 3) out.add(local);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const REDACTED = "\u2026";

/** Case-insensitive replace of every needle in `text`, longest first. */
function redactText(text: string, needles: string[]): string {
  if (needles.length === 0) return text;
  const re = new RegExp(needles.map(escapeRegExp).join("|"), "gi");
  return text.replace(re, REDACTED);
}

/**
 * origin + pathname only (query and hash can carry a password after a native GET
 * submit), with the saved username redacted from the path (a post-login path can
 * be /u/<name>/dashboard) and from the host labels (a tenant host can be <name>.app.com). The raw segment and its
 * once and twice decoded forms are checked (jdoe%40corp.test, jdoe%2540corp.test); a decoded ? or # stays encoded. Null unless the URL is http(s).
 */
function publicUrl(url: string, username: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const needles = redactionNeedles(username);
    // Per segment: a decoded "?" or "#" must stay encoded (%3F / %23), or it would turn the rest of
    // the path into a query or hash. Each segment is checked raw and decoded once and twice
    // (a double-encoded form like jdoe%2540corp.test), the most decoded level that exposes a needle wins.
    const safeDecode = (t: string): string => {
      try {
        return decodeURIComponent(t);
      } catch {
        return t;
      }
    };
    const path = u.pathname
      .split("/")
      .map((seg) => {
        const d1 = safeDecode(seg);
        const d2 = safeDecode(d1);
        for (const level of [d2, d1]) {
          const redacted = redactText(level, needles);
          if (redacted !== level) {
            return redacted
              .split(REDACTED)
              .map((part) => encodeURIComponent(part))
              .join(REDACTED);
          }
        }
        // The raw segment as well (an undecodable one, or a form decoding did not expose).
        return redactText(seg, needles);
      })
      .join("/");
    return `${u.protocol}//${redactText(u.host, needles)}${path}`;
  } catch {
    return null;
  }
}

/**
 * The form "fingerprint": what the snapshot shows of the page's structure, WITHOUT field values, focus
 * or `hasValue` (so typing and a hydration reset do not change it). A button that gets disabled or
 * relabelled ("Signing in..."), an element that appears or goes, or new visible page text (an error
 * message, the snapshot's `text`) all change it: the app reacted. Text that changes by itself (a
 * clock, a banner) also counts as a reaction, which is the safe side (no second submit).
 */
export function formFingerprint(elements: SnapshotElement[], text: string): string {
  return JSON.stringify([
    elements.map((e) => [e.tag, e.label, e.role, e.disabled, e.frame, e.isPassword, e.ops.join(",")]),
    text.replace(/\s+/g, " ").trim(),
  ]);
}

const originOf = (url: string | null): string | null => (url === null ? null : normalizeOrigin(url));

/** origin + pathname: a query or hash change (/login?error=1) is not a navigation. */
function locationKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export async function fillLogin(rawArgs: unknown, deps: FillLoginDeps): Promise<FillLoginResult> {
  const args = parseFillLoginArgs(rawArgs);
  if (!args) return fail('Invalid arguments. Use { label?: string, submit?: boolean }.');

  // A destroyed tab can make a dep throw: a dep never breaks the fixed results.
  const currentUrl = (): string | null => {
    try {
      return deps.getUrl();
    } catch {
      return null;
    }
  };
  const loading = (): boolean => {
    try {
      return deps.isLoading?.() === true;
    } catch {
      return false;
    }
  };
  const startUrl = currentUrl();
  if (startUrl === null) return fail("No browser tab is open.");
  const startKey = locationKey(startUrl);
  const origin = originOf(startUrl);
  if (!origin) return fail("The current tab is not an http(s) page.");

  const found = deps.store.findForOrigin(origin, args.label);
  if (!found.ok) {
    if (found.reason === "none") {
      return fail(`No saved login for ${origin}. The user can add one in the Passwords window.`);
    }
    if (found.reason === "label") {
      const labels = found.labels.slice(0, 10).map((l) => l.slice(0, 60));
      return fail(
        labels.length > 0
          ? `No saved login with that label for ${origin}. Saved labels: ${labels.join(", ")}.`
          : `No saved login with that label for ${origin}.`,
      );
    }
    return fail(`The saved login for ${origin} cannot be read. The user must save it again.`);
  }
  const entry = found.entry;

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  interface PageRead {
    id: string;
    url: string | undefined;
    elements: SnapshotElement[];
    /** The snapshot's visible page text (or ""): only ever hashed into the fingerprint, never returned. */
    text: string;
  }
  /** The one snapshot reader. Null when the page cannot be read (error, throw, no elements, no snapshot id). */
  const readPage = async (): Promise<PageRead | null> => {
    try {
      const snap = await deps.controller.snapshot();
      const elements = "error" in snap ? null : readElements(snap);
      const id = snap.snapshotId;
      if (!elements || typeof id !== "string" || id === "") return null;
      return { id, url: typeof snap.url === "string" ? snap.url : undefined, elements, text: typeof snap.text === "string" ? snap.text : "" };
    } catch {
      return null;
    }
  };

  // No fixed wait before the first snapshot: a page that is still hydrating takes
  // keystrokes the app never sees (a controlled input keeps its state "" while the
  // DOM shows text) or clears the fields when it finishes. The controller has no
  // "app is ready" signal, so the post-type check below (cleared fields are typed
  // again) and the one guarded retry after the submit are the real guard.
  const first = await readPage();
  if (!first) return fail("Could not read the page.");
  let snapshotId = first.id;
  let fields = pickLoginFields(first.elements);
  if (fields.username === undefined && fields.password === undefined) {
    return fail("No sign-in fields found on this page.");
  }

  const filled: ("username" | "password")[] = [];

  const typeInto = async (kind: "username" | "password", index: number, text: string, id: string): Promise<boolean> => {
    // The tab may have navigated since the origin was matched: a saved login is
    // only ever typed into a page of its own origin. (Checked on every typing,
    // the retry included.)
    if (originOf(currentUrl()) !== origin) return false;
    try {
      const res = await deps.controller.perform({ operation: "TYPE_TEXT", index, text, snapshotId: id });
      if ("error" in res) return false;
    } catch {
      return false;
    }
    // Checked again AFTER the keystrokes: a navigation that landed during
    // perform() ends the fill here, so no later field is typed and nothing is
    // submitted. (The text of THIS call already went to whatever page was
    // there; see "known limit" in CLAUDE.md.)
    if (originOf(currentUrl()) !== origin) return false;
    if (!filled.includes(kind)) filled.push(kind);
    return true;
  };

  const typeFields = async (
    picked: PickedFields,
    id: string,
    kinds: ("username" | "password")[],
  ): Promise<boolean> => {
    if (kinds.includes("username") && picked.username !== undefined) {
      if (!(await typeInto("username", picked.username, entry.username, id))) return false;
    }
    if (kinds.includes("password") && picked.password !== undefined) {
      if (!(await typeInto("password", picked.password, entry.password, id))) return false;
    }
    return true;
  };
  const TYPE_FAILED = "Could not type into the sign-in form. Nothing was submitted.";

  if (!(await typeFields(fields, snapshotId, ["username", "password"]))) return fail(TYPE_FAILED);

  // Settle, look again: a field that does not hold a value any more was cleared
  // (the app hydrated and reset it). Type it once more. Only the snapshot's own
  // `value` / `hasValue` flags are read, never a password.
  //
  // Indices and the snapshot id always come from ONE snapshot. If a field picked
  // before is missing from the new snapshot (the page re-rendered), take one more
  // snapshot and re-pick; if it is still missing, the fields are "stale": Enter is
  // not pressed (the result is ok with submitted:false), because the old index
  // could now point at another element.
  await sleep(AFTER_TYPE_SETTLE_MS);
  const missingPick = (p: PickedFields): boolean =>
    (["username", "password"] as const).some((k) => fields[k] !== undefined && p[k] === undefined);
  let staleFields = false;
  // A failed re-read (null) is handled like a missing field: one fresh snapshot, re-pick;
  // if that fails too, the old fields are stale and Enter is not pressed.
  let checked = await readPage();
  let again = checked ? pickLoginFields(checked.elements) : null;
  if (!checked || !again || missingPick(again)) {
    checked = await readPage();
    again = checked ? pickLoginFields(checked.elements) : null;
    if (!checked || !again || missingPick(again)) staleFields = true;
  }
  // The fingerprint baseline is the page as it was just before the first submit (values excluded). A
  // retype below changes the page's state (and may fire app handlers), so after one the page is read
  // again and THAT read is the baseline: the retype itself is not counted as a reaction.
  let baseline: string | null = null;
  if (checked && again && !staleFields) {
    const byIndex = new Map(checked.elements.map((e) => [e.index, e]));
    const cleared = (["username", "password"] as const).filter((kind) => {
      const idx = again![kind];
      return filled.includes(kind) && idx !== undefined && byIndex.get(idx)?.holdsText === false;
    });
    snapshotId = checked.id;
    fields = again;
    baseline = formFingerprint(checked.elements, checked.text);
    // An identifier-first form that reveals its password field inline: the password was not typed
    // before (there was no field), so it is typed once now (the origin guard is in typeInto).
    const revealed = !filled.includes("password") && again.password !== undefined;
    const retype: ("username" | "password")[] = [...cleared, ...(revealed ? (["password"] as const) : [])];
    if (retype.length > 0) {
      if (!(await typeFields(again, checked.id, retype))) return fail(TYPE_FAILED);
      const after = await readPage();
      const afterPick = after ? pickLoginFields(after.elements) : null;
      if (after && afterPick && !missingPick(afterPick) && (!revealed || afterPick.password !== undefined)) {
        snapshotId = after.id;
        fields = afterPick;
        baseline = formFingerprint(after.elements, after.text);
      }
      // else: keep the earlier ids and baseline (the retype may then count as a reaction: the safe side).
    }
  }

  /** Enter goes to the last field of the form: the password, else the username. */
  const pressTarget = (picked: PickedFields): number | null =>
    filled.includes("password") && picked.password !== undefined
      ? picked.password
      : filled.includes("username") && picked.username !== undefined
        ? picked.username
        : null;

  // A form whose password was not really typed (a two-step sign-in's first page) is never retried.
  const hadPassword = filled.includes("password");
  let submitted = false;
  let submitAttempted = false;
  let sessionEstablished: boolean | undefined;
  let stillOnSignInPage: boolean | undefined;
  let retried = false;

  const navigated = (resUrl: unknown): boolean => {
    const now = currentUrl();
    return (
      (typeof resUrl === "string" && locationKey(resUrl) !== startKey) || (now !== null && locationKey(now) !== startKey)
    );
  };

  /**
   * Watches the page for the full window (early exit only on a URL change or a
   * confirmed login) and returns the last page it read. Established = the URL moved
   * on, or the password field existed before, is gone now, and the act reported a
   * change. `pageChanged` = a sign that the app REACTED to the act: a navigation is
   * pending (`isLoading`), the form fingerprint differs from the pre-submit one at ANY
   * poll (see `formFingerprint`), or the page could not be read at all. The act's own
   * `changed` flag is NOT a reaction: it also fires for a focus move or a field edit
   * (seen in e2e under load with a silent, unhydrated form). A cleared password with an unchanged fingerprint is a
   * hydration reset, NOT a reaction: the retry is allowed then and retypes both fields.
   *
   * Accepted risk: an XHR whose response changes nothing visible within the window
   * (no text, no element change) looks like "no reaction" and can get a second submit.
   */
  const settle = async (actChanged: boolean, actUrlMoved: boolean) => {
    let moved = actUrlMoved;
    let seen = false;
    let sawSign = false; // sticky: a pending navigation or a fingerprint change at ANY poll
    let last: PageRead | null = null;
    for (let waited = 0; ; waited += POLL_MS) {
      if (navigated(undefined)) moved = true;
      if (moved) return { established: true, pageChanged: true, last };
      if (loading()) sawSign = true;
      last = await readPage();
      if (last) {
        if (last.url !== undefined && locationKey(last.url) !== startKey) return { established: true, pageChanged: true, last };
        seen = true;
        if (navigated(undefined)) return { established: true, pageChanged: true, last };
        const pw = last.elements.find((e) => !e.frame && e.isPassword);
        const pwGone = hadPassword && !pw;
        if (baseline !== null && formFingerprint(last.elements, last.text) !== baseline) sawSign = true;
        if (pwGone && actChanged) return { established: true, pageChanged: true, last };
      }
      if (waited >= SETTLE_MS) break;
      await sleep(POLL_MS);
    }
    // `seen` false: the page could not be read, so nothing is known: no second submit.
    return { established: false, pageChanged: sawSign || !seen, last };
  };

  const act = async (args2: Record<string, unknown>) => {
    try {
      const res = await deps.controller.act(args2);
      if ("error" in res) return { ok: false, changed: false, moved: false };
      return { ok: true, changed: res.changed === true, moved: navigated(res.url) };
    } catch {
      return { ok: false, changed: false, moved: false };
    }
  };

  /**
   * One submit: Enter in `index`, watch the page, and (only when `allowClick`)
   * the fallback click when Enter changed nothing at all.
   */
  const submitOnce = async (index: number, id: string, allowClick: boolean) => {
    const pressed = await act({ action: "press", key: "Enter", index, snapshotId: id });
    let didSubmit = pressed.ok;
    const afterEnter = await settle(pressed.changed, pressed.moved);
    let { established, pageChanged, last } = afterEnter;

    // Fallback click ONLY when Enter changed nothing at all: otherwise a slow
    // server or a re-render would get a second submit. (Uses settle's last read.)
    if (allowClick && !established && !pageChanged && last && originOf(currentUrl()) === origin) {
      const btn = pickSubmitButton(last.elements);
      if (btn !== null) {
        const click = await act({ action: "click", index: btn, snapshotId: last.id });
        if (click.ok) didSubmit = true;
        const afterClick = await settle(click.changed, click.moved);
        established = afterClick.established;
        pageChanged = pageChanged || afterClick.pageChanged;
        last = afterClick.last;
      }
    }
    return { submitted: didSubmit, established, pageChanged, last };
  };

  const target = pressTarget(fields);
  if (args.submit && !staleFields && target !== null && originOf(currentUrl()) === origin) {
    submitAttempted = true;
    const run1 = await submitOnce(target, snapshotId, true);
    submitted = run1.submitted;
    let established = run1.established;
    let finalPage = run1.last;

    // At most TWO submits per call: the first (Enter, maybe the fallback click) and ONE
    // retry (Enter only). The retry runs only when the form had a password field, the
    // pre-submit fields were confirmed (not stale) and settle saw NO sign that the app
    // reacted (see `settle`): no navigation, no pending load, the same form fingerprint,
    // the sign-in fields still there. Then the app most likely had not hydrated when we
    // typed (even if the fallback click was sent: it hit an app with empty state): type
    // BOTH fields again (TYPE_TEXT fires input events) and submit once more.
    // Accepted risk: a wrong password can be submitted twice per call (lockout counters).
    if (!established && !run1.pageChanged && hadPassword && run1.last !== null && originOf(currentUrl()) === origin) {
      const page = run1.last;
      const picked = pickLoginFields(page.elements);
      const kinds = filled.filter((k) => picked[k] !== undefined);
      const retryTarget = pressTarget(picked);
      if (kinds.length === filled.length && retryTarget !== null) {
        retried = true;
        // If typing fails here run 1 has already submitted: report that (submitted,
        // retried, not established), never "nothing was submitted".
        if (await typeFields(picked, page.id, [...kinds])) {
          const run2 = await submitOnce(retryTarget, page.id, false); // Enter only: the third action is never a click
          submitted = submitted || run2.submitted;
          established = run2.established;
          finalPage = run2.last;
        }
      }
    }
    sessionEstablished = established;

    if (established) {
      stillOnSignInPage = false;
    } else if (finalPage) {
      // Unknown (omitted) when the final page cannot be read.
      const p = pickLoginFields(finalPage.elements);
      stillOnSignInPage = (p.username !== undefined || p.password !== undefined) && !navigated(undefined);
    }
  }

  try {
    deps.store.markUsed(entry.id);
  } catch {
    // A failed bookkeeping write never changes the result.
  }
  const publicLocation = publicUrl(currentUrl() ?? startUrl, entry.username);
  return {
    ok: true,
    origin,
    label: entry.label,
    filled,
    submitted,
    ...(publicLocation === null ? {} : { url: publicLocation }),
    ...(sessionEstablished === undefined
      ? {}
      : sessionEstablished
        ? { sessionEstablished: true }
        : { sessionEstablished: false, note: SESSION_NOT_ESTABLISHED_NOTE }),
    ...(submitAttempted
      ? { ...(stillOnSignInPage === undefined ? {} : { stillOnSignInPage }), retried }
      : {}),
  };
}
