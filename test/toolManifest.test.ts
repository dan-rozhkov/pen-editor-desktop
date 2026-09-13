import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../src/main/mcp/toolManifest.json";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

const tools = manifest.tools as ToolDef[];

const DESKTOP_ONLY_NAME = "list_editor_tabs";

describe("tool manifest — shape", () => {
  it("every entry has a name, a non-empty description, and an object-typed schema", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("has no duplicate tool names", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it(`"${DESKTOP_ONLY_NAME}" is the only desktop-only name (not present in the bridged/static backend surface list below)`, () => {
    // Full cross-check against the sibling backend lives in the
    // .runIf(backendExists) block; this pinned check runs unconditionally
    // and encodes the same invariant the design doc states (§3): exactly
    // one tool name is a deliberate desktop-only divergence.
    const desktopOnlyCandidates = tools.filter((t) => t.name === DESKTOP_ONLY_NAME);
    expect(desktopOnlyCandidates).toHaveLength(1);
  });

  it(`every tool except "${DESKTOP_ONLY_NAME}" declares an optional integer "tabId"`, () => {
    for (const t of tools) {
      if (t.name === DESKTOP_ONLY_NAME) continue;
      const tabId = t.inputSchema.properties?.tabId as { type?: string } | undefined;
      expect(tabId, `${t.name} is missing a tabId property`).toBeTruthy();
      expect(tabId?.type).toBe("integer");
      expect(t.inputSchema.required ?? []).not.toContain("tabId");
    }
  });

  it(`"${DESKTOP_ONLY_NAME}" takes no arguments`, () => {
    const listTabs = tools.find((t) => t.name === DESKTOP_ONLY_NAME);
    expect(listTabs).toBeTruthy();
    expect(Object.keys(listTabs!.inputSchema.properties ?? {})).toEqual([]);
  });
});

describe("tool manifest — comment tools", () => {
  const byName = (name: string): ToolDef => {
    const t = tools.find((tool) => tool.name === name);
    if (!t) throw new Error(`Tool "${name}" not found in manifest`);
    return t;
  };

  it("read_comments takes optional includeResolved (boolean) and threadId (string), neither required", () => {
    const t = byName("read_comments");
    expect(t.inputSchema.properties?.includeResolved).toMatchObject({ type: "boolean" });
    expect(t.inputSchema.properties?.threadId).toMatchObject({ type: "string" });
    expect(t.inputSchema.required ?? []).toEqual([]);
  });

  it("reply_comment requires threadId and text (both strings)", () => {
    const t = byName("reply_comment");
    expect(t.inputSchema.properties?.threadId).toMatchObject({ type: "string" });
    expect(t.inputSchema.properties?.text).toMatchObject({ type: "string" });
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["threadId", "text"]));
  });

  it("resolve_comment requires threadId (string)", () => {
    const t = byName("resolve_comment");
    expect(t.inputSchema.properties?.threadId).toMatchObject({ type: "string" });
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["threadId"]));
  });

  it("leave_comment requires a comments array of 1-50 items, each with nodeId?/x?/y?/text", () => {
    const t = byName("leave_comment");
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["comments"]));
    const comments = t.inputSchema.properties?.comments as {
      type?: string;
      minItems?: number;
      maxItems?: number;
      items?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
    };
    expect(comments?.type).toBe("array");
    expect(comments?.minItems).toBe(1);
    expect(comments?.maxItems).toBe(50);
    const itemProps = comments?.items?.properties ?? {};
    expect(itemProps.nodeId).toMatchObject({ type: "string" });
    expect(itemProps.x).toMatchObject({ type: "number" });
    expect(itemProps.y).toMatchObject({ type: "number" });
    expect(itemProps.text).toMatchObject({ type: "string" });
    // text is unconditionally required on each item; the nodeId-vs-x/y
    // choice is a cross-field rule JSON Schema can't express structurally,
    // so it lives in the description text instead — checked below.
    expect(comments?.items?.required).toEqual(["text"]);
  });

  it("leave_comment documents the nodeId-vs-x/y rule in its description", () => {
    const t = byName("leave_comment");
    expect(t.description).toMatch(/nodeId/);
    expect(t.description).toMatch(/x and y/);
  });
});

describe("tool manifest — layers / embed HTML / canvas layout tools", () => {
  const byName = (name: string): ToolDef => {
    const t = tools.find((tool) => tool.name === name);
    if (!t) throw new Error(`Tool "${name}" not found in manifest`);
    return t;
  };

  it("read_embed_html requires nodeId, has an outline/grep/full mode enum defaulting to outline", () => {
    const t = byName("read_embed_html");
    expect(t.inputSchema.properties?.nodeId).toMatchObject({ type: "string" });
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["nodeId"]));
    expect(t.inputSchema.required).not.toEqual(expect.arrayContaining(["mode", "pattern", "contextLines", "maxDepth"]));
    const mode = t.inputSchema.properties?.mode as { type?: string; enum?: string[]; default?: string };
    expect(mode.enum).toEqual(["outline", "grep", "full"]);
    expect(mode.default).toBe("outline");
    expect(t.inputSchema.properties?.pattern).toMatchObject({ type: "string" });
  });

  it("edit_embed_html requires nodeId and a non-empty edits array of oldString/newString/replaceAll?", () => {
    const t = byName("edit_embed_html");
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["nodeId", "edits"]));
    const edits = t.inputSchema.properties?.edits as {
      type?: string;
      minItems?: number;
      maxItems?: number;
      items?: { properties?: Record<string, unknown>; required?: string[] };
    };
    expect(edits?.type).toBe("array");
    expect(edits?.minItems).toBe(1);
    expect(edits?.maxItems).toBe(20);
    expect(edits?.items?.properties?.oldString).toMatchObject({ type: "string" });
    expect(edits?.items?.properties?.newString).toMatchObject({ type: "string" });
    expect(edits?.items?.properties?.replaceAll).toMatchObject({ type: "boolean" });
    expect(edits?.items?.required).toEqual(expect.arrayContaining(["oldString", "newString"]));
    expect(edits?.items?.required).not.toEqual(expect.arrayContaining(["replaceAll"]));
  });

  it("rename_layers requires a non-empty renames array of {id, name}", () => {
    const t = byName("rename_layers");
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["renames"]));
    const renames = t.inputSchema.properties?.renames as {
      type?: string;
      minItems?: number;
      items?: { properties?: Record<string, unknown>; required?: string[] };
    };
    expect(renames?.type).toBe("array");
    expect(renames?.minItems).toBe(1);
    expect(renames?.items?.properties?.id).toMatchObject({ type: "string" });
    expect(renames?.items?.properties?.name).toMatchObject({ type: "string" });
    expect(renames?.items?.required).toEqual(expect.arrayContaining(["id", "name"]));
  });

  it("find_empty_space_on_canvas requires direction/width/height/padding, nodeId is optional", () => {
    const t = byName("find_empty_space_on_canvas");
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["direction", "width", "height", "padding"]));
    expect(t.inputSchema.required).not.toEqual(expect.arrayContaining(["nodeId"]));
    const direction = t.inputSchema.properties?.direction as { type?: string; enum?: string[] };
    expect(direction.enum).toEqual(["top", "right", "bottom", "left"]);
    expect(t.inputSchema.properties?.width).toMatchObject({ type: "number" });
    expect(t.inputSchema.properties?.height).toMatchObject({ type: "number" });
    expect(t.inputSchema.properties?.padding).toMatchObject({ type: "number" });
    expect(t.inputSchema.properties?.nodeId).toMatchObject({ type: "string" });
  });
});

// Vitest runs with cwd = pen-editor-desktop/, the sibling backend repo lives
// next to it. BRIDGED_TOOL_NAMES/STATIC_TOOL_NAMES live in toolNames.ts
// (server.ts just re-exports them) — read from there directly rather than
// from server.ts, which no longer contains the `export const NAME = [...]`
// declarations these need to match against.
const toolNamesPath = resolve(process.cwd(), "../pen-editor-backend/src/mcp/toolNames.ts");
const backendExists = existsSync(toolNamesPath);

/** Extracts the string literals of a `export const NAME = [...] as const;` array. */
function extractNamedStringArray(src: string, exportName: string): string[] {
  const match = new RegExp(`export const ${exportName}[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
  if (!match) throw new Error(`Could not find ${exportName} in backend toolNames.ts`);
  const names = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // A regex that matches the array shell but captures zero names would make
  // the cross-check below a trivial pass (expected = empty set superset of
  // nothing) — that is worse than the file simply being absent, since it
  // looks green while checking nothing. Guard against silently-empty
  // extraction explicitly.
  if (names.length === 0) throw new Error(`Extracted zero names for ${exportName} from backend toolNames.ts`);
  return names;
}

describe.runIf(backendExists)("tool manifest — bridged set matches pen-editor-backend", () => {
  const src = backendExists ? readFileSync(toolNamesPath, "utf8") : "";
  const bridged = backendExists ? extractNamedStringArray(src, "BRIDGED_TOOL_NAMES") : [];
  const staticNames = backendExists ? extractNamedStringArray(src, "STATIC_TOOL_NAMES") : [];

  it("the manifest's bridged-tool names equal BRIDGED_TOOL_NAMES ∪ STATIC_TOOL_NAMES", () => {
    const expected = new Set([...bridged, ...staticNames]);
    const actual = new Set(tools.filter((t) => t.name !== DESKTOP_ONLY_NAME).map((t) => t.name));
    expect(actual).toEqual(expected);
  });

  it(`"${DESKTOP_ONLY_NAME}" does not appear in the backend's tool name lists`, () => {
    expect(bridged).not.toContain(DESKTOP_ONLY_NAME);
    expect(staticNames).not.toContain(DESKTOP_ONLY_NAME);
  });
});

describe.runIf(!backendExists)("tool manifest — bridged set matches pen-editor-backend (skipped)", () => {
  it.skip("../pen-editor-backend not found next to pen-editor-desktop", () => {});
});
