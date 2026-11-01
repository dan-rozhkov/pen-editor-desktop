// Online-Mind2Web report: our runs vs published Browser Use / Operator on the SAME sampled tasks.
// usage: npm run om2w:report -- results/<dir> [results/<dir2> ...]   (each dir = one column, e.g. task vs manual)

import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "./runOnce.ts";
import { judgeCallFailed } from "./judge.ts";
import { loadOm2wSample } from "./om2wSuite.ts";
import { scenarioId } from "./om2w.ts";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: npm run om2w:report -- results/<dir> [results/<dir2>]");
  process.exit(2);
}
const sample = loadOm2wSample();
if (!sample) {
  console.error("data/om2w/sample.json is missing. Run: HF_TOKEN=... npm run om2w:prepare");
  process.exit(2);
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};
const pct = (v: number | null) => (v == null ? "-" : `${Math.round(v * 100)}%`);
const sec = (ms: number | null) => (ms == null ? "-" : `${Math.round(ms / 1000)}s`);

interface Col {
  label: string;
  runs: Map<string, RunResult[]>;
}
const cols: Col[] = dirs.map((dir) => {
  let label = path.basename(path.resolve(dir));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as { prompt?: string };
    if (cfg.prompt) label = `${cfg.prompt}:${label}`;
  } catch { /* no config */ }
  const runs = new Map<string, RunResult[]>();
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("run-") && x.endsWith(".json"))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunResult;
    if (!r.scenario?.startsWith("om2w-")) continue;
    (runs.get(r.scenario) ?? runs.set(r.scenario, []).get(r.scenario)!).push(r);
  }
  return { label, runs };
});

// A run counts as success only on judge "complete"; a harness error or missing judge is a failure.
// A run whose judge CALL failed has no verdict: it is left out of the rate (shown as "J").
const ok = (r: RunResult) => r.judge?.verdict === "complete";
const noVerdict = (r: RunResult) => !!r.judgeError || judgeCallFailed(r.judge);
const rate = (rs: RunResult[] | undefined) => {
  const judged = rs?.filter((r) => !noVerdict(r)) ?? [];
  return judged.length ? judged.filter(ok).length / judged.length : null;
};

console.log("Online-Mind2Web subset report");
console.log("NOTE: our judge is NOT the official WebJudge (different judge model and inputs), so numbers are indicative.");
console.log("Browser Use / Operator = published final_eval from the official WebJudge.\n");

const header = ["task", "level", ...cols.map((c) => c.label), "BrowserUse", "Operator", "website"];
console.log(header.join(" | "));

type Agg = { n: number; ours: number[][]; bu: number; op: number; buN: number; opN: number };
const mk = (): Agg => ({ n: 0, ours: cols.map(() => []), bu: 0, op: 0, buN: 0, opN: 0 });
const byLevel = new Map<string, Agg>();
const overall = mk();
const walls = cols.map(() => [] as number[]);

for (const t of sample.tasks) {
  const id = scenarioId(t.task_id);
  const cells = cols.map((c) => {
    const rs = c.runs.get(id);
    if (!rs?.length) return "-";
    const judged = rs.filter((r) => !noVerdict(r));
    return `${judged.filter(ok).length}/${judged.length} (${rs.map((r) => (noVerdict(r) ? "J" : ok(r) ? "Y" : (r.judge?.verdict ?? "err")[0])).join("")})`;
  });
  console.log([id, t.level, ...cells, t.browser_use ?? "-", t.operator ?? "-", t.website].join(" | "));
  const agg = byLevel.get(t.level) ?? byLevel.set(t.level, mk()).get(t.level)!;
  for (const a of [agg, overall]) {
    a.n++;
    if (t.browser_use != null) { a.buN++; a.bu += t.browser_use; }
    if (t.operator != null) { a.opN++; a.op += t.operator; }
  }
  cols.forEach((c, i) => {
    const rs = c.runs.get(id);
    if (!rs?.length) return;
    const r = rate(rs);
    // per-task mean success over runs, so every covered task weighs the same; a task with no
    // verdict at all (every judge call failed) is not covered
    if (r !== null) {
      agg.ours[i].push(r);
      overall.ours[i].push(r);
    }
    walls[i].push(...rs.map((r) => r.wallMs));
  });
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
console.log("\nTotals on the same sampled tasks (ours: only tasks with at least one run; BU/Operator: all sampled tasks)");
console.log(["level", "tasks", ...cols.map((c) => `${c.label} (covered)`), "BrowserUse", "Operator"].join(" | "));
const row = (name: string, a: Agg) =>
  console.log([name, a.n, ...a.ours.map((v) => `${pct(mean(v))} (${v.length})`), pct(a.buN ? a.bu / a.buN : null), pct(a.opN ? a.op / a.opN : null)].join(" | "));
for (const lv of ["easy", "medium", "hard"]) if (byLevel.has(lv)) row(lv, byLevel.get(lv)!);
for (const [lv, a] of byLevel) if (!["easy", "medium", "hard"].includes(lv)) row(lv, a);
row("ALL", overall);
console.log("\nWall time per run, p50: " + cols.map((c, i) => `${c.label} ${sec(median(walls[i]))}`).join(", "));
const noVerdictRuns = cols.map((c) => [...c.runs.values()].flat().filter(noVerdict).length);
if (noVerdictRuns.some(Boolean)) console.log("\nWARNING: runs with no verdict (judge call failed, left out above): " + cols.map((c, i) => `${c.label} ${noVerdictRuns[i]}`).join(", ") + ". Re-judge with npm run judge -- --dir <run dir>.");
