// Pure maths and state of the agent panel collapse/expand animation. No electron import: window.ts
// owns the timer and applies what `createPanelAnimator` returns. Progress p: 0 = expanded, 1 = collapsed; expand runs the same frames
// in reverse.
import type { Rect, WindowLayout } from "./layout";

export const PANEL_ANIMATION_MS = 240;
/** Frame period of the main-process timer (~60 fps). */
export const PANEL_ANIMATION_FRAME_MS = 16;

export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

export interface PanelFrame {
  panel: Rect;
  tabArea: Rect;
  /** False only at the collapsed end state (p >= 1): the panel view is hidden then. */
  panelVisible: boolean;
}

/** Rects to apply at progress p. The panel keeps its full expanded width and slides off to the left. */
export function panelAnimationFrame(expanded: WindowLayout, collapsed: WindowLayout, p: number): PanelFrame {
  const k = Math.min(1, Math.max(0, p));
  const endX = -expanded.panel.width;
  const panel: Rect = {
    ...expanded.panel,
    x: Math.round(expanded.panel.x + (endX - expanded.panel.x) * k),
  };
  const right = expanded.tabArea.x + expanded.tabArea.width; // fixed right edge
  const x = Math.round(expanded.tabArea.x + (collapsed.tabArea.x - expanded.tabArea.x) * k);
  const tabArea: Rect = { x, y: expanded.tabArea.y, width: Math.max(0, right - x), height: expanded.tabArea.height };
  return { panel, tabArea, panelVisible: k < 1 };
}

/** Linear time progress (0..1) of an animation that started `elapsedMs` ago. */
export function timeProgress(elapsedMs: number, durationMs = PANEL_ANIMATION_MS): number {
  if (!(durationMs > 0)) return 1;
  if (!Number.isFinite(elapsedMs)) return 1;
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

/**
 * Timeline state: eased progress `from` -> `to` (each 0 or 1), started at `startedAt`, where the first
 * frame begins at eased progress `origin`. Retargeting mid-flight starts from the CURRENT eased
 * progress, so the panel never jumps.
 */
export interface PanelTimeline {
  startedAt: number;
  origin: number;
  target: 0 | 1;
}

export function startTimeline(now: number, current: number, target: 0 | 1): PanelTimeline {
  return { startedAt: now, origin: Math.min(1, Math.max(0, current)), target };
}

/**
 * Eased progress at `now`. The remaining distance is covered in a proportional share of the full
 * duration, so a reversal after 30% of the way takes 30% of the time.
 */
export function timelineProgress(tl: PanelTimeline, now: number, durationMs = PANEL_ANIMATION_MS): number {
  const distance = Math.abs(tl.target - tl.origin);
  if (distance === 0) return tl.target;
  const t = timeProgress(now - tl.startedAt, durationMs * distance);
  return tl.origin + (tl.target - tl.origin) * easeOutCubic(t);
}

export function timelineDone(tl: PanelTimeline, now: number, durationMs = PANEL_ANIMATION_MS): boolean {
  const distance = Math.abs(tl.target - tl.origin);
  return distance === 0 || now - tl.startedAt >= durationMs * distance;
}

/**
 * Whether shell motion (panel slide, tab strip motion) is allowed. Off for env
 * `PEN_DESKTOP_NO_ANIMATIONS=1` and for the OS "reduce motion" setting.
 */
export function shellMotionEnabled(envValue: string | undefined, reducedMotion: boolean): boolean {
  return envValue !== "1" && !reducedMotion;
}

export type PanelTick =
  /** Apply this frame (progress 0 = expanded .. 1 = collapsed). */
  | { done: false; progress: number }
  /** The animation reached its target: apply the plain layout. */
  | { done: true; progress: number };

export interface PanelAnimator {
  /** A slide is in flight. */
  readonly running: boolean;
  /** Current eased progress; at rest it is 0 (expanded) or 1 (collapsed). */
  readonly progress: number;
  /** Start, or retarget a running slide from its CURRENT progress (never jumps). */
  start(now: number, collapsed: boolean): void;
  /** Jump to the rest state of `collapsed` and stop. */
  stop(collapsed: boolean): void;
  /** Advance to `now`. A stopped animator answers done. */
  tick(now: number): PanelTick;
}

export function createPanelAnimator(initialCollapsed: boolean, durationMs = PANEL_ANIMATION_MS): PanelAnimator {
  let timeline: PanelTimeline | null = null;
  let progress = initialCollapsed ? 1 : 0;
  return {
    get running() {
      return timeline !== null;
    },
    get progress() {
      return progress;
    },
    start(now, collapsed) {
      timeline = startTimeline(now, progress, collapsed ? 1 : 0);
    },
    stop(collapsed) {
      timeline = null;
      progress = collapsed ? 1 : 0;
    },
    tick(now) {
      if (!timeline) return { done: true, progress };
      progress = timelineProgress(timeline, now, durationMs);
      if (timelineDone(timeline, now, durationMs)) {
        progress = timeline.target;
        timeline = null;
        return { done: true, progress };
      }
      return { done: false, progress };
    },
  };
}
