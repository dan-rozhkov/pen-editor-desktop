import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  clampAgentPanelWidth,
  computeWindowLayout,
  ISLAND_GAP,
  ISLAND_RADIUS,
  agentPanelWidthFor,
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

describe("computeWindowLayout (glass + islands)", () => {
  const islands = { gap: ISLAND_GAP, radius: ISLAND_RADIUS };
  it("floats the panel and tab area as islands with even gaps", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, panelWidth: 380, islands });
    expect(l.tabbar).toEqual({ x: 0, y: 0, width: 1200, height: 38 });
    expect(l.radius).toBe(12);
    expect(l.panel).toEqual({ x: 8, y: 38, width: 380, height: 754 });
    expect(l.tabArea).toEqual({ x: 396, y: 38, width: 796, height: 754 });
    expect(l.panel!.x + l.panel!.width + 8).toBe(l.tabArea.x);
    expect(l.tabArea.x + l.tabArea.width + 8).toBe(1200);
    expect(l.panel!.y + l.panel!.height + 8).toBe(800);
    expect(l.tabStripLeft).toBe(396);
  });
  it("passes a custom gap and radius through", () => {
    const l = computeWindowLayout({ width: 1000, height: 600, tabbarHeight: 70, panelWidth: 300, islands: { gap: 4, radius: 6 } });
    expect(l.radius).toBe(6);
    expect(l.panel).toEqual({ x: 4, y: 70, width: 300, height: 526 });
    expect(l.tabArea).toEqual({ x: 308, y: 70, width: 688, height: 526 });
  });
  it("clamps in a tiny window and never goes negative", () => {
    const small = computeWindowLayout({ width: 500, height: 400, tabbarHeight: 38, panelWidth: 380, islands });
    expect(small.panel!.width).toBe(250);
    expect(small.tabArea).toEqual({ x: 266, y: 38, width: 226, height: 354 });
    for (const [w, h] of [[0, 10], [5, 5], [20, 100]]) {
      const l = computeWindowLayout({ width: w, height: h, tabbarHeight: 70, panelWidth: 380, islands });
      for (const r of [l.panel!, l.tabbar, l.tabArea]) {
        expect(r.width).toBeGreaterThanOrEqual(0);
        expect(r.height).toBeGreaterThanOrEqual(0);
      }
      expect(l.tabArea.x + l.tabArea.width).toBeLessThanOrEqual(w);
    }
  });
});

describe("islands: address row (tab view under the row) and collapsed panel", () => {
  const islands = { gap: 8, radius: 12 };
  it("panel stays at the tab row height; the tab view starts exactly below the row; the tab bar has a radius-tall tail", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 70, tabRowHeight: 38, panelWidth: 380, islands });
    expect(l.panel).toEqual({ x: 8, y: 38, width: 380, height: 754 });
    expect(l.tabArea).toEqual({ x: 396, y: 70, width: 796, height: 722 });
    expect(l.tabbar).toEqual({ x: 0, y: 0, width: 1200, height: 82 });
    expect(l.tabTail).toBe(12);
  });
  it("no tail without an address row", () => {
    const a = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, tabRowHeight: 38, panelWidth: 380, islands });
    expect(a.tabbar.height).toBe(38);
    expect(a.tabTail).toBe(0);
  });
  it("passes gap and radius through for the tab bar (CSS variables), pinned in tabbar.css", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 70, tabRowHeight: 38, panelWidth: 380, islands: { gap: 6, radius: 10 } });
    expect(l.gap).toBe(6);
    expect(l.radius).toBe(10);
    const css = fs.readFileSync(path.join(__dirname, "../src/tabbar/tabbar.css"), "utf8");
    expect(css).toContain("var(--island-gap");
    expect(css).toContain("var(--island-radius");
    expect(css).not.toMatch(/border-radius:\s*12px 12px 0 0/);
    expect(css).not.toMatch(/margin:\s*0 8px 0/);
  });
  it("collapsed panel (width 0): panel hidden, tab island takes the width with the left gap", () => {
    expect(agentPanelWidthFor(true)).toBe(0);
    expect(agentPanelWidthFor(false)).toBe(AGENT_PANEL_DEFAULT_WIDTH);
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, panelWidth: agentPanelWidthFor(true), islands });
    expect(l.panelVisible).toBe(false);
    expect(l.panel!.width).toBe(0);
    expect(l.tabArea).toEqual({ x: 8, y: 38, width: 1184, height: 754 });
    expect(l.tabStripLeft).toBe(8);
    const open = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, panelWidth: agentPanelWidthFor(false), islands });
    expect(open.panelVisible).toBe(true);
  });
});
