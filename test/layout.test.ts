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
  ADDRESS_ROW_HEIGHT,
  TAB_ROW_HEIGHT,
  OMNIBOX_ROW_HEIGHT,
  OMNIBOX_SHADOW_PAD,
  omniboxBounds,
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
  it("panel stays at the tab row height; the tab view starts exactly below the row; radius-tall tail", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 79, tabRowHeight: 38, panelWidth: 380, islands });
    expect(l.panel).toEqual({ x: 8, y: 38, width: 380, height: 754 });
    expect(l.tabArea).toEqual({ x: 396, y: 79, width: 796, height: 713 });
    expect(l.tabbar).toEqual({ x: 0, y: 0, width: 1200, height: 91 });
    expect(l.addressRowHeight).toBe(41);
    expect(l.tabTail).toBe(12);
  });
  it("no address row height without a row", () => {
    const a = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 38, tabRowHeight: 38, panelWidth: 380, islands });
    expect(a.tabbar.height).toBe(38);
    expect(a.addressRowHeight).toBe(0);
    expect(a.tabTail).toBe(0);
  });
  it("the address row is as tall as the chat header row (28px icon button + 2*6 padding + 1px border) and both start at the tab row", () => {
    expect(ADDRESS_ROW_HEIGHT).toBe(28 + 2 * 6 + 1);
    expect(TAB_ROW_HEIGHT).toBe(38);
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: TAB_ROW_HEIGHT + ADDRESS_ROW_HEIGHT, tabRowHeight: TAB_ROW_HEIGHT, panelWidth: 380, islands });
    expect(l.panel.y + ADDRESS_ROW_HEIGHT).toBe(l.tabArea.y);
  });
  it("passes gap and radius through for the tab bar (CSS variables), pinned in tabbar.css", () => {
    const l = computeWindowLayout({ width: 1200, height: 800, tabbarHeight: 70, tabRowHeight: 38, panelWidth: 380, islands: { gap: 6, radius: 10 } });
    expect(l.gap).toBe(6);
    expect(l.radius).toBe(10);
    const css = fs.readFileSync(path.join(__dirname, "../src/tabbar/tabbar.css"), "utf8");
    expect(css).toContain("var(--island-gap");
    expect(css).toContain("var(--island-radius");
    expect(css).toContain(`var(--address-row-height, ${ADDRESS_ROW_HEIGHT}px)`);
    expect(css).toContain(`var(--tab-row-height, ${TAB_ROW_HEIGHT}px)`);
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

describe("omniboxBounds", () => {
  const win = { width: 1200, height: 800 };
  // header 28 + 5 rows + divider 1 + footer 36 + 2 * 4 padding = 273 card, 289 view
  it("sizes the view from rows, header, footer and the shadow pad", () => {
    expect(OMNIBOX_ROW_HEIGHT).toBe(40);
    expect(OMNIBOX_SHADOW_PAD).toBe(8);
    expect(omniboxBounds({ x: 200, y: 78, width: 600 }, 5, true, win)).toEqual({ x: 192, y: 74, width: 616, height: 273 + 16 });
    expect(omniboxBounds({ x: 200, y: 78, width: 600 }, 2, false, win).height).toBe(4 + 80 + 1 + 36 + 4 + 16);
  });
  it("makes the card at least 420 wide", () => {
    expect(omniboxBounds({ x: 200, y: 78, width: 300 }, 1, false, win).width).toBe(420 + 16);
  });
  it("keeps the card 8px inside the window", () => {
    const right = omniboxBounds({ x: 1000, y: 78, width: 600 }, 1, false, win);
    expect(right.x + right.width - 8).toBe(1200 - 8);
    const left = omniboxBounds({ x: -50, y: 78, width: 600 }, 1, false, win);
    expect(left.x + 8).toBe(8);
    const narrow = omniboxBounds({ x: 0, y: 78, width: 600 }, 1, false, { width: 300, height: 800 });
    expect(narrow.x).toBe(0);
    expect(narrow.width).toBe(300);
  });
  it("clamps the height to 8px above the window bottom", () => {
    const b = omniboxBounds({ x: 200, y: 78, width: 600 }, 10, true, { width: 1200, height: 300 });
    expect(b.y + b.height).toBe(300 - 8);
    expect(omniboxBounds({ x: 200, y: 400, width: 600 }, 3, false, { width: 1200, height: 300 }).height).toBe(0);
  });
});
