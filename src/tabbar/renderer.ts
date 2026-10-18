type TabKind = "editor" | "browser";
type TabRow = {
  id: number;
  title: string;
  kind: TabKind;
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Leading icon: decided by main (tabIcons.ts). */
  icon?: { kind: "canvas" } | { kind: "favicon"; src: string } | { kind: "globe" };
};
type TabsSnapshot = {
  tabs: TabRow[];
  activeId: number | null;
  activeKind: TabKind | null;
  /** Still sent by main; the tab strip no longer renders it (File menu does). */
  mcpStatus: "listening" | "not-published" | "off" | "error";
  /**
   * Set by window.ts (see tabManager.ts's shouldFocusAddressBar) exactly on
   * the push where a fresh, empty-URL browser tab just became active — the
   * renderer's cue to put the caret in #url-input, the way every real
   * browser does on a new tab.
   */
  focusAddressBar?: boolean;
  /** The browser tabs the agent is driving right now (agent-cursor icon). */
  agentTabIds?: number[];
  /** Window x where the tab strip starts (the agent panel's right edge); 0/absent without a panel. */
  tabStripLeft?: number;
  /** The agent panel is collapsed (sidebar toggle state). */
  panelCollapsed?: boolean;
  /** Island gap / corner radius in px (layout.ts), for the address row CSS. */
  islandGap?: number;
  islandRadius?: number;
};
type UITheme = "light" | "dark";

interface PenTabbarApi {
  isMac: boolean;
  newTab(): void;
  togglePanel(): void;
  openNewTabMenu(anchor: { x: number; y: number }): void;
  openToolsMenu(anchor: { x: number; y: number }): void;
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
const chromeRowEl = document.getElementById("chrome-row")!;
const togglePanelEl = document.getElementById("toggle-panel") as HTMLButtonElement;
togglePanelEl.addEventListener("click", () => window.penTabbar.togglePanel());
const navBackEl = document.getElementById("nav-back") as HTMLButtonElement;
const navForwardEl = document.getElementById("nav-forward") as HTMLButtonElement;
const navReloadEl = document.getElementById("nav-reload") as HTMLButtonElement;
const urlFormEl = document.getElementById("url-form") as HTMLFormElement;
const urlInputEl = document.getElementById("url-input") as HTMLInputElement;

document.documentElement.toggleAttribute("data-macos", window.penTabbar.isMac);
const newTabEl = document.getElementById("new-tab")!;
newTabEl.addEventListener("click", () => {
  const rect = newTabEl.getBoundingClientRect();
  window.penTabbar.openNewTabMenu({ x: rect.left, y: rect.bottom + 4 });
});

const toolsBtnEl = document.getElementById("browser-tools")!;
toolsBtnEl.addEventListener("click", () => {
  const rect = toolsBtnEl.getBoundingClientRect();
  // Right-aligned would clip off-window; anchor at the button's left edge.
  window.penTabbar.openToolsMenu({ x: rect.left, y: rect.bottom + 4 });
});

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
urlInputEl.addEventListener("input", () => {
  urlInputEl.classList.remove("invalid");
  // A real keystroke — as opposed to the programmatic `.focus()` the new
  // empty-browser-tab fix (window.ts's pushState / shouldFocusAddressBar)
  // fires when a fresh blank tab becomes active. Only an actual edit must
  // suppress onState's writes below; merely being *focused* is not enough
  // — a blank tab that's about to be agent-navigated (browse_open creating
  // its own browser tab) gets auto-focused too, and if focus alone
  // suppressed syncing, nothing would ever un-suppress it (no blur ever
  // happens in that flow), leaving the address bar permanently stuck on
  // "" even once the tab actually navigated.
  userEditingUrl = true;
});

window.penTabbar.onTheme((theme) => {
  document.documentElement.dataset.theme = theme;
});

let urlInputFocused = false;
let userEditingUrl = false;
let latestActiveUrl: string | undefined;
urlInputEl.addEventListener("focus", () => {
  urlInputFocused = true;
});
urlInputEl.addEventListener("blur", () => {
  urlInputFocused = false;
  userEditingUrl = false;
  // While focused, onState below skips writing into the input so it never
  // clobbers what the user is mid-typing — but nothing resynced it
  // afterwards, so an agent-driven browse_open that lands while the address
  // bar happens to be focused left the input showing a stale URL
  // indefinitely (finding 9). Catch up on blur to whatever the most
  // recently received snapshot actually says.
  if (latestActiveUrl !== undefined) urlInputEl.value = latestActiveUrl;
});

// Leading tab icons. Built with createElementNS: the CSP forbids inline markup.
function svgIcon(cls: string, viewBox: string, draw: (svg: SVGSVGElement, ns: string) => void): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  draw(svg, ns);
  return svg;
}
function addPath(svg: SVGSVGElement, ns: string, d: string): void {
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d);
  svg.appendChild(p);
}
function tabIconEl(tab: TabRow): HTMLElement {
  const box = document.createElement("span");
  box.className = "tab-icon";
  const icon = tab.icon ?? { kind: tab.kind === "editor" ? "canvas" : "globe" };
  box.dataset.icon = icon.kind;
  if (icon.kind === "favicon") {
    const img = document.createElement("img");
    img.src = icon.src;
    img.alt = "";
    img.draggable = false;
    box.appendChild(img);
  } else if (icon.kind === "canvas") {
    // A frame with a cross-hair grid: the canvas.
    box.appendChild(svgIcon("glyph", "0 0 16 16", (svg, ns) => {
      const r = document.createElementNS(ns, "rect");
      r.setAttribute("x", "2.5"); r.setAttribute("y", "2.5"); r.setAttribute("width", "11"); r.setAttribute("height", "11"); r.setAttribute("rx", "2");
      svg.appendChild(r);
      addPath(svg, ns, "M6.2 2.8v10.4M9.8 2.8v10.4M2.8 6.2h10.4M2.8 9.8h10.4");
    }));
  } else {
    box.appendChild(svgIcon("glyph", "0 0 16 16", (svg, ns) => {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", "8"); c.setAttribute("cy", "8"); c.setAttribute("r", "5.8");
      svg.appendChild(c);
      addPath(svg, ns, "M2.2 8h11.6M8 2.2c2 1.7 2.9 3.6 2.9 5.8S10 12.1 8 13.8M8 2.2C6 3.9 5.1 5.8 5.1 8S6 12.1 8 13.8");
    }));
  }
  return box;
}

// Same arrow geometry as the in-page agent cursor (browser-agent pageScripts
// ARROW_POINTS). Built with createElementNS: the CSP forbids inline markup
// tricks and colours come from classes.
function agentCursorIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "agent-cursor");
  svg.setAttribute("viewBox", "-2.4 -2.6 24.2 24.4");
  svg.setAttribute("aria-hidden", "true");
  for (const [cls, width] of [["rim", "7.8"], ["body", "5.4"]]) {
    const poly = document.createElementNS(ns, "polygon");
    poly.setAttribute("class", cls);
    poly.setAttribute("points", "2.2,1.6 17.6,8.5 10.8,12.4 6.2,17.7");
    poly.setAttribute("stroke-width", width);
    poly.setAttribute("stroke-linejoin", "round");
    poly.setAttribute("stroke-linecap", "round");
    svg.appendChild(poly);
  }
  return svg;
}

window.penTabbar.onState((state) => {
  // The tab row's left padding is max(mac traffic-light padding, this) — see tabbar.css.
  if (state.islandGap !== undefined) document.documentElement.style.setProperty("--island-gap", `${state.islandGap}px`);
  if (state.islandRadius !== undefined) document.documentElement.style.setProperty("--island-radius", `${state.islandRadius}px`);
  const collapsed = state.panelCollapsed === true;
  togglePanelEl.setAttribute("aria-pressed", String(!collapsed));
  togglePanelEl.setAttribute("aria-label", collapsed ? "Show agent panel" : "Hide agent panel");
  togglePanelEl.title = collapsed ? "Show agent panel (Cmd/Ctrl+Alt+B)" : "Hide agent panel (Cmd/Ctrl+Alt+B)";
  document.documentElement.style.setProperty("--tab-strip-left", `${state.tabStripLeft ?? 0}px`);
  tabsEl.textContent = "";
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = tab.id === state.activeId ? "tab active" : "tab";
    el.addEventListener("mousedown", () => window.penTabbar.activateTab(tab.id));

    const agentWorking = tab.kind === "browser" && state.agentTabIds?.includes(tab.id);
    // Agent layout: every tab has a leading icon; the agent's cursor takes its slot while it drives the tab.
    if (!agentWorking) el.appendChild(tabIconEl(tab));
    if (agentWorking) {
      el.appendChild(agentCursorIcon());
      const hint = document.createElement("span");
      hint.className = "sr-only";
      hint.textContent = "Agent is working";
      el.appendChild(hint);
    }

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
    // is only written here while the user isn't actively editing it, so as
    // not to clobber what they're mid-typing. Being merely *focused* is not
    // by itself enough to suppress this write — see the `input` listener's
    // comment on `userEditingUrl` above for why (the new-browser-tab
    // auto-focus below would otherwise permanently wedge the address bar on
    // a stale/empty value once the tab is navigated by an agent rather than
    // by the user).
    latestActiveUrl = active?.url ?? "";
    if (!urlInputFocused || !userEditingUrl) urlInputEl.value = latestActiveUrl;

    // Caret half of the new-browser-tab fix (see window.ts's pushState):
    // the OS-level view focus alone lands the keyboard on the tab bar, but
    // without this the caret has no reason to be in #url-input specifically.
    // `select()` clears any stale value so typing replaces it outright.
    if (state.focusAddressBar) {
      urlInputEl.focus();
      urlInputEl.select();
    }
  }
});
