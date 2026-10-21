import { describe, expect, it } from "vitest";
import { arcControl, arcPoints, easeOutCubic, planMove, toLocal, MOVE_MS } from "../src/main/computerUse/cursorMath";

const frame = { x: 100, y: 50, width: 800, height: 600 };

describe("cursor overlay math", () => {
  it("converts a global point to window-local", () => {
    expect(toLocal({ x: 150, y: 80 }, frame)).toEqual({ x: 50, y: 30 });
    expect(toLocal({ x: 100, y: 50 }, { ...frame, x: -200 })).toEqual({ x: 300, y: 0 });
  });

  it("eases out and clamps", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it("arc starts at from, ends at to, and bows away from the straight line", () => {
    const pts = arcPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[10].x).toBeCloseTo(100);
    expect(pts[10].y).toBeCloseTo(0);
    expect(Math.abs(pts[5].y)).toBeGreaterThan(1);
    // ease-out: the first step is longer than the last
    expect(pts[1].x - pts[0].x).toBeGreaterThan(pts[10].x - pts[9].x);
  });

  it("a zero-length move stays put", () => {
    expect(arcControl({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
    for (const p of arcPoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)) expect(p).toEqual({ x: 5, y: 5 });
  });

  it("planMove is window-local; the first move appears at the target without animation", () => {
    const first = planMove(null, { x: 300, y: 250 }, frame, 4);
    expect(first.durationMs).toBe(0);
    expect(first.path[0]).toEqual({ x: 200, y: 200 });
    const next = planMove({ x: 300, y: 250 }, { x: 500, y: 350 }, frame, 4);
    expect(next.durationMs).toBe(MOVE_MS);
    expect(next.path[0]).toEqual({ x: 200, y: 200 });
    expect(next.path[4].x).toBeCloseTo(400);
    expect(next.path[4].y).toBeCloseTo(300);
  });
});
