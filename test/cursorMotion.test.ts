import { describe, it, expect } from "vitest";
import { CURSOR_PLAN_JS } from "../src/main/browser/pageScripts";

// CURSOR_PLAN_JS is the pure planner fragment CURSOR_JS embeds (no DOM, no
// args). Evaluating it directly pins the cua-derived planning math.
interface Plan {
  style: string;
  samples: { t: number; x: number; y: number }[];
  snapT: number | null;
  arrivalT: number;
  effects: Record<string, boolean>;
}
function plan(opts: Record<string, unknown>): Plan {
  return new Function("window", "opts", `${CURSOR_PLAN_JS}; return planMove(opts);`)({}, opts) as Plan;
}
const from = { x: 100, y: 600 };
const to = { x: 700, y: 120 };
const last = (p: Plan) => p.samples[p.samples.length - 1];

describe("CURSOR_PLAN_JS motion planning", () => {
  it("every style starts at from, ends exactly at to, arrives within the 700ms cap", () => {
    for (const style of ["signature_arc", "spring_settle", "comet_swoop", "magnetic", "classic"]) {
      const p = plan({ style, from, to, w: 40 });
      expect(p.samples[0]).toMatchObject({ t: 0, x: 100, y: 600 });
      const end = style === "classic" ? p.samples[p.samples.length - 1] : last(p);
      expect(end.x).toBeCloseTo(700, 5);
      expect(end.y).toBeCloseTo(120, 5);
      expect(p.arrivalT).toBeLessThanOrEqual(700 + 1e-6);
      for (let i = 1; i < p.samples.length; i++) expect(p.samples[i].t).toBeGreaterThan(p.samples[i - 1].t);
    }
  });

  it("unknown or absent style plans signature_arc", () => {
    expect(plan({ style: "nope", from, to, w: 40 }).style).toBe("signature_arc");
    expect(plan({ from, to, w: 40 }).style).toBe("signature_arc");
  });

  it("default effects per style match cua default_effects", () => {
    const fx = (style: string) => plan({ style, from, to, w: 40 }).effects;
    expect(fx("signature_arc")).toEqual({ trail: false, glow: true, magnet: false, ripple: true, squish: true });
    expect(fx("spring_settle")).toEqual({ trail: false, glow: true, magnet: false, ripple: false, squish: true });
    expect(fx("magnetic")).toEqual({ trail: false, glow: false, magnet: true, ripple: true, squish: false });
    expect(fx("comet_swoop")).toEqual({ trail: true, glow: false, magnet: false, ripple: true, squish: false });
    expect(fx("classic")).toEqual({ trail: false, glow: false, magnet: false, ripple: true, squish: true });
  });

  it("Fitts-aware duration: a small target takes longer than a big one", () => {
    const small = plan({ style: "comet_swoop", from, to, w: 6 });
    const big = plan({ style: "comet_swoop", from, to, w: 400 });
    expect(last(small).t).toBeGreaterThan(last(big).t);
  });

  it("a bare point uses the 24px default target box", () => {
    const pt = plan({ style: "comet_swoop", from, to, w: null });
    const box = plan({ style: "comet_swoop", from, to, w: 24 });
    expect(last(pt).t).toBeCloseTo(last(box).t, 6);
  });

  it("retimes so arrival never exceeds 700ms even for a huge move to a tiny target", () => {
    const p = plan({ style: "spring_settle", from: { x: 0, y: 0 }, to: { x: 5000, y: 3000 }, w: 4 });
    expect(p.arrivalT).toBeLessThanOrEqual(700 + 1e-6);
  });

  it("reduced motion is a 120ms straight glide with no effects", () => {
    const p = plan({ style: "comet_swoop", from, to, w: 40, reduce: true });
    expect(last(p).t).toBeCloseTo(120, 6);
    expect(Object.values(p.effects).every((v) => v === false)).toBe(true);
    const mid = p.samples[Math.floor(p.samples.length / 2)];
    const cross = (mid.x - from.x) * (to.y - from.y) - (mid.y - from.y) * (to.x - from.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6); // on the chord
  });

  it("magnetic records a lock-on time before arrival", () => {
    const p = plan({ style: "magnetic", from, to, w: 40 });
    expect(p.snapT).not.toBeNull();
    expect(p.snapT!).toBeLessThanOrEqual(last(p).t);
  });

  it("signature_arc bows off the chord (not a straight line)", () => {
    const p = plan({ style: "signature_arc", from, to, w: 40 });
    const mid = p.samples[Math.floor(p.samples.length / 2)];
    const cross = (mid.x - from.x) * (to.y - from.y) - (mid.y - from.y) * (to.x - from.x);
    expect(Math.abs(cross)).toBeGreaterThan(1000);
  });

  it("a zero-length move arrives immediately", () => {
    const p = plan({ style: "signature_arc", from, to: from, w: 40 });
    expect(p.arrivalT).toBe(0);
  });
});
