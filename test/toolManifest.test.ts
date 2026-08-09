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

// Vitest runs with cwd = pen-editor-desktop/, the sibling backend repo lives
// next to it.
const serverPath = resolve(process.cwd(), "../pen-editor-backend/src/mcp/server.ts");
const backendExists = existsSync(serverPath);

/** Extracts the string literals of a `export const NAME = [...] as const;` array. */
function extractNamedStringArray(src: string, exportName: string): string[] {
  const match = new RegExp(`export const ${exportName}[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
  if (!match) throw new Error(`Could not find ${exportName} in backend server.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe.runIf(backendExists)("tool manifest — bridged set matches pen-editor-backend", () => {
  const src = backendExists ? readFileSync(serverPath, "utf8") : "";
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
