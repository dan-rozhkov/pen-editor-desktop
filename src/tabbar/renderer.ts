type TabKind = "editor" | "browser" | "doc" | "trace" | "settings";
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
  reorderTab(id: number, beforeId: number | null): void;
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
// Glyph path data: Phosphor Icons "PaintBrush", "Globe", "FileText", "Pulse" and "GearSix" (all light weight), MIT License, Copyright (c) 2020
// Phosphor Icons (full notice: THIRD_PARTY_NOTICES.md at the repo root, shipped in the packaged app).
// Monochrome: filled with currentColor, the tab text color.
const GLYPHS: Record<TabKind, string> = {
  editor: "M224,26c-20.8,0-44.11,11.41-69.3,33.9C136.62,76.06,121,94.9,110.3,109A58,58,0,0,0,34,164c0,32.07-20.43,46.39-21.35,47A6,6,0,0,0,16,222H92a58,58,0,0,0,55-76.3c14.08-10.67,32.92-26.32,49.08-44.4C218.59,76.11,230,52.8,230,32A6,6,0,0,0,224,26ZM92,210H30.65C37.92,200.85,46,185.78,46,164a46,46,0,1,1,46,46Zm29.49-95.91c3.6-4.67,7.88-10,12.71-15.69a78.17,78.17,0,0,1,23.4,23.4c-5.67,4.83-11,9.11-15.69,12.71A58.38,58.38,0,0,0,121.49,114.09Zm45.2-.3a90.24,90.24,0,0,0-24.48-24.48C163.05,66.46,191,42,217.56,38.44,214,65,189.54,93,166.69,113.79Z",
  browser: "M128,26A102,102,0,1,0,230,128,102.12,102.12,0,0,0,128,26Zm81.57,64H169.19a132.58,132.58,0,0,0-25.73-50.67A90.29,90.29,0,0,1,209.57,90ZM218,128a89.7,89.7,0,0,1-3.83,26H171.81a155.43,155.43,0,0,0,0-52h42.36A89.7,89.7,0,0,1,218,128Zm-90,87.83a110,110,0,0,1-15.19-19.45A124.24,124.24,0,0,1,99.35,166h57.3a124.24,124.24,0,0,1-13.46,30.38A110,110,0,0,1,128,215.83ZM96.45,154a139.18,139.18,0,0,1,0-52h63.1a139.18,139.18,0,0,1,0,52ZM38,128a89.7,89.7,0,0,1,3.83-26H84.19a155.43,155.43,0,0,0,0,52H41.83A89.7,89.7,0,0,1,38,128Zm90-87.83a110,110,0,0,1,15.19,19.45A124.24,124.24,0,0,1,156.65,90H99.35a124.24,124.24,0,0,1,13.46-30.38A110,110,0,0,1,128,40.17Zm-15.46-.84A132.58,132.58,0,0,0,86.81,90H46.43A90.29,90.29,0,0,1,112.54,39.33ZM46.43,166H86.81a132.58,132.58,0,0,0,25.73,50.67A90.29,90.29,0,0,1,46.43,166Zm97,50.67A132.58,132.58,0,0,0,169.19,166h40.38A90.29,90.29,0,0,1,143.46,216.67Z",
  doc: "M212.24,83.76l-56-56A6,6,0,0,0,152,26H56A14,14,0,0,0,42,40V216a14,14,0,0,0,14,14H200a14,14,0,0,0,14-14V88A6,6,0,0,0,212.24,83.76ZM158,46.48,193.52,82H158ZM200,218H56a2,2,0,0,1-2-2V40a2,2,0,0,1,2-2h90V88a6,6,0,0,0,6,6h50V216A2,2,0,0,1,200,218Zm-34-82a6,6,0,0,1-6,6H96a6,6,0,0,1,0-12h64A6,6,0,0,1,166,136Zm0,32a6,6,0,0,1-6,6H96a6,6,0,0,1,0-12h64A6,6,0,0,1,166,168Z",
  trace: "M238,128a6,6,0,0,1-6,6H203.71l-38.34,76.68A6,6,0,0,1,160,214h-.3a6,6,0,0,1-5.31-3.85L95.51,55.57,61.46,130.48A6,6,0,0,1,56,134H24a6,6,0,0,1,0-12H52.14l38.4-84.48a6,6,0,0,1,11.07.34L160.74,193.1l33.89-67.78A6,6,0,0,1,200,122h32A6,6,0,0,1,238,128Z",
  settings: "M128,82a46,46,0,1,0,46,46A46.06,46.06,0,0,0,128,82Zm0,80a34,34,0,1,1,34-34A34,34,0,0,1,128,162Zm108-54.4a6,6,0,0,0-2.92-4L202.64,86.22l-.42-.71L202.1,51.2A6,6,0,0,0,200,46.64a110.12,110.12,0,0,0-36.07-20.31,6,6,0,0,0-4.84.45L128.46,43.86h-1L96.91,26.76a6,6,0,0,0-4.86-.44A109.92,109.92,0,0,0,56,46.68a6,6,0,0,0-2.12,4.55l-.16,34.34c-.14.23-.28.47-.41.71L22.91,103.57A6,6,0,0,0,20,107.62a104.81,104.81,0,0,0,0,40.78,6,6,0,0,0,2.92,4l30.42,17.33.42.71.12,34.31A6,6,0,0,0,56,209.36a110.12,110.12,0,0,0,36.07,20.31,6,6,0,0,0,4.84-.45l30.61-17.08h1l30.56,17.1A6.09,6.09,0,0,0,162,230a5.83,5.83,0,0,0,1.93-.32,109.92,109.92,0,0,0,36-20.36,6,6,0,0,0,2.12-4.55l.16-34.34c.14-.23.28-.47.41-.71l30.42-17.29a6,6,0,0,0,2.92-4.05A104.81,104.81,0,0,0,236,107.6Zm-11.25,35.79L195.32,160.1a6.07,6.07,0,0,0-2.28,2.3c-.59,1-1.21,2.11-1.86,3.14a6,6,0,0,0-.91,3.16l-.16,33.21a98.15,98.15,0,0,1-27.52,15.53L133,200.88a6,6,0,0,0-2.93-.77h-.14c-1.24,0-2.5,0-3.74,0a6,6,0,0,0-3.07.76L93.45,217.43a98,98,0,0,1-27.56-15.49l-.12-33.17a6,6,0,0,0-.91-3.16c-.64-1-1.27-2.08-1.86-3.14a6,6,0,0,0-2.27-2.3L31.3,143.4a93,93,0,0,1,0-30.79L60.68,95.9A6.07,6.07,0,0,0,63,93.6c.59-1,1.21-2.11,1.86-3.14a6,6,0,0,0,.91-3.16l.16-33.21A98.15,98.15,0,0,1,93.41,38.56L123,55.12a5.81,5.81,0,0,0,3.07.76c1.24,0,2.5,0,3.74,0a6,6,0,0,0,3.07-.76l29.65-16.56a98,98,0,0,1,27.56,15.49l.12,33.17a6,6,0,0,0,.91,3.16c.64,1,1.27,2.08,1.86,3.14a6,6,0,0,0,2.27,2.3L224.7,112.6A93,93,0,0,1,224.73,143.39Z",
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
  el.addEventListener("pointerdown", (e) => onTabPointerDown(e, tab.id, el));

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

// --- Drag to reorder ----------------------------------------------------------------------
// pointerdown arms a drag; it starts after DRAG_THRESHOLD_PX of horizontal movement (a plain click
// never moves a tab; activation stays on mousedown). The dragged tab follows the pointer via
// translateX, the others shift with transforms to open a gap at the would-be slot. Drop sends
// tabbar:reorder {id, beforeId} (beforeId = the tab it now sits before, null = the end).
// pointercancel / lost capture cancel. There is no Escape/blur cancel: the mousedown activates the tab,
// main then focuses the tab's page, so this view never has keyboard focus nor stays focused during a drag.
// A tabbar:state mid-drag updates titles/active only; the DOM order waits for the drop.
const DRAG_THRESHOLD_PX = 4;
interface DragSlot {
  id: number;
  el: HTMLElement;
  left: number;
  width: number;
}
interface DragState {
  id: number;
  el: HTMLElement;
  pointerId: number;
  startX: number;
  started: boolean;
  slots: DragSlot[];
  from: number;
  to: number;
  gap: number;
  stripLeft: number;
  stripRight: number;
  animate: boolean;
  tx: number;
}
let drag: DragState | null = null;
let lastState: TabsSnapshot | null = null;
// Optimistic order after a drop, until a tabbar:state confirms it (a stale push in between must not flip it back).
let pendingOrder: number[] | null = null;
let pendingTimer: number | undefined;

function clearPending(): void {
  pendingOrder = null;
  window.clearTimeout(pendingTimer);
}

function onTabPointerDown(e: PointerEvent, id: number, el: HTMLElement): void {
  if (e.button !== 0) return;
  if (e.target instanceof Element && e.target.closest(".close")) return;
  if (!el.classList.contains("tab") || el.classList.contains("entering")) return;
  if (drag) abortDrag(); // a stale gesture (lost pointerup) must not swallow this one
  drag = {
    id, el, pointerId: e.pointerId, startX: e.clientX, started: false,
    slots: [], from: 0, to: 0, gap: 0, stripLeft: 0, stripRight: 0, animate: false, tx: 0,
  };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragUp);
  window.addEventListener("pointercancel", cancelDrag);
}

function startDrag(d: DragState): boolean {
  // Mid-animation neighbours (entering / closing ghosts) move while measured: wait for a quiet strip.
  if (tabsEl.querySelector(".tab-ghost, .tab.entering")) return false;
  const els = Array.from(tabsEl.querySelectorAll<HTMLElement>(":scope > .tab"));
  const ids = new Map<HTMLElement, number>();
  for (const [id, v] of tabViews) ids.set(v.el, id);
  d.slots = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { id: ids.get(el) ?? -1, el, left: r.left, width: r.width };
  });
  d.from = d.slots.findIndex((s) => s.id === d.id);
  if (d.from === -1 || d.slots.length < 2) return false;
  d.to = d.from;
  const strip = tabsEl.getBoundingClientRect();
  d.stripLeft = strip.left;
  d.stripRight = strip.right;
  d.gap = parseFloat(getComputedStyle(tabsEl).columnGap) || 0;
  d.animate = canAnimate(d.el);
  try {
    d.el.setPointerCapture(d.pointerId);
  } catch {
    return false;
  }
  d.el.addEventListener("lostpointercapture", cancelDrag);
  d.el.classList.add("dragging");
  tabsEl.classList.add("reordering");
  for (const s of d.slots) {
    if (s.el !== d.el) s.el.style.transition = d.animate ? "transform 150ms ease-out" : "none";
  }
  return true;
}

function layoutDrag(d: DragState, clientX: number): void {
  const me = d.slots[d.from];
  const minTx = d.stripLeft - me.left;
  const maxTx = d.stripRight - me.width - me.left;
  d.tx = Math.max(minTx, Math.min(Math.max(minTx, maxTx), clientX - d.startX));
  d.el.style.transform = `translateX(${d.tx}px)`;
  const center = me.left + d.tx + me.width / 2;
  const others = d.slots.filter((_, i) => i !== d.from);
  let to = 0;
  for (const o of others) if (o.left + o.width / 2 < center) to++;
  d.to = to;
  // Final layout if dropped here: contiguous from the first slot's left edge.
  const ordered = others.slice();
  ordered.splice(to, 0, me);
  let x = d.slots[0].left;
  for (const s of ordered) {
    if (s !== me) s.el.style.transform = x === s.left ? "" : `translateX(${x - s.left}px)`;
    x += s.width + d.gap;
  }
}

/** Detaches the gesture's listeners and forgets it. */
function endDrag(d: DragState): void {
  drag = null;
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragUp);
  window.removeEventListener("pointercancel", cancelDrag);
  d.el.removeEventListener("lostpointercapture", cancelDrag);
  try {
    d.el.releasePointerCapture(d.pointerId);
  } catch {
    /* already released */
  }
}

function resetDragStyles(d: DragState): void {
  for (const s of d.slots) {
    s.el.style.transition = "none";
    s.el.style.transform = "";
  }
  d.el.classList.remove("dragging");
  tabsEl.classList.remove("reordering");
  void tabsEl.offsetWidth; // flush with transitions off, so clearing the transforms is instant
  for (const s of d.slots) s.el.style.transition = "";
}

/** Ends the gesture and restores the strip, without re-rendering. */
function abortDrag(): void {
  const d = drag;
  if (!d) return;
  endDrag(d);
  if (d.started) resetDragStyles(d);
}

function cancelDrag(): void {
  const d = drag;
  if (!d) return;
  abortDrag();
  if (d.started && lastState) renderTabs(lastState); // apply any reorder deferred while dragging
}

function onDragMove(e: PointerEvent): void {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  if ((e.buttons & 1) === 0) {
    cancelDrag(); // the button is up: a pointerup was lost
    return;
  }
  if (!d.started) {
    if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return;
    if (!startDrag(d)) return; // stay armed; retry on a later move once the strip is quiet
    d.started = true;
  }
  layoutDrag(d, e.clientX);
}

function onDragUp(e: PointerEvent): void {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  endDrag(d);
  if (!d.started) return;
  const visualLeft = d.el.getBoundingClientRect().left;
  resetDragStyles(d);
  if (d.to !== d.from) {
    // Optimistic: the neighbours already sit in their final slots, so moving the DOM node does not jump them.
    const others = d.slots.filter((s) => s.el !== d.el);
    const before = d.to < others.length ? others[d.to] : null;
    tabsEl.insertBefore(d.el, before ? before.el : others[others.length - 1].el.nextSibling);
    pendingOrder = Array.from(tabsEl.querySelectorAll<HTMLElement>(":scope > .tab")).map(
      (el) => d.slots.find((s) => s.el === el)?.id ?? -1,
    );
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(clearPending, 3000); // safety net only
    window.penTabbar.reorderTab(d.id, before ? before.id : null);
  }
  if (d.animate) {
    // The dragged tab glides from where it was released into its slot.
    const delta = visualLeft - d.el.getBoundingClientRect().left;
    if (Math.abs(delta) > 0.5) {
      d.el.animate([{ transform: `translateX(${delta}px)` }, { transform: "none" }], { duration: 120, easing: "cubic-bezier(0.33, 1, 0.68, 1)" });
    }
  }
  if (lastState) renderTabs(lastState);
}

function renderTabs(state: TabsSnapshot): void {
  if (drag?.started) {
    const ids = new Set(state.tabs.map((t) => t.id));
    if (ids.size === drag.slots.length && drag.slots.every((s) => ids.has(s.id))) {
      // Same tabs: keep the DOM order until the drag ends, but titles / active / loading stay live.
      for (const tab of state.tabs) {
        const v = tabViews.get(tab.id);
        if (v) updateTabView(v, tab, tab.id === state.activeId, tab.kind === "browser" && (state.agentTabIds?.includes(tab.id) ?? false));
      }
      return;
    }
    abortDrag(); // a tab came or went: the measured slots are stale; the render below reconciles
  }
  if (pendingOrder) {
    const order = pendingOrder;
    const ids = state.tabs.map((t) => t.id);
    if (ids.length === order.length && ids.every((id) => order.includes(id))) {
      if (ids.every((id, i) => id === order[i])) clearPending();
      else {
        const byId = new Map(state.tabs.map((t) => [t.id, t] as const));
        state = { ...state, tabs: order.map((id) => byId.get(id)!) };
      }
    } else clearPending();
  }
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
  lastState = state;
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
    const previousUrl = latestActiveUrl;
    latestActiveUrl = active?.url ?? "";
    if (!urlInputFocused || !userEditingUrl) urlInputEl.value = latestActiveUrl;
    // The tab got its first url (an agent browse_open into a fresh blank tab, which was
    // auto-focused below): drop the focus, so the field is not left grey and focused.
    if (!state.focusAddressBar && shouldBlurAddressBar(previousUrl, latestActiveUrl, userEditingUrl)) {
      urlInputEl.blur();
    }

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
