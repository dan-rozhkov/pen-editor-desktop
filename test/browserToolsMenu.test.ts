import { describe, it, expect, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  buildBrowserToolsMenuTemplate,
  planViewportCommands,
  planClearCommands,
  fitScale,
  viewportNeedsReload,
  type BrowserToolsActions,
  type BrowserToolsState,
} from "../src/main/browserToolsMenu";

const base: BrowserToolsState = { hasDebugger: true, hasDocument: true, viewport: "responsive", devToolsOpen: false, zoomFactor: 1, zoomLevel: 0 };
const mkActions = (): BrowserToolsActions => ({ setViewport: vi.fn(), toggleDevTools: vi.fn(), setZoomFactor: vi.fn(), setZoomLevel: vi.fn() });
const sub = (items: MenuItemConstructorOptions[], label: string) =>
  items.find((i) => i.label === label)!.submenu as MenuItemConstructorOptions[];

describe("buildBrowserToolsMenuTemplate", () => {
  it("has Viewport, DevTools and Zoom in order", () => {
    const t = buildBrowserToolsMenuTemplate(base, mkActions());
    expect(t.map((i) => i.label)).toEqual(["Viewport", "Open Developer Tools", "Zoom"]);
  });

  it("lists viewport radios with the current choice checked", () => {
    const t = buildBrowserToolsMenuTemplate({ ...base, viewport: "pixel-8" }, mkActions());
    const radios = sub(t, "Viewport");
    expect(radios.every((i) => i.type === "radio")).toBe(true);
    expect(radios.map((i) => i.label)).toEqual([
      "Responsive (window size)",
      "iPhone 15 — 393×852",
      "Pixel 8 — 412×915",
      "iPad — 820×1180",
      "Desktop — 1440×900",
      "Desktop — 1920×1080",
    ]);
    expect(radios.filter((i) => i.checked).map((i) => i.label)).toEqual(["Pixel 8 — 412×915"]);
  });

  it("clicking a viewport item reports its preset id", () => {
    const a = mkActions();
    const t = buildBrowserToolsMenuTemplate(base, a);
    sub(t, "Viewport").find((i) => i.label === "iPad — 820×1180")!.click!({} as never, undefined, {} as never);
    expect(a.setViewport).toHaveBeenCalledWith("ipad");
  });

  it("disables viewport items without a debugger", () => {
    const t = buildBrowserToolsMenuTemplate({ ...base, hasDebugger: false }, mkActions());
    const radios = sub(t, "Viewport").filter((i) => i.type === "radio");
    expect(radios.length).toBe(6);
    expect(radios.every((i) => i.enabled === false)).toBe(true);
  });

  it("disables viewport items on a tab without a committed document", () => {
    const t = buildBrowserToolsMenuTemplate({ ...base, hasDocument: false }, mkActions());
    const radios = sub(t, "Viewport").filter((i) => i.type === "radio");
    expect(radios.every((i) => i.enabled === false)).toBe(true);
  });

  it("toggles the DevTools label and action", () => {
    const a = mkActions();
    const open = buildBrowserToolsMenuTemplate({ ...base, devToolsOpen: true }, a);
    expect(open[1].label).toBe("Close Developer Tools");
    open[1].click!({} as never, undefined, {} as never);
    expect(a.toggleDevTools).toHaveBeenCalledOnce();
  });

  it("checks the current zoom preset and applies clicks", () => {
    const a = mkActions();
    const t = buildBrowserToolsMenuTemplate({ ...base, zoomFactor: 1.25 }, a);
    const radios = sub(t, "Zoom").filter((i) => i.type === "radio");
    expect(radios.map((i) => i.label)).toEqual(["50%", "75%", "90%", "100%", "110%", "125%", "150%", "200%"]);
    expect(radios.filter((i) => i.checked).map((i) => i.label)).toEqual(["125%"]);
    radios[0].click!({} as never, undefined, {} as never);
    expect(a.setZoomFactor).toHaveBeenCalledWith(0.5);
  });

  it("marks a preset checked within 0.01 of the factor", () => {
    const t = buildBrowserToolsMenuTemplate({ ...base, zoomFactor: 1.1 + 0.008 }, mkActions());
    const radios = sub(t, "Zoom").filter((i) => i.type === "radio");
    expect(radios.filter((i) => i.checked).map((i) => i.label)).toEqual(["110%"]);
  });

  it("Zoom In / Out step the level by 0.5; Actual Size resets to 0", () => {
    const a = mkActions();
    const z = sub(buildBrowserToolsMenuTemplate({ ...base, zoomLevel: 1 }, a), "Zoom");
    for (const l of ["Zoom In", "Zoom Out", "Actual Size"]) z.find((i) => i.label === l)!.click!({} as never, undefined, {} as never);
    expect(vi.mocked(a.setZoomLevel).mock.calls.map((c) => c[0])).toEqual([1.5, 0.5, 0]);
  });
});

const ctx = { view: { width: 2000, height: 2000 }, chromeVersion: "130.0.6723.58" };

describe("planViewportCommands", () => {
  it("emulates a mobile preset with a full identity", () => {
    const cmds = planViewportCommands("pixel-8", ctx);
    expect(cmds.map((c) => c.method)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ]);
    const [metrics, touch, ua] = cmds;
    expect(metrics.params).toEqual({ width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, scale: 1 });
    expect(touch.params).toEqual({ enabled: true });
    expect(String(ua.params!.userAgent)).toContain("Pixel 8");
    expect(ua.params!.platform).toBe("Linux armv8l");
    const md = ua.params!.userAgentMetadata as Record<string, unknown>;
    expect(md).toMatchObject({ mobile: true, platform: "Android", model: "Pixel 8", architecture: "", fullVersion: "130.0.6723.58" });
    expect(md.brands).toEqual([{ brand: "Not.A/Brand", version: "99" }, { brand: "Chromium", version: "130" }]);
  });

  it("uses real brands when supplied and iOS platform for iPhone", () => {
    const brands = [{ brand: "Chromium", version: "131" }];
    const ua = planViewportCommands("iphone-15", { ...ctx, brands })[2];
    expect(ua.params!.platform).toBe("iPhone");
    const md = ua.params!.userAgentMetadata as Record<string, unknown>;
    expect(md.platform).toBe("iOS");
    expect(md.brands).toEqual(brands);
  });

  it("desktop presets keep touch off and never set a UA override", () => {
    const [metrics, touch, ua] = planViewportCommands("desktop-1920", ctx);
    expect(metrics.params).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, scale: 1 });
    expect(touch.params).toEqual({ enabled: false });
    expect(ua.params).toEqual({ userAgent: "" });
  });

  it("scales a preset down to fit the view", () => {
    const [metrics] = planViewportCommands("desktop-1920", { view: { width: 960, height: 2000 } });
    expect(metrics.params!.scale).toBe(0.5);
    expect(fitScale({ width: 400, height: 1000 }, { width: 800, height: 500 })).toBe(0.5);
    expect(fitScale({ width: 400, height: 400 }, { width: 800, height: 800 })).toBe(1);
  });

  it("responsive clears emulation, including the UA via an empty string", () => {
    expect(planViewportCommands("responsive", ctx)).toEqual(planClearCommands());
    expect(planClearCommands()).toEqual([
      { method: "Emulation.clearDeviceMetricsOverride" },
      { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
      { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
    ]);
  });
});

describe("viewportNeedsReload", () => {
  it("reloads when entering or leaving a mobile identity", () => {
    expect(viewportNeedsReload("responsive", "iphone-15")).toBe(true);
    expect(viewportNeedsReload("iphone-15", "responsive")).toBe(true);
    expect(viewportNeedsReload("pixel-8", "desktop-1440")).toBe(true);
    expect(viewportNeedsReload("responsive", "desktop-1440")).toBe(false);
    expect(viewportNeedsReload("ipad", "ipad")).toBe(false);
  });
});
