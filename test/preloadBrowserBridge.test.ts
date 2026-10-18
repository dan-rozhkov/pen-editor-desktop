import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// A sandboxed preload cannot import a local file, so the agent panel's browser
// bridge is a copy of the editor tab's. Chosen over bundling the preloads (the
// build is plain `tsc`): this test keeps the two `makeBrowser` bodies identical
// after dropping comments and whitespace.

function makeBrowserBody(file: string): string {
  const src = readFileSync(path.join(__dirname, "../src/preload", file), "utf8");
  const start = src.indexOf("const makeBrowser = ");
  const end = src.indexOf("\nconst browser = {", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, "");
}

function browserObject(file: string): string {
  const src = readFileSync(path.join(__dirname, "../src/preload", file), "utf8");
  const start = src.indexOf("const browser = {");
  const end = src.indexOf("\n};", start);
  return src
    .slice(start, end)
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, "");
}

describe("preload browser bridge", () => {
  it("the agent panel's makeBrowser equals the editor tab's", () => {
    expect(makeBrowserBody("agentPanel.ts")).toBe(makeBrowserBody("tab.ts"));
  });
  it("the isolated()/closeSession wrapper is the same", () => {
    expect(browserObject("agentPanel.ts")).toBe(browserObject("tab.ts"));
  });
});
