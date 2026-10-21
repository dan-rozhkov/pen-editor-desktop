import { describe, expect, it, vi } from "vitest";
import { resolveRunningApp, runningAppNames, type ResolveDeps, type RunningApp } from "../src/main/computerUse/appResolver";

const app = (over: Partial<RunningApp> & { pid: number; name: string }): RunningApp => ({ active: false, hidden: false, ...over });

const deps = (links: Record<string, string> = {}, titles: Record<number, string[]> = {}) => {
  const windowTitles = vi.fn(async (pid: number) => titles[pid] ?? []);
  const d: ResolveDeps = {
    realpath: async (p) => {
      if (p in links) return links[p];
      if (p.startsWith("/")) return p;
      throw new Error("ENOENT");
    },
    windowTitles,
  };
  return { d, windowTitles };
};

const notes = app({ pid: 10, name: "Notes", bundleId: "com.apple.Notes", bundlePath: "/System/Applications/Notes.app" });
const qure = app({ pid: 20, name: "Electron", bundleId: "com.github.Electron", bundlePath: "/Users/u/proj/node_modules/electron/dist/Electron.app" });
const orca = app({ pid: 30, name: "Orca", bundleId: "com.orca", bundlePath: "/Applications/Orca App.app" });
const apps = [notes, qure, orca];

describe("resolveRunningApp", () => {
  it("matches a path by bundlePath", async () => {
    expect(await resolveRunningApp("/System/Applications/Notes.app", apps, deps().d)).toBe(notes);
  });
  it("matches through a symlink by realpath", async () => {
    expect(await resolveRunningApp("/Applications/Link.app", apps, deps({ "/Applications/Link.app": "/Applications/Orca App.app" }).d)).toBe(orca);
  });
  it("matches a path inside the bundle", async () => {
    expect(await resolveRunningApp("/Applications/Orca App.app/Contents/MacOS/Orca", apps, deps().d)).toBe(orca);
  });
  it("does not match a sibling that only shares a prefix", async () => {
    expect(await resolveRunningApp("/Applications/Orca App.app2", apps, deps().d)).toBeNull();
  });
  it("an unknown path gives null and never falls back to names", async () => {
    const { d, windowTitles } = deps();
    expect(await resolveRunningApp("/Applications/Nope.app", apps, d)).toBeNull();
    expect(windowTitles).not.toHaveBeenCalled();
  });
  it("matches a name, trimmed and case-insensitive, without reading window titles", async () => {
    const { d, windowTitles } = deps();
    expect(await resolveRunningApp("  nOtEs ", apps, d)).toBe(notes);
    expect(windowTitles).not.toHaveBeenCalled();
  });
  it("matches the bundle file name without .app", async () => {
    expect(await resolveRunningApp("Orca App", apps, deps().d)).toBe(orca);
    expect(await resolveRunningApp("electron", apps, deps().d)).toBe(qure);
  });
  it("a relative 'Name.app' falls back to the name rule", async () => {
    expect(await resolveRunningApp("Notes.app", apps, deps().d)).toBe(notes);
  });
  it("matches the exact title of a window when no name matches", async () => {
    const { d } = deps({}, { 20: ["Qure Dev - project"], 30: ["Qure Dev"] });
    expect(await resolveRunningApp("qure dev", apps, d)).toBe(orca);
  });
  it("a title is not a substring match", async () => {
    expect(await resolveRunningApp("Qure", apps, deps({}, { 20: ["Qure Dev"] }).d)).toBeNull();
  });
  it("title lookups are sequential, stop at the first match and skip apps named by skipTitleLookup", async () => {
    const { d, windowTitles } = deps({}, { 10: ["Hello"], 20: ["Hello"], 30: ["Hello"] });
    const got = await resolveRunningApp("hello", apps, { ...d, skipTitleLookup: (a) => a.pid === 10 });
    expect(got).toBe(qure);
    expect(windowTitles.mock.calls.map((c) => c[0])).toEqual([20]);
  });
  it("a failing windowTitles skips that app", async () => {
    const d: ResolveDeps = { realpath: async (p) => p, windowTitles: async (pid) => { if (pid === 10) throw new Error("x"); return pid === 20 ? ["Hello"] : []; } };
    expect(await resolveRunningApp("hello", apps, d)).toBe(qure);
  });
  it("ties: the active app wins, then the lowest pid", async () => {
    const a = app({ pid: 5, name: "Same" });
    const b = app({ pid: 3, name: "same" });
    const c = app({ pid: 9, name: "SAME", active: true });
    expect(await resolveRunningApp("same", [a, b, c], deps().d)).toBe(c);
    expect(await resolveRunningApp("same", [a, b], deps().d)).toBe(b);
  });
  it("returns null for nothing matching or empty input", async () => {
    expect(await resolveRunningApp("zzz", apps, deps().d)).toBeNull();
    expect(await resolveRunningApp("  ", apps, deps().d)).toBeNull();
    expect(await resolveRunningApp("x", [], deps().d)).toBeNull();
  });
});

describe("runningAppNames", () => {
  it("frontmost first, then alphabetical, unique, capped", () => {
    const list = [app({ pid: 1, name: "Zed" }), app({ pid: 2, name: "Alpha" }), app({ pid: 3, name: "Alpha" }), app({ pid: 4, name: "Mid", active: true })];
    expect(runningAppNames(list)).toEqual(["Mid", "Alpha", "Zed"]);
    expect(runningAppNames(list, 2)).toEqual(["Mid", "Alpha"]);
  });
  it("defaults to 15", () => {
    const many = Array.from({ length: 30 }, (_, i) => app({ pid: i + 1, name: `App${String(i).padStart(2, "0")}` }));
    expect(runningAppNames(many)).toHaveLength(15);
  });
});
