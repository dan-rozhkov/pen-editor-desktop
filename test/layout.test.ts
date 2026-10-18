import { describe, it, expect } from "vitest";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  clampAgentPanelWidth,
  computeWindowLayout,
  ISLAND_GAP,
  ISLAND_RADIUS,
  tabbarLayoutKind,
} from "../src/main/layout";

describe("clampAgentPanelWidth", () => {
  it("keeps a width inside [300, 50%]", () => {
    expect(clampAgentPanelWidth(380, 1440)).toBe(380);
    expect(clampAgentPanelWidth(100, 1440)).toBe(AGENT_PANEL_MIN_WIDTH);
    expect(clampAgentPanelWidth(5000, 1440)).toBe(720);
  });
  it("lets the 50% cap beat the minimum in a tiny window", () => {
    expect(clampAgentPanelWidth(380, 500)).toBe(250);
    expect(clampAgentPanelWidth(380, 0)).toBe(0);
    expect(clampAgentPanelWidth(380, 1)).toBe(0);
    expect(clampAgentPanelWidth(380, -10)).toBe(0);
  });
  it("falls back to the default for non-finite input", () => {
    expect(clampAgentPanelWidth(NaN, 1440)).toBe(AGENT_PANEL_DEFAULT_WIDTH);
  });
});

describe("computeWindowLayout", () => {
  it("without a panel reproduces the historical geometry", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, edge: 1, panelWidth: null });
    expect(l.panel).toBeNull();
    expect(l.radius).toBe(0);
    expect(l.tabbar).toEqual({ x: 0, y: 0, width: 1200, height: 38 });
    expect(l.rim).toEqual({ x: 0, y: 38, width: 1200, height: 762 });
    // What TabManager used to compute itself: x=edge, y=bar, w-2*edge, h-bar-edge.
    expect(l.tabArea).toEqual({ x: 1, y: 38, width: 1198, height: 761 });
    expect(l.tabStripLeft).toBe(0);
  });

  it("keeps the tab bar and rim full width and docks the panel below the bar", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 70, edge: 0, panelWidth: 380 });
    expect(l.tabbar).toEqual({ x: 0, y: 0, width: 1200, height: 70 });
    expect(l.rim).toEqual({ x: 0, y: 70, width: 1200, height: 730 });
    expect(l.panel).toEqual({ x: 0, y: 70, width: 380, height: 730 });
    expect(l.tabArea).toEqual({ x: 380, y: 70, width: 820, height: 730 });
    expect(l.tabStripLeft).toBe(380);
  });

  it("insets the panel like tab views by the rim edge", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, edge: 1, panelWidth: 380 });
    expect(l.panel).toEqual({ x: 1, y: 38, width: 379, height: 761 });
    // One rim-width gap between panel and tab views (the rim shows through).
    expect(l.tabArea).toEqual({ x: 381, y: 38, width: 818, height: 761 });
  });

  it("clamps the width in a small window", () => {
    const l = computeWindowLayout({ width: 500, height: 400, tabbarHeight: 38, edge: 0, panelWidth: 380 });
    expect(l.panel?.width).toBe(250);
    expect(l.tabArea).toEqual({ x: 250, y: 38, width: 250, height: 362 });
    expect(l.tabStripLeft).toBe(250);
  });

  it("never produces negative sizes for a degenerate window", () => {
    const l = computeWindowLayout({ width: 0, height: 10, tabbarHeight: 70, edge: 1, panelWidth: 380 });
    for (const r of [l.panel!, l.tabbar, l.rim!, l.tabArea]) {
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
    expect(l.tabbar.height).toBe(10);
    expect(l.tabArea.width).toBe(0);
  });
});

describe("computeWindowLayout glass + islands", () => {
  const islands = { gap: ISLAND_GAP, radius: ISLAND_RADIUS };
  it("floats the panel and tab area as islands with even gaps", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, edge: 1, panelWidth: 380, islands });
    expect(l.tabbar).toEqual({ x: 0, y: 0, width: 1200, height: 38 });
    expect(l.rim).toBeNull();
    expect(l.radius).toBe(12);
    expect(l.panel).toEqual({ x: 8, y: 38, width: 380, height: 754 });
    expect(l.tabArea).toEqual({ x: 396, y: 38, width: 796, height: 754 });
    expect(l.panel!.x + l.panel!.width + 8).toBe(l.tabArea.x);
    expect(l.tabArea.x + l.tabArea.width + 8).toBe(1200);
    expect(l.panel!.y + l.panel!.height + 8).toBe(800);
    expect(l.tabStripLeft).toBe(396);
  });
  it("passes a custom gap and radius through", () => {
    const l = computeWindowLayout({ width: 1000, height: 600, tabbarHeight: 70, edge: 0, panelWidth: 300, islands: { gap: 4, radius: 6 } });
    expect(l.radius).toBe(6);
    expect(l.panel).toEqual({ x: 4, y: 70, width: 300, height: 526 });
    expect(l.tabArea).toEqual({ x: 308, y: 70, width: 688, height: 526 });
  });
  it("clamps in a tiny window and never goes negative", () => {
    const small = computeWindowLayout({ width: 500, height: 400, tabbarHeight: 38, edge: 0, panelWidth: 380, islands });
    expect(small.panel!.width).toBe(250);
    expect(small.tabArea).toEqual({ x: 266, y: 38, width: 226, height: 354 });
    for (const [w, h] of [[0, 10], [5, 5], [20, 100]]) {
      const l = computeWindowLayout({ width: w, height: h, tabbarHeight: 70, edge: 0, panelWidth: 380, islands });
      for (const r of [l.panel!, l.tabbar, l.tabArea]) {
        expect(r.width).toBeGreaterThanOrEqual(0);
        expect(r.height).toBeGreaterThanOrEqual(0);
      }
      expect(l.tabArea.x + l.tabArea.width).toBeLessThanOrEqual(w);
    }
  });
  it("is ignored without a panel", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, edge: 1, panelWidth: null, islands });
    expect(l.panel).toBeNull();
    expect(l.radius).toBe(0);
    expect(l.rim).not.toBeNull();
  });
});

describe("tabbarLayoutKind", () => {
  it("carries the layout attribute only with the agent flag", () => {
    expect(tabbarLayoutKind(true)).toBe("agent");
    expect(tabbarLayoutKind(false)).toBeUndefined();
  });
});

describe("islands with an address row", () => {
  it("keeps the panel at the tab row height; only the tab area follows the address row", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 70, tabRowHeight: 38, edge: 0, panelWidth: 380, islands: { gap: 8, radius: 12 } });
    expect(l.panel).toEqual({ x: 8, y: 38, width: 380, height: 754 });
    expect(l.tabArea).toEqual({ x: 396, y: 70, width: 796, height: 722 });
    // The tab bar view reaches `radius` below the row (tail under the tab view's rounded corners).
    expect(l.tabbar).toEqual({ x: 0, y: 0, width: 1200, height: 82 });
  });
  it("has no tail without an address row", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, tabRowHeight: 38, edge: 0, panelWidth: 380, islands: { gap: 8, radius: 12 } });
    expect(l.tabbar.height).toBe(38);
  });
});
