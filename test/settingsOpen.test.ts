import { describe, expect, it, vi } from "vitest";
import { openSettings, type SettingsOpenDeps } from "../src/main/settingsOpen";

function deps(over: Partial<SettingsOpenDeps> = {}): SettingsOpenDeps {
  return {
    isPanel: (id) => id === 1,
    isPageTab: (id) => id === 2,
    openSettingsTab: vi.fn(),
    ...over,
  };
}

describe("settings:open", () => {
  it("opens from the agent panel", () => {
    const d = deps();
    expect(openSettings(d, 1, "agent")).toEqual({ ok: true });
    expect(d.openSettingsTab).toHaveBeenCalledWith("agent");
  });

  it("opens from a frontend tab, with no section", () => {
    const d = deps();
    expect(openSettings(d, 2, undefined)).toEqual({ ok: true });
    expect(d.openSettingsTab).toHaveBeenCalledWith(undefined);
  });

  it("accepts each of the six sections", () => {
    for (const s of ["account", "appearance", "canvas", "agent", "integrations", "shortcuts"]) {
      const d = deps();
      expect(openSettings(d, 1, s)).toEqual({ ok: true });
      expect(d.openSettingsTab).toHaveBeenCalledWith(s);
    }
  });

  it("ignores an invalid section but still opens the tab", () => {
    for (const bad of ["nope", "", 3, null, {}, ["agent"]]) {
      const d = deps();
      expect(openSettings(d, 1, bad)).toEqual({ ok: true });
      expect(d.openSettingsTab).toHaveBeenCalledWith(undefined);
    }
  });

  it("refuses any other sender (browser tab, tab bar, unknown)", () => {
    const d = deps();
    for (const sender of [3, 99]) expect(openSettings(d, sender, "agent")).toEqual({ ok: false });
    expect(d.openSettingsTab).not.toHaveBeenCalled();
  });

  it("returns ok:false when opening throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ openSettingsTab: () => { throw new Error("boom"); } });
    expect(openSettings(d, 1, "agent")).toEqual({ ok: false });
    err.mockRestore();
  });
});
