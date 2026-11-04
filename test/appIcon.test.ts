import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  APP_ICON_IDS, APP_ICON_LABELS, APP_ICON_SETTINGS_FILE, DEFAULT_APP_ICON, appIconPath, createAppIconService,
  parseAppIconId, readAppIconSettings, shouldApplyAtStartup, writeAppIconSettings,
} from "../src/main/appIcon";

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "appicon-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("settings file", () => {
  it("defaults on missing, corrupt and unknown", () => {
    const f = path.join(dir, APP_ICON_SETTINGS_FILE);
    expect(readAppIconSettings(f)).toBe("white");
    fs.writeFileSync(f, "{nope");
    expect(readAppIconSettings(f)).toBe("white");
    fs.writeFileSync(f, JSON.stringify({ icon: "red" }));
    expect(readAppIconSettings(f)).toBe("white");
    fs.writeFileSync(f, "null");
    expect(readAppIconSettings(f)).toBe("white");
  });
  it("round-trips and writes the documented shape", () => {
    const f = path.join(dir, "sub", APP_ICON_SETTINGS_FILE);
    expect(writeAppIconSettings(f, "shader")).toBe(true);
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({ icon: "shader" });
    expect(readAppIconSettings(f)).toBe("shader");
  });
  it("a failed write returns false and does not throw", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    expect(writeAppIconSettings(path.join(blocker, "x.json"), "black")).toBe(false);
  });
});

describe("helpers", () => {
  it("ids, labels, parse, path", () => {
    expect(APP_ICON_IDS).toEqual(["white", "black", "shader"]);
    expect(APP_ICON_LABELS).toEqual({ white: "White", black: "Black", shader: "Gradient" });
    expect(DEFAULT_APP_ICON).toBe("white");
    expect(parseAppIconId("black")).toBe("black");
    for (const v of ["red", "", 1, null, undefined, {}]) expect(parseAppIconId(v)).toBeNull();
    expect(appIconPath("/a", "shader")).toBe(path.join("/a", "shader.png"));
  });
  it("shouldApplyAtStartup", () => {
    const t = (platform: string, isPackaged: boolean, icon: "white" | "black") => shouldApplyAtStartup({ platform, isPackaged, icon });
    expect(t("darwin", false, "white")).toBe(true);
    expect(t("darwin", true, "white")).toBe(false);
    expect(t("darwin", true, "black")).toBe(true);
    expect(t("linux", false, "black")).toBe(false);
    expect(t("win32", true, "black")).toBe(false);
  });
});

describe("service", () => {
  function make(over: Partial<Parameters<typeof createAppIconService>[0]> = {}) {
    const setDockIcon = vi.fn();
    const preview = vi.fn((p: string) => `data:image/png;base64,${path.basename(p)}`);
    const settingsPath = path.join(dir, APP_ICON_SETTINGS_FILE);
    const svc = createAppIconService({ platform: "darwin", isPackaged: true, settingsPath, assetsDir: "/assets", setDockIcon, preview, ...over });
    return { svc, setDockIcon, preview, settingsPath };
  }
  it("applyAtStartup follows shouldApplyAtStartup", () => {
    const a = make({ isPackaged: false });
    a.svc.applyAtStartup();
    expect(a.setDockIcon).toHaveBeenCalledWith(path.join("/assets", "white.png"));
    const b = make();
    b.svc.applyAtStartup();
    expect(b.setDockIcon).not.toHaveBeenCalled();
    fs.writeFileSync(b.settingsPath, JSON.stringify({ icon: "black" }));
    const c = make();
    c.svc.applyAtStartup();
    expect(c.setDockIcon).toHaveBeenCalledWith(path.join("/assets", "black.png"));
  });
  it("state lists the three options", () => {
    const s = make().svc.state();
    expect(s.selected).toBe("white");
    expect(s.options).toEqual([
      { id: "white", label: "White", preview: "data:image/png;base64,white.png" },
      { id: "black", label: "Black", preview: "data:image/png;base64,black.png" },
      { id: "shader", label: "Gradient", preview: "data:image/png;base64,shader.png" },
    ]);
  });
  it("set writes the file, sets the Dock icon and returns the state", () => {
    const m = make();
    const r = m.svc.set("shader");
    expect(r).toMatchObject({ selected: "shader" });
    expect(readAppIconSettings(m.settingsPath)).toBe("shader");
    expect(m.setDockIcon).toHaveBeenCalledWith(path.join("/assets", "shader.png"));
  });
  it("off macOS there are no options and set is refused", () => {
    const m = make({ platform: "linux" });
    expect(m.svc.state().options).toEqual([]);
    expect(m.svc.set("black")).toEqual({ error: "App icons are available on macOS only." });
    expect(m.setDockIcon).not.toHaveBeenCalled();
    expect(readAppIconSettings(m.settingsPath)).toBe("white");
  });
  it("a packaged app restores the bundle icon for the default, a dev run uses the PNG", () => {
    const packaged = make();
    packaged.svc.set("black");
    packaged.svc.set("white");
    expect(packaged.setDockIcon).toHaveBeenLastCalledWith(null);
    const dev = make({ isPackaged: false });
    dev.svc.set("white");
    expect(dev.setDockIcon).toHaveBeenLastCalledWith(path.join("/assets", "white.png"));
  });
  it("a failed write restores the Dock and changes nothing", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    const m = make({ settingsPath: path.join(blocker, "s.json") });
    expect(m.svc.set("black")).toEqual({ error: "Could not save the setting." });
    expect(m.setDockIcon).toHaveBeenLastCalledWith(null);
    expect(m.svc.state().selected).toBe("white");
  });
  it("an icon the Dock cannot load is not saved", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = make({ setDockIcon: () => { throw new Error("x"); } });
    expect(m.svc.set("black")).toEqual({ error: "Could not change the icon." });
    expect(readAppIconSettings(m.settingsPath)).toBe("white");
    expect(() => m.svc.applyAtStartup()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("a throwing preview gives an empty string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = make({ preview: () => { throw new Error("y"); } });
    expect(m.svc.state().options.map((o) => o.preview)).toEqual(["", "", ""]);
    warn.mockRestore();
  });
});
