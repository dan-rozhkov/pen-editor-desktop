import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createBrowserSettingsStore, defaultBrowserSettings, parseBrowserSettingsPatch, readBrowserSettings } from "../src/main/browserSettings";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bs-"));
  dirs.push(d);
  return path.join(d, "browser-settings.json");
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("readBrowserSettings", () => {
  it("defaults on a missing file", () => {
    expect(readBrowserSettings(tmp())).toEqual({ adBlock: true, mcpBrowser: false });
  });
  it("defaults on a corrupt file", () => {
    const f = tmp();
    fs.writeFileSync(f, "{nope");
    expect(readBrowserSettings(f)).toEqual(defaultBrowserSettings());
  });
  it("falls back per field on wrong types", () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ adBlock: "no", mcpBrowser: false }));
    expect(readBrowserSettings(f)).toEqual({ adBlock: true, mcpBrowser: false });
  });
  it("ignores an array", () => {
    const f = tmp();
    fs.writeFileSync(f, "[]");
    expect(readBrowserSettings(f)).toEqual(defaultBrowserSettings());
  });
});

describe("parseBrowserSettingsPatch", () => {
  it("accepts optional booleans", () => {
    expect(parseBrowserSettingsPatch({})).toEqual({});
    expect(parseBrowserSettingsPatch({ adBlock: false })).toEqual({ adBlock: false });
    expect(parseBrowserSettingsPatch({ adBlock: false, mcpBrowser: true })).toEqual({ adBlock: false, mcpBrowser: true });
  });
  it("rejects everything else", () => {
    for (const bad of [null, undefined, 1, "x", [], [true], { adBlock: 1 }, { adBlock: "true" }, { other: true }, { adBlock: true, x: 1 }, new Date(), new (class A {})()]) {
      expect(parseBrowserSettingsPatch(bad)).toBeNull();
    }
  });
});

describe("createBrowserSettingsStore", () => {
  it("persists a patch and notifies once per real change", () => {
    const f = tmp();
    const store = createBrowserSettingsStore(f);
    const cb = vi.fn();
    const off = store.onChange(cb);
    expect(store.set({ adBlock: false })).toEqual({ adBlock: false, mcpBrowser: false });
    store.set({ adBlock: false });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ adBlock: false, mcpBrowser: false });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({ adBlock: false, mcpBrowser: false });
    expect(createBrowserSettingsStore(f).get().adBlock).toBe(false);
    off();
    store.set({ adBlock: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("a failed write changes nothing, notifies nobody and returns null", () => {
    // The parent "directory" is a file: mkdir/write fail.
    const blocker = tmp();
    fs.writeFileSync(blocker, "x");
    const store = createBrowserSettingsStore(path.join(blocker, "sub", "settings.json"));
    const cb = vi.fn();
    store.onChange(cb);
    expect(store.set({ adBlock: false })).toBeNull();
    expect(store.get()).toEqual({ adBlock: true, mcpBrowser: false });
    expect(cb).not.toHaveBeenCalled();
  });
  it("get returns a copy", () => {
    const store = createBrowserSettingsStore(tmp());
    store.get().adBlock = false;
    expect(store.get().adBlock).toBe(true);
  });
});
