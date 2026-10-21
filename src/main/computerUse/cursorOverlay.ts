// The agent cursor drawn over a natively controlled app (spec section 4): a transparent,
// click-through window above the target window. Created on the first move, only while the
// "Show Agent Cursor" setting is on. Screenshots never include it (window-only capture).
import { BrowserWindow } from "electron";
import { HIDE_AFTER_MS, planMove, type Point } from "./cursorMath";
import type { CursorSink, WindowFrame } from "./nativeController";

// Inline page: no remote content, no preload. Driven only through numeric arguments.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
#c{position:absolute;left:0;top:0;width:24px;height:24px;opacity:0;transition:opacity .15s;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.r{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #4f7cff;opacity:.9;animation:rip .5s ease-out forwards}
@keyframes rip{to{transform:scale(3.2);opacity:0}}
</style></head><body>
<svg id="c" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.9 L11.6 21.6 L14.2 20.5 L11.3 14 L17.4 14 Z" fill="#4f7cff" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
<script>
var c=document.getElementById("c"),timer=0;
function place(x,y){c.style.transform="translate("+x+"px,"+y+"px)"}
window.__move=function(flat,ms){
  cancelAnimationFrame(timer);c.style.opacity=1;
  var n=flat.length/2,t0=performance.now();
  if(ms<=0||n<2){place(flat[flat.length-2],flat[flat.length-1]);return}
  (function step(now){
    var k=Math.min(1,(now-t0)/ms),i=Math.round(k*(n-1));
    place(flat[i*2],flat[i*2+1]);
    if(k<1)timer=requestAnimationFrame(step);
  })(t0);
};
window.__ripple=function(x,y){var r=document.createElement("div");r.className="r";r.style.left=x+"px";r.style.top=y+"px";document.body.appendChild(r);setTimeout(function(){r.remove()},600)};
window.__hide=function(){c.style.opacity=0};
</script></body></html>`;

// Every overlay window ever made (weak: a destroyed window just disappears). Code that decides about "the main
// window" (dock reopen, second launch) must not count these: they are click-through decoration.
const overlayWindows = new WeakSet<object>();

/** True for a cursor overlay window. Use it to leave overlays out of any "which is the main window" decision. */
export const isCursorOverlayWindow = (win: object | null | undefined): boolean => win != null && overlayWindows.has(win);

export interface CursorOverlay extends CursorSink {
  /** Remove the window. Idempotent. Never touches the controlled app. */
  destroy(): void;
}

const finite = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

export function createCursorOverlay(deps: { enabled: () => boolean }): CursorOverlay {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  let last: Point | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

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
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
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

  const run = (w: BrowserWindow, code: string): void => {
    void (ready ?? Promise.resolve()).then(() => {
      if (!w.isDestroyed()) return w.webContents.executeJavaScript(code).catch(() => undefined);
      return undefined;
    });
  };

  const hide = (): void => {
    hideTimer = null;
    if (!win || win.isDestroyed()) return;
    run(win, "window.__hide()");
    const w = win;
    setTimeout(() => {
      if (!w.isDestroyed() && hideTimer === null) w.hide();
    }, 250);
  };

  return {
    moveTo(point, opts) {
      try {
        if (destroyed || !deps.enabled()) return;
        const f = opts.windowFrame;
        const w = ensure(f);
        w.setBounds({ x: Math.round(f.x), y: Math.round(f.y), width: Math.max(1, Math.round(f.width)), height: Math.max(1, Math.round(f.height)) });
        if (!w.isVisible()) w.showInactive();
        const { path, durationMs } = planMove(last, point, f);
        last = point;
        const flat = path.flatMap((p) => [finite(p.x), finite(p.y)]).join(",");
        run(w, `window.__move([${flat}],${finite(durationMs)})`);
        if (opts.click) {
          const end = path[path.length - 1];
          const delay = Math.round(durationMs);
          setTimeout(() => {
            if (!w.isDestroyed()) run(w, `window.__ripple(${finite(end.x)},${finite(end.y)})`);
          }, delay);
        }
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, HIDE_AFTER_MS);
      } catch {
        /* cosmetic: never fails the action */
      }
    },
    destroy() {
      destroyed = true;
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
