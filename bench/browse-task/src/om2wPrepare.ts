import os from "node:os";
// Builds data/om2w/sample.json: a deterministic stratified sample of
// Online-Mind2Web joined with key points and published Browser Use / Operator results.
// usage: npm run om2w:prepare -- [path/to/Online_Mind2Web.json] [--n 30] [--seed om2w-1]
// Without a path the gated HF file is downloaded with env HF_TOKEN.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { OM2W_DIR, OM2W_SAMPLE, type Level, type Om2wSample, type Om2wTask } from "./om2w.ts";

const HF_URL = "https://huggingface.co/datasets/osunlp/Online-Mind2Web/resolve/main/Online_Mind2Web.json";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    n: { type: "string", default: "30" },
    seed: { type: "string", default: "om2w-1" },
    help: { type: "boolean", short: "h", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`usage: npm run om2w:prepare -- [Online_Mind2Web.json] [--n 30] [--seed om2w-1] [--dry-run]
  With no file argument, downloads ${HF_URL}
  using env HF_TOKEN (Bearer). Output: data/om2w/sample.json (--dry-run: print only).
  Sample is split evenly over easy/medium/hard (remainder goes to easy, then medium).`);
  process.exit(0);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** mulberry32 seeded from a string hash. */
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

type Raw = Record<string, unknown>;
const pick = (r: Raw, ...keys: string[]): unknown => {
  for (const k of keys) if (r[k] != null && r[k] !== "") return r[k];
  return undefined;
};

async function loadDataset(): Promise<Raw[]> {
  let text: string;
  if (positionals[0]) {
    text = fs.readFileSync(positionals[0], "utf8");
  } else {
    // `hf auth login` saves the token here; HF_TOKEN wins when both exist.
    const tokenFile = path.join(os.homedir(), ".cache", "huggingface", "token");
    const token = process.env.HF_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");
    if (!token) throw new Error("no Hugging Face token: set HF_TOKEN or run `uvx --from huggingface_hub hf auth login` (the dataset is gated), or pass a local file");
    const res = await fetch(HF_URL, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
    text = await res.text();
  }
  const data = JSON.parse(text) as unknown;
  if (Array.isArray(data)) return data as Raw[];
  if (data && typeof data === "object") {
    const vals = Object.values(data as Raw);
    if (vals.length && vals.every((v) => v && typeof v === "object")) return vals as Raw[];
  }
  throw new Error("unexpected dataset shape (expected a JSON array of tasks)");
}

const n = Math.max(3, Number(args.n) || 30);
const raw = await loadDataset();
const first = raw[0] ?? {};
if (!("task_id" in first) || !("confirmed_task" in first) || !pick(first, "website", "url", "start_url") || !pick(first, "level", "difficulty")) {
  console.error(`unexpected field names; keys of the first record: ${Object.keys(first).join(", ")}`);
}

const byId = (file: string) =>
  new Map(readJson<{ task_id: string; final_eval: string | number; key_points: string }[]>(path.join(OM2W_DIR, file)).map((r) => [r.task_id, r]));
const bu = byId("browser_use.json");
const op = byId("operator.json");

const tasks: Om2wTask[] = [];
for (const r of raw) {
  const id = String(r.task_id ?? "");
  const task = String(pick(r, "confirmed_task", "task") ?? "");
  const website = String(pick(r, "website", "url", "start_url") ?? "");
  const level = String(pick(r, "level", "difficulty") ?? "").toLowerCase();
  const kp = bu.get(id)?.key_points ?? op.get(id)?.key_points;
  if (!id || !task || !website || !kp) continue; // no key points = no oracle
  tasks.push({
    task_id: id,
    confirmed_task: task,
    website,
    level,
    reference_length: typeof r.reference_length === "number" ? r.reference_length : undefined,
    key_points: kp,
    browser_use: bu.has(id) ? Number(bu.get(id)!.final_eval) : null,
    operator: op.has(id) ? Number(op.get(id)!.final_eval) : null,
  });
}
console.log(`dataset: ${raw.length} records, ${tasks.length} usable (have id, task, website, key points)`);

const levels: Level[] = ["easy", "medium", "hard"];
const quota = levels.map((_, i) => Math.floor(n / 3) + (i < n % 3 ? 1 : 0));
const rand = rng(String(args.seed));
const picked: Om2wTask[] = [];
levels.forEach((lv, i) => {
  const pool = tasks.filter((t) => t.level === lv).sort((a, b) => a.task_id.localeCompare(b.task_id));
  if (pool.length < quota[i]) console.warn(`level ${lv}: only ${pool.length} tasks, wanted ${quota[i]}`);
  picked.push(...shuffle(pool, rand).slice(0, quota[i]));
});

const sample: Om2wSample = { seed: String(args.seed), n: picked.length, tasks: picked };
for (const lv of levels) console.log(`${lv}: ${picked.filter((t) => t.level === lv).length}`);
if (args["dry-run"]) {
  console.log(picked.map((t) => `${t.task_id.slice(0, 8)} ${t.level} ${t.website} :: ${t.confirmed_task}`).join("\n"));
} else {
  fs.mkdirSync(OM2W_DIR, { recursive: true });
  fs.writeFileSync(OM2W_SAMPLE, JSON.stringify(sample, null, 2));
  console.log(`wrote ${picked.length} tasks -> ${OM2W_SAMPLE}`);
}
