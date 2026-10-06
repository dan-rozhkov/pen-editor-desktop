import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { resolveEditorUrl, DEFAULT_EDITOR_URL, resolveBrowserCursorEnabled, resolveBrowserCursorMotion, resetCursorMotionWarningForTests, resolveUserDataDir } from "../src/main/config";

describe("resolveEditorUrl", () => {
  it("defaults to the production URL", () => {
    expect(resolveEditorUrl({})).toBe(DEFAULT_EDITOR_URL);
    // "/app" — "/" is the showcase gallery, not the editor.
    expect(DEFAULT_EDITOR_URL).toBe("https://pen-editor.onrender.com/app");
  });

  it("honors PEN_DESKTOP_URL", () => {
    expect(
      resolveEditorUrl({ PEN_DESKTOP_URL: "http://localhost:5173/app" }),
    ).toBe("http://localhost:5173/app");
  });

  it("ignores a non-http(s) or unparseable override", () => {
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "file:///etc/passwd" })).toBe(DEFAULT_EDITOR_URL);
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "not a url" })).toBe(DEFAULT_EDITOR_URL);
  });
});

describe("resolveBrowserCursorEnabled", () => {
  it("defaults to enabled when unset", () => {
    expect(resolveBrowserCursorEnabled({})).toBe(true);
  });

  it("is disabled by off/0/false, case-insensitively", () => {
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "off" })).toBe(false);
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "OFF" })).toBe(false);
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "0" })).toBe(false);
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "false" })).toBe(false);
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "False" })).toBe(false);
  });

  it("stays enabled for any other value", () => {
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "on" })).toBe(true);
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "1" })).toBe(true);
    expect(resolveBrowserCursorEnabled({ PEN_DESKTOP_BROWSER_CURSOR: "" })).toBe(true);
  });
});

describe("resolveBrowserCursorMotion", () => {
  beforeEach(() => resetCursorMotionWarningForTests());
  afterEach(() => vi.restoreAllMocks());

  it("is undefined (default style) when unset or empty, without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveBrowserCursorMotion({})).toBeUndefined();
    expect(resolveBrowserCursorMotion({ PEN_DESKTOP_BROWSER_CURSOR_MOTION: "  " })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts each style, trimmed and case-insensitive", () => {
    for (const style of ["signature_arc", "spring_settle", "magnetic", "comet_swoop", "classic"]) {
      expect(resolveBrowserCursorMotion({ PEN_DESKTOP_BROWSER_CURSOR_MOTION: ` ${style.toUpperCase()} ` })).toBe(style);
    }
  });

  it("returns undefined for an unknown style and warns ONCE per process, saying the env value is ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveBrowserCursorMotion({ PEN_DESKTOP_BROWSER_CURSOR_MOTION: "wobbly" })).toBeUndefined();
    expect(resolveBrowserCursorMotion({ PEN_DESKTOP_BROWSER_CURSOR_MOTION: "wobbly" })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("signature_arc, spring_settle, magnetic, comet_swoop, classic");
    expect(msg).toContain("ignored");
    expect(msg).not.toContain("using the default");
  });
});

describe("resolveUserDataDir", () => {
  it("is undefined when unset or blank, trimmed otherwise", () => {
    expect(resolveUserDataDir({})).toBeUndefined();
    expect(resolveUserDataDir({ PEN_DESKTOP_USER_DATA_DIR: "  " })).toBeUndefined();
    expect(resolveUserDataDir({ PEN_DESKTOP_USER_DATA_DIR: " /tmp/x " })).toBe("/tmp/x");
  });
});
