import type { WebContents } from "electron";

export type NavigationDecision = "allow" | "external" | "deny";

/** Pure policy: same-origin as editor → allow; other http(s) → external; else deny. */
export function decideNavigation(targetUrl: string, editorOrigin: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return "deny";
  }
  if (url.origin === editorOrigin) return "allow";
  if (url.protocol === "http:" || url.protocol === "https:") return "external";
  return "deny";
}

/** Wires will-navigate + setWindowOpenHandler on a WebContents per the policy. */
export function attachNavigationPolicy(
  contents: WebContents,
  editorOrigin: string,
  openExternal: (url: string) => void,
): void {
  contents.on("will-navigate", (event, url) => {
    const decision = decideNavigation(url, editorOrigin);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(url, editorOrigin) === "external") openExternal(url);
    // Same-origin popups are also denied: the editor is single-window; tabs
    // are created only via the shell UI/menu.
    return { action: "deny" };
  });
}

/**
 * Pure policy for browser tabs (design doc `2026-09-18-builtin-browser-design.md`
 * §1): any http(s) navigation is allowed in place — a browser tab is a real
 * browser, so there is no origin clamp — and anything else (file:, custom
 * schemes, javascript:, garbage) is denied.
 */
export function decideBrowserNavigation(targetUrl: string): "allow" | "deny" {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return "deny";
  }
  return url.protocol === "http:" || url.protocol === "https:" ? "allow" : "deny";
}

/**
 * Wires a browser tab's WebContents per `decideBrowserNavigation`: in-place
 * http(s) navigation is left alone, everything else is blocked. Popups
 * (`target="_blank"`, `window.open`) open as a new browser tab instead of
 * escaping to the system browser — the whole point of the built-in browser is
 * to keep the user's session inside the app.
 */
export function attachBrowserTabPolicy(
  contents: WebContents,
  openInNewBrowserTab: (url: string) => void,
): void {
  contents.on("will-navigate", (event, url) => {
    if (decideBrowserNavigation(url) === "deny") event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (decideBrowserNavigation(url) === "allow") openInNewBrowserTab(url);
    return { action: "deny" };
  });
}

/**
 * Locks a WebContents down to whatever it was constructed with — used for the
 * tabbar view, which only ever loads local tabbar.html but has the penTabbar
 * IPC API attached. Any navigation attempt (e.g. a URL dragged onto the tab
 * strip) is blocked outright, and popups are always denied.
 */
export function attachLocalOnlyPolicy(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/**
 * Whether a `did-start-navigation` event is a real cross-document
 * navigation of the tab's main frame — the only case where the MCP bridge
 * registration should be dropped (see window.ts / mcp/service.ts's
 * handleTabNavigated). Electron fires `did-start-navigation` for
 * same-document navigations too (`pushState`/`replaceState`/hash changes),
 * which `pen-editor` uses as a react-router SPA; those never reload the
 * page's JS, so the existing `registerMcpBridge()` registration is still
 * live and must not be treated as gone.
 */
export function shouldDropMcpRegistration(details: { isMainFrame: boolean; isSameDocument: boolean }): boolean {
  return details.isMainFrame && !details.isSameDocument;
}

/** did-fail-load hook: main-frame load failures (except ERR_ABORTED -3) load the offline page. */
export function attachOfflineFallback(contents: WebContents, offlineFile: string): void {
  contents.on(
    "did-fail-load",
    (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
      // If the offline page itself fails to load (e.g. bad packaged path),
      // validatedURL is a file: URL — don't re-trigger the fallback or we loop forever.
      if (validatedURL.startsWith("file:")) return;
      void contents.loadFile(offlineFile, { query: { target: validatedURL } });
    },
  );
}
