// Thin node:http wiring for the desktop MCP endpoint. Binds loopback-only
// on an OS-assigned port, then layers defense-in-depth checks the backend
// doesn't need (plan §4): a narrow bind instead of bind-wide-and-filter,
// the loopback remote-address check anyway, a constant-time bearer check,
// a 1 MB body cap, and two checks the backend has no equivalent of at all —
// Host pinning (DNS-rebinding defense) and rejecting any request that
// carries an Origin header (a legitimate non-browser MCP client, i.e.
// pen-editor-plugin/lib/proxy.mjs, never sends one).

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { constantTimeEqual, extractBearerToken } from "./auth";
import { isLoopbackAddress } from "./handshake";
import { handleMessage, type JsonRpcDeps } from "./jsonRpc";

export const DEFAULT_MAX_BODY_BYTES = 1_000_000; // 1 MB

export interface HttpServerOptions {
  token: string;
  deps: JsonRpcDeps;
  /** Defaults to 0 (OS-assigned ephemeral port). */
  port?: number;
  /** Defaults to "127.0.0.1" — never bind wide and filter. */
  host?: string;
  maxBodyBytes?: number;
  /**
   * Called for any 'error' the server emits *after* it is already
   * listening (e.g. EMFILE/ENFILE on accept) — never for the bind-time
   * error the returned promise already rejects on. Defaults to
   * console.error. This is a background diagnostic server; a post-listen
   * error must never be allowed to reach Node's default EventEmitter
   * behavior (which throws and takes down the whole Electron main process)
   * over a failure the user's open editor tabs have nothing to do with.
   */
  onError?: (err: Error) => void;
}

export interface HttpServerHandle {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

// Every rejection branch below (Host/Origin/remote-address/auth) responds
// before ever reading the request body, matching a POST whose body may still
// be in flight when Node hands the parsed headers to this listener. Left
// unconsumed, Node still parses to the Content-Length boundary correctly, but
// the socket is not returned to a clean idle state until that draining
// happens; putting the stream in flowing mode here (discarding the bytes)
// makes that deterministic instead of dependent on when the runtime gets
// around to it — see the close()-race comment in startHttpServer.
function drainAndReject(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  req.resume();
  sendJson(res, status, body);
}

function hostMatches(headerHost: string | undefined, port: number): boolean {
  if (!headerHost) return false;
  return headerHost === `127.0.0.1:${port}` || headerHost === `localhost:${port}`;
}

export function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const { token, deps } = options;
  const host = options.host ?? "127.0.0.1";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const onError = options.onError ?? ((err: Error) => console.error("[mcp] http server error:", err));

  // Bound port is only known once the server is actually listening, and
  // the Host-header check needs it — so the request handler reads it from
  // this mutable box rather than capturing a value up front.
  const bound = { port: options.port ?? 0 };

  const server = createServer((req, res) => {
    void onRequest(req, res, { token, deps, maxBodyBytes, port: bound.port });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(bound.port, host, () => {
      server.removeListener("error", reject);
      // Permanent handler for anything the server emits from here on —
      // without it, a post-listen 'error' (this bind-time reject's
      // listener is gone now) reaches an EventEmitter with zero listeners,
      // which Node re-throws synchronously and crashes the process.
      server.on("error", onError);
      const address = server.address();
      bound.port = typeof address === "object" && address ? address.port : bound.port;
      resolve({
        server,
        get port() {
          return bound.port;
        },
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
            // server.close() only stops accepting *new* connections; its
            // callback (which we're awaiting via the promise above) does not
            // fire until every existing connection has fully ended. A
            // response the client already finished reading can still leave
            // its socket sitting open in ordinary HTTP/1.1 keep-alive (the
            // client's request carries "Connection: keep-alive" by default,
            // and the server's default keepAliveTimeout is 5s) — teardown of
            // that idle socket then races this close() call instead of being
            // ordered by it, which is what "response not fully consumed
            // before the server closes" cashed out to here: not the body,
            // but the *connection*, still alive when the port disappears.
            // closeAllConnections() (Node 18.2+) forces every socket closed
            // immediately so close() resolves deterministically instead of
            // depending on when the runtime happens to tear the socket down.
            server.closeAllConnections();
          }),
      });
    });
  });
}

interface RequestContext {
  token: string;
  deps: JsonRpcDeps;
  maxBodyBytes: number;
  port: number;
}

async function onRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  if (req.method !== "POST") {
    sendEmpty(res, 404);
    return;
  }

  // DNS-rebinding defense: a browser tab that resolved some attacker
  // domain to 127.0.0.1 still sends that domain in its Host header.
  if (!hostMatches(req.headers.host, ctx.port)) {
    drainAndReject(req, res, 403, { error: "Host header rejected." });
    return;
  }

  // A legitimate non-browser MCP client (the plugin proxy) never sends an
  // Origin header at all; only a browser context does. Reject unconditionally
  // rather than allow-listing, so this holds even if the bearer token leaks.
  if (req.headers.origin !== undefined) {
    drainAndReject(req, res, 403, { error: "Origin header rejected." });
    return;
  }

  // Defense in depth on top of the loopback bind itself.
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    drainAndReject(req, res, 403, { error: "Remote address rejected." });
    return;
  }

  const presented = extractBearerToken(req.headers.authorization);
  if (!presented || !constantTimeEqual(presented, ctx.token)) {
    drainAndReject(req, res, 401, { error: "Unauthorized." });
    return;
  }

  let body: string;
  try {
    body = await readBody(req, ctx.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "Request body too large." });
      return;
    }
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const response = await handleMessage(body, ctx.deps);
  if (response === null) {
    // Notification — nothing to reply with. 202 Accepted matches
    // proxy.mjs's own handling of a 202 to an answerable request being a
    // protocol violation, i.e. 202 is reserved for exactly this case.
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, response);
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      // Stop accumulating (and drop any further chunks on the floor) but
      // deliberately don't destroy the socket here — the caller still needs
      // to write a response (413) on this same connection. Destroying now
      // would abort the response mid-write and the client would see a
      // socket-hangup instead of the 413.
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.resume();
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new BodyTooLargeError("Request body exceeds the 1 MB cap."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => fail(err));
  });
}
