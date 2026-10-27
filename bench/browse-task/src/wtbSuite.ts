// WebTestBench scenario groups: `--scenarios @wtb` (oracle track: gold checklist given)
// and `@wtb-e2e` (agent writes its own checklist). Apps come from data/wtb/apps/<id>/dist
// (npm run wtb:prepare). The group is data/wtb/sample.json, or every built app without it.
// Each run serves the app's dist/ on a fresh local port with an SPA fallback; the fresh
// Electron profile per run gives every app empty localStorage.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Scenario } from "./scenarios.ts";
import { verdict } from "./verdict.ts";
import {
  WTB_SAMPLE, distDir, e2eGoal, isBuilt, loadRecords, oracleGoal, parsePredictions, scenarioId, scoreOracle,
  type WtbRecord, type WtbSample,
} from "./wtb.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".json": "application/json", ".txt": "text/plain", ".woff2": "font/woff2",
};

async function serveDist(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function loadSample(): string[] | null {
  try {
    return (JSON.parse(fs.readFileSync(WTB_SAMPLE, "utf8")) as WtbSample).ids;
  } catch {
    return null;
  }
}

function oracle(r: WtbRecord): Scenario {
  const bugs = r.checklist.filter((i) => !i.pass).length;
  return {
    id: scenarioId(r.index, "oracle"),
    about: `wtb ${r.category}: ${r.checklist.length} items, ${bugs} defects (gold checklist given)`,
    minSteps: r.checklist.length * 2,
    async start() {
      const srv = await serveDist(distDir(r.index));
      return {
        url: srv.url,
        goal: oracleGoal(r, srv.url),
        // success = every item right; score = item accuracy; detail = P/R/F1 for the report.
        verify: ({ finalText }) => {
          const s = scoreOracle(r, finalText);
          const checks: Record<string, boolean> = {};
          for (const it of s.items) checks[it.label] = it.pred !== null && it.pred === it.gold;
          return verdict(checks, s);
        },
        close: srv.close,
      };
    },
  };
}

function e2e(r: WtbRecord): Scenario {
  return {
    id: scenarioId(r.index, "e2e"),
    about: `wtb-e2e ${r.category}: own checklist, ${r.checklist.filter((i) => !i.pass).length} gold defects`,
    minSteps: r.checklist.length * 2,
    async start() {
      const srv = await serveDist(distDir(r.index));
      return {
        url: srv.url,
        goal: e2eGoal(r, srv.url),
        // Real scoring needs the official LLM matcher (npm run wtb:report → eval/scoring.py).
        verify: ({ finalText }) => {
          const preds = parsePredictions(finalText);
          return verdict({ replied: finalText.trim().length > 0, checklist: preds.length > 0 }, { predicted: preds.length, failed: preds.filter((p) => !p.pass).length });
        },
        close: srv.close,
      };
    },
  };
}

const records = loadRecords();
const ids = (loadSample() ?? [...records.keys()]).filter((id) => records.has(id) && isBuilt(id));
export const WTB_RECORDS = records;
export const WTB_SUITE: Scenario[] = ids.map((id) => oracle(records.get(id)!));
export const WTB_E2E_SUITE: Scenario[] = ids.map((id) => e2e(records.get(id)!));
