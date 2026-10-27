// One scenario run: a fresh Electron profile, the real desktop shell loading
// the editor, one chat turn on the pinned chat model, and every
// /api/chat + /api/browse/step exchange recorded from the editor page.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron, type ElectronApplication, type Page, type Request } from "playwright";
import { DESKTOP_DIR } from "./paths.ts";
import type { Scenario, Verdict } from "./scenarios.ts";
import type { Stack, BackendStepLog } from "./stack.ts";
import { startRecorder, type Recorder } from "./recorder.ts";
import { readEndState, type EndState } from "./endState.ts";
import { runJudge, type JudgeResult } from "./judge.ts";

const TURN_CAP_MS = Number(process.env.BENCH_TURN_CAP_MS ?? 10 * 60_000);
const TURN_END_DEBOUNCE_MS = 2_500;
/** Post-turn harness work (response bodies, end state, app close) must never
 * hang the whole suite: a tab stuck in executeJavaScript/capturePage blocked
 * nightly-1-1 for 2 h on the first scenario. */
const BODIES_CAP_MS = 30_000;
const END_STATE_CAP_MS = 90_000;
const CLOSE_CAP_MS = 20_000;

function withCap<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, cap]).finally(() => clearTimeout(timer));
}

export type PromptStyle = "task" | "free" | "manual" | "agent";

export interface StepRecord {
  /** ms from the run's send, request start / response end. */
  t0: number;
  t1: number;
  latencyMs: number;
  status: number;
  /** Error message of a non-200 step response (the backend's first zod issue on a 400). */
  error?: string;
  historyLen: number;
  elements: number;
  pageTextChars: number;
  /** Length of the marked screenshot data URL sent with the step (vision experiment). */
  screenshotChars: number;
  outcome?: string;
  operation?: string;
  index?: number;
  confidence?: number;
  cascade: boolean;
  cascadeNote?: string;
  textSource?: string;
  timings?: { jevMs: number; textMs?: number; cascadeMs?: number; totalMs: number };
  reason?: string;
}

export interface ChatRecord {
  t0: number;
  t1: number;
  toolCalls: string[];
  text: string;
  finishMeta?: Record<string, unknown>;
  /** A browse_agent subagent request (body agentMode "browse"), not the main chat. */
  nested?: boolean;
}

export interface TaskTranscript {
  status?: string;
  reason?: string;
  steps?: { operation: string; label: string; ok: boolean; via?: string; index?: number }[];
  cacheHits?: number;
}

export interface RunResult {
  scenario: string;
  policy: string;
  runIndex: number;
  startedAt: string;
  chatModel: string;
  wallMs: number;
  verdict: Verdict;
  finalText: string;
  chats: ChatRecord[];
  steps: StepRecord[];
  backendSteps: BackendStepLog[];
  /** ms spent executing client tools between chat requests, by tool name. */
  toolTimeMs: Record<string, number>;
  taskGoals: string[];
  transcripts: TaskTranscript[];
  /** End-state read (livegoal with BENCH_LIVE_END_URL); files live in <outDir>/<policy>-<scenario>-<n>/. */
  endState?: EndState;
  judge?: JudgeResult;
  harnessError?: string;
}

interface SseChunk {
  type: string;
  toolName?: string;
  input?: { goal?: string };
  delta?: string;
  messageMetadata?: Record<string, unknown>;
}

function parseSse(body: string): SseChunk[] {
  const out: SseChunk[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload) as SseChunk);
    } catch {
      // partial line
    }
  }
  return out;
}

/** browse_task outputs as the model saw them, from the last /api/chat body. */
function transcriptsFrom(body: string | null): TaskTranscript[] {
  if (!body) return [];
  const out: TaskTranscript[] = [];
  try {
    const parsed = JSON.parse(body) as { messages?: { parts?: { type?: string; state?: string; output?: unknown }[] }[] };
    for (const m of parsed.messages ?? []) {
      for (const p of m.parts ?? []) {
        if (p.type !== "tool-browse_task" || p.state !== "output-available") continue;
        let t = p.output;
        if (typeof t === "string") {
          try { t = JSON.parse(t); } catch { /* keep string */ }
        }
        if (t && typeof t === "object") out.push(t as TaskTranscript);
      }
    }
  } catch {
    // not JSON
  }
  return out;
}

function prompt(goal: string, style: PromptStyle): string {
  // "agent": the backend runs BROWSE_MODE=agent and its prompt already says
  // to delegate to browse_agent — the goal goes in as the user typed it.
  if (style === "free" || style === "agent") return goal;
  if (style === "manual") {
    return goal + " Do NOT call browse_task. Drive the browser yourself, step by step, with the other browse tools.";
  }
  return (
    goal +
    " Hand the WHOLE browsing job to a single browse_task call with the full goal (the Jev loop drives every step)." +
    " Only if it returns without finishing, continue from where it stopped with further browse_task calls or other browse tools."
  );
}

const CHAT_PLACEHOLDER = "Ask Sideform Agent…";

async function openChat(page: Page): Promise<void> {
  // Desktop v0.8 agent layout: the chat lives in the left /agent panel.
  await page.getByPlaceholder(CHAT_PLACEHOLDER).or(page.getByTestId("chat-list-new")).first().waitFor({ state: "visible", timeout: 90_000 });
  const create = page.getByTestId("create-chat-button");
  if (await create.isVisible().catch(() => false)) await create.click();
  else if (await page.getByTestId("chat-list-new").isVisible().catch(() => false)) await page.getByTestId("chat-list-new").click();
  await page.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForTurnEnd(page: Page, onTick: () => boolean): Promise<void> {
  const stop = page.locator('button[aria-label="Stop"]');
  const deadline = Date.now() + TURN_CAP_MS;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    // A step request in flight means a tool is still running even if the
    // Stop button blinked away between two tool-loop requests.
    // A Stop check that times out means the app is frozen, not that the turn ended:
    // withCap's rejection goes up as a harness error (it used to read as "not busy").
    const busy = (await withCap(stop.isVisible(), 10_000, "Stop button check (editor not responding)")) || onTick();
    if (busy) quietSince = null;
    else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= TURN_END_DEBOUNCE_MS) return;
    }
    await page.waitForTimeout(250);
  }
}

export interface RunOptions {
  scenario: Scenario;
  policy: string;
  runIndex: number;
  editorUrl: string;
  chatModel: string;
  promptStyle: PromptStyle;
  stack?: Stack;
  outDir: string;
}

export async function runOnce(opts: RunOptions): Promise<RunResult> {
  const running = await opts.scenario.start();
  const home = path.join(opts.outDir, "homes", `${opts.policy}-${opts.scenario.id}-${opts.runIndex}-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true });
  const electronPath = createRequire(path.join(DESKTOP_DIR, "package.json"))("electron") as unknown as string;
  const editorOrigin = new URL(opts.editorUrl).origin;

  const chats: ChatRecord[] = [];
  const steps: StepRecord[] = [];
  const pendingBodies: Promise<void>[] = [];
  let lastChatBody: string | null = null;
  let inflightSteps = 0;
  let t0 = 0;
  const rel = () => Date.now() - t0;

  let app: ElectronApplication | undefined;
  let recorder: Recorder | undefined;
  const result: RunResult = {
    scenario: opts.scenario.id,
    policy: opts.policy,
    runIndex: opts.runIndex,
    startedAt: new Date().toISOString(),
    chatModel: opts.chatModel,
    wallMs: 0,
    verdict: { success: false, score: 0, checks: {} },
    finalText: "",
    chats,
    steps,
    backendSteps: [],
    toolTimeMs: {},
    taskGoals: [],
    transcripts: [],
  };
  let wallStart = 0;
  const runDir = path.join(opts.outDir, `${opts.policy}-${opts.scenario.id}-${opts.runIndex + 1}`);

  try {
    app = await electron.launch({
      executablePath: electronPath,
      // Without this flag Playwright-launched Electron reports
      // navigator.webdriver = true (memory live-run-skroutz-cloudflare-wall).
      // --use-mock-keychain: the swapped HOME has no login Keychain, so the first
      // safeStorage call (the desktop saves a login when the agent submits a
      // password form) opened an invisible macOS auth prompt and blocked the main
      // process for good (wtb-0008, 24.10).
      args: ["--disable-blink-features=AutomationControlled", "--use-mock-keychain", DESKTOP_DIR],
      cwd: DESKTOP_DIR,
      // HOME alone does not move Electron's userData on macOS: without this the
      // run shares the real app's browser partition (cookies, cart, logins).
      env: { ...process.env, PEN_DESKTOP_URL: opts.editorUrl, HOME: home, USERPROFILE: home, PEN_DESKTOP_USER_DATA_DIR: path.join(home, "userData") },
    });
    const pages: Page[] = [...app.windows()];
    app.on("window", (p) => pages.push(p));
    const deadline = Date.now() + 60_000;
    let editor: Page | undefined;
    while (!editor && Date.now() < deadline) {
      editor = pages.find((p) => p.url().startsWith(`${editorOrigin}/agent`));
      if (!editor) await new Promise((r) => setTimeout(r, 250));
    }
    if (!editor) throw new Error(`no editor window at ${editorOrigin}`);
    if (process.env.BENCH_RECORD_DIR) recorder = startRecorder(app, process.env.BENCH_RECORD_DIR);
    // Diagnostic (BENCH_CONSOLE_LOG=<file>): the editor's console and page errors, with run time.
    if (process.env.BENCH_CONSOLE_LOG) {
      const file = process.env.BENCH_CONSOLE_LOG;
      const stamp = () => `${t0 ? ((Date.now() - t0) / 1000).toFixed(1) : "-"}s`;
      editor.on("console", (m) => fs.appendFileSync(file, `${stamp()} [${m.type()}] ${m.text()}\n`));
      editor.on("pageerror", (e) => fs.appendFileSync(file, `${stamp()} [pageerror] ${e.stack ?? e.message}\n`));
      editor.on("framenavigated", (f) => { if (f === editor!.mainFrame()) fs.appendFileSync(file, `${stamp()} [navigated] ${f.url()}\n`); });
    }
    // Diagnostic (BENCH_COOKIE_LOG=<file>): every 3 s, log cart-ish cookies of
    // the agent's browser partition when they change — tells a lost cart
    // cookie apart from a badge that rendered late.
    if (process.env.BENCH_COOKIE_LOG) {
      const logFile = process.env.BENCH_COOKIE_LOG;
      const electronApp = app!;
      const t0 = Date.now();
      let last = "";
      const timer = setInterval(async () => {
        try {
          const cur = await electronApp.evaluate(async ({ session, webContents }) => {
            const all = await session.fromPartition("persist:penbrowser").cookies.get({});
            const urls = webContents.getAllWebContents().map((w: any) => w.getURL()).filter((u: string) => /^https?:/.test(u) && !/localhost|127\.0\.0\.1/.test(u));
            return JSON.stringify({ cookies: all.filter((c: any) => /cart|basket/i.test(c.name)).map((c: any) => `${c.domain} ${c.name}=${c.value}`), urls });
          });
          if (cur !== last) {
            last = cur;
            fs.appendFileSync(logFile, `${((Date.now() - t0) / 1000).toFixed(1)}s ${cur}\n`);
          }
        } catch { /* app closing */ }
      }, 3000);
      electronApp.on("close", () => clearInterval(timer));
    }

    // Pin the chat model on every request — the per-chat picker and the
    // backend default both stay out of the measurement.
    await editor.route("**/api/chat", async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.continue();
      try {
        const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
        // A browse_agent subagent request keeps the backend's pinned model
        // (BROWSE_AGENT_MODEL) unless BENCH_AGENT_MODEL names one, e.g. the
        // OpenCode Go twin. It is never pinned to the main chat model.
        const nested = body.agentMode === "browse";
        const model = nested ? process.env.BENCH_AGENT_MODEL?.trim() : opts.chatModel;
        if (model) body.model = model;
        const postData = JSON.stringify(body);
        if (!nested) lastChatBody = postData;
        // Diagnostic (BENCH_DUMP_BODIES=<dir>): keep every request body for replay timing.
        if (process.env.BENCH_DUMP_BODIES) { fs.mkdirSync(process.env.BENCH_DUMP_BODIES, { recursive: true }); fs.writeFileSync(path.join(process.env.BENCH_DUMP_BODIES, `${Date.now()}-${nested ? "nested" : "main"}.json`), postData); }
        // OpenCode BYOK: the key goes as a header, never in the body (the body
        // is kept in lastChatBody / the run JSON). Without BENCH_OPENCODE_KEY
        // the backend answers 400 opencode_key_required — loud, not a fallback.
        const ocKey = process.env.BENCH_OPENCODE_KEY?.trim();
        if (ocKey && model && /^opencode(-go)?\//.test(model)) {
          return route.continue({ postData, headers: { ...req.headers(), "x-opencode-key": ocKey } });
        }
        return route.continue({ postData });
      } catch {
        return route.continue();
      }
    });

    const chatStart = new Map<Request, number>();
    const nestedChats = new Set<Request>();
    const stepStart = new Map<Request, { t0: number; body: Record<string, unknown> }>();
    editor.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/chat") && req.method() === "POST") {
        chatStart.set(req, rel());
        if ((req.postData() ?? "").includes('"agentMode":"browse"')) nestedChats.add(req);
      }
      else if (url.includes("/api/browse/step")) {
        inflightSteps++;
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(req.postData() ?? "{}"); } catch { /* keep empty */ }
        stepStart.set(req, { t0: rel(), body });
      }
    });
    const settleStep = (req: Request, status: number, json: Record<string, unknown> | null) => {
      const start = stepStart.get(req);
      if (!start) return;
      stepStart.delete(req);
      inflightSteps = Math.max(0, inflightSteps - 1);
      const t1 = rel();
      const b = start.body as { history?: unknown[]; elements?: unknown[]; pageText?: string; screenshot?: string };
      const j = (json ?? {}) as Partial<StepRecord> & { cascade?: boolean };
      if (status >= 400) {
        // Keep the rejected body: a 400 names only the first zod issue, the body shows which element.
        try {
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(path.join(runDir, `step-${status}-${Math.round(start.t0)}.json`), JSON.stringify({ error: (json as { error?: unknown } | null)?.error, body: { ...b, screenshot: b.screenshot ? `[${b.screenshot.length} chars]` : undefined } }, null, 2));
        } catch { /* best effort */ }
      }
      steps.push({
        t0: start.t0,
        t1,
        latencyMs: t1 - start.t0,
        status,
        error: status >= 400 ? String((json as { error?: unknown } | null)?.error ?? "") : undefined,
        historyLen: b.history?.length ?? 0,
        elements: b.elements?.length ?? 0,
        pageTextChars: b.pageText?.length ?? 0,
        screenshotChars: b.screenshot?.length ?? 0,
        outcome: j.outcome,
        operation: j.operation,
        index: j.index,
        confidence: j.confidence,
        cascade: j.cascade === true,
        cascadeNote: j.cascadeNote,
        textSource: j.textSource,
        timings: j.timings,
        reason: typeof j.reason === "string" ? j.reason.slice(0, 200) : undefined,
        url: (start.body as { url?: string }).url,
        chosen: typeof j.index === "number" ? (b.elements ?? []).find((e) => (e as { index?: number }).index === j.index) : undefined,
        elementList: (b.elements ?? []).map((e) => {
          const x = e as { index?: number; tag?: string; role?: string; label?: string; frame?: string; ops?: string[] };
          return `${x.index} ${x.tag}${x.role ? "/" + x.role : ""} ${JSON.stringify((x.label ?? "").slice(0, 50))}${x.frame ? " frame=" + x.frame : ""}`;
        }),
      } as StepRecord);
    };
    editor.on("requestfinished", (req) => {
      const url = req.url();
      if (url.includes("/api/browse/step")) {
        pendingBodies.push(
          (async () => {
            const res = await req.response();
            let json: Record<string, unknown> | null = null;
            try { json = (await res?.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
            settleStep(req, res?.status() ?? 0, json);
          })(),
        );
      } else if (url.includes("/api/chat") && chatStart.has(req)) {
        const start = chatStart.get(req)!;
        chatStart.delete(req);
        const t1 = rel();
        pendingBodies.push(
          (async () => {
            const body = (await (await req.response())?.text().catch(() => "")) ?? "";
            const chunks = parseSse(body);
            const toolCalls: string[] = [];
            let text = "";
            let finishMeta: Record<string, unknown> | undefined;
            for (const c of chunks) {
              if (c.type === "tool-input-available" && c.toolName) {
                toolCalls.push(c.toolName);
                if (c.toolName === "browse_task" && typeof c.input?.goal === "string") {
                  result.taskGoals.push(c.input.goal.slice(0, 400));
                  // Full goal, live (the run JSON is written only at the end).
                  fs.appendFileSync(path.join(opts.outDir, "task-goals.txt"), c.input.goal + "\n----\n");
                }
              }
              if (c.type === "text-delta" && typeof c.delta === "string") text += c.delta;
              if (c.type === "finish" && c.messageMetadata) finishMeta = c.messageMetadata;
            }
            chats.push({ t0: start, t1, toolCalls, text, finishMeta, ...(nestedChats.has(req) ? { nested: true } : {}) });
          })(),
        );
      }
    });
    editor.on("requestfailed", (req) => {
      if (req.url().includes("/api/browse/step")) settleStep(req, 0, null);
    });

    await openChat(editor);
    const textarea = editor.getByPlaceholder(CHAT_PLACEHOLDER);
    await textarea.click();
    await textarea.fill(prompt(running.goal, opts.promptStyle));
    t0 = Date.now();
    wallStart = t0;
    await textarea.press("Enter");
    await editor.waitForTimeout(1_000);
    await waitForTurnEnd(editor, () => inflightSteps > 0);
    await withCap(Promise.allSettled(pendingBodies), BODIES_CAP_MS, "chat response bodies").catch(() => {});
    // Demo recordings: keep the final answer on screen for a while.
    const hold = Number(process.env.BENCH_HOLD_MS ?? 0);
    if (hold > 0) await editor.waitForTimeout(hold);
    // End state: read before the app closes, from the agent's own partition.
    if (running.endUrl && running.endCheck) {
      // The agent's CURRENT tab (the desktop tracks it), not the last-created
      // one: on eBay the agent ended on an item page opened earlier than a
      // stale search tab, and the oracle judged the search tab.
      const currentUrl = await withCap(
        editor.evaluate(async () => {
          const browser = (window as unknown as { penDesktop?: { browser?: { tabs?: (a: { action: string }) => Promise<unknown> } } }).penDesktop?.browser;
          const res = (await browser?.tabs?.({ action: "list" })) as { tabs?: Array<{ url?: string; current?: boolean }> } | undefined;
          return res?.tabs?.find((t) => t.current)?.url;
        }),
        10_000,
        "current tab lookup",
      ).catch(() => undefined);
      result.endState = await withCap(readEndState(app, running.endUrl, runDir, currentUrl), END_STATE_CAP_MS, "end-state read");
    }
  } catch (err) {
    result.harnessError = err instanceof Error ? err.message : String(err);
  } finally {
    if (recorder) console.log("recorded", await recorder.stop());
    if (app) {
      const proc = app.process();
      await withCap(app.close(), CLOSE_CAP_MS, "app close").catch(() => proc.kill("SIGKILL"));
    }
  }

  chats.sort((a, b) => a.t0 - b.t0);
  steps.sort((a, b) => a.t0 - b.t0);
  // Wall = send → last chat response done (the debounce tail is not the agent's time).
  result.wallMs = chats.length ? Math.max(...chats.map((c) => c.t1)) : wallStart ? Date.now() - wallStart : 0;
  for (let i = 0; i < chats.length - 1; i++) {
    const gap = chats[i + 1].t0 - chats[i].t1;
    const tools = chats[i].toolCalls.length ? chats[i].toolCalls : ["(none)"];
    // Tools of one response run in parallel; attribute the gap to the slowest
    // kind — browse_task when present.
    const key = tools.includes("browse_task") ? "browse_task" : tools.join("+");
    result.toolTimeMs[key] = (result.toolTimeMs[key] ?? 0) + Math.max(0, gap);
  }
  const lastWithText = [...chats].reverse().find((c) => !c.nested && c.text.trim());
  result.finalText = lastWithText?.text ?? "";
  result.transcripts = transcriptsFrom(lastChatBody);
  if (opts.stack && wallStart) result.backendSteps = opts.stack.stepLogs(wallStart - 1_000, wallStart + result.wallMs + 5_000);
  result.verdict = running.verify({ finalText: result.finalText });
  if (result.endState && running.endUrl && running.endCheck) {
    const endTxt = path.join(runDir, "end-state.txt");
    if (fs.existsSync(endTxt)) {
      const input = {
        goal: running.goal,
        check: running.endCheck,
        endUrl: result.endState.finalUrl ?? running.endUrl,
        endState: fs.readFileSync(endTxt, "utf8"),
        finalReply: result.finalText,
        ...(running.endReplyIsAnswer ? { replyIsAnswer: true } : {}),
      };
      result.judge = await runJudge(input, runDir);
      fs.writeFileSync(path.join(runDir, "judge-input.json"), JSON.stringify(input, null, 2));
      fs.writeFileSync(path.join(runDir, "judge.json"), JSON.stringify(result.judge, null, 2));
    } else {
      result.judge = {
        verdict: "unknown", requirements: [], extras: [], duplicates: [], end_state_total: null, reply_total: null,
        reply_matches_end_state: false, notes: "end state not captured", error: result.endState.error,
      };
    }
    result.verdict.checks.judgeComplete = result.judge.verdict === "complete";
    const vals = Object.values(result.verdict.checks);
    result.verdict.success = vals.every(Boolean);
    result.verdict.score = vals.filter(Boolean).length / vals.length;
  }
  await running.close();
  // Each run gets a fresh Electron profile (hundreds of MB). 13.10 ~200 runs
  // filled the disk and killed three parallel benches with ENOSPC. Results
  // live in run-*.json and the run's own folder, not here. BENCH_KEEP_HOMES=1 keeps it.
  if (process.env.BENCH_KEEP_HOMES !== "1") fs.rmSync(home, { recursive: true, force: true });
  return result;
}
