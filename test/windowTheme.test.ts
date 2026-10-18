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
