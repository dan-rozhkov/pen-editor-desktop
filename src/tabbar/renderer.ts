type McpStatus = "listening" | "not-published" | "off" | "error";
type TabKind = "editor" | "browser";
type TabRow = {
  id: number;
  title: string;
  kind: TabKind;
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
};
type TabsSnapshot = {
  tabs: TabRow[];
  activeId: number | null;
  activeKind: TabKind | null;
  mcpStatus: McpStatus;
};
type UITheme = "light" | "dark";

interface PenTabbarApi {
  isMac: boolean;
  newTab(): void;
  activateTab(id: number): void;
  closeTab(id: number): void;
  navigate(action: "url" | "back" | "forward" | "reload", url?: string): void;
  onState(cb: (s: TabsSnapshot) => void): void;
  onTheme(cb: (theme: UITheme) => void): void;
}

interface Window {
  penTabbar: PenTabbarApi;
}

const tabsEl = document.getElementById("tabs")!;
const mcpStatusEl = document.getElementById("mcp-status")!;
const chromeRowEl = document.getElementById("chrome-row")!;
const navBackEl = document.getElementById("nav-back") as HTMLButtonElement;
const navForwardEl = document.getElementById("nav-forward") as HTMLButtonElement;
const navReloadEl = document.getElementById("nav-reload") as HTMLButtonElement;
const urlFormEl = document.getElementById("url-form") as HTMLFormElement;
const urlInputEl = document.getElementById("url-input") as HTMLInputElement;

document.documentElement.toggleAttribute("data-macos", window.penTabbar.isMac);
document.getElementById("new-tab")!.addEventListener("click", () => window.penTabbar.newTab());

// No terminal in a packaged app, so this dot is the only MCP diagnostic.
// Only the status string itself ever crosses the IPC boundary (see
// CLAUDE.md's IPC section) — the tooltip text below is fixed, generic copy
// chosen here in the renderer, never a value sent from main, so no port
// number or token can leak into it even by accident.
function mcpStatusTitle(status: McpStatus): string {
  switch (status) {
    case "listening":
      return "MCP: listening for agent connections";
    case "not-published":
      return "MCP: another local server owns the endpoint — see the File menu";
    case "off":
      return "";
    case "error":
      return "MCP: failed to start — see the File menu";
  }
}

// Typed input is normalized by `normalizeTypedUrl`/`isNavigableUrl` —
// defined in urlNormalization.ts (loaded as its own <script> just before
// this one; see that file's header for why it's split out and why calling
// its functions here needs no import). See design doc §2/§5 and finding 5.

navBackEl.addEventListener("click", () => window.penTabbar.navigate("back"));
navForwardEl.addEventListener("click", () => window.penTabbar.navigate("forward"));
navReloadEl.addEventListener("click", () => window.penTabbar.navigate("reload"));
urlFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const normalized = normalizeTypedUrl(urlInputEl.value);
  // Denial visibility (finding 5): main's onTabbarNavigate silently no-ops
  // on a non-http(s) URL (decideBrowserNavigation), which used to leave the
  // submit button looking like a dead control with no explanation. Mirror
  // that same allow/deny check here so a rejected submission is visible —
  // the input keeps its prior (unsent) value and gets a CSS hook instead of
  // quietly doing nothing. No new IPC channel: main still independently
  // validates before navigating.
  if (!normalized || !isNavigableUrl(normalized)) {
    urlInputEl.classList.add("invalid");
    return;
  }
  urlInputEl.classList.remove("invalid");
  window.penTabbar.navigate("url", normalized);
});
urlInputEl.addEventListener("input", () => urlInputEl.classList.remove("invalid"));

window.penTabbar.onTheme((theme) => {
  document.documentElement.dataset.theme = theme;
});

let urlInputFocused = false;
let latestActiveUrl: string | undefined;
urlInputEl.addEventListener("focus", () => {
  urlInputFocused = true;
});
urlInputEl.addEventListener("blur", () => {
  urlInputFocused = false;
  // While focused, onState below skips writing into the input so it never
  // clobbers what the user is mid-typing — but nothing resynced it
  // afterwards, so an agent-driven browse_open that lands while the address
  // bar happens to be focused left the input showing a stale URL
  // indefinitely (finding 9). Catch up on blur to whatever the most
  // recently received snapshot actually says.
  if (latestActiveUrl !== undefined) urlInputEl.value = latestActiveUrl;
});

window.penTabbar.onState((state) => {
  mcpStatusEl.className = `mcp-status mcp-status--${state.mcpStatus}`;
  mcpStatusEl.title = mcpStatusTitle(state.mcpStatus);

  tabsEl.textContent = "";
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = tab.id === state.activeId ? "tab active" : "tab";
    el.addEventListener("mousedown", () => window.penTabbar.activateTab(tab.id));

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title;
    el.appendChild(title);

    const close = document.createElement("button");
    close.className = "close";
    close.setAttribute("aria-label", "Close tab");
    close.title = "Close Tab";
    close.addEventListener("mousedown", (e) => e.stopPropagation());
    close.addEventListener("click", () => window.penTabbar.closeTab(tab.id));
    el.appendChild(close);

    tabsEl.appendChild(el);
  }

  // Address row: only shown for the active browser tab (design doc §2).
  const isBrowser = state.activeKind === "browser";
  chromeRowEl.toggleAttribute("hidden", !isBrowser);
  if (isBrowser) {
    const active = state.tabs.find((t) => t.id === state.activeId);
    navBackEl.disabled = !active?.canGoBack;
    navForwardEl.disabled = !active?.canGoForward;
    // Tracked unconditionally (finding 9) so a blur resync (above) always
    // has the latest value to fall back to, even though the input itself
    // is only written here while not focused, so as not to clobber what
    // the user is mid-typing.
    latestActiveUrl = active?.url ?? "";
    if (!urlInputFocused) urlInputEl.value = latestActiveUrl;
  }
});
