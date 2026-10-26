import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../src/main/mcp/toolManifest.json";
import { BROWSE_AGENT_TOOL_NAMES, createBrowseToolDefinitions } from "@sideform/browser-agent/agent";
import { BROWSE_MCP_TOOL_NAMES } from "../src/main/mcp/browserTools";
import { BROWSE_TOOL_INPUT_PROPS } from "../src/main/mcp/browseToolInputs";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

const tools = manifest.tools as ToolDef[];

interface ZodNode {
  shape?: Record<string, unknown>;
  _def: { schema?: ZodNode };
}

const DESKTOP_ONLY_NAME = "list_editor_tabs";
// The built-in browser's tools: desktop-only too. They live in @sideform/browser-agent, not the backend.
const BROWSE_NAMES: readonly string[] = BROWSE_MCP_TOOL_NAMES;
const DESKTOP_ONLY_NAMES = new Set<string>([DESKTOP_ONLY_NAME, ...BROWSE_NAMES]);

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

  it(`"${DESKTOP_ONLY_NAME}" and the seven browse tools are the only desktop-only names (not present in the bridged/static backend surface list below)`, () => {
    // Full cross-check against the sibling backend lives in the
    // .runIf(backendExists) block; this pinned check runs unconditionally.
    // Two groups diverge on purpose: list_editor_tabs (answered by main) and
    // the browse_* tools (they drive the built-in browser, no editor tab).
    expect(tools.filter((t) => t.name === DESKTOP_ONLY_NAME)).toHaveLength(1);
    expect(tools.filter((t) => t.name.startsWith("browse_")).map((t) => t.name)).toEqual([...BROWSE_NAMES]);
    expect(tools.filter((t) => DESKTOP_ONLY_NAMES.has(t.name))).toHaveLength(1 + BROWSE_NAMES.length);
  });

  it(`every tool except the desktop-only ones declares an optional integer "tabId"`, () => {
    for (const t of tools) {
      if (DESKTOP_ONLY_NAMES.has(t.name)) continue;
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

describe("tool manifest — browse tools", () => {
  const browseTools = tools.filter((t) => t.name.startsWith("browse_")) as Array<
    ToolDef & { annotations?: Record<string, boolean> }
  >;
  const definitions = createBrowseToolDefinitions();

  it("covers the package's seven browse tool names", () => {
    expect(browseTools.map((t) => t.name)).toEqual([...BROWSE_AGENT_TOOL_NAMES]);
  });

  it("never offers a login, capture, fixture or session tool", () => {
    const names = tools.map((t) => t.name);
    for (const n of ["browse_fill_login", "browse_capture"]) expect(names).not.toContain(n);
    for (const t of browseTools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const forbidden of ["app", "session", "fixture", "capture", "placeOnCanvas"]) expect(props, t.name).not.toContain(forbidden);
    }
  });

  it("has the package's top-level property names for each tool (no tabId added for routing)", () => {
    for (const t of browseTools) {
      // browse_act is wrapped twice in ZodEffects: unwrap to the object.
      let schema = definitions[t.name as keyof typeof definitions].inputSchema as unknown as ZodNode;
      while (!schema.shape && schema._def.schema) schema = schema._def.schema;
      // `files` (upload) is not offered over MCP.
      const expected = Object.keys(schema.shape ?? {}).filter((k) => k !== "files").sort();
      expect(Object.keys(t.inputSchema.properties ?? {}).sort(), t.name).toEqual(expected);
    }
  });

  it("starts each description with the desktop-app line and keeps the package text", () => {
    for (const t of browseTools) {
      expect(t.description).toMatch(/^Drives the built-in browser of the Sideform desktop app/);
      expect(t.description).toContain(definitions[t.name as keyof typeof definitions].description);
    }
  });

  it("says that an element-only browse_act call is refused", () => {
    const act = browseTools.find((t) => t.name === "browse_act");
    expect(act?.description).toMatch(/natural-language `element` description is not supported/);
  });

  it("offers no file upload: no `files` property and no `upload` action, top level or in a batch entry", () => {
    const act = browseTools.find((t) => t.name === "browse_act");
    const text = JSON.stringify(act?.inputSchema);
    expect(text).not.toContain('"files"');
    expect(text).not.toContain('"upload"');
  });

  it("carries the annotations of the design", () => {
    const byName = (n: string) => browseTools.find((t) => t.name === n)?.annotations;
    for (const n of ["browse_snapshot", "browse_screenshot", "browse_read", "browse_find_images"]) {
      expect(byName(n), n).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
    for (const n of ["browse_act", "browse_tabs"]) {
      expect(byName(n), n).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    }
    expect(byName("browse_open")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
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

describe("tool manifest — style / component tools", () => {
  const byName = (name: string) => {
    const t = (manifest.tools as Array<ToolDef & { annotations?: Record<string, boolean> }>).find((x) => x.name === name);
    if (!t) throw new Error(`Tool "${name}" not found in manifest`);
    return t;
  };
  const READ = ["get_styles", "get_text_styles"];
  const DESTRUCTIVE = ["set_styles", "set_text_styles", "define_component", "extract_component", "detach_instance", "delete_component"];
  const NON_DESTRUCTIVE = ["apply_fill_style", "apply_text_style", "apply_effect_style"];

  it("read tools are read-only; writers carry the backend's destructive flags", () => {
    for (const n of READ) expect(byName(n).annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    for (const n of DESTRUCTIVE) expect(byName(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const n of NON_DESTRUCTIVE) expect(byName(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("every tool declares annotations and a title", () => {
    for (const t of manifest.tools as Array<ToolDef & { title?: string; annotations?: object }>) {
      expect(t.annotations, t.name).toBeTruthy();
      expect(t.title, t.name).toBeTruthy();
    }
  });

  it("required arguments match the backend shapes", () => {
    expect(byName("set_text_styles").inputSchema.required).toEqual(["textStyles"]);
    expect(byName("apply_fill_style").inputSchema.required).toEqual(["nodeIds", "styleId"]);
    expect(byName("apply_text_style").inputSchema.required).toEqual(["nodeIds", "textStyleId"]);
    expect(byName("apply_effect_style").inputSchema.required).toEqual(["nodeIds", "styleId"]);
    expect(byName("define_component").inputSchema.required).toEqual(["key", "name", "html"]);
    expect(byName("extract_component").inputSchema.required).toEqual(["nodeId", "selector", "key", "name"]);
    expect(byName("detach_instance").inputSchema.required).toEqual(["nodeId", "selector"]);
    expect(byName("delete_component").inputSchema.required).toEqual(["key"]);
  });
});

// Vitest runs with cwd = pen-editor-desktop/, the sibling backend repo lives
// next to it. BRIDGED_TOOL_NAMES/STATIC_TOOL_NAMES live in toolNames.ts
// (server.ts just re-exports them) — read from there directly rather than
// from server.ts, which no longer contains the `export const NAME = [...]`
// declarations these need to match against.
const toolNamesPath = resolve(
  process.env.PEN_BACKEND_DIR ?? resolve(process.cwd(), "../pen-editor-backend"),
  "src/mcp/toolNames.ts",
);
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
    const actual = new Set(tools.filter((t) => !DESKTOP_ONLY_NAMES.has(t.name)).map((t) => t.name));
    expect(actual).toEqual(expected);
  });

  it(`"${DESKTOP_ONLY_NAME}" does not appear in the backend's tool name lists`, () => {
    expect(bridged).not.toContain(DESKTOP_ONLY_NAME);
    expect(staticNames).not.toContain(DESKTOP_ONLY_NAME);
    for (const n of BROWSE_NAMES) {
      expect(bridged).not.toContain(n);
      expect(staticNames).not.toContain(n);
    }
  });
});

describe.runIf(!backendExists)("tool manifest — bridged set matches pen-editor-backend (skipped)", () => {
  it.skip("../pen-editor-backend not found next to pen-editor-desktop", () => {});
});

describe("browse argument allowlist", () => {
  it("is exactly the property names of each browse tool in the manifest", () => {
    for (const name of BROWSE_NAMES) {
      const t = tools.find((x) => x.name === name);
      // browse_act also allows `element` (not advertised: the executor refuses it).
      const extra = name === "browse_act" ? ["element"] : [];
      expect(BROWSE_TOOL_INPUT_PROPS[name]).toEqual([...Object.keys(t?.inputSchema.properties ?? {}), ...extra]);
    }
    expect(Object.keys(BROWSE_TOOL_INPUT_PROPS).sort()).toEqual([...BROWSE_NAMES].sort());
  });
});
