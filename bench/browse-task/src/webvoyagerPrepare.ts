// Builds data/webvoyager/sample.json: a deterministic, stratified sample of WebVoyager
// (3 tasks per site x 15 sites) joined with the reference answers, after dropping tasks that
// cannot be done today (past absolute dates, login, purchase/booking).
// usage: npm run wv:prepare -- [--n 45] [--seed wv-1] [--today YYYY-MM-DD] [--fetch] [--dry-run]
// Data files are untrusted: they are only ever JSON.parse'd, never executed.

import fs from "node:fs";
import { parseArgs } from "node:util";
import { WV_DIR, WV_REFERENCE_FILE, WV_SAMPLE, WV_TASKS_FILE, type WvSample, type WvTask } from "./webvoyager.ts";

const RAW = "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data";

const { values: args } = parseArgs({
  options: {
    n: { type: "string", default: "45" },
    seed: { type: "string", default: "wv-1" },
    today: { type: "string" },
    fetch: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (args.help) {
  console.log(`usage: npm run wv:prepare -- [--n 45] [--seed wv-1] [--today YYYY-MM-DD] [--fetch] [--dry-run]
  Reads data/webvoyager/{WebVoyager_data.jsonl,reference_answer.json} (--fetch re-downloads them from
  ${RAW}). Output: data/webvoyager/sample.json, n/15 tasks per site (n is rounded down to a multiple of 15).`);
  process.exit(0);
}

/** mulberry32 seeded from a string hash (same as om2wPrepare). */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

if (args.fetch) {
  fs.mkdirSync(WV_DIR, { recursive: true });
  for (const [name, dest] of [["WebVoyager_data.jsonl", WV_TASKS_FILE], ["reference_answer.json", WV_REFERENCE_FILE]] as const) {
    const res = await fetch(`${RAW}/${name}`);
    if (!res.ok) throw new Error(`download ${name}: HTTP ${res.status}`);
    fs.writeFileSync(dest, await res.text());
    console.log(`downloaded ${name}`);
  }
}

// ---- load (JSON only) -------------------------------------------------------------------------
interface RawTask { web_name: string; id: string; ques: string; web: string }
interface RawRef { notice?: string; answers: { id: number; type: string; ans: string }[] }

const rawTasks: RawTask[] = fs
  .readFileSync(WV_TASKS_FILE, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as RawTask);
const refs = JSON.parse(fs.readFileSync(WV_REFERENCE_FILE, "utf8")) as Record<string, RawRef>;
const first = rawTasks[0] ?? ({} as RawTask);
if (!first.web_name || !first.id || !first.ques || !first.web) {
  throw new Error(`unexpected task fields; keys of the first record: ${Object.keys(first).join(", ")}`);
}

// ---- exclusion rules --------------------------------------------------------------------------
const today = args.today ? new Date(`${args.today}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const THIS_YEAR = today.getUTCFullYear();
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const M = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const MONTH_DAY = new RegExp(`\\b${M}\\s+\\d{1,2}(?!\\d)|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${M}`, "i");
const NUMERIC_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
const MONTH_YEAR = new RegExp(`\\b${M}\\s*,?\\s*(?:19|20)\\d\\d\\b`, "i");
const SEASON = /\b20\d\d-\d\d\b/; // "2023-24" season pages: the site now shows the current season
const YEARS = (q: string) => [...q.matchAll(/\b(19\d\d|20\d\d)\b/g)].map((m) => Number(m[1]));
const TRAVEL = new Set(["Booking", "Google Flights"]);

const LOGIN = /\b(log ?in|log into|sign ?in|sign ?up|create an? account|my account|your account|register|(?<!how to )subscribe|enroll|wishlist|bookmark|add to (?:my )?(?:list|favorites|collection)|fork)\b/i;
const NO_LOGIN_NEEDED = /\bwithout (?:a )?(?:log ?in|sign ?in)\b/i;
const PURCHASE = /\b(book (?:a|an|one|the|me|my|and|for)\b|find and book|reserve (?:a|an|the|one|my)\b|purchase|buy (?:it|one|now|and)\b|pre-?order|place an? order|order (?:a|an|the|one)\b|check ?out and pay|schedule an? (?:in-store )?pick ?up)\b/i;

/** Days until the next occurrence of the first "Month D" in q (no year given). */
function daysToNext(q: string): number | null {
  const m = q.match(new RegExp(`\\b(${M})\\s+(\\d{1,2})(?!\\d)`, "i")) ?? q.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${M})`, "i"));
  if (!m) return null;
  const monthStr = (isNaN(Number(m[1])) ? m[1] : m[2]).slice(0, 3).toLowerCase();
  const day = Number(isNaN(Number(m[1])) ? m[2] : m[1]);
  const mi = MONTHS.indexOf(monthStr);
  if (mi < 0) return null;
  let d = new Date(Date.UTC(THIS_YEAR, mi, day));
  if (d < today) d = new Date(Date.UTC(THIS_YEAR + 1, mi, day));
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

function exclusion(t: RawTask): string | null {
  const q = t.ques;
  const years = YEARS(q);
  const pastYear = years.some((y) => y <= THIS_YEAR) && !years.some((y) => y > THIS_YEAR);
  const dayLevel = MONTH_DAY.test(q) || NUMERIC_DATE.test(q);
  if (dayLevel && pastYear) return "past absolute date (day-level date with a past year)";
  if (MONTH_YEAR.test(q) && pastYear) return "past month/year period";
  if (SEASON.test(q)) return "past season (e.g. 2023-24; site now shows the current one)";
  if (dayLevel && !years.length && TRAVEL.has(t.web_name)) {
    const d = daysToNext(q);
    // Google Flights sells ~11 months ahead; Booking ~16 months. A no-year date resolves to its next occurrence.
    if (d != null && d > (t.web_name === "Google Flights" ? 330 : 480)) return "no-year date beyond the booking horizon";
  }
  if (LOGIN.test(q) && !NO_LOGIN_NEEDED.test(q)) return "requires login / account";
  if (PURCHASE.test(q)) return "requires purchase / booking / reservation";
  return null;
}

// ---- build pool -------------------------------------------------------------------------------
const excluded: Record<string, number> = {};
const excludedList: string[] = [];
const keptNoYear: string[] = [];
const pool = new Map<string, WvTask[]>();
for (const r of rawTasks) {
  const ref = refs[r.web_name];
  const num = Number(r.id.split("--").pop());
  const ans = ref?.answers.find((a) => a.id === num);
  let why = exclusion(r);
  if (!why && !ans) why = "no reference answer";
  if (why) {
    excluded[why] = (excluded[why] ?? 0) + 1;
    excludedList.push(`${r.id} [${why}] ${r.ques.slice(0, 110)}`);
    continue;
  }
  if ((MONTH_DAY.test(r.ques) || NUMERIC_DATE.test(r.ques)) && !YEARS(r.ques).length) keptNoYear.push(r.id);
  const task: WvTask = {
    id: r.id, web_name: r.web_name, web: r.web, ques: r.ques,
    ref_answer: ans!.ans, ref_type: ans!.type, notice: ref.notice?.trim() || undefined,
    browser_use: null,
  };
  (pool.get(r.web_name) ?? pool.set(r.web_name, []).get(r.web_name)!).push(task);
}
const total = rawTasks.length;
const dropped = Object.values(excluded).reduce((a, b) => a + b, 0);
console.log(`today (for date rules): ${today.toISOString().slice(0, 10)}`);
console.log(`dataset: ${total} tasks over ${new Set(rawTasks.map((r) => r.web_name)).size} sites; excluded ${dropped}, usable ${total - dropped}`);
for (const [k, v] of Object.entries(excluded).sort((a, b) => b[1] - a[1])) console.log(`  excluded ${String(v).padStart(3)}  ${k}`);
console.log(`  kept ${keptNoYear.length} tasks with a no-year date (resolve to next occurrence): ${keptNoYear.join(", ")}`);

// ---- stratified sample ------------------------------------------------------------------------
const sites = [...pool.keys()].sort();
const n = Number(args.n) || 45;
const perSite = Math.max(1, Math.floor(n / sites.length));
if (perSite * sites.length !== n) console.warn(`--n ${n} is not a multiple of ${sites.length}; using ${perSite} per site = ${perSite * sites.length}`);
const rand = rng(String(args.seed));
const picked: WvTask[] = [];
const usablePerSite: Record<string, number> = {};
const idNum = (t: WvTask) => Number(t.id.split("--").pop());
for (const site of sites) {
  const tasks = pool.get(site)!.sort((a, b) => idNum(a) - idNum(b));
  usablePerSite[site] = tasks.length;
  if (tasks.length < perSite) console.warn(`site ${site}: only ${tasks.length} usable tasks, wanted ${perSite} (taking all)`);
  picked.push(...shuffle(tasks, rand).slice(0, perSite).sort((a, b) => idNum(a) - idNum(b)));
}
for (const site of sites) {
  const ps = picked.filter((t) => t.web_name === site);
  console.log(`${site.padEnd(22)} usable ${String(usablePerSite[site]).padStart(3)}  picked ${ps.length}  (${ps.map((t) => `${t.id.split("--")[1]}:${t.ref_type[0]}`).join(" ")})`);
}
const types = picked.reduce<Record<string, number>>((a, t) => ((a[t.ref_type] = (a[t.ref_type] ?? 0) + 1), a), {});
console.log(`picked ${picked.length} tasks; reference types: ${JSON.stringify(types)}`);

const sample: WvSample = {
  seed: String(args.seed), n: picked.length, today: today.toISOString().slice(0, 10), perSite, excluded, usablePerSite, tasks: picked,
};
if (args["dry-run"]) {
  console.log(picked.map((t) => `${t.id} ${t.ref_type} :: ${t.ques}`).join("\n"));
} else {
  fs.writeFileSync(WV_SAMPLE, JSON.stringify(sample, null, 2));
  fs.writeFileSync(`${WV_DIR}/excluded.txt`, excludedList.join("\n") + "\n");
  console.log(`wrote ${picked.length} tasks -> ${WV_SAMPLE} (excluded list: data/webvoyager/excluded.txt)`);
}
