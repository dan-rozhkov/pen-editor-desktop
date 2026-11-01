// Browser Use Cloud arm for the OM2W sample: same goal text and same judge as our arms.
//   npm run bu -- --out results/om2w-bu-1 [--model bu-ultrafast] [--concurrency 5] [--limit N] [--only <id8>,...]
// Key: env BROWSER_USE_API_KEY, else the file .env.bu next to package.json.
// End state: after the run, we connect over CDP to the run's own cloud browser (kept alive
// with keepAlive) and read the active page's innerText, exactly what our judge reads
// from the agent tab in our arms. Wall time = POST /runs → terminal status, measured here.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { judgeCallFailed, runJudge, type JudgeResult } from "./judge.ts";
import { loadOm2wSample, om2wGoal } from "./om2wSuite.ts";
import { scenarioId, type Om2wTask } from "./om2w.ts";
import { END_TEXT_CAP } from "./endState.ts";

const API = "https://api.browser-use.com/api/v4";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "bu-ultrafast" },
    concurrency: { type: "string", default: "5" },
    limit: { type: "string" },
    only: { type: "string" },
    "run-timeout": { type: "string", default: "600" },
  },
});
if (!a.out) {
  console.error("usage: npm run bu -- --out results/<dir> [--model bu-ultrafast] [--concurrency 5] [--limit N] [--only id8,...]");
  process.exit(1);
}

function apiKey(): string {
  if (process.env.BROWSER_USE_API_KEY) return process.env.BROWSER_USE_API_KEY;
  const f = path.join(ROOT, ".env.bu");
  const m = fs.existsSync(f) ? /BROWSER_USE_API_KEY=(\S+)/.exec(fs.readFileSync(f, "utf8")) : null;
  if (!m) throw new Error("BROWSER_USE_API_KEY not set and .env.bu missing");
  return m[1];
}
const KEY = apiKey();

async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, {
      method,
      headers: { "X-Browser-Use-API-Key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => e as Error);
    if (res instanceof Error || res.status === 429 || res.status >= 500) {
      if (attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${method} ${p}: ${res instanceof Error ? res.message : res.status + " " + (await res.text()).slice(0, 300)}`);
    }
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunSummary {
  id: string; status: string; result: string | null; error: string | null; sessionId: string;
  totalInputTokens: number; totalOutputTokens: number; totalCostUsd: string; createdAt: string; updatedAt: string;
}
interface BrowserItem { id: string; status: string; cdpUrl: string | null; agentSessionId: string | null }

export interface BuRunResult {
  scenario: string; taskId: string; level: string; model: string; runId?: string; sessionId?: string;
  status: string; wallMs: number; serverMs?: number; costUsd?: number; cost?: unknown;
  tokensIn?: number; tokensOut?: number; reply: string; finalUrl?: string; endTextChars: number;
  endStateError?: string; error?: string; judge?: JudgeResult; success: boolean;
  /** Judge call failed: no verdict; the run is left out of the success rate (re-judge with npm run judge). */
  judgeError?: string;
}

async function readEndState(sessionId: string, dir: string): Promise<{ finalUrl?: string; text: string; error?: string; browserId?: string }> {
  let item: BrowserItem | undefined;
  for (let i = 0; i < 5 && !item?.cdpUrl; i++) {
    const list = await api<{ items: BrowserItem[] }>("GET", `/browsers?agentSessionId=${sessionId}&pageSize=5`);
    item = list.items.find((b) => b.status === "active") ?? list.items[0];
    if (!item?.cdpUrl) await sleep(1000);
  }
  if (!item?.cdpUrl) return { text: "", error: `no live cloud browser (status ${item?.status ?? "none"})`, browserId: item?.id };
  const browser = await chromium.connectOverCDP(item.cdpUrl, { timeout: 30_000 });
  try {
    const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => /^https?:/.test(p.url()));
    // The agent's current tab: the one that has focus, else the last one opened.
    let page = pages.at(-1);
    for (const p of pages) {
      if (await p.evaluate(() => document.visibilityState === "visible" && document.hasFocus()).catch(() => false)) page = p;
    }
    if (!page) return { text: "", error: "no http(s) page in the cloud browser", browserId: item.id };
    const text = String(await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "")).slice(0, END_TEXT_CAP);
    fs.writeFileSync(path.join(dir, "end-state.txt"), text);
    await page.screenshot({ path: path.join(dir, "end-state.png"), timeout: 15_000 }).catch(() => {});
    return { finalUrl: page.url(), text, browserId: item.id };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runTask(t: Om2wTask, outDir: string): Promise<BuRunResult> {
  const scenario = scenarioId(t.task_id);
  const dir = path.join(outDir, `bu-${scenario}-1`);
  fs.mkdirSync(dir, { recursive: true });
  const { goal, endCheck } = om2wGoal(t);
  const base: BuRunResult = { scenario, taskId: t.task_id, level: String(t.level), model: a.model!, status: "error", wallMs: 0, reply: "", endTextChars: 0, success: false };
  const t0 = Date.now();
  let runId: string | undefined;
  try {
    const created = await api<{ id: string; sessionId: string }>("POST", "/runs", { task: goal, model: a.model, keepAlive: 180, maxCostUsd: 1 });
    runId = created.id;
    base.runId = created.id;
    base.sessionId = created.sessionId;
    const deadline = t0 + Number(a["run-timeout"]) * 1000;
    let status = "queued";
    while (!["completed", "failed", "cancelled"].includes(status)) {
      if (Date.now() > deadline) {
        await api("POST", `/runs/${runId}/cancel`).catch(() => {});
        status = "timeout";
        break;
      }
      await sleep(500);
      status = (await api<{ status: string }>("GET", `/runs/${runId}/status`)).status;
    }
    base.wallMs = Date.now() - t0;
    base.status = status;
    const run = await api<RunSummary>("GET", `/runs/${runId}`);
    base.reply = run.result ?? run.error ?? "";
    base.serverMs = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
    base.tokensIn = run.totalInputTokens;
    base.tokensOut = run.totalOutputTokens;
    if (run.error) base.error = run.error;

    const end = await readEndState(created.sessionId, dir).catch((e) => ({ text: "", error: String(e instanceof Error ? e.message : e), finalUrl: undefined, browserId: undefined }));
    base.finalUrl = end.finalUrl;
    base.endTextChars = end.text.length;
    if (end.error) base.endStateError = end.error;
    if (end.browserId) await api("PATCH", `/browsers/${end.browserId}`, { action: "stop" }).catch(() => {});

    const cost = await api<{ totalCostUsd: string }>("GET", `/sessions/${created.sessionId}/cost`).catch(() => undefined);
    base.cost = cost;
    base.costUsd = cost ? Number(cost.totalCostUsd) : Number(run.totalCostUsd);

    const input = { goal, check: endCheck, endUrl: "agent-tab", endState: end.text, finalReply: base.reply };
    fs.writeFileSync(path.join(dir, "judge-input.json"), JSON.stringify({ ...input, endState: undefined }, null, 2));
    if (!fs.existsSync(path.join(dir, "end-state.txt"))) fs.writeFileSync(path.join(dir, "end-state.txt"), "");
    base.judge = await runJudge(input, dir);
    fs.writeFileSync(path.join(dir, "judge.json"), JSON.stringify(base.judge, null, 2));
    base.success = base.judge.verdict === "complete";
    if (judgeCallFailed(base.judge)) base.judgeError = base.judge.error || "judge call failed";
  } catch (e) {
    base.wallMs ||= Date.now() - t0;
    base.error = e instanceof Error ? e.message : String(e);
    if (runId) await api("POST", `/runs/${runId}/cancel`).catch(() => {});
  }
  fs.writeFileSync(path.join(outDir, `run-bu-${scenario}-1.json`), JSON.stringify(base, null, 2));
  return base;
}

const p50 = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

const sample = loadOm2wSample();
if (!sample) throw new Error("no data/om2w/sample.json: run npm run om2w:prepare first");
let tasks = sample.tasks;
if (a.only) {
  const ids = a.only.split(",").map((s) => s.trim());
  tasks = tasks.filter((t) => ids.some((id) => t.task_id.startsWith(id)));
}
if (a.limit) tasks = tasks.slice(0, Number(a.limit));
const outDir = path.resolve(ROOT, a.out);
fs.mkdirSync(outDir, { recursive: true });

const results: BuRunResult[] = [];
const queue = [...tasks];
await Promise.all(
  Array.from({ length: Math.max(1, Number(a.concurrency)) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const r = await runTask(t, outDir);
      results.push(r);
      console.log(`${r.scenario} [${r.level}] ${r.judgeError ? "JUDGE-ERROR" : r.judge?.verdict ?? "error"}  ${(r.wallMs / 1000).toFixed(1)} s  $${r.costUsd?.toFixed(4) ?? "?"}  ${r.error ?? r.endStateError ?? ""}`);
    }
  }),
);

// Runs without a verdict (judge call failed) are not failures: left out of every success rate.
const judged = results.filter((r) => !r.judgeError);
const lines = [`# Browser Use Cloud (${a.model}) on OM2W, ${new Date().toISOString()}`, "", "| level | success | n |", "|---|---|---|"];
for (const lv of ["easy", "medium", "hard"]) {
  const rs = judged.filter((r) => r.level === lv);
  if (rs.length) lines.push(`| ${lv} | ${Math.round((100 * rs.filter((r) => r.success).length) / rs.length)}% | ${rs.length} |`);
}
const ok = judged.filter((r) => r.success).length;
const costs = results.map((r) => r.costUsd).filter((c): c is number => Number.isFinite(c));
lines.push(
  `| ALL | ${judged.length ? Math.round((100 * ok) / judged.length) : 0}% | ${judged.length} |`,
  "",
  `Wall p50 ${(p50(results.map((r) => r.wallMs)) / 1000).toFixed(1)} s (POST → terminal, incl. queue); server p50 ${(p50(results.map((r) => r.serverMs ?? NaN).filter(Number.isFinite)) / 1000).toFixed(1)} s.`,
  `Cost: total $${costs.reduce((s, c) => s + c, 0).toFixed(4)}, per task mean $${(costs.reduce((s, c) => s + c, 0) / Math.max(1, costs.length)).toFixed(4)}, p50 $${p50(costs).toFixed(4)}.`,
  `Errors: ${results.filter((r) => r.error).length}; end-state errors: ${results.filter((r) => r.endStateError).length}; judge errors (left out of success): ${results.length - judged.length}.`,
);
fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n"));
if (judged.length < results.length) console.warn(`\nWARNING: ${results.length - judged.length} run(s) have no verdict (judge call failed). Re-judge: npm run judge -- --dir ${a.out}/bu-<scenario>-1`);
