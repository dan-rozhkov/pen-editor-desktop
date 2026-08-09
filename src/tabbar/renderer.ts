type McpStatus = "listening" | "not-published" | "off" | "error";
type TabsSnapshot = {
  tabs: { id: number; title: string }[];
  activeId: number | null;
  mcpStatus: McpStatus;
};
type UITheme = "light" | "dark";

interface PenTabbarApi {
  isMac: boolean;
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
const mcpStatusEl = document.getElementById("mcp-status")!;
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

window.penTabbar.onTheme((theme) => {
  document.documentElement.dataset.theme = theme;
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
});
