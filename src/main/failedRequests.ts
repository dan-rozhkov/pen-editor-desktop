// Failed-request recorder behind `BrowserPageHandle.drainFailedRequests`
// (QA diagnostics spec 2026-10-18, section 1). Pure: window.ts feeds it the CDP
// Network events from the tab's debugger listener, tests feed it fixtures.
//
// An entry is "<METHOD> <status|errorText> <origin><pathname>", <= 200 chars.
// The query and hash are NEVER recorded (they can hold tokens). A ring buffer
// of 50 entries bounds a page that spams failures between drains.

export const FAILED_REQUEST_CAP = 50;
const ENTRY_MAX = 200;
/** Bounds the requestId -> method/url memory for requests that never finish. */
const PENDING_CAP = 500;
const IGNORED_TYPES = new Set(["WebSocket", "EventSource", "Ping"]);

/** "origin + pathname" of an http(s) URL, or null (data:, blob:, unparsable...). */
export function redactUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

export interface FailedRequestRecorder {
  /** Feed one CDP event; non-Network events and irrelevant ones are ignored. */
  onEvent(method: string, params: unknown): void;
  /** Returns the entries since the last drain and clears them. */
  drain(): string[];
}

export function createFailedRequestRecorder(): FailedRequestRecorder {
  const pending = new Map<string, { method: string; url: string; type: string }>();
  let entries: string[] = [];
  const push = (method: string, what: string, url: string) => {
    entries.push(`${method} ${what} ${url}`.slice(0, ENTRY_MAX));
    if (entries.length > FAILED_REQUEST_CAP) entries.shift();
  };
  return {
    onEvent(method, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      const requestId = typeof p.requestId === "string" ? p.requestId : undefined;
      if (!requestId) return;
      if (method === "Network.requestWillBeSent") {
        const req = (p.request ?? {}) as { method?: unknown; url?: unknown };
        const type = typeof p.type === "string" ? p.type : "";
        if (IGNORED_TYPES.has(type) || typeof req.url !== "string") return;
        // A redirect re-sends the same requestId: the newest hop wins.
        pending.delete(requestId);
        pending.set(requestId, { method: typeof req.method === "string" ? req.method : "GET", url: req.url, type });
        if (pending.size > PENDING_CAP) pending.delete(pending.keys().next().value as string);
        return;
      }
      if (method === "Network.responseReceived") {
        const res = (p.response ?? {}) as { status?: unknown; url?: unknown };
        const known = pending.get(requestId);
        if (IGNORED_TYPES.has(typeof p.type === "string" ? p.type : "")) return;
        if (typeof res.status === "number" && res.status >= 400) {
          const url = redactUrl(typeof res.url === "string" ? res.url : (known?.url ?? ""));
          if (url) push(known?.method ?? "GET", String(res.status), url);
        }
        return;
      }
      if (method === "Network.loadingFailed") {
        const known = pending.get(requestId);
        pending.delete(requestId);
        if (!known || IGNORED_TYPES.has(known.type)) return;
        const errorText = typeof p.errorText === "string" ? p.errorText : "failed";
        // Cancelled by the page itself (navigation away, aborted fetch): not a failure.
        if (p.canceled === true) return;
        // Blocked by us (ad and tracker blocking): intended, not a failure of the page.
        if (errorText === "net::ERR_BLOCKED_BY_CLIENT") return;
        const url = redactUrl(known.url);
        if (url) push(known.method, errorText, url);
        return;
      }
      if (method === "Network.loadingFinished") pending.delete(requestId);
    },
    drain() {
      const out = entries;
      entries = [];
      return out;
    },
  };
}
