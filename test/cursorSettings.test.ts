import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readCursorSettings,
  writeCursorSettings,
  defaultCursorSettings,
  resolveCursorSettings,
} from "../src/main/cursorSettings";

describe("cursorSettings", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pen-cursor-settings-"));
    file = path.join(dir, "cursor-settings.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("defaults when the file is missing", () => {
    expect(readCursorSettings(file)).toEqual({ enabled: true });
    expect(defaultCursorSettings()).toEqual({ enabled: true });
  });

  it("round-trips a write", () => {
    expect(writeCursorSettings(file, { enabled: false })).toBe(true);
    expect(readCursorSettings(file)).toEqual({ enabled: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ enabled: false });
  });

  it("creates the parent directory on write", () => {
    const nested = path.join(dir, "a", "b", "cursor-settings.json");
    expect(writeCursorSettings(nested, { enabled: true })).toBe(true);
    expect(readCursorSettings(nested).enabled).toBe(true);
  });

  it("falls back to defaults on a corrupt file or non-object JSON", () => {
    fs.writeFileSync(file, "{not json");
    expect(readCursorSettings(file)).toEqual(defaultCursorSettings());
    fs.writeFileSync(file, "42");
    expect(readCursorSettings(file)).toEqual(defaultCursorSettings());
  });

  it("falls back to the default on an invalid enabled value", () => {
    fs.writeFileSync(file, JSON.stringify({ enabled: "yes" }));
    expect(readCursorSettings(file)).toEqual({ enabled: true });
  });

  it("ignores a legacy motion field from an old file", () => {
    fs.writeFileSync(file, JSON.stringify({ motion: "comet_swoop", enabled: false }));
    expect(readCursorSettings(file)).toEqual({ enabled: false });
  });

  it("returns false instead of throwing when the write fails", () => {
    fs.writeFileSync(path.join(dir, "blocker"), "x");
    expect(writeCursorSettings(path.join(dir, "blocker", "cursor-settings.json"), defaultCursorSettings())).toBe(false);
  });
});

describe("resolveCursorSettings (env vs saved precedence)", () => {
  const saved = { enabled: false };

  it("nothing set: the saved settings apply, nothing locked", () => {
    expect(resolveCursorSettings({}, saved)).toEqual({ enabled: false, enabledLocked: false });
    expect(resolveCursorSettings({}, defaultCursorSettings())).toEqual({ enabled: true, enabledLocked: false });
  });

  it("env wins and locks the menu item", () => {
    expect(resolveCursorSettings({ PEN_DESKTOP_BROWSER_CURSOR: "on" }, saved)).toEqual({ enabled: true, enabledLocked: true });
    expect(resolveCursorSettings({ PEN_DESKTOP_BROWSER_CURSOR: "off" }, { enabled: true })).toEqual({
      enabled: false,
      enabledLocked: true,
    });
  });

  it("empty or whitespace-only env counts as unset", () => {
    expect(resolveCursorSettings({ PEN_DESKTOP_BROWSER_CURSOR: "  " }, saved)).toEqual({ enabled: false, enabledLocked: false });
  });

  it("the removed PEN_DESKTOP_BROWSER_CURSOR_MOTION env var has no effect", () => {
    expect(resolveCursorSettings({ PEN_DESKTOP_BROWSER_CURSOR_MOTION: "classic" }, saved)).toEqual({
      enabled: false,
      enabledLocked: false,
    });
  });
});
