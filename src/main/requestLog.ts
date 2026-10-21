import type { PageRequestEntry } from "@sideform/browser-agent";

// Request log behind `BrowserPageHandle.drainRequests`. Pure: window.ts feeds it
// the CDP Network events from the tab's debugger listener (same one as
// failedRequests.ts), tests feed it fixtures. Mirrors PwPage.drainRequests in
// @sideform/browser-agent (adapters/playwright.ts).
//
// Unlike the failed-request recorder, URLs and headers are kept verbatim: this
// is a developer-facing log of the agent's own tab. Bounded: <= 500 in-flight
// records, a ring of <= 300 finished ones, <= 30 body fetches per drain.

export type { PageRequestEntry };

export const REQUEST_PENDING_CAP = 500;
export const REQUEST_RING_CAP = 300;
export const MAX_BODY_FETCHES = 30;
export const MAX_BODY_CHARS = 16 * 1024;
/** One body fetch gives up after this long (a request evicted from the browser's cache just has no body). */
export const BODY_FETCH_MS = 1000;
/** The whole body phase of one drain; past it the entries go out as they are and a late body is never written. */
export const BODY_PHASE_MS = 2000;
export const CLOSED_REQUEST_CAP = 300;
const IGNORED_TYPES = new Set(["WebSocket", "EventSource", "Ping"]);
const TEXT_MIME = /json|^text\/|xml|javascript|x-www-form-urlencoded/i;

interface Record_ {
  requestId: string;
  startMono?: number;
  mimeType?: string;
  error?: string;
  /** A 3xx hop that ended by a redirect: its body is the redirect page, never fetched. */
  redirect?: boolean;
  entry: PageRequestEntry;
}

export type GetBody = (requestId: string) => Promise<{ body: string; base64Encoded: boolean } | undefined>;

export interface RequestLog {
  /** Feed one CDP event; non-Network events and irrelevant ones are ignored. */
  onEvent(method: string, params: unknown): void;
  /**
   * Returns the finished requests since the last drain (with lazily fetched bodies) and clears them.
   * `getBody` is the raw CDP call: the per-body (1 s) and whole-phase (2 s) limits are applied here.
   */
  drain(getBody: GetBody): Promise<PageRequestEntry[]>;
  /** Finished entries without bodies (the tab is going away) and the drop count; both are reset. */
  takeFinished(): { requests: PageRequestEntry[]; dropped: number };
  /** Entries lost to the ring or the in-flight cap since the last call; reading resets the count. */
  droppedRequests(): number;
  /** Forgets everything, in-flight requests included. */
  clear(): void;
}

type Headers = Record<string, string>;
const asHeaders = (v: unknown): Headers | undefined =>
  v && typeof v === "object" ? { ...(v as Headers) } : undefined;

export function createRequestLog(): RequestLog {
  const active = new Map<string, Record_>();
  let done: Record_[] = [];
  let dropped = 0;

  const noteResponse = (requestId: string, type: unknown, response: unknown) => {
    const r = active.get(requestId);
    const res = response as { status?: unknown; mimeType?: unknown; headers?: unknown } | undefined;
    if (!r || !res) return;
    if (typeof type === "string" && type && !r.entry.type) r.entry.type = type.toLowerCase();
    if (typeof res.status === "number") r.entry.status = res.status;
    if (typeof res.mimeType === "string" && res.mimeType) {
      r.entry.mimeType = res.mimeType;
      r.mimeType = res.mimeType;
    }
    const headers = asHeaders(res.headers);
    if (headers) r.entry.responseHeaders = headers;
  };

  const finish = (requestId: string, timestamp: unknown, error: string | undefined, size?: unknown, redirect = false) => {
    const r = active.get(requestId);
    if (!r) return;
    active.delete(requestId);
    if (redirect) r.redirect = true;
    if (error !== undefined) {
      r.error = error;
      r.entry.error = error;
    }
    if (typeof size === "number") r.entry.size = size;
    if (typeof timestamp === "number" && typeof r.startMono === "number") {
      r.entry.durationMs = Math.max(0, Math.round((timestamp - r.startMono) * 1000));
    }
    done.push(r);
    if (done.length > REQUEST_RING_CAP) {
      done.shift();
      dropped++;
    }
  };

  return {
    onEvent(method, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      const requestId = typeof p.requestId === "string" ? p.requestId : undefined;
      if (!requestId) return;
      if (method === "Network.requestWillBeSent") {
        const type = typeof p.type === "string" ? p.type : "";
        if (IGNORED_TYPES.has(type)) return;
        const req = (p.request ?? {}) as { url?: unknown; method?: unknown; headers?: unknown };
        if (typeof req.url !== "string" || !req.url || req.url.startsWith("data:")) return;
        // A redirect reuses the requestId: the earlier hop ends here.
        if (p.redirectResponse && active.has(requestId)) {
          noteResponse(requestId, undefined, p.redirectResponse);
          finish(requestId, p.timestamp, undefined, undefined, true);
        }
        const entry: PageRequestEntry = {
          at: typeof p.wallTime === "number" ? Math.round(p.wallTime * 1000) : Date.now(),
          method: typeof req.method === "string" && req.method ? req.method : "GET",
          url: req.url,
        };
        if (type) entry.type = type.toLowerCase();
        const headers = asHeaders(req.headers);
        if (headers) entry.requestHeaders = headers;
        active.set(requestId, {
          requestId,
          startMono: typeof p.timestamp === "number" ? p.timestamp : undefined,
          entry,
        });
        if (active.size > REQUEST_PENDING_CAP) {
          active.delete(active.keys().next().value as string);
          dropped++;
        }
        return;
      }
      if (method === "Network.responseReceived") {
        noteResponse(requestId, p.type, p.response);
        return;
      }
      if (method === "Network.loadingFinished") {
        finish(requestId, p.timestamp, undefined, p.encodedDataLength);
        return;
      }
      if (method === "Network.loadingFailed") {
        finish(requestId, p.timestamp, typeof p.errorText === "string" && p.errorText ? p.errorText : "failed");
      }
    },
    async drain(getBody) {
      const records = done;
      done = [];
      let bodies = 0;
      let over = false;
      const fetches = Promise.all(
        records.map(async (r) => {
          if (
            bodies >= MAX_BODY_FETCHES ||
            r.redirect ||
            r.error !== undefined ||
            !r.mimeType ||
            !TEXT_MIME.test(r.mimeType) ||
            !["fetch", "xhr"].includes(r.entry.type ?? "")
          ) {
            return;
          }
          bodies++;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const res = await Promise.race([
              getBody(r.requestId),
              new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), BODY_FETCH_MS);
              }),
            ]);
            if (over || !res || res.base64Encoded || typeof res.body !== "string") return;
            r.entry.body = res.body.slice(0, MAX_BODY_CHARS);
            if (res.body.length > MAX_BODY_CHARS) r.entry.bodyTruncated = true;
          } catch {
            /* the body is gone: no body */
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      let phase: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        fetches,
        new Promise<void>((resolve) => {
          phase = setTimeout(resolve, BODY_PHASE_MS);
        }),
      ]);
      clearTimeout(phase);
      over = true;
      return records.map((r) => r.entry);
    },
    takeFinished() {
      const requests = done.map((r) => r.entry);
      done = [];
      const n = dropped;
      dropped = 0;
      return { requests, dropped: n };
    },
    droppedRequests() {
      const n = dropped;
      dropped = 0;
      return n;
    },
    clear() {
      active.clear();
      done = [];
      dropped = 0;
    },
  };
}

/** Entries of tabs that went away, until the controller drains them (`BrowserTarget.drainClosedRequests`). */
export interface ClosedRequestBuffer {
  add(taken: { requests: PageRequestEntry[]; dropped?: number }): void;
  drain(): { requests: PageRequestEntry[]; dropped?: number };
  clear(): void;
}

export function createClosedRequestBuffer(cap: number = CLOSED_REQUEST_CAP): ClosedRequestBuffer {
  let requests: PageRequestEntry[] = [];
  let dropped = 0;
  return {
    add(taken) {
      requests.push(...taken.requests);
      dropped += taken.dropped ?? 0;
      if (requests.length > cap) {
        dropped += requests.length - cap;
        requests = requests.slice(requests.length - cap);
      }
    },
    drain() {
      const out = requests;
      const d = dropped;
      requests = [];
      dropped = 0;
      return d > 0 ? { requests: out, dropped: d } : { requests: out };
    },
    clear() {
      requests = [];
      dropped = 0;
    },
  };
}
