// Deterministic, LLM-free benchmark of the window.penDesktop.browser bridge
// (src/main/browser/controller.ts) — speed (Part A) and reliability
// (Part B). No chat, no model, no network beyond localhost: every fixture
// page and the driving script are hand-authored, so a run is reproducible
// and its result is a property of the bridge's *implementation*, not of an
// LLM's behavior on a given day.
//
// Matched by playwright.bench.config.ts (testMatch: bench-*.spec.ts) and
// excluded from the default suite by playwright.config.ts's testIgnore —
// same shape as e2e/bench-browse.spec.ts. It is deliberately copied
// verbatim between worktrees/checkouts to get an apples-to-apples baseline,
// so it must use ONLY window.penDesktop.browser commands that already exist:
// open, act, perform, snapshot, read (see src/preload/tab.ts). No new
// commands or argument shapes are introduced here.
//
// Part A launches the real Electron shell (electron.launch) against a stub
// editor page — copied from e2e/browser-shop-fixture.spec.ts's approach —
// and drives the bench-shop checkout flow BENCH_ACTION_REPS times (default
// 3), timing every bridge call (page.evaluate round trip, performance.now()
// around it) and bucketing durations by op type. A fixed-overhead sequence
// (10 `act press`, 10 non-navigating `act click`, 5 `act wait`, plus a
// handful of direct `perform` calls) runs once per rep against a dedicated
// e2e/fixtures/bench-hard/server.ts page, so perform:CLICK/TYPE_TEXT/SELECT
// get their own samples too, not just the act:* paths the shop flow already
// exercises.
//
// Part B drives ten single-purpose fixture pages (e2e/fixtures/bench-hard/),
// each with an agent-style strategy (snapshot → act by index; if not found,
// act by target text — see each case for exceptions), and reads the page's
// own success flag back through the bridge's `read` command (never via
// Playwright's direct DOM access of the inner view — the bridge itself is
// what's being measured). A case failing is not a test failure: this file's
// only hard failures are harness malfunctions (the stub editor never
// loading, the shop/hard servers never starting).

import { test, expect, _electron as electron, type Page } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startBenchShopServer, type BenchShopServer } from "./fixtures/bench-shop/server";
import { startBenchHardServer, type BenchHardServer } from "./fixtures/bench-hard/server";

const REPS = Math.max(1, Number(process.env.BENCH_ACTION_REPS ?? "3") || 3);
const LABEL = process.env.BENCH_LABEL ?? "run";
const CASE_TIMEOUT_MS = 30_000;

let editorServer: http.Server;
let editorBaseUrl: string;
let shop: BenchShopServer;
let hard: BenchHardServer;

test.beforeAll(async () => {
  editorServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>
        if (window.penDesktop) { window.penDesktop.setDocumentTitle('Stub'); }
      </script>`);
  });
  await new Promise<void>((resolve) => editorServer.listen(0, "127.0.0.1", resolve));
  editorBaseUrl = `http://127.0.0.1:${(editorServer.address() as AddressInfo).port}`;
  shop = await startBenchShopServer();
  hard = await startBenchHardServer();
});

test.afterAll(async () => {
  await new Promise<void>((r) => editorServer.close(() => r()));
  await shop.close();
  await hard.close();
});

// --- bridge plumbing -------------------------------------------------------

interface SnapshotElement {
  index: number;
  tag: string;
  label: string;
  ops: string[];
  checked?: boolean;
  options?: string[];
  value?: string;
  hasValue?: boolean;
}

interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  snapshotId: string;
  error?: string;
}

interface BridgeResult {
  [key: string]: unknown;
  error?: string;
  text?: string;
}

type BridgeMethod = "open" | "act" | "perform" | "snapshot" | "read";

function callBrowser(page: Page, method: BridgeMethod, args?: Record<string, unknown>): Promise<BridgeResult> {
  return page.evaluate(
    ({ method, args }) => {
      const bridge = (
        window as unknown as {
          penDesktop: { browser: Record<string, (a?: Record<string, unknown>) => Promise<BridgeResult>> };
        }
      ).penDesktop.browser;
      return bridge[method](args);
    },
    { method, args },
  );
}

// --- Part A: speed -----------------------------------------------------

class OpStats {
  private samples: Record<string, number[]> = {};

  record(op: string, ms: number): void {
    (this.samples[op] ??= []).push(ms);
  }

  summary(): Record<string, { count: number; totalMs: number; meanMs: number; p50Ms: number; maxMs: number }> {
    const out: Record<string, { count: number; totalMs: number; meanMs: number; p50Ms: number; maxMs: number }> = {};
    for (const [op, samples] of Object.entries(this.samples)) {
      const sorted = [...samples].sort((a, b) => a - b);
      const total = samples.reduce((a, b) => a + b, 0);
      out[op] = {
        count: samples.length,
        totalMs: round2(total),
        meanMs: round2(total / samples.length),
        p50Ms: round2(sorted[Math.floor(sorted.length / 2)]),
        maxMs: round2(sorted[sorted.length - 1]),
      };
    }
    return out;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Times the bridge round trip (page.evaluate → IPC → BrowserController →
// page script → back) and buckets it under `opKey` — "open" | "snapshot" |
// "read" | "act:<action>" | "perform:<operation>".
async function timedCall(
  page: Page,
  stats: OpStats,
  opKey: string,
  method: BridgeMethod,
  args?: Record<string, unknown>,
): Promise<BridgeResult> {
  const start = performance.now();
  const result = await callBrowser(page, method, args);
  stats.record(opKey, performance.now() - start);
  return result;
}

async function timedAct(page: Page, stats: OpStats, args: Record<string, unknown>): Promise<BridgeResult> {
  const action = typeof args.action === "string" ? args.action : "unknown";
  return timedCall(page, stats, `act:${action}`, "act", args);
}

async function timedPerform(page: Page, stats: OpStats, args: Record<string, unknown>): Promise<BridgeResult> {
  const operation = typeof args.operation === "string" ? args.operation : "unknown";
  return timedCall(page, stats, `perform:${operation}`, "perform", args);
}

/** The bench-shop checkout flow, timed step by step. Mirrors the sequence
 * e2e/browser-shop-fixture.spec.ts drives, minus its assertions — this file
 * only cares about latency, and repeating the flow BENCH_ACTION_REPS times
 * against the same session (cookies persist across reps in the same
 * browser tab) accumulates cart/order state across reps, which is fine:
 * nothing here depends on exact counts. */
async function runShopFlowOnce(editorPage: Page, stats: OpStats): Promise<void> {
  await timedCall(editorPage, stats, "open", "open", { url: shop.url });
  await timedAct(editorPage, stats, { action: "type", target: "#search-input", text: "headphones" });
  await timedAct(editorPage, stats, { action: "press", key: "Enter", target: "#search-input" });
  await timedAct(editorPage, stats, { action: "click", target: "#accept-cookies" });
  await timedAct(editorPage, stats, { action: "type", target: "#search-input", text: "headphones" });
  await timedAct(editorPage, stats, { action: "press", key: "Enter", target: "#search-input" });
  await timedAct(editorPage, stats, { action: "hover", target: "Categories" });

  const brandSnapshot = (await timedCall(editorPage, stats, "snapshot", "snapshot")) as unknown as SnapshotResult;
  const audioNovaIndex = brandSnapshot.elements?.find((e) => e.tag === "input" && e.label === "AudioNova")?.index;
  if (audioNovaIndex !== undefined) {
    await timedAct(editorPage, stats, { action: "click", index: audioNovaIndex, snapshotId: brandSnapshot.snapshotId });
  }
  await timedAct(editorPage, stats, { action: "click", target: "#filter-wireless" });
  await timedAct(editorPage, stats, { action: "type", target: "#filter-price-max", text: "100" });

  const sortSnapshot = (await timedCall(editorPage, stats, "snapshot", "snapshot")) as unknown as SnapshotResult;
  const sortIndex = sortSnapshot.elements?.find((e) => e.tag === "select")?.index;
  if (sortIndex !== undefined) {
    await timedAct(editorPage, stats, { action: "select", index: sortIndex, snapshotId: sortSnapshot.snapshotId, text: "Rating" });
  }

  await timedAct(editorPage, stats, { action: "click", target: "AudioNova Studio Wireless" });
  await timedAct(editorPage, stats, { action: "click", target: "#add-to-cart" });
  await timedAct(editorPage, stats, { action: "click", target: "#go-to-cart" });
  await timedAct(editorPage, stats, { action: "click", target: "#checkout-link" });
  await timedAct(editorPage, stats, { action: "click", target: "#checkout-submit" }); // bad submit, deliberately
  await timedAct(editorPage, stats, { action: "type", target: "#checkout-name", text: "Test User" });
  await timedAct(editorPage, stats, { action: "type", target: "#checkout-email", text: "test@example.com" });

  const countrySnapshot = (await timedCall(editorPage, stats, "snapshot", "snapshot")) as unknown as SnapshotResult;
  const countryIndex = countrySnapshot.elements?.find((e) => e.tag === "select")?.index;
  if (countryIndex !== undefined) {
    await timedAct(editorPage, stats, {
      action: "select",
      index: countryIndex,
      snapshotId: countrySnapshot.snapshotId,
      text: "Germany",
    });
  }
  const standardIndex = countrySnapshot.elements?.find((e) => e.label.startsWith("Standard"))?.index;
  if (standardIndex !== undefined) {
    await timedAct(editorPage, stats, { action: "click", index: standardIndex, snapshotId: countrySnapshot.snapshotId });
  }
  await timedAct(editorPage, stats, { action: "click", target: "#checkout-terms" });
  await timedAct(editorPage, stats, { action: "click", target: "#checkout-submit" });
  await timedCall(editorPage, stats, "read", "read", {});
}

/** 10 `act press`, 10 non-navigating `act click`, 5 `act wait` (default ms),
 * plus one direct `perform` CLICK/TYPE_TEXT/SELECT each — the "explicit
 * sequence" fixed-overhead measurement, run against dedicated pages so it
 * never depends on the shop flow's DOM. */
async function runOverheadSequence(editorPage: Page, stats: OpStats): Promise<void> {
  await timedCall(editorPage, stats, "open", "open", { url: `${hard.url}/overhead-bench` });

  for (let i = 0; i < 10; i++) {
    await timedAct(editorPage, stats, { action: "click", target: `Click ${i}` });
  }
  for (let i = 0; i < 10; i++) {
    await timedAct(editorPage, stats, i === 0 ? { action: "press", key: "Tab", target: "#focus-input" } : { action: "press", key: "Tab" });
  }
  for (let i = 0; i < 5; i++) {
    await timedAct(editorPage, stats, { action: "wait" });
  }
  await timedAct(editorPage, stats, { action: "scroll", amount: 1 });
  await timedAct(editorPage, stats, { action: "scroll", amount: -1 });

  const snap = (await timedCall(editorPage, stats, "snapshot", "snapshot")) as unknown as SnapshotResult;
  // All 10 buttons above have already relabeled themselves to "clicked-N"
  // by this point — match on tag, not on the original "Click N" label.
  const clickEl = snap.elements?.find((e) => e.tag === "button");
  if (clickEl) {
    await timedPerform(editorPage, stats, { operation: "CLICK", index: clickEl.index, snapshotId: snap.snapshotId });
  }
  const inputEl = snap.elements?.find((e) => e.tag === "input");
  if (inputEl) {
    await timedPerform(editorPage, stats, { operation: "TYPE_TEXT", index: inputEl.index, snapshotId: snap.snapshotId, text: "hi" });
  }

  await timedCall(editorPage, stats, "open", "open", { url: `${hard.url}/native-select` });
  const selectSnap = (await timedCall(editorPage, stats, "snapshot", "snapshot")) as unknown as SnapshotResult;
  const selectEl = selectSnap.elements?.find((e) => e.tag === "select");
  if (selectEl) {
    await timedPerform(editorPage, stats, { operation: "SELECT", index: selectEl.index, snapshotId: selectSnap.snapshotId, text: "Germany" });
  }
}

// --- Part B: reliability -------------------------------------------------

interface CaseResult {
  name: string;
  pass: boolean;
  error?: string;
  ms: number;
}

/** Generic agent-style strategy: snapshot, find by exact label; if present,
 * act by index+snapshotId; otherwise fall back to act with the label as a
 * free-text target. Used by every case except inner-scroll (its own
 * scroll-retry loop) and slow-network-result/spinner-then-button (their own
 * timing-sensitive strategies), per the case list below. */
async function actByLabelOrTarget(editorPage: Page, action: "click", label: string): Promise<BridgeResult> {
  const snap = (await callBrowser(editorPage, "snapshot")) as unknown as SnapshotResult;
  const found = snap.elements?.find((e) => e.label.toLowerCase() === label.toLowerCase());
  if (found) {
    return callBrowser(editorPage, "act", { action, index: found.index, snapshotId: snap.snapshotId });
  }
  return callBrowser(editorPage, "act", { action, target: label });
}

function textHas(result: BridgeResult, needle: string): boolean {
  const text = typeof result.text === "string" ? result.text : "";
  return text.includes(needle);
}

async function caseShadowDom(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/shadow-dom` });
  await actByLabelOrTarget(editorPage, "click", "Shadow Buy");
  const read = await callBrowser(editorPage, "read", {});
  return { pass: textHas(read, "OK"), error: textHas(read, "OK") ? undefined : `page text did not contain OK: ${JSON.stringify(read.text)}` };
}

async function caseIframeSameOrigin(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/iframe-same-origin` });
  await actByLabelOrTarget(editorPage, "click", "Frame Buy");
  const read = await callBrowser(editorPage, "read", {});
  return { pass: textHas(read, "OK"), error: textHas(read, "OK") ? undefined : `page text did not contain OK: ${JSON.stringify(read.text)}` };
}

async function casePointerdownMenu(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/pointerdown-menu` });
  await actByLabelOrTarget(editorPage, "click", "Open Menu");
  await actByLabelOrTarget(editorPage, "click", "Menu Item");
  const read = await callBrowser(editorPage, "read", {});
  return { pass: textHas(read, "OK"), error: textHas(read, "OK") ? undefined : `page text did not contain OK: ${JSON.stringify(read.text)}` };
}

async function caseTrustedClick(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/trusted-click` });
  await actByLabelOrTarget(editorPage, "click", "Trusted Buy");
  const read = await callBrowser(editorPage, "read", {});
  return { pass: textHas(read, "OK"), error: textHas(read, "OK") ? undefined : `page text did not contain OK: ${JSON.stringify(read.text)}` };
}

async function caseInnerScroll(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/inner-scroll` });
  let target: SnapshotElement | undefined;
  let lastSnapshot: SnapshotResult | undefined;
  for (let attempt = 0; attempt <= 5; attempt++) {
    lastSnapshot = (await callBrowser(editorPage, "snapshot")) as unknown as SnapshotResult;
    target = lastSnapshot.elements?.find((e) => e.label === "Row 55");
    if (target || attempt === 5) break;
    await callBrowser(editorPage, "act", { action: "scroll", amount: 1 });
  }
  if (!target || !lastSnapshot) {
    return {
      pass: false,
      error: "Row 55 never appeared in a snapshot after 5 act-scroll retries.",
    };
  }
  await callBrowser(editorPage, "act", { action: "click", index: target.index, snapshotId: lastSnapshot.snapshotId });
  const read = await callBrowser(editorPage, "read", {});
  return { pass: textHas(read, "OK"), error: textHas(read, "OK") ? undefined : `page text did not contain OK: ${JSON.stringify(read.text)}` };
}

async function caseReactLikeInput(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/react-like-input` });
  const snap = (await callBrowser(editorPage, "snapshot")) as unknown as SnapshotResult;
  const inputEl = snap.elements?.find((e) => e.tag === "input");
  if (inputEl) {
    await callBrowser(editorPage, "act", { action: "type", index: inputEl.index, snapshotId: snap.snapshotId, text: "hello" });
  } else {
    await callBrowser(editorPage, "act", { action: "type", target: "Name Input", text: "hello" });
  }
  const read = await callBrowser(editorPage, "read", {});
  const text = typeof read.text === "string" ? read.text : "";
  const valueOk = text.includes("hello");
  const keydownMatch = /keydowns:(\d+)/.exec(text);
  const keydownCount = keydownMatch ? Number(keydownMatch[1]) : 0;
  const keydownOk = keydownCount > 0;
  return {
    pass: valueOk && keydownOk,
    error:
      valueOk && keydownOk
        ? undefined
        : `value sub-flag=${valueOk} (text=${JSON.stringify(text)}), keydown sub-flag=${keydownOk} (count=${keydownCount})`,
  };
}

async function caseSlowNetworkResult(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/slow-network-result` });
  await actByLabelOrTarget(editorPage, "click", "Load");
  // No explicit wait — this is the point of the case: does the click's own
  // settle, or the very next read with no delay, already see the fetch
  // result that lands 1200ms later?
  const read = await callBrowser(editorPage, "read", {});
  return {
    pass: textHas(read, "Loaded 42"),
    error: textHas(read, "Loaded 42") ? undefined : `immediate read did not contain "Loaded 42": ${JSON.stringify(read.text)}`,
  };
}

async function caseSpinnerThenButton(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/spinner-then-button` });
  let snap = (await callBrowser(editorPage, "snapshot")) as unknown as SnapshotResult;
  let target = snap.elements?.find((e) => e.label === "Late Buy");
  if (!target) {
    // Default `act wait` (no ms/text) — bounded sleep, WAIT_DEFAULT_MS
    // (3000ms in controller.ts), comfortably longer than the fixture's
    // 1500ms spinner.
    await callBrowser(editorPage, "act", { action: "wait" });
    snap = (await callBrowser(editorPage, "snapshot")) as unknown as SnapshotResult;
    target = snap.elements?.find((e) => e.label === "Late Buy");
  }
  if (!target) {
    return { pass: false, error: "Late Buy never appeared in a snapshot, even after act wait." };
  }
  await callBrowser(editorPage, "act", { action: "click", index: target.index, snapshotId: snap.snapshotId });
  const read = await callBrowser(editorPage, "read", {});
  return { pass: textHas(read, "OK"), error: textHas(read, "OK") ? undefined : `page text did not contain OK: ${JSON.stringify(read.text)}` };
}

async function caseCookieBannerIframe(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/cookie-banner-iframe` });
  await actByLabelOrTarget(editorPage, "click", "Accept all");
  const read = await callBrowser(editorPage, "read", {});
  return {
    pass: textHas(read, "consent ok"),
    error: textHas(read, "consent ok") ? undefined : `page text did not contain "consent ok": ${JSON.stringify(read.text)}`,
  };
}

async function caseNativeSelect(editorPage: Page): Promise<{ pass: boolean; error?: string }> {
  await callBrowser(editorPage, "open", { url: `${hard.url}/native-select` });
  const snap = (await callBrowser(editorPage, "snapshot")) as unknown as SnapshotResult;
  const selectEl = snap.elements?.find((e) => e.tag === "select");
  if (!selectEl) {
    return { pass: false, error: "No <select> element found in snapshot." };
  }
  await callBrowser(editorPage, "act", { action: "select", index: selectEl.index, snapshotId: snap.snapshotId, text: "Germany" });
  const read = await callBrowser(editorPage, "read", {});
  return { pass: textHas(read, "OK"), error: textHas(read, "OK") ? undefined : `page text did not contain OK: ${JSON.stringify(read.text)}` };
}

const RELIABILITY_CASES: { name: string; run: (editorPage: Page) => Promise<{ pass: boolean; error?: string }> }[] = [
  { name: "shadow-dom", run: caseShadowDom },
  { name: "iframe-same-origin", run: caseIframeSameOrigin },
  { name: "pointerdown-menu", run: casePointerdownMenu },
  { name: "trusted-click", run: caseTrustedClick },
  { name: "inner-scroll", run: caseInnerScroll },
  { name: "react-like-input", run: caseReactLikeInput },
  { name: "slow-network-result", run: caseSlowNetworkResult },
  { name: "spinner-then-button", run: caseSpinnerThenButton },
  { name: "cookie-banner-iframe", run: caseCookieBannerIframe },
  { name: "native-select", run: caseNativeSelect },
];

async function runCaseWithTimeout(editorPage: Page, name: string, run: (p: Page) => Promise<{ pass: boolean; error?: string }>): Promise<CaseResult> {
  const start = performance.now();
  try {
    const result = await Promise.race([
      run(editorPage),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`case timed out after ${CASE_TIMEOUT_MS}ms`)), CASE_TIMEOUT_MS)),
    ]);
    return { name, pass: result.pass, error: result.error, ms: round2(performance.now() - start) };
  } catch (err) {
    return { name, pass: false, error: err instanceof Error ? err.message : String(err), ms: round2(performance.now() - start) };
  }
}

// --- the test --------------------------------------------------------------

test("bench-actions: bridge speed and reliability", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: editorBaseUrl },
  });

  try {
    const editorPage = await app.waitForEvent("window", {
      predicate: (p) => p.url().startsWith(editorBaseUrl),
    });
    await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

    // --- Part A: speed ---
    const stats = new OpStats();
    const flowWallMs: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const start = performance.now();
      await runShopFlowOnce(editorPage, stats);
      flowWallMs.push(round2(performance.now() - start));
      await runOverheadSequence(editorPage, stats);
    }

    // --- Part B: reliability ---
    const caseResults: CaseResult[] = [];
    for (const { name, run } of RELIABILITY_CASES) {
      caseResults.push(await runCaseWithTimeout(editorPage, name, run));
    }

    const passCount = caseResults.filter((c) => c.pass).length;
    const failCount = caseResults.length - passCount;

    const output = {
      label: LABEL,
      reps: REPS,
      speed: {
        perOp: stats.summary(),
        flowWallMs,
      },
      reliability: {
        cases: caseResults,
        passCount,
        failCount,
      },
    };

    const outDir = path.join(process.cwd(), "test-results", "bench");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `actions-${LABEL}-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

    // eslint-disable-next-line no-console
    console.log(`\nbench-actions [${LABEL}] — wrote ${outFile}`);
    // eslint-disable-next-line no-console
    console.log(`\nSpeed (reps=${REPS}):`);
    // eslint-disable-next-line no-console
    console.log("op".padEnd(20) + "count".padStart(8) + "meanMs".padStart(10) + "p50Ms".padStart(10) + "maxMs".padStart(10));
    for (const [op, s] of Object.entries(output.speed.perOp)) {
      // eslint-disable-next-line no-console
      console.log(
        op.padEnd(20) + String(s.count).padStart(8) + String(s.meanMs).padStart(10) + String(s.p50Ms).padStart(10) + String(s.maxMs).padStart(10),
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\nFlow wall time per rep (ms): ${flowWallMs.join(", ")}`);

    // eslint-disable-next-line no-console
    console.log(`\nReliability: ${passCount} passed, ${failCount} failed (of ${caseResults.length})`);
    for (const c of caseResults) {
      // eslint-disable-next-line no-console
      console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(22)} ${c.ms}ms${c.error ? `  — ${c.error}` : ""}`);
    }

    // The only hard assertion: the harness itself worked (stub editor
    // loaded, the shop flow could open a page, at least one op was timed).
    // Individual case pass/fail is data, not a test outcome — several
    // reliability cases are EXPECTED to fail on today's bridge; that's the
    // point of this benchmark.
    expect(Object.keys(output.speed.perOp).length).toBeGreaterThan(0);
    expect(flowWallMs.length).toBe(REPS);

    await app.close();
  } finally {
    await app.close().catch(() => {});
  }
});
