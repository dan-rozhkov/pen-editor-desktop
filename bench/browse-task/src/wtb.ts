// Shared types, paths, prompt and scoring for the WebTestBench (WTB) groups.
// Dataset: HF friedrichor/WebTestBench (Apache-2.0), paper arXiv 2603.25226.
// 100 Lovable-generated vite apps, each with a gold checklist (~17.5 items)
// where `pass: false` items are real defects (448 of 1,750).
//
// Two tracks, as in the paper:
//   oracle (@wtb)     — the agent gets the gold checklist and marks each item
//                       pass/fail. Scored here, deterministically, by item id
//                       (same logic as the official eval/scoring_oracle.py).
//   e2e    (@wtb-e2e) — the agent gets only the app instruction and writes its
//                       own checklist. Needs the official LLM matcher
//                       (eval/scoring.py); `npm run wtb:report` exports the
//                       official layout for it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WTB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/wtb");
export const WTB_JSONL = path.join(WTB_DIR, "WebTestBench.jsonl");
export const WTB_ZIPS = path.join(WTB_DIR, "zips");
export const WTB_APPS = path.join(WTB_DIR, "apps");
export const WTB_SAMPLE = path.join(WTB_DIR, "sample.json");

export type ItemClass = "functionality" | "constraint" | "interaction" | "content";
export const CLASSES: ItemClass[] = ["functionality", "constraint", "interaction", "content"];
const CLASS_PREFIX: Record<ItemClass, string> = { functionality: "FT", constraint: "CS", interaction: "IX", content: "CT" };

export interface WtbItem {
  id: number;
  content: string;
  class: ItemClass;
  pass: boolean;
  bug?: string;
}

export interface WtbRecord {
  index: string;
  instruction: string;
  category: string;
  checklist: WtbItem[];
}

export interface WtbSample {
  seed: string;
  ids: string[];
}

export function loadRecords(): Map<string, WtbRecord> {
  const out = new Map<string, WtbRecord>();
  let text: string;
  try {
    text = fs.readFileSync(WTB_JSONL, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as WtbRecord;
    out.set(r.index, r);
  }
  return out;
}

export const distDir = (index: string) => path.join(WTB_APPS, index, "dist");
export const isBuilt = (index: string) => fs.existsSync(path.join(distDir(index), "index.html"));
export const scenarioId = (index: string, track: "oracle" | "e2e") => `${track === "oracle" ? "wtb" : "wtbe"}-${index.slice(-4)}`;

/** Item label shown to the agent: class prefix + gold id, e.g. CS-11. */
export function itemLabel(item: WtbItem): string {
  return `${CLASS_PREFIX[item.class] ?? "IT"}-${String(item.id).padStart(2, "0")}`;
}

const RESULT_FORMAT =
  "Mark a passed item as `- [X] ID: description`. Mark a failed item as `- [ ] ID: description` " +
  "and put one indented line under it: `  - Bug: <what you saw>`. " +
  "Mark an item you could not test as `- [?] ID: description` and put one indented line under it: `  - Blocked: <why>`. " +
  "One line per item, IDs exactly as given, no other checkbox lines.";

export function oracleGoal(r: WtbRecord, url: string): string {
  const items = r.checklist.map((it) => `- [ ] ${itemLabel(it)}: ${it.content}`).join("\n");
  return (
    `Test the web app at ${url} against the checklist below and find the defects. ` +
    `It is a local test build: you may create, edit and delete data in it. ` +
    `For each item, decide the user actions that test it and the expected behavior, do them, and compare with what the app actually does. ` +
    `An item passes only if the feature works exactly as described; any deviation (missing element, wrong data, no response, error) is a fail. ` +
    `If you cannot test an item (the environment blocks it, a precondition is missing), mark it blocked, not failed, and say why. ` +
    `Before you mark a feature as missing, find the condition that makes it appear (a date or deadline, a limit, a threshold) and test at that boundary.\n\n` +
    `What the app was built to do (the developer's instruction):\n"""\n${r.instruction}\n"""\n\n` +
    `Checklist:\n${items}\n\n` +
    `When done, reply with the full checklist and nothing else. ${RESULT_FORMAT}`
  );
}

export function e2eGoal(r: WtbRecord, url: string): string {
  return (
    `Test the web app at ${url} and find its defects. ` +
    `It is a local test build: you may create, edit and delete data in it. ` +
    `First write a test checklist from the developer's instruction below: features, business rules and constraints, interactions, and content. ` +
    `Then test every item in the app.\n\n` +
    `Developer's instruction:\n"""\n${r.instruction}\n"""\n\n` +
    `When done, reply with the full checklist and nothing else. Give each item an ID such as FT-01, CS-01, IX-01, CT-01. ${RESULT_FORMAT}`
  );
}

export interface PredItem {
  id: string;
  content: string;
  /** `[X]` and `[?]` (blocked: could not test) are both pass, `[ ]` is fail. */
  pass: boolean;
  blocked: boolean;
}

// Same line grammar as the official parser (eval/scoring.py _parse_pred_checklist),
// plus tolerance for leading list indentation, `[x]` and our third state `[?]`
// (blocked). The official parser drops a `[?]` line, and a missing item counts as
// pass there, so scoring blocked as pass agrees with it. `officialText` rewrites
// `[?]` to `[X]` for the official scorers.
const LINE = /^- \[\s*([xX ?])\s*\]\s*(?:\*\*)?([A-Za-z0-9_-]+)(?:\*\*)?:\s*(.+)$/;

export function parsePredictions(text: string): PredItem[] {
  const out: PredItem[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (m) out.push({ id: m[2].trim(), content: m[3].trim(), pass: m[1] !== " ", blocked: m[1] === "?" });
  }
  return out;
}

/** The reply with every blocked `[?]` box written as `[X]` (pass), for the official scorers. */
export function officialText(text: string): string {
  return text.replace(/^(\s*- \[)\s*\?\s*(\])/gm, "$1X$2");
}

export interface Prf {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

export function prf(tp: number, fp: number, fn: number, tn: number): Prf {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

export interface OracleScore {
  overall: Prf;
  byClass: Partial<Record<ItemClass, Prf>>;
  /** Gold items with no prediction line. The official scorer counts them as predicted pass. */
  missing: string[];
  /** Per gold item: predicted pass (null = missing) vs gold pass. */
  items: { label: string; class: ItemClass; gold: boolean; pred: boolean | null }[];
}

/**
 * Oracle-track score for one app. Failure is the positive class: TP = a real
 * defect reported as failed. A missing item counts as passed, which is what
 * the official scorer does with an unmatched gold item.
 */
export function scoreOracle(r: WtbRecord, text: string): OracleScore {
  const preds = new Map(parsePredictions(text).map((p) => [p.id.toUpperCase(), p]));
  const items: OracleScore["items"] = [];
  const missing: string[] = [];
  const counts = new Map<ItemClass | "all", [number, number, number, number]>();
  const bump = (k: ItemClass | "all", i: 0 | 1 | 2 | 3) => {
    const c = counts.get(k) ?? [0, 0, 0, 0];
    c[i]++;
    counts.set(k, c);
  };
  for (const it of r.checklist) {
    const label = itemLabel(it);
    const p = preds.get(label.toUpperCase()) ?? preds.get(String(it.id));
    if (!p) missing.push(label);
    const predPass = p ? p.pass : true;
    items.push({ label, class: it.class, gold: it.pass, pred: p ? p.pass : null });
    const cell: 0 | 1 | 2 | 3 = !it.pass && !predPass ? 0 : it.pass && !predPass ? 1 : !it.pass && predPass ? 2 : 3;
    bump("all", cell);
    bump(it.class, cell);
  }
  const all = counts.get("all") ?? [0, 0, 0, 0];
  const byClass: OracleScore["byClass"] = {};
  for (const c of CLASSES) {
    const v = counts.get(c);
    if (v) byClass[c] = prf(...v);
  }
  return { overall: prf(...all), byClass, missing, items };
}

/** Oracle-setting rows of the paper's Table 11 (macro P/R/F1, %). */
export const PAPER_ORACLE: { model: string; precision: number; recall: number; f1: number }[] = [
  { model: "Claude Sonnet 4.5", precision: 61.0, recall: 47.4, f1: 49.2 },
  { model: "GPT-5.1", precision: 47.0, recall: 63.4, f1: 46.8 },
  { model: "Step-3.5-Flash", precision: 53.4, recall: 38.7, f1: 40.9 },
  { model: "MiMo-V2-Flash", precision: 44.3, recall: 30.4, f1: 31.9 },
];

/** End-to-end rows of the paper's Table 2 (Coverage/P/R/F1, %), best four. */
export const PAPER_E2E: { model: string; coverage: number; precision: number; recall: number; f1: number }[] = [
  { model: "GPT-5.1", coverage: 63.1, precision: 25.8, recall: 33.3, f1: 26.4 },
  { model: "MiMo-V2-Flash", coverage: 63.5, precision: 34.8, recall: 24.6, f1: 25.1 },
  { model: "Step-3.5-Flash", coverage: 66.0, precision: 34.6, recall: 20.8, f1: 23.4 },
  { model: "Claude Sonnet 4.5", coverage: 63.7, precision: 32.1, recall: 19.7, f1: 21.9 },
];
