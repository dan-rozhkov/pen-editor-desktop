// Success oracle for live scenarios: an LLM judge compares the page state the
// agent left behind (end-state.txt) with the goal and a checklist, instead of
// trusting a regex over the agent's reply.
//
// Secrets: the OpenRouter key is not in the bench's own environment. The call
// runs in a small worker (judgeWorker.ts) under `infisical run --env=dev` in
// the backend repo dir (its .infisical.json picks the project) — the same
// mechanism stack.ts uses. OPENROUTER_API_KEY in the env wins when present;
// BENCH_NO_INFISICAL=1 skips Infisical.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_DIR } from "./paths.ts";

export const JUDGE_MODEL = () => process.env.BENCH_JUDGE_MODEL || "google/gemini-2.5-flash";

export type JudgeVerdict = "complete" | "partial" | "fail" | "unknown";

export interface JudgeRequirement {
  need: string;
  matched_item: string | null;
  ok: boolean;
  note: string;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  requirements: JudgeRequirement[];
  extras: string[];
  duplicates: string[];
  end_state_total: string | null;
  reply_total: string | null;
  reply_matches_end_state: boolean;
  notes: string;
  model?: string;
  error?: string;
}

export interface JudgeInput {
  goal: string;
  check: string;
  endUrl?: string;
  endState: string;
  finalReply: string;
  /**
   * Question tasks (WebVoyager): the final reply IS the answer being graded, the end state is
   * corroborating evidence only. Default (false) keeps "reply is a claim, judge from the page".
   */
  replyIsAnswer?: boolean;
}

const STATE_ONLY_RULE = "Judge ONLY from the end-state text: the reply is a claim, not evidence. ";
const REPLY_ANSWER_RULE =
  "This task is a QUESTION and the agent's final reply is the ANSWER being graded; the end-state text is only corroborating evidence of where the agent ended up. " +
  "A requirement is ok when the reply states it correctly (matching the checklist and any reference answer in substance) AND the end state does not contradict it. " +
  "If the end state simply does not display a fact that the reply states and that matches the reference answer, that is still ok (set matched_item to the reply's statement). " +
  "A reply that contradicts the checklist, gives no concrete answer, claims it could not do the task, or is contradicted by the end state is not ok. " +
  "The reference answer was recorded in 2023 on a live site: when the checklist says the answer is only ONE acceptable answer, a different answer that the end state supports and that satisfies the question's constraints is also ok. " +
  "reply_matches_end_state = false only when the end state contradicts the reply; when the end state is merely silent, set it true. ";

export function buildPrompt(i: JudgeInput): { system: string; user: string } {
  const system =
    "You are a strict QA judge for a browser agent. You get the user's goal, a checklist of what the final page state must contain, " +
    "the text of a page read AFTER the agent finished (the end state), and the agent's final reply. " +
    (i.replyIsAnswer ? REPLY_ANSWER_RULE : STATE_ONLY_RULE) +
    "Split the checklist into one requirement per NEED (an item, field or fact that must be present); rules such as \"no duplicates\" or \"no unrelated items\" are NOT requirements, they are reported in duplicates / extras and affect the verdict.  for each, find the item in the end state that satisfies it (matched_item, or null) and set ok. " +
    "extras = items in the end state that no requirement asks for. Recommendation blocks (\"you may also like\", \"everyday essentials\", related or sponsored products) and optional services the page merely offers are page furniture, not extras: count only items the user actually has (in the cart, applied as a filter, selected). duplicates = the same thing present more than once. " +
    "end_state_total / reply_total = the total price or count shown in the end state / claimed in the reply, as written, or null. " +
    "reply_matches_end_state = true only if EVERY item, count and total the reply claims is present in the end state and nothing the reply omits is there; a reply that claims an item the end state lacks is false. " +
    "verdict: complete = every requirement ok, no duplicates, no unrelated extras; partial = some ok; fail = none ok; " +
    "unknown = the end state is empty, a login/captcha/error page, or otherwise cannot show the result. " +
    'Reply with ONE JSON object and nothing else: {"verdict":"complete|partial|fail|unknown","requirements":[{"need":string,"matched_item":string|null,"ok":boolean,"note":string}],"extras":[string],"duplicates":[string],"end_state_total":string|null,"reply_total":string|null,"reply_matches_end_state":boolean,"notes":string}';
  const user = [
    `# Goal\n${i.goal}`,
    `# Checklist\n${i.check}`,
    `# End state${i.endUrl ? ` (read from ${i.endUrl})` : ""}\n${i.endState || "(empty)"}`,
    `# Agent's final reply\n${i.finalReply || "(empty)"}`,
  ].join("\n\n");
  return { system, user };
}

/** Tolerant parse: strips code fences, takes the outermost object, fills defaults. */
export function parseJudge(raw: string): JudgeResult {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const j = JSON.parse(s) as Partial<JudgeResult>;
  const verdicts: JudgeVerdict[] = ["complete", "partial", "fail", "unknown"];
  const strs = (x: unknown) => (Array.isArray(x) ? x.map((v) => String(v)) : []);
  return {
    verdict: verdicts.includes(j.verdict as JudgeVerdict) ? (j.verdict as JudgeVerdict) : "unknown",
    requirements: (Array.isArray(j.requirements) ? j.requirements : []).map((r) => ({
      need: String(r?.need ?? ""),
      matched_item: r?.matched_item == null ? null : String(r.matched_item),
      ok: r?.ok === true,
      note: String(r?.note ?? ""),
    })),
    extras: strs(j.extras),
    duplicates: strs(j.duplicates),
    end_state_total: j.end_state_total == null ? null : String(j.end_state_total),
    reply_total: j.reply_total == null ? null : String(j.reply_total),
    reply_matches_end_state: j.reply_matches_end_state === true,
    notes: String(j.notes ?? ""),
  };
}

/** Raw OpenRouter call; needs OPENROUTER_API_KEY in this process's env. */
export async function callJudge(input: JudgeInput): Promise<JudgeResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing");
  const model = JUDGE_MODEL();
  const { system, user } = buildPrompt(input);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content ?? "";
  return { ...parseJudge(content), model };
}

/**
 * Run the judge from the bench process: directly when the key is in the env,
 * else through the Infisical-wrapped worker. Never throws — a failed call is
 * a verdict "unknown" with `error`.
 */
export async function runJudge(input: JudgeInput, scratchDir: string): Promise<JudgeResult> {
  const fail = (error: string): JudgeResult => ({
    verdict: "unknown", requirements: [], extras: [], duplicates: [], end_state_total: null, reply_total: null,
    reply_matches_end_state: false, notes: "judge call failed", model: JUDGE_MODEL(), error,
  });
  try {
    if (process.env.OPENROUTER_API_KEY) return await callJudge(input);
    fs.mkdirSync(scratchDir, { recursive: true });
    const inFile = path.join(scratchDir, "judge-input.json");
    const outFile = path.join(scratchDir, "judge-raw.json");
    fs.rmSync(outFile, { force: true });
    fs.writeFileSync(inFile, JSON.stringify(input, null, 2));
    const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "judgeWorker.ts");
    const tsx = path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/tsx");
    const [cmd, args] =
      process.env.BENCH_NO_INFISICAL === "1"
        ? [tsx, [worker, inFile, outFile]]
        : ["infisical", ["run", "--env=dev", "--silent", "--", tsx, worker, inFile, outFile]];
    const stderr = await new Promise<string>((resolve) => {
      const child = spawn(cmd, args, { cwd: BACKEND_DIR, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr!.on("data", (d) => (err += d));
      child.on("error", (e) => resolve(String(e)));
      child.on("exit", () => resolve(err));
    });
    if (!fs.existsSync(outFile)) return fail(stderr.trim().slice(0, 400) || "worker produced no output");
    return JSON.parse(fs.readFileSync(outFile, "utf8")) as JudgeResult;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
