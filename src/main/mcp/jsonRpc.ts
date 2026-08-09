// Pure JSON-RPC 2.0 message handling for the desktop MCP endpoint. No
// Electron import, no node:http — httpServer.ts is the only caller in this
// package. Deliberately hand-rolled instead of @modelcontextprotocol/sdk
// (see plan §6): the one real consumer, pen-editor-plugin/lib/proxy.mjs,
// only ever POSTs a single JSON-RPC message and accepts a plain
// application/json 200 body — no GET SSE stream, no batching, no session
// resumption.

import type { ToolCallResult } from "./dispatcher";

export const JSON_RPC_VERSION = "2.0";
export const SERVER_NAME = "pen-editor-desktop";
export const SERVER_VERSION = "1.0.0";

// Bumped only when the *call envelope* itself changes (plan §2). Advertised
// as a fallback when a client's initialize request omits protocolVersion.
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
} as const;

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface JsonRpcDeps {
  toolManifest: ToolManifestEntry[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ParsedMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function isNotification(msg: ParsedMessage): boolean {
  return !("id" in msg);
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Handles exactly one JSON-RPC message (never a batch — the plugin proxy
 * never sends one). `raw` is the exact request body text; a request whose
 * body is not valid JSON returns a parse-error response. A notification
 * (no `id` key) always resolves to `null`, which httpServer.ts turns into
 * an empty 202.
 */
export async function handleMessage(raw: string, deps: JsonRpcDeps): Promise<JsonRpcResponse | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(null, ERROR_CODES.PARSE_ERROR, "Parse error: request body is not valid JSON.");
  }

  if (!isPlainObject(parsed) || typeof parsed.method !== "string") {
    return errorResponse(null, ERROR_CODES.INVALID_REQUEST, "Invalid Request: expected a JSON-RPC object with a string method.");
  }

  const msg = parsed as ParsedMessage;
  const method = msg.method as string;
  const notification = isNotification(msg);
  const id: JsonRpcId = notification ? null : ((msg.id as JsonRpcId) ?? null);

  const respond = (build: () => JsonRpcResponse): JsonRpcResponse | null => (notification ? null : build());

  switch (method) {
    case "notifications/initialized":
      return null;

    case "initialize": {
      const params = isPlainObject(msg.params) ? msg.params : {};
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      return respond(() =>
        resultResponse(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
    }

    case "ping":
      return respond(() => resultResponse(id, {}));

    case "tools/list":
      return respond(() => resultResponse(id, { tools: deps.toolManifest }));

    case "tools/call": {
      const params = isPlainObject(msg.params) ? msg.params : {};
      const name = params.name;
      if (typeof name !== "string") {
        return respond(() =>
          errorResponse(id, ERROR_CODES.INVALID_PARAMS, "Invalid params: tools/call requires a string 'name'."),
        );
      }
      const args = isPlainObject(params.arguments) ? params.arguments : {};
      const result = await deps.callTool(name, args);
      return respond(() => resultResponse(id, result));
    }

    default:
      return respond(() => errorResponse(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`));
  }
}
