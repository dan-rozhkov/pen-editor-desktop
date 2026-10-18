import { _electron as electron, type ElectronApplication } from "@playwright/test";

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;

/**
 * Launches the shell. The desktop has ONE layout (agent panel + tabs) and the
 * window starts with ZERO tabs, so a spec that needs an editor page would have
 * to open a canvas tab first. This helper does that by default: it waits for
 * the tab bar view, then asks main for a new canvas tab exactly as the tab
 * bar's "+" does (`tabbar:new`, sent from the tab bar's own webContents so the
 * sender check passes). It does NOT wait for the tab's page: the usual
 * `app.waitForEvent("window", ...)` that follows the call still sees it.
 *
 * Pass `{ canvasTab: false }` for specs that test the empty start itself (or
 * that open their own tabs), or call `electron.launch` directly.
 */
export async function launchShell(options: LaunchOptions, { canvasTab = true }: { canvasTab?: boolean } = {}): Promise<ElectronApplication> {
  const app = await electron.launch(options);
  if (!canvasTab) return app;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const opened = await app.evaluate(({ ipcMain, webContents }) => {
      const tabbar = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith("/tabbar/tabbar.html"));
      if (!tabbar) return false;
      ipcMain.emit("tabbar:new", { sender: tabbar });
      return true;
    });
    if (opened) return app;
    if (Date.now() > deadline) throw new Error("launchShell: the tab bar view never appeared");
    await new Promise((r) => setTimeout(r, 50));
  }
}
