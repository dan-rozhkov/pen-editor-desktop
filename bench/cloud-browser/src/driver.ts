import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { Daytona, Image, type Sandbox } from "@daytona/sdk";
import Steel from "steel-sdk";
import { chromium } from "playwright";
import { BrowserController } from "../vendor/controller";
import { PlaywrightTarget } from "./playwrightHandle";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "1";
};
const TARGET = flag("target", "local") as "local" | "daytona" | "steel";
const PROXY = args.includes("--proxy");
const RUN_LABEL = TARGET === "steel" ? (PROXY ? "steel-proxy" : "steel") : TARGET;
const KEEP = args.includes("--keep");
const PW_VERSION = "1.63.0";
const IMAGE = flag("image", `mcr.microsoft.com/playwright:v${PW_VERSION}-noble`)!;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve("results", `${RUN_LABEL}-${stamp}`);
mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const SITES = [
  { name: "wikipedia", url: "https://en.wikipedia.org" },
  { name: "github", url: "https://github.com" },
  { name: "booking", url: "https://www.booking.com" },
  { name: "amazon", url: "https://www.amazon.com" },
  { name: "skroutz", url: "https://www.skroutz.gr" },
  { name: "google", url: "https://www.google.com/search?q=figma" },
];

const WALL_RE = /captcha|verify you are human|just a moment|robot check|unusual traffic|turnstile|press\s*&\s*hold|access denied|are you a robot|pardon our interruption|security check|attention required|cf-chl|not a robot|sorry, we just need to make sure/i;

interface Ep { call(name: string, body?: unknown): Promise<{ result: any; serverMs: number; clientMs: number }>; health(): Promise<boolean>; }

function endpoint(base: string, headers: Record<string, string>): Ep {
  return {
    async health() {
      try { const r = await fetch(base + "/health", { headers }); return r.ok; } catch { return false; }
    },
    async call(name, body) {
      const t0 = Date.now();
      const r = await fetch(`${base}/cmd/${name}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
      const text = await r.text();
      const clientMs = Date.now() - t0;
      let j: any;
      try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`); }
      if (j.error && j.result === undefined) throw new Error(`worker: ${j.error}`);
      return { result: j.result, serverMs: j.serverMs, clientMs };
    },
  };
}

function inproc(controller: any): Ep {
  return {
    async health() { return true; },
    async call(name, body) {
      const t0 = Date.now();
      const result = await controller[name](body ?? {});
      const ms = Date.now() - t0;
      return { result, serverMs: ms, clientMs: ms };
    },
  };
}

async function waitHealthy(ep: Ep, timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await ep.health()) return; await sleep(500); }
  throw new Error("worker not healthy in time");
}

async function runScenario(ep: Ep) {
  const out: any[] = [];
  for (const site of SITES) {
    const rec: any = { site: site.name, url: site.url, steps: {}, errors: [] };
    const step = async (label: string, name: string, body?: unknown) => {
      try {
        const r = await ep.call(name, body);
        rec.steps[label] = { clientMs: r.clientMs, serverMs: r.serverMs, ok: !(r.result && r.result.error), error: r.result?.error };
        if (r.result?.error) rec.errors.push(`${label}: ${r.result.error}`);
        return r.result;
      } catch (e: any) {
        rec.steps[label] = { ok: false, error: String(e.message ?? e) };
        rec.errors.push(`${label}: ${e.message ?? e}`);
        return undefined;
      }
    };
    log("site", site.name);
    const opened = await step("open", "open", { url: site.url });
    rec.openResult = opened && { ...opened };
    let snap1 = await step("snapshot1", "snapshot");
    rec.elements1raw = snap1?.elements?.length ?? 0;
    if (rec.elements1raw < 8) {
      // transient JS-challenge interstitials (AWS WAF 202 etc.) reload themselves; give them a moment
      await sleep(4000);
      const again = await step("snapshot1_after4s", "snapshot");
      if (again) snap1 = again;
    }
    const els1: any[] = snap1?.elements ?? [];
    rec.elements1 = els1.length;
    // safe act: type into a search-like field, else click first link-ish element
    const typeable = els1.find((e) => (e.ops ?? []).includes("TYPE_TEXT") && /search|query|q\b|ask|destination|where/i.test(JSON.stringify(e))) ?? els1.find((e) => (e.ops ?? []).includes("TYPE_TEXT"));
    let actDesc = "none";
    if (typeable) {
      actDesc = `TYPE_TEXT #${typeable.index} (${String(typeable.label).slice(0, 40)})`;
      rec.act = await step("act", "perform", { snapshotId: snap1.snapshotId, index: typeable.index, operation: "TYPE_TEXT", text: "figma" });
    } else {
      const link = els1.find((e) => e.tag === "a" && e.label && (e.ops ?? []).includes("CLICK"));
      if (link) {
        actDesc = `CLICK #${link.index} (${String(link.label).slice(0, 40)})`;
        rec.act = await step("act", "perform", { snapshotId: snap1.snapshotId, index: link.index, operation: "CLICK" });
      }
    }
    rec.actDesc = actDesc;
    if (rec.act) rec.act = JSON.stringify(rec.act).slice(0, 300);
    const snap2 = await step("snapshot2", "snapshot");
    rec.elements2 = snap2?.elements?.length ?? 0;
    const shot = await step("screenshot", "screenshot", {});
    if (shot?.imageData) {
      const f = `${site.name}.jpg`;
      writeFileSync(path.join(outDir, f), Buffer.from(shot.imageData, "base64"));
      rec.screenshot = f;
    }
    // wall heuristic
    const hay = `${opened?.title ?? ""} ${snap1?.title ?? ""} ${snap2?.title ?? ""} ${JSON.stringify(snap1 ?? {}).slice(0, 20000)}`;
    const m = hay.match(WALL_RE);
    rec.wallMatch = m ? m[0] : null;
    rec.finalUrl = snap2?.url ?? snap1?.url;
    rec.finalTitle = snap2?.title ?? snap1?.title;
    rec.wall = !!m || Math.max(rec.elements1, rec.elements2) < 8;
    out.push(rec);
  }
  return out;
}

async function main() {
  const summary: any = { target: TARGET, stamp, pw: PW_VERSION };
  let proc: ChildProcess | undefined;
  let sandbox: Sandbox | undefined;
  let daytona: Daytona | undefined;
  let steel: Steel | undefined;
  let steelSession: any;
  let steelClose: (() => Promise<void>) | undefined;
  try {
    let ep: Ep;
    const t0 = Date.now();
    if (TARGET === "local") {
      const port = 8787 + Math.floor(Math.random() * 100);
      proc = spawn("node", ["dist/worker.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "inherit", "inherit"] });
      ep = endpoint(`http://127.0.0.1:${port}`, {});
      await waitHealthy(ep, 20000);
      summary.coldStartMs = { total: Date.now() - t0 };
    } else if (TARGET === "steel") {
      steel = new Steel({ steelAPIKey: process.env.STEEL_API_KEY! });
      const opts: Record<string, unknown> = { dimensions: { width: 1280, height: 800 } };
      if (PROXY) { opts.useProxy = true; opts.solveCaptcha = true; }
      const tc = Date.now();
      let session: any;
      const tried: any[] = [];
      try {
        session = await steel.sessions.create(opts as any);
      } catch (e: any) {
        tried.push({ opts, error: String(e.message).slice(0, 500) });
        log("create with opts failed:", tried[0].error);
        if (PROXY) {
          // retry each option separately to record which one is rejected
          for (const [k, v] of [["useProxy", true], ["solveCaptcha", true]] as const) {
            try { const x: any = await steel.sessions.create({ [k]: v } as any); tried.push({ opts: { [k]: v }, ok: true }); if (!session) session = x; else await steel.sessions.release(x.id); }
            catch (e2: any) { tried.push({ opts: { [k]: v }, error: String(e2.message).slice(0, 500) }); }
          }
        }
        if (!session) throw new Error("no session could be created");
      }
      steelSession = session;
      summary.optionAttempts = tried;
      summary.sessionOpts = opts;
      const createMs = Date.now() - tc;
      summary.session = { id: session.id, hasDebugUrl: !!session.debugUrl, hasSessionViewerUrl: !!session.sessionViewerUrl, hasWebsocketUrl: !!session.websocketUrl, region: session.region, solveCaptcha: session.solveCaptcha, useProxy: session.useProxy, dimensions: session.dimensions, userAgent: session.userAgent };
      const tk = Date.now();
      const browser = await chromium.connectOverCDP(`wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`);
      const ctx = browser.contexts()[0];
      const connectMs = Date.now() - tk;
      const tgt = new PlaywrightTarget(ctx);
      const controller = new BrowserController(tgt, { cursor: true });
      ep = inproc(controller);
      summary.coldStartMs = { createMs, connectMs, total: Date.now() - t0 };
      log("steel session", session.id, summary.coldStartMs);
      // egress IP check from inside the browser
      const ip = await ep.call("open", { url: "https://ipinfo.io/json" });
      const rd = await ep.call("read", {});
      summary.egress = { open: ip.result, read: JSON.stringify(rd.result).slice(0, 800) };
      log("egress", summary.egress.read.slice(0, 400));
      steelClose = async () => { await browser.close().catch(() => {}); };
    } else {
      daytona = new Daytona();
      const tc = Date.now();
      const labels = { app: "cloud-browser-spike" };
      const mk = async (image?: string) =>
        image
          ? daytona!.create({ image: Image.base(image), autoStopInterval: 15, labels, resources: { cpu: 2, memory: 4, disk: 10 } }, { timeout: 600, onSnapshotCreateLogs: (l: string) => log("[img]", l.trim().slice(0, 120)) } as any)
          : daytona!.create({ autoStopInterval: 15, labels }, { timeout: 180 });
      let usedImage: string | undefined = IMAGE;
      try {
        sandbox = await mk(IMAGE);
      } catch (e: any) {
        log("image create failed:", String(e.message).slice(0, 400));
        summary.imageError = String(e.message).slice(0, 600);
        usedImage = undefined;
        sandbox = await mk();
      }
      summary.image = usedImage ?? "default-snapshot";
      const createMs = Date.now() - tc;
      log("sandbox", sandbox.id, "created in", createMs, "ms via", summary.image);
      const sh = async (cmd: string, timeout = 120, env?: Record<string, string>) => {
        const r = await sandbox!.process.executeCommand(cmd, undefined, env, timeout);
        return { code: r.exitCode, out: (r.result ?? "").toString() };
      };
      const ts = Date.now();
      const home = (await sh("echo $HOME")).out.trim() || "/root";
      const dir = `${home}/spike`;
      await sh(`mkdir -p ${dir}`);
      await sandbox.fs.uploadFile(readFileSync("dist/worker.mjs"), `${dir}/worker.mjs`);
      const node = await sh("node -v; npm -v; which chromium google-chrome; ls /ms-playwright 2>&1 | head; id -un");
      log("sandbox env:", node.out.replace(/\n/g, " | "));
      summary.sandboxEnv = node.out;
      let browsersPath = "/ms-playwright";
      const inst = await sh(`cd ${dir} && npm init -y >/dev/null && npm i playwright@${PW_VERSION} 2>&1 | tail -3`, 300);
      log("npm i:", inst.out.trim().slice(-200));
      const has = await sh(`ls /ms-playwright 2>/dev/null | grep -c chromium`);
      if (usedImage && has.out.trim() !== "0") {
        summary.chromium = "preinstalled in image (" + (await sh("ls /ms-playwright")).out.replace(/\n/g, ",") + ")";
      } else {
        browsersPath = `${home}/pw`;
        const pi = await sh(`cd ${dir} && PLAYWRIGHT_BROWSERS_PATH=${browsersPath} npx playwright install --with-deps chromium 2>&1 | tail -5`, 600);
        log("pw install:", pi.out.trim().slice(-300));
        summary.chromium = "installed via playwright install --with-deps";
      }
      // does the preinstalled chromium match this playwright version? if not install
      const chk = await sh(`cd ${dir} && PLAYWRIGHT_BROWSERS_PATH=${browsersPath} node -e "const {chromium}=require('playwright');console.log(chromium.executablePath())" && ls $(PLAYWRIGHT_BROWSERS_PATH=${browsersPath} node -e "const {chromium}=require('playwright');console.log(chromium.executablePath())") 2>&1 | head -2`);
      if (/No such file/.test(chk.out)) {
        log("chromium missing for this playwright version; installing");
        const pi = await sh(`cd ${dir} && PLAYWRIGHT_BROWSERS_PATH=${home}/pw npx playwright install --with-deps chromium 2>&1 | tail -5`, 600);
        log(pi.out.trim().slice(-300));
        browsersPath = `${home}/pw`;
        summary.chromium += " + version-matching chromium installed";
      }
      const setupMs = Date.now() - ts;
      await sh(`cd ${dir} && (PLAYWRIGHT_BROWSERS_PATH=${browsersPath} PORT=8787 setsid nohup node worker.mjs > worker.log 2>&1 < /dev/null &) ; echo started`, 20);
      const link = await sandbox.getPreviewLink(8787);
      ep = endpoint(link.url.replace(/\/$/, ""), { "x-daytona-preview-token": link.token, "X-Daytona-Skip-Preview-Warning": "true" });
      try {
        await waitHealthy(ep, 60000);
      } catch (e) {
        summary.workerLog = (await sh(`cat ${dir}/worker.log`)).out.slice(-2000);
        throw e;
      }
      summary.coldStartMs = { createMs, setupMs, total: Date.now() - t0 };
      log("cold start", summary.coldStartMs);

      // network check
      const net: any[] = [];
      for (const u of ["https://www.google.com", "https://www.booking.com", "https://www.amazon.com", "https://www.skroutz.gr", "https://en.wikipedia.org", "https://github.com"]) {
        const r = await sh(`curl -sS -m 20 -o /dev/null -w '%{http_code} %{time_total}' ${u} 2>&1`, 40);
        net.push({ url: u, result: r.out.trim() });
      }
      net.push({ url: "ifconfig.io", result: (await sh("curl -sS -m 15 https://ifconfig.io 2>&1")).out.trim() });
      net.push({ url: "ipinfo.io/json", result: (await sh("curl -sS -m 15 https://ipinfo.io/json 2>&1")).out.replace(/\s+/g, " ").trim() });
      summary.network = net;
      log("network", JSON.stringify(net));
    }
    // warm-up health-latency (pure network overhead)
    const hl: number[] = [];
    for (let i = 0; i < 5; i++) { const t = Date.now(); await ep.health(); hl.push(Date.now() - t); }
    summary.healthRttMs = hl;
    summary.sites = await runScenario(ep);
    try { summary.tabs = (await ep.call("tabs", { action: "list" })).result; } catch (e: any) { summary.tabs = String(e.message); }
  } catch (e: any) {
    summary.fatal = String(e?.stack ?? e);
    log("FATAL", summary.fatal);
  } finally {
    if (steelClose) await steelClose();
    if (steel && steelSession) {
      try { await steel.sessions.release(steelSession.id); log("session released"); const s2: any = await steel.sessions.retrieve(steelSession.id); summary.sessionFinal = { status: s2.status, creditsUsed: s2.creditsUsed, proxyBytesUsed: s2.proxyBytesUsed, duration: s2.duration }; } catch (e: any) { log("release failed", e.message); }
    }
    if (proc) proc.kill();
    if (sandbox && !KEEP) { try { await sandbox.delete(); log("sandbox deleted"); } catch (e) { log("delete failed", e); } }
    writeFileSync(path.join(outDir, "results.json"), JSON.stringify(summary, null, 2));
    log("results:", outDir);
  }
}
main().then(() => process.exit(0));
