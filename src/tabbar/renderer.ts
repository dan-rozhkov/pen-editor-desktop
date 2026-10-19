type TabKind = "editor" | "browser";
type TabRow = {
  id: number;
  title: string;
  kind: TabKind;
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** A page load is in progress: the tab shows the loading fill. */
  loading?: boolean;
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
  /** Shell motion allowed; false = PEN_DESKTOP_NO_ANIMATIONS=1 or OS reduced motion (no tab motion). */
  motion?: boolean;
  /** Island gap / corner radius in px (layout.ts), for the address row CSS. */
  islandGap?: number;
  islandRadius?: number;
  addressRowHeight?: number;
  tabRowHeight?: number;
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
  onTail(cb: (color: string | null) => void): void;
  onStripLeft(cb: (x: number) => void): void;
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

window.penTabbar.onTail((color) => {
  // Only a plain CSS colour from main; anything else keeps the island colour.
  if (typeof color === "string" && /^(#[0-9a-f]{6}|rgb\(\d{1,3}, \d{1,3}, \d{1,3}\))$/.test(color)) {
    document.documentElement.style.setProperty("--tail-bg", color);
  } else {
    document.documentElement.style.removeProperty("--tail-bg");
  }
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

// Leading tab icons, keyed by tab kind: a paintbrush for editor (canvas) tabs, a globe for
// browser tabs, never a site favicon. The tab bar CSP has no img-src: the tab bar draws no images.
// Glyph path data: Phosphor Icons "PaintBrush" / "Globe", light weight, MIT License, Copyright (c) 2020
// Phosphor Icons (full notice: THIRD_PARTY_NOTICES.md at the repo root, shipped in the packaged app).
// Monochrome: filled with currentColor, the tab text color.
const GLYPHS: Record<TabKind, string> = {
  editor: "M224,26c-20.8,0-44.11,11.41-69.3,33.9C136.62,76.06,121,94.9,110.3,109A58,58,0,0,0,34,164c0,32.07-20.43,46.39-21.35,47A6,6,0,0,0,16,222H92a58,58,0,0,0,55-76.3c14.08-10.67,32.92-26.32,49.08-44.4C218.59,76.11,230,52.8,230,32A6,6,0,0,0,224,26ZM92,210H30.65C37.92,200.85,46,185.78,46,164a46,46,0,1,1,46,46Zm29.49-95.91c3.6-4.67,7.88-10,12.71-15.69a78.17,78.17,0,0,1,23.4,23.4c-5.67,4.83-11,9.11-15.69,12.71A58.38,58.38,0,0,0,121.49,114.09Zm45.2-.3a90.24,90.24,0,0,0-24.48-24.48C163.05,66.46,191,42,217.56,38.44,214,65,189.54,93,166.69,113.79Z",
  browser: "M128,26A102,102,0,1,0,230,128,102.12,102.12,0,0,0,128,26Zm81.57,64H169.19a132.58,132.58,0,0,0-25.73-50.67A90.29,90.29,0,0,1,209.57,90ZM218,128a89.7,89.7,0,0,1-3.83,26H171.81a155.43,155.43,0,0,0,0-52h42.36A89.7,89.7,0,0,1,218,128Zm-90,87.83a110,110,0,0,1-15.19-19.45A124.24,124.24,0,0,1,99.35,166h57.3a124.24,124.24,0,0,1-13.46,30.38A110,110,0,0,1,128,215.83ZM96.45,154a139.18,139.18,0,0,1,0-52h63.1a139.18,139.18,0,0,1,0,52ZM38,128a89.7,89.7,0,0,1,3.83-26H84.19a155.43,155.43,0,0,0,0,52H41.83A89.7,89.7,0,0,1,38,128Zm90-87.83a110,110,0,0,1,15.19,19.45A124.24,124.24,0,0,1,156.65,90H99.35a124.24,124.24,0,0,1,13.46-30.38A110,110,0,0,1,128,40.17Zm-15.46-.84A132.58,132.58,0,0,0,86.81,90H46.43A90.29,90.29,0,0,1,112.54,39.33ZM46.43,166H86.81a132.58,132.58,0,0,0,25.73,50.67A90.29,90.29,0,0,1,46.43,166Zm97,50.67A132.58,132.58,0,0,0,169.19,166h40.38A90.29,90.29,0,0,1,143.46,216.67Z",
};
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(cls: string, viewBox: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("class", cls);
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  return el;
}
function tabIconEl(tab: TabRow): HTMLElement {
  const box = document.createElement("span");
  box.className = "tab-icon";
  box.dataset.icon = tab.kind;
  const glyph = svg("glyph", "0 0 256 256");
  glyph.setAttribute("fill", "currentColor");
  const d = GLYPHS[tab.kind] ?? GLYPHS.browser; // unknown kind: the globe, never d="undefined"
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  glyph.appendChild(path);
  box.appendChild(glyph);
  return box;
}

// Same arrow geometry as the in-page agent cursor (browser-agent pageScripts
// ARROW_POINTS). Built with createElementNS: the CSP forbids inline markup
// tricks and colours come from classes.
function agentCursorIcon(): SVGSVGElement {
  const cursor = svg("agent-cursor", "-2.4 -2.6 24.2 24.4");
  for (const [cls, width] of [["rim", "7.8"], ["body", "5.4"]]) {
    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("class", cls);
    poly.setAttribute("points", "2.2,1.6 17.6,8.5 10.8,12.4 6.2,17.7");
    poly.setAttribute("stroke-width", width);
    poly.setAttribute("stroke-linejoin", "round");
    poly.setAttribute("stroke-linecap", "round");
    cursor.appendChild(poly);
  }
  return cursor;
}

// --- Keyed tab rendering -------------------------------------------------------------------
// Tabs are reconciled by id so their elements (and running animations) survive a state push.
// A removed tab becomes a `.tab-ghost` (never `.tab`: e2e counts `.tab`) that plays an exit and
// is dropped. Motion is skipped under prefers-reduced-motion and on the first render.
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const prefersReducedMotion = (): boolean => reducedMotionQuery.matches;
// `shellMotion` comes from main (tabbar:state `motion`): false for PEN_DESKTOP_NO_ANIMATIONS=1 and the OS setting.
let shellMotion = true;
const canAnimate = (el: Element): boolean => typeof el.animate === "function" && shellMotion && !prefersReducedMotion();

const PROGRESS_CREEP_MS = 7000;
const PROGRESS_FINISH_MS = 400; // 180ms run to 100%, then 220ms fade
interface TabView {
  el: HTMLElement;
  progress: HTMLElement;
  lead: Node[];
  leadKey: string;
  title: HTMLElement;
  loading: boolean;
  anim: Animation | null;
}
const tabViews = new Map<number, TabView>();
let firstTabRender = true;

function startProgress(v: TabView): void {
  v.anim?.cancel();
  v.anim = null;
  if (!canAnimate(v.progress)) {
    v.progress.classList.add("static");
    return;
  }
  v.anim = v.progress.animate(
    [{ width: "0%", opacity: 1 }, { width: "80%", opacity: 1 }],
    { duration: PROGRESS_CREEP_MS, easing: "cubic-bezier(0.1, 0.75, 0.25, 1)", fill: "forwards" },
  );
}

function finishProgress(v: TabView): void {
  v.progress.classList.remove("static");
  const running = v.anim;
  v.anim = null;
  if (!running || !canAnimate(v.progress)) {
    running?.cancel();
    return;
  }
  const from = getComputedStyle(v.progress).width; // current animated width, in px
  running.cancel();
  const finish = v.progress.animate(
    [
      { width: from, opacity: 1, offset: 0 },
      { width: "100%", opacity: 1, offset: 180 / PROGRESS_FINISH_MS },
      { width: "100%", opacity: 0, offset: 1 },
    ],
    { duration: PROGRESS_FINISH_MS, easing: "linear", fill: "forwards" },
  );
  v.anim = finish;
  finish.onfinish = () => {
    if (v.anim === finish) {
      finish.cancel();
      v.anim = null;
    }
  };
}

function createTabView(tab: TabRow): TabView {
  const el = document.createElement("div");
  el.className = "tab";
  el.addEventListener("mousedown", () => window.penTabbar.activateTab(tab.id));

  const progress = document.createElement("span");
  progress.className = "tab-progress";
  progress.setAttribute("aria-hidden", "true");
  el.appendChild(progress);

  const title = document.createElement("span");
  title.className = "title";
  el.appendChild(title);

  const close = document.createElement("button");
  close.className = "close";
  close.setAttribute("aria-label", "Close tab");
  close.title = "Close Tab";
  close.addEventListener("mousedown", (e) => e.stopPropagation());
  close.addEventListener("click", () => window.penTabbar.closeTab(tab.id));
  el.appendChild(close);

  return { el, progress, lead: [], leadKey: "", title, loading: false, anim: null };
}

function updateTabView(v: TabView, tab: TabRow, active: boolean, agentWorking: boolean): void {
  v.el.classList.toggle("active", active);
  if (v.title.textContent !== tab.title) v.title.textContent = tab.title;
  // Every tab has a leading icon; the agent's cursor takes its slot while it drives the tab.
  const leadKey = agentWorking ? "agent" : tab.kind;
  if (v.leadKey !== leadKey) {
    for (const n of v.lead) n.parentNode?.removeChild(n);
    if (agentWorking) {
      const hint = document.createElement("span");
      hint.className = "sr-only";
      hint.textContent = "Agent is working";
      v.lead = [agentCursorIcon(), hint];
    } else {
      v.lead = [tabIconEl(tab)];
    }
    for (const n of v.lead) v.el.insertBefore(n, v.title);
    v.leadKey = leadKey;
  }
  const loading = tab.loading === true;
  if (loading !== v.loading) {
    v.loading = loading;
    if (loading) startProgress(v);
    else finishProgress(v);
  }
}

function enterTab(el: HTMLElement): void {
  if (!canAnimate(el)) return;
  const w = el.getBoundingClientRect().width;
  el.classList.add("entering");
  const anim = el.animate(
    [{ opacity: 0, width: "0px", minWidth: "0px", paddingLeft: "0px", paddingRight: "0px" }, { opacity: 1, width: `${w}px`, minWidth: `${w}px` }],
    { duration: 180, easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
  );
  anim.onfinish = anim.oncancel = () => el.classList.remove("entering");
}

function exitTab(v: TabView): void {
  const el = v.el;
  v.anim?.cancel();
  const w = el.getBoundingClientRect().width;
  // Not `.tab` any more: e2e specs count/find `.tab`. Styling is shared in tabbar.css.
  el.classList.remove("tab");
  el.classList.add("tab-ghost");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("inert", "");
  if (!canAnimate(el)) {
    el.remove();
    return;
  }
  const anim = el.animate(
    [
      { opacity: 1, width: `${w}px`, minWidth: `${w}px` },
      { opacity: 0, width: "0px", minWidth: "0px", paddingLeft: "0px", paddingRight: "0px" },
    ],
    { duration: 160, easing: "cubic-bezier(0.32, 0, 0.67, 0)", fill: "forwards" },
  );
  anim.onfinish = anim.oncancel = () => el.remove();
}

function renderTabs(state: TabsSnapshot): void {
  const live = new Set(state.tabs.map((t) => t.id));
  for (const [id, v] of tabViews) {
    if (live.has(id)) continue;
    tabViews.delete(id);
    if (firstTabRender) v.el.remove();
    else exitTab(v);
  }
  const nextTab = (from: Element | null): Element | null => {
    let n = from;
    while (n && !n.classList.contains("tab")) n = n.nextElementSibling;
    return n;
  };
  let prev: HTMLElement | null = null;
  for (const tab of state.tabs) {
    let v = tabViews.get(tab.id);
    const isNew = !v;
    if (!v) {
      v = createTabView(tab);
      tabViews.set(tab.id, v);
    }
    const agentWorking = tab.kind === "browser" && (state.agentTabIds?.includes(tab.id) ?? false);
    updateTabView(v, tab, tab.id === state.activeId, agentWorking);
    const expected = nextTab(prev ? prev.nextElementSibling : tabsEl.firstElementChild);
    if (expected !== v.el) tabsEl.insertBefore(v.el, expected);
    if (isNew && !firstTabRender) enterTab(v.el);
    prev = v.el;
  }
  firstTabRender = false;
}

// While the panel slides, main pushes the interpolated strip offset every frame (one clock for the
// native views and the strip); the final value also arrives on tabbar:state.
window.penTabbar.onStripLeft((x) => {
  document.documentElement.style.setProperty("--tab-strip-left", `${x}px`);
});

window.penTabbar.onState((state) => {
  // The tab row's left padding is max(mac traffic-light padding, this) — see tabbar.css.
  if (state.islandGap !== undefined) document.documentElement.style.setProperty("--island-gap", `${state.islandGap}px`);
  if (state.islandRadius !== undefined) document.documentElement.style.setProperty("--island-radius", `${state.islandRadius}px`);
  if (state.addressRowHeight !== undefined) document.documentElement.style.setProperty("--address-row-height", `${state.addressRowHeight}px`);
  if (state.tabRowHeight !== undefined) document.documentElement.style.setProperty("--tab-row-height", `${state.tabRowHeight}px`);
  const collapsed = state.panelCollapsed === true;
  togglePanelEl.setAttribute("aria-pressed", String(!collapsed));
  togglePanelEl.setAttribute("aria-label", collapsed ? "Show agent panel" : "Hide agent panel");
  togglePanelEl.title = collapsed ? "Show agent panel (Cmd/Ctrl+Alt+B)" : "Hide agent panel (Cmd/Ctrl+Alt+B)";
  shellMotion = state.motion !== false;
  document.documentElement.style.setProperty("--tab-strip-left", `${state.tabStripLeft ?? 0}px`);
  renderTabs(state);

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
