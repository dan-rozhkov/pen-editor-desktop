import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetCursorMotionWarningForTests } from "../src/main/config";
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
    expect(readCursorSettings(file)).toEqual({ motion: "signature_arc", enabled: true });
    expect(defaultCursorSettings()).toEqual({ motion: "signature_arc", enabled: true });
  });

  it("round-trips a write", () => {
    expect(writeCursorSettings(file, { motion: "comet_swoop", enabled: false })).toBe(true);
    expect(readCursorSettings(file)).toEqual({ motion: "comet_swoop", enabled: false });
  });

  it("creates the parent directory on write", () => {
    const nested = path.join(dir, "a", "b", "cursor-settings.json");
    expect(writeCursorSettings(nested, { motion: "classic", enabled: true })).toBe(true);
    expect(readCursorSettings(nested).motion).toBe("classic");
  });

  it("falls back to defaults on a corrupt file or non-object JSON", () => {
    fs.writeFileSync(file, "{not json");
    expect(readCursorSettings(file)).toEqual(defaultCursorSettings());
    fs.writeFileSync(file, "42");
    expect(readCursorSettings(file)).toEqual(defaultCursorSettings());
  });

  it("falls back per field on invalid values", () => {
    fs.writeFileSync(file, JSON.stringify({ motion: "bogus", enabled: false }));
    expect(readCursorSettings(file)).toEqual({ motion: "signature_arc", enabled: false });
    fs.writeFileSync(file, JSON.stringify({ motion: "magnetic", enabled: "yes" }));
    expect(readCursorSettings(file)).toEqual({ motion: "magnetic", enabled: true });
  });

  it("returns false instead of throwing when the write fails", () => {
    fs.writeFileSync(path.join(dir, "blocker"), "x");
    expect(writeCursorSettings(path.join(dir, "blocker", "cursor-settings.json"), defaultCursorSettings())).toBe(false);
  });
});

describe("resolveCursorSettings (env vs saved precedence)", () => {
  const saved = { motion: "magnetic" as const, enabled: false };
  beforeEach(() => resetCursorMotionWarningForTests());
  afterEach(() => vi.restoreAllMocks());

  it("nothing set: the saved settings apply, nothing locked", () => {
    expect(resolveCursorSettings({}, saved)).toEqual({ ...saved, enabledLocked: false, motionLocked: false });
    expect(resolveCursorSettings({}, defaultCursorSettings())).toEqual({
      motion: "signature_arc",
      enabled: true,
      enabledLocked: false,
      motionLocked: false,
    });
  });

  it("env wins and locks its menu items", () => {
    const r = resolveCursorSettings(
      { PEN_DESKTOP_BROWSER_CURSOR: "on", PEN_DESKTOP_BROWSER_CURSOR_MOTION: " Comet_Swoop " },
      saved,
    );
    expect(r).toEqual({ enabled: true, motion: "comet_swoop", enabledLocked: true, motionLocked: true });
    expect(resolveCursorSettings({ PEN_DESKTOP_BROWSER_CURSOR: "off" }, { motion: "classic", enabled: true })).toMatchObject({
      enabled: false,
      enabledLocked: true,
      motion: "classic",
      motionLocked: false,
    });
  });

  it("empty or whitespace-only env counts as unset for BOTH vars", () => {
    const r = resolveCursorSettings({ PEN_DESKTOP_BROWSER_CURSOR: "  ", PEN_DESKTOP_BROWSER_CURSOR_MOTION: "" }, saved);
    expect(r).toEqual({ ...saved, enabledLocked: false, motionLocked: false });
  });

  it("an invalid env motion falls back to the saved choice, unlocked", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = resolveCursorSettings({ PEN_DESKTOP_BROWSER_CURSOR_MOTION: "bogus" }, saved);
    expect(r.motion).toBe("magnetic");
    expect(r.motionLocked).toBe(false);
  });
});
