import { decideBrowserNavigation } from "@sideform/browser-agent/controller";
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

export type PanelNavigationDecision = "allow" | "editor-tab" | "external" | "deny";

/**
 * Pure policy for the agent panel: it may only stay on its own page. Same
 * origin AND the panel path (`panelUrl`'s pathname) or a subpath -> allow;
 * any other same-origin URL (the editor, the gallery) -> open it as an editor
 * tab instead; other http(s) origins -> system browser; everything else deny.
 */
export function decidePanelNavigation(targetUrl: string, panelUrl: string): PanelNavigationDecision {
  let url: URL;
  let panel: URL;
  try {
    url = new URL(targetUrl);
    panel = new URL(panelUrl);
  } catch {
    return "deny";
  }
  if (url.origin === panel.origin) {
    const base = panel.pathname.replace(/\/+$/, "");
    return url.pathname === base || url.pathname.startsWith(`${base}/`) ? "allow" : "editor-tab";
  }
  if (url.protocol === "http:" || url.protocol === "https:") return "external";
  return "deny";
}

/** Wires will-navigate + setWindowOpenHandler on the agent panel per `decidePanelNavigation`. */
export function attachPanelNavigationPolicy(
  contents: WebContents,
  panelUrl: string,
  openExternal: (url: string) => void,
  openEditorTab: () => void,
): void {
  const route = (decision: PanelNavigationDecision, url: string) => {
    if (decision === "external") openExternal(url);
    else if (decision === "editor-tab") openEditorTab();
  };
  contents.on("will-navigate", (event, url) => {
    const decision = decidePanelNavigation(url, panelUrl);
    if (decision === "allow") return;
    event.preventDefault();
    route(decision, url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    route(decidePanelNavigation(url, panelUrl), url);
    return { action: "deny" };
  });
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

/**
 * Whether a `did-start-navigation`/`did-navigate-in-page` event should be
 * forwarded to `@sideform/browser-agent/controller`'s navigation-watch settle (`window.ts`'s
 * `onNavigationEvent`, feeding `armNavigationWatcher`). Both events fire for
 * ANY frame, not just the main one, and carry an `isMainFrame` flag — without
 * this filter, a subframe navigation (an ad/embed iframe reloading itself,
 * say) firing during the short post-click grace window made an ordinary,
 * non-navigating click look like it had started a real navigation, forcing
 * the caller to pay the full multi-second "wait for load" settle
 * (`CLICK_LOAD_SETTLE_TIMEOUT_MS`, 8s) for nothing — `isLoading()` reflects
 * the whole tab including subframes, so it looked exactly like a genuine
 * main-frame navigation. `did-navigate` needs no equivalent filter — per
 * Electron's own doc it "is emitted when a main frame navigation is done"
 * and never fires for a subframe. `did-start-loading` carries no frame
 * information at all (it reflects the whole tab's loading state, which
 * *does* flip for a subframe load) — with nothing to filter on, it is not
 * forwarded at all rather than risk the same false positive.
 */
export function shouldForwardNavigationEvent(details: { isMainFrame: boolean }): boolean {
  return details.isMainFrame;
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
