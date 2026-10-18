import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { resolveEditorUrl, DEFAULT_EDITOR_URL, resolveBrowserCursorEnabled, resolveBrowserCursorMotion, resetCursorMotionWarningForTests, resolveUserDataDir, resolveAgentLayoutEnabled, resolveAgentPanelUrl } from "../src/main/config";

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

describe("resolveAgentLayoutEnabled", () => {
  it("is off by default and for empty/other values", () => {
    expect(resolveAgentLayoutEnabled({})).toBe(false);
    expect(resolveAgentLayoutEnabled({ PEN_DESKTOP_AGENT_LAYOUT: "" })).toBe(false);
    expect(resolveAgentLayoutEnabled({ PEN_DESKTOP_AGENT_LAYOUT: "0" })).toBe(false);
    expect(resolveAgentLayoutEnabled({ PEN_DESKTOP_AGENT_LAYOUT: "off" })).toBe(false);
    expect(resolveAgentLayoutEnabled({ PEN_DESKTOP_AGENT_LAYOUT: "yes" })).toBe(false);
  });
  it("is on for 1/true/on, trimmed and case-insensitive", () => {
    expect(resolveAgentLayoutEnabled({ PEN_DESKTOP_AGENT_LAYOUT: "1" })).toBe(true);
    expect(resolveAgentLayoutEnabled({ PEN_DESKTOP_AGENT_LAYOUT: " TRUE " })).toBe(true);
    expect(resolveAgentLayoutEnabled({ PEN_DESKTOP_AGENT_LAYOUT: "On" })).toBe(true);
  });
});

describe("resolveAgentPanelUrl", () => {
  it("replaces /app with /agent on the default URL", () => {
    expect(resolveAgentPanelUrl(DEFAULT_EDITOR_URL)).toBe("https://pen-editor.onrender.com/agent");
  });
  it("keeps origin and port but drops the editor's query and hash", () => {
    expect(resolveAgentPanelUrl("http://localhost:5173/app?x=1&y=2#h")).toBe("http://localhost:5173/agent");
  });
  it("replaces only the last segment and keeps a base path prefix", () => {
    expect(resolveAgentPanelUrl("https://host/pen/app")).toBe("https://host/pen/agent");
    expect(resolveAgentPanelUrl("https://host/app/app")).toBe("https://host/app/agent");
  });
  it("ignores a trailing slash after app", () => {
    expect(resolveAgentPanelUrl("http://127.0.0.1:9000/app/")).toBe("http://127.0.0.1:9000/agent");
    expect(resolveAgentPanelUrl("https://host/pen/app/?q=1")).toBe("https://host/pen/agent");
  });
  it("appends agent beside the last segment when the path does not end in app", () => {
    expect(resolveAgentPanelUrl("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000/agent");
    expect(resolveAgentPanelUrl("http://127.0.0.1:9000/other")).toBe("http://127.0.0.1:9000/agent");
    expect(resolveAgentPanelUrl("https://host/pen/x")).toBe("https://host/pen/agent");
    expect(resolveAgentPanelUrl("https://host/pen/")).toBe("https://host/pen/agent");
    expect(resolveAgentPanelUrl("https://host/application")).toBe("https://host/agent");
  });
  it("follows a PEN_DESKTOP_URL override", () => {
    const url = resolveEditorUrl({ PEN_DESKTOP_URL: "https://staging.example.com/app?flag=1" });
    expect(resolveAgentPanelUrl(url)).toBe("https://staging.example.com/agent");
  });
});
