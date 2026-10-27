// Re-run the judge on existing run dirs.
//   npm run judge -- --dir results/<run>
// <run> is either a bench dir (every <policy>-<scenario>-<n>/ subdir holding
// end-state.txt + judge-input.json is re-judged, then run-*.json and
// summary.md are refreshed) or a single such subdir. BENCH_JUDGE_MODEL picks the model.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runJudge, type JudgeInput, type JudgeResult } from "./judge.ts";
import { writeSummary } from "./report.ts";
import type { RunResult } from "./runOnce.ts";

const { values } = parseArgs({ options: { dir: { type: "string" } } });
if (!values.dir) {
  console.error("usage: npm run judge -- --dir results/<run>");
  process.exit(1);
}
const root = path.resolve(values.dir);
const isRunDir = (d: string) => fs.existsSync(path.join(d, "end-state.txt"));
const dirs = isRunDir(root)
  ? [root]
  : fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).filter(isRunDir);
if (!dirs.length) {
  console.error(`no run dir with end-state.txt under ${root}`);
  process.exit(1);
}

let benchDir: string | undefined;
for (const dir of dirs) {
  const inFile = path.join(dir, "judge-input.json");
  if (!fs.existsSync(inFile)) {
    console.error(`${dir}: no judge-input.json (goal/checklist/reply) — skipped`);
    continue;
  }
  const input = JSON.parse(fs.readFileSync(inFile, "utf8")) as JudgeInput;
  input.endState = fs.readFileSync(path.join(dir, "end-state.txt"), "utf8");
  const judge: JudgeResult = await runJudge(input, dir);
  fs.writeFileSync(path.join(dir, "judge.json"), JSON.stringify(judge, null, 2));
  const ok = judge.requirements.filter((r) => r.ok).length;
  console.log(`${path.basename(dir)}: ${judge.verdict}  reqs ${ok}/${judge.requirements.length}  extras ${judge.extras.length}  dups ${judge.duplicates.length}  reply=end ${judge.reply_matches_end_state}${judge.error ? "  ERROR " + judge.error : ""}`);
  // Refresh the sibling run JSON, if this dir came from a bench run.
  const runFile = path.join(path.dirname(dir), `run-${path.basename(dir)}.json`);
  if (fs.existsSync(runFile)) {
    const r = JSON.parse(fs.readFileSync(runFile, "utf8")) as RunResult;
    r.judge = judge;
    r.verdict.checks.judgeComplete = judge.verdict === "complete";
    const vals = Object.values(r.verdict.checks);
    r.verdict.success = vals.every(Boolean);
    r.verdict.score = vals.filter(Boolean).length / vals.length;
    fs.writeFileSync(runFile, JSON.stringify(r, null, 2));
    benchDir = path.dirname(dir);
  }
}
if (benchDir) writeSummary(benchDir);
