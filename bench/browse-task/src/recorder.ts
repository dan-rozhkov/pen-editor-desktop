// Demo recorder (BENCH_RECORD_DIR): the terminal has no Screen Recording
// permission, so frames are taken from inside Electron — every WebContentsView
// of the window is captured with capturePage() and composited at its bounds.
// The hidden content tab (chat or browser) is put to the right of
// the window, so the video always shows both the chat and the page.
// BENCH_RECORD_LAYOUT=single: one window only, as the user sees it, and
// stop() ends on a few seconds of the chat with the final answer.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ElectronApplication } from "playwright";
import { WORKSPACE_DIR } from "./paths.ts";

const sharp = createRequire(path.join(WORKSPACE_DIR, "pen-editor-backend", "package.json"))("sharp") as any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Shot { x: number; y: number; w: number; h: number; visible: boolean; browser: boolean; jpg: string }

export interface Recorder { stop(): Promise<{ frames: number; dir: string }> }

export function startRecorder(app: ElectronApplication, dir: string, intervalMs = 250): Recorder {
  fs.mkdirSync(dir, { recursive: true });
  let stopped = false;
  const t0 = Date.now();
  const index: { file: string; t: number }[] = [];
  let n = 0;
  let lastTwo = { w: 0, h: 0 };
  const single = process.env.BENCH_RECORD_LAYOUT === "single";
  let forceChat = false;

  const grab = async (): Promise<{ shots: Shot[]; winW: number; winH: number }> =>
    app.evaluate(async ({ BaseWindow, WebContentsView }) => {
      const win = BaseWindow.getAllWindows()[0];
      if (!win) return { shots: [], winW: 0, winH: 0 };
      const out: { x: number; y: number; w: number; h: number; visible: boolean; browser: boolean; jpg: string }[] = [];
      const walk = async (view: any, ox: number, oy: number, parentVisible: boolean) => {
        const b = view.getBounds();
        const visible = parentVisible && view.getVisible();
        const x = ox + b.x;
        const y = oy + b.y;
        if (view instanceof WebContentsView && !view.webContents.isDestroyed() && b.width > 0 && b.height > 0) {
          const browser = view.webContents.session.storagePath?.includes("penbrowser") ?? false;
          if (visible || b.height > 200) {
            try {
              const img = await view.webContents.capturePage();
              if (!img.isEmpty()) out.push({ x, y, w: b.width, h: b.height, visible, browser, jpg: img.toJPEG(80).toString("base64") });
            } catch { /* view going away */ }
          }
        }
        for (const child of view.children) await walk(child, x, y, visible);
      };
      await walk(win.contentView, 0, 0, true);
      const [w, h] = win.getContentSize();
      return { shots: out, winW: w, winH: h };
    }) as Promise<{ shots: Shot[]; winW: number; winH: number }>;

  let warned = false;
  const loop = (async () => {
    // tsx (esbuild keepNames) wraps serialized functions in __name(), which
    // Electron's main process does not have.
    await app.evaluate("globalThis.__name = (f) => f").catch(() => {});
    while (!stopped) {
      const started = Date.now();
      try {
        const { shots, winW, winH } = await grab();
        if (winW && winH && single) {
          // The window as the user sees it (browser tab with its toolbar, or
          // the chat); at the end, the chat view even when it is hidden.
          const big = (a: Shot, b: Shot) => b.w * b.h - a.w * a.h;
          const chat = shots.filter((s) => !s.browser && s.h > 200).sort(big)[0];
          const parts = forceChat && chat ? [{ ...chat, x: 0, y: winH - chat.h }] : shots.filter((s) => s.visible);
          if (parts.length) {
            const layers: { input: Buffer; left: number; top: number }[] = [];
            for (const s of parts) {
              const input = await sharp(Buffer.from(s.jpg, "base64")).resize(s.w, s.h, { fit: "fill" }).toBuffer();
              layers.push({ input, left: s.x, top: s.y });
            }
            lastTwo = { w: Math.max(lastTwo.w, winW), h: Math.max(lastTwo.h, winH) };
            const file = `f${String(n++).padStart(5, "0")}.jpg`;
            await sharp({ create: { width: winW, height: winH, channels: 3, background: "#1e1e1e" } })
              .composite(layers)
              .jpeg({ quality: 85 })
              .toFile(path.join(dir, file));
            index.push({ file, t: Date.now() - t0 });
          }
        } else if (winW && winH) {
          // The other content tab (chat while the browser is shown, or the
          // browser while the chat is shown) goes to the right.
          const hidden = shots.filter((s) => !s.visible).sort((a, b) => b.w * b.h - a.w * a.h);
          const side = hidden[0];
          const W = winW + (side ? side.w : 0);
          const H = Math.max(winH, side ? side.h : 0);
          const layers: { input: Buffer; left: number; top: number }[] = [];
          for (const s of shots) {
            if (!s.visible) continue;
            const input = await sharp(Buffer.from(s.jpg, "base64")).resize(s.w, s.h, { fit: "fill" }).toBuffer();
            layers.push({ input, left: s.x, top: s.y });
          }
          if (side) {
            const input = await sharp(Buffer.from(side.jpg, "base64")).resize(side.w, side.h, { fit: "fill" }).toBuffer();
            layers.push({ input, left: winW, top: winH - side.h });
          }
          // Keep one canvas size for the whole video (ffmpeg pads to the max).
          lastTwo = { w: Math.max(lastTwo.w, W), h: Math.max(lastTwo.h, H) };
          const file = `f${String(n++).padStart(5, "0")}.jpg`;
          await sharp({ create: { width: W, height: H, channels: 3, background: "#1e1e1e" } })
            .composite(layers)
            .jpeg({ quality: 85 })
            .toFile(path.join(dir, file));
          index.push({ file, t: Date.now() - t0 });
        }
      } catch (err) {
        if (!warned) { warned = true; console.warn("recorder:", err instanceof Error ? err.message : err); }
      }
      const wait = intervalMs - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();

  return {
    async stop() {
      if (single) {
        forceChat = true;
        await new Promise((r) => setTimeout(r, 5000));
      }
      stopped = true;
      await loop;
      fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ size: lastTwo, frames: index }));
      return { frames: index.length, dir };
    },
  };
}
