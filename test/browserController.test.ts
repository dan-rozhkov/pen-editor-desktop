import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BrowserController,
  BROWSER_COMMAND_TIMEOUT_MS,
  BROWSER_OPEN_TIMEOUT_MS,
  type BrowserPageHandle,
  type BrowserTarget,
} from "../src/main/browser/controller";
// "Addendum 2, 2026-09-19" §1: act/perform now capture a page signature via
// SIGNATURE_JS before an action and again after its settle, diffing them
// into `{ changed, changes }`. Review finding 4 made SIGNATURE_JS take a
// `phase` argument (via the same ARGS_MARKER substitution every other
// script uses, so it can coordinate identity markers across the two
// calls — see its doc comment), so a signature call's code no longer
// equals the SIGNATURE_JS constant verbatim; "data-pen-sig-mainimg" is a
// string that appears only in SIGNATURE_JS's own body (not in any other
// script, even though "data-pen-sig-target" is shared with
// CLICK_JS/TYPE_JS/PERFORM_JS), so it reliably identifies a signature call
// regardless of which phase it was run for.
function isSignatureCall(code: unknown): boolean {
  return typeof code === "string" && code.includes("data-pen-sig-mainimg");
}

/** The human-cursor overlay (CURSOR_JS, controller.ts's moveCursor) runs
 * before every click/type/scroll/perform action's before-signature capture
 * — see CURSOR_JS's doc comment (pageScripts.ts). Its code references
 * `window.__penCursor` (the overlay's own state global), which no other
 * script does — SNAPSHOT_JS/FIND_IMAGES_JS both now reference the overlay's
 * *marker attribute* `data-pen-cursor` too (to skip it), so that string
 * alone is no longer unique to this script, unlike `__penCursor`. Every
 * existing assertion below that counts or indexes executeJavaScript calls
 * excludes cursor calls, exactly like signature calls, so this addition
 * doesn't change what those tests were already asserting about the action
 * scripts themselves. */
function isCursorCall(code: unknown): boolean {
  return typeof code === "string" && code.includes("__penCursor");
}

/** Finds the one non-signature, non-cursor executeJavaScript call whose code
 * contains `needle` — the action script's call, not one of the SIGNATURE_JS
 * calls bracketing it or the CURSOR_JS call preceding all of them. */
function findScriptCall(mock: ReturnType<typeof vi.fn>, needle: string): string {
  const call = mock.mock.calls.find((c) => !isSignatureCall(c[0]) && !isCursorCall(c[0]) && (c[0] as string).includes(needle));
  expect(call, `no executeJavaScript call contained ${JSON.stringify(needle)}`).toBeTruthy();
  return call![0] as string;
}

/** Count of executeJavaScript calls, excluding the cursor call — for
 * assertions written before the cursor overlay existed that count the
 * action-script-plus-signature-capture calls only. */
function nonCursorCallCount(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter((c) => !isCursorCall(c[0])).length;
}

// A real goBack()/goForward() is fire-and-forget but the URL does change —
// this fake mutates its own url/title synchronously on goBack/goForward so
// BrowserController's post-navigation URL-change poll (waitForUrlChange)
// resolves on its very first check, keeping these tests fast.
//
// The default executeJavaScript is signature-aware: a SIGNATURE_JS call
// (captureSignature) gets a real signature reflecting the page's *current*
// getURL()/getTitle() (so a navigating action's before/after diff correctly
// shows `changed: true` on "url"/"title" even under the default fake),
// while every other script gets the generic `{ ok: true }` most tests never
// inspect. A test that overrides executeJavaScript entirely takes on the
// responsibility of handling SIGNATURE_JS itself (see the "evidence of
// effect" describe block below for the pattern).
function makeFakePage(overrides: Partial<BrowserPageHandle> = {}): BrowserPageHandle {
  let url = "https://example.com/";
  let title = "Example";
  const page: BrowserPageHandle = {
    loadURL: vi.fn(() => Promise.resolve()),
    executeJavaScript: vi.fn((code: string) => {
      if (isSignatureCall(code)) {
        return Promise.resolve({
          url: page.getURL(),
          title: page.getTitle(),
          nodeCount: 1,
          textLength: 0,
          textHash: 0,
          mainImageSrc: "",
          scrollY: 0,
          focusedValueLength: 0,
        });
      }
      return Promise.resolve({ ok: true });
    }),
    getURL: vi.fn(() => url),
    getTitle: vi.fn(() => title),
    goBack: vi.fn(() => {
      url = "https://example.com/back";
      title = "Example (back)";
    }),
    goForward: vi.fn(() => {
      url = "https://example.com/forward";
      title = "Example (forward)";
    }),
    reload: vi.fn(),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => true),
    isLoading: vi.fn(() => false),
    // DOM-readiness fix (`open`'s doc comment): resolves immediately by
    // default, modeling the common case where the DOM becomes ready (and,
    // for these instant fakes, the full load also settles) essentially
    // synchronously. Tests exercising the "DOM ready, full load still
    // pending/failing" split override this and/or `loadURL` explicitly.
    onceDomReady: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return page;
}

function makeFakeTarget(page: BrowserPageHandle | null): BrowserTarget & { ensurePage: ReturnType<typeof vi.fn> } {
  const ensurePage = vi.fn(async () => {
    if (!page) throw new Error("no page to create");
    return page;
  });
  return {
    ensurePage,
    currentPage: () => page,
  };
}

describe("BrowserController", () => {
  describe("open", () => {
    it("navigates the ensured page and returns its final url/title, with loaded: true once the full load settles", async () => {
      const page = makeFakePage({ getURL: vi.fn(() => "https://example.com/final") });
      const target = makeFakeTarget(page);
      const controller = new BrowserController(target);
      const result = await controller.open({ url: "https://example.com" });
      expect(target.ensurePage).toHaveBeenCalled();
      expect(page.loadURL).toHaveBeenCalledWith("https://example.com");
      // Old behavior asserted `{ url, title }` alone, encoding "open always
      // means fully loaded" — no longer true (that's the defect this fix
      // addresses), so the expectation now includes `loaded`.
      expect(result).toEqual({ url: "https://example.com/final", title: "Example", loaded: true });
    });

    it("resolves promptly with loaded: false when the DOM becomes ready but the full load never settles", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          getURL: vi.fn(() => "https://example.com/heavy"),
          getTitle: vi.fn(() => "Heavy Page"),
          // Models webContents.loadURL() resolving only at did-finish-load,
          // which on a heavy page (ads/trackers/video) may never happen
          // within any reasonable bound — the promise here just never
          // settles.
          loadURL: vi.fn(() => new Promise<void>(() => {})),
          onceDomReady: vi.fn(() => Promise.resolve()),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const promise = controller.open({ url: "https://example.com" });
        // Only the bounded grace period elapses — nowhere near
        // BROWSER_COMMAND_TIMEOUT_MS — proving `open` doesn't wait for the
        // full load at all.
        await vi.advanceTimersByTimeAsync(1_600);
        const result = await promise;
        expect(result).toEqual({ url: "https://example.com/heavy", title: "Heavy Page", loaded: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports loaded: true when the full load settles within the grace period after DOM-ready", async () => {
      vi.useFakeTimers();
      try {
        let resolveLoad!: () => void;
        const page = makeFakePage({
          getURL: vi.fn(() => "https://example.com/final"),
          loadURL: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                resolveLoad = resolve;
              }),
          ),
          onceDomReady: vi.fn(() => Promise.resolve()),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const promise = controller.open({ url: "https://example.com" });
        // Let the dom-ready branch win the initial race, then let the full
        // load settle well within OPEN_LOAD_GRACE_MS.
        await vi.advanceTimersByTimeAsync(0);
        resolveLoad();
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;
        expect(result).toEqual({ url: "https://example.com/final", title: "Example", loaded: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces a genuine navigation error that happens before DOM-ready as {error}, not swallowed", async () => {
      const page = makeFakePage({
        loadURL: vi.fn(() => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"))),
        // DOM-ready never fires for a navigation that fails outright.
        onceDomReady: vi.fn(() => new Promise<void>(() => {})),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.open({ url: "https://example.com" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/ERR_NAME_NOT_RESOLVED/);
    });

    it("does not produce an unhandled rejection when DOM-ready wins and loadURL rejects afterwards — the successful result stands", async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        let rejectLoad!: (err: Error) => void;
        const page = makeFakePage({
          getURL: vi.fn(() => "https://example.com/heavy"),
          loadURL: vi.fn(
            () =>
              new Promise<void>((_resolve, reject) => {
                rejectLoad = reject;
              }),
          ),
          onceDomReady: vi.fn(() => Promise.resolve()),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const promise = controller.open({ url: "https://example.com" });
        // Nothing but the bounded grace period elapses before `open`
        // returns — the load promise is still pending at that point.
        await vi.advanceTimersByTimeAsync(1_600);
        const result = await promise;
        expect(result).toEqual({ url: "https://example.com/heavy", title: "Example", loaded: false });
        // The load promise settles (rejects) only after `open` already
        // returned — this must not surface as an unhandled rejection.
        rejectLoad(new Error("net::ERR_CONNECTION_RESET"));
        await vi.advanceTimersByTimeAsync(0);
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        vi.useRealTimers();
      }
    });

    it("arms the DOM-ready listener before calling loadURL", async () => {
      const callOrder: string[] = [];
      const page = makeFakePage({
        onceDomReady: vi.fn(() => {
          callOrder.push("onceDomReady");
          return Promise.resolve();
        }),
        loadURL: vi.fn(() => {
          callOrder.push("loadURL");
          return Promise.resolve();
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.open({ url: "https://example.com" });
      expect(callOrder).toEqual(["onceDomReady", "loadURL"]);
    });

    it("rejects missing url", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({});
      expect(result).toHaveProperty("error");
    });

    it("rejects a non-string url", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({ url: 123 });
      expect(result).toHaveProperty("error");
    });

    it("rejects an empty-string url", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({ url: "   " });
      expect(result).toHaveProperty("error");
    });

    it("rejects non-http(s) schemes", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({ url: "file:///etc/passwd" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/http/i);
    });

    it("rejects entirely malformed arguments (array, string, null)", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.open(["https://example.com"])).toHaveProperty("error");
      expect(await controller.open("https://example.com")).toHaveProperty("error");
      expect(await controller.open(null)).toHaveProperty("error");
      expect(await controller.open(undefined)).toHaveProperty("error");
    });

    it("never rejects when ensurePage throws — resolves to an error result instead", async () => {
      const target = makeFakeTarget(null);
      const controller = new BrowserController(target);
      await expect(controller.open({ url: "https://example.com" })).resolves.toHaveProperty("error");
    });

    it("times out and resolves an error result if ensurePage never settles", async () => {
      vi.useFakeTimers();
      try {
        const target: BrowserTarget = {
          ensurePage: () => new Promise<BrowserPageHandle>(() => {}),
          currentPage: () => null,
        };
        const controller = new BrowserController(target, { timeoutMs: 50 });
        const promise = controller.open({ url: "https://example.com" });
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("act", () => {
    it("rejects a missing/unknown action", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.act({})).toHaveProperty("error");
      expect(await controller.act({ action: "teleport" })).toHaveProperty("error");
      expect(await controller.act(null)).toHaveProperty("error");
      expect(await controller.act("click")).toHaveProperty("error");
    });

    it("errors cleanly when no browser tab is open", async () => {
      const controller = new BrowserController(makeFakeTarget(null));
      const result = await controller.act({ action: "click", target: "Buy now" });
      expect(result).toHaveProperty("error");
    });

    describe("click", () => {
      it("requires a non-empty string target", async () => {
        const controller = new BrowserController(makeFakeTarget(makeFakePage()));
        expect(await controller.act({ action: "click" })).toHaveProperty("error");
        expect(await controller.act({ action: "click", target: "" })).toHaveProperty("error");
        expect(await controller.act({ action: "click", target: 42 })).toHaveProperty("error");
      });

      it("runs the click script against the current page and returns its result", async () => {
        // getURL/getTitle deliberately match what the script itself reports —
        // this exercises the non-navigating case (no url change), so the
        // post-click settle wait (finding 7) resolves immediately and the
        // page's own url/title are used, consistent with the script's.
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" })),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        // 3 calls: captureSignature (before), CLICK_JS, captureSignature
        // (after) — see "Addendum 2" §1. This fake's executeJavaScript
        // returns the same canned CLICK_JS-shaped object for every call
        // (including the two signature calls), which is not a valid
        // signature, so evidence capture degrades to changed: false rather
        // than throwing — covered on its own in the "evidence of effect"
        // block below.
        // 3 non-cursor calls (a 4th, the cursor overlay's CURSOR_JS, runs
        // before all of them — see isCursorCall's doc comment).
        expect(nonCursorCallCount(page.executeJavaScript as ReturnType<typeof vi.fn>)).toBe(3);
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify("Buy now"));
        expect(code).not.toContain("PEN_BROWSER_ARGS");
        expect(result).toEqual({ url: "https://x/", title: "X", matched: "Buy now", changed: false, changes: [] });
      });

      it("finding 7: settles to the post-navigation url/title when a click starts a navigation, rather than trusting the script's stale pre-navigation read", async () => {
        vi.useFakeTimers();
        try {
          let url = "https://example.com/";
          let title = "Example";
          const page = makeFakePage({
            getURL: vi.fn(() => url),
            getTitle: vi.fn(() => title),
            executeJavaScript: vi.fn(() => {
              // The real page: the script's own synchronous location.href
              // read reports the page it was on when the click ran, but the
              // click actually kicks off a navigation that lands shortly
              // after the script returns.
              setTimeout(() => {
                url = "https://example.com/next";
                title = "Next";
              }, 50);
              return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" });
            }),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(300);
          const result = await promise;
          // This fake's executeJavaScript is not signature-aware — it
          // returns the same click-shaped object for every call, including
          // the two signature captures — so before/after both fail
          // isPageSignature and captureSignature degrades to null for both.
          // Review finding 2: that must not silently report "no change" when
          // the URL plainly did (exactly the case a rejecting/malformed
          // signature capture during a cross-origin navigation swap is meant
          // to model) — diffSignatures falls back to the previousUrl/
          // currentUrl runClick already tracks, which is enough to report
          // "url" (title has no equivalent fallback, so it's not reported).
          expect(result).toEqual({
            url: "https://example.com/next",
            title: "Next",
            matched: "Go",
            changed: true,
            changes: ["url"],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("finding 7: does not misreport when a click does not navigate", async () => {
        vi.useFakeTimers();
        try {
          const page = makeFakePage({
            getURL: vi.fn(() => "https://example.com/"),
            getTitle: vi.fn(() => "Example"),
            executeJavaScript: vi.fn(() =>
              Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" }),
            ),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(300);
          const result = await promise;
          expect(result).toEqual({
            url: "https://example.com/",
            title: "Example",
            matched: "Go",
            changed: false,
            changes: [],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      // Finding 4 / addendum F ("Load, not commit"): the old settle wait
      // returned as soon as getURL() changed (navigation commit), not once
      // the document actually finished loading — a following
      // browse_find_images would then measure an unlaid-out document (every
      // getBoundingClientRect() 0x0) and a slow-to-commit navigation (>300ms)
      // would time out before ever seeing the new url/title at all.
      it("finding 4: waits for the navigated page to finish loading, not just for the url to change, before trusting the result", async () => {
        vi.useFakeTimers();
        try {
          let url = "https://example.com/";
          let title = "Example";
          let loading = false;
          const page = makeFakePage({
            getURL: vi.fn(() => url),
            getTitle: vi.fn(() => title),
            isLoading: vi.fn(() => loading),
            executeJavaScript: vi.fn(() => {
              // Commit happens quickly (well within the 300ms settle bound),
              // but the document keeps loading for a while after that.
              setTimeout(() => {
                url = "https://example.com/next";
                title = "Next (loading)";
                loading = true;
              }, 50);
              setTimeout(() => {
                title = "Next";
                loading = false;
              }, 1_000);
              return Promise.resolve({ url: "https://example.com/", title: "Example" });
            }),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(1_050);
          const result = await promise;
          // Must trust the settled post-load title, not the mid-load one, and
          // not the pre-navigation one either. Review finding 2: as above,
          // this fake's executeJavaScript isn't signature-aware, so the diff
          // comes from the previousUrl/currentUrl fallback — it correctly
          // reports the navigation ("url") rather than "no change".
          expect(result).toEqual({
            url: "https://example.com/next",
            title: "Next",
            changed: true,
            changes: ["url"],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("finding 4: a navigation whose url commit takes longer than the 300ms detection bound is still not misreported, because isLoading() flips true immediately", async () => {
        // Models real Electron: did-start-loading (isLoading() -> true) fires
        // essentially as soon as the navigation is requested, well before a
        // slow network response actually commits the new URL. Relying on
        // getURL() alone (the pre-fix behavior) would miss this navigation
        // entirely and return the stale pre-click url/title — the exact
        // "commit takes longer than 300ms" case from addendum F.
        vi.useFakeTimers();
        try {
          let url = "https://example.com/";
          let title = "Example";
          let loading = true; // isLoading() flips true right away
          const page = makeFakePage({
            getURL: vi.fn(() => url),
            getTitle: vi.fn(() => title),
            isLoading: vi.fn(() => loading),
            executeJavaScript: vi.fn(() => {
              // Commit (url/title change) doesn't land until 500ms — later
              // than CLICK_SETTLE_TIMEOUT_MS (300ms) — but the load finishes
              // (isLoading -> false) shortly after that.
              setTimeout(() => {
                url = "https://example.com/next";
                title = "Next";
              }, 500);
              setTimeout(() => {
                loading = false;
              }, 600);
              return Promise.resolve({ url: "https://example.com/", title: "Example" });
            }),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(650);
          const result = await promise;
          // Review finding 2: see the comment on the first "finding 7" test
          // above — this fake's executeJavaScript isn't signature-aware
          // either, so the diff again comes from the previousUrl/currentUrl
          // fallback.
          expect(result).toEqual({ url: "https://example.com/next", title: "Next", changed: true, changes: ["url"] });
        } finally {
          vi.useRealTimers();
        }
      });

      it("surfaces a page-reported error (element not found) as the result", async () => {
        const page = makeFakePage({
          executeJavaScript: vi.fn(() => Promise.resolve({ error: "No element matched: Buy now" })),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toEqual({ error: "No element matched: Buy now" });
      });

      it("resolves an error result when the page script throws", async () => {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.reject(new Error("boom"))) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toContain("boom");
      });

      it("resolves an error when executeJavaScript returns a non-object", async () => {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.resolve("not an object")) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toHaveProperty("error");
      });
    });

    describe("type", () => {
      it("requires target and text", async () => {
        const controller = new BrowserController(makeFakeTarget(makeFakePage()));
        expect(await controller.act({ action: "type", target: "Search" })).toHaveProperty("error");
        expect(await controller.act({ action: "type", text: "hello" })).toHaveProperty("error");
        expect(await controller.act({ action: "type", target: "Search", text: 5 })).toHaveProperty("error");
      });

      it("embeds target and text as JSON in the script", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "type", target: "Search", text: 'a "quoted" value' });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify("Search"));
        expect(code).toContain(JSON.stringify("Search"));
        expect(code).toContain(JSON.stringify('a "quoted" value'));
      });

      // Finding 2: String.prototype.replace's *string* replacement form
      // treats $&, $`, $' and $$ as special patterns. A plain
      // `.replace(ARGS_MARKER, JSON.stringify(args))` call would silently
      // mangle (or, for $', truncate/splice) any of these sequences inside
      // a target/text value that came from an LLM tool call.
      it("does not interpret $& in text as a replacement pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "type", target: "Price", text: "price is $&" });
        const code = findScriptCall(
          page.executeJavaScript as ReturnType<typeof vi.fn>,
          JSON.stringify({ target: "Price", text: "price is $&" }),
        );
        expect(code).toContain(JSON.stringify({ target: "Price", text: "price is $&" }));
      });

      it("does not interpret $` in target as a replacement pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "click", target: "a$`b" });
        const code = findScriptCall(
          page.executeJavaScript as ReturnType<typeof vi.fn>,
          JSON.stringify({ target: "a$`b" }),
        );
        expect(code).toContain(JSON.stringify({ target: "a$`b" }));
      });

      it("does not let $' in target splice page source into the script (never breaks out of the JSON literal)", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "click", target: "$'" });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify({ target: "$'" }));
        expect(code).toContain(JSON.stringify({ target: "$'" }));
        // The rest of the script (e.g. the findByText helper) must still be
        // present intact after the substitution point.
        expect(code).toContain("findByText");
      });

      it("does not interpret $$ in text as an escaped-dollar pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "type", target: "Amount", text: "$$100" });
        const code = findScriptCall(
          page.executeJavaScript as ReturnType<typeof vi.fn>,
          JSON.stringify({ target: "Amount", text: "$$100" }),
        );
        expect(code).toContain(JSON.stringify({ target: "Amount", text: "$$100" }));
      });
    });

    describe("scroll", () => {
      it("defaults amount to 1", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "scroll" });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify({ amount: 1 }));
        expect(code).toContain(JSON.stringify({ amount: 1 }));
      });

      it("rejects a non-number amount", async () => {
        const controller = new BrowserController(makeFakeTarget(makeFakePage()));
        const result = await controller.act({ action: "scroll", amount: "a lot" });
        expect(result).toHaveProperty("error");
      });

      it("passes a numeric amount through", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "scroll", amount: 2.5 });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify({ amount: 2.5 }));
        expect(code).toContain(JSON.stringify({ amount: 2.5 }));
      });
    });

    describe("back / forward", () => {
      it("back calls goBack and reports the post-navigation url/title, with changed evidence for the navigation", async () => {
        const page = makeFakePage({ canGoBack: vi.fn(() => true) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "back" });
        expect(page.goBack).toHaveBeenCalled();
        // The default fake's signature capture reflects the page's live
        // getURL()/getTitle(), so a real navigation is real evidence here —
        // "Addendum 2" §1.
        expect(result).toEqual({
          url: "https://example.com/back",
          title: "Example (back)",
          changed: true,
          changes: ["url", "title"],
        });
      });

      it("back errors cleanly when there is no history", async () => {
        const page = makeFakePage({ canGoBack: vi.fn(() => false) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "back" });
        expect(page.goBack).not.toHaveBeenCalled();
        expect(result).toHaveProperty("error");
      });

      it("forward calls goForward when there is forward history, and reports the post-navigation url/title with changed evidence", async () => {
        const page = makeFakePage({ canGoForward: vi.fn(() => true) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "forward" });
        expect(page.goForward).toHaveBeenCalled();
        expect(result).toEqual({
          url: "https://example.com/forward",
          title: "Example (forward)",
          changed: true,
          changes: ["url", "title"],
        });
      });

      // Finding 4: forward had no equivalent to back's canGoBack() guard —
      // with no forward history, goForward() silently no-ops, and
      // waitForUrlChange would burn its full wait before reporting success
      // on an unchanged page.
      it("forward errors cleanly when there is no forward history, without calling goForward", async () => {
        const page = makeFakePage({ canGoForward: vi.fn(() => false) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "forward" });
        expect(page.goForward).not.toHaveBeenCalled();
        expect(result).toHaveProperty("error");
      });
    });

    it("times out a hung page script and resolves an error result", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => new Promise(() => {})) });
        // cursor: false — this test is about the plain command timeout, not
        // the cursor's budget extension (see the "cursor budget extension
        // (finding 1)" describe block below for that).
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50, cursor: false });
        const promise = controller.act({ action: "click", target: "x" });
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // jev-loop design doc "Addendum 2, 2026-09-19" §1: act/perform must
  // report `{ changed, changes }` alongside their existing return shape,
  // and `changed: false` must be a normal, reportable answer — never an
  // error. These use a signature-aware executeJavaScript override so the
  // before/after diff reflects a real (or genuinely absent) page change,
  // unlike most of the tests above whose fakes return a fixed shape for
  // every script and so always degrade to changed: false.
  describe("evidence of effect ('changed'/'changes')", () => {
    it("click reports changed: false, changes: [] when nothing about the page changed — not an error", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 42,
                textLength: 100,
                textHash: 555,
                mainImageSrc: "https://example.com/same.jpg",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Go" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    it("click reports changed: true with 'main-image' when the largest visible image swaps and nothing else does", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              nodeCount: 42,
              textLength: 100,
              textHash: 555,
              mainImageSrc: signatureCalls === 1 ? "https://example.com/before.jpg" : "https://example.com/after.jpg",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Next" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Next" });
      expect(result).toMatchObject({ changed: true, changes: ["main-image"] });
    });

    // Review finding 4: a whole-document text delta used to gate `changed`
    // on its own, but that's exactly the noise finding 4 exists to filter
    // out — a rotating carousel, a live price, or an injected ad moves
    // nodeCount/textLength/textHash between two captures milliseconds apart
    // with nothing the agent did causing it. "text" (and "dom") are still
    // reported in `changes` as useful context, but no longer set `changed`
    // by themselves; only url/title/main-image (identity-guarded)/scroll/
    // focused-value/the acted-on element's own scoped signature do. This
    // test used to assert the opposite (changed: true) — updated to match
    // the corrected semantics.
    it("click reports changed: false even though 'text' is in `changes`, when only the whole-document text delta moved (no navigation, no image change, no scoped-element change)", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              nodeCount: 42,
              textLength: signatureCalls === 1 ? 100 : 140,
              textHash: signatureCalls === 1 ? 555 : 777,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Add to cart" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Add to cart" });
      expect(result).toMatchObject({ changed: false, changes: ["text"] });
    });

    it("perform CLICK also carries changed evidence, computed the same way as act's click", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: signatureCalls === 1 ? "Example" : "Example (after)",
              nodeCount: 10,
              textLength: 10,
              textHash: 10,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).toMatchObject({ changed: true, changes: ["title"] });
    });

    it("perform SCROLL_DOWN with no real page change reports changed: false, not an error", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SCROLL_DOWN" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    it("a signature-capture failure (executeJavaScript rejects) degrades to changed: false rather than turning a successful action into an error", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.reject(new Error("signature capture boom"));
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Go" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
      expect(signatureCalls).toBeGreaterThan(0);
    });

    // Review finding 4: the acted-on element's own scoped signature (via
    // CLICK_JS's `__scopedBefore` + SIGNATURE_JS's `scopedAfter`) must gate
    // `changed` even while the whole-document dom/text noise moves too —
    // dom/text alone (asserted above) must not, but a real per-element
    // change must, regardless of what else is moving around it.
    it("click reports changed: true via the scoped target signature (aria-expanded flip) even while dom/text noise moves around it", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              // Whole-document noise moves on every call — a carousel/ad —
              // but must not by itself set changed (see the "text" test
              // above); it's the scopedAfter diff that should.
              nodeCount: signatureCalls,
              textLength: signatureCalls,
              textHash: signatureCalls,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
              scopedAfter:
                signatureCalls === 1
                  ? undefined
                  : { nodeCount: 3, textHash: 9, src: "", valueLength: 0, ariaExpanded: "true", ariaSelected: "", checked: false },
            });
          }
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            matched: "Menu",
            __scopedBefore: { nodeCount: 3, textHash: 9, src: "", valueLength: 0, ariaExpanded: "false", ariaSelected: "", checked: false },
          });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Menu" });
      expect(result).toMatchObject({ changed: true, changes: expect.arrayContaining(["dom", "text", "target"]) });
      // The internal marker field must never leak into the caller-visible result.
      expect(result).not.toHaveProperty("__scopedBefore");
    });

    // Review finding 4 (main-image identity guard): the largest visible
    // image can change identity between captures (an ad finishes loading
    // and is now bigger than the real photo) without the *original* image's
    // own src having changed at all — that must not be reported as
    // "main-image" changed, since nothing the click did moved that element.
    it("click does not report 'main-image' when a newly-loaded element becomes the largest visible image but the originally-tracked image's own src is unchanged", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                // SIGNATURE_JS's own identity marker means "after" always
                // re-reads the *same* element "before" marked as largest —
                // this fake models that directly: the src never changes.
                mainImageSrc: "https://example.com/original.jpg",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Load ad" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Load ad" });
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    // Review finding 3: scroll used to have no field in the signature that
    // moved when it succeeded, and no settle before the after-capture —
    // indistinguishable from scrolling a dead page. scrollY is now part of
    // the signature and gates `changed` on its own (it doesn't drift on its
    // own the way dom/text can, so it's trustworthy evidence, not noise).
    it("act scroll reports changed: true via scrollY moving, and waits for the settle before capturing 'after'", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: signatureCalls++ === 0 ? 0 : 600,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "scroll", amount: 1 });
      expect(result).toMatchObject({ changed: true, changes: ["scroll"] });
    });

    it("act scroll with no real scroll movement reports changed: false, not an error", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "scroll", amount: 1 });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    // Review finding 3: typing into a field used to report changed: false
    // unconditionally (nothing in the signature moved for it) — the scoped
    // target signature (TYPE_JS marks the field and reports its own
    // valueLength, same mechanism as CLICK_JS) is what now makes a
    // successful type distinguishable from typing into a dead field.
    it("act type reports changed: true via the scoped target's valueLength, even with no document-wide change", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
                scopedAfter: { nodeCount: 1, textHash: 0, src: "", valueLength: 5, ariaExpanded: "", ariaSelected: "", checked: false },
              })
            : Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                matched: "Search",
                __scopedBefore: { nodeCount: 1, textHash: 0, src: "", valueLength: 0, ariaExpanded: "", ariaSelected: "", checked: false },
              }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "type", target: "Search", text: "hello" });
      expect(result).toMatchObject({ changed: true, changes: ["target"] });
    });
  });

  describe("findImages", () => {
    let page: BrowserPageHandle;
    let controller: BrowserController;

    beforeEach(() => {
      page = makeFakePage({
        executeJavaScript: vi.fn(() =>
          Promise.resolve({
            images: [{ url: "https://x/a.jpg", alt: "", width: 400, height: 300 }],
            count: 1,
            pageUrl: "https://example.com/",
          }),
        ),
      });
      controller = new BrowserController(makeFakeTarget(page));
    });

    it("uses default minWidth/minHeight/limit when no args are given", async () => {
      await controller.findImages(undefined);
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify({ minWidth: 200, minHeight: 200, limit: 30 }));
    });

    it("passes through provided minWidth/minHeight/limit", async () => {
      await controller.findImages({ minWidth: 50, minHeight: 60, limit: 5 });
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify({ minWidth: 50, minHeight: 60, limit: 5 }));
    });

    it("hard-caps limit at 100 even if a larger value is requested", async () => {
      await controller.findImages({ limit: 5000 });
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify({ minWidth: 200, minHeight: 200, limit: 100 }));
    });

    it("rejects a non-numeric minWidth", async () => {
      const result = await controller.findImages({ minWidth: "big" });
      expect(result).toHaveProperty("error");
    });

    it("rejects a negative minHeight", async () => {
      const result = await controller.findImages({ minHeight: -1 });
      expect(result).toHaveProperty("error");
    });

    it("rejects array/string arguments", async () => {
      expect(await controller.findImages([1, 2])).toHaveProperty("error");
      expect(await controller.findImages("nope")).toHaveProperty("error");
    });

    it("returns the page script's result on success", async () => {
      const result = await controller.findImages({});
      expect(result).toEqual({
        images: [{ url: "https://x/a.jpg", alt: "", width: 400, height: 300 }],
        count: 1,
        pageUrl: "https://example.com/",
      });
    });

    it("errors cleanly when no browser tab is open", async () => {
      const noPageController = new BrowserController(makeFakeTarget(null));
      const result = await noPageController.findImages({});
      expect(result).toHaveProperty("error");
    });
  });

  // jev-loop design doc "Addendum 2, 2026-09-19" §2.
  describe("read", () => {
    it("rejects array/string arguments", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.read([1, 2])).toHaveProperty("error");
      expect(await controller.read("nope")).toHaveProperty("error");
    });

    it("rejects a non-positive or non-numeric maxChars", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.read({ maxChars: 0 })).toHaveProperty("error");
      expect(await controller.read({ maxChars: -5 })).toHaveProperty("error");
      expect(await controller.read({ maxChars: "big" })).toHaveProperty("error");
    });

    it("rejects an empty/non-string selector", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.read({ selector: "" })).toHaveProperty("error");
      expect(await controller.read({ selector: "   " })).toHaveProperty("error");
      expect(await controller.read({ selector: 5 })).toHaveProperty("error");
    });

    it("defaults maxChars to 6000 and selector to null when no args are given", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read(undefined);
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 6000, selector: null }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 6000, selector: null }));
    });

    it("passes a provided selector through", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read({ selector: "#main" });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 6000, selector: "#main" }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 6000, selector: "#main" }));
    });

    // Hard cap: 20000, regardless of what the caller asks for.
    it("clamps a requested maxChars above the 20000 hard cap", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read({ maxChars: 999_999 });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 20_000, selector: null }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 20_000, selector: null }));
    });

    it("accepts a requested maxChars under the hard cap unchanged", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read({ maxChars: 500 });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 500, selector: null }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 500, selector: null }));
    });

    it("returns the page script's digest on success", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({ ok: true })
            : Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                headings: ["Welcome"],
                text: "Hello world",
                links: [{ label: "Home", href: "https://example.com/" }],
                truncated: false,
              }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.read({});
      expect(result).toEqual({
        url: "https://example.com/",
        title: "Example",
        headings: ["Welcome"],
        text: "Hello world",
        links: [{ label: "Home", href: "https://example.com/" }],
        truncated: false,
      });
    });

    // "A selector that matches nothing is an error, not a silent whole-page
    // read" — the page script itself decides this (READ_JS returns
    // { error } rather than falling back), and the controller must surface
    // it verbatim rather than widening the read.
    it("surfaces the page script's selector-miss error rather than falling back to a whole-page read", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn(() =>
          Promise.resolve({ error: 'browse_read: no element matched selector "#nope"' }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.read({ selector: "#nope" });
      expect(result).toEqual({ error: 'browse_read: no element matched selector "#nope"' });
    });

    it("errors cleanly when no browser tab is open", async () => {
      const controller = new BrowserController(makeFakeTarget(null));
      const result = await controller.read({});
      expect(result).toHaveProperty("error");
    });
  });

  describe("snapshot", () => {
    it("runs SNAPSHOT_JS and returns the page's result with a freshly minted snapshotId", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn(() =>
          Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            elements: [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
            scroll: { y: 0, height: 1000, atBottom: false },
          }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { snapshotId: string; elements: unknown[] };
      expect(page.executeJavaScript).toHaveBeenCalledTimes(1);
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).not.toContain("PEN_BROWSER_ARGS");
      expect(typeof result.snapshotId).toBe("string");
      expect(result.snapshotId.length).toBeGreaterThan(0);
      expect(result.elements).toEqual([{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }]);
    });

    it("embeds the generated snapshotId and MAX_SNAPSHOT_ELEMENTS as the script's args", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { snapshotId: string };
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify(result.snapshotId));
      expect(code).toContain(JSON.stringify({ snapshotId: result.snapshotId, maxElements: 120 }));
    });

    it("errors cleanly when no browser tab is open", async () => {
      const controller = new BrowserController(makeFakeTarget(null));
      const result = await controller.snapshot();
      expect(result).toHaveProperty("error");
    });

    it("times out and resolves an error result if the page script never settles", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => new Promise(() => {})) });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50 });
        const promise = controller.snapshot();
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("perform", () => {
    it("rejects malformed arguments", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.perform(undefined)).toHaveProperty("error");
      expect(await controller.perform(null)).toHaveProperty("error");
      expect(await controller.perform("nope")).toHaveProperty("error");
      expect(await controller.perform([1])).toHaveProperty("error");
    });

    it("rejects a missing/non-string snapshotId", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.perform({ index: 0, operation: "CLICK" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/snapshotId/i);
    });

    it("rejects a non-integer or negative index", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: -1, operation: "CLICK" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: 1.5, operation: "CLICK" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: "0", operation: "CLICK" }),
      ).toHaveProperty("error");
    });

    it("rejects an unknown operation", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TELEPORT" });
      expect(result).toHaveProperty("error");
    });

    it("requires text for TYPE_TEXT and SELECT", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "SELECT" }),
      ).toHaveProperty("error");
    });

    // Finding 6 / addendum A: index is required only for CLICK/TYPE_TEXT/
    // SELECT — SCROLL_UP/SCROLL_DOWN act on the page itself and must be
    // accepted with no index at all, or scrolling always fails at the
    // bridge, breaking the advertised infinite-scroll-grid mechanism.
    it("finding 6: accepts SCROLL_UP/SCROLL_DOWN with no index at all", async () => {
      const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://x/", title: "X" })) });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const down = await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SCROLL_DOWN" });
      expect(down).not.toHaveProperty("error");
      const up = await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SCROLL_UP" });
      expect(up).not.toHaveProperty("error");
      // The script args sent must not carry a garbage/undefined index.
      const lastCode = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ snapshotId: snapshot.snapshotId, operation: "SCROLL_UP" }),
      );
      expect(lastCode).toContain(JSON.stringify({ snapshotId: snapshot.snapshotId, operation: "SCROLL_UP" }));
    });

    it("still requires index for CLICK/TYPE_TEXT/SELECT", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(await controller.perform({ snapshotId: snapshot.snapshotId, operation: "CLICK" })).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, operation: "TYPE_TEXT", text: "hi" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SELECT", text: "hi" }),
      ).toHaveProperty("error");
    });

    it("rejects a stale snapshotId (never having taken a snapshot)", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.perform({ snapshotId: "made-up-id", index: 0, operation: "CLICK" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/stale|unknown/i);
    });

    it("rejects a snapshotId superseded by a newer snapshot() call — the one way the indexed design can go quietly wrong", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      const firstSnapshot = (await controller.snapshot()) as { snapshotId: string };
      await controller.snapshot(); // supersedes firstSnapshot's id
      const result = await controller.perform({
        snapshotId: firstSnapshot.snapshotId,
        index: 0,
        operation: "CLICK",
      });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/stale|unknown/i);
      // Must not have even attempted to run a page script for the stale call.
      expect(page.executeJavaScript).toHaveBeenCalledTimes(2); // the two snapshot() calls only
    });

    it("runs PERFORM_JS with the validated args once the snapshotId matches", async () => {
      // CLICK's settle logic (below) always trusts page.getURL()/getTitle()
      // for the final result over the script's own report, so this fake's
      // getURL/getTitle are set to match what the script returns.
      const page = makeFakePage({
        getURL: vi.fn(() => "https://x/"),
        getTitle: vi.fn(() => "X"),
        executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://x/", title: "X" })),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" });
      // This fake's executeJavaScript ignores which script it was called
      // with, so neither before/after signature capture (see makeFakePage's
      // doc comment) sees a valid signature here — changed stays false.
      expect(result).toEqual({ url: "https://x/", title: "X", changed: false, changes: [] });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" }),
      );
      // JSON.stringify drops an `undefined` property (text is omitted for CLICK).
      expect(code).toContain(JSON.stringify({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" }));
    });

    it("CLICK reuses the click-settle wait: trusts the post-navigation url/title over the script's stale pre-navigation read", async () => {
      vi.useFakeTimers();
      try {
        let url = "https://example.com/";
        let title = "Example";
        const page = makeFakePage({
          getURL: vi.fn(() => url),
          getTitle: vi.fn(() => title),
          executeJavaScript: vi.fn(() => {
            setTimeout(() => {
              url = "https://example.com/next";
              title = "Next";
            }, 50);
            return Promise.resolve({ url: "https://example.com/", title: "Example" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
        await vi.advanceTimersByTimeAsync(300);
        const result = await promise;
        // Review finding 2: this fake's executeJavaScript isn't
        // signature-aware, so before/after both degrade to null and the
        // diff comes from the previousUrl/currentUrl fallback — see the
        // "finding 7"/"finding 4" comments in the act/click tests above for
        // the full explanation.
        expect(result).toEqual({ url: "https://example.com/next", title: "Next", changed: true, changes: ["url"] });
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces a page-reported error (element not found) as the result", async () => {
      // Four executeJavaScript calls before PERFORM_JS's error is reached:
      // snapshot()'s SNAPSHOT_JS, perform()'s cursor call, its
      // before-signature capture, then PERFORM_JS itself — an error result
      // short-circuits before the after-signature capture, so no fifth
      // call/entry is needed.
      const executeJavaScript = vi
        .fn()
        .mockResolvedValueOnce({
          url: "https://example.com/",
          title: "Example",
          elements: [],
          scroll: { y: 0, height: 0, atBottom: true },
        })
        .mockResolvedValueOnce({ moved: false }) // cursor call (no valid x/y; harmless)
        .mockResolvedValueOnce({ url: "https://example.com/", title: "Example" }) // before-signature (not a valid one; harmless)
        .mockResolvedValueOnce({ error: "No element at index 0 for this snapshot." });
      const page = makeFakePage({ executeJavaScript });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).toEqual({ error: "No element at index 0 for this snapshot." });
    });

    // Finding 5: lastSnapshotId used to be a bare string, justified by
    // "there is only ever one browser tab" — but File ▸ New Browser Tab and
    // popups both make more than one possible. If the active/most-recent
    // browser tab changes between snapshot() and perform(), a cross-tab
    // perform must fail with an accurate error instead of passing the
    // staleness check (same id) and only then failing in-page against the
    // wrong tab's DOM with a misleading "no element" message.
    it("finding 5 (two-browser-tab case): a perform against a different tab than the one snapshot() ran on fails with an accurate cross-tab error", async () => {
      const pageA = makeFakePage({ getURL: vi.fn(() => "https://a.example/") });
      const pageB = makeFakePage({ getURL: vi.fn(() => "https://b.example/") });
      let current: BrowserPageHandle | null = pageA;
      const target: BrowserTarget = {
        ensurePage: async () => current!,
        currentPage: () => current,
      };
      const controller = new BrowserController(target);
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(pageA.executeJavaScript).toHaveBeenCalledTimes(1);

      // The user (or a popup handler) switches the active/most-recent
      // browser tab to B before the agent's perform() call lands.
      current = pageB;
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });

      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/tab/i);
      // Must never have attempted to run PERFORM_JS against tab B's DOM —
      // the failure is the controller's staleness check, not an in-page
      // "no element" lookup miss.
      expect(pageB.executeJavaScript).not.toHaveBeenCalled();
    });

    it("finding 5: a perform against the same tab snapshot() ran on still succeeds when a second browser tab exists", async () => {
      const pageA = makeFakePage({
        getURL: vi.fn(() => "https://a.example/"),
        getTitle: vi.fn(() => "A"),
        executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://a.example/", title: "A" })),
      });
      const pageB = makeFakePage({ getURL: vi.fn(() => "https://b.example/") });
      let current: BrowserPageHandle | null = pageA;
      const target: BrowserTarget = {
        ensurePage: async () => current!,
        currentPage: () => current,
      };
      const controller = new BrowserController(target);
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      void pageB; // exists in the strip but is never the active/current page here
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "SCROLL_DOWN" });
      expect(result).not.toHaveProperty("error");
    });

    it("errors cleanly when no browser tab is open at perform time, even with a valid snapshotId", async () => {
      const page = makeFakePage();
      const target = makeFakeTarget(page);
      const controller = new BrowserController(target);
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      // Simulate the tab having gone away between snapshot() and perform().
      target.currentPage = () => null;
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).toHaveProperty("error");
    });

    it("times out a hung page script and resolves an error result", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.resolve({ ok: true })) });
        // cursor: false — see the sibling "act" timeout test's comment above.
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50, cursor: false });
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        (page.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
        const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "SCROLL_DOWN" });
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("open's own timeout budget", () => {
  // Measured against the live site 2026-09-19: an amazon.com search stalled
  // past the 20s command budget in roughly one run in four, while the rest
  // finished in ~2s. The DOM-ready race cannot help there — when the server
  // is slow the document itself hasn't arrived, so `dom-ready` hasn't fired
  // and there is nothing to race. A navigation simply needs longer than a
  // script evaluation against an existing page.
  it("gives open a longer default budget than every other command", () => {
    expect(BROWSER_OPEN_TIMEOUT_MS).toBeGreaterThan(BROWSER_COMMAND_TIMEOUT_MS);
  });

  it("uses that longer budget for open by default", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        // Neither ever settles: the command can only end by timing out.
        loadURL: vi.fn(() => new Promise<void>(() => {})),
        onceDomReady: vi.fn(() => new Promise<void>(() => {})),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const pending = controller.open({ url: "https://example.com/" });
      await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_TIMEOUT_MS + 1_000);
      // Still running well past the ordinary command budget.
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(BROWSER_OPEN_TIMEOUT_MS);
      const result = await pending;
      expect(JSON.stringify(result)).toMatch(String(BROWSER_OPEN_TIMEOUT_MS));
    } finally {
      vi.useRealTimers();
    }
  });

  it("an explicitly supplied timeoutMs still bounds open — a caller asking for a short budget means it", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        loadURL: vi.fn(() => new Promise<void>(() => {})),
        onceDomReady: vi.fn(() => new Promise<void>(() => {})),
      });
      const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 5_000 });
      const pending = controller.open({ url: "https://example.com/" });
      await vi.advanceTimersByTimeAsync(5_100);
      expect(JSON.stringify(await pending)).toMatch("5000");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Upstream jev-ultrafast PR #58, ported: a control that disables itself
// while its handler runs used to defeat the very next observation — the
// acted control is `:disabled` (so SNAPSHOT_JS skips it), the controls the
// handler will enable are not there yet, and the model is offered neither.
// The acting script now reports `__targetSelfDisabled` and the action waits
// (bounded) for the control to come back before capturing "after".
describe("self-disabling control", () => {
  /** TARGET_BUSY_JS is the only script whose body contains this literal. */
  function isBusyCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("present: false");
  }

  function makeBusyPage(busyAnswers: boolean[], selfDisabled = true) {
    const order: string[] = [];
    let busyCalls = 0;
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isSignatureCall(code)) {
          order.push("signature");
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            nodeCount: 1,
            textLength: 0,
            textHash: 0,
            mainImageSrc: "",
            scrollY: 0,
            focusedValueLength: 0,
          });
        }
        if (isBusyCall(code)) {
          const busy = busyAnswers[Math.min(busyCalls, busyAnswers.length - 1)];
          busyCalls++;
          order.push(`busy:${busy}`);
          return Promise.resolve({ present: true, busy });
        }
        order.push("action");
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          __targetSelfDisabled: selfDisabled,
        });
      }),
    });
    return { page, order, busyCalls: () => busyCalls };
  }

  it("waits for the acted control to stop being busy before capturing the after state", async () => {
    vi.useFakeTimers();
    try {
      const { page, order } = makeBusyPage([true, true, false]);
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await promise;

      // The busy polls sit between the action and the after-capture, and the
      // after-capture only runs once the control reported itself free.
      expect(order.slice(order.lastIndexOf("action"))).toEqual([
        "action",
        "busy:true",
        "busy:true",
        "busy:false",
        "signature",
      ]);
      // The internal flag never reaches the caller (same rule as
      // __scopedBefore).
      expect(result).not.toHaveProperty("__targetSelfDisabled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll at all when the action did not make the control busy", async () => {
    const { page, order } = makeBusyPage([false], false);
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT", text: "hi" });

    expect(order.filter((o) => o.startsWith("busy:"))).toEqual([]);
  });

  it("gives up after the 3s bound when the control never comes back, rather than hanging the command", async () => {
    vi.useFakeTimers();
    try {
      const { page, order } = makeBusyPage([true]);
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_TIMEOUT_MS);
      const result = await promise;

      expect(result).not.toHaveProperty("error");
      expect(order[order.length - 1]).toBe("signature");
      // 3s bound at a 50ms poll interval — bounded, and well under the 20s
      // command timeout that would otherwise turn this into an error.
      expect(order.filter((o) => o === "busy:true").length).toBeLessThanOrEqual(61);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the wait when the element disappears (re-render or navigation)", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              nodeCount: 1,
              textLength: 0,
              textHash: 0,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
          return Promise.resolve({ url: "https://example.com/", title: "Example", __targetSelfDisabled: true });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await promise).not.toHaveProperty("error");
    } finally {
      vi.useRealTimers();
    }
  });
});

// The visible cursor overlay (design: a human watching the browser tab must
// see the agent's clicks/typing land somewhere, not appear instantly and
// invisibly). CURSOR_JS runs before every click/type/scroll/perform action's
// before-signature capture — see its doc comment in pageScripts.ts.
describe("human cursor", () => {
  it("runs a cursor script carrying the target before CLICK_JS", async () => {
    const order: string[] = [];
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isCursorCall(code)) order.push("cursor");
        else if (isSignatureCall(code)) order.push("signature");
        else order.push("action");
        return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Buy now" });
      }),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    await controller.act({ action: "click", target: "Buy now" });

    expect(order[0]).toBe("cursor");
    expect(order.indexOf("cursor")).toBeLessThan(order.indexOf("signature"));

    const cursorCall = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      isCursorCall(c[0] as string),
    );
    expect(cursorCall, "no cursor call was made").toBeTruthy();
    const code = cursorCall![0] as string;
    expect(code).toContain(JSON.stringify("Buy now"));
    expect(code).toContain(JSON.stringify({ action: "click", target: "Buy now", from: null }));
  });

  it("perform with CLICK passes the snapshotId/index to the cursor call", async () => {
    const page = makeFakePage();
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" });

    const cursorCall = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      isCursorCall(c[0] as string),
    );
    expect(cursorCall, "no cursor call was made").toBeTruthy();
    const code = cursorCall![0] as string;
    expect(code).toContain(JSON.stringify({ action: "click", snapshotId: snapshot.snapshotId, index: 3, from: null }));
  });

  it("feeds the position a cursor call returns back as 'from' on the next cursor call", async () => {
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isCursorCall(code)) return Promise.resolve({ moved: true, x: 111, y: 222 });
        if (isSignatureCall(code)) return Promise.resolve({ ok: true });
        return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" });
      }),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    await controller.act({ action: "click", target: "Go" });
    await controller.act({ action: "click", target: "Go again" });

    const cursorCalls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      isCursorCall(c[0] as string),
    );
    expect(cursorCalls.length).toBe(2);
    expect(cursorCalls[0][0] as string).toContain(JSON.stringify({ action: "click", target: "Go", from: null }));
    expect(cursorCalls[1][0] as string).toContain(
      JSON.stringify({ action: "click", target: "Go again", from: { x: 111, y: 222 } }),
    );
  });

  it("a cursor script that rejects leaves the command's result unchanged and successful", async () => {
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isCursorCall(code)) return Promise.reject(new Error("cursor boom"));
        if (isSignatureCall(code)) return Promise.resolve({ ok: true });
        return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
      }),
      getURL: vi.fn(() => "https://x/"),
      getTitle: vi.fn(() => "X"),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "click", target: "Buy now" });
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ url: "https://x/", title: "X", matched: "Buy now" });
  });

  it("a cursor script that times out leaves the command's result unchanged and successful", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isCursorCall(code)) return new Promise(() => {}); // never settles
          if (isSignatureCall(code)) return Promise.resolve({ ok: true });
          return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
        }),
        getURL: vi.fn(() => "https://x/"),
        getTitle: vi.fn(() => "X"),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "click", target: "Buy now" });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ url: "https://x/", title: "X", matched: "Buy now" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues no cursor call at all when constructed with cursor: false", async () => {
    const page = makeFakePage();
    const controller = new BrowserController(makeFakeTarget(page), { cursor: false });
    await controller.act({ action: "click", target: "Go" });
    await controller.act({ action: "type", target: "Search", text: "hi" });
    await controller.act({ action: "scroll" });
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });

    const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(false);
  });

  // Finding 1: the cursor's own bound must be ADDED to a command's budget,
  // not spent out of it — moveCursor runs inside the same withCommandTimeout
  // closure the action itself needs, so a short caller-supplied timeoutMs
  // used to leave less than timeoutMs available for the actual action.
  describe("cursor budget extension (finding 1)", () => {
    it("extends the command budget by the cursor's own bound, so a slow action script still gets its full timeoutMs", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isCursorCall(code)) return Promise.resolve({ moved: false, x: 0, y: 0 });
            if (isSignatureCall(code)) return Promise.resolve({ ok: true });
            // The action script itself never resolves — models a slow page.
            return new Promise(() => {});
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 1_000 });
        const promise = controller.act({ action: "click", target: "Buy now" });

        // Just under timeoutMs alone: if the cursor's bound were carved out
        // of the budget instead of added to it, the command would already
        // have timed out by here.
        await vi.advanceTimersByTimeAsync(900);
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        // Push well past timeoutMs alone but still under timeoutMs +
        // cursorBudgetMs (1000 + min(1000, 1500) = 2000) — still not timed out.
        await vi.advanceTimersByTimeAsync(900);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        // Now past the full extended budget — the command must time out,
        // and the reported budget in the error message is the extended one.
        await vi.advanceTimersByTimeAsync(300);
        const result = await promise;
        expect(result).toMatchObject({ error: expect.stringContaining("2000ms") });
      } finally {
        vi.useRealTimers();
      }
    });

    it("perform also extends its budget by the cursor's own bound", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isCursorCall(code)) return Promise.resolve({ moved: false, x: 0, y: 0 });
            if (isSignatureCall(code)) return Promise.resolve({ ok: true });
            // SNAPSHOT_JS itself must resolve normally (its own budget carries
            // no cursor step) — only the subsequent PERFORM_JS call hangs.
            if (code.includes("INTERACTIVE_SELECTOR")) return Promise.resolve({ elements: [] });
            return new Promise(() => {}); // PERFORM_JS hangs
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 1_000 });
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });

        await vi.advanceTimersByTimeAsync(1_500);
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result).toMatchObject({ error: expect.stringContaining("2000ms") });
      } finally {
        vi.useRealTimers();
      }
    });

    it("back/forward, which never run a cursor step, keep the plain timeoutMs budget", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          canGoBack: vi.fn(() => true),
          getURL: vi.fn(() => "https://example.com/"), // never changes -> waitForUrlChange never resolves early
          executeJavaScript: vi.fn(() => new Promise(() => {})), // signature capture hangs too
        });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 1_000 });
        const promise = controller.act({ action: "back" });
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await promise;
        expect(result).toMatchObject({ error: expect.stringContaining("1000ms") });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Finding 2: a browser tab that exists but isn't the visible one (e.g. a
  // popup opened in the background) never fires requestAnimationFrame, so
  // the cursor step should be skipped outright rather than burning its full
  // backstop for an overlay nobody can see.
  describe("visibility gate (finding 2)", () => {
    it("skips the cursor call when the page reports isVisible() === false", async () => {
      const page = makeFakePage({ isVisible: vi.fn(() => false) });
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.act({ action: "click", target: "Buy now" });

      const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(false);
    });

    it("still runs the cursor call when the page reports isVisible() === true", async () => {
      const page = makeFakePage({ isVisible: vi.fn(() => true) });
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.act({ action: "click", target: "Buy now" });

      const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(true);
    });

    it("still runs the cursor call when the page doesn't implement isVisible at all", async () => {
      const page = makeFakePage();
      expect(page.isVisible).toBeUndefined();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.act({ action: "click", target: "Buy now" });

      const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(true);
    });
  });
});
