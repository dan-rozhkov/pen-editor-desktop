// Online-Mind2Web scenario group (`--scenarios @om2w`). Built from
// data/om2w/sample.json (npm run om2w:prepare). Missing file = empty group.
// Oracle: the LLM end-state judge on the agent tab, checklist = official key points.

import fs from "node:fs";
import type { Scenario } from "./scenarios.ts";
import { verdict } from "./verdict.ts";
import { OM2W_SAMPLE, scenarioId, type Om2wSample, type Om2wTask } from "./om2w.ts";

export function loadOm2wSample(): Om2wSample | null {
  try {
    return JSON.parse(fs.readFileSync(OM2W_SAMPLE, "utf8")) as Om2wSample;
  } catch {
    return null;
  }
}

function keyPointLines(kp: string): string {
  return kp
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

function build(t: Om2wTask): Scenario {
  const site = /^https?:\/\//i.test(t.website) ? t.website : `https://${t.website}`;
  const goal =
    `Open ${site}. ${t.confirmed_task} Do not sign in, do not buy or book anything, and do not submit personal data. ` +
    `When done, reply with the answer or what the page now shows.`;
  const endCheck = `The final state must satisfy all of these key points: ${keyPointLines(t.key_points)}`;
  return {
    id: scenarioId(t.task_id),
    about: `om2w ${t.level}: ${t.confirmed_task.slice(0, 80)}`,
    minSteps: t.reference_length ?? 8,
    start: async () => ({
      url: site,
      goal,
      endUrl: "agent-tab",
      endCheck,
      // Cheap sanity only; the judge decides.
      verify: ({ finalText }) => verdict({ replied: finalText.trim().length > 0 }),
      close: async () => {},
    }),
  };
}

export const OM2W_SUITE: Scenario[] = (loadOm2wSample()?.tasks ?? []).map(build);
