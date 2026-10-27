import path from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKSPACE_DIR = process.env.BENCH_WORKSPACE ? path.resolve(process.env.BENCH_WORKSPACE) : path.resolve(BENCH_DIR, "../../..");
/** bench/ lives in pen-editor-desktop: by default it runs the desktop repo that holds it. */
export const DESKTOP_DIR = process.env.BENCH_WORKSPACE ? path.join(WORKSPACE_DIR, "pen-editor-desktop") : path.resolve(BENCH_DIR, "../..");
export const FRONTEND_DIR = path.join(WORKSPACE_DIR, "pen-editor");
export const BACKEND_DIR = path.join(WORKSPACE_DIR, "pen-editor-backend");
export const RESULTS_DIR = path.join(BENCH_DIR, "results");
/** Tracked per-run summaries (bench/reports/<run>.md); raw outputs stay in the ignored RESULTS_DIR. */
export const REPORTS_DIR = path.resolve(BENCH_DIR, "../reports");
