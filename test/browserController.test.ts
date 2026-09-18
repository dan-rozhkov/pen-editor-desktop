import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BrowserController,
  type BrowserPageHandle,
  type BrowserTarget,
} from "../src/main/browser/controller";

// A real goBack()/goForward() is fire-and-forget but the URL does change —
// this fake mutates its own url/title synchronously on goBack/goForward so
// BrowserController's post-navigation URL-change poll (waitForUrlChange)
// resolves on its very first check, keeping these tests fast.
function makeFakePage(overrides: Partial<BrowserPageHandle> = {}): BrowserPageHandle {
  let url = "https://example.com/";
  let title = "Example";
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    executeJavaScript: vi.fn(() => Promise.resolve({ ok: true })),
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
    ...overrides,
  };
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
    it("navigates the ensured page and returns its final url/title", async () => {
      const page = makeFakePage({ getURL: vi.fn(() => "https://example.com/final") });
      const target = makeFakeTarget(page);
      const controller = new BrowserController(target);
      const result = await controller.open({ url: "https://example.com" });
      expect(target.ensurePage).toHaveBeenCalled();
      expect(page.loadURL).toHaveBeenCalledWith("https://example.com");
      expect(result).toEqual({ url: "https://example.com/final", title: "Example" });
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
        expect(page.executeJavaScript).toHaveBeenCalledTimes(1);
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(code).toContain(JSON.stringify("Buy now"));
        expect(code).not.toContain("PEN_BROWSER_ARGS");
        expect(result).toEqual({ url: "https://x/", title: "X", matched: "Buy now" });
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
          expect(result).toEqual({ url: "https://example.com/next", title: "Next", matched: "Go" });
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
          expect(result).toEqual({ url: "https://example.com/", title: "Example", matched: "Go" });
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
          // not the pre-navigation one either.
          expect(result).toEqual({ url: "https://example.com/next", title: "Next" });
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
          expect(result).toEqual({ url: "https://example.com/next", title: "Next" });
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
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
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
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(code).toContain(JSON.stringify({ target: "Price", text: "price is $&" }));
      });

      it("does not interpret $` in target as a replacement pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "click", target: "a$`b" });
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(code).toContain(JSON.stringify({ target: "a$`b" }));
      });

      it("does not let $' in target splice page source into the script (never breaks out of the JSON literal)", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "click", target: "$'" });
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(code).toContain(JSON.stringify({ target: "$'" }));
        // The rest of the script (e.g. the findByText helper) must still be
        // present intact after the substitution point.
        expect(code).toContain("findByText");
      });

      it("does not interpret $$ in text as an escaped-dollar pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "type", target: "Amount", text: "$$100" });
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(code).toContain(JSON.stringify({ target: "Amount", text: "$$100" }));
      });
    });

    describe("scroll", () => {
      it("defaults amount to 1", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "scroll" });
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
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
        const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(code).toContain(JSON.stringify({ amount: 2.5 }));
      });
    });

    describe("back / forward", () => {
      it("back calls goBack and reports the post-navigation url/title", async () => {
        const page = makeFakePage({ canGoBack: vi.fn(() => true) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "back" });
        expect(page.goBack).toHaveBeenCalled();
        expect(result).toEqual({ url: "https://example.com/back", title: "Example (back)" });
      });

      it("back errors cleanly when there is no history", async () => {
        const page = makeFakePage({ canGoBack: vi.fn(() => false) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "back" });
        expect(page.goBack).not.toHaveBeenCalled();
        expect(result).toHaveProperty("error");
      });

      it("forward calls goForward when there is forward history, and reports the post-navigation url/title", async () => {
        const page = makeFakePage({ canGoForward: vi.fn(() => true) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "forward" });
        expect(page.goForward).toHaveBeenCalled();
        expect(result).toEqual({ url: "https://example.com/forward", title: "Example (forward)" });
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
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50 });
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
      const lastCode = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
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
      expect(result).toEqual({ url: "https://x/", title: "X" });
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
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
        expect(result).toEqual({ url: "https://example.com/next", title: "Next" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces a page-reported error (element not found) as the result", async () => {
      const executeJavaScript = vi
        .fn()
        .mockResolvedValueOnce({
          url: "https://example.com/",
          title: "Example",
          elements: [],
          scroll: { y: 0, height: 0, atBottom: true },
        })
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
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50 });
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
