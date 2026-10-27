// WebTestBench report. usage: npm run wtb:report -- results/<dir> [results/<dir2> ...]
//
// Oracle runs (wtb-*) are re-scored from the saved final reply, so a scoring fix needs no
// rerun. Metrics are per-app P/R/F1 averaged over apps (macro), like the paper's Table 11;
// failure is the positive class. Pooled (micro) counts are printed too.
// Every dir also gets wtb-official/<track>/<record>/result_extracted.md: the layout the
// official scorers read (eval/scoring_oracle.py for oracle, eval/scoring.py for e2e, which
// needs its LLM matcher).

import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "./runOnce.ts";
import { CLASSES, PAPER_E2E, PAPER_ORACLE, officialText, parsePredictions, prf, scoreOracle, type ItemClass, type Prf } from "./wtb.ts";
import { WTB_RECORDS } from "./wtbSuite.ts";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: npm run wtb:report -- results/<dir> [results/<dir2>]");
  process.exit(2);
}

const pct = (v: number) => `${(v * 100).toFixed(1)}`;
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const recordOf = (scenario: string) => `WebTestBench_${scenario.slice(-4)}`;

const lines: string[] = [];
const out = (s = "") => lines.push(s);

for (const dir of dirs) {
  const runs = fs
    .readdirSync(dir)
    .filter((f) => /^run-.*-wtbe?-\d{4}-\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunResult);
  const oracle = runs.filter((r) => r.scenario.startsWith("wtb-"));
  const e2e = runs.filter((r) => r.scenario.startsWith("wtbe-"));
  let label = path.basename(path.resolve(dir));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as { prompt?: string; "chat-model"?: string };
    label = `${label} (${cfg["chat-model"] ?? "?"}, --prompt ${cfg.prompt ?? "?"})`;
  } catch { /* no config */ }
  out(`## ${label}`);
  out();

  for (const r of runs) {
    const track = r.scenario.startsWith("wtbe-") ? "e2e" : "oracle";
    const d = path.join(dir, "wtb-official", track, `${recordOf(r.scenario)}${r.runIndex ? `-run${r.runIndex + 1}` : ""}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "result_extracted.md"), officialText(r.finalText));
  }

  if (oracle.length) {
    const perApp: Prf[] = [];
    const perClass = new Map<ItemClass, Prf[]>();
    const pooled = [0, 0, 0, 0];
    let items = 0;
    let missing = 0;
    let blocked = 0;
    let blockedDefects = 0;
    let harness = 0;
    for (const r of oracle) {
      const rec = WTB_RECORDS.get(recordOf(r.scenario));
      if (!rec) continue;
      if (r.harnessError) harness++;
      const s = scoreOracle(rec, r.finalText);
      perApp.push(s.overall);
      for (const c of CLASSES) if (s.byClass[c]) perClass.set(c, [...(perClass.get(c) ?? []), s.byClass[c]!]);
      pooled[0] += s.overall.tp; pooled[1] += s.overall.fp; pooled[2] += s.overall.fn; pooled[3] += s.overall.tn;
      items += s.items.length;
      missing += s.missing.length;
      const gold = new Map(s.items.map((i) => [i.label.toUpperCase(), i.gold]));
      for (const p of parsePredictions(r.finalText).filter((x) => x.blocked)) {
        const g = gold.get(p.id.toUpperCase());
        if (g === undefined) continue;
        blocked++;
        if (!g) blockedDefects++;
      }
    }
    const macro = (v: Prf[]) => ({ p: mean(v.map((x) => x.precision)), r: mean(v.map((x) => x.recall)), f: mean(v.map((x) => x.f1)) });
    const m = macro(perApp);
    const micro = prf(pooled[0], pooled[1], pooled[2], pooled[3]);
    out(`### Oracle track (gold checklist given): ${perApp.length} app runs, ${items} items`);
    out();
    out(`| | Precision | Recall | F1 |`);
    out(`|---|---|---|---|`);
    out(`| **ours, macro** | **${pct(m.p)}** | **${pct(m.r)}** | **${pct(m.f)}** |`);
    out(`| ours, pooled | ${pct(micro.precision)} | ${pct(micro.recall)} | ${pct(micro.f1)} |`);
    for (const b of PAPER_ORACLE) out(`| paper: ${b.model} (100 apps) | ${b.precision} | ${b.recall} | ${b.f1} |`);
    out();
    out(`By item class (macro over apps that have the class): ` + CLASSES.map((c) => {
      const v = perClass.get(c);
      return v ? `${c} F1 ${pct(macro(v).f)}` : `${c} -`;
    }).join(", "));
    out();
    out(`Pooled counts: TP ${micro.tp}, FP ${micro.fp}, FN ${micro.fn}, TN ${micro.tn}. ` +
      `Items with no line in the reply: ${missing}/${items} (counted as "pass"). ` +
      `Blocked [?]: ${blocked}/${items} (counted as "pass"; ${blockedDefects} of them are gold defects). Harness errors: ${harness}. ` +
      `Wall p50 ${Math.round(median(oracle.map((r) => r.wallMs)) / 1000)} s.`);
    out();
    out(`| app | category | items | defects | P | R | F1 | missing | wall |`);
    out(`|---|---|---|---|---|---|---|---|---|`);
    for (const r of [...oracle].sort((a, b) => a.scenario.localeCompare(b.scenario))) {
      const rec = WTB_RECORDS.get(recordOf(r.scenario));
      if (!rec) continue;
      const s = scoreOracle(rec, r.finalText);
      out(`| ${r.scenario} #${r.runIndex + 1} | ${rec.category} | ${s.items.length} | ${rec.checklist.filter((i) => !i.pass).length} | ` +
        `${pct(s.overall.precision)} | ${pct(s.overall.recall)} | ${pct(s.overall.f1)} | ${s.missing.length} | ${Math.round(r.wallMs / 1000)} s${r.harnessError ? " ⚠" : ""} |`);
    }
    out();
  }

  if (e2e.length) {
    const preds = e2e.map((r) => parsePredictions(r.finalText));
    out(`### E2E track (own checklist): ${e2e.length} app runs`);
    out();
    out(`Not scored here: matching own items to gold items needs the official LLM matcher. ` +
      `Run eval/scoring.py from github.com/friedrichor/WebTestBench with --output_root ${path.join(dir, "wtb-official", "e2e")}.`);
    out(`Items per app: median ${median(preds.map((p) => p.length))}; reported failed: median ${median(preds.map((p) => p.filter((x) => !x.pass).length))}; ` +
      `wall p50 ${Math.round(median(e2e.map((r) => r.wallMs)) / 1000)} s.`);
    out(`Paper, best end-to-end F1: ` + PAPER_E2E.map((b) => `${b.model} ${b.f1}`).join(", ") + ".");
    out();
  }
}

const text = lines.join("\n");
console.log(text);
for (const dir of dirs) fs.writeFileSync(path.join(dir, "wtb-summary.md"), text);
