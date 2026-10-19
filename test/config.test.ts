import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { resolveEditorUrl, DEFAULT_EDITOR_URL, resolveBrowserCursorEnabled, resolveBrowserCursorMotion, resetCursorMotionWarningForTests, resolveUserDataDir, resolveStorageIdentity, LEGACY_APP_NAME, DISPLAY_APP_NAME, resolveAgentPanelUrl, resolveCanvasTabUrl, resolveDocTabUrl, isValidDocId, docIdOfUrl, INITIAL_TABS } from "../src/main/config";

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

describe("resolveStorageIdentity", () => {
  const join = (...p: string[]) => p.join("/");
  const appData = "/AS";
  const legacy = "/AS/Pineapple Editor";
  const fresh = "/AS/Sideform Desktop";
  const mk = (dirs: string[], files: Record<string, string> = {}) => ({
    exists: (p: string) => dirs.includes(p) || p in files,
    isDirectory: (p: string) => dirs.includes(p),
    read: (p: string) => files[p] ?? null,
  });

  it("existing install: legacy dir and legacy name", () => {
    expect(resolveStorageIdentity({}, appData, mk([legacy]), join)).toEqual({ userDataDir: legacy, storageName: LEGACY_APP_NAME });
  });
  it("fresh install: new dir and new name", () => {
    expect(resolveStorageIdentity({}, appData, mk([]), join)).toEqual({ userDataDir: fresh, storageName: DISPLAY_APP_NAME });
  });
  it("the new dir wins when both exist; its identity file decides the name", () => {
    const fs = mk([legacy, fresh], { [`${fresh}/storage-identity.json`]: '{"storageName":"Pineapple Editor"}' });
    expect(resolveStorageIdentity({}, appData, fs, join)).toEqual({ userDataDir: fresh, storageName: LEGACY_APP_NAME });
  });
  it("a legacy dir that appears later does not change a fresh install", () => {
    const fs = mk([legacy, fresh], { [`${fresh}/storage-identity.json`]: '{"storageName":"Sideform Desktop"}' });
    expect(resolveStorageIdentity({}, appData, fs, join)).toEqual({ userDataDir: fresh, storageName: DISPLAY_APP_NAME });
  });
  it("a new dir without an identity file gets the new name even if legacy exists", () => {
    expect(resolveStorageIdentity({}, appData, mk([legacy, fresh]), join).storageName).toBe(DISPLAY_APP_NAME);
  });
  it("a legacy path that is a file, not a directory, is ignored", () => {
    expect(resolveStorageIdentity({}, appData, mk([], { [legacy]: "x" }), join)).toEqual({ userDataDir: fresh, storageName: DISPLAY_APP_NAME });
  });
  it("env override: its identity file decides the name; the legacy dir itself means the legacy name", () => {
    const env = { PEN_DESKTOP_USER_DATA_DIR: " /tmp/e2e " };
    const withFile = mk([], { "/tmp/e2e/storage-identity.json": '{"storageName":"Pineapple Editor"}' });
    expect(resolveStorageIdentity(env, appData, withFile, join)).toEqual({ userDataDir: "/tmp/e2e", storageName: LEGACY_APP_NAME });
    expect(resolveStorageIdentity(env, appData, mk([legacy]), join)).toEqual({ userDataDir: "/tmp/e2e", storageName: DISPLAY_APP_NAME });
    expect(resolveStorageIdentity({ PEN_DESKTOP_USER_DATA_DIR: legacy }, appData, mk([]), join).storageName).toBe(LEGACY_APP_NAME);
  });
  it("ignores a corrupt or unknown identity file", () => {
    for (const text of ["not json", '{"storageName":"Evil"}', "null"]) {
      const fs = mk([legacy], { [`${legacy}/storage-identity.json`]: text });
      expect(resolveStorageIdentity({}, appData, fs, join).storageName).toBe(LEGACY_APP_NAME);
    }
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

describe("resolveDocTabUrl", () => {
  it("swaps the /app path for /doc and adds chat=off", () => {
    expect(resolveDocTabUrl(DEFAULT_EDITOR_URL)).toBe("https://pen-editor.onrender.com/doc?new=1&chat=off");
  });
  it("drops a stray new param when an id is given", () => {
    expect(resolveDocTabUrl("https://h/app?new=1", "n1")).toBe("https://h/doc?id=n1&chat=off");
  });
  it("adds id before chat=off and encodes it", () => {
    expect(resolveDocTabUrl("http://localhost:5173/app", "abc_1-X")).toBe("http://localhost:5173/doc?id=abc_1-X&chat=off");
  });
  it("keeps the path prefix, other params and drops the hash; replaces id and chat", () => {
    expect(resolveDocTabUrl("https://h/pen/app?q=1&id=old&chat=on#frame", "n1")).toBe("https://h/pen/doc?q=1&id=n1&chat=off");
  });
  it("handles /app/ and a path not ending in app like the panel URL", () => {
    expect(resolveDocTabUrl("https://h/app/")).toBe("https://h/doc?new=1&chat=off");
    expect(resolveDocTabUrl("https://h/pen/x")).toBe("https://h/pen/doc?new=1&chat=off");
    expect(resolveDocTabUrl("https://h/")).toBe("https://h/doc?new=1&chat=off");
  });
});

describe("isValidDocId / docIdOfUrl", () => {
  it("accepts 1-64 of A-Za-z0-9_- only", () => {
    expect(isValidDocId("a")).toBe(true);
    expect(isValidDocId("A_b-9".repeat(12))).toBe(true);
    expect(isValidDocId("a".repeat(65))).toBe(false);
    for (const bad of ["", "a b", "a/b", "a&id=b", "../x", "é", 5, null, undefined, {}]) expect(isValidDocId(bad)).toBe(false);
  });
  it("reads the id param of a doc URL", () => {
    expect(docIdOfUrl("https://h/doc?id=abc&chat=off")).toBe("abc");
    expect(docIdOfUrl("https://h/doc?new=1&chat=off")).toBeNull();
    expect(docIdOfUrl("not a url")).toBeNull();
  });
});

describe("resolveCanvasTabUrl", () => {
  it("adds chat=off to the default editor URL", () => {
    expect(resolveCanvasTabUrl(DEFAULT_EDITOR_URL)).toBe("https://pen-editor.onrender.com/app?chat=off");
  });
  it("keeps other params and merges chat=off", () => {
    const u = new URL(resolveCanvasTabUrl("http://localhost:5173/app?q=1&x=a%20b"));
    expect(u.searchParams.get("q")).toBe("1");
    expect(u.searchParams.get("x")).toBe("a b");
    expect(u.searchParams.get("chat")).toBe("off");
  });
  it("replaces an existing chat value without duplicating it", () => {
    const u = new URL(resolveCanvasTabUrl("http://h/app?chat=on&q=1&chat=x"));
    expect(u.searchParams.getAll("chat")).toEqual(["off"]);
    expect(u.searchParams.get("q")).toBe("1");
  });
  it("keeps the base path and the hash", () => {
    expect(resolveCanvasTabUrl("https://h/pen/app#frame-1")).toBe("https://h/pen/app?chat=off#frame-1");
  });
  it("keeps other params byte-for-byte (no re-serialization)", () => {
    expect(resolveCanvasTabUrl("http://h/app?x=a%20b&flag&t=~v")).toBe("http://h/app?x=a%20b&flag&t=~v&chat=off");
  });
  it("drops every chat param from the raw string and keeps the order of the rest", () => {
    expect(resolveCanvasTabUrl("http://h/app?chat=on&q=1+2&chat=x&z")).toBe("http://h/app?q=1+2&z&chat=off");
    expect(resolveCanvasTabUrl("http://h/app?chat")).toBe("http://h/app?chat=off");
  });
  it("does not drop params that merely start with chat", () => {
    expect(resolveCanvasTabUrl("http://h/app?chatty=1")).toBe("http://h/app?chatty=1&chat=off");
  });
});

describe("empty start", () => {
  it("opens no initial tab", () => {
    expect(INITIAL_TABS).toEqual([]);
  });
});
