// Opt-in benchmark comparing three ways the design agent can drive the
// built-in browser tab against the same task on the same fixture site:
//
//   BENCH_MODE=task   — the whole job goes to ONE browse_task call (the Jev
//                        loop drives every step; the main model only starts
//                        it and reads the transcript) — the "ultrafast" shape.
//   BENCH_MODE=jev    — the agent is told to use browse_task (the Jev-driven
//                        multi-step loop hitting POST /api/browse/step) for
//                        navigation, and browse_act's `element` field
//                        (natural-language target, resolved server-side via
//                        POST /api/browse/locate) for single actions.
//   BENCH_MODE=nojev  — the agent is told NOT to use browse_task and NOT to
//                        use `element`; it must drive browse_snapshot /
//                        browse_screenshot and browse_act by index. This
//                        mode ALSO routes /api/browse/step and
//                        /api/browse/locate to a 503 in the editor page, so
//                        any accidental Jev use fails loudly and is counted
//                        rather than silently succeeding.
//
// Both modes launch the real Electron shell against the deployed frontend
// (PEN_LIVE_URL, same default as e2e/live-prod.spec.ts), open the AI chat
// panel, and send the same task prompt (plus a mode-specific instruction
// suffix) against a local fixture shop (e2e/fixtures/bench-shop). Metrics —
// wall time, success, per-request/tool-call counts, token usage, the actual
// order POST — are written to test-results/bench/<mode>-<timestamp>.json and
// printed.
//
// `element`/`POST /api/browse/locate` do not exist in this desktop repo yet
// (backend-first rollout, still landing) — jev mode is included for when it
// does, but per this bench's own operating instructions it must not be run
// live until that backend change is deployed. Only nojev mode should be run
// for real ("BENCH_MODE=nojev BENCH_RUNS=1 npm run test:e2e:bench").
//
// NOT part of the default `npm run test:e2e` run or the live gate
// (playwright.config.ts / playwright.live.config.ts both exclude
// bench-*.spec.ts) — run explicitly via `npm run test:e2e:bench`. It spends
// real tokens on a real chat turn per run.

import { test, expect, _electron as electron, type Page, type Request } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startBenchShopServer, type OrderRecord } from "./fixtures/bench-shop/server";

const PROD_EDITOR = process.env.PEN_LIVE_URL ?? "https://pen-editor.onrender.com/app";
const editorOrigin = new URL(PROD_EDITOR).origin;

type BenchMode = "jev" | "nojev" | "task";
const BENCH_MODE: BenchMode =
  process.env.BENCH_MODE === "jev" ? "jev" : process.env.BENCH_MODE === "task" ? "task" : "nojev";
const BENCH_RUNS = Math.max(1, Number.parseInt(process.env.BENCH_RUNS ?? "1", 10) || 1);

// Wait this long with the "turn ended" signal continuously true before
// trusting it — the AI SDK's tool loop auto-continues (see
// `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` in
// pen-editor's useDesignChat), so a brief `streaming -> ready` blip between
// two tool-loop steps must not be mistaken for the turn actually finishing.
const TURN_END_DEBOUNCE_MS = 2_500;
const TURN_CAP_MS = 12 * 60_000;
const BRAND = "AudioNova";

function taskPrompt(fixtureUrl: string, mode: BenchMode): string {
  const base =
    `Open ${fixtureUrl}. Accept cookies, search for headphones, keep only wireless ones from brand ` +
    `${BRAND} under $100, sort by rating, open the top result, add it to the cart and check out as ` +
    `Test User, test@example.com, Germany, standard shipping, accept the terms. Reply with the order number.`;
  const suffix =
    mode === "task"
      ? " Hand the WHOLE browsing job to a single browse_task call with the full goal (the Jev loop drives every step). Only if it returns without finishing, continue from where it stopped with further browse_task calls or browse_act."
      : mode === "jev"
      ? " Drive the browser with browse_task for multi-step navigation, and browse_act with the `element` field for single actions."
      : " Do NOT use browse_task and do NOT use the `element` field; use browse_snapshot / browse_screenshot and browse_act by index.";
  return base + suffix;
}

interface SseChunk {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  messageMetadata?: { contextTokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** Parses an AI SDK v6 UI-message SSE body (`data: {...}\n\n` lines, `data:
 * [DONE]` terminator — see pen-editor's useDesignChat.test.ts `sseResponse`
 * helper) into its individual chunks. Tolerant of a body that isn't SSE at
 * all (an error response) — returns no chunks rather than throwing, since a
 * malformed/failed /api/chat call shouldn't crash metric collection. */
function parseSseChunks(body: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]" || payload === "") continue;
    try {
      chunks.push(JSON.parse(payload) as SseChunk);
    } catch {
      // Not a JSON data line (or a partial one) — skip rather than fail the run.
    }
  }
  return chunks;
}

interface RunMetrics {
  mode: BenchMode;
  runIndex: number;
  startedAt: string;
  wallMs: number;
  success: {
    serverRecordedMatchingOrder: boolean;
    finalMessageContainsOrderNumber: boolean;
  };
  chatRequestCount: number;
  toolCallCounts: Record<string, number>;
  browseStepRequests: { count: number; totalLatencyMs: number };
  browseLocateRequests: { count: number; totalLatencyMs: number };
  contextTokens: number | null;
  order: OrderRecord | null;
  finalAssistantMessageExcerpt: string;
}

/** Tracks request start times keyed by Request identity so a matching
 * request/requestfinished pair can report a latency even though Playwright's
 * `Request`/`Response` objects don't carry timing directly on the object we
 * see in `page.on("request")`. */
class LatencyTracker {
  count = 0;
  totalLatencyMs = 0;
  private readonly startedAt = new Map<Request, number>();

  onRequest(request: Request): void {
    this.startedAt.set(request, Date.now());
  }

  onSettled(request: Request): void {
    const start = this.startedAt.get(request);
    if (start === undefined) return;
    this.startedAt.delete(request);
    this.count += 1;
    this.totalLatencyMs += Date.now() - start;
  }
}

async function openChatPanel(page: Page): Promise<void> {
  const rail = page.locator('[data-testid="rail-agents"]');
  await rail.click();
  const createChatButton = page.locator('[data-testid="create-chat-button"]');
  if (await createChatButton.isVisible().catch(() => false)) {
    await createChatButton.click();
  }
  await expect(page.getByPlaceholder("Ask the design agent...")).toBeVisible({ timeout: 30_000 });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.getByPlaceholder("Ask the design agent...");
  await textarea.click();
  await textarea.fill(text);
  await page.locator('button[aria-label="Send"]').click();
}

/** Resolves once the turn has fully ended: no visible Stop button, sustained
 * for TURN_END_DEBOUNCE_MS (see its own doc comment), capped at TURN_CAP_MS. */
async function waitForTurnEnd(page: Page): Promise<void> {
  const stopButton = page.locator('button[aria-label="Stop"]');
  const deadline = Date.now() + TURN_CAP_MS;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    const stopVisible = await stopButton.isVisible().catch(() => false);
    if (stopVisible) {
      quietSince = null;
    } else {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= TURN_END_DEBOUNCE_MS) return;
    }
    await page.waitForTimeout(250);
  }
  // Cap reached — proceed anyway so a stuck agent still produces metrics
  // (success will simply read false) instead of failing the whole bench run.
}

async function runOnce(runIndex: number): Promise<RunMetrics> {
  const shop = await startBenchShopServer();
  const home = path.join(
    process.cwd(),
    "test-results",
    "bench",
    `home-${BENCH_MODE}-${Date.now()}-${runIndex}`,
  );
  fs.mkdirSync(home, { recursive: true });

  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: PROD_EDITOR, HOME: home, USERPROFILE: home },
  });

  const allPages: Page[] = [];
  app.windows().forEach((p) => allPages.push(p));
  app.on("window", (p) => allPages.push(p));
  const editorPages = () => allPages.filter((p) => p.url().startsWith(editorOrigin));

  try {
    await expect.poll(() => editorPages().length, { timeout: 60_000 }).toBeGreaterThan(0);
    const editorPage = editorPages()[0];
    await editorPage.waitForSelector("canvas", { timeout: 60_000 });

    const chatRequestBodies: string[] = [];
    const browseStep = new LatencyTracker();
    const browseLocate = new LatencyTracker();

    editorPage.on("response", (response) => {
      const url = response.url();
      if (url.includes("/api/chat")) {
        response
          .text()
          .then((body) => chatRequestBodies.push(body))
          .catch(() => {
            // A response that never completes (aborted, network error) simply
            // contributes no chunks — metrics stay a lower bound, not a crash.
          });
      }
    });

    if (BENCH_MODE === "nojev") {
      await editorPage.route("**/api/browse/step", async (route) => {
        browseStep.onRequest(route.request());
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "jev disabled for nojev bench mode" }),
        });
        browseStep.onSettled(route.request());
      });
      await editorPage.route("**/api/browse/locate", async (route) => {
        browseLocate.onRequest(route.request());
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "jev disabled for nojev bench mode" }),
        });
        browseLocate.onSettled(route.request());
      });
    } else {
      // jev mode: observe real /api/browse/step and /api/browse/locate
      // traffic (if the backend supports it) instead of stubbing it out.
      editorPage.on("request", (request) => {
        if (request.url().includes("/api/browse/step")) browseStep.onRequest(request);
        else if (request.url().includes("/api/browse/locate")) browseLocate.onRequest(request);
      });
      editorPage.on("requestfinished", (request) => {
        if (request.url().includes("/api/browse/step")) browseStep.onSettled(request);
        else if (request.url().includes("/api/browse/locate")) browseLocate.onSettled(request);
      });
      editorPage.on("requestfailed", (request) => {
        if (request.url().includes("/api/browse/step")) browseStep.onSettled(request);
        else if (request.url().includes("/api/browse/locate")) browseLocate.onSettled(request);
      });
    }

    await openChatPanel(editorPage);

    const startedAt = new Date();
    const startMs = Date.now();
    await sendMessage(editorPage, taskPrompt(shop.url, BENCH_MODE));
    // The Stop button takes a moment to appear after Send; give the debounce
    // loop something real to see before it can conclude the turn is over.
    await editorPage.waitForTimeout(1_000);
    await waitForTurnEnd(editorPage);
    const wallMs = Date.now() - startMs;

    const toolCallCounts: Record<string, number> = {};
    let contextTokens: number | null = null;
    for (const body of chatRequestBodies) {
      for (const chunk of parseSseChunks(body)) {
        if (chunk.type === "tool-input-available" && typeof chunk.toolName === "string") {
          toolCallCounts[chunk.toolName] = (toolCallCounts[chunk.toolName] ?? 0) + 1;
        }
        if (chunk.type === "finish" && typeof chunk.messageMetadata?.contextTokens === "number") {
          contextTokens = chunk.messageMetadata.contextTokens;
        }
      }
    }

    const orders = shop.getOrders();
    const order = orders.length > 0 ? orders[orders.length - 1] : null;
    const serverRecordedMatchingOrder =
      order !== null &&
      order.fullName === "Test User" &&
      order.email === "test@example.com" &&
      order.country === "Germany" &&
      order.shipping === "standard" &&
      order.termsAccepted === true;

    // No confirmed selector for individual chat message bubbles (see the
    // bench's own report caveats) — scan the whole page's visible text for
    // the order number instead of a specific message element.
    const pageText = await editorPage.evaluate(() => document.body.innerText);
    const finalMessageContainsOrderNumber = order !== null && pageText.includes(order.orderNumber);
    const excerptMatch = order ? pageText.slice(Math.max(0, pageText.indexOf(order.orderNumber) - 80), pageText.indexOf(order.orderNumber) + 80) : "";

    const metrics: RunMetrics = {
      mode: BENCH_MODE,
      runIndex,
      startedAt: startedAt.toISOString(),
      wallMs,
      success: { serverRecordedMatchingOrder, finalMessageContainsOrderNumber },
      chatRequestCount: chatRequestBodies.length,
      toolCallCounts,
      browseStepRequests: { count: browseStep.count, totalLatencyMs: browseStep.totalLatencyMs },
      browseLocateRequests: { count: browseLocate.count, totalLatencyMs: browseLocate.totalLatencyMs },
      contextTokens,
      order,
      finalAssistantMessageExcerpt: excerptMatch,
    };
    return metrics;
  } finally {
    await app.close().catch(() => {});
    await shop.close().catch(() => {});
  }
}

test.describe(`bench-browse (${BENCH_MODE})`, () => {
  test.setTimeout(TURN_CAP_MS + 5 * 60_000);

  for (let i = 0; i < BENCH_RUNS; i++) {
    test(`run ${i + 1}/${BENCH_RUNS}`, async () => {
      const metrics = await runOnce(i);

      const outDir = path.join(process.cwd(), "test-results", "bench");
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `${BENCH_MODE}-${Date.now()}.json`);
      fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));

      // eslint-disable-next-line no-console
      console.log(`[bench-browse:${BENCH_MODE}] run ${i + 1}/${BENCH_RUNS} -> ${outPath}`);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(metrics, null, 2));

      // This spec's job is to produce metrics, not to grade the agent — a
      // failed task run is expected and useful data (see CLAUDE.md's
      // "Deliverable 3": one nojev smoke is allowed to fail the task itself).
      // Only fail the *test* on a harness malfunction (nothing was ever sent,
      // or the turn never produced a single /api/chat request at all).
      expect(metrics.chatRequestCount, "no /api/chat request was observed at all — the harness itself likely failed").toBeGreaterThan(0);
    });
  }
});
