// Before/after verdict for two bench runs: did a change make browse_task
// better or worse? Reads summary.json of both dirs.
// CLI: npm run compare -- results/<before> results/<after>
//
// Three questions, one row each per scenario:
//   goal   — success rate and "by browse_task alone" (the step loop, not the chat model)
//   click  — steps per run, repeats, no-effect clicks, retries (wasted steps)
//   speed  — step latency p50 (decision model) and time inside browse_task
// Thresholds are set above the run-to-run noise measured on fixtures with 3 runs.

import fs from "node:fs";
import path from "node:path";

type Row = Record<string, number | null | string> & { scenario: string; runs: number };

const load = (dir: string): Row[] => JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));

// metric, label, direction (+1 = higher is better), relative threshold, absolute threshold
const METRICS: [string, string, 1 | -1, number, number][] = [
  ["successRate", "success", 1, 0, 0.2],
  ["jevOnlyRate", "alone", 1, 0, 0.2],
  ["decisionsMean", "steps", -1, 0.2, 2],
  ["repeatsMean", "repeats", -1, 0.3, 1],
  ["noEffectMean", "no-effect", -1, 0.3, 1],
  ["retryRate", "retry", -1, 0, 0.05],
  ["textLlmRate", "textLLM", -1, 0, 0.1],
  ["stepLatencyP50", "step ms", -1, 0.12, 60],
  ["browseTaskP50", "task ms", -1, 0.2, 3000],
];

function judge(before: number | null, after: number | null, dir: 1 | -1, rel: number, abs: number): string {
  if (before == null || after == null) return "";
  const delta = after - before;
  const limit = Math.max(abs, Math.abs(before) * rel);
  if (Math.abs(delta) < limit) return "";
  return delta * dir > 0 ? "▲" : "▼";
}

const fmt = (v: number | null, key: string) =>
  v == null ? "—" : key.endsWith("Rate") ? `${Math.round(v * 100)}%` : key.endsWith("P50") ? `${Math.round(v)}` : v.toFixed(1);

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error("usage: npm run compare -- results/<before> results/<after>");
  process.exit(2);
}
const before = new Map(load(beforeDir).map((r) => [r.scenario, r]));
const after = load(afterDir);
let worse = 0;
let better = 0;
console.log(`before: ${beforeDir}\nafter:  ${afterDir}\n▲ better, ▼ worse (beyond noise)\n`);
console.log(["scenario", "runs", ...METRICS.map((m) => m[1])].join(" | "));
for (const a of after) {
  const b = before.get(a.scenario);
  if (!b) continue;
  const cells = METRICS.map(([key, , dir, rel, abs]) => {
    const bv = b[key] as number | null;
    const av = a[key] as number | null;
    const mark = judge(bv, av, dir, rel, abs);
    if (a.scenario !== "ALL" && mark === "▼") worse++;
    if (a.scenario !== "ALL" && mark === "▲") better++;
    return `${fmt(bv, key)}→${fmt(av, key)}${mark}`;
  });
  console.log([a.scenario, `${b.runs}/${a.runs}`, ...cells].join(" | "));
}
console.log(`\nverdict: ${worse ? `WORSE (${worse} ▼)` : better ? `BETTER (${better} ▲)` : "NO CHANGE beyond noise"}${worse && better ? `, also ${better} ▲` : ""}`);
process.exit(worse ? 1 : 0);
