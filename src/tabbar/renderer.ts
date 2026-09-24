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
  /** Still sent by main; the tab strip no longer renders it (File menu does). */
  mcpStatus: "listening" | "not-published" | "off" | "error";
  /**
   * Set by window.ts (see tabManager.ts's shouldFocusAddressBar) exactly on
   * the push where a fresh, empty-URL browser tab just became active — the
   * renderer's cue to put the caret in #url-input, the way every real
   * browser does on a new tab.
   */
  focusAddressBar?: boolean;
};
type UITheme = "light" | "dark";

interface PenTabbarApi {
  isMac: boolean;
  newTab(): void;
  openNewTabMenu(anchor: { x: number; y: number }): void;
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

window.penTabbar.onState((state) => {
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
