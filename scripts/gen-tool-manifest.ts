// Regenerates src/main/mcp/toolManifest.json.
//
// IMPORTANT — this is NOT a faithful zod→JSON-Schema compiler. That was
// evaluated and rejected: pen-editor-backend/src/ai/tools.ts's input shapes
// mix `.describe()`, `.optional()`, `.enum()`, `.record(z.unknown())`, and
// (for batch_design) a `.transform()` alias-merge that has no JSON-Schema
// representation at all — a generic structural walk would either need to
// special-case every one of those (at which point it is just this file with
// extra indirection) or silently emit something subtly wrong (e.g. treating
// `.record(z.unknown())` as `{}` instead of `additionalProperties: true`,
// or forgetting a `.describe()` on a nested array item). Per the design doc
// (§6): a checked-in, hand-written manifest plus a generator that verifies
// it against the sibling backend, rather than a generator that produces
// something unverifiable.
//
// So this script does two things, and only two:
//   1. Writes the hand-maintained TOOLS array below to toolManifest.json —
//      this is the actual source of truth; edit TOOLS, not the JSON file.
//   2. When a sibling ../pen-editor-backend checkout exists, greps its
//      source (never imports/executes it — no zod/ai SDK dependency, no
//      risk of running module-level side effects) for the property names,
//      tool names, and enum members this manifest encodes, and reports any
//      that no longer appear. This catches "a field was renamed/removed
//      upstream and nobody updated TOOLS" — it does NOT catch "a field was
//      added upstream and nobody added it here" (grep can't know what it
//      isn't looking for), nor does it diff description text (prose changes
//      don't warrant a hard failure). Treat a clean run as "nothing obvious
//      rotted", not as "this manifest is definitely still complete".
//
// Run: npx tsx scripts/gen-tool-manifest.ts   (or ts-node)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TAB_ID_PROPERTY = {
  type: "integer",
  description: "Route this call to a specific editor tab by id (see list_editor_tabs). Omit to target the currently focused tab.",
};

// Every bridged tool's schema is `{ ...baseProperties, tabId }`, required
// list unchanged. Kept as a helper so the tabId property can't drift between
// entries.
function bridged(base: { properties: Record<string, unknown>; required?: string[] }): Record<string, unknown> {
  return {
    type: "object",
    properties: { ...base.properties, tabId: TAB_ID_PROPERTY },
    ...(base.required ? { required: base.required } : {}),
    additionalProperties: false,
  };
}

const BATCH_GET_PATTERN_TYPES = [
  "frame",
  "group",
  "rectangle",
  "ellipse",
  "line",
  "polygon",
  "path",
  "text",
  "embed",
  "ref",
  "connector",
];

const GUIDELINE_TOPICS = ["code", "table", "tailwind", "landing-page", "design-system"];

// Hand-maintained. Source: descriptions from pen-editor-backend/src/mcp/server.ts
// (registerTool calls), input shapes from pen-editor-backend/src/ai/tools.ts
// (the exported *InputShape objects imported by server.ts). Keep both in
// sync manually; the verification pass below is a tripwire, not a
// substitute for reading the diff when the backend changes.
export const TOOLS: ToolDef[] = [
  {
    name: "get_editor_state",
    description:
      "Get the current editor state: active .pen file, user selection, top-level nodes, and available components. Call this first — Figma's metadata-first pattern.",
    inputSchema: bridged({
      properties: {
        include_schema: {
          type: "boolean",
          description:
            "Whether to include the .pen file schema in the response. Set true if you need to understand the node format.",
        },
      },
      required: ["include_schema"],
    }),
  },
  {
    name: "batch_get",
    description: "Retrieve nodes by id or search pattern, with depth control. Use to inspect structure before modifying.",
    inputSchema: bridged({
      properties: {
        patterns: {
          type: "array",
          description: "Search patterns to match nodes",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "Only return nodes with this type",
                enum: BATCH_GET_PATTERN_TYPES,
              },
              name: { type: "string", description: "Only return nodes whose name matches this regex pattern" },
            },
            additionalProperties: false,
          },
        },
        nodeIds: { type: "array", description: "Specific node IDs to read", items: { type: "string" } },
        parentId: { type: "string", description: "Parent node ID to limit search scope" },
        readDepth: {
          type: "number",
          description: "How deep to read children (default 1). Nodes beyond this depth show as '...'.",
        },
        searchDepth: { type: "number", description: "How deep to search in the node tree. Unlimited if omitted." },
        resolveVariables: {
          type: "boolean",
          description: "If true, variable references are resolved to their current values.",
        },
        includePathGeometry: { type: "boolean", description: "If true, include full SVG path geometry data." },
      },
    }),
  },
  {
    name: "snapshot_layout",
    description:
      "Get computed layout rectangles (positions/sizes after the layout engine runs). Key for design-to-code fidelity — use to check placement, overlap, and clipping.",
    inputSchema: bridged({
      properties: {
        parentId: { type: "string", description: "Subtree root to inspect. Omit for the whole document." },
        maxDepth: {
          type: "number",
          description: "Depth limit for traversal. Default is direct children only. Be careful with large values.",
        },
        problemsOnly: {
          type: "boolean",
          description: "If true, only return nodes with layout problems (clipping, overflow).",
        },
      },
    }),
  },
  {
    name: "get_variables",
    description: "Read all design variables (tokens) and themes defined in the .pen file.",
    inputSchema: bridged({ properties: {} }),
  },
  {
    name: "get_screenshot",
    description:
      "Take a screenshot of a node for visual verification — enabled only for MCP clients (not the built-in chat agent). Omit nodeId to screenshot the current selection (errors if none or more than one node is selected). Returns a PNG image.",
    inputSchema: bridged({
      properties: { nodeId: { type: "string", description: "Node to screenshot. Omit to use the current selection." } },
    }),
  },
  {
    name: "batch_design",
    description:
      'Execute batch operations on the .pen node tree. Accepts a mini-script string with operations:\n\n**Operations:**\n- `binding=I(parent, nodeData)` — Insert new node. Works both for a freshly-created parent binding AND for adding a child to an already-existing node: pass the existing node\'s id/path as `parent` (e.g. `I("existingFrameId", {...})` or `I(card+"/body", {...})`). This is the ONLY way to add children to an existing node — `U()` cannot add, remove, or reorder children.\n- `binding=C(sourceId, parent, overrides)` — Copy node (`positionDirection`/`positionPadding` for placement)\n- `U(path, updateData)` — Update properties (cannot change id, type, or children)\n- `binding=R(path, newNodeData)` — Replace node entirely\n- `M(nodeId, parent?, index?)` — Move node\n- `D(nodeId)` — Delete node\n- `G(nodeId, "ai"|"stock", prompt)` — Generate/find image and apply as fill to frame/rectangle\n\nSee the deployed pen-editor bundle\'s own tool description for the full rules/examples list (auto-layout wrap/gap, min/max sizing, fills/strokes/effects stacks, corner radius/smoothing, constraints, masks, lists, variable font axes, etc.) — this manifest carries a summary only; the executing bundle\'s copy is authoritative.\n\nCall get_guidelines(topic: "design-system") first for auto-layout and component-usage rules.',
    inputSchema: bridged({
      properties: {
        operations: {
          type: "string",
          description: 'The batch-design mini-script to execute. Required (or one of the compatibility aliases below).',
        },
        design: {
          type: "string",
          description: 'Compatibility alias for "operations", for models that occasionally emit the wrong key name.',
        },
        script: {
          type: "string",
          description: 'Compatibility alias for "operations", for models that occasionally emit the wrong key name.',
        },
        batch: {
          type: "string",
          description: 'Compatibility alias for "operations", for models that occasionally emit the wrong key name.',
        },
      },
    }),
  },
  {
    name: "set_variables",
    description: "Add or update design variables and themes. Merges by default; replace=true overwrites all.",
    inputSchema: bridged({
      properties: {
        variables: {
          type: "object",
          description:
            'Variable definitions, as an object keyed by variable name. Simplest form — a plain hex string per name: `{"--brand-primary": "#3b82f6", "--brand-bg": "#ffffff"}`. Full form — an object per name with `type` ("color" | "number" | "string", default "color") and `value`: `{"--radius-lg": {"type": "number", "value": "16"}}`. Per-theme values use `themeValues`: `{"--brand-bg": {"type": "color", "value": "#ffffff", "themeValues": {"dark": "#0b0b0b"}}}`. Names may be given with or without a leading `--`/`$`. Nested token groups (e.g. `{colors: {primary: {$type, $value}}}`) are also accepted.',
          additionalProperties: true,
        },
        replace: { type: "boolean", description: "If true, replaces all existing variables. Default is merge." },
      },
      required: ["variables"],
    }),
  },
  {
    name: "get_guidelines",
    description: "Get design guidelines and rules for a topic (design-system, code, table, tailwind, landing-page).",
    inputSchema: bridged({
      properties: {
        topic: { type: "string", description: "Topic to retrieve guidelines for.", enum: GUIDELINE_TOPICS },
      },
      required: ["topic"],
    }),
  },
  {
    name: "get_style_guide_tags",
    description: "Get all available style guide tags. Call before get_style_guide to know which tags to use.",
    inputSchema: bridged({ properties: {} }),
  },
  {
    name: "get_style_guide",
    description: "Get a style guide for design inspiration, by tags or by name.",
    inputSchema: bridged({
      properties: {
        tags: { type: "array", description: "5-10 tags to search for a matching style guide.", items: { type: "string" } },
        name: { type: "string", description: "Specific style guide name to retrieve." },
      },
    }),
  },
  {
    name: "list_editor_tabs",
    description:
      "Desktop-only: list this app's open editor tabs, their titles, whether each is active/focused, and whether each is ready to receive MCP tool calls (mcpReady). Use to discover tabId values for explicit routing when more than one tab is open. This tool does not exist on pen-editor-backend's MCP surface — it is answered entirely by the desktop app, without involving any editor tab.",
    // Desktop-only: intentionally no `tabId` and no bridged() helper — it
    // answers from main's own tab registry, it never dispatches to a tab.
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const OUTPUT_PATH = join(__dirname, "..", "src", "main", "mcp", "toolManifest.json");

function writeManifest(): void {
  const manifest = {
    $comment:
      "Checked-in tools/list manifest for the desktop MCP endpoint. Generated by scripts/gen-tool-manifest.ts — edit TOOLS there, not this file. See that script's header for why this is hand-written rather than auto-converted from the backend's zod schemas.",
    tools: TOOLS,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`Wrote ${TOOLS.length} tools to ${OUTPUT_PATH}`);
}

// Best-effort drift tripwire against a sibling ../pen-editor-backend
// checkout. Text-search only — see the header comment for why this isn't a
// real schema diff. Returns problems found (empty = nothing obvious rotted).
function verifyAgainstBackend(): string[] {
  const backendRoot = resolve(__dirname, "..", "..", "pen-editor-backend");
  const serverPath = join(backendRoot, "src", "mcp", "server.ts");
  const toolsPath = join(backendRoot, "src", "ai", "tools.ts");
  if (!existsSync(serverPath) || !existsSync(toolsPath)) {
    console.log("No sibling ../pen-editor-backend checkout found — skipping drift verification.");
    return [];
  }

  const serverSrc = readFileSync(serverPath, "utf8");
  const toolsSrc = readFileSync(toolsPath, "utf8");
  const problems: string[] = [];

  for (const t of TOOLS) {
    if (t.name === "list_editor_tabs") continue; // deliberate divergence, never in the backend
    if (!serverSrc.includes(`"${t.name}"`)) {
      problems.push(`Tool "${t.name}" no longer appears (by name) in pen-editor-backend/src/mcp/server.ts.`);
    }
  }

  for (const propertyName of collectPropertyNames(TOOLS)) {
    if (propertyName === "tabId") continue; // desktop-only addition, never in the backend
    if (!toolsSrc.includes(propertyName)) {
      problems.push(`Property "${propertyName}" no longer appears in pen-editor-backend/src/ai/tools.ts.`);
    }
  }

  for (const enumValue of [...BATCH_GET_PATTERN_TYPES, ...GUIDELINE_TOPICS]) {
    if (!toolsSrc.includes(enumValue)) {
      problems.push(`Enum member "${enumValue}" no longer appears in pen-editor-backend/src/ai/tools.ts.`);
    }
  }

  return problems;
}

function collectPropertyNames(tools: ToolDef[]): Set<string> {
  const names = new Set<string>();
  const walk = (schema: Record<string, unknown>) => {
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties) return;
    for (const [key, value] of Object.entries(properties)) {
      names.add(key);
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (v.type === "array" && v.items && typeof v.items === "object") {
          walk(v.items as Record<string, unknown>);
        } else if (v.type === "object") {
          walk(v);
        }
      }
    }
  };
  for (const t of tools) walk(t.inputSchema);
  return names;
}

function main(): void {
  writeManifest();
  const problems = verifyAgainstBackend();
  if (problems.length > 0) {
    console.error("\nPossible drift between toolManifest.json and pen-editor-backend:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nReview the backend diff and update TOOLS in this script if these are real changes.");
    process.exitCode = 1;
  } else {
    console.log("Drift check: nothing obvious rotted.");
  }
}

if (require.main === module) {
  main();
}
