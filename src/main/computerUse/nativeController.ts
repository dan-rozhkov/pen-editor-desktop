// AppController for one running macOS app, on top of the `sideform-computer-use` helper
// (spec section 2). Never throws: every failure is an `{ error }` result. Electron-free:
// image re-encoding, the cursor overlay and the clock are injected.

import { parseQaChecks } from "@sideform/browser-agent/controller";
import type { AppController } from "../appTargets";
import {
  ERR_HELPER_MISSING,
  ERR_NATIVE_CHECK_NO_INDEX,
  ERR_NATIVE_CHECK_UNSUPPORTED,
  ERR_NATIVE_NO_CAPTURE,
  ERR_NATIVE_NO_WINDOW,
  ERR_NATIVE_NOT_FRONTMOST,
  ERR_NATIVE_OPEN_LOCKED,
  ERR_NATIVE_POINT_NOT_IN_APP,
  ERR_NATIVE_SHORTCUT_BLOCKED,
  ERR_NATIVE_TABS,
  ERR_NATIVE_UNSUPPORTED,
  ERR_NO_ACCESSIBILITY,
  ERR_NO_SCREEN_RECORDING,
  NATIVE_LIST_TRUNCATED_NOTE,
  ERR_NATIVE_CHECK_CUT,
  ERR_NATIVE_CHECK_NO_CHECKED,
  ERR_NATIVE_CHECK_NO_VALUE,
  ERR_NATIVE_CHECK_NO_LABEL,
  ERR_NATIVE_CHECK_EMPTY_TEXT,
  ERR_NATIVE_CHECK_AMBIGUOUS,
  ERR_NATIVE_TEXT_ABSENT_CUT,
} from "./errors";
import { HelperError, type ComputerUseHelper } from "./helperClient";
import { isBlockedShortcut } from "./shortcuts";

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The action kinds browser-agent's CURSOR_JS knows (it animates a click, a type, ... differently). */
export type CursorAction = "click" | "type" | "select" | "scroll" | "hover" | "press";

export interface CursorSink {
  /** Animate the agent cursor to a global screen point (top-left origin). The promise settles when it arrives (or gives up). */
  moveTo(point: { x: number; y: number }, opts: { action: CursorAction; windowFrame: WindowFrame }): Promise<void> | void;
}

export interface NativeControllerDeps {
  helper: Pick<ComputerUseHelper, "call">;
  pid: number;
  name: string;
  bundleId?: string;
  cursor?: CursorSink;
  /** Downscale + re-encode a PNG (base64) to JPEG ≤ maxWidth px. Injected: the Electron side uses nativeImage. Default: return the PNG unchanged with its size. */
  encodeImage?: (pngBase64: string, maxWidth: number) => { data: string; width: number; height: number; mimeType?: string };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type NativeAppController = AppController & { currentWindowId(): number | undefined };

const MAX_ELEMENTS = 120;
/** The helper clamps `maxElements` to 1000. A big snapshot stays internal: `target` search and QA checks, never shown to the model. */
const TARGET_SEARCH_MAX_ELEMENTS = 1000;
/** `read` limit for a text check. */
const ASSERT_READ_MAX_CHARS = 100000;
const ACTUAL_MAX_CHARS = 120;
const MAX_BATCH = 10;
const READ_MAX_CHARS = 12000;
const SCREENSHOT_MAX_WIDTH = 1280;
const WAIT_DEFAULT_MS = 1000;
const WAIT_TEXT_DEFAULT_MS = 5000;
const WAIT_MAX_MS = 15000;
const WAIT_POLL_MS = 500;
const SETTLE_MS = 300;
/** Pixels scrolled per unit of `amount`. */
const SCROLL_STEP_PX = 500;

const STALE_MESSAGE = "The snapshot is out of date (the window changed). Call browse_snapshot again and use the new snapshotId and indices.";

interface WindowInfo extends WindowFrame {
  windowId: number;
  title: string;
  onScreen?: boolean;
  minimized?: boolean;
  main?: boolean;
  focused?: boolean;
}

interface NativeElement {
  index: number;
  tag?: string;
  label?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  ops?: string[];
  isPassword?: boolean;
  hasValue?: boolean;
}

interface Snap {
  windowId: number;
  snapshotId: string;
  elements: NativeElement[];
  truncated?: boolean;
  title: string;
}

/** A failure with a message already written for the model. */
class Fail extends Error {}

function mapError(e: unknown): string {
  if (e instanceof Fail) return e.message;
  if (e instanceof HelperError) {
    switch (e.code) {
      case "NO_ACCESSIBILITY":
        return ERR_NO_ACCESSIBILITY;
      case "NO_SCREEN_RECORDING":
        return ERR_NO_SCREEN_RECORDING;
      case "NO_WINDOW":
        return ERR_NATIVE_NO_WINDOW;
      case "STALE":
        return STALE_MESSAGE;
      case "NOT_FRONTMOST":
        return ERR_NATIVE_NOT_FRONTMOST;
      case "POINT_NOT_IN_APP":
        return ERR_NATIVE_POINT_NOT_IN_APP;
      case "HELPER_SPAWN":
        return ERR_HELPER_MISSING;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

const centre = (f: WindowFrame): { x: number; y: number } => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });

export function createNativeAppController(deps: NativeControllerDeps): NativeAppController {
  const { helper, pid, cursor } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const appKey = deps.bundleId ?? deps.name;

  let windowId: number | undefined;
  let lastWindow: WindowFrame | undefined;

  const call = (cmd: string, args: Record<string, unknown> = {}) => helper.call(cmd, args);
  /** `perform` and `elementFrame` carry the pid: the helper answers STALE when the snapshot belongs to another app. */
  const perform = (args: Record<string, unknown>) => call("perform", { pid, ...args });
  const urlOf = (id: number): string => `macos-app://${appKey}/${id}`;

  async function listWindows(): Promise<WindowInfo[]> {
    const res = await call("windows", { pid });
    const all = Array.isArray(res.windows) ? (res.windows as WindowInfo[]) : [];
    // Zero-area AX windows (Finder's desktop) are not something the user sees.
    const shown = all.filter((w) => w.onScreen !== false && w.minimized !== true && w.width > 0 && w.height > 0);
    // windowId 0 is not a real window (a menu bar or an AX stub); keep such entries only when nothing else is left.
    const real = shown.filter((w) => w.windowId !== 0);
    return real.length > 0 ? real : shown;
  }

  const pickDefault = (ws: WindowInfo[]): WindowInfo | undefined => ws.find((w) => w.focused) ?? ws.find((w) => w.main) ?? ws[0];

  async function currentWindow(): Promise<WindowInfo> {
    const ws = await listWindows();
    const chosen = (windowId !== undefined ? ws.find((w) => w.windowId === windowId) : undefined) ?? pickDefault(ws);
    if (!chosen) throw new Fail(ERR_NATIVE_NO_WINDOW);
    windowId = chosen.windowId;
    lastWindow = { x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height };
    if (latestShown && latestShown.windowId !== chosen.windowId) latestShown = undefined;
    return chosen;
  }

  async function winId(): Promise<number> {
    return windowId ?? (await currentWindow()).windowId;
  }

  /**
   * Run `fn` against the current window. When the helper says the cached window is gone (NO_WINDOW: the user
   * closed it, a document window was replaced), list the windows again, pick again (focused, main, first) and retry once.
   */
  async function withWindow<T>(fn: (id: number) => Promise<T>): Promise<T> {
    const id = await winId();
    try {
      return await fn(id);
    } catch (e) {
      if (!(e instanceof HelperError) || e.code !== "NO_WINDOW") throw e;
    }
    windowId = undefined;
    return await fn((await currentWindow()).windowId);
  }

  /** The snapshot the model saw last (`browse_snapshot`, or the result of `browse_act`): QA checks by index refer to it. Dropped when the window changes. */
  let latestShown: { windowId: number; elements: NativeElement[] } | undefined;

  /** Elements of recent snapshots, so a later read-back can tell which element it is looking at. */
  const knownElements = new Map<string, NativeElement[]>();
  /** Ids of big (search-sized) snapshots among them: a read-back after typing into one must use the big cap too. */
  const bigSnapshotIds = new Set<string>();

  async function takeSnapshot(maxElements: number = MAX_ELEMENTS): Promise<Snap> {
    let id = 0;
    const res = await withWindow((wid) => {
      id = wid;
      return call("snapshot", { pid, windowId: wid, maxElements });
    });
    const w = rec(res.window);
    if (typeof w.width === "number") lastWindow = { x: num(w.x), y: num(w.y), width: num(w.width), height: num(w.height) };
    const elements = Array.isArray(res.elements) ? (res.elements as NativeElement[]) : [];
    knownElements.set(str(res.snapshotId), elements);
    while (knownElements.size > 8) knownElements.delete(knownElements.keys().next().value as string);
    if (maxElements > MAX_ELEMENTS) bigSnapshotIds.add(str(res.snapshotId));
    while (bigSnapshotIds.size > 8) bigSnapshotIds.delete(bigSnapshotIds.keys().next().value as string);
    return {
      windowId: id,
      snapshotId: str(res.snapshotId),
      elements,
      truncated: res.truncated === true ? true : undefined,
      title: str(w.title),
    };
  }

  function snapshotResult(s: Snap): Record<string, unknown> {
    latestShown = { windowId: s.windowId, elements: s.elements };
    const id = s.windowId;
    const out: Record<string, unknown> = {
      snapshotId: s.snapshotId,
      url: urlOf(id),
      title: s.title,
      elements: s.elements,
      scroll: { y: 0, height: 0, atBottom: true },
    };
    if (s.truncated) {
      out.truncated = true;
      out.note = NATIVE_LIST_TRUNCATED_NOTE(MAX_ELEMENTS, TARGET_SEARCH_MAX_ELEMENTS);
    }
    return out;
  }

  async function frameOf(snapshotId: string, index: number): Promise<WindowFrame> {
    const f = await call("elementFrame", { pid, snapshotId, index });
    return { x: num(f.x), y: num(f.y), width: num(f.width), height: num(f.height) };
  }

  /** Tell the cursor overlay where the next action lands. Cosmetic: never fails the action. */
  async function pointCursor(point: { x: number; y: number }, action: CursorAction): Promise<void> {
    if (!cursor || !lastWindow) return;
    try {
      await cursor.moveTo(point, { action, windowFrame: lastWindow });
    } catch {
      /* cosmetic */
    }
  }

  /** Centre of an element, moving the cursor there when one is attached. */
  async function aimAt(snapshotId: string, index: number, action: CursorAction): Promise<WindowFrame> {
    const f = await frameOf(snapshotId, index);
    await pointCursor(centre(f), action);
    return f;
  }

  async function press(snapshotId: string, index: number): Promise<{ done: true; via: string }> {
    const aimed = cursor ? await aimAt(snapshotId, index, "click").catch(() => undefined) : undefined;
    try {
      const r = await perform({ snapshotId, index, action: "press" });
      return { done: true, via: str(r.via) || "ax" };
    } catch (e) {
      if (!(e instanceof HelperError) || e.code !== "NO_ACTION") throw e;
    }
    // The cursor already went there (and rippled): one aim per click, not two.
    const f = aimed ?? (await aimAt(snapshotId, index, "click"));
    const c = centre(f);
    await call("click", { pid, x: c.x, y: c.y });
    return { done: true, via: "event" };
  }

  /** Indices can shift between snapshots: the element is the same only when tag and label agree. Same index first, else a unique match. */
  function reidentify(orig: NativeElement, index: number, elements: NativeElement[]): NativeElement | undefined {
    const all = candidatesOf(orig, elements);
    return all.find((e) => e.index === index) ?? (all.length === 1 ? all[0] : undefined);
  }

  const candidatesOf = (orig: NativeElement, elements: NativeElement[]): NativeElement[] =>
    elements.filter((e) => (e.tag ?? "") === (orig.tag ?? "") && (e.label ?? "") === (orig.label ?? ""));

  async function typeText(snapshotId: string, index: number, text: string): Promise<{ done: true; via: string; verified?: false }> {
    if (cursor) await aimAt(snapshotId, index, "type").catch(() => undefined);
    const orig = knownElements.get(snapshotId)?.find((e) => e.index === index);
    await perform({ snapshotId, index, action: "focus" });
    let stuck = false;
    try {
      await perform({ snapshotId, index, action: "setValue", text });
      const fresh = (await takeSnapshot(bigSnapshotIds.has(snapshotId) ? TARGET_SEARCH_MAX_ELEMENTS : MAX_ELEMENTS)).elements;
      // Indices can shift after setValue.
      const el = orig ? reidentify(orig, index, fresh) : undefined;
      // The value cannot be read back: do not type again or send Select All to another control.
      if (!el) return { done: true, via: "ax", verified: false };
      if (el.isPassword) {
        // hasValue is only a proof when the field was empty before.
        if (orig?.hasValue === true) return { done: true, via: "ax", verified: false };
        stuck = el.hasValue === true;
      } else {
        stuck = el.value === text;
      }
    } catch (e) {
      if (!(e instanceof HelperError) || (e.code !== "NO_ACTION" && e.code !== "AX_FAILED")) throw e;
    }
    if (stuck) return { done: true, via: "ax" };
    await call("key", { pid, key: "Meta+a", modifiers: [] });
    await call("type", { pid, text });
    return { done: true, via: "event" };
  }

  async function scrollBy(snapshotId: string | undefined, index: number | undefined, dy: number): Promise<{ done: true }> {
    let at: { x: number; y: number };
    if (snapshotId !== undefined && index !== undefined) {
      at = centre(await aimAt(snapshotId, index, "scroll"));
    } else {
      if (!lastWindow) await currentWindow();
      at = centre(lastWindow as WindowFrame);
      await pointCursor(at, "scroll");
    }
    await call("scroll", { pid, x: at.x, y: at.y, dx: 0, dy });
    return { done: true };
  }

  /** The five perform operations of the Jev loop. */
  async function runPerform(a: { operation: string; snapshotId: string; index?: number; text?: string }): Promise<unknown> {
    const { operation, snapshotId, index, text } = a;
    const needIndex = (): number => {
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new Fail(`"${operation}" requires a non-negative integer "index".`);
      return index;
    };
    let out: Record<string, unknown>;
    switch (operation) {
      case "CLICK":
        out = await press(snapshotId, needIndex());
        break;
      case "TYPE_TEXT":
        if (typeof text !== "string") throw new Fail('"TYPE_TEXT" requires a string "text".');
        out = await typeText(snapshotId, needIndex(), text);
        break;
      case "SELECT": {
        if (typeof text !== "string") throw new Fail('"SELECT" requires a string "text".');
        const i = needIndex();
        if (cursor) await aimAt(snapshotId, i, "select").catch(() => undefined);
        const r = await perform({ snapshotId, index: i, action: "pick", text });
        out = { done: true, via: str(r.via) || "ax" };
        break;
      }
      default:
        if (operation !== "SCROLL_DOWN" && operation !== "SCROLL_UP" && !operation.startsWith("SCROLL_")) {
          throw new Fail(`Unknown operation "${operation}".`);
        }
        out = await scrollBy(snapshotId, index, operation === "SCROLL_UP" ? -SCROLL_STEP_PX : SCROLL_STEP_PX);
    }
    const id = await winId();
    return { ...out, url: urlOf(id) };
  }

  // ---- act ----

  const norm = (s: string): string => s.trim().toLowerCase();

  /** Exact label first, then substring; among elements that support `op` when any do. */
  function findByTarget(elements: NativeElement[], target: string, op?: string, exactOnly = false): NativeElement | undefined {
    const t = norm(target);
    const withOp = op ? elements.filter((e) => e.ops?.includes(op)) : [];
    for (const pool of withOp.length > 0 ? [withOp] : [elements]) {
      const exact = pool.find((e) => norm(e.label ?? "") === t);
      if (exact) return exact;
      if (exactOnly) continue;
      const part = pool.find((e) => t !== "" && norm(e.label ?? "").includes(t));
      if (part) return part;
    }
    return undefined;
  }

  interface Located {
    snapshotId: string;
    index: number;
    matched?: string;
  }

  /** `index`+`snapshotId`, or `target` against a fresh snapshot (`fresh` is reused when it is still current). */
  async function locate(step: Record<string, unknown>, op: string | undefined, fresh: () => Promise<Snap>): Promise<Located | undefined> {
    if (typeof step.target === "string" && step.target.trim() !== "") {
      const snap = await fresh();
      const t = norm(step.target);
      let el = findByTarget(snap.elements, step.target, op);
      const isExact = (e: NativeElement): boolean => norm(e.label ?? "") === t;
      if (el && (!snap.truncated || isExact(el))) return { snapshotId: snap.snapshotId, index: el.index, matched: el.label };
      if (snap.truncated) {
        // The model-sized list stops early: search the whole window. This big snapshot is never shown to the model.
        // An exact label anywhere beats a partial match in the short list.
        const big = await takeSnapshot(TARGET_SEARCH_MAX_ELEMENTS);
        const exact = findByTarget(big.elements, step.target, op, true);
        if (exact) return { snapshotId: big.snapshotId, index: exact.index, matched: exact.label };
        if (el) return { snapshotId: snap.snapshotId, index: el.index, matched: el.label };
        el = findByTarget(big.elements, step.target, op);
        if (el) return { snapshotId: big.snapshotId, index: el.index, matched: el.label };
      }
      throw new Fail(`No element matched target "${step.target}". Call browse_snapshot to see the available elements.`);
    }
    if (step.index !== undefined || step.snapshotId !== undefined) {
      if (typeof step.index !== "number" || !Number.isInteger(step.index) || step.index < 0 || typeof step.snapshotId !== "string" || step.snapshotId === "") {
        throw new Fail(`browse_act "${str(step.action)}" requires "index" (non-negative integer) together with "snapshotId".`);
      }
      return { snapshotId: step.snapshotId, index: step.index };
    }
    return undefined;
  }

  async function runWait(step: Record<string, unknown>): Promise<void> {
    const ms = typeof step.ms === "number" && Number.isFinite(step.ms) && step.ms >= 0 ? step.ms : undefined;
    if (typeof step.text === "string" && step.text.trim() !== "") {
      const needle = norm(step.text);
      const timeout = Math.min(ms ?? WAIT_TEXT_DEFAULT_MS, WAIT_MAX_MS);
      const start = now();
      for (;;) {
        const r = await withWindow((wid) => call("read", { pid, windowId: wid, maxChars: READ_MAX_CHARS }));
        if (norm(str(r.text)).includes(needle)) return;
        if (now() - start >= timeout) throw new Fail(`Timed out after ${timeout} ms waiting for the text "${step.text}".`);
        await sleep(WAIT_POLL_MS);
      }
    }
    await sleep(Math.min(ms ?? WAIT_DEFAULT_MS, WAIT_MAX_MS));
  }

  /** One browse_act action. Returns the matched label, if a target was used. */
  async function runStep(step: Record<string, unknown>, fresh: () => Promise<Snap>): Promise<string | undefined> {
    const action = step.action;
    if (typeof action !== "string") throw new Fail('browse_act requires an "action".');
    switch (action) {
      case "back":
      case "forward":
      case "reload":
      case "upload":
      case "viewport":
        throw new Fail(ERR_NATIVE_UNSUPPORTED(action));
      case "wait":
        await runWait(step);
        return undefined;
      case "click": {
        const l = await locate(step, "CLICK", fresh);
        if (!l) throw new Fail('browse_act "click" requires a "target" (or "index" with "snapshotId").');
        await press(l.snapshotId, l.index);
        return l.matched;
      }
      case "type": {
        if (typeof step.text !== "string") throw new Fail('browse_act "type" requires a string "text".');
        const l = await locate(step, "TYPE_TEXT", fresh);
        if (!l) throw new Fail('browse_act "type" requires a "target" (or "index" with "snapshotId").');
        await typeText(l.snapshotId, l.index, step.text);
        return l.matched;
      }
      case "select": {
        if (typeof step.text !== "string") throw new Fail('browse_act "select" requires a string "text".');
        const l = await locate(step, "SELECT", fresh);
        if (!l) throw new Fail('browse_act "select" requires a "target" (or "index" with "snapshotId").');
        await runPerform({ operation: "SELECT", snapshotId: l.snapshotId, index: l.index, text: step.text });
        return l.matched;
      }
      case "hover": {
        const l = await locate(step, undefined, fresh);
        if (!l) throw new Fail('browse_act "hover" requires a "target" (or "index" with "snapshotId").');
        const c = centre(await aimAt(l.snapshotId, l.index, "hover"));
        await call("move", { pid, x: c.x, y: c.y });
        return l.matched;
      }
      case "press": {
        if (typeof step.key !== "string" || step.key.trim() === "") throw new Fail('browse_act "press" requires a non-empty string "key".');
        if (isBlockedShortcut(step.key)) throw new Fail(ERR_NATIVE_SHORTCUT_BLOCKED(step.key));
        const l = await locate(step, undefined, fresh);
        if (l) {
          if (cursor) await aimAt(l.snapshotId, l.index, "press").catch(() => undefined);
          await perform({ snapshotId: l.snapshotId, index: l.index, action: "focus" });
        }
        await call("key", { pid, key: step.key, modifiers: [] });
        return l?.matched;
      }
      case "scroll": {
        const l = await locate(step, undefined, fresh);
        const amount = typeof step.amount === "number" && Number.isFinite(step.amount) ? step.amount : 1;
        const sign = step.direction === "up" ? -1 : 1;
        await scrollBy(l?.snapshotId, l?.index, sign * amount * SCROLL_STEP_PX);
        return l?.matched;
      }
      default:
        throw new Fail(`Unknown browse_act action "${action}".`);
    }
  }

  const signature = (els: NativeElement[]): string => JSON.stringify(els.map((e) => [e.label ?? "", e.value ?? "", e.checked ?? null]));

  async function act(args: unknown): Promise<unknown> {
    const a = rec(args);
    let steps: Record<string, unknown>[];
    if (Array.isArray(a.actions)) {
      if (a.actions.length === 0) throw new Fail('browse_act "actions" must not be empty.');
      if (a.actions.length > MAX_BATCH) throw new Fail(`browse_act "actions" takes at most ${MAX_BATCH} actions.`);
      steps = a.actions.map(rec);
    } else {
      steps = [a];
    }
    // A blocked shortcut anywhere in the batch refuses the whole batch: no earlier step runs.
    for (let i = 0; i < steps.length; i++) {
      const k = steps[i].action === "press" ? steps[i].key : undefined;
      if (typeof k === "string" && isBlockedShortcut(k)) {
        const msg = ERR_NATIVE_SHORTCUT_BLOCKED(k);
        throw new Fail(steps.length > 1 ? `Action ${i + 1} of ${steps.length} failed: ${msg}` : msg);
      }
    }
    const before = await takeSnapshot();
    // The first target step may reuse `before`; later ones see a UI changed by earlier steps.
    let reusable: Snap | undefined = before;
    const fresh = async (): Promise<Snap> => {
      const s = reusable ?? (await takeSnapshot());
      reusable = undefined;
      return s;
    };
    let matched: string | undefined;
    for (let i = 0; i < steps.length; i++) {
      try {
        matched = (await runStep(steps[i], fresh)) ?? matched;
      } catch (e) {
        const msg = mapError(e);
        throw new Fail(steps.length > 1 ? `Action ${i + 1} of ${steps.length} failed: ${msg}` : msg);
      }
      if (i < steps.length - 1) reusable = undefined;
    }
    await sleep(SETTLE_MS);
    const after = await takeSnapshot();
    return {
      url: urlOf(after.windowId),
      title: after.title,
      matched,
      changed: signature(before.elements) !== signature(after.elements),
      snapshot: snapshotResult(after),
    };
  }

  // ---- the controller ----

  /** Run `fn`; any failure becomes `{ error }`. */
  const safe =
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    async (...args: A): Promise<unknown> => {
      try {
        return await fn(...args);
      } catch (e) {
        return { error: mapError(e) };
      }
    };

  // ---- assert (QA checks) ----

  // Local copies: `cut` and QA_CHECK_ACTUAL_MAX_CHARS are not exported by an entry of @sideform/browser-agent the desktop imports.
  const cut = (v: string, n = ACTUAL_MAX_CHARS): string => (v.length > n ? `${v.slice(0, n - 3)}...` : v);
  const squash = (v: string): string => v.replace(/\s+/g, " ").trim().toLowerCase();

  type CheckResult = { check: unknown; passed: boolean; actual?: string; error?: string; target?: string };

  /**
   * Describes the element an index check addressed: `role "label"`, at most 80 chars. Mirrors the target format of
   * @sideform/browser-agent (not importable: the pinned v0.4.3 lacks it). The label is cut first; no label gives the role alone.
   */
  const TARGET_MAX_CHARS = 80;
  function describeTarget(el: NativeElement): string | undefined {
    const role = (el.tag ?? "").replace(/\s+/g, " ").trim();
    let label = (el.label ?? "").replace(/\s+/g, " ").trim();
    if (label === `${el.tag ?? ""} #${el.index}`) label = "";
    if (!role && !label) return undefined;
    if (!label) return role.slice(0, TARGET_MAX_CHARS);
    const prefix = role ? `${role.slice(0, 40)} ` : "";
    // As in the package: a quote inside the label becomes ', and the label is cut before it is quoted.
    label = label.replace(/"/g, "'");
    const keep = TARGET_MAX_CHARS - prefix.length - 2;
    if (label.length > keep) label = `${label.slice(0, Math.max(0, keep - 3)).replace(/[\uD800-\uDBFF]$/, "")}...`;
    return `${prefix}"${label}"`;
  }
  type Verdict = { passed: boolean; actual?: string; error?: string };

  /** `el` is the single element the check is about; `present` says whether any candidate with the same tag and label exists. */
  function elementState(present: boolean, el: NativeElement | undefined, state: string, label: string): Verdict {
    if (state === "absent") return present ? { passed: false, actual: "found" } : { passed: true };
    if (state === "hidden") return present ? { passed: false, actual: "visible" } : { passed: true, actual: "not found" };
    if (state === "exists" || state === "visible") return present ? { passed: true } : { passed: false, actual: "not found" };
    if (!el) return present ? { passed: false, error: label } : { passed: false, actual: "not found" };
    switch (state) {
      case "enabled":
        return el.disabled === true ? { passed: false, actual: "disabled" } : { passed: true };
      case "disabled":
        return el.disabled === true ? { passed: true } : { passed: false, actual: "enabled" };
      case "checked":
        if (typeof el.checked !== "boolean") return { passed: false, error: ERR_NATIVE_CHECK_NO_CHECKED };
        return el.checked ? { passed: true } : { passed: false, actual: "unchecked" };
      default: // unchecked
        if (typeof el.checked !== "boolean") return { passed: false, error: ERR_NATIVE_CHECK_NO_CHECKED };
        return el.checked ? { passed: false, actual: "checked" } : { passed: true };
    }
  }

  // The value is clipped to 200 chars by the helper, so a longer expected value can fail wrongly (a false fail, never a false pass).
  function valueCheck(el: NativeElement, check: Record<string, unknown>): Verdict {
    if (el.isPassword) {
      return check.equals === "" && el.hasValue !== true ? { passed: true } : { passed: false, actual: "value hidden (password field)" };
    }
    if (typeof el.value !== "string") return { passed: false, error: ERR_NATIVE_CHECK_NO_VALUE };
    const v = el.value;
    const okEquals = typeof check.equals !== "string" || v === check.equals;
    const okContains = typeof check.contains !== "string" || v.includes(check.contains);
    return okEquals && okContains ? { passed: true } : { passed: false, actual: cut(`value ${JSON.stringify(cut(v, 100))}`) };
  }

  async function assertChecks(args: unknown): Promise<unknown> {
    if (typeof args !== "object" || args === null) throw new Fail('assert requires an object with "checks".');
    const parsed = parseQaChecks(rec(args).checks);
    if (!parsed.ok) throw new Fail(`assert: ${parsed.errors.join("; ")}`);
    const results: CheckResult[] = [];
    let read: { text: string; truncated: boolean } | undefined;
    let big: Snap | undefined;
    let winInfo: { url: string; title: string } | undefined;
    for (const raw of parsed.value) {
      const check = raw as unknown as Record<string, unknown>;
      const type = str(check.type);
      if (type === "no_console_errors" || type === "no_failed_requests") {
        // A native app has no console or request log. The agent layer judges these two from the run history anyway.
        results.push({ check, passed: true });
      } else if (type === "text") {
        if (!read) {
          const r = await withWindow((wid) => call("read", { pid, windowId: wid, maxChars: ASSERT_READ_MAX_CHARS }));
          read = { text: squash(str(r.text)), truncated: r.truncated === true };
        }
        const needle = squash(str(check.text));
        if (needle === "") {
          results.push({ check, passed: false, error: ERR_NATIVE_CHECK_EMPTY_TEXT });
          continue;
        }
        const found = read.text.includes(needle);
        if (check.absent === true) {
          if (found) results.push({ check, passed: false, actual: "found" });
          else if (read.truncated) results.push({ check, passed: false, error: ERR_NATIVE_TEXT_ABSENT_CUT });
          else results.push({ check, passed: true });
        } else if (found) results.push({ check, passed: true });
        else results.push({ check, passed: false, actual: read.truncated ? "not found (the window text was cut, so it may be lower down)" : "not found" });
      } else if ((type === "element" || type === "value") && check.selector === undefined && typeof check.index === "number") {
        const index = check.index;
        const wid = await winId();
        const shown = latestShown && latestShown.windowId === wid ? latestShown : undefined;
        const orig = shown?.elements.find((e) => e.index === index);
        if (!orig) {
          results.push({ check, passed: false, error: ERR_NATIVE_CHECK_NO_INDEX(index) });
          continue;
        }
        if (!orig.label?.trim() || orig.label === `${orig.tag ?? ""} #${orig.index}`) {
          results.push({ check, passed: false, error: ERR_NATIVE_CHECK_NO_LABEL(index) });
          continue;
        }
        // One big snapshot for all index checks of this call, so a lower element is not missed.
        big ??= await takeSnapshot(TARGET_SEARCH_MAX_ELEMENTS);
        if (big.windowId !== shown?.windowId) {
          results.push({ check, passed: false, error: ERR_NATIVE_CHECK_NO_INDEX(index) });
          continue;
        }
        const cands = candidatesOf(orig, big.elements);
        const present = cands.length > 0;
        if (!present && big.truncated) {
          results.push({ check, passed: false, error: ERR_NATIVE_CHECK_CUT });
          continue;
        }
        const el = reidentify(orig, index, big.elements);
        const ambiguous = ERR_NATIVE_CHECK_AMBIGUOUS(index, orig.tag ?? "", orig.label ?? "");
        const target = el ? describeTarget(el) : undefined;
        const n = results.length;
        if (type === "element") {
          results.push({ check, ...elementState(present, el, str(check.state), ambiguous) });
        } else if (!present) {
          results.push({ check, passed: false, actual: "not found" });
        } else if (!el) {
          results.push({ check, passed: false, error: ambiguous });
        } else {
          results.push({ check, ...valueCheck(el, check) });
        }
        if (target && results.length > n) results[n].target = target;
        winInfo ??= { url: urlOf(big.windowId), title: big.title };
      } else if (type === "url") {
        results.push({ check, passed: false, error: ERR_NATIVE_CHECK_UNSUPPORTED("url check") });
      } else if (type === "element" || type === "value" || type === "count") {
        const what = check.selector !== undefined || type === "count" ? `${type} check with a CSS selector` : `${type} check without an index`;
        results.push({ check, passed: false, error: ERR_NATIVE_CHECK_UNSUPPORTED(what) });
      } else {
        results.push({ check, passed: false, error: ERR_NATIVE_CHECK_UNSUPPORTED(`${type || "unknown"} check`) });
      }
    }
    return { ok: true, passed: results.every((r) => r.passed), results, ...(winInfo ? { url: winInfo.url, title: winInfo.title } : {}) };
  }

  const unsupported = (name: string) => async () => ({ error: ERR_NATIVE_UNSUPPORTED(name) });

  return {
    currentWindowId: () => windowId,

    open: async () => ({ error: ERR_NATIVE_OPEN_LOCKED }),
    findImages: unsupported("findImages"),
    assert: safe(assertChecks),
    requests: unsupported("requests"),

    tabs: safe(async (args: unknown) => {
      const action = str(rec(args).action) || "list";
      if (action === "close" || action === "new") return { error: ERR_NATIVE_TABS };
      if (action !== "list" && action !== "switch") return { error: `Unknown browse_tabs action "${action}".` };
      let ws = await listWindows();
      if (action === "switch") {
        const tabId = rec(args).tabId;
        const target = ws.find((w) => w.windowId === tabId);
        if (!target) return { error: `No window with id ${String(tabId)}. Use browse_tabs list.` };
        if (target.windowId !== windowId) latestShown = undefined;
        windowId = target.windowId;
        lastWindow = { x: target.x, y: target.y, width: target.width, height: target.height };
        ws = await listWindows();
      }
      let cur = windowId !== undefined ? ws.find((w) => w.windowId === windowId) : undefined;
      if (!cur) {
        cur = pickDefault(ws);
        windowId = cur?.windowId;
        if (cur) lastWindow = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
      }
      return {
        tabs: ws.map((w) => ({ tabId: w.windowId, url: urlOf(w.windowId), title: w.title, current: w.windowId === cur?.windowId })),
        current: cur?.windowId ?? null,
      };
    }),

    snapshot: safe(async () => {
      return snapshotResult(await takeSnapshot());
    }),

    perform: safe(async (args: unknown) => {
      const a = rec(args);
      if (typeof a.snapshotId !== "string" || a.snapshotId === "") throw new Fail('browse perform requires a non-empty string "snapshotId".');
      if (typeof a.operation !== "string") throw new Fail('browse perform requires an "operation".');
      await winId();
      return runPerform({
        operation: a.operation,
        snapshotId: a.snapshotId,
        index: typeof a.index === "number" ? a.index : undefined,
        text: typeof a.text === "string" ? a.text : undefined,
      });
    }),

    act: safe(act),

    read: safe(async (args: unknown) => {
      const m = rec(args).maxChars;
      const maxChars = typeof m === "number" && Number.isFinite(m) && m > 0 ? m : READ_MAX_CHARS;
      let id = 0;
      const r = await withWindow((wid) => {
        id = wid;
        return call("read", { pid, windowId: wid, maxChars });
      });
      return { url: urlOf(id), title: str(r.title), text: str(r.text), truncated: r.truncated === true };
    }),

    screenshot: safe(async (args: unknown) => {
      const annotate = rec(args).annotate === true;
      const snap = annotate ? await takeSnapshot() : undefined;
      let id = snap?.windowId ?? 0;
      let shot: Record<string, unknown>;
      try {
        shot = await withWindow((wid) => {
          id = wid;
          if (wid === 0) throw new Fail(ERR_NATIVE_NO_CAPTURE);
          return call("screenshot", { windowId: wid, maxWidth: SCREENSHOT_MAX_WIDTH });
        });
      } catch (e) {
        if (e instanceof HelperError && e.code === "NO_SCREEN_RECORDING") {
          await call("permissions", { prompt: true }).catch(() => undefined);
        }
        throw e;
      }
      const png = str(shot.png);
      if (png === "") throw new Fail("Screenshot capture failed (empty image).");
      const img = deps.encodeImage
        ? deps.encodeImage(png, SCREENSHOT_MAX_WIDTH)
        : { data: png, width: num(shot.width), height: num(shot.height), mimeType: "image/png" };
      const title = snap?.title ?? ((await listWindows().catch(() => [])).find((w) => w.windowId === id)?.title ?? "");
      const result: Record<string, unknown> = {
        imageData: `data:${img.mimeType ?? "image/jpeg"};base64,${img.data}`,
        width: img.width,
        height: img.height,
        url: urlOf(id),
        title,
      };
      if (snap) {
        latestShown = { windowId: snap.windowId, elements: snap.elements };
        result.snapshotId = snap.snapshotId;
        result.marked = snap.elements.length;
        result.elements = snap.elements;
      }
      return result;
    }),
  };
}
