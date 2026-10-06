import { describe, it, expect } from "vitest";
import { CURSOR_PLAN_JS } from "../src/main/browser/pageScripts";

// CURSOR_PLAN_JS is the pure planner fragment CURSOR_JS embeds (no DOM, no
// args). Evaluating it directly pins the cua-derived planning math.
interface Plan {
  style: string;
  samples: { t: number; x: number; y: number; rot: number }[];
  snapT: number | null;
  arrivalT: number;
  motionEndMs: number;
  effects: Record<string, boolean>;
}
function plan(opts: Record<string, unknown>): Plan {
  return new Function("window", "opts", `${CURSOR_PLAN_JS}; return planMove(opts);`)({}, opts) as Plan;
}
function evalPlan<T>(expr: string, args: Record<string, unknown> = {}): T {
  return new Function("window", ...Object.keys(args), `${CURSOR_PLAN_JS}; return ${expr};`)({}, ...Object.values(args)) as T;
}
const TIP_ANGLE = -0.75 * Math.PI;
const wrap = (a: number) => evalPlan<number>("wrapAngle(a)", { a });
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
    expect(fx("signature_arc")).toEqual({
      trail: false,
      glow: true,
      magnet: false,
      ripple: true,
      squish: true,
      rotates: true,
    });
    expect(fx("spring_settle")).toEqual({
      trail: false,
      glow: true,
      magnet: false,
      ripple: false,
      squish: true,
      rotates: true,
    });
    expect(fx("magnetic")).toEqual({
      trail: false,
      glow: false,
      magnet: true,
      ripple: true,
      squish: false,
      rotates: false,
    });
    expect(fx("comet_swoop")).toEqual({
      trail: true,
      glow: false,
      magnet: false,
      ripple: true,
      squish: false,
      rotates: true,
    });
    expect(fx("classic")).toEqual({
      trail: false,
      glow: false,
      magnet: false,
      ripple: true,
      squish: true,
      rotates: false,
    });
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

  describe("heading rotation (shortest-arc chase toward travel)", () => {
    const right = { from: { x: 100, y: 300 }, to: { x: 800, y: 300 }, w: 40 };
    const TANGENT = ["signature_arc", "spring_settle", "comet_swoop"];
    // Slack for the arc's bow: the travel heading itself swings across a move
    // (arc size 0.16 / 0.12 / 0.24 of the distance), and rot first lags, then trails it.
    const BOW_SLACK: Record<string, number> = { signature_arc: 1.45, spring_settle: 1.1, comet_swoop: 2.1 };
    const ROT0S = [-3, -2.5, 0, 2.5, 3];
    const DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) }));
    const maxAbsRot = (p: Plan) => Math.max(...p.samples.map((q) => Math.abs(q.rot)));
    const travel = (p: Plan) => {
      let sum = 0;
      for (let i = 1; i < p.samples.length; i++) sum += Math.abs(wrap(p.samples[i].rot - p.samples[i - 1].rot));
      return sum;
    };
    const planFixedHeading = (style: string, opts: Record<string, unknown>): Plan =>
      new Function(
        "window",
        "opts",
        `${CURSOR_PLAN_JS}; STYLE_EFFECTS[${JSON.stringify(style)}].rotates = false; return planMove(opts);`,
      )({}, opts) as Plan;

    it("wrapAngle maps into (-PI, PI]", () => {
      expect(wrap(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
      expect(wrap(-Math.PI)).toBeCloseTo(Math.PI, 9);
      expect(wrap(1.75 * Math.PI)).toBeCloseTo(-0.25 * Math.PI, 9);
    });

    it("every direction x carried rot0 x distance: bounded by PI, smooth, ends at 0, no wasted rotation", () => {
      for (const style of TANGENT) {
        for (const dist of [600, 80]) {
          for (const rot0 of ROT0S) {
            for (const d of DIRS) {
              const f = { x: 700, y: 500 };
              const t = { x: f.x + d.x * dist, y: f.y + d.y * dist };
              const p = plan({ style, from: f, to: t, w: 30, rot0 });
              const tag = `${style} ${dist}px rot0=${rot0} dir(${d.x.toFixed(2)},${d.y.toFixed(2)})`;
              expect(maxAbsRot(p), tag).toBeLessThanOrEqual(Math.PI + 1e-9);
              for (let i = 1; i < p.samples.length; i++) {
                expect(Math.abs(wrap(p.samples[i].rot - p.samples[i - 1].rot)), tag).toBeLessThanOrEqual(0.55);
              }
              expect(last(p).rot, tag).toBe(0);
              const heading = wrap(Math.atan2(d.y, d.x) - TIP_ANGLE);
              const budget = Math.abs(wrap(heading - wrap(rot0))) + Math.abs(heading) + BOW_SLACK[style];
              expect(travel(p), tag).toBeLessThanOrEqual(budget);
            }
          }
        }
      }
    });

    it("regression: signature_arc, rot0=3, 600px down-right does not spin", () => {
      const p = plan({ style: "signature_arc", from: { x: 100, y: 100 }, to: { x: 700, y: 700 }, w: 30, rot0: 3 });
      expect(maxAbsRot(p)).toBeLessThanOrEqual(Math.PI + 1e-9);
      // The chase into the heading (up to arrival) is small: rot0 already sits near the heading (~pi).
      const chase = { ...p, samples: p.samples.filter((q) => q.t <= p.arrivalT) };
      expect(travel(chase)).toBeLessThanOrEqual(1.0);
      // Then the way home is at most a half-turn along the shortest arc.
      expect(travel(p) - travel(chase)).toBeLessThanOrEqual(Math.PI + 1e-9);
    });

    it("the tip leads: while moving fast, rot tracks the travel heading", () => {
      for (const style of TANGENT) {
        const p = plan({ style, ...right });
        let checked = 0;
        for (let i = 4; i < p.samples.length - 4; i++) {
          const a = p.samples[i - 2];
          const b = p.samples[i + 2];
          const dt = (b.t - a.t) / 1000;
          const vx = (b.x - a.x) / dt;
          const vy = (b.y - a.y) / dt;
          if (Math.hypot(vx, vy) <= 300 || p.samples[i].t < 150) continue; // let the lag catch up
          checked++;
          expect(Math.abs(wrap(p.samples[i].rot - wrap(Math.atan2(vy, vx) - TIP_ANGLE))), style).toBeLessThan(0.6);
        }
        expect(checked, style).toBeGreaterThan(10);
      }
    });

    it("tangent styles rotate; magnetic, classic and reduced motion never do on their own", () => {
      for (const style of TANGENT) expect(maxAbsRot(plan({ style, ...right }))).toBeGreaterThan(1);
      for (const style of ["magnetic", "classic"]) {
        expect(plan({ style, ...right }).samples.every((q) => q.rot === 0)).toBe(true);
      }
      expect(plan({ style: "signature_arc", ...right, reduce: true }).samples.every((q) => q.rot === 0)).toBe(true);
    });

    it("the settle tail leaves arrival untouched (same arrival and path as the same move with fixed heading)", () => {
      for (const style of TANGENT) {
        const opts = { style, ...right };
        const p = plan(opts);
        const q = planFixedHeading(style, opts);
        expect(p.arrivalT).toBeCloseTo(q.arrivalT, 9);
        for (let i = 0; i < q.samples.length; i++) {
          expect(p.samples[i].t).toBeCloseTo(q.samples[i].t, 9);
          expect(p.samples[i].x).toBeCloseTo(q.samples[i].x, 9);
        }
        expect(p.samples.length).toBeGreaterThan(q.samples.length); // the tail only appends
        expect(p.samples.length - q.samples.length).toBeLessThanOrEqual(36);
        expect(last(p).t).toBeGreaterThan(q.arrivalT);
        expect(p.motionEndMs).toBeCloseTo(last(q).t, 9);
      }
    });

    it("a fixed style with rot0 ~ 0 gets no tail (same sample count as rot0 = 0)", () => {
      for (const style of ["magnetic", "classic"]) {
        const base = plan({ style, ...right, rot0: 0 });
        const tiny = plan({ style, ...right, rot0: 0.0005 });
        expect(tiny.samples.length).toBe(base.samples.length);
        expect(last(tiny).rot).toBe(0);
      }
    });

    it("magnetic/classic ease a carried rot to 0 DURING the move (monotonic); reduced motion snaps to 0", () => {
      for (const style of ["magnetic", "classic"]) {
        for (const rot0 of [-3, 2.5, 3]) {
          const p = plan({ style, ...right, rot0 });
          expect(p.samples[0].rot).toBeCloseTo(rot0, 9);
          expect(last(p).rot).toBe(0);
          for (let i = 1; i < p.samples.length; i++) {
            expect(Math.abs(p.samples[i].rot)).toBeLessThanOrEqual(Math.abs(p.samples[i - 1].rot) + 1e-12);
          }
          // ~300ms in, it is home (|rot| < 0.1), well before the end of the move.
          const at300 = p.samples.find((q) => q.t >= 300)!;
          expect(Math.abs(at300.rot)).toBeLessThan(0.1 * Math.max(1, Math.abs(rot0)));
          expect(Math.abs(p.samples.find((q) => q.t >= 450)!.rot)).toBeLessThan(0.1);
          // the tail exists only if rot had not reached 0 by the last motion sample
          const noTail = plan({ style, ...right, rot0: 0 });
          expect(p.samples.length).toBeLessThanOrEqual(noTail.samples.length + 36);
        }
      }
      for (const rot0 of [-3, 2.5, 3]) {
        const red = plan({ style: "signature_arc", ...right, reduce: true, rot0 });
        const base = plan({ style: "signature_arc", ...right, reduce: true });
        expect(red.samples.every((q) => q.rot === 0)).toBe(true);
        expect(red.samples.length).toBe(base.samples.length); // no tail
      }
    });

    it("planMove starts from the wrapped rot0 it is given", () => {
      expect(plan({ style: "signature_arc", ...right, rot0: 1.2 }).samples[0].rot).toBeCloseTo(1.2, 9);
      expect(plan({ style: "signature_arc", ...right, rot0: 5.6 }).samples[0].rot).toBeCloseTo(5.6 - 2 * Math.PI, 9);
    });

    it("sampleAt interpolates rot along the shortest arc", () => {
      const samples = [
        { t: 0, x: 0, y: 0, rot: 3.0 },
        { t: 10, x: 0, y: 0, rot: -3.0 },
      ];
      const r = evalPlan<{ rot: number }>("sampleAt(samples, 5)", { samples }).rot;
      expect(Math.abs(wrap(r - Math.PI))).toBeLessThan(0.2); // crosses PI, not 0
      expect(Math.abs(r)).toBeLessThanOrEqual(Math.PI + 1e-12); // and stays wrapped
    });
  });

  describe("arrow pivot", () => {
    const pivot = evalPlan<{ x: number; y: number }>("ARROW_PIVOT");
    const points = evalPlan<string>("ARROW_POINTS")
      .split(" ")
      .map((q) => {
        const [x, y] = q.split(",").map(Number);
        return { x, y };
      });
    const unit = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    };
    // The visible tip of the blue (stroke 5.4) rounded polygon: the corner pulled
    // back by half the stroke along the tip bisector.
    const visibleTip = () => {
      const a = unit(points[0], points[1]);
      const b = unit(points[0], points[points.length - 1]);
      const n = Math.hypot(a.x + b.x, a.y + b.y);
      return {
        x: points[0].x - ((a.x + b.x) / n) * 2.7,
        y: points[0].y - ((a.y + b.y) / n) * 2.7,
      };
    };
    const apply = (
      rot: number,
      scale: number,
      pt: { x: number; y: number },
    ) => {
      // Evaluate the exact transform string as a matrix about the pivot.
      const str = evalPlan<string>("arrowTransform(rot, scale)", {
        rot,
        scale,
      });
      const m = /^rotate\(([-\d.e]+)rad\) scale\(([-\d.e]+)\)$/.exec(str)!;
      const r = Number(m[1]);
      const k = Number(m[2]);
      const dx = (pt.x - pivot.x) * k;
      const dy = (pt.y - pivot.y) * k;
      return {
        x: pivot.x + dx * Math.cos(r) - dy * Math.sin(r),
        y: pivot.y + dx * Math.sin(r) + dy * Math.cos(r),
      };
    };

    it("the visible tip of the arrow is within 1px of the pivot (the hotspot)", () => {
      const tip = visibleTip();
      expect(Math.hypot(tip.x - pivot.x, tip.y - pivot.y)).toBeLessThan(1);
    });

    it("rotating and squishing about the pivot keeps the hotspot fixed", () => {
      for (const rot of [0, 0.7, -2.1, 2.36, 5]) {
        for (const scale of [1, 0.88]) {
          const out = apply(rot, scale, pivot);
          expect(out.x).toBeCloseTo(pivot.x, 9);
          expect(out.y).toBeCloseTo(pivot.y, 9);
        }
      }
    });

    it("rest-pose tip direction matches TIP_ANGLE, and rotating by rot turns it toward the heading", () => {
      const centroid = {
        x: points.reduce((a, q) => a + q.x, 0) / points.length,
        y: points.reduce((a, q) => a + q.y, 0) / points.length,
      };
      const dir = Math.atan2(pivot.y - centroid.y, pivot.x - centroid.x); // body -> tip
      expect(Math.abs(wrap(dir - TIP_ANGLE))).toBeLessThan(0.35);
      const b2 = apply(wrap(0 - TIP_ANGLE), 1, centroid); // heading 0 (moving right)
      expect(
        Math.abs(wrap(Math.atan2(pivot.y - b2.y, pivot.x - b2.x))),
      ).toBeLessThan(0.35);
    });
  });
});
