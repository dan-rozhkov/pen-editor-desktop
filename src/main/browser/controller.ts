// The built-in browser's command surface (design doc
// `2026-09-18-builtin-browser-design.md` §3). Electron-free, in the style of
// ../mcp/dispatcher.ts: the page is injected via BrowserTarget so this stays
// unit-testable under plain Node/vitest. window.ts adapts a real
// WebContentsView (via TabManager.browserHandle()/newTab("browser")) into
// BrowserTarget/BrowserPageHandle.
//
// Every method below takes `unknown` and validates it before touching
// anything — these arguments arrive from an LLM through a renderer, so
// neither their shape nor their types can be trusted. Every method resolves;
// a failure comes back as `{ error: string }`, never a rejection, matching
// how pen-editor's own toolHandlers behave everywhere else in this project
// (and how dispatcher.ts's ToolCallResult never rejects either).

import { randomUUID } from "node:crypto";
import { decideBrowserNavigation } from "../navigation";
import { parseKeySpec, modifiersBitmask, resolveEditCommand } from "./keys";
// Second-pass review finding 10: BrowserTabInfo is declared once, in
// tabManager.ts — see the re-export below, where the type used to be
// declared a second time in this file.
import type { BrowserTabInfo } from "../tabManager";
import {
  ARGS_MARKER,
  FIND_IMAGES_JS,
  CLICK_JS,
  TYPE_JS,
  SCROLL_JS,
  SNAPSHOT_JS,
  PERFORM_JS,
  SIGNATURE_JS,
  READ_JS,
  TARGET_BUSY_JS,
  CURSOR_JS,
  MARKS_JS,
  REMOVE_MARKS_JS,
  HOVER_TARGET_JS,
  FOCUS_JS,
  WAIT_TEXT_JS,
} from "./pageScripts";

const SCRIPT_TEMPLATES = {
  FIND_IMAGES_JS,
  CLICK_JS,
  TYPE_JS,
  SCROLL_JS,
  SNAPSHOT_JS,
  PERFORM_JS,
  READ_JS,
  TARGET_BUSY_JS,
  CURSOR_JS,
  MARKS_JS,
  REMOVE_MARKS_JS,
  HOVER_TARGET_JS,
  FOCUS_JS,
  WAIT_TEXT_JS,
} as const;

type ScriptName = keyof typeof SCRIPT_TEMPLATES;

/** jev-loop design doc "Addendum 2, 2026-09-19" §2: default/hard-cap for
 * browse_read's `maxChars`. */
const READ_MAX_CHARS_DEFAULT = 6_000;
const READ_MAX_CHARS_HARD_CAP = 20_000;

/** The `{ changed, changes }` signature diffed before/after an action —
 * "Addendum 2" §1. `changes` entries are stable, documented category names
 * ("url" | "title" | "dom" | "text" | "main-image"), not raw field names. */
export interface EffectEvidence {
  changed: boolean;
  changes: string[];
}

/** A single element's own signature — SCOPED_SIGNATURE_JS in pageScripts.ts.
 * Review finding 4: the element actually acted on, not the whole document,
 * is the real evidence on a live page. */
interface ScopedSignature {
  nodeCount: number;
  textHash: number;
  src: string;
  valueLength: number;
  ariaExpanded: string;
  ariaSelected: string;
  checked: boolean;
}

function isScopedSignature(value: unknown): value is ScopedSignature {
  return (
    isRecord(value) &&
    typeof value.nodeCount === "number" &&
    typeof value.textHash === "number" &&
    typeof value.src === "string" &&
    typeof value.valueLength === "number" &&
    typeof value.ariaExpanded === "string" &&
    typeof value.ariaSelected === "string" &&
    typeof value.checked === "boolean"
  );
}

interface PageSignature {
  url: string;
  title: string;
  nodeCount: number;
  textLength: number;
  textHash: number;
  mainImageSrc: string;
  /** Review finding 3: absent from the original signature, so a successful
   * scroll and a scroll on a dead page were indistinguishable. */
  scrollY: number;
  /** Review finding 3: a *length*, never the focused field's content — see
   * SCOPED_SIGNATURE_JS's doc comment for the same reasoning applied to the
   * scoped-target signature. */
  focusedValueLength: number;
  /** Only present on a `phase: "after"` capture, and only when the acting
   * script stamped a target element — review finding 4. */
  scopedAfter?: ScopedSignature | null;
}

function isPageSignature(value: unknown): value is PageSignature {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.nodeCount === "number" &&
    typeof value.textLength === "number" &&
    typeof value.textHash === "number" &&
    typeof value.mainImageSrc === "string" &&
    typeof value.scrollY === "number" &&
    typeof value.focusedValueLength === "number" &&
    (value.scopedAfter === undefined || value.scopedAfter === null || isScopedSignature(value.scopedAfter))
  );
}

/** Review finding 3: type/scroll (and perform's TYPE_TEXT/SELECT/SCROLL_*)
 * had no settle at all between the action and the after-capture, and the
 * fields that would show they worked (scrollY, a focused input's value
 * length) weren't even in the signature — a successful type/scroll and a
 * dead one both reported changed: false. Short, because unlike a click
 * there is no navigation to wait for, just a paint/reflow. */
const NON_CLICK_SETTLE_MS = 50;

/** Spec `2026-09-18-browse-task-jev-loop-design.md` §1: the element table is
 * the whole request payload for /api/browse/step, so an uncapped snapshot on
 * a big page is both slow and expensive. */
export const MAX_SNAPSHOT_ELEMENTS = 120;

/** Below the frontend's own per-tool timeout, so the agent gets a real "the
 * browser command timed out" message rather than a generic tool-loop
 * timeout with no detail. */
export const BROWSER_COMMAND_TIMEOUT_MS = 20_000;

/** `open`'s own, longer budget.
 *
 * Every other command evaluates a script against a page that already
 * exists, so 20s is generous. `open` is a NAVIGATION: it waits on a remote
 * server, and measured against the live site (2026-09-19, 8 runs) an
 * amazon.com search stalled past 20s in roughly one run in four while the
 * rest finished in ~2s. The DOM-ready race below does not help those: when
 * Amazon is slow it is slow at the document level, so `dom-ready` has not
 * fired either and there is nothing to race against — the request simply
 * needs longer than a script call ever should.
 *
 * Deliberately not unbounded: a command that never returns is worse than
 * one that fails, and the frontend loop's own per-step budget still has to
 * fit several of these. */
export const BROWSER_OPEN_TIMEOUT_MS = 45_000;

/** How long a click is given to show *any* sign of having started a
 * navigation — either `getURL()` moving away from its pre-click value, or
 * `isLoading()` going true — before concluding it didn't navigate at all
 * (see runClick's doc comment / finding 7 and settleAfterClick below).
 * `isLoading()` is the signal that actually keeps this bound usable: real
 * Electron navigations flip it true essentially as soon as the navigation is
 * requested (`did-start-loading`), long before a slow commit would move
 * `getURL()` — relying on the URL alone is what made addendum F's "commit
 * takes longer than 300ms" case possible. */
const CLICK_SETTLE_TIMEOUT_MS = 300;

/** Addendum F ("Load, not commit"): once a click is seen to have started a
 * navigation (settleAfterClick's first phase), how long to wait for the
 * document to actually finish loading (`isLoading()` back to false) before
 * trusting the result's url/title. Navigation *commit* — the point
 * `getURL()` changes — is not the same as laid out: a following
 * browse_find_images measures an unlaid-out document at commit, where every
 * getBoundingClientRect() is 0x0, so the size filter drops every image and
 * the tool reports count: 0. This is a separate, longer budget than
 * CLICK_SETTLE_TIMEOUT_MS because a real page load is routinely slower than
 * the time it takes just to observe that a navigation started at all. */
const CLICK_LOAD_SETTLE_TIMEOUT_MS = 8_000;

/** How long an action may wait for a control that disabled *itself* while
 * its handler runs (see pageScripts.ts's TARGET_BUSY_HELPER_JS for the
 * case, from upstream jev-ultrafast PR #58). Paid only when the acting
 * script reports `__targetSelfDisabled` — a control that was already
 * disabled before the action, or one that never goes busy, waits zero. The
 * bound is what keeps a control that never re-enables (a button disabled
 * for good after submit) from burning the whole command timeout: after it,
 * the observation proceeds anyway, exactly as it did before this wait
 * existed. */
const BUSY_SETTLE_TIMEOUT_MS = 3_000;
const BUSY_POLL_INTERVAL_MS = 50;

/** Bounds `moveCursor`'s own CURSOR_JS call — a little above CURSOR_JS's own
 * internal ~1.15s backstop, so that backstop (which always resolves with a
 * best-effort position rather than hanging) is what normally fires, not
 * this outer timeout.
 *
 * The cursor step runs *inside* the same closure `withCommandTimeout` bounds
 * (see `moveCursor`'s own call sites in `act`/`perform`), so its own bound
 * is added to that command's budget rather than carved out of it (see
 * `BrowserController.cursorBudgetMs`) — a cosmetic overlay must never be
 * what pushes a slow-but-working command over its timeout. `moveCursor`'s
 * own call to `withTimeout` is still independently bounded by
 * `Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS)`, so a short caller-supplied
 * `timeoutMs` still gets a correspondingly short-bounded cursor call. */
const CURSOR_TIMEOUT_MS = 1_500;

/** How long the command queue waits for a TIMED-OUT command's abandoned work
 * to settle before letting the next command run anyway — see
 * `BrowserController.overrun`. */
const OVERRUN_GRACE_MS = 10_000;

/** `open`'s DOM-ready-not-full-load fix: `webContents.loadURL()` resolves
 * only at `did-finish-load` — every subresource, including ads/trackers on a
 * heavy commercial page, which routinely blows past
 * BROWSER_COMMAND_TIMEOUT_MS. `open` instead resolves once the DOM is ready
 * (see `BrowserPageHandle.onceDomReady`) and gives the page this short,
 * bounded grace period to finish the *full* load too, so the common fast
 * page still reports `loaded: true`. Well under BROWSER_COMMAND_TIMEOUT_MS —
 * this is a courtesy wait, not a correctness requirement, so a slow page
 * simply returns with `loaded: false` instead of blocking the command. */
const OPEN_LOAD_GRACE_MS = 1_500;

/** Second-pass review finding 6: extra budget `tabs({action:"new", url})`
 * gives its own outer command on top of `openTimeoutMs`, so its nested
 * `open()` call's identically-`openTimeoutMs`-budgeted timeout always
 * resolves first — see the doc comment where this is used, in `tabs()`. */
const OPEN_COMMAND_MARGIN_MS = 5_000;

/** `act`'s `wait` action (design doc `2026-09-23-full-browser-use-design.md`):
 * default and hard cap for `ms`, mirroring `browse_read`'s
 * default/hard-cap-for-a-numeric-arg shape (`READ_MAX_CHARS_DEFAULT`/
 * `_HARD_CAP` above) — validated and clamped here, not left to whatever a
 * caller asks for, since this is untrusted LLM input. */
const WAIT_DEFAULT_MS = 3_000;
const WAIT_MAX_MS = 15_000;
/** How often `runWait` polls the page for `text` while waiting. */
const WAIT_POLL_INTERVAL_MS = 100;

/** Second-pass review finding 7: bounds `screenshot({ annotate: true })`'s
 * post-MARKS_JS paint wait (`waitForPaint`) — a double requestAnimationFrame
 * normally resolves within a frame or two (well under this), but a hidden
 * `WebContentsView` never ticks `requestAnimationFrame` at all, so this is
 * what keeps that case from hanging the whole screenshot command. */
const PAINT_WAIT_TIMEOUT_MS = 100;

/** A browser tab's page, as the controller needs to drive it. Electron-free
 * — window.ts supplies the real implementation over a WebContentsView. */
export interface BrowserPageHandle {
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /**
   * True while the page is mid-navigation (Electron's
   * `webContents.isLoading()`). Addendum F: the post-click settle wait uses
   * this to wait for the document to actually finish loading rather than
   * merely for `getURL()` to change at navigation commit — see
   * CLICK_LOAD_SETTLE_TIMEOUT_MS's doc comment.
   */
  isLoading(): boolean;
  /**
   * Resolves once the current navigation's DOM is ready — see
   * `TabViewHandle.onceDomReady`'s doc comment (tabManager.ts) for the full
   * rationale. `open` races this against `loadURL()` so a heavy page's
   * subresources don't have to finish before the command returns.
   */
  onceDomReady(): Promise<void>;
  /**
   * Optional: true while this page's view is actually being drawn (Electron's
   * `View#getVisible()`). A hidden `WebContentsView` stops firing
   * `requestAnimationFrame`, so CURSOR_JS's animation never starts and the
   * script only settles via its internal backstop — burning ~1.15s per
   * click/type/select for an overlay nobody is looking at (this repo has
   * been bitten by rAF-in-a-hidden-tab before — get_screenshot). `moveCursor`
   * skips the cursor step entirely when this returns false. A handle that
   * doesn't implement it (every fake page in the test suite, notably) behaves
   * as before — the cursor always runs.
   */
  isVisible?(): boolean;
  /**
   * Optional: full browser use (design doc `2026-09-23-full-browser-use-design.md`).
   * Captures the tab's current viewport as a downscaled JPEG — window.ts's
   * real implementation is `webContents.capturePage()` resized to ≤1280px
   * wide and encoded via `nativeImage.toJPEG(70)`. Returns `null` (not a
   * rejection) on an empty capture (`image.isEmpty()`) or any other capture
   * failure — `screenshot()` turns that into a `{ error }` result rather
   * than handing back a blank image.
   */
  capture?(): Promise<{ imageData: string; width: number; height: number } | null>;
  /**
   * Optional: sends a raw Chrome DevTools Protocol command against this
   * tab's attached debugger session (`webContents.debugger` in window.ts,
   * attached once per browser tab at creation — see CLAUDE.md's "Full
   * browser use" section). Backs `act`'s `press` (`Input.dispatchKeyEvent`)
   * and `hover` (`Input.dispatchMouseEvent`) — both are trusted, OS-level
   * input events, unlike a page-script `dispatchEvent`, which is what makes
   * `press` reach an app's real keydown handlers and `hover` genuinely
   * trigger `:hover`/`mouseover`. Absent (or rejecting) when the debugger
   * failed to attach (e.g. real DevTools already attached to this tab) —
   * `press`/`hover` report a clear `{ error }` in that case rather than
   * silently doing nothing.
   */
  sendCdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Optional: drains (and clears) the JS dialogs (`alert`/`confirm`/
   * `prompt`/`beforeunload`) this tab's CDP session auto-handled since the
   * last drain — see CLAUDE.md's dialog policy. `withCommandTimeout` calls
   * this after every command and merges a non-empty result into that
   * command's own `{ dialogs }` field, so a dialog raised mid-action is
   * reported back to the agent instead of just silently vanishing.
   */
  drainDialogs?(): { type: string; message: string }[];
}

// BrowserTabInfo is declared once, in tabManager.ts (second-pass review
// finding 10) — before this, controller.ts and tabManager.ts each declared
// their own structurally-identical copy (one comment even said so:
// tabManager.ts's used to read "structurally identical to BrowserTarget's
// own BrowserTabInfo there"), which is exactly the kind of pair that can
// silently drift. Re-exported here (imported at the top of this file) so
// every existing `import { BrowserTabInfo } from "./controller"` keeps
// working.
export type { BrowserTabInfo };

export interface BrowserTarget {
  /** Resolves the tab to drive, creating one if none exists. */
  ensurePage(): Promise<BrowserPageHandle>;
  /** Null when no browser tab is open — read-only commands fail cleanly. */
  currentPage(): BrowserPageHandle | null;
  /**
   * Optional: full browser use's `tabs` command. All four are present or
   * all four are absent in practice (window.ts implements them together
   * over TabManager) — `tabs()` reports "not supported" up front if any is
   * missing, rather than failing action-by-action.
   */
  listPages?(): Promise<BrowserTabInfo[]>;
  selectPage?(tabId: number): Promise<boolean>;
  closePage?(tabId: number): Promise<boolean>;
  newPage?(url?: string): Promise<BrowserTabInfo>;
  /**
   * Optional: review finding 6. Every currently open browser tab's own
   * `BrowserPageHandle`, tagged with its `tabId` — used by `mergeDialogs` to
   * drain dialogs from *every* browser tab, not just `currentPage()`. Without
   * this, a dialog on a tab that isn't the one a command happens to act on
   * (a popup that raised its own dialog, or the tab a command just switched
   * away from) was silently dropped instead of surfacing on the next command
   * that could report it. Absent on any `BrowserTarget` that predates this
   * (every unit-test fake, notably) — `mergeDialogs` degrades to draining
   * only `currentPage()`, the previous behavior.
   */
  pageHandles?(): Promise<{ tabId: number; page: BrowserPageHandle }[]>;
}

export type BrowserCommandResult = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(message: string): BrowserCommandResult {
  return { error: message };
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(toMessage(err)));
      },
    );
  });
}

function validateOpenArgs(args: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (!isRecord(args) || typeof args.url !== "string" || args.url.trim() === "") {
    return { ok: false, error: 'browse_open requires a non-empty string "url".' };
  }
  const url = args.url.trim();
  if (decideBrowserNavigation(url) !== "allow") {
    return { ok: false, error: `browse_open only supports http(s) URLs, got: ${url}` };
  }
  return { ok: true, url };
}

interface ValidatedReadArgs {
  maxChars: number;
  selector?: string;
}

function validateReadArgs(args: unknown): { ok: true; value: ValidatedReadArgs } | { ok: false; error: string } {
  if (args !== undefined && !isRecord(args)) {
    return { ok: false, error: "browse_read requires an object (or no arguments)." };
  }
  const raw = isRecord(args) ? args : {};

  let maxChars = READ_MAX_CHARS_DEFAULT;
  if (raw.maxChars !== undefined) {
    if (typeof raw.maxChars !== "number" || !Number.isFinite(raw.maxChars) || raw.maxChars <= 0) {
      return { ok: false, error: 'browse_read requires "maxChars" to be a positive number when provided.' };
    }
    // Hard cap regardless of what the caller asked for — the default (6000)
    // is a courtesy, the cap (20000) is not negotiable.
    maxChars = Math.min(raw.maxChars, READ_MAX_CHARS_HARD_CAP);
  }

  let selector: string | undefined;
  if (raw.selector !== undefined) {
    if (typeof raw.selector !== "string" || raw.selector.trim() === "") {
      return { ok: false, error: 'browse_read requires "selector" to be a non-empty string when provided.' };
    }
    selector = raw.selector;
  }

  return { ok: true, value: { maxChars, selector } };
}

// Full browser use (design doc `2026-09-23-full-browser-use-design.md`)
// added select/press/hover/reload/wait to the original five.
type ActAction = "click" | "type" | "select" | "press" | "hover" | "scroll" | "back" | "forward" | "reload" | "wait";

const ACT_ACTIONS: readonly ActAction[] = [
  "click",
  "type",
  "select",
  "press",
  "hover",
  "scroll",
  "back",
  "forward",
  "reload",
  "wait",
];

function isActAction(value: unknown): value is ActAction {
  return typeof value === "string" && (ACT_ACTIONS as readonly string[]).includes(value);
}

/** Shared by `act`'s click/type/select/press/hover: an `index` requires a
 * `snapshotId` alongside it (and vice versa) — this only validates the
 * *shape*, the staleness/cross-tab check happens where `perform()` already
 * does it, for the actions that route there. */
function validateIndexSnapshot(
  args: Record<string, unknown>,
  actionLabel: string,
): { ok: true; index: number; snapshotId: string } | { ok: false; error: string } {
  if (!isNonNegativeInteger(args.index)) {
    return {
      ok: false,
      error: `browse_act "${actionLabel}" requires a non-negative integer "index" (with "snapshotId") or a string "target".`,
    };
  }
  if (typeof args.snapshotId !== "string" || args.snapshotId.trim() === "") {
    return {
      ok: false,
      error: `browse_act "${actionLabel}" with "index" also requires a non-empty string "snapshotId".`,
    };
  }
  return { ok: true, index: args.index, snapshotId: args.snapshotId };
}

function validateScreenshotArgs(
  args: unknown,
): { ok: true; value: { annotate: boolean } } | { ok: false; error: string } {
  if (args !== undefined && !isRecord(args)) {
    return { ok: false, error: "browse_screenshot requires an object (or no arguments)." };
  }
  const raw = isRecord(args) ? args : {};
  if (raw.annotate !== undefined && typeof raw.annotate !== "boolean") {
    return { ok: false, error: 'browse_screenshot requires "annotate" to be a boolean when provided.' };
  }
  return { ok: true, value: { annotate: raw.annotate === true } };
}

type TabsAction = "list" | "switch" | "close" | "new";

function isTabsAction(value: unknown): value is TabsAction {
  return value === "list" || value === "switch" || value === "close" || value === "new";
}

interface ValidatedTabsArgs {
  action: TabsAction;
  tabId?: number;
  url?: string;
}

function validateTabsArgs(args: unknown): { ok: true; value: ValidatedTabsArgs } | { ok: false; error: string } {
  if (!isRecord(args) || !isTabsAction(args.action)) {
    return {
      ok: false,
      error: `browse_tabs requires an "action" of "list", "switch", "close", or "new" (got ${
        isRecord(args) ? JSON.stringify(args.action) : JSON.stringify(args)
      }).`,
    };
  }
  const action = args.action;
  let tabId: number | undefined;
  if (args.tabId !== undefined) {
    if (!isNonNegativeInteger(args.tabId)) {
      return { ok: false, error: 'browse_tabs requires "tabId" to be a non-negative integer when provided.' };
    }
    tabId = args.tabId;
  }
  if ((action === "switch" || action === "close") && tabId === undefined) {
    return { ok: false, error: `browse_tabs "${action}" requires a "tabId".` };
  }
  let url: string | undefined;
  if (args.url !== undefined) {
    if (typeof args.url !== "string" || args.url.trim() === "") {
      return { ok: false, error: 'browse_tabs requires "url" to be a non-empty string when provided.' };
    }
    const trimmed = args.url.trim();
    if (decideBrowserNavigation(trimmed) !== "allow") {
      return { ok: false, error: `browse_tabs only supports http(s) URLs, got: ${trimmed}` };
    }
    url = trimmed;
  }
  return { ok: true, value: { action, tabId, url } };
}

type PerformOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN";

const PERFORM_OPERATIONS: readonly PerformOperation[] = ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN"];

// Addendum A: index is required only for these three — SCROLL_UP/SCROLL_DOWN
// act on the page itself and must be accepted with no index at all (they
// used to always fail at the bridge because index was unconditionally
// required). WAIT is not a member of PerformOperation/PERFORM_OPERATIONS at
// all — it is never sent to perform(); the frontend loop handles it locally
// by sleeping and taking a fresh snapshot.
const INDEXED_OPERATIONS: readonly PerformOperation[] = ["CLICK", "TYPE_TEXT", "SELECT"];

function isPerformOperation(value: unknown): value is PerformOperation {
  return typeof value === "string" && (PERFORM_OPERATIONS as readonly string[]).includes(value);
}

interface ValidatedPerformArgs {
  /** Present only for CLICK/TYPE_TEXT/SELECT — see INDEXED_OPERATIONS. */
  index?: number;
  operation: PerformOperation;
  text?: string;
  snapshotId: string;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validatePerformArgs(args: unknown): { ok: true; value: ValidatedPerformArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "browse perform requires an object." };
  }
  if (typeof args.snapshotId !== "string" || args.snapshotId.trim() === "") {
    return { ok: false, error: 'browse perform requires a non-empty string "snapshotId".' };
  }
  if (!isPerformOperation(args.operation)) {
    return {
      ok: false,
      error: `browse perform requires an "operation" of ${PERFORM_OPERATIONS.join(", ")} (got ${JSON.stringify(args.operation)}).`,
    };
  }
  const operation = args.operation;
  const indexRequired = (INDEXED_OPERATIONS as readonly string[]).includes(operation);
  let index: number | undefined;
  if (indexRequired) {
    if (!isNonNegativeInteger(args.index)) {
      return { ok: false, error: `browse perform "${operation}" requires a non-negative integer "index".` };
    }
    index = args.index;
  } else if (args.index !== undefined) {
    // Not required for SCROLL_UP/SCROLL_DOWN, but if the caller passed one
    // anyway, it must still be well-formed rather than silently ignored.
    if (!isNonNegativeInteger(args.index)) {
      return { ok: false, error: `browse perform "${operation}" requires "index" to be a non-negative integer when provided.` };
    }
    index = args.index;
  }
  if (args.text !== undefined && typeof args.text !== "string") {
    return { ok: false, error: 'browse perform requires "text" to be a string when provided.' };
  }
  if ((operation === "TYPE_TEXT" || operation === "SELECT") && typeof args.text !== "string") {
    return { ok: false, error: `browse perform "${operation}" requires a string "text".` };
  }
  return {
    ok: true,
    value: { index, operation, text: args.text, snapshotId: args.snapshotId },
  };
}

export class BrowserController {
  private readonly timeoutMs: number;
  private readonly openTimeoutMs: number;

  // The most recent snapshot() call's id, together with the exact page it
  // was taken against — perform() compares its caller-supplied snapshotId
  // (and the *current* page) against this single slot and hard-errors on
  // either mismatch — see "Credentials"/§1 of the jev-loop design doc: a
  // page that re-rendered between snapshot and perform must never be
  // silently acted on, so this is a rejection, not a best-effort lookup.
  //
  // Finding 5: this used to be a bare snapshotId string, justified by "there
  // is only ever one browser tab" — but File ▸ New Browser Tab and popups
  // both make more than one possible, and `browserHandle()` (window.ts)
  // picks active-if-browser else last-created, so which tab a command hits
  // depends on what the user clicked. Without the page identity check, a
  // snapshot on tab A followed by a perform after the user switched to tab B
  // would pass this staleness check (the id matches) and only then fail
  // in-page against tab B's DOM with a misleading "no element at index N"
  // error, instead of an accurate cross-tab message. Comparing the page
  // reference itself needs no new "tab id" concept in the Electron-free
  // BrowserPageHandle — window.ts hands back the same object for a given tab
  // on every call, and a different object for a different tab.
  private lastSnapshot: { id: string; page: BrowserPageHandle } | null = null;

  /** Second-pass review finding 8: a FIFO queue every public command
   * (open/act/findImages/snapshot/perform/read/screenshot/tabs) runs
   * through, via `runExclusive` — nothing previously serialized concurrent
   * `BrowserController` calls, so two tool calls the frontend fired without
   * waiting for each other could interleave (a `screenshot({annotate:true})`
   * overlaying marks in the middle of an unrelated command's signature
   * capture; `lastSnapshot` being replaced mid-`perform` by a `snapshot()`
   * that raced it). Each command's own `withCommandTimeout` bound already
   * guarantees it eventually settles, so a plain FIFO — no separate queue
   * timeout — is enough: nothing can wedge the queue forever short of a
   * command hanging past its own timeout, which `withCommandTimeout` doesn't
   * allow. Each command's timeout starts only once it actually begins
   * running `fn` (inside `runExclusive`'s callback), not while it's still
   * waiting in the queue — a command queued behind a slow one is not charged
   * for time it spent waiting.
   *
   * A command that itself calls another public command internally (`tabs`'s
   * "new"+url case calling `open`; `act`'s index-based branches calling
   * `perform`) must call that command's `*Unlocked` implementation directly,
   * never the public method — calling back into `runExclusive` while already
   * inside it would enqueue behind itself and deadlock forever, since the
   * outer call can't finish (and let the queue advance) until the inner call
   * it's waiting on does.
   *
   * `runExclusive` starts `fn` synchronously (no `.then()` hop at all) when
   * the queue is idle, rather than always chaining onto `mutexTail` — this
   * matters beyond micro-optimization: several existing behaviors (e.g.
   * `withCommandTimeout` capturing `pageHandles`/`currentPage()` "before
   * `fn()` runs") were written, and tested, assuming a command begins
   * executing in the same synchronous tick it's called in, up to its own
   * first `await`. Always deferring the start by one `Promise.then()` hop
   * (even for the common, uncontended case of one in-flight command at a
   * time) would push that capture one microtask later than callers observe
   * — silently changing what "before" means relative to code that runs
   * right after the call, with no queueing actually needed to explain it. */
  private mutexBusy = false;
  private mutexTail: Promise<void> = Promise.resolve();
  /** Set by `withCommandTimeout` when a command TIMES OUT: its `fn()` keeps
   * running in the background (a promise can't be cancelled), so releasing
   * the queue the moment the timeout fires would let the next command start
   * while the late click/type/`REMOVE_MARKS_JS` still lands mid-way through
   * its before/after captures (third-pass review). The next command waits
   * for that work to settle — bounded by OVERRUN_GRACE_MS, since the work
   * may be blocked forever (a page script behind a dialog). */
  private overrun: Promise<void> | null = null;

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const start = (): Promise<T> => {
      this.mutexBusy = true;
      // Checked here, inside `start`, not at enqueue time: a command already
      // waiting in the queue when its predecessor timed out must wait out
      // that predecessor's abandoned work too (see `overrun`).
      const pendingOverrun = this.overrun;
      this.overrun = null;
      const p = pendingOverrun ? pendingOverrun.then(fn) : fn();
      p.then(
        () => {
          this.mutexBusy = false;
        },
        () => {
          this.mutexBusy = false;
        },
      );
      return p;
    };
    const result = this.mutexBusy ? this.mutexTail.then(start, start) : start();
    // Chained regardless of `result`'s outcome — a rejecting command must
    // still let the next queued one run, and this tail itself must never
    // reject (an unhandled rejection here would break every future queue
    // entry), so both branches resolve.
    this.mutexTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Same staleness/cross-tab guard `perform()` applies to its own
   * `snapshotId`, factored out (review finding 5) so `runPress`/`runHover`
   * can apply it too when they're given `index`+`snapshotId` — before this,
   * those two skipped the guard entirely and went straight to a page-script
   * lookup, so a stale or cross-tab snapshotId silently failed with "no
   * element" instead of the same clear staleness error `perform()` gives.
   * Returns an error result on mismatch, `null` when `snapshotId` is current
   * for `page`. */
  private checkSnapshotStale(snapshotId: string, page: BrowserPageHandle): BrowserCommandResult | null {
    if (!this.lastSnapshot || snapshotId !== this.lastSnapshot.id || page !== this.lastSnapshot.page) {
      return errorResult(
        this.lastSnapshot && snapshotId === this.lastSnapshot.id
          ? "Stale snapshotId — a different browser tab is now active. Call browser snapshot again on this tab before perform."
          : "Stale or unknown snapshotId — the page may have changed since that snapshot. Call browser snapshot again before perform.",
      );
    }
    return null;
  }

  // The last known viewport position CURSOR_JS's overlay landed at — fed
  // back as `from` on the next moveCursor call so consecutive moves chain
  // from where the cursor actually is rather than resetting to a default
  // start point every command. Updated only when a cursor call reports
  // finite numeric x/y; a failed or no-op cursor call leaves it as-is.
  private cursorPosition: { x: number; y: number } | null = null;
  private readonly cursorEnabled: boolean;

  /** The cursor step runs inside the command closure `withCommandTimeout`
   * bounds, so its own bound is added to that command's budget rather than
   * taken out of it — a cosmetic overlay must never be what pushes a
   * slow-but-working command over its timeout. Zero when the cursor is
   * disabled, since no cursor step runs at all. */
  private get cursorBudgetMs(): number {
    return this.cursorEnabled ? Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS) : 0;
  }

  constructor(
    private readonly target: BrowserTarget,
    opts?: { timeoutMs?: number; openTimeoutMs?: number; cursor?: boolean },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? BROWSER_COMMAND_TIMEOUT_MS;
    // An explicitly supplied timeoutMs bounds EVERY command including
    // open — a caller (or a test) that asks for a short budget means it.
    // open only gets its own longer default when nothing was specified.
    this.openTimeoutMs =
      opts?.openTimeoutMs ?? opts?.timeoutMs ?? BROWSER_OPEN_TIMEOUT_MS;
    this.cursorEnabled = opts?.cursor ?? true;
  }

  /** Runs CURSOR_JS to move the built-in browser's visible cursor overlay
   * toward the target of an upcoming action, before that action's own
   * before-signature capture — see CURSOR_JS's doc comment (pageScripts.ts)
   * for why the ordering matters. A no-op when `cursorEnabled` is false
   * (PEN_DESKTOP_BROWSER_CURSOR=off — config.ts's
   * `resolveBrowserCursorEnabled`), and also a no-op when the driven page
   * reports itself not visible (`page.isVisible?.() === false`) — a hidden
   * `WebContentsView` never fires `requestAnimationFrame`, so the animation
   * would only ever settle via its internal backstop, paying ~1.15s for an
   * overlay nobody can see. Every failure — a rejecting/throwing
   * executeJavaScript, a timeout, a malformed response — is swallowed: the
   * cursor is cosmetic, and must never turn a working browser command into
   * an error or a timeout of its own.
   *
   * Runs inside the same command closure `withCommandTimeout` bounds — see
   * `cursorBudgetMs`'s doc comment for why callers extend that budget by the
   * cursor's own bound rather than letting this eat into it. */
  private async moveCursor(
    page: BrowserPageHandle,
    spec: {
      action: "click" | "type" | "select" | "scroll" | "hover" | "press";
      target?: string;
      snapshotId?: string;
      index?: number;
    },
  ): Promise<void> {
    if (!this.cursorEnabled) return;
    if (page.isVisible?.() === false) return;
    try {
      const scriptArgs = { ...spec, from: this.cursorPosition };
      // Bounded by the smaller of CURSOR_TIMEOUT_MS and this controller's
      // own configured timeoutMs — same convention as
      // settleWhileTargetBusy/waitForUrlChange/waitForLoadStop above, so a
      // caller (or a test) that asks for a short overall budget also gets a
      // short-bounded cursor call rather than one that can outlive the
      // command it's decorating.
      const result = await withTimeout(
        this.executeScript(page, "CURSOR_JS", scriptArgs),
        Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS),
        "Cursor animation timed out.",
      );
      if (
        isRecord(result) &&
        typeof result.x === "number" &&
        Number.isFinite(result.x) &&
        typeof result.y === "number" &&
        Number.isFinite(result.y)
      ) {
        this.cursorPosition = { x: result.x, y: result.y };
      }
    } catch {
      // Cosmetic only — see this method's doc comment.
    }
  }

  /** Resolves once the DOM is ready, not once every subresource has
   * finished — `webContents.loadURL()`'s own promise resolves at
   * `did-finish-load`, which on a heavy commercial page (ads, trackers,
   * video) routinely exceeds BROWSER_COMMAND_TIMEOUT_MS even though the page
   * is perfectly usable well before that. The DOM-ready listener
   * (`page.onceDomReady()`) is armed *before* `loadURL` is called — arming
   * it after risks missing an event that fires while `loadURL` is still
   * synchronously setting up the navigation.
   *
   * Both promises are raced. If the full load settles first (fast page, or a
   * genuine navigation error before the DOM ever became ready), that result
   * is trusted outright — a rejection here is surfaced as `{ error }`, same
   * as before this fix. If DOM-ready wins, the page gets a short, bounded
   * grace period (OPEN_LOAD_GRACE_MS) to finish the full load too, so the
   * common fast page still comes back `loaded: true`; if the grace period
   * expires first, the command returns with `loaded: false` and the load
   * promise's eventual settlement (success or failure) is one that already
   * has both a resolve and a reject handler attached below, so it can never
   * become an unhandled rejection — a subresource failing after the page is
   * usable is not treated as this command failing.
   *
   * Second-pass review finding 8: this public method just serializes onto
   * the command queue (`runExclusive`) and delegates to `openUnlocked` for
   * the actual work — see `runExclusive`'s doc comment for why `tabs()`'s
   * internal "new"+url case calls `openUnlocked` directly instead of this. */
  async open(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.openUnlocked(args));
  }

  private async openUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateOpenArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    return this.withCommandTimeout(async () => {
      const page = await this.target.ensurePage();

      // Armed before loadURL() is called — see the doc comment above.
      const domReadyPromise = page.onceDomReady();
      const loadPromise = page.loadURL(validated.url);

      type Outcome = { via: "dom-ready" } | { via: "load"; error: Error | null };
      // .then's reject handler here consumes loadPromise's rejection into a
      // resolved value — this is what keeps a late load failure from ever
      // reaching Node as an unhandled rejection, regardless of which branch
      // below is taken or how long after this function returns it settles.
      const loadOutcome: Promise<Outcome> = loadPromise.then(
        () => ({ via: "load", error: null }),
        (err: unknown) => ({ via: "load", error: err instanceof Error ? err : new Error(toMessage(err)) }),
      );
      const domReadyOutcome: Promise<Outcome> = domReadyPromise.then(() => ({ via: "dom-ready", error: null }));

      const first = await Promise.race([domReadyOutcome, loadOutcome]);

      if (first.via === "load") {
        // The full load settled before the DOM even became ready — either a
        // fast page (nothing left to wait for) or a genuine navigation
        // failure. Either way there is no "DOM ready but still loading"
        // state to report, so this is the whole answer.
        if (first.error) throw first.error;
        return { url: page.getURL(), title: page.getTitle(), loaded: true };
      }

      const graceOutcome = await Promise.race([
        loadOutcome,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), OPEN_LOAD_GRACE_MS)),
      ]);
      // A load failure that happens *after* DOM-ready already succeeded is
      // not a command failure (e.g. a stalled subresource) — it just means
      // the full load never completed, so `loaded` stays false.
      const loaded = graceOutcome !== "timeout" && graceOutcome.via === "load" && graceOutcome.error === null;
      return { url: page.getURL(), title: page.getTitle(), loaded };
    }, this.openTimeoutMs);
  }

  /** Second-pass review finding 8: public entry point — serializes onto the
   * command queue and delegates to `actUnlocked`. */
  async act(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.actUnlocked(args));
  }

  private async actUnlocked(args: unknown): Promise<BrowserCommandResult> {
    if (!isRecord(args) || !isActAction(args.action)) {
      return errorResult(
        `browse_act requires an "action" of "click", "type", "select", "press", "hover", "scroll", "back", ` +
          `"forward", "reload", or "wait" (got ${
            isRecord(args) ? JSON.stringify(args.action) : JSON.stringify(args)
          }).`,
      );
    }
    const action = args.action;

    if (action === "reload") {
      return this.withCommandTimeout(async () => {
        const page = this.target.currentPage();
        if (!page) return errorResult("No browser tab is open — call browse_open first.");
        const previousUrl = page.getURL();
        page.reload();
        // Same two-phase settle as a click's navigation (addendum F) —
        // reload() is fire-and-forget just like goBack()/goForward(), so
        // "did it even start" and "has it finished" are separate questions.
        await this.waitForNavigationStart(page, previousUrl, CLICK_SETTLE_TIMEOUT_MS);
        await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
        return { url: page.getURL(), title: page.getTitle() };
      });
    }

    if (action === "wait") {
      if (args.text !== undefined && (typeof args.text !== "string" || args.text.trim() === "")) {
        return errorResult('browse_act "wait" requires "text" to be a non-empty string when provided.');
      }
      if (args.ms !== undefined && (typeof args.ms !== "number" || !Number.isFinite(args.ms) || args.ms < 0)) {
        return errorResult('browse_act "wait" requires "ms" to be a non-negative number when provided.');
      }
      const ms = Math.min(typeof args.ms === "number" ? args.ms : WAIT_DEFAULT_MS, WAIT_MAX_MS);
      const text = typeof args.text === "string" ? args.text : undefined;
      // Own budget, not this.timeoutMs — a caller waiting up to WAIT_MAX_MS
      // (15s) must not be cut off by the default 20s command timeout minus
      // whatever else this closure does; a little headroom on top of `ms`
      // covers the poll/script round trips themselves.
      return this.withCommandTimeout(() => this.runWait(text, ms), ms + 5_000);
    }

    if (action === "press") {
      if (typeof args.key !== "string" || args.key.trim() === "") {
        return errorResult('browse_act "press" requires a non-empty string "key".');
      }
      const key = args.key;
      let focusTarget: string | undefined;
      let focusIndex: number | undefined;
      let focusSnapshotId: string | undefined;
      if (args.target !== undefined) {
        if (typeof args.target !== "string" || args.target.trim() === "") {
          return errorResult('browse_act "press" requires "target" to be a non-empty string when provided.');
        }
        focusTarget = args.target;
      }
      if (args.index !== undefined || args.snapshotId !== undefined) {
        const validated = validateIndexSnapshot(args, "press");
        if (!validated.ok) return errorResult(validated.error);
        focusIndex = validated.index;
        focusSnapshotId = validated.snapshotId;
      }
      return this.withCommandTimeout(
        () => this.runPress(key, { target: focusTarget, index: focusIndex, snapshotId: focusSnapshotId }),
        this.timeoutMs + this.cursorBudgetMs,
      );
    }

    if (action === "hover") {
      let hoverTarget: string | undefined;
      let hoverIndex: number | undefined;
      let hoverSnapshotId: string | undefined;
      if (typeof args.target === "string" && args.target.trim() !== "") {
        hoverTarget = args.target;
      } else if (args.index !== undefined || args.snapshotId !== undefined) {
        const validated = validateIndexSnapshot(args, "hover");
        if (!validated.ok) return errorResult(validated.error);
        hoverIndex = validated.index;
        hoverSnapshotId = validated.snapshotId;
      } else {
        return errorResult('browse_act "hover" requires a "target" string, or "index" with "snapshotId".');
      }
      return this.withCommandTimeout(
        () => this.runHover({ target: hoverTarget, index: hoverIndex, snapshotId: hoverSnapshotId }),
        this.timeoutMs + this.cursorBudgetMs,
      );
    }

    if (action === "select") {
      const validated = validateIndexSnapshot(args, "select");
      if (!validated.ok) return errorResult(validated.error);
      if (typeof args.text !== "string") {
        return errorResult('browse_act "select" requires a string "text".');
      }
      // Routes to the same perform() path the jev loop uses — see the
      // design doc's table ("select | index+snapshotId, text | perform
      // SELECT"). perform() already applies the staleness/cross-tab
      // snapshotId check and produces evidence for SELECT. `performUnlocked`
      // (not the public `perform`) — see `runExclusive`'s doc comment: this
      // call is already running inside the queue, from `act`'s own turn.
      return this.performUnlocked({ operation: "SELECT", index: validated.index, snapshotId: validated.snapshotId, text: args.text });
    }

    if (action === "back" || action === "forward") {
      return this.withCommandTimeout(async () => {
        const page = this.target.currentPage();
        if (!page) return errorResult("No browser tab is open — call browse_open first.");
        if (action === "back" && !page.canGoBack()) {
          return errorResult("Cannot go back: no previous page in this tab's history.");
        }
        if (action === "forward" && !page.canGoForward()) {
          return errorResult("Cannot go forward: no next page in this tab's history.");
        }
        // goBack()/goForward() are fire-and-forget (BrowserPageHandle has no
        // navigation-complete signal) — wait for the URL to actually change
        // before reading it back, so the result reflects the page the user
        // lands on rather than a stale pre-navigation URL.
        const previousUrl = page.getURL();
        const before = await this.captureSignature(page, "before");
        if (action === "back") page.goBack();
        else page.goForward();
        await this.waitForUrlChange(page, previousUrl);
        const after = await this.captureSignature(page, "after");
        const currentUrl = page.getURL();
        return {
          url: currentUrl,
          title: page.getTitle(),
          ...this.diffSignatures(before, after, { previousUrl, currentUrl }),
        };
      });
    }

    if (action === "scroll") {
      if (args.amount !== undefined && (typeof args.amount !== "number" || !Number.isFinite(args.amount))) {
        return errorResult('browse_act "scroll" requires "amount" to be a number when provided.');
      }
      const amount = typeof args.amount === "number" ? args.amount : 1;
      return this.withCommandTimeout(
        () => this.runOnPageWithEvidence("SCROLL_JS", { amount }),
        this.timeoutMs + this.cursorBudgetMs,
      );
    }

    // click / type — target OR index+snapshotId (design doc's table: "click
    // / type | target or index+snapshotId (+text) | index → existing
    // perform CLICK/TYPE_TEXT path"). Index-based routes straight to
    // perform(), which already carries the staleness/cross-tab check,
    // evidence, and (for CLICK) openedTab detection.
    if (args.index !== undefined || args.snapshotId !== undefined) {
      const validated = validateIndexSnapshot(args, action);
      if (!validated.ok) return errorResult(validated.error);
      if (action === "type" && typeof args.text !== "string") {
        return errorResult('browse_act "type" requires a string "text" when using "index".');
      }
      // `performUnlocked`, not the public `perform` — see `runExclusive`'s
      // doc comment.
      return this.performUnlocked({
        operation: action === "click" ? "CLICK" : "TYPE_TEXT",
        index: validated.index,
        snapshotId: validated.snapshotId,
        text: args.text,
      });
    }

    if (typeof args.target !== "string" || args.target.trim() === "") {
      return errorResult(`browse_act "${action}" requires a non-empty string "target" (or "index" with "snapshotId").`);
    }
    // Captured as a local const, not read as `args.target` again below: TS
    // narrowing of a property access does not survive into the closures
    // passed to withCommandTimeout, so `runClick`'s `target: string`
    // parameter needs an already-narrowed value.
    const target = args.target;
    if (action === "type") {
      if (typeof args.text !== "string") {
        return errorResult('browse_act "type" requires a string "text".');
      }
      const text = args.text;
      return this.withCommandTimeout(
        () => this.runOnPageWithEvidence("TYPE_JS", { target, text }),
        this.timeoutMs + this.cursorBudgetMs,
      );
    }
    return this.withCommandTimeout(() => this.runClick(target), this.timeoutMs + this.cursorBudgetMs);
  }

  /** Runs CLICK_JS and, if the click actually started a navigation, waits
   * briefly for it to land before trusting the result's url/title — see
   * CLICK_SETTLE_TIMEOUT_MS's doc comment. CLICK_JS itself reads
   * location.href/document.title synchronously, so on its own it reports
   * whatever page the agent was just on, not the one the click navigated
   * to, and a following browse_find_images would then race the new page's
   * load (finding 7).
   *
   * "Addendum 2" §1: a signature is captured before the click and again
   * after the settle, and the diff is merged into the result as
   * `{ changed, changes }` — the whole point being that `changed: false` is
   * a normal, reportable answer (a click on a wrapper that did nothing),
   * never an error.
   *
   * Review finding 4: CLICK_JS also stamps the element it actually clicked
   * and returns that element's own before-signature (`__scopedBefore`) —
   * extracted here (and stripped from the result, see extractScopedBefore)
   * so diffSignatures can compare it against the same element's after
   * state, the real evidence on a page whose whole-document dom/text moves
   * on its own. */
  private async runClick(target: string): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    const previousUrl = page.getURL();
    // Full browser use: a click may open a popup as a new browser tab
    // (attachBrowserTabPolicy in window.ts) — listed before the action so
    // detectOpenedTab can diff against it after, the same before/after
    // shape captureSignature already uses.
    const tabsBefore = await this.listPagesSafe();
    // Before the before-signature capture, deliberately — see CURSOR_JS's
    // doc comment (pageScripts.ts) for why the overlay's own DOM/scroll
    // footprint must never land between the two evidence-of-effect captures.
    await this.moveCursor(page, { action: "click", target });
    const before = await this.captureSignature(page, "before");
    const result = await this.executeScript(page, "CLICK_JS", { target });
    if ("error" in result) return result;
    const scopedBefore = extractScopedBefore(result);
    const selfDisabled = extractTargetSelfDisabled(result);
    await this.settleAfterClick(page, previousUrl);
    if (selfDisabled) {
      await this.settleWhileTargetBusy(page);
      // A handler that disables its button and *then* navigates finishes
      // after the busy wait, not before it — so the load wait is redone
      // here. It returns immediately when nothing is loading.
      await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
    }
    const after = await this.captureSignature(page, "after");
    const currentUrl = page.getURL();
    const openedTab = await this.detectOpenedTab(tabsBefore);
    const merged: BrowserCommandResult = {
      ...result,
      url: currentUrl,
      title: page.getTitle(),
      ...this.diffSignatures(before, after, { previousUrl, currentUrl, scopedBefore }),
    };
    if (openedTab) merged.openedTab = openedTab;
    return merged;
  }

  /** `act`'s `press` — a trusted CDP `Input.dispatchKeyEvent` key press,
   * optionally focusing a target first (FOCUS_JS). Reports `{ error }`
   * outright when this tab's CDP session never attached (`page.sendCdp`
   * absent) — degrading gracefully per the design doc rather than silently
   * doing nothing. Reuses the same click-settle/openedTab machinery as
   * runClick/perform's CLICK, since Enter routinely submits a form (a real
   * navigation) and can just as easily open a popup.
   *
   * Review finding 5: an `index`+`snapshotId` focus target now goes through
   * the same staleness/cross-tab guard `perform()` uses (previously it went
   * straight to FOCUS_JS, so a stale snapshotId just failed to find an
   * element with no explanation), and a focus that was explicitly requested
   * but fails is now a hard error rather than best-effort — sending the key
   * to whatever happens to already have focus when the caller asked for a
   * specific element is worse than reporting the failure. */
  private async runPress(
    keySpec: string,
    focus: { target?: string; index?: number; snapshotId?: string },
  ): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    const parsed = parseKeySpec(keySpec);
    if (!parsed) return errorResult(`Unsupported key: ${JSON.stringify(keySpec)}`);
    if (!page.sendCdp) {
      return errorResult("Keyboard input (press) requires a CDP session, which is unavailable for this browser tab.");
    }

    const hasIndexTarget = focus.index !== undefined && focus.snapshotId !== undefined;
    if (focus.target || hasIndexTarget) {
      if (hasIndexTarget) {
        const staleError = this.checkSnapshotStale(focus.snapshotId!, page);
        if (staleError) return staleError;
      }
      let focusResult: BrowserCommandResult;
      try {
        focusResult = await this.executeScript(page, "FOCUS_JS", {
          target: focus.target,
          index: focus.index,
          snapshotId: focus.snapshotId,
        });
      } catch (err) {
        return errorResult(`Failed to focus target before press: ${toMessage(err)}`);
      }
      if ("error" in focusResult) return focusResult;
      if (focusResult.focused !== true) {
        return errorResult(`No element matched to focus before press: ${focus.target ?? `index ${focus.index}`}`);
      }
    }

    await this.moveCursor(page, { action: "press", target: focus.target, snapshotId: focus.snapshotId, index: focus.index });

    const previousUrl = page.getURL();
    const tabsBefore = await this.listPagesSafe();
    const before = await this.captureSignature(page, "before");

    const { descriptor, modifiers } = parsed;
    const modBits = modifiersBitmask(modifiers);
    // Review finding 2: a Meta/Ctrl-modified combo (Cmd+A, Ctrl+C, …) is
    // sent as a *textless* event with CDP's `commands` field naming the
    // editing command — Chromium doesn't run its native accelerator table
    // off a CDP-synthesized modified keydown the way it would a genuine
    // OS-level shortcut, so a synthetic Cmd+A on macOS Chromium silently did
    // nothing before this. Sending `text` alongside a modified combo would
    // also be actively wrong — Cmd+A must select all, never additionally
    // insert the literal character "a".
    const isEditCombo = modifiers.meta || modifiers.ctrl;
    const commands = isEditCombo ? resolveEditCommand(descriptor.key, modifiers) : undefined;
    const text = isEditCombo ? undefined : descriptor.text;
    try {
      await page.sendCdp("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        modifiers: modBits,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        code: descriptor.code,
        key: descriptor.key,
        text,
        unmodifiedText: text,
        commands,
      });
      await page.sendCdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: modBits,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        code: descriptor.code,
        key: descriptor.key,
      });
    } catch (err) {
      return errorResult(`Failed to dispatch key "${keySpec}": ${toMessage(err)}`);
    }

    // Enter routinely submits a form — the same two-phase settle a click
    // uses — but every other key gets at least the short non-navigating
    // settle so a typed character's evidence isn't captured before the
    // page has repainted.
    await this.settleAfterClick(page, previousUrl);
    await this.settleShort();
    const after = await this.captureSignature(page, "after");
    const currentUrl = page.getURL();
    const openedTab = await this.detectOpenedTab(tabsBefore);
    const result: BrowserCommandResult = {
      url: currentUrl,
      title: page.getTitle(),
      ...this.diffSignatures(before, after, { previousUrl, currentUrl }),
    };
    if (openedTab) result.openedTab = openedTab;
    return result;
  }

  /** `act`'s `hover` — locates the target (HOVER_TARGET_JS), then dispatches
   * a trusted CDP `Input.dispatchMouseEvent` `mouseMoved` at its centre. A
   * page-script `dispatchEvent("mouseover")` would not trigger the
   * browser's own `:hover` CSS pseudo-class, which is the entire point of
   * this action existing separately from a page script.
   *
   * Review finding 8: HOVER_TARGET_JS itself scrolls the target into view
   * while locating it (a target below the fold has to be scrolled to before
   * its coordinates mean anything) — that scroll must happen *before* the
   * before-signature capture, per CLAUDE.md's before/after-capture ordering
   * rule (the same rule runClick's cursor-move-before-capture comment
   * documents), otherwise the before-capture's scrollY reflects the
   * pre-scroll page and the diff reports a `scrollY` change caused by
   * locating the target, not by the hover itself. Locate (and scroll) runs
   * first now, then the cursor overlay move, then the before-capture.
   *
   * Review finding 5: an `index`+`snapshotId` target now goes through the
   * same staleness/cross-tab guard `perform()` uses, instead of skipping
   * straight to a page-script lookup that would just report "not found" on
   * a stale snapshot. */
  private async runHover(spec: { target?: string; index?: number; snapshotId?: string }): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    if (!page.sendCdp) {
      return errorResult("Hover requires a CDP session, which is unavailable for this browser tab.");
    }
    if (spec.index !== undefined && spec.snapshotId !== undefined) {
      const staleError = this.checkSnapshotStale(spec.snapshotId, page);
      if (staleError) return staleError;
    }
    const located = await this.executeScript(page, "HOVER_TARGET_JS", {
      target: spec.target,
      index: spec.index,
      snapshotId: spec.snapshotId,
    });
    if ("error" in located) return located;
    if (located.found !== true || typeof located.x !== "number" || typeof located.y !== "number") {
      return errorResult(`No element matched for hover: ${spec.target ?? `index ${spec.index}`}`);
    }
    await this.moveCursor(page, { action: "hover", target: spec.target, snapshotId: spec.snapshotId, index: spec.index });
    const before = await this.captureSignature(page, "before");
    try {
      await page.sendCdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: located.x, y: located.y, button: "none" });
    } catch (err) {
      return errorResult(`Failed to dispatch hover: ${toMessage(err)}`);
    }
    await this.settleShort();
    const after = await this.captureSignature(page, "after");
    return { url: page.getURL(), title: page.getTitle(), ...this.diffSignatures(before, after, {}) };
  }

  /** `act`'s `wait` — without `text`, just a bounded sleep; with `text`,
   * polls WAIT_TEXT_JS every WAIT_POLL_INTERVAL_MS until it reports a
   * case-insensitive substring match or `ms` runs out. Never errors on a
   * miss — `found: false` is a normal, reportable answer (see the design
   * doc's table), the same "not finding something is not a failure"
   * convention `diffSignatures`'s `changed: false` already established.
   *
   * Second-pass review finding 9: a do/while, not a `while` — with `text`
   * and a `ms` of 0 (or small enough that the deadline has already passed by
   * the time `Date.now()` is checked), the previous `while (Date.now() <
   * deadline)` loop's condition could be false before the body ever ran even
   * once, so the page was never actually checked at all and the call simply
   * reported `found: false` no matter what was already on the page. The text
   * is now always polled at least once, regardless of `ms`. */
  private async runWait(text: string | undefined, ms: number): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    if (!text) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { found: true, url: page.getURL(), title: page.getTitle() };
    }
    const deadline = Date.now() + ms;
    let found = false;
    do {
      try {
        const result = await this.executeScript(page, "WAIT_TEXT_JS", { text });
        if (isRecord(result) && result.found === true) {
          found = true;
        }
      } catch {
        // Keep polling — a transient executeJavaScript failure (mid
        // navigation, say) shouldn't end the wait early.
      }
      if (found || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
    } while (true);
    return { found, url: page.getURL(), title: page.getTitle() };
  }

  /** Second-pass review finding 8: public entry point — serializes onto the
   * command queue and delegates to `findImagesUnlocked`. */
  async findImages(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.findImagesUnlocked(args));
  }

  private async findImagesUnlocked(args: unknown): Promise<BrowserCommandResult> {
    if (args !== undefined && !isRecord(args)) {
      return errorResult("browse_find_images requires an object (or no arguments).");
    }
    const raw = isRecord(args) ? args : {};
    const minWidth = normalizeNonNegativeNumber(raw.minWidth, 200);
    if (minWidth.error) return errorResult(`"minWidth" ${minWidth.error}`);
    const minHeight = normalizeNonNegativeNumber(raw.minHeight, 200);
    if (minHeight.error) return errorResult(`"minHeight" ${minHeight.error}`);
    const limitField = normalizeNonNegativeNumber(raw.limit, 30);
    if (limitField.error) return errorResult(`"limit" ${limitField.error}`);
    const limit = Math.max(1, Math.min(limitField.value, 100));

    return this.withCommandTimeout(() =>
      this.runOnPage("FIND_IMAGES_JS", { minWidth: minWidth.value, minHeight: minHeight.value, limit }),
    );
  }

  /** A readable digest of the current page — jev-loop design doc "Addendum
   * 2, 2026-09-19" §2. Read-only, so unlike act/perform it carries no
   * `{ changed, changes }` evidence. A `selector` that matches nothing is a
   * page-script `{ error }`, surfaced here exactly like any other page
   * error, not silently widened to a whole-page read. */
  async read(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.readUnlocked(args));
  }

  private async readUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateReadArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { maxChars, selector } = validated.value;
    return this.withCommandTimeout(() =>
      this.runOnPage("READ_JS", { maxChars, selector: selector ?? null }),
    );
  }

  /** Walks the current page and returns an indexed element table (jev-loop
   * design doc §1). Generates a fresh snapshotId every call — the id is
   * both embedded in the page (SNAPSHOT_JS stamps each surviving element
   * with `data-pen-snap="<id>:<index>"`) and returned to the caller, and
   * becomes the *only* snapshotId perform() will accept until the next
   * snapshot() call. */
  async snapshot(): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.snapshotUnlocked());
  }

  private async snapshotUnlocked(): Promise<BrowserCommandResult> {
    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      return this.takeSnapshot(page);
    });
  }

  /** The actual snapshot() work, factored out so `screenshot({ annotate:
   * true })` can take one against a page it already resolved, without a
   * second `currentPage()` lookup (and the TOCTOU risk of that lookup
   * returning a different tab than the one already being screenshotted). */
  private async takeSnapshot(page: BrowserPageHandle): Promise<BrowserCommandResult> {
    const snapshotId = randomUUID();
    const result = await this.executeScript(page, "SNAPSHOT_JS", {
      snapshotId,
      maxElements: MAX_SNAPSHOT_ELEMENTS,
    });
    if ("error" in result) return result;
    this.lastSnapshot = { id: snapshotId, page };
    return { ...result, snapshotId };
  }

  /** Full browser use: a downscaled JPEG of the current viewport —
   * `page.capture()` (window.ts: `webContents.capturePage()` → resize to
   * ≤1280px wide → `toJPEG(70)`). `annotate: true` first takes a fresh
   * snapshot (so its `snapshotId` becomes the one `perform`/`act`'s
   * index-based actions will accept next), overlays a numbered label on
   * every one of its elements (MARKS_JS — "set of marks"), captures, and
   * always removes the overlay in `finally` regardless of how the capture
   * itself goes, so a failed capture can never leave marks stuck on the
   * page. An empty capture (`capture()` returning null) is an `{ error }`,
   * not a blank image — a caller has no way to tell "the page is genuinely
   * blank" from "the capture silently failed" otherwise. */
  async screenshot(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.screenshotUnlocked(args));
  }

  private async screenshotUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateScreenshotArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { annotate } = validated.value;
    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      if (!page.capture) return errorResult("Screenshot is not supported by this browser tab.");

      let snapshotId: string | undefined;
      let elements: unknown;
      if (annotate) {
        const snap = await this.takeSnapshot(page);
        if ("error" in snap) return snap;
        snapshotId = snap.snapshotId as string;
        elements = snap.elements;
        // Second-pass review finding 7: MARKS_JS's own result is checked
        // before proceeding — before this, a MARKS_JS failure (a throwing/
        // rejecting executeJavaScript, or a page-script `{ error }`) was
        // silently ignored and the capture ran anyway, so a failed overlay
        // produced a screenshot with no marks and no indication why. On
        // error, any partially-applied marks are removed (best-effort) before
        // returning, same as the ordinary `finally` cleanup below would.
        const marksResult = await this.executeScript(page, "MARKS_JS", { snapshotId });
        if ("error" in marksResult) {
          try {
            await this.executeScript(page, "REMOVE_MARKS_JS", {});
          } catch {
            // Best-effort — see this method's `finally` block below.
          }
          return marksResult;
        }
        // Second-pass review finding 7: capturing right after MARKS_JS
        // returns can miss the overlay entirely — the DOM mutation hasn't
        // necessarily been painted yet when `capturePage()` runs. Waits for
        // an in-page double requestAnimationFrame (the standard "wait for
        // the next paint" idiom), raced against a short timeout: a hidden
        // `WebContentsView` never fires `requestAnimationFrame` at all (this
        // repo has been bitten by that before — get_screenshot), so this must
        // never hang the whole command waiting for a paint that will never
        // come.
        await this.waitForPaint(page);
      }
      try {
        const captured = await page.capture();
        if (!captured || !captured.imageData) {
          return errorResult("Screenshot capture failed (empty image).");
        }
        const result: BrowserCommandResult = {
          imageData: captured.imageData,
          width: captured.width,
          height: captured.height,
          url: page.getURL(),
          title: page.getTitle(),
        };
        if (annotate) {
          result.snapshotId = snapshotId;
          result.elements = elements;
        }
        return result;
      } finally {
        if (annotate) {
          try {
            await this.executeScript(page, "REMOVE_MARKS_JS", {});
          } catch {
            // Best-effort cleanup — a failure here must never mask whatever
            // the capture itself returned/threw.
          }
        }
      }
    });
  }

  /** Full browser use's `tabs` command — lists/switches/closes/opens browser
   * tabs. Reports "not supported" up front when the injected `BrowserTarget`
   * doesn't implement the four optional methods this needs (window.ts
   * always implements all four together, but the unit-test fakes and any
   * future embedder might not). */
  async tabs(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.tabsUnlocked(args));
  }

  private async tabsUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateTabsArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { action, tabId, url } = validated.value;
    if (!this.target.listPages || !this.target.selectPage || !this.target.closePage || !this.target.newPage) {
      return errorResult("Tab management is not supported by this browser build.");
    }
    // "new" with a url delegates to open() below (review finding 9), which
    // needs its own longer openTimeoutMs budget (BROWSER_OPEN_TIMEOUT_MS) —
    // the default command timeout would otherwise cut a slow page's
    // DOM-ready wait short before open()'s own grace period ever gets a
    // chance to run.
    //
    // Second-pass review finding 6: this outer command starts its own
    // withTimeout clock *before* `newPage()` runs, while the nested
    // `this.open()` call below starts its own (separately budgeted at the
    // same `this.openTimeoutMs`) only after `newPage()` has resolved — so the
    // outer timer's deadline was always strictly earlier than the inner
    // one's, and the outer timeout fired first, on every slow `open`,
    // producing a bare "Browser command timed out" with no tab listing at
    // all instead of `open()`'s own more specific timeout (which at least
    // still runs `listTabsResult()` afterward). Padding the outer budget by
    // OPEN_COMMAND_MARGIN_MS — comfortably more than `newPage()` (an
    // in-process tab creation, not a network wait) could ever take — ensures
    // the inner `open()` timeout always resolves first.
    const budgetMs = action === "new" && url ? this.openTimeoutMs + OPEN_COMMAND_MARGIN_MS : undefined;
    return this.withCommandTimeout(async () => {
      if (action === "list") return this.listTabsResult();
      if (action === "new") {
        // Review finding 9: `newPage` itself only creates the tab and makes
        // it current — it used to also `await`s a full `loadURL()` (the same
        // `did-finish-load` wait `open()` deliberately avoids for a heavy
        // page), so `tabs({action:"new", url})` blocked for as long as the
        // whole page took to finish loading instead of `open()`'s
        // DOM-ready-plus-grace-period compromise. `newPage()` now never
        // takes a url; loading one, when given, reuses `open()` outright —
        // same DOM-ready race, same grace period, same `{ loaded }` field.
        await this.target.newPage!();
        if (!url) return this.listTabsResult();
        // `openUnlocked`, not the public `open` — see `runExclusive`'s doc
        // comment: this call is already running inside the queue, from
        // `tabs`'s own turn, and calling back into `open` would deadlock.
        const openResult = await this.openUnlocked({ url });
        const tabsResult = await this.listTabsResult();
        // On open failure the tab still exists (newPage() already created
        // it) — report the error alongside the tab listing so the caller
        // can see the new (empty) tab instead of retrying `new` into a
        // duplicate tab.
        return "error" in openResult ? { ...tabsResult, error: openResult.error } : { ...tabsResult, ...openResult };
      }
      if (action === "switch") {
        const ok = await this.target.selectPage!(tabId!);
        if (!ok) return errorResult(`No browser tab with id ${tabId}.`);
        return this.listTabsResult();
      }
      // close
      const ok = await this.target.closePage!(tabId!);
      if (!ok) return errorResult(`No browser tab with id ${tabId} to close, or it is not a browser tab.`);
      return this.listTabsResult();
    }, budgetMs);
  }

  private async listTabsResult(): Promise<BrowserCommandResult> {
    const pages = await this.target.listPages!();
    const tabsOut = pages.map((p) => ({ tabId: p.tabId, url: p.url, title: p.title, current: p.current }));
    const current = pages.find((p) => p.current)?.tabId ?? null;
    return { tabs: tabsOut, current };
  }

  /** Best-effort tab listing used by `detectOpenedTab` — never throws, and
   * returns `[]` when the injected `BrowserTarget` doesn't implement
   * `listPages` at all (every unit-test fake, notably), so a click's own
   * result is never broken by openedTab detection being unavailable. */
  private async listPagesSafe(): Promise<BrowserTabInfo[]> {
    if (!this.target.listPages) return [];
    try {
      return await this.target.listPages();
    } catch {
      return [];
    }
  }

  /** Full browser use, fixing upstream jev-ultrafast #61 ("the agent sticks
   * to the old tab"): diffs a tab listing taken before a click-like action
   * against one taken after, and reports the first genuinely new tab id (if
   * any) as `openedTab` — the agent's current tab has already followed a
   * popup (window.ts's attachBrowserTabPolicy sets `agentBrowserTabId` to
   * it), so this is purely informational, telling the caller a new tab
   * exists rather than silently leaving it undiscovered. */
  private async detectOpenedTab(
    before: BrowserTabInfo[],
  ): Promise<{ tabId: number; url: string; title: string } | undefined> {
    const after = await this.listPagesSafe();
    if (after.length <= before.length) return undefined;
    const beforeIds = new Set(before.map((p) => p.tabId));
    const opened = after.find((p) => !beforeIds.has(p.tabId));
    if (!opened) return undefined;
    return { tabId: opened.tabId, url: opened.url, title: opened.title };
  }

  /** Acts by index against the elements table from the caller's most recent
   * snapshot() — see validatePerformArgs and lastSnapshot's doc comment for
   * the staleness/cross-tab guard. CLICK reuses the same post-click settle
   * wait as browse_act's click (runClick above). */
  async perform(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.performUnlocked(args));
  }

  private async performUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validatePerformArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { index, operation, text, snapshotId } = validated.value;

    // Resolved before the staleness check (not inside withCommandTimeout)
    // so the check can compare it against the page snapshot() actually ran
    // against — see lastSnapshot's doc comment / finding 5.
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");

    const staleError = this.checkSnapshotStale(snapshotId, page);
    if (staleError) return staleError;

    return this.withCommandTimeout(async () => {
      if (operation === "CLICK") {
        const previousUrl = page.getURL();
        // Full browser use: same openedTab detection as runClick — an
        // index-based click ("index click" in the design doc's item 4) gets
        // the same treatment as a target-based one.
        const tabsBefore = await this.listPagesSafe();
        // Before the before-signature capture — see runClick's comment.
        await this.moveCursor(page, { action: "click", snapshotId, index });
        const before = await this.captureSignature(page, "before");
        const result = await this.executeScript(page, "PERFORM_JS", { snapshotId, index, operation, text });
        if ("error" in result) return result;
        const scopedBefore = extractScopedBefore(result);
        const selfDisabled = extractTargetSelfDisabled(result);
        await this.settleAfterClick(page, previousUrl);
        if (selfDisabled) {
          await this.settleWhileTargetBusy(page);
          // See runClick: the navigation can start after the busy wait.
          await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
        }
        const after = await this.captureSignature(page, "after");
        const currentUrl = page.getURL();
        const openedTab = await this.detectOpenedTab(tabsBefore);
        const merged: BrowserCommandResult = {
          ...result,
          url: currentUrl,
          title: page.getTitle(),
          ...this.diffSignatures(before, after, { previousUrl, currentUrl, scopedBefore }),
        };
        if (openedTab) merged.openedTab = openedTab;
        return merged;
      }

      // Review finding 3: TYPE_TEXT/SELECT/SCROLL_UP/SCROLL_DOWN get a short
      // settle before the after-capture too — see NON_CLICK_SETTLE_MS.
      // Before the before-signature capture — see runClick's comment.
      const cursorAction: "type" | "select" | "scroll" =
        operation === "TYPE_TEXT" ? "type" : operation === "SELECT" ? "select" : "scroll";
      await this.moveCursor(page, { action: cursorAction, snapshotId, index });
      const before = await this.captureSignature(page, "before");
      const result = await this.executeScript(page, "PERFORM_JS", { snapshotId, index, operation, text });
      if ("error" in result) return result;
      const scopedBefore = extractScopedBefore(result);
      const selfDisabled = extractTargetSelfDisabled(result);
      await this.settleShort();
      if (selfDisabled) await this.settleWhileTargetBusy(page);
      const after = await this.captureSignature(page, "after");
      return { ...result, ...this.diffSignatures(before, after, { scopedBefore }) };
    }, this.timeoutMs + this.cursorBudgetMs);
  }

  private async runOnPage(
    script: "FIND_IMAGES_JS" | "CLICK_JS" | "TYPE_JS" | "SCROLL_JS" | "READ_JS",
    scriptArgs: Record<string, unknown>,
  ): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    return this.executeScript(page, script, scriptArgs);
  }

  /** Like runOnPage, but wraps the call with a before/after page-signature
   * diff merged into a successful result as `{ changed, changes }` —
   * "Addendum 2" §1. Used by act's `type`/`scroll` (click has its own
   * variant inlined in runClick, since it also needs the click-settle
   * wait in between the two captures).
   *
   * Review finding 3: a short settle (NON_CLICK_SETTLE_MS) now runs between
   * the action and the after-capture — type/scroll used to capture "after"
   * immediately, with no settle at all. */
  private async runOnPageWithEvidence(
    script: "TYPE_JS" | "SCROLL_JS",
    scriptArgs: Record<string, unknown>,
  ): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    // Before the before-signature capture — see runClick's comment / CURSOR_JS's
    // doc comment for why. TYPE_JS carries a target to aim at; SCROLL_JS has
    // none, so the cursor just stays put and visible (see CURSOR_JS's
    // "action === scroll" branch).
    if (script === "TYPE_JS") {
      const target = typeof scriptArgs.target === "string" ? scriptArgs.target : undefined;
      await this.moveCursor(page, { action: "type", target });
    } else {
      await this.moveCursor(page, { action: "scroll" });
    }
    const before = await this.captureSignature(page, "before");
    const result = await this.executeScript(page, script, scriptArgs);
    if ("error" in result) return result;
    const scopedBefore = extractScopedBefore(result);
    const selfDisabled = extractTargetSelfDisabled(result);
    await this.settleShort();
    if (selfDisabled) await this.settleWhileTargetBusy(page);
    const after = await this.captureSignature(page, "after");
    return { ...result, ...this.diffSignatures(before, after, { scopedBefore }) };
  }

  private async executeScript(
    page: BrowserPageHandle,
    script: ScriptName,
    scriptArgs: Record<string, unknown>,
  ): Promise<BrowserCommandResult> {
    // A function replacer, not a plain string — String.prototype.replace's
    // *string* form treats `$&`, `` $` ``, `$'` and `$$` in the replacement
    // as special patterns (e.g. `$&` re-inserts the whole match, `$'`
    // inserts everything after it), so a JSON.stringify'd arg containing one
    // of those two-character sequences (a click target of "$'", chat text
    // "price is $&") would get silently mangled — and `$'` in particular can
    // splice page content into the JSON string literal, breaking the "can
    // never break out of the script" invariant this file's header claims.
    // The function form's return value is inserted verbatim, no pattern
    // interpretation.
    const code = SCRIPT_TEMPLATES[script].replace(ARGS_MARKER, () => JSON.stringify(scriptArgs));
    const result = await page.executeJavaScript(code);
    if (!isRecord(result)) return errorResult("Unexpected response from the page script.");
    return result;
  }

  /** Runs SIGNATURE_JS for the given phase and returns the parsed signature,
   * or `null` on any failure (a throwing/rejecting executeJavaScript, or a
   * malformed response) — evidence capture must never itself turn a
   * successful action into an error result, so a capture failure degrades
   * to "no evidence available" rather than propagating.
   *
   * Review finding 4: SIGNATURE_JS now takes `phase` (via ARGS_MARKER, like
   * every other script here) — it needs to know "before" from "after" to
   * coordinate the `data-pen-sig-mainimg`/`data-pen-sig-target` identity
   * markers across the two calls (see SIGNATURE_JS's doc comment). */
  private async captureSignature(page: BrowserPageHandle, phase: "before" | "after"): Promise<PageSignature | null> {
    try {
      const code = SIGNATURE_JS.replace(ARGS_MARKER, () => JSON.stringify({ phase }));
      const result = await page.executeJavaScript(code);
      return isPageSignature(result) ? result : null;
    } catch {
      return null;
    }
  }

  /** "Addendum 2" §1, reshaped by review findings 2/4: diffs two page
   * signatures into `{ changed, changes }`. `changes` uses stable category
   * names, not raw field names.
   *
   * Finding 2: when either capture is missing (most likely the AFTER one —
   * `executeJavaScript` rejecting mid a cross-origin navigation's frame
   * swap is exactly when the page is most likely to have actually changed),
   * this used to unconditionally report `changed: false` — self-contradictory
   * at the moment of the biggest effect. `opts.previousUrl`/`opts.currentUrl`
   * (both already tracked by every caller that navigates) are used as a
   * fallback signal instead of guessing "no change".
   *
   * Finding 4: a whole-document `dom`/`text` delta is noisy on a live page
   * (carousels, lazy images, ads) and is reported in `changes` for context,
   * but never gates `changed` on its own — only url/title/main-image
   * (identity-guarded via SIGNATURE_JS's marker, see its doc comment) and
   * the acted-on element's own scoped signature do. `scrollY` and
   * `focusedValueLength` (finding 3) also gate `changed`: unlike `dom`/
   * `text`, neither one drifts on its own between two captures of the same
   * page — they only move because the action itself scrolled the page or
   * changed what's typed into a field — so they're trustworthy evidence,
   * not noise. */
  private diffSignatures(
    before: PageSignature | null,
    after: PageSignature | null,
    opts?: { previousUrl?: string; currentUrl?: string; scopedBefore?: ScopedSignature | null },
  ): EffectEvidence {
    if (!before || !after) {
      const changes: string[] = [];
      if (opts?.previousUrl !== undefined && opts?.currentUrl !== undefined && opts.previousUrl !== opts.currentUrl) {
        changes.push("url");
      }
      return { changed: changes.length > 0, changes };
    }

    const changes: string[] = [];
    const urlChanged = before.url !== after.url;
    const titleChanged = before.title !== after.title;
    const mainImageChanged = before.mainImageSrc !== after.mainImageSrc;
    const scrollChanged = before.scrollY !== after.scrollY;
    const valueChanged = before.focusedValueLength !== after.focusedValueLength;

    if (urlChanged) changes.push("url");
    if (titleChanged) changes.push("title");
    // Report-only — see the doc comment above for why these don't gate.
    if (before.nodeCount !== after.nodeCount) changes.push("dom");
    if (before.textLength !== after.textLength || before.textHash !== after.textHash) changes.push("text");
    if (scrollChanged) changes.push("scroll");
    if (valueChanged) changes.push("value");
    if (mainImageChanged) changes.push("main-image");

    let scopedChanged = false;
    if (opts && opts.scopedBefore !== undefined) {
      const scopedBefore = opts.scopedBefore;
      const scopedAfter = after.scopedAfter ?? null;
      if (scopedBefore || scopedAfter) {
        scopedChanged =
          !scopedBefore ||
          !scopedAfter ||
          scopedBefore.nodeCount !== scopedAfter.nodeCount ||
          scopedBefore.textHash !== scopedAfter.textHash ||
          scopedBefore.src !== scopedAfter.src ||
          scopedBefore.valueLength !== scopedAfter.valueLength ||
          scopedBefore.ariaExpanded !== scopedAfter.ariaExpanded ||
          scopedBefore.ariaSelected !== scopedAfter.ariaSelected ||
          scopedBefore.checked !== scopedAfter.checked;
      }
      if (scopedChanged) changes.push("target");
    }

    const changed = urlChanged || titleChanged || mainImageChanged || scrollChanged || valueChanged || scopedChanged;
    return { changed, changes };
  }

  /** Review finding 3: a short, fixed settle for a non-click action before
   * capturing "after" — see NON_CLICK_SETTLE_MS's doc comment. */
  private async settleShort(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, NON_CLICK_SETTLE_MS));
  }

  /** Second-pass review finding 7: waits for the next paint after a DOM
   * mutation (MARKS_JS's overlay) before `screenshot({ annotate: true })`
   * captures the page — an in-page double `requestAnimationFrame` (the
   * standard "wait for the browser to actually paint" idiom: the first rAF
   * only guarantees the *next* frame is about to be produced, the second
   * guarantees that frame has landed), raced against PAINT_WAIT_TIMEOUT_MS.
   * Swallows every failure (a throwing/rejecting executeJavaScript, or the
   * race timing out) — a hidden `WebContentsView` never fires
   * `requestAnimationFrame` at all, so timing out here is the expected,
   * common case for an off-screen tab, not an error; the capture proceeds
   * either way, exactly as it did before this wait existed. */
  private async waitForPaint(page: BrowserPageHandle): Promise<void> {
    const script =
      "(function(){return new Promise(function(resolve){" +
      "requestAnimationFrame(function(){requestAnimationFrame(function(){resolve(true);});});" +
      "});})()";
    try {
      await withTimeout(page.executeJavaScript(script), PAINT_WAIT_TIMEOUT_MS, "paint wait timed out");
    } catch {
      // See this method's doc comment.
    }
  }

  /** Waits (bounded by BUSY_SETTLE_TIMEOUT_MS) for the element the acting
   * script stamped `data-pen-sig-target` to stop being busy — i.e. for the
   * handler that disabled it to finish. Called only when that script
   * reported `__targetSelfDisabled`, so the common action pays nothing.
   *
   * Every failure mode ends the wait rather than extending it: the element
   * disappearing (`present: false` — a re-render or a navigation), a page
   * script `{ error }`, a rejecting executeJavaScript, or a malformed
   * answer. Observing a moment early is the old behaviour; hanging here is
   * not. */
  private async settleWhileTargetBusy(page: BrowserPageHandle): Promise<void> {
    const deadline = Date.now() + Math.min(this.timeoutMs, BUSY_SETTLE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      let busy = false;
      try {
        const result = await this.executeScript(page, "TARGET_BUSY_JS", {});
        busy = result.present === true && result.busy === true;
      } catch {
        return;
      }
      if (!busy) return;
      await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_INTERVAL_MS));
    }
  }

  /** Polls briefly for `page.getURL()` to move away from `previousUrl` —
   * bounded well under the overall command timeout so a page whose URL
   * never actually changes (e.g. a fake in tests, or a click that doesn't
   * navigate) doesn't stall a command. `maxWaitMs` defaults to 2s (used by
   * back/forward, which always navigate); a smaller bound is passed for
   * click, where most invocations don't navigate at all. Returns whether the
   * URL actually changed, so callers can tell "navigated" from "timed out
   * without navigating". */
  private async waitForUrlChange(page: BrowserPageHandle, previousUrl: string, maxWaitMs = 2_000): Promise<boolean> {
    const deadline = Date.now() + Math.min(this.timeoutMs, maxWaitMs);
    while (page.getURL() === previousUrl && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return page.getURL() !== previousUrl;
  }

  /** Polls until `page.isLoading()` goes false, bounded by `maxWaitMs` (and
   * always by the overall command timeout). Used only once a navigation has
   * actually been observed (see settleAfterClick) — a page that never
   * navigated has no load to wait for. */
  private async waitForLoadStop(page: BrowserPageHandle, maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + Math.min(this.timeoutMs, maxWaitMs);
    while (page.isLoading() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** First phase of settleAfterClick: polls (bounded, short) for *any* sign
   * that the click started a navigation — `getURL()` moving, or
   * `isLoading()` going true, whichever comes first. Checking `isLoading()`
   * too (not just the URL) is what makes CLICK_SETTLE_TIMEOUT_MS's short
   * bound viable for a real, slow-to-commit navigation — see its doc
   * comment. Returns whether a navigation was observed at all. */
  private async waitForNavigationStart(page: BrowserPageHandle, previousUrl: string, maxWaitMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.min(this.timeoutMs, maxWaitMs);
    const navigating = () => page.getURL() !== previousUrl || page.isLoading();
    while (!navigating() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return navigating();
  }

  /** Addendum F ("Load, not commit"): waits for a click's navigation, if any,
   * to actually finish loading — not merely for `getURL()` to change at
   * commit. First waits (bounded, short) to see whether the click started a
   * navigation at all; only if it did does it then wait (bounded, longer)
   * for that navigation to finish loading. A click that never navigates
   * settles after the short bound alone, same as before this fix. */
  private async settleAfterClick(page: BrowserPageHandle, previousUrl: string): Promise<void> {
    const navigated = await this.waitForNavigationStart(page, previousUrl, CLICK_SETTLE_TIMEOUT_MS);
    if (navigated) await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
  }

  private async withCommandTimeout(
    fn: () => Promise<BrowserCommandResult>,
    budgetMs?: number,
  ): Promise<BrowserCommandResult> {
    const ms = budgetMs ?? this.timeoutMs;
    // Review finding 6: both captured *before* fn() runs, not after — a
    // command can itself close the tab it acted on (`tabs({action:"close"})`,
    // or a click whose handler navigates the whole window away and it gets
    // torn down), and each `BrowserPageHandle` here is a plain object closing
    // over its own dialog queue array, so draining it after the fact is safe
    // even once the underlying tab is gone — but only if we grabbed the
    // handle while the tab still existed.
    const actedPage = this.target.currentPage();
    const pageHandles = await this.listPageHandlesSafe();
    let result: BrowserCommandResult;
    const work = fn();
    try {
      result = await withTimeout(work, ms, `Browser command timed out after ${ms}ms.`);
    } catch (err) {
      result = errorResult(toMessage(err));
      // See `overrun`'s doc comment: keep the next queued command from
      // starting while this one's abandoned work is still running.
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      this.overrun = Promise.race([
        settled,
        new Promise<void>((resolve) => setTimeout(resolve, OVERRUN_GRACE_MS)),
      ]);
    }
    return this.mergeDialogs(result, pageHandles, actedPage);
  }

  /** Best-effort `BrowserTarget.pageHandles()` call — `[]` when the target
   * doesn't implement it (every unit-test fake, and any `BrowserTarget`
   * predating review finding 6) or throws, so dialog draining degrades to
   * `mergeDialogs`'s `actedPage`-only fallback rather than breaking the
   * command it's piggybacking on. */
  private async listPageHandlesSafe(): Promise<{ tabId: number; page: BrowserPageHandle }[]> {
    if (!this.target.pageHandles) return [];
    try {
      return await this.target.pageHandles();
    } catch {
      return [];
    }
  }

  /** Full browser use's dialog policy (CLAUDE.md): every command result gets
   * whatever JS dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) any
   * browser tab's CDP session auto-handled since the last drain merged in as
   * `{ dialogs }` (each entry tagged `tabId`) — centralized here (every
   * public command routes through `withCommandTimeout`) rather than threaded
   * through each command individually. Applied on both success and failure:
   * a dialog raised by the very action that then errored out is still worth
   * reporting.
   *
   * Review finding 6: this used to drain only `target.currentPage()` *after*
   * the command ran — so a dialog on a tab other than the one a command acts
   * on (a popup that raised its own dialog while the command ran elsewhere,
   * or the tab the command itself just closed) was silently lost instead of
   * surfacing on the next report. `pageHandles` (captured by
   * `withCommandTimeout` before `fn()` ran) now covers every open browser
   * tab; `actedPage` (also captured beforehand) is the fallback for a
   * `BrowserTarget` that doesn't implement `pageHandles` at all.
   *
   * Second-pass review finding 6: `tabs({action:"new", url})` runs a nested
   * `open()` call (see `tabs()`), which is itself wrapped in
   * `withCommandTimeout` and so already drains and merges dialogs into its
   * own `{ dialogs }` field before the outer `tabs()` call's
   * `withCommandTimeout` ever sees the result. This method used to overwrite
   * `result.dialogs` outright (`{ ...result, dialogs }`) whenever *this* call
   * found anything of its own to drain — starting from an empty array
   * instead of whatever `result.dialogs` already carried, so the inner
   * call's dialogs were silently dropped the moment the outer call had any
   * dialogs of its own. Seeding `dialogs` from `result.dialogs` (when
   * present) fixes this without ever double-reporting: `drainDialogs()`
   * clears each tab's queue on the call that drains it, so by the time the
   * outer call's drain runs, every dialog the inner call already reported is
   * gone from the queue and cannot be drained a second time. */
  private mergeDialogs(
    result: BrowserCommandResult,
    pageHandles: { tabId: number; page: BrowserPageHandle }[],
    actedPage: BrowserPageHandle | null,
  ): BrowserCommandResult {
    const dialogs: Record<string, unknown>[] = Array.isArray(result.dialogs)
      ? [...(result.dialogs as Record<string, unknown>[])]
      : [];
    const drain = (page: BrowserPageHandle, tabId?: number) => {
      if (!page.drainDialogs) return;
      try {
        const drained = page.drainDialogs();
        for (const d of drained) dialogs.push(tabId === undefined ? { ...d } : { tabId, ...d });
      } catch {
        // A throwing drainDialogs degrades to "no dialogs from this tab"
        // rather than breaking the command it's piggybacking on.
      }
    };
    if (pageHandles.length > 0) {
      for (const { tabId, page } of pageHandles) drain(page, tabId);
    } else if (actedPage) {
      drain(actedPage);
    }
    if (dialogs.length === 0) return result;
    return { ...result, dialogs };
  }
}

function normalizeNonNegativeNumber(
  value: unknown,
  fallback: number,
): { value: number; error?: string } {
  if (value === undefined) return { value: fallback };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { value: fallback, error: "must be a non-negative number." };
  }
  return { value };
}

/** Review finding 4: CLICK_JS/TYPE_JS/PERFORM_JS (for CLICK/TYPE_TEXT/SELECT)
 * embed the acted-on element's own before-signature in their result as an
 * internal `__scopedBefore` field. This pulls it out for diffSignatures and
 * deletes it from `result` in place, so it never leaks into the value a
 * caller (the chat tool, ultimately) ends up seeing. */
/** Upstream PR #58: CLICK_JS/TYPE_JS/PERFORM_JS report whether the action
 * itself made the acted-on control busy. Like `__scopedBefore`, it is an
 * internal field — pulled out here and deleted in place so it never reaches
 * the chat tool's result. */
function extractTargetSelfDisabled(result: BrowserCommandResult): boolean {
  const raw = result.__targetSelfDisabled;
  delete result.__targetSelfDisabled;
  return raw === true;
}

function extractScopedBefore(result: BrowserCommandResult): ScopedSignature | null {
  const raw = result.__scopedBefore;
  delete result.__scopedBefore;
  return isScopedSignature(raw) ? raw : null;
}
