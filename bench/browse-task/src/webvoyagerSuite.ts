// WebVoyager scenario group (`--scenarios @webvoyager`). Built from data/webvoyager/sample.json
// (npm run wv:prepare). Missing file = empty group.
// Oracle: the end-state LLM judge on the agent tab, in "reply is the answer" mode, with the
// 2023 reference answer as the checklist. Not the WebVoyager GPT-4V auto-evaluator.

import fs from "node:fs";
import type { Scenario } from "./scenarios.ts";
import { verdict } from "./verdict.ts";
import { WV_SAMPLE, scenarioId, type WvSample, type WvTask } from "./webvoyager.ts";

export function loadWvSample(): WvSample | null {
  try {
    return JSON.parse(fs.readFileSync(WV_SAMPLE, "utf8")) as WvSample;
  } catch {
    return null;
  }
}

export function wvEndCheck(t: WvTask): string {
  const ref = `Reference answer (recorded in 2023): "${t.ref_answer}".`;
  const kind =
    t.ref_type === "golden"
      ? "Reference type GOLDEN: the final reply must match this answer in substance (same item/value/count; wording and formatting may differ)."
      : "Reference type POSSIBLE: this is ONE acceptable answer, not the only one. The live site has changed since 2023, so another answer is fine when it satisfies every constraint in the question and the end state supports it; a reply that does not match and is not supported by the page is not complete.";
  const note = t.notice ? ` Note on this site: ${t.notice}.` : "";
  return (
    `The task is complete when the agent's final reply (together with the page it ended on) answers the question: "${t.ques}" ` +
    `${ref} ${kind}${note} An answer that only says what was clicked, or that refuses or gives up, is not complete.`
  );
}

function build(t: WvTask, today: string): Scenario {
  const goal =
    `Open ${t.web}. ${t.ques} Do not sign in, do not buy or book anything, and do not submit personal data. ` +
    `Today is ${today}; if a date has no year, use its next occurrence. ` +
    `When done, reply with the answer or what the page now shows.`;
  return {
    id: scenarioId(t),
    about: `webvoyager ${t.web_name}: ${t.ques.slice(0, 80)}`,
    minSteps: 6,
    start: async () => ({
      url: t.web,
      goal,
      endUrl: "agent-tab",
      endCheck: wvEndCheck(t),
      endReplyIsAnswer: true,
      // Cheap sanity only; the judge decides.
      verify: ({ finalText }) => verdict({ replied: finalText.trim().length > 0 }),
      close: async () => {},
    }),
  };
}

const sample = loadWvSample();
export const WV_SUITE: Scenario[] = (sample?.tasks ?? []).map((t) => build(t, sample!.today));
