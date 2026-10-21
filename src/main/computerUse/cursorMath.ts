// Electron-free math of the agent cursor overlay (spec section 4): global screen
// points to window-local points, and the arc the cursor travels.
import type { WindowFrame } from "./nativeController";

export interface Point {
  x: number;
  y: number;
}

/** A global screen point (top-left origin) in the coordinates of a window frame. */
export const toLocal = (p: Point, frame: WindowFrame): Point => ({ x: p.x - frame.x, y: p.y - frame.y });

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** Control point of a quadratic arc: the midpoint pushed sideways by a fifth of the distance (capped). */
export function arcControl(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x: from.x, y: from.y };
  const bow = Math.min(80, dist * 0.2);
  return { x: (from.x + to.x) / 2 + (-dy / dist) * bow, y: (from.y + to.y) / 2 + (dx / dist) * bow };
}

/**
 * Points along the arc from `from` to `to`, `steps` + 1 of them (first = from, last = to), spaced by an
 * ease-out curve: the cursor starts fast and settles. Plain numbers only (they go to the overlay page).
 */
export function arcPoints(from: Point, to: Point, steps = 24): Point[] {
  const c = arcControl(from, to);
  const n = Math.max(1, Math.floor(steps));
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = easeOutCubic(i / n);
    const u = 1 - t;
    out.push({ x: u * u * from.x + 2 * u * t * c.x + t * t * to.x, y: u * u * from.y + 2 * u * t * c.y + t * t * to.y });
  }
  return out;
}

export const MOVE_MS = 350;
export const HIDE_AFTER_MS = 1500;

/** One move, window-local and ready for the overlay page. `from` null = appear at the target. */
export function planMove(from: Point | null, to: Point, frame: WindowFrame, steps = 24): { path: Point[]; durationMs: number } {
  const start = from ?? to;
  const path = arcPoints(toLocal(start, frame), toLocal(to, frame), steps);
  return { path, durationMs: from === null ? 0 : MOVE_MS };
}
