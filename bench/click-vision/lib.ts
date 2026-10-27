import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

export const ROOT = "/Users/daniilrozhkov/prj/pen-editor-app";
export const HERE = path.join(ROOT, "bench/click-vision");
const WS = process.env.CV_WS ?? ROOT;
export const DATA = path.join(HERE, process.env.CV_DATA ?? "data");
const PS = await import(pathToFileURL(path.join(WS, "pen-editor-desktop/src/main/browser/pageScripts.ts")).href);
const UF = await import(pathToFileURL(path.join(WS, "pen-editor-backend/src/ai/browseStepUltrafast.ts")).href);
export const buildUltrafastQuestions = UF.buildUltrafastQuestions as (goal: string, els: any[], scroll: any) => { questions: Record<string, any>; operations: string[]; targets: any };

export const GRID = { cols: 16, rows: 10, cw: 80, ch: 80 };
export const VIEWPORT = { width: 1280, height: 800 };

export function loadEnv() {
  const txt = fs.readFileSync(path.join(ROOT, "pen-editor-backend/.env"), "utf8");
  for (const line of txt.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function runScript(page: Page, name: string, args: Record<string, unknown>) {
  const code = (PS[name] as string).replace(PS.ARGS_MARKER, () => JSON.stringify(args));
  return page.evaluate(code);
}

export interface Snap { id: string; url: string; title: string; text: string; scroll: any; elements: any[] }
export async function snapshot(page: Page): Promise<Snap> {
  const id = "s" + Math.random().toString(36).slice(2, 8);
  const r: any = await runScript(page, "SNAPSHOT_JS", { snapshotId: id, maxElements: 120 });
  return { id, url: r.url, title: r.title, text: r.text, scroll: r.scroll, elements: r.elements };
}
export async function marks(page: Page, id: string) { await runScript(page, "MARKS_JS", { snapshotId: id }); }
export async function unmarks(page: Page) { await runScript(page, "REMOVE_MARKS_JS", {}); }

/** element rects by snapshot index (viewport coords) */
export async function rects(page: Page, id: string): Promise<Record<number, { x: number; y: number; w: number; h: number }>> {
  return page.evaluate((id) => {
    const out: any = {};
    document.querySelectorAll(`[data-pen-snap^="${id}:"]`).forEach((el) => {
      const a = el.getAttribute("data-pen-snap")!; const i = parseInt(a.slice(id.length + 1), 10);
      const r = el.getBoundingClientRect(); out[i] = { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    return out;
  }, id);
}
/** map a CSS selector to the snapshot index of it or nearest stamped ancestor */
export async function indexOf(page: Page, id: string, selector: string): Promise<number | null> {
  return page.evaluate(([id, sel]) => {
    const el = document.querySelector(sel as string); if (!el) return null;
    const s = (el as Element).closest(`[data-pen-snap^="${id}:"]`) || (el as Element).querySelector(`[data-pen-snap^="${id}:"]`);
    if (!s) return null; const a = s.getAttribute("data-pen-snap")!; return parseInt(a.slice((id as string).length + 1), 10);
  }, [id, selector] as const);
}

export async function startStatic(files: Record<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    const body = files[p] ?? files[p.replace(/\/$/, "")];
    if (body === undefined) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) };
}

export async function launch(): Promise<Browser> { return chromium.launch({ headless: true }); }
export async function newPage(b: Browser): Promise<Page> {
  const ctx = await b.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  return ctx.newPage();
}
