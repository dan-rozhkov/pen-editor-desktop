// npm run wtb:prepare -- [--ids 0001,0002] [--n 20 --seed wtb-1] [--concurrency 4] [--force]
//
// 1. Downloads WebTestBench.jsonl and the 100 app zips from HF (no token, not gated).
// 2. Unzips every app into data/wtb/apps/<id>, installs it with `npm ci --ignore-scripts`,
//    builds it with React in DEVELOPMENT mode (the paper runs `npm run dev`, so StrictMode
//    double effects stay), keeps dist/ and deletes node_modules (~260 MB each).
// 3. With --n, writes data/wtb/sample.json: a category-stratified sample for @wtb / @wtb-e2e.
//
// The apps are third-party code. Only vite.config.ts runs at build time, and only the two
// Lovable-template configs seen on 2026-10-24 are accepted; anything else is skipped.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { WTB_APPS, WTB_DIR, WTB_JSONL, WTB_SAMPLE, WTB_ZIPS, isBuilt, loadRecords, type WtbSample } from "./wtb.ts";

const run = promisify(execFile);
const HF = "https://huggingface.co/datasets/friedrichor/WebTestBench/resolve/main";
const KNOWN_VITE_CONFIGS = new Set(["978c0733ad7195aa171e5d7f71b2dccf", "eea8e578ebca550761c5c0e19be01385"]);

const { values: args } = parseArgs({
  options: {
    ids: { type: "string" },
    n: { type: "string" },
    seed: { type: "string", default: "wtb-1" },
    concurrency: { type: "string", default: "4" },
    force: { type: "boolean", default: false },
  },
});

async function download(url: string, file: string): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function build(index: string): Promise<string> {
  if (isBuilt(index) && !args.force) return "cached";
  const zip = path.join(WTB_ZIPS, `${index}.zip`);
  await download(`${HF}/web_applications_zip/${index}.zip`, zip);
  const dir = path.join(WTB_APPS, index);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(WTB_APPS, { recursive: true });
  // Info-ZIP refuses absolute paths and strips "../" components.
  await run("unzip", ["-q", "-o", zip, "-d", WTB_APPS]);
  const cfg = path.join(dir, "vite.config.ts");
  const hash = crypto.createHash("md5").update(fs.readFileSync(cfg)).digest("hex");
  if (!KNOWN_VITE_CONFIGS.has(hash)) return `SKIPPED: unknown vite.config.ts (md5 ${hash})`;
  try {
    const npmFlags = ["--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
    try {
      await run("npm", ["ci", ...npmFlags], { cwd: dir, maxBuffer: 1 << 24 });
    } catch {
      // 18 of 100 apps ship a lock file out of sync with package.json (EUSAGE);
      // the authors' README runs `npm install`, which resolves the missing deps.
      await run("npm", ["install", ...npmFlags], { cwd: dir, maxBuffer: 1 << 24 });
    }
    await run("npx", ["vite", "build", "--mode", "development", "--logLevel", "error"], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: "development" },
      maxBuffer: 1 << 24,
    });
  } finally {
    fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  }
  return isBuilt(index) ? "built" : "FAILED: no dist/index.html";
}

function seededRank(seed: string, id: string): string {
  return crypto.createHash("sha256").update(`${seed}:${id}`).digest("hex");
}

/** Round-robin over categories, each category in seeded order: a stratified sample of n. */
function stratified(ids: string[], categoryOf: (id: string) => string, n: number, seed: string): string[] {
  const byCat = new Map<string, string[]>();
  for (const id of ids) byCat.set(categoryOf(id), [...(byCat.get(categoryOf(id)) ?? []), id]);
  const queues = [...byCat.keys()].sort().map((c) => byCat.get(c)!.sort((a, b) => seededRank(seed, a).localeCompare(seededRank(seed, b))));
  const out: string[] = [];
  while (out.length < n && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
  return out.sort();
}

await download(`${HF}/WebTestBench.jsonl`, WTB_JSONL);
const records = loadRecords();
const wanted = args.ids
  ? args.ids.split(",").map((s) => `WebTestBench_${s.trim().padStart(4, "0")}`)
  : [...records.keys()];
for (const id of wanted) if (!records.has(id)) throw new Error(`unknown id ${id}`);

const results = new Map<string, string>();
const queue = [...wanted];
const workers = Array.from({ length: Math.max(1, Number(args.concurrency) || 1) }, async () => {
  for (let id = queue.shift(); id; id = queue.shift()) {
    const t0 = Date.now();
    let status: string;
    try {
      status = await build(id);
    } catch (err) {
      status = `FAILED: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    }
    results.set(id, status);
    console.log(`${id}: ${status} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
});
await Promise.all(workers);

const built = [...records.keys()].filter(isBuilt);
const bad = [...results].filter(([, s]) => s.startsWith("FAILED") || s.startsWith("SKIPPED"));
console.log(`\nbuilt ${built.length}/${records.size}; problems: ${bad.length ? bad.map(([id, s]) => `${id} ${s}`).join("; ") : "none"}`);

if (args.n) {
  const ids = stratified(built, (id) => records.get(id)!.category, Number(args.n), args.seed!);
  const sample: WtbSample = { seed: args.seed!, ids };
  fs.writeFileSync(WTB_SAMPLE, JSON.stringify(sample, null, 2));
  console.log(`sample of ${ids.length} → ${path.relative(WTB_DIR, WTB_SAMPLE)}: ${ids.map((i) => i.slice(-4)).join(",")}`);
}
