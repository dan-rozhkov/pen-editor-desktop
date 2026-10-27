// WebVoyager report: our runs per sampled task, with per-site-group totals.
// usage: npm run wv:report -- results/<dir> [results/<dir2> ...]   (each dir = one column, e.g. task vs manual)

import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "./runOnce.ts";
import { loadWvSample } from "./webvoyagerSuite.ts";
import { SITE_GROUPS, scenarioId } from "./webvoyager.ts";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: npm run wv:report -- results/<dir> [results/<dir2>]");
  process.exit(2);
}
const sample = loadWvSample();
if (!sample) {
  console.error("data/webvoyager/sample.json is missing. Run: npm run wv:prepare");
  process.exit(2);
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
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
    if (!r.scenario?.startsWith("wv-")) continue;
    (runs.get(r.scenario) ?? runs.set(r.scenario, []).get(r.scenario)!).push(r);
  }
  return { label, runs };
});

// Success only on judge "complete"; a harness error or missing judge is a failure.
const ok = (r: RunResult) => r.judge?.verdict === "complete";
const rate = (rs: RunResult[]) => rs.filter(ok).length / rs.length;

console.log("WebVoyager subset report");
console.log(`Sample: ${sample.n} tasks, seed ${sample.seed}, prepared ${sample.today}; ${sample.perSite} per site.`);
console.log("NOTE: our judge is NOT the WebVoyager GPT-4V auto-evaluator (different judge model, text-only inputs, 2023 reference answers on a changed live web), so numbers are indicative.");
console.log("Published aggregates (self-reported, different task set and evaluator, not comparable per task): Browser Use 89.1% on 586 tasks");
console.log("  (https://browser-use.com/posts/sota-technical-report, 2024-12-15); an independent replication measured 60.2% (https://github.com/nottelabs/open-operator-evals).");
console.log("  No per-task Browser Use results keyed by WebVoyager id are public (browser-use/eval publishes code and data only), so there is no per-task BrowserUse column.\n");

console.log(["task", "site", "ref", ...cols.map((c) => c.label)].join(" | "));

type Agg = { n: number; ours: number[][] };
const mk = (): Agg => ({ n: 0, ours: cols.map(() => []) });
const bySite = new Map<string, Agg>();
const byGroup = new Map<string, Agg>();
const overall = mk();
const walls = cols.map(() => [] as number[]);

for (const t of sample.tasks) {
  const id = scenarioId(t);
  const cells = cols.map((c) => {
    const rs = c.runs.get(id);
    if (!rs?.length) return "-";
    return `${rs.filter(ok).length}/${rs.length} (${rs.map((r) => (ok(r) ? "Y" : r.judge?.verdict ?? "err")[0]).join("")})`;
  });
  console.log([id, t.web_name, t.ref_type, ...cells].join(" | "));
  const group = SITE_GROUPS[t.web_name] ?? "other";
  const aggs = [
    bySite.get(t.web_name) ?? bySite.set(t.web_name, mk()).get(t.web_name)!,
    byGroup.get(group) ?? byGroup.set(group, mk()).get(group)!,
    overall,
  ];
  for (const a of aggs) a.n++;
  cols.forEach((c, i) => {
    const rs = c.runs.get(id);
    if (!rs?.length) return;
    // per-task mean success over runs, so every covered task weighs the same
    for (const a of aggs) a.ours[i].push(rate(rs));
    walls[i].push(...rs.map((r) => r.wallMs));
  });
}

console.log("\nTotals (ours: only tasks with at least one run; covered count in brackets)");
const row = (name: string, a: Agg) => console.log([name, a.n, ...a.ours.map((v) => `${pct(mean(v))} (${v.length})`)].join(" | "));
console.log(["group", "tasks", ...cols.map((c) => c.label)].join(" | "));
for (const [g, a] of [...byGroup].sort((x, y) => x[0].localeCompare(y[0]))) row(g, a);
row("ALL", overall);
console.log("\nPer site");
console.log(["site", "tasks", ...cols.map((c) => c.label)].join(" | "));
for (const [s, a] of [...bySite].sort((x, y) => x[0].localeCompare(y[0]))) row(s, a);
console.log("\nWall time per run, p50: " + cols.map((c, i) => `${c.label} ${sec(median(walls[i]))}`).join(", "));
