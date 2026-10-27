// Playwright-backed BrowserTarget / BrowserPageHandle for the vendored BrowserController.
// Implemented optional methods: isVisible, capture, sendCdp, drainDialogs, drainConsoleErrors,
// onNavigationEvent, networkStats, listFrames, executeJavaScriptInFrame, listPages/selectPage/closePage/newPage/pageHandles.
import { chromium, type BrowserContext, type Page, type CDPSession, type Frame } from "playwright";
import type { BrowserPageHandle, BrowserTarget } from "../vendor/controller";
import type { BrowserTabInfo } from "../vendor/tabManager";

const UA =
  process.env.UA ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

class PwPage implements BrowserPageHandle {
  private loading = false;
  private title = "";
  private dialogs: { type: string; message: string }[] = [];
  private consoleErrors: string[] = [];
  private navCbs = new Set<() => void>();
  private domReadyWaiters: (() => void)[] = [];
  private pending = new Map<string, { startedAt: number; generation: number }>();
  private gen = 0;
  private frames = new Map<number, Frame>();
  private frameSeq = 1;
  private cdp!: CDPSession;
  ready: Promise<void>;

  constructor(readonly page: Page, private readonly ctx: BrowserContext) {
    this.ready = this.init();
  }

  private fireNav() {
    for (const cb of this.navCbs) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  private async init() {
    const page = this.page;
    this.cdp = await this.ctx.newCDPSession(page);
    const cdp = this.cdp;
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    cdp.on("Page.frameStartedLoading", (p: any) => {
      if (p.frameId === this.mainFrameId) { this.loading = true; this.fireNav(); }
    });
    cdp.on("Page.frameStoppedLoading", (p: any) => {
      if (p.frameId === this.mainFrameId) this.loading = false;
    });
    cdp.on("Page.frameNavigated", (p: any) => {
      if (!p.frame.parentId) { this.mainFrameId = p.frame.id; this.fireNav(); }
    });
    cdp.on("Page.navigatedWithinDocument", () => this.fireNav());
    cdp.on("Page.domContentEventFired", () => {
      const w = this.domReadyWaiters.splice(0);
      for (const f of w) f();
    });
    cdp.on("Network.requestWillBeSent", (p: any) => {
      if (["WebSocket", "EventSource", "Ping"].includes(p.type ?? "")) return;
      this.gen += 1;
      this.pending.set(p.requestId, { startedAt: Date.now(), generation: this.gen });
    });
    const done = (p: any) => this.pending.delete(p.requestId);
    cdp.on("Network.loadingFinished", done);
    cdp.on("Network.loadingFailed", done);
    try {
      const tree: any = await cdp.send("Page.getFrameTree");
      this.mainFrameId = tree.frameTree.frame.id;
    } catch { /* ignore */ }

    // Dialog policy copied from desktop CLAUDE.md: alert/beforeunload accept, confirm/prompt dismiss.
    page.on("dialog", (d) => {
      const type = d.type();
      this.dialogs.push({ type, message: d.message().slice(0, 200) });
      if (this.dialogs.length > 10) this.dialogs.shift();
      const accept = type === "alert" || type === "beforeunload";
      (accept ? d.accept() : d.dismiss()).catch(() => {});
    });
    page.on("console", (m) => {
      if (m.type() === "error") {
        this.consoleErrors.push(m.text().slice(0, 200));
        if (this.consoleErrors.length > 50) this.consoleErrors.shift();
      }
    });
    page.on("pageerror", (e) => {
      this.consoleErrors.push(String(e.message).slice(0, 200));
      if (this.consoleErrors.length > 50) this.consoleErrors.shift();
    });
    const refreshTitle = () => { page.title().then((t) => (this.title = t)).catch(() => {}); };
    page.on("domcontentloaded", refreshTitle);
    page.on("load", refreshTitle);
    page.on("framenavigated", refreshTitle);
  }
  private mainFrameId = "";

  async loadURL(url: string): Promise<void> {
    await this.ready;
    try {
      await this.page.goto(url, { waitUntil: "load", timeout: 60_000 });
    } catch (e) {
      // ERR_ABORTED is what a JS-challenge redirect/reload racing the first navigation produces
      // (skroutz); wait for the superseding navigation to load instead of failing.
      if (/ERR_ABORTED/.test(String(e))) {
        await this.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
        return;
      }
      throw e;
    }
  }
  executeJavaScript(code: string): Promise<unknown> { return this.page.evaluate(code); }
  getURL() { return this.page.url(); }
  getTitle() { return this.title; }
  goBack() { this.page.goBack({ waitUntil: "commit" }).catch(() => {}); }
  goForward() { this.page.goForward({ waitUntil: "commit" }).catch(() => {}); }
  reload() { this.page.reload({ waitUntil: "commit" }).catch(() => {}); }
  // Playwright has no sync history API; ask CDP would be async. Report true and let goBack no-op.
  canGoBack() { return true; }
  canGoForward() { return true; }
  isLoading() { return this.loading; }
  // Electron semantics: resolves on the NEXT dom-ready (armed before loadURL). No readyState shortcut.
  onceDomReady(): Promise<void> {
    return new Promise<void>((r) => this.domReadyWaiters.push(r));
  }
  isVisible() { return true; }
  async capture() {
    try {
      const buf = await this.page.screenshot({ type: "jpeg", quality: 70, scale: "css" });
      const vp = this.page.viewportSize() ?? { width: 1280, height: 800 };
      return { imageData: buf.toString("base64"), width: vp.width, height: vp.height };
    } catch { return null; }
  }
  async sendCdp(method: string, params?: Record<string, unknown>) {
    await this.ready;
    return this.cdp.send(method as any, params as any);
  }
  drainDialogs() { return this.dialogs.splice(0); }
  drainConsoleErrors() { return this.consoleErrors.splice(0); }
  onNavigationEvent(cb: () => void) { this.navCbs.add(cb); return () => { this.navCbs.delete(cb); }; }
  networkStats(dropAfterMs: number, sinceGeneration?: number) {
    const now = Date.now();
    let pending = 0;
    for (const [id, r] of this.pending) {
      if (now - r.startedAt > dropAfterMs) { this.pending.delete(id); continue; }
      if (sinceGeneration === undefined || r.generation > sinceGeneration) pending++;
    }
    return { pending, generation: this.gen };
  }
  listFrames() {
    this.frames.clear();
    return this.page.mainFrame().childFrames().map((f) => {
      const id = this.frameSeq++;
      this.frames.set(id, f);
      return { frameId: id, url: f.url(), name: f.name() };
    });
  }
  async executeJavaScriptInFrame(frameId: number, code: string, timeoutMs: number) {
    const f = this.frames.get(frameId);
    if (!f || f.isDetached()) throw new Error("frame gone");
    return Promise.race([
      f.evaluate(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error("frame timeout")), timeoutMs)),
    ]);
  }
}

export class PlaywrightTarget implements BrowserTarget {
  private ctx?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private pages = new Map<number, PwPage>();
  private ids = new Map<Page, number>();
  private seq = 1;
  private currentId: number | null = null;

  constructor(existing?: BrowserContext) {
    if (existing) {
      this.ctx = existing;
      existing.on("page", (p) => this.register(p));
      for (const p of existing.pages()) this.register(p);
    }
  }

  private async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    this.launching ??= (async () => {
      const headless = process.env.HEADLESS !== "0";
      const browser = await chromium.launch({
        headless,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: UA,
        locale: "en-US",
      });
      ctx.on("page", (p) => this.register(p));
      this.ctx = ctx;
      return ctx;
    })();
    return this.launching;
  }
  private register(p: Page): PwPage {
    const existing = this.ids.get(p);
    if (existing) return this.pages.get(existing)!;
    const id = this.seq++;
    const h = new PwPage(p, this.ctx!);
    this.pages.set(id, h);
    this.ids.set(p, id);
    this.currentId = id; // popups / new pages become current
    p.on("close", () => {
      this.pages.delete(id);
      if (this.currentId === id) this.currentId = [...this.pages.keys()].pop() ?? null;
    });
    return h;
  }
  async ensurePage(): Promise<BrowserPageHandle> {
    const ctx = await this.context();
    let h = this.currentId ? this.pages.get(this.currentId) : undefined;
    if (!h) {
      const p = await ctx.newPage();
      h = this.register(p);
    }
    await h.ready;
    return h;
  }
  currentPage() { return this.currentId ? this.pages.get(this.currentId) ?? null : null; }
  async listPages(): Promise<BrowserTabInfo[]> {
    return [...this.pages].map(([tabId, h]) => ({ tabId, url: h.getURL(), title: h.getTitle(), current: tabId === this.currentId }));
  }
  async selectPage(tabId: number) {
    const h = this.pages.get(tabId);
    if (!h) return false;
    this.currentId = tabId;
    await h.page.bringToFront().catch(() => {});
    return true;
  }
  async closePage(tabId: number) {
    const h = this.pages.get(tabId);
    if (!h) return false;
    await h.page.close().catch(() => {});
    return true;
  }
  async newPage(url?: string): Promise<BrowserTabInfo> {
    const ctx = await this.context();
    const p = await ctx.newPage();
    const h = this.register(p);
    await h.ready;
    if (url) await h.loadURL(url).catch(() => {});
    const tabId = this.ids.get(p)!;
    return { tabId, url: h.getURL(), title: h.getTitle(), current: true };
  }
  async pageHandles() {
    return [...this.pages].map(([tabId, page]) => ({ tabId, page }));
  }
  async close() { await this.ctx?.browser()?.close().catch(() => {}); }
}
