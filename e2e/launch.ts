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

const CRASH_SIGNALS = new Set(["SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL", "SIGFPE", "SIGTRAP"]);

/**
 * Prints a crash of the Electron process to stderr. Playwright itself only reports "Target page,
 * context or browser has been closed" at the next call. Kills on teardown (SIGKILL/SIGTERM) are
 * not crashes and stay silent.
 */
export function reportCrashes(app: ElectronApplication): void {
  const proc = app.process();
  proc.on("exit", (code, signal) => {
    if (signal && CRASH_SIGNALS.has(signal)) console.error(`Electron pid=${proc.pid} crashed with ${signal} (exit code ${code})`);
  });
}

/**
 * Waits, WITHOUT running code in the main process, until the shell's own views exist (the tab bar
 * and the empty start, the last view createMainWindow makes) and returns the tab bar page.
 *
 * Why: Node's inspector runs a main-process `app.evaluate` as a V8 interrupt, in the middle of
 * synchronous main code. One that lands while main is constructing a `WebContentsView` crashes
 * Electron with SIGSEGV. Playwright's page list and "window" events come from CDP target events
 * and never interrupt the main process. The wait rejects at once if the app exits.
 */
export async function waitForShellViews(app: ElectronApplication): Promise<Page> {
  const page = async (suffix: string) =>
    app.windows().find((p) => p.url().endsWith(suffix)) ??
    (await app.waitForEvent("window", { predicate: (p) => p.url().endsWith(suffix) }));
  const [tabbar] = await Promise.all([page("/tabbar/tabbar.html"), page("/tabbar/empty.html")]);
  return tabbar;
}

/**
 * Launches the shell. The desktop has ONE layout (agent panel + tabs) and the
 * window starts with ZERO tabs, so a spec that needs an editor page has to
 * open a canvas tab first. This helper does that by default: it waits for the
 * tab bar view, asks for a new canvas tab exactly as the tab bar's "+" does
 * (`penTabbar.newTab()` in the tab bar page, which sends `tabbar:new`), and
 * returns once that tab's page exists. It is exposed as
 * `shell.canvasPage` (the listener is registered BEFORE the tab is requested,
 * so there is no race with the window event).
 *
 * Pass `{ canvasTab: false }` for specs that test the empty start itself (or
 * that open their own tabs); `canvasPage` is then undefined. Such specs may also
 * call `electron.launch` directly.
 */
export async function launchShell(options: LaunchOptions, { canvasTab = true }: { canvasTab?: boolean } = {}): Promise<Shell> {
  const app = (await electron.launch(options)) as Shell;
  reportCrashes(app);
  const tabbar = await waitForShellViews(app);
  if (!canvasTab) return app;
  const base = String(options.env?.PEN_DESKTOP_URL ?? process.env.PEN_DESKTOP_URL ?? "");
  const waiting = app.waitForEvent("window", { predicate: (p) => isCanvasPage(p.url(), base), timeout: 60_000 });
  waiting.catch(() => undefined);
  // The tab bar's own "+" path (renderer → `tabbar:new`), so no main-process code runs here.
  await tabbar.evaluate(() => (window as unknown as { penTabbar: { newTab(): void } }).penTabbar.newTab());
  app.canvasPage = await waiting;
  return app;
}
