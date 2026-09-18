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
import { ARGS_MARKER, FIND_IMAGES_JS, CLICK_JS, TYPE_JS, SCROLL_JS, SNAPSHOT_JS, PERFORM_JS } from "./pageScripts";

const SCRIPT_TEMPLATES = { FIND_IMAGES_JS, CLICK_JS, TYPE_JS, SCROLL_JS, SNAPSHOT_JS, PERFORM_JS } as const;

/** Spec `2026-09-18-browse-task-jev-loop-design.md` §1: the element table is
 * the whole request payload for /api/browse/step, so an uncapped snapshot on
 * a big page is both slow and expensive. */
export const MAX_SNAPSHOT_ELEMENTS = 120;

/** Below the frontend's own per-tool timeout, so the agent gets a real "the
 * browser command timed out" message rather than a generic tool-loop
 * timeout with no detail. */
export const BROWSER_COMMAND_TIMEOUT_MS = 20_000;

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
    opts?: { timeoutMs?: number },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? BROWSER_COMMAND_TIMEOUT_MS;
  }

  async open(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateOpenArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    return this.withCommandTimeout(async () => {
      const page = await this.target.ensurePage();
      await page.loadURL(validated.url);
      return { url: page.getURL(), title: page.getTitle() };
    });
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
        if (action === "back") page.goBack();
        else page.goForward();
        await this.waitForUrlChange(page, previousUrl);
        return { url: page.getURL(), title: page.getTitle() };
      });
    }

    if (action === "scroll") {
      if (args.amount !== undefined && (typeof args.amount !== "number" || !Number.isFinite(args.amount))) {
        return errorResult('browse_act "scroll" requires "amount" to be a number when provided.');
      }
      const amount = typeof args.amount === "number" ? args.amount : 1;
      return this.withCommandTimeout(() => this.runOnPage("SCROLL_JS", { amount }));
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
      return this.withCommandTimeout(() => this.runOnPage("TYPE_JS", { target, text }));
    }
    return this.withCommandTimeout(() => this.runClick(target));
  }

  /** Runs CLICK_JS and, if the click actually started a navigation, waits
   * briefly for it to land before trusting the result's url/title — see
   * CLICK_SETTLE_TIMEOUT_MS's doc comment. CLICK_JS itself reads
   * location.href/document.title synchronously, so on its own it reports
   * whatever page the agent was just on, not the one the click navigated
   * to, and a following browse_find_images would then race the new page's
   * load (finding 7). */
  private async runClick(target: string): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    const previousUrl = page.getURL();
    const result = await this.executeScript(page, "CLICK_JS", { target });
    if ("error" in result) return result;
    await this.settleAfterClick(page, previousUrl);
    return { ...result, url: page.getURL(), title: page.getTitle() };
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
        const result = await this.executeScript(page, "PERFORM_JS", { snapshotId, index, operation, text });
        if ("error" in result) return result;
        await this.settleAfterClick(page, previousUrl);
        return { ...result, url: page.getURL(), title: page.getTitle() };
      }

      return this.executeScript(page, "PERFORM_JS", { snapshotId, index, operation, text });
    });
  }

  private async runOnPage(
    script: "FIND_IMAGES_JS" | "CLICK_JS" | "TYPE_JS" | "SCROLL_JS",
    scriptArgs: Record<string, unknown>,
  ): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    return this.executeScript(page, script, scriptArgs);
  }

  private async executeScript(
    page: BrowserPageHandle,
    script: "FIND_IMAGES_JS" | "CLICK_JS" | "TYPE_JS" | "SCROLL_JS" | "SNAPSHOT_JS" | "PERFORM_JS",
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

  private async withCommandTimeout(fn: () => Promise<BrowserCommandResult>): Promise<BrowserCommandResult> {
    try {
      return await withTimeout(
        fn(),
        this.timeoutMs,
        `Browser command timed out after ${this.timeoutMs}ms.`,
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
