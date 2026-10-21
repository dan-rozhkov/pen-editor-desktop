// AppController for one running macOS app, on top of the `sideform-computer-use` helper
// (spec section 2). Never throws: every failure is an `{ error }` result. Electron-free:
// image re-encoding, the cursor overlay and the clock are injected.

import type { AppController } from "../appTargets";
import {
  ERR_HELPER_MISSING,
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
} from "./errors";
import { HelperError, type ComputerUseHelper } from "./helperClient";
import { isBlockedShortcut } from "./shortcuts";

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorSink {
  /** Animate the agent cursor to a global screen point (top-left origin). */
  moveTo(point: { x: number; y: number }, opts: { click: boolean; windowFrame: WindowFrame }): void;
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

  /** Elements of recent snapshots, so a later read-back can tell which element it is looking at. */
  const knownElements = new Map<string, NativeElement[]>();

  async function takeSnapshot(): Promise<Snap> {
    let id = 0;
    const res = await withWindow((wid) => {
      id = wid;
      return call("snapshot", { pid, windowId: wid, maxElements: MAX_ELEMENTS });
    });
    const w = rec(res.window);
    if (typeof w.width === "number") lastWindow = { x: num(w.x), y: num(w.y), width: num(w.width), height: num(w.height) };
    const elements = Array.isArray(res.elements) ? (res.elements as NativeElement[]) : [];
    knownElements.set(str(res.snapshotId), elements);
    while (knownElements.size > 8) knownElements.delete(knownElements.keys().next().value as string);
    return {
      windowId: id,
      snapshotId: str(res.snapshotId),
      elements,
      truncated: res.truncated === true ? true : undefined,
      title: str(w.title),
    };
  }

  function snapshotResult(s: Snap): Record<string, unknown> {
    const id = s.windowId;
    const out: Record<string, unknown> = {
      snapshotId: s.snapshotId,
      url: urlOf(id),
      title: s.title,
      elements: s.elements,
      scroll: { y: 0, height: 0, atBottom: true },
    };
    if (s.truncated) out.truncated = true;
    return out;
  }

  async function frameOf(snapshotId: string, index: number): Promise<WindowFrame> {
    const f = await call("elementFrame", { pid, snapshotId, index });
    return { x: num(f.x), y: num(f.y), width: num(f.width), height: num(f.height) };
  }

  /** Tell the cursor overlay where the next action lands. Cosmetic: never fails the action. */
  function pointCursor(point: { x: number; y: number }, click: boolean): void {
    if (!cursor || !lastWindow) return;
    try {
      cursor.moveTo(point, { click, windowFrame: lastWindow });
    } catch {
      /* cosmetic */
    }
  }

  /** Centre of an element, moving the cursor there when one is attached. */
  async function aimAt(snapshotId: string, index: number, click: boolean): Promise<WindowFrame> {
    const f = await frameOf(snapshotId, index);
    pointCursor(centre(f), click);
    return f;
  }

  async function press(snapshotId: string, index: number): Promise<{ done: true; via: string }> {
    if (cursor) await aimAt(snapshotId, index, true).catch(() => undefined);
    try {
      const r = await perform({ snapshotId, index, action: "press" });
      return { done: true, via: str(r.via) || "ax" };
    } catch (e) {
      if (!(e instanceof HelperError) || e.code !== "NO_ACTION") throw e;
    }
    const f = await aimAt(snapshotId, index, true);
    const c = centre(f);
    await call("click", { pid, x: c.x, y: c.y });
    return { done: true, via: "event" };
  }

  async function typeText(snapshotId: string, index: number, text: string): Promise<{ done: true; via: string; verified?: false }> {
    if (cursor) await aimAt(snapshotId, index, false).catch(() => undefined);
    const orig = knownElements.get(snapshotId)?.find((e) => e.index === index);
    await perform({ snapshotId, index, action: "focus" });
    let stuck = false;
    try {
      await perform({ snapshotId, index, action: "setValue", text });
      const fresh = (await takeSnapshot()).elements;
      // Indices can shift after setValue: the element is the same only when tag and label agree.
      const same = (e: NativeElement): boolean => !!orig && (e.tag ?? "") === (orig.tag ?? "") && (e.label ?? "") === (orig.label ?? "");
      let el = fresh.find((e) => e.index === index && same(e));
      if (!el) {
        const all = fresh.filter(same);
        if (all.length === 1) el = all[0];
      }
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
      at = centre(await aimAt(snapshotId, index, false));
    } else {
      if (!lastWindow) await currentWindow();
      at = centre(lastWindow as WindowFrame);
      pointCursor(at, false);
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
        if (cursor) await aimAt(snapshotId, i, true).catch(() => undefined);
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
  function findByTarget(elements: NativeElement[], target: string, op?: string): NativeElement | undefined {
    const t = norm(target);
    const withOp = op ? elements.filter((e) => e.ops?.includes(op)) : [];
    for (const pool of withOp.length > 0 ? [withOp] : [elements]) {
      const exact = pool.find((e) => norm(e.label ?? "") === t);
      if (exact) return exact;
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
      const el = findByTarget(snap.elements, step.target, op);
      if (!el) throw new Fail(`No element matched target "${step.target}". Call browse_snapshot to see the available elements.`);
      return { snapshotId: snap.snapshotId, index: el.index, matched: el.label };
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
        const c = centre(await aimAt(l.snapshotId, l.index, false));
        await call("move", { pid, x: c.x, y: c.y });
        return l.matched;
      }
      case "press": {
        if (typeof step.key !== "string" || step.key.trim() === "") throw new Fail('browse_act "press" requires a non-empty string "key".');
        if (isBlockedShortcut(step.key)) throw new Fail(ERR_NATIVE_SHORTCUT_BLOCKED(step.key));
        const l = await locate(step, undefined, fresh);
        if (l) await perform({ snapshotId: l.snapshotId, index: l.index, action: "focus" });
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

  const unsupported = (name: string) => async () => ({ error: ERR_NATIVE_UNSUPPORTED(name) });

  return {
    currentWindowId: () => windowId,

    open: async () => ({ error: ERR_NATIVE_OPEN_LOCKED }),
    findImages: unsupported("findImages"),
    assert: unsupported("assert"),
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
        result.snapshotId = snap.snapshotId;
        result.marked = snap.elements.length;
        result.elements = snap.elements;
      }
      return result;
    }),
  };
}
