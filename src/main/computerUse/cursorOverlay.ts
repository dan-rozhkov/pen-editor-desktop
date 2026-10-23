// The agent cursor drawn over a natively controlled app (spec section 4): a transparent,
// click-through window above the target window. Created on the first move, only while the
// "Show Agent Cursor" setting is on. Screenshots never include it (window-only capture).
import { BrowserWindow } from "electron";
import { ARGS_MARKER, CURSOR_JS } from "@sideform/browser-agent/controller";
import type { CursorSink, WindowFrame } from "./nativeController";

// Inline page: no remote content, no preload, no cursor markup of its own. The cursor is drawn by browser-agent's
// CURSOR_JS (the script browser tabs use), run once per move, so arrow, motion, glow and ripple are identical.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
</style></head><body></body></html>`;

/** Bound on awaiting one move (page load included): same as the browser controller's CURSOR_TIMEOUT_MS. */
const MOVE_TIMEOUT_MS = 900;
/** CURSOR_JS fades its own root out after 8 s idle (400 ms transition); only then may the window go. */
const HIDE_AFTER_MS = 8000 + 400;

// Every overlay window ever made (weak: a destroyed window just disappears). Code that decides about "the main
// window" (dock reopen, second launch) must not count these: they are click-through decoration.
const overlayWindows = new WeakSet<object>();
// Live overlays, so unticking "Show Agent Cursor" can hide them all at once (like the browser tab's hideCursorOverlay).
const liveOverlays = new Set<{ hideNow(): void }>();

/** Hide every live cursor overlay right away ("Show Agent Cursor" was just unticked). The next move shows it again. */
export function hideAllCursorOverlays(): void {
  for (const o of liveOverlays) o.hideNow();
}

/** True for a cursor overlay window. Use it to leave overlays out of any "which is the main window" decision. */
export const isCursorOverlayWindow = (win: object | null | undefined): boolean => win != null && overlayWindows.has(win);

export interface CursorOverlay extends CursorSink {
  /** Remove the window. Idempotent. Never touches the controlled app. */
  destroy(): void;
}

const toLocal = (p: { x: number; y: number }, f: WindowFrame): { x: number; y: number } => ({ x: p.x - f.x, y: p.y - f.y });

/**
 * Runs before CURSOR_JS when the window was re-bounded. CURSOR_JS keeps its resting point window-local and clamps
 * targets to innerWidth/innerHeight, so: shift that point by the frame origin's move (it stays at the same screen
 * spot), then wait (a few frames at most) until the renderer reports the new size.
 */
const reboundJs = (dx: number, dy: number, width: number, height: number): string => `new Promise(function (resolve) {
  var st = window.__penCursor;
  if (st && st.pos) st.pos = { x: st.pos.x + ${dx}, y: st.pos.y + ${dy} };
  var n = 0;
  (function check() {
    if ((window.innerWidth === ${width} && window.innerHeight === ${height}) || ++n > 10) resolve(null);
    else requestAnimationFrame(check);
  })();
})`;

export function createCursorOverlay(deps: { enabled: () => boolean }): CursorOverlay {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let bounds: WindowFrame | null = null;

  const ensure = (frame: WindowFrame): BrowserWindow => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
      transparent: true,
      frame: false,
      focusable: false,
      show: false,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      // backgroundThrottling off: after an idle hide, the first move must animate at once, not wait out a paused rAF.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    overlayWindows.add(win);
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, "screen-saver");
    // skipTransformProcessType: the default would switch the app's process type (Dock icon flicker, menu bar loss).
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // macOS: keep it out of the Window menu (and the Mission Control window list).
    win.excludedFromShownWindowsMenu = true;
    const w = win;
    ready = w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).then(
      () => undefined,
      () => undefined,
    );
    return w;
  };

  /** Run CURSOR_JS in the overlay page; resolves when its promise settles. Never rejects. */
  const run = async (w: BrowserWindow, code: string): Promise<void> => {
    await (ready ?? Promise.resolve());
    if (w.isDestroyed()) return;
    await w.webContents.executeJavaScript(code).catch(() => undefined);
  };

  const hide = (): void => {
    hideTimer = null;
    if (win && !win.isDestroyed()) win.hide();
  };

  const self = {
    hideNow(): void {
      if (hideTimer) clearTimeout(hideTimer);
      hide();
    },
  };
  liveOverlays.add(self);

  return {
    async moveTo(point, opts) {
      try {
        if (destroyed || !deps.enabled()) return;
        const f = opts.windowFrame;
        const w = ensure(f);
        const next = { x: Math.round(f.x), y: Math.round(f.y), width: Math.max(1, Math.round(f.width)), height: Math.max(1, Math.round(f.height)) };
        const prev = bounds;
        const rebound = !prev || prev.x !== next.x || prev.y !== next.y || prev.width !== next.width || prev.height !== next.height;
        if (rebound) w.setBounds(next);
        bounds = next;
        if (!w.isVisible()) w.showInactive();
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = null;
        // No `from`: CURSOR_JS keeps its own position and starts at the same spot as in a browser tab.
        const args = { action: opts.action, point: toLocal(point, f) };
        const pre = rebound && prev ? `${reboundJs(prev.x - next.x, prev.y - next.y, next.width, next.height)}.then(function () { return ` : "";
        const code = CURSOR_JS.replace(ARGS_MARKER, () => JSON.stringify(args));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, MOVE_TIMEOUT_MS);
        });
        try {
          await Promise.race([run(w, pre ? `${pre}${code}; })` : code), bound]);
        } finally {
          clearTimeout(timer);
          // Armed once the move ran: CURSOR_JS starts its own 8 s fade then, so the window goes after the fade.
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = destroyed ? null : setTimeout(hide, HIDE_AFTER_MS);
        }
      } catch {
        /* cosmetic: never fails the action */
      }
    },
    destroy() {
      destroyed = true;
      liveOverlays.delete(self);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {
        /* already gone */
      }
      win = null;
    },
  };
}
