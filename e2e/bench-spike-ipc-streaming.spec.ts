// SPIKE (branch spike/ipc-streaming only): measures canvas-tool streaming over
// the main-process IPC relay (chat tab -> main -> canvas tab) in the real
// Electron shell, against a LOCAL Vite dev server of the spike frontend.
// Contract: docs/spike-ipc-streaming-contract.md. Report: docs/spike-ipc-streaming-report.md.
//
// Opt-in (bench-*.spec.ts): `npm run test:e2e:bench -- e2e/bench-spike-ipc-streaming.spec.ts`.
//
// Prerequisites (the spec does not start Vite itself):
//   cd ../wt-spike-fe   # or any pen-editor checkout carrying the spike code
//   VITE_AI_API_URL=http://127.0.0.1:5199/api/chat npm run dev -- --port 5198 --strictPort
// The frontend talks to a stub AI backend this spec runs on :5199 (CORS
// reflects the Origin). It scripts one streamed batch_design tool call per
// armed turn and answers the auto-continuation with a short text turn.
//
// Knobs: SPIKE_RUNS (default 5), SPIKE_SCENARIOS (comma list, default all of
// S0,S1,S1v,S2,S3,S4,S5; S3x is opt-in), SPIKE_PACE_MS (default 15), SPIKE_OUT_DIR.

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

const EDITOR_URL = process.env.PEN_DESKTOP_URL ?? "http://localhost:5198/app";
const EDITOR_ORIGIN = new URL(EDITOR_URL).origin;
const STUB_PORT = Number(process.env.SPIKE_STUB_PORT ?? 5199);
const RUNS = Math.max(1, Number(process.env.SPIKE_RUNS ?? 5));
const PACE_MS = Number(process.env.SPIKE_PACE_MS ?? 15);
const SCENARIOS = new Set((process.env.SPIKE_SCENARIOS ?? "S0,S1,S1v,S2,S3,S4,S5").split(",").map((s) => s.trim()));
const OUT_DIR = process.env.SPIKE_OUT_DIR ?? path.join(process.cwd(), "test-results", "bench");
const STATEMENTS = 24; // batch_design applies at most 25 operations per call

// ---------------------------------------------------------------- statistics

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}
function summarize(values: number[]): { n: number; median: number; p95: number; min: number; max: number } {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const r = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : NaN);
  return { n: v.length, median: r(pct(v, 0.5)), p95: r(pct(v, 0.95)), min: r(v[0] ?? NaN), max: r(v[v.length - 1] ?? NaN) };
}

// --------------------------------------------------------------- operations

/** batch_design mini-script: STATEMENTS frames, each with `children` small rects. */
function makeOperations(targetChars: number): { operations: string; nodes: number } {
  const stmtChars = Math.floor(targetChars / STATEMENTS);
  const childProto = (i: number) =>
    `{type: "rect", name: "c${i}", x: ${(i % 9) * 26}, y: ${Math.floor(i / 9) * 26}, width: 24, height: 24, fill: "#3b82f6"}`;
  let children = 1;
  const build = (n: number, s: number) =>
    `f${s}=I(document, {type: "frame", name: "F${s}", x: ${(s % 6) * 260}, y: ${Math.floor(s / 6) * 260}, width: 250, height: 250, children: [${Array.from({ length: n }, (_, i) => childProto(i)).join(", ")}]})\n`;
  while (build(children + 1, 0).length <= stmtChars) children++;
  let operations = "";
  for (let s = 0; s < STATEMENTS; s++) operations += build(children, s);
  return { operations, nodes: STATEMENTS * (children + 1) };
}

// ------------------------------------------------------------- stub backend

interface Armed {
  operations: string;
  deltas: number;
  paceMs: number;
}
interface StubRun {
  tFirstDelta: number | null;
  tLastDelta: number | null;
  deltasSent: number;
  tContinuation: number | null;
  continuationToolOutput: string | null;
  continuationBodyBytes: number | null;
  canvasContextBytes: number[];
  chatRequests: number;
}

class StubBackend {
  server!: http.Server;
  armed: Armed | null = null;
  run: StubRun = StubBackend.fresh();
  private waiters: Array<() => void> = [];

  static fresh(): StubRun {
    return {
      tFirstDelta: null,
      tLastDelta: null,
      deltasSent: 0,
      tContinuation: null,
      continuationToolOutput: null,
      continuationBodyBytes: null,
      canvasContextBytes: [],
      chatRequests: 0,
    };
  }

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
  port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  arm(a: Armed): void {
    this.run = StubBackend.fresh();
    this.armed = a;
  }
  reset(): void {
    this.run = StubBackend.fresh();
    this.armed = null;
  }
  /** Resolves when a request after the streamed turn (the auto-continuation) arrived. */
  async waitForContinuation(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.run.tContinuation === null) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  }
  async waitForDeltas(n: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.run.deltasSent < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  }

  private cors(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader("access-control-allow-origin", req.headers.origin ?? EDITOR_ORIGIN);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("vary", "origin");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.cors(req, res);
    const url = req.url ?? "";
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [{ id: "test/spike-model", label: "Spike Model", supportsVision: true }],
          default: "test/spike-model",
        }),
      );
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/chat")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: { canvasContext?: unknown; messages?: unknown } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      this.run.chatRequests++;
      if (typeof body.canvasContext === "string") this.run.canvasContextBytes.push(body.canvasContext.length);
      const armed = this.armed;
      this.armed = null;
      if (armed) await this.streamToolCall(res, armed);
      else await this.textTurn(res, raw);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  }

  private sse(res: http.ServerResponse, chunk: Record<string, unknown>): void {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  private sseHeaders(res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
      "cache-control": "no-cache",
    });
  }

  private async streamToolCall(res: http.ServerResponse, a: Armed): Promise<void> {
    this.sseHeaders(res);
    this.sse(res, { type: "start" });
    this.sse(res, { type: "start-step" });
    this.sse(res, { type: "tool-input-start", toolCallId: "spike-1", toolName: "batch_design" });
    const json = JSON.stringify({ operations: a.operations });
    const size = Math.ceil(json.length / a.deltas);
    const t0 = Date.now();
    for (let i = 0; i < a.deltas; i++) {
      const target = t0 + i * a.paceMs;
      const wait = target - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (res.destroyed) return;
      this.sse(res, { type: "tool-input-delta", toolCallId: "spike-1", inputTextDelta: json.slice(i * size, (i + 1) * size) });
      const now = performance.timeOrigin + performance.now();
      if (this.run.tFirstDelta === null) this.run.tFirstDelta = now;
      this.run.tLastDelta = now;
      this.run.deltasSent = i + 1;
    }
    this.sse(res, { type: "tool-input-available", toolCallId: "spike-1", toolName: "batch_design", input: { operations: a.operations } });
    this.sse(res, { type: "finish-step" });
    this.sse(res, { type: "finish" });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private async textTurn(res: http.ServerResponse, rawBody: string): Promise<void> {
    this.run.tContinuation = performance.timeOrigin + performance.now();
    this.run.continuationBodyBytes = rawBody.length;
    try {
      const body = JSON.parse(rawBody) as { messages?: Array<{ parts?: Array<Record<string, unknown>> }> };
      for (const m of body.messages ?? []) {
        for (const p of m.parts ?? []) {
          if (typeof p.type === "string" && p.type.startsWith("tool-") && p.output !== undefined) {
            this.run.continuationToolOutput = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
          }
        }
      }
    } catch {
      /* ignore */
    }
    this.sseHeaders(res);
    this.sse(res, { type: "start" });
    this.sse(res, { type: "start-step" });
    this.sse(res, { type: "text-start", id: "t1" });
    this.sse(res, { type: "text-delta", id: "t1", delta: "Done. The frames are on the canvas." });
    this.sse(res, { type: "text-end", id: "t1" });
    this.sse(res, { type: "finish-step" });
    this.sse(res, { type: "finish" });
    res.write("data: [DONE]\n\n");
    res.end();
    for (const w of this.waiters.splice(0)) w();
  }
}

// ------------------------------------------------------------------- shell

interface Shell {
  app: ElectronApplication;
  tabbar: Page;
  a: Page;
  b: Page | null;
  consoleErrors: { a: string[]; b: string[] };
}

function watchErrors(page: Page, sink: string[]): void {
  page.on("console", (m) => {
    if (m.type() === "error") sink.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => sink.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("response", (r) => {
    if (r.status() >= 400) sink.push(`http ${r.status()} ${r.url().slice(0, 160)}`);
  });
}

async function launch(homeDir: string): Promise<Shell> {
  fs.mkdirSync(homeDir, { recursive: true });
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: EDITOR_URL, HOME: homeDir, USERPROFILE: homeDir },
  });
  const consoleErrors = { a: [] as string[], b: [] as string[] };
  const a = await app.waitForEvent("window", { predicate: (p) => p.url().startsWith(EDITOR_ORIGIN) });
  watchErrors(a, consoleErrors.a);
  const tabbar =
    app.windows().find((p) => p.url().endsWith("/tabbar/tabbar.html")) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("/tabbar/tabbar.html") }));
  await ready(a);
  return { app, tabbar, a, b: null, consoleErrors };
}

async function ready(page: Page): Promise<void> {
  await page.locator("[data-canvas]").waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __spike?: unknown }).__spike), undefined, { timeout: 30_000 });
}

async function openSecondTab(shell: Shell): Promise<void> {
  await shell.tabbar.evaluate(() => (window as unknown as { penTabbar: { newTab(): void } }).penTabbar.newTab());
  const b = await shell.app.waitForEvent("window", { predicate: (p) => p.url().startsWith(EDITOR_ORIGIN) && p !== shell.a });
  watchErrors(b, shell.consoleErrors.b);
  await ready(b);
  shell.b = b;
}

async function activateTab(shell: Shell, which: "a" | "b"): Promise<void> {
  const idx = which === "a" ? 0 : 1;
  await shell.tabbar.locator(".tab").nth(idx).click();
}

interface CpuSample {
  [id: string]: { cpu: number; url: string };
}
/** Cumulative CPU seconds per webContents, from the main process. */
async function sampleCpu(app: ElectronApplication): Promise<CpuSample> {
  return app.evaluate(({ app: electronApp, webContents }) => {
    const metrics = electronApp.getAppMetrics();
    const out: Record<string, { cpu: number; url: string }> = {};
    for (const wc of webContents.getAllWebContents()) {
      const pid = wc.getOSProcessId();
      const m = metrics.find((x) => x.pid === pid);
      if (m) out[String(wc.id)] = { cpu: m.cpu.cumulativeCPUUsage ?? 0, url: wc.getURL() };
    }
    const main = metrics.find((x) => x.type === "Browser");
    if (main) out["main"] = { cpu: main.cpu.cumulativeCPUUsage ?? 0, url: "main" };
    return out;
  });
}
function cpuDelta(before: CpuSample, after: CpuSample): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, s] of Object.entries(after)) if (before[id]) out[`${id}:${s.url.replace(EDITOR_ORIGIN, "")}`] = Math.round((s.cpu - before[id].cpu) * 1000) / 1000;
  return out;
}

// --------------------------------------------------------- in-page recorder

/** Records scene growth timestamps and long tasks. Returns nothing. */
async function installRecorder(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Store = { getState(): { nodesById: Record<string, unknown> }; subscribe(cb: () => void): () => void };
    const w = window as unknown as {
      __sceneStore: Store;
      __rec?: { base: number; first: number | null; last: number | null; count: number; samples: Array<[number, number]>; longTasks: number[] };
    };
    const now = () => performance.timeOrigin + performance.now();
    const base = Object.keys(w.__sceneStore.getState().nodesById).length;
    const rec = { base, first: null as number | null, last: null as number | null, count: base, samples: [] as Array<[number, number]>, longTasks: [] as number[] };
    w.__rec = rec;
    let lastRef: unknown = w.__sceneStore.getState().nodesById;
    w.__sceneStore.subscribe(() => {
      const ref = w.__sceneStore.getState().nodesById;
      if (ref === lastRef) return;
      lastRef = ref;
      const n = Object.keys(ref).length;
      if (n > rec.count) {
        const t = now();
        if (rec.first === null) rec.first = t;
        rec.last = t;
        rec.samples.push([t, n]);
      }
      rec.count = n;
    });
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) rec.longTasks.push(e.duration);
      }).observe({ type: "longtask", buffered: false });
    } catch {
      /* longtask unsupported */
    }
    return base;
  });
}

interface RecResult {
  base: number;
  first: number | null;
  last: number | null;
  count: number;
  longTasks: number[];
}
async function readRecorder(page: Page): Promise<RecResult> {
  return page.evaluate(() => {
    const r = (window as unknown as { __rec: RecResult }).__rec;
    return { base: r.base, first: r.first, last: r.last, count: r.count, longTasks: r.longTasks };
  });
}

// ---------------------------------------------------------------- chat helper

async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByTestId("rail-agents").click();
  const input = page.getByPlaceholder("Ask the design agent...");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(text);
  await input.press("Enter");
}

type Format = "append" | "full";
interface SpikeStatsLite {
  received: Record<string, { count: number; bytes: number; latencyMs: Dist; mainHopMs: Dist }>;
  sent: Record<string, { count: number; bytes: number }>;
  seq: { gaps: number; outOfOrder: number };
  resyncs: { sent: number; received: number };
  ignoredFrames: number;
  errors: number;
  peerGone: number;
  context: { requests: number; roundTripMs: Dist; fallbacks: number; answered: number; versionsRepeated: number };
  contextStable: boolean | null;
}
interface Dist {
  count: number;
  p50: number;
  p95: number;
  max: number;
}
const spikeStats = (page: Page): Promise<SpikeStatsLite> =>
  page.evaluate(() => (window as unknown as { __spike: { stats(): unknown } }).__spike.stats() as never);

// ------------------------------------------------------------------ one run

interface StreamRunResult {
  scenario: string;
  format: Format | "local";
  chars: number;
  deltas: number;
  expectedNodes: number;
  firstDeltaToFirstNodeMs: number | null;
  firstDeltaToLastNodeMs: number | null;
  firstDeltaToContinuationMs: number | null;
  streamDurationMs: number | null;
  lastDeltaToLastNodeMs: number | null;
  nodesAdded: number;
  continuationToolOutput: string | null;
  statsA: SpikeStatsLite | null;
  statsB: SpikeStatsLite | null;
  longTasksRecordingTab: { count: number; totalMs: number; maxMs: number };
  longTasksChatTab: { count: number; totalMs: number; maxMs: number };
  cpuSeconds: Record<string, number>;
  errorsA: string[];
  errorsB: string[];
}

const ltSummary = (xs: number[]) => ({
  count: xs.length,
  totalMs: Math.round(xs.reduce((s, x) => s + x, 0)),
  maxMs: Math.round(Math.max(0, ...xs)),
});

async function streamRun(
  stub: StubBackend,
  homeDir: string,
  opts: { scenario: string; format: Format | "local"; chars: number; deltas: number; canvasVisible?: boolean },
): Promise<StreamRunResult> {
  const shell = await launch(homeDir);
  try {
    const remote = opts.format !== "local";
    if (remote) await openSecondTab(shell);
    const { operations, nodes } = makeOperations(opts.chars);
    const recPage = remote ? shell.b! : shell.a;

    if (remote) {
      await shell.a.evaluate((fmt) => {
        const s = (window as unknown as { __spike: { format: string; setRole(r: string): void } }).__spike;
        s.format = fmt;
        s.setRole("chat");
      }, opts.format);
      await shell.b!.evaluate(() => (window as unknown as { __spike: { setRole(r: string): void } }).__spike.setRole("canvas"));
    }
    await installRecorder(recPage);
    if (remote) await installRecorder(shell.a);
    await activateTab(shell, "a");
    const cpu0 = await sampleCpu(shell.app);

    stub.arm({ operations, deltas: opts.deltas, paceMs: PACE_MS });
    await sendChat(shell.a, "draw frames");
    // canvasVisible: the canvas tab is the active (painting) one while it streams; otherwise
    // it is a hidden WebContentsView and the chat tab stays in front.
    if (opts.canvasVisible && remote) await activateTab(shell, "b");
    const gotContinuation = await stub.waitForContinuation(180_000);
    expect(gotContinuation, "no auto-continuation request reached the stub").toBe(true);
    await shell.a.getByText("Done. The frames are on the canvas.").waitFor({ timeout: 30_000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));

    const cpu1 = await sampleCpu(shell.app);
    const rec = await readRecorder(recPage);
    const chatRec = remote ? await readRecorder(shell.a) : rec;
    const statsA = remote ? await spikeStats(shell.a) : null;
    const statsB = remote ? await spikeStats(shell.b!) : null;
    const r = stub.run;
    const rel = (t: number | null) => (t !== null && r.tFirstDelta !== null ? Math.round((t - r.tFirstDelta) * 100) / 100 : null);
    return {
      scenario: opts.scenario,
      format: opts.format,
      chars: operations.length,
      deltas: opts.deltas,
      expectedNodes: nodes,
      firstDeltaToFirstNodeMs: rel(rec.first),
      firstDeltaToLastNodeMs: rel(rec.last),
      firstDeltaToContinuationMs: rel(r.tContinuation),
      streamDurationMs: rel(r.tLastDelta),
      lastDeltaToLastNodeMs: r.tLastDelta !== null && rec.last !== null ? Math.round((rec.last - r.tLastDelta) * 100) / 100 : null,
      nodesAdded: rec.count - rec.base,
      continuationToolOutput: r.continuationToolOutput?.slice(0, 200) ?? null,
      statsA,
      statsB,
      longTasksRecordingTab: ltSummary(rec.longTasks),
      longTasksChatTab: ltSummary(chatRec.longTasks),
      cpuSeconds: cpuDelta(cpu0, cpu1),
      errorsA: [...shell.consoleErrors.a],
      errorsB: [...shell.consoleErrors.b],
    };
  } finally {
    stub.reset();
    await shell.app.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------ aggregation/IO

const allResults: Record<string, unknown> = {};

function agg(runs: StreamRunResult[], pick: (r: StreamRunResult) => number | null | undefined) {
  return summarize(runs.map((r) => pick(r) ?? NaN));
}

function summarizeStreamRuns(runs: StreamRunResult[]) {
  const recv = (r: StreamRunResult, kind: string) => r.statsB?.received?.[kind];
  const recvA = (r: StreamRunResult, kind: string) => r.statsA?.received?.[kind];
  return {
    runs: runs.length,
    chars: runs[0]?.chars,
    deltas: runs[0]?.deltas,
    expectedNodes: runs[0]?.expectedNodes,
    nodesAdded: agg(runs, (r) => r.nodesAdded),
    firstDeltaToFirstNodeMs: agg(runs, (r) => r.firstDeltaToFirstNodeMs),
    firstDeltaToLastNodeMs: agg(runs, (r) => r.firstDeltaToLastNodeMs),
    lastDeltaToLastNodeMs: agg(runs, (r) => r.lastDeltaToLastNodeMs),
    firstDeltaToContinuationMs: agg(runs, (r) => r.firstDeltaToContinuationMs),
    streamDurationMs: agg(runs, (r) => r.streamDurationMs),
    ipc: runs[0]?.statsB
      ? {
          streamMsgsToCanvas: agg(runs, (r) => recv(r, "stream")?.count),
          streamBytesToCanvas: agg(runs, (r) => recv(r, "stream")?.bytes),
          streamLatencyP50Ms: agg(runs, (r) => recv(r, "stream")?.latencyMs.p50),
          streamLatencyP95Ms: agg(runs, (r) => recv(r, "stream")?.latencyMs.p95),
          streamLatencyMaxMs: agg(runs, (r) => recv(r, "stream")?.latencyMs.max),
          streamMainHopP50Ms: agg(runs, (r) => recv(r, "stream")?.mainHopMs.p50),
          streamMainHopP95Ms: agg(runs, (r) => recv(r, "stream")?.mainHopMs.p95),
          callBytes: agg(runs, (r) => recv(r, "call")?.bytes),
          callLatencyMs: agg(runs, (r) => recv(r, "call")?.latencyMs.max),
          resultLatencyMs: agg(runs, (r) => recvA(r, "result")?.latencyMs.max),
          seqGaps: agg(runs, (r) => r.statsB?.seq.gaps),
          seqOutOfOrder: agg(runs, (r) => r.statsB?.seq.outOfOrder),
          resyncsSentByCanvas: agg(runs, (r) => r.statsB?.resyncs.sent),
          ignoredFrames: agg(runs, (r) => r.statsB?.ignoredFrames),
          errorsAtChat: agg(runs, (r) => r.statsA?.errors),
        }
      : null,
    longTasksRecordingTab: {
      count: agg(runs, (r) => r.longTasksRecordingTab.count),
      totalMs: agg(runs, (r) => r.longTasksRecordingTab.totalMs),
      maxMs: agg(runs, (r) => r.longTasksRecordingTab.maxMs),
    },
    longTasksChatTab: {
      count: agg(runs, (r) => r.longTasksChatTab.count),
      totalMs: agg(runs, (r) => r.longTasksChatTab.totalMs),
      maxMs: agg(runs, (r) => r.longTasksChatTab.maxMs),
    },
    consoleErrors: { tabA: runs.flatMap((r) => r.errorsA), tabB: runs.flatMap((r) => r.errorsB) },
    toolOutputs: [...new Set(runs.map((r) => r.continuationToolOutput))],
  };
}

function flush(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "spike-ipc-streaming-latest.json"), JSON.stringify(allResults, null, 2));
}

// ------------------------------------------------------------------- tests

const stub = new StubBackend();
test.beforeAll(async () => {
  await stub.start();
});
test.afterAll(async () => {
  flush();
  await stub.stop();
});

const SIZES = {
  small: { chars: 25_000, deltas: 400 },
  large: { chars: 200_000, deltas: 800 },
  xl: { chars: 1_000_000, deltas: 2000 },
};

async function matrix(name: string, format: Format | "local", size: { chars: number; deltas: number }, runs: number, testInfo: { outputPath(p: string): string }, canvasVisible = false) {
  const results: StreamRunResult[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(await streamRun(stub, testInfo.outputPath(`home-${name}-${i}`), { scenario: name, format, ...size, canvasVisible }));
  }
  allResults[name] = { summary: summarizeStreamRuns(results), raw: results };
  flush();
  console.log(`\n== ${name} ==\n${JSON.stringify((allResults[name] as { summary: unknown }).summary, null, 1)}`);
}

test.describe.configure({ mode: "serial" });

test("S0 baseline: local apply, no roles", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S0"));
  test.setTimeout(RUNS * 90_000);
  await matrix("S0", "local", SIZES.small, RUNS, testInfo);
});
test("S1 remote append, 25 KB", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S1"));
  test.setTimeout(RUNS * 120_000);
  await matrix("S1", "append", SIZES.small, RUNS, testInfo);
});
test("S1v/S2v remote with the canvas tab visible", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S1v"));
  test.setTimeout(RUNS * 240_000);
  await matrix("S1v", "append", SIZES.small, RUNS, testInfo, true);
  await matrix("S2v", "full", SIZES.small, RUNS, testInfo, true);
});
test("S2 remote full, 25 KB", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S2"));
  test.setTimeout(RUNS * 120_000);
  await matrix("S2", "full", SIZES.small, RUNS, testInfo);
});
test("S3 large, 200 KB, both formats (and local)", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S3"));
  const runs = Math.min(RUNS, 3);
  test.setTimeout(runs * 3 * 240_000);
  await matrix("S3-local", "local", SIZES.large, runs, testInfo);
  await matrix("S3-append", "append", SIZES.large, runs, testInfo);
  await matrix("S3-full", "full", SIZES.large, runs, testInfo);
});

test("S3x stress, 1 MB, both formats (opt-in: SPIKE_SCENARIOS=S3x)", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S3x"));
  test.setTimeout(900_000);
  await matrix("S3x-append", "append", SIZES.xl, 2, testInfo);
  await matrix("S3x-full", "full", SIZES.xl, 2, testInfo);
});

// ---------------------------------------------------------------------- S4

test("S4 context round trips", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S4"));
  test.setTimeout(600_000);
  const shell = await launch(testInfo.outputPath("home-s4"));
  const out: Record<string, unknown> = {};
  try {
    await openSecondTab(shell);
    await shell.a.evaluate(() => (window as unknown as { __spike: { setRole(r: string): void } }).__spike.setRole("chat"));
    await shell.b!.evaluate(() => (window as unknown as { __spike: { setRole(r: string): void } }).__spike.setRole("canvas"));
    await activateTab(shell, "a");

    const mutate = (n: number) =>
      shell.b!.evaluate(async (k) => {
        const mod = (await import(/* @vite-ignore */ ["", "src", "hooks", "useDesignChat.ts"].join("/"))) as {
          executeToolCall(name: string, input: unknown, ctx: unknown, mode: string): Promise<string>;
        };
        return mod.executeToolCall(
          "batch_design",
          { operations: `m${k}=I(document, {type: "rect", name: "m${k}", x: ${k}, y: 0, width: 10, height: 10})` },
          { sessionId: "spike-bench", toolCallId: `m${k}` },
          "chat",
        );
      }, n);

    const roundTrips = (count: number) =>
      shell.a.evaluate(async (n) => {
        const s = (window as unknown as { __spike: { requestContext(): Promise<string | null> } }).__spike;
        const times: number[] = [];
        const hashes = new Set<string>();
        let nulls = 0;
        for (let i = 0; i < n; i++) {
          const t = performance.now();
          const v = await s.requestContext();
          times.push(performance.now() - t);
          if (v === null) nulls++;
          else hashes.add(String(v.length) + ":" + v.slice(0, 64) + v.slice(-64));
        }
        return { times, nulls, distinct: hashes.size };
      }, count);

    const sizeOf = () =>
      shell.b!.evaluate(() => Object.keys((window as unknown as { __sceneStore: { getState(): { nodesById: object } } }).__sceneStore.getState().nodesById).length);

    const phase = async (label: string, mutateEach: boolean) => {
      await shell.a.evaluate(() => (window as unknown as { __spike: { reset(): void } }).__spike.reset());
      await shell.b!.evaluate(() => (window as unknown as { __spike: { reset(): void } }).__spike.reset());
      let r: Awaited<ReturnType<typeof roundTrips>>;
      if (mutateEach) {
        const times: number[] = [];
        let nulls = 0;
        for (let i = 0; i < 100; i++) {
          await mutate(1000 + i);
          const one = await roundTrips(1);
          times.push(...one.times);
          nulls += one.nulls;
        }
        r = { times, nulls, distinct: -1 };
      } else {
        r = await roundTrips(100);
      }
      const sa = await spikeStats(shell.a);
      const sb = await spikeStats(shell.b!);
      out[label] = {
        sceneNodes: await sizeOf(),
        ownRoundTripMs: summarize(r.times),
        spikeRoundTripMs: sa.context.roundTripMs,
        fallbacks: sa.context.fallbacks,
        nullResponses: r.nulls,
        distinctResponses: r.distinct,
        contextStable: sb.contextStable,
        answered: sb.context.answered,
        versionsRepeated: sb.context.versionsRepeated,
        responseBytesAtChat: sa.received["context-response"]?.bytes,
        responseLatencyMs: sa.received["context-response"]?.latencyMs,
        requestMainHopMs: sb.received["context-request"]?.mainHopMs,
      };
      console.log(label, JSON.stringify(out[label]));
    };

    await phase("empty-unchanged", false);
    await mutate(1);
    await phase("after-1-mutation-unchanged", false);
    await phase("empty-ish-mutate-each", true);

    // Large scene: stream 24 frames x ~100 children locally on B via a chat turn is not
    // possible (B has no chat); apply the script directly with executeToolCall.
    const big = makeOperations(25_000);
    await shell.b!.evaluate(async (ops) => {
      const mod = (await import(/* @vite-ignore */ ["", "src", "hooks", "useDesignChat.ts"].join("/"))) as {
        executeToolCall(name: string, input: unknown, ctx: unknown, mode: string): Promise<string>;
      };
      await mod.executeToolCall("batch_design", { operations: ops }, { sessionId: "spike-bench", toolCallId: "big1" }, "chat");
    }, big.operations);
    await phase("large-scene-unchanged", false);
    await phase("large-scene-mutate-each", true);

    out.errorsA = shell.consoleErrors.a;
    out.errorsB = shell.consoleErrors.b;
    allResults["S4"] = out;
    flush();
  } finally {
    await shell.app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------- S5

test("S5 close canvas tab mid-stream", async ({}, testInfo) => {
  test.skip(!SCENARIOS.has("S5"));
  const runs = Math.min(RUNS, 5);
  test.setTimeout(runs * 120_000);
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < runs; i++) {
    const shell = await launch(testInfo.outputPath(`home-s5-${i}`));
    try {
      await openSecondTab(shell);
      await shell.a.evaluate(() => {
        const s = (window as unknown as { __spike: { format: string; setRole(r: string): void } }).__spike;
        s.format = "append";
        s.setRole("chat");
      });
      await shell.b!.evaluate(() => (window as unknown as { __spike: { setRole(r: string): void } }).__spike.setRole("canvas"));
      await installRecorder(shell.b!);
      await activateTab(shell, "a");
      const { operations } = makeOperations(SIZES.small.chars);
      stub.arm({ operations, deltas: SIZES.small.deltas, paceMs: PACE_MS });
      await sendChat(shell.a, "draw frames");
      await stub.waitForDeltas(SIZES.small.deltas / 2, 60_000);
      const nodesAtClose = await readRecorder(shell.b!).then((r) => r.count - r.base).catch(() => -1);
      const tClose = performance.timeOrigin + performance.now();
      await shell.tabbar.locator(".tab .close").nth(1).dispatchEvent("click");
      const got = await stub.waitForContinuation(60_000);
      const r = stub.run;
      await shell.a.getByText("Done. The frames are on the canvas.").waitFor({ timeout: 20_000 }).catch(() => undefined);
      const finishedText = await shell.a.getByText("Done. The frames are on the canvas.").count();
      await new Promise((res) => setTimeout(res, 300));
      const statsA = await spikeStats(shell.a);
      const chatErrorBanner = await shell.a.getByText(/something went wrong|error/i).count().catch(() => -1);
      results.push({
        gotContinuation: got,
        closeToContinuationMs: r.tContinuation !== null ? Math.round((r.tContinuation - tClose) * 100) / 100 : null,
        lastDeltaToContinuationMs:
          r.tContinuation !== null && r.tLastDelta !== null ? Math.round((r.tContinuation - r.tLastDelta) * 100) / 100 : null,
        deltasAtClose: SIZES.small.deltas / 2,
        nodesOnCanvasAtClose: nodesAtClose,
        toolOutput: r.continuationToolOutput,
        chatFinishedWithText: finishedText > 0,
        chatErrorTextMatches: chatErrorBanner,
        statsA: { peerGone: statsA.peerGone, errors: statsA.errors, sent: statsA.sent, received: Object.fromEntries(Object.entries(statsA.received).map(([k, v]) => [k, v.count])) },
        errorsA: [...shell.consoleErrors.a],
        errorsB: [...shell.consoleErrors.b],
      });
      console.log("S5 run", i, JSON.stringify(results[results.length - 1]));
    } finally {
      stub.reset();
      await shell.app.close().catch(() => undefined);
    }
  }
  allResults["S5"] = {
    summary: {
      closeToContinuationMs: summarize(results.map((r) => (r.closeToContinuationMs as number | null) ?? NaN)),
      lastDeltaToContinuationMs: summarize(results.map((r) => (r.lastDeltaToContinuationMs as number | null) ?? NaN)),
      errorEnvelopesAtChat: summarize(results.map((r) => ((r.statsA as { errors: number }).errors))), toolOutputs: [...new Set(results.map((r) => r.toolOutput))] },
    raw: results,
  };
  flush();
});
