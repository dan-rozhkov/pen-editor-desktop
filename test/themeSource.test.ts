import { describe, expect, it } from "vitest";
import { createThemeSource } from "../src/main/themeSource";

describe("themeSource", () => {
  it("follows the system until a window pushes, then the pushed value", () => {
    let sys: "light" | "dark" = "light";
    const src = createThemeSource(() => sys);
    expect(src.current()).toBe("light");
    expect(src.set("a", "dark")).toBe(true);
    sys = "light";
    expect(src.current()).toBe("dark");
  });

  it("falls back to the system (and follows it) once the last pushing window withdraws", () => {
    let sys: "light" | "dark" = "light";
    const src = createThemeSource(() => sys);
    src.set("a", "dark");
    expect(src.set("a", null)).toBe(true);
    expect(src.current()).toBe("light");
    sys = "dark";
    expect(src.current()).toBe("dark");
  });

  it("without a focused window the latest push of any open window wins", () => {
    const src = createThemeSource(() => "light");
    src.set("a", "dark");
    src.set("b", "light");
    expect(src.current()).toBe("light");
    src.set("a", "dark"); // a pushes again: now the latest
    expect(src.current()).toBe("dark");
    src.set("a", null);
    expect(src.current()).toBe("light");
    src.set("b", null);
    expect(src.current()).toBe("light");
  });

  it("follows the window focused last, not the one that pushed last", () => {
    const src = createThemeSource(() => "light");
    src.set("a", "dark");
    src.set("b", "light");
    expect(src.focus("a")).toBe(true);
    expect(src.current()).toBe("dark");
    // b pushes in the background: a stays in charge.
    expect(src.set("b", "light")).toBe(false);
    expect(src.current()).toBe("dark");
    // a changes its own theme: followed.
    expect(src.set("a", "light")).toBe(true);
    expect(src.current()).toBe("light");
    expect(src.focus("b")).toBe(false);
  });

  it("falls back to another open window when the focused one closes, then to the system", () => {
    const src = createThemeSource(() => "light");
    src.set("a", "dark");
    src.set("b", "dark");
    src.set("c", "dark");
    src.focus("a");
    src.set("c", "light");
    expect(src.current()).toBe("dark");
    expect(src.set("a", null)).toBe(true); // any open window: the latest push, c
    expect(src.current()).toBe("light");
    src.set("b", null);
    src.set("c", null);
    expect(src.current()).toBe("light");
  });

  it("focus on a window that never pushed changes nothing", () => {
    const src = createThemeSource(() => "light");
    src.set("a", "dark");
    expect(src.focus("ghost")).toBe(false);
    expect(src.current()).toBe("dark");
  });
});
