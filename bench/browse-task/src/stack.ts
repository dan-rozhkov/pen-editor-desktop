// Local stack for one bench policy: pen-editor-backend (tsx, its own .env
// plus overrides) and pen-editor's Vite dev server pointed at it.
//
// Gotchas carried over from earlier live runs (memory
// browse-speed-stagehand-hermes-shipped):
//  - a second dev backend overwrites and on exit DELETES ~/.pen-editor/mcp.json
//    (the desktop's MCP handshake) — so the backend runs with its own HOME;
//  - its own PORT plus CORS_ALLOWED_ORIGINS for the Vite origin, or the
//    browser POSTs die silently after preflight;
//  - Vite binds ::1 by default — pin 127.0.0.1.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { BACKEND_DIR, FRONTEND_DIR } from "./paths.ts";

// Dev secrets of both repos live in Infisical (memory dev-secrets-infisical):
// each process runs under `infisical run` in its own repo dir (its
// .infisical.json picks the project). The bench overrides go through `env`
// AFTER injection, so an Infisical value (e.g. the frontend's
// VITE_AI_API_URL) can never win over them. infisical needs the real HOME
// for its login, so HOME is only swapped for the child.
function underInfisical(overrides: Record<string, string>, cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (process.env.BENCH_NO_INFISICAL === "1") return { cmd: "env", args: [...Object.entries(overrides).map(([k, v]) => `${k}=${v}`), cmd, ...args] };
  return {
    cmd: "infisical",
    args: ["run", "--env=dev", "--silent", "--", "env", ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`), cmd, ...args],
  };
}

export interface StackOptions {
  backendPort: number;
  vitePort: number;
  policy: "ultrafast" | "legacy";
  chatModel: string;
  cascadeModel?: string;
  /** Backend BROWSE_MODE: "task" offers browse_task, "manual" (backend default since dba834b) does not. */
  browseMode?: "task" | "manual" | "agent";
  outDir: string;
}

/** One `browse step decided` line from the backend's pino log. */
export interface BackendStepLog {
  time: number;
  step: number;
  policy: string;
  outcome: string;
  operation?: string;
  cascade: boolean;
  cascadeNote?: string;
  timings?: { jevMs: number; textMs?: number; cascadeMs?: number; totalMs: number };
  textSource?: string;
  vision?: boolean;
  inputTokens?: number;
  diag?: { tier?: string; gates?: { head: string; peak: number; threshold: number; jevPick?: string }[] };
}

export interface Stack {
  editorUrl: string;
  backendUrl: string;
  /** Step-decision log lines with `time` in [from, to]. */
  stepLogs: (from: number, to: number) => BackendStepLog[];
  stop: () => Promise<void>;
}

function startProcess(name: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string, onLine?: (line: string) => void): ChildProcess {
  const out = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.pipe(out, { end: false });
    if (onLine) readline.createInterface({ input: stream }).on("line", onLine);
  }
  child.on("exit", (code) => out.write(`\n[${name} exited ${code}]\n`));
  return child;
}

async function waitForHttp(url: string, child: ChildProcess, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited with ${child.exitCode} before answering — see its log`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not answer ${url} within ${timeoutMs / 1000}s`);
}

function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      resolve();
    }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { process.kill(-child.pid!, "SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

/** Sentinel OpenRouter key under BENCH_NO_OPENROUTER=1; grep the backend log for it / 401s. */
export const BLOCKED_OPENROUTER_KEY = "bench-openrouter-blocked";

// BENCH_NO_OPENROUTER=1: every LLM call of the run goes to OpenCode Go (user rule, 24.10).
// Main chat and the browse_agent subagent are pinned to opencode-go/* per request by runOnce;
// the helper roles that default to OpenRouter are switched off (QA judge, vision), and the
// OpenRouter key is replaced, so any helper left over (prompt suggestions, …) fails with 401
// instead of spending. Without vision, screenshots reach the model as a placeholder: the
// agent works from the DOM, like the WebTestBench baselines.
function noOpenRouterEnv(chatModel: string): Record<string, string> {
  if (process.env.BENCH_NO_OPENROUTER !== "1") return {};
  const oc = /^opencode(-go)?\//;
  if (!oc.test(chatModel)) throw new Error(`BENCH_NO_OPENROUTER=1 needs --chat-model opencode-go/…, got "${chatModel}"`);
  if (!oc.test(process.env.BENCH_AGENT_MODEL ?? "")) throw new Error("BENCH_NO_OPENROUTER=1 needs BENCH_AGENT_MODEL=opencode-go/… for the browse_agent subagent");
  if (!process.env.BENCH_OPENCODE_KEY?.trim()) throw new Error("BENCH_NO_OPENROUTER=1 needs BENCH_OPENCODE_KEY");
  return {
    QA_JUDGE_MODEL: "off",
    VISION_MODEL: "",
    OPENROUTER_API_KEY: BLOCKED_OPENROUTER_KEY,
    // The backend pins the browse_agent subagent to BROWSE_AGENT_MODEL (OpenRouter) and ignores
    // body.model; this flag makes it take BENCH_AGENT_MODEL, which runOnce puts in body.model.
    BROWSE_AGENT_FOLLOW_REQUEST_MODEL: "true",
  };
}

export async function startLocalStack(opts: StackOptions): Promise<Stack> {
  const backendUrl = `http://127.0.0.1:${opts.backendPort}`;
  const viteOrigin = `http://127.0.0.1:${opts.vitePort}`;
  const backendHome = path.join(opts.outDir, "backend-home");
  fs.mkdirSync(backendHome, { recursive: true });

  const stepLogs: BackendStepLog[] = [];
  const backendCmd = underInfisical(
    {
      HOME: backendHome,
      PORT: String(opts.backendPort),
      HOST: "127.0.0.1",
      CORS_ALLOWED_ORIGINS: viteOrigin,
      // An OpenCode ref ("opencode-go/...") in CHAT_MODEL is a boot failure
      // (BYOK only). Boot on the OpenRouter twin; runOnce pins the real model
      // per request in body.model and adds X-OpenCode-Key.
      CHAT_MODEL: /^opencode(-go)?\//.test(opts.chatModel) ? "deepseek/deepseek-v4.1-flash" : opts.chatModel,
      BROWSE_STEP_POLICY: opts.policy,
      ...(opts.cascadeModel ? { BROWSE_CASCADE_MODEL: opts.cascadeModel } : {}),
      ...(opts.browseMode ? { BROWSE_MODE: opts.browseMode } : {}),
      // Step-model comparison (e.g. jev-latest vs the Infisical default).
      ...(process.env.BENCH_TYPESAFE_MODEL ? { TYPESAFE_MODEL: process.env.BENCH_TYPESAFE_MODEL } : {}),
      // Chat reasoning arm (default "none"; on OpenCode deepseek anything
      // else means the model reasons — levels are noise there).
      // Model arms: the browse subagent model and the OpenRouter provider order.
      ...(process.env.BENCH_BROWSE_AGENT_MODEL ? { BROWSE_AGENT_MODEL: process.env.BENCH_BROWSE_AGENT_MODEL } : {}),
      ...(process.env.BENCH_OPENROUTER_PROVIDER_ORDER ? { OPENROUTER_PROVIDER_ORDER: process.env.BENCH_OPENROUTER_PROVIDER_ORDER } : {}),
      ...(process.env.BENCH_CHAT_REASONING_EFFORT ? { CHAT_REASONING_EFFORT: process.env.BENCH_CHAT_REASONING_EFFORT } : {}),
      ...noOpenRouterEnv(opts.chatModel),
      ...noOpenRouterEnv(opts.chatModel),
      // Keep bench turns out of the shared trace DB and agent logs.
      TRACE_DATABASE_URL: "",
      ENABLE_AGENT_LOGGING: "false",
    },
    path.join(BACKEND_DIR, "node_modules/.bin/tsx"),
    ["--env-file-if-exists=.env", "src/index.ts"],
  );
  const backend = startProcess(
    "backend",
    backendCmd.cmd,
    backendCmd.args,
    BACKEND_DIR,
    process.env,
    path.join(opts.outDir, `backend-${opts.policy}.log`),
    (line) => {
      if (!line.includes("browse step decided")) return;
      try {
        const rec = JSON.parse(line) as { time: number; browseStep: Omit<BackendStepLog, "time"> };
        stepLogs.push({ time: rec.time, ...rec.browseStep });
      } catch {
        // non-JSON line
      }
    },
  );

  const viteCmd = underInfisical(
    { VITE_AI_API_URL: `${backendUrl}/api/chat` },
    path.join(FRONTEND_DIR, "node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", String(opts.vitePort), "--strictPort"],
  );
  const vite = startProcess("vite", viteCmd.cmd, viteCmd.args, FRONTEND_DIR, process.env,
    path.join(opts.outDir, "vite.log"),
  );

  try {
    await Promise.all([
      waitForHttp(`${backendUrl}/api/models`, backend, "backend"),
      waitForHttp(`${viteOrigin}/app`, vite, "vite"),
    ]);
  } catch (err) {
    await Promise.all([kill(backend), kill(vite)]);
    throw err;
  }

  return {
    editorUrl: `${viteOrigin}/app`,
    backendUrl,
    stepLogs: (from, to) => stepLogs.filter((l) => l.time >= from && l.time <= to),
    stop: async () => {
      await Promise.all([kill(backend), kill(vite)]);
    },
  };
}
