// Network mocks for the desktop browser (PageFixture `network`).
//
// The desktop browser runs in the user's REAL profile, so mocks are scoped to
// the agent's browser tabs: CDP `Fetch` on each browser tab's own debugger
// session. Never `session.webRequest` (profile-wide), never an editor tab
// (editor tabs are never registered here). `releaseFixture` calls the remover
// that `routeRequests` returns: it disables Fetch and lets every still-paused
// request through.

export interface FetchMockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs?: number;
  abort?: boolean;
}

export type FetchMockHandler = (req: { url: string; method: string }) => FetchMockResponse | undefined;

/** One browser tab's debugger session, as the router needs it. */
export interface RoutedTab {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Optional: resolves once the tab can take page-state CDP (it has a committed
   * document). Awaited only by `routeRequests` on an EXISTING tab; the
   * fire-and-forget enable of a newly registered tab never waits for it.
   * `boundMs`, when given, is a hard bound for this wait.
   */
  whenReady?(boundMs?: number): Promise<void>;
  /** Subscribe to the tab's CDP events; returns the unsubscribe. */
  onEvent(cb: (method: string, params: unknown) => void): () => void;
}

interface Route {
  handler: FetchMockHandler;
  removal: AbortController;
}

interface TabState {
  tab: RoutedTab;
  unsubscribe: () => void;
  /** Fetch is enabled on the tab (acknowledged). Touched only inside `chain`. */
  enabled: boolean;
  /** Serializes this tab's enable/disable commands, so a late disable can never undo a newer enable. */
  chain: Promise<unknown>;
  tabId?: number;
}

/** How long `routeRequests` waits for a tab that is NOT the agent's own to commit its first document. */
export const OTHER_TAB_READY_MS = 2_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class FetchRouter {
  private readonly tabs = new Map<RoutedTab, TabState>();
  private readonly routes = new Set<Route>();

  /**
   * Register a BROWSER tab that has an attached debugger. If routing is
   * active, Fetch is enabled on it at once (popups and new tabs opened during
   * a task are mocked too). Returns the unregister, for when the tab closes.
   */
  registerTab(tab: RoutedTab, tabId?: number): () => void {
    const state: TabState = { tab, enabled: false, chain: Promise.resolve(), unsubscribe: () => {}, tabId };
    state.unsubscribe = tab.onEvent((method, params) => {
      if (method === "Fetch.requestPaused") void this.onPaused(state, params);
    });
    this.tabs.set(tab, state);
    if (this.routes.size > 0) {
      // Nobody can receive a throw here; log it.
      this.enable(state, "none").catch((err) => console.warn("[fetchRouting] could not enable Fetch on a new tab:", err));
    }
    return () => {
      state.unsubscribe();
      state.enabled = false;
      this.tabs.delete(tab);
    };
  }

  /** True when the browser tab with this id has joined the router. */
  isRegistered(tabId: number): boolean {
    for (const s of this.tabs.values()) if (s.tabId === tabId) return true;
    return false;
  }

  /**
   * Throws when the agent's current browser tab (webContents id; null = no
   * tab yet) exists but has no debugger, so it can never be intercepted.
   */
  assertCurrentTabInterceptable(currentWebContentsId: number | null): void {
    if (currentWebContentsId !== null && !this.isRegistered(currentWebContentsId)) {
      throw new Error("request interception is not available in this browser tab");
    }
  }

  /**
   * Intercept the requests of every registered browser tab. With no
   * registered tab the call still succeeds (nothing to mock yet; tabs opened
   * later are covered while routing is active). The remover is idempotent.
   */
  async routeRequests(handler: FetchMockHandler, currentWebContentsId: number | null = null): Promise<() => Promise<void>> {
    const route: Route = { handler, removal: new AbortController() };
    this.routes.add(route);
    const states = [...this.tabs.values()];
    // The agent's own tab must really be enabled (a failure fails the apply). Any other tab is
    // best effort: one that cannot commit a document (crashed, aborted, still empty) is skipped
    // and gets the fire-and-forget enable of a new tab, never blocking or failing the fixture.
    const results = await Promise.allSettled(
      states.map((state) => this.enable(state, state.tabId !== undefined && state.tabId === currentWebContentsId ? "required" : "bounded")),
    );
    // A tab that closed during the call cannot be intercepted and needs no
    // interception: only failures on still-registered tabs fail the apply.
    const failed = results.some((r, i) => r.status === "rejected" && this.tabs.get(states[i].tab) === states[i]);
    if (failed) {
      // Undo: drop the route and disable whatever this call enabled, so no
      // tab keeps intercepting for a route that was never reported active.
      await this.remove(route);
      throw new Error("could not enable request interception in the browser tab");
    }
    let removed: Promise<void> | null = null;
    return () => {
      removed ??= this.remove(route);
      return removed;
    };
  }

  private run<T>(state: TabState, op: () => Promise<T>): Promise<T> {
    const result = state.chain.then(op);
    state.chain = result.catch(() => {});
    return result;
  }

  /** Resolves once the tab acknowledged Fetch.enable; rejects if it failed. */
  private enable(state: TabState, ready: "none" | "required" | "bounded"): Promise<void> {
    let skipped = false;
    const done = this.run(state, async () => {
      if (state.enabled || this.tabs.get(state.tab) !== state) return;
      if (ready === "required") {
        await state.tab.whenReady?.();
      } else if (ready === "bounded" && state.tab.whenReady) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ok = await Promise.race([
          state.tab.whenReady(OTHER_TAB_READY_MS).then(() => true, () => false),
          new Promise<false>((r) => (timer = setTimeout(() => r(false), OTHER_TAB_READY_MS))),
        ]);
        clearTimeout(timer);
        if (!ok) {
          skipped = true;
          return;
        }
      }
      if (state.enabled || this.tabs.get(state.tab) !== state) return;
      await state.tab.sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      state.enabled = true;
    });
    return done.then(() => {
      // Queued behind this op on the tab's chain; nobody awaits it (like a new tab's enable).
      if (skipped && this.routes.size > 0) {
        this.enable(state, "none").catch((err) => console.warn("[fetchRouting] could not enable Fetch on an uncommitted tab:", err));
      }
    });
  }

  private async remove(route: Route): Promise<void> {
    route.removal.abort(); // delayed requests continue at once
    this.routes.delete(route);
    await Promise.all(
      [...this.tabs.values()].map((state) =>
        this.run(state, async () => {
          // Checked when it runs: a route added meanwhile keeps Fetch on.
          if (!state.enabled || this.routes.size > 0) return;
          state.enabled = false;
          // Fetch.disable also releases requests still paused in the browser.
          await state.tab.sendCommand("Fetch.disable").catch(() => {});
        }),
      ),
    );
  }

  private async onPaused(state: TabState, params: unknown): Promise<void> {
    const p = params as { requestId?: string; request?: { url?: string; method?: string } };
    const requestId = p?.requestId;
    if (!requestId) return;
    const send = (method: string, args: Record<string, unknown>) => state.tab.sendCommand(method, { requestId, ...args });
    const req = { url: p.request?.url ?? "", method: p.request?.method ?? "GET" };
    let route: Route | undefined;
    let mock: FetchMockResponse | undefined;
    for (const r of this.routes) {
      if (r.removal.signal.aborted) continue;
      try {
        mock = r.handler(req);
      } catch {
        mock = undefined;
      }
      if (mock) {
        route = r;
        break;
      }
    }
    try {
      if (!mock || !route) return void (await send("Fetch.continueRequest", {}));
      if (mock.delayMs) {
        try {
          await sleep(mock.delayMs, route.removal.signal);
        } catch {
          return void (await send("Fetch.continueRequest", {}));
        }
      }
      if (mock.abort) return void (await send("Fetch.failRequest", { errorReason: "Failed" }));
      await send("Fetch.fulfillRequest", {
        responseCode: mock.status,
        responseHeaders: Object.entries(mock.headers ?? {}).map(([name, value]) => ({ name, value })),
        body: Buffer.from(mock.body ?? "", "utf8").toString("base64"),
      });
    } catch {
      // The answer failed: a request left paused hangs the page. Hand it on,
      // and fail it as the last resort. A closed tab rejects both; ignore.
      try {
        await send("Fetch.continueRequest", {});
      } catch {
        await send("Fetch.failRequest", { errorReason: "Failed" }).catch(() => {});
      }
    }
  }
}
