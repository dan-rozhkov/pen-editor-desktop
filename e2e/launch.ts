import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;

/** The app plus the first canvas tab's page (see `launchShell`). */
export type Shell = ElectronApplication & { canvasPage: Page };

/**
 * True for the page of a CANVAS tab of the editor at `base` (the editor URL the
 * shell was launched with): same origin, not the agent panel (`/agent...`) and
 * chatless (`chat=off`, what `resolveCanvasTabUrl` adds). Browser tabs at the
 * same origin (no `chat=off`) and the panel are not canvas pages.
 */
export function isCanvasPage(url: string, base: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== new URL(base).origin) return false;
  if (u.pathname === "/agent" || u.pathname.startsWith("/agent/")) return false;
  return u.searchParams.get("chat") === "off";
}

/**
 * Launches the shell. The desktop has ONE layout (agent panel + tabs) and the
 * window starts with ZERO tabs, so a spec that needs an editor page has to
 * open a canvas tab first. This helper does that by default: it waits for the
 * tab bar view, asks main for a new canvas tab exactly as the tab bar's "+"
 * does (`tabbar:new`, sent from the tab bar's own webContents so the sender
 * check passes), and returns once that tab's page exists. It is exposed as
 * `shell.canvasPage` (the listener is registered BEFORE the tab is requested,
 * so there is no race with the window event).
 *
 * Pass `{ canvasTab: false }` for specs that test the empty start itself (or
 * that open their own tabs); `canvasPage` is then undefined. Such specs may also
 * call `electron.launch` directly.
 */
export async function launchShell(options: LaunchOptions, { canvasTab = true }: { canvasTab?: boolean } = {}): Promise<Shell> {
  const app = (await electron.launch(options)) as Shell;
  if (!canvasTab) return app;
  const base = String(options.env?.PEN_DESKTOP_URL ?? process.env.PEN_DESKTOP_URL ?? "");
  const waiting = app.waitForEvent("window", { predicate: (p) => isCanvasPage(p.url(), base), timeout: 60_000 });
  waiting.catch(() => undefined);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const opened = await app.evaluate(({ ipcMain, webContents }) => {
      const tabbar = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith("/tabbar/tabbar.html"));
      if (!tabbar) return false;
      ipcMain.emit("tabbar:new", { sender: tabbar });
      return true;
    });
    if (opened) break;
    if (Date.now() > deadline) throw new Error("launchShell: the tab bar view never appeared");
    await new Promise((r) => setTimeout(r, 50));
  }
  app.canvasPage = await waiting;
  return app;
}
