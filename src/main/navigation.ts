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

/** did-fail-load hook: main-frame load failures (except ERR_ABORTED -3) load the offline page. */
export function attachOfflineFallback(contents: WebContents, offlineFile: string): void {
  contents.on(
    "did-fail-load",
    (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
      void contents.loadFile(offlineFile, { query: { target: validatedURL } });
    },
  );
}
