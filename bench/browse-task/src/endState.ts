// Reads the end state of a live run from the agent's OWN browser session: a
// hidden window on the same Electron partition the agent tabs use
// (`persist:penbrowser`, pen-editor-desktop/src/main/window.ts), so cookies,
// cart and logins match. The agent's tab is never navigated.

import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication } from "playwright";

export const END_TEXT_CAP = 30_000;

export interface EndState {
  endUrl: string;
  finalUrl?: string;
  /** URL of the agent's last external tab at the end of the turn. */
  agentTabUrl?: string;
  agentTabUrls: string[];
  /** The tab the desktop reports as the agent's current one (browser.tabs list). */
  currentTabUrl?: string;
  textChars: number;
  error?: string;
}

/** Sentinel endUrl: read the agent's own last external tab instead of loading a URL. */
export const AGENT_TAB = "agent-tab";

export async function readEndState(app: ElectronApplication, endUrl: string, dir: string, currentUrl?: string): Promise<EndState> {
  fs.mkdirSync(dir, { recursive: true });
  const out: EndState = { endUrl, agentTabUrls: [], textChars: 0 };
  try {
    // Tabs first: reading the end page must not change what we report.
    const raw = await app.evaluate(async ({ webContents }) => {
      return webContents.getAllWebContents().map((w: any) => w.getURL() as string).filter((u: string) => /^https?:/.test(u));
    });
    out.agentTabUrls = raw.filter((u: string) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(u));
    out.agentTabUrl = currentUrl && out.agentTabUrls.includes(currentUrl) ? currentUrl : out.agentTabUrls.at(-1);
    out.currentTabUrl = currentUrl;
    if (endUrl === AGENT_TAB) {
      const tab = await app.evaluate(
        async ({ webContents }, p: { cap: number; currentUrl?: string }) => {
          const tabs = webContents
            .getAllWebContents()
            .filter((w: any) => /^https?:/.test(w.getURL()) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(w.getURL()));
          const wc = tabs.find((w: any) => p.currentUrl !== undefined && w.getURL() === p.currentUrl) ?? tabs.at(-1);
          if (!wc) return null;
          const text = (await wc.executeJavaScript("document.body ? document.body.innerText : ''")) as string;
          const img = await wc.capturePage();
          return { text: String(text).slice(0, p.cap), png: img.toPNG().toString("base64"), finalUrl: wc.getURL() };
        },
        { cap: END_TEXT_CAP, currentUrl },
      );
      if (!tab) {
        out.error = "no agent tab";
        return out;
      }
      out.finalUrl = tab.finalUrl;
      out.textChars = tab.text.length;
      fs.writeFileSync(path.join(dir, "end-state.txt"), tab.text);
      fs.writeFileSync(path.join(dir, "end-state.png"), Buffer.from(tab.png, "base64"));
      return out;
    }
    const res = await app.evaluate(
      async ({ BrowserWindow }, p: { url: string; cap: number }) => {
        const win = new BrowserWindow({
          show: false,
          width: 1280,
          height: 1600,
          webPreferences: { partition: "persist:penbrowser", backgroundThrottling: false, contextIsolation: true, sandbox: true },
        });
        try {
          const wc = win.webContents;
          const loaded = new Promise<void>((resolve) => {
            wc.once("did-finish-load", () => resolve());
            wc.once("did-fail-load", () => resolve());
            setTimeout(resolve, 45_000);
          });
          wc.loadURL(p.url).catch(() => {});
          await loaded;
          await new Promise((r) => setTimeout(r, 3_000));
          const text = (await wc.executeJavaScript("document.body ? document.body.innerText : ''")) as string;
          const img = await wc.capturePage();
          return { text: String(text).slice(0, p.cap), png: img.toPNG().toString("base64"), finalUrl: wc.getURL() };
        } finally {
          win.destroy();
        }
      },
      { url: endUrl, cap: END_TEXT_CAP },
    );
    out.finalUrl = res.finalUrl;
    out.textChars = res.text.length;
    fs.writeFileSync(path.join(dir, "end-state.txt"), res.text);
    fs.writeFileSync(path.join(dir, "end-state.png"), Buffer.from(res.png, "base64"));
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}
