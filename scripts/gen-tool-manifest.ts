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
    name: "read_comments",
    description:
      "Read canvas comment threads (feedback pins). Each thread carries an order number, resolved state, and — when anchored to a node — that node's id and name. Pass threadId for a single thread, or omit it to list all threads.",
    inputSchema: bridged({
      properties: {
        includeResolved: {
          type: "boolean",
          description: "Whether to include resolved threads. Default false (only unresolved threads are returned).",
        },
        threadId: { type: "string", description: "If given, return only this thread instead of the full list." },
      },
    }),
  },
  {
    name: "reply_comment",
    description: "Append a reply to an existing comment thread, authored by you (the agent).",
    inputSchema: bridged({
      properties: {
        threadId: { type: "string", description: "The id of the thread to reply to." },
        text: { type: "string", description: "The reply message body (non-empty)." },
      },
      required: ["threadId", "text"],
    }),
  },
  {
    name: "resolve_comment",
    description: "Mark a comment thread as resolved, after you've addressed what it asked for.",
    inputSchema: bridged({
      properties: { threadId: { type: "string", description: "The id of the thread to resolve." } },
      required: ["threadId"],
    }),
  },
  {
    name: "leave_comment",
    description:
      "Drop one or more comment pins authored by you (the agent), each starting a new thread. Pass a batch of 1-50 comments in one call. Each item needs nodeId (anchors to that node's center) or both x and y (a world-space canvas point). Returns the created thread numbers.",
    inputSchema: bridged({
      properties: {
        comments: {
          type: "array",
          description: "Batch of comments to leave in this single call (1-50). Each item needs nodeId, or both x and y.",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              nodeId: {
                type: "string",
                description:
                  "Id of the node to anchor this comment to (pin defaults to the node's center). Omit if using x/y instead.",
              },
              x: {
                type: "number",
                description: "World-space canvas x coordinate for the pin. Required together with y when nodeId is omitted.",
              },
              y: {
                type: "number",
                description: "World-space canvas y coordinate for the pin. Required together with x when nodeId is omitted.",
              },
              text: { type: "string", description: "The comment body (non-empty). Be specific and actionable." },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
      },
      required: ["comments"],
    }),
  },
  {
    name: "read_embed_html",
    description:
      "Read part of an existing embed node's HTML without pulling the whole document into context. `outline` (default) returns the tag structure with attributes intact and text/deep subtrees elided; `grep` returns lines matching a literal substring with surrounding context, for byte-exact anchors to feed edit_embed_html; `full` returns the entire HTML. Always read before editing.",
    inputSchema: bridged({
      properties: {
        nodeId: { type: "string", description: "Id of the embed node to read." },
        mode: {
          type: "string",
          description: "outline = elided structure, grep = matches for `pattern`, full = entire HTML.",
          enum: ["outline", "grep", "full"],
          default: "outline",
        },
        pattern: {
          type: "string",
          description: "Literal substring to search for (not a regex). Required when mode is 'grep'.",
        },
        contextLines: {
          type: "number",
          description: "Lines of context around each grep match.",
          minimum: 0,
          maximum: 20,
          default: 2,
        },
        maxDepth: {
          type: "number",
          description: "Nesting depth kept in outline mode; deeper subtrees are summarized.",
          minimum: 1,
          maximum: 12,
          default: 4,
        },
      },
      required: ["nodeId"],
    }),
  },
  {
    name: "edit_embed_html",
    description:
      "Apply targeted text edits to an existing embed node's HTML instead of rewriting the whole screen. Each edit replaces an exact substring (oldString) with newString; an empty newString deletes the match. ALWAYS use this — never rewrite the whole htmlContent — when changing part of a screen that already exists: rewriting a whole screen costs thousands of tokens and silently drifts parts you weren't asked to touch. Read the fragment with read_embed_html first.",
    inputSchema: bridged({
      properties: {
        nodeId: { type: "string", description: "Id of the embed node to edit." },
        edits: {
          type: "array",
          description: "Edits applied in order, each against the result of the previous one.",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              oldString: {
                type: "string",
                description: "Exact substring to find. Must occur exactly once unless replaceAll is true.",
              },
              newString: {
                type: "string",
                description: "Replacement text. An empty string deletes the matched fragment.",
              },
              replaceAll: {
                type: "boolean",
                description: "Replace every occurrence instead of requiring a unique match.",
              },
            },
            required: ["oldString", "newString"],
            additionalProperties: false,
          },
        },
      },
      required: ["nodeId", "edits"],
    }),
  },
  {
    name: "rename_layers",
    description:
      "Rename one or more layers (nodes) to logical, human-readable names in a single undoable step. Read each layer's type, text content, and hierarchy first (via get_editor_state / batch_get) so the names reflect each layer's role.",
    inputSchema: bridged({
      properties: {
        renames: {
          type: "array",
          description: "One {id, name} entry per layer to rename.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The node id to rename." },
              name: { type: "string", description: "The new layer name (non-empty)." },
            },
            required: ["id", "name"],
            additionalProperties: false,
          },
        },
      },
      required: ["renames"],
    }),
  },
  {
    name: "find_empty_space_on_canvas",
    description:
      "Find available empty space on the canvas in a given direction with the specified dimensions. Use before inserting new top-level frames to avoid overlapping.",
    inputSchema: bridged({
      properties: {
        direction: {
          type: "string",
          description: "Direction to search for empty space.",
          enum: ["top", "right", "bottom", "left"],
        },
        width: { type: "number", description: "Required width of empty space." },
        height: { type: "number", description: "Required height of empty space." },
        padding: { type: "number", description: "Minimum distance from other elements." },
        nodeId: {
          type: "string",
          description: "Reference node to search around. Omit to search around entire canvas content.",
        },
      },
      required: ["direction", "width", "height", "padding"],
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
  const toolNamesPath = join(backendRoot, "src", "mcp", "toolNames.ts");
  const toolsPath = join(backendRoot, "src", "ai", "tools.ts");
  if (!existsSync(serverPath) || !existsSync(toolNamesPath) || !existsSync(toolsPath)) {
    console.log("No sibling ../pen-editor-backend checkout found — skipping drift verification.");
    return [];
  }

  const serverSrc = readFileSync(serverPath, "utf8");
  const toolNamesSrc = readFileSync(toolNamesPath, "utf8");
  const toolsSrc = readFileSync(toolsPath, "utf8");
  const problems: string[] = [];

  for (const t of TOOLS) {
    if (t.name === "list_editor_tabs") continue; // deliberate divergence, never in the backend
    // Tool names/descriptions are registered in server.ts (registerTool calls);
    // the BRIDGED_TOOL_NAMES/STATIC_TOOL_NAMES lists themselves live in
    // toolNames.ts (server.ts just re-exports them) — check both.
    if (!serverSrc.includes(`"${t.name}"`) && !toolNamesSrc.includes(`"${t.name}"`)) {
      problems.push(
        `Tool "${t.name}" no longer appears (by name) in pen-editor-backend/src/mcp/server.ts or toolNames.ts.`,
      );
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
