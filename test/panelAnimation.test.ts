import { describe, it, expect } from "vitest";
import { computeWindowLayout, ISLAND_GAP, ISLAND_RADIUS, TAB_ROW_HEIGHT } from "../src/main/layout";
import {
  PANEL_ANIMATION_MS,
  createPanelAnimator,
  easeOutCubic,
  panelAnimationFrame,
  shellMotionEnabled,
  startTimeline,
  timeProgress,
  timelineDone,
  timelineProgress,
} from "../src/main/panelAnimation";

const base = { width: 1440, height: 900, tabbarHeight: TAB_ROW_HEIGHT, islands: { gap: ISLAND_GAP, radius: ISLAND_RADIUS } };
const expanded = computeWindowLayout({ ...base, panelWidth: 380 });
const collapsed = computeWindowLayout({ ...base, panelWidth: 0 });

describe("easeOutCubic", () => {
  it("runs 0 -> 1, monotonic, clamped", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-3)).toBe(0);
    expect(easeOutCubic(7)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = easeOutCubic(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("panelAnimationFrame", () => {
  it("p=0 equals the expanded layout", () => {
    const f = panelAnimationFrame(expanded, collapsed, 0);
    expect(f.panel).toEqual(expanded.panel);
    expect(f.tabArea).toEqual(expanded.tabArea);
    expect(f.panelVisible).toBe(true);
  });
  it("p=1 puts the panel fully off-window, tab area at the collapsed layout, panel hidden", () => {
    const f = panelAnimationFrame(expanded, collapsed, 1);
    expect(f.panel.x + f.panel.width).toBe(0);
    expect(f.panel.width).toBe(expanded.panel.width);
    expect(f.tabArea).toEqual(collapsed.tabArea);
    expect(f.panelVisible).toBe(false);
  });
  it("keeps the panel width, y/height and the tab area right edge in between", () => {
    for (const p of [0.1, 0.37, 0.5, 0.9]) {
      const f = panelAnimationFrame(expanded, collapsed, p);
      expect(f.panelVisible).toBe(true);
      expect(f.panel.width).toBe(expanded.panel.width);
      expect(f.panel.y).toBe(expanded.panel.y);
      expect(f.panel.height).toBe(expanded.panel.height);
      expect(f.tabArea.y).toBe(expanded.tabArea.y);
      expect(f.tabArea.height).toBe(expanded.tabArea.height);
      expect(f.tabArea.x + f.tabArea.width).toBe(expanded.tabArea.x + expanded.tabArea.width);
      expect(Number.isInteger(f.tabArea.x)).toBe(true);
      expect(Number.isInteger(f.panel.x)).toBe(true);
    }
  });
  it("clamps p", () => {
    expect(panelAnimationFrame(expanded, collapsed, -1).panel).toEqual(expanded.panel);
    expect(panelAnimationFrame(expanded, collapsed, 2).panelVisible).toBe(false);
  });
});

describe("timeline", () => {
  it("timeProgress clamps", () => {
    expect(timeProgress(-5)).toBe(0);
    expect(timeProgress(PANEL_ANIMATION_MS / 2)).toBe(0.5);
    expect(timeProgress(10_000)).toBe(1);
    expect(timeProgress(NaN)).toBe(1);
  });
  it("collapse goes 0 -> 1 and finishes after the duration", () => {
    const tl = startTimeline(1000, 0, 1);
    expect(timelineProgress(tl, 1000)).toBe(0);
    expect(timelineDone(tl, 1000 + PANEL_ANIMATION_MS - 1)).toBe(false);
    expect(timelineProgress(tl, 1000 + PANEL_ANIMATION_MS)).toBe(1);
    expect(timelineDone(tl, 1000 + PANEL_ANIMATION_MS)).toBe(true);
  });
  it("reversing mid-flight starts from the current progress", () => {
    const a = startTimeline(0, 0, 1);
    const mid = timelineProgress(a, 100);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    const b = startTimeline(100, mid, 0);
    expect(timelineProgress(b, 100)).toBeCloseTo(mid, 10);
    expect(timelineProgress(b, 100 + PANEL_ANIMATION_MS)).toBe(0);
    expect(timelineDone(b, 100 + PANEL_ANIMATION_MS * mid)).toBe(true);
    expect(timelineProgress(b, 110)).toBeLessThan(mid);
  });
  it("a no-op timeline is done at its target", () => {
    const tl = startTimeline(0, 1, 1);
    expect(timelineDone(tl, 0)).toBe(true);
    expect(timelineProgress(tl, 0)).toBe(1);
  });
});

describe("shellMotionEnabled", () => {
  it("is off for the env opt-out and for reduced motion", () => {
    expect(shellMotionEnabled(undefined, false)).toBe(true);
    expect(shellMotionEnabled("0", false)).toBe(true);
    expect(shellMotionEnabled("1", false)).toBe(false);
    expect(shellMotionEnabled(undefined, true)).toBe(false);
    expect(shellMotionEnabled("1", true)).toBe(false);
  });
});

describe("createPanelAnimator", () => {
  it("starts at rest for the initial state and answers done when stopped", () => {
    const a = createPanelAnimator(true);
    expect(a.running).toBe(false);
    expect(a.progress).toBe(1);
    expect(a.tick(0)).toEqual({ done: true, progress: 1 });
  });
  it("collapse runs frames then reports done at the target", () => {
    const a = createPanelAnimator(false);
    a.start(1000, true);
    expect(a.running).toBe(true);
    const mid = a.tick(1000 + 100);
    expect(mid.done).toBe(false);
    expect(mid.progress).toBeGreaterThan(0);
    expect(mid.progress).toBeLessThan(1);
    expect(a.tick(1000 + PANEL_ANIMATION_MS)).toEqual({ done: true, progress: 1 });
    expect(a.running).toBe(false);
    expect(a.progress).toBe(1);
  });
  it("retargets from the current progress", () => {
    const a = createPanelAnimator(false);
    a.start(0, true);
    const mid = a.tick(100).progress;
    a.start(100, false);
    expect(a.tick(100).progress).toBeCloseTo(mid, 10);
    expect(a.tick(110).progress).toBeLessThan(mid);
    expect(a.tick(100 + PANEL_ANIMATION_MS)).toEqual({ done: true, progress: 0 });
  });
  it("stop jumps to the rest state", () => {
    const a = createPanelAnimator(false);
    a.start(0, true);
    a.stop(true);
    expect(a.running).toBe(false);
    expect(a.progress).toBe(1);
    a.start(0, false);
    a.stop(false);
    expect(a.progress).toBe(0);
  });
});
