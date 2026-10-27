import fs from "node:fs";
import path from "node:path";
import { DATA, HERE, GRID, loadEnv, buildUltrafastQuestions } from "./lib.ts";
loadEnv();
const prepared: any[] = JSON.parse(fs.readFileSync(path.join(DATA, "prepared.json"), "utf8"));
const b64 = (id: string, kind: string) => "data:image/jpeg;base64," + fs.readFileSync(path.join(DATA, "shots", `${id}.${kind}.jpg`)).toString("base64");
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// replica of browseStepUltrafast.stateElement
function stateElement(el: any) {
  const out: any = { index: el.index, role: el.role ?? el.tag, label: trunc(el.label ?? "", 100), operations: el.ops };
  if (el.checked !== undefined) out.checked = el.checked;
  else if (el.value !== undefined || el.ops.includes("TYPE_TEXT") || el.ops.includes("SELECT")) out.value = el.value ?? (el.hasValue ? "(filled; value hidden)" : "");
  if (el.expanded !== undefined) out.expanded = el.expanded;
  return out;
}
const MARK_NOTE = "The screenshot shows the current page. Interactive elements are outlined in blue boxes, each with a blue number label at its top-left corner. The answer key is the number of the box on the element to click.";

function build(it: any, arm: string) {
  const els = it.snap.elements.filter((e: any) => e.ops?.length);
  const q = buildUltrafastQuestions(it.goal, els, it.snap.scroll).questions.click_target;
  const treeState = { page: { url: it.snap.url, title: it.snap.title, text: it.snap.text }, elements: els.map(stateElement), recent_actions: [], scroll: it.snap.scroll };
  const img = (k: string) => ({ type: "image_url", image_url: { url: b64(it.id, k) } });
  if (arm === "A" || arm === "B") return { state: treeState, questions: { click_target: q } };
  const keys = Object.keys(q.criteria);
  if (arm === "C") {
    const criteria: any = {}; for (const k of keys) criteria[k] = { element: `box ${k}` };
    return { state: ["Screenshot of the current page (1280x800 viewport).", img("marked")], questions: { click_target: { type: "choice", criteria, instructions: { ...q.instructions, screenshot_note: MARK_NOTE } } } };
  }
  if (arm === "D") {
    return { state: [JSON.stringify(treeState), img("marked")], questions: { click_target: { ...q, instructions: { ...q.instructions, screenshot_note: MARK_NOTE + " Box numbers equal the element index in the JSON state." } } } };
  }
  // E: grid cells
  const criteria: any = {};
  for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) criteria[String.fromCharCode(65 + c) + (r + 1)] = { cell: `column ${String.fromCharCode(65 + c)}, row ${r + 1}`, area: `x ${c * GRID.cw}-${(c + 1) * GRID.cw}, y ${r * GRID.ch}-${(r + 1) * GRID.ch}` };
  return { state: ["Screenshot of the current page (1280x800 viewport) with a magenta grid; each cell is labelled with its column letter and row number at its top-left corner.", img("grid")],
    questions: { click_target: { type: "choice", criteria, instructions: { goal: it.goal, operation: "CLICK", rules: "Choose the grid cell that contains the center of the element the user should click next to advance the goal. Choose only an offered cell." } } } };
}
const ENDPOINT: Record<string, { base: string; key: string; model: string }> = {
  A: { base: "https://api.typesafe.ai/v1", key: process.env.TYPESAFE_API_KEY!, model: "jev-latest" },
  B: { base: "https://openrouter.ai/api/v1", key: process.env.OPENROUTER_API_KEY!, model: "openai/gpt-6-luna-decisions" },
};
for (const a of "CDE") ENDPOINT[a] = ENDPOINT.B;

async function call(it: any, arm: string, run: number) {
  const body = build(it, arm); const ep = ENDPOINT[arm];
  const payload = JSON.stringify({ state: body.state, model: ep.model, questions: body.questions });
  const t0 = Date.now(); let rec: any = { item: it.id, cat: it.cat, arm, run, target: it.target, payloadBytes: payload.length };
  try {
    const res = await fetch(`${ep.base}/systemone`, { method: "POST", headers: { Authorization: `Bearer ${ep.key}`, "Content-Type": "application/json" }, body: payload, signal: AbortSignal.timeout(60000) });
    rec.ms = Date.now() - t0; rec.status = res.status;
    const j: any = await res.json().catch(() => null);
    if (res.ok && j?.answers?.click_target) {
      const a = j.answers.click_target; rec.choice = a.choice; rec.confidence = a.confidence; rec.peak = Math.max(0, ...Object.values<number>(a.probabilities)); rec.usage = j.usage; rec.model = j.model;
    } else rec.error = JSON.stringify(j)?.slice(0, 300);
  } catch (e: any) { rec.ms = Date.now() - t0; rec.error = String(e.message ?? e); }
  return rec;
}
const only = process.argv[2] ?? "ABCDE";
const outFile = path.join(DATA, "raw.jsonl");
const workers = [only.includes("A") ? "A" : "", only.replace("A", "")].filter(Boolean);
await Promise.all(workers.map(async (w) => {
  for (const run of [1, 2]) for (const it of prepared) { if (it.target === null) continue;
    for (const arm of w) { const rec = await call(it, arm, run); fs.appendFileSync(outFile, JSON.stringify(rec) + "\n"); process.stdout.write(rec.error ? "x" : "."); } }
}));
console.log("\ndone");
