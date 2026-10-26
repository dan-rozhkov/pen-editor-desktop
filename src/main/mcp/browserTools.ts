// The seven browse tools as MCP tools. Pure and Electron-free: runs a tool against a
// `BrowserBridge` with the package's own executor and turns its JSON string into an MCP result.
// Never rejects.
import type { BrowserBridge } from "@sideform/browser-agent/loop";
import { executeBrowseTool } from "@sideform/browser-agent/agent/execute";
import type { ToolCallResult, ToolContent } from "./dispatcher";
import { BROWSE_TOOL_INPUT_PROPS } from "./browseToolInputs";

/**
 * Exposed to MCP clients. Pinned by test against `BROWSE_AGENT_TOOL_NAMES`. `browse_fill_login`,
 * `browse_capture` and the QA tools are not in the package's list, and nothing else is exposed:
 * a password must never reach a client.
 */
export const BROWSE_MCP_TOOL_NAMES = [
  "browse_open",
  "browse_snapshot",
  "browse_screenshot",
  "browse_act",
  "browse_tabs",
  "browse_find_images",
  "browse_read",
] as const;

export type BrowseMcpToolName = (typeof BROWSE_MCP_TOOL_NAMES)[number];

export function isBrowseMcpTool(name: string): name is BrowseMcpToolName {
  return (BROWSE_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

export const BROWSER_OFF_MESSAGE = "Browser control over MCP is turned off in Settings > Browser.";
export const NO_WINDOW_MESSAGE = "No Sideform window is open.";

function textResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Input as the executor gets it: ONLY the properties the tool's allowlist names (`BROWSE_TOOL_INPUT_PROPS`,
 * generated: the manifest's properties, plus `element` for browse_act, which the executor refuses). Everything
 * else (`app`, `repro`, `session`, `files`, ...) is dropped, so a client cannot reach an executor option the
 * schema does not offer. The entries of a browse_act batch (`actions`) are filtered the same way. `tabId` stays
 * for browse_tabs: it names a browser tab, not an editor tab. An unknown tool keeps nothing.
 */
export function sanitizeBrowseArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const allowed = BROWSE_TOOL_INPUT_PROPS[tool] ?? [];
  const out: Record<string, unknown> = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(args, key)) out[key] = args[key];
  if (tool === "browse_act" && Array.isArray(out.actions)) {
    out.actions = out.actions.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const entryOut: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key !== "actions" && Object.prototype.hasOwnProperty.call(entry, key)) entryOut[key] = (entry as Record<string, unknown>)[key];
      }
      return entryOut;
    });
  }
  return out;
}

export const UPLOAD_REFUSED_MESSAGE = "File upload is not available over MCP.";

function isUploadAction(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "upload";
}

/** True when a browse_act call (or any entry of its batch) asks for the `upload` action. */
export function requestsUpload(args: Record<string, unknown>): boolean {
  if (isUploadAction(args.action)) return true;
  if (Array.isArray(args.actions)) {
    return args.actions.some((e) => !!e && typeof e === "object" && isUploadAction((e as Record<string, unknown>).action));
  }
  return false;
}

const IMAGE_DATA_URL = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s;

/**
 * Converts one executor result string. `{ error }` becomes an error result. A `browse_screenshot`
 * becomes an image item plus a text item with every other field (snapshotId, elements, ...); the
 * base64 is never part of the text. Everything else is text as is.
 */
export function browseResultToToolResult(tool: string, raw: string): ToolCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return tool === "browse_screenshot" ? errorResult("Malformed screenshot response.") : textResult(raw);
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (obj && typeof obj.error === "string") return errorResult(obj.error);
  if (tool !== "browse_screenshot") return textResult(raw);
  if (!obj) return errorResult("Malformed screenshot response.");
  const { imageData, ...rest } = obj;
  if (typeof imageData !== "string") return errorResult("No image returned.");
  const match = IMAGE_DATA_URL.exec(imageData);
  if (!match) return errorResult("Screenshot response was not a data URL.");
  const content: ToolContent[] = [{ type: "image", data: match[2], mimeType: match[1] }];
  if (Object.keys(rest).length > 0) content.push({ type: "text", text: JSON.stringify(rest) });
  return { content };
}

/** Runs one browse tool on `bridge`. */
export async function runBrowseMcpTool(
  bridge: BrowserBridge,
  tool: BrowseMcpToolName,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  // An MCP client must not push files into pages. Refused before the bridge, for a batch entry too.
  if (tool === "browse_act" && requestsUpload(args)) return errorResult(UPLOAD_REFUSED_MESSAGE);
  try {
    // `element` stays in the forwarded args and no `locateElement` is passed: the executor refuses an
    // element-only browse_act (also with `index: null` / `target: ""`), top level or batch entry.
    const raw = await executeBrowseTool(bridge, tool, sanitizeBrowseArgs(tool, args));
    return browseResultToToolResult(tool, raw);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
