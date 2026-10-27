// Aggregates run JSONs into summary.md / summary.json.
// CLI: npm run report -- results/<stamp>   (re-summarize an existing run dir)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunResult } from "./runOnce.ts";
import { SCENARIOS } from "./scenarios.ts";

const TERMINAL = new Set(["DONE", "BLOCKED"]);
const READ_ONLY_BROWSE = new Set(["browse_read", "browse_snapshot", "browse_screenshot", "browse_find_images", "browse_tabs"]);

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const p50 = (v: number[]) => quantile(v, 0.5);
const p90 = (v: number[]) => quantile(v, 0.9);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const mean = (v: number[]) => (v.length ? sum(v) / v.length : null);

/** Per-run derived numbers — everything the tables need. */
export function runStats(r: RunResult) {
  const decisions = r.steps.filter((s) => s.status === 200);
  const cascadeTried = decisions.filter((s) => s.timings?.cascadeMs !== undefined);
  const cascadeUsed = decisions.filter((s) => s.cascade);
  const textLlm = decisions.filter((s) => s.timings?.textMs !== undefined);
  let repeats = 0;
  for (let i = 1; i < decisions.length; i++) {
    const a = decisions[i - 1];
    const b = decisions[i];
    if (b.outcome === "act" && a.outcome === "act" && a.operation === b.operation && a.index === b.index && b.operation !== "WAIT") repeats++;
  }
  const transcriptSteps = r.transcripts.flatMap((t) => t.steps ?? []);
  const toolCalls = r.chats.flatMap((c) => c.toolCalls);
  // Browse tools that change the page — the main model driving by hand.
  const manualActs = toolCalls.filter((t) => t.startsWith("browse_") && !READ_ONLY_BROWSE.has(t) && t !== "browse_task").length;
  const demotions = r.backendSteps.filter((l) => {
    const op = l.diag?.gates?.find((g) => g.head === "op");
    return !!op?.jevPick && TERMINAL.has(op.jevPick) && !!l.operation && !TERMINAL.has(l.operation);
  }).length;
  const tiers: Record<string, number> = {};
  for (const l of r.backendSteps) {
    const t = l.diag?.tier ?? "?";
    tiers[t] = (tiers[t] ?? 0) + 1;
  }
  return {
    success: r.verdict.success,
    /** Solved with no page-changing browse tool besides browse_task. */
    jevOnly: r.verdict.success && manualActs === 0,
    manualActs,
    score: r.verdict.score,
    wallMs: r.wallMs,
    browseTaskMs: r.toolTimeMs.browse_task ?? 0,
    modelMs: sum(r.chats.map((c) => c.t1 - c.t0)),
    chatRequests: r.chats.length,
    browseTaskCalls: toolCalls.filter((t) => t === "browse_task").length,
    otherBrowseCalls: toolCalls.filter((t) => t.startsWith("browse_") && t !== "browse_task").length,
    statuses: r.transcripts.map((t) => t.status ?? "?"),
    decisions: decisions.length,
    httpErrors: r.steps.length - decisions.length,
    retries: decisions.filter((s) => s.outcome === "retry").length,
    stepLatency: r.steps.map((s) => s.latencyMs),
    serverTotal: decisions.flatMap((s) => (s.timings ? [s.timings.totalMs] : [])),
    jevMs: decisions.flatMap((s) => (s.timings ? [s.timings.jevMs] : [])),
    textMs: textLlm.map((s) => s.timings!.textMs!),
    cascadeMs: cascadeTried.map((s) => s.timings!.cascadeMs!),
    cascadeTried: cascadeTried.length,
    cascadeUsed: cascadeUsed.length,
    cascadeNotes: cascadeTried.filter((s) => s.cascadeNote).map((s) => s.cascadeNote!),
    textLlm: textLlm.length,
    demotions,
    tiers,
    repeats,
    noEffect: transcriptSteps.filter((s) => !s.ok || /no effect/i.test(s.label)).length,
    cacheHits: sum(r.transcripts.map((t) => t.cacheHits ?? 0)),
    contextTokens: (r.chats.at(-1)?.finishMeta?.contextTokens as number | undefined) ?? null,
  };
}

type Stats = ReturnType<typeof runStats>;

/** One console line per finished run. */
export function runStatsLine(r: RunResult): string {
  const s = runStats(r);
  const failed = Object.entries(r.verdict.checks).filter(([, v]) => !v).map(([k]) => k);
  return [
    s.success ? "OK" : "FAIL",
    `score ${s.score.toFixed(2)}`,
    `${(s.wallMs / 1000).toFixed(1)}s`,
    `steps ${s.decisions}`,
    `manual ${s.manualActs}`,
    `cascade ${s.cascadeTried}/${s.cascadeUsed}`,
    `textLLM ${s.textLlm}`,
    `statuses [${s.statuses.join(",")}]`,
    r.judge ? `judge ${r.judge.verdict} ${r.judge.requirements.filter((x) => x.ok).length}/${r.judge.requirements.length} extras ${r.judge.extras.length} dups ${r.judge.duplicates.length}` : "",
    failed.length ? `failed: ${failed.join(",")}` : "",
    r.harnessError ? `HARNESS: ${r.harnessError}` : "",
  ].filter(Boolean).join("  ");
}

function aggregate(stats: Stats[]) {
  const decisions = sum(stats.map((s) => s.decisions));
  const rate = (n: number) => (decisions ? n / decisions : null);
  const statuses: Record<string, number> = {};
  for (const s of stats) for (const st of s.statuses) statuses[st] = (statuses[st] ?? 0) + 1;
  const tiers: Record<string, number> = {};
  for (const s of stats) for (const [k, v] of Object.entries(s.tiers)) tiers[k] = (tiers[k] ?? 0) + v;
  const notes: Record<string, number> = {};
  for (const s of stats) for (const n of s.cascadeNotes) {
    const key = n.replace(/\d+(\.\d+)?/g, "#").slice(0, 60);
    notes[key] = (notes[key] ?? 0) + 1;
  }
  return {
    runs: stats.length,
    successRate: mean(stats.map((s) => (s.success ? 1 : 0))),
    jevOnlyRate: mean(stats.map((s) => (s.jevOnly ? 1 : 0))),
    manualActsMean: mean(stats.map((s) => s.manualActs)),
    meanScore: mean(stats.map((s) => s.score)),
    wallP50: p50(stats.map((s) => s.wallMs)),
    wallP90: p90(stats.map((s) => s.wallMs)),
    browseTaskP50: p50(stats.map((s) => s.browseTaskMs)),
    modelP50: p50(stats.map((s) => s.modelMs)),
    chatRequestsMean: mean(stats.map((s) => s.chatRequests)),
    browseTaskCallsMean: mean(stats.map((s) => s.browseTaskCalls)),
    otherBrowseCallsMean: mean(stats.map((s) => s.otherBrowseCalls)),
    decisionsMean: mean(stats.map((s) => s.decisions)),
    decisions,
    stepLatencyP50: p50(stats.flatMap((s) => s.stepLatency)),
    stepLatencyP90: p90(stats.flatMap((s) => s.stepLatency)),
    serverP50: p50(stats.flatMap((s) => s.serverTotal)),
    jevP50: p50(stats.flatMap((s) => s.jevMs)),
    textP50: p50(stats.flatMap((s) => s.textMs)),
    cascadeP50: p50(stats.flatMap((s) => s.cascadeMs)),
    cascadeTriedRate: rate(sum(stats.map((s) => s.cascadeTried))),
    cascadeUsedRate: rate(sum(stats.map((s) => s.cascadeUsed))),
    textLlmRate: rate(sum(stats.map((s) => s.textLlm))),
    retryRate: rate(sum(stats.map((s) => s.retries))),
    demotionRate: rate(sum(stats.map((s) => s.demotions))),
    repeatsMean: mean(stats.map((s) => s.repeats)),
    noEffectMean: mean(stats.map((s) => s.noEffect)),
    httpErrors: sum(stats.map((s) => s.httpErrors)),
    cacheHits: sum(stats.map((s) => s.cacheHits)),
    statuses,
    tiers,
    cascadeNotes: notes,
  };
}

const sec = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const msf = (ms: number | null) => (ms === null ? "—" : `${Math.round(ms)} ms`);
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const num = (x: number | null, d = 1) => (x === null ? "—" : x.toFixed(d));
const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "—";

/** Judge columns; old runs without a judge render as dashes. */
function judgeCells(r: RunResult): string {
  const j = r.judge;
  if (!j) return "— | — | — | — | —";
  const ok = j.requirements.filter((x) => x.ok).length;
  return `${j.verdict}${j.error ? " (error)" : ""} | ${ok}/${j.requirements.length} | ${j.extras.length} | ${j.duplicates.length} | ${j.reply_matches_end_state ? "yes" : "no"}`;
}

export function summarize(results: RunResult[]) {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    for (const key of [`${r.policy}|${r.scenario}`, `${r.policy}|ALL`]) {
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
  }
  const rows = [...groups.entries()].map(([key, rs]) => {
    const [policy, scenario] = key.split("|");
    return { policy, scenario, ...aggregate(rs.map(runStats)) };
  });
  rows.sort((a, b) => a.policy.localeCompare(b.policy) || (a.scenario === "ALL" ? 1 : b.scenario === "ALL" ? -1 : a.scenario.localeCompare(b.scenario)));

  const minSteps = Object.fromEntries(SCENARIOS.map((s) => [s.id, s.minSteps]));
  const md: string[] = [];
  md.push(`# browse_task bench — ${new Date().toISOString().slice(0, 16)}`, "");
  md.push(`Chat model: ${[...new Set(results.map((r) => r.chatModel))].join(", ")}. Runs: ${results.length}.`, "");

  md.push("## Outcome and speed", "");
  md.push("| policy | scenario | runs | success | by browse_task alone | score | wall p50 / p90 | in browse_task p50 | in chat model p50 | chat reqs | browse_task calls | manual browse acts | task statuses |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    md.push(`| ${r.policy} | ${r.scenario} | ${r.runs} | ${pct(r.successRate)} | ${pct(r.jevOnlyRate)} | ${num(r.meanScore, 2)} | ${sec(r.wallP50)} / ${sec(r.wallP90)} | ${sec(r.browseTaskP50)} | ${sec(r.modelP50)} | ${num(r.chatRequestsMean)} | ${num(r.browseTaskCallsMean)} | ${num(r.manualActsMean)} | ${kv(r.statuses)} |`);
  }

  md.push("", "## Step loop (Jev)", "");
  md.push("| policy | scenario | steps/run (min) | step latency p50 / p90 | server p50 | Jev p50 | repeats/run | no-effect/run | retry | HTTP errors |");
  md.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const min = minSteps[r.scenario];
    md.push(`| ${r.policy} | ${r.scenario} | ${num(r.decisionsMean)}${min ? ` (${min})` : ""} | ${msf(r.stepLatencyP50)} / ${msf(r.stepLatencyP90)} | ${msf(r.serverP50)} | ${msf(r.jevP50)} | ${num(r.repeatsMean)} | ${num(r.noEffectMean)} | ${pct(r.retryRate)} | ${r.httpErrors} |`);
  }

  md.push("", "## Jev → LLM hand-offs", "");
  md.push("Share of step decisions. **cascade tried** — the legacy second opinion (BROWSE_CASCADE_MODEL) ran; **used** — its answer replaced Jev's. **text LLM** — TYPE_TEXT value written by the LLM. **demoted** — Jev picked DONE/BLOCKED below the terminal gate and the runner-up op ran instead (ultrafast, from backend log).", "");
  md.push("| policy | scenario | decisions | cascade tried | cascade used | cascade p50 | text LLM | text p50 | demoted | tiers (backend log) | cascade rejections |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    md.push(`| ${r.policy} | ${r.scenario} | ${r.decisions} | ${pct(r.cascadeTriedRate)} | ${pct(r.cascadeUsedRate)} | ${msf(r.cascadeP50)} | ${pct(r.textLlmRate)} | ${msf(r.textP50)} | ${pct(r.demotionRate)} | ${kv(r.tiers)} | ${kv(r.cascadeNotes)} |`);
  }

  md.push("", "## Runs", "");
  md.push("| policy | scenario | # | ok | score | wall | steps | cascade tried/used | text LLM | failed checks | judge | reqs ok/total | extras | duplicates | reply = end state | harness |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const s = runStats(r);
    const failed = Object.entries(r.verdict.checks).filter(([, v]) => !v).map(([k]) => k).join(", ");
    md.push(`| ${r.policy} | ${r.scenario} | ${r.runIndex + 1} | ${s.success ? "✅" : "❌"} | ${num(s.score, 2)} | ${sec(s.wallMs)} | ${s.decisions} | ${s.cascadeTried}/${s.cascadeUsed} | ${s.textLlm} | ${failed || "—"} | ${judgeCells(r)} | ${r.harnessError ?? ""} |`);
  }
  return { markdown: md.join("\n") + "\n", rows };
}

export function writeSummary(dir: string): string {
  const results = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunResult);
  const { markdown, rows } = summarize(results);
  fs.writeFileSync(path.join(dir, "summary.md"), markdown);
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(rows, null, 2));
  return markdown;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: npm run report -- <results dir>");
    process.exit(1);
  }
  console.log(writeSummary(path.resolve(dir)));
}
