type TabsSnapshot = { tabs: { id: number; title: string }[]; activeId: number | null };
type UITheme = "light" | "dark";

interface PenTabbarApi {
  newTab(): void;
  activateTab(id: number): void;
  closeTab(id: number): void;
  onState(cb: (s: TabsSnapshot) => void): void;
  onTheme(cb: (theme: UITheme) => void): void;
}

interface Window {
  penTabbar: PenTabbarApi;
}

const tabsEl = document.getElementById("tabs")!;
document.getElementById("new-tab")!.addEventListener("click", () => window.penTabbar.newTab());

window.penTabbar.onTheme((theme) => {
  document.documentElement.dataset.theme = theme;
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
});
