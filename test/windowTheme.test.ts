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

import { adoptPanelTheme, glassTint, isPanelDocument, GLASS_ALPHA_DIFFERENT, GLASS_ALPHA_SAME } from "../src/main/windowTheme";

describe("adoptPanelTheme", () => {
  it("adopts the panel theme until an editor reported", () => {
    expect(adoptPanelTheme({ remembered: null, fromPanel: false }, "dark")).toEqual({ remembered: "dark", fromPanel: true, changed: true });
    expect(adoptPanelTheme({ remembered: "dark", fromPanel: true }, "light")).toEqual({ remembered: "light", fromPanel: true, changed: true });
    expect(adoptPanelTheme({ remembered: "dark", fromPanel: true }, "dark").changed).toBe(false);
  });
  it("never overrides an editor's report", () => {
    expect(adoptPanelTheme({ remembered: "light", fromPanel: false }, "dark")).toEqual({ remembered: "light", fromPanel: false, changed: false });
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
