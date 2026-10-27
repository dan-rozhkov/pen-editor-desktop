// Shared types and paths for the Online-Mind2Web (OM2W) group.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OM2W_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/om2w");
export const OM2W_SAMPLE = path.join(OM2W_DIR, "sample.json");

export type Level = "easy" | "medium" | "hard";

export interface Om2wTask {
  task_id: string;
  confirmed_task: string;
  website: string;
  level: Level | string;
  reference_length?: number;
  key_points: string;
  /** Published final_eval (1 = success, 0 = fail); null when the task is absent from that set. */
  browser_use: number | null;
  operator: number | null;
}

export interface Om2wSample {
  seed: string;
  n: number;
  tasks: Om2wTask[];
}

export const scenarioId = (taskId: string) => `om2w-${taskId.slice(0, 8)}`;
