// Opt-in live check of the agent layout with full-window screenshots.
//
//   cd ../wt-f5   # pen-editor with the /agent route + canvas link
//   VITE_AI_API_URL=http://127.0.0.1:5195/api/chat NODE_OPTIONS=--no-experimental-webstorage \
//     npm run dev -- --port 5194 --strictPort
//   cd ../wt-glass   # this repo (pen-editor-desktop)
//   PEN_DESKTOP_URL=http://localhost:5194/app npm run test:e2e:shots
//
// The spec starts a stub AI backend (:5195, AI SDK v6 UI-message SSE) and a stub web page, and decides the
// scripted turn from the user message text: "design" (batch_design: a mobile screen), "browse" (browse_open on
// the stub page), "close" (a long slow batch_design; the test closes the canvas tab mid-stream).
// Screenshots: macOS `screencapture -l <CGWindowID>` of the whole BaseWindow, else a composite of per-view
// capturePage() images. Output: AGENT_SHOTS_DIR (default test-results/agent-layout-shots).

import { reportCrashes, waitForShellViews } from "./launch";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const EDITOR_URL = process.env.PEN_DESKTOP_URL ?? "http://localhost:5194/app";
const ORIGIN = new URL(EDITOR_URL).origin;
const STUB_PORT = Number(process.env.AGENT_STUB_PORT ?? 5195);
const OUT = process.env.AGENT_SHOTS_DIR ?? path.join(process.cwd(), "test-results", "agent-layout-shots");

// ------------------------------------------------------------------ scripts

/** A mobile "Focus" screen: frame + shapes + text, one statement per element so nodes appear one by one. */
function designOperations(prefix = ""): string[] {
  const t = (name: string, x: number, y: number, content: string, size: number, weight: string, fill: string, extra = "") =>
    `t_${name}=I(f, {type: "text", name: "${prefix}${name}", x: ${x}, y: ${y}, content: ${JSON.stringify(content)}, fontSize: ${size}, fontWeight: "${weight}", fill: "${fill}"${extra}})`;
  const r = (name: string, x: number, y: number, w: number, h: number, fill: string, radius: number) =>
    `r_${name}=I(f, {type: "rect", name: "${prefix}${name}", x: ${x}, y: ${y}, width: ${w}, height: ${h}, fill: "${fill}", cornerRadius: ${radius}})`;
  return [
    `f=I(document, {type: "frame", name: "${prefix}Focus Home", x: 0, y: 0, width: 390, height: 844, fill: "#0f1115", cornerRadius: 24})`,
    t("Greeting", 24, 64, "Good morning, Maya", 28, "700", "#f3f1ec"),
    t("Sub", 24, 104, "3 sessions planned today", 15, "400", "#9aa0ac"),
    r("HeroCard", 24, 150, 342, 190, "#1a1d24", 20),
    r("HeroAccent", 24, 150, 8, 190, "#b9ff66", 4),
    t("HeroLabel", 52, 174, "UP NEXT", 12, "600", "#b9ff66"),
    t("HeroTitle", 52, 198, "Deep focus flow", 24, "700", "#f3f1ec"),
    t("HeroMeta", 52, 236, "25 min  -  Breathing + ambient", 14, "400", "#9aa0ac"),
    r("HeroButton", 52, 280, 140, 40, "#b9ff66", 20),
    t("HeroButtonText", 84, 291, "Start now", 15, "600", "#0f1115"),
    t("WeekTitle", 24, 372, "Your week", 18, "700", "#f3f1ec"),
    r("Day1", 24, 410, 46, 90, "#1a1d24", 14),
    r("Day2", 80, 410, 46, 90, "#b9ff66", 14),
    r("Day3", 136, 410, 46, 90, "#1a1d24", 14),
    r("Day4", 192, 410, 46, 90, "#1a1d24", 14),
    r("Day5", 248, 410, 46, 90, "#1a1d24", 14),
    r("Day6", 304, 410, 46, 90, "#1a1d24", 14),
    t("Mon", 36, 424, "Mon", 12, "500", "#9aa0ac"),
    t("Tue", 92, 424, "Tue", 12, "700", "#0f1115"),
    t("ListTitle", 24, 532, "Sessions", 18, "700", "#f3f1ec"),
    r("Row1", 24, 568, 342, 64, "#1a1d24", 16),
    t("Row1Text", 48, 588, "Morning reset  -  10 min", 15, "500", "#f3f1ec"),
    r("Row2", 24, 644, 342, 64, "#1a1d24", 16),
    t("Row2Text", 48, 664, "Box breathing  -  5 min", 15, "500", "#f3f1ec"),
    r("TabBar", 24, 760, 342, 64, "#1e2129", 32),
    r("TabDot", 60, 782, 20, 20, "#b9ff66", 10),
  ];
}
const DESIGN_OPS = designOperations();
const SLOW_OPS = [
  ...designOperations("Slow "),
  ...Array.from({ length: 24 }, (_, i) => `x${i}=I(f, {type: "rect", name: "Filler${i}", x: ${20 + (i % 8) * 40}, y: ${20 + Math.floor(i / 8) * 40}, width: 30, height: 30, fill: "#334155"})`),
];

// ------------------------------------------------------------- stub backend

interface Hold {
  /** Stream this many deltas, then wait for release(). */
  afterDeltas: number;
  reached: Promise<void>;
  release: () => void;
}

class Stub {
  server!: http.Server;
  chatBodies: Array<{ messages?: Array<{ role: string; parts?: Array<Record<string, unknown>> }>; canvasContext?: unknown }> = [];
  unhandled: string[] = [];
  /** Pending hold for the next streamed batch_design. */
  hold: { afterDeltas: number; paceMs: number; reached: () => void; gate: Promise<void> } | null = null;
  paceMs = 4;
  streamedDeltas = 0;
  /** Close turn: wall-clock marks of the slow stream. */
  closeStream: { start: number; end: number | null; deltas: number } | null = null;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(STUB_PORT, "127.0.0.1", resolve);
    });
  }
  stop(): Promise<void> {
    return new Promise((r) => {
      this.server.closeAllConnections?.();
      this.server.close(() => r());
    });
  }
  /** Arms a hold on the next design/close stream. */
  armHold(afterDeltas: number): Hold {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    this.hold = { afterDeltas, paceMs: this.paceMs, reached, gate };
    return { afterDeltas, reached: reachedP, release };
  }

  private cors(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader("access-control-allow-origin", req.headers.origin ?? ORIGIN);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", String(req.headers["access-control-request-headers"] ?? "*"));
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("vary", "origin");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.cors(req, res);
    const url = req.url ?? "";
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (req.method === "GET" && url.startsWith("/stubpage")) {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.end(STUB_PAGE);
    }
    if (req.method === "GET" && url.startsWith("/api/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ models: [{ id: "test/agent-model", label: "Agent Model", supportsVision: true }], default: "test/agent-model" }));
    }
    if (req.method === "GET" && url.startsWith("/api/auth-config")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ enabled: false }));
    }
    if (req.method === "GET" && (url.startsWith("/api/skills") || url.startsWith("/api/user-skills"))) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ skills: [] }));
    }
    if (req.method === "POST" && url.startsWith("/api/chat")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: Stub["chatBodies"][number] = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* ignore */
      }
      this.chatBodies.push(body);
      await this.chat(res, body);
      return;
    }
    this.unhandled.push(`${req.method} ${url}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  }

  private sse(res: http.ServerResponse, chunk: Record<string, unknown>): void {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  private head(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1", "cache-control": "no-cache" });
  }
  private end(res: http.ServerResponse): void {
    this.sse(res, { type: "finish-step" });
    this.sse(res, { type: "finish" });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private async chat(res: http.ServerResponse, body: Stub["chatBodies"][number]): Promise<void> {
    const msgs = body.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const userText = (lastUser?.parts ?? []).map((p) => (p.type === "text" ? String(p.text) : "")).join(" ").toLowerCase();
    const last = msgs[msgs.length - 1];
    const isContinuation = last?.role === "assistant" && (last.parts ?? []).some((p) => typeof p.type === "string" && p.type.startsWith("tool-") && p.output !== undefined);
    const kind = userText.includes("browse") ? "browse" : userText.includes("close") ? "close" : userText.includes("tiny") ? "tiny" : "design";

    this.head(res);
    this.sse(res, { type: "start" });
    this.sse(res, { type: "start-step" });
    if (isContinuation) {
      const text =
        kind === "browse" ? "Opened the stub page in the browser tab." : kind === "close" ? "Tried to continue after the tab closed." : kind === "tiny" ? "Added one more node." : "Done. The Focus Home screen is on the canvas.";
      this.sse(res, { type: "text-start", id: "t2" });
      this.sse(res, { type: "text-delta", id: "t2", delta: text });
      this.sse(res, { type: "text-end", id: "t2" });
      return this.end(res);
    }
    if (kind === "browse") {
      this.sse(res, { type: "text-start", id: "t1" });
      this.sse(res, { type: "text-delta", id: "t1", delta: "Opening the page." });
      this.sse(res, { type: "text-end", id: "t1" });
      this.sse(res, { type: "tool-input-available", toolCallId: "browse-1", toolName: "browse_open", input: { url: `http://127.0.0.1:${STUB_PORT}/stubpage` } });
      return this.end(res);
    }
    const ops = kind === "close" ? SLOW_OPS : kind === "tiny" ? ['n=I(document, {type: "rect", name: "TinyNode", x: 600, y: 0, width: 40, height: 40, fill: "#ff0000"})'] : DESIGN_OPS;
    this.sse(res, { type: "text-start", id: "t1" });
    this.sse(res, { type: "text-delta", id: "t1", delta: kind === "close" ? "Drawing a long screen." : "Designing the screen." });
    this.sse(res, { type: "text-end", id: "t1" });
    const id = `bd-${Date.now()}`;
    this.sse(res, { type: "tool-input-start", toolCallId: id, toolName: "batch_design" });
    const json = JSON.stringify({ operations: ops.join("\n") + "\n" });
    const size = 24;
    const hold = this.hold;
    this.hold = null;
    const pace = hold?.paceMs ?? this.paceMs;
    if (kind === "close") this.closeStream = { start: Date.now(), end: null, deltas: 0 };
    for (let i = 0, n = 0; i < json.length; i += size, n++) {
      if (res.destroyed) return;
      this.sse(res, { type: "tool-input-delta", toolCallId: id, inputTextDelta: json.slice(i, i + size) });
      this.streamedDeltas++;
      if (this.closeStream && kind === "close") this.closeStream.deltas++;
      if (hold && n === hold.afterDeltas) {
        hold.reached();
        await hold.gate;
      }
      await new Promise((r) => setTimeout(r, kind === "close" ? 40 : pace));
    }
    if (this.closeStream && kind === "close") this.closeStream.end = Date.now();
    this.sse(res, { type: "tool-input-available", toolCallId: id, toolName: "batch_design", input: { operations: ops.join("\n") + "\n" } });
    this.end(res);
  }
}

const STUB_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Stub Page</title>
<style>body{font:16px system-ui;margin:0;background:${process.env.AGENT_STUB_BG ?? "#f4efe6"};color:#1d1a16}main{max-width:560px;margin:80px auto;padding:0 24px}
h1{font-size:40px;margin:0 0 12px}.card{background:#fffaf2;border:1px solid #e5dccb;border-radius:16px;padding:20px;margin-top:20px}
button{background:#ff7a45;color:#fff;border:0;border-radius:999px;padding:10px 20px;font-size:16px}</style></head>
<body><main><h1>Stub Page</h1><p>A local page served by the stub backend for browse_open.</p>
<div class="card"><h2>Coffee subscription</h2><p>Fresh beans every two weeks.</p><button>Subscribe</button></div></main></body></html>`;

// ------------------------------------------------------------------ helpers

interface Shell {
  app: ElectronApplication;
  tabbar: Page;
  panel: Page;
  canvases: Page[];
  errors: Map<string, string[]>;
}

function watch(page: Page, label: string, errors: Map<string, string[]>): void {
  const sink = () => {
    let a = errors.get(label);
    if (!a) errors.set(label, (a = []));
    return a;
  };
  page.on("console", (m) => {
    if (m.type() === "error") sink().push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => sink().push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("response", (r) => {
    if (r.status() >= 400) sink().push(`http ${r.status()} ${r.url().slice(0, 160)}`);
  });
}

const isPanel = (p: Page) => p.url().startsWith(`${ORIGIN}/agent`);
const isCanvas = (p: Page) => p.url().startsWith(`${ORIGIN}/app`);

async function launch(opts: { dark?: boolean; tag: string; emptyShot?: string }): Promise<Shell> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `agent-layout-${opts.tag}-`));
  const errors = new Map<string, string[]>();
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      PEN_DESKTOP_URL: EDITOR_URL,
      HOME: home,
      USERPROFILE: home,
      PEN_DESKTOP_USER_DATA_DIR: path.join(home, "userData"),
    },
  });
  const find = async (pred: (p: Page) => boolean) => {
    try {
      return app.windows().find(pred) ?? (await app.waitForEvent("window", { predicate: pred, timeout: 45_000 }));
    } catch (e) {
      console.log("windows at timeout:", app.windows().map((p) => p.url()));
      await app.close().catch(() => undefined);
      throw e;
    }
  };
  reportCrashes(app);
  const panel = await find(isPanel);
  // No main-process code before the shell views exist (see waitForShellViews).
  const tabbar = await waitForShellViews(app);
  // Empty start: the window opens with zero tabs. Size it first, capture the placeholder (optional), then open a canvas tab.
  await app.evaluate(({ BaseWindow }) => {
    const w = (() => {
      // The main window = the one that owns the tab bar view (robust against title/app renames).
      const w = BaseWindow.getAllWindows().find((x) =>
        x.contentView.children.some((c) => (c as unknown as { webContents?: Electron.WebContents }).webContents?.getURL().endsWith("/tabbar/tabbar.html")),
      );
      if (!w) throw new Error("main window (owner of the tab bar view) not found");
      return w;
    })();
    w.setContentSize(1440, 900);
    w.center();
  });
  await waitPanel(panel);
  if (opts.dark) {
    // Stored editor theme "dark": the panel page paints dark, main adopts it for the chrome/glass (empty start).
    await panel.evaluate(() => localStorage.setItem("ui-theme", "dark"));
    await panel.reload();
    await waitPanel(panel);
  }
  if (opts.emptyShot) {
    await new Promise((r) => setTimeout(r, 1200));
    await shot({ app, tabbar, panel, canvases: [], errors }, opts.emptyShot);
  }
  await tabbar.evaluate(() => (window as never as { penTabbar: { newTab(): void } }).penTabbar.newTab());
  const canvas = await find(isCanvas);
  // 1440x900 content, like a normal desktop window.
  await app.evaluate(({ BaseWindow }) => {
    const w = (() => {
      // The main window = the one that owns the tab bar view (robust against title/app renames).
      const w = BaseWindow.getAllWindows().find((x) =>
        x.contentView.children.some((c) => (c as unknown as { webContents?: Electron.WebContents }).webContents?.getURL().endsWith("/tabbar/tabbar.html")),
      );
      if (!w) throw new Error("main window (owner of the tab bar view) not found");
      return w;
    })();
    w.setContentSize(1440, 900);
    w.center();
  });
  await new Promise((r) => setTimeout(r, 500));
  watch(panel, `${opts.tag}:panel`, errors);
  watch(canvas, `${opts.tag}:canvas1`, errors);
  const shell: Shell = { app, tabbar, panel, canvases: [canvas], errors };
  if (opts.dark) {
    for (const p of [panel, canvas]) {
      await p.evaluate(() => localStorage.setItem("ui-theme", "dark"));
      await p.reload();
    }
  }
  await waitPanel(panel);
  await canvas.waitForFunction(() => Boolean((window as never as { __sceneStore?: unknown }).__sceneStore), undefined, { timeout: 90_000 });
  await expect.poll(() => listTabs(panel).then((t) => t.length), { timeout: 30_000 }).toBe(1);
  return shell;
}

async function waitPanel(panel: Page): Promise<void> {
  await panel.getByPlaceholder("Ask Sideform Agent…").or(panel.getByTestId("chat-list-new")).first().waitFor({ state: "visible", timeout: 90_000 });
}

interface TabInfo {
  tabId: number;
  registrationId: number;
  title: string;
  active: boolean;
}
function listTabs(panel: Page): Promise<TabInfo[]> {
  return panel.evaluate(() => (window as never as { penAgentPanel: { canvas: { listTabs(): Promise<TabInfo[]> } } }).penAgentPanel.canvas.listTabs());
}

async function sceneCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const st = (window as never as { __sceneStore?: { getState(): { nodesById: object } } }).__sceneStore;
    return st ? Object.keys(st.getState().nodesById).length : 0;
  });
}
async function sceneNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.values((window as never as { __sceneStore: { getState(): { nodesById: Record<string, { name?: string }> } } }).__sceneStore.getState().nodesById).map((n) => n.name ?? ""),
  );
}

async function newCanvasPage(shell: Shell, label: string, before: number): Promise<Page> {
  const pred = (p: Page) => isCanvas(p) && !shell.canvases.includes(p);
  const existing = shell.app.windows().find(pred);
  const page = existing ?? (await shell.app.waitForEvent("window", { predicate: pred, timeout: 30_000 }));
  void before;
  watch(page, label, shell.errors);
  shell.canvases.push(page);
  return page;
}

async function send(panel: Page, text: string): Promise<void> {
  const input = panel.getByPlaceholder("Ask Sideform Agent…");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(text);
  await input.press("Enter");
}

/** Frame the 390x844 screen in the visible canvas area (viewport coords are canvas-relative). */
async function fitScreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = (window as never as { __viewportStore: { getState(): { setViewportState(s: { scale: number; x: number; y: number }): void } } }).__viewportStore;
    vp.getState().setViewportState({ scale: 0.85, x: 392, y: 36 });
  });
}

async function newChat(panel: Page): Promise<void> {
  // From an open chat: header "new chat" button; from the list: the list's own button.
  const header = panel.getByTestId("create-chat-button");
  if (await header.isVisible().catch(() => false)) await header.click();
  else await panel.getByTestId("chat-list-new").click();
  await panel.getByPlaceholder("Ask Sideform Agent…").waitFor({ state: "visible", timeout: 15_000 });
}

// ---- screenshots

let method = "unknown";
async function shot(shell: Shell, name: string): Promise<string> {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  await new Promise((r) => setTimeout(r, 600)); // let Pixi / layout settle
  const id = await shell.app.evaluate(({ BaseWindow }) => (() => {
      // The main window = the one that owns the tab bar view (robust against title/app renames).
      const w = BaseWindow.getAllWindows().find((x) =>
        x.contentView.children.some((c) => (c as unknown as { webContents?: Electron.WebContents }).webContents?.getURL().endsWith("/tabbar/tabbar.html")),
      );
      if (!w) throw new Error("main window (owner of the tab bar view) not found");
      return w;
    })().getMediaSourceId());
  const wid = Number(id.split(":")[1]);
  try {
    if (process.platform !== "darwin" || process.env.AGENT_SHOT_COMPOSITE) throw new Error("composite forced");
    // Bring the window to the front so nothing overlaps; screencapture -l renders the window itself anyway.
    await shell.app.evaluate(({ BaseWindow }) => (() => {
      // The main window = the one that owns the tab bar view (robust against title/app renames).
      const w = BaseWindow.getAllWindows().find((x) =>
        x.contentView.children.some((c) => (c as unknown as { webContents?: Electron.WebContents }).webContents?.getURL().endsWith("/tabbar/tabbar.html")),
      );
      if (!w) throw new Error("main window (owner of the tab bar view) not found");
      return w;
    })().show());
    execFileSync("screencapture", ["-x", "-o", "-l", String(wid), file], { timeout: 20_000 });
    const st = fs.statSync(file);
    if (st.size < 5_000) throw new Error(`screencapture produced ${st.size} bytes`);
    method = "screencapture -l (OS-level window capture)";
  } catch (e) {
    method = `composite of webContents.capturePage() (screencapture failed: ${String(e).slice(0, 120)})`;
    await composite(shell, file);
  }
  return file;
}

/** Fallback: capturePage() of every view at its bounds, drawn onto one canvas in a hidden window. */
async function composite(shell: Shell, file: string): Promise<void> {
  const parts = await shell.app.evaluate(async ({ BaseWindow }) => {
    const win = (() => {
      // The main window = the one that owns the tab bar view (robust against title/app renames).
      const w = BaseWindow.getAllWindows().find((x) =>
        x.contentView.children.some((c) => (c as unknown as { webContents?: Electron.WebContents }).webContents?.getURL().endsWith("/tabbar/tabbar.html")),
      );
      if (!w) throw new Error("main window (owner of the tab bar view) not found");
      return w;
    })();
    const cb = win.getContentBounds();
    const out: Array<{ x: number; y: number; w: number; h: number; png: string }> = [];
    for (const child of win.contentView.children) {
      const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents;
      if (!wc || !(child as unknown as { getVisible?: () => boolean }).getVisible?.()) continue;
      const b = child.getBounds();
      const img = await wc.capturePage();
      out.push({ x: b.x, y: b.y, w: b.width, h: b.height, png: img.toPNG().toString("base64") });
    }
    return { width: cb.width, height: cb.height, out };
  });
  const png = await shell.app.evaluate(async ({ BrowserWindow }, data) => {
    const w = new BrowserWindow({ show: false, width: 100, height: 100, webPreferences: { offscreen: false } });
    await w.loadURL("about:blank");
    const b64 = await w.webContents.executeJavaScript(`(async()=>{
      const d=${JSON.stringify(data)};const c=document.createElement('canvas');c.width=d.width*2;c.height=d.height*2;
      const g=c.getContext('2d');g.fillStyle='#ccc';g.fillRect(0,0,c.width,c.height);
      for(const p of d.out){const im=new Image();im.src='data:image/png;base64,'+p.png;await im.decode();g.drawImage(im,p.x*2,p.y*2,p.w*2,p.h*2);}
      return c.toDataURL('image/png').split(',')[1];})()`);
    w.destroy();
    return b64 as string;
  }, parts);
  fs.writeFileSync(file, Buffer.from(png, "base64"));
}

// -------------------------------------------------------------------- spec

const report: Record<string, string[]> = {};
function note(state: string, line: string): void {
  (report[state] ??= []).push(line);
  console.log(`[${state}] ${line}`);
}

// Default mode (not serial): the soft state-6 assertion may fail and the dark run must still capture its screenshots.
test.describe.configure({ mode: "default" });

let stub: Stub;
test.beforeAll(async () => {
  stub = new Stub();
  await stub.start();
});
test.afterAll(async () => {
  await stub.stop();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ method, report, unhandledStubRequests: stub.unhandled }, null, 2));
});

test("agent layout: states 1-6 (light)", async () => {
  test.setTimeout(300_000);
  const shell = await launch({ tag: "light", emptyShot: "00-empty.png" });
  const { app, panel } = shell;
  const c1 = shell.canvases[0];
  try {

  // ---- 1 start
  expect(new URL(panel.url()).pathname).toBe("/agent");
  expect(new URL(c1.url()).searchParams.get("chat")).toBe("off");
  await expect(c1.getByText("Agents", { exact: true })).toHaveCount(0);
  expect(await panel.getByPlaceholder("Ask Sideform Agent…").isVisible()).toBe(true);
  await expect(panel.locator('[data-testid="message-list"], [role="log"]').getByText(/./)).toHaveCount(0).catch(() => undefined);
  note("01", `panel scene store present: ${await panel.evaluate(() => Boolean((window as never as { __sceneStore?: unknown }).__sceneStore))}`);
  note("01", "panel /agent + one canvas tab /app?chat=off, no Agents text on canvas");
  await shot(shell, "01-start.png");

  await fitScreen(c1);
  // ---- 2 streaming (+3 done)
  const hold = stub.armHold(120); // ~ 2.9 KB of JSON streamed, then pause
  const before = await sceneCount(c1);
  await send(panel, "design a focus app home screen");
  await hold.reached;
  await expect.poll(() => sceneCount(c1), { timeout: 15_000 }).toBeGreaterThan(before);
  const mid = await sceneCount(c1);
  note("02", `canvas nodes while streaming: ${before} -> ${mid} (call not yet complete)`);
  await expect(panel.getByText("Designing the screen.")).toBeVisible();
  await shot(shell, "02-streaming.png");
  hold.release();

  await expect(panel.getByText("Done. The Focus Home screen is on the canvas.")).toBeVisible({ timeout: 30_000 });
  const names = await sceneNames(c1);
  expect(names).toContain("Focus Home");
  expect(names).toContain("HeroTitle");
  await fitScreen(c1);
  expect(await sceneCount(panel)).toBe(0); // panel has no scene store at all or an empty one
  note("03", `canvas has ${await sceneCount(c1)} nodes incl. Focus Home; panel scene empty`);
  await shot(shell, "03-done.png");
  // 08: sidebar toggle collapses the agent panel (hidden, not destroyed); the tab island takes the width.
  await shell.tabbar.evaluate(() => (window as unknown as { penTabbar: { togglePanel(): void } }).penTabbar.togglePanel());
  await expect(shell.tabbar.locator("#toggle-panel")).toHaveAttribute("aria-pressed", "false");
  await new Promise((r) => setTimeout(r, 500));
  await shot(shell, "08-collapsed.png");
  await shell.tabbar.evaluate(() => (window as unknown as { penTabbar: { togglePanel(): void } }).penTabbar.togglePanel());
  await expect(shell.tabbar.locator("#toggle-panel")).toHaveAttribute("aria-pressed", "true");

  // ---- 4 two canvases + browser
  const first = (await listTabs(panel))[0];
  await panel.evaluate(() => (window as never as { penAgentPanel: { canvas: { openTab(o: object): Promise<unknown> } } }).penAgentPanel.canvas.openTab({ activate: true }));
  const c2 = await newCanvasPage(shell, "light:canvas2", 1);
  await c2.waitForFunction(() => Boolean((window as never as { __sceneStore?: unknown }).__sceneStore), undefined, { timeout: 60_000 });
  const newBrowserTab = await panel.evaluate((url) =>
    (window as never as { penAgentPanel: { browser: { tabs(a: object): Promise<unknown> } } }).penAgentPanel.browser.tabs({ action: "new", url }),
  `http://127.0.0.1:${STUB_PORT}/stubpage`);
  note("04", `browser.tabs new -> ${JSON.stringify(newBrowserTab).slice(0, 160)}`);
  await expect.poll(() => shell.tabbar.locator(".tab").count()).toBe(3);
  await panel.evaluate((id) => (window as never as { penAgentPanel: { canvas: { activateTab(id: number): void } } }).penAgentPanel.canvas.activateTab(id), first.tabId);
  await expect.poll(async () => (await listTabs(panel)).find((t) => t.tabId === first.tabId)?.active).toBe(true);
  await expect(shell.tabbar.locator(".tab.active")).toHaveCount(1);
  const activeIdx = await shell.tabbar.locator(".tab").evaluateAll((els) => els.findIndex((e) => e.classList.contains("active")));
  expect(activeIdx).toBe(0);
  expect(await sceneCount(c2)).toBeLessThan(3);
  note("04", `3 tabs (canvas1 active, canvas2, browser); list order ${(await listTabs(panel)).map((t) => t.tabId).join(",")}`);
  await shot(shell, "04-two-canvases-and-browser.png");

  // chat stays bound to the first canvas: a follow-up edit lands there, not on the active/other canvas
  const c1Before = await sceneCount(c1);
  const c2Before = await sceneCount(c2);
  await send(panel, "tiny edit please");
  await expect(panel.getByText("Added one more node.")).toBeVisible({ timeout: 30_000 });
  expect(await sceneCount(c1)).toBe(c1Before + 1);
  expect(await sceneCount(c2)).toBe(c2Before);
  note("04", "follow-up batch_design landed on canvas1 (bound), canvas2 unchanged");

  // ---- 5 browse from the panel with no canvas tab
  // Close both canvas tabs (the browser tab stays, so the shell does not respawn an editor tab).
  for (let guard = 0; guard < 4; guard++) {
    const kinds = await shell.tabbar.locator(".tab .title").allTextContents();
    const idx = (await listTabs(panel)).length > 0 ? 0 : -1;
    if (idx < 0) break;
    await shell.tabbar.locator(".tab").nth(0).hover();
    await shell.tabbar.locator(".tab .close").nth(0).click();
    await expect.poll(async () => (await listTabs(panel)).length, { timeout: 10_000 }).toBeLessThan(2 - Math.min(guard, 1) + 0);
    void kinds;
    if ((await listTabs(panel)).length === 0) break;
  }
  expect((await listTabs(panel)).length).toBe(0);
  await newChat(panel);
  const nChatBefore = stub.chatBodies.length;
  await send(panel, "browse the stub page");
  await expect(panel.getByText("Opened the stub page in the browser tab.")).toBeVisible({ timeout: 40_000 });
  expect((await listTabs(panel)).length).toBe(0); // no canvas tab was opened for a browser tool
  const cont = stub.chatBodies[stub.chatBodies.length - 1];
  const toolPart = (cont.messages ?? []).flatMap((m) => m.parts ?? []).find((p) => p.type === "tool-browse_open");
  note("05", `browse_open output: ${JSON.stringify(toolPart?.output).slice(0, 200)} (requests ${stub.chatBodies.length - nChatBefore})`);
  expect(JSON.stringify(toolPart?.output)).not.toMatch(/"error"/i);
  // Show the browser tab with the stub page.
  const browserIdx = await shell.tabbar.locator(".tab .title").evaluateAll((els) => els.findIndex((e) => /stub/i.test(e.textContent ?? "")));
  note("05", `tab titles: ${(await shell.tabbar.locator(".tab .title").allTextContents()).join(" | ")}`);
  if (browserIdx >= 0) await shell.tabbar.locator(".tab").nth(browserIdx).click();
  await new Promise((r) => setTimeout(r, 800));
  await shot(shell, "05-browse-from-panel.png");

  // ---- 6 canvas closed mid-stream
  await newChat(panel);
  const hold6 = stub.armHold(90); // the stream pauses after 90 deltas, so the close is deterministically mid-stream
  await send(panel, "close test: draw a long screen");
  await expect.poll(async () => (await listTabs(panel)).length, { timeout: 40_000 }).toBe(1);
  const bound = (await listTabs(panel))[0];
  const c3 = shell.app.windows().find((p) => isCanvas(p) && !shell.canvases.includes(p));
  if (c3) {
    watch(c3, "light:canvas3", shell.errors);
    await expect.poll(() => sceneCount(c3), { timeout: 30_000 }).toBeGreaterThan(2);
  }
  await hold6.reached;
  const t0 = Date.now();
  const idxCanvas = await shell.tabbar.locator(".tab").evaluateAll((els) => els.length);
  // The canvas tab (title "Untitled"; the browser tab is "Stub Page") may be a background tab: close it by title.
  const titles = await shell.tabbar.locator(".tab .title").allTextContents();
  const canvasIdx = titles.findIndex((t) => /untitled/i.test(t));
  note("06", `strip titles at close: ${titles.join(" | ")}; closing index ${canvasIdx}`);
  expect(canvasIdx).toBeGreaterThanOrEqual(0);
  await shell.tabbar.locator(".tab").nth(canvasIdx).hover();
  await shell.tabbar.locator(".tab .close").nth(canvasIdx).click();
  void bound;
  void idxCanvas;
  // Stream is HELD mid-way. Does the chat react to the closed tab while the model is still streaming?
  const probe = async (): Promise<{ running: boolean; closedText: boolean }> => {
    const txt = await panel.locator("body").innerText();
    return { running: /Running\.\.\./.test(txt), closedText: /canvas tab was closed/i.test(txt) };
  };
  let heldRunningGone = -1;
  let heldErrorText = -1;
  while (Date.now() - t0 < 3_000) {
    const r = await probe();
    if (heldRunningGone < 0 && !r.running) heldRunningGone = Date.now() - t0;
    if (heldErrorText < 0 && r.closedText) heldErrorText = Date.now() - t0;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  await shot(shell, "06a-canvas-closed-mid-stream.png");
  note("06", `while the stream is held mid-way (3 s after close): Running... gone at ${heldRunningGone} ms, error text at ${heldErrorText} ms (-1 = never)`);
  const tRelease = Date.now();
  hold6.release();
  let tRunningGone = -1;
  let tErrorText = -1;
  while (Date.now() - tRelease < 25_000) {
    const r = await probe();
    if (tRunningGone < 0 && !r.running) tRunningGone = Date.now() - tRelease;
    if (tErrorText < 0 && r.closedText) tErrorText = Date.now() - tRelease;
    if (tRunningGone >= 0) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const cs = stub.closeStream!;
  await new Promise((r) => setTimeout(r, 1_500));
  note("06", `after releasing the stream: stream ended ${cs.end === null ? -1 : cs.end - tRelease} ms after release; Running... gone ${tRunningGone} ms after release`);
  await shot(shell, "06-canvas-closed.png");
  const text1 = (await panel.locator("body").innerText()).replace(/\n+/g, " | ");
  note("06", `panel text: ${text1.slice(0, 300)}`);
  await panel.getByText("Design", { exact: true }).first().click().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 500));
  const text2 = (await panel.locator("body").innerText()).replace(/\n+/g, " | ");
  note("06", `expanded row OUTPUT: ${text2.slice(text2.indexOf("OUTPUT") >= 0 ? text2.indexOf("OUTPUT") : 0).slice(0, 300)}`);
  const dt = heldErrorText >= 0 ? heldErrorText : heldRunningGone;
  note("06", `error shown ${dt} ms after the close (-1 = never), stream still open`);
  // Soft: a failure is visible in the report but the remaining screenshots are still captured.
  expect.soft(dt >= 0 && dt < 1_500, "the chat shows an error within 1.5 s of the close while the stream is still open (row stays Running... until the model's tool-input ends)").toBe(true);
  expect.soft(/canvas tab was closed/i.test(text2), 'output text is "The canvas tab was closed."').toBe(true);

  note("errors", JSON.stringify(Object.fromEntries(shell.errors)));
  } finally {
    await app.close().catch(() => undefined);
  }
});

test("agent layout: state 7 (dark)", async () => {
  test.setTimeout(180_000);
  const shell = await launch({ tag: "dark", dark: true, emptyShot: "00b-empty-dark.png" });
  try {
    const { panel } = shell;
    const c1 = shell.canvases[0];
    expect(await panel.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    expect(await c1.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    await fitScreen(c1);
    await send(panel, "design a focus app home screen");
    await expect(panel.getByText("Done. The Focus Home screen is on the canvas.")).toBeVisible({ timeout: 40_000 });
    expect(await sceneNames(c1)).toContain("Focus Home");
    await fitScreen(c1);
    expect(await sceneCount(panel)).toBe(0);
    note("07", "dark theme in panel and canvas; design turn done, nodes on canvas, panel scene empty");
    await shot(shell, "07-dark.png");
    // 07b: a browser tab in the dark theme (address row = top of the island).
    await newChat(panel);
    await send(panel, "browse the stub page");
    await expect(panel.getByText("Opened the stub page in the browser tab.")).toBeVisible({ timeout: 40_000 });
    const stubIdx = await shell.tabbar.locator(".tab .title").evaluateAll((els) => els.findIndex((e) => /stub/i.test(e.textContent ?? "")));
    if (stubIdx >= 0) await shell.tabbar.locator(".tab").nth(stubIdx).click();
    await new Promise((r) => setTimeout(r, 1200));
    await shot(shell, "07b-dark-browser.png");
    note("errors-dark", JSON.stringify(Object.fromEntries(shell.errors)));

  } finally {
    await shell.app.close().catch(() => undefined);
  }
});
