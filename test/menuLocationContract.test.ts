import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Finding 7: the amber/red tooltip (tabbar/renderer.ts), the README, and the
// design plan's Task 11 must all agree on where the MCP status line and
// "Use this app for MCP" actually live — menu.ts's own test
// (test/menu.test.ts) pins that they are appended to the **File** submenu,
// not the real macOS app menu. This file pins the *prose* side: nobody can
// silently revert the tooltip/README wording back to "the app menu" (which
// would send a user to the wrong menu on macOS, where a real
// `{ role: "appMenu" }` exists and has nothing MCP-related in it) without
// this test failing.
const root = resolve(__dirname, "..");
const rendererSrc = readFileSync(resolve(root, "src/tabbar/renderer.ts"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

describe("MCP menu location <-> wording contract", () => {
  it("the not-published/error tooltip in renderer.ts points at the File menu", () => {
    expect(rendererSrc).toMatch(/File menu/);
    expect(rendererSrc).not.toMatch(/app menu/i);
  });

  it("README describes 'Use this app for MCP' as living in the File menu, not 'the app menu'", () => {
    expect(readme).toMatch(/File menu.*Use this app for MCP|Use this app for MCP.*File menu/s);
    expect(readme).not.toMatch(/app menu/i);
  });
});
