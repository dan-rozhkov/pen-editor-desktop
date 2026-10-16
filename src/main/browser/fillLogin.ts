import { normalizeOrigin, type CredentialStore } from "./credentialStore";

/**
 * `browser:command` -> `fillLogin`. Types a saved login into the sign-in form
 * of the agent's current browser tab (design:
 * docs/superpowers/specs/2026-10-16-browser-saved-logins-design.md).
 *
 * The model asks "fill the login here" and gets back only
 * `{ ok, origin, label, filled, submitted }` or `{ ok: false, error }`. Two
 * rules hold everywhere in this file:
 *  - The username and the password go into exactly one place: the `text` of a
 *    controller `perform` call. They are never put in a result, an error or a
 *    log line.
 *  - Nothing the controller returns is passed through (its results can carry
 *    page text and `changes`). Every error here is a fixed message.
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
}

export interface FillLoginArgs {
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
  disabled: boolean;
  frame: boolean;
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
      disabled: e.disabled === true,
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

const originOf = (url: string | null): string | null => (url === null ? null : normalizeOrigin(url));

export async function fillLogin(rawArgs: unknown, deps: FillLoginDeps): Promise<FillLoginResult> {
  const args = parseFillLoginArgs(rawArgs);
  if (!args) return fail('Invalid arguments. Use { label?: string, submit?: boolean }.');

  const startUrl = deps.getUrl();
  if (startUrl === null) return fail("No browser tab is open.");
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

  let snapshot: Record<string, unknown>;
  try {
    snapshot = await deps.controller.snapshot();
  } catch {
    return fail("Could not read the page.");
  }
  const snapshotId = snapshot.snapshotId;
  const elements = "error" in snapshot ? null : readElements(snapshot);
  if (!elements || typeof snapshotId !== "string" || snapshotId === "") return fail("Could not read the page.");

  const fields = pickLoginFields(elements);
  if (fields.username === undefined && fields.password === undefined) {
    return fail("No sign-in fields found on this page.");
  }

  const filled: ("username" | "password")[] = [];
  let lastIndex: number | null = null;

  const typeInto = async (kind: "username" | "password", index: number, text: string): Promise<boolean> => {
    // The tab may have navigated since the origin was matched: a saved login is
    // only ever typed into a page of its own origin.
    if (originOf(deps.getUrl()) !== origin) return false;
    try {
      const res = await deps.controller.perform({ operation: "TYPE_TEXT", index, text, snapshotId });
      if ("error" in res) return false;
    } catch {
      return false;
    }
    // Checked again AFTER the keystrokes: a navigation that landed during
    // perform() ends the fill here, so no later field is typed and nothing is
    // submitted. (The text of THIS call already went to whatever page was
    // there; see "known limit" in CLAUDE.md.)
    if (originOf(deps.getUrl()) !== origin) return false;
    filled.push(kind);
    lastIndex = index;
    return true;
  };

  if (fields.username !== undefined && !(await typeInto("username", fields.username, entry.username))) {
    return fail("Could not type into the sign-in form. Nothing was submitted.");
  }
  if (fields.password !== undefined && !(await typeInto("password", fields.password, entry.password))) {
    return fail("Could not type into the sign-in form. Nothing was submitted.");
  }

  let submitted = false;
  if (args.submit && lastIndex !== null && originOf(deps.getUrl()) === origin) {
    try {
      const res = await deps.controller.act({ action: "press", key: "Enter", index: lastIndex, snapshotId });
      submitted = !("error" in res);
    } catch {
      submitted = false;
    }
  }

  deps.store.markUsed(entry.id);
  return { ok: true, origin, label: entry.label, filled, submitted };
}
