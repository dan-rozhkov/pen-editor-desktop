// Opt-in screen recording of the shell's micro-animations (panel slide, tab loading fill, tab enter/exit).
//
//   MOTION_VIDEO=1 npm run test:e2e:bench -- e2e/bench-motion-video.spec.ts
//
// Runs against the deployed frontend (PEN_DESKTOP_URL overrides) and real websites, so it needs network.
// macOS only. The OS recorder is not used (see record): main composites per-view capturePage() frames and
// ffmpeg (on PATH) encodes them. Output: MOTION_VIDEO_DIR (default test-results/motion-video), one .mp4 per scene.

import { test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = process.env.MOTION_VIDEO_DIR ?? path.join(process.cwd(), "test-results", "motion-video");
const SITES = ["https://en.wikipedia.org/wiki/Electron_(software_framework)", "https://github.com/electron/electron"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tabbarPage(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 200; i++) {
    const p = app.windows().find((w) => w.url().endsWith("/tabbar/tabbar.html"));
    if (p) return p;
    await sleep(100);
  }
  throw new Error("tab bar page never appeared");
}

type Layer = { x: number; y: number; width: number; height: number; radius: number; file: string };
type Frame = { t: number; layers: Layer[] };

/**
 * Records `seconds` of the window into OUT/<name>.mp4 while `act` runs. The OS screen recorder is not
 * available (no Screen Recording permission: `screencapture -v` writes black frames), so main captures
 * every visible view with `capturePage()` in a loop (frames keep their real timestamps), a hidden window
 * composites the layers on a canvas (island radius, a flat glass colour behind), and ffmpeg encodes.
 */
async function record(app: ElectronApplication, name: string, seconds: number, act: () => Promise<void>): Promise<void> {
  const dir = path.join(OUT, `${name}-frames`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const capturing = app.evaluate(
    async ({ BaseWindow, WebContentsView }, { dir, ms }) => {
      const req = (process as unknown as { mainModule: { require: (m: string) => unknown } }).mainModule.require;
      const fsm = req("fs") as typeof import("node:fs");
      const pathm = req("path") as typeof import("node:path");
      const win = BaseWindow.getAllWindows()[0];
      const frames: { t: number; layers: { x: number; y: number; width: number; height: number; radius: number; file: string }[] }[] = [];
      const t0 = Date.now();
      let n = 0;
      while (Date.now() - t0 < ms) {
        const t = Date.now() - t0;
        const views = win.contentView.children.filter(
          (v): v is InstanceType<typeof WebContentsView> => v instanceof WebContentsView && v.getVisible() && !v.webContents.isDestroyed(),
        );
        const shots = await Promise.all(
          // URL read before the await: a tab closed mid-capture has no webContents afterwards.
          views.map(async (v) => ({ url: v.webContents.getURL(), b: v.getBounds(), img: await v.webContents.capturePage().catch(() => null) })),
        );
        const layers = [];
        for (const { url, b, img } of shots) {
          if (!img || img.isEmpty() || b.width <= 0 || b.height <= 0) continue;
          const isBar = url.endsWith("/tabbar/tabbar.html");
          const file = pathm.join(dir, `f${n}-${layers.length}.${isBar ? "png" : "jpg"}`);
          const small = img.resize({ width: b.width, quality: "good" });
          fsm.writeFileSync(file, isBar ? small.toPNG() : small.toJPEG(85));
          layers.push({ x: b.x, y: b.y, width: b.width, height: b.height, radius: isBar ? 0 : 12, file });
        }
        frames.push({ t, layers });
        n++;
      }
      return frames;
    },
    { dir, ms: seconds * 1000 },
  );
  await sleep(400);
  await act();
  const frames = (await capturing) as Frame[];
  const size = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds());

  // Composite each frame in a hidden window (canvas), then encode with real per-frame durations.
  const composed = await app.evaluate(
    async ({ BrowserWindow }, { frames, w, h, dir }) => {
      const req = (process as unknown as { mainModule: { require: (m: string) => unknown } }).mainModule.require;
      const fsm = req("fs") as typeof import("node:fs");
      const pathm = req("path") as typeof import("node:path");
      const comp = new BrowserWindow({ show: false, width: w, height: h, webPreferences: { offscreen: true } });
      await comp.loadURL("data:text/html,<canvas id=c></canvas>");
      const files: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const layers = frames[i].layers.map((l) => ({
          ...l,
          src: `data:image/${l.file.endsWith(".png") ? "png" : "jpeg"};base64,${fsm.readFileSync(l.file).toString("base64")}`,
        }));
        const dataUrl: string = await comp.webContents.executeJavaScript(`(async () => {
          const layers = ${JSON.stringify(layers)};
          const c = document.getElementById("c"); c.width = ${w}; c.height = ${h};
          const g = c.getContext("2d");
          g.fillStyle = "#e6e8ee"; g.fillRect(0, 0, ${w}, ${h});
          for (const l of layers) {
            const img = new Image(); img.src = l.src; await img.decode();
            g.save();
            if (l.radius) { g.beginPath(); g.roundRect(l.x, l.y, l.width, l.height, l.radius); g.clip(); }
            g.drawImage(img, l.x, l.y, l.width, l.height);
            g.restore();
          }
          return c.toDataURL("image/png");
        })()`);
        const out = pathm.join(dir, `c${String(i).padStart(5, "0")}.png`);
        fsm.writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
        files.push(out);
      }
      comp.destroy();
      return files;
    },
    { frames, w: size.width, h: size.height, dir },
  );
  const list = composed
    .map((f, i) => `file '${f}'\nduration ${(((frames[i + 1]?.t ?? seconds * 1000) - frames[i].t) / 1000).toFixed(4)}`)
    .join("\n");
  fs.writeFileSync(path.join(dir, "list.txt"), `${list}\nfile '${composed.at(-1)}'\n`);
  const fps = (frames.length / seconds).toFixed(1);
  console.log(`${name}: ${frames.length} frames in ${seconds}s (${fps} fps)`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"),
    "-vf", "fps=60,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", path.join(OUT, `${name}.mp4`)]);
}

test("record shell micro-animations", async () => {
  test.skip(!process.env.MOTION_VIDEO || process.platform !== "darwin", "opt-in, macOS only (MOTION_VIDEO=1)");
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });
  const app = await electron.launch({ args: ["."], env: { ...process.env } as Record<string, string> });
  try {
    const bar = await tabbarPage(app);
    await app.evaluate(({ BaseWindow }) => {
      BaseWindow.getAllWindows()[0].setBounds({ x: 80, y: 80, width: 1280, height: 800 });
    });
    await sleep(6_000); // the agent panel loads the deployed /agent page

    // Scene 1: new browser tabs enter, pages load (the fill), a reload, then a tab closes.
    await record(app, "tab-loading", 16, async () => {
      for (const url of SITES) {
        await app.evaluate(({ ipcMain, webContents }) => {
          const tabbar = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith("/tabbar/tabbar.html"))!;
          ipcMain.emit("tabbar:new-browser", { sender: tabbar });
        });
        await sleep(700);
        await bar.fill("#url-input", url);
        await bar.press("#url-input", "Enter");
        await sleep(3_500);
      }
      await bar.click("#nav-reload");
      await sleep(3_000);
      await bar.hover("#tabs .tab.active");
      await bar.click("#tabs .tab.active .close");
      await sleep(1_500);
    });
    // Scene 2: hide and show the chat panel over the open page twice, then a quick reverse mid-flight.
    await record(app, "panel-toggle", 7, async () => {
      for (let i = 0; i < 2; i++) {
        await bar.click("#toggle-panel");
        await sleep(1_100);
        await bar.click("#toggle-panel");
        await sleep(1_100);
      }
      await bar.click("#toggle-panel");
      await sleep(110);
      await bar.click("#toggle-panel");
    });
  } finally {
    await app.close();
  }
});
