// Shared types and paths for the WebVoyager (He et al. 2024) group.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WV_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/webvoyager");
export const WV_SAMPLE = path.join(WV_DIR, "sample.json");
export const WV_TASKS_FILE = path.join(WV_DIR, "WebVoyager_data.jsonl");
export const WV_REFERENCE_FILE = path.join(WV_DIR, "reference_answer.json");

export type RefType = "golden" | "possible";

export interface WvTask {
  /** Original id, e.g. "Allrecipes--3". */
  id: string;
  web_name: string;
  web: string;
  ques: string;
  /** Reference answer recorded in 2023 on the live site. */
  ref_answer: string;
  /** golden = must match; possible = one acceptable answer (live site has changed since). */
  ref_type: RefType | string;
  /** Per-site note from reference_answer.json, e.g. "review information is real-time". */
  notice?: string;
  /** Published pass/fail of Browser Use for this id; null = no per-task file exists (see README / report header). */
  browser_use: number | null;
}

export interface WvSample {
  seed: string;
  n: number;
  /** The date the sample was prepared; the goal tells the agent about it so no-year dates resolve to the future. */
  today: string;
  perSite: number;
  /** How many tasks each rule dropped from the 642-task pool (a task is counted under its first matching reason). */
  excluded: Record<string, number>;
  /** Usable tasks left per site before sampling. */
  usablePerSite: Record<string, number>;
  tasks: WvTask[];
}

/** Site -> group for the per-group totals in the report. */
export const SITE_GROUPS: Record<string, string> = {
  Allrecipes: "shopping/food",
  Amazon: "shopping/food",
  Apple: "shopping/food",
  Booking: "travel/maps",
  "Google Flights": "travel/maps",
  "Google Map": "travel/maps",
  ArXiv: "reference/knowledge",
  "Cambridge Dictionary": "reference/knowledge",
  Coursera: "reference/knowledge",
  "Wolfram Alpha": "reference/knowledge",
  "BBC News": "news/search/dev",
  ESPN: "news/search/dev",
  GitHub: "news/search/dev",
  "Google Search": "news/search/dev",
  Huggingface: "news/search/dev",
};

export const scenarioId = (t: Pick<WvTask, "id">) =>
  `wv-${t.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{3,}/g, "--").replace(/^-|-$/g, "")}`;
