import { describe, expect, it } from "vitest";
import { resolveWindowTheme } from "../src/main/windowTheme";

describe("resolveWindowTheme", () => {
  it("uses the system theme before any editor reported", () => {
    expect(resolveWindowTheme({ activeTheme: null, remembered: null, system: "light" })).toEqual({ theme: "light", remembered: null });
  });

  it("an editor theme wins and is remembered", () => {
    expect(resolveWindowTheme({ activeTheme: "dark", remembered: null, system: "light" })).toEqual({ theme: "dark", remembered: "dark" });
    expect(resolveWindowTheme({ activeTheme: "light", remembered: "dark", system: "dark" })).toEqual({ theme: "light", remembered: "light" });
  });

  it("keeps the remembered editor theme with no editor tab, ignoring the system theme", () => {
    expect(resolveWindowTheme({ activeTheme: null, remembered: "dark", system: "light" })).toEqual({ theme: "dark", remembered: "dark" });
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { adoptPanelTheme, shouldReadPanelTheme, contentBackground, fallbackTheme, glassTint, isPanelDocument, ISLAND_BG, GLASS_ALPHA_DIFFERENT, GLASS_ALPHA_SAME } from "../src/main/windowTheme";

describe("adoptPanelTheme", () => {
  it("adopts the panel theme until an editor reported", () => {
    expect(adoptPanelTheme({ remembered: null, fromPanel: false }, "dark", 0)).toEqual({ remembered: "dark", fromPanel: true, changed: true });
    expect(adoptPanelTheme({ remembered: "dark", fromPanel: true }, "light", 1)).toEqual({ remembered: "light", fromPanel: true, changed: true });
    expect(adoptPanelTheme({ remembered: "dark", fromPanel: true }, "dark", 1).changed).toBe(false);
  });
  it("never overrides an editor's report while an editor tab exists", () => {
    expect(adoptPanelTheme({ remembered: "light", fromPanel: false }, "dark", 2)).toEqual({ remembered: "light", fromPanel: false, changed: false });
  });
  it("lets the panel win again when there are zero editor tabs (stale editor theme)", () => {
    expect(adoptPanelTheme({ remembered: "light", fromPanel: false }, "dark", 0)).toEqual({ remembered: "dark", fromPanel: true, changed: true });
  });
});

describe("shouldReadPanelTheme", () => {
  const base = { remembered: "light" as const, fromPanel: false, editorTabs: 1, now: 5000, lastRead: 0, throttleMs: 1000 };
  it("does not read while an editor is the source", () => {
    expect(shouldReadPanelTheme(base)).toBe(false);
  });
  it("reads while nothing is remembered, the panel is the source, or there are zero editor tabs", () => {
    expect(shouldReadPanelTheme({ ...base, remembered: null })).toBe(true);
    expect(shouldReadPanelTheme({ ...base, fromPanel: true })).toBe(true);
    expect(shouldReadPanelTheme({ ...base, editorTabs: 0 })).toBe(true);
  });
  it("throttles, except with throttleMs 0", () => {
    expect(shouldReadPanelTheme({ ...base, remembered: null, lastRead: 4500 })).toBe(false);
    expect(shouldReadPanelTheme({ ...base, remembered: null, lastRead: 4500, throttleMs: 0 })).toBe(true);
  });
});

describe("agent layout colours", () => {
  it("dark island = frontend panel surface; flag-off dark content is unchanged", () => {
    expect(contentBackground("dark", true)).toBe("#2a2a2a");
    expect(contentBackground("dark", false)).toBe("#1a1a1a");
    expect(contentBackground("light", true)).toBe("#ffffff");
    expect(contentBackground("light", false)).toBe("#ffffff");
  });
  it("falls back to light in the agent layout regardless of the OS", () => {
    expect(fallbackTheme(true, true)).toBe("light");
    expect(fallbackTheme(false, true)).toBe("dark");
    expect(fallbackTheme(false, false)).toBe("light");
  });
  it("tokens.css --island-bg equals the TS constants", () => {
    const css = readFileSync(path.join(__dirname, "../src/tabbar/tokens.css"), "utf8");
    expect(css).toContain(`--island-bg: light-dark(${ISLAND_BG.light}, ${ISLAND_BG.dark});`);
  });
});

describe("isPanelDocument", () => {
  const panel = "https://x.test/agent";
  it("accepts the panel page and subpaths, rejects others", () => {
    expect(isPanelDocument("https://x.test/agent", panel)).toBe(true);
    expect(isPanelDocument("https://x.test/agent/chat/1?q=1", panel)).toBe(true);
    expect(isPanelDocument("https://x.test/app", panel)).toBe(false);
    expect(isPanelDocument("https://x.test/agentx", panel)).toBe(false);
    expect(isPanelDocument("https://evil.test/agent", panel)).toBe(false);
    expect(isPanelDocument("file:///app/assets/offline.html", panel)).toBe(false);
    expect(isPanelDocument("not a url", panel)).toBe(false);
  });
});

describe("glassTint", () => {
  it("is light-handed when the editor theme matches the OS, stronger when it differs", () => {
    expect(glassTint("light", false).alpha).toBe(GLASS_ALPHA_SAME);
    expect(glassTint("dark", true).alpha).toBe(GLASS_ALPHA_SAME);
    expect(glassTint("light", true).alpha).toBe(GLASS_ALPHA_DIFFERENT);
    expect(glassTint("dark", false).alpha).toBe(GLASS_ALPHA_DIFFERENT);
  });
  it("uses the editor theme's colour", () => {
    expect(glassTint("light", true).color).toMatch(/^rgba\(244, 245, 248, /);
    expect(glassTint("dark", false).color).toMatch(/^rgba\(28, 28, 30, /);
  });
});
