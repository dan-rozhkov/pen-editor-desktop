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

import { decideBrowserNavigation } from "../navigation";
import { ARGS_MARKER, FIND_IMAGES_JS, CLICK_JS, TYPE_JS, SCROLL_JS } from "./pageScripts";

const SCRIPT_TEMPLATES = { FIND_IMAGES_JS, CLICK_JS, TYPE_JS, SCROLL_JS } as const;

/** Below the frontend's own per-tool timeout, so the agent gets a real "the
 * browser command timed out" message rather than a generic tool-loop
 * timeout with no detail. */
export const BROWSER_COMMAND_TIMEOUT_MS = 20_000;

/** How long a click is given to actually start a navigation before its
 * pre-click url/title are trusted (see runClick's doc comment / finding 7). */
const CLICK_SETTLE_TIMEOUT_MS = 300;

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

export class BrowserController {
  private readonly timeoutMs: number;

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
    await this.waitForUrlChange(page, previousUrl, CLICK_SETTLE_TIMEOUT_MS);
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
    script: "FIND_IMAGES_JS" | "CLICK_JS" | "TYPE_JS" | "SCROLL_JS",
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
   * click, where most invocations don't navigate at all. */
  private async waitForUrlChange(page: BrowserPageHandle, previousUrl: string, maxWaitMs = 2_000): Promise<void> {
    const deadline = Date.now() + Math.min(this.timeoutMs, maxWaitMs);
    while (page.getURL() === previousUrl && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
