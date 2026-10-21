import { describe, it, expect } from "vitest";
import { resolveEditorUrl, DEFAULT_EDITOR_URL, resolveBrowserCursorEnabled, resolveUserDataDir, resolveStorageIdentity, LEGACY_APP_NAME, DISPLAY_APP_NAME, resolveAgentPanelUrl, resolveCanvasTabUrl, resolveDocTabUrl, isValidDocId, docIdOfUrl, isDocPageUrl, isDocPageOn, resolveWorkflowTabUrl, isValidWorkflowId, workflowIdOfUrl, resolveTraceTabUrl, resolveSettingsTabUrl, isValidSettingsSection, SETTINGS_SECTIONS, isValidTraceId, traceIdOfUrl, INITIAL_TABS } from "../src/main/config";

describe("resolveEditorUrl", () => {
  it("defaults to the production URL", () => {
    expect(resolveEditorUrl({})).toBe(DEFAULT_EDITOR_URL);
    // "/app" — "/" is the showcase gallery, not the editor.
    expect(DEFAULT_EDITOR_URL).toBe("https://app.sideform.pro/app");
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
    expect(resolveAgentPanelUrl(DEFAULT_EDITOR_URL)).toBe("https://app.sideform.pro/agent");
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
    expect(resolveDocTabUrl(DEFAULT_EDITOR_URL)).toBe("https://app.sideform.pro/doc?new=1&chat=off");
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

describe("resolveWorkflowTabUrl", () => {
  it("swaps /app for /workflow with new=1 or id, then chat=off", () => {
    expect(resolveWorkflowTabUrl(DEFAULT_EDITOR_URL)).toBe("https://app.sideform.pro/workflow?new=1&chat=off");
    expect(resolveWorkflowTabUrl("http://localhost:5173/app", "wf_0123456789ab")).toBe("http://localhost:5173/workflow?id=wf_0123456789ab&chat=off");
  });
  it("keeps prefix and other params, drops hash, replaces id/new/chat", () => {
    expect(resolveWorkflowTabUrl("https://h/pen/app?q=1&id=old&new=1&chat=on#x", "wf_a")).toBe("https://h/pen/workflow?q=1&id=wf_a&chat=off");
    expect(resolveWorkflowTabUrl("https://h/app/")).toBe("https://h/workflow?new=1&chat=off");
  });
});

describe("workflow id and page helpers", () => {
  it("isValidWorkflowId accepts wf_ + 1-64 alphanumerics only", () => {
    expect(isValidWorkflowId("wf_0123456789ab")).toBe(true);
    expect(isValidWorkflowId("wf_" + "a".repeat(64))).toBe(true);
    for (const bad of ["", "wf_", "abc", "wf_a-b", "wf_a b", "wf_../x", "wf_" + "a".repeat(65), 5, null, undefined, {}]) expect(isValidWorkflowId(bad)).toBe(false);
  });
  it("workflowIdOfUrl", () => {
    expect(workflowIdOfUrl("https://h/workflow?id=wf_a&chat=off")).toBe("wf_a");
    expect(workflowIdOfUrl("https://h/workflow?new=1")).toBeNull();
    expect(workflowIdOfUrl("nope")).toBeNull();
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

describe("isDocPageUrl", () => {
  it("is true only when the last path segment is doc", () => {
    for (const ok of ["https://h/doc", "https://h/doc/", "https://h/doc?id=a&chat=off", "https://h/pre/doc"]) expect(isDocPageUrl(ok)).toBe(true);
    for (const bad of ["https://h/", "https://h/app", "https://h/doc/x", "https://h/docs", "https://h/trace/doc/a", "not a url"]) expect(isDocPageUrl(bad)).toBe(false);
  });
});

describe("isDocPageOn", () => {
  it("needs the doc page on exactly the editor origin", () => {
    expect(isDocPageOn("https://h/doc?id=a", "https://h")).toBe(true);
    expect(isDocPageOn("https://other/doc", "https://h")).toBe(false);
    expect(isDocPageOn("http://h/doc", "https://h")).toBe(false);
    expect(isDocPageOn("https://h/app", "https://h")).toBe(false);
    expect(isDocPageOn(undefined, "https://h")).toBe(false);
    expect(isDocPageOn("nope", "https://h")).toBe(false);
  });
});

describe("resolveTraceTabUrl", () => {
  it("swaps the /app path for /trace/<id> and adds src=local&chat=off", () => {
    expect(resolveTraceTabUrl(DEFAULT_EDITOR_URL, "abc_1-X")).toBe("https://app.sideform.pro/trace/abc_1-X?src=local&chat=off");
  });
  it("keeps the path prefix and other params, drops the hash, replaces src and chat", () => {
    expect(resolveTraceTabUrl("https://h/pen/app?q=1&src=cloud&chat=on#f", "t1")).toBe("https://h/pen/trace/t1?q=1&src=local&chat=off");
  });
  it("handles /app/ and a path not ending in app", () => {
    expect(resolveTraceTabUrl("https://h/app/", "t")).toBe("https://h/trace/t?src=local&chat=off");
    expect(resolveTraceTabUrl("https://h/pen/x", "t")).toBe("https://h/pen/trace/t?src=local&chat=off");
  });
});

describe("isValidTraceId / traceIdOfUrl", () => {
  it("accepts 1-64 of A-Za-z0-9_- only", () => {
    expect(isValidTraceId("a")).toBe(true);
    expect(isValidTraceId("a".repeat(64))).toBe(true);
    for (const bad of ["", "a".repeat(65), "a b", "a/b", "..", "../x", "a?b", 5, null, undefined]) expect(isValidTraceId(bad)).toBe(false);
  });
  it("reads the id from the path of a trace URL", () => {
    expect(traceIdOfUrl("https://h/trace/abc?src=local&chat=off")).toBe("abc");
    expect(traceIdOfUrl("https://h/pen/trace/abc")).toBe("abc");
    expect(traceIdOfUrl("https://h/doc?id=abc")).toBeNull();
    expect(traceIdOfUrl("https://h/trace/")).toBeNull();
    expect(traceIdOfUrl("https://h/trace/a%20b")).toBeNull();
    expect(traceIdOfUrl("not a url")).toBeNull();
  });
});

describe("resolveCanvasTabUrl", () => {
  it("adds chat=off to the default editor URL", () => {
    expect(resolveCanvasTabUrl(DEFAULT_EDITOR_URL)).toBe("https://app.sideform.pro/app?chat=off");
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

describe("resolveSettingsTabUrl", () => {
  it("swaps the /app path for /settings and adds chat=off", () => {
    expect(resolveSettingsTabUrl(DEFAULT_EDITOR_URL)).toBe("https://app.sideform.pro/settings?chat=off");
  });
  it("adds section after chat=off for each valid section", () => {
    for (const id of SETTINGS_SECTIONS) {
      expect(resolveSettingsTabUrl("http://localhost:5173/app", id)).toBe(`http://localhost:5173/settings?chat=off&section=${id}`);
    }
  });
  it("drops an invalid or non-string section", () => {
    for (const bad of ["nope", "", "Account", "account&x=1", 5, null, {}]) {
      expect(resolveSettingsTabUrl("https://h/app", bad)).toBe("https://h/settings?chat=off");
    }
  });
  it("keeps the path prefix and other params, drops the hash, replaces chat and section", () => {
    expect(resolveSettingsTabUrl("https://h/pen/app?q=1&chat=on&section=agent#frame", "canvas")).toBe("https://h/pen/settings?q=1&chat=off&section=canvas");
  });
  it("handles /app/ and a path not ending in app like the panel URL", () => {
    expect(resolveSettingsTabUrl("https://h/app/")).toBe("https://h/settings?chat=off");
    expect(resolveSettingsTabUrl("https://h/pen/x")).toBe("https://h/pen/settings?chat=off");
  });
});

describe("isValidSettingsSection", () => {
  it("accepts exactly the six section ids", () => {
    expect([...SETTINGS_SECTIONS]).toEqual(["account", "appearance", "canvas", "agent", "browser", "integrations", "shortcuts"]);
    for (const id of SETTINGS_SECTIONS) expect(isValidSettingsSection(id)).toBe(true);
    for (const bad of ["", "other", "constructor", 1, undefined, null]) expect(isValidSettingsSection(bad)).toBe(false);
  });
});
