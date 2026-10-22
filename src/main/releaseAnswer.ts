/**
 * The bridge answer of `releaseFixture`. The browser-agent package returns
 * `{ mockHits }` (per-rule network-mock hit counts) from the call that really
 * released a fixture with mocks, else nothing. Forward the hits so the
 * frontend can report rules that matched 0 requests.
 */
export function releaseAnswer(result: unknown): { ok: true; mockHits?: unknown[] } {
  const hits =
    typeof result === "object" && result !== null ? (result as { mockHits?: unknown }).mockHits : undefined;
  return { ok: true, ...(Array.isArray(hits) ? { mockHits: hits } : {}) };
}
