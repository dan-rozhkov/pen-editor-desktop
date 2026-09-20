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
} as const;

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
}

export interface BrowserTarget {
  /** Resolves the tab to drive, creating one if none exists. */
  ensurePage(): Promise<BrowserPageHandle>;
  /** Null when no browser tab is open — read-only commands fail cleanly. */
  currentPage(): BrowserPageHandle | null;
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

type ActAction = "click" | "type" | "scroll" | "back" | "forward";

function isActAction(value: unknown): value is ActAction {
  return value === "click" || value === "type" || value === "scroll" || value === "back" || value === "forward";
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

  constructor(
    private readonly target: BrowserTarget,
    opts?: { timeoutMs?: number; openTimeoutMs?: number },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? BROWSER_COMMAND_TIMEOUT_MS;
    // An explicitly supplied timeoutMs bounds EVERY command including
    // open — a caller (or a test) that asks for a short budget means it.
    // open only gets its own longer default when nothing was specified.
    this.openTimeoutMs =
      opts?.openTimeoutMs ?? opts?.timeoutMs ?? BROWSER_OPEN_TIMEOUT_MS;
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
   * usable is not treated as this command failing. */
  async open(args: unknown): Promise<BrowserCommandResult> {
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

  async act(args: unknown): Promise<BrowserCommandResult> {
    if (!isRecord(args) || !isActAction(args.action)) {
      return errorResult(
        `browse_act requires an "action" of "click", "type", "scroll", "back", or "forward" (got ${
          isRecord(args) ? JSON.stringify(args.action) : JSON.stringify(args)
        }).`,
      );
    }
    const action = args.action;

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
      return this.withCommandTimeout(() => this.runOnPageWithEvidence("SCROLL_JS", { amount }));
    }

    // click / type
    if (typeof args.target !== "string" || args.target.trim() === "") {
      return errorResult(`browse_act "${action}" requires a non-empty string "target".`);
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
      return this.withCommandTimeout(() => this.runOnPageWithEvidence("TYPE_JS", { target, text }));
    }
    return this.withCommandTimeout(() => this.runClick(target));
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
    return {
      ...result,
      url: currentUrl,
      title: page.getTitle(),
      ...this.diffSignatures(before, after, { previousUrl, currentUrl, scopedBefore }),
    };
  }

  async findImages(args: unknown): Promise<BrowserCommandResult> {
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
    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      const snapshotId = randomUUID();
      const result = await this.executeScript(page, "SNAPSHOT_JS", {
        snapshotId,
        maxElements: MAX_SNAPSHOT_ELEMENTS,
      });
      if ("error" in result) return result;
      this.lastSnapshot = { id: snapshotId, page };
      return { ...result, snapshotId };
    });
  }

  /** Acts by index against the elements table from the caller's most recent
   * snapshot() — see validatePerformArgs and lastSnapshot's doc comment for
   * the staleness/cross-tab guard. CLICK reuses the same post-click settle
   * wait as browse_act's click (runClick above). */
  async perform(args: unknown): Promise<BrowserCommandResult> {
    const validated = validatePerformArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { index, operation, text, snapshotId } = validated.value;

    // Resolved before the staleness check (not inside withCommandTimeout)
    // so the check can compare it against the page snapshot() actually ran
    // against — see lastSnapshot's doc comment / finding 5.
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");

    if (!this.lastSnapshot || snapshotId !== this.lastSnapshot.id || page !== this.lastSnapshot.page) {
      return errorResult(
        this.lastSnapshot && snapshotId === this.lastSnapshot.id
          ? "Stale snapshotId — a different browser tab is now active. Call browser snapshot again on this tab before perform."
          : "Stale or unknown snapshotId — the page may have changed since that snapshot. Call browser snapshot again before perform.",
      );
    }

    return this.withCommandTimeout(async () => {
      if (operation === "CLICK") {
        const previousUrl = page.getURL();
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
        return {
          ...result,
          url: currentUrl,
          title: page.getTitle(),
          ...this.diffSignatures(before, after, { previousUrl, currentUrl, scopedBefore }),
        };
      }

      // Review finding 3: TYPE_TEXT/SELECT/SCROLL_UP/SCROLL_DOWN get a short
      // settle before the after-capture too — see NON_CLICK_SETTLE_MS.
      const before = await this.captureSignature(page, "before");
      const result = await this.executeScript(page, "PERFORM_JS", { snapshotId, index, operation, text });
      if ("error" in result) return result;
      const scopedBefore = extractScopedBefore(result);
      const selfDisabled = extractTargetSelfDisabled(result);
      await this.settleShort();
      if (selfDisabled) await this.settleWhileTargetBusy(page);
      const after = await this.captureSignature(page, "after");
      return { ...result, ...this.diffSignatures(before, after, { scopedBefore }) };
    });
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
    script:
      | "FIND_IMAGES_JS"
      | "CLICK_JS"
      | "TYPE_JS"
      | "SCROLL_JS"
      | "SNAPSHOT_JS"
      | "PERFORM_JS"
      | "READ_JS"
      | "TARGET_BUSY_JS",
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
    try {
      return await withTimeout(
        fn(),
        ms,
        `Browser command timed out after ${ms}ms.`,
      );
    } catch (err) {
      return errorResult(toMessage(err));
    }
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
