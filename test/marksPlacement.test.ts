import { describe, expect, it } from "vitest";
import { ARGS_MARKER, MARKS_JS } from "@sideform/browser-agent/controller";

/**
 * MARKS_JS runs in the page; this drives it against a minimal fake DOM (no
 * layout engine: element rects and what `elementFromPoint` hits are scripted)
 * and checks WHERE each numbered label lands.
 */
interface Box {
  l: number;
  t: number;
  w: number;
  h: number;
}
interface Drawn {
  kind: "box" | "label";
  l: number;
  t: number;
  w: number;
  h: number;
  text: string;
  css: string;
}

function parse(css: string, prop: string): number {
  const m = new RegExp("(?:^|;)" + prop + ":(-?[\\d.]+)px").exec(css);
  return m ? Number(m[1]) : NaN;
}

function run(boxes: Box[], opts: { vw?: number; vh?: number; textHits?: Array<{ rect: Box; text: string }> } = {}) {
  const vw = opts.vw ?? 1280;
  const vh = opts.vh ?? 800;
  const marked = boxes.map((b, i) => ({
    getAttribute: () => "s1:" + i,
    getBoundingClientRect: () => ({ left: b.l, top: b.t, right: b.l + b.w, bottom: b.t + b.h, width: b.w, height: b.h }),
  }));
  const appended: Array<{ children: Array<{ style: { cssText: string }; textContent: string }> }> = [];
  const makeEl = () => {
    const el = {
      style: { cssText: "" },
      textContent: "",
      children: [] as unknown[],
      parentNode: null as unknown,
      setAttribute() {},
      appendChild(c: unknown) {
        el.children.push(c);
      },
    };
    return el;
  };
  const textEl = { tagName: "P", firstChild: null as unknown };
  let currentText: { rect: Box; text: string } | undefined;
  const document = {
    documentElement: { appendChild: (c: never) => appended.push(c), clientWidth: vw, clientHeight: vh },
    body: {},
    querySelector: () => null,
    querySelectorAll: () => marked,
    createElement: makeEl,
    createRange: () => ({
      selectNodeContents() {},
      getClientRects: () =>
        currentText
          ? [{ left: currentText.rect.l, top: currentText.rect.t, right: currentText.rect.l + currentText.rect.w, bottom: currentText.rect.t + currentText.rect.h, width: currentText.rect.w }]
          : [],
    }),
    elementFromPoint: (x: number, y: number) => {
      const hit = (opts.textHits ?? []).find((t) => x >= t.rect.l && x <= t.rect.l + t.rect.w && y >= t.rect.t && y <= t.rect.t + t.rect.h);
      if (!hit) return null;
      currentText = hit;
      textEl.firstChild = { nodeType: 3, nodeValue: hit.text, nextSibling: null };
      return textEl;
    },
  };
  const code = MARKS_JS.replace(ARGS_MARKER, () => JSON.stringify({ snapshotId: "s1" }));
  const result = new Function("window", "document", "return " + code)({ innerWidth: vw, innerHeight: vh }, document) as {
    marked: number;
    placement: Record<string, number>;
  };
  const container = appended[0]!;
  const drawn: Drawn[] = [];
  for (const c of container.children) {
    const css = c.style.cssText;
    const isLabel = c.textContent !== "";
    drawn.push({
      kind: isLabel ? "label" : "box",
      l: parse(css, "left"),
      t: parse(css, "top"),
      w: isLabel ? parse(css, "min-width") : parse(css, "width"),
      h: parse(css, "height"),
      text: c.textContent,
      css,
    });
  }
  return { result, labels: drawn.filter((d) => d.kind === "label") };
}

const overlap = (a: { l: number; t: number; w: number; h: number }, b: { l: number; t: number; w: number; h: number }) =>
  a.l < b.l + b.w && b.l < a.l + a.w && a.t < b.t + b.h && b.t < a.t + a.h;

describe("MARKS_JS label placement", () => {
  it("puts the label just left of an isolated element's top-left corner, on its row", () => {
    const { result, labels } = run([{ l: 400, t: 300, w: 120, h: 32 }]);
    expect(result.placement.left).toBe(1);
    expect(labels[0]!.t).toBe(300);
    expect(labels[0]!.l + labels[0]!.w).toBe(399);
  });

  it("goes above the box when there is no room on the left", () => {
    const { result, labels } = run([{ l: 4, t: 300, w: 120, h: 32 }]);
    expect(result.placement.above).toBe(1);
    expect(labels[0]!.l).toBe(4);
    expect(labels[0]!.t + 16 + 1).toBe(300);
  });

  it("never covers a neighbouring marked box (a row of buttons)", () => {
    const row = [0, 1, 2, 3].map((i) => ({ l: 100 + i * 70, t: 200, w: 64, h: 30 }));
    const { labels } = run(row);
    for (const label of labels) {
      row.forEach((b, i) => {
        if (String(i) !== label.text) expect(overlap(label, b)).toBe(false);
      });
    }
  });

  it("falls back to a small translucent inside-corner label in a tight grid", () => {
    const grid: Box[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) grid.push({ l: 20 + c * 52, t: 80 + r * 44, w: 48, h: 40 });
    const { result, labels } = run(grid);
    expect(result.placement.inside).toBeGreaterThanOrEqual(12);
    const centre = labels[5]!;
    expect(centre.css).toContain("rgba(13,153,255,0.82)");
    expect(centre.l).toBeGreaterThan(grid[5]!.l);
    expect(centre.t).toBeGreaterThan(grid[5]!.t);
    expect(centre.l + centre.w).toBeLessThanOrEqual(grid[5]!.l + grid[5]!.w);
  });

  it("does not put a label over visible page text", () => {
    const text = { rect: { l: 340, t: 296, w: 56, h: 40 }, text: "Email" };
    const { result } = run([{ l: 400, t: 300, w: 120, h: 32 }], { textHits: [text] });
    expect(result.placement.left).toBe(0);
    expect(result.placement.above).toBe(1);
  });

  it("keeps every label inside the viewport and off other labels", () => {
    const boxes: Box[] = [
      { l: 0, t: 0, w: 60, h: 24 },
      { l: 1220, t: 770, w: 60, h: 30 },
      { l: 600, t: 400, w: 60, h: 24 },
      { l: 664, t: 400, w: 60, h: 24 },
    ];
    const { labels } = run(boxes);
    for (const a of labels) {
      expect(a.l).toBeGreaterThanOrEqual(0);
      expect(a.t).toBeGreaterThanOrEqual(0);
      expect(a.l + a.w).toBeLessThanOrEqual(1280);
      expect(a.t + a.h).toBeLessThanOrEqual(800);
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) expect(overlap(labels[i]!, labels[j]!)).toBe(false);
  });

  it("skips zero-size and off-screen elements", () => {
    const { result } = run([
      { l: 10, t: 10, w: 0, h: 20 },
      { l: 2000, t: 10, w: 50, h: 20 },
      { l: 100, t: 100, w: 50, h: 20 },
    ]);
    expect(result.marked).toBe(1);
  });
});

describe("MARKS_JS draw:false", () => {
  it("returns the marks as data and makes no DOM change", () => {
    const appended: unknown[] = [];
    const document = {
      documentElement: { appendChild: (c: unknown) => appended.push(c), clientWidth: 1280, clientHeight: 800 },
      body: {},
      querySelector: () => null,
      querySelectorAll: () => [
        {
          getAttribute: () => "s1:0",
          getBoundingClientRect: () => ({ left: 400, top: 300, right: 520, bottom: 332, width: 120, height: 32 }),
        },
      ],
      createElement: () => {
        throw new Error("DOM touched");
      },
      createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
      elementFromPoint: () => null,
    };
    const code = MARKS_JS.replace(ARGS_MARKER, () => JSON.stringify({ snapshotId: "s1", draw: false }));
    const r = new Function("window", "document", "return " + code)({ innerWidth: 1280, innerHeight: 800 }, document) as {
      marked: number;
      viewportWidth: number;
      viewportHeight: number;
      marks: Array<{ text: string; box: { l: number }; label: { l: number; t: number; w: number }; inside: boolean; bg: string }>;
    };
    expect(appended).toHaveLength(0);
    expect(r.marked).toBe(1);
    expect(r.viewportWidth).toBe(1280);
    expect(r.viewportHeight).toBe(800);
    expect(r.marks[0]!.text).toBe("0");
    expect(r.marks[0]!.box.l).toBe(400);
    expect(r.marks[0]!.label.t).toBe(300);
    expect(r.marks[0]!.label.l + r.marks[0]!.label.w).toBe(399);
    expect(r.marks[0]!.inside).toBe(false);
  });
});
